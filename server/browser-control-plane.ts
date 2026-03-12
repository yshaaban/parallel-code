import { WebSocket } from 'ws';
import { IPC } from '../electron/ipc/channels.js';
import type { RemoteAgent, ServerMessage } from '../electron/remote/protocol.js';
import {
  createWebSocketTransport,
  type SendTextResult,
  type WebSocketTransport,
} from '../electron/remote/ws-transport.js';
import {
  createBrowserServerInfo,
  type BrowserRemoteStatus,
  type BrowserServerInfo,
} from './browser-server-info.js';
import { createBrowserSendQueue } from './browser-send-queue.js';

const WS_BACKPRESSURE_MAX_BYTES = 1_048_576;
const MICRO_BATCH_INTERVAL_MS = 8;

export interface BrowserControlPlane {
  authenticateConnection: (client: WebSocket, clientId?: string, lastSeq?: number) => boolean;
  broadcastAgentList: () => void;
  broadcastControl: (message: ServerMessage) => void;
  broadcastRemoteStatus: () => void;
  cleanup: () => void;
  cleanupClient: (client: WebSocket) => void;
  emitIpcEvent: (channel: IPC, payload: unknown) => void;
  getRemoteStatus: () => BrowserRemoteStatus;
  getServerInfo: () => BrowserServerInfo;
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
  buildAgentList: () => RemoteAgent[];
  cleanupSocketClient: (client: WebSocket) => void;
  port: number;
  simulateJitterMs?: number;
  simulateLatencyMs?: number;
  simulatePacketLoss?: number;
  token: string;
}

function addGitStatusControlBroadcast(
  payload: unknown,
  broadcastControl: (message: ServerMessage) => void,
): void {
  const message = payload as {
    branchName?: unknown;
    projectRoot?: unknown;
    status?: {
      has_committed_changes: boolean;
      has_uncommitted_changes: boolean;
    };
    worktreePath?: unknown;
  };

  const statusMessage: ServerMessage = {
    type: 'git-status-changed',
    ...(typeof message.branchName === 'string' ? { branchName: message.branchName } : {}),
    ...(typeof message.projectRoot === 'string' ? { projectRoot: message.projectRoot } : {}),
    ...(message.status ? { status: message.status } : {}),
    ...(typeof message.worktreePath === 'string' ? { worktreePath: message.worktreePath } : {}),
  };

  broadcastControl(statusMessage);
}

export function createBrowserControlPlane(
  options: CreateBrowserControlPlaneOptions,
): BrowserControlPlane {
  const batchedSender = createBrowserSendQueue<WebSocket>({
    flushIntervalMs: MICRO_BATCH_INTERVAL_MS,
    send: (client, message) => sendSafely(client, message).ok,
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
  });

  const serverInfo = createBrowserServerInfo({
    getAuthenticatedClientCount: () => transport.getAuthenticatedClientCount(),
    port: options.port,
    token: options.token,
  });

  function cleanupClient(client: WebSocket): void {
    batchedSender.cleanupClient(client);
  }

  function sendSafely(client: WebSocket, data: string | Buffer): SendTextResult {
    if (client.readyState !== WebSocket.OPEN) {
      return { ok: false, reason: 'not-open' };
    }
    if (client.bufferedAmount > WS_BACKPRESSURE_MAX_BYTES) {
      return { ok: false, reason: 'backpressure' };
    }

    try {
      client.send(data);
      return { ok: true };
    } catch (error) {
      cleanupClient(client);
      options.cleanupSocketClient(client);
      try {
        client.close();
      } catch {
        /* ignore secondary close failures */
      }
      return {
        ok: false,
        reason: 'send-error',
        error,
      };
    }
  }

  function sendChannelData(client: WebSocket, data: string | Buffer): boolean {
    const simulatePacketLoss = options.simulatePacketLoss ?? 0;
    const simulateLatencyMs = options.simulateLatencyMs ?? 0;
    const simulateJitterMs = options.simulateJitterMs ?? 0;

    if (simulatePacketLoss > 0 && Math.random() < simulatePacketLoss) {
      return true;
    }
    if (simulateLatencyMs > 0 || simulateJitterMs > 0) {
      if (client.readyState !== WebSocket.OPEN) {
        return false;
      }

      const delay = simulateLatencyMs + Math.random() * simulateJitterMs;
      setTimeout(() => {
        void sendSafely(client, data);
      }, delay);
      return true;
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

    if (channel === IPC.GitStatusChanged) {
      addGitStatusControlBroadcast(payload, broadcastControl);
    }
  }

  function broadcastAgentList(): void {
    transport.broadcast({
      type: 'agents',
      list: options.buildAgentList(),
    });
  }

  function broadcastRemoteStatus(): void {
    const remoteStatus = serverInfo.getRemoteStatus();
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

  return {
    authenticateConnection,
    broadcastAgentList,
    broadcastControl,
    broadcastRemoteStatus,
    cleanup,
    cleanupClient,
    emitIpcEvent,
    getRemoteStatus: serverInfo.getRemoteStatus,
    getServerInfo: serverInfo.getServerInfo,
    sendAgentError,
    sendChannelData,
    sendMessage,
    startHeartbeat: transport.startHeartbeat,
    transport,
  };
}
