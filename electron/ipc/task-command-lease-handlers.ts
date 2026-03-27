import { IPC } from './channels.js';
import type { HandlerContext, IpcHandler } from './handler-context.js';
import {
  acquireTaskCommandLease,
  getTaskCommandControllerStateVersion,
  getTaskCommandControllers,
  releaseTaskCommandLease,
  renewTaskCommandLease,
} from './task-command-leases.js';
import { defineIpcHandler } from './typed-handler.js';
import { assertOptionalBoolean, assertOptionalInt, assertString } from './validate.js';
import type { TaskCommandControllerSnapshot } from '../../src/domain/server-state.js';

function emitTaskCommandControllerChanged(
  context: HandlerContext,
  payload: TaskCommandControllerSnapshot,
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
        assertString(request.ownerId, 'ownerId');
        assertString(request.taskId, 'taskId');
        assertOptionalBoolean(request.takeover, 'takeover');

        const result = acquireTaskCommandLease(
          request.taskId,
          request.clientId,
          request.ownerId,
          request.action,
          request.takeover ?? false,
        );
        if (result.changed) {
          emitTaskCommandControllerChanged(context, {
            action: result.action,
            controllerId: result.controllerId,
            taskId: result.taskId,
            version: result.version,
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
        assertString(request.ownerId, 'ownerId');
        assertString(request.taskId, 'taskId');
        assertOptionalInt(request.leaseGeneration, 'leaseGeneration');
        return renewTaskCommandLease(
          request.taskId,
          request.clientId,
          request.ownerId,
          Date.now(),
          request.leaseGeneration,
        );
      },
    ),

    [IPC.ReleaseTaskCommandLease]: defineIpcHandler<IPC.ReleaseTaskCommandLease>(
      IPC.ReleaseTaskCommandLease,
      (args) => {
        const request = args;
        assertString(request.clientId, 'clientId');
        assertString(request.ownerId, 'ownerId');
        assertString(request.taskId, 'taskId');
        assertOptionalInt(request.leaseGeneration, 'leaseGeneration');

        const result = releaseTaskCommandLease(
          request.taskId,
          request.clientId,
          request.ownerId,
          Date.now(),
          request.leaseGeneration,
        );
        if (result.changed) {
          emitTaskCommandControllerChanged(context, result.snapshot);
        }
        return result.snapshot;
      },
    ),

    [IPC.GetTaskCommandControllers]: () => {
      return {
        controllers: getTaskCommandControllers(),
        version: getTaskCommandControllerStateVersion(),
      };
    },
  };
}
