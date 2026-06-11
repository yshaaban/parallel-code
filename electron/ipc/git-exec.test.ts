import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

type ExecFilePromisifyImplementation = (
  cmd: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stderr: string; stdout: string }>;

function setExecFilePromisifyImplementation(
  implementation: ExecFilePromisifyImplementation | undefined,
): void {
  Object.defineProperty(execFileMock, PROMISIFY_CUSTOM, {
    configurable: true,
    value: implementation,
    writable: true,
  });
}

describe('execGit', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    setExecFilePromisifyImplementation(undefined);
  });

  it('forwards git args and options to execFile unchanged', async () => {
    const calls: Array<{ args: string[]; cmd: string; options: { cwd?: string } | undefined }> = [];
    setExecFilePromisifyImplementation(async (cmd, args, options) => {
      calls.push({ args, cmd, options });
      return { stderr: '', stdout: 'ok\n' };
    });

    const { execGit } = await import('./git-exec.js');
    const result = await execGit(['status', '--porcelain'], { cwd: '/repo' });

    expect(result).toEqual({ stderr: '', stdout: 'ok\n' });
    expect(calls).toEqual([
      { args: ['status', '--porcelain'], cmd: 'git', options: { cwd: '/repo' } },
    ]);
  });

  it('rejects with the underlying execFile error', async () => {
    setExecFilePromisifyImplementation(async () => {
      throw new Error('git failed');
    });

    const { execGit } = await import('./git-exec.js');

    await expect(execGit(['rev-parse', 'HEAD'], { cwd: '/repo' })).rejects.toThrow('git failed');
  });

  it('counts every spawned git subprocess in runtime diagnostics', async () => {
    setExecFilePromisifyImplementation(async () => ({ stderr: '', stdout: '' }));

    const { execGit } = await import('./git-exec.js');
    const {
      getBackendRuntimeDiagnosticsSnapshot,
      getGitSubprocessCount,
      resetBackendRuntimeDiagnostics,
    } = await import('./runtime-diagnostics.js');

    resetBackendRuntimeDiagnostics();
    await execGit(['rev-parse', 'HEAD'], { cwd: '/repo' });
    await execGit(['status', '--porcelain'], { cwd: '/repo' });

    expect(getGitSubprocessCount()).toBe(2);
    expect(getBackendRuntimeDiagnosticsSnapshot().gitSubprocessCount).toBe(2);

    resetBackendRuntimeDiagnostics();
    expect(getGitSubprocessCount()).toBe(0);
    expect(getBackendRuntimeDiagnosticsSnapshot().gitSubprocessCount).toBe(0);
  });
});
