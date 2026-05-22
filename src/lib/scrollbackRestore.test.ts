import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

import type { TerminalRecoveryBatchEntry } from '../ipc/types';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('./ipc', () => ({
  invoke: invokeMock,
}));

type RecoveryRequest = {
  agentId: string;
  requestId: string;
};

type RecoveryRequestPayload = {
  requests: RecoveryRequest[];
};

function createSnapshotBatchEntry(
  request: RecoveryRequest,
  options: {
    cols?: number;
    data?: string;
    outputCursor?: number;
    rows?: number;
  } = {},
): TerminalRecoveryBatchEntry {
  return {
    agentId: request.agentId,
    cols: options.cols ?? 101,
    outputCursor: options.outputCursor ?? 17,
    recovery: {
      data: options.data ?? 'aaa',
      kind: 'snapshot',
    },
    requestId: request.requestId,
    rows: options.rows ?? 24,
  };
}

function mockSnapshotRecoveryBatch(
  createEntry: (request: RecoveryRequest) => TerminalRecoveryBatchEntry,
): void {
  invokeMock.mockImplementation(async function (_channel: IPC, payload: RecoveryRequestPayload) {
    return payload.requests.map(function mapRecoveryRequest(request) {
      return createEntry(request);
    });
  });
}

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
        rows: 24,
      },
    ] satisfies TerminalRecoveryBatchEntry[]);

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
    mockSnapshotRecoveryBatch(function createInitialAttachRecoveryEntry(request) {
      return createSnapshotBatchEntry(request, {
        cols: request.agentId === 'agent-a' ? 81 : 99,
        data: request.agentId === 'agent-a' ? 'aaa' : 'bbb',
        outputCursor: request.agentId === 'agent-a' ? 7 : 9,
        rows: request.agentId === 'agent-a' ? 24 : 30,
      });
    });

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

  it('uses caller geometry for missing attach recovery batch entries', async () => {
    invokeMock.mockResolvedValue([]);

    const { requestAttachTerminalRecovery } = await import('./scrollbackRestore');

    const recovery = requestAttachTerminalRecovery('agent-missing', {
      fallbackCols: 132,
      fallbackRows: 44,
      outputCursor: 5,
    });

    await vi.advanceTimersByTimeAsync(20);

    await expect(recovery).resolves.toMatchObject({
      agentId: 'agent-missing',
      cols: 132,
      recovery: { kind: 'snapshot', data: null },
      rows: 44,
    });
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetTerminalRecoveryBatch, {
      requests: [
        {
          agentId: 'agent-missing',
          outputCursor: 5,
          renderedTail: null,
          requestId: expect.any(String),
          snapshotByteLimit: null,
        },
      ],
    });
  });

  it('batches reconnect restores into a single IPC round-trip', async () => {
    mockSnapshotRecoveryBatch(function createReconnectRecoveryEntry(request) {
      return createSnapshotBatchEntry(request, {
        cols: request.agentId === 'agent-a' ? 81 : 99,
        data: request.agentId === 'agent-a' ? 'aaa' : 'bbb',
        outputCursor: request.agentId === 'agent-a' ? 7 : 9,
        rows: request.agentId === 'agent-a' ? 24 : 30,
      });
    });

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
    mockSnapshotRecoveryBatch(function createStartupRecoveryEntry(request) {
      return createSnapshotBatchEntry(request, {
        cols: request.agentId === 'agent-selected' ? 101 : 88,
        data: request.agentId === 'agent-selected' ? 'aaa' : 'bbb',
        outputCursor: request.agentId === 'agent-selected' ? 17 : 9,
        rows: request.agentId === 'agent-selected' ? 24 : 30,
      });
    });

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
          visibleTerminalCount: 1,
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
          visibleTerminalCount: 1,
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
        rows: 24,
      },
    ] satisfies TerminalRecoveryBatchEntry[]);

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
          visibleTerminalCount: 1,
        },
      ],
    });
  });

  it('uses caller geometry for missing startup recovery batch entries', async () => {
    invokeMock.mockResolvedValue([]);

    const { requestStartupTerminalRecovery } = await import('./scrollbackRestore');

    await expect(
      requestStartupTerminalRecovery('agent-selected', 'selected', {
        fallbackCols: 120,
        fallbackRows: 34,
      }),
    ).resolves.toMatchObject({
      agentId: 'agent-selected',
      cols: 120,
      recovery: { kind: 'snapshot', data: null },
      rows: 34,
    });
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetTerminalStartupRecoveryBatch, {
      requests: [
        {
          agentId: 'agent-selected',
          requestId: expect.any(String),
          role: 'selected',
          visibleTerminalCount: 1,
        },
      ],
    });
  });

  it('passes caller visible startup terminal count for selected and visible sibling requests', async () => {
    mockSnapshotRecoveryBatch(createSnapshotBatchEntry);

    const { requestStartupTerminalRecovery } = await import('./scrollbackRestore');

    const selected = requestStartupTerminalRecovery('agent-selected', 'selected', {
      visibleTerminalCount: 4,
    });
    const visible = requestStartupTerminalRecovery('agent-visible', 'visible-sibling', {
      visibleTerminalCount: 4,
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
    await expect(selected).resolves.toMatchObject({ agentId: 'agent-selected' });
    await expect(visible).resolves.toMatchObject({ agentId: 'agent-visible' });

    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.GetTerminalStartupRecoveryBatch, {
      requests: [
        {
          agentId: 'agent-selected',
          requestId: expect.any(String),
          role: 'selected',
          visibleTerminalCount: 4,
        },
      ],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.GetTerminalStartupRecoveryBatch, {
      requests: [
        {
          agentId: 'agent-visible',
          requestId: expect.any(String),
          role: 'visible-sibling',
          visibleTerminalCount: 4,
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
        rows: 24,
      },
    ] satisfies TerminalRecoveryBatchEntry[]);

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
