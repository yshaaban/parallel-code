import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
}));

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  readonly kill = vi.fn(() => true);
  pid: number | undefined;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  execFileSyncMock.mockReset();
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Windows standalone server process-tree lifecycle', () => {
  it('still awaits and verifies tree termination when the owned root already exited', async () => {
    const root = new FakeChildProcess(4_321);
    root.exitCode = 0;
    const gracefulTaskkill = new FakeChildProcess();
    const forcedTaskkill = new FakeChildProcess();
    spawnMock
      .mockReturnValueOnce(root)
      .mockReturnValueOnce(gracefulTaskkill)
      .mockReturnValueOnce(forcedTaskkill);
    const { spawnStandaloneServerProcess, stopStandaloneServerProcess } =
      await import('../../scripts/lib/standalone-server-process.mjs');
    const ownedRoot = spawnStandaloneServerProcess('node', ['server.js']);
    const stopped = stopStandaloneServerProcess(ownedRoot, {
      forceKillAfterMs: 50,
      forceKillSettleMs: 20,
    });

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'C:\\Windows\\System32\\taskkill.exe',
      ['/pid', '4321', '/t'],
      { stdio: 'ignore', windowsHide: true },
    );
    gracefulTaskkill.emit('close', 1, null);
    await Promise.resolve();
    expect(spawnMock).toHaveBeenNthCalledWith(
      3,
      'C:\\Windows\\System32\\taskkill.exe',
      ['/pid', '4321', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    );
    forcedTaskkill.emit('close', 1, null);

    await expect(stopped).rejects.toThrow('Standalone server process tree 4321 did not exit');
    expect(root.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('awaits graceful tree termination even when the root exits first', async () => {
    const root = new FakeChildProcess(4_321);
    const taskkill = new FakeChildProcess();
    spawnMock.mockReturnValueOnce(root).mockReturnValueOnce(taskkill);
    const { spawnStandaloneServerProcess, stopStandaloneServerProcess } =
      await import('../../scripts/lib/standalone-server-process.mjs');
    const ownedRoot = spawnStandaloneServerProcess('node', ['server.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stopped = stopStandaloneServerProcess(ownedRoot, {
      forceKillAfterMs: 50,
      forceKillSettleMs: 20,
    });
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void stopped.then(markSettled, markSettled);

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'C:\\Windows\\System32\\taskkill.exe',
      ['/pid', '4321', '/t'],
      { stdio: 'ignore', windowsHide: true },
    );
    root.exitCode = 0;
    root.emit('exit', 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);

    taskkill.emit('close', 0, null);
    await expect(stopped).resolves.toBeUndefined();
    expect(root.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('escalates a failed graceful tree request to an awaited forced tree request', async () => {
    const root = new FakeChildProcess(4_321);
    const gracefulTaskkill = new FakeChildProcess();
    const forcedTaskkill = new FakeChildProcess();
    spawnMock
      .mockReturnValueOnce(root)
      .mockReturnValueOnce(gracefulTaskkill)
      .mockReturnValueOnce(forcedTaskkill);
    const { spawnStandaloneServerProcess, stopStandaloneServerProcess } =
      await import('../../scripts/lib/standalone-server-process.mjs');
    const ownedRoot = spawnStandaloneServerProcess('node', ['server.js']);
    const stopped = stopStandaloneServerProcess(ownedRoot, {
      forceKillAfterMs: 50,
      forceKillSettleMs: 20,
    });

    gracefulTaskkill.emit('close', 1, null);
    await Promise.resolve();
    expect(spawnMock).toHaveBeenNthCalledWith(
      3,
      'C:\\Windows\\System32\\taskkill.exe',
      ['/pid', '4321', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    );

    root.exitCode = 0;
    root.emit('exit', 0, null);
    await Promise.resolve();
    forcedTaskkill.emit('close', 0, null);
    await expect(stopped).resolves.toBeUndefined();
    expect(root.kill).not.toHaveBeenCalled();
  });

  it('bounds hung tree helpers and rejects when forced tree termination cannot be confirmed', async () => {
    const root = new FakeChildProcess(4_321);
    const gracefulTaskkill = new FakeChildProcess();
    const forcedTaskkill = new FakeChildProcess();
    spawnMock
      .mockReturnValueOnce(root)
      .mockReturnValueOnce(gracefulTaskkill)
      .mockReturnValueOnce(forcedTaskkill);
    const { spawnStandaloneServerProcess, stopStandaloneServerProcess } =
      await import('../../scripts/lib/standalone-server-process.mjs');
    const ownedRoot = spawnStandaloneServerProcess('node', ['server.js']);
    const stopped = stopStandaloneServerProcess(ownedRoot, {
      forceKillAfterMs: 50,
      forceKillSettleMs: 20,
    });
    const observedStop = stopped.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(70);
    expect(gracefulTaskkill.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(40);

    await expect(observedStop).resolves.toEqual(
      expect.objectContaining({
        message: 'Standalone server process tree 4321 did not exit',
      }),
    );
    expect(forcedTaskkill.kill).toHaveBeenCalledWith('SIGKILL');
    expect(root.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps helper errors observed while escalating a timed-out graceful request', async () => {
    const root = new FakeChildProcess(4_321);
    const gracefulTaskkill = new FakeChildProcess();
    const forcedTaskkill = new FakeChildProcess();
    gracefulTaskkill.kill.mockImplementation(() => {
      queueMicrotask(() => gracefulTaskkill.emit('error', new Error('taskkill failed')));
      return false;
    });
    spawnMock
      .mockReturnValueOnce(root)
      .mockReturnValueOnce(gracefulTaskkill)
      .mockReturnValueOnce(forcedTaskkill);
    const { spawnStandaloneServerProcess, stopStandaloneServerProcess } =
      await import('../../scripts/lib/standalone-server-process.mjs');
    const ownedRoot = spawnStandaloneServerProcess('node', ['server.js']);
    const stopped = stopStandaloneServerProcess(ownedRoot, {
      forceKillAfterMs: 50,
      forceKillSettleMs: 20,
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    forcedTaskkill.emit('close', 0, null);

    await expect(stopped).resolves.toBeUndefined();
    expect(gracefulTaskkill.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries one failed owned-tree stop while preserving ownership', async () => {
    const root = new FakeChildProcess(4_321);
    const firstGracefulTaskkill = new FakeChildProcess();
    const firstForcedTaskkill = new FakeChildProcess();
    const retryGracefulTaskkill = new FakeChildProcess();
    spawnMock
      .mockReturnValueOnce(root)
      .mockReturnValueOnce(firstGracefulTaskkill)
      .mockReturnValueOnce(firstForcedTaskkill)
      .mockReturnValueOnce(retryGracefulTaskkill);
    const { spawnStandaloneServerProcess, stopStandaloneServerProcessWithRetry } =
      await import('../../scripts/lib/standalone-server-process.mjs');
    const ownedRoot = spawnStandaloneServerProcess('node', ['server.js']);
    const stopped = stopStandaloneServerProcessWithRetry(ownedRoot, {
      forceKillAfterMs: 50,
      forceKillSettleMs: 20,
    });

    firstGracefulTaskkill.emit('close', 1, null);
    await Promise.resolve();
    firstForcedTaskkill.emit('close', 1, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnMock).toHaveBeenNthCalledWith(
      4,
      'C:\\Windows\\System32\\taskkill.exe',
      ['/pid', '4321', '/t'],
      { stdio: 'ignore', windowsHide: true },
    );

    retryGracefulTaskkill.emit('close', 0, null);
    await expect(stopped).resolves.toBeUndefined();
    expect(root.kill).toHaveBeenCalledTimes(1);
  });

  it('aggregates both owned-tree failures after the bounded retry', async () => {
    const root = new FakeChildProcess(4_321);
    const firstGracefulTaskkill = new FakeChildProcess();
    const firstForcedTaskkill = new FakeChildProcess();
    const retryGracefulTaskkill = new FakeChildProcess();
    const retryForcedTaskkill = new FakeChildProcess();
    spawnMock
      .mockReturnValueOnce(root)
      .mockReturnValueOnce(firstGracefulTaskkill)
      .mockReturnValueOnce(firstForcedTaskkill)
      .mockReturnValueOnce(retryGracefulTaskkill)
      .mockReturnValueOnce(retryForcedTaskkill);
    const { spawnStandaloneServerProcess, stopStandaloneServerProcessWithRetry } =
      await import('../../scripts/lib/standalone-server-process.mjs');
    const ownedRoot = spawnStandaloneServerProcess('node', ['server.js']);
    const stopped = stopStandaloneServerProcessWithRetry(ownedRoot, {
      forceKillAfterMs: 50,
      forceKillSettleMs: 20,
    });

    firstGracefulTaskkill.emit('close', 1, null);
    await Promise.resolve();
    firstForcedTaskkill.emit('close', 1, null);
    await Promise.resolve();
    await Promise.resolve();
    retryGracefulTaskkill.emit('close', 1, null);
    await Promise.resolve();
    retryForcedTaskkill.emit('close', 1, null);

    const failure = await stopped.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: 'Standalone server process tree 4321 did not exit',
      }),
      expect.objectContaining({
        message: 'Standalone server process tree 4321 did not exit',
      }),
    ]);
    expect(root.kill).toHaveBeenCalledTimes(2);
  });
});
