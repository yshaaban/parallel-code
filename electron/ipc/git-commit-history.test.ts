import { beforeEach, describe, expect, it, vi } from 'vitest';

const { detectDiffBaseMock, execGitMock, getMainBranchMock } = vi.hoisted(() => ({
  detectDiffBaseMock: vi.fn(),
  execGitMock: vi.fn(),
  getMainBranchMock: vi.fn(),
}));

vi.mock('./git-exec.js', () => ({
  execGit: execGitMock,
}));

vi.mock('./git.js', () => ({
  getMainBranch: getMainBranchMock,
}));

vi.mock('./git-diff-base.js', () => ({
  detectDiffBase: detectDiffBaseMock,
}));

function mockExecGit(handler: (args: readonly string[], cwd: string | undefined) => string): void {
  execGitMock.mockImplementation(
    async (args: readonly string[], options?: { cwd?: string; maxBuffer?: number }) => ({
      stderr: '',
      stdout: handler(args, options?.cwd),
    }),
  );
}

describe('git commit history', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getMainBranchMock.mockResolvedValue('main');
    detectDiffBaseMock.mockResolvedValue({ ref: 'main', sha: 'basehash' });
  });

  it('returns structured commit summaries with per-commit file stats', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'rev-parse' && args[1] === 'feature/task') {
        return 'headhash\n';
      }

      if (args[0] === 'log') {
        return [
          'hash1\x1fabc123\x1fDev One\x1f2026-05-08T10:00:00Z\x1fbasehash\x1fFirst change',
          'hash2\x1fdef456\x1fDev Two\x1f2026-05-08T11:00:00Z\x1fhash1\x1fSecond change',
        ].join('\n');
      }

      if (
        args[0] === 'diff' &&
        args.includes('--numstat') &&
        args[args.length - 2] === 'basehash' &&
        args[args.length - 1] === 'hash1'
      ) {
        return '2\t1\tsrc/a.ts\n';
      }

      if (
        args[0] === 'diff' &&
        args.includes('--numstat') &&
        args[args.length - 2] === 'hash1' &&
        args[args.length - 1] === 'hash2'
      ) {
        return '0\t3\tsrc/b.ts\n';
      }

      if (
        args[0] === 'diff' &&
        args.includes('--name-status') &&
        args[args.length - 2] === 'basehash' &&
        args[args.length - 1] === 'hash1'
      ) {
        return 'M\tsrc/a.ts\n';
      }

      if (
        args[0] === 'diff' &&
        args.includes('--name-status') &&
        args[args.length - 2] === 'hash1' &&
        args[args.length - 1] === 'hash2'
      ) {
        return 'D\tsrc/b.ts\n';
      }

      throw new Error(`Unexpected git call: ${args.join(' ')}`);
    });

    const { getBranchCommitHistory } = await import('./git-commit-history.js');

    await expect(
      getBranchCommitHistory({
        branchName: 'feature/task',
        projectRoot: '/repo',
      }),
    ).resolves.toEqual({
      baseHash: 'basehash',
      headHash: 'headhash',
      revisionId: 'basehash:headhash',
      commits: [
        {
          authoredAt: '2026-05-08T10:00:00Z',
          authorName: 'Dev One',
          files: [
            {
              commitHash: 'hash1',
              committed: true,
              lines_added: 2,
              lines_removed: 1,
              path: 'src/a.ts',
              status: 'M',
            },
          ],
          hash: 'hash1',
          parentHashes: ['basehash'],
          shortHash: 'abc123',
          subject: 'First change',
          totalAdded: 2,
          totalRemoved: 1,
        },
        {
          authoredAt: '2026-05-08T11:00:00Z',
          authorName: 'Dev Two',
          files: [
            {
              commitHash: 'hash2',
              committed: true,
              lines_added: 0,
              lines_removed: 3,
              path: 'src/b.ts',
              status: 'D',
            },
          ],
          hash: 'hash2',
          parentHashes: ['hash1'],
          shortHash: 'def456',
          subject: 'Second change',
          totalAdded: 0,
          totalRemoved: 3,
        },
      ],
    });
    expect(detectDiffBaseMock).toHaveBeenCalledWith('/repo', 'main', 'headhash');
  });

  it('summarizes merge commits against their first parent', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'rev-parse' && args[1] === 'feature/task') {
        return 'mergehash\n';
      }

      if (args[0] === 'log') {
        return 'mergehash\x1fabc123\x1fDev One\x1f2026-05-08T10:00:00Z\x1ffirst-parent second-parent\x1fMerge feature';
      }

      if (
        args[0] === 'diff' &&
        args.includes('--numstat') &&
        args[args.length - 2] === 'first-parent' &&
        args[args.length - 1] === 'mergehash'
      ) {
        return '4\t1\tsrc/merged.ts\n';
      }

      if (
        args[0] === 'diff' &&
        args.includes('--name-status') &&
        args[args.length - 2] === 'first-parent' &&
        args[args.length - 1] === 'mergehash'
      ) {
        return 'M\tsrc/merged.ts\n';
      }

      throw new Error(`Unexpected git call: ${args.join(' ')}`);
    });

    const { getBranchCommitHistory } = await import('./git-commit-history.js');

    await expect(
      getBranchCommitHistory({
        branchName: 'feature/task',
        projectRoot: '/repo',
      }),
    ).resolves.toMatchObject({
      commits: [
        {
          files: [
            {
              commitHash: 'mergehash',
              lines_added: 4,
              lines_removed: 1,
              path: 'src/merged.ts',
              status: 'M',
            },
          ],
          hash: 'mergehash',
          parentHashes: ['first-parent', 'second-parent'],
          totalAdded: 4,
          totalRemoved: 1,
        },
      ],
    });
  });
});
