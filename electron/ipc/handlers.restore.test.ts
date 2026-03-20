import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from './runtime-diagnostics.js';

const {
  pauseAgentMock,
  resumeAgentMock,
  getAgentPauseStateMock,
  getAgentScrollbackMock,
  getAgentColsMock,
  getAgentTerminalRecoveryMock,
} = vi.hoisted(() => ({
  pauseAgentMock: vi.fn(),
  resumeAgentMock: vi.fn(),
  getAgentPauseStateMock: vi.fn(),
  getAgentScrollbackMock: vi.fn(),
  getAgentColsMock: vi.fn(),
  getAgentTerminalRecoveryMock: vi.fn(),
}));

vi.mock('./pty.js', async () => {
  const actual = await vi.importActual<typeof import('./pty.js')>('./pty.js');
  return {
    ...actual,
    pauseAgent: pauseAgentMock,
    resumeAgent: resumeAgentMock,
    getAgentPauseState: getAgentPauseStateMock,
    getAgentScrollback: getAgentScrollbackMock,
    getAgentCols: getAgentColsMock,
    getAgentTerminalRecovery: getAgentTerminalRecoveryMock,
  };
});

import { createIpcHandlers, type HandlerContext } from './handlers.js';

function buildContext(): HandlerContext {
  return {
    userDataPath: '/tmp/parallel-code-tests',
    isPackaged: false,
    sendToChannel: vi.fn(),
  };
}

