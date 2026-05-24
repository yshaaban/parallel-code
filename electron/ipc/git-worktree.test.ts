import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

function mockExecFile(
  handler: (
    cmd: string,
    args: string[],
    cwd: string | undefined,
  ) => { stderr?: string; stdout?: string },
): void {
  execFileMock.mockImplementation(
    (
      cmd: string,
      args: string[],
      optionsOrCallback:
        | {
            cwd?: string;
          }
        | ((error: Error | null, stdout: string, stderr: string) => void),
      maybeCallback?: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      if (!callback) {
        throw new Error('Missing callback');
      }

      const cwd = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback.cwd;

      try {
        const result = handler(cmd, args, cwd);
        callback(null, result.stdout ?? '', result.stderr ?? '');
      } catch (error) {
        callback(error as Error, '', '');
      }
    },
  );

  Object.defineProperty(execFileMock, PROMISIFY_CUSTOM, {
    configurable: true,
    value: (
      cmd: string,
      args: string[],
      options?: {
        cwd?: string;
      },
    ) =>
      new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
        execFileMock(
          cmd,
          args,
          options ?? {},
          (error: Error | null, stdout: string, stderr: string) => {
            if (error) {
              reject(error);
              return;
            }

            resolve({ stderr, stdout });
          },
        );
      }),
  });
}

describe('git-worktree', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects worktree creation in an empty repository with a clear error', async () => {
    mockExecFile((_cmd, args, cwd) => {
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
    mockExecFile((_cmd, args, cwd) => {
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
    mockExecFile((_cmd, args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'feature/base') {
        throw new Error('missing local base branch');
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/feature/base') {
        return { stdout: 'abc123\n' };
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
    mockExecFile((_cmd, args, cwd) => {
      if (cwd !== '/repo') {
        throw new Error(`Unexpected cwd: ${cwd}`);
      }

      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'feature/base') {
        return { stdout: 'abc123\n' };
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

  it('parses git porcelain worktree output for import discovery', async () => {
    mockExecFile((_cmd, args, cwd) => {
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
