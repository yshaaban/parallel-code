import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';

const {
  attachExistingAgentSessionExactMock,
  getAgentColsMock,
  getAgentPauseStateMock,
  getAgentRowsMock,
  getAgentLifecycleGenerationMock,
  getAgentMetaMock,
  getAgentTerminalRecoveryMock,
  getAgentTerminalStartupRecoveryMock,
  hasAgentSessionMock,
  pauseAgentMock,
  resizeAgentMock,
  resumeAgentMock,
  spawnTaskAgentWorkflowMock,
} = vi.hoisted(() => ({
  attachExistingAgentSessionExactMock: vi.fn(),
  getAgentColsMock: vi.fn(),
  getAgentPauseStateMock: vi.fn(),
  getAgentRowsMock: vi.fn(),
  getAgentLifecycleGenerationMock: vi.fn(),
  getAgentMetaMock: vi.fn(),
  getAgentTerminalRecoveryMock: vi.fn(),
  getAgentTerminalStartupRecoveryMock: vi.fn(),
  hasAgentSessionMock: vi.fn(),
  pauseAgentMock: vi.fn(),
  resizeAgentMock: vi.fn(),
  resumeAgentMock: vi.fn(),
  spawnTaskAgentWorkflowMock: vi.fn(),
}));

vi.mock('./pty.js', async () => {
  const actual = await vi.importActual<typeof import('./pty.js')>('./pty.js');
  return {
    ...actual,
    attachExistingAgentSessionExact: attachExistingAgentSessionExactMock,
    getAgentCols: getAgentColsMock,
    getAgentPauseState: getAgentPauseStateMock,
    getAgentRows: getAgentRowsMock,
    getAgentLifecycleGeneration: getAgentLifecycleGenerationMock,
    getAgentMeta: getAgentMetaMock,
    getAgentTerminalRecovery: getAgentTerminalRecoveryMock,
    getAgentTerminalStartupRecovery: getAgentTerminalStartupRecoveryMock,
    hasAgentSession: hasAgentSessionMock,
    pauseAgent: pauseAgentMock,
    resizeAgent: resizeAgentMock,
    resumeAgent: resumeAgentMock,
  };
});

vi.mock('./task-workflows.js', async () => {
  const actual = await vi.importActual<typeof import('./task-workflows.js')>('./task-workflows.js');
  return {
    ...actual,
    spawnOwnedTaskAgentWorkflow: (
      context: unknown,
      _ownership: unknown,
      request: { bindOutputChannel?: () => boolean },
    ) => {
      const channelBound = request.bindOutputChannel?.();
      if (channelBound === false) {
        return { channelAttached: false, channelBound: false, kind: 'created-session' };
      }
      const result = spawnTaskAgentWorkflowMock(context, request);
      return result instanceof Promise
        ? result.then((value) => ({
            ...value,
            ...(channelBound === undefined ? {} : { channelBound }),
          }))
        : { ...result, ...(channelBound === undefined ? {} : { channelBound }) };
    },
    spawnTaskAgentWorkflow: spawnTaskAgentWorkflowMock,
  };
});

import { releaseAllHeldTerminalRecoveryBatchPausesForTests } from './agent-handlers.js';
import { createIpcHandlers, type HandlerContext } from './handlers.js';
import {
  registerArenaTerminalLaunch,
  resetArenaTerminalLaunchesForTest,
} from './arena-terminal-launches.js';
import {
  acquireTaskCommandLease,
  getTaskCommandLeaseIdentity,
  resetTaskCommandLeasesForTest,
} from './task-command-leases.js';
import { normalizeBrowserIpcTaskCommandArgs } from '../../server/browser-ipc-task-command-args.js';

function buildContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    userDataPath: '/tmp/parallel-code-tests',
    isPackaged: false,
    classifyCanonicalAgentSessionIdentity: vi.fn().mockResolvedValue('unmanaged'),
    restoreCanonicalTaskShellSession: vi.fn(async ({ sessionId, taskId }) => ({
      kind: 'unmanaged' as const,
      reason: 'compatibility-shell' as const,
      sessionId,
      taskId,
    })),
    sendToChannel: vi.fn(),
    ...overrides,
  };
}

function buildAttachRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const request: Record<string, unknown> = {
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
    isShell: true,
    onOutput: { __CHANNEL_ID__: 'channel-1' },
    rows: 40,
    sessionOwner: 'compatibility-shell',
    taskId: 'task-1',
    ...overrides,
  };
  if (overrides.arenaLaunchToken !== undefined && overrides.sessionOwner === undefined) {
    request.isShell = false;
    request.sessionOwner = 'arena-transient';
  }
  return request;
}

function buildManagedAttachRequest(
  sessionOwner: 'managed-agent' | 'managed-task-shell' = 'managed-agent',
): Record<string, unknown> {
  return {
    agentId: 'agent-1',
    clientId: 'client-1',
    initialRecovery: {
      outputCursor: null,
      role: null,
      snapshotByteLimit: 64 * 1024,
      visibleTerminalCount: 1,
    },
    onOutput: { __CHANNEL_ID__: 'channel-1' },
    sessionOwner,
    taskId: 'task-1',
  };
}

describe('AttachTerminalSession', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetArenaTerminalLaunchesForTest();
    resetTaskCommandLeasesForTest();
    hasAgentSessionMock.mockReturnValue(true);
    getAgentPauseStateMock.mockReturnValue(null);
    getAgentColsMock.mockReturnValue(132);
    getAgentRowsMock.mockReturnValue(43);
    getAgentLifecycleGenerationMock.mockReturnValue(7);
    getAgentMetaMock.mockReturnValue({
      agentId: 'agent-1',
      generation: 7,
      isShell: true,
      taskId: 'task-1',
    });
    attachExistingAgentSessionExactMock.mockImplementation(
      (_send: unknown, request: { bindChannel?: () => boolean }) => ({
        channelAttached: true,
        channelBound: request.bindChannel?.() ?? true,
        kind: 'attached-existing',
      }),
    );
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
    resetArenaTerminalLaunchesForTest();
    resetTaskCommandLeasesForTest();
    releaseAllHeldTerminalRecoveryBatchPausesForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('classifies only an exact backend-issued Arena launch as explicit transient', async () => {
    hasAgentSessionMock.mockReturnValue(false);
    spawnTaskAgentWorkflowMock.mockResolvedValue({
      channelAttached: true,
      kind: 'created-session',
    });
    const arenaLaunchToken = registerArenaTerminalLaunch({
      agentId: 'agent-1',
      branchName: 'arena/one',
      projectRoot: '/tmp/project',
      root: '/tmp/worktree',
      taskId: 'task-1',
    });
    const handlers = createIpcHandlers(buildContext());

    await handlers[IPC.AttachTerminalSession]?.(buildAttachRequest({ arenaLaunchToken }));

    expect(spawnTaskAgentWorkflowMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contentAuthorityClass: 'explicit-transient',
        contentAuthorityRoot: '/tmp/worktree',
      }),
    );
  });

  it('rejects a renderer-invented Arena token without reaching the spawn workflow', async () => {
    hasAgentSessionMock.mockReturnValue(false);
    const handlers = createIpcHandlers(buildContext());

    await expect(
      handlers[IPC.AttachTerminalSession]?.(
        buildAttachRequest({ arenaLaunchToken: 'renderer-selected' }),
      ),
    ).rejects.toThrow('Arena terminal launch is unavailable');
    expect(spawnTaskAgentWorkflowMock).not.toHaveBeenCalled();
  });

  it('rejects an Arena launch attach race without consuming its capability', async () => {
    const arenaLaunchToken = registerArenaTerminalLaunch({
      agentId: 'agent-1',
      branchName: 'arena/one',
      projectRoot: '/tmp/project',
      root: '/tmp/worktree',
      taskId: 'task-1',
    });
    const handlers = createIpcHandlers(buildContext());

    await expect(
      handlers[IPC.AttachTerminalSession]?.(buildAttachRequest({ arenaLaunchToken })),
    ).rejects.toThrow('Arena terminal launch is unavailable');
    expect(spawnTaskAgentWorkflowMock).not.toHaveBeenCalled();

    hasAgentSessionMock.mockReturnValue(false);
    await expect(
      handlers[IPC.AttachTerminalSession]?.(buildAttachRequest({ arenaLaunchToken })),
    ).resolves.toBeDefined();
    expect(spawnTaskAgentWorkflowMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contentAuthorityClass: 'explicit-transient',
        contentAuthorityRoot: '/tmp/worktree',
      }),
    );
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
      channelBound: boolean;
      disposition: string;
      recovery: { batchPauseId?: string; recovery: { kind: string } } | null;
    };

    expect(callOrder).toEqual(['bind:client-1:channel-1', 'spawn']);
    expect(result.channelBound).toBe(true);
    expect(result.disposition).toBe('existing');
  });

  it('restores a managed agent from identity only before exact channel attach', async () => {
    const callOrder: string[] = [];
    const bindChannelForClient = vi.fn(() => {
      callOrder.push('bind');
      return true;
    });
    const restoreCanonicalAgentSession = vi.fn(async () => {
      callOrder.push('restore');
      return {
        agentId: 'agent-1',
        cols: 132,
        generation: 8,
        kind: 'restored' as const,
        rows: 43,
        taskId: 'task-1',
      };
    });
    attachExistingAgentSessionExactMock.mockImplementation(
      (_send: unknown, request: { bindChannel?: () => boolean }) => {
        callOrder.push('exact-attach');
        return {
          channelAttached: true,
          channelBound: request.bindChannel?.() ?? true,
          kind: 'attached-existing',
        };
      },
    );
    const handlers = createIpcHandlers(
      buildContext({ bindChannelForClient, restoreCanonicalAgentSession }),
    );

    const result = await handlers[IPC.AttachTerminalSession]?.(buildManagedAttachRequest());

    expect(restoreCanonicalAgentSession).toHaveBeenCalledWith({
      agentId: 'agent-1',
      taskId: 'task-1',
    });
    expect(callOrder).toEqual(['restore', 'exact-attach', 'bind']);
    expect(result).toMatchObject({
      channelBound: true,
      disposition: 'restored',
      generation: 8,
      kind: 'attached',
    });
    expect(spawnTaskAgentWorkflowMock).not.toHaveBeenCalled();
  });

  it('returns typed managed restore denial without channel, PTY, pause, or spawn effects', async () => {
    const bindChannelForClient = vi.fn(() => true);
    const restoreCanonicalAgentSession = vi.fn().mockResolvedValue({
      kind: 'unavailable',
      reason: 'restore-failed',
    });
    const handlers = createIpcHandlers(
      buildContext({ bindChannelForClient, restoreCanonicalAgentSession }),
    );

    const result = await handlers[IPC.AttachTerminalSession]?.(buildManagedAttachRequest());

    expect(result).toEqual({
      channelBound: false,
      kind: 'unavailable',
      reason: 'restore-failed',
      recovery: null,
    });
    expect(bindChannelForClient).not.toHaveBeenCalled();
    expect(attachExistingAgentSessionExactMock).not.toHaveBeenCalled();
    expect(pauseAgentMock).not.toHaveBeenCalled();
    expect(spawnTaskAgentWorkflowMock).not.toHaveBeenCalled();
  });

  it('does not let a compatibility label downgrade a canonical managed agent identity', async () => {
    const bindChannelForClient = vi.fn(() => true);
    const restoreCanonicalTaskShellSession = vi.fn();
    const handlers = createIpcHandlers(
      buildContext({
        bindChannelForClient,
        classifyCanonicalAgentSessionIdentity: vi.fn().mockResolvedValue('managed-agent'),
        restoreCanonicalTaskShellSession,
      }),
    );

    const result = await handlers[IPC.AttachTerminalSession]?.(buildAttachRequest());

    expect(result).toEqual({
      channelBound: false,
      kind: 'unavailable',
      reason: 'identity-unavailable',
      recovery: null,
    });
    expect(restoreCanonicalTaskShellSession).not.toHaveBeenCalled();
    expect(bindChannelForClient).not.toHaveBeenCalled();
    expect(spawnTaskAgentWorkflowMock).not.toHaveBeenCalled();
  });

  it('forwards explicit compatibility creation only to shell ownership classification', async () => {
    hasAgentSessionMock.mockReturnValue(false);
    spawnTaskAgentWorkflowMock.mockReturnValue({
      channelAttached: true,
      kind: 'created-session',
    });
    const restoreCanonicalTaskShellSession = vi.fn(async ({ sessionId, taskId }) => ({
      kind: 'unmanaged' as const,
      reason: 'compatibility-shell' as const,
      sessionId,
      taskId,
    }));
    const handlers = createIpcHandlers(buildContext({ restoreCanonicalTaskShellSession }));

    const result = await handlers[IPC.AttachTerminalSession]?.(
      buildAttachRequest({ compatibilityIntent: 'create' }),
    );

    expect(restoreCanonicalTaskShellSession).toHaveBeenCalledWith(
      { sessionId: 'agent-1', taskId: 'task-1' },
      { compatibilityIntent: 'create' },
    );
    expect(result).toMatchObject({
      channelBound: true,
      disposition: 'created',
      kind: 'attached',
    });
    expect(spawnTaskAgentWorkflowMock.mock.calls[0]?.[1]).not.toHaveProperty('controllerId');
  });

  it('requires the authenticated browser client to hold task control for explicit creation', async () => {
    hasAgentSessionMock.mockReturnValue(false);
    spawnTaskAgentWorkflowMock.mockReturnValue({
      channelAttached: true,
      kind: 'created-session',
    });
    const handlers = createIpcHandlers(buildContext());
    acquireTaskCommandLease('task-1', 'peer-client', 'peer-owner', 'peer action');

    await expect(
      handlers[IPC.AttachTerminalSession]?.(
        buildAttachRequest({ compatibilityIntent: 'create', controllerId: 'client-1' }),
      ),
    ).rejects.toThrow('Task is controlled by another client');
    expect(spawnTaskAgentWorkflowMock).not.toHaveBeenCalled();

    resetTaskCommandLeasesForTest();
    acquireTaskCommandLease('task-1', 'client-1', 'client-owner', 'open a terminal');
    await expect(
      handlers[IPC.AttachTerminalSession]?.(
        buildAttachRequest({ compatibilityIntent: 'create', controllerId: 'client-1' }),
      ),
    ).resolves.toMatchObject({ kind: 'attached' });
  });

  it('binds standalone creation provenance to transport identity and uses exact existing attach on reload', async () => {
    hasAgentSessionMock.mockReturnValue(false);
    spawnTaskAgentWorkflowMock.mockReturnValue({ channelAttached: true, kind: 'created-session' });
    const restore = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'unmanaged',
        reason: 'compatibility-shell',
        standalone: true,
        taskId: 'task-1',
        sessionId: 'agent-1',
      })
      .mockResolvedValue({
        kind: 'existing',
        taskId: 'task-1',
        sessionId: 'agent-1',
        generation: 7,
        cols: 132,
        rows: 43,
      });
    const bindChannelForClient = vi.fn(() => true);
    const handlers = createIpcHandlers(
      buildContext({ bindChannelForClient, restoreCanonicalTaskShellSession: restore }),
    );
    acquireTaskCommandLease('task-1', 'browser-owner', 'owner', 'open a terminal');
    const normalized = (create: boolean, clientId = 'browser-owner') =>
      normalizeBrowserIpcTaskCommandArgs(
        IPC.AttachTerminalSession,
        buildAttachRequest({
          clientId: 'forged',
          controllerId: 'forged',
          compatibilityCreatorClientId: 'forged',
          ...(create ? { compatibilityIntent: 'create' } : {}),
        }),
        clientId,
      );
    await expect(handlers[IPC.AttachTerminalSession]?.(normalized(true))).resolves.toMatchObject({
      kind: 'attached',
      disposition: 'created',
    });
    expect(spawnTaskAgentWorkflowMock.mock.calls[0]?.[1]).toMatchObject({
      compatibilityCreatorClientId: 'browser-owner',
    });
    expect(restore).toHaveBeenNthCalledWith(
      1,
      { sessionId: 'agent-1', taskId: 'task-1' },
      { clientId: 'browser-owner', compatibilityIntent: 'create' },
    );

    hasAgentSessionMock.mockReturnValue(true);
    await expect(handlers[IPC.AttachTerminalSession]?.(normalized(false))).resolves.toMatchObject({
      kind: 'attached',
      disposition: 'existing',
      generation: 7,
    });
    expect(restore).toHaveBeenLastCalledWith(
      { sessionId: 'agent-1', taskId: 'task-1' },
      { clientId: 'browser-owner' },
    );
    expect(spawnTaskAgentWorkflowMock).toHaveBeenCalledTimes(1);
    expect(attachExistingAgentSessionExactMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: 'agent-1',
        taskId: 'task-1',
        generation: 7,
        isShell: true,
      }),
    );
    const controller = getTaskCommandLeaseIdentity('task-1', 'browser-owner');
    for (const create of [false, true]) {
      await expect(
        handlers[IPC.AttachTerminalSession]?.(normalized(create, 'browser-observer')),
      ).resolves.toMatchObject({ kind: 'attached', disposition: 'existing', generation: 7 });
    }
    expect(getTaskCommandLeaseIdentity('task-1', 'browser-owner')).toEqual(controller);
    expect(getTaskCommandLeaseIdentity('task-1', 'browser-observer')).toBeNull();
    expect(getAgentColsMock('agent-1')).toBe(132);
    expect(getAgentRowsMock('agent-1')).toBe(43);
    expect(spawnTaskAgentWorkflowMock).toHaveBeenCalledTimes(1);
    expect(() =>
      handlers[IPC.ResizeAgent]?.({
        agentId: 'agent-1',
        taskId: 'task-1',
        controllerId: 'browser-observer',
        cols: 80,
        rows: 20,
      }),
    ).toThrow('controlled by another client');
    expect(resizeAgentMock).not.toHaveBeenCalled();
    bindChannelForClient.mockReturnValue(false);
    await expect(handlers[IPC.AttachTerminalSession]?.(normalized(false))).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'channel-unavailable',
    });
    expect(spawnTaskAgentWorkflowMock).toHaveBeenCalledTimes(1);
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

  it('forwards watcher ownership for a task shell attach', async () => {
    const handlers = createIpcHandlers(buildContext());

    await handlers[IPC.AttachTerminalSession]?.(
      buildAttachRequest({ isShell: true, startsTaskWatchers: true }),
    );

    expect(spawnTaskAgentWorkflowMock).toHaveBeenCalledTimes(1);
    expect(spawnTaskAgentWorkflowMock.mock.calls[0]?.[1]).toMatchObject({
      agentId: 'agent-1',
      cwd: '/tmp/worktree',
      isShell: true,
      startsTaskWatchers: true,
      taskId: 'task-1',
    });
  });

  it.each([
    {
      expected: 'startsTaskWatchers must be a boolean when provided',
      overrides: { isShell: true, startsTaskWatchers: 'yes' },
    },
    {
      expected: 'startsTaskWatchers requires a shell session',
      overrides: { isShell: false, startsTaskWatchers: true },
    },
    {
      expected: 'startsTaskWatchers requires a non-empty cwd',
      overrides: { cwd: '  ', isShell: true, startsTaskWatchers: true },
    },
    {
      expected: 'compatibilityIntent must be create when provided',
      overrides: { compatibilityIntent: 'restore' },
    },
  ])('rejects invalid watcher ownership requests: $expected', async ({ expected, overrides }) => {
    const handlers = createIpcHandlers(buildContext());

    await expect(
      handlers[IPC.AttachTerminalSession]?.(buildAttachRequest(overrides)),
    ).rejects.toThrow(expected);
    expect(spawnTaskAgentWorkflowMock).not.toHaveBeenCalled();
  });

  it('returns same-tick recovery for an existing-session attach under a held batch pause', async () => {
    const handlers = createIpcHandlers(buildContext());

    const result = (await handlers[IPC.AttachTerminalSession]?.(buildAttachRequest())) as {
      disposition: string;
      recovery: { agentId: string; batchPauseId?: string; recovery: { kind: string } } | null;
    };

    expect(result.disposition).toBe('existing');
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
      disposition: string;
      recovery: unknown;
    };

    expect(result.disposition).toBe('created');
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