describe('GetScrollbackBatch', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-16T00:00:00Z'));
    vi.clearAllMocks();
    resetBackendRuntimeDiagnostics();
    getAgentPauseStateMock.mockReturnValue(null);
    getAgentScrollbackMock.mockImplementation((agentId: string) =>
      Buffer.from(`scrollback:${agentId}`, 'utf8').toString('base64'),
    );
    getAgentColsMock.mockReturnValue(80);
    getAgentTerminalRecoveryMock.mockImplementation((agentId: string) => ({
      cols: 80,
      data: Buffer.from(`scrollback:${agentId}`, 'utf8'),
      kind: 'snapshot',
    }));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('pauses each agent once and always resumes after returning the batch', async () => {
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.GetScrollbackBatch]?.({
      agentIds: ['agent-a', 'agent-a', 'agent-b'],
    })) as Array<{ agentId: string; scrollback: string | null; cols: number }>;

    expect(result).toEqual([
      {
        agentId: 'agent-a',
        scrollback: Buffer.from('scrollback:agent-a', 'utf8').toString('base64'),
        cols: 80,
      },
      {
        agentId: 'agent-b',
        scrollback: Buffer.from('scrollback:agent-b', 'utf8').toString('base64'),
        cols: 80,
      },
    ]);
    expect(pauseAgentMock).toHaveBeenCalledTimes(2);
    expect(pauseAgentMock).toHaveBeenNthCalledWith(1, 'agent-a', 'restore');
    expect(pauseAgentMock).toHaveBeenNthCalledWith(2, 'agent-b', 'restore');
    expect(resumeAgentMock).toHaveBeenCalledTimes(2);
    expect(resumeAgentMock).toHaveBeenNthCalledWith(1, 'agent-b', 'restore');
    expect(resumeAgentMock).toHaveBeenNthCalledWith(2, 'agent-a', 'restore');
    expect(getBackendRuntimeDiagnosticsSnapshot().scrollbackReplay).toMatchObject({
      batchRequests: 1,
      requestedAgents: 2,
      returnedBytes:
        Buffer.byteLength('scrollback:agent-a', 'utf8') +
        Buffer.byteLength('scrollback:agent-b', 'utf8'),
    });
  });

  it('dedupes concurrent identical scrollback batch requests', async () => {
    const handlers = createIpcHandlers(buildContext());
    const firstAgentId = 'dedupe-agent-a';
    const secondAgentId = 'dedupe-agent-b';

    const first = handlers[IPC.GetScrollbackBatch]?.({
      agentIds: [firstAgentId, secondAgentId],
    }) as Promise<Array<{ agentId: string; scrollback: string | null; cols: number }>>;
    const second = handlers[IPC.GetScrollbackBatch]?.({
      agentIds: [secondAgentId, firstAgentId],
    }) as Promise<Array<{ agentId: string; scrollback: string | null; cols: number }>>;

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual([
      {
        agentId: firstAgentId,
        scrollback: Buffer.from(`scrollback:${firstAgentId}`, 'utf8').toString('base64'),
        cols: 80,
      },
      {
        agentId: secondAgentId,
        scrollback: Buffer.from(`scrollback:${secondAgentId}`, 'utf8').toString('base64'),
        cols: 80,
      },
    ]);
    expect(secondResult).toEqual([
      {
        agentId: secondAgentId,
        scrollback: Buffer.from(`scrollback:${secondAgentId}`, 'utf8').toString('base64'),
        cols: 80,
      },
      {
        agentId: firstAgentId,
        scrollback: Buffer.from(`scrollback:${firstAgentId}`, 'utf8').toString('base64'),
        cols: 80,
      },
    ]);
    expect(pauseAgentMock).toHaveBeenCalledTimes(2);
    expect(resumeAgentMock).toHaveBeenCalledTimes(2);
    expect(getBackendRuntimeDiagnosticsSnapshot().scrollbackReplay).toMatchObject({
      batchRequests: 1,
      cacheHits: 1,
      cacheMisses: 1,
      requestedAgents: 2,
    });
  });

  it('reuses a recent identical scrollback batch inside the short cache window', async () => {
    const handlers = createIpcHandlers(buildContext());
    const firstAgentId = 'ttl-agent-a';
    const secondAgentId = 'ttl-agent-b';

    const first = (await handlers[IPC.GetScrollbackBatch]?.({
      agentIds: [firstAgentId, secondAgentId],
    })) as Array<{ agentId: string; scrollback: string | null; cols: number }>;
    const second = (await handlers[IPC.GetScrollbackBatch]?.({
      agentIds: [secondAgentId, firstAgentId],
    })) as Array<{ agentId: string; scrollback: string | null; cols: number }>;

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(pauseAgentMock).toHaveBeenCalledTimes(2);
    expect(resumeAgentMock).toHaveBeenCalledTimes(2);
    expect(getBackendRuntimeDiagnosticsSnapshot().scrollbackReplay).toMatchObject({
      batchRequests: 1,
      cacheHits: 1,
      cacheMisses: 1,
      requestedAgents: 2,
    });

    await vi.advanceTimersByTimeAsync(210);
    await handlers[IPC.GetScrollbackBatch]?.({
      agentIds: [firstAgentId, secondAgentId],
    });

    expect(pauseAgentMock).toHaveBeenCalledTimes(4);
    expect(resumeAgentMock).toHaveBeenCalledTimes(4);
    expect(getBackendRuntimeDiagnosticsSnapshot().scrollbackReplay).toMatchObject({
      batchRequests: 2,
      cacheHits: 1,
      cacheMisses: 2,
      requestedAgents: 4,
    });
  });
});

