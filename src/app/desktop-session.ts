import type { Setter } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import {
  clearPathInputNotifier,
  getPendingPathInput,
  registerPathInputNotifier,
} from '../lib/dialog';
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
  startTaskStatusPolling,
  stopTaskStatusPolling,
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

function clearRestoringConnectionBanner(
  setConnectionBanner: Setter<ConnectionBanner | null>,
): void {
  setConnectionBanner((current) => (current?.state === 'restoring' ? null : current));
}

function handlePastedGitHubUrl(text: string): void {
  if (!isGitHubUrl(text)) return;
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
  let offPlanContent = () => {};
  let cleanupBrowserRuntime = () => {};
  let cleanupShortcuts = () => {};
  let unlistenCloseRequested: (() => void) | null = null;

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
    handlePastedGitHubUrl(text);
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

    await loadAgents();
    if (disposed) return;

    await loadState();
    if (disposed) return;

    markAutosaveClean();
    await validateProjectPaths();
    if (!options.electronRuntime) {
      await refreshRemoteStatus().catch(() => {});
    }
    if (disposed) return;

    await restoreWindowState();
    if (disposed) return;

    await captureWindowState();
    if (disposed) return;

    setupAutosave();
    startTaskStatusPolling();

    offPlanContent = listen(IPC.PlanContent, (data: unknown) => {
      const message = data as { taskId: string; content: string | null; fileName: string | null };
      if (message.taskId && store.tasks[message.taskId]) {
        setPlanContent(message.taskId, message.content, message.fileName);
      }
    });

    cleanupBrowserRuntime = options.electronRuntime
      ? () => {}
      : registerBrowserAppRuntime({
          clearRestoringConnectionBanner: () => {
            clearRestoringConnectionBanner(options.setConnectionBanner);
          },
          onAgentLifecycle: handleAgentLifecycleMessage,
          onGitStatusChanged: handleGitStatusChanged,
          onRemoteStatus: updateRemotePeerStatus,
          reconcileRunningAgents,
          refreshRemoteStatus,
          scheduleBrowserStateSync,
          setConnectionBanner: options.setConnectionBanner,
          showNotification,
          syncAgentStatusesFromServer,
          syncBrowserStateFromServer: () => syncBrowserStateFromServer(),
        });

    await reconcileRunningAgents();
    if (disposed) return;

    cleanupShortcuts = registerAppShortcuts();
    const unlisten = await registerCloseRequestedHandler();
    if (disposed) {
      unlisten();
      return;
    }
    unlistenCloseRequested = unlisten;
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
    unlistenCloseRequested?.();
    cleanupShortcuts();
    stopTaskStatusPolling();
    offPlanContent();
    cleanupBrowserRuntime();
    cleanupWindowEventListeners();
  };
}

export { getConnectionBannerText };
