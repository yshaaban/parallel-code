import express from 'express';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'http';
import { createServer as createHttpsServer } from 'https';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { subscribeAgentAvailability } from '../electron/ipc/agent-availability-state.js';
import { subscribeAgentSupervision } from '../electron/ipc/agent-supervision.js';
import {
  getAgentDefsWithLastKnownAvailability,
  requestAgentCatalogAvailabilityRevalidation,
} from '../electron/ipc/agents.js';
import {
  cancelBackendBackgroundReconciliation,
  clearBackendClientFocus,
  getAllBackendFocusedChannelIds,
  releaseBackendBackgroundWork,
  subscribeBackendClientFocusedChannels,
} from '../electron/ipc/backend-work-queue.js';
import { IPC } from '../electron/ipc/channels.js';
import { stopAllAskAboutCodeRequests } from '../electron/ipc/ask-about-code.js';
import {
  loadPersistedDerivedState,
  startDerivedStatePersistence,
} from '../electron/ipc/derived-state-persistence.js';
import type { HandlerContext } from '../electron/ipc/handler-context.js';
import { createIpcHandlers } from '../electron/ipc/handlers.js';
import type {
  RemoteCommandRegistrationTable,
  RemoteGrant,
} from '../electron/ipc/remote-command-gateway.js';
import { mergeRemoteCommandRegistrationTables } from '../electron/ipc/remote-command-gateway.js';
import { restoreBackendDerivedState } from '../electron/ipc/saved-state-restore.js';
import {
  getTaskConvergenceSnapshots,
  getTaskConvergenceStateVersion,
  subscribeTaskConvergence,
} from '../electron/ipc/task-convergence-state.js';
import {
  getTaskReviewStateVersion,
  listTaskReviewSnapshots,
  subscribeTaskReview,
} from '../electron/ipc/task-review-state.js';
import {
  getTaskReviewSignalsStateVersion,
  listTaskReviewSignalsSnapshots,
  subscribeTaskReviewSignals,
} from '../electron/ipc/task-review-signals.js';
import {
  getTaskStepsStateVersion,
  listTaskStepsSummarySnapshots,
  subscribeTaskSteps,
} from '../electron/ipc/task-steps.js';
import {
  getGitStatusStateVersion,
  listGitStatusSnapshots,
} from '../electron/ipc/git-status-state.js';
import { stopAllGitWatchers } from '../electron/ipc/git-watcher.js';
import { clearAutoPauseReasonsForChannel } from '../electron/ipc/pty.js';
import {
  loadAppStateDocumentForEnv,
  loadTaskRegistryStateDocumentForEnv,
} from '../electron/ipc/storage.js';
import type { SavedStateDocument } from '../electron/ipc/saved-state-document.js';
import { getServerInstanceId } from '../electron/ipc/server-instance.js';
import { buildTaskCatalogAgentChoices } from '../electron/ipc/task-catalog-agent-choices.js';
import {
  getCurrentTaskCatalogSessionRuntime,
  subscribeTaskCatalogPtyRuntime,
} from '../electron/ipc/task-catalog-runtime-composition.js';
import { createTaskCatalogState } from '../electron/ipc/task-catalog-state.js';
import { createTaskExperienceRemoteCommandRegistrations } from '../electron/ipc/task-experience-remote-registrations.js';
import { createRemoteTaskCreationOperationSource } from '../electron/ipc/task-creation-remote-commands.js';
import {
  createProductionTaskExperienceRuntime,
  stopAgentRunnersAfterTaskExperience,
  TaskExperienceRuntimeActivationError,
  type ProductionTaskExperienceRuntime,
} from '../electron/ipc/task-experience-runtime-composition.js';
import { createTaskNotesEventStream } from '../src/runtime/task-notes-event-stream.js';
import {
  snapshotTaskNotesWriterEntitlements,
  type TaskNotesWriterEntitlements,
} from '../electron/ipc/task-notes-writer-entitlements.js';
import {
  createActiveTaskReliabilityIpcHandlers,
  subscribeActiveTaskReliabilityRuntime,
} from '../electron/ipc/task-reliability-ipc.js';
import type { JsonObject } from '../electron/ipc/workspace-state-storage.js';
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
import {
  buildSecureSessionBootstrapUrl,
  type RemotePeerTrustPolicy,
} from '../electron/remote/network.js';
import type { RemoteAuthHttpPaths } from '../electron/remote/remote-auth-http.js';
import {
  createScopedRemoteCommandRuntime,
  type ScopedRemoteCommandRuntime,
} from '../electron/remote/scoped-command-runtime.js';
import {
  collectRuntimeCleanupFailures,
  settleWorkspaceStorageCleanupOwners,
  type RuntimeCleanupFailure,
} from '../electron/runtime-cleanup.js';
import { createTaskPortsSnapshotEvent } from '../src/domain/server-state.js';
import { isRecord } from '../src/lib/type-guards.js';
import { registerAgentLifecycleBroadcasts } from './agent-lifecycle.js';
import { createBrowserAuthController } from './browser-auth.js';
import { createBrowserChannelManager } from './browser-channels.js';
import { createBrowserControlPlane } from './browser-control-plane.js';
import type { BrowserServerInfo } from './browser-server-info.js';
import { registerBrowserIpcRoutes } from './browser-ipc.js';
import { registerBrowserLatencyDiagnosticsRoutes } from './browser-latency-diagnostics.js';
import { registerBrowserPreviewRoutes } from './browser-preview.js';
import { registerBrowserStaticRoutes } from './browser-static.js';
import {
  registerBrowserWebSocketServer,
  type BrowserWebSocketServer,
} from './browser-websocket.js';
import {
  startCoordinatorRuntimeLoad,
  type CoordinatorRuntimeLoader,
} from './coordinator-runtime-loader.js';
import { createTaskNameRegistry } from './task-names.js';
import {
  createStandaloneScopedRemoteWebSocket,
  type StandaloneScopedRemoteWebSocket,
} from './scoped-remote-websocket.js';

