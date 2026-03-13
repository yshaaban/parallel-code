import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

import { fetchTaskReviewFiles } from './review-files';

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

    await expect(
      fetchTaskReviewFiles(
        {
          worktreePath: '/tmp/task-1',
          projectRoot: '/tmp/project',
          branchName: 'feature/task-1',
        },
        'all',
      ),
    ).resolves.toEqual({
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

    await expect(
      fetchTaskReviewFiles(
        {
          worktreePath: '/tmp/task-1',
          projectRoot: '/tmp/project',
          branchName: 'feature/task-1',
        },
        'all',
      ),
    ).resolves.toEqual({
      files: [
        {
          path: 'src/branch-only.ts',
          committed: true,
          lines_added: 5,
          lines_removed: 2,
          status: 'modified',
        },
      ],
      totalAdded: 5,
      totalRemoved: 2,
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetChangedFilesFromBranch, {
      projectRoot: '/tmp/project',
      branchName: 'feature/task-1',
    });
  });
});
