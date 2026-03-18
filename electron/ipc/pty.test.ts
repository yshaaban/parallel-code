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

import {
  getAgentPauseState,
  getAgentTerminalRecovery,
  killAllAgents,
  pauseAgent,
  resumeAgent,
  spawnAgent,
  validateCommand,
  writeToAgent,
} from './pty.js';

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
  it('requests a structured restore when reconnecting to an existing session', () => {
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

    const attachedExistingSession = spawnAgent(sendToChannel, {
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

    expect(attachedExistingSession).toBe(true);
    expect(proc.resize).toHaveBeenCalledWith(100, 30);
    expect(sendToChannel).not.toHaveBeenCalledWith('two', {
      type: 'RecoveryRequired',
      reason: 'attach',
    });
  });

  it('clears scoped restore pauses only when the matching channel resumes', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-restore-pause',
      agentId: 'agent-restore-pause',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'restore-channel' },
    });

    pauseAgent('agent-restore-pause', 'restore', 'restore-channel');
    expect(getAgentPauseState('agent-restore-pause')).toBe('restore');

    resumeAgent('agent-restore-pause', 'restore');
    expect(getAgentPauseState('agent-restore-pause')).toBe('restore');

    resumeAgent('agent-restore-pause', 'restore', 'restore-channel');
    expect(getAgentPauseState('agent-restore-pause')).toBeNull();
  });

  it('returns an empty snapshot recovery when the backend scrollback is empty but the client has stale content', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-empty-recovery',
      agentId: 'agent-empty-recovery',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'empty-recovery' },
    });

    const recovery = getAgentTerminalRecovery(
      'agent-empty-recovery',
      Buffer.from('stale-local-output', 'utf8'),
    );

    expect(recovery).toEqual({
      cols: 80,
      data: Buffer.alloc(0),
      kind: 'snapshot',
      outputCursor: 0,
    });
  });

  it('returns noop recovery when the renderer tail already matches current scrollback', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-noop',
      agentId: 'agent-noop',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'noop' },
    });

    proc.emitData('hello world');

    expect(getAgentTerminalRecovery('agent-noop', Buffer.from('hello world', 'utf8'))).toEqual({
      cols: 80,
      kind: 'noop',
      outputCursor: Buffer.byteLength('hello world', 'utf8'),
    });
  });

  it('returns delta recovery when the renderer tail matches an earlier scrollback prefix', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-delta',
      agentId: 'agent-delta',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'delta' },
    });

    proc.emitData('abcdef');
    proc.emitData('gh');

    expect(getAgentTerminalRecovery('agent-delta', Buffer.from('abcdef', 'utf8'))).toEqual({
      cols: 80,
      data: Buffer.from('gh', 'utf8'),
      kind: 'delta',
      overlapBytes: 6,
      outputCursor: 8,
      source: 'tail',
    });
  });

  it('prefers the most recent exact rendered tail match when repeated history exists', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-repeated-delta',
      agentId: 'agent-repeated-delta',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'repeated-delta' },
    });

    proc.emitData('abcabcX');

    expect(getAgentTerminalRecovery('agent-repeated-delta', Buffer.from('abc', 'utf8'))).toEqual({
      cols: 80,
      data: Buffer.from('X', 'utf8'),
      kind: 'delta',
      overlapBytes: 3,
      outputCursor: 7,
      source: 'tail',
    });
  });

  it('returns snapshot recovery when the renderer tail cannot be reconciled', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-snapshot',
      agentId: 'agent-snapshot',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'snapshot' },
    });

    proc.emitData('abcdef');

    expect(getAgentTerminalRecovery('agent-snapshot', Buffer.from('xyz', 'utf8'))).toEqual({
      cols: 80,
      data: Buffer.from('abcdef', 'utf8'),
      kind: 'snapshot',
      outputCursor: 6,
    });
  });

  it('returns cursor-based delta recovery when the client cursor is within the retained window', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-cursor-delta',
      agentId: 'agent-cursor-delta',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'cursor-delta' },
    });

    proc.emitData('abcdef');
    proc.emitData('ghij');

    expect(getAgentTerminalRecovery('agent-cursor-delta', null, 6)).toEqual({
      cols: 80,
      data: Buffer.from('ghij', 'utf8'),
      kind: 'delta',
      outputCursor: 10,
      overlapBytes: 0,
      source: 'cursor',
    });
  });

  it('prefers retained cursor recovery over a stale rendered tail', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-cursor-preferred',
      agentId: 'agent-cursor-preferred',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'cursor-preferred' },
    });

    proc.emitData('abcdefghij');

    expect(
      getAgentTerminalRecovery('agent-cursor-preferred', Buffer.from('stale', 'utf8'), 6),
    ).toEqual({
      cols: 80,
      data: Buffer.from('ghij', 'utf8'),
      kind: 'delta',
      outputCursor: 10,
      overlapBytes: 0,
      source: 'cursor',
    });
    expect(
      getAgentTerminalRecovery('agent-cursor-preferred', Buffer.from('still-stale', 'utf8'), 10),
    ).toEqual({
      cols: 80,
      kind: 'noop',
      outputCursor: 10,
    });
  });

  it('falls back to rendered-tail recovery when the client cursor is stale beyond retention', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-cursor-fallback',
      agentId: 'agent-cursor-fallback',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'cursor-fallback' },
    });

    proc.emitData('abcdef');

    expect(
      getAgentTerminalRecovery('agent-cursor-fallback', Buffer.from('abc', 'utf8'), -1),
    ).toEqual({
      cols: 80,
      data: Buffer.from('def', 'utf8'),
      kind: 'delta',
      outputCursor: 6,
      overlapBytes: 3,
      source: 'tail',
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

  it('keeps the interactive output fast path alive across held-key repeat gaps', () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    const sendToChannel = vi.fn();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(sendToChannel, {
      taskId: 'task-output-repeat',
      agentId: 'agent-output-repeat',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'output-repeat' },
    });

    writeToAgent('agent-output-repeat', 'a');
    sendToChannel.mockClear();

    vi.advanceTimersByTime(120);
    proc.emitData('a');

    expect(sendToChannel).toHaveBeenCalledWith('output-repeat', {
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
