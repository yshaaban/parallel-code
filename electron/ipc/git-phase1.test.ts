import { beforeEach, describe, expect, it, vi } from 'vitest';

const { detectMainBranchMock, execFileMock, worktreeExistsMock } = vi.hoisted(() => ({
  detectMainBranchMock: vi.fn(),
  execFileMock: vi.fn(),
  worktreeExistsMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('./git-branch.js', () => ({
  detectMainBranch: detectMainBranchMock,
  getCurrentBranchName: vi.fn(),
}));

vi.mock('./git-cache.js', () => ({
  cacheKey: vi.fn((value: string) => value),
  invalidateGitQueryCacheForPath: vi.fn(),
  invalidateWorktreeStatusCache: vi.fn(),
  MAX_BUFFER: 1024 * 1024,
  withGitQueryCache: vi.fn((_key: string, loader: () => Promise<unknown>) => loader()),
}));

vi.mock('./git-worktree.js', () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  worktreeExists: worktreeExistsMock,
  SYMLINK_CANDIDATES: [],
}));

vi.mock('./git-diff-ops.js', () => ({}));
vi.mock('./git-mutation-ops.js', () => ({}));
vi.mock('./git-types.js', () => ({}));

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

describe('git phase 1 parity', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    detectMainBranchMock.mockReset();
    worktreeExistsMock.mockReset();
  });

  it('uses the merge base when checking for committed worktree changes', async () => {
    detectMainBranchMock.mockResolvedValue('main');
    worktreeExistsMock.mockResolvedValue(true);
    setExecImplementation(async (_command, args) => {
      if (args[0] === 'status') {
        return { stderr: '', stdout: '' };
      }
      if (args[0] === 'merge-base') {
        return { stderr: '', stdout: 'base123\n' };
      }
      if (args[0] === 'log') {
        expect(args).toEqual(['log', 'base123..HEAD', '--oneline']);
        return { stderr: '', stdout: 'abc123 feature commit\n' };
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`);
    });

    const { getWorktreeStatus } = await import('./git.js');

    await expect(getWorktreeStatus('/repo/.worktrees/task')).resolves.toEqual({
      has_committed_changes: true,
      has_uncommitted_changes: false,
    });
  });

  it('uses the merge base when loading the branch log', async () => {
    detectMainBranchMock.mockResolvedValue('main');
    setExecImplementation(async (_command, args) => {
      if (args[0] === 'merge-base') {
        return { stderr: '', stdout: 'base456\n' };
      }
      if (args[0] === 'log') {
        expect(args).toEqual(['log', 'base456..HEAD', '--pretty=format:- %h %s']);
        return { stderr: '', stdout: '- abc123 feature commit' };
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`);
    });

    const { getBranchLog } = await import('./git.js');

    await expect(getBranchLog('/repo/.worktrees/task')).resolves.toBe('- abc123 feature commit');
  });
});
