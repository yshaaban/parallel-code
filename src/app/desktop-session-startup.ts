import { IPC } from '../../electron/ipc/channels';
import { loadAgents } from '../app/agent-catalog';
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
import type { BrowserColdBootstrapPlanContent } from '../domain/renderer-invoke';
import type { PlanContentUpdate } from '../domain/renderer-events';
import type { ServerStateBootstrapResultSnapshot } from '../domain/server-state-bootstrap';
import {
  loadClientSessionState,
  peekClientSessionSelection,
  reconcileClientSessionState,
} from '../store/client-session';
import { loadState } from '../store/persistence-load';
import { applyProjectPathExistence, validateProjectPaths } from '../store/projects';
import { store } from '../store/state';
import { setPlanContent } from '../store/tasks';
import {
  beginAppStartupPresentation,
  clearAppStartupStatus,
  setAppStartupStatus,
} from './app-startup-status';
import { startWorkspaceShapeCachePersistence } from './workspace-shape-cache-persistence';
import { startStartupRestoreAgentSessionEnsure } from './agent-session-ensure';
import { refreshDiscoveredProjects } from './discovered-projects';
import {
  beginSpeculativeSelectedTerminalAttach,
  getSpeculativeSelectedTerminalIntent,
  resolveSpeculativeSelectedTerminalAttach,
  type SpeculativeSelectedTerminalIntent,
} from './speculative-terminal-attach';
import { emitStartupBreadcrumb } from './startup-breadcrumbs';

import {
  createBrowserRuntimeCleanup,
  createBrowserRuntimeOptions,
} from './desktop-browser-runtime';
import {
  startBrowserWorkspaceColdStartRecovery,
  type BrowserWorkspaceColdStartRecovery,
} from './browser-workspace-cold-start-recovery';
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
import { reconcileRetainedTaskMergeOperations } from './task-merge-operation-recovery';

interface DesktopSessionBootstrapController {
  cleanupStartupListeners(): void;
  complete(): void;
  hydrateInitialSnapshots(
    snapshots?: ReadonlyArray<ServerStateBootstrapResultSnapshot>,
  ): Promise<void>;
}

const BROWSER_AGENT_CATALOG_REFRESH_DELAY_MS = 2_000;
const DISCOVERED_PROJECTS_PREFETCH_DELAY_MS = 1_500;

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

