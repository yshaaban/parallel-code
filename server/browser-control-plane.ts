import { WebSocket } from 'ws';
import { IPC } from '../electron/ipc/channels.js';
import type {
  RemoteAgent,
  RequestTaskCommandTakeoverCommand,
  RespondTaskCommandTakeoverCommand,
  ServerMessage,
  UpdatePresenceCommand,
} from '../electron/remote/protocol.js';
import {
  getTaskCommandControllers,
  getTaskCommandControllerSnapshot,
  pruneExpiredTaskCommandLeases,
  releaseTaskCommandLeasesForClient,
} from '../electron/ipc/task-command-leases.js';
import type {
  AgentSupervisionEvent,
  GitStatusSyncEvent,
  PeerPresenceSnapshot,
  RemotePresence,
  TaskPortsEvent,
} from '../src/domain/server-state.js';
import type { TaskConvergenceEvent } from '../src/domain/task-convergence.js';
import type { TaskReviewEvent } from '../src/domain/task-review.js';
import { isRemovedTaskPortsEvent } from '../src/domain/server-state.js';
import {
  createWebSocketTransport,
  type CreateWebSocketTransportOptions,
  type SendTextResult,
  type WebSocketTransport,
} from '../electron/remote/ws-transport.js';
import { type BrowserRemoteStatus, type BrowserServerInfo } from './browser-server-info.js';
import { createBrowserControlState } from './browser-control-state.js';
import { createBrowserSendQueue } from './browser-send-queue.js';
import {
  recordBrowserControlDelayedQueue,
  recordBrowserControlSendResult,
} from '../electron/ipc/runtime-diagnostics.js';

const WS_BACKPRESSURE_MAX_BYTES = 1_048_576;
const MICRO_BATCH_INTERVAL_MS = 1;
const DELAYED_SEND_RETRY_INTERVAL_MS = 25;
const TASK_COMMAND_TAKEOVER_TIMEOUT_MS = 8_000;
const TASK_COMMAND_TAKEOVER_IDLE_MS = 15_000;
const TASK_COMMAND_LEASE_PRUNE_INTERVAL_MS = 1_000;

export interface BrowserControlPlane {
  authenticateConnection: (client: WebSocket, clientId?: string, lastSeq?: number) => boolean;
  broadcastAgentList: () => void;
  broadcastControl: (message: ServerMessage) => void;
  broadcastRemoteStatus: () => void;
  cleanup: () => void;
  cleanupClient: (client: WebSocket) => void;
  emitIpcEvent: (channel: IPC, payload: unknown) => void;
  emitAgentSupervisionChanged: (payload: AgentSupervisionEvent) => void;
  emitGitStatusChanged: (payload: GitStatusSyncEvent) => void;
  emitTaskConvergenceChanged: (payload: TaskConvergenceEvent) => void;
  emitTaskReviewChanged: (payload: TaskReviewEvent) => void;
  emitTaskPortsChanged: (payload: TaskPortsEvent) => void;
  getPendingChannelSendState: (
    client: WebSocket,
  ) => { queueAgeMs: number; queueBytes: number; queueDepth: number } | null;
  getPeerPresenceVersion: () => number;
  getPeerPresenceSnapshots: () => PeerPresenceSnapshot[];
  getRemoteStatus: () => BrowserRemoteStatus;
  getRemoteStatusVersion: () => number;
  getServerInfo: () => BrowserServerInfo;
  removeGitStatus: (worktreePath: string) => void;
  sendAgentError: (
    client: WebSocket,
    agentId: string,
    fallbackMessage: string,
    error: unknown,
  ) => void;
  sendChannelData: (client: WebSocket, data: string | Buffer) => boolean;
  sendMessage: (client: WebSocket, message: ServerMessage) => boolean;
  startHeartbeat: () => void;
  transport: WebSocketTransport<WebSocket>;
  requestTaskCommandTakeover: (
    client: WebSocket,
    message: RequestTaskCommandTakeoverCommand,
  ) => void;
  respondTaskCommandTakeover: (
    client: WebSocket,
    message: RespondTaskCommandTakeoverCommand,
  ) => void;
  updatePeerPresence: (client: WebSocket, presence: UpdatePresenceCommand) => void;
}

