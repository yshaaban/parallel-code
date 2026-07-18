import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
}));

interface FakeStream extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  setEncoding: ReturnType<typeof vi.fn>;
}

interface FakeChild extends EventEmitter {
  exitCode?: number | null;
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
  signalCode?: NodeJS.Signals | null;
  spawnfile: string;
  stderr: FakeStream;
  stdin: FakeStream;
  stdout: FakeStream;
  unref: ReturnType<typeof vi.fn>;
}

function createStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.destroy = vi.fn();
  stream.end = vi.fn();
  stream.setEncoding = vi.fn(() => stream);
  return stream;
}

function createChild(command = 'fixture-command'): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = vi.fn(() => true);
  child.spawnfile = command;
  child.stderr = createStream();
  child.stdin = createStream();
  child.stdout = createStream();
  child.unref = vi.fn();
  return child;
}

describe('spawnWithDeadline', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    execFileSyncMock.mockReset();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('owns the POSIX process group and resolves the reported exit', async () => {
    const child = createChild('fixture');
    spawnMock.mockReturnValue(child);
    const { spawnWithDeadline } = await import('./bounded-process.js');

    const bounded = spawnWithDeadline(
      'fixture',
      ['--version'],
      { cwd: '/repo' },
      { timeoutMs: 50 },
    );

    expect(spawnMock).toHaveBeenCalledWith('fixture', ['--version'], {
      cwd: '/repo',
      detached: process.platform !== 'win32',
    });
    child.emit('close', 0, null);
    await expect(bounded.completion).resolves.toEqual({ code: 0, signal: null });
  });

  it('does not spawn when the lifecycle signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before launch'));
    const { spawnWithDeadline } = await import('./bounded-process.js');

    expect(() =>
      spawnWithDeadline('fixture', [], {}, { signal: controller.signal, timeoutMs: 50 }),
    ).toThrow('cancelled before launch');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('waits for Windows tree termination before settling a closed root process', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const child = createChild('fixture');
    child.pid = 4321;
    const taskkill = createChild('taskkill.exe');
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
    const { spawnWithDeadline } = await import('./bounded-process.js');
    const bounded = spawnWithDeadline(
      'fixture',
      [],
      {},
      { forceKillCloseGraceMs: 20, terminateGraceMs: 50, timeoutMs: 100 },
    );
    const settled = bounded.completion.catch((error: unknown) => error);
    let completionFinished = false;
    void settled.then(() => {
      completionFinished = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'C:\\Windows\\System32\\taskkill.exe',
      ['/pid', '4321', '/t'],
      { stdio: 'ignore', windowsHide: true },
    );
    child.emit('close', null, 'SIGTERM');
    await Promise.resolve();
    expect(completionFinished).toBe(false);

    taskkill.emit('close', 0, null);
    await expect(settled).resolves.toMatchObject({ code: 'ETIMEDOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries Windows tree-kill after root exit and awaits the retry before settling', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const child = createChild('fixture');
    child.pid = 4321;
    const initialTaskkill = createChild('taskkill.exe');
    const retryTaskkill = createChild('taskkill.exe');
    spawnMock
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(initialTaskkill)
      .mockReturnValueOnce(retryTaskkill);
    const { spawnWithDeadline } = await import('./bounded-process.js');
    const bounded = spawnWithDeadline(
      'fixture',
      [],
      {},
      { forceKillCloseGraceMs: 20, terminateGraceMs: 50, timeoutMs: 100 },
    );
    const settled = bounded.completion.catch((error: unknown) => error);
    let completionFinished = false;
    void settled.then(() => {
      completionFinished = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    initialTaskkill.emit('close', 1, null);
    child.emit('exit', 0, null);
    await Promise.resolve();

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock).toHaveBeenNthCalledWith(
      3,
      'C:\\Windows\\System32\\taskkill.exe',
      ['/pid', '4321', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    );
    child.emit('close', 0, null);
    await Promise.resolve();
    expect(completionFinished).toBe(false);

    retryTaskkill.emit('close', 0, null);
    await expect(settled).resolves.toMatchObject({ code: 'ETIMEDOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives the initial Windows tree-kill the terminate grace and guards late kill errors', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const child = createChild('fixture');
    child.pid = 4321;
    const taskkill = createChild('taskkill.exe');
    const retryTaskkill = createChild('taskkill.exe');
    taskkill.kill.mockImplementation(() => {
      queueMicrotask(() => taskkill.emit('error', new Error('taskkill kill failed')));
      return false;
    });
    spawnMock
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(taskkill)
      .mockReturnValueOnce(retryTaskkill);
    const { spawnWithDeadline } = await import('./bounded-process.js');
    const bounded = spawnWithDeadline(
      'fixture',
      [],
      {},
      { forceKillCloseGraceMs: 20, terminateGraceMs: 50, timeoutMs: 100 },
    );
    const settled = bounded.completion.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(49);
    expect(taskkill.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(taskkill.kill).toHaveBeenCalledWith('SIGKILL');
    expect(taskkill.listenerCount('error')).toBe(0);

    taskkill.emit('close', null, 'SIGKILL');
    expect(taskkill.listenerCount('error')).toBe(0);
    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalledTimes(3);
    retryTaskkill.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(20);
    await expect(settled).resolves.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('bounds two non-closing Windows tree-kill attempts and detaches their listeners', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const child = createChild('fixture');
    child.pid = 4321;
    const initialTaskkill = createChild('taskkill.exe');
    const retryTaskkill = createChild('taskkill.exe');
    spawnMock
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(initialTaskkill)
      .mockReturnValueOnce(retryTaskkill);
    const { spawnWithDeadline } = await import('./bounded-process.js');
    const bounded = spawnWithDeadline(
      'fixture',
      [],
      {},
      { forceKillCloseGraceMs: 20, terminateGraceMs: 50, timeoutMs: 100 },
    );
    const settled = bounded.completion.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(50);
    expect(initialTaskkill.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(20);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20);
    expect(retryTaskkill.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(40);

    const lifecycleError = await settled;
    expect(lifecycleError).toMatchObject({ code: 'ETIMEDOUT' });
    expect(bounded.forcedTerminationError).toBe(lifecycleError);
    expect(initialTaskkill.eventNames()).toEqual([]);
    expect(retryTaskkill.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never signals a reused POSIX descendant identity', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    let rootProcessGroupAlive = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -4321 && signal === 0 && !rootProcessGroupAlive) {
        throw Object.assign(new Error('group exited'), { code: 'ESRCH' });
      }
      return true;
    });
    const child = createChild('fixture');
    child.pid = 4321;
    child.exitCode = null;
    child.signalCode = null;
    const currentRecord = `${process.pid} 1 9000 S current-start`;
    const rootRecord = '4321 1 4321 S root-start';
    const descendantRecord = '5555 4321 5555 S descendant-start';
    const reusedDescendantRecord = '5555 1 5555 S reused-start';
    execFileSyncMock
      .mockReturnValueOnce([currentRecord, rootRecord, descendantRecord].join('\n'))
      .mockReturnValueOnce([currentRecord, rootRecord, reusedDescendantRecord].join('\n'))
      .mockReturnValue([currentRecord, reusedDescendantRecord].join('\n'));
    spawnMock.mockReturnValue(child);
    const { spawnWithDeadline } = await import('./bounded-process.js');
    const bounded = spawnWithDeadline('fixture', [], {}, { timeoutMs: 1_000 });

    await vi.advanceTimersByTimeAsync(100);
    bounded.terminate(new Error('stop fixture'));

    expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(-5555, expect.anything());

    child.exitCode = 0;
    rootProcessGroupAlive = false;
    child.emit('close', 0, null);
    await expect(bounded.completion).rejects.toThrow('stop fixture');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a detached POSIX identity captured from startup output after its root exits', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    let rootProcessGroupAlive = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -4321 && signal === 0 && !rootProcessGroupAlive) {
        throw Object.assign(new Error('group exited'), { code: 'ESRCH' });
      }
      return true;
    });
    const child = createChild('fixture');
    child.pid = 4321;
    child.exitCode = null;
    child.signalCode = null;
    const currentRecord = `${process.pid} 1 9000 S current-start`;
    const rootRecord = '4321 1 4321 S root-start';
    const detachedRecord = '5555 4321 5555 S detached-start';
    const reparentedRecord = '5555 1 5555 S detached-start';
    execFileSyncMock
      .mockReturnValueOnce([currentRecord, rootRecord, detachedRecord].join('\n'))
      .mockReturnValueOnce([currentRecord, reparentedRecord].join('\n'))
      .mockReturnValue(currentRecord);
    spawnMock.mockReturnValue(child);
    const { spawnWithDeadline } = await import('./bounded-process.js');
    const bounded = spawnWithDeadline('fixture', [], {}, { timeoutMs: 1_000 });

    child.stdout.on('data', vi.fn());
    child.stdout.emit('data', Buffer.from('5555\n'));
    child.exitCode = 0;
    child.emit('exit', 0, null);
    rootProcessGroupAlive = false;
    bounded.terminate(new Error('stop fixture'));

    expect(killSpy).toHaveBeenCalledWith(-5555, 'SIGTERM');

    child.emit('close', 0, null);
    await expect(bounded.completion).rejects.toThrow('stop fixture');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('captures a silent POSIX descendant that detaches late in the bounded startup window', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    let rootProcessGroupAlive = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -4321 && signal === 0 && !rootProcessGroupAlive) {
        throw Object.assign(new Error('group exited'), { code: 'ESRCH' });
      }
      return true;
    });
    const child = createChild('fixture');
    child.pid = 4321;
    child.exitCode = null;
    child.signalCode = null;
    const currentRecord = `${process.pid} 1 9000 S current-start`;
    const rootRecord = '4321 1 4321 S root-start';
    const detachedRecord = '5555 4321 5555 S detached-start';
    const reparentedRecord = '5555 1 5555 S detached-start';
    execFileSyncMock
      .mockReturnValueOnce([currentRecord, rootRecord].join('\n'))
      .mockReturnValueOnce([currentRecord, rootRecord, detachedRecord].join('\n'))
      .mockReturnValueOnce([currentRecord, reparentedRecord].join('\n'))
      .mockReturnValue(currentRecord);
    spawnMock.mockReturnValue(child);
    const { spawnWithDeadline } = await import('./bounded-process.js');
    const bounded = spawnWithDeadline('fixture', [], {}, { timeoutMs: 1_000 });

    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(80);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);

    child.exitCode = 0;
    child.emit('exit', 0, null);
    rootProcessGroupAlive = false;
    bounded.terminate(new Error('stop fixture'));

    expect(killSpy).toHaveBeenCalledWith(-5555, 'SIGTERM');

    child.emit('close', 0, null);
    await expect(bounded.completion).rejects.toThrow('stop fixture');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('captures direct-spawn POSIX startup output immediately and cancels later scans', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const child = createChild('fixture');
    child.pid = 4321;
    child.exitCode = null;
    child.signalCode = null;
    execFileSyncMock.mockReturnValue(
      [`${process.pid} 1 9000 S current-start`, '4321 1 4321 S root-start'].join('\n'),
    );
    spawnMock.mockReturnValue(child);
    const { spawnWithDeadline } = await import('./bounded-process.js');
    const bounded = spawnWithDeadline('fixture', [], {}, { timeoutMs: 1_000 });

    child.stdout.on('data', vi.fn());
    child.stdout.emit('data', Buffer.from('ready\n'));
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(execFileSyncMock).toHaveBeenCalledOnce();

    child.emit('close', 0, null);
    await expect(bounded.completion).resolves.toEqual({ code: 0, signal: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original POSIX group owned when the root exits before the first snapshot', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    let rootProcessGroupAlive = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -4321 && signal === 0 && !rootProcessGroupAlive) {
        throw Object.assign(new Error('group exited'), { code: 'ESRCH' });
      }
      return true;
    });
    const child = createChild('fixture');
    child.pid = 4321;
    child.exitCode = 0;
    child.signalCode = null;
    execFileSyncMock.mockReturnValue(`${process.pid} 1 9000 S current-start`);
    spawnMock.mockReturnValue(child);
    const { spawnWithDeadline } = await import('./bounded-process.js');
    const bounded = spawnWithDeadline(
      'fixture',
      [],
      {},
      { forceKillCloseGraceMs: 10, terminateGraceMs: 20, timeoutMs: 1_000 },
    );
    const settled = bounded.completion.catch((error: unknown) => error);
    let completionFinished = false;
    void settled.then(() => {
      completionFinished = true;
    });

    bounded.terminate(new Error('stop fixture'));
    expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');

    child.emit('close', 0, null);
    await Promise.resolve();
    expect(completionFinished).toBe(false);

    rootProcessGroupAlive = false;
    await vi.advanceTimersByTimeAsync(20);
    await expect(settled).resolves.toMatchObject({ message: 'stop fixture' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('execFileWithDeadline', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    execFileSyncMock.mockReset();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns buffered output without forwarding buffering or lifecycle options', async () => {
    const child = createChild('fixture');
    spawnMock.mockReturnValue(child);
    const { execFileWithDeadline } = await import('./bounded-process.js');
    const result = execFileWithDeadline('fixture', ['--version'], {
      cwd: '/repo',
      encoding: 'utf8',
      maxBuffer: 100,
      timeoutMs: 50,
    });

    expect(spawnMock).toHaveBeenCalledWith('fixture', ['--version'], {
      cwd: '/repo',
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.emit('data', Buffer.from('1.0\n'));
    child.emit('close', 0, null);

    await expect(result).resolves.toEqual({ stderr: '', stdout: '1.0\n' });
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalledWith(undefined);
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
  });

  it('coalesces buffered-command output capture into the POSIX startup window', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const child = createChild('fixture');
    child.pid = 4321;
    child.exitCode = null;
    child.signalCode = null;
    execFileSyncMock.mockReturnValue(
      [`${process.pid} 1 9000 S current-start`, '4321 1 4321 S root-start'].join('\n'),
    );
    spawnMock.mockReturnValue(child);
    const { execFileWithDeadline } = await import('./bounded-process.js');
    const result = execFileWithDeadline('fixture', [], {
      encoding: 'utf8',
      timeoutMs: 1_000,
    });

    child.stdout.emit('data', Buffer.from('ready\n'));
    expect(execFileSyncMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(99);
    expect(execFileSyncMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(150);
    expect(execFileSyncMock).toHaveBeenCalledOnce();

    child.emit('close', 0, null);
    await expect(result).resolves.toEqual({ stderr: '', stdout: 'ready\n' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips POSIX process-table capture when a buffered command closes quickly', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const child = createChild('fixture');
    child.pid = 4321;
    child.exitCode = null;
    child.signalCode = null;
    spawnMock.mockReturnValue(child);
    const { execFileWithDeadline } = await import('./bounded-process.js');
    const result = execFileWithDeadline('fixture', [], {
      encoding: 'utf8',
      timeoutMs: 1_000,
    });

    child.stdout.emit('data', Buffer.from('done\n'));
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual({ stderr: '', stdout: 'done\n' });
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid lifecycle and buffer limits before starting a process', async () => {
    const { execFileWithDeadline } = await import('./bounded-process.js');

    expect(() =>
      execFileWithDeadline('fixture', [], {
        encoding: 'utf8',
        timeoutMs: Number.NaN,
      }),
    ).toThrow('timeoutMs must be a finite non-negative number');
    expect(() =>
      execFileWithDeadline('fixture', [], {
        encoding: 'utf8',
        maxBuffer: -1,
        timeoutMs: 50,
      }),
    ).toThrow('maxBuffer must be a non-negative number');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('preserves stdout, stderr, and exit details on command failures', async () => {
    const child = createChild('fixture');
    spawnMock.mockReturnValue(child);
    const { execFileWithDeadline } = await import('./bounded-process.js');
    const result = execFileWithDeadline('fixture', ['fail'], {
      encoding: 'utf8',
      timeoutMs: 50,
    });

    child.stdout.emit('data', Buffer.from('partial output'));
    child.stderr.emit('data', Buffer.from('failure detail'));
    child.emit('close', 2, null);
    const error = await result.catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      cmd: 'fixture fail',
      code: 2,
      killed: false,
      message: 'Command failed: fixture fail\nfailure detail',
      signal: null,
      stderr: 'failure detail',
      stdout: 'partial output',
    });
  });

  it('adds command and buffered output context to spawn errors', async () => {
    const child = createChild('fixture');
    spawnMock.mockReturnValue(child);
    const { execFileWithDeadline } = await import('./bounded-process.js');
    const result = execFileWithDeadline('fixture', ['missing'], {
      encoding: 'utf8',
      timeoutMs: 50,
    });
    const settled = result.catch((reason: unknown) => reason);

    child.emit('error', Object.assign(new Error('spawn fixture ENOENT'), { code: 'ENOENT' }));

    await expect(settled).resolves.toMatchObject({
      cmd: 'fixture missing',
      code: 'ENOENT',
      stderr: '',
      stdout: '',
    });
  });

  it('force-kills and settles when a timed-out buffered child never closes', async () => {
    vi.useFakeTimers();
    const child = createChild('fixture');
    spawnMock.mockReturnValue(child);
    const { execFileWithDeadline } = await import('./bounded-process.js');
    const result = execFileWithDeadline('fixture', ['hang'], {
      encoding: 'utf8',
      forceKillCloseGraceMs: 10,
      terminateGraceMs: 20,
      timeoutMs: 50,
    });
    const rejection = expect(result).rejects.toThrow('fixture subprocess timed out after 50ms');

    child.stdout.emit('data', Buffer.from('partial'));
    await vi.advanceTimersByTimeAsync(50);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    const error = await result.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ stdout: 'partial' });
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles safely when aborted with an immutable Error reason', async () => {
    vi.useFakeTimers();
    const child = createChild('fixture');
    const controller = new AbortController();
    const frozenReason = Object.freeze(new Error('immutable cancellation'));
    spawnMock.mockReturnValue(child);
    const { execFileWithDeadline } = await import('./bounded-process.js');
    const result = execFileWithDeadline('fixture', ['hang'], {
      encoding: 'utf8',
      forceKillCloseGraceMs: 10,
      signal: controller.signal,
      terminateGraceMs: 20,
      timeoutMs: 1_000,
    });
    const settled = result.catch((reason: unknown) => reason);

    controller.abort(frozenReason);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(10);

    const error = await settled;
    expect(error).toMatchObject({
      cause: frozenReason,
      message: 'immutable cancellation',
      name: 'AbortError',
      stderr: '',
      stdout: '',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces maxBuffer per stream while preserving bounded partial output', async () => {
    const child = createChild('fixture');
    spawnMock.mockReturnValue(child);
    const { execFileWithDeadline } = await import('./bounded-process.js');
    const result = execFileWithDeadline('fixture', [], {
      encoding: 'utf8',
      maxBuffer: 4,
      timeoutMs: 50,
    });

    child.stdout.emit('data', Buffer.from('abcdef'));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    const error = await result.catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      cmd: 'fixture',
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      name: 'RangeError',
      stderr: '',
      stdout: 'abcd',
    });
  });

  it('preserves complete multibyte characters when maxBuffer is exceeded', async () => {
    const child = createChild('fixture');
    spawnMock.mockReturnValue(child);
    const { execFileWithDeadline } = await import('./bounded-process.js');
    const result = execFileWithDeadline('fixture', [], {
      encoding: 'utf8',
      maxBuffer: 1,
      timeoutMs: 50,
    });

    child.stdout.emit('data', 'é');
    child.emit('close', null, 'SIGTERM');

    await expect(result).rejects.toMatchObject({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      name: 'RangeError',
      stdout: 'é',
    });
  });

  it('writes explicit input and removes stream listeners on completion', async () => {
    const child = createChild('fixture');
    spawnMock.mockReturnValue(child);
    const { execFileWithDeadline } = await import('./bounded-process.js');
    const result = execFileWithDeadline('fixture', [], {
      encoding: 'utf8',
      input: 'payload',
      timeoutMs: 50,
    });

    expect(child.stdin.end).toHaveBeenCalledWith('payload');
    expect(child.stdin.listenerCount('error')).toBe(1);
    child.stdout.emit('data', Buffer.from('hash\n'));
    child.emit('close', 0, null);

    await expect(result).resolves.toEqual({ stderr: '', stdout: 'hash\n' });
    expect(child.stdin.listenerCount('error')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
  });
});
