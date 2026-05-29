import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from './runtime-diagnostics.js';
import { TerminalStateMirror } from './terminal-state-mirror.js';

const { observeTaskPortsFromOutputMock, spawnMock } = vi.hoisted(() => ({
  observeTaskPortsFromOutputMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}));

vi.mock('./task-ports.js', () => ({
  observeTaskPortsFromOutput: observeTaskPortsFromOutputMock,
}));

import {
  getAgentMeta,
  getAgentPauseState,
  getAgentTerminalRecovery,
  getAgentTerminalStartupRecovery,
  killAllAgents,
  onPtyEvent,
  pauseAgent,
  resizeAgent,
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
  rows: number;
  pause: () => void;
  resume: () => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
  kill: () => void;
  onData: (cb: (data: string | Buffer) => void) => void;
  onExit: (cb: (info: { exitCode: number | null; signal?: number | null }) => void) => void;
  emitData: (data: string | Buffer) => void;
  emitExit: (info: { exitCode: number | null; signal?: number | null }) => void;
};

function createMockProc(): MockProc {
  let onDataCb: ((data: string | Buffer) => void) | undefined;
  let onExitCb: ((info: { exitCode: number | null; signal?: number | null }) => void) | undefined;

  const proc: MockProc = {
    cols: 80,
    rows: 24,
    pause: vi.fn(),
    resume: vi.fn(),
    resize: vi.fn((cols: number, rows: number) => {
      proc.cols = cols;
      proc.rows = rows;
    }),
    write: vi.fn(),
    kill: vi.fn(() => onExitCb?.({ exitCode: 0, signal: null })),
    onData: vi.fn((cb) => {
      onDataCb = cb;
    }),
    onExit: vi.fn((cb) => {
      onExitCb = cb;
    }),
    emitData: (data: string | Buffer) => {
      onDataCb?.(data);
    },
    emitExit: (info) => {
      onExitCb?.(info);
    },
  };

  return proc;
}

