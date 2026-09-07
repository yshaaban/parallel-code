import { describe, expect, it } from 'vitest';

import {
  isRemovedTaskConvergenceEvent,
  isTaskConvergenceEvent,
  isTaskConvergenceSnapshot,
  isTaskOverlapWarning,
  isTaskReviewState,
  getTaskReviewPresentation,
  getTaskReviewQueueGroupLabel,
  type TaskConvergenceSnapshot,
} from './task-convergence';

function snapshot(overrides: Partial<TaskConvergenceSnapshot> = {}): TaskConvergenceSnapshot {
  return {
    branchFiles: [],
    branchName: 'task/test',
    changedFileCount: 0,
    commitCount: 0,
    conflictingFiles: [],
    hasCommittedChanges: false,
    hasUncommittedChanges: false,
    mainAheadCount: 0,
    overlapWarnings: [],
    projectId: 'project-1',
    state: 'needs-refresh',
    summary: 'Stored explanation',
    taskId: 'task-1',
    totalAdded: 0,
    totalRemoved: 0,
    updatedAt: 1,
    worktreePath: '/tmp/task-1',
    ...overrides,
  };
}

describe('task convergence domain helpers', () => {
  it.each([
    {
      data: { reviewReason: 'behind-base', mainAheadCount: 1 },
      label: 'Behind 1',
      detail: 'by 1 commit.',
    },
    {
      data: { reviewReason: 'behind-base', mainAheadCount: 3 },
      label: 'Behind 3',
      detail: 'by 3 commits.',
    },
    {
      data: { reviewReason: 'branch-mismatch', currentBranch: 'task/other', mainAheadCount: 3 },
      label: 'Branch changed',
      detail: '"task/other", recorded task branch is "task/test"',
    },
    {
      data: { reviewReason: 'detached-head', currentBranch: null, mainAheadCount: 3 },
      label: 'Detached',
      detail: 'detached HEAD',
    },
    {
      data: { state: 'merge-blocked', reviewReason: 'conflicts', conflictingFiles: ['a', 'b'] },
      label: 'Conflicts 2',
      detail: '2 files conflict with "upstream/platform"',
    },
  ] satisfies Array<{ data: Partial<TaskConvergenceSnapshot>; label: string; detail: string }>)(
    'presents $label from structured backend reasons, not summary text',
    ({ data, label, detail }) => {
      const presentation = getTaskReviewPresentation(
        snapshot({ baseBranch: 'upstream/platform', ...data }),
      );
      expect(presentation.label).toBe(label);
      expect(presentation.badgeLabel).toBe(label);
      expect(presentation.summary).toContain(detail);
      expect(presentation.summary).not.toContain('Stored explanation');
      expect(presentation.summary).not.toMatch(/\bmain\b/i);
    },
  );

  it.each(['branch-mismatch', 'detached-head', 'behind-base'] as const)(
    'keeps %s guidance safe when the checkout may be shared by project-root tasks',
    (reviewReason) => {
      const { summary } = getTaskReviewPresentation(
        snapshot({
          branchName: 'feature/recorded',
          currentBranch: reviewReason === 'detached-head' ? null : 'feature/shared',
          mainAheadCount: 2,
          reviewReason,
          worktreePath: '/tmp/shared-project-root',
        }),
      );
      expect(summary).not.toMatch(/check out|before merge review/i);
      if (reviewReason === 'behind-base') {
        expect(summary).toContain('Review the branch differences');
      } else {
        expect(summary).toContain('recorded task branch');
        expect(summary).toContain('other tasks may share it');
      }
    },
  );

  it('keeps legacy snapshots valid and does not guess their reason from counts or prose', () => {
    const legacy = snapshot({ mainAheadCount: 8, summary: 'Worktree is on another branch' });
    expect(isTaskConvergenceSnapshot(legacy)).toBe(true);
    expect(getTaskReviewPresentation(legacy)).toEqual({
      badgeLabel: 'Needs attention',
      label: 'Needs attention',
      summary: legacy.summary,
    });
    expect(getTaskReviewQueueGroupLabel('needs-refresh')).toBe('Needs attention');
    expect(getTaskReviewPresentation(snapshot({ state: 'unavailable' })).badgeLabel).toBeNull();
    expect(
      getTaskReviewPresentation(snapshot({ state: 'review-ready', reviewReason: 'behind-base' }))
        .label,
    ).toBe('Ready');
  });

  it('validates optional reason and branch facts without requiring them on older snapshots', () => {
    const current = snapshot({
      baseBranch: 'trunk',
      currentBranch: null,
      reviewReason: 'detached-head',
    });
    expect(isTaskConvergenceEvent(current)).toBe(true);
    expect(isTaskConvergenceSnapshot({ ...current, baseBranch: 42 })).toBe(false);
    expect(isTaskConvergenceSnapshot({ ...current, currentBranch: false })).toBe(false);
    expect(isTaskConvergenceSnapshot({ ...current, reviewReason: 'loading' })).toBe(false);
  });
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
