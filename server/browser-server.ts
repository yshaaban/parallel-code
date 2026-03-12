import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { IPC } from '../electron/ipc/channels.js';
import { createIpcHandlers } from '../electron/ipc/handlers.js';
import { stopAllGitWatchers } from '../electron/ipc/git-watcher.js';
import { clearAutoPauseReasonsForChannel } from '../electron/ipc/pty.js';
import { loadAppStateForEnv } from '../electron/ipc/storage.js';
import { buildRemoteAgentList } from '../electron/remote/agent-list.js';
import { type ServerMessage } from '../electron/remote/protocol.js';
import { createTokenComparator } from '../electron/remote/token-auth.js';
import { createWebSocketTransport, type SendTextResult } from '../electron/remote/ws-transport.js';
import { registerAgentLifecycleBroadcasts } from './agent-lifecycle.js';
import { createBrowserChannelManager } from './browser-channels.js';
import { registerBrowserIpcRoutes, startSavedTaskGitWatchers } from './browser-ipc.js';
import { registerBrowserStaticRoutes } from './browser-static.js';
import { createBrowserSendQueue } from './browser-send-queue.js';
import { createBrowserServerInfo } from './browser-server-info.js';
import {
  registerBrowserWebSocketServer,
  type BrowserWebSocketServer,
} from './browser-websocket.js';
import { createTaskNameRegistry } from './task-names.js';

type WebSocketClient = WebSocket;

type BrowserServerLifecycle =
  | { kind: 'running' }
  | { kind: 'closing'; exitOnClose: boolean }
  | { kind: 'closed' };

export interface StartBrowserServerOptions {
  distDir: string;
  distRemoteDir: string;
  port: number;
  registerProcessHandlers?: boolean;
  simulateJitterMs?: number;
  simulateLatencyMs?: number;
  simulatePacketLoss?: number;
  token: string;
  userDataPath: string;
}

export interface BrowserServerController {
  cleanup: () => void;
  shutdown: () => void;
}

const WS_BACKPRESSURE_MAX_BYTES = 1_048_576;
const MICRO_BATCH_INTERVAL_MS = 8;

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