type BrowserServerLifecycle =
  | { kind: 'running' }
  | { kind: 'closing'; exitOnClose: boolean }
  | { kind: 'closed' };

const CONTROL_SOCKET_PATH = '/ws';
const SCOPED_REMOTE_SOCKET_PATH = '/remote-ws';
const STANDALONE_REMOTE_AUTH_HTTP_PATHS = Object.freeze({
  bootstrap: '/remote/auth/bootstrap',
  logout: '/api/remote/auth/logout',
  session: '/api/remote/auth/session',
}) satisfies RemoteAuthHttpPaths;
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
  taskNotesWriterEntitlements?: TaskNotesWriterEntitlements;
  scopedCommands?: {
    accessToken: string;
    grants: ReadonlySet<RemoteGrant>;
    mutationAdmissionInitiallyOpen?: boolean;
    peerTrustPolicy: RemotePeerTrustPolicy;
    registrations?: RemoteCommandRegistrationTable;
    tls: { cert: Buffer | string; key: Buffer | string };
    workspacePrincipalId?: string;
  };
  token: string;
  userDataPath: string;
}

export interface BrowserServerController {
  cleanup: () => void;
  shutdown: () => void;
  /**
   * Settles only after the task-experience owner is active and the HTTP/WS
   * listener is accepting requests. Startup failures reject this promise.
   */
  whenReady: () => Promise<void>;
  /**
   * Settles once asynchronous runtime cleanup, including coordinator
   * persistence and agent-runner teardown, has finished after
   * cleanup()/shutdown(). Rejects with every owner failure after all owners
   * have settled. Test harnesses must await this before removing the state
   * directory.
   */
  whenCoordinatorRuntimeStopped: () => Promise<void>;
}

type BrowserRuntimeCleanupLabel =
  | 'agent runner'
  | 'ask about code'
  | 'coordinator'
  | 'scoped remote'
  | 'task experience'
  | 'workspace storage';

export type BrowserRuntimeCleanupFailure = RuntimeCleanupFailure<BrowserRuntimeCleanupLabel>;

export class BrowserRuntimeCleanupError extends Error {
  readonly failures: BrowserRuntimeCleanupFailure[];

  constructor(failures: BrowserRuntimeCleanupFailure[]) {
    super(
      `Browser server runtime cleanup failed: ${failures.map((failure) => failure.label).join(', ')}`,
    );
    this.name = 'BrowserRuntimeCleanupError';
    this.failures = failures;
  }
}

