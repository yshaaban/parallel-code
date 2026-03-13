import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangedFile } from '../../src/ipc/types.js';

const { getChangedFilesFromBranchMock, getProjectDiffMock } = vi.hoisted(() => ({
  getChangedFilesFromBranchMock: vi.fn(),
  getProjectDiffMock: vi.fn(),
}));

vi.mock('./git.js', () => ({
  getChangedFilesFromBranch: getChangedFilesFromBranchMock,
  getProjectDiff: getProjectDiffMock,
}));

import {
  clearTaskReviewRegistry,
  getTaskReviewSnapshot,
  registerTaskReviewTask,
  refreshTaskReview,
  removeTaskReview,
  subscribeTaskReview,
} from './task-review-state.js';

function createChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    committed: false,
    lines_added: 3,
    lines_removed: 1,
    path: 'src/example.ts',
    status: 'modified',
    ...overrides,
  };
}

function registerTask(overrides: Partial<Parameters<typeof registerTaskReviewTask>[0]> = {}): void {
  registerTaskReviewTask({
    branchName: 'feature/task-1',
    projectId: 'project-1',
    projectRoot: '/tmp/project',
    taskId: 'task-1',
    worktreePath: '/tmp/project/task-1',
    ...overrides,
  });
}

describe('task-review-state', () => {
  beforeEach(() => {
    clearTaskReviewRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearTaskReviewRegistry();
  });

  it('refreshes from project diff when available', async () => {
    getProjectDiffMock.mockResolvedValue({
      files: [createChangedFile({ path: 'src/first.ts' })],
      totalAdded: 3,
      totalRemoved: 1,
    });

    registerTask();
    await refreshTaskReview('task-1');

    expect(getTaskReviewSnapshot('task-1')).toMatchObject({
      taskId: 'task-1',
      source: 'worktree',
      files: [expect.objectContaining({ path: 'src/first.ts' })],
    });
    expect(getChangedFilesFromBranchMock).not.toHaveBeenCalled();
  });

  it('falls back to branch files when project diff fails', async () => {
    getProjectDiffMock.mockRejectedValue(new Error('missing worktree'));
    getChangedFilesFromBranchMock.mockResolvedValue([
      createChangedFile({ path: 'src/fallback.ts', committed: true }),
    ]);

    registerTask();
    await refreshTaskReview('task-1');

    expect(getTaskReviewSnapshot('task-1')).toMatchObject({
      taskId: 'task-1',
      source: 'branch-fallback',
      files: [expect.objectContaining({ path: 'src/fallback.ts' })],
    });
  });

  it('emits a removal event when task review state is deleted', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTaskReview(listener);
    getProjectDiffMock.mockResolvedValue({
      files: [createChangedFile({ path: 'src/first.ts' })],
      totalAdded: 3,
      totalRemoved: 1,
    });

    registerTask();
    await refreshTaskReview('task-1');
    removeTaskReview('task-1');
    unsubscribe();

    expect(listener).toHaveBeenLastCalledWith({
      removed: true,
      taskId: 'task-1',
    });
    expect(getTaskReviewSnapshot('task-1')).toBeUndefined();
  });
});
