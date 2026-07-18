import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
}));

describe('execGitSync', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
  });

  it('applies the bounded default while forwarding Git args and caller options', async () => {
    execFileSyncMock.mockReturnValue('main\n');
    const { DEFAULT_GIT_EXEC_TIMEOUT_MS } = await import('./git-process-policy.js');
    const { execGitSync } = await import('./git-sync-exec.js');

    expect(execGitSync(['check-ref-format', '--branch', 'main'], { encoding: 'utf8' })).toBe(
      'main\n',
    );
    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['check-ref-format', '--branch', 'main'], {
      encoding: 'utf8',
      timeout: DEFAULT_GIT_EXEC_TIMEOUT_MS,
    });
  });

  it('preserves an explicit zero timeout override', async () => {
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    const { execGitSync } = await import('./git-sync-exec.js');

    execGitSync(['status'], { encoding: 'buffer', timeout: 0 });

    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['status'], {
      encoding: 'buffer',
      timeout: 0,
    });
  });

  it('records synchronous Git subprocesses in runtime diagnostics', async () => {
    execFileSyncMock.mockReturnValue('main\n');
    const { execGitSync } = await import('./git-sync-exec.js');
    const {
      getBackendRuntimeDiagnosticsSnapshot,
      getGitSubprocessCount,
      resetBackendRuntimeDiagnostics,
    } = await import('./runtime-diagnostics.js');

    resetBackendRuntimeDiagnostics();
    execGitSync(['check-ref-format', '--branch', 'main'], { encoding: 'utf8' });

    expect(getGitSubprocessCount()).toBe(1);
    expect(getBackendRuntimeDiagnosticsSnapshot().gitSubprocessCount).toBe(1);
  });

  it('preserves the null result produced when stdout is ignored', async () => {
    execFileSyncMock.mockReturnValue(null);
    const { execGitSync } = await import('./git-sync-exec.js');

    expect(
      execGitSync(['check-ref-format', '--branch', 'main'], {
        encoding: 'utf8',
        stdio: 'ignore',
      }),
    ).toBeNull();
  });
});
