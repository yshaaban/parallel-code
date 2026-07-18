import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';

const {
  getAgentColsMock,
  getAgentPauseStateMock,
  getAgentRowsMock,
  getAgentTerminalRecoveryMock,
  getAgentTerminalStartupRecoveryMock,
  hasAgentSessionMock,
  pauseAgentMock,
  resumeAgentMock,
  spawnTaskAgentWorkflowMock,
} = vi.hoisted(() => ({
  getAgentColsMock: vi.fn(),
  getAgentPauseStateMock: vi.fn(),
  getAgentRowsMock: vi.fn(),
  getAgentTerminalRecoveryMock: vi.fn(),
  getAgentTerminalStartupRecoveryMock: vi.fn(),
  hasAgentSessionMock: vi.fn(),
  pauseAgentMock: vi.fn(),
  resumeAgentMock: vi.fn(),
  spawnTaskAgentWorkflowMock: vi.fn(),
}));

vi.mock('./pty.js', async () => {
  const actual = await vi.importActual<typeof import('./pty.js')>('./pty.js');
  return {
    ...actual,
    getAgentCols: getAgentColsMock,
    getAgentPauseState: getAgentPauseStateMock,
    getAgentRows: getAgentRowsMock,
    getAgentTerminalRecovery: getAgentTerminalRecoveryMock,
    getAgentTerminalStartupRecovery: getAgentTerminalStartupRecoveryMock,
    hasAgentSession: hasAgentSessionMock,
    pauseAgent: pauseAgentMock,
    resumeAgent: resumeAgentMock,
  };
});

vi.mock('./task-workflows.js', async () => {
  const actual = await vi.importActual<typeof import('./task-workflows.js')>('./task-workflows.js');
  return {
    ...actual,
    spawnTaskAgentWorkflow: spawnTaskAgentWorkflowMock,
  };
});

import { releaseAllHeldTerminalRecoveryBatchPausesForTests } from './agent-handlers.js';
import { createIpcHandlers, type HandlerContext } from './handlers.js';

function buildContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    userDataPath: '/tmp/parallel-code-tests',
    isPackaged: false,
    sendToChannel: vi.fn(),
    ...overrides,
  };
}

function buildAttachRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: 'agent-1',
    args: [],
    clientId: 'client-1',
    cols: 100,
    command: '/bin/agent',
    cwd: '/tmp/worktree',
    env: {},
    initialRecovery: {
      outputCursor: null,
      role: null,
      snapshotByteLimit: 64 * 1024,
      visibleTerminalCount: 1,
    },
    onOutput: { __CHANNEL_ID__: 'channel-1' },
    rows: 40,
    taskId: 'task-1',
    ...overrides,
  };
}

