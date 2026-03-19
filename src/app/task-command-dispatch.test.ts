import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, storeState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  storeState: {
    agents: {} as Record<
      string,
      { status: 'running' | 'paused' | 'flow-controlled' | 'restoring' | 'exited' }
    >,
  },
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../store/state', () => ({
  store: storeState,
}));

import { writeToAgentWhenReady } from './task-command-dispatch';

describe('task-command-dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    storeState.agents = {};
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps retrying while the agent remains writable', async () => {
    invokeMock.mockRejectedValueOnce(new Error('agent not found'));
    invokeMock.mockResolvedValueOnce(undefined);
    storeState.agents = {
      'agent-1': { status: 'paused' },
    };

    const writePromise = writeToAgentWhenReady('agent-1', 'hello');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    await writePromise;

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('fails immediately once the agent is no longer writable', async () => {
    const notFoundError = new Error('agent not found');
    invokeMock.mockRejectedValue(notFoundError);
    storeState.agents = {
      'agent-1': { status: 'exited' },
    };

    await expect(writeToAgentWhenReady('agent-1', 'hello')).rejects.toThrow(notFoundError);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
