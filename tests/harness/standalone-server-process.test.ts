import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupDevelopmentServerData,
  getDevelopmentStateDir,
  spawnStandaloneServerProcess,
  stopStandaloneServerProcess,
  stopStandaloneServerProcessWithRetry,
  waitForStandaloneServerReady,
} from '../../scripts/lib/standalone-server-process.mjs';

class FakeServerProcess extends EventEmitter {
  exitCode: number | null = null;
  readonly kill = vi.fn(() => true);
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
}

function expectNoReadinessListeners(process: FakeServerProcess): void {
  expect(process.listenerCount('error')).toBe(0);
  expect(process.listenerCount('exit')).toBe(0);
  expect(process.stderr.listenerCount('data')).toBe(0);
  expect(process.stdout.listenerCount('data')).toBe(0);
}

async function spawnUncooperativeDetachedFixture() {
  const descendantScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);";
  const serverScript = [
    "const { spawn } = require('node:child_process');",
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'ignore' });`,
    'descendant.unref();',
    "process.on('SIGTERM', () => {});",
    "process.stdout.write(String(descendant.pid) + '\\n');",
    'setInterval(() => {}, 1_000);',
  ].join(' ');
  const serverProcess = spawnStandaloneServerProcess(process.execPath, ['-e', serverScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const descendantPid = await new Promise<number>((resolve, reject) => {
    let stdout = '';

    const cleanup = () => {
      serverProcess.off('error', handleError);
      serverProcess.off('exit', handleExit);
      serverProcess.stdout.off('data', handleStdout);
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`fixture exited before reporting its descendant: ${code ?? signal}`));
    };
    const handleStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = /^(\d+)\r?\n/u.exec(stdout);
      if (match) {
        cleanup();
        resolve(Number(match[1]));
      }
    };

    serverProcess.once('error', handleError);
    serverProcess.once('exit', handleExit);
    serverProcess.stdout.on('data', handleStdout);
  });

  return { descendantPid, serverProcess };
}

async function spawnPreExitedRootWithDetachedDescendantFixture() {
  const descendantScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);";
  const serverScript = [
    "const { spawn } = require('node:child_process');",
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'ignore' });`,
    'descendant.unref();',
    "process.stdout.write(String(descendant.pid) + '\\n');",
    'setTimeout(() => process.exit(1), 50);',
  ].join(' ');
  const serverProcess = spawnStandaloneServerProcess(process.execPath, ['-e', serverScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  const descendantPid = new Promise<number>((resolve) => {
    serverProcess.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = /^(\d+)\r?\n/u.exec(stdout);
      if (match) {
        resolve(Number(match[1]));
      }
    });
  });
  const readiness = waitForStandaloneServerReady(serverProcess, { timeoutMs: 1_000 });

  const pid = await descendantPid;
  await expect(readiness).rejects.toThrow('exited before readiness');
  return { descendantPid: pid, serverProcess };
}

