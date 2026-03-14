import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../electron/ipc/channels';
import { createTaskReviewDiffRequest, fetchTaskAllDiffs, fetchTaskFileDiff } from './review-diffs';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

describe('review-diffs', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('fetches file diffs from the worktree first', async () => {
    invokeMock.mockResolvedValue({
      diff: 'diff --git a/a.ts b/a.ts',
      newContent: 'next',
      oldContent: 'prev',
    });

    const request = createTaskReviewDiffRequest({
      worktreePath: '/tmp/task',
    });
    const result = await fetchTaskFileDiff(request, 'src/a.ts');

    expect(result.oldContent).toBe('prev');
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetFileDiff, {
      worktreePath: '/tmp/task',
      filePath: 'src/a.ts',
    });
  });

  it('falls back to branch all-diff fetches when the worktree fetch fails', async () => {
    invokeMock
      .mockRejectedValueOnce(new Error('missing worktree'))
      .mockResolvedValueOnce('diff --git a/src/a.ts b/src/a.ts');

    const request = createTaskReviewDiffRequest({
      branchName: 'task/demo',
      projectRoot: '/tmp/project',
      worktreePath: '/tmp/task',
    });
    const result = await fetchTaskAllDiffs(request);

    expect(result).toContain('diff --git');
    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.GetAllFileDiffs, {
      worktreePath: '/tmp/task',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.GetAllFileDiffsFromBranch, {
      projectRoot: '/tmp/project',
      branchName: 'task/demo',
    });
  });
});
