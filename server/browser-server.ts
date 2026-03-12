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
import { createWebSocketTransport } from '../electron/remote/ws-transport.js';
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

  broadcastControl({
    type: 'git-status-changed',
    branchName: typeof message.branchName === 'string' ? message.branchName : undefined,
    projectRoot: typeof message.projectRoot === 'string' ? message.projectRoot : undefined,
    status: message.status,
    worktreePath: typeof message.worktreePath === 'string' ? message.worktreePath : undefined,
  });
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
  let cleanedUp = false;
  let serverCloseRequested = false;
  let serverClosed = false;
  let shuttingDown = false;

  const batchedSender = createBrowserSendQueue<WebSocketClient>({
    flushIntervalMs: MICRO_BATCH_INTERVAL_MS,
    send: (client, message) => sendSafely(client, message),
  });

  function cleanupClientState(client: WebSocketClient): void {
    batchedSender.cleanupClient(client);
    browserSocketServer?.cleanupClient(client);
  }

  function sendSafely(client: WebSocketClient, data: string | Buffer): boolean {
    if (client.readyState !== WebSocket.OPEN) return false;
    if (client.bufferedAmount > WS_BACKPRESSURE_MAX_BYTES) return false;

    try {
      client.send(data);
      return true;
    } catch {
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
      return false;
    }
  }

  function simulatedSend(client: WebSocketClient, data: string | Buffer): boolean {
    const simulatePacketLoss = options.simulatePacketLoss ?? 0;
    const simulateLatencyMs = options.simulateLatencyMs ?? 0;
    const simulateJitterMs = options.simulateJitterMs ?? 0;

    if (simulatePacketLoss > 0 && Math.random() < simulatePacketLoss) return true;
    if (simulateLatencyMs > 0 || simulateJitterMs > 0) {
      if (client.readyState !== WebSocket.OPEN) return false;
      const delay = simulateLatencyMs + Math.random() * simulateJitterMs;
      setTimeout(() => {
        void sendSafely(client, data);
      }, delay);
      return true;
    }

    return sendSafely(client, data);
  }

  const channelManager = createBrowserChannelManager({
    clearAutoPauseReasonsForChannel,
    send: simulatedSend,
  });

  const transport = createWebSocketTransport<WebSocketClient>({
    closeClient: (client, code, reason) => {
      client.close(code, reason);
    },
    sendBroadcastText: (client, text) => batchedSender.queueMessage(client, text),
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
    if (!transport.authenticateClient(client, clientId)) return false;
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
    sendMessage: (client, message) => sendSafely(client, JSON.stringify(message)),
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
    serverClosed = true;
  });

  function requestServerClose(onClosed?: () => void): void {
    if (serverClosed) {
      onClosed?.();
      return;
    }

    if (onClosed) {
      server.once('close', onClosed);
    }

    if (serverCloseRequested) return;
    serverCloseRequested = true;
    server.close();
  }

  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;

    cleanupAgentLifecycleBroadcasts();
    stopAllGitWatchers();
    transport.stopHeartbeat();
    channelManager.cleanup();
    for (const client of wss.clients) {
      cleanupClientState(client);
      client.close();
    }
    wss.close();
    requestServerClose();
  }

  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    cleanup();
    requestServerClose(() => process.exit(0));
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
