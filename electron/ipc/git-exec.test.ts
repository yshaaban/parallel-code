import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

interface FakeStream extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  setEncoding: ReturnType<typeof vi.fn>;
}

interface FakeProcess extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
  spawnfile: string;
  stderr: FakeStream;
  stdin: FakeStream;
  stdout: FakeStream;
}

function createStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.destroy = vi.fn();
  stream.end = vi.fn();
  stream.setEncoding = vi.fn(() => stream);
  return stream;
}

function createSpawnProcess(): FakeProcess {
  const child = new EventEmitter() as FakeProcess;
  child.kill = vi.fn(() => true);
  child.spawnfile = 'git';
  child.stderr = createStream();
  child.stdin = createStream();
  child.stdout = createStream();
  return child;
}

describe('execGit', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the bounded default while forwarding git args and caller options', async () => {
    const child = createSpawnProcess();
    spawnMock.mockReturnValue(child);

    const { execGit } = await import('./git-exec.js');
    const result = execGit(['status', '--porcelain'], { cwd: '/repo' });
    child.stdout.emit('data', Buffer.from('ok\n'));
    child.emit('close', 0, null);

    await expect(result).resolves.toEqual({ stderr: '', stdout: 'ok\n' });
    expect(spawnMock).toHaveBeenCalledWith('git', ['status', '--porcelain'], {
      cwd: '/repo',
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('preserves an explicit zero timeout override', async () => {
    vi.useFakeTimers();
    const child = createSpawnProcess();
    spawnMock.mockReturnValue(child);

    const { execGit } = await import('./git-exec.js');
    const result = execGit(['status'], { timeout: 0 });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', 0, null);

    await expect(result).resolves.toEqual({ stderr: '', stdout: '' });
  });

  it('supports bounded buffer reads without a direct execFile escape hatch', async () => {
    const child = createSpawnProcess();
    spawnMock.mockReturnValue(child);
    const { execGitBuffer } = await import('./git-exec.js');
    const result = execGitBuffer(['show', 'HEAD:file'], { cwd: '/repo' });
    child.stdout.emit('data', Buffer.from('binary'));
    child.emit('close', 0, null);

    await expect(result).resolves.toEqual({
      stderr: Buffer.alloc(0),
      stdout: Buffer.from('binary'),
    });
  });

  it('rejects with the underlying spawn error', async () => {
    const child = createSpawnProcess();
    spawnMock.mockReturnValue(child);
    const { execGit } = await import('./git-exec.js');
    const result = execGit(['rev-parse', 'HEAD'], { cwd: '/repo' });
    const rejection = expect(result).rejects.toThrow('git failed');
    child.emit('error', new Error('git failed'));

    await rejection;
  });

  it('counts every spawned git subprocess in runtime diagnostics', async () => {
    const { execGit, spawnGitWithDeadline } = await import('./git-exec.js');
    const {
      getBackendRuntimeDiagnosticsSnapshot,
      getGitSubprocessCount,
      resetBackendRuntimeDiagnostics,
    } = await import('./runtime-diagnostics.js');

    resetBackendRuntimeDiagnostics();
    const firstChild = createSpawnProcess();
    spawnMock.mockReturnValueOnce(firstChild);
    const first = execGit(['rev-parse', 'HEAD'], { cwd: '/repo' });
    firstChild.emit('close', 0, null);
    await first;

    const secondChild = createSpawnProcess();
    spawnMock.mockReturnValueOnce(secondChild);
    const second = execGit(['status', '--porcelain'], { cwd: '/repo' });
    secondChild.emit('close', 0, null);
    await second;

    const child = createSpawnProcess();
    spawnMock.mockReturnValueOnce(child);
    const { completion } = spawnGitWithDeadline(['cat-file', '--batch'], { cwd: '/repo' });
    child.emit('close', 0, null);
    await completion;

    expect(getGitSubprocessCount()).toBe(3);
    expect(getBackendRuntimeDiagnosticsSnapshot().gitSubprocessCount).toBe(3);

    resetBackendRuntimeDiagnostics();
    expect(getGitSubprocessCount()).toBe(0);
    expect(getBackendRuntimeDiagnosticsSnapshot().gitSubprocessCount).toBe(0);
  });

  it('does not count or launch pre-aborted Git work', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const { execGit, spawnGitWithDeadline } = await import('./git-exec.js');
    const { getGitSubprocessCount, resetBackendRuntimeDiagnostics } =
      await import('./runtime-diagnostics.js');
    resetBackendRuntimeDiagnostics();

    await expect(execGit(['status'], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(() => spawnGitWithDeadline(['status'], {}, { signal: controller.signal })).toThrow(
      'cancelled',
    );

    expect(spawnMock).not.toHaveBeenCalled();
    expect(getGitSubprocessCount()).toBe(0);
  });

  it('waits for a timed-out child to close after requesting termination', async () => {
    vi.useFakeTimers();
    const child = createSpawnProcess();
    spawnMock.mockReturnValue(child);
    const { spawnGitWithDeadline } = await import('./git-exec.js');
    const { completion } = spawnGitWithDeadline(
      ['cat-file', '--batch'],
      { cwd: '/repo' },
      { forceKillCloseGraceMs: 20, terminateGraceMs: 20, timeoutMs: 50 },
    );
    let settled = false;
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(50);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(settled).toBe(false);

    child.emit('close', null, 'SIGTERM');
    await expect(completion).rejects.toThrow('Git subprocess timed out after 50ms');
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('force-kills and bounds cleanup when a timed-out child never closes', async () => {
    vi.useFakeTimers();
    const child = createSpawnProcess();
    spawnMock.mockReturnValue(child);
    const { spawnGitWithDeadline } = await import('./git-exec.js');
    const { completion } = spawnGitWithDeadline(
      ['push', 'origin'],
      { cwd: '/repo' },
      { forceKillCloseGraceMs: 10, terminateGraceMs: 20, timeoutMs: 50 },
    );
    const rejection = expect(completion).rejects.toThrow('Git subprocess timed out after 50ms');

    await vi.advanceTimersByTimeAsync(50);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
