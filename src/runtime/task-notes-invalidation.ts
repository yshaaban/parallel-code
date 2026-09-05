import {
  isTaskNotesChangedNotification,
  type TaskNotesChangedNotification,
} from '../domain/task-notes';

type TaskNotesInvalidationListener = (notification: TaskNotesChangedNotification) => void;

const listenersByTaskId = new Map<string, Set<TaskNotesInvalidationListener>>();

export function publishTaskNotesInvalidation(value: unknown): boolean {
  if (!isTaskNotesChangedNotification(value)) return false;
  for (const listener of listenersByTaskId.get(value.taskId) ?? []) listener(value);
  return true;
}

export function subscribeTaskNotesInvalidation(
  taskId: string,
  listener: TaskNotesInvalidationListener,
): () => void {
  const listeners = listenersByTaskId.get(taskId) ?? new Set<TaskNotesInvalidationListener>();
  listeners.add(listener);
  listenersByTaskId.set(taskId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByTaskId.delete(taskId);
  };
}

export function resetTaskNotesInvalidationsForTests(): void {
  listenersByTaskId.clear();
}
