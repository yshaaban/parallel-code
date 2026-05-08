import { IPC } from './channels.js';
import type { IpcHandler } from './handler-context.js';
import { listTaskReviewSignalsSnapshots } from './task-review-signals.js';

export function createTaskReviewSignalsIpcHandlers(): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.GetTaskReviewSignals]: () => listTaskReviewSignalsSnapshots(),
  };
}
