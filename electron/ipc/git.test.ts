import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execGitMock } = vi.hoisted(() => ({
  execGitMock: vi.fn(),
}));

vi.mock('./git-exec.js', () => ({
  execGit: execGitMock,
}));

function setExecGitImplementation(
  implementation: (
    args: readonly string[],
    options?: { cwd?: string; maxBuffer?: number },
  ) => Promise<{
    stderr: string;
    stdout: string;
  }>,
): void {
  execGitMock.mockImplementation(implementation);
}

describe('getGitRepoRoot', () => {
  beforeEach(() => {
    vi.resetModules();
    execGitMock.mockReset();
    vi.restoreAllMocks();
  });

  it('preserves a selected symlinked repo root path when it resolves to the real git root', async () => {
    setExecGitImplementation(
      vi.fn(async () => ({
        stderr: '',
        stdout: '/real/repo\n',
      })),
    );
    vi.spyOn(fs, 'realpathSync').mockImplementation((filePath) => {
      if (filePath === '/link/repo' || filePath === '/real/repo') {
        return '/real/repo';
      }

      return String(filePath);
    });

    const { getGitRepoRoot } = await import('./git.js');

    await expect(getGitRepoRoot('/link/repo')).resolves.toBe('/link/repo');
  });

  it('returns the actual repo root when the selected path is nested inside the repo', async () => {
    setExecGitImplementation(
      vi.fn(async () => ({
        stderr: '',
        stdout: '/real/repo\n',
      })),
    );
    vi.spyOn(fs, 'realpathSync').mockImplementation((filePath) => {
      if (filePath === '/link/repo/packages/app') {
        return '/real/repo/packages/app';
      }
      if (filePath === '/real/repo') {
        return '/real/repo';
      }

      return String(filePath);
    });

    const { getGitRepoRoot } = await import('./git.js');

    await expect(getGitRepoRoot('/link/repo/packages/app')).resolves.toBe('/real/repo');
  });
});

describe('listImportableWorktrees', () => {
  beforeEach(() => {
    vi.resetModules();
    execGitMock.mockReset();
    vi.restoreAllMocks();
  });

  it('filters registered worktree aliases by canonical path before status checks', async () => {
    setExecGitImplementation(
      vi.fn(async (args: readonly string[]) => {
        if (args.join(' ') === 'worktree list --porcelain') {
          return {
            stderr: '',
            stdout: [
              'worktree /real/repo',
              'branch refs/heads/main',
              '',
              'worktree /real/repo/.worktrees/imported',
              'branch refs/heads/task/imported',
              '',
            ].join('\n'),
          };
        }

        throw new Error(`Unexpected git call: ${args.join(' ')}`);
      }),
    );
    vi.spyOn(fs, 'realpathSync').mockImplementation((filePath) => {
      if (filePath === '/link/repo/.worktrees/imported') {
        return '/real/repo/.worktrees/imported';
      }
      return String(filePath);
    });

    const { listImportableWorktrees } = await import('./git.js');

    await expect(
      listImportableWorktrees('/real/repo', {
        registeredWorktreePaths: ['/link/repo/.worktrees/imported'],
      }),
    ).resolves.toEqual([]);
  });
});
