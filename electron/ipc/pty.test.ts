import fs from 'fs';
import os from 'os';
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
  clearAutoPauseReasonsForChannel,
  countRunningAgents,
  detachAgentOutput,
  getAgentMeta,
  getAgentPauseState,
  getAgentTerminalRecovery,
  getAgentTerminalStartupRecovery,
  killAgentAndWaitForRunnerCleanup,
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

function getSpawnEnv(): Record<string, string> {
  const lastCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
  const spawnOptions = lastCall?.[2] as { env?: Record<string, string> } | undefined;
  return spawnOptions?.env ?? {};
}

function withProcessEnv<T>(updates: Record<string, string | undefined>, run: () => T): T {
  const originals = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    originals.set(key, process.env[key]);
  }

  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    return run();
  } finally {
    for (const [key, value] of originals) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
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

function withTemporaryDirectory<T>(run: (directoryPath: string) => T): T {
  const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-pty-test-'));
  try {
    return run(directoryPath);
  } finally {
    fs.rmSync(directoryPath, { force: true, recursive: true });
  }
}

function createFakeExecutable(directoryPath: string, fileName: string): string {
  const commandPath = path.join(directoryPath, fileName);
  fs.writeFileSync(commandPath, '');
  fs.chmodSync(commandPath, 0o755);
  return commandPath;
}

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

  it('does not leak inherited no-color env into agent terminals', () => {
    withProcessEnv(
      {
        CLICOLOR: '0',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        npm_config_color: 'false',
      },
      () => {
        const proc = createMockProc();
        spawnMock.mockReturnValueOnce(proc);

        spawnAgent(vi.fn(), {
          taskId: 'task-color-env',
          agentId: 'agent-color-env',
          command: existingAbsoluteCommand,
          args: [],
          cwd: '/',
          env: {},
          cols: 80,
          rows: 24,
        });

        const spawnEnv = getSpawnEnv();
        expect(spawnEnv.NO_COLOR).toBeUndefined();
        expect(spawnEnv.FORCE_COLOR).toBeUndefined();
        expect(spawnEnv.CLICOLOR).toBeUndefined();
        expect(spawnEnv.npm_config_color).toBeUndefined();
        expect(spawnEnv.TERM).toBe('xterm-256color');
        expect(spawnEnv.COLORTERM).toBe('truecolor');
      },
    );
  });

  it('isolates zsh startup, history, and platform home directories when configured', () => {
    withTemporaryDirectory((directoryPath) => {
      const command = createFakeExecutable(directoryPath, 'zsh.exe');
      const shellHomePath = path.join(directoryPath, 'shell-home');
      withProcessEnv(
        {
          APPDATA: '/real/app-data',
          HOME: '/real/home',
          PARALLEL_CODE_TEST_SHELL_HOME: shellHomePath,
          USERPROFILE: '/real/user-profile',
          XDG_DATA_HOME: '/real/xdg-data',
        },
        () => {
          const proc = createMockProc();
          spawnMock.mockReturnValueOnce(proc);

          spawnAgent(vi.fn(), {
            taskId: 'task-shell-history-sandbox',
            agentId: 'agent-shell-history-sandbox',
            command,
            args: [],
            cwd: '/',
            env: {},
            cols: 80,
            rows: 24,
            isShell: true,
            onOutput: { __CHANNEL_ID__: 'shell-history-sandbox-channel' },
          });

          const spawnEnv = getSpawnEnv();
          expect(spawnEnv.HOME).toBe(shellHomePath);
          expect(spawnEnv.USERPROFILE).toBe(shellHomePath);
          expect(spawnEnv.APPDATA).toBe(path.join(shellHomePath, '.app-data', 'roaming'));
          expect(spawnEnv.XDG_DATA_HOME).toBe(path.join(shellHomePath, '.local', 'share'));
          expect(spawnEnv.HISTFILE).toBe(path.join(shellHomePath, '.shell_history'));
          expect(spawnEnv.PARALLEL_CODE_TEST_SHELL_HOME).toBeUndefined();
          expect(spawnEnv.ZDOTDIR).toBe(path.join(shellHomePath, '.config', 'zsh'));
          expect(spawnEnv.HISTSIZE).toBe('0');
          expect(spawnEnv.SAVEHIST).toBe('0');
          expect(
            fs.readFileSync(path.join(shellHomePath, '.config', 'zsh', '.zshrc'), 'utf8'),
          ).toContain("PROMPT='%# '");
          expect(
            fs.readFileSync(path.join(shellHomePath, '.config', 'zsh', '.zshenv'), 'utf8'),
          ).toContain('HISTFILE="$HOME/.shell_history"');
        },
      );
    });
  });

  it('does not apply the test shell sandbox to non-shell launches', () => {
    withTemporaryDirectory((shellHomePath) => {
      withProcessEnv(
        {
          HOME: '/original/home',
          PARALLEL_CODE_TEST_SHELL_HOME: shellHomePath,
        },
        () => {
          const proc = createMockProc();
          spawnMock.mockReturnValueOnce(proc);

          spawnAgent(vi.fn(), {
            taskId: 'task-no-shell-history-sandbox',
            agentId: 'agent-no-shell-history-sandbox',
            command: process.execPath,
            args: ['--version'],
            cwd: '/',
            env: {},
            cols: 80,
            rows: 24,
            onOutput: { __CHANNEL_ID__: 'no-shell-history-sandbox-channel' },
          });

          const spawnEnv = getSpawnEnv();
          expect(spawnEnv.HOME).toBe('/original/home');
          expect(spawnEnv.HISTFILE).not.toBe(path.join(shellHomePath, '.shell_history'));
          expect(spawnEnv.PARALLEL_CODE_TEST_SHELL_HOME).toBeUndefined();
          expect(spawnEnv.ZDOTDIR).toBeUndefined();
        },
      );
    });
  });

  it('does not let an agent env override enable the test-only shell sandbox', () => {
    withTemporaryDirectory((directoryPath) => {
      const command = createFakeExecutable(directoryPath, 'zsh');
      const shellHomePath = path.join(directoryPath, 'agent-selected-shell-home');
      withProcessEnv(
        {
          HOME: '/original/home',
          PARALLEL_CODE_TEST_SHELL_HOME: undefined,
        },
        () => {
          spawnMock.mockReturnValueOnce(createMockProc());

          spawnAgent(vi.fn(), {
            taskId: 'task-agent-env-shell-sandbox',
            agentId: 'agent-agent-env-shell-sandbox',
            command,
            args: [],
            cwd: '/',
            env: {
              PARALLEL_CODE_TEST_SHELL_HOME: shellHomePath,
            },
            cols: 80,
            rows: 24,
            isShell: true,
          });

          expect(getSpawnEnv().HOME).toBe('/original/home');
          expect(getSpawnEnv().PARALLEL_CODE_TEST_SHELL_HOME).toBeUndefined();
          expect(fs.existsSync(shellHomePath)).toBe(false);
        },
      );
    });
  });

  it('removes inherited mixed-case color suppression env from agent terminals', () => {
    withProcessEnv(
      {
        Force_Color: '0',
        No_Color: '1',
        node_disable_colors: '1',
        Npm_Config_Color: 'false',
      },
      () => {
        const proc = createMockProc();
        spawnMock.mockReturnValueOnce(proc);

        spawnAgent(vi.fn(), {
          taskId: 'task-mixed-color-env',
          agentId: 'agent-mixed-color-env',
          command: existingAbsoluteCommand,
          args: [],
          cwd: '/',
          env: {},
          cols: 80,
          rows: 24,
        });

        const spawnEnv = getSpawnEnv();
        expect(spawnEnv.Force_Color).toBeUndefined();
        expect(spawnEnv.No_Color).toBeUndefined();
        expect(spawnEnv.node_disable_colors).toBeUndefined();
        expect(spawnEnv.Npm_Config_Color).toBeUndefined();
      },
    );
  });

  it('keeps explicit no-color env overrides for agent terminals', () => {
    const originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';

    try {
      const proc = createMockProc();
      spawnMock.mockReturnValueOnce(proc);

      spawnAgent(vi.fn(), {
        taskId: 'task-explicit-color-env',
        agentId: 'agent-explicit-color-env',
        command: existingAbsoluteCommand,
        args: [],
        cwd: '/',
        env: {
          CLICOLOR: '0',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          npm_config_color: 'false',
        },
        cols: 80,
        rows: 24,
      });

      const spawnEnv = getSpawnEnv();
      expect(spawnEnv.NO_COLOR).toBe('1');
      expect(spawnEnv.FORCE_COLOR).toBe('0');
      expect(spawnEnv.CLICOLOR).toBe('0');
      expect(spawnEnv.npm_config_color).toBe('false');
    } finally {
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
    }
  });

  it('keeps explicit mixed-case color env overrides without retaining inherited duplicates', () => {
    withProcessEnv({ FORCE_COLOR: '0' }, () => {
      const proc = createMockProc();
      spawnMock.mockReturnValueOnce(proc);

      spawnAgent(vi.fn(), {
        taskId: 'task-explicit-mixed-color-env',
        agentId: 'agent-explicit-mixed-color-env',
        command: existingAbsoluteCommand,
        args: [],
        cwd: '/',
        env: {
          Force_Color: '1',
        },
        cols: 80,
        rows: 24,
      });

      const spawnEnv = getSpawnEnv();
      expect(spawnEnv.FORCE_COLOR).toBeUndefined();
      expect(spawnEnv.Force_Color).toBe('1');
    });
  });

  it('filters unsafe env overrides case-insensitively', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-blocked-env',
      agentId: 'agent-blocked-env',
      command: existingAbsoluteCommand,
      args: [],
      cwd: '/',
      env: {
        Node_Options: '--require ./unexpected.js',
        Path: '/tmp/unexpected',
        SAFE_FLAG: 'allowed',
      },
      cols: 80,
      rows: 24,
    });

    const spawnEnv = getSpawnEnv();
    expect(spawnEnv.Node_Options).toBeUndefined();
    expect(spawnEnv.Path).toBeUndefined();
    expect(spawnEnv.SAFE_FLAG).toBe('allowed');
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

    const spawnDisposition = spawnAgent(sendToChannel, {
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

    expect(spawnDisposition).toEqual({
      channelAttached: true,
      kind: 'attached-existing',
    });
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

    const spawnDisposition = spawnAgent(sendToChannel, {
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

    expect(spawnDisposition).toEqual({
      channelAttached: true,
      kind: 'attached-existing',
    });
    expect(proc.resize).not.toHaveBeenCalled();
    expect(sendToChannel).not.toHaveBeenCalledWith('two', {
      type: 'RecoveryRequired',
      reason: 'attach',
    });
  });

  it('replaces an existing session when explicitly requested', async () => {
    const firstProc = createMockProc();
    const secondProc = createMockProc();
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);
    const sendToChannel = vi.fn();
    const firstCleanup = vi.fn();

    spawnAgent(sendToChannel, {
      taskId: 'task-1',
      agentId: 'agent-1',
      command: '/bin/sh',
      args: ['first'],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onExitCleanup: firstCleanup,
      onOutput: { __CHANNEL_ID__: 'one' },
    });

    const spawnDisposition = spawnAgent(sendToChannel, {
      taskId: 'task-1',
      agentId: 'agent-1',
      command: '/bin/sh',
      args: ['second'],
      cwd: '/',
      env: {},
      cols: 100,
      rows: 30,
      replaceExistingSession: true,
      onOutput: { __CHANNEL_ID__: 'two' },
    });

    expect(spawnDisposition).toMatchObject({
      channelAttached: true,
      kind: 'created-session',
    });
    await expect(spawnDisposition.replacedSessionCleanup).resolves.toBeUndefined();
    expect(firstProc.kill).toHaveBeenCalledTimes(1);
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(['second']);
    expect(spawnMock.mock.calls[1]?.[2]).toMatchObject({
      cols: 100,
      rows: 30,
    });
    expect(getAgentMeta('agent-1')).toMatchObject({
      taskId: 'task-1',
    });
  });

  it('retains ownership of a replaced PTY that does not exit after forced termination', async () => {
    vi.useFakeTimers();
    const firstProc = createMockProc();
    firstProc.kill = vi.fn();
    const secondProc = createMockProc();
    const firstCleanup = vi.fn();
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    spawnAgent(vi.fn(), {
      agentId: 'agent-stuck-replacement',
      args: ['first'],
      cols: 80,
      command: '/bin/sh',
      cwd: '/',
      env: {},
      onExitCleanup: firstCleanup,
      rows: 24,
      taskId: 'task-1',
    });
    const replacement = spawnAgent(vi.fn(), {
      agentId: 'agent-stuck-replacement',
      args: ['second'],
      cols: 80,
      command: '/bin/sh',
      cwd: '/',
      env: {},
      replaceExistingSession: true,
      rows: 24,
      taskId: 'task-1',
    });

    await vi.advanceTimersByTimeAsync(6_000);
    await expect(replacement.replacedSessionCleanup).rejects.toThrow('did not exit within 6000ms');
    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(firstProc.kill).toHaveBeenCalledTimes(2);
    expect(countRunningAgents()).toBe(1);

    const retry = killAgentAndWaitForRunnerCleanup('agent-stuck-replacement');
    await Promise.resolve();
    expect(firstProc.kill).toHaveBeenCalledTimes(3);
    firstProc.emitExit({ exitCode: 0, signal: null });
    await retry;
    expect(countRunningAgents()).toBe(0);
  });

  it('retries a transient replaced-runner cleanup failure on the next stop', async () => {
    const firstProc = createMockProc();
    const secondProc = createMockProc();
    const firstCleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient replacement cleanup failure'))
      .mockResolvedValueOnce(undefined);
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    spawnAgent(vi.fn(), {
      agentId: 'agent-replacement-cleanup-retry',
      args: ['first'],
      cols: 80,
      command: '/bin/sh',
      cwd: '/',
      env: {},
      onExitCleanup: firstCleanup,
      rows: 24,
      taskId: 'task-1',
    });
    const replacement = spawnAgent(vi.fn(), {
      agentId: 'agent-replacement-cleanup-retry',
      args: ['second'],
      cols: 80,
      command: '/bin/sh',
      cwd: '/',
      env: {},
      replaceExistingSession: true,
      rows: 24,
      taskId: 'task-1',
    });

    await expect(replacement.replacedSessionCleanup).rejects.toThrow(
      'transient replacement cleanup failure',
    );
    await expect(
      killAgentAndWaitForRunnerCleanup('agent-replacement-cleanup-retry'),
    ).resolves.toBeUndefined();
    expect(firstCleanup).toHaveBeenCalledTimes(2);
  });

  it('awaits asynchronous runner cleanup when an agent is stopped for task deletion', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    let resolveCleanup!: () => void;
    const onExitCleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );

    spawnAgent(vi.fn(), {
      agentId: 'agent-runner-cleanup',
      args: [],
      cols: 80,
      command: '/bin/sh',
      cwd: '/',
      env: {},
      onExitCleanup,
      rows: 24,
      taskId: 'task-1',
    });

    const cleanup = killAgentAndWaitForRunnerCleanup('agent-runner-cleanup');
    let settled = false;
    void cleanup.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(proc.kill).toHaveBeenCalledOnce();
    expect(onExitCleanup).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    resolveCleanup();
    await cleanup;
    expect(settled).toBe(true);
  });

  it('does not start runner cleanup until the PTY exit is observed', async () => {
    const proc = createMockProc();
    proc.kill = vi.fn();
    spawnMock.mockReturnValueOnce(proc);
    const onExitCleanup = vi.fn();

    spawnAgent(vi.fn(), {
      agentId: 'agent-delayed-exit-cleanup',
      args: [],
      cols: 80,
      command: '/bin/sh',
      cwd: '/',
      env: {},
      onExitCleanup,
      rows: 24,
      taskId: 'task-1',
    });

    const cleanup = killAgentAndWaitForRunnerCleanup('agent-delayed-exit-cleanup');
    await Promise.resolve();
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(onExitCleanup).not.toHaveBeenCalled();

    proc.emitExit({ exitCode: 0, signal: null });
    await cleanup;
    expect(onExitCleanup).toHaveBeenCalledOnce();
  });

  it('retries runner cleanup after a transient failure', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const onExitCleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('docker daemon unavailable'))
      .mockResolvedValueOnce(undefined);

    spawnAgent(vi.fn(), {
      agentId: 'agent-retry-runner-cleanup',
      args: [],
      cols: 80,
      command: '/bin/sh',
      cwd: '/',
      env: {},
      onExitCleanup,
      rows: 24,
      taskId: 'task-1',
    });

    await expect(killAgentAndWaitForRunnerCleanup('agent-retry-runner-cleanup')).rejects.toThrow(
      'docker daemon unavailable',
    );
    await expect(
      killAgentAndWaitForRunnerCleanup('agent-retry-runner-cleanup'),
    ).resolves.toBeUndefined();
    await expect(
      killAgentAndWaitForRunnerCleanup('agent-retry-runner-cleanup'),
    ).resolves.toBeUndefined();

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(onExitCleanup).toHaveBeenCalledTimes(2);
  });

  it('keeps the existing session when replacement command validation fails', () => {
    const firstProc = createMockProc();
    spawnMock.mockReturnValueOnce(firstProc);
    const sendToChannel = vi.fn();

    spawnAgent(sendToChannel, {
      taskId: 'task-1',
      agentId: 'agent-1',
      command: '/bin/sh',
      args: ['first'],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'one' },
    });

    expect(() =>
      spawnAgent(sendToChannel, {
        taskId: 'task-1',
        agentId: 'agent-1',
        command: 'bad;cmd',
        args: ['second'],
        cwd: '/',
        env: {},
        cols: 100,
        rows: 30,
        replaceExistingSession: true,
        onOutput: { __CHANNEL_ID__: 'two' },
      }),
    ).toThrow(/Command contains disallowed characters/);

    expect(firstProc.kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(getAgentMeta('agent-1')).toMatchObject({
      agentId: 'agent-1',
      taskId: 'task-1',
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
      ).toEqual({
        channelAttached: true,
        kind: 'created-session',
      });

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
      ).toEqual({
        channelAttached: true,
        kind: 'created-session',
      });

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
      ).toEqual({
        channelAttached: true,
        kind: 'created-session',
      });

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
      ).toEqual({
        channelAttached: true,
        kind: 'attached-existing',
      });

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

  it('keeps wrapped exit diagnostics in chronological order across small PTY chunks', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const onExit = vi.fn();
    const offExit = onPtyEvent('exit', onExit);

    const outputLines = Array.from(
      { length: 60 },
      (_, index) => `line-${index.toString().padStart(2, '0')}-${'x'.repeat(140)}`,
    );
    const output = Buffer.from(`${outputLines.join('\n')}\n`, 'utf8');

    try {
      spawnAgent(vi.fn(), {
        taskId: 'task-wrapped-exit-tail',
        agentId: 'agent-wrapped-exit-tail',
        command: '/bin/sh',
        args: [],
        cwd: '/',
        env: {},
        cols: 80,
        rows: 24,
        onOutput: { __CHANNEL_ID__: 'wrapped-exit-tail' },
      });

      for (let offset = 0; offset < output.length; offset += 7) {
        proc.emitData(output.subarray(offset, offset + 7));
      }
      proc.emitExit({ exitCode: 1, signal: null });

      expect(onExit).toHaveBeenCalledWith('agent-wrapped-exit-tail', {
        exitCode: 1,
        generation: 0,
        lastOutput: outputLines.slice(-50),
        signal: null,
      });
    } finally {
      offExit();
    }
  });

  it('keeps only the diagnostic suffix from a PTY chunk larger than the tail capacity', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const onExit = vi.fn();
    const offExit = onPtyEvent('exit', onExit);

    try {
      spawnAgent(vi.fn(), {
        taskId: 'task-oversized-exit-tail',
        agentId: 'agent-oversized-exit-tail',
        command: '/bin/sh',
        args: [],
        cwd: '/',
        env: {},
        cols: 80,
        rows: 24,
        onOutput: { __CHANNEL_ID__: 'oversized-exit-tail' },
      });

      proc.emitData(Buffer.from(`${'discarded'.repeat(1_200)}\nkept-one\nkept-two\n`, 'utf8'));
      proc.emitExit({ exitCode: 2, signal: 15 });

      expect(onExit).toHaveBeenCalledWith(
        'agent-oversized-exit-tail',
        expect.objectContaining({
          exitCode: 2,
          lastOutput: expect.arrayContaining(['kept-one', 'kept-two']),
          signal: 15,
        }),
      );
      const exitEvent = onExit.mock.calls[0]?.[1] as { lastOutput?: string[] } | undefined;
      expect(exitEvent?.lastOutput?.slice(-2)).toEqual(['kept-one', 'kept-two']);
    } finally {
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

  it('expires scoped restore pauses when the matching resume never arrives', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-restore-expiry',
      agentId: 'agent-restore-expiry',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'restore-channel' },
    });

    pauseAgent('agent-restore-expiry', 'restore', 'restore-channel');
    expect(getAgentPauseState('agent-restore-expiry')).toBe('restore');
    expect(proc.pause).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(getAgentPauseState('agent-restore-expiry')).toBe('restore');

    await vi.advanceTimersByTimeAsync(1);
    expect(getAgentPauseState('agent-restore-expiry')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('expires global restore pauses when recovery cleanup does not run', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-global-restore-expiry',
      agentId: 'agent-global-restore-expiry',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
    });

    pauseAgent('agent-global-restore-expiry', 'restore');
    expect(getAgentPauseState('agent-global-restore-expiry')).toBe('restore');

    await vi.advanceTimersByTimeAsync(30_000);

    expect(getAgentPauseState('agent-global-restore-expiry')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('does not expire manual pauses when a restore lease times out', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-manual-restore-expiry',
      agentId: 'agent-manual-restore-expiry',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'restore-channel' },
    });

    pauseAgent('agent-manual-restore-expiry', 'manual');
    pauseAgent('agent-manual-restore-expiry', 'restore', 'restore-channel');

    await vi.advanceTimersByTimeAsync(30_000);

    expect(getAgentPauseState('agent-manual-restore-expiry')).toBe('manual');
    expect(proc.resume).not.toHaveBeenCalled();

    resumeAgent('agent-manual-restore-expiry', 'manual');
    expect(getAgentPauseState('agent-manual-restore-expiry')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps renewed flow-control pauses when a restore lease times out', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-flow-restore-expiry',
      agentId: 'agent-flow-restore-expiry',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'restore-channel' },
    });

    pauseAgent('agent-flow-restore-expiry', 'flow-control', 'restore-channel');
    pauseAgent('agent-flow-restore-expiry', 'restore', 'restore-channel');

    await vi.advanceTimersByTimeAsync(10_000);
    pauseAgent('agent-flow-restore-expiry', 'flow-control', 'restore-channel');
    await vi.advanceTimersByTimeAsync(10_000);
    pauseAgent('agent-flow-restore-expiry', 'flow-control', 'restore-channel');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(getAgentPauseState('agent-flow-restore-expiry')).toBe('flow-control');
    expect(proc.resume).not.toHaveBeenCalled();

    resumeAgent('agent-flow-restore-expiry', 'flow-control', 'restore-channel');
    expect(getAgentPauseState('agent-flow-restore-expiry')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('cancels scoped restore expiry when the matching resume arrives', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-restore-resume',
      agentId: 'agent-restore-resume',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'restore-channel' },
    });

    pauseAgent('agent-restore-resume', 'restore', 'restore-channel');
    resumeAgent('agent-restore-resume', 'restore', 'restore-channel');

    expect(getAgentPauseState('agent-restore-resume')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(getAgentPauseState('agent-restore-resume')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('renews scoped restore pause leases when the same restore id pauses again', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-restore-renew',
      agentId: 'agent-restore-renew',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'restore-channel' },
    });

    pauseAgent('agent-restore-renew', 'restore', 'restore-channel', 'restore-lease-1');
    await vi.advanceTimersByTimeAsync(20_000);
    pauseAgent('agent-restore-renew', 'restore', 'restore-channel', 'restore-lease-1');
    await vi.advanceTimersByTimeAsync(20_000);

    expect(getAgentPauseState('agent-restore-renew')).toBe('restore');
    expect(proc.pause).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(getAgentPauseState('agent-restore-renew')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps scoped restore pauses when a stale restore id resumes on the same channel', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-stale-restore-resume',
      agentId: 'agent-stale-restore-resume',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'restore-channel' },
    });

    pauseAgent('agent-stale-restore-resume', 'restore', 'restore-channel', 'restore-lease-new');
    resumeAgent('agent-stale-restore-resume', 'restore', 'restore-channel', 'restore-lease-old');

    expect(getAgentPauseState('agent-stale-restore-resume')).toBe('restore');
    expect(proc.resume).not.toHaveBeenCalled();

    resumeAgent('agent-stale-restore-resume', 'restore', 'restore-channel', 'restore-lease-new');

    expect(getAgentPauseState('agent-stale-restore-resume')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps newer scoped restore leases when an older same-channel restore resumes', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-overlapping-restore-resume',
      agentId: 'agent-overlapping-restore-resume',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'restore-channel' },
    });

    pauseAgent(
      'agent-overlapping-restore-resume',
      'restore',
      'restore-channel',
      'restore-lease-old',
    );
    pauseAgent(
      'agent-overlapping-restore-resume',
      'restore',
      'restore-channel',
      'restore-lease-new',
    );
    resumeAgent(
      'agent-overlapping-restore-resume',
      'restore',
      'restore-channel',
      'restore-lease-old',
    );

    expect(getAgentPauseState('agent-overlapping-restore-resume')).toBe('restore');
    expect(proc.resume).not.toHaveBeenCalled();

    resumeAgent(
      'agent-overlapping-restore-resume',
      'restore',
      'restore-channel',
      'restore-lease-new',
    );

    expect(getAgentPauseState('agent-overlapping-restore-resume')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('clears scoped restore leases when a browser channel disconnects', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-restore-channel-cleanup',
      agentId: 'agent-restore-channel-cleanup',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'restore-channel' },
    });

    pauseAgent('agent-restore-channel-cleanup', 'restore', 'restore-channel');
    clearAutoPauseReasonsForChannel('restore-channel');

    expect(getAgentPauseState('agent-restore-channel-cleanup')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(getAgentPauseState('agent-restore-channel-cleanup')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('clears all scoped restore lease ids when a browser channel disconnects', async () => {
    vi.useFakeTimers();
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-restore-channel-multi-cleanup',
      agentId: 'agent-restore-channel-multi-cleanup',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'restore-channel' },
    });

    pauseAgent(
      'agent-restore-channel-multi-cleanup',
      'restore',
      'restore-channel',
      'restore-lease-1',
    );
    pauseAgent(
      'agent-restore-channel-multi-cleanup',
      'restore',
      'restore-channel',
      'restore-lease-2',
    );
    clearAutoPauseReasonsForChannel('restore-channel');

    expect(getAgentPauseState('agent-restore-channel-multi-cleanup')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(getAgentPauseState('agent-restore-channel-multi-cleanup')).toBeNull();
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('ignores scoped restore pauses for channels not attached to the agent', () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);

    spawnAgent(vi.fn(), {
      taskId: 'task-unknown-restore-channel',
      agentId: 'agent-unknown-restore-channel',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'known-channel' },
    });

    pauseAgent('agent-unknown-restore-channel', 'restore', 'missing-channel');

    expect(getAgentPauseState('agent-unknown-restore-channel')).toBeNull();
    expect(proc.pause).not.toHaveBeenCalled();
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
      .spyOn(TerminalStateMirror.prototype, 'serializeLatest')
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

describe('flush-time scans and cursor-first recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    killAllAgents();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function spawnFlushScanAgent(agentId: string, taskId: string, channelId: string): MockProc {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    spawnAgent(vi.fn(), {
      taskId,
      agentId,
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: channelId },
    });
    return proc;
  }

  it('runs supervision and port scans at flush even with zero attached channels', () => {
    const proc = spawnFlushScanAgent('agent-no-channels', 'task-no-channels', 'detached-channel');
    detachAgentOutput('agent-no-channels', 'detached-channel');
    observeTaskPortsFromOutputMock.mockClear();

    proc.emitData('listening on http://localhost:4321');
    vi.advanceTimersByTime(4);

    // Unattached agents (for example coordinator-driven ones) must keep
    // supervision, port observation, and the terminal-state mirror live even
    // though the flush has no channel subscribers to send to.
    expect(observeTaskPortsFromOutputMock).toHaveBeenCalledWith(
      'task-no-channels',
      'listening on http://localhost:4321',
    );
  });

  it('forwards the pending batch to the mirror before applying a resize', () => {
    const enqueueOutputSpy = vi.spyOn(TerminalStateMirror.prototype, 'enqueueOutput');
    const enqueueResizeSpy = vi.spyOn(TerminalStateMirror.prototype, 'enqueueResize');
    try {
      const proc = spawnFlushScanAgent('agent-resize-order', 'task-resize-order', 'resize-channel');

      proc.emitData('pending-bytes');
      expect(enqueueOutputSpy).not.toHaveBeenCalled();

      resizeAgent('agent-resize-order', 120, 40);

      // Mirror writes and the resize keep the same relative order as the
      // real PTY byte stream: batch first, then resize.
      expect(enqueueOutputSpy).toHaveBeenCalledTimes(1);
      expect(enqueueResizeSpy).toHaveBeenCalledTimes(1);
      const outputOrder = enqueueOutputSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
      const resizeOrder = enqueueResizeSpy.mock.invocationCallOrder[0] ?? 0;
      expect(outputOrder).toBeLessThan(resizeOrder);
    } finally {
      enqueueOutputSpy.mockRestore();
      enqueueResizeSpy.mockRestore();
    }
  });

  it('tags mirror writes with the cumulative byte cursor at flush time', () => {
    const enqueueOutputSpy = vi.spyOn(TerminalStateMirror.prototype, 'enqueueOutput');
    try {
      const proc = spawnFlushScanAgent('agent-cursor-tag', 'task-cursor-tag', 'cursor-channel');

      proc.emitData('12345');
      vi.advanceTimersByTime(4);
      proc.emitData('678');
      vi.advanceTimersByTime(4);

      expect(enqueueOutputSpy).toHaveBeenCalledTimes(2);
      expect(enqueueOutputSpy.mock.calls[0]?.[1]).toBe(5);
      expect(enqueueOutputSpy.mock.calls[1]?.[1]).toBe(8);
    } finally {
      enqueueOutputSpy.mockRestore();
    }
  });

  it('returns tail-needed on a cursor miss when the capped snapshot would truncate history', () => {
    const proc = spawnFlushScanAgent('agent-tail-needed', 'task-tail-needed', 'tail-channel');
    proc.emitData('x'.repeat(100));

    const recovery = getAgentTerminalRecovery('agent-tail-needed', null, 500, 50);

    expect(recovery.kind).toBe('tail-needed');
    expect(recovery.outputCursor).toBe(100);
  });

  it('falls back to a capped snapshot on a cursor miss when retention fits the limit', () => {
    const proc = spawnFlushScanAgent('agent-cursor-miss', 'task-cursor-miss', 'miss-channel');
    proc.emitData('x'.repeat(100));

    const recovery = getAgentTerminalRecovery('agent-cursor-miss', null, 500, 200);

    expect(recovery.kind).toBe('snapshot');
    if (recovery.kind !== 'snapshot') {
      throw new Error('expected snapshot recovery');
    }
    expect(recovery.data?.length).toBe(100);
  });

  it('caps cursorless reconnect snapshots at the requested byte limit', () => {
    const proc = spawnFlushScanAgent('agent-snapshot-cap', 'task-snapshot-cap', 'cap-channel');
    proc.emitData('y'.repeat(100));

    const recovery = getAgentTerminalRecovery('agent-snapshot-cap', null, null, 50);

    expect(recovery.kind).toBe('snapshot');
    if (recovery.kind !== 'snapshot') {
      throw new Error('expected snapshot recovery');
    }
    expect(recovery.data?.length).toBe(50);
    expect(recovery.outputCursor).toBe(100);
  });

  it('keeps the cursor-hit delta fast path byte-exact under the snapshot cap', () => {
    const proc = spawnFlushScanAgent('agent-cursor-hit', 'task-cursor-hit', 'hit-channel');
    proc.emitData('abcdefghij');

    const recovery = getAgentTerminalRecovery('agent-cursor-hit', null, 6, 4);

    expect(recovery.kind).toBe('delta');
    if (recovery.kind !== 'delta') {
      throw new Error('expected delta recovery');
    }
    expect(recovery.data.toString('utf8')).toBe('ghij');
    expect(recovery.outputCursor).toBe(10);
  });
});
