import { IPC } from '../../electron/ipc/channels';
import { loadAgents } from '../app/agent-catalog';
import { registerAppShortcuts } from '../runtime/app-shortcuts';
import { reconcileRunningAgents } from '../runtime/server-sync';
import { markAutosaveClean, setupAutosave } from '../store/autosave';
import { invoke } from '../lib/ipc';
import { listenPlanContent } from '../lib/ipc-events';
import type { PlanContentUpdate } from '../domain/renderer-events';
import { loadClientSessionState, reconcileClientSessionState } from '../store/client-session';
import { loadState, loadWorkspaceState } from '../store/persistence-load';
import { validateProjectPaths } from '../store/projects';
import { store } from '../store/state';
import { loadTaskCommandControllers } from '../store/task-command-controllers';
import { setPlanContent } from '../store/tasks';
import { clearAppStartupStatus, setAppStartupStatus } from './app-startup-status';

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
  hydrateInitialSnapshots(): Promise<void>;
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

  await loadAgents();
  if (isDisposed()) return;

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
  } else {
    setAppStartupStatus('restoring', 'Loading saved workspace state');
    await loadWorkspaceState();
  }
  if (isDisposed()) return;

  if (!options.electronRuntime) {
    loadClientSessionState();
    reconcileClientSessionState();
    await loadTaskCommandControllers({
      ifUnchangedSince: browserRuntimeOptions.getTaskCommandControllerUpdateCount(),
    });
  }

  if (options.electronRuntime) {
    await restorePersistedPlanContent();
    if (isDisposed()) return;
  }

  await bootstrapController.hydrateInitialSnapshots();
  if (isDisposed()) return;

  setAppStartupStatus('finalizing', 'Finalizing startup');
  bootstrapController.complete();

  markAutosaveClean();
  await validateProjectPaths();
  if (isDisposed()) return;

  await sessionRuntime.restoreWindowState();
  if (isDisposed()) return;

  await sessionRuntime.captureWindowState();
  if (isDisposed()) return;

  setupAutosave();

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

  if (options.electronRuntime) {
    resources.cleanupBrowserRuntime = replaceDesktopSessionResource(
      isDisposed(),
      resources.cleanupBrowserRuntime,
      createBrowserRuntimeCleanup(options, browserRuntimeOptions),
      disposeCleanup,
    );
  }
  bootstrapController.cleanupStartupListeners();

  await reconcileRunningAgents();
  if (isDisposed()) return;

  taskNotificationRuntime.arm();
  clearAppStartupStatus();

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
}
