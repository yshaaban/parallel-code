import { IPC } from './channels.js';
import type { IpcHandler } from './handler-context.js';
import { BadRequestError } from './errors.js';
import { validatePath } from './path-utils.js';
import {
  exposeTaskPort,
  getTaskPortExposureCandidates,
  getTaskPortSnapshots,
  revalidateTaskPortPreview,
  unexposeTaskPort,
} from './task-ports.js';
import { assertInt, assertOptionalString, assertString } from './validate.js';

function assertValidPort(port: number): void {
  if (port < 1 || port > 65_535) {
    throw new BadRequestError('port must be between 1 and 65535');
  }
}

export function createTaskPortIpcHandlers(): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.GetTaskPorts]: () => getTaskPortSnapshots(),
    [IPC.ExposePort]: (args) => {
      const request = args ?? {};
      assertString(request.taskId, 'taskId');
      assertInt(request.port, 'port');
      assertOptionalString(request.label, 'label');
      assertValidPort(request.port);
      return exposeTaskPort(request.taskId, request.port, request.label);
    },
    [IPC.GetTaskPortExposureCandidates]: (args) => {
      const request = args ?? {};
      assertString(request.taskId, 'taskId');
      assertString(request.worktreePath, 'worktreePath');
      validatePath(request.worktreePath, 'worktreePath');
      return getTaskPortExposureCandidates(request.taskId, request.worktreePath);
    },
    [IPC.RefreshTaskPortPreview]: async (args) => {
      const request = args ?? {};
      assertString(request.taskId, 'taskId');
      assertInt(request.port, 'port');
      assertValidPort(request.port);
      return revalidateTaskPortPreview(request.taskId, request.port);
    },
    [IPC.UnexposePort]: (args) => {
      const request = args ?? {};
      assertString(request.taskId, 'taskId');
      assertInt(request.port, 'port');
      assertValidPort(request.port);
      return unexposeTaskPort(request.taskId, request.port);
    },
  };
}
