import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MERGE_PROGRESS_SCHEMA_VERSION } from '../../src/domain/task-merge.js';
import {
  COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION,
  MergeProgressCommitContextError,
  commitCompletedMergeProgress,
  readMergeProgressSnapshot,
} from './merge-progress.js';
import type { JsonObject } from './workspace-state-storage.js';

const COMMITTED_AT = new Date('2026-08-04T10:00:00.000Z');

function stateAfterRemoval(overrides: JsonObject = {}): JsonObject {
  return {
    collapsedTaskOrder: [],
    completedTaskCount: 2,
    completedTaskDate: '2026-08-04',
    mergedLinesAdded: 10,
    mergedLinesRemoved: 4,
    taskOrder: [],
    tasks: {},
    ...overrides,
  };
}

describe('completed merge progress extension', () => {
  it('uses the fixed internal extension discriminator', () => {
    expect(COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION).toBe('commit-completed-merge-progress-v1');
  });

  it('atomically returns progress, marker, and rollback-window legacy projections', () => {
    const state = stateAfterRemoval();
    const result = commitCompletedMergeProgress({
      committedAt: COMMITTED_AT,
      linesAdded: 7,
      linesRemoved: 1,
      operationId: 'merge-operation-1',
      removedTask: { id: 'task-1', name: 'Removed' },
      stateAfterRemoval: state,
    });

    expect(result.changed).toBe(true);
    expect(result.progress).toEqual({
      schemaVersion: MERGE_PROGRESS_SCHEMA_VERSION,
      version: 2,
      dateKey: '2026-08-04',
      tasksToday: 3,
      linesAdded: 17,
      linesRemoved: 5,
      updatedAt: COMMITTED_AT.toISOString(),
    });
    expect(result.marker).toEqual({
      committedAt: COMMITTED_AT.toISOString(),
      operationId: 'merge-operation-1',
      progressVersion: 2,
      taskId: 'task-1',
    });
    expect(result.nextSharedState).toMatchObject({
      committedMergeOperationId: 'merge-operation-1',
      completedTaskCount: 3,
      completedTaskDate: '2026-08-04',
      mergeOperation: result.marker,
      mergeProgress: result.progress,
      mergedLinesAdded: 17,
      mergedLinesRemoved: 5,
    });
    expect(state).toEqual(stateAfterRemoval());
  });

  it('counts a zero-line merge and resets the daily value at commit-time date rollover', () => {
    const result = commitCompletedMergeProgress({
      committedAt: COMMITTED_AT,
      linesAdded: 0,
      linesRemoved: 0,
      operationId: 'merge-operation-2',
      removedTask: { id: 'task-2' },
      stateAfterRemoval: stateAfterRemoval({
        completedTaskCount: 99,
        completedTaskDate: '2026-08-03',
      }),
    });

    expect(result.progress).toMatchObject({
      dateKey: '2026-08-04',
      tasksToday: 1,
      linesAdded: 10,
      linesRemoved: 4,
    });
  });

  it('returns an idempotent no-op for the exact committed marker', () => {
    const first = commitCompletedMergeProgress({
      committedAt: COMMITTED_AT,
      linesAdded: 7,
      linesRemoved: 1,
      operationId: 'merge-operation-1',
      removedTask: { id: 'task-1' },
      stateAfterRemoval: stateAfterRemoval(),
    });

    const replay = commitCompletedMergeProgress({
      committedAt: new Date('2026-08-05T10:00:00.000Z'),
      linesAdded: 999,
      linesRemoved: 999,
      operationId: 'merge-operation-1',
      removedTask: { id: 'task-1' },
      stateAfterRemoval: first.nextSharedState,
    });

    expect(replay).toEqual({
      changed: false,
      marker: first.marker,
      nextSharedState: first.nextSharedState,
      progress: first.progress,
    });

    const laterOperation = commitCompletedMergeProgress({
      committedAt: new Date('2026-08-04T11:00:00.000Z'),
      linesAdded: 2,
      linesRemoved: 0,
      operationId: 'merge-operation-2',
      removedTask: { id: 'task-2' },
      stateAfterRemoval: first.nextSharedState,
    });
    expect(laterOperation).toMatchObject({
      changed: true,
      marker: { operationId: 'merge-operation-2', progressVersion: 3, taskId: 'task-2' },
      progress: { version: 3, tasksToday: 4, linesAdded: 19, linesRemoved: 5 },
    });
  });

  it('rejects structural ownership violations and inconsistent committed evidence', () => {
    for (const invalidState of [
      stateAfterRemoval({ tasks: { 'task-1': { id: 'task-1' } } }),
      stateAfterRemoval({ taskOrder: ['task-1'] }),
      stateAfterRemoval({ collapsedTaskOrder: ['task-1'] }),
    ]) {
      expect(() =>
        commitCompletedMergeProgress({
          committedAt: COMMITTED_AT,
          linesAdded: 1,
          linesRemoved: 1,
          operationId: 'merge-operation-1',
          removedTask: { id: 'task-1' },
          stateAfterRemoval: invalidState,
        }),
      ).toThrow(MergeProgressCommitContextError);
    }

    expect(() =>
      commitCompletedMergeProgress({
        committedAt: COMMITTED_AT,
        linesAdded: 1,
        linesRemoved: 1,
        operationId: 'merge-operation-1',
        removedTask: { id: 'task-1' },
        stateAfterRemoval: stateAfterRemoval({
          committedMergeOperationId: 'merge-operation-1',
          mergeOperation: {
            committedAt: COMMITTED_AT.toISOString(),
            operationId: 'merge-operation-1',
            progressVersion: 9,
            taskId: 'task-1',
          },
          mergeProgress: {
            schemaVersion: 1,
            version: 2,
            dateKey: '2026-08-04',
            tasksToday: 3,
            linesAdded: 17,
            linesRemoved: 5,
            updatedAt: COMMITTED_AT.toISOString(),
          },
        }),
      }),
    ).toThrow(MergeProgressCommitContextError);

    expect(() =>
      commitCompletedMergeProgress({
        committedAt: COMMITTED_AT,
        linesAdded: 1,
        linesRemoved: 1,
        operationId: 'merge-operation-1',
        removedTask: { id: 'task-1' },
        stateAfterRemoval: stateAfterRemoval({
          committedMergeOperationId: 'merge-operation-1',
          mergeOperation: {
            committedAt: COMMITTED_AT.toISOString(),
            operationId: 'merge-operation-1',
            progressVersion: 1,
            taskId: 'task-1',
          },
        }),
      }),
    ).toThrow('missing its canonical progress snapshot');
  });

  it('seeds only from legacy fields when canonical progress is absent', () => {
    expect(readMergeProgressSnapshot(stateAfterRemoval(), COMMITTED_AT)).toEqual({
      schemaVersion: 1,
      version: 1,
      dateKey: '2026-08-04',
      tasksToday: 2,
      linesAdded: 10,
      linesRemoved: 4,
      updatedAt: COMMITTED_AT.toISOString(),
    });
    expect(() =>
      readMergeProgressSnapshot(
        stateAfterRemoval({ mergeProgress: { version: 'corrupt' } }),
        COMMITTED_AT,
      ),
    ).toThrow(MergeProgressCommitContextError);
  });

  it('has no filesystem, Git, cleanup, removal, or mutation-service dependency', () => {
    const source = fs.readFileSync(new URL('./merge-progress.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(
      /node:fs|git-mutation|task-structure|task-removal|WorkspaceMutationService/,
    );
  });
});
