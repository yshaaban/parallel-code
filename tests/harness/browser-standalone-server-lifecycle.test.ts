import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stopStandaloneProcess, waitForServerReady } from '../browser/harness/standalone-server.js';

class FakeBrowserServerProcess extends EventEmitter {
  exitCode: number | null = null;
  readonly kill = vi.fn(() => true);
  readonly pid = 123;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
}

function asBrowserServerProcess(
  process: FakeBrowserServerProcess,
): Parameters<typeof waitForServerReady>[0] {
  return process as unknown as Parameters<typeof waitForServerReady>[0];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('browser-lab standalone server lifecycle', () => {
  it('rejects a spawn error without waiting for the readiness timeout', async () => {
    const process = new FakeBrowserServerProcess();
    const ready = waitForServerReady(asBrowserServerProcess(process));

    process.emit('error', new Error('spawn failed'));

    await expect(ready).rejects.toThrow('spawn failed');
  });

  it('rejects malformed readiness output through the promise boundary', async () => {
    const process = new FakeBrowserServerProcess();
    const ready = waitForServerReady(asBrowserServerProcess(process));

    process.stdout.emit('data', Buffer.from('Parallel Code server listening on http://%/\n'));

    await expect(ready).rejects.toThrow();
  });

  it('rejects immediately when readiness observation starts after the server exited', async () => {
    const process = new FakeBrowserServerProcess();
    process.exitCode = 1;

    await expect(waitForServerReady(asBrowserServerProcess(process))).rejects.toThrow(
      'Standalone server exited before readiness with code 1',
    );
    expect(process.listenerCount('error')).toBe(0);
    expect(process.listenerCount('exit')).toBe(0);
  });

  it('settles after TERM to KILL escalation even when no exit event arrives', async () => {
    vi.useFakeTimers();
    const process = new FakeBrowserServerProcess();
    const stopped = stopStandaloneProcess(asBrowserServerProcess(process));

    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(stopped).resolves.toBeUndefined();
  });

  it('treats signal races as an already-stopped process', async () => {
    const process = new FakeBrowserServerProcess();
    process.kill.mockImplementation(() => {
      throw new Error('process already exited');
    });

    await expect(stopStandaloneProcess(asBrowserServerProcess(process))).resolves.toBeUndefined();
  });

  it('settles and removes listeners when signal delivery emits a process error', async () => {
    const process = new FakeBrowserServerProcess();
    process.kill.mockImplementationOnce(() => {
      process.emit('error', new Error('signal delivery failed'));
      return true;
    });

    await expect(stopStandaloneProcess(asBrowserServerProcess(process))).resolves.toBeUndefined();
    expect(process.listenerCount('error')).toBe(0);
    expect(process.listenerCount('exit')).toBe(0);
  });
});
