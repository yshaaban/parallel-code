import type { Setter } from 'solid-js';

import { handleTaskCommandTakeoverResult } from './task-command-lease';
import type {
  BrowserRuntimeCleanupOptions,
  CleanupFn,
  StartDesktopAppSessionOptions,
} from './desktop-session-types';
import type { ConnectionBanner } from '../runtime/browser-session';
import { getConnectionBannerText, registerBrowserAppRuntime } from '../runtime/browser-session';
import {
  handleAgentLifecycleMessage,
  reconcileRunningAgentIds,
  syncAgentStatusesFromServer,
} from '../runtime/server-sync';
import {
  applyTaskCommandControllerChanged,
  getTaskCommandControllerUpdateCount,
  replaceTaskCommandControllers,
} from '../store/task-command-controllers';
import { replacePeerSessions } from '../store/peer-presence';
import { showNotification } from '../store/notification';
import { upsertIncomingTaskTakeoverRequest } from '../store/task-command-takeovers';

type BrowserRuntimeRegistrationOptions = Parameters<typeof registerBrowserAppRuntime>[0];

function clearRestoringConnectionBanner(
  setConnectionBanner: Setter<ConnectionBanner | null>,
): void {
  setConnectionBanner((current) => (current?.state === 'restoring' ? null : current));
}

export function createBrowserRuntimeOptions(
  options: StartDesktopAppSessionOptions,
  browserStateSync: {
    scheduleBrowserStateSync: (delayMs?: number, notify?: boolean) => void;
    syncBrowserStateFromReconnectSnapshot: BrowserRuntimeCleanupOptions['syncBrowserStateFromReconnectSnapshot'];
  },
  taskNotificationRuntime?: {
    onRestoreCompleted?: () => void;
    onRestoreStarted?: () => void;
  },
): BrowserRuntimeCleanupOptions {
  const runtimeOptions: BrowserRuntimeCleanupOptions = {
    getTaskCommandControllerUpdateCount,
    onAgentLifecycle: handleAgentLifecycleMessage,
    onPeerPresence: replacePeerSessions,
    onTaskCommandControllerChanged: applyTaskCommandControllerChanged,
    onTaskCommandTakeoverRequest: upsertIncomingTaskTakeoverRequest,
    onTaskCommandTakeoverResult: handleTaskCommandTakeoverResult,
    replaceTaskCommandControllers,
    reconcileRunningAgentIds,
    scheduleBrowserStateSync: browserStateSync.scheduleBrowserStateSync,
    setConnectionBanner: options.setConnectionBanner,
    showNotification,
    syncAgentStatusesFromServer,
    syncBrowserStateFromReconnectSnapshot: browserStateSync.syncBrowserStateFromReconnectSnapshot,
  };

  if (taskNotificationRuntime?.onRestoreCompleted) {
    runtimeOptions.onTaskNotificationRestoreCompleted = taskNotificationRuntime.onRestoreCompleted;
  }

  if (taskNotificationRuntime?.onRestoreStarted) {
    runtimeOptions.onTaskNotificationRestoreStarted = taskNotificationRuntime.onRestoreStarted;
  }

  return runtimeOptions;
}

export function createBrowserRuntimeCleanup(
  options: StartDesktopAppSessionOptions,
  runtimeOptions: BrowserRuntimeCleanupOptions,
): CleanupFn {
  if (options.electronRuntime) {
    return () => {};
  }

  const browserRuntimeOptions: BrowserRuntimeRegistrationOptions = {
    clearRestoringConnectionBanner: () => {
      clearRestoringConnectionBanner(options.setConnectionBanner);
    },
    getTaskCommandControllerUpdateCount: runtimeOptions.getTaskCommandControllerUpdateCount,
    onAgentLifecycle: runtimeOptions.onAgentLifecycle,
    onPeerPresence: runtimeOptions.onPeerPresence,
    onTaskCommandControllerChanged: runtimeOptions.onTaskCommandControllerChanged,
    onTaskCommandTakeoverRequest: runtimeOptions.onTaskCommandTakeoverRequest,
    onTaskCommandTakeoverResult: runtimeOptions.onTaskCommandTakeoverResult,
    reconcileRunningAgentIds: runtimeOptions.reconcileRunningAgentIds,
    replaceTaskCommandControllers: runtimeOptions.replaceTaskCommandControllers,
    scheduleBrowserStateSync: runtimeOptions.scheduleBrowserStateSync,
    setConnectionBanner: runtimeOptions.setConnectionBanner,
    showNotification: runtimeOptions.showNotification,
    syncAgentStatusesFromServer: runtimeOptions.syncAgentStatusesFromServer,
    syncBrowserStateFromReconnectSnapshot: runtimeOptions.syncBrowserStateFromReconnectSnapshot,
  };

  if (runtimeOptions.onTaskNotificationRestoreCompleted) {
    browserRuntimeOptions.onTaskNotificationRestoreCompleted =
      runtimeOptions.onTaskNotificationRestoreCompleted;
  }

  if (runtimeOptions.onTaskNotificationRestoreStarted) {
    browserRuntimeOptions.onTaskNotificationRestoreStarted =
      runtimeOptions.onTaskNotificationRestoreStarted;
  }

  return registerBrowserAppRuntime(browserRuntimeOptions);
}

export { getConnectionBannerText };
