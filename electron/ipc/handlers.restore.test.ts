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
  getAgentTerminalStartupRecoveryMock,
  hasAgentSessionMock,
} = vi.hoisted(() => ({
  pauseAgentMock: vi.fn(),
  resumeAgentMock: vi.fn(),
  getAgentPauseStateMock: vi.fn(),
  getAgentScrollbackMock: vi.fn(),
  getAgentColsMock: vi.fn(),
  getAgentTerminalRecoveryMock: vi.fn(),
  getAgentTerminalStartupRecoveryMock: vi.fn(),
  hasAgentSessionMock: vi.fn(),
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
    getAgentTerminalStartupRecovery: getAgentTerminalStartupRecoveryMock,
    hasAgentSession: hasAgentSessionMock,
  };
});

import { createIpcHandlers, type HandlerContext } from './handlers.js';

function buildContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    userDataPath: '/tmp/parallel-code-tests',
    isPackaged: false,
    sendToChannel: vi.fn(),
    ...overrides,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe('PauseAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores restore pauses for inactive browser channels', async () => {
    const handlers = createIpcHandlers(
      buildContext({
        isChannelActive: (channelId) => channelId === 'active-channel',
      }),
    );

    await handlers[IPC.PauseAgent]?.({
      agentId: 'agent-inactive-channel',
      channelId: 'inactive-channel',
      reason: 'restore',
    });

    expect(pauseAgentMock).not.toHaveBeenCalled();
  });

  it('keeps restore pauses for active browser channels', async () => {
    const handlers = createIpcHandlers(
      buildContext({
        isChannelActive: (channelId) => channelId === 'active-channel',
      }),
    );

    await handlers[IPC.PauseAgent]?.({
      agentId: 'agent-active-channel',
      channelId: 'active-channel',
      reason: 'restore',
    });

    expect(pauseAgentMock).toHaveBeenCalledWith(
      'agent-active-channel',
      'restore',
      'active-channel',
      undefined,
    );
  });

  it('passes restore lease ids for active browser channel restores', async () => {
    const handlers = createIpcHandlers(
      buildContext({
        isChannelActive: (channelId) => channelId === 'active-channel',
      }),
    );

    await handlers[IPC.PauseAgent]?.({
      agentId: 'agent-active-channel',
      channelId: 'active-channel',
      reason: 'restore',
      restoreLeaseId: 'restore-lease-1',
    });

    expect(pauseAgentMock).toHaveBeenCalledWith(
      'agent-active-channel',
      'restore',
      'active-channel',
      'restore-lease-1',
    );
  });

  it('keeps non-channel restore pauses without browser liveness checks', async () => {
    const handlers = createIpcHandlers(
      buildContext({
        isChannelActive: vi.fn(() => false),
      }),
    );

    await handlers[IPC.PauseAgent]?.({
      agentId: 'agent-global-restore',
      reason: 'restore',
    });

    expect(pauseAgentMock).toHaveBeenCalledWith(
      'agent-global-restore',
      'restore',
      undefined,
      undefined,
    );
  });

  it('rejects restore lease ids outside restore pauses', async () => {
    const handlers = createIpcHandlers(buildContext());

    expect(() =>
      handlers[IPC.PauseAgent]?.({
        agentId: 'agent-invalid-restore-lease',
        reason: 'flow-control',
        restoreLeaseId: 'restore-lease-1',
      }),
    ).toThrow('restoreLeaseId is only valid for restore pauses');
    expect(() =>
      handlers[IPC.ResumeAgent]?.({
        agentId: 'agent-empty-restore-lease',
        reason: 'restore',
        restoreLeaseId: '',
      }),
    ).toThrow('restoreLeaseId must be non-empty');

    expect(pauseAgentMock).not.toHaveBeenCalled();
    expect(resumeAgentMock).not.toHaveBeenCalled();
  });
});

