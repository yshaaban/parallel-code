import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const {
  adjustGlobalScaleMock,
  applyAgentSupervisionEventMock,
  applyRemoteStatusMock,
  applyTaskPortsEventMock,
  captureWindowStateMock,
  cleanupWindowEventListenersMock,
  clearPathInputNotifierMock,
  createBrowserStateSyncMock,
  fetchTaskPortsMock,
  getPendingPathInputMock,
  invokeMock,
  handleGitStatusChangedMock,
  listenMock,
  loadAgentsMock,
  loadStateMock,
  markAutosaveCleanMock,
  refreshRemoteStatusMock,
  replaceAgentSupervisionSnapshotsMock,
  replaceTaskPortSnapshotsMock,
  registerAppShortcutsMock,
  registerBrowserAppRuntimeMock,
  registerCloseRequestedHandlerMock,
  registerPathInputNotifierMock,
  registerWindowEventListenersMock,
  restoreWindowStateMock,
  saveStateMock,
  setupAutosaveMock,
  setupWindowChromeMock,
  syncWindowFocusedMock,
  syncWindowMaximizedMock,
  validateProjectPathsMock,
  windowEventListeners,
  windowListeners,
} = vi.hoisted(() => ({
  adjustGlobalScaleMock: vi.fn(),
  applyAgentSupervisionEventMock: vi.fn(),
  applyRemoteStatusMock: vi.fn(),
  applyTaskPortsEventMock: vi.fn(),
  captureWindowStateMock: vi.fn().mockResolvedValue(undefined),
  cleanupWindowEventListenersMock: vi.fn(),
  clearPathInputNotifierMock: vi.fn(),
  createBrowserStateSyncMock: vi.fn(() => ({
    cleanupBrowserStateSyncTimer: vi.fn(),
    scheduleBrowserStateSync: vi.fn(),
    syncBrowserStateFromServer: vi.fn().mockResolvedValue(undefined),
  })),
  fetchTaskPortsMock: vi.fn().mockResolvedValue([]),
  getPendingPathInputMock: vi.fn(),
  invokeMock: vi.fn(),
  handleGitStatusChangedMock: vi.fn(),
  listenMock: vi.fn(),
  loadAgentsMock: vi.fn().mockResolvedValue(undefined),
  loadStateMock: vi.fn().mockResolvedValue(undefined),
  markAutosaveCleanMock: vi.fn(),
  refreshRemoteStatusMock: vi.fn().mockResolvedValue(undefined),
  replaceAgentSupervisionSnapshotsMock: vi.fn(),
  replaceTaskPortSnapshotsMock: vi.fn(),
  registerAppShortcutsMock: vi.fn(() => vi.fn()),
  registerBrowserAppRuntimeMock: vi.fn(() => vi.fn()),
  registerCloseRequestedHandlerMock: vi.fn().mockResolvedValue(vi.fn()),
  registerPathInputNotifierMock: vi.fn(),
  registerWindowEventListenersMock: vi.fn(),
  restoreWindowStateMock: vi.fn().mockResolvedValue(undefined),
  saveStateMock: vi.fn().mockResolvedValue(undefined),
  setupAutosaveMock: vi.fn(),
  setupWindowChromeMock: vi.fn().mockResolvedValue(undefined),
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
  setNewTaskDropUrl: vi.fn(),
  setPlanContent: vi.fn(),
  showNotification: vi.fn(),
  store: {
    showHelpDialog: false,
    showNewTaskDialog: false,
    showSettingsDialog: false,
    tasks: {},
  },
  toggleNewTaskDialog: vi.fn(),
  updateRemotePeerStatus: vi.fn(),
  validateProjectPaths: validateProjectPathsMock,
}));

vi.mock('./remote-access', () => ({
  applyRemoteStatus: applyRemoteStatusMock,
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
    vi.clearAllMocks();
    windowListeners.clear();
    windowEventListeners.clear();
    invokeMock.mockResolvedValue([]);
    fetchTaskPortsMock.mockResolvedValue([]);

    listenMock.mockImplementation((channel: string, listener: (payload: unknown) => void) => {
      windowListeners.set(channel, listener);
      return () => {
        windowListeners.delete(channel);
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
        removeEventListener: vi.fn((event: string) => {
          windowEventListeners.delete(event);
        }),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
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
    expect(handleGitStatusChangedMock).not.toHaveBeenCalled();

    deferredLoadState.resolve(undefined);
    await deferredLoadState.promise;

    await vi.waitFor(() => {
      expect(handleGitStatusChangedMock).toHaveBeenCalledWith(message);
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
        agentId: 'agent-1',
        attentionReason: 'ready-for-next-step',
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'hydra>',
        state: 'idle-at-prompt',
        taskId: 'task-1',
        updatedAt: 1_000,
      },
    ];
    invokeMock.mockResolvedValueOnce(initialSnapshots);

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
      expect(invokeMock).toHaveBeenCalledWith(IPC.GetAgentSupervision);
    });
    expect(replaceAgentSupervisionSnapshotsMock).toHaveBeenCalledWith(initialSnapshots);

    cleanup();
  });

  it('hydrates browser agent supervision snapshots after state has loaded', async () => {
    const initialSnapshots = [
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
    ];
    invokeMock.mockResolvedValueOnce(initialSnapshots);

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
      expect(invokeMock).toHaveBeenCalledWith(IPC.GetAgentSupervision);
    });
    expect(replaceAgentSupervisionSnapshotsMock).toHaveBeenCalledWith(initialSnapshots);

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

    expect(handleGitStatusChangedMock).not.toHaveBeenCalled();
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
