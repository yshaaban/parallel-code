import type { Setter } from 'solid-js';

import { applyServerStateEvent, replaceServerStateBootstrap } from './server-state-bootstrap';
import { handleTaskCommandTakeoverResult } from './task-command-lease';
import type {
  BrowserRuntimeCleanupOptions,
  CleanupFn,
  StartDesktopAppSessionOptions,
} from './desktop-session-types';
import type { TaskPortsEvent } from '../domain/server-state';
import type { ConnectionBanner } from '../runtime/browser-session';
import { getConnectionBannerText, registerBrowserAppRuntime } from '../runtime/browser-session';
import {
  handleAgentLifecycleMessage,
  handleGitStatusChanged,
  reconcileRunningAgentIds,
  syncAgentStatusesFromServer,
} from '../runtime/server-sync';
import {
  applyTaskCommandControllerChanged,
  getTaskCommandControllerUpdateCount,
  replacePeerSessions,
  replaceTaskCommandControllers,
  showNotification,
  upsertIncomingTaskTakeoverRequest,
  updateRemotePeerStatus,
} from '../store/store';

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
): BrowserRuntimeCleanupOptions {
  return {
    getTaskCommandControllerUpdateCount,
    onAgentLifecycle: handleAgentLifecycleMessage,
    onGitStatusChanged: handleGitStatusChanged,
    onRemoteStatus: updateRemotePeerStatus,
    onPeerPresence: replacePeerSessions,
    onServerStateBootstrap: replaceServerStateBootstrap,
    onTaskCommandControllerChanged: applyTaskCommandControllerChanged,
    onTaskCommandTakeoverRequest: upsertIncomingTaskTakeoverRequest,
    onTaskCommandTakeoverResult: handleTaskCommandTakeoverResult,
    onTaskPortsChanged: (event: TaskPortsEvent) => applyServerStateEvent('task-ports', event),
    replaceTaskCommandControllers,
    reconcileRunningAgentIds,
    scheduleBrowserStateSync: browserStateSync.scheduleBrowserStateSync,
    setConnectionBanner: options.setConnectionBanner,
    showNotification,
    syncAgentStatusesFromServer,
    syncBrowserStateFromReconnectSnapshot: browserStateSync.syncBrowserStateFromReconnectSnapshot,
  };
}

export function createBrowserRuntimeCleanup(
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
    getTaskCommandControllerUpdateCount: runtimeOptions.getTaskCommandControllerUpdateCount,
    onAgentLifecycle: runtimeOptions.onAgentLifecycle,
    onGitStatusChanged: runtimeOptions.onGitStatusChanged,
    onPeerPresence: runtimeOptions.onPeerPresence,
    onServerStateBootstrap: runtimeOptions.onServerStateBootstrap,
    onTaskCommandControllerChanged: runtimeOptions.onTaskCommandControllerChanged,
    onTaskCommandTakeoverRequest: runtimeOptions.onTaskCommandTakeoverRequest,
    onTaskCommandTakeoverResult: runtimeOptions.onTaskCommandTakeoverResult,
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

export { getConnectionBannerText };
