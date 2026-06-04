import express from 'express';
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { subscribeCoordinatorEvents } from '../electron/coordinator/runtime.js';
import {
  ensureCoordinatorServiceLoaded,
  startCoordinatorRuntimePersistence,
} from '../electron/coordinator/service.js';
import { startCoordinatorPromptDeliveryRuntime } from '../electron/coordinator/tool-gateway.js';
import { subscribeAgentSupervision } from '../electron/ipc/agent-supervision.js';
import { IPC } from '../electron/ipc/channels.js';
import type { HandlerContext } from '../electron/ipc/handler-context.js';
import { createIpcHandlers } from '../electron/ipc/handlers.js';
import {
  getTaskConvergenceSnapshots,
  getTaskConvergenceStateVersion,
  restoreSavedTaskConvergence,
  subscribeTaskConvergence,
} from '../electron/ipc/task-convergence-state.js';
import { restoreSavedTaskReview, subscribeTaskReview } from '../electron/ipc/task-review-state.js';
import {
  getTaskReviewSignalsStateVersion,
  listTaskReviewSignalsSnapshots,
  restoreSavedTaskReviewSignals,
  subscribeTaskReviewSignals,
} from '../electron/ipc/task-review-signals.js';
import {
  getTaskStepsStateVersion,
  listTaskStepsSummarySnapshots,
  restoreSavedTaskSteps,
  subscribeTaskSteps,
} from '../electron/ipc/task-steps.js';
import { restoreSavedTaskGitStatusMonitoring } from '../electron/ipc/git-status-workflows.js';
import { stopAllGitWatchers } from '../electron/ipc/git-watcher.js';
import { clearAutoPauseReasonsForChannel } from '../electron/ipc/pty.js';
import { loadAppStateForEnv, loadTaskRegistryStateForEnv } from '../electron/ipc/storage.js';
import {
  clearTaskContainerPreviewTargets,
  hasTaskContainerPreviewTarget,
  resolveTaskContainerPreviewTarget,
} from '../electron/ipc/task-containers.js';
import {
  getExposedTaskPort,
  getTaskPortsStateVersion,
  getTaskPortSnapshots,
  resolveTaskPreviewTarget,
  restoreSavedTaskPorts,
  markTaskPreviewUnavailable,
  subscribeTaskPorts,
} from '../electron/ipc/task-ports.js';
import { buildRemoteAgentList } from '../electron/remote/agent-list.js';
import { createTokenComparator } from '../electron/remote/token-auth.js';
import { createTaskPortsSnapshotEvent } from '../src/domain/server-state.js';
import { isRecord } from '../src/lib/type-guards.js';
import { registerAgentLifecycleBroadcasts } from './agent-lifecycle.js';
import { createBrowserAuthController } from './browser-auth.js';
import { createBrowserChannelManager } from './browser-channels.js';
import { createBrowserControlPlane } from './browser-control-plane.js';
import { registerBrowserIpcRoutes } from './browser-ipc.js';
import { registerBrowserLatencyDiagnosticsRoutes } from './browser-latency-diagnostics.js';
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

const CONTROL_SOCKET_PATH = '/ws';
const COORDINATOR_TOOL_CALL_PATH = '/api/coordinator/tool-call';
const PREVIEW_SOCKET_PATH_PREFIXES = ['/_preview/', '/_container_preview/'] as const;
const REQUEST_URL_BASE = 'http://localhost';

