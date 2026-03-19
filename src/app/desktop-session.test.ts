import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { getAppStartupSummary, resetAppStartupStatusForTests } from './app-startup-status';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from './runtime-diagnostics';
import { resetTerminalStartupStateForTests } from '../store/terminal-startup';

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
  loadAgentsMock,
  loadClientSessionStateMock,
  loadStateMock,
  loadTaskCommandControllersMock,
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
  saveBrowserWorkspaceStateMock,
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
  loadAgentsMock: vi.fn().mockResolvedValue(undefined),
  loadClientSessionStateMock: vi.fn(),
  loadStateMock: vi.fn().mockResolvedValue(undefined),
  loadTaskCommandControllersMock: vi.fn().mockResolvedValue(undefined),
  loadWorkspaceStateMock: vi.fn().mockResolvedValue(undefined),
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
  saveBrowserWorkspaceStateMock: vi.fn().mockResolvedValue(undefined),
  saveStateMock: vi.fn().mockResolvedValue(undefined),
  saveClientSessionStateMock: vi.fn(),
  setPlanContentMock: vi.fn(),
  setupAutosaveMock: vi.fn(),
  setupWindowChromeMock: vi.fn().mockResolvedValue(undefined),
  startTaskNotificationRuntimeMock: vi.fn(() => vi.fn()),
  storeState: {
    showHelpDialog: false,
    showNewTaskDialog: false,
    showSettingsDialog: false,
    taskOrder: [] as string[],
    collapsedTaskOrder: [] as string[],
    tasks: {} as Record<
      string,
      { planFileName?: string; planRelativePath?: string; worktreePath?: string }
    >,
  },
  syncWindowFocusedMock: vi.fn(),
  syncWindowMaximizedMock: vi.fn(),
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

vi.mock('../store/navigation', () => ({
  toggleNewTaskDialog: vi.fn(),
}));

vi.mock('../store/notification', () => ({
  showNotification: vi.fn(),
}));

vi.mock('../store/peer-presence', () => ({
  replacePeerSessions: replacePeerSessionsMock,
}));

vi.mock('../store/persistence-load', () => ({
  loadState: loadStateMock,
  loadWorkspaceState: loadWorkspaceStateMock,
}));

