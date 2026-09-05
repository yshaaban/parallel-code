import { beforeEach, describe, expect, it } from 'vitest';

import {
  MERGE_PROGRESS_SCHEMA_VERSION,
  type CommittedMergeOperationMarker,
  type MergeProgressSnapshot,
} from '../domain/task-merge';
import {
  applyPersistedMergeProgressProjection,
  applyPersistedMergeProgressSnapshot,
  applyMergeProgressSnapshot,
  getCanonicalMergeProgressPersistenceProjection,
  getCurrentMergeProgressSnapshot,
  getMergedLineTotalsFromProgress,
  getMergedTasksTodayFromProgress,
  resetMergeProgressProjectionForTests,
} from './merge-progress';

function snapshot(overrides: Partial<MergeProgressSnapshot> = {}): MergeProgressSnapshot {
  return {
    schemaVersion: MERGE_PROGRESS_SCHEMA_VERSION,
    version: 1,
    dateKey: '2026-08-04',
    tasksToday: 3,
    linesAdded: 20,
    linesRemoved: 4,
    updatedAt: '2026-08-04T10:00:00.000Z',
    ...overrides,
  };
}

function marker(
  overrides: Partial<CommittedMergeOperationMarker> = {},
): CommittedMergeOperationMarker {
  return {
    committedAt: '2026-08-04T10:00:00.000Z',
    operationId: 'merge-1',
    progressVersion: 1,
    taskId: 'task-1',
    ...overrides,
  };
}

describe('merge progress renderer projection', () => {
  beforeEach(() => {
    resetMergeProgressProjectionForTests();
  });

  it('applies one full update per newer version and ignores duplicate or stale delivery', () => {
    expect(applyMergeProgressSnapshot(snapshot())).toBe('newer');
    expect(applyMergeProgressSnapshot(snapshot())).toBe('duplicate');
    expect(applyMergeProgressSnapshot(snapshot({ version: 0 }))).toBe('stale');
    expect(applyMergeProgressSnapshot(snapshot({ version: 2, tasksToday: 4 }))).toBe('newer');

    expect(getCurrentMergeProgressSnapshot()).toEqual(snapshot({ version: 2, tasksToday: 4 }));
  });

  it('fails closed on divergent data at an already applied version', () => {
    expect(applyMergeProgressSnapshot(snapshot())).toBe('newer');
    expect(applyMergeProgressSnapshot(snapshot({ tasksToday: 99 }))).toBe('conflict');
    expect(getCurrentMergeProgressSnapshot()).toEqual(snapshot());
  });

  it('shows zero daily progress for a prior date while retaining lifetime line totals', () => {
    applyMergeProgressSnapshot(snapshot({ dateKey: '2026-08-03', tasksToday: 12 }));

    expect(getMergedTasksTodayFromProgress(new Date('2026-08-04T12:00:00.000Z'))).toBe(0);
    expect(getMergedLineTotalsFromProgress()).toEqual({ added: 20, removed: 4 });
  });

  it('retains an immutable copy of the accepted snapshot', () => {
    const incoming = snapshot();
    applyMergeProgressSnapshot(incoming);
    incoming.tasksToday = 999;

    expect(getCurrentMergeProgressSnapshot()?.tasksToday).toBe(3);
    expect(Object.isFrozen(getCurrentMergeProgressSnapshot())).toBe(true);
  });

  it('uses one fail-closed decode boundary for reload and cold-bootstrap input', () => {
    expect(applyPersistedMergeProgressSnapshot(undefined)).toBe('absent');
    expect(applyPersistedMergeProgressSnapshot({ version: 99 })).toBe('invalid');
    expect(getCurrentMergeProgressSnapshot()).toBeNull();

    expect(applyPersistedMergeProgressSnapshot(snapshot())).toBe('newer');
    expect(applyPersistedMergeProgressSnapshot(snapshot({ version: 0 }))).toBe('stale');
    expect(getCurrentMergeProgressSnapshot()).toEqual(snapshot());
  });

  it('retains an immutable, complete canonical projection for persistence proposals', () => {
    const incomingMarker = marker();
    expect(
      applyPersistedMergeProgressProjection({
        committedMergeOperationId: incomingMarker.operationId,
        mergeOperation: incomingMarker,
        mergeProgress: snapshot(),
      }),
    ).toBe('newer');
    incomingMarker.taskId = 'forged-after-apply';

    const projection = getCanonicalMergeProgressPersistenceProjection();
    expect(projection).toEqual({
      committedMergeOperationId: 'merge-1',
      mergeOperation: marker(),
      mergeProgress: snapshot(),
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection?.mergeOperation)).toBe(true);
    expect(Object.isFrozen(projection?.mergeProgress)).toBe(true);
  });

  it('rejects incomplete or snapshot-inconsistent committed merge markers', () => {
    expect(
      applyPersistedMergeProgressProjection({
        committedMergeOperationId: 'merge-1',
        mergeProgress: snapshot(),
      }),
    ).toBe('invalid');
    expect(
      applyPersistedMergeProgressProjection({
        committedMergeOperationId: 'merge-1',
        mergeOperation: marker({ progressVersion: 2 }),
        mergeProgress: snapshot(),
      }),
    ).toBe('invalid');
    expect(getCurrentMergeProgressSnapshot()).toBeNull();
    expect(getCanonicalMergeProgressPersistenceProjection()).toBeNull();
  });

  it('keeps live progress separate from canonical persistence and rejects marker loss', () => {
    expect(
      applyPersistedMergeProgressProjection({
        committedMergeOperationId: 'merge-1',
        mergeOperation: marker(),
        mergeProgress: snapshot(),
      }),
    ).toBe('newer');

    const liveProgress = snapshot({ version: 2, tasksToday: 4 });
    expect(applyMergeProgressSnapshot(liveProgress)).toBe('newer');
    expect(getCanonicalMergeProgressPersistenceProjection()).toMatchObject({
      committedMergeOperationId: 'merge-1',
      mergeProgress: snapshot(),
    });

    expect(applyPersistedMergeProgressProjection({ mergeProgress: liveProgress })).toBe('invalid');
    expect(getCanonicalMergeProgressPersistenceProjection()).toMatchObject({
      committedMergeOperationId: 'merge-1',
      mergeProgress: snapshot(),
    });

    const nextMarker = marker({ operationId: 'merge-2', progressVersion: 2 });
    expect(
      applyPersistedMergeProgressProjection({
        committedMergeOperationId: nextMarker.operationId,
        mergeOperation: nextMarker,
        mergeProgress: liveProgress,
      }),
    ).toBe('duplicate');
    expect(getCanonicalMergeProgressPersistenceProjection()).toEqual({
      committedMergeOperationId: 'merge-2',
      mergeOperation: nextMarker,
      mergeProgress: liveProgress,
    });
  });
});
