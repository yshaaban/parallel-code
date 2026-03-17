import { WebSocket } from 'ws';
import { IPC } from '../electron/ipc/channels.js';
import type { RemoteAgent, ServerMessage } from '../electron/remote/protocol.js';
import type {
  AgentSupervisionEvent,
  GitStatusSyncEvent,
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
const MICRO_BATCH_INTERVAL_MS = 8;
const DELAYED_SEND_RETRY_INTERVAL_MS = 25;

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
    getAuthenticatedClientCount: () => transport.getAuthenticatedClientCount(),
    port: options.port,
    token: options.token,
  });

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

  function cleanupClient(client: WebSocket): void {
    batchedSender.cleanupClient(client);
    clearDelayedClientSendState(client);
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

    if (lastSeq !== undefined) {
      transport.replayControlEvents(client, lastSeq);
    }
    sendAgentSnapshot(client);
    sendJsonMessage(client, controlState.createStateBootstrapMessage());
    return true;
  }

  function broadcastControl(message: ServerMessage): void {
    transport.broadcastControl(message);
  }

  function emitIpcEvent(channel: IPC, payload: unknown): void {
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
    getRemoteStatus: controlState.getRemoteStatus,
    getRemoteStatusVersion: controlState.getRemoteStatusVersion,
    getServerInfo: controlState.getServerInfo,
    removeGitStatus: controlState.removeGitStatus,
    sendAgentError,
    sendChannelData,
    sendMessage,
    startHeartbeat: transport.startHeartbeat,
    transport,
  };
}
