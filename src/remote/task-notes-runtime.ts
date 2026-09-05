import { TaskNotesRegistry } from '../components/task-notes/task-notes-registry';
import type { TaskNotesController } from '../components/task-notes/task-notes-controller';
import { remoteTaskNotesTransport } from './remote-ipc';
import { getRemoteClientId } from './client-id';
import { subscribeRemoteConnectionStatus } from './ws';
import {
  registerRemoteTaskNotesLifecycleOwner,
  type RemoteTaskNotesCatalogLifecycle,
} from './task-notes-lifecycle-channel';

export type { RemoteTaskNotesCatalogLifecycle } from './task-notes-lifecycle-channel';

const navigationListeners = new Map<string, Set<() => void>>();
const catalogLifecycleByTask = new Map<string, RemoteTaskNotesCatalogLifecycle>();
const remoteTaskNotesRegistry = new TaskNotesRegistry({
  onNavigateTaskList: (taskId) => {
    remoteTaskNotesRegistry.remove(taskId);
    catalogLifecycleByTask.delete(taskId);
    for (const listener of navigationListeners.get(taskId) ?? []) listener();
  },
  sourceId: getRemoteClientId(),
});
let wasConnected = false;

subscribeRemoteConnectionStatus((status) => {
  const connected = status === 'connected';
  if (connected && !wasConnected) remoteTaskNotesRegistry.refreshMounted();
  wasConnected = connected;
});

export function mountRemoteTaskNotes(taskId: string) {
  return remoteTaskNotesRegistry.mount(taskId, remoteTaskNotesTransport);
}

export function hasUnsavedRemoteTaskNotes(taskId: string): boolean {
  return remoteTaskNotesRegistry.hasUnsaved(taskId);
}

export function registerRemoteTaskNotesNavigation(
  taskId: string,
  listener: () => void,
): () => void {
  let listeners = navigationListeners.get(taskId);
  if (!listeners) {
    listeners = new Set();
    navigationListeners.set(taskId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = navigationListeners.get(taskId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) navigationListeners.delete(taskId);
  };
}

function getLoadedTaskIncarnation(controller: TaskNotesController): string | null {
  const state = controller.state;
  if ('base' in state && state.base) return state.base.taskIncarnation;
  if (state.kind === 'closing' && state.currentTask.taskState === 'present') {
    return state.currentTask.taskIncarnation;
  }
  return null;
}

export function applyRemoteTaskNotesCatalogLifecycle(
  taskId: string,
  lifecycle: RemoteTaskNotesCatalogLifecycle,
): void {
  const controller = remoteTaskNotesRegistry.get(taskId);
  if (!controller) return;
  const previous = catalogLifecycleByTask.get(taskId);
  if (
    previous?.serverInstanceId === lifecycle.serverInstanceId &&
    lifecycle.catalogVersion < previous.catalogVersion
  ) {
    return;
  }
  catalogLifecycleByTask.set(taskId, lifecycle);

  if (lifecycle.taskState === 'removed') {
    controller.applyLifecycle(lifecycle);
    return;
  }
  if (
    previous &&
    (previous.serverInstanceId !== lifecycle.serverInstanceId || previous.taskState === 'removed')
  ) {
    controller.checkStatus();
    return;
  }
  const taskIncarnation = getLoadedTaskIncarnation(controller);
  if (!taskIncarnation) return;
  controller.applyLifecycle({ ...lifecycle, taskIncarnation });
}

export function confirmRemoteTaskNotesLeave(
  taskId: string,
  message: string,
  confirm: (message: string) => boolean,
): boolean {
  if (remoteTaskNotesRegistry.hasUnsaved(taskId) && !confirm(message)) return false;
  remoteTaskNotesRegistry.remove(taskId);
  catalogLifecycleByTask.delete(taskId);
  return true;
}

registerRemoteTaskNotesLifecycleOwner((taskId, lifecycle) => {
  applyRemoteTaskNotesCatalogLifecycle(taskId, lifecycle);
  return hasUnsavedRemoteTaskNotes(taskId);
});
