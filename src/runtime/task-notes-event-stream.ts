import {
  isTaskNotesChangedNotification,
  type TaskNotesChangedNotification,
} from '../domain/task-notes.js';

export type TaskNotesChangedListener = (notification: TaskNotesChangedNotification) => void;

/** One content-free host stream; transports subscribe without becoming event-policy owners. */
export function createTaskNotesEventStream() {
  const listeners = new Set<TaskNotesChangedListener>();

  return Object.freeze({
    publish(value: unknown): boolean {
      if (!isTaskNotesChangedNotification(value)) return false;
      for (const listener of listeners) {
        try {
          listener(value);
        } catch {
          // A disconnected projection is repaired by its reconnect Get. It must not prevent
          // another projection from receiving the same durable invalidation.
        }
      }
      return true;
    },
    subscribe(listener: TaskNotesChangedListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export type TaskNotesEventStream = ReturnType<typeof createTaskNotesEventStream>;