describe('GetTerminalRecoveryBatch', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetBackendRuntimeDiagnostics();
    getAgentTerminalRecoveryMock.mockImplementation(
      (agentId: string, renderedTail: Buffer | null, outputCursor: number | null) => {
        const renderedText = renderedTail?.toString('utf8') ?? '';
        if (agentId === 'agent-noop') {
          return {
            cols: 91,
            kind: 'noop',
            outputCursor: outputCursor ?? 14,
          };
        }

        if (agentId === 'agent-delta') {
          expect(renderedText).toBe('rendered-tail');
          expect(outputCursor).toBe(12);
          return {
            cols: 92,
            data: Buffer.from('delta-bytes', 'utf8'),
            kind: 'delta',
            overlapBytes: renderedText.length,
            outputCursor: 23,
            source: 'cursor',
          };
        }

        return {
          cols: 93,
          data: Buffer.from('snapshot-bytes', 'utf8'),
          kind: 'snapshot',
          outputCursor: 37,
        };
      },
    );
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('returns structured noop, delta, and snapshot recovery entries in request order', async () => {
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.GetTerminalRecoveryBatch]?.({
      requests: [
        {
          agentId: 'agent-noop',
          outputCursor: 14,
          renderedTail: null,
          requestId: 'req-noop',
        },
        {
          agentId: 'agent-delta',
          outputCursor: 12,
          renderedTail: Buffer.from('rendered-tail', 'utf8').toString('base64'),
          requestId: 'req-delta',
        },
        {
          agentId: 'agent-snapshot',
          outputCursor: null,
          renderedTail: null,
          requestId: 'req-snapshot',
        },
      ],
    })) as Array<{
      agentId: string;
      cols: number;
      recovery: { kind: string; data?: string | null; overlapBytes?: number };
      requestId: string;
    }>;

    expect(result).toEqual([
      {
        agentId: 'agent-noop',
        cols: 91,
        outputCursor: 14,
        recovery: {
          kind: 'noop',
        },
        requestId: 'req-noop',
      },
      {
        agentId: 'agent-delta',
        cols: 92,
        outputCursor: 23,
        recovery: {
          kind: 'delta',
          data: Buffer.from('delta-bytes', 'utf8').toString('base64'),
          overlapBytes: 'rendered-tail'.length,
          source: 'cursor',
        },
        requestId: 'req-delta',
      },
      {
        agentId: 'agent-snapshot',
        cols: 93,
        outputCursor: 37,
        recovery: {
          kind: 'snapshot',
          data: Buffer.from('snapshot-bytes', 'utf8').toString('base64'),
        },
        requestId: 'req-snapshot',
      },
    ]);
    expect(pauseAgentMock).toHaveBeenCalledTimes(3);
    expect(resumeAgentMock).toHaveBeenCalledTimes(3);
    expect(getBackendRuntimeDiagnosticsSnapshot().terminalRecovery).toEqual({
      cursorDeltaResponses: 1,
      deltaResponses: 1,
      lastDurationMs: expect.any(Number),
      maxDurationMs: expect.any(Number),
      noopResponses: 1,
      requests: 3,
      returnedBytes:
        Buffer.byteLength('delta-bytes', 'utf8') + Buffer.byteLength('snapshot-bytes', 'utf8'),
      snapshotResponses: 1,
      tailDeltaResponses: 0,
    });
    expect(getBackendRuntimeDiagnosticsSnapshot().scrollbackReplay).toMatchObject({
      batchRequests: 0,
      requestedAgents: 0,
      returnedBytes: 0,
    });
  });

  it('skips redundant backend pause and resume when recovery callers already hold the pause', async () => {
    getAgentPauseStateMock.mockReturnValue('restore');
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.GetTerminalRecoveryBatch]?.({
      requests: [
        {
          agentId: 'agent-snapshot',
          outputCursor: null,
          renderedTail: null,
          requestId: 'req-snapshot',
        },
      ],
    })) as Array<{
      agentId: string;
      cols: number;
      outputCursor: number;
      recovery: { kind: string; data?: string | null };
      requestId: string;
    }>;

    expect(result).toEqual([
      {
        agentId: 'agent-snapshot',
        cols: 93,
        outputCursor: 37,
        recovery: {
          kind: 'snapshot',
          data: Buffer.from('snapshot-bytes', 'utf8').toString('base64'),
        },
        requestId: 'req-snapshot',
      },
    ]);
    expect(pauseAgentMock).not.toHaveBeenCalled();
    expect(resumeAgentMock).not.toHaveBeenCalled();
    expect(getAgentTerminalRecoveryMock).toHaveBeenCalledWith('agent-snapshot', null, null);
  });
});
