import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('./ipc', () => ({
  invoke: invokeMock,
}));

describe('requestReconnectTerminalRecovery', () => {
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

  it('requests immediate terminal recovery without waiting for the reconnect batch window', async () => {
    invokeMock.mockResolvedValue([
      {
        agentId: 'agent-now',
        cols: 87,
        outputCursor: 3,
        recovery: {
          kind: 'delta',
          data: 'aaa',
          overlapBytes: 2,
          source: 'tail',
        },
        requestId: 'req-now',
      },
    ]);

    const { requestTerminalRecovery } = await import('./scrollbackRestore');

    await expect(
      requestTerminalRecovery('agent-now', {
        outputCursor: 11,
        renderedTail: Buffer.from('zz', 'utf8').toString('base64'),
      }),
    ).resolves.toMatchObject({
      agentId: 'agent-now',
      cols: 87,
      outputCursor: 3,
      recovery: {
        kind: 'delta',
        data: 'aaa',
        overlapBytes: 2,
        source: 'tail',
      },
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetTerminalRecoveryBatch, {
      requests: [
        {
          agentId: 'agent-now',
          outputCursor: 11,
          renderedTail: Buffer.from('zz', 'utf8').toString('base64'),
          requestId: expect.any(String),
        },
      ],
    });
  });

  it('batches reconnect restores into a single IPC round-trip', async () => {
    invokeMock.mockImplementation(
      async (_channel: IPC, payload: { requests: Array<{ agentId: string; requestId: string }> }) =>
        payload.requests.map((request) => ({
          agentId: request.agentId,
          cols: request.agentId === 'agent-a' ? 81 : 99,
          outputCursor: request.agentId === 'agent-a' ? 7 : 9,
          recovery: {
            data: request.agentId === 'agent-a' ? 'aaa' : 'bbb',
            kind: 'snapshot' as const,
          },
          requestId: request.requestId,
        })),
    );

    const { requestReconnectTerminalRecovery } = await import('./scrollbackRestore');

    const first = requestReconnectTerminalRecovery('agent-a', { outputCursor: 5 });
    const second = requestReconnectTerminalRecovery('agent-b', { outputCursor: 6 });

    await vi.advanceTimersByTimeAsync(20);

    await expect(first).resolves.toMatchObject({
      agentId: 'agent-a',
      cols: 81,
      outputCursor: 7,
      recovery: { kind: 'snapshot', data: 'aaa' },
    });
    await expect(second).resolves.toMatchObject({
      agentId: 'agent-b',
      cols: 99,
      outputCursor: 9,
      recovery: { kind: 'snapshot', data: 'bbb' },
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetTerminalRecoveryBatch, {
      requests: [
        {
          agentId: 'agent-a',
          outputCursor: 5,
          renderedTail: null,
          requestId: expect.any(String),
        },
        {
          agentId: 'agent-b',
          outputCursor: 6,
          renderedTail: null,
          requestId: expect.any(String),
        },
      ],
    });
  });
});
