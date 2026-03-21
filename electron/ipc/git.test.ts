import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

describe('getGitRepoRoot', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    vi.restoreAllMocks();
    (execFileMock as Record<PropertyKey, unknown>)[PROMISIFY_CUSTOM] = undefined;
  });

  it('preserves a selected symlinked repo root path when it resolves to the real git root', async () => {
    (execFileMock as Record<PropertyKey, unknown>)[PROMISIFY_CUSTOM] = vi.fn(async () => ({
      stderr: '',
      stdout: '/real/repo\n',
    }));
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
    (execFileMock as Record<PropertyKey, unknown>)[PROMISIFY_CUSTOM] = vi.fn(async () => ({
      stderr: '',
      stdout: '/real/repo\n',
    }));
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
