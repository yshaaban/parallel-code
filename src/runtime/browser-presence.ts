import { createRenderEffect, type Accessor } from 'solid-js';
import { createPresenceRuntime } from '../domain/presence-runtime';
import { syncFocusedTypingTaskCommandLease } from '../app/task-command-lease';
import { onBrowserAuthenticated, sendBrowserControlMessage } from '../lib/ipc';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { getTaskFocusedPanel, store } from '../store/store';
import { listControlledTaskIdsByController } from '../store/task-command-controllers';

interface BrowserPresenceRuntimeOptions {
  getDisplayName: Accessor<string>;
}
function getFocusedSurface(): string | null {
  if (store.sidebarFocused) {
    return 'sidebar';
  }

  const activeTaskId = store.activeTaskId;
  if (!activeTaskId) {
    return null;
  }

  return getTaskFocusedPanel(activeTaskId);
}

function getControllingTaskIds(clientId: string): string[] {
  return listControlledTaskIdsByController(clientId);
}

export function createBrowserPresenceRuntime(options: BrowserPresenceRuntimeOptions): void {
  const clientId = getRuntimeClientId();
  createPresenceRuntime({
    createReactiveEffect: createRenderEffect,
    getActiveTaskId: () => store.activeTaskId,
    getControllingTaskIds: () => getControllingTaskIds(clientId),
    getDisplayName: options.getDisplayName,
    getFocusedSurface,
    publishPresence: (payload) => sendBrowserControlMessage(payload).then(() => true),
    subscribeForcedRepublish: (publishPresence) => onBrowserAuthenticated(publishPresence),
    syncFocusedTypingLease: syncFocusedTypingTaskCommandLease,
  });
}
