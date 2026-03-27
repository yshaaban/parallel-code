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
  pause: () => void;
  resume: () => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
  kill: () => void;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper wrapping dynamic import
function spawnTestAgent(spawnAgent: any, agentId: string, channelId: string): void {
  spawnAgent(vi.fn(), {
    taskId: `task-${agentId}`,
    agentId,
    command: '/bin/sh',
    args: [],
    cwd: '/',
    env: {},
    cols: 80,
    rows: 24,
    onOutput: { __CHANNEL_ID__: channelId },
  });
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

    spawnTestAgent(spawnAgent, 'agent-1', 'channel-1');
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

    spawnTestAgent(spawnAgent, 'agent-2', 'channel-2');
    pauseAgent('agent-2', 'flow-control');
    detachAgentOutput('agent-2', 'channel-2');

    expect(proc.pause).toHaveBeenCalledTimes(1);
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('clears flow-control pauses via clearAutoPauseReasonsForChannel without removing channel', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const { clearAutoPauseReasonsForChannel, pauseAgent, spawnAgent } = await import('./pty.js');

    spawnTestAgent(spawnAgent, 'agent-clear', 'channel-a');
    pauseAgent('agent-clear', 'flow-control');
    expect(proc.pause).toHaveBeenCalledTimes(1);

    clearAutoPauseReasonsForChannel('channel-a');
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('clearAutoPauseReasonsForChannel only affects agents with that channel', async () => {
    const proc1 = createMockProc();
    const proc2 = createMockProc();
    spawnMock.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);
    const { clearAutoPauseReasonsForChannel, pauseAgent, spawnAgent } = await import('./pty.js');

    spawnTestAgent(spawnAgent, 'agent-a', 'channel-a');
    spawnTestAgent(spawnAgent, 'agent-b', 'channel-b');
    pauseAgent('agent-a', 'flow-control');
    pauseAgent('agent-b', 'flow-control');

    clearAutoPauseReasonsForChannel('channel-a');
    expect(proc1.resume).toHaveBeenCalledTimes(1);
    expect(proc2.resume).not.toHaveBeenCalled();
  });

  it('clearAutoPauseReasonsForChannel preserves manual pauses', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const { clearAutoPauseReasonsForChannel, pauseAgent, spawnAgent } = await import('./pty.js');

    spawnTestAgent(spawnAgent, 'agent-manual', 'channel-a');
    pauseAgent('agent-manual', 'manual');
    pauseAgent('agent-manual', 'flow-control');
    expect(proc.pause).toHaveBeenCalledTimes(1);

    clearAutoPauseReasonsForChannel('channel-a');
    expect(proc.resume).not.toHaveBeenCalled();
  });

  it('reference-counts concurrent pause reasons from multiple clients', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const { pauseAgent, resumeAgent, spawnAgent } = await import('./pty.js');

    spawnTestAgent(spawnAgent, 'agent-3', 'channel-3');
    pauseAgent('agent-3', 'flow-control');
    pauseAgent('agent-3', 'flow-control');

    expect(proc.pause).toHaveBeenCalledTimes(1);

    resumeAgent('agent-3', 'flow-control');
    expect(proc.resume).not.toHaveBeenCalled();

    resumeAgent('agent-3', 'flow-control');
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('reports the effective pause state in priority order', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const { getAgentPauseState, pauseAgent, resumeAgent, spawnAgent } = await import('./pty.js');

    spawnTestAgent(spawnAgent, 'agent-state', 'channel-state');
    expect(getAgentPauseState('agent-state')).toBeNull();

    pauseAgent('agent-state', 'restore');
    expect(getAgentPauseState('agent-state')).toBe('restore');

    pauseAgent('agent-state', 'flow-control');
    expect(getAgentPauseState('agent-state')).toBe('flow-control');

    pauseAgent('agent-state', 'manual');
    expect(getAgentPauseState('agent-state')).toBe('manual');

    resumeAgent('agent-state', 'manual');
    expect(getAgentPauseState('agent-state')).toBe('flow-control');

    resumeAgent('agent-state', 'flow-control');
    expect(getAgentPauseState('agent-state')).toBe('restore');

    resumeAgent('agent-state', 'restore');
    expect(getAgentPauseState('agent-state')).toBeNull();
  });

  it('keeps flow-control pauses for other channels when one channel disconnects', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const { clearAutoPauseReasonsForChannel, pauseAgent, spawnAgent } = await import('./pty.js');

    spawnTestAgent(spawnAgent, 'agent-shared', 'channel-a');
    spawnTestAgent(spawnAgent, 'agent-shared', 'channel-b');

    pauseAgent('agent-shared', 'flow-control', 'channel-a');
    pauseAgent('agent-shared', 'flow-control', 'channel-b');
    expect(proc.pause).toHaveBeenCalledTimes(1);

    clearAutoPauseReasonsForChannel('channel-a');
    expect(proc.resume).not.toHaveBeenCalled();

    clearAutoPauseReasonsForChannel('channel-b');
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('clears a detached channel scoped flow-control pause even when another channel remains', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const { detachAgentOutput, pauseAgent, spawnAgent } = await import('./pty.js');

    spawnTestAgent(spawnAgent, 'agent-detach', 'channel-a');
    spawnTestAgent(spawnAgent, 'agent-detach', 'channel-b');

    pauseAgent('agent-detach', 'flow-control', 'channel-a');
    expect(proc.pause).toHaveBeenCalledTimes(1);

    detachAgentOutput('agent-detach', 'channel-a');
    expect(proc.resume).toHaveBeenCalledTimes(1);
  });

  it('does not leak automatic pause ownership across repeated multi-channel churn', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const { clearAutoPauseReasonsForChannel, getAgentPauseState, pauseAgent, spawnAgent } =
      await import('./pty.js');

    spawnTestAgent(spawnAgent, 'agent-loop', 'channel-a');
    spawnTestAgent(spawnAgent, 'agent-loop', 'channel-b');

    for (const _cycle of [1, 2, 3]) {
      pauseAgent('agent-loop', 'flow-control', 'channel-a');
      pauseAgent('agent-loop', 'restore', 'channel-b');
      expect(getAgentPauseState('agent-loop')).toBe('flow-control');

      clearAutoPauseReasonsForChannel('channel-a');
      expect(getAgentPauseState('agent-loop')).toBe('restore');

      clearAutoPauseReasonsForChannel('channel-b');
      expect(getAgentPauseState('agent-loop')).toBeNull();
    }

    expect(proc.pause).toHaveBeenCalledTimes(3);
    expect(proc.resume).toHaveBeenCalledTimes(3);
  });
});
