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
  ) => { stdout?: string; stderr?: string },
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
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFileMock(
          cmd,
          args,
          options ?? {},
          (error: Error | null, stdout: string, stderr: string) => {
            if (error) {
              reject(error);
              return;
            }

            resolve({
              stdout,
              stderr,
            });
          },
        );
      }),
  });
}

describe('git-branch', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('uses the synced configured base branch for matching worktrees', async () => {
    mockExecFile((_cmd, args, cwd) => {
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
        projects: [{ id: 'project-1', path: '/repo', baseBranch: ' personal/main ' }],
      }),
    );

    await expect(detectMainBranch('/repo/.worktrees/feature/task')).resolves.toBe('personal/main');
  });

  it('falls back to git detection after a configured base branch is removed', async () => {
    mockExecFile((_cmd, args, cwd) => {
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
        projects: [{ id: 'project-1', path: '/repo', baseBranch: 'personal/main' }],
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

  it('refreshes a stale origin head before falling back', async () => {
    let symbolicRefCallCount = 0;

    mockExecFile((_cmd, args, cwd) => {
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
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['remote', 'set-head', 'origin', '--auto'],
      expect.objectContaining({ cwd: '/repo', timeout: 5_000 }),
      expect.any(Function),
    );
  });

  it('falls back to remote-tracking main when refreshing origin head fails', async () => {
    mockExecFile((_cmd, args, cwd) => {
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
    mockExecFile((_cmd, args, cwd) => {
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
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['config', '--get', 'init.defaultBranch'],
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function),
    );
  });
});
