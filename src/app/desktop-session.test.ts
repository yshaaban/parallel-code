import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from './runtime-diagnostics';

const {
  adjustGlobalScaleMock,
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
  getPendingPathInputMock,
  invokeMock,
  handleGitStatusChangedMock,
  handleGitStatusSyncEventMock,
  listenMock,
  loadAgentsMock,
  loadStateMock,
  markAutosaveCleanMock,
  fetchTaskConvergenceMock,
  refreshRemoteStatusMock,
  replaceTaskConvergenceSnapshotsMock,
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
  saveStateMock,
  setPlanContentMock,
  setupAutosaveMock,
  setupWindowChromeMock,
  storeState,
  syncWindowFocusedMock,
  syncWindowMaximizedMock,
  validateProjectPathsMock,
  windowEventListeners,
  windowListeners,
} = vi.hoisted(() => ({
  adjustGlobalScaleMock: vi.fn(),
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
  getPendingPathInputMock: vi.fn(),
  invokeMock: vi.fn(),
  handleGitStatusChangedMock: vi.fn(),
  handleGitStatusSyncEventMock: vi.fn(),
  listenMock: vi.fn(),
  loadAgentsMock: vi.fn().mockResolvedValue(undefined),
  loadStateMock: vi.fn().mockResolvedValue(undefined),
  markAutosaveCleanMock: vi.fn(),
  fetchTaskConvergenceMock: vi.fn().mockResolvedValue([]),
  refreshRemoteStatusMock: vi.fn().mockResolvedValue(undefined),
  replaceTaskConvergenceSnapshotsMock: vi.fn(),
  replaceTaskReviewSnapshotsMock: vi.fn(),
  replaceAgentSupervisionSnapshotsMock: vi.fn(),
  replaceGitStatusSnapshotsMock: vi.fn(),
  replaceTaskPortSnapshotsMock: vi.fn(),
  registerAppShortcutsMock: vi.fn(() => vi.fn()),
  registerBrowserAppRuntimeMock: vi.fn(() => vi.fn()),
  registerCloseRequestedHandlerMock: vi.fn().mockResolvedValue(vi.fn()),
  registerPathInputNotifierMock: vi.fn(),
  registerWindowEventListenersMock: vi.fn(),
  restoreWindowStateMock: vi.fn().mockResolvedValue(undefined),
  saveStateMock: vi.fn().mockResolvedValue(undefined),
  setPlanContentMock: vi.fn(),
  setupAutosaveMock: vi.fn(),
  setupWindowChromeMock: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../store/autosave', () => ({
  markAutosaveClean: markAutosaveCleanMock,
  setupAutosave: setupAutosaveMock,
}));

vi.mock('../store/store', () => ({
  adjustGlobalScale: adjustGlobalScaleMock,
  loadAgents: loadAgentsMock,
  loadState: loadStateMock,
  refreshRemoteStatus: refreshRemoteStatusMock,
  saveState: saveStateMock,
  setPlanContent: setPlanContentMock,
  setNewTaskDropUrl: vi.fn(),
  showNotification: vi.fn(),
  store: storeState,
  toggleNewTaskDialog: vi.fn(),
  updateRemotePeerStatus: vi.fn(),
  validateProjectPaths: validateProjectPathsMock,
}));

vi.mock('./remote-access', () => ({
  applyRemoteStatus: applyRemoteStatusMock,
  fetchRemoteStatusSnapshot: fetchRemoteStatusSnapshotMock,
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

vi.mock('./git-status-sync', () => ({
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

describe('desktop session startup sequencing', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
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
    loadStateMock.mockReset();
    loadStateMock.mockResolvedValue(undefined);
    markAutosaveCleanMock.mockReset();
    refreshRemoteStatusMock.mockReset();
    refreshRemoteStatusMock.mockResolvedValue(undefined);
    replaceTaskConvergenceSnapshotsMock.mockReset();
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
    setupAutosaveMock.mockReset();
    setupWindowChromeMock.mockReset();
    setupWindowChromeMock.mockResolvedValue(undefined);
    setPlanContentMock.mockReset();
    syncWindowFocusedMock.mockReset();
    syncWindowMaximizedMock.mockReset();
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

    await vi.waitFor(() => {
      expect(windowListeners.has(IPC.GitStatusChanged)).toBe(true);
    });

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
    await vi.waitFor(() => {
      expect(getRendererRuntimeDiagnosticsSnapshot().bootstrap).toMatchObject({
        completions: 1,
      });
    });

    await vi.waitFor(() => {
      expect(handleGitStatusSyncEventMock).toHaveBeenCalledWith(message);
    });

    cleanup();
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

    await vi.waitFor(() => {
      expect(windowListeners.has(IPC.TaskPortsChanged)).toBe(true);
    });

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

    await vi.waitFor(() => {
      expect(applyTaskPortsEventMock).toHaveBeenCalledWith(event);
    });

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

    await vi.waitFor(() => {
      expect(setPlanContentMock).toHaveBeenCalledWith(
        'task-1',
        '# Restored plan',
        'current-plan.md',
        'docs/plans/current-plan.md',
      );
    });

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

    await vi.waitFor(() => {
      expect(applyTaskConvergenceEventMock).toHaveBeenCalledWith(event);
    });

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

    await vi.waitFor(() => {
      expect(windowListeners.has(IPC.RemoteStatusChanged)).toBe(true);
    });

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
    await vi.waitFor(() => {
      expect(getRendererRuntimeDiagnosticsSnapshot().bootstrap).toMatchObject({
        completions: 1,
      });
    });

    await vi.waitFor(() => {
      expect(applyRemoteStatusMock).toHaveBeenCalledWith(message);
    });

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

    await vi.waitFor(() => {
      expect(applyAgentSupervisionEventMock).toHaveBeenCalledWith(message);
    });

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

    await vi.waitFor(() => {
      expect(loadStateMock).toHaveBeenCalled();
    });
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.GetServerStateBootstrap);
    expect(replaceAgentSupervisionSnapshotsMock).not.toHaveBeenCalled();

    cleanup();
  });

  it('hydrates early browser state-bootstrap task-port snapshots before load completes', async () => {
    const deferredLoadState = createDeferred<undefined>();
    loadStateMock.mockReturnValueOnce(deferredLoadState.promise);

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
      expect(windowListeners.has('state-bootstrap')).toBe(true);
    });

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
    await Promise.resolve();
    await Promise.resolve();

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
    loadStateMock.mockReturnValueOnce(deferredLoadState.promise);

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

    await vi.waitFor(() => {
      expect(validateProjectPathsMock).toHaveBeenCalled();
    });

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

    await vi.waitFor(() => {
      expect(applyRemoteStatusMock).toHaveBeenCalledWith(snapshot.payload);
    });
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

  it('saves state when the pagehide lifecycle event fires', async () => {
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
  });
});