export interface StartBrowserServerOptions {
  browserChannelBackpressureDrainIntervalMs?: number;
  browserChannelClientDegradedMaxDrainPasses?: number;
  browserChannelClientDegradedMaxQueueAgeMs?: number;
  browserChannelClientDegradedMaxQueuedBytes?: number;
  browserChannelCoalescedDataMaxBytes?: number;
  browserControlHeartbeatIntervalMs?: number;
  browserControlMaxMissedPongs?: number;
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

function getUpgradePathname(req: IncomingMessage): string | null {
  const value = req.url ?? '/';
  return URL.canParse(value, REQUEST_URL_BASE) ? new URL(value, REQUEST_URL_BASE).pathname : null;
}

function isPreviewSocketPath(pathname: string): boolean {
  return PREVIEW_SOCKET_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
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

function getCoordinatorToolCallUrl(port: number): string {
  return `http://127.0.0.1:${port}${COORDINATOR_TOOL_CALL_PATH}`;
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
    maxPayload: 256 * 1024,
    noServer: true,
  });
  const handleControlSocketUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = getUpgradePathname(req);
    if (pathname !== CONTROL_SOCKET_PATH) {
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit('connection', client, req);
    });
  };
  server.on('upgrade', handleControlSocketUpgrade);
  const handleUnknownSocketUpgrade = (req: IncomingMessage, socket: Duplex): void => {
    const pathname = getUpgradePathname(req);
    if (pathname === CONTROL_SOCKET_PATH || (pathname && isPreviewSocketPath(pathname))) {
      return;
    }

    const statusLine = pathname ? 'HTTP/1.1 404 Not Found' : 'HTTP/1.1 400 Bad Request';
    socket.write(`${statusLine}\r\n\r\n`);
    socket.destroy();
  };
  const taskNames = createTaskNameRegistry();
  const storageEnv = { userDataPath: options.userDataPath, isPackaged: false } as const;
  const savedAppState = loadAppStateForEnv(storageEnv);
  const savedTaskRegistryState = loadTaskRegistryStateForEnv(storageEnv);
  const browserAuth = createBrowserAuthController({
    token: options.token,
  });

  if (savedTaskRegistryState) {
    taskNames.syncFromSavedState(savedTaskRegistryState);
  }

  if (savedAppState) {
    restoreSavedTaskPorts(savedAppState);
  }

  let browserSocketServer: BrowserWebSocketServer | null = null;
  let lifecycle: BrowserServerLifecycle = { kind: 'running' };
  const closeCallbacks = new Set<() => void>();
  let browserSocketInfrastructureCleaned = false;
  let processHandlersRemoved = false;

  function getSimulatedClientMessageDelayMs(): number {
    const latencyMs = Math.max(0, options.simulateLatencyMs ?? 0);
    const jitterMs = Math.max(0, options.simulateJitterMs ?? 0);
    return latencyMs + (jitterMs > 0 ? Math.random() * jitterMs : 0);
  }

  function shouldDropSimulatedClientMessage(): boolean {
    const packetLoss = Math.min(1, Math.max(0, options.simulatePacketLoss ?? 0));
    return packetLoss > 0 && Math.random() < packetLoss;
  }

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
        getTaskMetadata: taskNames.getTaskMetadata,
        getTaskName: taskNames.getTaskName,
      }),
    cleanupSocketClient: (client) => {
      browserSocketServer?.cleanupClient(client);
    },
    port: options.port,
    token: options.token,
    ...(options.browserControlHeartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: options.browserControlHeartbeatIntervalMs }
      : {}),
    ...(options.browserControlMaxMissedPongs !== undefined
      ? { maxMissedPongs: options.browserControlMaxMissedPongs }
      : {}),
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

  const taskPortsStateVersion = getTaskPortsStateVersion();
  for (const snapshot of getTaskPortSnapshots()) {
    controlPlane.emitTaskPortsChanged({
      ...createTaskPortsSnapshotEvent(snapshot),
      stateVersion: taskPortsStateVersion,
    });
  }
  const handlerContext: HandlerContext = {
    userDataPath: options.userDataPath,
    isPackaged: false,
    coordinatorToolCallUrl: () => getCoordinatorToolCallUrl(controlPlane.getServerInfo().port),
    sendToChannel: (channelId, message) => {
      channelManager.sendChannelMessage(channelId, message);
    },
    isChannelActive: (channelId) => channelManager.hasActiveSubscriber(channelId),
    emitIpcEvent: controlPlane.emitIpcEvent,
    emitGitStatusChanged: controlPlane.emitGitStatusChanged,
    remoteAccess: createBrowserRemoteAccessController(controlPlane),
  };
  ensureCoordinatorServiceLoaded(handlerContext);
  const cleanupCoordinatorPersistence = startCoordinatorRuntimePersistence(handlerContext);
  const cleanupCoordinatorPromptDelivery = startCoordinatorPromptDeliveryRuntime(
    handlerContext,
    taskNames,
  );
  const handlers = createIpcHandlers(handlerContext, taskNames);

  if (savedAppState) {
    restoreSavedTaskGitStatusMonitoring(
      {
        emitGitStatusChanged: controlPlane.emitGitStatusChanged,
      },
      savedAppState,
    );
    restoreSavedTaskConvergence(savedAppState);
    restoreSavedTaskReview(savedAppState);
    restoreSavedTaskReviewSignals(savedAppState);
    restoreSavedTaskSteps(savedAppState);
    const taskConvergenceStateVersion = getTaskConvergenceStateVersion();
    for (const snapshot of getTaskConvergenceSnapshots()) {
      controlPlane.emitTaskConvergenceChanged({
        ...snapshot,
        stateVersion: taskConvergenceStateVersion,
      });
    }
    const taskStepsStateVersion = getTaskStepsStateVersion();
    for (const snapshot of listTaskStepsSummarySnapshots()) {
      controlPlane.emitTaskStepsChanged({
        ...snapshot,
        stateVersion: taskStepsStateVersion,
      });
    }
    const taskReviewSignalsStateVersion = getTaskReviewSignalsStateVersion();
    for (const snapshot of listTaskReviewSignalsSnapshots()) {
      controlPlane.emitTaskReviewSignalsChanged({
        ...snapshot,
        stateVersion: taskReviewSignalsStateVersion,
      });
    }
  }

  app.use((req, res, next) => {
    if (browserAuth.handleBootstrapIfPresent(req, res)) {
      return;
    }

    next();
  });
  browserAuth.registerRoutes(app);

  app.post(COORDINATOR_TOOL_CALL_PATH, express.json({ limit: '1mb' }), async (req, res) => {
    const handler = handlers[IPC.CoordinatorToolCall];
    if (!handler) {
      res.status(404).json({ error: 'coordinator tool call handler unavailable' });
      return;
    }
    if (!isRecord(req.body)) {
      res.status(400).json({ error: 'coordinator tool call body must be an object' });
      return;
    }

    try {
      const result = await handler(req.body);
      res.json({ result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal error';
      res.status(400).json({ error: message });
    }
  });

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
  registerBrowserLatencyDiagnosticsRoutes({
    app,
    authGatePath: browserAuth.getAuthGatePath(),
    isAuthorizedRequest,
  });

  const cleanupPreviewRoutes = registerBrowserPreviewRoutes({
    app,
    hasExposedTaskPort: (taskId, port) => getExposedTaskPort(taskId, port) !== undefined,
    hasTaskContainerPreviewTarget,
    isAuthorizedRequest,
    isAllowedBrowserOrigin: browserAuth.isAllowedBrowserOrigin,
    markPreviewUnavailable: (taskId, port) => {
      markTaskPreviewUnavailable(taskId, port);
    },
    resolveTaskContainerPreviewTarget: async (taskId, port) =>
      resolveTaskContainerPreviewTarget(taskId, port),
    resolvePreviewTarget: (taskId, port) => resolveTaskPreviewTarget(taskId, port),
    server,
  });
  server.on('upgrade', handleUnknownSocketUpgrade);

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
  const cleanupCoordinatorEvents = subscribeCoordinatorEvents((event) => {
    controlPlane.emitCoordinatorChanged(event);
  });
  const cleanupTaskConvergence = subscribeTaskConvergence((event) => {
    controlPlane.emitTaskConvergenceChanged(event);
  });
  const cleanupTaskReview = subscribeTaskReview((event) => {
    controlPlane.emitTaskReviewChanged(event);
  });
  const cleanupTaskReviewSignals = subscribeTaskReviewSignals((event) => {
    controlPlane.emitTaskReviewSignalsChanged(event);
  });
  const cleanupTaskSteps = subscribeTaskSteps((event) => {
    controlPlane.emitTaskStepsChanged(event);
  });
  const cleanupTaskPorts = subscribeTaskPorts((event) => {
    controlPlane.emitTaskPortsChanged(event);
  });
  const cleanedClients = new WeakSet<WebSocket>();

  function cleanupClientState(client: WebSocket): void {
    if (cleanedClients.has(client)) {
      return;
    }

    cleanedClients.add(client);
    const clientId = controlPlane.transport.getClientId(client);
    browserSocketServer?.cleanupClient(client);
    controlPlane.cleanupClient(client);
    if (clientId && !controlPlane.transport.hasClientId(clientId)) {
      browserSocketServer?.pruneDisconnectedAgentCommandResults();
    }
  }

  function cleanupBrowserSocketInfrastructure(): void {
    if (browserSocketInfrastructureCleaned) {
      return;
    }

    browserSocketInfrastructureCleaned = true;
    browserSocketServer?.cleanup();
    controlPlane.cleanup();
    channelManager.cleanup();
  }

  const handleUncaughtException = (err: unknown): void => {
    console.error('[server] Uncaught Exception:', err);
  };
  const handleUnhandledRejection = (reason: unknown): void => {
    console.error('[server] Unhandled Rejection:', reason);
  };
  const handleSigint = (): void => {
    shutdown();
  };
  const handleSigterm = (): void => {
    shutdown();
  };

  function removeProcessHandlers(): void {
    if (processHandlersRemoved || !(options.registerProcessHandlers ?? true)) {
      return;
    }

    processHandlersRemoved = true;
    process.off('uncaughtException', handleUncaughtException);
    process.off('unhandledRejection', handleUnhandledRejection);
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
  }

  browserSocketServer = registerBrowserWebSocketServer({
    authenticateConnection: controlPlane.authenticateConnection,
    broadcastRemoteStatus: controlPlane.broadcastRemoteStatus,
    channels: channelManager,
    cleanupClientState,
    getClientMessageDelayMs: getSimulatedClientMessageDelayMs,
    isAuthorizedRequest: browserAuth.isAuthenticatedRequest,
    isAllowedBrowserOrigin: browserAuth.isAllowedBrowserOrigin,
    sendAgentError: controlPlane.sendAgentError,
    sendMessage: (client, message) => controlPlane.sendMessage(client, message),
    shouldDropClientMessage: shouldDropSimulatedClientMessage,
    handleTaskCommandLease: controlPlane.handleTaskCommandLease,
    requestTaskCommandTakeover: controlPlane.requestTaskCommandTakeover,
    respondTaskCommandTakeover: controlPlane.respondTaskCommandTakeover,
    safeCompareToken: safeCompare,
    transport: controlPlane.transport,
    updatePeerPresence: controlPlane.updatePeerPresence,
    wss,
  });

  wss.on('close', () => {
    cleanupBrowserSocketInfrastructure();
  });

  server.listen(options.port, '0.0.0.0', () => {
    const address = server.address();
    if (address && typeof address !== 'string') {
      controlPlane.setServerPort(address.port);
    }

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
    removeProcessHandlers();

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

    removeProcessHandlers();
    cleanupAgentLifecycleBroadcasts();
    cleanupAgentSupervision();
    cleanupCoordinatorEvents();
    cleanupCoordinatorPersistence();
    cleanupCoordinatorPromptDelivery();
    cleanupTaskConvergence();
    cleanupTaskReview();
    cleanupTaskReviewSignals();
    cleanupTaskSteps();
    cleanupTaskPorts();
    server.off('upgrade', handleControlSocketUpgrade);
    server.off('upgrade', handleUnknownSocketUpgrade);
    cleanupPreviewRoutes();
    clearTaskContainerPreviewTargets();
    stopAllGitWatchers();
    for (const client of wss.clients) {
      cleanupClientState(client);
      client.close();
    }
    cleanupBrowserSocketInfrastructure();
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
    process.on('uncaughtException', handleUncaughtException);
    process.on('unhandledRejection', handleUnhandledRejection);
    process.on('SIGINT', handleSigint);
    process.on('SIGTERM', handleSigterm);
  }

  return {
    cleanup,
    shutdown,
  };
}
