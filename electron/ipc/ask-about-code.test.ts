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
  ASK_ABOUT_CODE_TIMEOUT_MS,
  askAboutCode,
  cancelAskAboutCode,
  MAX_ASK_ABOUT_CODE_CONCURRENT_REQUESTS,
  MAX_ASK_ABOUT_CODE_PROMPT_LENGTH,
  resetAskAboutCodeState,
} from './ask-about-code.js';

function createSpawnProcess(): EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  stderr: EventEmitter;
  stdout: EventEmitter;
} {
  const proc = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stderr: EventEmitter;
    stdout: EventEmitter;
  };
  proc.kill = vi.fn();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
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

  it('streams stdout and stderr chunks before the done event', () => {
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

    expect(validateCommandMock).toHaveBeenCalledWith('claude');
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p', 'Explain this code', '--output-format', 'text']),
      expect.objectContaining({
        cwd: '/repo',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(messages).toEqual([
      { type: 'chunk', text: 'First answer chunk' },
      { type: 'error', text: 'warning text' },
      { type: 'done', exitCode: 0 },
    ]);
  });

  it('kills an active request when cancelled', () => {
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
  });

  it('times out long-running requests once and emits a terminal error', () => {
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

    vi.advanceTimersByTime(ASK_ABOUT_CODE_TIMEOUT_MS);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(messages).toEqual([
      { type: 'error', text: 'Request timed out after 2 minutes.' },
      { type: 'done', exitCode: 1 },
    ]);
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

  it('rejects requests above the concurrent limit unless they reuse the same id', () => {
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
});
