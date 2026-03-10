import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}));

import { killAllAgents, spawnAgent, validateCommand } from './pty.js';

const existingAbsoluteCommand =
  process.platform === 'win32'
    ? (process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe')
    : '/bin/sh';
const existingBareCommand = process.platform === 'win32' ? 'cmd' : 'sh';
const missingAbsoluteCommand =
  process.platform === 'win32' ? 'C:\\nonexistent\\path\\binary.exe' : '/nonexistent/path/binary';

type MockProc = {
  cols: number;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
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
  spawnMock.mockReset();
});

afterEach(() => {
  killAllAgents();
});

describe('validateCommand', () => {
  it('does not throw for a command found in PATH', () => {
    expect(() => validateCommand(existingAbsoluteCommand)).not.toThrow();
  });

  it('throws a descriptive error for a missing command', () => {
    expect(() => validateCommand('nonexistent-binary-xyz')).toThrow(/not found in PATH/);
  });

  it('throws a descriptive error naming the command', () => {
    expect(() => validateCommand('nonexistent-binary-xyz')).toThrow(/nonexistent-binary-xyz/);
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
});
