import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { DesktopSessionMainElement } from './desktop-session-types';
import { getAppStartupSummary, resetAppStartupStatusForTests } from './app-startup-status';
import { isBrowserColdBootstrapPending, resetBrowserStartupStateForTests } from './browser-startup';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from './runtime-diagnostics';
import { isRecord } from '../lib/type-guards';
import { resetTerminalStartupStateForTests } from '../store/terminal-startup';
import {
  resetTerminalStartupPaintCoordinationForTests,
  setTerminalStartupPaintCoordinationEntry,
} from './terminal-startup-paint';

function isMeaningfulColdBootstrapProjectionForTest(projection: unknown): boolean {
  if (!isRecord(projection)) {
    return false;
  }

  return (
    (Array.isArray(projection.projects) && projection.projects.length > 0) ||
    (Array.isArray(projection.taskOrder) && projection.taskOrder.length > 0) ||
    (Array.isArray(projection.collapsedTaskOrder) && projection.collapsedTaskOrder.length > 0) ||
    (isRecord(projection.tasks) && Object.keys(projection.tasks).length > 0) ||
    (isRecord(projection.terminals) && Object.keys(projection.terminals).length > 0)
  );
}

function createMeaningfulColdBootstrapProjection() {
  return {
    ...createEmptyColdBootstrapProjection(),
    projects: [
      {
        color: '#336699',
        id: 'project-bootstrap',
        name: 'Bootstrap Project',
        path: '/tmp/bootstrap-project',
      },
    ],
    taskOrder: ['task-bootstrap'],
    tasks: {
      'task-bootstrap': {
        agentIds: ['agent-bootstrap'],
        branchName: 'main',
        id: 'task-bootstrap',
        lastPrompt: '',
        name: 'Bootstrap Task',
        notes: '',
        projectId: 'project-bootstrap',
        shellAgentIds: [],
        worktreePath: '/tmp/bootstrap-project/task-bootstrap',
      },
    },
  };
}

