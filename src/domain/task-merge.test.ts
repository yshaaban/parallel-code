import { describe, expect, it } from 'vitest';

import {
  MERGE_PROGRESS_SCHEMA_VERSION,
  MergeProgressOverflowError,
  advanceCompletedMergeProgress,
  getMergeProgressSnapshotDisposition,
  isMergeProgressDateKey,
  isMergeProgressSnapshot,
  isTaskMergeOperationSnapshot,
  isTaskMergeResultEnvelope,
  normalizeMergeProgressInteger,
  seedMergeProgressSnapshot,
  type MergeProgressSnapshot,
  type TaskMergeOperationSnapshot,
} from './task-merge';

const COMMIT_TIME = new Date('2026-08-04T09:30:00.000Z');

function progress(overrides: Partial<MergeProgressSnapshot> = {}): MergeProgressSnapshot {
  return {
    schemaVersion: MERGE_PROGRESS_SCHEMA_VERSION,
    version: 4,
    dateKey: '2026-08-04',
    tasksToday: 2,
    linesAdded: 10,
    linesRemoved: 3,
    updatedAt: '2026-08-04T08:00:00.000Z',
    ...overrides,
  };
}

function outcome(overrides: Partial<TaskMergeOperationSnapshot> = {}): TaskMergeOperationSnapshot {
  return {
    cleanupRequested: true,
    counted: true,
    gitMerged: true,
    linesAdded: 4,
    linesRemoved: 1,
    operationId: 'merge-operation-1',
    phase: 'completed',
    progressVersionAtOutcome: 4,
    taskId: 'task-1',
    taskReleased: true,
    version: 8,
    ...overrides,
  };
}

describe('merge progress domain', () => {
  it('advances all progress values in one immutable snapshot', () => {
    const current = progress();

    const next = advanceCompletedMergeProgress(current, {
      committedAt: COMMIT_TIME,
      linesAdded: 7.9,
      linesRemoved: 2,
    });

    expect(next).toEqual({
      schemaVersion: 1,
      version: 5,
      dateKey: '2026-08-04',
      tasksToday: 3,
      linesAdded: 17,
      linesRemoved: 5,
      updatedAt: COMMIT_TIME.toISOString(),
    });
    expect(current).toEqual(progress());
  });

  it('counts zero-line merges and resets only the daily value on date rollover', () => {
    const next = advanceCompletedMergeProgress(
      progress({ dateKey: '2026-08-03', tasksToday: 99 }),
      {
        committedAt: COMMIT_TIME,
        linesAdded: Number.NaN,
        linesRemoved: -5,
      },
    );

    expect(next).toMatchObject({
      dateKey: '2026-08-04',
      tasksToday: 1,
      linesAdded: 10,
      linesRemoved: 3,
      version: 5,
    });
  });

  it('rejects overflow without returning a partial snapshot', () => {
    expect(() =>
      advanceCompletedMergeProgress(progress({ linesAdded: Number.MAX_SAFE_INTEGER }), {
        committedAt: COMMIT_TIME,
        linesAdded: 1,
        linesRemoved: 0,
      }),
    ).toThrow(MergeProgressOverflowError);
    expect(() =>
      advanceCompletedMergeProgress(progress({ version: Number.MAX_SAFE_INTEGER }), {
        committedAt: COMMIT_TIME,
        linesAdded: 0,
        linesRemoved: 0,
      }),
    ).toThrow(MergeProgressOverflowError);
  });

  it('seeds canonical progress from legacy fields without carrying an old daily count', () => {
    expect(
      seedMergeProgressSnapshot(
        {
          completedTaskCount: 12,
          completedTaskDate: '2026-08-03',
          mergedLinesAdded: 40,
          mergedLinesRemoved: 5,
        },
        COMMIT_TIME,
      ),
    ).toEqual({
      schemaVersion: 1,
      version: 1,
      dateKey: '2026-08-03',
      tasksToday: 0,
      linesAdded: 40,
      linesRemoved: 5,
      updatedAt: COMMIT_TIME.toISOString(),
    });

    expect(seedMergeProgressSnapshot({}, COMMIT_TIME).version).toBe(0);
  });

  it('normalizes legacy numeric inputs and validates calendar dates precisely', () => {
    expect(normalizeMergeProgressInteger(4.9)).toBe(4);
    expect(normalizeMergeProgressInteger(-1)).toBe(0);
    expect(normalizeMergeProgressInteger(Infinity)).toBe(0);
    expect(normalizeMergeProgressInteger(Number.MAX_VALUE)).toBe(Number.MAX_SAFE_INTEGER);
    expect(isMergeProgressDateKey('2024-02-29')).toBe(true);
    expect(isMergeProgressDateKey('2025-02-29')).toBe(false);
    expect(isMergeProgressDateKey('2026-13-01')).toBe(false);
  });

  it('distinguishes newer, stale, duplicate, and same-version conflicting snapshots', () => {
    const current = progress();
    expect(getMergeProgressSnapshotDisposition(null, current)).toBe('newer');
    expect(getMergeProgressSnapshotDisposition(current, progress())).toBe('duplicate');
    expect(getMergeProgressSnapshotDisposition(current, progress({ version: 3 }))).toBe('stale');
    expect(getMergeProgressSnapshotDisposition(current, progress({ version: 5 }))).toBe('newer');
    expect(getMergeProgressSnapshotDisposition(current, progress({ tasksToday: 7 }))).toBe(
      'conflict',
    );
  });

  it('guards snapshots, counted invariants, issues, and generic removal envelopes', () => {
    expect(isMergeProgressSnapshot(progress())).toBe(true);
    expect(isMergeProgressSnapshot({ ...progress(), linesAdded: -1 })).toBe(false);
    expect(isMergeProgressSnapshot({ ...progress(), updatedAt: 'yesterday' })).toBe(false);
    expect(isTaskMergeOperationSnapshot(outcome())).toBe(true);
    expect(isTaskMergeOperationSnapshot(outcome({ taskReleased: false }))).toBe(false);
    expect(
      isTaskMergeOperationSnapshot(
        outcome({
          counted: false,
          phase: 'manual-reconciliation-required',
          taskReleased: false,
          issue: {
            code: 'git-outcome-ambiguous',
            recovery: {
              kind: 'local-operator-reconciliation',
              allowedActions: ['recheck-evidence', 'adopt-if-proven-merged'],
            },
          },
        }),
      ),
    ).toBe(true);

    expect(
      isTaskMergeResultEnvelope(
        {
          currentProgress: progress(),
          currentRemoval: { kind: 'canonical-removal' },
          originalOutcome: outcome(),
          replayed: true,
        },
        (candidate): candidate is { kind: 'canonical-removal' } =>
          typeof candidate === 'object' &&
          candidate !== null &&
          (candidate as { kind?: unknown }).kind === 'canonical-removal',
      ),
    ).toBe(true);
  });
});
