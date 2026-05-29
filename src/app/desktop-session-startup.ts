import { IPC } from '../../electron/ipc/channels';
import { loadAgents } from '../app/agent-catalog';
import { fetchBrowserColdBootstrap } from '../app/browser-cold-bootstrap';
import {
  beginBrowserColdBootstrap,
  completeBrowserColdBootstrap,
  isBrowserColdBootstrapPending,
  setBrowserStartupTier,
} from '../app/browser-startup';
import { notifyTerminalAttachPolicyChanged } from '../app/terminal-attach-scheduler';
import { registerAppShortcuts } from '../runtime/app-shortcuts';
import { reconcileRunningAgents } from '../runtime/server-sync';
import { markAutosaveClean, setupAutosave } from '../store/autosave';
import { invoke } from '../lib/ipc';
import { listenPlanContent } from '../lib/ipc-events';
import type { BrowserColdBootstrapProjection } from '../domain/browser-cold-bootstrap';
import type { BrowserColdBootstrapSnapshot } from '../domain/renderer-invoke';
import type { PlanContentUpdate } from '../domain/renderer-events';
import type { AnyServerStateBootstrapSnapshot } from '../domain/server-state-bootstrap';
import { loadClientSessionState, reconcileClientSessionState } from '../store/client-session';
import { takeBrowserColdBootstrapHandoffProjection } from '../store/browser-cold-bootstrap-handoff';
import {
  applyBrowserColdBootstrapWorkspaceProjection,
  loadState,
  loadWorkspaceState,
} from '../store/persistence-load';
import { validateProjectPaths } from '../store/projects';
import { store } from '../store/state';
import { setPlanContent } from '../store/tasks';
import { clearAppStartupStatus, setAppStartupStatus } from './app-startup-status';
import { startStartupRestoreAgentSessionEnsure } from './agent-session-ensure';
import { emitStartupBreadcrumb } from './startup-breadcrumbs';

import {
  createBrowserRuntimeCleanup,
  createBrowserRuntimeOptions,
} from './desktop-browser-runtime';
import {
  disposeCleanup,
  disposeOptionalCleanup,
  replaceDesktopSessionResource,
} from './desktop-session-resources';
import type {
  BrowserStateSyncApi,
  DesktopSessionResources,
  DesktopSessionRuntime,
  StartDesktopAppSessionOptions,
} from './desktop-session-types';

interface DesktopSessionBootstrapController {
  cleanupStartupListeners(): void;
  complete(): void;
  hydrateInitialSnapshots(
    snapshots?: ReadonlyArray<AnyServerStateBootstrapSnapshot>,
  ): Promise<void>;
}

const BROWSER_COLD_BOOTSTRAP_RETRY_DELAYS_MS = [75, 200];
const BROWSER_COLD_BOOTSTRAP_RECOVERY_DELAYS_MS = [150, 300, 600];
const BROWSER_AGENT_CATALOG_REFRESH_DELAY_MS = 2_000;

interface BrowserColdBootstrapFetchResult {
  lastError: unknown | null;
  snapshot: BrowserColdBootstrapSnapshot | null;
}

interface BrowserWorkspaceStateLoadResult {
  didLoad: boolean;
  lastError: unknown | null;
}

interface DesktopSessionStartupTimerEntry {
  resolve: (completed: boolean) => void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
}

interface DesktopSessionStartupTimerController {
  cancelAll(): void;
  schedule(callback: () => void, delayMs: number): void;
  wait(delayMs: number, isDisposed: () => boolean): Promise<boolean>;
}

