import type { Setter } from 'solid-js';
import { applyRemoteStatus } from './remote-access';
import { applyTaskPortsEvent, fetchTaskPorts, replaceTaskPortSnapshots } from './task-ports';
import { applyAgentSupervisionEvent, replaceAgentSupervisionSnapshots } from './task-attention';
import {
  clearPathInputNotifier,
  getPendingPathInput,
  registerPathInputNotifier,
} from '../lib/dialog';
import { IPC } from '../../electron/ipc/channels';
import type { PlanContentUpdate } from '../domain/renderer-events';
import type {
  AgentSupervisionEvent,
  GitStatusSyncEvent,
  RemoteAccessStatus,
  TaskPortsEvent,
} from '../domain/server-state';
import {
  listenAgentSupervisionChanged,
  listenGitStatusChanged,
  listenPlanContent,
  listenRemoteStatusChanged,
  listenTaskPortsChanged,
} from '../lib/ipc-events';
import { invoke } from '../lib/ipc';
import { assertNever } from '../lib/assert-never';
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
  offAgentSupervision: () => void;
  cleanupBrowserRuntime: () => void;
  cleanupShortcuts: () => void;
  offGitStatus: () => void;
  offPlanContent: () => void;
  offRemoteStatus: () => void;
  offTaskPorts: () => void;
  unlistenCloseRequested: (() => void) | null;
}

type CleanupFn = () => void;
type DesktopSessionStartupState =
  | {
      kind: 'booting';
      pendingAgentSupervision: AgentSupervisionEvent[];
      pendingGitMessages: GitStatusSyncEvent[];
      pendingRemoteStatus: RemoteAccessStatus | null;
      pendingTaskPorts: TaskPortsEvent[];
    }
  | { kind: 'ready' }
  | { kind: 'disposed' };

function createDesktopSessionResources(): DesktopSessionResources {
  return {
    offAgentSupervision: () => {},
    cleanupBrowserRuntime: () => {},
    cleanupShortcuts: () => {},
    offGitStatus: () => {},
    offPlanContent: () => {},
    offRemoteStatus: () => {},
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

function createDesktopSessionStartupGate(): {
  complete(): void;
  dispose(): void;
  handle(message: GitStatusSyncEvent): void;
  handleAgentSupervision(event: AgentSupervisionEvent): void;
  handleRemoteStatus(status: RemoteAccessStatus): void;
  handleTaskPorts(event: TaskPortsEvent): void;
} {
  let state: DesktopSessionStartupState = {
    kind: 'booting',
    pendingAgentSupervision: [],
    pendingGitMessages: [],
    pendingRemoteStatus: null,
    pendingTaskPorts: [],
  };

  return {
    handle(message: GitStatusSyncEvent): void {
      switch (state.kind) {
        case 'booting':
          state.pendingGitMessages.push(message);
          return;
        case 'ready':
          handleGitStatusChanged(message);
          return;
        case 'disposed':
          return;
        default:
          return assertNever(state, 'Unhandled desktop session startup state');
      }
    },
    handleAgentSupervision(event: AgentSupervisionEvent): void {
      switch (state.kind) {
        case 'booting':
          state.pendingAgentSupervision.push(event);
          return;
        case 'ready':
          applyAgentSupervisionEvent(event);
          return;
        case 'disposed':
          return;
        default:
          return assertNever(state, 'Unhandled desktop session startup state');
      }
    },
    handleRemoteStatus(status: RemoteAccessStatus): void {
      switch (state.kind) {
        case 'booting':
          state.pendingRemoteStatus = status;
          return;
        case 'ready':
          applyRemoteStatus(status);
          return;
        case 'disposed':
          return;
        default:
          return assertNever(state, 'Unhandled desktop session startup state');
      }
    },
    handleTaskPorts(event: TaskPortsEvent): void {
      switch (state.kind) {
        case 'booting':
          state.pendingTaskPorts.push(event);
          return;
        case 'ready':
          applyTaskPortsEvent(event);
          return;
        case 'disposed':
          return;
        default:
          return assertNever(state, 'Unhandled desktop session startup state');
      }
    },
    complete(): void {
      if (state.kind !== 'booting') {
        return;
      }

      const pendingRemoteStatus = state.pendingRemoteStatus;
      const pendingAgentSupervision = state.pendingAgentSupervision.splice(0);
      const pendingGitMessages = state.pendingGitMessages.splice(0);
      const pendingTaskPorts = state.pendingTaskPorts.splice(0);
      state = { kind: 'ready' };

      if (pendingRemoteStatus) {
        applyRemoteStatus(pendingRemoteStatus);
      }
      for (const event of pendingAgentSupervision) {
        applyAgentSupervisionEvent(event);
      }
      for (const message of pendingGitMessages) {
        handleGitStatusChanged(message);
      }
      for (const event of pendingTaskPorts) {
        applyTaskPortsEvent(event);
      }
    },
    dispose(): void {
      state = { kind: 'disposed' };
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
    onTaskPortsChanged: applyTaskPortsEvent,
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
      createAgentSupervisionListener(startupGate.handleAgentSupervision),
      disposeCleanup,
    );

    resources.offRemoteStatus = replaceResource(
      disposed,
      resources.offRemoteStatus,
      createRemoteStatusListener(options.electronRuntime, startupGate.handleRemoteStatus),
      disposeCleanup,
    );

    resources.offGitStatus = replaceResource(
      disposed,
      resources.offGitStatus,
      createGitStatusListener(options.electronRuntime, startupGate.handle),
      disposeCleanup,
    );
    resources.offTaskPorts = replaceResource(
      disposed,
      resources.offTaskPorts,
      createTaskPortsListener(options.electronRuntime, startupGate.handleTaskPorts),
      disposeCleanup,
    );

    await loadAgents();
    if (disposed) return;

    await loadState();
    if (disposed) return;

    if (options.electronRuntime) {
      replaceAgentSupervisionSnapshots(await invoke(IPC.GetAgentSupervision));
      if (disposed) return;
    }

    replaceTaskPortSnapshots(await fetchTaskPorts());
    if (disposed) return;

    startupGate.complete();

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
