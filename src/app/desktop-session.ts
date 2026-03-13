import type { Setter } from 'solid-js';
import {
  applyServerStateEvent,
  createServerStateBootstrapGate,
  fetchServerStateBootstrap,
  replaceServerStateBootstrap,
  replaceServerStateSnapshot,
  type ServerStateBootstrapCategoryDescriptors,
} from './server-state-bootstrap';
import {
  clearPathInputNotifier,
  getPendingPathInput,
  registerPathInputNotifier,
} from '../lib/dialog';
import type { PlanContentUpdate } from '../domain/renderer-events';
import type {
  AgentSupervisionEvent,
  GitStatusSyncEvent,
  RemoteAccessStatus,
  TaskPortsEvent,
} from '../domain/server-state';
import type {
  AnyServerStateBootstrapSnapshot,
  ServerStateBootstrapPayloadMap,
  ServerStateBootstrapCategory,
  ServerStateEventPayloadMap,
} from '../domain/server-state-bootstrap';
import type { TaskConvergenceEvent } from '../domain/task-convergence';
import type { TaskReviewEvent } from '../domain/task-review';
import {
  listenAgentSupervisionChanged,
  listenGitStatusChanged,
  listenPlanContent,
  listenRemoteStatusChanged,
  listenTaskConvergenceChanged,
  listenTaskReviewChanged,
  listenTaskPortsChanged,
} from '../lib/ipc-events';
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
  offAgentSupervision: () => void;
  cleanupBrowserRuntime: () => void;
  cleanupShortcuts: () => void;
  offGitStatus: () => void;
  offPlanContent: () => void;
  offRemoteStatus: () => void;
  offTaskConvergence: () => void;
  offTaskReview: () => void;
  offTaskPorts: () => void;
  unlistenCloseRequested: (() => void) | null;
}

type CleanupFn = () => void;

