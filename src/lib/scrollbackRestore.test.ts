import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('./ipc', () => ({
  invoke: invokeMock,
}));

describe('requestReconnectScrollback', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    invokeMock.mockReset();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        setTimeout,
        clearTimeout,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('batches reconnect restores into a single IPC round-trip', async () => {
    invokeMock.mockResolvedValue([
      { agentId: 'agent-a', scrollback: 'aaa', cols: 81 },
      { agentId: 'agent-b', scrollback: 'bbb', cols: 99 },
    ]);

    const { requestReconnectScrollback } = await import('./scrollbackRestore');

    const first = requestReconnectScrollback('agent-a');
    const second = requestReconnectScrollback('agent-b');

    await vi.advanceTimersByTimeAsync(20);

    await expect(first).resolves.toEqual({ agentId: 'agent-a', scrollback: 'aaa', cols: 81 });
    await expect(second).resolves.toEqual({ agentId: 'agent-b', scrollback: 'bbb', cols: 99 });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetScrollbackBatch, {
      agentIds: ['agent-a', 'agent-b'],
    });
  });
});
