import { setStore } from '../store/state';
import type { TaskCloseState } from '../store/types';

export function setTaskCloseState(taskId: string, closeState: TaskCloseState | undefined): void {
  setStore('tasks', taskId, 'closeState', closeState);
}

export function markTaskClosing(taskId: string): void {
  setTaskCloseState(taskId, { kind: 'closing' });
}

export function markTaskRemoving(taskId: string): void {
  setTaskCloseState(taskId, { kind: 'removing' });
}

export function markTaskCloseError(taskId: string, message: string): void {
  setTaskCloseState(taskId, { kind: 'error', message });
}

export function clearTaskCloseState(taskId: string): void {
  setTaskCloseState(taskId, undefined);
}
