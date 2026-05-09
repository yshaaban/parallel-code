import { describe, expect, it } from 'vitest';

import {
  isRemovedTaskReviewEvent,
  isTaskReviewEvent,
  isTaskReviewFile,
  isTaskReviewSnapshot,
  isTaskReviewSource,
} from './task-review';

describe('task review domain helpers', () => {
  it('recognizes only supported review sources', () => {
    expect(isTaskReviewSource('worktree')).toBe(true);
    expect(isTaskReviewSource('branch-fallback')).toBe(true);
    expect(isTaskReviewSource('unavailable')).toBe(true);
    expect(isTaskReviewSource('stale-cache')).toBe(false);
    expect(isTaskReviewSource(undefined)).toBe(false);
  });

  it('identifies removed review events by shape', () => {
    expect(
      isRemovedTaskReviewEvent({
        removed: true,
        taskId: 'task-1',
      }),
    ).toBe(true);
    expect(
      isRemovedTaskReviewEvent({
        removed: false,
        taskId: 'task-1',
      }),
    ).toBe(false);
  });

  it('validates task review snapshots and events from transport boundaries', () => {
    const file = {
      committed: false,
      lines_added: 4,
      lines_removed: 1,
      path: 'src/app.ts',
      status: 'modified',
    };
    const snapshot = {
      branchName: 'feature/task-1',
      files: [file],
      projectId: 'project-1',
      revisionId: 'rev-1',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 4,
      totalRemoved: 1,
      updatedAt: 10,
      worktreePath: '/tmp/task-1',
    };

    expect(isTaskReviewFile(file)).toBe(true);
    expect(isTaskReviewSnapshot(snapshot)).toBe(true);
    expect(isTaskReviewEvent(snapshot)).toBe(true);
    expect(
      isTaskReviewEvent({
        removed: true,
        taskId: 'task-1',
      }),
    ).toBe(true);
    expect(isTaskReviewEvent({ ...snapshot, stateVersion: '7' })).toBe(false);
    expect(isTaskReviewEvent({ ...snapshot, stateVersion: 1.5 })).toBe(false);
    expect(isTaskReviewFile({ ...file, status: 'renamed' })).toBe(false);
    expect(isTaskReviewSnapshot({ ...snapshot, files: [{ ...file, lines_added: NaN }] })).toBe(
      false,
    );
    expect(isTaskReviewFile({ ...file, lines_added: -1 })).toBe(false);
    expect(isTaskReviewSnapshot({ ...snapshot, totalRemoved: 1.5 })).toBe(false);
    expect(isTaskReviewSnapshot({ ...snapshot, updatedAt: -1 })).toBe(false);
  });
});
