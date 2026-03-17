import type { Setter } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { replaceServerStateBootstrap, applyServerStateEvent } from './server-state-bootstrap';
import { createSessionBootstrapController } from './session-bootstrap-controller';
import {
  clearPathInputNotifier,
  getPendingPathInput,
  registerPathInputNotifier,
} from '../lib/dialog';
import type { PlanContentUpdate } from '../domain/renderer-events';
import type { TaskPortsEvent } from '../domain/server-state';
import { invoke } from '../lib/ipc';
import { listenPlanContent } from '../lib/ipc-events';
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
  reconcileRunningAgentIds,
  reconcileRunningAgents,
  syncAgentStatusesFromServer,
} from '../runtime/server-sync';
import { createWindowSessionRuntime } from '../runtime/window-session';
import { setupAutosave, markAutosaveClean } from '../store/autosave';
import {
  applyTaskCommandControllerChanged,
  loadClientSessionState,
  loadAgents,
  loadTaskCommandControllers,
  reconcileClientSessionState,
  loadState,
  loadWorkspaceState,
  replaceTaskCommandControllers,
  saveState,
  saveBrowserWorkspaceState,
  saveClientSessionState,
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
  offPlanContent: () => void;
  unlistenCloseRequested: (() => void) | null;
}

interface BrowserRuntimeCleanupOptions {
  onAgentLifecycle: typeof handleAgentLifecycleMessage;
  onGitStatusChanged: typeof handleGitStatusChanged;
  onRemoteStatus: typeof updateRemotePeerStatus;
  onServerStateBootstrap: typeof replaceServerStateBootstrap;
  onTaskCommandControllerChanged: typeof applyTaskCommandControllerChanged;
  onTaskPortsChanged: (event: TaskPortsEvent) => void;
  replaceTaskCommandControllers: typeof replaceTaskCommandControllers;
  reconcileRunningAgentIds: typeof reconcileRunningAgentIds;
  scheduleBrowserStateSync: (delayMs?: number, notify?: boolean) => void;
  setConnectionBanner: Setter<ConnectionBanner | null>;
  showNotification: typeof showNotification;
  syncAgentStatusesFromServer: typeof syncAgentStatusesFromServer;
  syncBrowserStateFromReconnectSnapshot: BrowserStateSyncApi['syncBrowserStateFromReconnectSnapshot'];
}

interface DesktopSessionRuntime {
  captureWindowState: () => Promise<void>;
  cleanupWindowEventListeners: () => void;
  registerCloseRequestedHandler: () => Promise<() => void>;
  registerWindowEventListeners: () => void;
  restoreWindowState: () => Promise<void>;
  setupWindowChrome: () => Promise<void>;
  syncWindowFocused: () => Promise<void>;
  syncWindowMaximized: () => Promise<void>;
}

type CleanupFn = () => void;
type BrowserStateSyncApi = ReturnType<typeof createBrowserStateSync>;

