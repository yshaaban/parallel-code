import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';

const {
  attachExistingAgentSessionExactMock,
  spawnAgentMock,
  cleanupPendingDockerAgentRunnerBuildsMock,
  createDockerAgentRunnerLaunchMock,
  ensurePlansDirectoryMock,
  getAgentColsMock,
  getAgentMetaMock,
  getAgentRowsMock,
  hasAgentSessionMock,
  isTaskCommandLeaseHeldMock,
  resizeAgentMock,
  startPlanWatcherMock,
  startTaskGitStatusMonitoringMock,
  writeToAgentMock,
} = vi.hoisted(() => ({
  attachExistingAgentSessionExactMock: vi.fn(),
  spawnAgentMock: vi.fn(),
  cleanupPendingDockerAgentRunnerBuildsMock: vi.fn(),
  createDockerAgentRunnerLaunchMock: vi.fn(),
  ensurePlansDirectoryMock: vi.fn(),
  getAgentColsMock: vi.fn(),
  getAgentMetaMock: vi.fn(),
  getAgentRowsMock: vi.fn(),
  hasAgentSessionMock: vi.fn(),
  isTaskCommandLeaseHeldMock: vi.fn(),
  resizeAgentMock: vi.fn(),
  startPlanWatcherMock: vi.fn(),
  startTaskGitStatusMonitoringMock: vi.fn(),
  writeToAgentMock: vi.fn(),
}));

vi.mock('./agent-runner-docker.js', () => ({
  cleanupPendingDockerAgentRunnerBuilds: cleanupPendingDockerAgentRunnerBuildsMock,
  createDockerAgentRunnerLaunch: createDockerAgentRunnerLaunchMock,
}));

vi.mock('./pty.js', async () => {
  const actual = await vi.importActual<typeof import('./pty.js')>('./pty.js');
  return {
    ...actual,
    attachExistingAgentSessionExact: attachExistingAgentSessionExactMock,
    spawnAgent: spawnAgentMock,
    getAgentCols: getAgentColsMock,
    getAgentMeta: getAgentMetaMock,
    getAgentRows: getAgentRowsMock,
    hasAgentSession: hasAgentSessionMock,
    resizeAgent: resizeAgentMock,
    writeToAgent: writeToAgentMock,
  };
});

vi.mock('./task-command-leases.js', async () => {
  const actual = await vi.importActual<typeof import('./task-command-leases.js')>(
    './task-command-leases.js',
  );
  return {
    ...actual,
    isTaskCommandLeaseHeld: isTaskCommandLeaseHeldMock,
  };
});

vi.mock('./plans.js', async () => {
  const actual = await vi.importActual<typeof import('./plans.js')>('./plans.js');
  return {
    ...actual,
    ensurePlansDirectory: ensurePlansDirectoryMock,
    startPlanWatcher: startPlanWatcherMock,
  };
});

