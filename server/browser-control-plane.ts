import { WebSocket } from 'ws';
import { IPC } from '../electron/ipc/channels.js';
import type {
  ClientMessage,
  RemoteAgent,
  RequestTaskCommandTakeoverCommand,
  RespondTaskCommandTakeoverCommand,
  ServerMessage,
  UpdatePresenceCommand,
} from '../electron/remote/protocol.js';
import {
  acquireTaskCommandLease,
  getTaskCommandControllers,
  getTaskCommandControllerSnapshot,
  pruneExpiredTaskCommandLeases,
  releaseTaskCommandLeasesForClient,
} from '../electron/ipc/task-command-leases.js';
import { handleTaskCommandLeaseControlMessage } from '../electron/ipc/task-command-lease-control.js';
import { getBackendRuntimeDiagnosticsGeneration } from '../electron/ipc/runtime-diagnostics.js';
import type {
  AgentSupervisionEvent,
  GitStatusSyncEvent,
  PeerPresenceSnapshot,
  RemotePresence,
  TaskPortsEvent,
} from '../src/domain/server-state.js';
import type { CoordinatorEventEnvelope } from '../src/domain/coordinator.js';
import { classifyGitStatusSyncEvent } from '../src/domain/server-state.js';
import type { RemoteLiveIpcEventChannel } from '../src/domain/remote-live-ipc-events.js';
import type { TaskConvergenceEvent } from '../src/domain/task-convergence.js';
import type { TaskStepsEvent } from '../src/domain/task-steps.js';
import type { TaskReviewEvent } from '../src/domain/task-review.js';
import type { TaskReviewSignalsEvent } from '../src/domain/task-review-signals.js';
import { assertNever } from '../src/lib/assert-never.js';
import { isNonNegativeInteger } from '../src/lib/type-guards.js';
import {
  createWebSocketTransport,
  type CreateWebSocketTransportOptions,
  type WebSocketTransport,
} from '../electron/remote/ws-transport.js';
import { type BrowserRemoteStatus, type BrowserServerInfo } from './browser-server-info.js';
import { createBrowserControlDelayedSends } from './browser-control-delayed-sends.js';
import { createBrowserControlState } from './browser-control-state.js';
import { createBrowserPeerPresence } from './browser-peer-presence.js';
import { createBrowserSendQueue } from './browser-send-queue.js';
import { createBrowserTaskCommandTakeovers } from './browser-task-command-takeovers.js';

const MICRO_BATCH_INTERVAL_MS = 1;
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
  emitCoordinatorChanged: (payload: CoordinatorEventEnvelope) => void;
  emitGitStatusChanged: (payload: GitStatusSyncEvent) => void;
  emitTaskConvergenceChanged: (payload: TaskConvergenceEvent) => void;
  emitTaskReviewChanged: (payload: TaskReviewEvent) => void;
  emitTaskReviewSignalsChanged: (payload: TaskReviewSignalsEvent) => void;
  emitTaskStepsChanged: (payload: TaskStepsEvent) => void;
  emitTaskPortsChanged: (payload: TaskPortsEvent) => void;
  getPendingChannelSendState: (
    client: WebSocket,
  ) => { queueAgeMs: number; queueBytes: number; queueDepth: number } | null;
  getPeerPresenceVersion: () => number;
  getPeerPresenceSnapshots: () => PeerPresenceSnapshot[];
  getRemoteStatus: () => BrowserRemoteStatus;
  getRemoteStatusVersion: () => number;
  getServerInfo: () => BrowserServerInfo;
  setServerPort: (port: number) => void;
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
  handleTaskCommandLease: (
    client: WebSocket,
    message: Extract<ClientMessage, { type: 'task-command-lease' }>,
  ) => void;
  updatePeerPresence: (client: WebSocket, presence: UpdatePresenceCommand) => void;
}

