import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAgentMetaMock, getAgentPauseStateMock, onPtyEventMock, ptyListeners } = vi.hoisted(
  () => {
    const listeners = new Map<string, (agentId: string, data?: unknown) => void>();
    return {
      getAgentMetaMock: vi.fn(),
      getAgentPauseStateMock: vi.fn(),
      onPtyEventMock: vi.fn(
        (event: string, listener: (agentId: string, data?: unknown) => void) => {
          listeners.set(event, listener);
          return vi.fn(() => {
            listeners.delete(event);
          });
        },
      ),
      ptyListeners: listeners,
    };
  },
);

vi.mock('../electron/ipc/pty.js', () => ({
  getAgentMeta: getAgentMetaMock,
  getAgentPauseState: getAgentPauseStateMock,
  onPtyEvent: onPtyEventMock,
}));

vi.mock('../electron/remote/protocol.js', () => ({
  getRemoteAgentStatus: vi.fn(() => 'paused'),
}));

describe('registerAgentLifecycleBroadcasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptyListeners.clear();
    getAgentPauseStateMock.mockReturnValue(null);
  });

  afterEach(() => {
    ptyListeners.clear();
  });

  it('includes lifecycle generation on spawn and exit broadcasts', async () => {
    const { registerAgentLifecycleBroadcasts } = await import('./agent-lifecycle.js');
    const broadcastAgentList = vi.fn();
    const broadcastControl = vi.fn();
    const releaseAgentControl = vi.fn();

    getAgentMetaMock.mockReturnValue({
      agentId: 'agent-1',
      generation: 4,
      isShell: false,
      taskId: 'task-1',
    });

    const cleanup = registerAgentLifecycleBroadcasts({
      broadcastAgentList,
      broadcastControl,
      releaseAgentControl,
    });

    ptyListeners.get('spawn')?.('agent-1');
    ptyListeners.get('exit')?.('agent-1', { exitCode: 9, generation: 4, signal: 'SIGTERM' });

    expect(broadcastControl).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        event: 'spawn',
        generation: 4,
        type: 'agent-lifecycle',
      }),
    );
    expect(broadcastControl).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        event: 'exit',
        exitCode: 9,
        generation: 4,
        signal: 'SIGTERM',
        type: 'agent-lifecycle',
      }),
    );

    cleanup();
  });

  it('broadcasts spawn, pause, resume, and exit with backend lifecycle truth', async () => {
    const { registerAgentLifecycleBroadcasts } = await import('./agent-lifecycle.js');
    const broadcastAgentList = vi.fn();
    const broadcastControl = vi.fn();
    const releaseAgentControl = vi.fn();
    const scheduledTimers = new Map<object, () => void>();
    const setTimer = vi.fn((callback: () => void) => {
      const handle = {};
      scheduledTimers.set(handle, callback);
      return handle as ReturnType<typeof setTimeout>;
    });
    const clearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => {
      scheduledTimers.delete(timer as unknown as object);
    });

    getAgentMetaMock.mockReturnValue({
      agentId: 'agent-1',
      generation: 7,
      isShell: true,
      taskId: 'task-1',
    });
    getAgentPauseStateMock.mockReturnValue('flow-control');

    const cleanup = registerAgentLifecycleBroadcasts({
      broadcastAgentList,
      broadcastControl,
      clearTimer,
      releaseAgentControl,
      setTimer,
    });

    ptyListeners.get('spawn')?.('agent-1');
    ptyListeners.get('pause')?.('agent-1');
    ptyListeners.get('resume')?.('agent-1');
    ptyListeners.get('exit')?.('agent-1', { exitCode: 0, generation: 11, signal: null });

    expect(broadcastAgentList).toHaveBeenCalledTimes(3);
    expect(releaseAgentControl).toHaveBeenCalledWith('agent-1');
    expect(broadcastControl.mock.calls).toEqual(
      expect.arrayContaining([
        [
          {
            agentId: 'agent-1',
            event: 'spawn',
            generation: 7,
            isShell: true,
            status: 'running',
            taskId: 'task-1',
            type: 'agent-lifecycle',
          },
        ],
        [
          {
            agentId: 'agent-1',
            event: 'pause',
            generation: 7,
            isShell: true,
            status: 'paused',
            taskId: 'task-1',
            type: 'agent-lifecycle',
          },
        ],
        [
          {
            agentId: 'agent-1',
            event: 'resume',
            generation: 7,
            isShell: true,
            status: 'running',
            taskId: 'task-1',
            type: 'agent-lifecycle',
          },
        ],
        [
          {
            agentId: 'agent-1',
            event: 'exit',
            exitCode: 0,
            generation: 11,
            isShell: true,
            signal: null,
            status: 'exited',
            taskId: 'task-1',
            type: 'agent-lifecycle',
          },
        ],
      ]),
    );

    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(scheduledTimers.size).toBe(1);
    scheduledTimers.values().next().value?.();
    expect(broadcastAgentList).toHaveBeenCalledTimes(4);

    cleanup();
  });

  it('cancels delayed exit list refresh on cleanup', async () => {
    const { registerAgentLifecycleBroadcasts } = await import('./agent-lifecycle.js');
    const broadcastAgentList = vi.fn();
    const broadcastControl = vi.fn();
    const releaseAgentControl = vi.fn();
    const scheduledTimers = new Map<object, () => void>();
    const setTimer = vi.fn((callback: () => void) => {
      const handle = {};
      scheduledTimers.set(handle, callback);
      return handle as ReturnType<typeof setTimeout>;
    });
    const clearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => {
      scheduledTimers.delete(timer as unknown as object);
    });

    getAgentMetaMock.mockReturnValue({
      agentId: 'agent-1',
      generation: 4,
      isShell: false,
      taskId: 'task-1',
    });

    const cleanup = registerAgentLifecycleBroadcasts({
      broadcastAgentList,
      broadcastControl,
      clearTimer,
      releaseAgentControl,
      setTimer,
    });

    ptyListeners.get('exit')?.('agent-1', { exitCode: 1, generation: 4, signal: 'SIGTERM' });
    expect(scheduledTimers.size).toBe(1);

    cleanup();
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(scheduledTimers.size).toBe(0);
    expect(broadcastAgentList).toHaveBeenCalledTimes(0);
  });
});
