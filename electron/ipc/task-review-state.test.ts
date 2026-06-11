import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangedFile } from '../../src/ipc/types.js';

const { getChangedFilesFromBranchWithRevisionMock, getProjectDiffMock } = vi.hoisted(() => ({
  getChangedFilesFromBranchWithRevisionMock: vi.fn(),
  getProjectDiffMock: vi.fn(),
}));

vi.mock('./git.js', () => ({
  getChangedFilesFromBranchWithRevision: getChangedFilesFromBranchWithRevisionMock,
  getProjectDiff: getProjectDiffMock,
}));

import {
  clearTaskReviewRegistry,
  getTaskReviewSnapshot,
  registerTaskReviewTask,
  refreshTaskReview,
  removeTaskReview,
  restoreSavedTaskReview,
  subscribeTaskReview,
} from './task-review-state.js';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function waitForTaskReviewSnapshot(taskId: string): Promise<void> {
  return new Promise((resolve) => {
    const existingSnapshot = getTaskReviewSnapshot(taskId);
    if (existingSnapshot) {
      resolve();
      return;
    }

    const unsubscribe = subscribeTaskReview((event) => {
      if (event.taskId !== taskId || 'removed' in event) {
        return;
      }

      unsubscribe();
      resolve();
    });
  });
}

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
    expect(getChangedFilesFromBranchWithRevisionMock).not.toHaveBeenCalled();
  });

  it('emits a worktree review snapshot when only the backend diff revision changes', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTaskReview(listener);
    const files = [createChangedFile({ path: 'src/stable.ts', committed: true })];
    getProjectDiffMock
      .mockResolvedValueOnce({
        files,
        revisionId: 'base:head-one',
        totalAdded: 3,
        totalRemoved: 1,
      })
      .mockResolvedValueOnce({
        files,
        revisionId: 'base:head-two',
        totalAdded: 3,
        totalRemoved: 1,
      });

    registerTask();
    await refreshTaskReview('task-1');
    await refreshTaskReview('task-1');
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(getTaskReviewSnapshot('task-1')?.revisionId).toContain('base:head-two');
  });

  it('falls back to branch files when project diff fails', async () => {
    getProjectDiffMock.mockRejectedValue(new Error('missing worktree'));
    getChangedFilesFromBranchWithRevisionMock.mockResolvedValue({
      files: [createChangedFile({ path: 'src/fallback.ts', committed: true })],
      revisionId: 'base:branch-head',
    });

    registerTask();
    await refreshTaskReview('task-1');

    expect(getTaskReviewSnapshot('task-1')).toMatchObject({
      taskId: 'task-1',
      source: 'branch-fallback',
      files: [expect.objectContaining({ path: 'src/fallback.ts' })],
    });
  });

  it('emits a branch fallback review snapshot when only the backend diff revision changes', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTaskReview(listener);
    const files = [createChangedFile({ path: 'src/fallback.ts', committed: true })];
    getProjectDiffMock.mockRejectedValue(new Error('missing worktree'));
    getChangedFilesFromBranchWithRevisionMock
      .mockResolvedValueOnce({
        files,
        revisionId: 'base:branch-head-one',
      })
      .mockResolvedValueOnce({
        files,
        revisionId: 'base:branch-head-two',
      });

    registerTask();
    await refreshTaskReview('task-1');
    await refreshTaskReview('task-1');
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(getTaskReviewSnapshot('task-1')?.revisionId).toContain('base:branch-head-two');
  });

  it('returns to worktree review data when the worktree becomes available again', async () => {
    getProjectDiffMock.mockRejectedValueOnce(new Error('missing worktree')).mockResolvedValueOnce({
      files: [createChangedFile({ path: 'src/worktree.ts', committed: false })],
      totalAdded: 4,
      totalRemoved: 0,
    });
    getChangedFilesFromBranchWithRevisionMock.mockResolvedValue({
      files: [createChangedFile({ path: 'src/fallback.ts', committed: true })],
      revisionId: 'base:branch-head',
    });

    registerTask();

    await refreshTaskReview('task-1');
    expect(getTaskReviewSnapshot('task-1')).toMatchObject({
      source: 'branch-fallback',
      files: [expect.objectContaining({ path: 'src/fallback.ts' })],
    });

    await refreshTaskReview('task-1');
    expect(getTaskReviewSnapshot('task-1')).toMatchObject({
      source: 'worktree',
      files: [expect.objectContaining({ path: 'src/worktree.ts', committed: false })],
    });
    expect(getChangedFilesFromBranchWithRevisionMock).toHaveBeenCalledTimes(1);
    expect(getProjectDiffMock).toHaveBeenCalledTimes(2);
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

    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        removed: true,
        taskId: 'task-1',
      }),
    );
    expect(getTaskReviewSnapshot('task-1')).toBeUndefined();
  });

  it('reruns refresh when another invalidation arrives during an in-flight load', async () => {
    const firstLoad = createDeferred<{
      files: ChangedFile[];
      totalAdded: number;
      totalRemoved: number;
    }>();

    getProjectDiffMock.mockReturnValueOnce(firstLoad.promise).mockResolvedValueOnce({
      files: [createChangedFile({ path: 'src/second.ts' })],
      totalAdded: 4,
      totalRemoved: 2,
    });

    registerTask();
    const firstRefresh = refreshTaskReview('task-1');
    const secondRefresh = refreshTaskReview('task-1');

    firstLoad.resolve({
      files: [createChangedFile({ path: 'src/first.ts' })],
      totalAdded: 3,
      totalRemoved: 1,
    });

    await Promise.all([firstRefresh, secondRefresh]);

    expect(getProjectDiffMock).toHaveBeenCalledTimes(2);
    expect(getTaskReviewSnapshot('task-1')).toMatchObject({
      files: [expect.objectContaining({ path: 'src/second.ts' })],
      revisionId: expect.stringContaining('src/second.ts'),
    });
  });

  it('ignores in-flight snapshots when review metadata changes', async () => {
    const firstLoad = createDeferred<{
      files: ChangedFile[];
      totalAdded: number;
      totalRemoved: number;
    }>();

    getProjectDiffMock.mockReturnValueOnce(firstLoad.promise).mockResolvedValueOnce({
      files: [createChangedFile({ path: 'src/new-base.ts' })],
      totalAdded: 6,
      totalRemoved: 0,
    });

    registerTask({ baseBranch: 'release/old' });
    const refresh = refreshTaskReview('task-1');

    registerTask({ baseBranch: 'release/new' });
    firstLoad.resolve({
      files: [createChangedFile({ path: 'src/old-base.ts' })],
      totalAdded: 3,
      totalRemoved: 1,
    });

    await refresh;

    expect(getProjectDiffMock).toHaveBeenNthCalledWith(
      1,
      '/tmp/project/task-1',
      'all',
      'release/old',
    );
    expect(getProjectDiffMock).toHaveBeenNthCalledWith(
      2,
      '/tmp/project/task-1',
      'all',
      'release/new',
    );
    expect(getTaskReviewSnapshot('task-1')).toMatchObject({
      files: [expect.objectContaining({ path: 'src/new-base.ts' })],
      revisionId: expect.stringContaining('src/new-base.ts'),
    });
  });

  it('restores review metadata without scheduling a blanket refresh', async () => {
    getProjectDiffMock.mockResolvedValue({
      files: [createChangedFile({ path: 'src/restored.ts' })],
      totalAdded: 3,
      totalRemoved: 1,
    });

    restoreSavedTaskReview(
      JSON.stringify({
        projects: [{ id: 'project-1', path: '/tmp/project' }],
        tasks: {
          'task-from-key': {
            branchName: 'feature/task-1',
            projectId: 'project-1',
            worktreePath: '/tmp/project/task-1',
          },
        },
      }),
    );

    await Promise.resolve();

    expect(getProjectDiffMock).not.toHaveBeenCalled();
    expect(getTaskReviewSnapshot('task-from-key')).toBeUndefined();

    const restoredSnapshot = waitForTaskReviewSnapshot('task-from-key');
    await refreshTaskReview('task-from-key');
    await restoredSnapshot;

    expect(getTaskReviewSnapshot('task-from-key')).toMatchObject({
      taskId: 'task-from-key',
      source: 'worktree',
      files: [expect.objectContaining({ path: 'src/restored.ts' })],
    });
  });
});