function retainObservedRuntimeCleanup(
  cleanup: Promise<void>,
  label: BrowserRuntimeCleanupLabel,
): Promise<void> {
  void cleanup.catch((error: unknown) => {
    console.warn(`Browser server ${label} cleanup failed:`, error);
  });
  return cleanup;
}

async function settleBrowserRuntimeCleanupOwners(
  owners: ReadonlyArray<{
    cleanup: Promise<void>;
    label: BrowserRuntimeCleanupLabel;
  }>,
): Promise<void> {
  const failures = await collectRuntimeCleanupFailures(owners);
  if (failures.length > 0) {
    throw new BrowserRuntimeCleanupError(failures);
  }
}

async function exitAfterBrowserRuntimeCleanup(
  cleanup: Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  let exitCode = 0;
  try {
    await cleanup;
  } catch (error) {
    console.error('Browser server shutdown cleanup failed:', error);
    exitCode = 1;
  }
  exit(exitCode);
}

export const __browserServerTestExports = {
  getBrowserServerStartupMessages,
  exitAfterBrowserRuntimeCleanup,
  retainObservedRuntimeCleanup,
  settleBrowserRuntimeCleanupOwners,
};

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

function getCoordinatorToolCallUrl(port: number, secure: boolean): string {
  return `${secure ? 'https' : 'http'}://127.0.0.1:${port}${COORDINATOR_TOOL_CALL_PATH}`;
}

function getBrowserServerStartupMessages(
  info: BrowserServerInfo,
  browserToken: string,
  scopedRemoteEnabled: boolean,
): string[] {
  if (!scopedRemoteEnabled) {
    return [
      `Parallel Code server listening on ${info.url}`,
      ...(info.wifiUrl ? [`WiFi: ${info.wifiUrl}`] : []),
      ...(info.tailscaleUrl ? [`Tailscale: ${info.tailscaleUrl}`] : []),
    ];
  }

  return [
    `Parallel Code browser admin: ${buildSecureSessionBootstrapUrl(
      '127.0.0.1',
      info.port,
      browserToken,
    )}`,
    `Parallel Code remote: ${info.url}`,
    ...(info.wifiUrl ? [`Remote WiFi: ${info.wifiUrl}`] : []),
    ...(info.tailscaleUrl ? [`Remote Tailscale: ${info.tailscaleUrl}`] : []),
  ];
}

// Browser-mode composition root. The browser server wires together:
// - browser-ipc.ts for HTTP command/query IPC
// - browser-websocket.ts for websocket control sessions
// - browser-channels.ts for terminal stream routing
// - browser-control-plane.ts for presence, control broadcasts, and lifecycle glue

