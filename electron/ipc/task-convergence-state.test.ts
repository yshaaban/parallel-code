import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  checkMergeStatusMock,
  getBranchLogMock,
  getProjectDiffMock,
  getWorktreeStatusMock,
  invalidateWorktreeStatusCacheMock,
} = vi.hoisted(() => ({
  checkMergeStatusMock: vi.fn(),
  getBranchLogMock: vi.fn(),
  getProjectDiffMock: vi.fn(),
  getWorktreeStatusMock: vi.fn(),
  invalidateWorktreeStatusCacheMock: vi.fn(),
}));

vi.mock('./git.js', () => ({
  checkMergeStatus: checkMergeStatusMock,
  getBranchLog: getBranchLogMock,
  getProjectDiff: getProjectDiffMock,
  getWorktreeStatus: getWorktreeStatusMock,
  invalidateWorktreeStatusCache: invalidateWorktreeStatusCacheMock,
}));

import {
  clearTaskConvergenceRegistry,
  getTaskConvergenceSnapshot,
  refreshTaskConvergence,
  registerTaskConvergenceTask,
  removeTaskConvergence,
  subscribeTaskConvergence,
} from './task-convergence-state.js';

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

function mockTaskGitData(taskWorktreePath: string, sharedFile: string, taskFile: string): void {
  getProjectDiffMock.mockImplementation((worktreePath: string) => {
    if (worktreePath !== taskWorktreePath) {
      return Promise.resolve({
        files: [],
        totalAdded: 0,
        totalRemoved: 0,
      });
    }

    return Promise.resolve({
      files: [
        {
          path: sharedFile,
          status: 'modified',
          committed: true,
          lines_added: 3,
          lines_removed: 1,
        },
        {
          path: taskFile,
          status: 'added',
          committed: true,
          lines_added: 2,
          lines_removed: 0,
        },
      ],
      totalAdded: 5,
      totalRemoved: 1,
    });
  });

  getWorktreeStatusMock.mockImplementation((worktreePath: string) => {
    if (worktreePath !== taskWorktreePath) {
      return Promise.resolve({
        has_committed_changes: false,
        has_uncommitted_changes: false,
      });
    }

    return Promise.resolve({
      has_committed_changes: true,
      has_uncommitted_changes: false,
    });
  });

  checkMergeStatusMock.mockImplementation((worktreePath: string) => {
    if (worktreePath !== taskWorktreePath) {
      return Promise.resolve({
        conflicting_files: [],
        main_ahead_count: 0,
      });
    }

    return Promise.resolve({
      conflicting_files: [],
      main_ahead_count: 0,
    });
  });

  getBranchLogMock.mockImplementation((worktreePath: string) => {
    if (worktreePath !== taskWorktreePath) {
      return Promise.resolve('');
    }

    return Promise.resolve('commit one\ncommit two\n');
  });
}