describe('GetScrollbackBatch', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-16T00:00:00Z'));
    vi.clearAllMocks();
    resetBackendRuntimeDiagnostics();
    getAgentPauseStateMock.mockReturnValue(null);
    hasAgentSessionMock.mockReturnValue(true);
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

  it('does not pause missing agents before returning scrollback batch entries', async () => {
    hasAgentSessionMock.mockImplementation((agentId: string) => agentId === 'agent-live');
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.GetScrollbackBatch]?.({
      agentIds: ['agent-live', 'agent-missing'],
    })) as Array<{ agentId: string; scrollback: string | null; cols: number }>;

    expect(result.map((entry) => entry.agentId)).toEqual(['agent-live', 'agent-missing']);
    expect(pauseAgentMock).toHaveBeenCalledTimes(1);
    expect(pauseAgentMock).toHaveBeenCalledWith('agent-live', 'restore');
    expect(resumeAgentMock).toHaveBeenCalledTimes(1);
    expect(resumeAgentMock).toHaveBeenCalledWith('agent-live', 'restore');
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
    getAgentPauseStateMock.mockReturnValue(null);
    hasAgentSessionMock.mockReturnValue(true);
    getAgentTerminalRecoveryMock.mockImplementation(
      (
        agentId: string,
        renderedTail: Buffer | null,
        outputCursor: number | null,
        _snapshotByteLimit: number | null,
      ) => {
        const renderedText = renderedTail?.toString('utf8') ?? '';
        if (agentId === 'agent-noop') {
          return {
            cols: 91,
            kind: 'noop',
            outputCursor: outputCursor ?? 14,
            rows: 21,
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
            rows: 22,
            source: 'cursor',
          };
        }

        return {
          cols: 93,
          data: Buffer.from('snapshot-bytes', 'utf8'),
          kind: 'snapshot',
          outputCursor: 37,
          rows: 23,
        };
      },
    );
    getAgentTerminalStartupRecoveryMock.mockImplementation(
      (
        agentId: string,
        renderedTail: Buffer | null,
        outputCursor: number | null,
        _role: 'selected' | 'visible-sibling',
        _visibleTerminalCount: number,
      ) => {
        expect(renderedTail).toBeNull();
        expect(outputCursor).toBeNull();
        if (agentId === 'agent-selected') {
          return {
            cols: 120,
            data: Buffer.from('selected-startup', 'utf8'),
            kind: 'terminal-state',
            outputCursor: 48,
            rows: 32,
          };
        }

        return {
          cols: 96,
          data: Buffer.from('visible-startup', 'utf8'),
          kind: 'terminal-state',
          outputCursor: 25,
          rows: 28,
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
          snapshotByteLimit: null,
        },
        {
          agentId: 'agent-delta',
          outputCursor: 12,
          renderedTail: Buffer.from('rendered-tail', 'utf8').toString('base64'),
          requestId: 'req-delta',
          snapshotByteLimit: null,
        },
        {
          agentId: 'agent-snapshot',
          outputCursor: null,
          renderedTail: null,
          requestId: 'req-snapshot',
          snapshotByteLimit: null,
        },
      ],
    })) as Array<{
      agentId: string;
      cols: number;
      recovery: { kind: string; data?: string | null; overlapBytes?: number };
      requestId: string;
      rows: number;
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
        rows: 21,
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
        rows: 22,
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
        rows: 23,
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
      terminalStateFallbacks: 0,
      terminalStateResponses: 0,
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
          snapshotByteLimit: null,
        },
      ],
    })) as Array<{
      agentId: string;
      cols: number;
      outputCursor: number;
      recovery: { kind: string; data?: string | null };
      requestId: string;
      rows: number;
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
        rows: 23,
      },
    ]);
    expect(pauseAgentMock).not.toHaveBeenCalled();
    expect(resumeAgentMock).not.toHaveBeenCalled();
    expect(getAgentTerminalRecoveryMock).toHaveBeenCalledWith('agent-snapshot', null, null, null);
  });

  it('passes snapshot byte limits through to terminal recovery requests', async () => {
    const handlers = createIpcHandlers(buildContext());

    await handlers[IPC.GetTerminalRecoveryBatch]?.({
      requests: [
        {
          agentId: 'agent-snapshot',
          outputCursor: null,
          renderedTail: null,
          requestId: 'req-snapshot',
          snapshotByteLimit: 4096,
        },
      ],
    });

    expect(getAgentTerminalRecoveryMock).toHaveBeenCalledWith('agent-snapshot', null, null, 4096);
  });

  it('does not pause missing agents before returning terminal recovery entries', async () => {
    hasAgentSessionMock.mockImplementation((agentId: string) => agentId === 'agent-noop');
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.GetTerminalRecoveryBatch]?.({
      requests: [
        {
          agentId: 'agent-noop',
          outputCursor: 14,
          renderedTail: null,
          requestId: 'req-live',
          snapshotByteLimit: null,
        },
        {
          agentId: 'agent-snapshot',
          outputCursor: null,
          renderedTail: null,
          requestId: 'req-missing',
          snapshotByteLimit: null,
        },
      ],
    })) as Array<{ agentId: string; requestId: string }>;

    expect(result.map((entry) => entry.requestId)).toEqual(['req-live', 'req-missing']);
    expect(pauseAgentMock).toHaveBeenCalledTimes(1);
    expect(pauseAgentMock).toHaveBeenCalledWith('agent-noop', 'restore');
    expect(resumeAgentMock).toHaveBeenCalledTimes(1);
    expect(resumeAgentMock).toHaveBeenCalledWith('agent-noop', 'restore');
  });

  it('rejects malformed rendered tail base64 before decoding recovery requests', async () => {
    const handlers = createIpcHandlers(buildContext());

    for (const renderedTail of ['not-valid-base64!', 'AB==']) {
      await expect(
        handlers[IPC.GetTerminalRecoveryBatch]?.({
          requests: [
            {
              agentId: 'agent-snapshot',
              outputCursor: null,
              renderedTail,
              requestId: 'req-invalid-tail',
              snapshotByteLimit: null,
            },
          ],
        }),
      ).rejects.toThrow('requests[0].renderedTail must be valid base64');
    }

    expect(getAgentTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(pauseAgentMock).not.toHaveBeenCalled();
    expect(resumeAgentMock).not.toHaveBeenCalled();

    getAgentTerminalRecoveryMock.mockReturnValueOnce({
      cols: 80,
      data: Buffer.from('snapshot', 'utf8'),
      kind: 'snapshot',
      outputCursor: 8,
      rows: 24,
    });
    await expect(
      handlers[IPC.GetTerminalRecoveryBatch]?.({
        requests: [
          {
            agentId: 'agent-snapshot',
            outputCursor: null,
            renderedTail: 'AA==',
            requestId: 'req-valid-tail',
            snapshotByteLimit: null,
          },
        ],
      }),
    ).resolves.toBeDefined();

    expect(getAgentTerminalRecoveryMock).toHaveBeenCalledTimes(1);
  });

  it('supports legacy startup recovery entries with batch-length visible count fallback', async () => {
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.GetTerminalStartupRecoveryBatch]?.({
      requests: [
        {
          agentId: 'agent-selected',
          requestId: 'req-selected',
          role: 'selected',
        },
        {
          agentId: 'agent-visible',
          requestId: 'req-visible',
          role: 'visible-sibling',
        },
      ],
    })) as Array<{
      agentId: string;
      cols: number;
      outputCursor: number;
      recovery: { kind: string; data?: string | null; overlapBytes?: number; source?: string };
      requestId: string;
      rows: number;
    }>;

    expect(result).toEqual([
      {
        agentId: 'agent-selected',
        cols: 120,
        outputCursor: 48,
        recovery: {
          kind: 'terminal-state',
          data: Buffer.from('selected-startup', 'utf8').toString('base64'),
        },
        requestId: 'req-selected',
        rows: 32,
      },
      {
        agentId: 'agent-visible',
        cols: 96,
        outputCursor: 25,
        recovery: {
          kind: 'terminal-state',
          data: Buffer.from('visible-startup', 'utf8').toString('base64'),
        },
        requestId: 'req-visible',
        rows: 28,
      },
    ]);
    expect(getAgentTerminalStartupRecoveryMock).toHaveBeenCalledWith(
      'agent-selected',
      null,
      null,
      'selected',
      2,
    );
    expect(getAgentTerminalStartupRecoveryMock).toHaveBeenCalledWith(
      'agent-visible',
      null,
      null,
      'visible-sibling',
      2,
    );
    expect(getBackendRuntimeDiagnosticsSnapshot().terminalRecovery).toMatchObject({
      snapshotResponses: 0,
      terminalStateResponses: 2,
    });
  });

  it('uses explicit total visible startup terminal count from requests', async () => {
    const handlers = createIpcHandlers(buildContext());

    await handlers[IPC.GetTerminalStartupRecoveryBatch]?.({
      requests: [
        {
          agentId: 'agent-selected',
          requestId: 'req-selected',
          role: 'selected',
          visibleTerminalCount: 4,
        },
        {
          agentId: 'agent-visible',
          requestId: 'req-visible',
          role: 'visible-sibling',
          visibleTerminalCount: 4,
        },
      ],
    });

    expect(getAgentTerminalStartupRecoveryMock).toHaveBeenCalledWith(
      'agent-selected',
      null,
      null,
      'selected',
      4,
    );
    expect(getAgentTerminalStartupRecoveryMock).toHaveBeenCalledWith(
      'agent-visible',
      null,
      null,
      'visible-sibling',
      4,
    );
  });

  it('releases each startup recovery pause before fetching the next agent group', async () => {
    const selectedRecovery = createDeferred<{
      cols: number;
      data: Buffer;
      kind: 'terminal-state';
      outputCursor: number;
      rows: number;
    }>();
    const visibleRecovery = createDeferred<{
      cols: number;
      data: Buffer;
      kind: 'terminal-state';
      outputCursor: number;
      rows: number;
    }>();
    getAgentTerminalStartupRecoveryMock.mockImplementation((agentId: string) => {
      if (agentId === 'agent-selected') {
        return selectedRecovery.promise;
      }

      return visibleRecovery.promise;
    });
    const handlers = createIpcHandlers(buildContext());

    const batchPromise = handlers[IPC.GetTerminalStartupRecoveryBatch]?.({
      requests: [
        {
          agentId: 'agent-selected',
          requestId: 'req-selected',
          role: 'selected',
          visibleTerminalCount: 2,
        },
        {
          agentId: 'agent-visible',
          requestId: 'req-visible',
          role: 'visible-sibling',
          visibleTerminalCount: 2,
        },
      ],
    }) as Promise<Array<{ agentId: string; requestId: string }>>;

    await flushMicrotasks();
    expect(pauseAgentMock).toHaveBeenCalledTimes(1);
    expect(pauseAgentMock).toHaveBeenCalledWith('agent-selected', 'restore');

    selectedRecovery.resolve({
      cols: 120,
      data: Buffer.from('selected-startup', 'utf8'),
      kind: 'terminal-state',
      outputCursor: 48,
      rows: 32,
    });
    await flushMicrotasks();

    expect(pauseAgentMock).toHaveBeenCalledTimes(2);
    expect(pauseAgentMock).toHaveBeenNthCalledWith(2, 'agent-visible', 'restore');
    expect(resumeAgentMock).toHaveBeenCalledWith('agent-selected', 'restore');
    expect(resumeAgentMock.mock.invocationCallOrder[0]).toBeLessThan(
      pauseAgentMock.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );

    visibleRecovery.resolve({
      cols: 96,
      data: Buffer.from('visible-startup', 'utf8'),
      kind: 'terminal-state',
      outputCursor: 25,
      rows: 28,
    });

    await expect(batchPromise).resolves.toEqual([
      expect.objectContaining({ agentId: 'agent-selected', requestId: 'req-selected' }),
      expect.objectContaining({ agentId: 'agent-visible', requestId: 'req-visible' }),
    ]);
    expect(resumeAgentMock).toHaveBeenCalledWith('agent-visible', 'restore');
  });

  it('does not pause missing agents before returning terminal startup recovery entries', async () => {
    hasAgentSessionMock.mockImplementation((agentId: string) => agentId === 'agent-selected');
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.GetTerminalStartupRecoveryBatch]?.({
      requests: [
        {
          agentId: 'agent-selected',
          requestId: 'req-live',
          role: 'selected',
          visibleTerminalCount: 2,
        },
        {
          agentId: 'agent-visible',
          requestId: 'req-missing',
          role: 'visible-sibling',
          visibleTerminalCount: 2,
        },
      ],
    })) as Array<{ agentId: string; requestId: string }>;

    expect(result.map((entry) => entry.requestId)).toEqual(['req-live', 'req-missing']);
    expect(pauseAgentMock).toHaveBeenCalledTimes(1);
    expect(pauseAgentMock).toHaveBeenCalledWith('agent-selected', 'restore');
    expect(resumeAgentMock).toHaveBeenCalledTimes(1);
    expect(resumeAgentMock).toHaveBeenCalledWith('agent-selected', 'restore');
  });

  it('rejects non-positive explicit visible startup terminal counts', async () => {
    const handlers = createIpcHandlers(buildContext());

    await expect(
      handlers[IPC.GetTerminalStartupRecoveryBatch]?.({
        requests: [
          {
            agentId: 'agent-selected',
            requestId: 'req-selected',
            role: 'selected',
            visibleTerminalCount: 0,
          },
        ],
      }),
    ).rejects.toThrow('requests[0].visibleTerminalCount must be a positive integer');

    expect(getAgentTerminalStartupRecoveryMock).not.toHaveBeenCalled();
    expect(pauseAgentMock).not.toHaveBeenCalled();
  });
});