function createDesktopSessionStartupTimerController(): DesktopSessionStartupTimerController {
  let cancelled = false;
  const timers = new Set<DesktopSessionStartupTimerEntry>();

  function clearTimer(entry: DesktopSessionStartupTimerEntry): void {
    globalThis.clearTimeout(entry.timeout);
    timers.delete(entry);
  }

  return {
    cancelAll(): void {
      if (cancelled) {
        return;
      }

      cancelled = true;
      for (const entry of timers) {
        clearTimer(entry);
        entry.resolve(false);
      }
    },
    schedule(callback: () => void, delayMs: number): void {
      if (cancelled) {
        return;
      }

      const entry = {
        resolve: () => undefined,
        timeout: globalThis.setTimeout(() => {
          timers.delete(entry);
          if (cancelled) {
            return;
          }

          callback();
        }, delayMs),
      } satisfies DesktopSessionStartupTimerEntry;
      timers.add(entry);
    },
    wait(delayMs: number, isDisposed: () => boolean): Promise<boolean> {
      if (cancelled || isDisposed()) {
        return Promise.resolve(false);
      }

      return new Promise((resolve) => {
        const entry = {
          resolve,
          timeout: globalThis.setTimeout(() => {
            timers.delete(entry);
            resolve(!cancelled && !isDisposed());
          }, delayMs),
        } satisfies DesktopSessionStartupTimerEntry;
        timers.add(entry);
      });
    },
  };
}

async function fetchBrowserColdBootstrapWithRetry(
  isDisposed: () => boolean,
  startupTimerController: DesktopSessionStartupTimerController,
): Promise<BrowserColdBootstrapFetchResult> {
  let lastError: unknown = null;
  let snapshot: BrowserColdBootstrapSnapshot | null = null;

  for (let attempt = 0; attempt <= BROWSER_COLD_BOOTSTRAP_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      snapshot = await fetchBrowserColdBootstrap();
      if (snapshot) {
        return {
          lastError,
          snapshot,
        };
      }
    } catch (error) {
      lastError = error;
      snapshot = null;
    }

    if (attempt >= BROWSER_COLD_BOOTSTRAP_RETRY_DELAYS_MS.length || isDisposed()) {
      break;
    }

    const retryDelayMs = BROWSER_COLD_BOOTSTRAP_RETRY_DELAYS_MS[attempt];
    if (retryDelayMs === undefined) {
      break;
    }

    if (!(await startupTimerController.wait(retryDelayMs, isDisposed))) {
      break;
    }
  }

  return {
    lastError,
    snapshot,
  };
}

async function loadWorkspaceStateWithRetry(
  isDisposed: () => boolean,
  startupTimerController: DesktopSessionStartupTimerController,
): Promise<BrowserWorkspaceStateLoadResult> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= BROWSER_COLD_BOOTSTRAP_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      if (await loadWorkspaceState()) {
        return {
          didLoad: true,
          lastError: null,
        };
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt >= BROWSER_COLD_BOOTSTRAP_RETRY_DELAYS_MS.length || isDisposed()) {
      break;
    }

    const retryDelayMs = BROWSER_COLD_BOOTSTRAP_RETRY_DELAYS_MS[attempt];
    if (retryDelayMs === undefined) {
      break;
    }

    if (!(await startupTimerController.wait(retryDelayMs, isDisposed))) {
      break;
    }
  }

  return {
    didLoad: false,
    lastError,
  };
}

