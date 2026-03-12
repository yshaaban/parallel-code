import type { Setter } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import type { RemoteAccessStatus } from '../../electron/ipc/remote-access-workflows';
import { applyRemoteStatus } from './remote-access';
import {
  clearPathInputNotifier,
  getPendingPathInput,
  registerPathInputNotifier,
} from '../lib/dialog';
import type { GitStatusSyncEvent } from './git-status-sync';
import { listen } from '../lib/ipc';
import { isGitHubUrl } from '../lib/github-url';
import { isMac } from '../lib/platform';
import { createCtrlWheelZoomHandler } from '../lib/wheelZoom';
import {
  getConnectionBannerText,
  registerBrowserAppRuntime,
  type ConnectionBanner,
} from '../runtime/browser-session';
import { registerAppShortcuts } from '../runtime/app-shortcuts';
import {
  createBrowserStateSync,
  handleAgentLifecycleMessage,
  handleGitStatusChanged,
  reconcileRunningAgents,
  syncAgentStatusesFromServer,
} from '../runtime/server-sync';
import { createWindowSessionRuntime } from '../runtime/window-session';
import { setupAutosave, markAutosaveClean } from '../store/autosave';
import {
  loadAgents,
  loadState,
  refreshRemoteStatus,
  saveState,
  adjustGlobalScale,
  setNewTaskDropUrl,
  setPlanContent,
  showNotification,
  store,
  toggleNewTaskDialog,
  updateRemotePeerStatus,
  validateProjectPaths,
} from '../store/store';

interface StartDesktopAppSessionOptions {
  electronRuntime: boolean;
  mainElement: HTMLDivElement;
  setConnectionBanner: Setter<ConnectionBanner | null>;
  setPathInputDialog: (next: { open: boolean; directory: boolean }) => void;
  setWindowFocused: (focused: boolean) => void;
  setWindowMaximized: (maximized: boolean) => void;
}

interface DesktopSessionResources {
  cleanupBrowserRuntime: () => void;
  cleanupShortcuts: () => void;
  offGitStatus: () => void;
  offPlanContent: () => void;
  offRemoteStatus: () => void;
  unlistenCloseRequested: (() => void) | null;
}

type CleanupFn = () => void;

function createDesktopSessionResources(): DesktopSessionResources {
  return {
    cleanupBrowserRuntime: () => {},
    cleanupShortcuts: () => {},
    offGitStatus: () => {},
    offPlanContent: () => {},
    offRemoteStatus: () => {},
    unlistenCloseRequested: null,
  };
}

function disposeCleanup(cleanup: CleanupFn): void {
  cleanup();
}

function disposeOptionalCleanup(cleanup: CleanupFn | null): void {
  cleanup?.();
}

function replaceResource<T>(
  disposed: boolean,
  currentResource: T,
  nextResource: T,
  dispose: (resource: T) => void,
): T {
  if (disposed) {
    dispose(nextResource);
    return currentResource;
  }

  return nextResource;
}

function disposeDesktopSessionResources(resources: DesktopSessionResources): void {
  disposeOptionalCleanup(resources.unlistenCloseRequested);
  resources.unlistenCloseRequested = null;
  disposeCleanup(resources.cleanupShortcuts);
  resources.cleanupShortcuts = () => {};
  disposeCleanup(resources.offGitStatus);
  resources.offGitStatus = () => {};
  disposeCleanup(resources.offPlanContent);
  resources.offPlanContent = () => {};
  disposeCleanup(resources.offRemoteStatus);
  resources.offRemoteStatus = () => {};
  disposeCleanup(resources.cleanupBrowserRuntime);
  resources.cleanupBrowserRuntime = () => {};
}

function createRemoteStatusListener(electronRuntime: boolean): CleanupFn {
  if (!electronRuntime) {
    return () => {};
  }

  return listen(IPC.RemoteStatusChanged, (payload: unknown) => {
    applyRemoteStatus(payload as RemoteAccessStatus);
  });
}

function createGitStatusListener(
  electronRuntime: boolean,
  onGitStatusChanged: (message: GitStatusSyncEvent) => void,
): CleanupFn {
  if (!electronRuntime) {
    return () => {};
  }

  return listen(IPC.GitStatusChanged, (payload: unknown) => {
    onGitStatusChanged(payload as GitStatusSyncEvent);
  });
}

function createGitStatusStartupGate(): {
  flush(): void;
  handle(message: GitStatusSyncEvent): void;
} {
  let ready = false;
  const pendingMessages: GitStatusSyncEvent[] = [];

  function apply(message: GitStatusSyncEvent): void {
    handleGitStatusChanged(message);
  }

  return {
    handle(message: GitStatusSyncEvent): void {
      if (!ready) {
        pendingMessages.push(message);
        return;
      }

      apply(message);
    },
    flush(): void {
      if (ready) {
        return;
      }

      ready = true;
      for (const message of pendingMessages.splice(0)) {
        apply(message);
      }
    },
  };
}

function createBrowserRuntimeCleanup(
  options: StartDesktopAppSessionOptions,
  browserStateSync: {
    scheduleBrowserStateSync: (delayMs?: number, notify?: boolean) => void;
    syncBrowserStateFromServer: () => Promise<void>;
  },
): CleanupFn {
  if (options.electronRuntime) {
    return () => {};
  }

  return registerBrowserAppRuntime({
    clearRestoringConnectionBanner: () => {
      clearRestoringConnectionBanner(options.setConnectionBanner);
    },
    onAgentLifecycle: handleAgentLifecycleMessage,
    onGitStatusChanged: handleGitStatusChanged,
    onRemoteStatus: updateRemotePeerStatus,
    reconcileRunningAgents,
    refreshRemoteStatus,
    scheduleBrowserStateSync: browserStateSync.scheduleBrowserStateSync,
    setConnectionBanner: options.setConnectionBanner,
    showNotification,
    syncAgentStatusesFromServer,
    syncBrowserStateFromServer: browserStateSync.syncBrowserStateFromServer,
  });
}

