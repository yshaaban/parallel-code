import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { applyRequestedWorktreeSymlinksMock, execGitMock } = vi.hoisted(() => ({
  applyRequestedWorktreeSymlinksMock: vi.fn(),
  execGitMock: vi.fn(),
}));

vi.mock('./git-exec.js', () => ({
  execGit: execGitMock,
}));

vi.mock('./git-worktree-symlinks.js', async () => {
  const actual = await vi.importActual<typeof import('./git-worktree-symlinks.js')>(
    './git-worktree-symlinks.js',
  );
  return {
    ...actual,
    applyRequestedWorktreeSymlinks: applyRequestedWorktreeSymlinksMock,
  };
});

import { createWorktree } from './git-worktree.js';
import {
  encodeTaskWorktreeLinkRequestV1,
  WorktreeSymlinkSafetyError,
} from './git-worktree-symlinks.js';

describe('worktree link fatal cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'rev-parse' || args[0] === 'for-each-ref') {
        return { stderr: '', stdout: args[0] === 'for-each-ref' ? 'main\n' : 'abc123\n' };
      }
      if (args[0] === 'worktree' || args[0] === 'branch') {
        return { stderr: '', stdout: '' };
      }
      throw new Error(`Unexpected Git call: ${args.join(' ')}`);
    });
  });

  it('removes and prunes a new worktree before propagating a fatal safety error', async () => {
    const operationError = new WorktreeSymlinkSafetyError('unsafe link cleanup failed', [
      new Error('unlink failed'),
    ]);
    applyRequestedWorktreeSymlinksMock.mockRejectedValueOnce(operationError);

    await expect(
      createWorktree('/repo', 'task/fatal-links', encodeTaskWorktreeLinkRequestV1(['cache'])),
    ).rejects.toBe(operationError);

    expect(applyRequestedWorktreeSymlinksMock).toHaveBeenCalledOnce();
    expect(execGitMock.mock.calls.map(([args]) => args)).toEqual([
      ['rev-parse', '--verify', 'HEAD'],
      ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads'],
      ['worktree', 'add', '-b', 'task/fatal-links', '/repo/.worktrees/task/fatal-links'],
      ['worktree', 'remove', '--force', '/repo/.worktrees/task/fatal-links'],
      ['worktree', 'prune'],
      ['branch', '-D', '--', 'task/fatal-links'],
    ]);
  });

  it('composes operation and cleanup failures instead of hiding either cause', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-link-cleanup-'));
    const branchName = 'task/composed-failure';
    const worktreePath = path.join(repoRoot, '.worktrees', branchName);
    const operationError = new WorktreeSymlinkSafetyError('unsafe link remained', [
      new Error('identity changed'),
    ]);
    applyRequestedWorktreeSymlinksMock.mockRejectedValueOnce(operationError);
    execGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'rev-parse' || args[0] === 'for-each-ref') {
        return { stderr: '', stdout: args[0] === 'for-each-ref' ? 'main\n' : 'abc123\n' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        fs.mkdirSync(worktreePath, { recursive: true });
        return { stderr: '', stdout: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('git removal failed');
      }
      if (args[0] === 'worktree' && args[1] === 'prune') {
        throw new Error('git prune failed');
      }
      if (args[0] === 'branch') {
        return { stderr: '', stdout: '' };
      }
      throw new Error(`Unexpected Git call: ${args.join(' ')}`);
    });
    const removeSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('filesystem removal failed');
    });

    let thrown: unknown;
    try {
      await createWorktree(repoRoot, branchName, encodeTaskWorktreeLinkRequestV1(['cache']));
    } catch (error) {
      thrown = error;
    } finally {
      removeSpy.mockRestore();
      fs.rmSync(repoRoot, { force: true, recursive: true });
    }

    expect(thrown).toBeInstanceOf(WorktreeSymlinkSafetyError);
    expect((thrown as WorktreeSymlinkSafetyError).causes[0]).toBe(operationError);
    expect((thrown as WorktreeSymlinkSafetyError).causes[1]).toBeInstanceOf(
      WorktreeSymlinkSafetyError,
    );
  });
});
