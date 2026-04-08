import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('./ipc', () => ({
  invoke: invokeMock,
}));

describe('terminal recovery batching', () => {
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
          snapshotByteLimit: null,
        },
      ],
    });
  });

  it('batches initial attach restores into a single IPC round-trip', async () => {
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

    const { requestAttachTerminalRecovery } = await import('./scrollbackRestore');

    const first = requestAttachTerminalRecovery('agent-a', { outputCursor: 5 });
    const second = requestAttachTerminalRecovery('agent-b', { outputCursor: 6 });

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
          snapshotByteLimit: null,
        },
        {
          agentId: 'agent-b',
          outputCursor: 6,
          renderedTail: null,
          requestId: expect.any(String),
          snapshotByteLimit: null,
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
          snapshotByteLimit: null,
        },
        {
          agentId: 'agent-b',
          outputCursor: 6,
          renderedTail: null,
          requestId: expect.any(String),
          snapshotByteLimit: null,
        },
      ],
    });
  });

  it('requests selected startup recovery immediately while still batching visible siblings', async () => {
    invokeMock.mockImplementation(
      async (_channel: IPC, payload: { requests: Array<{ agentId: string; requestId: string }> }) =>
        payload.requests.map((request) => ({
          agentId: request.agentId,
          cols: request.agentId === 'agent-selected' ? 101 : 88,
          outputCursor: request.agentId === 'agent-selected' ? 17 : 9,
          recovery: {
            data: request.agentId === 'agent-selected' ? 'aaa' : 'bbb',
            kind: 'snapshot' as const,
          },
          requestId: request.requestId,
        })),
    );

    const { requestStartupTerminalRecovery } = await import('./scrollbackRestore');

    const first = requestStartupTerminalRecovery('agent-selected', 'selected');
    const second = requestStartupTerminalRecovery('agent-visible', 'visible-sibling');

    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.GetTerminalStartupRecoveryBatch, {
      requests: [
        {
          agentId: 'agent-selected',
          requestId: expect.any(String),
          role: 'selected',
        },
      ],
    });

    await vi.advanceTimersByTimeAsync(20);

    await expect(first).resolves.toMatchObject({
      agentId: 'agent-selected',
      cols: 101,
      outputCursor: 17,
      recovery: { kind: 'snapshot', data: 'aaa' },
    });
    await expect(second).resolves.toMatchObject({
      agentId: 'agent-visible',
      cols: 88,
      outputCursor: 9,
      recovery: { kind: 'snapshot', data: 'bbb' },
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.GetTerminalStartupRecoveryBatch, {
      requests: [
        {
          agentId: 'agent-visible',
          requestId: expect.any(String),
          role: 'visible-sibling',
        },
      ],
    });
  });

  it('requests selected startup recovery immediately when batching would only delay the focused terminal', async () => {
    invokeMock.mockResolvedValue([
      {
        agentId: 'agent-selected',
        cols: 101,
        outputCursor: 17,
        recovery: {
          data: 'aaa',
          kind: 'snapshot' as const,
        },
        requestId: 'req-selected',
      },
    ]);

    const { requestStartupTerminalRecovery } = await import('./scrollbackRestore');

    await expect(
      requestStartupTerminalRecovery('agent-selected', 'selected', { immediate: true }),
    ).resolves.toMatchObject({
      agentId: 'agent-selected',
      cols: 101,
      outputCursor: 17,
      recovery: { kind: 'snapshot', data: 'aaa' },
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetTerminalStartupRecoveryBatch, {
      requests: [
        {
          agentId: 'agent-selected',
          requestId: expect.any(String),
          role: 'selected',
        },
      ],
    });
  });

  it('requests selected reconnect recovery immediately without waiting for the reconnect batch window', async () => {
    invokeMock.mockResolvedValue([
      {
        agentId: 'agent-now',
        cols: 87,
        outputCursor: 3,
        recovery: {
          data: 'aaa',
          kind: 'delta' as const,
          overlapBytes: 2,
          source: 'tail' as const,
        },
        requestId: 'req-now',
      },
    ]);

    const { requestReconnectTerminalRecovery } = await import('./scrollbackRestore');

    await expect(
      requestReconnectTerminalRecovery(
        'agent-now',
        {
          outputCursor: 11,
          renderedTail: Buffer.from('zz', 'utf8').toString('base64'),
        },
        { immediate: true },
      ),
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
          snapshotByteLimit: null,
        },
      ],
    });
  });
});
