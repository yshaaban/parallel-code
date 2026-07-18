import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execGitMock } = vi.hoisted(() => ({
  execGitMock: vi.fn(),
}));

vi.mock('./git-exec.js', () => ({
  execGit: execGitMock,
}));

function mockExecGit(
  handler: (
    args: readonly string[],
    cwd: string | undefined,
  ) => { stderr?: string; stdout?: string },
): void {
  execGitMock.mockImplementation(async (args: readonly string[], options?: { cwd?: string }) => {
    const result = handler(args, options?.cwd);
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  });
}

describe('git-worktree', () => {
  beforeEach(() => {
    vi.resetModules();
    execGitMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects worktree creation in an empty repository with a clear error', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        throw new Error('missing HEAD');
      }

      if (args[0] === 'rev-list' && args[1] === '-n1' && args[2] === '--all') {
        return { stdout: '' };
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { createWorktree } = await import('./git-worktree.js');

    await expect(createWorktree('/repo', 'task/test', [])).rejects.toThrow(
      'Cannot create a worktree in a repository with no commits. Please make an initial commit first.',
    );
  });

  it('rejects a missing base branch with a clear error in a non-empty repository', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'feature/base') {
        throw new Error('missing base branch');
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/feature/base') {
        throw new Error('missing remote base branch');
      }

      if (args[0] === 'rev-list' && args[1] === '-n1' && args[2] === '--all') {
        return { stdout: 'abc123\n' };
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { createWorktree } = await import('./git-worktree.js');

    await expect(createWorktree('/repo', 'task/test', [], false, 'feature/base')).rejects.toThrow(
      'Branch "feature/base" does not exist. Please select a valid base branch or create the branch first.',
    );
  });

  it('uses the origin tracking ref when the selected base branch is remote-only', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'feature/base') {
        throw new Error('missing local base branch');
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/feature/base') {
        return { stdout: 'abc123\n' };
      }

      if (args.join(' ') === 'for-each-ref --format=%(refname:strip=2) refs/heads') {
        return { stdout: 'main\nfeature/base\n' };
      }

      if (
        args[0] === 'worktree' &&
        args[1] === 'add' &&
        args[2] === '-b' &&
        args[3] === 'task/test' &&
        args[4] === '/repo/.worktrees/task/test' &&
        args[5] === 'origin/feature/base'
      ) {
        return {};
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { createWorktree } = await import('./git-worktree.js');

    await expect(createWorktree('/repo', 'task/test', [], false, 'feature/base')).resolves.toEqual({
      branch: 'task/test',
      path: '/repo/.worktrees/task/test',
    });
  });

  it('passes the validated base branch through to git worktree add', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'feature/base') {
        return { stdout: 'abc123\n' };
      }

      if (args.join(' ') === 'for-each-ref --format=%(refname:strip=2) refs/heads') {
        return { stdout: 'main\nfeature/base\n' };
      }

      if (
        args[0] === 'worktree' &&
        args[1] === 'add' &&
        args[2] === '-b' &&
        args[3] === 'task/test' &&
        args[4] === '/repo/.worktrees/task/test' &&
        args[5] === 'feature/base'
      ) {
        return {};
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { createWorktree } = await import('./git-worktree.js');

    await expect(createWorktree('/repo', 'task/test', [], false, 'feature/base')).resolves.toEqual({
      branch: 'task/test',
      path: '/repo/.worktrees/task/test',
    });
  });

  it('rejects a proposed branch below an existing local branch ref', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        return { stdout: 'abc123\n' };
      }

      if (args.join(' ') === 'for-each-ref --format=%(refname:strip=2) refs/heads') {
        return { stdout: 'main\nfeature\n' };
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { createWorktree } = await import('./git-worktree.js');

    await expect(createWorktree('/repo', 'feature/task', [])).rejects.toThrow(
      'Cannot create branch "feature/task" because local branch "feature" already uses that ref path.',
    );
    expect(
      execGitMock.mock.calls.some(
        ([args]) => Array.isArray(args) && args.join(' ').startsWith('worktree add'),
      ),
    ).toBe(false);
  });

  it('rejects a proposed branch that would block an existing local branch ref', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        return { stdout: 'abc123\n' };
      }

      if (args.join(' ') === 'for-each-ref --format=%(refname:strip=2) refs/heads') {
        return { stdout: 'main\nfeature/task\n' };
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { createWorktree } = await import('./git-worktree.js');

    await expect(createWorktree('/repo', 'feature', [])).rejects.toThrow(
      'Cannot create branch "feature" because it would block existing local branch "feature/task".',
    );
    expect(
      execGitMock.mock.calls.some(
        ([args]) => Array.isArray(args) && args.join(' ').startsWith('worktree add'),
      ),
    ).toBe(false);
  });

  it('allows an exact local branch match so task allocation can retry on normal collision errors', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        return { stdout: 'abc123\n' };
      }

      if (args.join(' ') === 'for-each-ref --format=%(refname:strip=2) refs/heads') {
        return { stdout: 'main\ntask/test\n' };
      }

      if (
        args[0] === 'worktree' &&
        args[1] === 'add' &&
        args[2] === '-b' &&
        args[3] === 'task/test'
      ) {
        return {};
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { createWorktree } = await import('./git-worktree.js');

    await expect(createWorktree('/repo', 'task/test', [])).resolves.toEqual({
      branch: 'task/test',
      path: '/repo/.worktrees/task/test',
    });
  });

  it('parses git porcelain worktree output for import discovery', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args.join(' ') === 'worktree list --porcelain') {
        return {
          stdout: [
            'worktree /repo',
            'HEAD abc123',
            'branch refs/heads/main',
            '',
            'worktree /repo/.worktrees/task/auth',
            'HEAD def456',
            'branch refs/heads/task/auth',
            '',
            'worktree /repo/.worktrees/detached',
            'HEAD fedcba',
            'detached',
            '',
          ].join('\n'),
        };
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { listGitWorktrees } = await import('./git-worktree.js');

    await expect(listGitWorktrees('/repo')).resolves.toEqual([
      {
        branchName: 'main',
        detached: false,
        path: '/repo',
      },
      {
        branchName: 'task/auth',
        detached: false,
        path: '/repo/.worktrees/task/auth',
      },
      {
        branchName: null,
        detached: true,
        path: '/repo/.worktrees/detached',
      },
    ]);
  });
});
