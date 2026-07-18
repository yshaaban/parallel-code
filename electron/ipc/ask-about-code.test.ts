import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, validateCommandMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  validateCommandMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('./command-resolver.js', () => ({
  validateCommand: validateCommandMock,
}));

import {
  ASK_ABOUT_CODE_FORCE_KILL_TIMEOUT_MS,
  ASK_ABOUT_CODE_TIMEOUT_MS,
  AskAboutCodeCleanupError,
  AskAboutCodeRequestLifecycleError,
  askAboutCode,
  cancelAskAboutCode,
  MAX_ASK_ABOUT_CODE_CONCURRENT_REQUESTS,
  MAX_ASK_ABOUT_CODE_PROMPT_LENGTH,
  resetAskAboutCodeState,
  stopAllAskAboutCodeRequests,
} from './ask-about-code.js';
import { DEFAULT_SUBPROCESS_FORCE_KILL_CLOSE_GRACE_MS } from './bounded-process.js';
import {
  DesktopRuntimeCleanupError,
  settleDesktopRuntimeCleanupOwners,
} from '../runtime-cleanup.js';

interface FakeStream extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>;
}

function createStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.destroy = vi.fn();
  return stream;
}

function createSpawnProcess(): EventEmitter & {
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
  signalCode: NodeJS.Signals | null;
  stderr: FakeStream;
  stdin: FakeStream;
  stdout: FakeStream;
} {
  const proc = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
    signalCode: NodeJS.Signals | null;
    stderr: FakeStream;
    stdin: FakeStream;
    stdout: FakeStream;
  };
  proc.exitCode = null;
  proc.kill = vi.fn();
  proc.signalCode = null;
  proc.stdin = createStream();
  proc.stdout = createStream();
  proc.stderr = createStream();
  return proc;
}

