import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskReviewSnapshot } from '../domain/task-review';
import { resetStoreForTest } from '../test/store-test-helpers';
import {
  applyTaskReviewEvent,
  getTaskReviewSnapshot,
  replaceTaskReviewSnapshots,
  resetTaskReviewProjectionStateForTests,
} from './task-review-state';

function createTaskReviewSnapshot(
  taskId: string,
  overrides: Partial<TaskReviewSnapshot> = {},
): TaskReviewSnapshot {
  return {
    branchName: `feature/${taskId}`,
    files: [],
    projectId: 'project-1',
    revisionId: `${taskId}::review`,
    source: 'worktree',
    taskId,
    totalAdded: 1,
    totalRemoved: 0,
    updatedAt: 1_000,
    worktreePath: `/tmp/${taskId}`,
    ...overrides,
  };
}

describe('task review state projection', () => {
  beforeEach(() => {
    resetTaskReviewProjectionStateForTests();
    resetStoreForTest();
  });

  it('ignores stale versioned review snapshot and removal events after a newer replacement', () => {
    const snapshot = createTaskReviewSnapshot('task-1', {
      revisionId: 'task-1::fresh',
      updatedAt: 2_000,
    });
    replaceTaskReviewSnapshots([snapshot], { replaceVersion: 2 });

    applyTaskReviewEvent({
      ...createTaskReviewSnapshot('task-1', {
        revisionId: 'task-1::old',
        totalAdded: 9,
        updatedAt: 1_000,
      }),
      stateVersion: 1,
    });
    applyTaskReviewEvent({
      removed: true,
      stateVersion: 1,
      taskId: 'task-1',
    });

    expect(getTaskReviewSnapshot('task-1')).toEqual(snapshot);
  });
});
