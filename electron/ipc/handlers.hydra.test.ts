import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';

const {
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

function buildContext(): HandlerContext {
  return {
    userDataPath: '/tmp/parallel-code-tests',
    isPackaged: false,
    sendToChannel: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAgentColsMock.mockReturnValue(80);
  getAgentMetaMock.mockReturnValue(undefined);
  getAgentRowsMock.mockReturnValue(24);
  hasAgentSessionMock.mockReturnValue(false);
  isTaskCommandLeaseHeldMock.mockReturnValue(true);
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
  it('routes Hydra spawns through the internal adapter bootstrap', async () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    await handlers[IPC.SpawnAgent]?.({
      taskId: 'task-1',
      agentId: 'agent-1',
      adapter: 'hydra',
      command: 'hydra',
      args: ['agents=codex,claude'],
      baseBranch: 'release/main',
      cwd: '/tmp/parallel-code/worktree-one',
      env: {
        PARALLEL_CODE_HYDRA_STARTUP_MODE: 'smart',
      },
      resumeOnStart: true,
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    expect(spawnAgentMock).toHaveBeenCalledWith(
      context.sendToChannel,
      expect.objectContaining({
        taskId: 'task-1',
        agentId: 'agent-1',
        command: process.execPath,
        isInternalNodeProcess: true,
        args: expect.arrayContaining([
          expect.stringContaining('hydra-adapter'),
          '--hydra-command',
          'hydra',
          '--startup-mode',
          'smart',
          '--resume-on-start',
          '--operator-arg',
          'agents=codex,claude',
        ]),
      }),
    );
    expect(startTaskGitStatusMonitoringMock).toHaveBeenCalledWith(context, {
      baseBranch: 'release/main',
      taskId: 'task-1',
      worktreePath: '/tmp/parallel-code/worktree-one',
    });
  });

  it('ensures agent sessions in batch without attaching output channels', async () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    await expect(
      handlers[IPC.EnsureAgentSessionsBatch]?.({
        clientId: 'client-1',
        reason: 'startup-restore',
        requests: [
          {
            taskId: 'task-1',
            agentId: 'agent-1',
            command: '/bin/sh',
            args: [],
            cwd: '/tmp/parallel-code/worktree-one',
            env: {},
            cols: 100,
            rows: 30,
          },
        ],
      }),
    ).resolves.toEqual({
      results: [
        {
          agentId: 'agent-1',
          cols: 100,
          created: true,
          existed: false,
          rows: 30,
          taskId: 'task-1',
        },
      ],
    });

    expect(spawnAgentMock).toHaveBeenCalledWith(
      context.sendToChannel,
      expect.not.objectContaining({
        onOutput: expect.anything(),
      }),
    );
  });

  it('does not require renderer-owned client identity for local batch ensure', async () => {
    const handlers = createIpcHandlers(buildContext());

    await expect(
      handlers[IPC.EnsureAgentSessionsBatch]?.({
        reason: 'startup-restore',
        requests: [],
      }),
    ).resolves.toEqual({ results: [] });
  });

  it('batch ensure preserves existing PTY geometry instead of implicitly resizing', async () => {
    hasAgentSessionMock.mockReturnValue(true);
    getAgentColsMock.mockReturnValue(80);
    getAgentMetaMock.mockReturnValue({ taskId: 'task-from-session' });
    getAgentRowsMock.mockReturnValue(24);
    const handlers = createIpcHandlers(buildContext());

    await expect(
      handlers[IPC.EnsureAgentSessionsBatch]?.({
        clientId: 'client-1',
        reason: 'startup-restore',
        requests: [
          {
            taskId: 'task-1',
            agentId: 'agent-1',
            command: '/bin/sh',
            args: [],
            cwd: '/tmp/parallel-code/worktree-one',
            env: {},
            cols: 120,
            rows: 40,
          },
        ],
      }),
    ).resolves.toEqual({
      results: [
        {
          agentId: 'agent-1',
          cols: 80,
          created: false,
          existed: true,
          rows: 24,
          taskId: 'task-from-session',
        },
      ],
    });

    expect(spawnAgentMock).not.toHaveBeenCalled();
    expect(resizeAgentMock).not.toHaveBeenCalled();
  });

  it('does not validate runner profile config for existing batch sessions', async () => {
    hasAgentSessionMock.mockReturnValue(true);
    getAgentColsMock.mockReturnValue(120);
    getAgentRowsMock.mockReturnValue(40);
    const handlers = createIpcHandlers(buildContext());

    await expect(
      handlers[IPC.EnsureAgentSessionsBatch]?.({
        clientId: 'client-1',
        reason: 'startup-restore',
        requests: [
          {
            taskId: 'task-1',
            agentId: 'agent-1',
            command: '/bin/sh',
            args: [],
            cwd: '/tmp/parallel-code/worktree-one',
            env: {},
            cols: 80,
            rows: 24,
            runnerProfile: { provider: 'docker-container' },
          },
        ],
      }),
    ).resolves.toEqual({
      results: [
        {
          agentId: 'agent-1',
          cols: 120,
          created: false,
          existed: true,
          rows: 40,
          taskId: 'task-1',
        },
      ],
    });

    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('returns per-agent failures from batch ensure without hiding partial successes', async () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);
    spawnAgentMock.mockImplementation((_sendToChannel, request: { agentId: string }) => {
      if (request.agentId === 'agent-fail') {
        throw new Error('spawn failed');
      }

      return { channelAttached: true, kind: 'created-session' };
    });

    await expect(
      handlers[IPC.EnsureAgentSessionsBatch]?.({
        clientId: 'client-1',
        reason: 'dispatch-storm',
        requests: [
          {
            taskId: 'task-1',
            agentId: 'agent-ok',
            command: '/bin/sh',
            args: [],
            cwd: '/tmp/parallel-code/worktree-one',
            env: {},
            cols: 80,
            rows: 24,
          },
          {
            taskId: 'task-1',
            agentId: 'agent-fail',
            command: '/bin/sh',
            args: [],
            cwd: '/tmp/parallel-code/worktree-one',
            env: {},
            cols: 80,
            rows: 24,
          },
        ],
      }),
    ).resolves.toEqual({
      results: [
        {
          agentId: 'agent-ok',
          cols: 80,
          created: true,
          existed: false,
          rows: 24,
          taskId: 'task-1',
        },
        {
          agentId: 'agent-fail',
          cols: 80,
          created: false,
          error: 'spawn failed',
          existed: false,
          rows: 24,
          taskId: 'task-1',
        },
      ],
    });
  });

  it('keeps valid batch entries when one runner profile config is invalid', async () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    await expect(
      handlers[IPC.EnsureAgentSessionsBatch]?.({
        clientId: 'client-1',
        reason: 'dispatch-storm',
        requests: [
          {
            taskId: 'task-1',
            agentId: 'agent-ok',
            command: '/bin/sh',
            args: [],
            cwd: '/tmp/parallel-code/worktree-one',
            env: {},
            cols: 80,
            rows: 24,
          },
          {
            taskId: 'task-1',
            agentId: 'agent-bad-profile',
            command: '/bin/sh',
            args: [],
            cwd: '/tmp/parallel-code/worktree-one',
            env: {},
            cols: 80,
            rows: 24,
            runnerProfile: { provider: 'docker-container' },
          },
        ],
      }),
    ).resolves.toEqual({
      results: [
        {
          agentId: 'agent-ok',
          cols: 80,
          created: true,
          existed: false,
          rows: 24,
          taskId: 'task-1',
        },
        {
          agentId: 'agent-bad-profile',
          cols: 80,
          created: false,
          error: 'agentRunnerProfile requires image or dockerfile for Docker container runners',
          existed: false,
          rows: 24,
          taskId: 'task-1',
        },
      ],
    });

    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    expect(spawnAgentMock).toHaveBeenCalledWith(
      context.sendToChannel,
      expect.objectContaining({
        agentId: 'agent-ok',
      }),
    );
  });

  it('releases batch spawn admission slots when one admitted entry throws', async () => {
    const handlers = createIpcHandlers(buildContext());
    spawnAgentMock.mockImplementation((_sendToChannel, request: { agentId: string }) => {
      if (request.agentId === 'agent-2') {
        throw new Error('spawn failed');
      }

      return { channelAttached: true, kind: 'created-session' };
    });

    const response = (await handlers[IPC.EnsureAgentSessionsBatch]?.({
      clientId: 'client-1',
      reason: 'dispatch-storm',
      requests: Array.from({ length: 6 }, (_, index) => ({
        taskId: 'task-1',
        agentId: `agent-${index}`,
        command: '/bin/sh',
        args: [],
        cwd: '/tmp/parallel-code/worktree-one',
        env: {},
        cols: 80,
        rows: 24,
      })),
    })) as
      | {
          results: Array<{
            agentId: string;
            created: boolean;
            error?: string;
            existed: boolean;
          }>;
        }
      | undefined;

    expect(response?.results).toHaveLength(6);
    expect(response?.results.filter((result) => result.created)).toHaveLength(5);
    expect(response?.results).toContainEqual(
      expect.objectContaining({
        agentId: 'agent-2',
        created: false,
        error: 'spawn failed',
        existed: false,
      }),
    );
  });

  it('handles duplicate agent ids within one batch with a single spawn', async () => {
    const handlers = createIpcHandlers(buildContext());
    let sessionExists = false;
    hasAgentSessionMock.mockImplementation((agentId: string) => {
      return agentId === 'agent-dupe' && sessionExists;
    });
    getAgentMetaMock.mockReturnValue({ taskId: 'task-1' });
    spawnAgentMock.mockImplementation(() => {
      if (sessionExists) {
        return { channelAttached: false, kind: 'attached-existing' };
      }
      sessionExists = true;
      return { channelAttached: true, kind: 'created-session' };
    });

    await expect(
      handlers[IPC.EnsureAgentSessionsBatch]?.({
        clientId: 'client-1',
        reason: 'dispatch-storm',
        requests: [
          {
            taskId: 'task-1',
            agentId: 'agent-dupe',
            command: '/bin/sh',
            args: [],
            cwd: '/tmp/parallel-code/worktree-one',
            env: {},
            cols: 80,
            rows: 24,
          },
          {
            taskId: 'task-1',
            agentId: 'agent-dupe',
            command: '/bin/sh',
            args: [],
            cwd: '/tmp/parallel-code/worktree-one',
            env: {},
            cols: 80,
            rows: 24,
          },
        ],
      }),
    ).resolves.toEqual({
      results: [
        {
          agentId: 'agent-dupe',
          cols: 80,
          created: true,
          existed: false,
          rows: 24,
          taskId: 'task-1',
        },
        {
          agentId: 'agent-dupe',
          cols: 80,
          created: false,
          existed: true,
          rows: 24,
          taskId: 'task-1',
        },
      ],
    });
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
  });

  it('single-flights duplicate Docker launches while asynchronous runner setup is pending', async () => {
    const handlers = createIpcHandlers(buildContext());
    let sessionExists = false;
    hasAgentSessionMock.mockImplementation(
      (agentId: string) => agentId === 'agent-docker-dupe' && sessionExists,
    );
    getAgentMetaMock.mockReturnValue({ taskId: 'task-1' });
    spawnAgentMock.mockImplementation(() => {
      if (sessionExists) {
        return { channelAttached: false, kind: 'attached-existing' };
      }
      sessionExists = true;
      return { channelAttached: true, kind: 'created-session' };
    });
    let resolveDockerLaunch!: (launch: unknown) => void;
    createDockerAgentRunnerLaunchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDockerLaunch = resolve;
      }),
    );

    const response = handlers[IPC.EnsureAgentSessionsBatch]?.({
      clientId: 'client-1',
      reason: 'dispatch-storm',
      requests: [
        {
          agentId: 'agent-docker-dupe',
          args: [],
          cols: 80,
          command: 'codex',
          cwd: '/tmp/parallel-code/worktree-one',
          env: {},
          rows: 24,
          runnerProfile: { image: 'agent:latest', provider: 'docker-container' },
          taskId: 'task-1',
        },
        {
          agentId: 'agent-docker-dupe',
          args: [],
          cols: 80,
          command: 'codex',
          cwd: '/tmp/parallel-code/worktree-one',
          env: {},
          rows: 24,
          runnerProfile: { image: 'agent:latest', provider: 'docker-container' },
          taskId: 'task-1',
        },
      ],
    });
    await vi.waitFor(() => {
      expect(createDockerAgentRunnerLaunchMock).toHaveBeenCalledOnce();
    });
    expect(spawnAgentMock).not.toHaveBeenCalled();

    resolveDockerLaunch({
      args: ['run', 'agent:latest', 'codex'],
      cleanup: vi.fn(),
      command: 'docker',
      cwd: '/tmp/parallel-code/worktree-one',
      env: {},
      identity: {
        agentId: 'agent-docker-dupe',
        labels: {},
        profileId: 'profile-1',
        provider: 'docker-container',
        runnerInstanceId: 'runner-1',
        startedAt: '2026-05-24T00:00:00.000Z',
        taskId: 'task-1',
      },
    });

    await expect(response).resolves.toEqual({
      results: [
        {
          agentId: 'agent-docker-dupe',
          cols: 80,
          created: true,
          existed: false,
          rows: 24,
          taskId: 'task-1',
        },
        {
          agentId: 'agent-docker-dupe',
          cols: 80,
          created: false,
          existed: true,
          rows: 24,
          taskId: 'task-1',
        },
      ],
    });
    expect(createDockerAgentRunnerLaunchMock).toHaveBeenCalledOnce();
    expect(spawnAgentMock).toHaveBeenCalledOnce();
  });

  it('rejects invalid terminal geometry before spawning or resizing', async () => {
    const handlers = createIpcHandlers(buildContext());

    await expect(
      handlers[IPC.SpawnAgent]?.({
        taskId: 'task-1',
        agentId: 'agent-1',
        command: '/bin/sh',
        args: [],
        cwd: '/tmp/parallel-code/worktree-one',
        env: {},
        cols: 0,
        rows: 24,
        onOutput: { __CHANNEL_ID__: 'channel-1' },
      }),
    ).rejects.toThrow('cols must be a positive integer');

    await expect(
      handlers[IPC.EnsureAgentSessionsBatch]?.({
        clientId: 'client-1',
        reason: 'startup-restore',
        requests: [
          {
            taskId: 'task-1',
            agentId: 'agent-1',
            command: '/bin/sh',
            args: [],
            cwd: '/tmp/parallel-code/worktree-one',
            env: {},
            cols: 80,
            rows: Number.NaN,
          },
        ],
      }),
    ).rejects.toThrow('requests[0].rows must be an integer');

    expect(() =>
      handlers[IPC.ResizeAgent]?.({
        agentId: 'agent-1',
        cols: 120,
        rows: -1,
      }),
    ).toThrow('rows must be a positive integer');

    expect(spawnAgentMock).not.toHaveBeenCalled();
    expect(resizeAgentMock).not.toHaveBeenCalled();
  });

  it('re-checks an admitted SpawnAgent before resolving runner profile config', async () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);
    hasAgentSessionMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    spawnAgentMock.mockReturnValueOnce({
      channelAttached: true,
      kind: 'attached-existing',
    });
    getAgentColsMock.mockReturnValue(100);
    getAgentRowsMock.mockReturnValue(30);

    await expect(
      handlers[IPC.SpawnAgent]?.({
        taskId: 'task-1',
        agentId: 'agent-1',
        command: '/bin/sh',
        args: [],
        cwd: '/tmp/parallel-code/worktree-one',
        env: {},
        cols: 80,
        rows: 24,
        onOutput: { __CHANNEL_ID__: 'channel-1' },
        runnerProfile: { provider: 'podman' },
      }),
    ).resolves.toEqual({ attachedExistingSession: true });

    expect(spawnAgentMock).toHaveBeenCalledWith(
      context.sendToChannel,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 100,
        rows: 30,
      }),
    );
    expect(spawnAgentMock).toHaveBeenCalledWith(
      context.sendToChannel,
      expect.not.objectContaining({
        runnerProfile: expect.anything(),
      }),
    );
  });

  it('rejects invalid Hydra startup recovery flags', async () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);
    const invalidRequest = {
      taskId: 'task-1',
      agentId: 'agent-1',
      adapter: 'hydra',
      command: 'hydra',
      args: [],
      cwd: '/tmp/parallel-code/worktree-one',
      env: {},
      resumeOnStart: 'true',
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    } as unknown as Parameters<NonNullable<(typeof handlers)[typeof IPC.SpawnAgent]>>[0];

    await expect(handlers[IPC.SpawnAgent]?.(invalidRequest)).rejects.toThrow(
      'resumeOnStart must be a boolean',
    );
  });

  it('rejects malformed spawn base branches at the IPC boundary', async () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    await expect(
      handlers[IPC.SpawnAgent]?.({
        taskId: 'task-1',
        agentId: 'agent-1',
        command: 'codex',
        args: ['resume'],
        baseBranch: 'feature..bad',
        cwd: '/tmp/parallel-code/worktree-one',
        env: {},
        cols: 80,
        rows: 24,
        onOutput: { __CHANNEL_ID__: 'channel-1' },
      }),
    ).rejects.toThrow('baseBranch must be a valid branch name');

    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('keeps non-Hydra spawns on the generic PTY path', async () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    await handlers[IPC.SpawnAgent]?.({
      taskId: 'task-1',
      agentId: 'agent-1',
      command: 'codex',
      args: ['resume', '--last'],
      cwd: '/tmp/parallel-code/worktree-one',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    expect(spawnAgentMock).toHaveBeenCalledWith(
      context.sendToChannel,
      expect.objectContaining({
        command: 'codex',
        args: ['resume', '--last'],
        isInternalNodeProcess: false,
      }),
    );
  });

  it('uses backend geometry for existing-session attach instead of requested local geometry', async () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);
    hasAgentSessionMock.mockReturnValue(true);
    getAgentColsMock.mockReturnValue(88);
    getAgentRowsMock.mockReturnValue(26);

    await handlers[IPC.SpawnAgent]?.({
      taskId: 'task-1',
      agentId: 'agent-1',
      command: 'codex',
      args: ['resume'],
      cwd: '/tmp/parallel-code/worktree-one',
      env: {},
      cols: 120,
      rows: 40,
      controllerId: 'client-1',
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    expect(spawnAgentMock).toHaveBeenCalledWith(
      context.sendToChannel,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 88,
        rows: 26,
      }),
    );
  });

  it('uses requested geometry and replacement intent when replacing an existing session', async () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);
    hasAgentSessionMock.mockReturnValue(true);
    getAgentColsMock.mockReturnValue(88);
    getAgentRowsMock.mockReturnValue(26);
    spawnAgentMock.mockReturnValue({ channelAttached: true, kind: 'created-session' });

    await expect(
      handlers[IPC.SpawnAgent]?.({
        taskId: 'task-1',
        agentId: 'agent-1',
        command: 'codex',
        args: ['resume'],
        cwd: '/tmp/parallel-code/worktree-one',
        env: {},
        cols: 120,
        rows: 40,
        replaceExistingSession: true,
        onOutput: { __CHANNEL_ID__: 'channel-1' },
      }),
    ).resolves.toEqual({ attachedExistingSession: false });

    expect(spawnAgentMock).toHaveBeenCalledWith(
      context.sendToChannel,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 120,
        replaceExistingSession: true,
        rows: 40,
      }),
    );
  });

  it('rejects malformed replaceExistingSession values at the IPC boundary', async () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    await expect(
      handlers[IPC.SpawnAgent]?.({
        taskId: 'task-1',
        agentId: 'agent-1',
        command: 'codex',
        args: ['resume'],
        cwd: '/tmp/parallel-code/worktree-one',
        env: {},
        cols: 80,
        rows: 24,
        replaceExistingSession: 'yes',
        onOutput: { __CHANNEL_ID__: 'channel-1' },
      } as unknown as Parameters<NonNullable<(typeof handlers)[typeof IPC.SpawnAgent]>>[0]),
    ).rejects.toThrow('replaceExistingSession must be a boolean');

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
