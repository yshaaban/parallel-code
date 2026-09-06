import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  detectMainBranchMock,
  execGitMock,
  getCurrentBranchNameMock,
  invalidateGitQueryCacheForPathMock,
  removeWorktreeMock,
  withWorktreeLockMock,
} = vi.hoisted(() => ({
  detectMainBranchMock: vi.fn(),
  execGitMock: vi.fn(),
  getCurrentBranchNameMock: vi.fn(),
  invalidateGitQueryCacheForPathMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  withWorktreeLockMock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./git-exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./git-exec.js')>()),
  execGit: execGitMock,
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

type ExecResult = { stderr: string; stdout: string };

function setExecImplementation(
  implementation: (args: readonly string[], options: { cwd?: string }) => Promise<ExecResult>,
): void {
  execGitMock.mockImplementation((args: readonly string[], options: { cwd?: string } = {}) =>
    implementation(args, options),
  );
}

describe('git mutation phase 1 parity', () => {
  beforeEach(() => {
    vi.resetModules();
    detectMainBranchMock.mockReset();
    execGitMock.mockReset();
    getCurrentBranchNameMock.mockReset();
    invalidateGitQueryCacheForPathMock.mockReset();
    removeWorktreeMock.mockReset();
    withWorktreeLockMock.mockClear();
  });

  it('reports the current worktree branch in merge status', async () => {
    detectMainBranchMock.mockResolvedValue('main');
    getCurrentBranchNameMock.mockResolvedValue('feature/task');
    setExecImplementation(async (args) => {
      if (args[0] === 'show-ref' && args[3] === 'refs/heads/main')
        return { stderr: '', stdout: 'main123\n' };
      if (args[0] === 'rev-list') {
        expect(args).toEqual([
          'rev-list',
          '--count',
          '--cherry-pick',
          '--right-only',
          'HEAD...refs/heads/main',
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
    setExecImplementation(async (args) => {
      if (args[0] === 'show-ref' && args[3] === 'refs/heads/release/main')
        return { stderr: '', stdout: 'main123\n' };
      if (args[0] === 'rev-list') {
        expect(args).toEqual([
          'rev-list',
          '--count',
          '--cherry-pick',
          '--right-only',
          'HEAD...refs/heads/release/main',
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
    setExecImplementation(async (args) => {
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
    setExecImplementation(async (args, options) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stderr: '', stdout: '.git\n' };
      }
      if (args[0] === 'show-ref' && args[3] === 'refs/heads/main')
        return { stderr: '', stdout: 'main123\n' };
      if (args[0] === 'rev-parse' && args[2] === 'refs/heads/feature/task')
        return { stderr: '', stdout: 'task123\n' };
      if (args[0] === 'merge-base') {
        expect(options.cwd).toBe('/repo');
        expect(args).toEqual(['merge-base', 'refs/heads/main', 'task123']);
        return { stderr: '', stdout: 'base789\n' };
      }
      if (args[0] === 'diff') {
        expect(args).toEqual(['diff', '--numstat', 'base789..task123']);
        return { stderr: '', stdout: '4\t1\tsrc/feature.ts\n' };
      }
      if (args[0] === 'status') {
        return { stderr: '', stdout: '' };
      }
      if (args[0] === 'switch') {
        return { stderr: '', stdout: '' };
      }
      if (args[0] === 'merge') {
        return { stderr: '', stdout: '' };
      }
      if (args[0] === 'fmt-merge-msg')
        return { stderr: '', stdout: "Merge branch 'feature/task'\n" };
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