function createDesktopSessionResources(): DesktopSessionResources {
  return {
    cleanupBrowserRuntime: () => {},
    cleanupShortcuts: () => {},
    offPlanContent: () => {},
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
  disposeCleanup(resources.offPlanContent);
  resources.offPlanContent = () => {};
  disposeCleanup(resources.cleanupBrowserRuntime);
  resources.cleanupBrowserRuntime = () => {};
}

function createBrowserRuntimeCleanup(
  options: StartDesktopAppSessionOptions,
  runtimeOptions: BrowserRuntimeCleanupOptions,
): CleanupFn {
  if (options.electronRuntime) {
    return () => {};
  }

  return registerBrowserAppRuntime({
    clearRestoringConnectionBanner: () => {
      clearRestoringConnectionBanner(options.setConnectionBanner);
    },
    onAgentLifecycle: runtimeOptions.onAgentLifecycle,
    onGitStatusChanged: runtimeOptions.onGitStatusChanged,
    onServerStateBootstrap: runtimeOptions.onServerStateBootstrap,
    onTaskCommandControllerChanged: runtimeOptions.onTaskCommandControllerChanged,
    onTaskPortsChanged: runtimeOptions.onTaskPortsChanged,
    onRemoteStatus: runtimeOptions.onRemoteStatus,
    reconcileRunningAgentIds: runtimeOptions.reconcileRunningAgentIds,
    replaceTaskCommandControllers: runtimeOptions.replaceTaskCommandControllers,
    scheduleBrowserStateSync: runtimeOptions.scheduleBrowserStateSync,
    setConnectionBanner: runtimeOptions.setConnectionBanner,
    showNotification: runtimeOptions.showNotification,
    syncAgentStatusesFromServer: runtimeOptions.syncAgentStatusesFromServer,
    syncBrowserStateFromReconnectSnapshot: runtimeOptions.syncBrowserStateFromReconnectSnapshot,
  });
}

function createBrowserRuntimeOptions(
  options: StartDesktopAppSessionOptions,
  browserStateSync: {
    scheduleBrowserStateSync: (delayMs?: number, notify?: boolean) => void;
    syncBrowserStateFromReconnectSnapshot: BrowserStateSyncApi['syncBrowserStateFromReconnectSnapshot'];
  },
): BrowserRuntimeCleanupOptions {
  return {
    onAgentLifecycle: handleAgentLifecycleMessage,
    onGitStatusChanged: handleGitStatusChanged,
    onRemoteStatus: updateRemotePeerStatus,
    onServerStateBootstrap: replaceServerStateBootstrap,
    onTaskCommandControllerChanged: applyTaskCommandControllerChanged,
    onTaskPortsChanged: (event) => applyServerStateEvent('task-ports', event),
    replaceTaskCommandControllers,
    reconcileRunningAgentIds,
    scheduleBrowserStateSync: browserStateSync.scheduleBrowserStateSync,
    setConnectionBanner: options.setConnectionBanner,
    showNotification,
    syncAgentStatusesFromServer,
    syncBrowserStateFromReconnectSnapshot: browserStateSync.syncBrowserStateFromReconnectSnapshot,
  };
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

async function restorePersistedPlanContent(): Promise<void> {
  const taskIds = [...store.taskOrder, ...store.collapsedTaskOrder];
  const restoreRequests = taskIds
    .map((taskId) => {
      const task = store.tasks[taskId];
      if (!task?.worktreePath || !task.planRelativePath) {
        return null;
      }

      return invoke(IPC.ReadPlanContent, {
        relativePath: task.planRelativePath,
        worktreePath: task.worktreePath,
      })
        .then((result) => {
          if (result) {
            setPlanContent(taskId, result.content, result.fileName, result.relativePath);
          }
        })
        .catch((error) => {
          console.warn(`Failed to restore plan for task ${taskId}:`, error);
        });
    })
    .filter((request): request is Promise<void> => request !== null);

  await Promise.all(restoreRequests);
}

async function runDesktopSessionStartup(
  options: StartDesktopAppSessionOptions,
  resources: DesktopSessionResources,
  bootstrapController: ReturnType<typeof createSessionBootstrapController>,
  browserStateSync: {
    scheduleBrowserStateSync: (delayMs?: number, notify?: boolean) => void;
    syncBrowserStateFromReconnectSnapshot: BrowserStateSyncApi['syncBrowserStateFromReconnectSnapshot'];
  },
  sessionRuntime: DesktopSessionRuntime,
  isDisposed: () => boolean,
): Promise<void> {
  await sessionRuntime.setupWindowChrome();
  if (isDisposed()) return;

  void sessionRuntime.syncWindowFocused();
  void sessionRuntime.syncWindowMaximized();
  sessionRuntime.registerWindowEventListeners();

  await loadAgents();
  if (isDisposed()) return;

  if (options.electronRuntime) {
    await loadState();
  } else {
    await loadWorkspaceState();
  }
  if (isDisposed()) return;

  if (!options.electronRuntime) {
    loadClientSessionState();
    reconcileClientSessionState();
    await loadTaskCommandControllers();
  }

  if (options.electronRuntime) {
    await restorePersistedPlanContent();
    if (isDisposed()) return;
  }

  await bootstrapController.hydrateInitialSnapshots();
  if (isDisposed()) return;

  bootstrapController.complete();

  markAutosaveClean();
  await validateProjectPaths();
  if (isDisposed()) return;

  await sessionRuntime.restoreWindowState();
  if (isDisposed()) return;

  await sessionRuntime.captureWindowState();
  if (isDisposed()) return;

  setupAutosave();

  resources.offPlanContent = replaceResource(
    isDisposed(),
    resources.offPlanContent,
    listenPlanContent((message: PlanContentUpdate) => {
      if (message.taskId && store.tasks[message.taskId]) {
        setPlanContent(message.taskId, message.content, message.fileName, message.relativePath);
      }
    }),
    disposeCleanup,
  );

  resources.cleanupBrowserRuntime = replaceResource(
    isDisposed(),
    resources.cleanupBrowserRuntime,
    createBrowserRuntimeCleanup(options, createBrowserRuntimeOptions(options, browserStateSync)),
    disposeCleanup,
  );
  bootstrapController.cleanupStartupListeners();

  await reconcileRunningAgents();
  if (isDisposed()) return;

  resources.cleanupShortcuts = replaceResource(
    isDisposed(),
    resources.cleanupShortcuts,
    registerAppShortcuts(),
    disposeCleanup,
  );
  const unlisten = await sessionRuntime.registerCloseRequestedHandler();
  resources.unlistenCloseRequested = replaceResource<CleanupFn | null>(
    isDisposed(),
    resources.unlistenCloseRequested,
    unlisten,
    disposeOptionalCleanup,
  );
}

export function startDesktopAppSession(options: StartDesktopAppSessionOptions): () => void {
  const {
    cleanupBrowserStateSyncTimer,
    scheduleBrowserStateSync,
    syncBrowserStateFromReconnectSnapshot,
  } = createBrowserStateSync(options.electronRuntime);

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
  const bootstrapController = createSessionBootstrapController(options.electronRuntime);
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
    if (options.electronRuntime) {
      void saveState();
      return;
    }

    void saveBrowserWorkspaceState();
    saveClientSessionState();
  };
  window.addEventListener('pagehide', handlePageHide);

  void (async () => {
    await runDesktopSessionStartup(
      options,
      resources,
      bootstrapController,
      {
        scheduleBrowserStateSync,
        syncBrowserStateFromReconnectSnapshot,
      },
      {
        captureWindowState,
        cleanupWindowEventListeners,
        registerCloseRequestedHandler,
        registerWindowEventListeners,
        restoreWindowState,
        setupWindowChrome,
        syncWindowFocused,
        syncWindowMaximized,
      },
      () => disposed,
    );
  })();

  return () => {
    disposed = true;
    bootstrapController.dispose();
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
