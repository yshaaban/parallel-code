import type { Task, Terminal } from '../store/types.js';

type TaskClosingLike = Pick<Task, 'closeState'> | null | undefined;
type TerminalClosingLike = Pick<Terminal, 'closingStatus'> | null | undefined;

export function hasTaskClosingState(task: TaskClosingLike): boolean {
  return task?.closeState !== undefined;
}

export function isTaskClosing(task: TaskClosingLike): boolean {
  return task?.closeState?.kind === 'closing';
}

export function isTaskRemoving(task: TaskClosingLike): boolean {
  return task?.closeState?.kind === 'removing';
}

export function isTaskCloseErrored(task: TaskClosingLike): boolean {
  return task?.closeState?.kind === 'error';
}

export function getTaskCloseError(task: TaskClosingLike): string | null {
  return task?.closeState?.kind === 'error' ? task.closeState.message : null;
}

export function isTaskCloseInProgress(task: TaskClosingLike): boolean {
  return isTaskClosing(task) || isTaskRemoving(task);
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
