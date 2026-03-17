import { IPC } from './channels.js';
import type { HandlerContext, IpcHandler } from './handler-context.js';
import {
  acquireTaskCommandLease,
  getTaskCommandControllers,
  releaseTaskCommandLease,
  renewTaskCommandLease,
} from './task-command-leases.js';
import { defineIpcHandler } from './typed-handler.js';
import { assertOptionalBoolean, assertString } from './validate.js';

function emitTaskCommandControllerChanged(
  context: HandlerContext,
  payload: {
    action: string | null;
    controllerId: string | null;
    taskId: string;
  },
): void {
  context.emitIpcEvent?.(IPC.TaskCommandControllerChanged, payload);
}

export function createTaskCommandLeaseIpcHandlers(
  context: HandlerContext,
): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.AcquireTaskCommandLease]: defineIpcHandler<IPC.AcquireTaskCommandLease>(
      IPC.AcquireTaskCommandLease,
      (args) => {
        const request = args;
        assertString(request.action, 'action');
        assertString(request.clientId, 'clientId');
        assertString(request.taskId, 'taskId');
        assertOptionalBoolean(request.takeover, 'takeover');

        const result = acquireTaskCommandLease(
          request.taskId,
          request.clientId,
          request.action,
          request.takeover ?? false,
        );
        if (result.changed) {
          emitTaskCommandControllerChanged(context, {
            action: result.action,
            controllerId: result.controllerId,
            taskId: result.taskId,
          });
        }
        return result;
      },
    ),

    [IPC.RenewTaskCommandLease]: defineIpcHandler<IPC.RenewTaskCommandLease>(
      IPC.RenewTaskCommandLease,
      (args) => {
        const request = args;
        assertString(request.clientId, 'clientId');
        assertString(request.taskId, 'taskId');
        return renewTaskCommandLease(request.taskId, request.clientId);
      },
    ),

    [IPC.ReleaseTaskCommandLease]: defineIpcHandler<IPC.ReleaseTaskCommandLease>(
      IPC.ReleaseTaskCommandLease,
      (args) => {
        const request = args;
        assertString(request.clientId, 'clientId');
        assertString(request.taskId, 'taskId');

        const result = releaseTaskCommandLease(request.taskId, request.clientId);
        if (result.changed) {
          emitTaskCommandControllerChanged(context, result.snapshot);
        }
        return result.snapshot;
      },
    ),

    [IPC.GetTaskCommandControllers]: () => {
      return getTaskCommandControllers();
    },
  };
}
