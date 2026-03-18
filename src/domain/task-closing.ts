import type { Task, Terminal } from '../store/types.js';

type TaskClosingLike = Pick<Task, 'closingStatus' | 'directMode'> | null | undefined;
type TerminalClosingLike = Pick<Terminal, 'closingStatus'> | null | undefined;

export function hasTaskClosingState(task: TaskClosingLike): boolean {
  return task?.closingStatus !== undefined;
}

export function isTaskClosing(task: TaskClosingLike): boolean {
  return task?.closingStatus === 'closing';
}

export function isTaskRemoving(task: TaskClosingLike): boolean {
  return task?.closingStatus === 'removing';
}

export function isTaskCloseErrored(task: TaskClosingLike): boolean {
  return task?.closingStatus === 'error';
}

export function isTaskCloseInProgress(task: TaskClosingLike): boolean {
  return isTaskClosing(task) || isTaskRemoving(task);
}

export function blocksNewDirectModeTask(task: TaskClosingLike): boolean {
  return task?.directMode === true && !isTaskRemoving(task);
}

export function hasProjectDirectModeTask(
  taskIds: ReadonlyArray<string>,
  tasks: Record<string, Task | undefined>,
  projectId: string,
): boolean {
  return taskIds.some((taskId) => {
    const task = tasks[taskId];
    return task?.projectId === projectId && blocksNewDirectModeTask(task);
  });
}

export function isTerminalClosing(terminal: TerminalClosingLike): boolean {
  return terminal?.closingStatus === 'closing';
}

export function isTerminalRemoving(terminal: TerminalClosingLike): boolean {
  return terminal?.closingStatus === 'removing';
}

export function isTerminalCloseInProgress(terminal: TerminalClosingLike): boolean {
  return isTerminalClosing(terminal) || isTerminalRemoving(terminal);
}
