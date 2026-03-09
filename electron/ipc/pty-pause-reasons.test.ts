import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const validateCommandMock = vi.fn();

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}));

vi.mock('./command-resolver.js', () => ({
  validateCommand: validateCommandMock,
}));

type MockProc = {
  cols: number;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (info: { exitCode: number | null; signal?: number | null }) => void) => void;
};

function createMockProc(): MockProc {
  let onExitCb: ((info: { exitCode: number | null; signal?: number | null }) => void) | undefined;
  return {
    cols: 80,
    pause: vi.fn(),
    resume: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(() => onExitCb?.({ exitCode: 0, signal: null })),
    onData: vi.fn(),
    onExit: vi.fn((cb) => {
      onExitCb = cb;
    }),
  };
}

describe('pty pause reasons', () => {
  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    validateCommandMock.mockReset();
  });

  it('keeps manual pauses across detach', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const { detachAgentOutput, pauseAgent, resumeAgent, spawnAgent } = await import('./pty.js');

    spawnAgent(vi.fn(), {
      taskId: 'task-1',
      agentId: 'agent-1',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    pauseAgent('agent-1', 'manual');
    detachAgentOutput('agent-1', 'channel-1');

    expect(proc.pause).toHaveBeenCalledTimes(1);
    expect(proc.resume).not.toHaveBeenCalled();

    resumeAgent('agent-1', 'manual');
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('drops automatic pause reasons when the last channel detaches', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const { detachAgentOutput, pauseAgent, spawnAgent } = await import('./pty.js');

    spawnAgent(vi.fn(), {
      taskId: 'task-2',
      agentId: 'agent-2',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'channel-2' },
    });

    pauseAgent('agent-2', 'flow-control');
    detachAgentOutput('agent-2', 'channel-2');

    expect(proc.pause).toHaveBeenCalledTimes(1);
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('reference-counts concurrent pause reasons from multiple clients', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const { pauseAgent, resumeAgent, spawnAgent } = await import('./pty.js');

    spawnAgent(vi.fn(), {
      taskId: 'task-3',
      agentId: 'agent-3',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'channel-3' },
    });

    pauseAgent('agent-3', 'flow-control');
    pauseAgent('agent-3', 'flow-control');

    expect(proc.pause).toHaveBeenCalledTimes(1);

    resumeAgent('agent-3', 'flow-control');
    expect(proc.resume).not.toHaveBeenCalled();

    resumeAgent('agent-3', 'flow-control');
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });
});
