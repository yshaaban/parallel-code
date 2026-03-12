import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const {
  adjustGlobalScaleMock,
  captureWindowStateMock,
  cleanupWindowEventListenersMock,
  clearPathInputNotifierMock,
  createBrowserStateSyncMock,
  getPendingPathInputMock,
  handleGitStatusChangedMock,
  listenMock,
  loadAgentsMock,
  loadStateMock,
  markAutosaveCleanMock,
  refreshRemoteStatusMock,
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
  windowListeners,
} = vi.hoisted(() => ({
  adjustGlobalScaleMock: vi.fn(),
  captureWindowStateMock: vi.fn().mockResolvedValue(undefined),
  cleanupWindowEventListenersMock: vi.fn(),
  clearPathInputNotifierMock: vi.fn(),
  createBrowserStateSyncMock: vi.fn(() => ({
    cleanupBrowserStateSyncTimer: vi.fn(),
    scheduleBrowserStateSync: vi.fn(),
    syncBrowserStateFromServer: vi.fn().mockResolvedValue(undefined),
  })),
  getPendingPathInputMock: vi.fn(),
  handleGitStatusChangedMock: vi.fn(),
  listenMock: vi.fn(),
  loadAgentsMock: vi.fn().mockResolvedValue(undefined),
  loadStateMock: vi.fn().mockResolvedValue(undefined),
  markAutosaveCleanMock: vi.fn(),
  refreshRemoteStatusMock: vi.fn().mockResolvedValue(undefined),
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
  windowListeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('../lib/dialog', () => ({
  clearPathInputNotifier: clearPathInputNotifierMock,
  getPendingPathInput: getPendingPathInputMock,
  registerPathInputNotifier: registerPathInputNotifierMock,
}));

vi.mock('../lib/ipc', () => ({
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
  applyRemoteStatus: vi.fn(),
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
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
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
});