export interface CreateBrowserControlPlaneOptions {
  agentControlLeaseMs?: number;
  buildAgentList: () => RemoteAgent[];
  cleanupSocketClient: (client: WebSocket) => void;
  heartbeatIntervalMs?: number;
  maxMissedPongs?: number;
  port: number;
  simulateJitterMs?: number;
  simulateLatencyMs?: number;
  simulatePacketLoss?: number;
  token: string;
}

type BrowserTransportTuningOptions = Pick<
  CreateWebSocketTransportOptions<WebSocket>,
  'agentControlLeaseMs' | 'heartbeatIntervalMs' | 'maxMissedPongs'
>;
type GitStatusControlMessage = Extract<ServerMessage, { type: 'git-status-changed' }>;
type TaskPortsControlMessage = Extract<ServerMessage, { type: 'task-ports-changed' }>;

interface DelayedClientSendEntry {
  data: string | Buffer;
  dueAt: number;
  enqueuedAt: number;
  sizeBytes: number;
}

interface DelayedClientSendState {
  queue: DelayedClientSendEntry[];
  timer: ReturnType<typeof setTimeout> | null;
  totalBytes: number;
}

interface PendingTaskCommandTakeoverRequest {
  action: string;
  expiresAt: number;
  requestId: string;
  requesterClientId: string;
  requesterDisplayName: string;
  targetControllerId: string;
  taskId: string;
  timer: ReturnType<typeof setTimeout>;
}

type TaskCommandTakeoverDecision = 'approved' | 'denied' | 'force-required' | 'owner-missing';

function createGitStatusControlMessage(message: GitStatusSyncEvent): GitStatusControlMessage {
  return {
    type: 'git-status-changed',
    ...(typeof message.branchName === 'string' ? { branchName: message.branchName } : {}),
    ...(typeof message.projectRoot === 'string' ? { projectRoot: message.projectRoot } : {}),
    ...(message.status ? { status: message.status } : {}),
    ...(typeof message.worktreePath === 'string' ? { worktreePath: message.worktreePath } : {}),
  };
}

function createTaskPortsControlMessage(message: TaskPortsEvent): TaskPortsControlMessage {
  if (isRemovedTaskPortsEvent(message)) {
    return {
      type: 'task-ports-changed',
      taskId: message.taskId,
      removed: true,
    };
  }

  return {
    type: 'task-ports-changed',
    taskId: message.taskId,
    observed: message.observed,
    exposed: message.exposed,
    updatedAt: message.updatedAt,
  };
}

