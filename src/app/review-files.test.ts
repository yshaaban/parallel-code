import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

import { fetchTaskReviewFiles } from './review-files';

const reviewFilesRequest = {
  worktreePath: '/tmp/task-1',
  projectRoot: '/tmp/project',
  branchName: 'feature/task-1',
} as const;

describe('fetchTaskReviewFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the canonical project diff for all-changes task review files', async () => {
    invokeMock.mockResolvedValue({
      files: [
        {
          path: 'src/first.ts',
          committed: false,
          lines_added: 3,
          lines_removed: 1,
          status: 'modified',
        },
      ],
      totalAdded: 3,
      totalRemoved: 1,
    });

    await expect(fetchTaskReviewFiles(reviewFilesRequest, 'all')).resolves.toEqual({
      files: [
        {
          path: 'src/first.ts',
          committed: false,
          lines_added: 3,
          lines_removed: 1,
          status: 'modified',
        },
      ],
      source: 'project-diff',
      totalAdded: 3,
      totalRemoved: 1,
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetProjectDiff, {
      worktreePath: '/tmp/task-1',
      mode: 'all',
    });
  });

  it('falls back to branch changed files when all-changes worktree diff is unavailable', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.GetProjectDiff) {
        return Promise.reject(new Error('missing worktree'));
      }

      if (channel === IPC.GetChangedFilesFromBranch) {
        return Promise.resolve([
          {
            path: 'src/branch-only.ts',
            committed: true,
            lines_added: 5,
            lines_removed: 2,
            status: 'modified',
          },
        ]);
      }

      throw new Error(`Unexpected channel: ${channel}`);
    });

    await expect(fetchTaskReviewFiles(reviewFilesRequest, 'all')).resolves.toEqual({
      files: [
        {
          path: 'src/branch-only.ts',
          committed: true,
          lines_added: 5,
          lines_removed: 2,
          status: 'modified',
        },
      ],
      source: 'branch-fallback',
      totalAdded: 5,
      totalRemoved: 2,
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetChangedFilesFromBranch, {
      projectRoot: '/tmp/project',
      branchName: 'feature/task-1',
    });
  });

  it('routes staged review mode through the canonical project diff path', async () => {
    invokeMock.mockResolvedValue({
      files: [
        {
          path: 'src/staged.ts',
          committed: false,
          lines_added: 2,
          lines_removed: 0,
          status: 'modified',
        },
      ],
      totalAdded: 2,
      totalRemoved: 0,
    });

    await expect(fetchTaskReviewFiles(reviewFilesRequest, 'staged')).resolves.toEqual({
      files: [
        {
          path: 'src/staged.ts',
          committed: false,
          lines_added: 2,
          lines_removed: 0,
          status: 'modified',
        },
      ],
      source: 'project-diff',
      totalAdded: 2,
      totalRemoved: 0,
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetProjectDiff, {
      worktreePath: '/tmp/task-1',
      mode: 'staged',
    });
  });

  it('routes unstaged review mode through the canonical project diff path', async () => {
    invokeMock.mockResolvedValue({
      files: [
        {
          path: 'src/unstaged.ts',
          committed: false,
          lines_added: 1,
          lines_removed: 3,
          status: 'modified',
        },
      ],
      totalAdded: 1,
      totalRemoved: 3,
    });

    await expect(fetchTaskReviewFiles(reviewFilesRequest, 'unstaged')).resolves.toEqual({
      files: [
        {
          path: 'src/unstaged.ts',
          committed: false,
          lines_added: 1,
          lines_removed: 3,
          status: 'modified',
        },
      ],
      source: 'project-diff',
      totalAdded: 1,
      totalRemoved: 3,
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetProjectDiff, {
      worktreePath: '/tmp/task-1',
      mode: 'unstaged',
    });
  });

  it('does not fall back to branch changed files when branch mode worktree diff fails', async () => {
    invokeMock.mockRejectedValue(new Error('missing worktree'));

    await expect(fetchTaskReviewFiles(reviewFilesRequest, 'branch')).rejects.toThrow(
      'missing worktree',
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetProjectDiff, {
      worktreePath: '/tmp/task-1',
      mode: 'branch',
    });
  });
});