describe('askAboutCode', () => {
  beforeEach(() => {
    resetAskAboutCodeState();
    vi.useRealTimers();
    spawnMock.mockReset();
    validateCommandMock.mockReset();
  });

  afterEach(() => {
    resetAskAboutCodeState();
    vi.useRealTimers();
  });

  it('streams stdout and stderr chunks before the done event', async () => {
    const proc = createSpawnProcess();
    spawnMock.mockReturnValue(proc);
    const messages: unknown[] = [];

    askAboutCode(
      {
        requestId: 'req-1',
        prompt: 'Explain this code',
        cwd: '/repo',
      },
      (message) => messages.push(message),
    );

    proc.stdout.emit('data', Buffer.from('First answer chunk'));
    proc.stderr.emit('data', Buffer.from('warning text'));
    proc.emit('close', 0);
    await Promise.resolve();

    expect(validateCommandMock).toHaveBeenCalledWith('claude');
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p', 'Explain this code', '--output-format', 'text']),
      expect.objectContaining({
        cwd: '/repo',
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(messages).toEqual([
      { type: 'chunk', text: 'First answer chunk' },
      { type: 'error', text: 'warning text' },
      { type: 'done', exitCode: 0 },
    ]);
  });

  it('routes minimax requests through the backend-only provider adapter', async () => {
    const proc = createSpawnProcess();
    spawnMock.mockReturnValue(proc);

    askAboutCode(
      {
        requestId: 'req-minimax',
        prompt: 'Explain this code',
        cwd: '/repo',
        providerId: 'minimax',
      },
      () => {},
    );

    expect(validateCommandMock).toHaveBeenCalledWith('minimax');
    expect(spawnMock).toHaveBeenCalledWith(
      'minimax',
      ['Explain this code'],
      expect.objectContaining({
        cwd: '/repo',
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    proc.emit('close', 0);
    await Promise.resolve();
  });

  it('kills an active request when cancelled', async () => {
    const proc = createSpawnProcess();
    spawnMock.mockReturnValue(proc);

    askAboutCode(
      {
        requestId: 'req-2',
        prompt: 'Question',
        cwd: '/repo',
      },
      () => {},
    );

    cancelAskAboutCode('req-2');

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    proc.emit('close', null, 'SIGTERM');
    await Promise.resolve();
  });

  it('force-kills a cancelled request that does not exit after SIGTERM', async () => {
    vi.useFakeTimers();
    const proc = createSpawnProcess();
    proc.kill.mockReturnValue(true);
    spawnMock.mockReturnValue(proc);

    askAboutCode(
      {
        requestId: 'req-force-kill',
        prompt: 'Question',
        cwd: '/repo',
      },
      () => {},
    );

    cancelAskAboutCode('req-force-kill');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(ASK_ABOUT_CODE_FORCE_KILL_TIMEOUT_MS);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    proc.emit('close', null, 'SIGKILL');
    await Promise.resolve();
  });

  it('does not let a replaced request clean up the new request with the same id', async () => {
    vi.useFakeTimers();
    const firstProcess = createSpawnProcess();
    const replacementProcess = createSpawnProcess();
    spawnMock.mockReturnValueOnce(firstProcess).mockReturnValueOnce(replacementProcess);
    const replacementMessages: unknown[] = [];

    askAboutCode(
      {
        requestId: 'req-reused',
        prompt: 'First question',
        cwd: '/repo',
      },
      () => {},
    );
    askAboutCode(
      {
        requestId: 'req-reused',
        prompt: 'Replacement question',
        cwd: '/repo',
      },
      (message) => replacementMessages.push(message),
    );

    firstProcess.emit('close', 0);
    await vi.advanceTimersByTimeAsync(ASK_ABOUT_CODE_TIMEOUT_MS);

    expect(replacementProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(replacementMessages).toEqual([]);
    replacementProcess.emit('close', null, 'SIGTERM');
    await Promise.resolve();
    expect(replacementMessages).toEqual([
      { type: 'error', text: 'Request timed out after 2 minutes.' },
      { type: 'done', exitCode: 1 },
    ]);
  });

  it('times out long-running requests once and emits a terminal error after cleanup', async () => {
    vi.useFakeTimers();
    const proc = createSpawnProcess();
    spawnMock.mockReturnValue(proc);
    const messages: unknown[] = [];

    askAboutCode(
      {
        requestId: 'req-3',
        prompt: 'Question',
        cwd: '/repo',
      },
      (message) => messages.push(message),
    );

    await vi.advanceTimersByTimeAsync(ASK_ABOUT_CODE_TIMEOUT_MS);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(messages).toEqual([]);
    proc.emit('close', null, 'SIGTERM');
    await Promise.resolve();
    expect(messages).toEqual([
      { type: 'error', text: 'Request timed out after 2 minutes.' },
      { type: 'done', exitCode: 1 },
    ]);
  });

  it('bounds final cleanup when a killed provider never closes its streams', async () => {
    vi.useFakeTimers();
    const proc = createSpawnProcess();
    proc.kill.mockReturnValue(true);
    spawnMock.mockReturnValue(proc);
    const messages: unknown[] = [];

    askAboutCode(
      {
        requestId: 'req-stuck-close',
        prompt: 'Question',
        cwd: '/repo',
      },
      (message) => messages.push(message),
    );

    await vi.advanceTimersByTimeAsync(ASK_ABOUT_CODE_TIMEOUT_MS);
    expect(proc.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(messages).toEqual([]);

    await vi.advanceTimersByTimeAsync(ASK_ABOUT_CODE_FORCE_KILL_TIMEOUT_MS);
    expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(messages).toEqual([]);

    await vi.advanceTimersByTimeAsync(DEFAULT_SUBPROCESS_FORCE_KILL_CLOSE_GRACE_MS);
    expect(messages).toEqual([
      { type: 'error', text: 'Request timed out after 2 minutes.' },
      { type: 'done', exitCode: 1 },
    ]);
    expect(proc.stdin.destroy).toHaveBeenCalledOnce();
    expect(proc.stdout.destroy).toHaveBeenCalledOnce();
    expect(proc.stderr.destroy).toHaveBeenCalledOnce();
    expect(proc.stdout.listenerCount('data')).toBe(0);
    expect(proc.stdout.listenerCount('error')).toBe(0);
    expect(proc.stderr.listenerCount('data')).toBe(0);
    expect(proc.stderr.listenerCount('error')).toBe(0);
    expect(proc.listenerCount('close')).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects prompts longer than the configured limit', () => {
    expect(() =>
      askAboutCode(
        {
          requestId: 'req-4',
          prompt: 'x'.repeat(MAX_ASK_ABOUT_CODE_PROMPT_LENGTH + 1),
          cwd: '/repo',
        },
        () => {},
      ),
    ).toThrow(/must not exceed/i);
  });

  it('rejects requests above the concurrent owner limit', () => {
    for (let index = 0; index < MAX_ASK_ABOUT_CODE_CONCURRENT_REQUESTS; index += 1) {
      spawnMock.mockReturnValueOnce(createSpawnProcess());
      askAboutCode(
        {
          requestId: `req-${index}`,
          prompt: 'Question',
          cwd: '/repo',
        },
        () => {},
      );
    }

    spawnMock.mockReturnValueOnce(createSpawnProcess());
    expect(() =>
      askAboutCode(
        {
          requestId: 'req-overflow',
          prompt: 'Question',
          cwd: '/repo',
        },
        () => {},
      ),
    ).toThrow(/Too many concurrent/i);
  });

  it('retains cancelling requests in concurrency admission until process cleanup settles', async () => {
    const processes = Array.from({ length: MAX_ASK_ABOUT_CODE_CONCURRENT_REQUESTS }, () =>
      createSpawnProcess(),
    );
    for (const [index, process] of processes.entries()) {
      spawnMock.mockReturnValueOnce(process);
      askAboutCode(
        {
          requestId: `req-${index}`,
          prompt: 'Question',
          cwd: '/repo',
        },
        () => {},
      );
    }

    cancelAskAboutCode('req-0');
    expect(processes[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(() =>
      askAboutCode(
        {
          requestId: 'req-replacement',
          prompt: 'Question',
          cwd: '/repo',
        },
        () => {},
      ),
    ).toThrow(/Too many concurrent/i);

    processes[0]?.emit('close', null, 'SIGTERM');
    await Promise.resolve();
    await Promise.resolve();

    const replacement = createSpawnProcess();
    spawnMock.mockReturnValueOnce(replacement);
    expect(() =>
      askAboutCode(
        {
          requestId: 'req-replacement',
          prompt: 'Question',
          cwd: '/repo',
        },
        () => {},
      ),
    ).not.toThrow();
  });

  it('stops and drains every owned request before reopening admission', async () => {
    const firstProcess = createSpawnProcess();
    const secondProcess = createSpawnProcess();
    spawnMock.mockReturnValueOnce(firstProcess).mockReturnValueOnce(secondProcess);
    for (const requestId of ['req-first', 'req-second']) {
      askAboutCode(
        {
          requestId,
          prompt: 'Question',
          cwd: '/repo',
        },
        () => {},
      );
    }

    const stopping = stopAllAskAboutCodeRequests();
    let stopSettled = false;
    const markStopSettled = () => {
      stopSettled = true;
    };
    void stopping.then(markStopSettled, markStopSettled);

    expect(firstProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(secondProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(() =>
      askAboutCode(
        {
          requestId: 'req-during-stop',
          prompt: 'Question',
          cwd: '/repo',
        },
        () => {},
      ),
    ).toThrow(/shutting down/i);

    firstProcess.emit('close', null, 'SIGTERM');
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    secondProcess.emit('close', null, 'SIGTERM');
    await expect(stopping).resolves.toBeUndefined();
    expect(stopSettled).toBe(true);

    const nextProcess = createSpawnProcess();
    spawnMock.mockReturnValueOnce(nextProcess);
    expect(() =>
      askAboutCode(
        {
          requestId: 'req-after-stop',
          prompt: 'Question',
          cwd: '/repo',
        },
        () => {},
      ),
    ).not.toThrow();
  });

  it('treats confirmed requested termination as successful aggregate runtime cleanup', async () => {
    const process = createSpawnProcess();
    spawnMock.mockReturnValueOnce(process);
    askAboutCode(
      {
        requestId: 'req-confirmed-shutdown',
        prompt: 'Question',
        cwd: '/repo',
      },
      () => {},
    );

    const cleanup = settleDesktopRuntimeCleanupOwners([
      { cleanup: Promise.resolve(), label: 'agent runner' },
      { cleanup: stopAllAskAboutCodeRequests(), label: 'ask about code' },
      { cleanup: Promise.resolve(), label: 'coordinator' },
    ]);
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');

    process.emit('close', null, 'SIGTERM');
    await expect(cleanup).resolves.toBeUndefined();
  });

  it('reports unconfirmed process termination through aggregate runtime cleanup', async () => {
    vi.useFakeTimers();
    const process = createSpawnProcess();
    process.kill.mockReturnValue(true);
    spawnMock.mockReturnValueOnce(process);
    const messages: unknown[] = [];
    askAboutCode(
      {
        requestId: 'req-unconfirmed-shutdown',
        prompt: 'Question',
        cwd: '/repo',
      },
      (message) => messages.push(message),
    );

    const cleanup = settleDesktopRuntimeCleanupOwners([
      { cleanup: Promise.resolve(), label: 'agent runner' },
      { cleanup: stopAllAskAboutCodeRequests(), label: 'ask about code' },
      { cleanup: Promise.resolve(), label: 'coordinator' },
    ]);
    const cleanupOutcome = cleanup.catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(
      ASK_ABOUT_CODE_FORCE_KILL_TIMEOUT_MS + DEFAULT_SUBPROCESS_FORCE_KILL_CLOSE_GRACE_MS,
    );

    const error = await cleanupOutcome;
    expect(error).toBeInstanceOf(DesktopRuntimeCleanupError);
    const askCleanupFailure = (error as DesktopRuntimeCleanupError).failures[0];
    expect(askCleanupFailure?.label).toBe('ask about code');
    expect(askCleanupFailure?.error).toBeInstanceOf(AskAboutCodeCleanupError);
    const requestFailure = (askCleanupFailure?.error as AskAboutCodeCleanupError).failures[0];
    expect(requestFailure).toBeInstanceOf(AskAboutCodeRequestLifecycleError);
    expect(requestFailure).toMatchObject({
      lifecycleError: expect.objectContaining({ name: 'AskAboutCodeCancellationError' }),
      requestId: 'req-unconfirmed-shutdown',
    });
    expect(messages).toEqual([{ type: 'done', exitCode: null }]);
  });

  it('does not retain an empty stop promise across later request lifecycles', async () => {
    await expect(stopAllAskAboutCodeRequests()).resolves.toBeUndefined();

    const process = createSpawnProcess();
    spawnMock.mockReturnValueOnce(process);
    askAboutCode(
      {
        requestId: 'req-after-empty-stop',
        prompt: 'Question',
        cwd: '/repo',
      },
      () => {},
    );

    const stopping = stopAllAskAboutCodeRequests();
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    process.emit('close', null, 'SIGTERM');
    await expect(stopping).resolves.toBeUndefined();
  });
});
