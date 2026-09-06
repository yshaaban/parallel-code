import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GIT_BRANCH_TEST_TIMEOUT_MS = 15_000;

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
  ) => { stdout?: string; stderr?: string },
): void {
  execGitMock.mockImplementation(
    async (args: readonly string[], options?: { cwd?: string; timeout?: number }) => {
      const result = handler(args, options?.cwd);
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
  );
}

describe('git-branch', { timeout: GIT_BRANCH_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
    execGitMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('uses the synced configured base branch for matching worktrees', async () => {
    mockExecGit((args, cwd) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir' && cwd === '/repo') {
        return { stdout: '.git\n' };
      }
      if (
        args[0] === 'rev-parse' &&
        args[1] === '--git-common-dir' &&
        cwd === '/repo/.worktrees/feature/task'
      ) {
        return { stdout: '/repo/.git\n' };
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { detectMainBranch, syncConfiguredBaseBranchesFromSavedState } =
      await import('./git-branch.js');

    await syncConfiguredBaseBranchesFromSavedState(
      JSON.stringify({
        projects: [
          {
            id: 'project-1',
            path: '/repo',
            baseBranch: ' personal/main ',
            defaultTaskGitIsolation: 'current-branch',
          },
        ],
      }),
    );

    await expect(detectMainBranch('/repo/.worktrees/feature/task')).resolves.toBe('personal/main');
  });

  it('falls back to git detection after a configured base branch is removed', async () => {
    mockExecGit((args, cwd) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir' && cwd === '/repo') {
        return { stdout: '.git\n' };
      }
      if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD' && cwd === '/repo') {
        return { stdout: 'refs/remotes/origin/main\n' };
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { detectMainBranch, syncConfiguredBaseBranchesFromSavedState } =
      await import('./git-branch.js');

    await syncConfiguredBaseBranchesFromSavedState(
      JSON.stringify({
        projects: [
          {
            id: 'project-1',
            path: '/repo',
            baseBranch: 'personal/main',
            defaultTaskGitIsolation: 'worktree',
          },
        ],
      }),
    );
    await expect(detectMainBranch('/repo')).resolves.toBe('personal/main');

    await syncConfiguredBaseBranchesFromSavedState(
      JSON.stringify({
        projects: [{ id: 'project-1', path: '/repo' }],
      }),
    );
    await expect(detectMainBranch('/repo')).resolves.toBe('main');
  });

  it('ignores configured base branches from non-git project records', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
        return { stdout: 'refs/remotes/origin/main\n' };
      }

      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'refs/remotes/origin/main'
      ) {
        return { stdout: 'abc123\n' };
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { detectMainBranch, syncConfiguredBaseBranchesFromSavedState } =
      await import('./git-branch.js');

    await syncConfiguredBaseBranchesFromSavedState(
      JSON.stringify({
        projects: [
          {
            id: 'project-1',
            path: '/repo',
            baseBranch: 'personal/main',
            projectMode: 'non-git',
          },
        ],
      }),
    );

    await expect(detectMainBranch('/repo')).resolves.toBe('main');
  });

  it('refreshes a stale origin head before falling back', async () => {
    let symbolicRefCallCount = 0;

    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
        symbolicRefCallCount += 1;
        return {
          stdout:
            symbolicRefCallCount === 1
              ? 'refs/remotes/origin/master\n'
              : 'refs/remotes/origin/main\n',
        };
      }

      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'refs/remotes/origin/master'
      ) {
        throw new Error('stale origin head');
      }

      if (
        args[0] === 'remote' &&
        args[1] === 'set-head' &&
        args[2] === 'origin' &&
        args[3] === '--auto'
      ) {
        return {};
      }

      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'refs/remotes/origin/main'
      ) {
        return { stdout: 'abc123\n' };
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { detectMainBranch } = await import('./git-branch.js');

    await expect(detectMainBranch('/repo')).resolves.toBe('main');
    expect(execGitMock).toHaveBeenCalledWith(
      ['remote', 'set-head', 'origin', '--auto'],
      expect.objectContaining({ cwd: '/repo', timeout: 5_000 }),
    );
  });

  it('falls back to remote-tracking main when refreshing origin head fails', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
        return { stdout: 'refs/remotes/origin/master\n' };
      }

      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'refs/remotes/origin/master'
      ) {
        throw new Error('stale origin head');
      }

      if (
        args[0] === 'remote' &&
        args[1] === 'set-head' &&
        args[2] === 'origin' &&
        args[3] === '--auto'
      ) {
        throw new Error('remote unavailable');
      }

      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'refs/remotes/origin/main'
      ) {
        return { stdout: 'abc123\n' };
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { detectMainBranch } = await import('./git-branch.js');

    await expect(detectMainBranch('/repo')).resolves.toBe('main');
  });

  it('uses the configured init default branch when no remote-tracking defaults exist', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
        throw new Error('missing origin head');
      }

      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        (args[2] === 'refs/remotes/origin/main' || args[2] === 'refs/remotes/origin/master')
      ) {
        throw new Error('missing remote-tracking branch');
      }

      if (args[0] === 'config' && args[1] === '--get' && args[2] === 'init.defaultBranch') {
        return { stdout: 'trunk\n' };
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { detectMainBranch } = await import('./git-branch.js');

    await expect(detectMainBranch('/repo')).resolves.toBe('trunk');
    expect(execGitMock).toHaveBeenCalledWith(
      ['config', '--get', 'init.defaultBranch'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('falls back to a local default branch when no remote-tracking default exists', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
        throw new Error('missing origin head');
      }

      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        (args[2] === 'refs/remotes/origin/main' || args[2] === 'refs/remotes/origin/master')
      ) {
        throw new Error('missing remote-tracking branch');
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/heads/main') {
        return { stdout: 'abc123\n' };
      }

      if (args[0] === 'config' && args[1] === '--get' && args[2] === 'init.defaultBranch') {
        throw new Error('should not query init.defaultBranch');
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { detectMainBranch } = await import('./git-branch.js');

    await expect(detectMainBranch('/repo')).resolves.toBe('main');
  });

  it('lists local and remote branches with default and current metadata', async () => {
    mockExecGit((args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
        return { stdout: 'refs/remotes/origin/main\n' };
      }

      if (args[0] === 'symbolic-ref' && args[1] === 'HEAD') {
        return { stdout: 'refs/heads/feature/local\n' };
      }

      if (
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'refs/remotes/origin/main'
      ) {
        return { stdout: 'abc123\n' };
      }

      if (args[0] === 'for-each-ref') {
        return {
          stdout: [
            'refs/heads/feature/local\torigin/feature/local',
            'refs/heads/main\torigin/main',
            'refs/remotes/origin/HEAD\t',
            'refs/remotes/origin/main\t',
            'refs/remotes/origin/feature/remote\t',
          ].join('\n'),
        };
      }

      throw new Error(`Unexpected git call for ${cwd}: ${args.join(' ')}`);
    });

    const { listBranches } = await import('./git-branch.js');

    await expect(listBranches('/repo')).resolves.toMatchObject({
      defaultBranch: 'main',
      branches: [
        {
          current: false,
          local: true,
          name: 'main',
          remote: true,
          remoteRef: 'origin/main',
          upstream: 'origin/main',
        },
        {
          current: true,
          local: true,
          name: 'feature/local',
          remote: false,
          upstream: 'origin/feature/local',
        },
        {
          current: false,
          local: false,
          name: 'feature/remote',
          remote: true,
          remoteRef: 'origin/feature/remote',
        },
      ],
    });
  });
});
