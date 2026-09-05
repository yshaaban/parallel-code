import { IPC } from '../../electron/ipc/channels.js';
import type {
  ListTaskCreationReconciliationsRequest,
  ListTaskCreationReconciliationsResult,
} from '../../electron/ipc/task-creation-local-reconciliation.js';
import type {
  TaskCreationReconciliationAction,
  TaskCreationReconciliationActionResult,
} from '../../electron/ipc/task-creation-reconciliation.js';
import type { TaskCreationOperationId } from '../domain/task-creation-ticket.js';
import { invokeOnce, isElectronRuntime } from '../lib/ipc.js';

function requireDesktopRuntime(): void {
  if (!isElectronRuntime()) {
    throw new Error('Task-creation reconciliation is available only in the local desktop app');
  }
}

export async function listTaskCreationReconciliations(
  request: Readonly<ListTaskCreationReconciliationsRequest> = {},
): Promise<ListTaskCreationReconciliationsResult> {
  requireDesktopRuntime();
  return invokeOnce(IPC.ListTaskCreationReconciliations, request);
}

export async function inspectTaskCreationReconciliation(
  operationId: TaskCreationOperationId,
): Promise<TaskCreationReconciliationActionResult> {
  return executeTaskCreationReconciliation({ kind: 'inspect', operationId });
}

export async function executeTaskCreationReconciliation(
  action: TaskCreationReconciliationAction,
): Promise<TaskCreationReconciliationActionResult> {
  requireDesktopRuntime();
  return invokeOnce(IPC.ExecuteTaskCreationReconciliation, action);
}
