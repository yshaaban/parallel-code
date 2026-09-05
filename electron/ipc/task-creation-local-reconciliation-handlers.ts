import { IPC } from './channels.js';
import { BadRequestError } from './errors.js';
import type { IpcHandlerMap } from './handlers.js';
import { isListTaskCreationReconciliationsRequest } from './task-creation-local-reconciliation.js';
import { isTaskCreationReconciliationAction } from './task-creation-reconciliation.js';
import type { ProductionTaskExperienceRuntime } from './task-experience-runtime-composition.js';
import { defineIpcHandler } from './typed-handler.js';

function requireRequest<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
  label: string,
): T {
  if (!guard(value)) throw new BadRequestError(`Invalid ${label} request`);
  return value;
}

/**
 * Electron-only adapter. It injects the composition-owned authority and never
 * accepts an actor, grant, or authority token from renderer request data.
 */
export function createTaskCreationLocalReconciliationIpcHandlers(
  runtime: ProductionTaskExperienceRuntime,
): IpcHandlerMap {
  const command = runtime.localReconciliation.electronMain;
  return {
    [IPC.ListTaskCreationReconciliations]: defineIpcHandler(
      IPC.ListTaskCreationReconciliations,
      (request) =>
        command.list(
          requireRequest(
            request,
            isListTaskCreationReconciliationsRequest,
            'task-creation reconciliation list',
          ),
        ),
    ),
    [IPC.ExecuteTaskCreationReconciliation]: defineIpcHandler(
      IPC.ExecuteTaskCreationReconciliation,
      (request) =>
        command.execute(
          requireRequest(
            request,
            isTaskCreationReconciliationAction,
            'task-creation reconciliation action',
          ),
        ),
    ),
  };
}
