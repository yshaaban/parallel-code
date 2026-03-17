import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from './runtime-diagnostics.js';

const { pauseAgentMock, resumeAgentMock, getAgentScrollbackMock, getAgentColsMock } = vi.hoisted(
  () => ({
    pauseAgentMock: vi.fn(),
    resumeAgentMock: vi.fn(),
    getAgentScrollbackMock: vi.fn(),
    getAgentColsMock: vi.fn(),
  }),
);

vi.mock('./pty.js', async () => {
  const actual = await vi.importActual<typeof import('./pty.js')>('./pty.js');
  return {
    ...actual,
    pauseAgent: pauseAgentMock,
    resumeAgent: resumeAgentMock,
    getAgentScrollback: getAgentScrollbackMock,
    getAgentCols: getAgentColsMock,
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
    getAgentScrollbackMock.mockImplementation((agentId: string) =>
      Buffer.from(`scrollback:${agentId}`, 'utf8').toString('base64'),
    );
    getAgentColsMock.mockReturnValue(80);
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
