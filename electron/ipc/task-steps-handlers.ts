import { IPC } from './channels.js';
import type { IpcHandler } from './handler-context.js';
import { getTaskStepsSnapshot } from './task-steps.js';
import { defineIpcHandler } from './typed-handler.js';
import { assertString } from './validate.js';

export function createTaskStepsIpcHandlers(): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.GetTaskStepsSnapshot]: defineIpcHandler<IPC.GetTaskStepsSnapshot>(
      IPC.GetTaskStepsSnapshot,
      (args) => {
        assertString(args.taskId, 'taskId');
        return getTaskStepsSnapshot(args.taskId);
      },
    ),
  };
}