beforeEach(() => {
  vi.clearAllTimers();
  spawnMock.mockReset();
  observeTaskPortsFromOutputMock.mockReset();
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
  it('requests raw PTY output bytes on Unix-like platforms', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-raw-output-option',
      agentId: 'agent-raw-output-option',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'raw-output-option-channel' },
    });

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { encoding?: string | null } | undefined;
    if (process.platform === 'win32') {
      expect(spawnOptions).not.toHaveProperty('encoding');
    } else {
      expect(spawnOptions?.encoding).toBeNull();
    }
  });

  it('keeps raw PTY bytes in output, scrollback, and recovery cursors', () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    const sendToChannel = vi.fn();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(sendToChannel, {
      taskId: 'task-raw-output',
      agentId: 'agent-raw-output',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'raw-output-channel' },
    });

    const rawChunk = Buffer.from([0xff, 0x00, 0x41, 0xc3, 0x28]);
    proc.emitData(rawChunk);
    vi.advanceTimersByTime(4);

    expect(sendToChannel).toHaveBeenCalledWith('raw-output-channel', {
      type: 'Data',
      data: rawChunk.toString('base64'),
    });
    expect(getAgentTerminalRecovery('agent-raw-output', null)).toEqual({
      cols: 80,
      data: rawChunk,
      kind: 'snapshot',
      outputCursor: rawChunk.length,
      rows: 24,
    });
  });

  it('registers backend terminal input traces when traced shell input arrives', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const now = performance.timeOrigin + performance.now();

    spawnAgent(vi.fn(), {
      taskId: 'task-trace',
      agentId: 'agent-trace',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'trace-channel' },
    });

    writeToAgent('agent-trace', 'trace-me', {
      clientId: 'client-1',
      requestId: 'request-1',
      taskId: 'task-trace',
      trace: {
        bufferedAtMs: now + 10,
        inputChars: 8,
        inputKind: 'interactive',
        sendStartedAtMs: now + 15,
        startedAtMs: now,
      },
    });

    const diagnostics = getBackendRuntimeDiagnosticsSnapshot();
    expect(diagnostics.terminalInputTracing.activeTraceCount).toBe(1);
    expect(diagnostics.terminalInputTracing.completedTraces).toHaveLength(0);
  });

  it('supports backend-only sessions that collect recovery state before any output channel attaches', () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const sendToChannel = vi.fn();

    spawnAgent(sendToChannel, {
      taskId: 'task-backend-only',
      agentId: 'agent-backend-only',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
    });

    proc.emitData('backend output');
    vi.advanceTimersByTime(4);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(getAgentTerminalRecovery('agent-backend-only', null)).toEqual({
      cols: 80,
      data: Buffer.from('backend output', 'utf8'),
      kind: 'snapshot',
      outputCursor: Buffer.byteLength('backend output', 'utf8'),
      rows: 24,
    });

    const attachedExistingSession = spawnAgent(sendToChannel, {
      taskId: 'task-backend-only',
      agentId: 'agent-backend-only',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 100,
      rows: 30,
      onOutput: { __CHANNEL_ID__: 'attached-channel' },
    });

    expect(attachedExistingSession).toBe(true);
    expect(proc.resize).not.toHaveBeenCalled();
  });

  it('reattaches to an existing session without implicitly resizing the shared PTY', () => {
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
    expect(proc.resize).not.toHaveBeenCalled();
    expect(sendToChannel).not.toHaveBeenCalledWith('two', {
      type: 'RecoveryRequired',
      reason: 'attach',
    });
  });

  it('keeps explicit resizeAgent as the PTY resize mutation path', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-resize',
      agentId: 'agent-resize',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'resize-channel' },
    });

    resizeAgent('agent-resize', 100, 30);

    expect(proc.resize).toHaveBeenCalledWith(100, 30);
    expect(proc.cols).toBe(100);
    expect(proc.rows).toBe(30);
  });

  it('does not advance the terminal-state mirror when PTY resize fails', () => {
    const enqueueResizeSpy = vi.spyOn(TerminalStateMirror.prototype, 'enqueueResize');
    const proc = createMockProc();
    proc.resize = vi.fn(() => {
      throw new Error('resize failed');
    });
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-resize-failure',
      agentId: 'agent-resize-failure',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'resize-failure-channel' },
    });

    try {
      expect(() => resizeAgent('agent-resize-failure', 100, 30)).toThrow('resize failed');
      expect(enqueueResizeSpy).not.toHaveBeenCalled();
    } finally {
      enqueueResizeSpy.mockRestore();
    }
  });

  it('ignores late exits from an older generation after respawning the same agent id', () => {
    const firstProc = createMockProc();
    const secondProc = createMockProc();
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);
    const onExit = vi.fn();
    const offExit = onPtyEvent('exit', onExit);

    try {
      expect(
        spawnAgent(vi.fn(), {
          taskId: 'task-1',
          agentId: 'agent-same',
          command: '/bin/sh',
          args: [],
          cwd: '/',
          env: {},
          cols: 80,
          rows: 24,
          onOutput: { __CHANNEL_ID__: 'one' },
        }),
      ).toBe(false);

      firstProc.emitExit({ exitCode: 0, signal: null });

      expect(
        spawnAgent(vi.fn(), {
          taskId: 'task-1',
          agentId: 'agent-same',
          command: '/bin/sh',
          args: [],
          cwd: '/',
          env: {},
          cols: 80,
          rows: 24,
          onOutput: { __CHANNEL_ID__: 'two' },
        }),
      ).toBe(false);

      expect(getAgentMeta('agent-same')).toEqual({
        agentId: 'agent-same',
        generation: 1,
        isShell: false,
        taskId: 'task-1',
      });

      firstProc.emitExit({ exitCode: 9, signal: 15 });

      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenLastCalledWith('agent-same', {
        exitCode: 0,
        generation: 0,
        lastOutput: [],
        signal: null,
      });
      expect(getAgentMeta('agent-same')).toEqual({
        agentId: 'agent-same',
        generation: 1,
        isShell: false,
        taskId: 'task-1',
      });
    } finally {
      offExit();
    }
  });

  it('reattach updates task metadata and output routing without changing lifecycle generation or emitting extra lifecycle events', () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    const initialSendToChannel = vi.fn();
    const reattachedSendToChannel = vi.fn();
    const onSpawn = vi.fn();
    const onPause = vi.fn();
    const onResume = vi.fn();
    const onExit = vi.fn();

    const offSpawn = onPtyEvent('spawn', onSpawn);
    const offPause = onPtyEvent('pause', onPause);
    const offResume = onPtyEvent('resume', onResume);
    const offExit = onPtyEvent('exit', onExit);

    try {
      expect(
        spawnAgent(initialSendToChannel, {
          taskId: 'task-reattach-initial',
          agentId: 'agent-reattach-metadata',
          command: '/bin/sh',
          args: [],
          cwd: '/',
          env: {},
          cols: 80,
          rows: 24,
          isShell: false,
          onOutput: { __CHANNEL_ID__: 'channel-one' },
        }),
      ).toBe(false);

      expect(getAgentMeta('agent-reattach-metadata')).toEqual({
        agentId: 'agent-reattach-metadata',
        generation: 0,
        isShell: false,
        taskId: 'task-reattach-initial',
      });
      expect(onSpawn).toHaveBeenCalledTimes(1);
      expect(onSpawn).toHaveBeenCalledWith('agent-reattach-metadata', { generation: 0 });

      expect(
        spawnAgent(reattachedSendToChannel, {
          taskId: 'task-reattach-next',
          agentId: 'agent-reattach-metadata',
          command: '/bin/sh',
          args: [],
          cwd: '/',
          env: {},
          cols: 100,
          rows: 30,
          isShell: true,
          onOutput: { __CHANNEL_ID__: 'channel-two' },
        }),
      ).toBe(true);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(proc.resize).not.toHaveBeenCalled();
      expect(getAgentMeta('agent-reattach-metadata')).toEqual({
        agentId: 'agent-reattach-metadata',
        generation: 0,
        isShell: true,
        taskId: 'task-reattach-next',
      });
      expect(onSpawn).toHaveBeenCalledTimes(1);
      expect(onPause).not.toHaveBeenCalled();
      expect(onResume).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();

      proc.emitData('hello');
      vi.advanceTimersByTime(4);

      const dataMessage = {
        data: Buffer.from('hello', 'utf8').toString('base64'),
        type: 'Data',
      };

      expect(initialSendToChannel).not.toHaveBeenCalled();
      expect(reattachedSendToChannel).toHaveBeenCalledTimes(2);
      expect(reattachedSendToChannel).toHaveBeenNthCalledWith(1, 'channel-one', dataMessage);
      expect(reattachedSendToChannel).toHaveBeenNthCalledWith(2, 'channel-two', dataMessage);
      expect(observeTaskPortsFromOutputMock).toHaveBeenLastCalledWith(
        'task-reattach-next',
        'hello',
      );

      proc.kill();

      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith('agent-reattach-metadata', {
        exitCode: 0,
        generation: 0,
        lastOutput: ['hello'],
        signal: null,
      });
    } finally {
      offSpawn();
      offPause();
      offResume();
      offExit();
    }
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

  it('returns noop recovery without snapshot payload when both backend and renderer are empty', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-empty-noop',
      agentId: 'agent-empty-noop',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'empty-noop' },
    });

    expect(getAgentTerminalRecovery('agent-empty-noop', null)).toEqual({
      cols: 80,
      kind: 'noop',
      outputCursor: 0,
      rows: 24,
    });
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
      rows: 24,
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
      rows: 24,
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
      rows: 24,
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
      rows: 24,
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
      rows: 24,
    });
  });

  it('caps attach snapshot recovery bytes without affecting delta matching', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-capped-snapshot',
      agentId: 'agent-capped-snapshot',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'capped-snapshot' },
    });

    proc.emitData('abcdefghijklmnopqrstuvwxyz');

    expect(
      getAgentTerminalRecovery('agent-capped-snapshot', Buffer.from('123', 'utf8'), null, 8),
    ).toEqual({
      cols: 80,
      data: Buffer.from('stuvwxyz', 'utf8'),
      kind: 'snapshot',
      outputCursor: 26,
      rows: 24,
    });
  });

  it('builds serialized terminal-state recovery for selected and visible startup terminals', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-startup-caps',
      agentId: 'agent-startup-caps',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'startup-caps' },
    });

    const startupHistory = '0123456789'.repeat(40);
    proc.emitData(startupHistory);

    const selectedRecovery = await getAgentTerminalStartupRecovery(
      'agent-startup-caps',
      Buffer.from('stale', 'utf8'),
      null,
      'selected',
      4,
    );
    expect(selectedRecovery.kind).toBe('terminal-state');
    if (selectedRecovery.kind !== 'terminal-state') {
      throw new Error('expected terminal-state recovery for selected terminal');
    }
    expect(selectedRecovery.cols).toBe(80);
    expect(selectedRecovery.rows).toBe(24);
    expect(selectedRecovery.outputCursor).toBe(startupHistory.length);
    const siblingRecovery = await getAgentTerminalStartupRecovery(
      'agent-startup-caps',
      Buffer.from('stale', 'utf8'),
      null,
      'visible-sibling',
      4,
    );
    expect(siblingRecovery.kind).toBe('terminal-state');
    if (siblingRecovery.kind !== 'terminal-state') {
      throw new Error('expected terminal-state recovery for visible sibling');
    }
    expect(siblingRecovery.cols).toBe(80);
    expect(siblingRecovery.rows).toBe(24);
    expect(siblingRecovery.outputCursor).toBe(startupHistory.length);
  });

  it('falls back to capped startup snapshots when serialized terminal-state exceeds the dense role cap', async () => {
    const serializeSpy = vi
      .spyOn(TerminalStateMirror.prototype, 'serialize')
      .mockResolvedValueOnce({
        cols: 80,
        data: Buffer.alloc(80 * 1024, 's'),
        rows: 24,
      });
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-startup-oversized-state',
      agentId: 'agent-startup-oversized-state',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'startup-oversized-state' },
    });

    const startupHistory = 'h'.repeat(64 * 1024);
    proc.emitData(startupHistory);

    try {
      const recovery = await getAgentTerminalStartupRecovery(
        'agent-startup-oversized-state',
        Buffer.from('stale', 'utf8'),
        null,
        'visible-sibling',
        4,
      );

      expect(recovery.kind).toBe('snapshot');
      if (recovery.kind !== 'snapshot') {
        throw new Error('expected snapshot fallback for oversized terminal-state recovery');
      }
      expect(recovery.data?.length).toBe(48 * 1024);
      expect(recovery.outputCursor).toBe(startupHistory.length);
      expect(getBackendRuntimeDiagnosticsSnapshot().terminalRecovery.terminalStateFallbacks).toBe(
        1,
      );
    } finally {
      serializeSpy.mockRestore();
    }
  });

  it('uses backend terminal state instead of client cursors for startup recovery', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-startup-cursor',
      agentId: 'agent-startup-cursor',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'startup-cursor' },
    });

    proc.emitData('0123456789abcdefghij');

    const recovery = await getAgentTerminalStartupRecovery(
      'agent-startup-cursor',
      Buffer.from('0123456789', 'utf8'),
      10,
      'visible-sibling',
      4,
    );

    expect(recovery.cols).toBe(80);
    expect(recovery.outputCursor).toBe(20);
    expect(recovery.kind).toBe('terminal-state');
    if (recovery.kind !== 'terminal-state') {
      throw new Error('expected terminal-state recovery');
    }
    expect(recovery.data?.length).toBeGreaterThan(0);
  });

  it('falls back to scrollback snapshots and records diagnostics when terminal-state serialization is unavailable', async () => {
    const serializeSpy = vi
      .spyOn(TerminalStateMirror.prototype, 'serialize')
      .mockResolvedValueOnce(null);
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-startup-fallback',
      agentId: 'agent-startup-fallback',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'startup-fallback' },
    });

    proc.emitData('fallback-history');

    try {
      const recovery = await getAgentTerminalStartupRecovery(
        'agent-startup-fallback',
        Buffer.from('stale', 'utf8'),
        null,
        'visible-sibling',
        4,
      );

      expect(recovery.kind).toBe('snapshot');
      expect(getBackendRuntimeDiagnosticsSnapshot().terminalRecovery.terminalStateFallbacks).toBe(
        1,
      );
    } finally {
      serializeSpy.mockRestore();
    }
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
      rows: 24,
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
      rows: 24,
      source: 'cursor',
    });
    expect(
      getAgentTerminalRecovery('agent-cursor-preferred', Buffer.from('still-stale', 'utf8'), 10),
    ).toEqual({
      cols: 80,
      kind: 'noop',
      outputCursor: 10,
      rows: 24,
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
      rows: 24,
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

  it('acknowledges request-tracked terminal input after the PTY write flushes', () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    const onApplied = vi.fn();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-input-ack',
      agentId: 'agent-input-ack',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'input-ack' },
    });

    writeToAgent('agent-input-ack', 'abc', undefined, undefined, { onApplied });
    expect(onApplied).not.toHaveBeenCalled();

    vi.runOnlyPendingTimers();

    expect(proc.write).toHaveBeenCalledWith('abc');
    expect(onApplied).toHaveBeenCalledTimes(1);
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

  it('writes request-tracked terminal input in sequence when requests arrive out of order', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-ordered-input',
      agentId: 'agent-ordered-input',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'ordered-input' },
    });

    writeToAgent('agent-ordered-input', 'second\r', undefined, {
      inputEpoch: 'epoch-one',
      inputSeq: 1,
    });
    writeToAgent('agent-ordered-input', 'first\r', undefined, {
      inputEpoch: 'epoch-one',
      inputSeq: 0,
    });

    expect(proc.write).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(proc.write)
        .mock.calls.map(([data]) => data)
        .join(''),
    ).toBe('first\rsecond\r');
  });

  it('acknowledges duplicate ordered terminal input without writing it twice', () => {
    const proc = createMockProc();
    const duplicateApplied = vi.fn();
    const duplicateDropped = vi.fn();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-ordered-input-duplicate',
      agentId: 'agent-ordered-input-duplicate',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'ordered-input-duplicate' },
    });

    writeToAgent('agent-ordered-input-duplicate', 'first\r', undefined, {
      inputEpoch: 'epoch-one',
      inputSeq: 0,
    });
    writeToAgent(
      'agent-ordered-input-duplicate',
      'first-duplicate\r',
      undefined,
      {
        inputEpoch: 'epoch-one',
        inputSeq: 0,
      },
      {
        onApplied: duplicateApplied,
        onDropped: duplicateDropped,
      },
    );

    expect(proc.write).toHaveBeenCalledTimes(1);
    expect(proc.write).toHaveBeenCalledWith('first\r');
    expect(duplicateApplied).toHaveBeenCalledTimes(1);
    expect(duplicateDropped).not.toHaveBeenCalled();
  });

  it('rotates ordered terminal input epochs and ignores stale gaps', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-ordered-input-epoch',
      agentId: 'agent-ordered-input-epoch',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'ordered-input-epoch' },
    });

    writeToAgent('agent-ordered-input-epoch', 'stale-later\r', undefined, {
      inputEpoch: 'old-epoch',
      inputSeq: 1,
    });
    writeToAgent('agent-ordered-input-epoch', 'fresh\r', undefined, {
      inputEpoch: 'new-epoch',
      inputSeq: 0,
    });
    writeToAgent('agent-ordered-input-epoch', 'stale-first\r', undefined, {
      inputEpoch: 'old-epoch',
      inputSeq: 0,
    });

    expect(
      vi
        .mocked(proc.write)
        .mock.calls.map(([data]) => data)
        .join(''),
    ).toBe('fresh\r');
  });

  it('splits oversized browser paste input before writing to the PTY', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-large-input',
      agentId: 'agent-large-input',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'large-input' },
    });

    const input = `${'x'.repeat(64 * 1024 + 512)}tail-marker\n`;
    writeToAgent('agent-large-input', input);

    const writes = vi.mocked(proc.write).mock.calls.map(([chunk]) => chunk);
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.join('')).toBe(input);
    expect(writes.every((chunk) => chunk.length <= 16 * 1024)).toBe(true);
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

  it('clears queued input, rejects callbacks, and records a failure when proc.write throws', () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    const onDropped = vi.fn();
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

    writeToAgent('agent-write-fail', 'pending', undefined, undefined, { onDropped });

    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    expect(onDropped).toHaveBeenCalledTimes(1);
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
