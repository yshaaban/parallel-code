import type { TaskNotesCapability } from '../domain/task-notes';

export type { TaskNotesCapability } from '../domain/task-notes';

export function createTaskNotesCapability(
  read: boolean,
  write: boolean,
): Readonly<TaskNotesCapability> {
  return Object.freeze({ read, write: read && write });
}

/** Startup advertises nothing until the backend's common Notes barrier is ready. */
export const DESKTOP_TASK_NOTES_CAPABILITY = createTaskNotesCapability(false, false);

/** Remote views remain unavailable unless the authenticated host advertises exact commands. */
export const UNAVAILABLE_TASK_NOTES_CAPABILITY = DESKTOP_TASK_NOTES_CAPABILITY;
