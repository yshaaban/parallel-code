import { describe, expect, it } from 'vitest';

import {
  isRemovedTaskConvergenceEvent,
  isTaskConvergenceEvent,
  isTaskConvergenceSnapshot,
  isTaskOverlapWarning,
  isTaskReviewState,
} from './task-convergence';

describe('task convergence domain helpers', () => {
  it('identifies removed convergence events by explicit removal value', () => {
    expect(
      isRemovedTaskConvergenceEvent({
        removed: true,
        taskId: 'task-1',
      }),
    ).toBe(true);
    expect(
      isRemovedTaskConvergenceEvent({
        removed: false,
        taskId: 'task-1',
      }),
    ).toBe(false);
  });

  it('validates convergence snapshots and events from transport boundaries', () => {
    const warning = {
      otherTaskId: 'task-2',
      otherTaskName: 'Other task',
      sharedCount: 1,
      sharedFiles: ['src/app.ts'],
    };
    const snapshot = {
      branchFiles: ['src/app.ts'],
      branchName: 'feature/task-1',
      changedFileCount: 1,
      commitCount: 1,
      conflictingFiles: [],
      hasCommittedChanges: true,
      hasUncommittedChanges: false,
      mainAheadCount: 0,
      overlapWarnings: [warning],
      projectId: 'project-1',
      state: 'review-ready',
      summary: '1 commit, 1 file changed',
      taskId: 'task-1',
      totalAdded: 4,
      totalRemoved: 1,
      updatedAt: 10,
      worktreePath: '/tmp/task-1',
    };

    expect(isTaskReviewState('review-ready')).toBe(true);
    expect(isTaskReviewState('blocked')).toBe(false);
    expect(isTaskOverlapWarning(warning)).toBe(true);
    expect(isTaskConvergenceSnapshot(snapshot)).toBe(true);
    expect(isTaskConvergenceEvent(snapshot)).toBe(true);
    expect(isTaskConvergenceEvent({ ...snapshot, stateVersion: '7' })).toBe(false);
    expect(isTaskConvergenceEvent({ ...snapshot, stateVersion: -1 })).toBe(false);
    expect(isTaskConvergenceSnapshot({ ...snapshot, state: 'blocked' })).toBe(false);
    expect(isTaskOverlapWarning({ ...warning, sharedFiles: [1] })).toBe(false);
    expect(isTaskOverlapWarning({ ...warning, sharedCount: -1 })).toBe(false);
    expect(isTaskConvergenceSnapshot({ ...snapshot, changedFileCount: 1.5 })).toBe(false);
    expect(isTaskConvergenceSnapshot({ ...snapshot, totalAdded: -1 })).toBe(false);
    expect(isTaskConvergenceSnapshot({ ...snapshot, updatedAt: 1.5 })).toBe(false);
  });
});
