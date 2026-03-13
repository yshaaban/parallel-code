import { IPC } from './channels.js';
import type { IpcHandler } from './handler-context.js';
import { listTaskConvergenceSnapshots } from './task-convergence-state.js';

export function createTaskConvergenceIpcHandlers(): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.GetTaskConvergence]: () => listTaskConvergenceSnapshots(),
  };
}