async function recoverMissingBrowserWorkspaceState(
  isDisposed: () => boolean,
  startupTimerController: DesktopSessionStartupTimerController,
): Promise<BrowserWorkspaceStateLoadResult> {
  let lastError: unknown = null;

  for (const delayMs of BROWSER_COLD_BOOTSTRAP_RECOVERY_DELAYS_MS) {
    if (isDisposed()) {
      break;
    }
    if (hasMeaningfulWorkspaceStoreState()) {
      return {
        didLoad: true,
        lastError: null,
      };
    }

    if (!(await startupTimerController.wait(delayMs, isDisposed))) {
      break;
    }

    try {
      if (await loadWorkspaceState()) {
        return {
          didLoad: true,
          lastError: null,
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  return {
    didLoad: hasMeaningfulWorkspaceStoreState(),
    lastError,
  };
}

function createBrowserWorkspaceStartupFailure(
  bootstrapError: unknown,
  workspaceLoadError: unknown,
): Error | null {
  const errors = [bootstrapError, workspaceLoadError].filter(
    (error): error is NonNullable<typeof error> => error !== null,
  );
  if (errors.length === 0) {
    return null;
  }

  const detail = errors
    .map((error) => {
      if (error instanceof Error && error.message.trim()) {
        return error.message;
      }

      return String(error);
    })
    .join('; ');

  return new Error(
    detail
      ? `Failed to restore browser workspace during cold bootstrap: ${detail}`
      : 'Failed to restore browser workspace during cold bootstrap',
  );
}

function hasMeaningfulWorkspaceStoreState(): boolean {
  return (
    store.projects.length > 0 ||
    store.taskOrder.length > 0 ||
    store.collapsedTaskOrder.length > 0 ||
    Object.keys(store.tasks).length > 0 ||
    Object.keys(store.terminals).length > 0
  );
}

function applyBrowserWorkspaceProjection(
  projection: BrowserColdBootstrapProjection | null,
  workspaceRevision: number,
): boolean {
  if (!projection) {
    return false;
  }

  applyBrowserColdBootstrapWorkspaceProjection(projection, workspaceRevision);
  emitStartupBreadcrumb('desktop-startup:browser-projection-applied');
  return true;
}

function validateProjectPathsInBackground(): void {
  void validateProjectPaths().catch((error) => {
    console.warn('Failed to validate project paths during browser startup:', error);
  });
}

function captureBrowserWindowStateInBackground(sessionRuntime: DesktopSessionRuntime): void {
  void sessionRuntime.captureWindowState().catch((error) => {
    console.warn('Failed to capture browser window state during startup:', error);
  });
}

function refreshBrowserAgentCatalogInBackground(): Promise<void> {
  emitStartupBreadcrumb('desktop-startup:browser-agents-refresh-start');
  return loadAgents()
    .then(() => {
      emitStartupBreadcrumb('desktop-startup:browser-agents-refresh-complete');
    })
    .catch((error) => {
      console.warn('Failed to refresh browser agent catalog during startup:', error);
    });
}

function scheduleBrowserAgentCatalogRefresh(
  startupTimerController: DesktopSessionStartupTimerController,
  isDisposed: () => boolean,
  ensureBrowserAgentCatalogRefresh: () => Promise<void>,
): void {
  startupTimerController.schedule(() => {
    if (isDisposed()) {
      return;
    }

    void ensureBrowserAgentCatalogRefresh();
  }, BROWSER_AGENT_CATALOG_REFRESH_DELAY_MS);
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

export async function runDesktopSessionStartup(
  options: StartDesktopAppSessionOptions,
  resources: DesktopSessionResources,
  bootstrapController: DesktopSessionBootstrapController,
  browserStateSync: BrowserStateSyncApi,
  sessionRuntime: DesktopSessionRuntime,
  taskNotificationRuntime: {
    arm: () => void;
    disarm: () => void;
  },
  isDisposed: () => boolean,
): Promise<void> {
  emitStartupBreadcrumb('desktop-startup:begin');
  const startupTimerController = createDesktopSessionStartupTimerController();
  const startupCleanupCallbacks = new Set<() => void>();
  function cleanupStartupScopedResources(): void {
    startupTimerController.cancelAll();
    for (const cleanup of startupCleanupCallbacks) {
      cleanup();
    }
    startupCleanupCallbacks.clear();
  }

  function registerStartupScopedCleanup(cleanup: () => void): void {
    if (isDisposed()) {
      cleanup();
      return;
    }

    startupCleanupCallbacks.add(cleanup);
  }

  resources.cleanupStartupTimers = replaceDesktopSessionResource(
    isDisposed(),
    resources.cleanupStartupTimers,
    cleanupStartupScopedResources,
    disposeCleanup,
  );
  let browserAgentCatalogRefreshPromise: Promise<void> | null = null;
  function ensureBrowserAgentCatalogRefresh(): Promise<void> {
    browserAgentCatalogRefreshPromise ??= refreshBrowserAgentCatalogInBackground();
    return browserAgentCatalogRefreshPromise;
  }

  setAppStartupStatus('bootstrapping', 'Loading workspace and session state');
  const browserRuntimeOptions = createBrowserRuntimeOptions(options, browserStateSync, {
    onRestoreCompleted: taskNotificationRuntime.arm,
    onRestoreStarted: taskNotificationRuntime.disarm,
  });

  await sessionRuntime.setupWindowChrome();
  if (isDisposed()) return;

  void sessionRuntime.syncWindowFocused();
  void sessionRuntime.syncWindowMaximized();
  sessionRuntime.registerWindowEventListeners();

  if (options.electronRuntime) {
    await loadAgents();
    emitStartupBreadcrumb('desktop-startup:agents-loaded');
    if (isDisposed()) return;
  }

  if (!options.electronRuntime) {
    resources.cleanupBrowserRuntime = replaceDesktopSessionResource(
      isDisposed(),
      resources.cleanupBrowserRuntime,
      createBrowserRuntimeCleanup(options, browserRuntimeOptions),
      disposeCleanup,
    );
  }

  if (options.electronRuntime) {
    setAppStartupStatus('restoring', 'Loading saved workspace state');
    await loadState();
    registerStartupScopedCleanup(startStartupRestoreAgentSessionEnsure({ isDisposed }));
  } else {
    beginBrowserColdBootstrap();
    emitStartupBreadcrumb('desktop-startup:browser-cold-bootstrap-begin');
    setAppStartupStatus('restoring', 'Loading backend browser bootstrap');
    const coldBootstrapResult = await fetchBrowserColdBootstrapWithRetry(
      isDisposed,
      startupTimerController,
    );
    if (isDisposed()) {
      return;
    }
    const coldBootstrap = coldBootstrapResult.snapshot;
    const workspaceRevision = coldBootstrap?.workspaceRevision ?? 0;
    let appliedWorkspaceProjection = applyBrowserWorkspaceProjection(
      coldBootstrap?.workspaceProjection ?? null,
      workspaceRevision,
    );
    let usedHandoffProjection = false;

    if (!appliedWorkspaceProjection) {
      await ensureBrowserAgentCatalogRefresh();
      if (isDisposed()) {
        return;
      }

      const coldBootstrapHandoffProjection = takeBrowserColdBootstrapHandoffProjection({
        currentAvailableAgents: store.availableAgents,
        currentCustomAgents: store.customAgents,
      });
      if (applyBrowserWorkspaceProjection(coldBootstrapHandoffProjection, workspaceRevision)) {
        appliedWorkspaceProjection = true;
        usedHandoffProjection = true;
      } else {
        const initialWorkspaceStateLoad = await loadWorkspaceStateWithRetry(
          isDisposed,
          startupTimerController,
        );
        if (isDisposed()) {
          return;
        }
        const recoveredWorkspaceState =
          initialWorkspaceStateLoad.didLoad || isDisposed()
            ? initialWorkspaceStateLoad
            : await recoverMissingBrowserWorkspaceState(isDisposed, startupTimerController);
        if (isDisposed()) {
          return;
        }
        if (!recoveredWorkspaceState.didLoad) {
          if (coldBootstrapResult.lastError) {
            console.warn('Failed to fetch browser cold bootstrap:', coldBootstrapResult.lastError);
          }
          if (recoveredWorkspaceState.lastError) {
            console.warn(
              'Failed to load browser workspace state during cold bootstrap:',
              recoveredWorkspaceState.lastError,
            );
          }
          const startupFailure = createBrowserWorkspaceStartupFailure(
            coldBootstrapResult.lastError,
            recoveredWorkspaceState.lastError,
          );
          console.warn(
            startupFailure?.message ??
              'Browser cold bootstrap did not restore shared workspace state after retries.',
          );
          browserStateSync.scheduleBrowserStateSync(0, false);
        }
      }
    }

    if (!appliedWorkspaceProjection && !hasMeaningfulWorkspaceStoreState()) {
      console.warn(
        'Browser startup completed without a meaningful workspace projection; continuing with the current workspace snapshot.',
      );
    }
    await bootstrapController.hydrateInitialSnapshots(coldBootstrap?.serverStateBootstrap);
    if (isDisposed()) {
      return;
    }
    setBrowserStartupTier('summary');
    loadClientSessionState({
      restoreTerminalPanels: true,
    });
    reconcileClientSessionState();
    registerStartupScopedCleanup(startStartupRestoreAgentSessionEnsure({ isDisposed }));
    setBrowserStartupTier('selected-task');
    emitStartupBreadcrumb('desktop-startup:browser-selected-task');
    if (usedHandoffProjection) {
      browserStateSync.scheduleBrowserStateSync(0, false);
    }
  }
  if (isDisposed()) return;

  if (options.electronRuntime) {
    await restorePersistedPlanContent();
    if (isDisposed()) return;
  }

  if (options.electronRuntime) {
    await bootstrapController.hydrateInitialSnapshots();
  }
  if (isDisposed()) return;

  setAppStartupStatus('finalizing', 'Finalizing startup');
  emitStartupBreadcrumb('desktop-startup:finalizing');
  bootstrapController.complete();
  emitStartupBreadcrumb('desktop-startup:after-bootstrap-complete');

  markAutosaveClean();
  emitStartupBreadcrumb('desktop-startup:after-mark-autosave-clean');
  if (options.electronRuntime) {
    await validateProjectPaths();
    emitStartupBreadcrumb('desktop-startup:after-validate-project-paths');
    if (isDisposed()) return;
  } else {
    validateProjectPathsInBackground();
    emitStartupBreadcrumb('desktop-startup:after-schedule-project-path-validation');
  }

  if (options.electronRuntime) {
    await sessionRuntime.restoreWindowState();
    emitStartupBreadcrumb('desktop-startup:after-restore-window-state');
    if (isDisposed()) return;

    await sessionRuntime.captureWindowState();
    emitStartupBreadcrumb('desktop-startup:after-capture-window-state');
    if (isDisposed()) return;
  } else {
    captureBrowserWindowStateInBackground(sessionRuntime);
    emitStartupBreadcrumb('desktop-startup:after-schedule-window-state-capture');
  }

  setupAutosave();
  emitStartupBreadcrumb('desktop-startup:after-setup-autosave');

  resources.offPlanContent = replaceDesktopSessionResource(
    isDisposed(),
    resources.offPlanContent,
    listenPlanContent((message: PlanContentUpdate) => {
      if (message.taskId && store.tasks[message.taskId]) {
        setPlanContent(message.taskId, message.content, message.fileName, message.relativePath);
      }
    }),
    disposeCleanup,
  );
  emitStartupBreadcrumb('desktop-startup:after-plan-listener');

  if (options.electronRuntime) {
    resources.cleanupBrowserRuntime = replaceDesktopSessionResource(
      isDisposed(),
      resources.cleanupBrowserRuntime,
      createBrowserRuntimeCleanup(options, browserRuntimeOptions),
      disposeCleanup,
    );
  }
  bootstrapController.cleanupStartupListeners();
  emitStartupBreadcrumb('desktop-startup:after-cleanup-startup-listeners');

  taskNotificationRuntime.arm();
  emitStartupBreadcrumb('desktop-startup:after-arm-notifications');
  clearAppStartupStatus();
  emitStartupBreadcrumb('desktop-startup:complete');
  if (!options.electronRuntime) {
    scheduleBrowserAgentCatalogRefresh(
      startupTimerController,
      isDisposed,
      ensureBrowserAgentCatalogRefresh,
    );
    startupTimerController.schedule(() => {
      if (isDisposed()) {
        return;
      }
      if (!isBrowserColdBootstrapPending()) {
        return;
      }

      completeBrowserColdBootstrap();
      notifyTerminalAttachPolicyChanged();
    }, 1_000);
  }

  resources.cleanupShortcuts = replaceDesktopSessionResource(
    isDisposed(),
    resources.cleanupShortcuts,
    registerAppShortcuts(),
    disposeCleanup,
  );
  const unlisten = await sessionRuntime.registerCloseRequestedHandler();
  resources.unlistenCloseRequested = replaceDesktopSessionResource(
    isDisposed(),
    resources.unlistenCloseRequested,
    unlisten,
    disposeOptionalCleanup,
  );

  if (options.electronRuntime) {
    await reconcileRunningAgents();
    return;
  }

  void reconcileRunningAgents();
}
