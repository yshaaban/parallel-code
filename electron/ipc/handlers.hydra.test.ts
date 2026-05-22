import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';

const {
  spawnAgentMock,
  ensurePlansDirectoryMock,
  getAgentColsMock,
  getAgentRowsMock,
  hasAgentSessionMock,
  resizeAgentMock,
  startPlanWatcherMock,
  startTaskGitStatusMonitoringMock,
  writeToAgentMock,
} = vi.hoisted(() => ({
  spawnAgentMock: vi.fn(),
  ensurePlansDirectoryMock: vi.fn(),
  getAgentColsMock: vi.fn(),
  getAgentRowsMock: vi.fn(),
  hasAgentSessionMock: vi.fn(),
  resizeAgentMock: vi.fn(),
  startPlanWatcherMock: vi.fn(),
  startTaskGitStatusMonitoringMock: vi.fn(),
  writeToAgentMock: vi.fn(),
}));

vi.mock('./pty.js', async () => {
  const actual = await vi.importActual<typeof import('./pty.js')>('./pty.js');
  return {
    ...actual,
    spawnAgent: spawnAgentMock,
    getAgentCols: getAgentColsMock,
    getAgentRows: getAgentRowsMock,
    hasAgentSession: hasAgentSessionMock,
    resizeAgent: resizeAgentMock,
    writeToAgent: writeToAgentMock,
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
  getAgentRowsMock.mockReturnValue(24);
  hasAgentSessionMock.mockReturnValue(false);
  startTaskGitStatusMonitoringMock.mockResolvedValue(undefined);
});

describe('Hydra spawn handling', () => {
  it('routes Hydra spawns through the internal adapter bootstrap', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    handlers[IPC.SpawnAgent]?.({
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

  it('keeps non-Hydra spawns on the generic PTY path', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    handlers[IPC.SpawnAgent]?.({
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

  it('uses backend geometry for existing-session attach instead of requested local geometry', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);
    hasAgentSessionMock.mockReturnValue(true);
    getAgentColsMock.mockReturnValue(88);
    getAgentRowsMock.mockReturnValue(26);

    handlers[IPC.SpawnAgent]?.({
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

  it('keeps explicit ResizeAgent as the handler resize path', () => {
    const handlers = createIpcHandlers(buildContext());

    handlers[IPC.ResizeAgent]?.({
      agentId: 'agent-1',
      cols: 120,
      rows: 40,
      taskId: 'task-1',
      controllerId: 'client-1',
    });

    expect(resizeAgentMock).toHaveBeenCalledWith('agent-1', 120, 40, undefined);
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