export function startBrowserServer(options: StartBrowserServerOptions): BrowserServerController {
  const taskNotesWriterEntitlements = snapshotTaskNotesWriterEntitlements(
    options.taskNotesWriterEntitlements,
  );
  if (options.scopedCommands) {
    if (!options.scopedCommands.accessToken) {
      throw new TypeError('Scoped remote access token cannot be empty');
    }
    if (options.scopedCommands.accessToken === options.token) {
      throw new TypeError('Scoped remote and full browser access tokens must be distinct');
    }
  }
  const { safeCompare } = createTokenComparator(options.token);
  const app = express();
  let scopedRuntime: ScopedRemoteCommandRuntime | null = null;
  const dispatchHttpRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const runtime = scopedRuntime;
    if (runtime?.authHttpHandler(request, response)) return;
    if (runtime) {
      void runtime.commandHttpHandler(request, response).then((handled) => {
        if (!handled) app(request, response);
      });
      return;
    }
    app(request, response);
  };
  const server = options.scopedCommands
    ? createHttpsServer(options.scopedCommands.tls, dispatchHttpRequest)
    : createServer(dispatchHttpRequest);
  const wss = new WebSocketServer({
    maxPayload: 256 * 1024,
    noServer: true,
  });
  const scopedRemoteWss = options.scopedCommands
    ? new WebSocketServer({ maxPayload: 256 * 1024, noServer: true })
    : null;
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
  const handleScopedRemoteSocketUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (!scopedRemoteWss || getUpgradePathname(req) !== SCOPED_REMOTE_SOCKET_PATH) return;
    scopedRemoteWss.handleUpgrade(req, socket, head, (client) => {
      scopedRemoteWss.emit('connection', client, req);
    });
  };
  server.on('upgrade', handleScopedRemoteSocketUpgrade);
  const handleUnknownSocketUpgrade = (req: IncomingMessage, socket: Duplex): void => {
    const pathname = getUpgradePathname(req);
    if (
      pathname === CONTROL_SOCKET_PATH ||
      pathname === SCOPED_REMOTE_SOCKET_PATH ||
      (pathname && isPreviewSocketPath(pathname))
    ) {
      return;
    }

    const statusLine = pathname ? 'HTTP/1.1 404 Not Found' : 'HTTP/1.1 400 Bad Request';
    socket.write(`${statusLine}\r\n\r\n`);
    socket.destroy();
  };
  const taskNames = createTaskNameRegistry();
  const storageEnv = { userDataPath: options.userDataPath, isPackaged: false } as const;
  const savedAppState = loadAppStateDocumentForEnv(storageEnv);
  const savedTaskRegistryState = loadTaskRegistryStateDocumentForEnv(storageEnv);
  const serverInstanceId = getServerInstanceId();
  const taskCatalog = createTaskCatalogState({ serverInstanceId });
  const stopTaskCatalogPtyRuntime = subscribeTaskCatalogPtyRuntime(taskCatalog);
  const defaultAgentDefinitions = getAgentDefsWithLastKnownAvailability();
  const syncTaskCatalogFromJson = (state: SavedStateDocument): void => {
    try {
      taskCatalog.replace({
        sharedState: (state.root ?? {}) as JsonObject,
        sessionRuntime: getCurrentTaskCatalogSessionRuntime(),
        staticAgents: buildTaskCatalogAgentChoices(
          (state.root ?? {}) as JsonObject,
          defaultAgentDefinitions,
        ),
      });
    } catch {
      // The catalog publishes its own typed unavailable state. Canonical
      // workspace truth must not be rolled back by projection failure.
    }
  };
  const browserAuth = createBrowserAuthController({
    token: options.token,
  });

  taskNames.restoreAuthorizedTaskRoots(savedTaskRegistryState ?? '{"tasks":{}}');
  if (savedTaskRegistryState) {
    taskNames.syncFromSavedState(savedTaskRegistryState);
    syncTaskCatalogFromJson(savedTaskRegistryState);
  } else {
    taskCatalog.replace({
      sharedState: {
        collapsedTaskOrder: [],
        projects: [],
        taskOrder: [],
        tasks: {},
      },
      sessionRuntime: getCurrentTaskCatalogSessionRuntime(),
      staticAgents: buildTaskCatalogAgentChoices({}, defaultAgentDefinitions),
    });
  }

  if (savedAppState) {
    restoreSavedTaskPorts(savedAppState.json);
  }

  let browserSocketServer: BrowserWebSocketServer | null = null;
  let scopedRemoteSocket: StandaloneScopedRemoteWebSocket | null = null;
  let lifecycle: BrowserServerLifecycle = { kind: 'running' };
  let serverListenPending = false;
  let browserServerReadySettled = false;
  let resolveBrowserServerReady: () => void = () => {};
  let rejectBrowserServerReady: (error: unknown) => void = () => {};
  const browserServerReady = new Promise<void>((resolve, reject) => {
    resolveBrowserServerReady = resolve;
    rejectBrowserServerReady = reject;
  });
  // startBrowserServer is intentionally synchronous. Keep startup rejection
  // observed even for legacy callers that only use the lifecycle methods.
  void browserServerReady.catch(() => {});
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

  function settleBrowserServerReady(): void {
    if (browserServerReadySettled) return;
    browserServerReadySettled = true;
    resolveBrowserServerReady();
  }

  function settleBrowserServerStartupFailure(error: unknown): void {
    if (browserServerReadySettled) return;
    browserServerReadySettled = true;
    rejectBrowserServerReady(error);
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

  function isAuthorizedRemoteRequest(req: {
    header?: (name: string) => string | undefined;
    headers: IncomingHttpHeaders;
    url?: string | undefined;
  }): boolean {
    return scopedRuntime
      ? scopedRuntime.authenticateReadRequest(req as IncomingMessage) !== null
      : isAuthorizedRequest(req);
  }

  const getRemoteAgentList = () =>
    buildRemoteAgentList({
      getTaskMetadata: taskNames.getTaskMetadata,
      getTaskName: taskNames.getTaskName,
    });
  const controlPlane = createBrowserControlPlane({
    buildAgentList: getRemoteAgentList,
    cleanupSocketClient: (client) => {
      browserSocketServer?.cleanupClient(client);
    },
    port: options.port,
    ...(options.scopedCommands
      ? {
          remoteAccess: {
            secureSessionBootstrap: {
              bootstrapPath: STANDALONE_REMOTE_AUTH_HTTP_PATHS.bootstrap,
              nextPath: '/remote/',
            },
            token: options.scopedCommands.accessToken,
          },
        }
      : {}),
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
    getClientBufferedAmount: (client) => client.bufferedAmount,
    getPendingChannelSendState: (client) => controlPlane.getPendingChannelSendState(client),
    send: (client, data) => controlPlane.sendChannelData(client, data),
  });
  // Focused-channel lane priority is derived from the single focus signal
  // (ReportClientTaskFocus.focusedChannelIds); the channel manager consumes
  // the merged focused set whenever any client's focus changes.
  const cleanupFocusedChannelConsumer = subscribeBackendClientFocusedChannels(() => {
    channelManager.setFocusedChannelIds(getAllBackendFocusedChannelIds());
  });

  const taskPortsStateVersion = getTaskPortsStateVersion();
  for (const snapshot of getTaskPortSnapshots()) {
    controlPlane.emitTaskPortsChanged({
      ...createTaskPortsSnapshotEvent(snapshot),
      stateVersion: taskPortsStateVersion,
    });
  }
  let coordinatorRuntimeLoader: CoordinatorRuntimeLoader | null = null;
  const workspaceMutationCleanups = new Set<() => Promise<void>>();
  let runtimeCleanupDone: Promise<void> | null = null;
  let coordinatorRuntimeStartSettled = false;
  let resolveCoordinatorRuntimeStarted: (
    loader: CoordinatorRuntimeLoader | null,
  ) => void = () => {};
  const coordinatorRuntimeStarted = new Promise<CoordinatorRuntimeLoader | null>((resolve) => {
    resolveCoordinatorRuntimeStarted = resolve;
  });

  function settleCoordinatorRuntimeStart(loader: CoordinatorRuntimeLoader | null): void {
    if (coordinatorRuntimeStartSettled) {
      return;
    }
    coordinatorRuntimeStartSettled = true;
    resolveCoordinatorRuntimeStarted(loader);
  }

  async function awaitCoordinatorRuntimeReady(): Promise<void> {
    const loader = await coordinatorRuntimeStarted;
    if (!loader) {
      throw new Error('Browser server stopped before the coordinator runtime started');
    }
    await loader.ready;
  }

  const taskNotesEvents = createTaskNotesEventStream();
  const handlerContext: HandlerContext = {
    userDataPath: options.userDataPath,
    isPackaged: false,
    workspaceStorageKind: 'standalone',
    taskNotesWriterEntitlements,
    registerWorkspaceMutationCleanup: (cleanup) => workspaceMutationCleanups.add(cleanup),
    awaitCoordinatorRuntimeReady,
    bindChannelForClient: (clientId, channelId) => {
      if (!clientId) {
        return false;
      }

      const clients = controlPlane.transport.getClientsById(clientId);
      if (clients.length === 0) {
        return false;
      }

      for (const client of clients) {
        channelManager.bindChannel(client, channelId);
      }
      return true;
    },
    ...(options.scopedCommands
      ? { coordinatorToolCallTlsCertificate: options.scopedCommands.tls.cert.toString('utf8') }
      : {}),
    coordinatorToolCallUrl: () =>
      getCoordinatorToolCallUrl(
        controlPlane.getServerInfo().port,
        options.scopedCommands !== undefined,
      ),
    sendToChannel: (channelId, message) => {
      channelManager.sendChannelMessage(channelId, message);
    },
    isChannelActive: (channelId) => channelManager.hasActiveSubscriber(channelId),
    emitIpcEvent: (channel, payload) => {
      controlPlane.emitIpcEvent(channel, payload);
      if (channel === IPC.TaskNotesChanged) taskNotesEvents.publish(payload);
    },
    emitGitStatusChanged: controlPlane.emitGitStatusChanged,
    remoteAccess: createBrowserRemoteAccessController(controlPlane),
  };
  handlerContext.getTaskNotesService = async () => (await taskExperienceRuntimeStarted).notes;
  handlerContext.restoreCanonicalAgentSession = async (request) =>
    (await taskExperienceRuntimeStarted).agentSession.restoreCanonicalSession(request);
  handlerContext.classifyCanonicalAgentSessionIdentity = async (request) =>
    (await taskExperienceRuntimeStarted).agentSession.classifyCanonicalSessionIdentity(request);
  handlerContext.restoreCanonicalTaskShellSession = async (request, options) =>
    (await taskExperienceRuntimeStarted).shell.restoreCanonicalTaskShellSession(request, options);
  const handlers = createIpcHandlers(handlerContext, taskNames, savedTaskRegistryState, {
    onTaskRemovalLifecycle: ({ taskId, closing }) => {
      taskCatalog.setTaskClosing(taskId, closing);
    },
    syncTaskCatalogFromJson,
  });
  let stopTaskReliabilitySubscription: (() => void) | null = null;

  function activateTaskExperienceTransports(runtime: ProductionTaskExperienceRuntime): void {
    Object.assign(handlers, createActiveTaskReliabilityIpcHandlers(runtime));
    stopTaskReliabilitySubscription = subscribeActiveTaskReliabilityRuntime(runtime, (event) => {
      controlPlane.emitIpcEvent(IPC.TaskReliabilityChanged, event);
    });
    if (!options.scopedCommands || !scopedRemoteWss) return;
    const registrations = mergeRemoteCommandRegistrationTables(
      createTaskExperienceRemoteCommandRegistrations({
        catalog: taskCatalog,
        getRuntime: async () => runtime,
        writerEntitlement: taskNotesWriterEntitlements.remote,
      }),
      options.scopedCommands.registrations ?? {},
    );
    const grants = options.scopedCommands.grants;
    scopedRuntime = createScopedRemoteCommandRuntime({
      accessToken: options.scopedCommands.accessToken,
      authHttpPaths: STANDALONE_REMOTE_AUTH_HTTP_PATHS,
      grants,
      ...(options.scopedCommands.mutationAdmissionInitiallyOpen !== undefined
        ? {
            mutationAdmissionInitiallyOpen: options.scopedCommands.mutationAdmissionInitiallyOpen,
          }
        : {
            mutationAdmissionInitiallyOpen: [...grants].some(
              (grant) =>
                grant === 'notes:write' || grant === 'task:create' || grant === 'terminal:control',
            ),
          }),
      onInternalError: (error) => console.error('[server] Scoped command failed:', error),
      peerTrustPolicy: options.scopedCommands.peerTrustPolicy,
      registrations,
      workspacePrincipalId: options.scopedCommands.workspacePrincipalId ?? 'standalone-owner',
    });
    scopedRemoteSocket = createStandaloneScopedRemoteWebSocket({
      getAgentList: getRemoteAgentList,
      runtime: scopedRuntime,
      subscribeTaskCatalog: (listener) => taskCatalog.subscribe(listener),
      subscribeTaskNotesChanged: taskNotesEvents.subscribe,
      taskCreationOperations: createRemoteTaskCreationOperationSource(runtime.creation),
      wss: scopedRemoteWss,
    });
  }

  const taskExperienceRuntimeStarted = createProductionTaskExperienceRuntime({
    catalog: taskCatalog,
    context: handlerContext,
    serverInstanceId,
    taskNames,
  });
  handlerContext.getTaskCreationCommand = async () =>
    (await taskExperienceRuntimeStarted).localCreation;
  handlerContext.getTaskMergeWorkflow = async () =>
    (await taskExperienceRuntimeStarted).merge.workflow;

  if (savedAppState) {
    restoreBackendDerivedState({
      context: {
        emitGitStatusChanged: controlPlane.emitGitStatusChanged,
      },
      derivedState: loadPersistedDerivedState(storageEnv),
      document: savedAppState,
    });
    const gitStatusStateVersion = getGitStatusStateVersion();
    for (const snapshot of listGitStatusSnapshots()) {
      controlPlane.emitGitStatusChanged({
        ...snapshot,
        stateVersion: gitStatusStateVersion,
      });
    }
    const taskConvergenceStateVersion = getTaskConvergenceStateVersion();
    for (const snapshot of getTaskConvergenceSnapshots()) {
      controlPlane.emitTaskConvergenceChanged({
        ...snapshot,
        stateVersion: taskConvergenceStateVersion,
      });
    }
    const taskReviewStateVersion = getTaskReviewStateVersion();
    for (const snapshot of listTaskReviewSnapshots()) {
      controlPlane.emitTaskReviewChanged({
        ...snapshot,
        stateVersion: taskReviewStateVersion,
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
  const cleanupDerivedStatePersistence = startDerivedStatePersistence(storageEnv);

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
    isAuthorizedRemoteRequest,
    ...(options.scopedCommands ? { remoteAuthGatePath: null } : {}),
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
  const cleanupAgentAvailability = subscribeAgentAvailability((event) => {
    controlPlane.emitIpcEvent(IPC.AgentAvailabilityChanged, event);
  });
  // The boot probe round is queued at 'background' priority and stays gated
  // until releaseBackendBackgroundWork() runs in the listen callback; the work
  // queue is the single post-listen scheduler.
  requestAgentCatalogAvailabilityRevalidation('boot');
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
      clearBackendClientFocus(clientId);
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
    sendStateBootstrap: controlPlane.sendStateBootstrap,
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

  void taskExperienceRuntimeStarted
    .then((runtime) => {
      if (lifecycle.kind !== 'running') return;
      activateTaskExperienceTransports(runtime);
      const handleListenError = (error: Error): void => {
        serverListenPending = false;
        settleBrowserServerStartupFailure(error);
        cleanup();
      };
      server.once('error', handleListenError);
      serverListenPending = true;
      try {
        server.listen(options.port, '0.0.0.0', () => {
          serverListenPending = false;
          server.off('error', handleListenError);
          if (lifecycle.kind !== 'running') {
            settleBrowserServerStartupFailure(
              new Error('Browser server stopped before its listener became ready'),
            );
            settleCoordinatorRuntimeStart(null);
            server.close();
            return;
          }
          try {
            const address = server.address();
            if (address && typeof address !== 'string') {
              controlPlane.setServerPort(address.port);
            }

            const info = controlPlane.getServerInfo();
            for (const message of getBrowserServerStartupMessages(
              info,
              options.token,
              options.scopedCommands !== undefined,
            )) {
              process.stdout.write(`${message}\n`);
            }
            controlPlane.startHeartbeat();
            scopedRemoteSocket?.startHeartbeat();
            coordinatorRuntimeLoader = startCoordinatorRuntimeLoad({
              emitCoordinatorChanged: (event) => {
                controlPlane.emitCoordinatorChanged(event);
              },
              handlerContext,
              taskNames,
            });
            settleCoordinatorRuntimeStart(coordinatorRuntimeLoader);
            releaseBackendBackgroundWork();
            settleBrowserServerReady();
          } catch (error) {
            settleBrowserServerStartupFailure(error);
            cleanup();
          }
        });
      } catch (error) {
        serverListenPending = false;
        server.off('error', handleListenError);
        throw error;
      }
    })
    .catch((error: unknown) => {
      console.error('[server] Task-experience activation failed:', error);
      settleBrowserServerStartupFailure(error);
      cleanup();
    });

  function finalizeServerClose(): void {
    const shouldExit = lifecycle.kind === 'closing' ? lifecycle.exitOnClose : false;
    lifecycle = { kind: 'closed' };
    removeProcessHandlers();

    for (const callback of closeCallbacks) {
      callback();
    }
    closeCallbacks.clear();

    if (shouldExit) {
      // Await persistence and runner cleanup so neither state writes nor
      // external Docker resources are dropped at shutdown. A cleanup failure
      // is operationally visible through a nonzero process exit after every
      // independent owner has still been allowed to settle.
      void exitAfterBrowserRuntimeCleanup(runtimeCleanupDone ?? Promise.resolve());
    }
  }

  server.on('close', finalizeServerClose);

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
    if (!server.listening) {
      if (serverListenPending) return;
      finalizeServerClose();
      return;
    }
    server.close();
  }

  function cleanup(exitOnClose = false): void {
    if (lifecycle.kind !== 'running') {
      if (exitOnClose) requestServerClose(true);
      return;
    }

    removeProcessHandlers();
    settleBrowserServerStartupFailure(new Error('Browser server stopped before startup completed'));
    cleanupAgentLifecycleBroadcasts();
    cleanupAgentAvailability();
    cleanupAgentSupervision();
    cleanupFocusedChannelConsumer();
    // cleanup() stays synchronous for its callers, but persistence and runner
    // teardown are async contracts. Keep both promises so exit-on-close waits
    // for their ownership to settle instead of dropping work during shutdown.
    if (!coordinatorRuntimeLoader) {
      settleCoordinatorRuntimeStart(null);
    }
    const coordinatorRuntimeCleanup = retainObservedRuntimeCleanup(
      coordinatorRuntimeStarted.then((loader) => loader?.cleanup()),
      'coordinator',
    );
    const askAboutCodeRuntimeCleanup = retainObservedRuntimeCleanup(
      stopAllAskAboutCodeRequests(),
      'ask about code',
    );
    const scopedRuntimeAtClose = scopedRuntime;
    const scopedRemoteRuntimeCleanup = retainObservedRuntimeCleanup(
      scopedRuntimeAtClose
        ? scopedRuntimeAtClose.closeAndDrain().then(() => scopedRuntimeAtClose.revokeAll())
        : Promise.resolve(),
      'scoped remote',
    );
    stopTaskReliabilitySubscription?.();
    stopTaskReliabilitySubscription = null;
    const taskExperienceRuntimeCleanup = retainObservedRuntimeCleanup(
      taskExperienceRuntimeStarted.then(
        (runtime) => runtime.close(),
        (error: unknown) =>
          error instanceof TaskExperienceRuntimeActivationError
            ? error.retryCleanup()
            : Promise.reject(error),
      ),
      'task experience',
    );
    const agentRuntimeCleanup = retainObservedRuntimeCleanup(
      stopAgentRunnersAfterTaskExperience(taskExperienceRuntimeCleanup),
      'agent runner',
    );
    const workspaceOwnersAtClose = [...workspaceMutationCleanups];
    workspaceMutationCleanups.clear();
    const closeWorkspaceOwners = () => settleWorkspaceStorageCleanupOwners(workspaceOwnersAtClose);
    const workspaceStorageCleanup = retainObservedRuntimeCleanup(
      taskExperienceRuntimeCleanup.then(closeWorkspaceOwners, closeWorkspaceOwners),
      'workspace storage',
    );
    runtimeCleanupDone = settleBrowserRuntimeCleanupOwners([
      { cleanup: coordinatorRuntimeCleanup, label: 'coordinator' },
      { cleanup: agentRuntimeCleanup, label: 'agent runner' },
      { cleanup: askAboutCodeRuntimeCleanup, label: 'ask about code' },
      { cleanup: scopedRemoteRuntimeCleanup, label: 'scoped remote' },
      { cleanup: taskExperienceRuntimeCleanup, label: 'task experience' },
      { cleanup: workspaceStorageCleanup, label: 'workspace storage' },
    ]);
    // Preserve the rejecting aggregate for whenCoordinatorRuntimeStopped and
    // exit-on-close without allowing an ignored cleanup() call to create an
    // unhandled rejection in the meantime.
    void runtimeCleanupDone.catch(() => {});
    cancelBackendBackgroundReconciliation();
    cleanupDerivedStatePersistence();
    cleanupTaskConvergence();
    cleanupTaskReview();
    cleanupTaskReviewSignals();
    cleanupTaskSteps();
    cleanupTaskPorts();
    stopTaskCatalogPtyRuntime();
    server.off('upgrade', handleControlSocketUpgrade);
    server.off('upgrade', handleScopedRemoteSocketUpgrade);
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
    scopedRemoteSocket?.cleanup();
    scopedRemoteSocket = null;
    scopedRemoteWss?.close();
    requestServerClose(exitOnClose);
  }

  function shutdown(): void {
    if (lifecycle.kind === 'closed') {
      return;
    }

    cleanup(true);
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
    whenCoordinatorRuntimeStopped: () => runtimeCleanupDone ?? Promise.resolve(),
    whenReady: () => browserServerReady,
  };
}
