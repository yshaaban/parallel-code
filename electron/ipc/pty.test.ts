import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from './runtime-diagnostics.js';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}));

import { killAllAgents, spawnAgent, validateCommand, writeToAgent } from './pty.js';

const existingAbsoluteCommand =
  process.platform === 'win32'
    ? (process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe')
    : '/bin/sh';
const existingBareCommand = process.platform === 'win32' ? 'cmd' : 'sh';
const missingAbsoluteCommand =
  process.platform === 'win32' ? 'C:\\nonexistent\\path\\binary.exe' : '/nonexistent/path/binary';
const missingBareCommand = 'nonexistent-binary-xyz';
const minimalLookupPath = path.dirname(existingAbsoluteCommand);

type MockProc = {
  cols: number;
  pause: () => void;
  resume: () => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
  kill: () => void;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (info: { exitCode: number | null; signal?: number | null }) => void) => void;
  emitData: (data: string) => void;
};

function createMockProc(): MockProc {
  let onDataCb: ((data: string) => void) | undefined;
  let onExitCb: ((info: { exitCode: number | null; signal?: number | null }) => void) | undefined;

  const proc: MockProc = {
    cols: 80,
    pause: vi.fn(),
    resume: vi.fn(),
    resize: vi.fn((cols: number) => {
      proc.cols = cols;
    }),
    write: vi.fn(),
    kill: vi.fn(() => onExitCb?.({ exitCode: 0, signal: null })),
    onData: vi.fn((cb) => {
      onDataCb = cb;
    }),
    onExit: vi.fn((cb) => {
      onExitCb = cb;
    }),
    emitData: (data: string) => {
      onDataCb?.(data);
    },
  };

  return proc;
}

beforeEach(() => {
  vi.clearAllTimers();
  spawnMock.mockReset();
  resetBackendRuntimeDiagnostics();
});

afterEach(() => {
  vi.clearAllTimers();
  killAllAgents();
  vi.useRealTimers();
});

describe('validateCommand', () => {
  let originalPath = '';

  beforeEach(() => {
    originalPath = process.env.PATH ?? '';
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('does not throw for a command found in PATH', () => {
    expect(() => validateCommand(existingAbsoluteCommand)).not.toThrow();
  });

  it('throws a descriptive error for a missing command', () => {
    process.env.PATH = minimalLookupPath;
    expect(() => validateCommand(missingBareCommand)).toThrow(/not found in PATH/);
  });

  it('throws a descriptive error naming the command', () => {
    process.env.PATH = minimalLookupPath;
    expect(() => validateCommand(missingBareCommand)).toThrow(/nonexistent-binary-xyz/);
  });

  it('throws for a nonexistent absolute path', () => {
    expect(() => validateCommand(missingAbsoluteCommand)).toThrow(/not found or not executable/);
  });

  it('does not throw for a bare command found in PATH', () => {
    expect(() => validateCommand(existingBareCommand)).not.toThrow();
  });

  it('throws for an empty command string', () => {
    expect(() => validateCommand('')).toThrow(/must not be empty/);
  });

  it('throws for a whitespace-only command string', () => {
    expect(() => validateCommand('   ')).toThrow(/must not be empty/);
  });
});

describe('spawnAgent', () => {
  it('replays scrollback and rebinds a new channel when reconnecting to an existing session', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const sendToChannel = vi.fn();

    spawnAgent(sendToChannel, {
      taskId: 'task-1',
      agentId: 'agent-1',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'one' },
    });

    proc.emitData('hello');
    sendToChannel.mockClear();

    spawnAgent(sendToChannel, {
      taskId: 'task-1',
      agentId: 'agent-1',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 100,
      rows: 30,
      onOutput: { __CHANNEL_ID__: 'two' },
    });

    expect(proc.resize).toHaveBeenCalledWith(100, 30);
    expect(sendToChannel).toHaveBeenCalledWith('two', {
      type: 'Data',
      data: Buffer.from('hello').toString('base64'),
    });
  });

  it('coalesces queued interactive input writes on the next immediate flush', () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-input',
      agentId: 'agent-input',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'input' },
    });

    writeToAgent('agent-input', 'abc');
    writeToAgent('agent-input', 'def');
    expect(proc.write).not.toHaveBeenCalled();

    vi.runOnlyPendingTimers();
    expect(proc.write).toHaveBeenCalledTimes(1);
    expect(proc.write).toHaveBeenCalledWith('abcdef');
    expect(getBackendRuntimeDiagnosticsSnapshot().ptyInput).toMatchObject({
      coalescedMessages: 1,
      enqueuedChars: 6,
      enqueuedMessages: 2,
      flushes: 1,
      maxQueuedChars: 6,
    });
  });

  it('flushes control input immediately', () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-enter',
      agentId: 'agent-enter',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'enter' },
    });

    writeToAgent('agent-enter', 'echo hello');
    writeToAgent('agent-enter', '\r');

    expect(proc.write).toHaveBeenCalledTimes(1);
    expect(proc.write).toHaveBeenCalledWith('echo hello\r');
  });

  it('clears pending queued input when the process exits', () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-exit',
      agentId: 'agent-exit',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'exit' },
    });

    writeToAgent('agent-exit', 'pending');
    proc.kill();
    vi.runOnlyPendingTimers();

    expect(proc.write).not.toHaveBeenCalled();
    expect(getBackendRuntimeDiagnosticsSnapshot().ptyInput.clearedQueues).toBe(1);
  });

  it('clears queued input and records a failure when proc.write throws', () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    proc.write = vi.fn(() => {
      throw new Error('pty closed');
    });
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-write-fail',
      agentId: 'agent-write-fail',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'write-fail' },
    });

    writeToAgent('agent-write-fail', 'pending');

    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    expect(getBackendRuntimeDiagnosticsSnapshot().ptyInput).toMatchObject({
      clearedQueues: 1,
      writeFailures: 1,
    });
    expect(() => writeToAgent('agent-write-fail', 'again')).toThrow(/not accepting input/);
  });

  it('flushes small output immediately after recent interactive input', () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    const sendToChannel = vi.fn();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(sendToChannel, {
      taskId: 'task-output-fast',
      agentId: 'agent-output-fast',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'output-fast' },
    });

    writeToAgent('agent-output-fast', 'a');
    proc.emitData('a');

    expect(sendToChannel).toHaveBeenCalledWith('output-fast', {
      type: 'Data',
      data: Buffer.from('a').toString('base64'),
    });
  });

  it('batches small output on the timer when there was no recent interactive input', () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    const sendToChannel = vi.fn();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(sendToChannel, {
      taskId: 'task-output-batch',
      agentId: 'agent-output-batch',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'output-batch' },
    });

    proc.emitData('x');
    expect(sendToChannel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4);
    expect(sendToChannel).toHaveBeenCalledWith('output-batch', {
      type: 'Data',
      data: Buffer.from('x').toString('base64'),
    });
  });
});
