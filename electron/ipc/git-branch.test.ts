import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});
