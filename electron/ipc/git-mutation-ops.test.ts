import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

function createSpawnProcess(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe('streamPushTask', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    execFileMock.mockReset();
    spawnMock.mockReset();
  });

  it('streams stdout and stderr push output before resolving', async () => {
    const proc = createSpawnProcess();
    spawnMock.mockReturnValue(proc);

    const { streamPushTask } = await import('./git-mutation-ops.js');
    const chunks: string[] = [];
    const pushPromise = streamPushTask('/repo', 'feature/task', (text) => {
      chunks.push(text);
    });
    await vi.waitFor(() => {
      expect(proc.stdout.listenerCount('data')).toBeGreaterThan(0);
      expect(proc.stderr.listenerCount('data')).toBeGreaterThan(0);
      expect(proc.listenerCount('close')).toBeGreaterThan(0);
    });

    proc.stdout.emit('data', Buffer.from('Enumerating objects: 3\n'));
    proc.stderr.emit('data', Buffer.from('Writing objects: 100% (3/3)\n'));
    proc.emit('close', 0, null);

    await expect(pushPromise).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['push', '--progress', '-u', 'origin', '--', 'feature/task'],
      {
        cwd: '/repo',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(chunks).toEqual(['Enumerating objects: 3\n', 'Writing objects: 100% (3/3)\n']);
  });

  it('rejects with the last stderr line when git push exits non-zero', async () => {
    const proc = createSpawnProcess();
    spawnMock.mockReturnValue(proc);

    const { streamPushTask } = await import('./git-mutation-ops.js');
    const pushPromise = streamPushTask('/repo', 'feature/task');
    await vi.waitFor(() => {
      expect(proc.stderr.listenerCount('data')).toBeGreaterThan(0);
      expect(proc.listenerCount('close')).toBeGreaterThan(0);
    });

    proc.stderr.emit('data', Buffer.from('remote: denied\nfatal: could not read from remote\n'));
    proc.emit('close', 1, null);

    await expect(pushPromise).rejects.toThrow('fatal: could not read from remote');
  });

  it('keeps only the stderr tail while preserving the final error line', async () => {
    const proc = createSpawnProcess();
    spawnMock.mockReturnValue(proc);

    const { streamPushTask } = await import('./git-mutation-ops.js');
    const pushPromise = streamPushTask('/repo', 'feature/task');
    await vi.waitFor(() => {
      expect(proc.stderr.listenerCount('data')).toBeGreaterThan(0);
    });

    proc.stderr.emit('data', Buffer.from(`${'x'.repeat(6000)}\n`));
    proc.stderr.emit('data', Buffer.from('fatal: denied by remote policy\n'));
    proc.emit('close', 1, null);

    await expect(pushPromise).rejects.toThrow('fatal: denied by remote policy');
  });

  it('preserves the fatal line when a single oversized stderr chunk ends with extra noise', async () => {
    const proc = createSpawnProcess();
    spawnMock.mockReturnValue(proc);

    const { streamPushTask } = await import('./git-mutation-ops.js');
    const pushPromise = streamPushTask('/repo', 'feature/task');
    await vi.waitFor(() => {
      expect(proc.stderr.listenerCount('data')).toBeGreaterThan(0);
    });

    proc.stderr.emit(
      'data',
      Buffer.from(`fatal: denied by remote policy\n${'x'.repeat(6000)}\n`, 'utf8'),
    );
    proc.emit('close', 1, null);

    await expect(pushPromise).rejects.toThrow('fatal: denied by remote policy');
  });
});