function createDesktopSessionResources(): DesktopSessionResources {
  return {
    offAgentSupervision: () => {},
    cleanupBrowserRuntime: () => {},
    cleanupShortcuts: () => {},
    offGitStatus: () => {},
    offPlanContent: () => {},
    offRemoteStatus: () => {},
    offTaskConvergence: () => {},
    offTaskReview: () => {},
    offTaskPorts: () => {},
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
  disposeCleanup(resources.offAgentSupervision);
  resources.offAgentSupervision = () => {};
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
  disposeCleanup(resources.offTaskConvergence);
  resources.offTaskConvergence = () => {};
  disposeCleanup(resources.offTaskReview);
  resources.offTaskReview = () => {};
  disposeCleanup(resources.offTaskPorts);
  resources.offTaskPorts = () => {};
  disposeCleanup(resources.cleanupBrowserRuntime);
  resources.cleanupBrowserRuntime = () => {};
}

function createRemoteStatusListener(
  electronRuntime: boolean,
  handleRemoteStatus: (status: RemoteAccessStatus) => void,
): CleanupFn {
  if (!electronRuntime) {
    return () => {};
  }

  return listenRemoteStatusChanged(handleRemoteStatus);
}

function createAgentSupervisionListener(
  onAgentSupervisionChanged: (event: AgentSupervisionEvent) => void,
): CleanupFn {
  return listenAgentSupervisionChanged(onAgentSupervisionChanged);
}

function createGitStatusListener(
  electronRuntime: boolean,
  onGitStatusChanged: (message: GitStatusSyncEvent) => void,
): CleanupFn {
  if (!electronRuntime) {
    return () => {};
  }

  return listenGitStatusChanged(onGitStatusChanged);
}

function createTaskPortsListener(
  electronRuntime: boolean,
  onTaskPortsChanged: (event: TaskPortsEvent) => void,
): CleanupFn {
  if (!electronRuntime) {
    return () => {};
  }

  return listenTaskPortsChanged(onTaskPortsChanged);
}

function createTaskConvergenceListener(
  onTaskConvergenceChanged: (event: TaskConvergenceEvent) => void,
): CleanupFn {
  return listenTaskConvergenceChanged(onTaskConvergenceChanged);
}

function createTaskReviewListener(
  onTaskReviewChanged: (event: TaskReviewEvent) => void,
): CleanupFn {
  return listenTaskReviewChanged(onTaskReviewChanged);
}

function createDesktopSessionStartupGate(): ReturnType<typeof createServerStateBootstrapGate> {
  function createSnapshotApplier<TCategory extends ServerStateBootstrapCategory>(
    category: TCategory,
  ): (payload: ServerStateBootstrapPayloadMap[TCategory]) => void {
    return (payload) => {
      replaceServerStateSnapshot(category, payload);
    };
  }

  const descriptors: ServerStateBootstrapCategoryDescriptors = {
    'agent-supervision': {
      applyEvent: (event) => applyServerStateEvent('agent-supervision', event),
      applySnapshot: createSnapshotApplier('agent-supervision'),
    },
    'git-status': {
      applyEvent: (event) => applyServerStateEvent('git-status', event),
      applySnapshot: createSnapshotApplier('git-status'),
    },
    'remote-status': {
      applyEvent: (event) => applyServerStateEvent('remote-status', event),
      applySnapshot: createSnapshotApplier('remote-status'),
    },
    'task-convergence': {
      applyEvent: (event) => applyServerStateEvent('task-convergence', event),
      applySnapshot: createSnapshotApplier('task-convergence'),
    },
    'task-review': {
      applyEvent: (event) => applyServerStateEvent('task-review', event),
      applySnapshot: createSnapshotApplier('task-review'),
    },
    'task-ports': {
      applyEvent: (event) => applyServerStateEvent('task-ports', event),
      applySnapshot: createSnapshotApplier('task-ports'),
    },
  };

  return createServerStateBootstrapGate(descriptors);
}

function handleStartupCategoryEvent<K extends ServerStateBootstrapCategory>(
  startupGate: ReturnType<typeof createServerStateBootstrapGate>,
  category: K,
): (event: ServerStateEventPayloadMap[K]) => void {
  return (event) => {
    startupGate.handle(category, event);
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
    onServerStateBootstrap: replaceServerStateBootstrap,
    onTaskPortsChanged: (event) => applyServerStateEvent('task-ports', event),
    onRemoteStatus: updateRemotePeerStatus,
    reconcileRunningAgents,
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
  const startupGate = createDesktopSessionStartupGate();
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

    resources.offAgentSupervision = replaceResource(
      disposed,
      resources.offAgentSupervision,
      createAgentSupervisionListener(handleStartupCategoryEvent(startupGate, 'agent-supervision')),
      disposeCleanup,
    );

    resources.offRemoteStatus = replaceResource(
      disposed,
      resources.offRemoteStatus,
      createRemoteStatusListener(
        options.electronRuntime,
        handleStartupCategoryEvent(startupGate, 'remote-status'),
      ),
      disposeCleanup,
    );

    resources.offGitStatus = replaceResource(
      disposed,
      resources.offGitStatus,
      createGitStatusListener(
        options.electronRuntime,
        handleStartupCategoryEvent(startupGate, 'git-status'),
      ),
      disposeCleanup,
    );
    resources.offTaskPorts = replaceResource(
      disposed,
      resources.offTaskPorts,
      createTaskPortsListener(
        options.electronRuntime,
        handleStartupCategoryEvent(startupGate, 'task-ports'),
      ),
      disposeCleanup,
    );
    resources.offTaskConvergence = replaceResource(
      disposed,
      resources.offTaskConvergence,
      createTaskConvergenceListener(handleStartupCategoryEvent(startupGate, 'task-convergence')),
      disposeCleanup,
    );
    resources.offTaskReview = replaceResource(
      disposed,
      resources.offTaskReview,
      createTaskReviewListener(handleStartupCategoryEvent(startupGate, 'task-review')),
      disposeCleanup,
    );

    await loadAgents();
    if (disposed) return;

    await loadState();
    if (disposed) return;

    if (options.electronRuntime) {
      const bootstrapSnapshots = await fetchServerStateBootstrap().catch(
        () => [] as AnyServerStateBootstrapSnapshot[],
      );
      if (disposed) return;

      for (const snapshot of bootstrapSnapshots) {
        startupGate.hydrate(snapshot.category, snapshot.payload, snapshot.version);
      }
    }

    startupGate.complete();

    markAutosaveClean();
    await validateProjectPaths();
    if (disposed) return;

    await restoreWindowState();
    if (disposed) return;

    await captureWindowState();
    if (disposed) return;

    setupAutosave();

    resources.offPlanContent = replaceResource(
      disposed,
      resources.offPlanContent,
      listenPlanContent((message: PlanContentUpdate) => {
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
    startupGate.dispose();
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
