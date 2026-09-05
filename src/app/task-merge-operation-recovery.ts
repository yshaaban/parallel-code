import { IPC } from '../../electron/ipc/channels';
import type { RendererInvokeResponseMap } from '../domain/renderer-invoke';
import { isTerminalTaskMergePhase } from '../domain/task-merge';
import { invokeOnce } from '../lib/ipc';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { showNotification } from '../store/notification';
import { store } from '../store/state';
import { applyMergeProgressSnapshot } from './merge-progress';
import {
  listRetainedTaskMergeOperations,
  releaseRetainedTaskMergeOperations,
  type RetainedTaskMergeOperation,
} from './task-merge-operation-access';

const STATUS_JOIN_CONCURRENCY = 4;
const FINALIZER_REPAIR_NOTIFICATION =
  'Task merged. Backend cleanup finalizers will continue automatically.';

type TaskMergeStatus = RendererInvokeResponseMap[IPC.GetTaskMergeOperationStatus];

export function notifyTaskMergeFinalizerRepair(): void {
  showNotification(FINALIZER_REPAIR_NOTIFICATION);
}

export interface TaskMergeOperationRecoveryDependencies {
  applyProgress(status: TaskMergeStatus): void;
  getStatus(retained: RetainedTaskMergeOperation): Promise<TaskMergeStatus>;
  hasCanonicalTask(taskId: string): boolean;
  listRetained(): RetainedTaskMergeOperation[];
  notifyFinalizerRepair(): void;
  onFailure(taskId: string, error: unknown): void;
  release(
    operations: ReadonlyArray<Readonly<{ operationId: string; taskId: string }>>,
  ): ReadonlySet<string>;
}

export interface TaskMergeOperationRecoveryResult {
  checked: number;
  cleared: number;
  failed: number;
  pending: number;
}

const productionDependencies: TaskMergeOperationRecoveryDependencies = {
  applyProgress: (status) => applyMergeProgressSnapshot(status.currentProgress),
  getStatus: (retained) =>
    invokeOnce(IPC.GetTaskMergeOperationStatus, {
      access: retained.access,
      controllerId: getRuntimeClientId(),
    }),
  hasCanonicalTask: (taskId) => store.tasks[taskId] !== undefined,
  listRetained: listRetainedTaskMergeOperations,
  notifyFinalizerRepair: notifyTaskMergeFinalizerRepair,
  onFailure: (taskId, error) => {
    console.warn(`Failed to reconcile retained merge operation for task ${taskId}:`, error);
  },
  release: releaseRetainedTaskMergeOperations,
};

interface TerminalRecoveryJoin {
  retained: RetainedTaskMergeOperation;
  status: TaskMergeStatus;
}

async function recoverOne(
  retained: RetainedTaskMergeOperation,
  dependencies: TaskMergeOperationRecoveryDependencies,
  result: TaskMergeOperationRecoveryResult,
): Promise<TerminalRecoveryJoin | null> {
  const taskId = retained.semanticRequest.taskId;
  try {
    const status = await dependencies.getStatus(retained);
    dependencies.applyProgress(status);
    if (!isTerminalTaskMergePhase(status.originalOutcome.phase)) {
      result.pending += 1;
      return null;
    }
    return { retained, status };
  } catch (error) {
    result.failed += 1;
    dependencies.onFailure(taskId, error);
    return null;
  }
}

/**
 * Status-join retained credentials only after their task is absent from canonical workspace truth.
 * Absence selects recovery candidates; terminal backend truth is still required before clearing.
 */
export async function recoverAbsentRetainedTaskMergeOperations(
  dependencies: TaskMergeOperationRecoveryDependencies = productionDependencies,
): Promise<TaskMergeOperationRecoveryResult> {
  const retained = dependencies
    .listRetained()
    .filter((entry) => !dependencies.hasCanonicalTask(entry.semanticRequest.taskId));
  const result: TaskMergeOperationRecoveryResult = {
    checked: retained.length,
    cleared: 0,
    failed: 0,
    pending: 0,
  };
  let nextIndex = 0;
  const terminalJoins: TerminalRecoveryJoin[] = [];

  async function worker(): Promise<void> {
    while (nextIndex < retained.length) {
      const entry = retained[nextIndex];
      nextIndex += 1;
      if (entry) {
        const terminalJoin = await recoverOne(entry, dependencies, result);
        if (terminalJoin) terminalJoins.push(terminalJoin);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(STATUS_JOIN_CONCURRENCY, retained.length) }, () => worker()),
  );
  const releasedTaskIds =
    terminalJoins.length === 0
      ? new Set<string>()
      : dependencies.release(
          terminalJoins.map(({ retained: entry }) => ({
            operationId: entry.access.operationId,
            taskId: entry.semanticRequest.taskId,
          })),
        );
  result.cleared = releasedTaskIds.size;
  if (
    terminalJoins.some(
      ({ retained: entry, status }) =>
        releasedTaskIds.has(entry.semanticRequest.taskId) &&
        status.currentRemoval?.removalState === 'finalizer-repair-pending',
    )
  ) {
    dependencies.notifyFinalizerRepair();
  }
  return result;
}

let activeRecovery: Promise<void> | null = null;
let recoveryRequested = false;

/** Coalesce startup/workspace-event triggers while preserving one rerun requested during a join. */
export function reconcileRetainedTaskMergeOperations(): Promise<void> {
  recoveryRequested = true;
  if (activeRecovery) return activeRecovery;

  activeRecovery = (async () => {
    do {
      recoveryRequested = false;
      await recoverAbsentRetainedTaskMergeOperations();
    } while (recoveryRequested);
  })().finally(() => {
    activeRecovery = null;
  });
  return activeRecovery;
}

export function resetTaskMergeOperationRecoveryForTests(): void {
  activeRecovery = null;
  recoveryRequested = false;
}