function forceCleanupProcessGroup(processGroup: number | undefined) {
  if (!processGroup) {
    return;
  }
  try {
    process.kill(-processGroup, 'SIGKILL');
  } catch {
    // The owned group is already gone.
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('raw standalone server process lifecycle', () => {
  it('detects readiness after the line is split across stdout chunks', async () => {
    const process = new FakeServerProcess();
    const ready = waitForStandaloneServerReady(process, { timeoutMs: 100 });
    let settled = false;
    void ready.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    process.stdout.emit(
      'data',
      Buffer.from('Parallel Code server listening on http://127.0.0.1:43'),
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    process.stdout.emit('data', Buffer.from('117?token=profile-token\n'));

    await expect(ready).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:43117',
      port: 43_117,
      url: 'http://127.0.0.1:43117?token=profile-token',
    });
    expectNoReadinessListeners(process);
  });

  it('ignores embedded readiness-like output until an exact line arrives', async () => {
    const process = new FakeServerProcess();
    const ready = waitForStandaloneServerReady(process, { timeoutMs: 100 });
    let settled = false;
    void ready.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    process.stdout.emit(
      'data',
      Buffer.from(
        'dependency: Parallel Code server listening on http://127.0.0.1:43117 trailing-noise\n',
      ),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    process.stdout.emit(
      'data',
      Buffer.from('Parallel Code server listening on http://127.0.0.1:43117\n'),
    );
    await expect(ready).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:43117',
      port: 43_117,
      url: 'http://127.0.0.1:43117',
    });
  });

  it('detects readiness after bounding an oversized stdout prefix', async () => {
    const process = new FakeServerProcess();
    const ready = waitForStandaloneServerReady(process, {
      outputBufferMaxChars: 128,
      timeoutMs: 100,
    });

    process.stdout.emit('data', Buffer.from(`${'x'.repeat(10_000)}\n`));
    process.stdout.emit(
      'data',
      Buffer.from('Parallel Code server listening on http://127.0.0.1:43117\n'),
    );

    await expect(ready).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:43117',
      port: 43_117,
      url: 'http://127.0.0.1:43117',
    });
  });

  it('rejects malformed completed readiness output through the promise boundary', async () => {
    const process = new FakeServerProcess();
    const ready = waitForStandaloneServerReady(process, { timeoutMs: 100 });

    process.stdout.emit('data', Buffer.from('Parallel Code server listening on http://%/\n'));

    await expect(ready).rejects.toThrow();
    expectNoReadinessListeners(process);
  });

  it('includes bounded stderr context when the server exits before readiness', async () => {
    const process = new FakeServerProcess();
    const ready = waitForStandaloneServerReady(process, {
      outputBufferMaxChars: 32,
      timeoutMs: 100,
    });

    process.stderr.emit('data', Buffer.from('prefix-that-will-be-trimmed: startup failed'));
    process.emit('exit', 1, null);

    await expect(ready).rejects.toThrow('startup failed');
  });

  it('rejects immediately when readiness observation starts after the server exited', async () => {
    const process = new FakeServerProcess();
    process.exitCode = 1;

    await expect(waitForStandaloneServerReady(process, { timeoutMs: 100 })).rejects.toThrow(
      'Standalone server exited before readiness with code 1',
    );
    expectNoReadinessListeners(process);
  });

  it('resolves after bounded TERM to KILL escalation even without an exit event', async () => {
    vi.useFakeTimers();
    const process = new FakeServerProcess();
    const stopped = stopStandaloneServerProcess(process, {
      forceKillAfterMs: 5,
      forceKillSettleMs: 5,
    });

    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5);
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(5);

    await expect(stopped).resolves.toBeUndefined();
  });

  if (process.platform !== 'win32') {
    it('force-stops an uncooperative descendant that escaped into a detached process group', async () => {
      const { descendantPid, serverProcess } = await spawnUncooperativeDetachedFixture();
      let cleanupRequired = true;

      try {
        await stopStandaloneServerProcess(serverProcess, {
          forceKillAfterMs: 25,
          forceKillSettleMs: 1_000,
        });

        for (let attempt = 0; attempt < 50 && isProcessAlive(descendantPid); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(isProcessAlive(descendantPid)).toBe(false);
        cleanupRequired = false;
      } finally {
        if (cleanupRequired) {
          forceCleanupProcessGroup(descendantPid);
          forceCleanupProcessGroup(serverProcess.pid);
        }
      }
    });

    it('retains escaped descendant ownership across the bounded stop retry', async () => {
      const { descendantPid, serverProcess } = await spawnUncooperativeDetachedFixture();
      const originalProcessKill = process.kill.bind(process);
      let cleanupRequired = true;
      let swallowedDescendantSignals = 0;
      const processKillSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (
          pid === -descendantPid &&
          (signal === 'SIGTERM' || signal === 'SIGKILL') &&
          swallowedDescendantSignals < 2
        ) {
          swallowedDescendantSignals += 1;
          return true;
        }
        return originalProcessKill(pid, signal);
      });

      try {
        await expect(
          stopStandaloneServerProcessWithRetry(serverProcess, {
            forceKillAfterMs: 25,
            forceKillSettleMs: 150,
          }),
        ).resolves.toBeUndefined();
        expect(swallowedDescendantSignals).toBe(2);
        expect(isProcessAlive(descendantPid)).toBe(false);
        cleanupRequired = false;
      } finally {
        processKillSpy.mockRestore();
        if (cleanupRequired) {
          forceCleanupProcessGroup(descendantPid);
          forceCleanupProcessGroup(serverProcess.pid);
        }
      }
    });

    it('retains a detached descendant when the root exits before the first stop attempt', async () => {
      const { descendantPid, serverProcess } =
        await spawnPreExitedRootWithDetachedDescendantFixture();
      let cleanupRequired = true;

      try {
        await stopStandaloneServerProcessWithRetry(serverProcess, {
          forceKillAfterMs: 25,
          forceKillSettleMs: 1_000,
        });

        for (let attempt = 0; attempt < 50 && isProcessAlive(descendantPid); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(isProcessAlive(descendantPid)).toBe(false);
        cleanupRequired = false;
      } finally {
        if (cleanupRequired) {
          forceCleanupProcessGroup(descendantPid);
          forceCleanupProcessGroup(serverProcess.pid);
        }
      }
    });
  }

  it('settles and removes listeners when signal delivery emits a process error', async () => {
    const process = new FakeServerProcess();
    process.kill.mockImplementationOnce(() => {
      process.emit('error', new Error('signal delivery failed'));
      return true;
    });

    await expect(stopStandaloneServerProcess(process)).resolves.toBeUndefined();
    expect(process.listenerCount('error')).toBe(0);
    expect(process.listenerCount('exit')).toBe(0);
  });

  it('settles immediately when the process rejects signal delivery', async () => {
    const process = new FakeServerProcess();
    process.kill.mockReturnValueOnce(false);

    await expect(stopStandaloneServerProcess(process)).resolves.toBeUndefined();
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(process.listenerCount('error')).toBe(0);
    expect(process.listenerCount('exit')).toBe(0);
  });

  it('attempts both development-data removals and labels simultaneous failures', async () => {
    const userDataPath = path.resolve('/tmp/parallel-code-failed-profile-cleanup');
    const stateDir = getDevelopmentStateDir(userDataPath);
    const userDataFailure = new Error('user data removal failed');
    const remove = vi.fn((targetPath: string) =>
      targetPath === userDataPath ? Promise.reject(userDataFailure) : Promise.reject(null),
    );

    const failure = await cleanupDevelopmentServerData(userDataPath, { remove }).catch(
      (error: unknown) => error,
    );

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, userDataPath, { force: true, recursive: true });
    expect(remove).toHaveBeenNthCalledWith(2, stateDir, { force: true, recursive: true });
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe('Development server data cleanup failed');
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        cause: userDataFailure,
        message: 'remove server user data: user data removal failed',
      }),
      expect.objectContaining({ cause: null, message: 'remove server development state: null' }),
    ]);
  });

  it('removes both the profiler user-data directory and its development state sibling', async () => {
    const parentPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-profile-cleanup-'));
    const userDataPath = path.join(parentPath, 'user-data');
    const stateDir = getDevelopmentStateDir(userDataPath);

    try {
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(userDataPath, 'shell-history'), 'sandboxed\n');
      fs.writeFileSync(path.join(stateDir, 'state.json'), '{}');

      await cleanupDevelopmentServerData(userDataPath);

      expect(fs.existsSync(userDataPath)).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      fs.rmSync(parentPath, { force: true, recursive: true });
    }
  });
});