export function startBrowserServer(options: StartBrowserServerOptions): BrowserServerController {
  const { safeCompare } = createTokenComparator(options.token);
  const app = express();
  const server = createServer(app);
  const taskNames = createTaskNameRegistry();
  const wss = new WebSocketServer({
    server,
    maxPayload: 256 * 1024,
  });
  const savedState = loadAppStateForEnv({ userDataPath: options.userDataPath, isPackaged: false });

  if (savedState) {
    taskNames.syncFromSavedState(savedState);
  }

  let browserSocketServer: BrowserWebSocketServer | null = null;
  let lifecycle: BrowserServerLifecycle = { kind: 'running' };
  const closeCallbacks = new Set<() => void>();

  const batchedSender = createBrowserSendQueue<WebSocketClient>({
    flushIntervalMs: MICRO_BATCH_INTERVAL_MS,
    send: (client, message) => sendSafely(client, message).ok,
  });

  function cleanupClientState(client: WebSocketClient): void {
    batchedSender.cleanupClient(client);
    browserSocketServer?.cleanupClient(client);
  }

  function sendSafely(client: WebSocketClient, data: string | Buffer): SendTextResult {
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
      const wasAuthenticated = transport.isAuthenticated(client);
      cleanupClientState(client);
      if (wasAuthenticated) {
        broadcastRemoteStatus();
      }
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

  function simulatedSend(client: WebSocketClient, data: string | Buffer): SendTextResult {
    const simulatePacketLoss = options.simulatePacketLoss ?? 0;
    const simulateLatencyMs = options.simulateLatencyMs ?? 0;
    const simulateJitterMs = options.simulateJitterMs ?? 0;

    if (simulatePacketLoss > 0 && Math.random() < simulatePacketLoss) {
      return { ok: true };
    }
    if (simulateLatencyMs > 0 || simulateJitterMs > 0) {
      if (client.readyState !== WebSocket.OPEN) {
        return { ok: false, reason: 'not-open' };
      }
      const delay = simulateLatencyMs + Math.random() * simulateJitterMs;
      setTimeout(() => {
        void sendSafely(client, data);
      }, delay);
      return { ok: true };
    }

    return sendSafely(client, data);
  }

  const channelManager = createBrowserChannelManager({
    clearAutoPauseReasonsForChannel,
    send: (client, data) => simulatedSend(client, data).ok,
  });

  const transport = createWebSocketTransport<WebSocketClient>({
    closeClient: (client, code, reason) => {
      client.close(code, reason);
    },
    sendBroadcastText: (client, text) => {
      batchedSender.queueMessage(client, text);
      return { ok: true };
    },
    sendDirectText: (client, text) => sendSafely(client, text),
    terminateClient: (client) => {
      client.terminate();
    },
  });

  const serverInfo = createBrowserServerInfo({
    getAuthenticatedClientCount: () => transport.getAuthenticatedClientCount(),
    port: options.port,
    token: options.token,
  });

  function buildAgentList() {
    return buildRemoteAgentList({
      getTaskName: taskNames.getTaskName,
    });
  }

  function sendJsonMessage(client: WebSocketClient, message: ServerMessage): void {
    void sendSafely(client, JSON.stringify(message));
  }

  function sendAgentError(
    client: WebSocketClient,
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

  function sendAgentList(client: WebSocketClient): void {
    sendJsonMessage(client, {
      type: 'agents',
      list: buildAgentList(),
    });
  }

  function sendAgentControllers(client: WebSocketClient): void {
    transport.sendAgentControllers(client);
  }

  function sendAgentSnapshot(client: WebSocketClient): void {
    sendAgentList(client);
    sendAgentControllers(client);
  }

  function replayStaleEvents(client: WebSocketClient, lastSeq = -1): void {
    transport.replayControlEvents(client, lastSeq);
  }

  function broadcast(message: ServerMessage): void {
    transport.broadcast(message);
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
    broadcast({
      type: 'agents',
      list: buildAgentList(),
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

  function authenticateConnection(
    client: WebSocketClient,
    clientId?: string,
    lastSeq?: number,
  ): boolean {
    const authResult = transport.authenticateClient(client, clientId);
    if (!authResult.ok) return false;
    if (lastSeq !== undefined) {
      replayStaleEvents(client, lastSeq);
    }
    sendAgentSnapshot(client);
    broadcastRemoteStatus();
    return true;
  }

  function isAuthorizedRequest(req: express.Request): boolean {
    const auth = req.header('authorization');
    if (auth?.startsWith('Bearer ') && safeCompare(auth.slice(7))) return true;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
    return safeCompare(queryToken);
  }

  const handlers = createIpcHandlers({
    userDataPath: options.userDataPath,
    isPackaged: false,
    sendToChannel: (channelId, message) => {
      channelManager.sendChannelMessage(channelId, message);
    },
    emitIpcEvent,
    remoteAccess: {
      start: async () => serverInfo.getServerInfo(),
      stop: async () => {},
      status: () => serverInfo.getRemoteStatus(),
    },
  });

  if (savedState) {
    startSavedTaskGitWatchers({
      broadcastControl,
      emitIpcEvent,
      savedJson: savedState,
    });
  }

  registerBrowserIpcRoutes({
    app,
    broadcastControl,
    handlers,
    isAuthorizedRequest,
    taskNames,
  });

  registerBrowserStaticRoutes({
    app,
    distDir: options.distDir,
    distRemoteDir: options.distRemoteDir,
  });

  const cleanupAgentLifecycleBroadcasts = registerAgentLifecycleBroadcasts({
    broadcastAgentList,
    broadcastControl,
    releaseAgentControl: (agentId) => {
      transport.releaseAgentControl(agentId);
    },
  });

  browserSocketServer = registerBrowserWebSocketServer({
    authenticateConnection,
    broadcastRemoteStatus,
    channels: channelManager,
    sendAgentError,
    sendMessage: (client, message) => sendSafely(client, JSON.stringify(message)).ok,
    safeCompareToken: safeCompare,
    transport,
    wss,
  });

  server.listen(options.port, '0.0.0.0', () => {
    const info = serverInfo.getServerInfo();
    process.stdout.write(`Parallel Code server listening on ${info.url}\n`);
    if (info.wifiUrl) process.stdout.write(`WiFi: ${info.wifiUrl}\n`);
    if (info.tailscaleUrl) process.stdout.write(`Tailscale: ${info.tailscaleUrl}\n`);
    transport.startHeartbeat();
  });

  server.on('close', () => {
    const shouldExit = lifecycle.kind === 'closing' ? lifecycle.exitOnClose : false;
    lifecycle = { kind: 'closed' };

    for (const callback of closeCallbacks) {
      callback();
    }
    closeCallbacks.clear();

    if (shouldExit) {
      process.exit(0);
    }
  });

  function requestServerClose(exitOnClose = false, onClosed?: () => void): void {
    if (lifecycle.kind === 'closed') {
      onClosed?.();
      return;
    }

    if (onClosed) {
      closeCallbacks.add(onClosed);
    }

    if (lifecycle.kind === 'closing') {
      if (exitOnClose && !lifecycle.exitOnClose) {
        lifecycle = { kind: 'closing', exitOnClose: true };
      }
      return;
    }

    lifecycle = { kind: 'closing', exitOnClose };
    server.close();
  }

  function cleanup(): void {
    if (lifecycle.kind !== 'running') return;

    cleanupAgentLifecycleBroadcasts();
    stopAllGitWatchers();
    transport.stopHeartbeat();
    channelManager.cleanup();
    for (const client of wss.clients) {
      cleanupClientState(client);
      client.close();
    }
    wss.close();
    requestServerClose(false);
  }

  function shutdown(): void {
    if (lifecycle.kind === 'closed') return;
    cleanup();
    requestServerClose(true);
  }

  if (options.registerProcessHandlers ?? true) {
    process.on('uncaughtException', (err) => {
      console.error('[server] Uncaught Exception:', err);
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[server] Unhandled Rejection:', reason);
    });

    process.on('SIGINT', () => {
      shutdown();
    });

    process.on('SIGTERM', () => {
      shutdown();
    });
  }

  return {
    cleanup,
    shutdown,
  };
}
