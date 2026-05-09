import { IPC } from './channels.js';
import type { IpcHandlerMap } from './handlers.js';
import { validatePath } from './path-utils.js';
import {
  exposeTaskPort,
  getTaskPortExposureCandidates,
  getTaskPortSnapshots,
  revalidateTaskPortPreview,
  unexposeTaskPort,
} from './task-ports.js';
import { defineIpcHandler } from './typed-handler.js';
import { assertOptionalString, assertString, assertTcpPortNumber } from './validate.js';

export function createTaskPortIpcHandlers(): IpcHandlerMap {
  return {
    [IPC.GetTaskPorts]: () => getTaskPortSnapshots(),
    [IPC.ExposePort]: defineIpcHandler<IPC.ExposePort>(IPC.ExposePort, (args) => {
      const request = args;
      assertString(request.taskId, 'taskId');
      assertTcpPortNumber(request.port, 'port');
      assertOptionalString(request.label, 'label');
      return exposeTaskPort(request.taskId, request.port, request.label);
    }),
    [IPC.GetTaskPortExposureCandidates]: defineIpcHandler<IPC.GetTaskPortExposureCandidates>(
      IPC.GetTaskPortExposureCandidates,
      (args) => {
        const request = args;
        assertString(request.taskId, 'taskId');
        assertString(request.worktreePath, 'worktreePath');
        validatePath(request.worktreePath, 'worktreePath');
        return getTaskPortExposureCandidates(request.taskId, request.worktreePath);
      },
    ),
    [IPC.RefreshTaskPortPreview]: defineIpcHandler<IPC.RefreshTaskPortPreview>(
      IPC.RefreshTaskPortPreview,
      async (args) => {
        const request = args;
        assertString(request.taskId, 'taskId');
        assertTcpPortNumber(request.port, 'port');
        return revalidateTaskPortPreview(request.taskId, request.port);
      },
    ),
    [IPC.UnexposePort]: defineIpcHandler<IPC.UnexposePort>(IPC.UnexposePort, (args) => {
      const request = args;
      assertString(request.taskId, 'taskId');
      assertTcpPortNumber(request.port, 'port');
      return unexposeTaskPort(request.taskId, request.port);
    }),
  };
}
