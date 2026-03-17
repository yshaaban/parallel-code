import express from 'express';
import { createServer, type IncomingHttpHeaders } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { subscribeAgentSupervision } from '../electron/ipc/agent-supervision.js';
import { createIpcHandlers } from '../electron/ipc/handlers.js';
import {
  getTaskConvergenceSnapshots,
  restoreSavedTaskConvergence,
  subscribeTaskConvergence,
} from '../electron/ipc/task-convergence-state.js';
import { restoreSavedTaskReview, subscribeTaskReview } from '../electron/ipc/task-review-state.js';
import { restoreSavedTaskGitStatusMonitoring } from '../electron/ipc/git-status-workflows.js';
import { stopAllGitWatchers } from '../electron/ipc/git-watcher.js';
import { clearAutoPauseReasonsForChannel } from '../electron/ipc/pty.js';
import { loadAppStateForEnv } from '../electron/ipc/storage.js';
import {
  getExposedTaskPort,
  getTaskPortSnapshots,
  resolveTaskPreviewTarget,
  restoreSavedTaskPorts,
  markTaskPreviewUnavailable,
  subscribeTaskPorts,
} from '../electron/ipc/task-ports.js';
import { buildRemoteAgentList } from '../electron/remote/agent-list.js';
import { createTokenComparator } from '../electron/remote/token-auth.js';
import { registerAgentLifecycleBroadcasts } from './agent-lifecycle.js';
import { createBrowserAuthController } from './browser-auth.js';
import { createBrowserChannelManager } from './browser-channels.js';
import { createBrowserControlPlane } from './browser-control-plane.js';
import { registerBrowserIpcRoutes } from './browser-ipc.js';
import { registerBrowserPreviewRoutes } from './browser-preview.js';
import { registerBrowserStaticRoutes } from './browser-static.js';
import {
  registerBrowserWebSocketServer,
  type BrowserWebSocketServer,
} from './browser-websocket.js';
import { createTaskNameRegistry } from './task-names.js';

type BrowserServerLifecycle =
  | { kind: 'running' }
  | { kind: 'closing'; exitOnClose: boolean }
  | { kind: 'closed' };