function refreshBrowserAgentCatalogInBackground(signal?: AbortSignal): Promise<void> {
  emitStartupBreadcrumb('desktop-startup:browser-agents-refresh-start');
  return loadAgents(signal ? { signal } : undefined)
    .then(() => {
      signal?.throwIfAborted();
      emitStartupBreadcrumb('desktop-startup:browser-agents-refresh-complete');
    })
    .catch((error) => {
      if (signal?.aborted) {
        return;
      }
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

function scheduleDiscoveredProjectsRefresh(
  startupTimerController: DesktopSessionStartupTimerController,
  isDisposed: () => boolean,
): void {
  startupTimerController.schedule(() => {
    if (isDisposed()) {
      return;
    }

    emitStartupBreadcrumb('desktop-startup:discovered-projects-refresh-start');
    void refreshDiscoveredProjects();
  }, DISCOVERED_PROJECTS_PREFETCH_DELAY_MS);
}

function peekSpeculativeSelectedTerminalIntent(): SpeculativeSelectedTerminalIntent | null {
  const selection = peekClientSessionSelection();
  if (!selection.activeTaskId) {
    return null;
  }

  const agentId = selection.activeAgentId ?? selection.standaloneTerminalAgentId;
  if (!agentId) {
    return null;
  }

  return {
    agentId,
    taskId: selection.activeTaskId,
  };
}

// Confirmation requires the restored selection to resolve to the exact same
// task and agent identity; reconcileClientSessionState has already cleared any
// dangling selection, so a matching activeAgentId implies the agent still
// exists in restored state.
function resolveSpeculativeSelectedTerminalAttachFromRestoredSelection(): void {
  const intent = getSpeculativeSelectedTerminalIntent();
  if (!intent) {
    return;
  }

  const confirmed = store.activeTaskId === intent.taskId && store.activeAgentId === intent.agentId;
  resolveSpeculativeSelectedTerminalAttach(confirmed ? 'confirmed' : 'discarded');
}

function applyColdBootstrapPlanContents(
  planContents: BrowserColdBootstrapPlanContent[] | undefined,
): void {
  for (const entry of planContents ?? []) {
    if (store.tasks[entry.taskId]) {
      setPlanContent(entry.taskId, entry.content, entry.fileName, entry.relativePath);
    }
  }
}

async function restorePersistedPlanContent(isDisposed: () => boolean = () => false): Promise<void> {
  const taskIds = [...store.taskOrder, ...store.collapsedTaskOrder];
  const restoreRequests = taskIds
    .map((taskId) => {
      const task = store.tasks[taskId];
      if (!task?.worktreePath || !task.planRelativePath) {
        return null;
      }
      const { worktreePath, planRelativePath, planContent } = task;

      return invoke(IPC.ReadPlanContent, {
        relativePath: planRelativePath,
        taskId,
      })
        .then((result) => {
          const currentTask = store.tasks[taskId];
          if (
            result &&
            !isDisposed() &&
            currentTask?.worktreePath === worktreePath &&
            currentTask.planRelativePath === planRelativePath &&
            currentTask.planContent === planContent &&
            result.relativePath === planRelativePath
          ) {
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
  let refreshBrowserPlans = false;
  emitStartupBreadcrumb('desktop-startup:begin');
  // Presentation pending begins before any awaited startup work so skeleton
  // surfaces never race the first await; clearAppStartupStatus (completion,
  // failure, and dispose paths) completes it.
  beginAppStartupPresentation();
  const startupTimerController = createDesktopSessionStartupTimerController();
  const startupCleanupCallbacks = new Set<() => void>();
  function cleanupStartupScopedResources(): void {
    startupTimerController.cancelAll();
    // Resolution is mandatory for a published speculative intent: a disposed
    // or aborted startup discards it here so a registered prewarm consumer can
    // never be left holding an unresolved intent (no-op once resolved).
    resolveSpeculativeSelectedTerminalAttach('discarded');
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
  const browserAgentCatalogRefreshController = new AbortController();
  registerStartupScopedCleanup(() => {
    browserAgentCatalogRefreshController.abort(
      new Error('Browser agent catalog startup refresh cancelled'),
    );
  });
  let browserAgentCatalogRefreshPromise: Promise<void> | null = null;
  function ensureBrowserAgentCatalogRefresh(): Promise<void> {
    browserAgentCatalogRefreshPromise ??= refreshBrowserAgentCatalogInBackground(
      browserAgentCatalogRefreshController.signal,
    );
    return browserAgentCatalogRefreshPromise;
  }

  function refreshBrowserAgentCatalogForRecovery(signal: AbortSignal): Promise<void> {
    const refreshPromise = refreshBrowserAgentCatalogInBackground(signal);
    return refreshPromise.then(() => {
      signal.throwIfAborted();
      browserAgentCatalogRefreshPromise ??= refreshPromise;
    });
  }

  function startBrowserWorkspaceRecovery(): BrowserWorkspaceColdStartRecovery {
    const recovery = startBrowserWorkspaceColdStartRecovery({
      ensureAgentCatalogRefresh: refreshBrowserAgentCatalogForRecovery,
      isDisposed,
      scheduleImmediateSync: () => browserStateSync.scheduleBrowserStateSync(0, false),
      wait: (delayMs) => startupTimerController.wait(delayMs, isDisposed),
    });
    registerStartupScopedCleanup(recovery.cancel);
    return recovery;
  }

  // App shortcuts register before any startup await; handlers no-op safely on
  // an empty store.
  resources.cleanupShortcuts = replaceDesktopSessionResource(
    isDisposed(),
    resources.cleanupShortcuts,
    registerAppShortcuts(),
    disposeCleanup,
  );
  emitStartupBreadcrumb('desktop-startup:shortcuts-registered');

  registerStartupScopedCleanup(startWorkspaceShapeCachePersistence());

  setAppStartupStatus('bootstrapping', 'Loading workspace and session state');
  const browserRuntimeOptions = createBrowserRuntimeOptions(options, browserStateSync, {
    onRestoreCompleted: taskNotificationRuntime.arm,
    onRestoreStarted: taskNotificationRuntime.disarm,
  });

  // On the healthy browser path, the cold-bootstrap fetch is the only awaited
  // network round trip before the selected-task tier, so it starts before
  // window chrome and runs concurrently with websocket runtime registration.
  let browserWorkspaceRecovery: BrowserWorkspaceColdStartRecovery | null = null;
  if (!options.electronRuntime) {
    beginBrowserColdBootstrap();
    emitStartupBreadcrumb('desktop-startup:browser-cold-bootstrap-begin');
    beginSpeculativeSelectedTerminalAttach(peekSpeculativeSelectedTerminalIntent());
    resources.cleanupBrowserRuntime = replaceDesktopSessionResource(
      isDisposed(),
      resources.cleanupBrowserRuntime,
      createBrowserRuntimeCleanup(options, browserRuntimeOptions),
      disposeCleanup,
    );
    setAppStartupStatus('restoring', 'Loading backend browser bootstrap');
    browserWorkspaceRecovery = startBrowserWorkspaceRecovery();
  }

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

  if (options.electronRuntime) {
    setAppStartupStatus('restoring', 'Loading saved workspace state');
    await loadState();
    registerStartupScopedCleanup(startStartupRestoreAgentSessionEnsure({ isDisposed }));
  } else {
    const recoveryResult = await (
      browserWorkspaceRecovery ?? startBrowserWorkspaceRecovery()
    ).restore();
    if (!recoveryResult || isDisposed()) {
      return;
    }
    const { coldBootstrap, shouldSchedulePostRestoreSync } = recoveryResult;
    // Plan contents and project-path existence ride the cold-bootstrap payload,
    // so no ReadPlanContent or CheckPathsExist round trips sit on this path; the
    // delayed background validation below still runs reconciliation refreshes.
    applyColdBootstrapPlanContents(coldBootstrap?.planContents);
    refreshBrowserPlans = coldBootstrap?.planContents === undefined;
    if (coldBootstrap?.projectPathsExist) {
      applyProjectPathExistence(coldBootstrap.projectPathsExist);
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
    resolveSpeculativeSelectedTerminalAttachFromRestoredSelection();
    registerStartupScopedCleanup(startStartupRestoreAgentSessionEnsure({ isDisposed }));
    setBrowserStartupTier('selected-task');
    emitStartupBreadcrumb('desktop-startup:browser-selected-task');
    if (shouldSchedulePostRestoreSync) {
      browserStateSync.scheduleBrowserStateSync(0, false);
    }
  }
  if (isDisposed()) return;

  // Recover credentials left by a response lost after canonical merge removal. This is deliberately
  // background work: startup renders canonical state immediately, while the status join clears only
  // operations whose backend outcome is terminal.
  void reconcileRetainedTaskMergeOperations();

  if (options.electronRuntime) {
    await Promise.all([
      restorePersistedPlanContent(),
      bootstrapController.hydrateInitialSnapshots(),
    ]);
  }
  if (isDisposed()) return;

  setAppStartupStatus('finalizing', 'Finalizing startup');
  emitStartupBreadcrumb('desktop-startup:finalizing');
  bootstrapController.complete();
  emitStartupBreadcrumb('desktop-startup:after-bootstrap-complete');

  markAutosaveClean();
  emitStartupBreadcrumb('desktop-startup:after-mark-autosave-clean');

  if (options.electronRuntime) {
    await Promise.all([
      validateProjectPaths().then(() => {
        emitStartupBreadcrumb('desktop-startup:after-validate-project-paths');
      }),
      sessionRuntime.restoreWindowState().then(() => {
        emitStartupBreadcrumb('desktop-startup:after-restore-window-state');
      }),
    ]);
    if (isDisposed()) return;

    await sessionRuntime.captureWindowState();
    emitStartupBreadcrumb('desktop-startup:after-capture-window-state');
    if (isDisposed()) return;
  } else {
    validateProjectPathsInBackground();
    emitStartupBreadcrumb('desktop-startup:after-schedule-project-path-validation');
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
  if (refreshBrowserPlans && !isDisposed()) void restorePersistedPlanContent(isDisposed);

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
  scheduleDiscoveredProjectsRefresh(startupTimerController, isDisposed);
  emitStartupBreadcrumb('desktop-startup:after-schedule-discovered-projects');
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
