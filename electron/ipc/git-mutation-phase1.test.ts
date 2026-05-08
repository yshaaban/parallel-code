import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  detectMainBranchMock,
  execFileMock,
  getCurrentBranchNameMock,
  invalidateGitQueryCacheForPathMock,
  removeWorktreeMock,
  spawnMock,
  withWorktreeLockMock,
} = vi.hoisted(() => ({
  detectMainBranchMock: vi.fn(),
  execFileMock: vi.fn(),
  getCurrentBranchNameMock: vi.fn(),
  invalidateGitQueryCacheForPathMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  spawnMock: vi.fn(),
  withWorktreeLockMock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

vi.mock('./git-branch.js', () => ({
  detectMainBranch: detectMainBranchMock,
  getCurrentBranchName: getCurrentBranchNameMock,
}));

vi.mock('./git-cache.js', () => ({
  invalidateGitQueryCacheForPath: invalidateGitQueryCacheForPathMock,
  withWorktreeLock: withWorktreeLockMock,
}));

vi.mock('./git-worktree.js', () => ({
  removeWorktree: removeWorktreeMock,
}));

vi.mock('./git-status-parser.js', () => ({
  parseConflictPath: vi.fn(() => null),
}));

const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

type ExecResult = { stderr: string; stdout: string };

function setExecImplementation(
  implementation: (
    command: string,
    args: string[],
    options: { cwd?: string },
  ) => Promise<ExecResult>,
): void {
  Object.defineProperty(execFileMock, PROMISIFY_CUSTOM, {
    configurable: true,
    value: implementation,
    writable: true,
  });
}

describe('git mutation phase 1 parity', () => {
  beforeEach(() => {
    vi.resetModules();
    detectMainBranchMock.mockReset();
    execFileMock.mockReset();
    getCurrentBranchNameMock.mockReset();
    invalidateGitQueryCacheForPathMock.mockReset();
    removeWorktreeMock.mockReset();
    spawnMock.mockReset();
    withWorktreeLockMock.mockClear();
  });

  it('reports the current worktree branch in merge status', async () => {
    detectMainBranchMock.mockResolvedValue('main');
    getCurrentBranchNameMock.mockResolvedValue('feature/task');
    setExecImplementation(async (_command, args) => {
      if (args[0] === 'rev-list') {
        expect(args).toEqual([
          'rev-list',
          '--count',
          '--cherry-pick',
          '--right-only',
          'HEAD...main',
        ]);
        return { stderr: '', stdout: '0\n' };
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`);
    });

    const { checkMergeStatus } = await import('./git-mutation-ops.js');

    await expect(checkMergeStatus('/repo/.worktrees/task')).resolves.toEqual({
      conflicting_files: [],
      current_branch: 'feature/task',
      main_ahead_count: 0,
    });
  });

  it('counts only non-patch-equivalent base-branch commits as main ahead', async () => {
    detectMainBranchMock.mockResolvedValue('release/main');
    getCurrentBranchNameMock.mockResolvedValue('feature/task');
    setExecImplementation(async (_command, args) => {
      if (args[0] === 'rev-list') {
        expect(args).toEqual([
          'rev-list',
          '--count',
          '--cherry-pick',
          '--right-only',
          'HEAD...release/main',
        ]);
        return { stderr: '', stdout: '2\n' };
      }
      if (args[0] === 'merge-tree') {
        return { stderr: '', stdout: '' };
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`);
    });

    const { checkMergeStatus } = await import('./git-mutation-ops.js');

    await expect(checkMergeStatus('/repo/.worktrees/task', 'release/main')).resolves.toEqual({
      conflicting_files: [],
      current_branch: 'feature/task',
      main_ahead_count: 2,
    });
    expect(detectMainBranchMock).toHaveBeenCalledWith('/repo/.worktrees/task', 'release/main');
  });

  it('rejects merge when the worktree branch no longer matches the task branch', async () => {
    getCurrentBranchNameMock.mockResolvedValue('feature/other-branch');
    setExecImplementation(async (_command, args) => {
      if (args[0] === 'rev-parse') {
        return { stderr: '', stdout: '.git\n' };
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`);
    });

    const { mergeTask } = await import('./git-mutation-ops.js');

    await expect(
      mergeTask('/repo', '/repo/.worktrees/task', 'feature/task', false, null, false),
    ).rejects.toThrow(
      "Task worktree is on 'feature/other-branch', expected 'feature/task'. Refresh the task branch before merging.",
    );
  });

  it('computes merge stats from the merge base before merging', async () => {
    detectMainBranchMock.mockResolvedValue('main');
    getCurrentBranchNameMock.mockImplementation(async (repoPath: string) => {
      if (repoPath === '/repo/.worktrees/task') {
        return 'feature/task';
      }
      return 'feature/task';
    });
    setExecImplementation(async (_command, args, options) => {
      if (args[0] === 'rev-parse') {
        return { stderr: '', stdout: '.git\n' };
      }
      if (args[0] === 'merge-base') {
        expect(options.cwd).toBe('/repo');
        expect(args).toEqual(['merge-base', 'main', 'feature/task']);
        return { stderr: '', stdout: 'base789\n' };
      }
      if (args[0] === 'diff') {
        expect(args).toEqual(['diff', '--numstat', 'base789..feature/task']);
        return { stderr: '', stdout: '4\t1\tsrc/feature.ts\n' };
      }
      if (args[0] === 'status') {
        return { stderr: '', stdout: '' };
      }
      if (args[0] === 'checkout') {
        return { stderr: '', stdout: '' };
      }
      if (args[0] === 'merge') {
        return { stderr: '', stdout: '' };
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`);
    });

    const { mergeTask } = await import('./git-mutation-ops.js');

    await expect(
      mergeTask(
        '/repo',
        '/repo/.worktrees/task',
        'feature/task',
        false,
        null,
        false,
        'release/main',
      ),
    ).resolves.toEqual({
      lines_added: 4,
      lines_removed: 1,
      main_branch: 'main',
    });
    expect(detectMainBranchMock).toHaveBeenCalledWith('/repo', 'release/main');
  });
});