function createTransportTuningOptions(
  options: CreateBrowserControlPlaneOptions,
): BrowserTransportTuningOptions {
  return {
    ...(options.agentControlLeaseMs !== undefined
      ? { agentControlLeaseMs: options.agentControlLeaseMs }
      : {}),
    ...(options.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
    ...(options.maxMissedPongs !== undefined ? { maxMissedPongs: options.maxMissedPongs } : {}),
  };
}

function getSimulatedRetransmissionDelayMs(
  latencyMs: number,
  jitterMs: number,
  packetLoss: number,
): number {
  if (packetLoss <= 0 || Math.random() >= packetLoss) {
    return 0;
  }

  const retransmissionBaseMs = Math.max(DELAYED_SEND_RETRY_INTERVAL_MS, latencyMs);
  const retransmissionJitterMs = Math.max(jitterMs, Math.floor(retransmissionBaseMs / 2));
  return retransmissionBaseMs + Math.random() * retransmissionJitterMs;
}

function getSimulatedChannelDelayMs(options: CreateBrowserControlPlaneOptions): number {
  const latencyMs = Math.max(0, options.simulateLatencyMs ?? 0);
  const jitterMs = Math.max(0, options.simulateJitterMs ?? 0);
  const packetLoss = Math.min(1, Math.max(0, options.simulatePacketLoss ?? 0));
  const baseDelayMs = latencyMs + Math.random() * jitterMs;
  const retransmissionDelayMs = getSimulatedRetransmissionDelayMs(latencyMs, jitterMs, packetLoss);
  return baseDelayMs + retransmissionDelayMs;
}

export function createBrowserControlPlane(
  options: CreateBrowserControlPlaneOptions,
): BrowserControlPlane {
  const delayedClientSends = new WeakMap<WebSocket, DelayedClientSendState>();
  const peerSessions = new Map<string, PeerPresenceSnapshot>();
  const pendingTaskCommandTakeoverRequests = new Map<string, PendingTaskCommandTakeoverRequest>();
  let taskCommandLeasePruneTimer: ReturnType<typeof setInterval> | null = null;
  let peerPresenceVersion = 0;

  const batchedSender = createBrowserSendQueue<WebSocket>({
    flushIntervalMs: MICRO_BATCH_INTERVAL_MS,
    send: (client, message) => {
      const result = sendSafely(client, message);
      if (result.ok) {
        return { ok: true };
      }

      if (result.reason === 'backpressure') {
        cleanupFailedClientSend(client);
        return { ok: false, retry: false };
      }

      return { ok: false, retry: false };
    },
  });

  const transport = createWebSocketTransport<WebSocket>({
    closeClient: (client, code, reason) => {
      client.close(code, reason);
    },
    sendBroadcastText: (client, text) => {
      batchedSender.queueMessage(client, text);
      return { ok: true };
    },
    sendDirectText: (client, text) => sendSafely(client, text),
    terminateClient: (client) => {
      cleanupClient(client);
      options.cleanupSocketClient(client);
      client.terminate();
    },
    onAuthenticatedClientCountChanged: () => {
      broadcastRemoteStatus();
    },
    ...createTransportTuningOptions(options),
  });

  const controlState = createBrowserControlState({
    getPeerPresenceSnapshots: () => getPeerPresenceSnapshots(),
    getPeerPresenceVersion: () => peerPresenceVersion,
    getAuthenticatedClientCount: () => transport.getAuthenticatedClientCount(),
    port: options.port,
    token: options.token,
  });

  function createFallbackPeerPresence(clientId: string): PeerPresenceSnapshot {
    return {
      activeTaskId: null,
      clientId,
      controllingAgentIds: [],
      controllingTaskIds: [],
      displayName: `Session ${clientId.slice(0, 6)}`,
      focusedSurface: null,
      lastSeenAt: Date.now(),
      visibility: 'visible',
    };
  }

  function bumpPeerPresenceVersion(): void {
    peerPresenceVersion += 1;
  }

  function getPeerPresenceSnapshots(): PeerPresenceSnapshot[] {
    return [...peerSessions.values()].sort((left, right) => {
      const displayNameComparison = left.displayName.localeCompare(right.displayName);
      if (displayNameComparison !== 0) {
        return displayNameComparison;
      }

      return left.clientId.localeCompare(right.clientId);
    });
  }

  function ensurePeerPresence(clientId: string): void {
    if (peerSessions.has(clientId)) {
      return;
    }

    peerSessions.set(clientId, createFallbackPeerPresence(clientId));
    bumpPeerPresenceVersion();
  }

  function broadcastPeerPresences(): void {
    bumpPeerPresenceVersion();
    broadcastControl({
      type: 'peer-presences',
      list: getPeerPresenceSnapshots(),
    });
  }

  function getDataSizeBytes(data: string | Buffer): number {
    return Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
  }

  function getDelayedClientSendState(client: WebSocket): DelayedClientSendState {
    let state = delayedClientSends.get(client);
    if (state) {
      return state;
    }

    state = {
      queue: [],
      timer: null,
      totalBytes: 0,
    };
    delayedClientSends.set(client, state);
    return state;
  }

  function getNextDelayedSendDueAt(latencyMs: number, jitterMs: number): number {
    return Date.now() + latencyMs + Math.random() * jitterMs;
  }

  function getDelayedClientQueueAgeMs(state: DelayedClientSendState): number {
    const firstEntry = state.queue[0];
    if (!firstEntry) {
      return 0;
    }

    return Math.max(0, Date.now() - firstEntry.enqueuedAt);
  }

  function recordDelayedClientQueueHighWater(state: DelayedClientSendState): void {
    if (state.queue.length === 0) {
      return;
    }

    recordBrowserControlDelayedQueue(
      state.queue.length,
      state.totalBytes,
      getDelayedClientQueueAgeMs(state),
    );
  }

  function scheduleDelayedClientDrainForQueueHead(
    client: WebSocket,
    state: DelayedClientSendState,
  ): void {
    const firstDueAt = state.queue[0]?.dueAt;
    if (firstDueAt === undefined) {
      return;
    }

    scheduleDelayedClientDrain(client, state, firstDueAt - Date.now());
  }

  function clearDelayedClientSendState(client: WebSocket): void {
    const state = delayedClientSends.get(client);
    if (!state) {
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
    }
    delayedClientSends.delete(client);
  }

  function emitReleasedTaskCommandControllers(clientId: string): void {
    for (const snapshot of releaseTaskCommandLeasesForClient(clientId)) {
      emitIpcEvent(IPC.TaskCommandControllerChanged, snapshot);
    }
  }

  function pruneExpiredTaskCommandControllers(): void {
    for (const snapshot of pruneExpiredTaskCommandLeases()) {
      emitIpcEvent(IPC.TaskCommandControllerChanged, snapshot);
    }
  }

  function pruneInactiveClientState(): void {
    const inactiveClientIds = new Set<string>();

    for (const snapshot of getTaskCommandControllers()) {
      if (snapshot.controllerId && !transport.hasClientId(snapshot.controllerId)) {
        inactiveClientIds.add(snapshot.controllerId);
      }
    }

    for (const clientId of peerSessions.keys()) {
      if (!transport.hasClientId(clientId)) {
        inactiveClientIds.add(clientId);
      }
    }

    let peerPresenceChanged = false;
    for (const clientId of inactiveClientIds) {
      cleanupTaskCommandTakeoverRequestsForClient(clientId);
      for (const snapshot of releaseTaskCommandLeasesForClient(clientId)) {
        emitIpcEvent(IPC.TaskCommandControllerChanged, snapshot);
      }
      if (peerSessions.delete(clientId)) {
        peerPresenceChanged = true;
      }
    }

    if (peerPresenceChanged) {
      broadcastPeerPresences();
    }
  }

  function cleanupClient(client: WebSocket): void {
    const clientId = transport.getClientId(client);
    batchedSender.cleanupClient(client);
    clearDelayedClientSendState(client);
    transport.cleanupClient(client);
    if (clientId && !transport.hasClientId(clientId)) {
      cleanupTaskCommandTakeoverRequestsForClient(clientId);
      emitReleasedTaskCommandControllers(clientId);
      peerSessions.delete(clientId);
      broadcastPeerPresences();
    }
  }

  function cleanupInactiveClient(client: WebSocket): void {
    cleanupClient(client);
    options.cleanupSocketClient(client);
  }

  function cleanupFailedClientSend(client: WebSocket): void {
    cleanupInactiveClient(client);
    try {
      client.close();
    } catch {
      /* ignore secondary close failures */
    }
  }

  function sendSafely(client: WebSocket, data: string | Buffer): SendTextResult {
    if (client.readyState !== WebSocket.OPEN) {
      recordBrowserControlSendResult('not-open');
      cleanupInactiveClient(client);
      return { ok: false, reason: 'not-open' };
    }
    if (client.bufferedAmount > WS_BACKPRESSURE_MAX_BYTES) {
      recordBrowserControlSendResult('backpressure');
      return { ok: false, reason: 'backpressure' };
    }

    try {
      client.send(data);
      return { ok: true };
    } catch (error) {
      recordBrowserControlSendResult('send-error');
      cleanupFailedClientSend(client);
      return {
        ok: false,
        reason: 'send-error',
        error,
      };
    }
  }

  function scheduleDelayedClientDrain(
    client: WebSocket,
    state: DelayedClientSendState,
    delayMs: number,
  ): void {
    if (state.timer) {
      return;
    }

    state.timer = setTimeout(
      () => {
        state.timer = null;
        drainDelayedClientQueue(client);
      },
      Math.max(0, delayMs),
    );
  }

  function drainDelayedClientQueue(client: WebSocket): void {
    const state = delayedClientSends.get(client);
    if (!state) {
      return;
    }

    if (client.readyState !== WebSocket.OPEN) {
      cleanupInactiveClient(client);
      return;
    }

    while (state.queue.length > 0) {
      recordDelayedClientQueueHighWater(state);
      const nextEntry = state.queue[0];
      if (!nextEntry) {
        break;
      }

      const delayMs = nextEntry.dueAt - Date.now();
      if (delayMs > 0) {
        scheduleDelayedClientDrainForQueueHead(client, state);
        return;
      }

      const result = sendSafely(client, nextEntry.data);
      if (!result.ok) {
        if (result.reason === 'backpressure') {
          scheduleDelayedClientDrain(client, state, DELAYED_SEND_RETRY_INTERVAL_MS);
        }
        return;
      }

      state.queue.shift();
      state.totalBytes -= nextEntry.sizeBytes;
    }

    clearDelayedClientSendState(client);
  }

  function queueDelayedChannelSend(
    client: WebSocket,
    data: string | Buffer,
    latencyMs: number,
    jitterMs: number,
  ): boolean {
    if (client.readyState !== WebSocket.OPEN) {
      recordBrowserControlSendResult('not-open');
      cleanupInactiveClient(client);
      return false;
    }

    const state = getDelayedClientSendState(client);
    const sizeBytes = getDataSizeBytes(data);
    const bufferedBytes = state.totalBytes + client.bufferedAmount + sizeBytes;
    if (bufferedBytes > WS_BACKPRESSURE_MAX_BYTES) {
      recordBrowserControlSendResult('backpressure');
      return false;
    }

    state.queue.push({
      data,
      dueAt: getNextDelayedSendDueAt(latencyMs, jitterMs),
      enqueuedAt: Date.now(),
      sizeBytes,
    });
    state.totalBytes += sizeBytes;
    recordDelayedClientQueueHighWater(state);
    scheduleDelayedClientDrainForQueueHead(client, state);
    return true;
  }

  function sendChannelData(client: WebSocket, data: string | Buffer): boolean {
    const simulatedDelayMs = getSimulatedChannelDelayMs(options);
    if (simulatedDelayMs > 0) {
      return queueDelayedChannelSend(client, data, simulatedDelayMs, 0);
    }

    return sendSafely(client, data).ok;
  }

  function sendJsonMessage(client: WebSocket, message: ServerMessage): void {
    void sendSafely(client, JSON.stringify(message));
  }

  function sendAgentList(client: WebSocket): void {
    sendJsonMessage(client, {
      type: 'agents',
      list: options.buildAgentList(),
    });
  }

  function sendAgentSnapshot(client: WebSocket): void {
    sendAgentList(client);
    transport.sendAgentControllers(client);
  }

  function authenticateConnection(client: WebSocket, clientId?: string, lastSeq?: number): boolean {
    const authResult = transport.authenticateClient(client, clientId);
    if (!authResult.ok) {
      return false;
    }

    ensurePeerPresence(authResult.clientId);

    if (lastSeq !== undefined) {
      transport.replayControlEvents(client, lastSeq);
    }
    sendAgentSnapshot(client);
    sendJsonMessage(client, controlState.createStateBootstrapMessage());
    broadcastPeerPresences();
    return true;
  }

  function broadcastControl(message: ServerMessage): void {
    transport.broadcastControl(message);
  }

  function emitIpcEvent(channel: IPC, payload: unknown): void {
    if (
      channel === IPC.TaskCommandControllerChanged &&
      typeof payload === 'object' &&
      payload !== null &&
      'taskId' in payload &&
      typeof payload.taskId === 'string'
    ) {
      reconcilePendingTaskCommandTakeoversForTask(payload.taskId);
      reconcileAgentControllersForTask(payload.taskId);
    }

    broadcastControl({
      type: 'ipc-event',
      channel,
      payload,
    });
  }

  function emitAgentSupervisionChanged(payload: AgentSupervisionEvent): void {
    emitIpcEvent(IPC.AgentSupervisionChanged, payload);
  }

  function emitGitStatusChanged(payload: GitStatusSyncEvent): void {
    emitIpcEvent(IPC.GitStatusChanged, payload);
    broadcastControl(createGitStatusControlMessage(payload));
  }

  function emitTaskConvergenceChanged(payload: TaskConvergenceEvent): void {
    emitIpcEvent(IPC.TaskConvergenceChanged, payload);
  }

  function emitTaskReviewChanged(payload: TaskReviewEvent): void {
    emitIpcEvent(IPC.TaskReviewChanged, payload);
  }

  function emitTaskPortsChanged(payload: TaskPortsEvent): void {
    broadcastControl(createTaskPortsControlMessage(payload));
  }

  function broadcastAgentList(): void {
    transport.broadcast({
      type: 'agents',
      list: options.buildAgentList(),
    });
  }

  function broadcastRemoteStatus(): void {
    const remoteStatus: RemotePresence = controlState.nextRemotePresence();
    broadcastControl({
      type: 'remote-status',
      connectedClients: remoteStatus.connectedClients,
      peerClients: remoteStatus.peerClients,
    });
  }

  function getPeerPresence(clientId: string): PeerPresenceSnapshot {
    return peerSessions.get(clientId) ?? createFallbackPeerPresence(clientId);
  }

  function getPendingTaskCommandTakeoverRequest(
    requestId: string,
  ): PendingTaskCommandTakeoverRequest | null {
    return pendingTaskCommandTakeoverRequests.get(requestId) ?? null;
  }

  function getTaskTakeoverTimeoutDecision(
    request: PendingTaskCommandTakeoverRequest,
  ): 'approved' | 'denied' | 'force-required' | 'owner-missing' {
    const currentController = getTaskCommandControllerSnapshot(request.taskId);
    if (!currentController.controllerId) {
      return 'owner-missing';
    }

    if (currentController.controllerId === request.requesterClientId) {
      return 'approved';
    }

    if (currentController.controllerId !== request.targetControllerId) {
      return 'denied';
    }

    if (!transport.hasClientId(request.targetControllerId)) {
      return 'owner-missing';
    }

    const targetPresence = peerSessions.get(request.targetControllerId);
    if (!targetPresence) {
      return 'force-required';
    }

    if (targetPresence.visibility === 'hidden') {
      return 'approved';
    }

    if (Date.now() - targetPresence.lastSeenAt >= TASK_COMMAND_TAKEOVER_IDLE_MS) {
      return 'approved';
    }

    return 'force-required';
  }

  function getTaskTakeoverResponseDecision(
    request: PendingTaskCommandTakeoverRequest,
    approved: boolean,
  ): 'approved' | 'denied' | 'owner-missing' {
    const currentController = getTaskCommandControllerSnapshot(request.taskId);
    if (!currentController.controllerId) {
      return 'owner-missing';
    }

    if (currentController.controllerId === request.requesterClientId) {
      return 'approved';
    }

    if (currentController.controllerId !== request.targetControllerId) {
      return 'denied';
    }

    return approved ? 'approved' : 'denied';
  }

  function getTaskTakeoverControllerChangeDecision(
    request: PendingTaskCommandTakeoverRequest,
  ): 'approved' | 'denied' | 'owner-missing' | null {
    const currentController = getTaskCommandControllerSnapshot(request.taskId);
    if (!currentController.controllerId) {
      return 'owner-missing';
    }

    if (currentController.controllerId === request.requesterClientId) {
      return 'approved';
    }

    if (currentController.controllerId !== request.targetControllerId) {
      return 'denied';
    }

    return null;
  }

  function clearTaskCommandTakeoverRequest(
    requestId: string,
  ): PendingTaskCommandTakeoverRequest | null {
    const request = pendingTaskCommandTakeoverRequests.get(requestId) ?? null;
    if (!request) {
      return null;
    }

    clearTimeout(request.timer);
    pendingTaskCommandTakeoverRequests.delete(requestId);
    return request;
  }

  function sendTaskCommandTakeoverResult(
    request: PendingTaskCommandTakeoverRequest,
    decision: TaskCommandTakeoverDecision,
  ): void {
    const resultMessage = createTaskCommandTakeoverResultMessage(
      request.requestId,
      request.taskId,
      decision,
    );
    transport.sendToClientId(request.requesterClientId, resultMessage);
    if (request.targetControllerId !== request.requesterClientId) {
      transport.sendToClientId(request.targetControllerId, resultMessage);
    }
  }

  function createTaskCommandTakeoverResultMessage(
    requestId: string,
    taskId: string,
    decision: TaskCommandTakeoverDecision,
  ): ServerMessage {
    return {
      type: 'task-command-takeover-result',
      decision,
      requestId,
      taskId,
    };
  }

  function sendDirectTaskCommandTakeoverResult(
    clientId: string,
    requestId: string,
    taskId: string,
    decision: TaskCommandTakeoverDecision,
  ): void {
    transport.sendToClientId(
      clientId,
      createTaskCommandTakeoverResultMessage(requestId, taskId, decision),
    );
  }

  function resolveTaskCommandTakeoverRequest(
    requestId: string,
    decision: TaskCommandTakeoverDecision,
  ): void {
    const request = clearTaskCommandTakeoverRequest(requestId);
    if (!request) {
      return;
    }

    sendTaskCommandTakeoverResult(request, decision);
  }

  function cleanupTaskCommandTakeoverRequestsForClient(clientId: string): void {
    for (const request of [...pendingTaskCommandTakeoverRequests.values()]) {
      if (request.requesterClientId === clientId) {
        resolveTaskCommandTakeoverRequest(request.requestId, 'denied');
        continue;
      }

      if (request.targetControllerId === clientId) {
        resolveTaskCommandTakeoverRequest(request.requestId, 'owner-missing');
      }
    }
  }

  function reconcilePendingTaskCommandTakeoversForTask(taskId: string): void {
    for (const request of [...pendingTaskCommandTakeoverRequests.values()]) {
      if (request.taskId !== taskId) {
        continue;
      }

      const decision = getTaskTakeoverControllerChangeDecision(request);
      if (!decision) {
        continue;
      }

      resolveTaskCommandTakeoverRequest(request.requestId, decision);
    }
  }

  function reconcileAgentControllersForTask(taskId: string): void {
    const agents = options.buildAgentList().filter((agent) => agent.taskId === taskId);
    for (const agent of agents) {
      const controllerId = transport.getAgentControllerId(agent.agentId);
      if (!controllerId) {
        continue;
      }

      if (getTaskCommandControllerSnapshot(taskId).controllerId === controllerId) {
        continue;
      }

      transport.releaseAgentControl(agent.agentId, controllerId);
    }
  }

  function requestTaskCommandTakeover(
    client: WebSocket,
    message: RequestTaskCommandTakeoverCommand,
  ): void {
    const requesterClientId = transport.getClientId(client);
    if (!requesterClientId) {
      return;
    }

    const currentController = getTaskCommandControllerSnapshot(message.taskId);
    if (
      !currentController.controllerId ||
      currentController.controllerId !== message.targetControllerId
    ) {
      sendDirectTaskCommandTakeoverResult(
        requesterClientId,
        message.requestId,
        message.taskId,
        'owner-missing',
      );
      return;
    }

    if (requesterClientId === message.targetControllerId) {
      sendDirectTaskCommandTakeoverResult(
        requesterClientId,
        message.requestId,
        message.taskId,
        'approved',
      );
      return;
    }

    if (!transport.hasClientId(message.targetControllerId)) {
      sendDirectTaskCommandTakeoverResult(
        requesterClientId,
        message.requestId,
        message.taskId,
        'owner-missing',
      );
      return;
    }

    const requesterDisplayName = getPeerPresence(requesterClientId).displayName;
    const expiresAt = Date.now() + TASK_COMMAND_TAKEOVER_TIMEOUT_MS;
    const timer = setTimeout(() => {
      const request = getPendingTaskCommandTakeoverRequest(message.requestId);
      if (!request) {
        return;
      }

      resolveTaskCommandTakeoverRequest(message.requestId, getTaskTakeoverTimeoutDecision(request));
    }, TASK_COMMAND_TAKEOVER_TIMEOUT_MS);

    pendingTaskCommandTakeoverRequests.set(message.requestId, {
      action: message.action,
      expiresAt,
      requestId: message.requestId,
      requesterClientId,
      requesterDisplayName,
      targetControllerId: message.targetControllerId,
      taskId: message.taskId,
      timer,
    });

    transport.sendToClientId(message.targetControllerId, {
      type: 'task-command-takeover-request',
      action: message.action,
      expiresAt,
      requestId: message.requestId,
      requesterClientId,
      requesterDisplayName,
      taskId: message.taskId,
    });
  }

  function respondTaskCommandTakeover(
    client: WebSocket,
    message: RespondTaskCommandTakeoverCommand,
  ): void {
    const responderClientId = transport.getClientId(client);
    if (!responderClientId) {
      return;
    }

    const request = getPendingTaskCommandTakeoverRequest(message.requestId);
    if (!request || request.targetControllerId !== responderClientId) {
      return;
    }

    resolveTaskCommandTakeoverRequest(
      message.requestId,
      getTaskTakeoverResponseDecision(request, message.approved),
    );
  }

  function updatePeerPresence(client: WebSocket, presence: UpdatePresenceCommand): void {
    const clientId = transport.getClientId(client);
    if (!clientId) {
      return;
    }

    const nextPresence: PeerPresenceSnapshot = {
      ...(peerSessions.get(clientId) ?? createFallbackPeerPresence(clientId)),
      activeTaskId: presence.activeTaskId ?? null,
      clientId,
      controllingAgentIds: presence.controllingAgentIds ?? [],
      controllingTaskIds: presence.controllingTaskIds ?? [],
      displayName: presence.displayName,
      focusedSurface: presence.focusedSurface ?? null,
      lastSeenAt: Date.now(),
      visibility: presence.visibility,
    };
    peerSessions.set(clientId, nextPresence);
    broadcastPeerPresences();
  }

  function sendMessage(client: WebSocket, message: ServerMessage): boolean {
    return sendSafely(client, JSON.stringify(message)).ok;
  }

  function sendAgentError(
    client: WebSocket,
    agentId: string,
    fallbackMessage: string,
    error: unknown,
  ): void {
    sendJsonMessage(client, {
      type: 'agent-error',
      agentId,
      message: error instanceof Error ? error.message : fallbackMessage,
    });
  }

  function cleanup(): void {
    transport.stopHeartbeat();
    for (const request of [...pendingTaskCommandTakeoverRequests.values()]) {
      clearTaskCommandTakeoverRequest(request.requestId);
    }
    if (taskCommandLeasePruneTimer) {
      clearInterval(taskCommandLeasePruneTimer);
      taskCommandLeasePruneTimer = null;
    }
  }

  function startHeartbeat(): void {
    transport.startHeartbeat();
    if (taskCommandLeasePruneTimer) {
      return;
    }

    taskCommandLeasePruneTimer = setInterval(() => {
      pruneExpiredTaskCommandControllers();
      pruneInactiveClientState();
    }, TASK_COMMAND_LEASE_PRUNE_INTERVAL_MS);
  }

  function getPendingChannelSendState(
    client: WebSocket,
  ): { queueAgeMs: number; queueBytes: number; queueDepth: number } | null {
    const state = delayedClientSends.get(client);
    if (!state || state.queue.length === 0) {
      return null;
    }

    return {
      queueAgeMs: getDelayedClientQueueAgeMs(state),
      queueBytes: state.totalBytes,
      queueDepth: state.queue.length,
    };
  }

  return {
    authenticateConnection,
    broadcastAgentList,
    broadcastControl,
    broadcastRemoteStatus,
    cleanup,
    cleanupClient,
    emitIpcEvent,
    emitAgentSupervisionChanged,
    emitGitStatusChanged,
    emitTaskConvergenceChanged,
    emitTaskReviewChanged,
    emitTaskPortsChanged,
    getPendingChannelSendState,
    getPeerPresenceSnapshots,
    getPeerPresenceVersion: () => peerPresenceVersion,
    getRemoteStatus: controlState.getRemoteStatus,
    getRemoteStatusVersion: controlState.getRemoteStatusVersion,
    getServerInfo: controlState.getServerInfo,
    removeGitStatus: controlState.removeGitStatus,
    sendAgentError,
    sendChannelData,
    sendMessage,
    startHeartbeat,
    transport,
    requestTaskCommandTakeover,
    respondTaskCommandTakeover,
    updatePeerPresence,
  };
}