export interface CreateBrowserControlPlaneOptions {
  agentControlLeaseMs?: number;
  buildAgentList: () => RemoteAgent[];
  cleanupSocketClient: (client: WebSocket) => void;
  controlEventBufferSize?: number;
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
  'agentControlLeaseMs' | 'controlEventBufferSize' | 'heartbeatIntervalMs' | 'maxMissedPongs'
>;
type GitStatusControlMessage = Extract<ServerMessage, { type: 'git-status-changed' }>;
type TaskPortsControlMessage = Extract<ServerMessage, { type: 'task-ports-changed' }>;

function createGitStatusControlMessage(message: GitStatusSyncEvent): GitStatusControlMessage {
  const classification = classifyGitStatusSyncEvent(message);
  switch (classification.kind) {
    case 'snapshot': {
      const event = classification.event;
      return {
        type: 'git-status-changed',
        ...(typeof event.branchName === 'string' ? { branchName: event.branchName } : {}),
        ...(typeof event.projectRoot === 'string' ? { projectRoot: event.projectRoot } : {}),
        ...(isNonNegativeInteger(event.stateVersion) ? { stateVersion: event.stateVersion } : {}),
        status: event.status,
        worktreePath: event.worktreePath,
      };
    }
    case 'refresh':
      return {
        type: 'git-status-changed',
        ...classification.event,
      };
    default:
      return assertNever(classification, 'Unhandled git status sync event kind');
  }
}

function createTaskPortsControlMessage(message: TaskPortsEvent): TaskPortsControlMessage {
  switch (message.kind) {
    case 'removed':
    case 'snapshot':
      return {
        type: 'task-ports-changed',
        ...message,
      };
    default:
      return assertNever(message, 'Unhandled task ports event kind');
  }
}

function createTransportTuningOptions(
  options: CreateBrowserControlPlaneOptions,
): BrowserTransportTuningOptions {
  return {
    ...(options.agentControlLeaseMs !== undefined
      ? { agentControlLeaseMs: options.agentControlLeaseMs }
      : {}),
    ...(options.controlEventBufferSize !== undefined
      ? { controlEventBufferSize: options.controlEventBufferSize }
      : {}),
    ...(options.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
    ...(options.maxMissedPongs !== undefined ? { maxMissedPongs: options.maxMissedPongs } : {}),
  };
}

function getSimulatedChannelDelayMs(options: CreateBrowserControlPlaneOptions): number {
  const latencyMs = Math.max(0, options.simulateLatencyMs ?? 0);
  const jitterMs = Math.max(0, options.simulateJitterMs ?? 0);
  return latencyMs + (jitterMs > 0 ? Math.random() * jitterMs : 0);
}

function shouldDropSimulatedSend(options: CreateBrowserControlPlaneOptions): boolean {
  const packetLoss = Math.min(1, Math.max(0, options.simulatePacketLoss ?? 0));
  return packetLoss > 0 && Math.random() < packetLoss;
}

export function createBrowserControlPlane(
  options: CreateBrowserControlPlaneOptions,
): BrowserControlPlane {
  let taskCommandLeasePruneTimer: ReturnType<typeof setInterval> | null = null;
  let deferAuthenticatedClientCountChanged = false;
  let deferredAuthenticatedClientCountChanged = false;
  const peerPresence = createBrowserPeerPresence({
    broadcastControl,
  });

  const delayedSends = createBrowserControlDelayedSends({
    getChannelDelayMs: () => getSimulatedChannelDelayMs(options),
    shouldDropSend: () => shouldDropSimulatedSend(options),
    onFailedClientSend: cleanupFailedClientSend,
    onInactiveClient: cleanupInactiveClient,
  });

  const batchedSender = createBrowserSendQueue<WebSocket>({
    captureMessageGeneration: getBackendRuntimeDiagnosticsGeneration,
    flushIntervalMs: MICRO_BATCH_INTERVAL_MS,
    send: (client, message, diagnosticsGeneration) => {
      const result = delayedSends.sendSafely(client, message, diagnosticsGeneration);
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
    sendDirectText: (client, text) => delayedSends.sendSafely(client, text),
    terminateClient: (client) => {
      options.cleanupSocketClient(client);
      cleanupClient(client);
      client.terminate();
    },
    onAuthenticatedClientCountChanged: () => {
      if (deferAuthenticatedClientCountChanged) {
        deferredAuthenticatedClientCountChanged = true;
        return;
      }

      broadcastRemoteStatus();
    },
    ...createTransportTuningOptions(options),
  });

  const controlState = createBrowserControlState({
    getPeerPresenceSnapshots: peerPresence.getPeerPresenceSnapshots,
    getPeerPresenceVersion: peerPresence.getPeerPresenceVersion,
    getAuthenticatedClientCount: () => transport.getAuthenticatedClientCount(),
    port: options.port,
    token: options.token,
  });

  const taskCommandTakeovers = createBrowserTaskCommandTakeovers({
    applyApprovedTakeover: (request) => {
      const result = acquireTaskCommandLease(
        request.taskId,
        request.requesterClientId,
        request.requesterOwnerId ?? `browser-takeover:${request.requesterClientId}`,
        request.action,
        true,
      );
      if (result.changed) {
        emitRemoteLiveIpcEvent(IPC.TaskCommandControllerChanged, {
          action: result.action,
          controllerId: result.controllerId,
          taskId: result.taskId,
          version: result.version,
        });
      }
      return result.controllerId === request.requesterClientId;
    },
    getCurrentControllerId: (taskId) => getTaskCommandControllerSnapshot(taskId).controllerId,
    getPeerPresence: peerPresence.getPeerPresence,
    hasClientId: transport.hasClientId,
    idleMs: TASK_COMMAND_TAKEOVER_IDLE_MS,
    sendToClientId: transport.sendToClientId,
    timeoutMs: TASK_COMMAND_TAKEOVER_TIMEOUT_MS,
  });

  function cleanupDisconnectedClient(clientId: string): void {
    taskCommandTakeovers.cleanupRequestsForClient(clientId);
    emitReleasedTaskCommandControllers(clientId);
    peerPresence.removePeerPresence(clientId);
  }

  function emitReleasedTaskCommandControllers(clientId: string): void {
    for (const snapshot of releaseTaskCommandLeasesForClient(clientId)) {
      emitRemoteLiveIpcEvent(IPC.TaskCommandControllerChanged, snapshot);
    }
  }

  function pruneExpiredTaskCommandControllers(): void {
    for (const snapshot of pruneExpiredTaskCommandLeases()) {
      emitRemoteLiveIpcEvent(IPC.TaskCommandControllerChanged, snapshot);
    }
  }

  function pruneInactiveClientState(): void {
    const inactiveClientIds = new Set<string>();

    for (const snapshot of getTaskCommandControllers()) {
      if (snapshot.controllerId && !transport.hasClientId(snapshot.controllerId)) {
        inactiveClientIds.add(snapshot.controllerId);
      }
    }

    for (const snapshot of peerPresence.getPeerPresenceSnapshots()) {
      const clientId = snapshot.clientId;
      if (!transport.hasClientId(clientId)) {
        inactiveClientIds.add(clientId);
      }
    }

    for (const clientId of inactiveClientIds) {
      cleanupDisconnectedClient(clientId);
    }
  }

  function cleanupClient(client: WebSocket): void {
    const clientId = transport.getClientId(client);
    batchedSender.cleanupClient(client);
    delayedSends.clearClient(client);
    transport.cleanupClient(client);
    if (clientId && !transport.hasClientId(clientId)) {
      cleanupDisconnectedClient(clientId);
    }
  }

  function cleanupInactiveClient(client: WebSocket): void {
    options.cleanupSocketClient(client);
    cleanupClient(client);
  }

  function cleanupFailedClientSend(client: WebSocket): void {
    cleanupInactiveClient(client);
    try {
      client.close();
    } catch {
      /* ignore secondary close failures */
    }
  }

  function sendChannelData(client: WebSocket, data: string | Buffer): boolean {
    return delayedSends.sendChannelData(client, data);
  }

  function sendJsonMessage(client: WebSocket, message: ServerMessage): void {
    void delayedSends.sendSafely(client, JSON.stringify(message));
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
    const lastReplayableSeq =
      lastSeq === undefined ? undefined : transport.getLatestControlEventSeq();
    deferAuthenticatedClientCountChanged = lastSeq !== undefined;
    function authenticateClientWithDeferredStatus(): ReturnType<
      typeof transport.authenticateClient
    > {
      try {
        return transport.authenticateClient(client, clientId);
      } finally {
        deferAuthenticatedClientCountChanged = false;
      }
    }

    const authResult = authenticateClientWithDeferredStatus();
    if (!authResult.ok) {
      deferredAuthenticatedClientCountChanged = false;
      return false;
    }

    peerPresence.ensurePeerPresence(authResult.clientId);

    if (lastSeq !== undefined) {
      transport.replayControlEvents(client, lastSeq, lastReplayableSeq);
    }
    sendAgentSnapshot(client);
    sendJsonMessage(client, controlState.createStateBootstrapMessage());
    broadcastControl({
      type: 'peer-presences',
      list: peerPresence.getPeerPresenceSnapshots(),
    });
    if (deferredAuthenticatedClientCountChanged) {
      deferredAuthenticatedClientCountChanged = false;
      broadcastRemoteStatus();
    }
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
      taskCommandTakeovers.reconcileTask(payload.taskId);
      reconcileAgentControllersForTask(payload.taskId);
    }

    broadcastControl({
      type: 'ipc-event',
      channel,
      payload,
    });
  }

  function emitRemoteLiveIpcEvent(channel: RemoteLiveIpcEventChannel, payload: unknown): void {
    emitIpcEvent(channel, payload);
  }

  function emitAgentSupervisionChanged(payload: AgentSupervisionEvent): void {
    emitRemoteLiveIpcEvent(IPC.AgentSupervisionChanged, payload);
  }

  function emitCoordinatorChanged(payload: CoordinatorEventEnvelope): void {
    emitRemoteLiveIpcEvent(IPC.CoordinatorChanged, payload);
    broadcastControl({
      type: 'coordinator-event',
      event: payload,
    });
  }

  function emitGitStatusChanged(payload: GitStatusSyncEvent): void {
    emitRemoteLiveIpcEvent(IPC.GitStatusChanged, payload);
    broadcastControl(createGitStatusControlMessage(payload));
  }

  function emitTaskConvergenceChanged(payload: TaskConvergenceEvent): void {
    emitRemoteLiveIpcEvent(IPC.TaskConvergenceChanged, payload);
  }

  function emitTaskReviewChanged(payload: TaskReviewEvent): void {
    emitRemoteLiveIpcEvent(IPC.TaskReviewChanged, payload);
  }

  function emitTaskReviewSignalsChanged(payload: TaskReviewSignalsEvent): void {
    emitRemoteLiveIpcEvent(IPC.TaskReviewSignalsChanged, payload);
  }

  function emitTaskStepsChanged(payload: TaskStepsEvent): void {
    emitRemoteLiveIpcEvent(IPC.TaskStepsChanged, payload);
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

    taskCommandTakeovers.requestTakeover(requesterClientId, message);
  }

  function respondTaskCommandTakeover(
    client: WebSocket,
    message: RespondTaskCommandTakeoverCommand,
  ): void {
    const responderClientId = transport.getClientId(client);
    if (!responderClientId) {
      return;
    }

    taskCommandTakeovers.respondTakeover(responderClientId, message);
  }

  function handleTaskCommandLease(
    client: WebSocket,
    message: Extract<ClientMessage, { type: 'task-command-lease' }>,
  ): void {
    const result = handleTaskCommandLeaseControlMessage(
      message,
      transport.getClientId(client),
      (snapshot) => {
        emitRemoteLiveIpcEvent(IPC.TaskCommandControllerChanged, snapshot);
      },
    );
    sendJsonMessage(client, result);
  }

  function updatePeerPresence(client: WebSocket, presence: UpdatePresenceCommand): void {
    const clientId = transport.getClientId(client);
    if (!clientId) {
      return;
    }

    peerPresence.updatePeerPresence(clientId, presence);
  }

  function sendMessage(client: WebSocket, message: ServerMessage): boolean {
    return delayedSends.sendSafely(client, JSON.stringify(message)).ok;
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
    batchedSender.cleanup();
    delayedSends.cleanup();
    taskCommandTakeovers.cleanup();
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
    return delayedSends.getPendingChannelSendState(client);
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
    emitCoordinatorChanged,
    emitGitStatusChanged,
    emitTaskConvergenceChanged,
    emitTaskReviewChanged,
    emitTaskReviewSignalsChanged,
    emitTaskStepsChanged,
    emitTaskPortsChanged,
    getPendingChannelSendState,
    getPeerPresenceSnapshots: peerPresence.getPeerPresenceSnapshots,
    getPeerPresenceVersion: peerPresence.getPeerPresenceVersion,
    getRemoteStatus: controlState.getRemoteStatus,
    getRemoteStatusVersion: controlState.getRemoteStatusVersion,
    getServerInfo: controlState.getServerInfo,
    setServerPort: controlState.setServerPort,
    removeGitStatus: controlState.removeGitStatus,
    sendAgentError,
    sendChannelData,
    sendMessage,
    startHeartbeat,
    transport,
    handleTaskCommandLease,
    requestTaskCommandTakeover,
    respondTaskCommandTakeover,
    updatePeerPresence,
  };
}
