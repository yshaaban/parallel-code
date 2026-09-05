import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../electron/ipc/channels';
import type { RendererInvokeResponseMap } from '../domain/renderer-invoke';
import {
  listRetainedTaskMergeOperations,
  releaseRetainedTaskMergeOperations,
  resetRetainedTaskMergeOperationsForTests,
  retainTaskMergeOperation,
} from './task-merge-operation-access';
import {
  recoverAbsentRetainedTaskMergeOperations,
  resetTaskMergeOperationRecoveryForTests,
  type TaskMergeOperationRecoveryDependencies,
} from './task-merge-operation-recovery';

type TaskMergeStatus = RendererInvokeResponseMap[IPC.GetTaskMergeOperationStatus];

const RETAINED_RECOVERY_PHASES = [
  'merged-awaiting-removal',
  'manual-reconciliation-required',
] as const;

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function terminalStatus(
  taskId: string,
  operationId: string,
  removalState: 'complete' | 'finalizer-repair-pending' = 'complete',
): TaskMergeStatus {
  return {
    currentProgress: {
      dateKey: '2026-08-04',
      linesAdded: 3,
      linesRemoved: 0,
      schemaVersion: 1,
      tasksToday: 1,
      updatedAt: '2026-08-04T00:00:00.000Z',
      version: 1,
    },
    currentRemoval: {
      deletionOperationId: operationId,
      removed: true,
      removalState,
      taskId,
    },
    originalOutcome: {
      cleanupRequested: true,
      counted: true,
      gitMerged: true,
      operationId,
      phase: 'completed',
      progressVersionAtOutcome: 1,
      taskId,
      taskReleased: true,
      version: 4,
    },
    replayed: true,
  };
}

function dependencies(
  overrides: Partial<TaskMergeOperationRecoveryDependencies> = {},
): TaskMergeOperationRecoveryDependencies {
  return {
    applyProgress: vi.fn(),
    getStatus: vi.fn(),
    hasCanonicalTask: () => false,
    listRetained: () => [],
    notifyFinalizerRepair: vi.fn(),
    onFailure: vi.fn(),
    release: vi.fn(
      (
        operations: ReadonlyArray<Readonly<{ operationId: string; taskId: string }>>,
      ): ReadonlySet<string> => new Set(operations.map(({ taskId }) => taskId)),
    ),
    ...overrides,
  };
}

describe('retained task merge operation recovery', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', createMemoryStorage());
    resetRetainedTaskMergeOperationsForTests();
    resetTaskMergeOperationRecoveryForTests();
  });

  it.each(RETAINED_RECOVERY_PHASES)(
    'keeps a canonically absent %s credential until backend truth is terminal',
    async (phase) => {
      const retained = {
        access: { operationCapability: 'capability-1', operationId: 'operation-1' },
        semanticRequest: { cleanup: true, squash: false, taskId: 'task-1' },
      } as const;
      const pending = terminalStatus('task-1', 'operation-1');
      pending.originalOutcome.phase = phase;
      pending.originalOutcome.counted = false;
      pending.originalOutcome.taskReleased = false;
      const recovery = dependencies({
        getStatus: vi.fn().mockResolvedValue(pending),
        listRetained: () => [retained],
      });

      await expect(recoverAbsentRetainedTaskMergeOperations(recovery)).resolves.toEqual({
        checked: 1,
        cleared: 0,
        failed: 0,
        pending: 1,
      });
      expect(recovery.applyProgress).toHaveBeenCalledWith(pending);
      expect(recovery.release).not.toHaveBeenCalled();
      expect(recovery.notifyFinalizerRepair).not.toHaveBeenCalled();
    },
  );

  it('does not status-join while the task remains in canonical workspace truth', async () => {
    const recovery = dependencies({
      hasCanonicalTask: () => true,
      listRetained: () => [
        {
          access: { operationCapability: 'capability-1', operationId: 'operation-1' },
          semanticRequest: { cleanup: true, squash: false, taskId: 'task-1' },
        },
      ],
    });

    await expect(recoverAbsentRetainedTaskMergeOperations(recovery)).resolves.toEqual({
      checked: 0,
      cleared: 0,
      failed: 0,
      pending: 0,
    });
    expect(recovery.getStatus).not.toHaveBeenCalled();
  });

  it('retains access when an absent-task status join is unavailable', async () => {
    const error = new Error('temporarily unavailable');
    const recovery = dependencies({
      getStatus: vi.fn().mockRejectedValue(error),
      listRetained: () => [
        {
          access: { operationCapability: 'capability-1', operationId: 'operation-1' },
          semanticRequest: { cleanup: true, squash: false, taskId: 'task-1' },
        },
      ],
    });

    await expect(recoverAbsentRetainedTaskMergeOperations(recovery)).resolves.toEqual({
      checked: 1,
      cleared: 0,
      failed: 1,
      pending: 0,
    });
    expect(recovery.release).not.toHaveBeenCalled();
    expect(recovery.onFailure).toHaveBeenCalledWith('task-1', error);
  });

  it('does not duplicate finalizer repair after another terminal consumer wins release', async () => {
    const recovery = dependencies({
      getStatus: vi
        .fn()
        .mockResolvedValue(terminalStatus('task-1', 'operation-1', 'finalizer-repair-pending')),
      listRetained: () => [
        {
          access: { operationCapability: 'capability-1', operationId: 'operation-1' },
          semanticRequest: { cleanup: true, squash: false, taskId: 'task-1' },
        },
      ],
      release: vi.fn().mockReturnValue(new Set()),
    });

    await expect(recoverAbsentRetainedTaskMergeOperations(recovery)).resolves.toEqual({
      checked: 1,
      cleared: 0,
      failed: 0,
      pending: 0,
    });
    expect(recovery.notifyFinalizerRepair).not.toHaveBeenCalled();
  });

  it('clears all 32 terminal lost-response credentials so the renderer cap is reusable', async () => {
    for (let index = 0; index < 32; index += 1) {
      expect(
        retainTaskMergeOperation(
          {
            operationCapability: `capability-${index}`,
            operationId: `operation-${index}`,
          },
          { cleanup: true, squash: false, taskId: `task-${index}` },
        ),
      ).toBe(true);
    }

    const notifyFinalizerRepair = vi.fn();
    const release = vi.fn(releaseRetainedTaskMergeOperations);
    const recovery = dependencies({
      getStatus: async (retained) =>
        terminalStatus(
          retained.semanticRequest.taskId,
          retained.access.operationId,
          retained.semanticRequest.taskId === 'task-0' ||
            retained.semanticRequest.taskId === 'task-1'
            ? 'finalizer-repair-pending'
            : 'complete',
        ),
      listRetained: listRetainedTaskMergeOperations,
      notifyFinalizerRepair,
      release,
    });
    const result = await recoverAbsentRetainedTaskMergeOperations(recovery);

    expect(result).toEqual({ checked: 32, cleared: 32, failed: 0, pending: 0 });
    expect(release).toHaveBeenCalledTimes(1);
    expect(listRetainedTaskMergeOperations()).toHaveLength(0);
    expect(notifyFinalizerRepair).toHaveBeenCalledTimes(1);
    await expect(recoverAbsentRetainedTaskMergeOperations(recovery)).resolves.toEqual({
      checked: 0,
      cleared: 0,
      failed: 0,
      pending: 0,
    });
    expect(notifyFinalizerRepair).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(
      retainTaskMergeOperation(
        { operationCapability: 'capability-next', operationId: 'operation-next' },
        { cleanup: true, squash: false, taskId: 'task-next' },
      ),
    ).toBe(true);
  });
});