function createMainElementStub(): DesktopSessionMainElement {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

const {
  adjustGlobalScaleMock,
  applyTaskCommandControllerChangedMock,
  applyTaskConvergenceEventMock,
  applyTaskReviewEventMock,
  applyAgentSupervisionEventMock,
  applyRemoteStatusMock,
  applyTaskPortsEventMock,
  captureWindowStateMock,
  cleanupWindowEventListenersMock,
  clearPathInputNotifierMock,
  createBrowserStateSyncMock,
  fetchRemoteStatusSnapshotMock,
  fetchTaskPortsMock,
  getTaskCommandControllerUpdateCountMock,
  getPendingPathInputMock,
  invokeMock,
  handleGitStatusChangedMock,
  handleGitStatusSyncEventMock,
  listenMock,
  applyBrowserColdBootstrapWorkspaceProjectionMock,
  fetchBrowserColdBootstrapMock,
  hasMeaningfulBrowserColdBootstrapProjectionMock,
  loadAgentsMock,
  loadClientSessionStateMock,
  loadStateMock,
  loadWorkspaceStateMock,
  markAutosaveCleanMock,
  fetchTaskConvergenceMock,
  reconcileClientSessionStateMock,
  replaceTaskConvergenceSnapshotsMock,
  replaceTaskCommandControllersMock,
  replacePeerSessionsMock,
  replaceTaskReviewSnapshotsMock,
  replaceAgentSupervisionSnapshotsMock,
  replaceGitStatusSnapshotsMock,
  replaceTaskPortSnapshotsMock,
  registerAppShortcutsMock,
  registerBrowserAppRuntimeMock,
  registerCloseRequestedHandlerMock,
  registerPathInputNotifierMock,
  registerWindowEventListenersMock,
  restoreWindowStateMock,
  saveBrowserWorkspaceStateOnPagehideMock,
  saveStateMock,
  saveClientSessionStateMock,
  createElectronTaskNotificationSinkMock,
  createWebTaskNotificationSinkMock,
  initializeTaskNotificationCapabilityRuntimeMock,
  refreshTaskNotificationCapabilityMock,
  setPlanContentMock,
  setupAutosaveMock,
  setupWindowChromeMock,
  startTaskNotificationRuntimeMock,
  storeState,
  syncWindowFocusedMock,
  syncWindowMaximizedMock,
  takeBrowserColdBootstrapHandoffProjectionMock,
  upsertIncomingTaskTakeoverRequestMock,
  validateProjectPathsMock,
  windowEventListeners,
  windowListeners,
} = vi.hoisted(() => ({
  adjustGlobalScaleMock: vi.fn(),
  applyTaskCommandControllerChangedMock: vi.fn(),
  applyTaskConvergenceEventMock: vi.fn(),
  applyTaskReviewEventMock: vi.fn(),
  applyAgentSupervisionEventMock: vi.fn(),
  applyRemoteStatusMock: vi.fn(),
  applyTaskPortsEventMock: vi.fn(),
  captureWindowStateMock: vi.fn().mockResolvedValue(undefined),
  cleanupWindowEventListenersMock: vi.fn(),
  clearPathInputNotifierMock: vi.fn(),
  createBrowserStateSyncMock: vi.fn(() => ({
    cleanupBrowserStateSyncTimer: vi.fn(),
    scheduleBrowserStateSync: vi.fn(),
    syncBrowserStateFromReconnectSnapshot: vi.fn().mockResolvedValue(undefined),
    syncBrowserStateFromServer: vi.fn().mockResolvedValue(undefined),
  })),
  fetchRemoteStatusSnapshotMock: vi.fn().mockResolvedValue({
    enabled: false,
    connectedClients: 0,
    peerClients: 0,
    port: 7777,
    tailscaleUrl: null,
    token: null,
    url: null,
    wifiUrl: null,
  }),
  fetchTaskPortsMock: vi.fn().mockResolvedValue([]),
  getTaskCommandControllerUpdateCountMock: vi.fn(() => 0),
  getPendingPathInputMock: vi.fn(),
  invokeMock: vi.fn(),
  initializeTaskNotificationCapabilityRuntimeMock: vi.fn().mockResolvedValue(undefined),
  refreshTaskNotificationCapabilityMock: vi.fn().mockResolvedValue({
    checking: false,
    permission: 'granted',
    provider: 'web',
    supported: true,
  }),
  handleGitStatusChangedMock: vi.fn(),
  handleGitStatusSyncEventMock: vi.fn(),
  listenMock: vi.fn(),
  applyBrowserColdBootstrapWorkspaceProjectionMock: vi.fn(),
  fetchBrowserColdBootstrapMock: vi.fn().mockResolvedValue({
    serverStateBootstrap: [],
    workspaceRevision: 0,
    workspaceProjection: createMeaningfulColdBootstrapProjection(),
  }),
  hasMeaningfulBrowserColdBootstrapProjectionMock: vi.fn(
    isMeaningfulColdBootstrapProjectionForTest,
  ),
  loadAgentsMock: vi.fn().mockResolvedValue(undefined),
  loadClientSessionStateMock: vi.fn(),
  loadStateMock: vi.fn().mockResolvedValue(undefined),
  loadWorkspaceStateMock: vi.fn().mockResolvedValue(true),
  markAutosaveCleanMock: vi.fn(),
  fetchTaskConvergenceMock: vi.fn().mockResolvedValue([]),
  reconcileClientSessionStateMock: vi.fn(),
  replaceTaskConvergenceSnapshotsMock: vi.fn(),
  replaceTaskCommandControllersMock: vi.fn(),
  replacePeerSessionsMock: vi.fn(),
  replaceTaskReviewSnapshotsMock: vi.fn(),
  replaceAgentSupervisionSnapshotsMock: vi.fn(),
  replaceGitStatusSnapshotsMock: vi.fn(),
  replaceTaskPortSnapshotsMock: vi.fn(),
  createElectronTaskNotificationSinkMock: vi.fn(() => ({
    subscribeClicks: vi.fn(),
    show: vi.fn(),
  })),
  createWebTaskNotificationSinkMock: vi.fn(() => ({
    subscribeClicks: vi.fn(),
    show: vi.fn(),
  })),
  registerAppShortcutsMock: vi.fn(() => vi.fn()),
  registerBrowserAppRuntimeMock: vi.fn(() => vi.fn()),
  registerCloseRequestedHandlerMock: vi.fn().mockResolvedValue(vi.fn()),
  registerPathInputNotifierMock: vi.fn(),
  registerWindowEventListenersMock: vi.fn(),
  restoreWindowStateMock: vi.fn().mockResolvedValue(undefined),
  saveBrowserWorkspaceStateOnPagehideMock: vi.fn(),
  saveStateMock: vi.fn().mockResolvedValue(undefined),
  saveClientSessionStateMock: vi.fn(),
  setPlanContentMock: vi.fn(),
  setupAutosaveMock: vi.fn(),
  setupWindowChromeMock: vi.fn().mockResolvedValue(undefined),
  startTaskNotificationRuntimeMock: vi.fn(() => vi.fn()),
  storeState: {
    activeTaskId: null as string | null,
    activeAgentId: null as string | null,
    projects: [] as Array<{ id: string }>,
    agents: {} as Record<string, unknown>,
    hydraCommand: '',
    hydraStartupMode: 'auto' as const,
    markdownViewer: null,
    showAddProjectDialog: false,
    showHelpDialog: false,
    showNewTaskDialog: false,
    showSettingsDialog: false,
    taskOrder: [] as string[],
    collapsedTaskOrder: [] as string[],
    tasks: {} as Record<
      string,
      {
        agentIds?: string[];
        baseBranch?: string;
        collapsed?: boolean;
        id?: string;
        planFileName?: string;
        planRelativePath?: string;
        projectId?: string;
        projectMode?: string;
        shellAgentIds?: string[];
        skipPermissions?: boolean;
        worktreePath?: string;
      }
    >,
    terminals: {} as Record<string, { id: string }>,
  },
  syncWindowFocusedMock: vi.fn(),
  syncWindowMaximizedMock: vi.fn(),
  takeBrowserColdBootstrapHandoffProjectionMock: vi.fn().mockReturnValue(null),
  upsertIncomingTaskTakeoverRequestMock: vi.fn(),
  validateProjectPathsMock: vi.fn().mockResolvedValue(undefined),
  windowEventListeners: new Map<string, EventListener>(),
  windowListeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('../lib/dialog', () => ({
  clearPathInputNotifier: clearPathInputNotifierMock,
  getPendingPathInput: getPendingPathInputMock,
  registerPathInputNotifier: registerPathInputNotifierMock,
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
  listen: listenMock,
  listenServerMessage: listenMock,
}));

vi.mock('../lib/ipc-events', () => ({
  listenAgentSupervisionChanged: (listener: (payload: unknown) => void) =>
    listenMock(IPC.AgentSupervisionChanged, listener),
  listenGitStatusChanged: (listener: (payload: unknown) => void) =>
    listenMock(IPC.GitStatusChanged, listener),
  listenPlanContent: (listener: (payload: unknown) => void) =>
    listenMock(IPC.PlanContent, listener),
  listenRemoteStatusChanged: (listener: (payload: unknown) => void) =>
    listenMock(IPC.RemoteStatusChanged, listener),
  listenTaskCommandControllerChanged: (listener: (payload: unknown) => void) =>
    listenMock(IPC.TaskCommandControllerChanged, listener),
  listenTaskConvergenceChanged: (listener: (payload: unknown) => void) =>
    listenMock(IPC.TaskConvergenceChanged, listener),
  listenTaskPortsChanged: (listener: (payload: unknown) => void) =>
    listenMock(IPC.TaskPortsChanged, listener),
  listenTaskReviewChanged: (listener: (payload: unknown) => void) =>
    listenMock(IPC.TaskReviewChanged, listener),
  listenTaskReviewSignalsChanged: (listener: (payload: unknown) => void) =>
    listenMock(IPC.TaskReviewSignalsChanged, listener),
  listenTaskStepsChanged: (listener: (payload: unknown) => void) =>
    listenMock(IPC.TaskStepsChanged, listener),
}));

vi.mock('../lib/github-url', () => ({
  isGitHubUrl: () => false,
}));

vi.mock('../lib/platform', () => ({
  isMac: false,
}));

vi.mock('../lib/wheelZoom', () => ({
  createCtrlWheelZoomHandler: (_callback: (delta: number) => void) => vi.fn(),
}));

vi.mock('../runtime/browser-session', () => ({
  getConnectionBannerText: vi.fn(),
  registerBrowserAppRuntime: registerBrowserAppRuntimeMock,
}));

vi.mock('../runtime/app-shortcuts', () => ({
  registerAppShortcuts: registerAppShortcutsMock,
}));

vi.mock('../runtime/server-sync', () => ({
  createBrowserStateSync: createBrowserStateSyncMock,
  handleAgentLifecycleMessage: vi.fn(),
  handleGitStatusChanged: handleGitStatusChangedMock,
  reconcileRunningAgentIds: vi.fn(),
  reconcileRunningAgents: vi.fn().mockResolvedValue(undefined),
  syncAgentStatusesFromServer: vi.fn(),
}));

vi.mock('../runtime/window-session', () => ({
  createWindowSessionRuntime: () => ({
    captureWindowState: captureWindowStateMock,
    cleanupWindowEventListeners: cleanupWindowEventListenersMock,
    registerCloseRequestedHandler: registerCloseRequestedHandlerMock,
    registerWindowEventListeners: registerWindowEventListenersMock,
    restoreWindowState: restoreWindowStateMock,
    setupWindowChrome: setupWindowChromeMock,
    syncWindowFocused: syncWindowFocusedMock,
    syncWindowMaximized: syncWindowMaximizedMock,
  }),
}));

vi.mock('./task-notification-capabilities', () => ({
  getTaskNotificationCapability: vi.fn(() => ({
    checking: false,
    permission: 'granted',
    provider: 'electron',
    supported: true,
  })),
  initializeTaskNotificationCapabilityRuntime: initializeTaskNotificationCapabilityRuntimeMock,
  refreshTaskNotificationCapability: refreshTaskNotificationCapabilityMock,
}));

vi.mock('./task-notification-runtime', () => ({
  startTaskNotificationRuntime: startTaskNotificationRuntimeMock,
}));

vi.mock('./task-notification-sinks', () => ({
  createElectronTaskNotificationSink: createElectronTaskNotificationSinkMock,
  createWebTaskNotificationSink: createWebTaskNotificationSinkMock,
}));

vi.mock('./new-task-dialog-workflows', () => ({
  openNewTaskDialog: vi.fn(),
}));

vi.mock('../store/autosave', () => ({
  markAutosaveClean: markAutosaveCleanMock,
  setupAutosave: setupAutosaveMock,
}));

vi.mock('../app/agent-catalog', () => ({
  loadAgents: loadAgentsMock,
}));

vi.mock('../store/client-session', () => ({
  loadClientSessionState: loadClientSessionStateMock,
  reconcileClientSessionState: reconcileClientSessionStateMock,
  saveClientSessionState: saveClientSessionStateMock,
}));

vi.mock('../store/notification', () => ({
  showNotification: vi.fn(),
}));

vi.mock('../store/peer-presence', () => ({
  replacePeerSessions: replacePeerSessionsMock,
}));

vi.mock('../store/persistence-load', () => ({
  applyBrowserColdBootstrapWorkspaceProjection: applyBrowserColdBootstrapWorkspaceProjectionMock,
  loadState: loadStateMock,
  loadWorkspaceState: loadWorkspaceStateMock,
}));

vi.mock('./browser-cold-bootstrap', () => ({
  fetchBrowserColdBootstrap: fetchBrowserColdBootstrapMock,
}));

vi.mock('../store/browser-cold-bootstrap-handoff', () => ({
  hasMeaningfulBrowserColdBootstrapProjection: hasMeaningfulBrowserColdBootstrapProjectionMock,
  takeBrowserColdBootstrapHandoffProjection: takeBrowserColdBootstrapHandoffProjectionMock,
}));

vi.mock('../store/persistence-save', () => ({
  saveBrowserWorkspaceStateOnPagehide: saveBrowserWorkspaceStateOnPagehideMock,
  saveState: saveStateMock,
}));

vi.mock('../store/projects', () => ({
  validateProjectPaths: validateProjectPathsMock,
}));

vi.mock('../store/state', () => ({
  store: storeState,
}));

vi.mock('../store/task-command-controllers', () => ({
  applyTaskCommandControllerChanged: applyTaskCommandControllerChangedMock,
  getTaskCommandControllerUpdateCount: getTaskCommandControllerUpdateCountMock,
  getTaskCommandControllerVersion: vi.fn(() => 0),
  replaceTaskCommandControllers: replaceTaskCommandControllersMock,
}));

vi.mock('../store/task-command-takeovers', () => ({
  upsertIncomingTaskTakeoverRequest: upsertIncomingTaskTakeoverRequestMock,
}));

vi.mock('../store/tasks', () => ({
  setNewTaskDropUrl: vi.fn(),
  setPlanContent: setPlanContentMock,
}));

vi.mock('../store/ui', () => ({
  adjustGlobalScale: adjustGlobalScaleMock,
}));

vi.mock('./remote-access', () => ({
  applyRemoteStatus: applyRemoteStatusMock,
  fetchRemoteStatusSnapshot: fetchRemoteStatusSnapshotMock,
  updateRemotePeerStatus: vi.fn(),
}));

vi.mock('./task-convergence', () => ({
  applyTaskConvergenceEvent: applyTaskConvergenceEventMock,
  fetchTaskConvergence: fetchTaskConvergenceMock,
  replaceTaskConvergenceSnapshots: replaceTaskConvergenceSnapshotsMock,
}));

vi.mock('./task-review-state', () => ({
  applyTaskReviewEvent: applyTaskReviewEventMock,
  replaceTaskReviewSnapshots: replaceTaskReviewSnapshotsMock,
}));

vi.mock('./task-ports', () => ({
  applyTaskPortsEvent: applyTaskPortsEventMock,
  fetchTaskPorts: fetchTaskPortsMock,
  replaceTaskPortSnapshots: replaceTaskPortSnapshotsMock,
}));

vi.mock('./task-attention', () => ({
  applyAgentSupervisionEvent: applyAgentSupervisionEventMock,
  replaceAgentSupervisionSnapshots: replaceAgentSupervisionSnapshotsMock,
}));

vi.mock('../store/task-git-status', () => ({
  handleGitStatusSyncEvent: handleGitStatusSyncEventMock,
  replaceGitStatusSnapshots: replaceGitStatusSnapshotsMock,
}));

import { startDesktopAppSession } from './desktop-session';

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    reject = innerReject;
    resolve = innerResolve;
  });
  return { promise, reject, resolve };
}

async function flushResolvedPromises(iterations = 12): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function createEmptyColdBootstrapProjection() {
  return {
    availableAgents: [],
    collapsedTaskOrder: [],
    completedTaskCount: 0,
    completedTaskDate: '2026-03-16',
    customAgents: [],
    hydraCommand: '',
    hydraForceDispatchFromPromptPanel: true,
    hydraStartupMode: 'auto' as const,
    lastProjectId: null,
    mergedLinesAdded: 0,
    mergedLinesRemoved: 0,
    projects: [],
    taskOrder: [],
    tasks: {},
    terminals: {},
  };
}

const BROWSER_COLD_BOOTSTRAP_TEST_RETRY_WINDOW_MS = 500;
const BROWSER_COLD_BOOTSTRAP_TEST_FAILURE_WINDOW_MS = 2_000;

function hasEnsureAgentSessionsBatchInvoke(): boolean {
  return invokeMock.mock.calls.some(([channel]) => channel === IPC.EnsureAgentSessionsBatch);
}

describe('desktop session startup sequencing', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    resetAppStartupStatusForTests();
    resetBrowserStartupStateForTests();
    resetTerminalStartupStateForTests();
    resetTerminalStartupPaintCoordinationForTests();
    resetRendererRuntimeDiagnostics();
    windowListeners.clear();
    windowEventListeners.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    fetchTaskPortsMock.mockReset();
    fetchTaskPortsMock.mockResolvedValue([]);
    fetchTaskConvergenceMock.mockReset();
    fetchTaskConvergenceMock.mockResolvedValue([]);
    fetchRemoteStatusSnapshotMock.mockReset();
    fetchRemoteStatusSnapshotMock.mockResolvedValue({
      enabled: false,
      connectedClients: 0,
      peerClients: 0,
      port: 7777,
      tailscaleUrl: null,
      token: null,
      url: null,
      wifiUrl: null,
    });
    loadAgentsMock.mockReset();
    loadAgentsMock.mockResolvedValue(undefined);
    applyRemoteStatusMock.mockReset();
    applyTaskCommandControllerChangedMock.mockReset();
    applyTaskConvergenceEventMock.mockReset();
    applyTaskPortsEventMock.mockReset();
    applyTaskReviewEventMock.mockReset();
    applyAgentSupervisionEventMock.mockReset();
    applyBrowserColdBootstrapWorkspaceProjectionMock.mockReset();
    fetchBrowserColdBootstrapMock.mockReset();
    fetchBrowserColdBootstrapMock.mockResolvedValue({
      serverStateBootstrap: [],
      workspaceRevision: 0,
      workspaceProjection: createMeaningfulColdBootstrapProjection(),
    });
    hasMeaningfulBrowserColdBootstrapProjectionMock.mockReset();
    hasMeaningfulBrowserColdBootstrapProjectionMock.mockImplementation(
      isMeaningfulColdBootstrapProjectionForTest,
    );
    loadClientSessionStateMock.mockReset();
    loadStateMock.mockReset();
    loadStateMock.mockResolvedValue(undefined);
    loadWorkspaceStateMock.mockReset();
    loadWorkspaceStateMock.mockResolvedValue(true);
    getTaskCommandControllerUpdateCountMock.mockReset();
    getTaskCommandControllerUpdateCountMock.mockReturnValue(0);
    markAutosaveCleanMock.mockReset();
    reconcileClientSessionStateMock.mockReset();
    replaceTaskConvergenceSnapshotsMock.mockReset();
    replacePeerSessionsMock.mockReset();
    replaceTaskReviewSnapshotsMock.mockReset();
    replaceAgentSupervisionSnapshotsMock.mockReset();
    replaceGitStatusSnapshotsMock.mockReset();
    replaceTaskPortSnapshotsMock.mockReset();
    registerAppShortcutsMock.mockReset();
    registerAppShortcutsMock.mockImplementation(() => vi.fn());
    registerBrowserAppRuntimeMock.mockReset();
    registerBrowserAppRuntimeMock.mockImplementation(() => vi.fn());
    registerCloseRequestedHandlerMock.mockReset();
    registerCloseRequestedHandlerMock.mockResolvedValue(vi.fn());
    registerPathInputNotifierMock.mockReset();
    restoreWindowStateMock.mockReset();
    restoreWindowStateMock.mockResolvedValue(undefined);
    saveStateMock.mockReset();
    saveStateMock.mockResolvedValue(undefined);
    saveBrowserWorkspaceStateOnPagehideMock.mockReset();
    saveClientSessionStateMock.mockReset();
    setupAutosaveMock.mockReset();
    setupWindowChromeMock.mockReset();
    setupWindowChromeMock.mockResolvedValue(undefined);
    setPlanContentMock.mockReset();
    syncWindowFocusedMock.mockReset();
    syncWindowMaximizedMock.mockReset();
    takeBrowserColdBootstrapHandoffProjectionMock.mockReset();
    takeBrowserColdBootstrapHandoffProjectionMock.mockReturnValue(null);
    upsertIncomingTaskTakeoverRequestMock.mockReset();
    validateProjectPathsMock.mockReset();
    validateProjectPathsMock.mockResolvedValue(undefined);
    storeState.projects = [];
    storeState.activeTaskId = null;
    storeState.activeAgentId = null;
    storeState.agents = {};
    storeState.hydraCommand = '';
    storeState.hydraStartupMode = 'auto';
    storeState.taskOrder = [];
    storeState.collapsedTaskOrder = [];
    storeState.tasks = {};
    storeState.terminals = {};

    listenMock.mockImplementation((channel: string, listener: (payload: unknown) => void) => {
      windowListeners.set(channel, listener);
      return () => {
        if (windowListeners.get(channel) === listener) {
          windowListeners.delete(channel);
        }
      };
    });

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        activeElement: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
        addEventListener: vi.fn((event: string, listener: EventListener) => {
          windowEventListeners.set(event, listener);
        }),
        removeEventListener: vi.fn((event: string, listener: EventListener) => {
          if (windowEventListeners.get(event) === listener) {
            windowEventListeners.delete(event);
          }
        }),
      },
    });
  });

  afterEach(async () => {
    resetBrowserStartupStateForTests();
    resetTerminalStartupPaintCoordinationForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });

    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('buffers Electron git-status events until state has loaded', async () => {
    const deferredLoadState = createDeferred<undefined>();
    loadStateMock.mockReturnValueOnce(deferredLoadState.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    expect(windowListeners.has(IPC.GitStatusChanged)).toBe(true);

    const message = {
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    };

    windowListeners.get(IPC.GitStatusChanged)?.(message);
    expect(handleGitStatusSyncEventMock).not.toHaveBeenCalled();

    deferredLoadState.resolve(undefined);
    await deferredLoadState.promise;
    await flushResolvedPromises();

    expect(getRendererRuntimeDiagnosticsSnapshot().bootstrap).toMatchObject({
      completions: 1,
    });
    expect(handleGitStatusSyncEventMock).toHaveBeenCalledWith(message);

    cleanup();
  });

  it('starts and cleans up the task notification runtime through the desktop session owner', () => {
    const stopDesktopNotificationsMock = vi.fn();
    const windowFocused = vi.fn(() => false);
    startTaskNotificationRuntimeMock.mockReturnValueOnce(stopDesktopNotificationsMock);

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      windowFocused,
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    expect(initializeTaskNotificationCapabilityRuntimeMock).toHaveBeenCalledWith(true);
    expect(createElectronTaskNotificationSinkMock).toHaveBeenCalledTimes(1);
    expect(startTaskNotificationRuntimeMock).toHaveBeenCalledWith({
      capability: expect.any(Function),
      isNotificationsArmed: expect.any(Function),
      isWindowFocused: windowFocused,
      sink: expect.any(Object),
    });

    cleanup();

    expect(stopDesktopNotificationsMock).toHaveBeenCalledTimes(1);
  });

  it('starts the shared task notification runtime with the web sink in browser mode', () => {
    const stopTaskNotificationsMock = vi.fn();
    const windowFocused = vi.fn(() => false);
    startTaskNotificationRuntimeMock.mockReturnValueOnce(stopTaskNotificationsMock);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      windowFocused,
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    expect(initializeTaskNotificationCapabilityRuntimeMock).toHaveBeenCalledWith(false);
    expect(createWebTaskNotificationSinkMock).toHaveBeenCalledTimes(1);
    expect(startTaskNotificationRuntimeMock).toHaveBeenCalledWith({
      capability: expect.any(Function),
      isNotificationsArmed: expect.any(Function),
      isWindowFocused: windowFocused,
      sink: expect.any(Object),
    });

    cleanup();

    expect(stopTaskNotificationsMock).toHaveBeenCalledTimes(1);
  });

  it('forwards SSH-clone path input requests through the desktop session owner', () => {
    const setPathInputDialog = vi.fn();

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog,
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    const notify = registerPathInputNotifierMock.mock.calls[0]?.[0] as (() => void) | undefined;
    getPendingPathInputMock.mockReturnValue({
      options: {
        allowSshClone: true,
        directory: true,
        suppressRecentProjects: true,
      },
      resolve: vi.fn(),
    });

    notify?.();

    expect(setPathInputDialog).toHaveBeenCalledWith({
      open: true,
      directory: true,
      allowSshClone: true,
      suppressRecentProjects: true,
    });

    cleanup();
    expect(clearPathInputNotifierMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes browser notification capability on focus and visible tab restores', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      windowFocused: vi.fn(() => false),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    const focusListener = windowEventListeners.get('focus');
    expect(focusListener).toBeTypeOf('function');

    focusListener?.(new Event('focus'));
    await flushResolvedPromises();

    expect(refreshTaskNotificationCapabilityMock).toHaveBeenCalledWith(false);

    const addDocumentListenerMock = document.addEventListener as ReturnType<typeof vi.fn>;
    const removeDocumentListenerMock = document.removeEventListener as ReturnType<typeof vi.fn>;
    const visibilityListener = addDocumentListenerMock.mock.calls.find(
      ([eventName]) => eventName === 'visibilitychange',
    )?.[1] as EventListener | undefined;

    expect(visibilityListener).toBeTypeOf('function');

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    visibilityListener?.(new Event('visibilitychange'));
    await flushResolvedPromises();
    expect(refreshTaskNotificationCapabilityMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    visibilityListener?.(new Event('visibilitychange'));
    await flushResolvedPromises();
    expect(refreshTaskNotificationCapabilityMock).toHaveBeenCalledTimes(2);

    cleanup();

    expect(removeDocumentListenerMock).toHaveBeenCalledWith('visibilitychange', visibilityListener);
  });

  it('updates and clears the shared startup status during desktop startup', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      windowFocused: vi.fn(() => false),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    expect(getAppStartupSummary()).toEqual({
      detail: 'Loading workspace and session state',
      label: 'Still loading your workspace…',
    });

    await flushResolvedPromises();
    cleanup();

    expect(getAppStartupSummary()).toBeNull();
  });

  it('buffers Electron task-port events until state has loaded', async () => {
    const deferredLoadState = createDeferred<undefined>();
    loadStateMock.mockReturnValueOnce(deferredLoadState.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    expect(windowListeners.has(IPC.TaskPortsChanged)).toBe(true);

    const event = {
      kind: 'snapshot',
      taskId: 'task-1',
      observed: [],
      exposed: [
        {
          availability: 'unknown',
          host: null,
          label: 'Frontend',
          lastVerifiedAt: null,
          port: 5173,
          protocol: 'http',
          source: 'manual',
          statusMessage: null,
          updatedAt: 1_000,
          verifiedHost: null,
        },
      ],
      updatedAt: 1_000,
    };

    windowListeners.get(IPC.TaskPortsChanged)?.(event);
    expect(applyTaskPortsEventMock).not.toHaveBeenCalled();

    deferredLoadState.resolve(undefined);
    await deferredLoadState.promise;
    await flushResolvedPromises();

    expect(applyTaskPortsEventMock).toHaveBeenCalledWith(event);

    cleanup();
  });

  it('restores persisted plan content for Electron tasks with a saved plan file', async () => {
    storeState.taskOrder = ['task-1'];
    storeState.tasks = {
      'task-1': {
        planFileName: 'current-plan.md',
        planRelativePath: 'docs/plans/current-plan.md',
        worktreePath: '/tmp/task-1',
      },
    };
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      if (channel === IPC.ReadPlanContent) {
        expect(args).toEqual({
          relativePath: 'docs/plans/current-plan.md',
          worktreePath: '/tmp/task-1',
        });
        return Promise.resolve({
          content: '# Restored plan',
          fileName: 'current-plan.md',
          relativePath: 'docs/plans/current-plan.md',
        });
      }

      return Promise.resolve([]);
    });

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();

    expect(setPlanContentMock).toHaveBeenCalledWith(
      'task-1',
      '# Restored plan',
      'current-plan.md',
      'docs/plans/current-plan.md',
    );

    cleanup();
  });

  it('prewarms restored Electron background task agent sessions after selected startup fallback', async () => {
    vi.useFakeTimers();
    loadStateMock.mockImplementation(async () => {
      storeState.projects = [
        {
          id: 'project-1',
        },
      ];
      storeState.activeTaskId = 'task-1';
      storeState.activeAgentId = 'agent-1';
      storeState.taskOrder = ['task-background', 'task-1'];
      storeState.tasks = {
        'task-background': {
          agentIds: ['agent-background'],
          id: 'task-background',
          projectId: 'project-1',
          shellAgentIds: [],
          worktreePath: '/tmp/task-background',
        },
        'task-1': {
          agentIds: ['agent-1'],
          baseBranch: 'release/main',
          id: 'task-1',
          projectId: 'project-1',
          projectMode: 'git',
          shellAgentIds: ['shell-1'],
          skipPermissions: true,
          worktreePath: '/tmp/task-1',
        },
      };
      storeState.agents = {
        'agent-background': {
          def: {
            args: ['watch'],
            command: 'claude',
            description: 'Claude',
            id: 'claude',
            name: 'Claude',
            resume_args: [],
            skip_permissions_args: [],
          },
          exitCode: null,
          generation: 0,
          id: 'agent-background',
          lastOutput: [],
          resumed: false,
          signal: null,
          status: 'running',
          taskId: 'task-background',
        },
        'agent-1': {
          def: {
            args: ['run'],
            command: 'codex',
            description: 'Codex',
            id: 'codex',
            name: 'Codex',
            resume_args: ['resume'],
            resume_strategy: 'cli-args',
            skip_permissions_args: ['--skip-permissions'],
          },
          exitCode: null,
          generation: 0,
          id: 'agent-1',
          lastOutput: [],
          resumed: true,
          signal: null,
          status: 'running',
          taskId: 'task-1',
        },
      };
    });
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.EnsureAgentSessionsBatch) {
        return {
          results: [
            {
              agentId: 'agent-background',
              cols: 80,
              created: true,
              existed: false,
              rows: 24,
              taskId: 'task-background',
            },
          ],
        };
      }

      return [];
    });

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();

    expect(hasEnsureAgentSessionsBatchInvoke()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushResolvedPromises();

    expect(invokeMock).toHaveBeenCalledWith(IPC.EnsureAgentSessionsBatch, {
      reason: 'startup-restore',
      requests: [
        {
          agentId: 'agent-background',
          args: ['watch'],
          cols: 80,
          command: 'claude',
          cwd: '/tmp/task-background',
          env: {},
          resumeOnStart: false,
          rows: 24,
          taskId: 'task-background',
        },
      ],
    });

    cleanup();
  });

  it('prewarms restored Electron background task agent sessions after selected paint', async () => {
    vi.useFakeTimers();
    loadStateMock.mockImplementation(async () => {
      storeState.activeTaskId = 'task-1';
      storeState.activeAgentId = 'agent-1';
      storeState.taskOrder = ['task-background', 'task-1'];
      storeState.tasks = {
        'task-background': {
          agentIds: ['agent-background'],
          id: 'task-background',
          projectId: 'project-1',
          shellAgentIds: [],
          worktreePath: '/tmp/task-background',
        },
        'task-1': {
          agentIds: ['agent-1'],
          id: 'task-1',
          projectId: 'project-1',
          shellAgentIds: [],
          worktreePath: '/tmp/task-1',
        },
      };
      storeState.agents = {
        'agent-background': {
          def: {
            args: ['watch'],
            command: 'claude',
            description: 'Claude',
            id: 'claude',
            name: 'Claude',
            resume_args: [],
            skip_permissions_args: [],
          },
          exitCode: null,
          generation: 0,
          id: 'agent-background',
          lastOutput: [],
          resumed: false,
          signal: null,
          status: 'running',
          taskId: 'task-background',
        },
        'agent-1': {
          def: {
            args: ['run'],
            command: 'codex',
            description: 'Codex',
            id: 'codex',
            name: 'Codex',
            resume_args: [],
            skip_permissions_args: [],
          },
          exitCode: null,
          generation: 0,
          id: 'agent-1',
          lastOutput: [],
          resumed: false,
          signal: null,
          status: 'running',
          taskId: 'task-1',
        },
      };
    });

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();

    expect(hasEnsureAgentSessionsBatchInvoke()).toBe(false);

    setTerminalStartupPaintCoordinationEntry('task-1:agent-1', {
      paintReady: true,
      role: 'selected',
      taskId: 'task-1',
    });
    await flushResolvedPromises();

    expect(invokeMock).toHaveBeenCalledWith(IPC.EnsureAgentSessionsBatch, {
      reason: 'startup-restore',
      requests: [
        expect.objectContaining({
          agentId: 'agent-background',
          taskId: 'task-background',
        }),
      ],
    });

    cleanup();
  });

  it('cancels deferred startup restore prewarm when Electron startup is disposed', async () => {
    vi.useFakeTimers();
    loadStateMock.mockImplementation(async () => {
      storeState.activeTaskId = 'task-1';
      storeState.activeAgentId = 'agent-1';
      storeState.taskOrder = ['task-background', 'task-1'];
      storeState.tasks = {
        'task-background': {
          agentIds: ['agent-background'],
          id: 'task-background',
          projectId: 'project-1',
          shellAgentIds: [],
          worktreePath: '/tmp/task-background',
        },
        'task-1': {
          agentIds: ['agent-1'],
          id: 'task-1',
          projectId: 'project-1',
          shellAgentIds: [],
          worktreePath: '/tmp/task-1',
        },
      };
      storeState.agents = {
        'agent-background': {
          def: {
            args: ['watch'],
            command: 'claude',
            description: 'Claude',
            id: 'claude',
            name: 'Claude',
            resume_args: [],
            skip_permissions_args: [],
          },
          exitCode: null,
          generation: 0,
          id: 'agent-background',
          lastOutput: [],
          resumed: false,
          signal: null,
          status: 'running',
          taskId: 'task-background',
        },
        'agent-1': {
          def: {
            args: ['run'],
            command: 'codex',
            description: 'Codex',
            id: 'codex',
            name: 'Codex',
            resume_args: [],
            skip_permissions_args: [],
          },
          exitCode: null,
          generation: 0,
          id: 'agent-1',
          lastOutput: [],
          resumed: false,
          signal: null,
          status: 'running',
          taskId: 'task-1',
        },
      };
    });

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();
    cleanup();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushResolvedPromises();

    expect(hasEnsureAgentSessionsBatchInvoke()).toBe(false);
  });

  it('buffers Electron task-convergence events until state has loaded', async () => {
    const deferredLoadState = createDeferred<undefined>();
    loadStateMock.mockReturnValueOnce(deferredLoadState.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(windowListeners.has(IPC.TaskConvergenceChanged)).toBe(true);
    });

    const event = {
      branchFiles: ['src/app.ts'],
      branchName: 'feature/task-1',
      changedFileCount: 1,
      commitCount: 1,
      conflictingFiles: [],
      hasCommittedChanges: true,
      hasUncommittedChanges: false,
      mainAheadCount: 0,
      overlapWarnings: [],
      projectId: 'project-1',
      state: 'review-ready',
      summary: '1 commit, 1 file changed',
      taskId: 'task-1',
      totalAdded: 4,
      totalRemoved: 0,
      updatedAt: 1_000,
      worktreePath: '/tmp/task-1',
    };

    windowListeners.get(IPC.TaskConvergenceChanged)?.(event);
    expect(applyTaskConvergenceEventMock).not.toHaveBeenCalled();

    deferredLoadState.resolve(undefined);
    await deferredLoadState.promise;
    await flushResolvedPromises();

    expect(applyTaskConvergenceEventMock).toHaveBeenCalledWith(event);

    cleanup();
  });

  it('buffers Electron remote-status events until state has loaded', async () => {
    const deferredLoadState = createDeferred<undefined>();
    loadStateMock.mockReturnValueOnce(deferredLoadState.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();
    expect(windowListeners.has(IPC.RemoteStatusChanged)).toBe(true);

    const message = {
      enabled: true,
      connectedClients: 3,
      peerClients: 2,
      token: 'secret',
      port: 7777,
      url: 'http://server',
      wifiUrl: null,
      tailscaleUrl: null,
    };

    windowListeners.get(IPC.RemoteStatusChanged)?.(message);
    expect(applyRemoteStatusMock).not.toHaveBeenCalled();

    deferredLoadState.resolve(undefined);
    await deferredLoadState.promise;
    await flushResolvedPromises();

    expect(getRendererRuntimeDiagnosticsSnapshot().bootstrap).toMatchObject({
      completions: 1,
    });
    expect(applyRemoteStatusMock).toHaveBeenCalledWith(message);

    cleanup();
  });

  it('buffers Electron agent-supervision events until state has loaded', async () => {
    const deferredLoadState = createDeferred<undefined>();
    loadStateMock.mockReturnValueOnce(deferredLoadState.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(windowListeners.has(IPC.AgentSupervisionChanged)).toBe(true);
    });

    const message = {
      agentId: 'agent-1',
      attentionReason: 'waiting-input',
      isShell: false,
      kind: 'snapshot',
      lastOutputAt: 1_000,
      preview: 'Proceed? [Y/n]',
      state: 'awaiting-input',
      taskId: 'task-1',
      updatedAt: 1_000,
    };

    windowListeners.get(IPC.AgentSupervisionChanged)?.(message);
    expect(applyAgentSupervisionEventMock).not.toHaveBeenCalled();

    deferredLoadState.resolve(undefined);
    await deferredLoadState.promise;
    await flushResolvedPromises();

    expect(applyAgentSupervisionEventMock).toHaveBeenCalledWith(message);

    cleanup();
  });

  it('hydrates Electron agent supervision snapshots after state has loaded', async () => {
    const initialSnapshots = [
      {
        category: 'agent-supervision',
        mode: 'replace',
        payload: [
          {
            agentId: 'agent-1',
            attentionReason: 'ready-for-next-step',
            isShell: false,
            lastOutputAt: 1_000,
            preview: 'hydra>',
            state: 'idle-at-prompt',
            taskId: 'task-1',
            updatedAt: 1_000,
          },
        ],
        version: 1,
      },
    ];
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.GetServerStateBootstrap) {
        return initialSnapshots;
      }

      return [];
    });

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(replaceAgentSupervisionSnapshotsMock).toHaveBeenCalledWith(
        initialSnapshots[0].payload,
        { replaceVersion: initialSnapshots[0].version },
      );
    });
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetServerStateBootstrap);

    cleanup();
  });

  it('uses the dedicated browser cold bootstrap instead of the electron startup fetch path', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();

    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);
    expect(applyBrowserColdBootstrapWorkspaceProjectionMock).toHaveBeenCalledWith(
      createMeaningfulColdBootstrapProjection(),
      0,
    );
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.GetServerStateBootstrap);
    expect(replaceAgentSupervisionSnapshotsMock).not.toHaveBeenCalled();

    cleanup();
  });

  it('loads browser-local client session state after the cold bootstrap projection', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);
      expect(applyBrowserColdBootstrapWorkspaceProjectionMock).toHaveBeenCalledTimes(1);
      expect(loadClientSessionStateMock).toHaveBeenCalledWith({
        restoreTerminalPanels: true,
      });
      expect(reconcileClientSessionStateMock).toHaveBeenCalledTimes(1);
    });

    cleanup();
  });

  it('treats an empty backend browser cold bootstrap snapshot as valid state', async () => {
    fetchBrowserColdBootstrapMock.mockResolvedValueOnce({
      serverStateBootstrap: [],
      workspaceRevision: 0,
      workspaceProjection: createEmptyColdBootstrapProjection(),
    });

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();

    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);
    expect(applyBrowserColdBootstrapWorkspaceProjectionMock).toHaveBeenCalledWith(
      createEmptyColdBootstrapProjection(),
      0,
    );
    expect(takeBrowserColdBootstrapHandoffProjectionMock).not.toHaveBeenCalled();
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();

    cleanup();
  });

  it('falls back to loading canonical workspace state when cold bootstrap projections are unavailable', async () => {
    vi.useFakeTimers();
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(BROWSER_COLD_BOOTSTRAP_TEST_RETRY_WINDOW_MS);
    await flushResolvedPromises();

    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(3);
    expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    expect(takeBrowserColdBootstrapHandoffProjectionMock).toHaveBeenCalledTimes(1);
    expect(applyBrowserColdBootstrapWorkspaceProjectionMock).not.toHaveBeenCalled();
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(1);
    expect(loadAgentsMock.mock.invocationCallOrder[0]).toBeLessThan(
      takeBrowserColdBootstrapHandoffProjectionMock.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(loadAgentsMock.mock.invocationCallOrder[0]).toBeLessThan(
      loadWorkspaceStateMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    cleanup();
  });

  it('does not retry empty browser cold bootstrap snapshots', async () => {
    fetchBrowserColdBootstrapMock.mockResolvedValueOnce({
      serverStateBootstrap: [],
      workspaceRevision: 0,
      workspaceProjection: createEmptyColdBootstrapProjection(),
    });

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);
      expect(applyBrowserColdBootstrapWorkspaceProjectionMock).toHaveBeenCalledWith(
        createEmptyColdBootstrapProjection(),
        0,
      );
      expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
    });

    cleanup();
  });

  it('retries loading canonical workspace state when cold bootstrap starts before shared state is available', async () => {
    vi.useFakeTimers();
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);
    loadWorkspaceStateMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(3);
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(2);
    expect(applyBrowserColdBootstrapWorkspaceProjectionMock).not.toHaveBeenCalled();
    expect(loadClientSessionStateMock).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('cancels pending browser cold bootstrap retry timers when startup is cleaned up', async () => {
    vi.useFakeTimers();
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();
    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);

    cleanup();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushResolvedPromises();

    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
  });

  it('retries canonical workspace load after a transient browser startup load failure', async () => {
    vi.useFakeTimers();
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);
    loadWorkspaceStateMock.mockRejectedValueOnce(new Error('workspace load unavailable'));
    loadWorkspaceStateMock.mockResolvedValueOnce(true);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(BROWSER_COLD_BOOTSTRAP_TEST_RETRY_WINDOW_MS);
    await flushResolvedPromises();

    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(3);
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(2);
    expect(loadClientSessionStateMock).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('schedules a follow-up browser sync instead of aborting startup when browser cold bootstrap remains unavailable', async () => {
    vi.useFakeTimers();
    fetchBrowserColdBootstrapMock.mockRejectedValue(new Error('bootstrap unavailable'));
    loadWorkspaceStateMock.mockResolvedValue(false);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(BROWSER_COLD_BOOTSTRAP_TEST_FAILURE_WINDOW_MS);
    await flushResolvedPromises();

    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(3);
    expect(loadWorkspaceStateMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(loadClientSessionStateMock).toHaveBeenCalledTimes(1);
    expect(reconcileClientSessionStateMock).toHaveBeenCalledTimes(1);
    expect(getAppStartupSummary()).toBeNull();

    const latestBrowserStateSyncResult =
      createBrowserStateSyncMock.mock.results[createBrowserStateSyncMock.mock.results.length - 1];
    const browserStateSync = latestBrowserStateSyncResult?.value as
      | { scheduleBrowserStateSync: ReturnType<typeof vi.fn> }
      | undefined;
    expect(browserStateSync?.scheduleBrowserStateSync).toHaveBeenCalledWith(0, false);

    cleanup();
  });

  it('retries browser cold bootstrap fetches before applying the backend projection', async () => {
    vi.useFakeTimers();
    fetchBrowserColdBootstrapMock
      .mockRejectedValueOnce(new Error('temporary bootstrap failure'))
      .mockResolvedValueOnce({
        serverStateBootstrap: [],
        workspaceRevision: 7,
        workspaceProjection: createMeaningfulColdBootstrapProjection(),
      });

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(BROWSER_COLD_BOOTSTRAP_TEST_RETRY_WINDOW_MS);
    await flushResolvedPromises();

    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(2);
    expect(applyBrowserColdBootstrapWorkspaceProjectionMock).toHaveBeenCalledWith(
      createMeaningfulColdBootstrapProjection(),
      7,
    );
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();

    cleanup();
  });

  it('falls back to the same-tab handoff projection when cold bootstrap fetches keep failing', async () => {
    vi.useFakeTimers();
    const handoffProjection = {
      ...createEmptyColdBootstrapProjection(),
      projects: [
        {
          color: '#225577',
          id: 'project-handoff-error',
          name: 'Handoff Project',
          path: '/tmp/handoff-error',
        },
      ],
      taskOrder: ['task-handoff-error'],
      tasks: {
        'task-handoff-error': {
          agentIds: ['agent-handoff-error'],
          branchName: 'feature/handoff-error',
          id: 'task-handoff-error',
          lastPrompt: '',
          name: 'Handoff Task Error',
          notes: '',
          projectId: 'project-handoff-error',
          shellAgentIds: [],
          worktreePath: '/tmp/handoff-error/task-handoff-error',
        },
      },
    };
    fetchBrowserColdBootstrapMock.mockRejectedValue(new Error('bootstrap unavailable'));
    takeBrowserColdBootstrapHandoffProjectionMock.mockReturnValueOnce(handoffProjection);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(BROWSER_COLD_BOOTSTRAP_TEST_RETRY_WINDOW_MS);
    await flushResolvedPromises();

    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(3);
    expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    expect(takeBrowserColdBootstrapHandoffProjectionMock).toHaveBeenCalledTimes(1);
    expect(applyBrowserColdBootstrapWorkspaceProjectionMock).toHaveBeenCalledWith(
      handoffProjection,
      0,
    );
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
    expect(loadAgentsMock.mock.invocationCallOrder[0]).toBeLessThan(
      takeBrowserColdBootstrapHandoffProjectionMock.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );

    cleanup();
  });

  it('resets cold bootstrap gating when browser startup is disposed before completion', async () => {
    const deferredBootstrap = createDeferred<{
      serverStateBootstrap: [];
      workspaceRevision: number;
      workspaceProjection: ReturnType<typeof createEmptyColdBootstrapProjection>;
    }>();
    fetchBrowserColdBootstrapMock.mockReturnValueOnce(deferredBootstrap.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();
    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);
    expect(isBrowserColdBootstrapPending()).toBe(true);

    cleanup();

    expect(isBrowserColdBootstrapPending()).toBe(false);

    deferredBootstrap.resolve({
      serverStateBootstrap: [],
      workspaceRevision: 0,
      workspaceProjection: createEmptyColdBootstrapProjection(),
    });
    await deferredBootstrap.promise;
    await flushResolvedPromises();
  });

  it('completes browser cold bootstrap on timeout even when a selected terminal candidate exists', async () => {
    vi.useFakeTimers();

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);
      expect(isBrowserColdBootstrapPending()).toBe(true);
    });

    storeState.activeTaskId = 'task-1';
    storeState.taskOrder = ['task-1'];
    storeState.tasks = {
      'task-1': {
        agentIds: ['agent-1'],
        shellAgentIds: [],
      },
    };

    await vi.advanceTimersByTimeAsync(1_000);

    expect(isBrowserColdBootstrapPending()).toBe(false);

    cleanup();
  });

  it('hydrates early browser state-bootstrap task-port snapshots before load completes', async () => {
    const deferredBootstrap = createDeferred<{
      serverStateBootstrap: [];
      workspaceRevision: number;
      workspaceProjection: ReturnType<typeof createEmptyColdBootstrapProjection>;
    }>();
    fetchBrowserColdBootstrapMock.mockReturnValueOnce(deferredBootstrap.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    expect(windowListeners.has('state-bootstrap')).toBe(true);

    windowListeners.get('state-bootstrap')?.({
      snapshots: [
        {
          category: 'task-ports',
          mode: 'replace',
          payload: [
            {
              taskId: 'task-1',
              observed: [],
              exposed: [],
              updatedAt: 1_000,
            },
          ],
          version: 1,
        },
      ],
    });

    expect(replaceTaskPortSnapshotsMock).not.toHaveBeenCalled();

    deferredBootstrap.resolve({
      serverStateBootstrap: [],
      workspaceRevision: 0,
      workspaceProjection: createEmptyColdBootstrapProjection(),
    });
    await deferredBootstrap.promise;

    await vi.waitFor(() => {
      expect(replaceTaskPortSnapshotsMock).toHaveBeenCalledWith(
        [
          {
            taskId: 'task-1',
            observed: [],
            exposed: [],
            updatedAt: 1_000,
          },
        ],
        { replaceVersion: 1 },
      );
    });
    expect(getRendererRuntimeDiagnosticsSnapshot().bootstrap).toMatchObject({
      bufferedEvents: expect.objectContaining({
        'task-ports': 0,
      }),
      bufferedSnapshots: expect.objectContaining({
        'task-ports': 1,
      }),
      completions: expect.any(Number),
      lastDurationMs: expect.any(Number),
    });

    cleanup();
  });

  it('buffers early browser task-review events until state has loaded', async () => {
    const deferredBootstrap = createDeferred<{
      serverStateBootstrap: [];
      workspaceRevision: number;
      workspaceProjection: ReturnType<typeof createEmptyColdBootstrapProjection>;
    }>();
    fetchBrowserColdBootstrapMock.mockReturnValueOnce(deferredBootstrap.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    expect(windowListeners.has(IPC.TaskReviewChanged)).toBe(true);

    const event = {
      branchName: 'feature/task-1',
      files: [],
      projectId: 'project-1',
      revisionId: 'rev-1',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 0,
      totalRemoved: 0,
      updatedAt: 1_000,
      worktreePath: '/tmp/task-1',
    };

    windowListeners.get(IPC.TaskReviewChanged)?.(event);
    expect(applyTaskReviewEventMock).not.toHaveBeenCalled();

    deferredBootstrap.resolve({
      serverStateBootstrap: [],
      workspaceRevision: 0,
      workspaceProjection: createEmptyColdBootstrapProjection(),
    });
    await deferredBootstrap.promise;

    await vi.waitFor(() => {
      expect(applyTaskReviewEventMock).toHaveBeenCalledWith(event);
    });
    expect(getRendererRuntimeDiagnosticsSnapshot().bootstrap).toMatchObject({
      bufferedEvents: expect.objectContaining({
        'task-review': 1,
        'task-review-signals': 0,
      }),
      bufferedSnapshots: expect.objectContaining({
        'task-review': 0,
        'task-review-signals': 0,
      }),
      completions: expect.any(Number),
      lastDurationMs: expect.any(Number),
    });

    cleanup();
  });

  it('keeps browser review, convergence, and supervision listeners active after startup completes', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();
    expect(registerBrowserAppRuntimeMock).toHaveBeenCalledTimes(1);

    const reviewEvent = {
      branchName: 'feature/task-after-load',
      files: [],
      projectId: 'project-1',
      revisionId: 'rev-after-load',
      source: 'worktree',
      taskId: 'task-after-load',
      totalAdded: 0,
      totalRemoved: 0,
      updatedAt: 2_000,
      worktreePath: '/tmp/task-after-load',
    };
    const convergenceEvent = {
      branchFiles: ['src/app.ts'],
      branchName: 'feature/task-after-load',
      changedFileCount: 1,
      commitCount: 1,
      conflictingFiles: [],
      hasCommittedChanges: true,
      hasUncommittedChanges: false,
      mainAheadCount: 0,
      overlapWarnings: [],
      projectId: 'project-1',
      state: 'review-ready',
      summary: 'Ready to review',
      taskId: 'task-after-load',
      totalAdded: 4,
      totalRemoved: 0,
      updatedAt: 2_100,
      worktreePath: '/tmp/task-after-load',
    };
    const supervisionEvent = {
      agentId: 'agent-1',
      attentionReason: 'waiting-input',
      isShell: false,
      kind: 'snapshot',
      lastOutputAt: 2_190,
      preview: 'Proceed? [Y/n]',
      state: 'awaiting-input',
      taskId: 'task-after-load',
      updatedAt: 2_200,
    };

    windowListeners.get(IPC.TaskReviewChanged)?.(reviewEvent);
    windowListeners.get(IPC.TaskConvergenceChanged)?.(convergenceEvent);
    windowListeners.get(IPC.AgentSupervisionChanged)?.(supervisionEvent);

    expect(applyTaskReviewEventMock).toHaveBeenCalledWith(reviewEvent);
    expect(applyTaskConvergenceEventMock).toHaveBeenCalledWith(convergenceEvent);
    expect(applyAgentSupervisionEventMock).toHaveBeenCalledWith(supervisionEvent);

    cleanup();
  });

  it('attaches the browser runtime before loading the cold bootstrap payload', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();
    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);

    expect(registerBrowserAppRuntimeMock).toHaveBeenCalledTimes(1);
    expect(registerBrowserAppRuntimeMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchBrowserColdBootstrapMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(applyBrowserColdBootstrapWorkspaceProjectionMock).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('does not block browser cold bootstrap on the agent catalog refresh', async () => {
    vi.useFakeTimers();
    const deferredAgents = createDeferred<undefined>();
    loadAgentsMock.mockReturnValueOnce(deferredAgents.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();
    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);
    expect(loadAgentsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    expect(fetchBrowserColdBootstrapMock.mock.invocationCallOrder[0]).toBeLessThan(
      loadAgentsMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    deferredAgents.resolve(undefined);
    await deferredAgents.promise;
    cleanup();
  });

  it('handles failed background browser agent catalog refreshes', async () => {
    vi.useFakeTimers();
    const refreshError = new Error('agent catalog unavailable');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    loadAgentsMock.mockRejectedValueOnce(refreshError);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    try {
      await flushResolvedPromises();
      expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await flushResolvedPromises();
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to refresh browser agent catalog during startup:',
        refreshError,
      );
    } finally {
      cleanup();
      warnSpy.mockRestore();
    }
  });

  it('does not block browser startup on project path validation', async () => {
    const deferredValidation = createDeferred<undefined>();
    validateProjectPathsMock.mockReturnValueOnce(deferredValidation.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();

    expect(validateProjectPathsMock).toHaveBeenCalledTimes(1);
    expect(setupAutosaveMock).toHaveBeenCalled();
    expect(registerCloseRequestedHandlerMock).toHaveBeenCalled();

    deferredValidation.resolve(undefined);
    await flushResolvedPromises();
    cleanup();
  });

  it('does not block browser startup on browser window-state capture', async () => {
    const deferredCapture = createDeferred<undefined>();
    captureWindowStateMock.mockReturnValueOnce(deferredCapture.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(setupAutosaveMock).toHaveBeenCalled();
      expect(registerCloseRequestedHandlerMock).toHaveBeenCalled();
    });

    expect(restoreWindowStateMock).not.toHaveBeenCalled();
    expect(captureWindowStateMock).toHaveBeenCalledTimes(1);

    deferredCapture.resolve(undefined);
    await deferredCapture.promise;
    cleanup();
  });

  it('keeps electron git and remote listeners active after startup completes', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();
    expect(validateProjectPathsMock).toHaveBeenCalled();

    const gitEvent = {
      worktreePath: '/tmp/task-after-load',
      branchName: 'feature/task-after-load',
      projectRoot: '/tmp/project',
    };
    const remoteStatus = {
      enabled: true,
      connectedClients: 1,
      peerClients: 0,
      port: 7777,
      tailscaleUrl: null,
      token: 'token',
      url: 'http://127.0.0.1:7777',
      wifiUrl: null,
    };

    windowListeners.get(IPC.GitStatusChanged)?.(gitEvent);
    windowListeners.get(IPC.RemoteStatusChanged)?.(remoteStatus);

    expect(handleGitStatusSyncEventMock).toHaveBeenCalledWith(gitEvent);
    expect(applyRemoteStatusMock).toHaveBeenCalledWith(remoteStatus);

    cleanup();
  });

  it('hydrates convergence snapshots after state has loaded', async () => {
    const snapshots = [
      {
        category: 'task-convergence',
        mode: 'replace',
        payload: [
          {
            branchFiles: ['src/app.ts'],
            branchName: 'feature/task-1',
            changedFileCount: 1,
            commitCount: 2,
            conflictingFiles: [],
            hasCommittedChanges: true,
            hasUncommittedChanges: false,
            mainAheadCount: 0,
            overlapWarnings: [],
            projectId: 'project-1',
            state: 'review-ready',
            summary: '2 commits, 1 file changed',
            taskId: 'task-1',
            totalAdded: 5,
            totalRemoved: 1,
            updatedAt: 1_000,
            worktreePath: '/tmp/task-1',
          },
        ],
        version: 1,
      },
    ];
    invokeMock.mockResolvedValueOnce(snapshots);

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC.GetServerStateBootstrap);
      expect(replaceTaskConvergenceSnapshotsMock).toHaveBeenCalledWith(snapshots[0].payload, {
        replaceVersion: snapshots[0].version,
      });
    });

    cleanup();
  });

  it('hydrates remote status snapshot after state has loaded', async () => {
    const snapshot = {
      category: 'remote-status',
      mode: 'replace',
      payload: {
        enabled: true,
        connectedClients: 3,
        peerClients: 2,
        token: 'secret',
        port: 7777,
        url: 'http://server',
        wifiUrl: null,
        tailscaleUrl: null,
      },
      version: 1,
    };
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.GetServerStateBootstrap) {
        return [snapshot];
      }

      return [];
    });

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();
    expect(applyRemoteStatusMock).toHaveBeenCalledWith(snapshot.payload);
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetServerStateBootstrap);

    cleanup();
  });

  it('drops buffered startup events after cleanup before state has loaded', async () => {
    const deferredLoadState = createDeferred<undefined>();
    loadStateMock.mockReturnValueOnce(deferredLoadState.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(windowListeners.has(IPC.GitStatusChanged)).toBe(true);
      expect(windowListeners.has(IPC.AgentSupervisionChanged)).toBe(true);
      expect(windowListeners.has(IPC.RemoteStatusChanged)).toBe(true);
    });

    windowListeners.get(IPC.GitStatusChanged)?.({
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });
    windowListeners.get(IPC.RemoteStatusChanged)?.({
      enabled: true,
      connectedClients: 1,
      peerClients: 1,
      token: 'secret',
      port: 7777,
      url: 'http://server',
      wifiUrl: null,
      tailscaleUrl: null,
    });
    windowListeners.get(IPC.AgentSupervisionChanged)?.({
      agentId: 'agent-1',
      attentionReason: 'waiting-input',
      isShell: false,
      lastOutputAt: 1_000,
      preview: 'Proceed? [Y/n]',
      state: 'awaiting-input',
      taskId: 'task-1',
      updatedAt: 1_000,
    });

    cleanup();
    deferredLoadState.resolve(undefined);
    await deferredLoadState.promise;

    expect(handleGitStatusSyncEventMock).not.toHaveBeenCalled();
    expect(applyAgentSupervisionEventMock).not.toHaveBeenCalled();
    expect(applyRemoteStatusMock).not.toHaveBeenCalled();
  });

  it('disposes a late close-requested cleanup when startup finishes after teardown', async () => {
    const deferredCloseHandler = createDeferred<() => void>();
    const unlistenCloseRequested = vi.fn();
    registerCloseRequestedHandlerMock.mockReturnValueOnce(deferredCloseHandler.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(registerCloseRequestedHandlerMock).toHaveBeenCalledTimes(1);
    });

    cleanup();
    deferredCloseHandler.resolve(unlistenCloseRequested);
    await deferredCloseHandler.promise;
    await flushResolvedPromises();

    expect(unlistenCloseRequested).toHaveBeenCalledTimes(1);
  });

  it('saves electron app state when the pagehide lifecycle event fires', async () => {
    startDesktopAppSession({
      electronRuntime: true,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    const pagehideListener = windowEventListeners.get('pagehide');
    expect(pagehideListener).toBeDefined();

    pagehideListener?.(new Event('pagehide'));

    await vi.waitFor(() => {
      expect(saveStateMock).toHaveBeenCalledTimes(1);
    });
    expect(saveBrowserWorkspaceStateOnPagehideMock).not.toHaveBeenCalled();
    expect(saveClientSessionStateMock).not.toHaveBeenCalled();
  });

  it('saves browser workspace and client session state when the pagehide lifecycle event fires', async () => {
    startDesktopAppSession({
      electronRuntime: false,
      mainElement: createMainElementStub(),
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    const pagehideListener = windowEventListeners.get('pagehide');
    expect(pagehideListener).toBeDefined();

    pagehideListener?.(new Event('pagehide'));

    await vi.waitFor(() => {
      expect(saveBrowserWorkspaceStateOnPagehideMock).toHaveBeenCalledTimes(1);
      expect(saveClientSessionStateMock).toHaveBeenCalledTimes(1);
    });
    expect(saveStateMock).not.toHaveBeenCalled();
  });
});