vi.mock('../store/persistence-save', () => ({
  saveBrowserWorkspaceState: saveBrowserWorkspaceStateMock,
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
  loadTaskCommandControllers: loadTaskCommandControllersMock,
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
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushResolvedPromises(iterations = 12): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

describe('desktop session startup sequencing', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    resetAppStartupStatusForTests();
    resetTerminalStartupStateForTests();
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
    loadClientSessionStateMock.mockReset();
    loadTaskCommandControllersMock.mockReset();
    loadTaskCommandControllersMock.mockResolvedValue(undefined);
    loadStateMock.mockReset();
    loadStateMock.mockResolvedValue(undefined);
    loadWorkspaceStateMock.mockReset();
    loadWorkspaceStateMock.mockResolvedValue(undefined);
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
    saveBrowserWorkspaceStateMock.mockReset();
    saveBrowserWorkspaceStateMock.mockResolvedValue(undefined);
    saveClientSessionStateMock.mockReset();
    setupAutosaveMock.mockReset();
    setupWindowChromeMock.mockReset();
    setupWindowChromeMock.mockResolvedValue(undefined);
    setPlanContentMock.mockReset();
    syncWindowFocusedMock.mockReset();
    syncWindowMaximizedMock.mockReset();
    upsertIncomingTaskTakeoverRequestMock.mockReset();
    validateProjectPathsMock.mockReset();
    validateProjectPathsMock.mockResolvedValue(undefined);
    storeState.taskOrder = [];
    storeState.collapsedTaskOrder = [];
    storeState.tasks = {};

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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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

  it('refreshes browser notification capability on focus and visible tab restores', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    expect(windowListeners.has(IPC.TaskPortsChanged)).toBe(true);

    const event = {
      taskId: 'task-1',
      observed: [],
      exposed: [
        {
          host: null,
          label: 'Frontend',
          port: 5173,
          protocol: 'http',
          source: 'manual',
          updatedAt: 1_000,
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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

  it('buffers Electron task-convergence events until state has loaded', async () => {
    const deferredLoadState = createDeferred<undefined>();
    loadStateMock.mockReturnValueOnce(deferredLoadState.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(replaceAgentSupervisionSnapshotsMock).toHaveBeenCalledWith(
        initialSnapshots[0].payload,
      );
    });
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetServerStateBootstrap);

    cleanup();
  });

  it('does not fetch Electron bootstrap snapshots in browser mode', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();

    expect(loadWorkspaceStateMock).toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.GetServerStateBootstrap);
    expect(replaceAgentSupervisionSnapshotsMock).not.toHaveBeenCalled();

    cleanup();
  });

  it('loads browser-local client session state after the shared workspace state', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(loadWorkspaceStateMock).toHaveBeenCalled();
    });

    expect(loadClientSessionStateMock).toHaveBeenCalledTimes(1);
    expect(reconcileClientSessionStateMock).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('hydrates early browser state-bootstrap task-port snapshots before load completes', async () => {
    const deferredLoadState = createDeferred<undefined>();
    loadWorkspaceStateMock.mockReturnValueOnce(deferredLoadState.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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

    deferredLoadState.resolve(undefined);
    await deferredLoadState.promise;
    await flushResolvedPromises();

    expect(replaceTaskPortSnapshotsMock).toHaveBeenCalledWith([
      {
        taskId: 'task-1',
        observed: [],
        exposed: [],
        updatedAt: 1_000,
      },
    ]);
    expect(getRendererRuntimeDiagnosticsSnapshot().bootstrap).toMatchObject({
      bufferedEvents: expect.objectContaining({
        'task-ports': 0,
      }),
      bufferedSnapshots: expect.objectContaining({
        'task-ports': 1,
      }),
      completions: 1,
      lastDurationMs: expect.any(Number),
    });

    cleanup();
  });

  it('buffers early browser task-review events until state has loaded', async () => {
    const deferredLoadState = createDeferred<undefined>();
    loadWorkspaceStateMock.mockReturnValueOnce(deferredLoadState.promise);

    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    expect(windowListeners.has(IPC.TaskReviewChanged)).toBe(true);

    const event = {
      taskId: 'task-1',
      projectId: 'project-1',
      worktreePath: '/tmp/task-1',
      branchName: 'feature/task-1',
      changedFileCount: 2,
      hiddenHydraFileCount: 0,
      source: 'git-status',
      updatedAt: 1_000,
      revision: 'rev-1',
    };

    windowListeners.get(IPC.TaskReviewChanged)?.(event);
    expect(applyTaskReviewEventMock).not.toHaveBeenCalled();

    deferredLoadState.resolve(undefined);
    await deferredLoadState.promise;

    await vi.waitFor(() => {
      expect(applyTaskReviewEventMock).toHaveBeenCalledWith(event);
    });
    expect(getRendererRuntimeDiagnosticsSnapshot().bootstrap).toMatchObject({
      bufferedEvents: expect.objectContaining({
        'task-review': 1,
      }),
      bufferedSnapshots: expect.objectContaining({
        'task-review': 0,
      }),
      completions: 1,
      lastDurationMs: expect.any(Number),
    });

    cleanup();
  });

  it('keeps browser review, convergence, and supervision listeners active after startup completes', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(registerBrowserAppRuntimeMock).toHaveBeenCalledTimes(1);
    });

    const reviewEvent = {
      taskId: 'task-after-load',
      projectId: 'project-1',
      worktreePath: '/tmp/task-after-load',
      branchName: 'feature/task-after-load',
      changedFileCount: 1,
      hiddenHydraFileCount: 0,
      source: 'git-status',
      updatedAt: 2_000,
      revision: 'rev-after-load',
    };
    const convergenceEvent = {
      taskId: 'task-after-load',
      projectId: 'project-1',
      branchName: 'feature/task-after-load',
      worktreePath: '/tmp/task-after-load',
      readiness: 'review-ready',
      summary: 'Ready to review',
      overlapTaskIds: [],
      updatedAt: 2_100,
      revision: 'conv-after-load',
    };
    const supervisionEvent = {
      agentId: 'agent-1',
      taskId: 'task-after-load',
      isShell: false,
      state: 'awaiting-input',
      attentionReason: 'waiting-input',
      preview: 'Proceed? [Y/n]',
      updatedAt: 2_200,
      lastOutputAt: 2_190,
    };

    windowListeners.get(IPC.TaskReviewChanged)?.(reviewEvent);
    windowListeners.get(IPC.TaskConvergenceChanged)?.(convergenceEvent);
    windowListeners.get(IPC.AgentSupervisionChanged)?.(supervisionEvent);

    expect(applyTaskReviewEventMock).toHaveBeenCalledWith(reviewEvent);
    expect(applyTaskConvergenceEventMock).toHaveBeenCalledWith(convergenceEvent);
    expect(applyAgentSupervisionEventMock).toHaveBeenCalledWith(supervisionEvent);

    cleanup();
  });

  it('attaches the browser runtime before loading browser workspace snapshots', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: false,
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await flushResolvedPromises();
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(1);

    expect(registerBrowserAppRuntimeMock).toHaveBeenCalledTimes(1);
    expect(registerBrowserAppRuntimeMock.mock.invocationCallOrder[0]).toBeLessThan(
      loadWorkspaceStateMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(loadTaskCommandControllersMock).toHaveBeenCalledWith({ ifUnchangedSince: 0 });

    cleanup();
  });

  it('keeps electron git and remote listeners active after startup completes', async () => {
    const cleanup = startDesktopAppSession({
      electronRuntime: true,
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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
      token: null,
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC.GetServerStateBootstrap);
      expect(replaceTaskConvergenceSnapshotsMock).toHaveBeenCalledWith(snapshots[0].payload);
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
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
    expect(saveBrowserWorkspaceStateMock).not.toHaveBeenCalled();
    expect(saveClientSessionStateMock).not.toHaveBeenCalled();
  });

  it('saves browser workspace and client session state when the pagehide lifecycle event fires', async () => {
    startDesktopAppSession({
      electronRuntime: false,
      mainElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLDivElement,
      setConnectionBanner: vi.fn(),
      setPathInputDialog: vi.fn(),
      setWindowFocused: vi.fn(),
      setWindowMaximized: vi.fn(),
    });

    const pagehideListener = windowEventListeners.get('pagehide');
    expect(pagehideListener).toBeDefined();

    pagehideListener?.(new Event('pagehide'));

    await vi.waitFor(() => {
      expect(saveBrowserWorkspaceStateMock).toHaveBeenCalledTimes(1);
      expect(saveClientSessionStateMock).toHaveBeenCalledTimes(1);
    });
    expect(saveStateMock).not.toHaveBeenCalled();
  });
});