describe('task convergence state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTaskConvergenceRegistry();
  });

  it('computes snapshots and overlap warnings on backend refresh', async () => {
    registerTaskConvergenceTask({
      branchName: 'feature/task-1',
      projectId: 'project-1',
      projectRoot: '/repo/project-1',
      taskId: 'task-1',
      taskName: 'Task one',
      worktreePath: '/tmp/task-1',
    });
    registerTaskConvergenceTask({
      branchName: 'feature/task-2',
      projectId: 'project-1',
      projectRoot: '/repo/project-1',
      taskId: 'task-2',
      taskName: 'Task two',
      worktreePath: '/tmp/task-2',
    });

    mockTaskGitData('/tmp/task-1', 'src/shared.ts', 'src/one.ts');
    await refreshTaskConvergence('task-1');

    mockTaskGitData('/tmp/task-2', 'src/shared.ts', 'src/two.ts');
    await refreshTaskConvergence('task-2');

    expect(getTaskConvergenceSnapshot('task-1')).toMatchObject({
      commitCount: 2,
      changedFileCount: 2,
      overlapWarnings: [
        {
          otherTaskId: 'task-2',
          otherTaskName: 'Task two',
          sharedCount: 1,
          sharedFiles: ['src/shared.ts'],
        },
      ],
      state: 'review-ready',
    });

    expect(getTaskConvergenceSnapshot('task-2')).toMatchObject({
      overlapWarnings: [
        {
          otherTaskId: 'task-1',
          otherTaskName: 'Task one',
          sharedCount: 1,
          sharedFiles: ['src/shared.ts'],
        },
      ],
      state: 'review-ready',
    });
    expect(invalidateWorktreeStatusCacheMock).toHaveBeenCalledWith('/tmp/task-1');
    expect(invalidateWorktreeStatusCacheMock).toHaveBeenCalledWith('/tmp/task-2');
  });

  it('emits removal events and clears overlap warnings when a task is deleted', async () => {
    const events: unknown[] = [];
    const unsubscribe = subscribeTaskConvergence((event) => {
      events.push(event);
    });

    registerTaskConvergenceTask({
      branchName: 'feature/task-1',
      projectId: 'project-1',
      projectRoot: '/repo/project-1',
      taskId: 'task-1',
      taskName: 'Task one',
      worktreePath: '/tmp/task-1',
    });
    registerTaskConvergenceTask({
      branchName: 'feature/task-2',
      projectId: 'project-1',
      projectRoot: '/repo/project-1',
      taskId: 'task-2',
      taskName: 'Task two',
      worktreePath: '/tmp/task-2',
    });

    mockTaskGitData('/tmp/task-1', 'src/shared.ts', 'src/one.ts');
    await refreshTaskConvergence('task-1');

    mockTaskGitData('/tmp/task-2', 'src/shared.ts', 'src/two.ts');
    await refreshTaskConvergence('task-2');

    removeTaskConvergence('task-2');
    unsubscribe();

    expect(events).toContainEqual({
      removed: true,
      taskId: 'task-2',
    });
    expect(getTaskConvergenceSnapshot('task-1')).toMatchObject({
      overlapWarnings: [],
    });
    expect(getTaskConvergenceSnapshot('task-2')).toBeUndefined();
  });

  it('reruns convergence refresh when invalidated during an in-flight load', async () => {
    const firstProjectDiff = createDeferred<{
      files: Array<{
        committed: boolean;
        lines_added: number;
        lines_removed: number;
        path: string;
        status: string;
      }>;
      totalAdded: number;
      totalRemoved: number;
    }>();

    registerTaskConvergenceTask({
      branchName: 'feature/task-1',
      projectId: 'project-1',
      projectRoot: '/repo/project-1',
      taskId: 'task-1',
      taskName: 'Task one',
      worktreePath: '/tmp/task-1',
    });

    getProjectDiffMock.mockReturnValueOnce(firstProjectDiff.promise).mockResolvedValueOnce({
      files: [
        {
          path: 'src/second.ts',
          status: 'modified',
          committed: true,
          lines_added: 4,
          lines_removed: 1,
        },
      ],
      totalAdded: 4,
      totalRemoved: 1,
    });
    getWorktreeStatusMock.mockResolvedValue({
      has_committed_changes: true,
      has_uncommitted_changes: false,
    });
    checkMergeStatusMock.mockResolvedValue({
      conflicting_files: [],
      main_ahead_count: 0,
    });
    getBranchLogMock.mockResolvedValue('commit one\n');

    const firstRefresh = refreshTaskConvergence('task-1');
    const secondRefresh = refreshTaskConvergence('task-1');

    firstProjectDiff.resolve({
      files: [
        {
          path: 'src/first.ts',
          status: 'modified',
          committed: true,
          lines_added: 2,
          lines_removed: 1,
        },
      ],
      totalAdded: 2,
      totalRemoved: 1,
    });

    await Promise.all([firstRefresh, secondRefresh]);

    expect(getProjectDiffMock).toHaveBeenCalledTimes(2);
    expect(getTaskConvergenceSnapshot('task-1')).toMatchObject({
      branchFiles: ['src/second.ts'],
      changedFileCount: 1,
      totalAdded: 4,
      totalRemoved: 1,
    });
  });
});