describe('AttachTerminalSession', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.clearAllMocks();
    hasAgentSessionMock.mockReturnValue(true);
    getAgentPauseStateMock.mockReturnValue(null);
    getAgentColsMock.mockReturnValue(132);
    getAgentRowsMock.mockReturnValue(43);
    spawnTaskAgentWorkflowMock.mockReturnValue({
      channelAttached: true,
      kind: 'attached-existing',
    });
    getAgentTerminalRecoveryMock.mockReturnValue({
      cols: 132,
      kind: 'noop',
      outputCursor: 42,
      rows: 43,
    });
    getAgentTerminalStartupRecoveryMock.mockResolvedValue({
      cols: 132,
      data: Buffer.from('startup-state', 'utf8'),
      kind: 'terminal-state',
      outputCursor: 64,
      rows: 43,
    });
  });

  afterEach(() => {
    releaseAllHeldTerminalRecoveryBatchPausesForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('binds the channel for the requesting client before running the spawn workflow', async () => {
    const callOrder: string[] = [];
    const bindChannelForClient = vi.fn((clientId: string | null, channelId: string) => {
      callOrder.push(`bind:${clientId ?? 'null'}:${channelId}`);
      return true;
    });
    spawnTaskAgentWorkflowMock.mockImplementation(() => {
      callOrder.push('spawn');
      return { channelAttached: true, kind: 'attached-existing' };
    });
    const handlers = createIpcHandlers(buildContext({ bindChannelForClient }));

    const result = (await handlers[IPC.AttachTerminalSession]?.(buildAttachRequest())) as {
      attachedExistingSession: boolean;
      channelBound: boolean;
      recovery: { batchPauseId?: string; recovery: { kind: string } } | null;
    };

    expect(callOrder).toEqual(['bind:client-1:channel-1', 'spawn']);
    expect(result.channelBound).toBe(true);
    expect(result.attachedExistingSession).toBe(true);
  });

  it('reports channelBound true on Electron where channel binding is implicit', async () => {
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.AttachTerminalSession]?.(buildAttachRequest())) as {
      channelBound: boolean;
    };

    expect(result.channelBound).toBe(true);
  });

  it('never resizes an existing session: backend geometry wins over the optimistic request geometry', async () => {
    const handlers = createIpcHandlers(buildContext());

    await handlers[IPC.AttachTerminalSession]?.(buildAttachRequest({ cols: 100, rows: 40 }));

    expect(spawnTaskAgentWorkflowMock).toHaveBeenCalledTimes(1);
    expect(spawnTaskAgentWorkflowMock.mock.calls[0]?.[1]).toMatchObject({
      agentId: 'agent-1',
      cols: 132,
      rows: 43,
    });
  });

  it('returns same-tick recovery for an existing-session attach under a held batch pause', async () => {
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.AttachTerminalSession]?.(buildAttachRequest())) as {
      attachedExistingSession: boolean;
      recovery: { agentId: string; batchPauseId?: string; recovery: { kind: string } } | null;
    };

    expect(result.attachedExistingSession).toBe(true);
    expect(result.recovery).toMatchObject({
      agentId: 'agent-1',
      batchPauseId: expect.any(String),
      recovery: { kind: 'noop' },
    });
    expect(getAgentTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', null, null, 64 * 1024);
    expect(pauseAgentMock).toHaveBeenCalledTimes(1);
    expect(pauseAgentMock).toHaveBeenCalledWith('agent-1', 'restore');
    // The pause survives the response so live Data frames cannot race the
    // client apply; the release message (or the auto-resume timer) ends it.
    expect(resumeAgentMock).not.toHaveBeenCalled();

    await handlers[IPC.ReleaseTerminalRecoveryPause]?.({
      batchPauseId: result.recovery?.batchPauseId ?? '',
    });
    expect(resumeAgentMock).toHaveBeenCalledTimes(1);
    expect(resumeAgentMock).toHaveBeenCalledWith('agent-1', 'restore');
  });

  it('auto-resumes a held attach pause when the release message is lost', async () => {
    const handlers = createIpcHandlers(buildContext());

    await handlers[IPC.AttachTerminalSession]?.(buildAttachRequest());

    expect(resumeAgentMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(resumeAgentMock).toHaveBeenCalledTimes(1);
    expect(resumeAgentMock).toHaveBeenCalledWith('agent-1', 'restore');
  });

  it('uses the startup recovery helper with the requested role and visible count', async () => {
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.AttachTerminalSession]?.(
      buildAttachRequest({
        initialRecovery: {
          outputCursor: null,
          role: 'selected',
          snapshotByteLimit: 64 * 1024,
          visibleTerminalCount: 3,
        },
      }),
    )) as { recovery: { recovery: { kind: string } } | null };

    expect(getAgentTerminalStartupRecoveryMock).toHaveBeenCalledWith(
      'agent-1',
      null,
      null,
      'selected',
      3,
    );
    expect(getAgentTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(result.recovery?.recovery.kind).toBe('terminal-state');
  });

  it('returns recovery null for a fresh spawn without pausing', async () => {
    hasAgentSessionMock.mockReturnValue(false);
    spawnTaskAgentWorkflowMock.mockReturnValue({
      channelAttached: true,
      kind: 'created-session',
    });
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.AttachTerminalSession]?.(buildAttachRequest())) as {
      attachedExistingSession: boolean;
      recovery: unknown;
    };

    expect(result.attachedExistingSession).toBe(false);
    expect(result.recovery).toBeNull();
    expect(pauseAgentMock).not.toHaveBeenCalled();
    expect(getAgentTerminalRecoveryMock).not.toHaveBeenCalled();
    // Fresh spawns use the requested optimistic geometry.
    expect(spawnTaskAgentWorkflowMock.mock.calls[0]?.[1]).toMatchObject({
      cols: 100,
      rows: 40,
    });
  });

  it('reports channelBound false when the client has no live control connection', async () => {
    const bindChannelForClient = vi.fn(() => false);
    const handlers = createIpcHandlers(buildContext({ bindChannelForClient }));

    const result = (await handlers[IPC.AttachTerminalSession]?.(buildAttachRequest())) as {
      channelBound: boolean;
    };

    expect(result.channelBound).toBe(false);
  });

  it('resolves a tail-needed initial capture to a capped snapshot in the same response', async () => {
    getAgentTerminalRecoveryMock
      .mockReturnValueOnce({
        cols: 132,
        kind: 'tail-needed',
        outputCursor: 4096,
        rows: 43,
      })
      .mockReturnValueOnce({
        cols: 132,
        data: Buffer.from('capped-snapshot', 'utf8'),
        kind: 'snapshot',
        outputCursor: 4096,
        rows: 43,
      });
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.AttachTerminalSession]?.(
      buildAttachRequest({
        initialRecovery: {
          outputCursor: 12,
          role: null,
          snapshotByteLimit: 64 * 1024,
          visibleTerminalCount: 1,
        },
      }),
    )) as { recovery: { recovery: { kind: string } } | null };

    // A fresh attach has no rendered tail for a phase-two request, so the
    // handler re-derives the capped snapshot inside the same round trip.
    expect(result.recovery?.recovery.kind).toBe('snapshot');
    expect(getAgentTerminalRecoveryMock).toHaveBeenNthCalledWith(1, 'agent-1', null, 12, 64 * 1024);
    expect(getAgentTerminalRecoveryMock).toHaveBeenNthCalledWith(
      2,
      'agent-1',
      null,
      null,
      64 * 1024,
    );
  });

  it('caps a fresh-mount cursor-0 delta at the attach snapshot byte budget', async () => {
    getAgentTerminalRecoveryMock
      .mockReturnValueOnce({
        cols: 132,
        data: Buffer.alloc(128 * 1024, 120),
        kind: 'delta',
        outputCursor: 128 * 1024,
        overlapBytes: 0,
        rows: 43,
        source: 'cursor',
      })
      .mockReturnValueOnce({
        cols: 132,
        data: Buffer.alloc(64 * 1024, 120),
        kind: 'snapshot',
        outputCursor: 128 * 1024,
        rows: 43,
      });
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.AttachTerminalSession]?.(
      buildAttachRequest({
        initialRecovery: {
          outputCursor: 0,
          role: null,
          snapshotByteLimit: 64 * 1024,
          visibleTerminalCount: 1,
        },
      }),
    )) as { recovery: { recovery: { kind: string } } | null };

    // A cursor-0 delta has no rendered history to preserve: it is a
    // full-state transfer in disguise, so the byte budget applies and the
    // handler resolves it to the capped snapshot inside the same round trip.
    expect(result.recovery?.recovery.kind).toBe('snapshot');
    expect(getAgentTerminalRecoveryMock).toHaveBeenNthCalledWith(1, 'agent-1', null, 0, 64 * 1024);
    expect(getAgentTerminalRecoveryMock).toHaveBeenNthCalledWith(
      2,
      'agent-1',
      null,
      null,
      64 * 1024,
    );
  });

  it('keeps a fresh-mount cursor-0 delta inline when it fits the snapshot byte budget', async () => {
    getAgentTerminalRecoveryMock.mockReturnValue({
      cols: 132,
      data: Buffer.alloc(16 * 1024, 120),
      kind: 'delta',
      outputCursor: 16 * 1024,
      overlapBytes: 0,
      rows: 43,
      source: 'cursor',
    });
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.AttachTerminalSession]?.(
      buildAttachRequest({
        initialRecovery: {
          outputCursor: 0,
          role: null,
          snapshotByteLimit: 64 * 1024,
          visibleTerminalCount: 1,
        },
      }),
    )) as { recovery: { recovery: { kind: string } } | null };

    // Reload reattach stays on the non-destructive delta path when the
    // replay fits the budget (no term.reset, no blocking restore UI).
    expect(result.recovery?.recovery.kind).toBe('delta');
    expect(getAgentTerminalRecoveryMock).toHaveBeenCalledTimes(1);
  });

  it('does not cap a continuity cursor delta that exceeds the snapshot byte budget', async () => {
    getAgentTerminalRecoveryMock.mockReturnValue({
      cols: 132,
      data: Buffer.alloc(128 * 1024, 120),
      kind: 'delta',
      outputCursor: 256 * 1024,
      overlapBytes: 0,
      rows: 43,
      source: 'cursor',
    });
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.AttachTerminalSession]?.(
      buildAttachRequest({
        initialRecovery: {
          outputCursor: 128 * 1024,
          role: null,
          snapshotByteLimit: 64 * 1024,
          visibleTerminalCount: 1,
        },
      }),
    )) as { recovery: { recovery: { kind: string } } | null };

    // A non-zero cursor claim is real rendered continuity; truncating it to
    // a snapshot would destroy renderer history, so the delta stays uncapped.
    expect(result.recovery?.recovery.kind).toBe('delta');
    expect(getAgentTerminalRecoveryMock).toHaveBeenCalledTimes(1);
  });

  it('releases a held pause when capturing the recovery entry fails', async () => {
    getAgentTerminalRecoveryMock.mockImplementation(() => {
      throw new Error('capture failed');
    });
    const handlers = createIpcHandlers(buildContext());

    await expect(handlers[IPC.AttachTerminalSession]?.(buildAttachRequest())).rejects.toThrow(
      'capture failed',
    );

    expect(pauseAgentMock).toHaveBeenCalledTimes(1);
    expect(resumeAgentMock).toHaveBeenCalledTimes(1);
  });
});