export interface StartBrowserServerOptions {
  browserChannelBackpressureDrainIntervalMs?: number;
  browserChannelClientDegradedMaxDrainPasses?: number;
  browserChannelClientDegradedMaxQueueAgeMs?: number;
  browserChannelClientDegradedMaxQueuedBytes?: number;
  browserChannelCoalescedDataMaxBytes?: number;
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

function createBrowserRemoteAccessController(
  controlPlane: ReturnType<typeof createBrowserControlPlane>,
) {
  return {
    getStatusVersion: () => controlPlane.getRemoteStatusVersion(),
    start: async () => controlPlane.getServerInfo(),
    stop: async () => {},
    status: () => controlPlane.getRemoteStatus(),
    subscribe: () => () => {},
  };
}

// Browser-mode composition root. The browser server wires together:
// - browser-ipc.ts for HTTP command/query IPC
// - browser-websocket.ts for websocket control sessions
// - browser-channels.ts for terminal stream routing
// - browser-control-plane.ts for presence, control broadcasts, and lifecycle glue

export function startBrowserServer(options: StartBrowserServerOptions): BrowserServerController {
  const { safeCompare } = createTokenComparator(options.token);
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({
    server,
    maxPayload: 256 * 1024,
    path: '/ws',
  });
  const taskNames = createTaskNameRegistry();
  const savedState = loadAppStateForEnv({ userDataPath: options.userDataPath, isPackaged: false });
  const browserAuth = createBrowserAuthController({
    token: options.token,
  });

  if (savedState) {
    taskNames.syncFromSavedState(savedState);
    restoreSavedTaskPorts(savedState);
  }

  let browserSocketServer: BrowserWebSocketServer | null = null;
  let lifecycle: BrowserServerLifecycle = { kind: 'running' };
  const closeCallbacks = new Set<() => void>();

  function isAuthorizedRequest(req: {
    header?: (name: string) => string | undefined;
    headers: IncomingHttpHeaders;
    url?: string | undefined;
  }): boolean {
    const auth =
      typeof req.header === 'function'
        ? req.header('authorization')
        : typeof req.headers.authorization === 'string'
          ? req.headers.authorization
          : undefined;
    if (auth?.startsWith('Bearer ') && safeCompare(auth.slice(7))) {
      return true;
    }

    return browserAuth.isAuthenticatedRequest(req);
  }

  const controlPlane = createBrowserControlPlane({
    buildAgentList: () =>
      buildRemoteAgentList({
        getTaskName: taskNames.getTaskName,
      }),
    cleanupSocketClient: (client) => {
      browserSocketServer?.cleanupClient(client);
    },
    port: options.port,
    token: options.token,
    ...(options.simulateJitterMs !== undefined
      ? { simulateJitterMs: options.simulateJitterMs }
      : {}),
    ...(options.simulateLatencyMs !== undefined
      ? { simulateLatencyMs: options.simulateLatencyMs }
      : {}),
    ...(options.simulatePacketLoss !== undefined
      ? { simulatePacketLoss: options.simulatePacketLoss }
      : {}),
  });

  const channelManager = createBrowserChannelManager({
    ...(options.browserChannelBackpressureDrainIntervalMs !== undefined
      ? { backpressureDrainIntervalMs: options.browserChannelBackpressureDrainIntervalMs }
      : {}),
    clearAutoPauseReasonsForChannel,
    ...(options.browserChannelClientDegradedMaxDrainPasses !== undefined
      ? { clientDegradedMaxDrainPasses: options.browserChannelClientDegradedMaxDrainPasses }
      : {}),
    ...(options.browserChannelClientDegradedMaxQueueAgeMs !== undefined
      ? { clientDegradedMaxQueueAgeMs: options.browserChannelClientDegradedMaxQueueAgeMs }
      : {}),
    ...(options.browserChannelClientDegradedMaxQueuedBytes !== undefined
      ? { clientDegradedMaxQueuedBytes: options.browserChannelClientDegradedMaxQueuedBytes }
      : {}),
    ...(options.browserChannelCoalescedDataMaxBytes !== undefined
      ? { coalescedChannelDataMaxBytes: options.browserChannelCoalescedDataMaxBytes }
      : {}),
    getPendingChannelSendState: (client) => controlPlane.getPendingChannelSendState(client),
    send: (client, data) => controlPlane.sendChannelData(client, data),
  });

  for (const snapshot of getTaskPortSnapshots()) {
    controlPlane.emitTaskPortsChanged(snapshot);
  }
  const handlers = createIpcHandlers({
    userDataPath: options.userDataPath,
    isPackaged: false,
    sendToChannel: (channelId, message) => {
      channelManager.sendChannelMessage(channelId, message);
    },
    emitIpcEvent: controlPlane.emitIpcEvent,
    emitGitStatusChanged: controlPlane.emitGitStatusChanged,
    remoteAccess: createBrowserRemoteAccessController(controlPlane),
  });

  if (savedState) {
    restoreSavedTaskGitStatusMonitoring(
      {
        emitGitStatusChanged: controlPlane.emitGitStatusChanged,
      },
      savedState,
    );
    restoreSavedTaskConvergence(savedState);
    restoreSavedTaskReview(savedState);
    for (const snapshot of getTaskConvergenceSnapshots()) {
      controlPlane.emitTaskConvergenceChanged(snapshot);
    }
  }

  app.use((req, res, next) => {
    if (browserAuth.handleBootstrapIfPresent(req, res)) {
      return;
    }

    next();
  });
  browserAuth.registerRoutes(app);

  registerBrowserIpcRoutes({
    app,
    broadcastControl: controlPlane.broadcastControl,
    emitGitStatusChanged: controlPlane.emitGitStatusChanged,
    handlers,
    isAuthorizedRequest,
    isAllowedMutationRequest: browserAuth.isAllowedMutationRequest,
    removeGitStatus: controlPlane.removeGitStatus,
    taskNames,
  });

  const cleanupPreviewRoutes = registerBrowserPreviewRoutes({
    app,
    hasExposedTaskPort: (taskId, port) => getExposedTaskPort(taskId, port) !== undefined,
    isAuthorizedRequest,
    isAllowedBrowserOrigin: browserAuth.isAllowedBrowserOrigin,
    markPreviewUnavailable: (taskId, port) => {
      markTaskPreviewUnavailable(taskId, port);
    },
    resolvePreviewTarget: (taskId, port) => resolveTaskPreviewTarget(taskId, port),
    server,
  });

  registerBrowserStaticRoutes({
    app,
    authGatePath: browserAuth.getAuthGatePath(),
    distDir: options.distDir,
    distRemoteDir: options.distRemoteDir,
    isAuthorizedRequest,
  });

  const cleanupAgentLifecycleBroadcasts = registerAgentLifecycleBroadcasts({
    broadcastAgentList: controlPlane.broadcastAgentList,
    broadcastControl: controlPlane.broadcastControl,
    releaseAgentControl: (agentId) => {
      controlPlane.transport.releaseAgentControl(agentId);
    },
  });
  const cleanupAgentSupervision = subscribeAgentSupervision((event) => {
    controlPlane.emitAgentSupervisionChanged(event);
  });
  const cleanupTaskConvergence = subscribeTaskConvergence((event) => {
    controlPlane.emitTaskConvergenceChanged(event);
  });
  const cleanupTaskReview = subscribeTaskReview((event) => {
    controlPlane.emitTaskReviewChanged(event);
  });
  const cleanupTaskPorts = subscribeTaskPorts((event) => {
    controlPlane.emitTaskPortsChanged(event);
  });

  browserSocketServer = registerBrowserWebSocketServer({
    authenticateConnection: controlPlane.authenticateConnection,
    broadcastRemoteStatus: controlPlane.broadcastRemoteStatus,
    channels: channelManager,
    isAuthorizedRequest: browserAuth.isAuthenticatedRequest,
    isAllowedBrowserOrigin: browserAuth.isAllowedBrowserOrigin,
    sendAgentError: controlPlane.sendAgentError,
    sendMessage: (client, message) => controlPlane.sendMessage(client, message),
    safeCompareToken: safeCompare,
    transport: controlPlane.transport,
    wss,
  });

  function cleanupClientState(client: WebSocket): void {
    controlPlane.cleanupClient(client);
    browserSocketServer?.cleanupClient(client);
  }

  server.listen(options.port, '0.0.0.0', () => {
    const info = controlPlane.getServerInfo();
    process.stdout.write(`Parallel Code server listening on ${info.url}\n`);
    if (info.wifiUrl) {
      process.stdout.write(`WiFi: ${info.wifiUrl}\n`);
    }
    if (info.tailscaleUrl) {
      process.stdout.write(`Tailscale: ${info.tailscaleUrl}\n`);
    }
    controlPlane.startHeartbeat();
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
    if (lifecycle.kind !== 'running') {
      return;
    }

    cleanupAgentLifecycleBroadcasts();
    cleanupAgentSupervision();
    cleanupTaskConvergence();
    cleanupTaskReview();
    cleanupTaskPorts();
    cleanupPreviewRoutes();
    stopAllGitWatchers();
    controlPlane.cleanup();
    channelManager.cleanup();
    for (const client of wss.clients) {
      cleanupClientState(client);
      client.close();
    }
    wss.close();
    requestServerClose(false);
  }

  function shutdown(): void {
    if (lifecycle.kind === 'closed') {
      return;
    }

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