vi.mock('./git-status-workflows.js', async () => {
  const actual = await vi.importActual<typeof import('./git-status-workflows.js')>(
    './git-status-workflows.js',
  );
  return {
    ...actual,
    startTaskGitStatusMonitoring: startTaskGitStatusMonitoringMock,
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

beforeEach(() => {
  vi.clearAllMocks();
  getAgentColsMock.mockReturnValue(80);
  getAgentMetaMock.mockImplementation((agentId: string) =>
    hasAgentSessionMock(agentId) ? { agentId, taskId: 'task-1' } : undefined,
  );
  getAgentRowsMock.mockReturnValue(24);
  hasAgentSessionMock.mockReturnValue(false);
  isTaskCommandLeaseHeldMock.mockReturnValue(true);
  attachExistingAgentSessionExactMock.mockImplementation(
    (_sendToChannel: unknown, request: { bindChannel?: () => boolean }) => ({
      channelAttached: true,
      channelBound: request.bindChannel?.() ?? true,
      kind: 'attached-existing',
    }),
  );
  spawnAgentMock.mockImplementation(
    (_sendToChannel, request: { agentId: string; replaceExistingSession?: boolean }) => ({
      channelAttached: true,
      kind:
        hasAgentSessionMock(request.agentId) && request.replaceExistingSession !== true
          ? 'attached-existing'
          : 'created-session',
    }),
  );
  cleanupPendingDockerAgentRunnerBuildsMock.mockResolvedValue(undefined);
  createDockerAgentRunnerLaunchMock.mockResolvedValue({
    args: ['run', 'agent:latest', 'codex'],
    cleanup: vi.fn(),
    command: 'docker',
    cwd: '/tmp/parallel-code/worktree-one',
    env: {},
    identity: {
      agentId: 'agent-1',
      labels: {},
      profileId: 'profile-1',
      provider: 'docker-container',
      runnerInstanceId: 'runner-1',
      startedAt: '2026-05-24T00:00:00.000Z',
      taskId: 'task-1',
    },
  });
  startTaskGitStatusMonitoringMock.mockResolvedValue(undefined);
});

describe('Hydra spawn handling', () => {
  it('retires renderer-owned process creation without reaching PTY or watcher effects', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    expect(() =>
      handlers[IPC.SpawnAgent]?.({
        adapter: 'hydra',
        agentId: 'agent-1',
        args: ['agents=codex,claude'],
        command: 'hydra',
        cwd: '/tmp/parallel-code/worktree-one',
        env: {},
        onOutput: { __CHANNEL_ID__: 'channel-1' },
        taskId: 'task-1',
      }),
    ).toThrow('SpawnAgent is retired; use AttachTerminalSession with an explicit sessionOwner');

    expect(spawnAgentMock).not.toHaveBeenCalled();
    expect(startTaskGitStatusMonitoringMock).not.toHaveBeenCalled();
  });

  it('restores agent sessions from identity-only batch requests', async () => {
    const restoreCanonicalAgentSession = vi
      .fn()
      .mockResolvedValueOnce({
        agentId: 'agent-1',
        cols: 100,
        generation: 4,
        kind: 'restored',
        rows: 30,
        taskId: 'task-1',
      })
      .mockResolvedValueOnce({
        agentId: 'agent-2',
        cols: 80,
        generation: 7,
        kind: 'existing',
        rows: 24,
        taskId: 'task-1',
      });
    const handlers = createIpcHandlers(buildContext({ restoreCanonicalAgentSession }));

    await expect(
      handlers[IPC.EnsureAgentSessionsBatch]?.({
        clientId: 'client-1',
        reason: 'startup-restore',
        requests: [
          { agentId: 'agent-1', taskId: 'task-1' },
          { agentId: 'agent-2', taskId: 'task-1' },
        ],
      }),
    ).resolves.toEqual({
      results: [
        {
          agentId: 'agent-1',
          cols: 100,
          generation: 4,
          kind: 'restored',
          rows: 30,
          taskId: 'task-1',
        },
        {
          agentId: 'agent-2',
          cols: 80,
          generation: 7,
          kind: 'existing',
          rows: 24,
          taskId: 'task-1',
        },
      ],
    });
    expect(restoreCanonicalAgentSession).toHaveBeenCalledTimes(2);
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('keeps ordered typed batch failures without hiding successes', async () => {
    const restoreCanonicalAgentSession = vi
      .fn()
      .mockResolvedValueOnce({
        agentId: 'agent-ok',
        cols: 80,
        generation: 2,
        kind: 'existing',
        rows: 24,
        taskId: 'task-1',
      })
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'restore-failed' })
      .mockRejectedValueOnce(new Error('journal unavailable'));
    const handlers = createIpcHandlers(buildContext({ restoreCanonicalAgentSession }));

    await expect(
      handlers[IPC.EnsureAgentSessionsBatch]?.({
        reason: 'dispatch-storm',
        requests: [
          { agentId: 'agent-ok', taskId: 'task-1' },
          { agentId: 'agent-denied', taskId: 'task-1' },
          { agentId: 'agent-error', taskId: 'task-1' },
        ],
      }),
    ).resolves.toEqual({
      results: [
        {
          agentId: 'agent-ok',
          cols: 80,
          generation: 2,
          kind: 'existing',
          rows: 24,
          taskId: 'task-1',
        },
        {
          agentId: 'agent-denied',
          kind: 'unavailable',
          reason: 'restore-failed',
          taskId: 'task-1',
        },
        {
          agentId: 'agent-error',
          kind: 'unavailable',
          reason: 'restore-failed',
          taskId: 'task-1',
        },
      ],
    });
  });

  it('single-flights duplicate identities while preserving ordered results', async () => {
    const restoreCanonicalAgentSession = vi.fn().mockResolvedValue({
      agentId: 'agent-dupe',
      cols: 80,
      generation: 3,
      kind: 'restored',
      rows: 24,
      taskId: 'task-1',
    });
    const handlers = createIpcHandlers(buildContext({ restoreCanonicalAgentSession }));

    const response = await handlers[IPC.EnsureAgentSessionsBatch]?.({
      reason: 'startup-restore',
      requests: [
        { agentId: 'agent-dupe', taskId: 'task-1' },
        { agentId: 'agent-dupe', taskId: 'task-1' },
      ],
    });

    expect(response).toEqual({
      results: [
        {
          agentId: 'agent-dupe',
          cols: 80,
          generation: 3,
          kind: 'restored',
          rows: 24,
          taskId: 'task-1',
        },
        {
          agentId: 'agent-dupe',
          cols: 80,
          generation: 3,
          kind: 'restored',
          rows: 24,
          taskId: 'task-1',
        },
      ],
    });
    expect(restoreCanonicalAgentSession).toHaveBeenCalledOnce();
  });

  it('rejects renderer launch material in identity-only batch entries', async () => {
    const restoreCanonicalAgentSession = vi.fn();
    const handlers = createIpcHandlers(buildContext({ restoreCanonicalAgentSession }));

    await expect(
      handlers[IPC.EnsureAgentSessionsBatch]?.({
        reason: 'startup-restore',
        requests: [{ agentId: 'agent-1', command: '/bin/sh', taskId: 'task-1' }],
      }),
    ).rejects.toThrow('requests[0] must contain exactly taskId and agentId');
    expect(restoreCanonicalAgentSession).not.toHaveBeenCalled();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('does not require a task-command lease for canonical batch restore', async () => {
    const restoreCanonicalAgentSession = vi.fn().mockResolvedValue({
      agentId: 'agent-1',
      cols: 80,
      generation: 5,
      kind: 'restored',
      rows: 24,
      taskId: 'task-1',
    });
    const handlers = createIpcHandlers(buildContext({ restoreCanonicalAgentSession }));
    isTaskCommandLeaseHeldMock.mockReturnValue(false);

    await expect(
      handlers[IPC.EnsureAgentSessionsBatch]?.({
        clientId: 'observer-client',
        reason: 'startup-restore',
        requests: [{ agentId: 'agent-1', taskId: 'task-1' }],
      }),
    ).resolves.toEqual({
      results: [
        {
          agentId: 'agent-1',
          cols: 80,
          generation: 5,
          kind: 'restored',
          rows: 24,
          taskId: 'task-1',
        },
      ],
    });

    expect(isTaskCommandLeaseHeldMock).not.toHaveBeenCalled();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('returns an identity denial before binding a managed attach channel', async () => {
    const bindChannelForClient = vi.fn(() => true);
    const handlers = createIpcHandlers(
      buildContext({
        bindChannelForClient,
        restoreCanonicalAgentSession: vi.fn().mockResolvedValue({
          kind: 'unavailable',
          reason: 'identity-unavailable',
        }),
      }),
    );

    await expect(
      handlers[IPC.AttachTerminalSession]?.({
        agentId: 'agent-1',
        clientId: 'observer-client',
        initialRecovery: {
          outputCursor: null,
          role: null,
          snapshotByteLimit: null,
          visibleTerminalCount: 1,
        },
        onOutput: { __CHANNEL_ID__: 'channel-1' },
        sessionOwner: 'managed-agent',
        taskId: 'task-1',
      }),
    ).resolves.toEqual({
      channelBound: false,
      kind: 'unavailable',
      reason: 'identity-unavailable',
      recovery: null,
    });

    expect(bindChannelForClient).not.toHaveBeenCalled();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('keeps explicit ResizeAgent as the handler resize path', () => {
    const handlers = createIpcHandlers(buildContext());
    getAgentMetaMock.mockReturnValue({ taskId: 'task-1' });

    handlers[IPC.ResizeAgent]?.({
      agentId: 'agent-1',
      cols: 120,
      rows: 40,
      taskId: 'task-1',
      controllerId: 'client-1',
    });

    expect(resizeAgentMock).toHaveBeenCalledWith('agent-1', 120, 40, undefined);
  });

  it('rejects task terminal writes without controller lease identity', () => {
    const handlers = createIpcHandlers(buildContext());
    getAgentMetaMock.mockReturnValue({ taskId: 'task-1' });

    expect(() =>
      handlers[IPC.WriteToAgent]?.({
        agentId: 'agent-1',
        data: 'pwd\r',
        taskId: 'task-1',
      }),
    ).toThrow('controllerId is required for task terminal mutations');

    expect(writeToAgentMock).not.toHaveBeenCalled();
  });

  it('rejects task terminal writes when taskId does not match agent metadata', () => {
    const handlers = createIpcHandlers(buildContext());
    getAgentMetaMock.mockReturnValue({ taskId: 'task-1' });

    expect(() =>
      handlers[IPC.WriteToAgent]?.({
        agentId: 'agent-1',
        controllerId: 'client-1',
        data: 'pwd\r',
        taskId: 'task-2',
      }),
    ).toThrow('taskId must match the agent task');

    expect(writeToAgentMock).not.toHaveBeenCalled();
  });

  it('passes paired terminal ordering tokens through handler validation', () => {
    const handlers = createIpcHandlers(buildContext());

    handlers[IPC.WriteToAgent]?.({
      agentId: 'agent-1',
      data: 'pwd\r',
      inputEpoch: 'input-epoch-1',
      inputSeq: 0,
    });
    handlers[IPC.ResizeAgent]?.({
      agentId: 'agent-1',
      cols: 120,
      resizeEpoch: 'resize-epoch-1',
      resizeSeq: 0,
      rows: 40,
    });

    expect(writeToAgentMock).toHaveBeenCalledWith('agent-1', 'pwd\r', undefined, {
      inputEpoch: 'input-epoch-1',
      inputSeq: 0,
    });
    expect(resizeAgentMock).toHaveBeenCalledWith('agent-1', 120, 40, {
      resizeEpoch: 'resize-epoch-1',
      resizeSeq: 0,
    });
  });

  it('rejects partial, empty, and negative terminal ordering tokens at the IPC boundary', () => {
    const handlers = createIpcHandlers(buildContext());

    expect(() =>
      handlers[IPC.WriteToAgent]?.({
        agentId: 'agent-1',
        data: 'pwd\r',
        inputEpoch: 'input-epoch-1',
      }),
    ).toThrow('inputEpoch and inputSeq must both be provided');
    expect(() =>
      handlers[IPC.WriteToAgent]?.({
        agentId: 'agent-1',
        data: 'pwd\r',
        inputEpoch: '',
        inputSeq: 0,
      }),
    ).toThrow('inputEpoch must be a non-empty string');
    expect(() =>
      handlers[IPC.ResizeAgent]?.({
        agentId: 'agent-1',
        cols: 120,
        resizeEpoch: 'resize-epoch-1',
        resizeSeq: -1,
        rows: 40,
      }),
    ).toThrow('resizeSeq must be a non-negative integer');
  });
});
