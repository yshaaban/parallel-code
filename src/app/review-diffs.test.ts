import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../electron/ipc/channels';
import type { ChangedFile } from '../ipc/types';
import { createTaskReviewDiffRequest, fetchTaskFileDiff } from './review-diffs';

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

  function createChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
    return {
      committed: false,
      lines_added: 1,
      lines_removed: 0,
      path: 'src/a.ts',
      status: 'modified',
      ...overrides,
    };
  }

  it('fetches file diffs from the worktree first', async () => {
    invokeMock.mockResolvedValue({
      diff: 'diff --git a/a.ts b/a.ts',
      newContent: 'next',
      oldContent: 'prev',
    });

    const request = createTaskReviewDiffRequest({
      worktreePath: '/tmp/task',
    });
    const result = await fetchTaskFileDiff(request, createChangedFile());

    expect(result.oldContent).toBe('prev');
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetFileDiff, {
      filePath: 'src/a.ts',
      status: 'modified',
      worktreePath: '/tmp/task',
    });
  });

  it('fetches committed file diffs from the branch review source', async () => {
    invokeMock.mockResolvedValue({
      diff: 'diff --git a/src/new.ts b/src/new.ts',
      newContent: 'next',
      oldContent: '',
    });

    const request = createTaskReviewDiffRequest({
      branchName: 'feature/task-1',
      projectRoot: '/tmp/project',
      worktreePath: '/tmp/task',
    });
    const result = await fetchTaskFileDiff(
      request,
      createChangedFile({
        committed: true,
        path: 'src/new.ts',
        status: 'A',
      }),
    );

    expect(result.oldContent).toBe('');
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetFileDiffFromBranch, {
      projectRoot: '/tmp/project',
      branchName: 'feature/task-1',
      filePath: 'src/new.ts',
      status: 'A',
    });
  });

  it('falls back to the branch diff source when a worktree file diff is unavailable', async () => {
    invokeMock.mockRejectedValueOnce(new Error('missing worktree')).mockResolvedValueOnce({
      diff: 'diff --git a/src/a.ts b/src/a.ts',
      newContent: 'next',
      oldContent: 'prev',
    });

    const request = createTaskReviewDiffRequest({
      branchName: 'feature/task-1',
      projectRoot: '/tmp/project',
      worktreePath: '/tmp/task',
    });
    const result = await fetchTaskFileDiff(
      request,
      createChangedFile({
        path: 'src/a.ts',
        status: 'modified',
      }),
    );

    expect(result).toEqual({
      diff: 'diff --git a/src/a.ts b/src/a.ts',
      newContent: 'next',
      oldContent: 'prev',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.GetFileDiff, {
      filePath: 'src/a.ts',
      status: 'modified',
      worktreePath: '/tmp/task',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.GetFileDiffFromBranch, {
      branchName: 'feature/task-1',
      filePath: 'src/a.ts',
      projectRoot: '/tmp/project',
      status: 'modified',
    });
  });
});