function clearRestoringConnectionBanner(
  setConnectionBanner: Setter<ConnectionBanner | null>,
): void {
  setConnectionBanner((current) => (current?.state === 'restoring' ? null : current));
}

function openNewTaskDialogFromGitHubUrl(text: string): void {
  setNewTaskDropUrl(text);
  toggleNewTaskDialog(true);
}

export function startDesktopAppSession(options: StartDesktopAppSessionOptions): () => void {
  const { cleanupBrowserStateSyncTimer, scheduleBrowserStateSync, syncBrowserStateFromServer } =
    createBrowserStateSync(options.electronRuntime);

  const {
    captureWindowState,
    cleanupWindowEventListeners,
    registerCloseRequestedHandler,
    registerWindowEventListeners,
    restoreWindowState,
    setupWindowChrome,
    syncWindowFocused,
    syncWindowMaximized,
  } = createWindowSessionRuntime({
    electronRuntime: options.electronRuntime,
    isMac,
    setWindowFocused: options.setWindowFocused,
    setWindowMaximized: options.setWindowMaximized,
  });

  let disposed = false;
  const startupGitStatusGate = createGitStatusStartupGate();
  const resources = createDesktopSessionResources();

  if (!options.electronRuntime) {
    registerPathInputNotifier(() => {
      const pending = getPendingPathInput();
      if (!pending) return;
      options.setPathInputDialog({
        open: true,
        directory: pending.options.directory ?? false,
      });
    });
  }

  const handlePaste = (event: ClipboardEvent) => {
    if (store.showNewTaskDialog || store.showHelpDialog || store.showSettingsDialog) return;

    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      (activeElement instanceof HTMLElement && activeElement.isContentEditable) ||
      activeElement?.closest?.('.xterm')
    ) {
      return;
    }

    const text = event.clipboardData?.getData('text/plain')?.trim();
    if (!text) return;
    if (!isGitHubUrl(text)) return;

    event.preventDefault();
    openNewTaskDialogFromGitHubUrl(text);
  };
  document.addEventListener('paste', handlePaste);

  const handleWheel = createCtrlWheelZoomHandler((delta) => {
    adjustGlobalScale(delta);
  });
  options.mainElement.addEventListener('wheel', handleWheel, { passive: false });

  const handlePageHide = () => {
    void saveState();
  };
  window.addEventListener('pagehide', handlePageHide);

  void (async () => {
    await setupWindowChrome();
    if (disposed) return;

    void syncWindowFocused();
    void syncWindowMaximized();
    registerWindowEventListeners();

    resources.offRemoteStatus = replaceResource(
      disposed,
      resources.offRemoteStatus,
      createRemoteStatusListener(options.electronRuntime),
      disposeCleanup,
    );

    resources.offGitStatus = replaceResource(
      disposed,
      resources.offGitStatus,
      createGitStatusListener(options.electronRuntime, startupGitStatusGate.handle),
      disposeCleanup,
    );

    await loadAgents();
    if (disposed) return;

    await loadState();
    if (disposed) return;
    startupGitStatusGate.flush();

    markAutosaveClean();
    await validateProjectPaths();
    await refreshRemoteStatus().catch(() => {});
    if (disposed) return;

    await restoreWindowState();
    if (disposed) return;

    await captureWindowState();
    if (disposed) return;

    setupAutosave();

    resources.offPlanContent = replaceResource(
      disposed,
      resources.offPlanContent,
      listen(IPC.PlanContent, (data: unknown) => {
        const message = data as { taskId: string; content: string | null; fileName: string | null };
        if (message.taskId && store.tasks[message.taskId]) {
          setPlanContent(message.taskId, message.content, message.fileName);
        }
      }),
      disposeCleanup,
    );

    resources.cleanupBrowserRuntime = replaceResource(
      disposed,
      resources.cleanupBrowserRuntime,
      createBrowserRuntimeCleanup(options, {
        scheduleBrowserStateSync,
        syncBrowserStateFromServer: () => syncBrowserStateFromServer(),
      }),
      disposeCleanup,
    );

    await reconcileRunningAgents();
    if (disposed) return;

    resources.cleanupShortcuts = replaceResource(
      disposed,
      resources.cleanupShortcuts,
      registerAppShortcuts(),
      disposeCleanup,
    );
    const unlisten = await registerCloseRequestedHandler();
    resources.unlistenCloseRequested = replaceResource<CleanupFn | null>(
      disposed,
      resources.unlistenCloseRequested,
      unlisten,
      disposeOptionalCleanup,
    );
  })();

  return () => {
    disposed = true;
    cleanupBrowserStateSyncTimer();
    if (!options.electronRuntime) {
      clearPathInputNotifier();
    }
    document.removeEventListener('paste', handlePaste);
    options.mainElement.removeEventListener('wheel', handleWheel);
    window.removeEventListener('pagehide', handlePageHide);
    disposeDesktopSessionResources(resources);
    cleanupWindowEventListeners();
  };
}

export { getConnectionBannerText };
