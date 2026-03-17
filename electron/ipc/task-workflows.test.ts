import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';

const {
  resolveHydraAdapterLaunchMock,
  ensurePlansDirectoryMock,
  startPlanWatcherMock,
  stopPlanWatcherMock,
  spawnAgentMock,
  createTaskMock,
  deleteTaskMock,
  startTaskGitStatusMonitoringMock,
  stopTaskGitStatusWatcherMock,
} = vi.hoisted(() => ({
  resolveHydraAdapterLaunchMock: vi.fn(),
  ensurePlansDirectoryMock: vi.fn(),
  startPlanWatcherMock: vi.fn(),
  stopPlanWatcherMock: vi.fn(),
  spawnAgentMock: vi.fn(),
  createTaskMock: vi.fn(),
  deleteTaskMock: vi.fn(),
  startTaskGitStatusMonitoringMock: vi.fn(),
  stopTaskGitStatusWatcherMock: vi.fn(),
}));

vi.mock('./hydra-adapter.js', () => ({
  resolveHydraAdapterLaunch: resolveHydraAdapterLaunchMock,
}));

vi.mock('./plans.js', () => ({
  ensurePlansDirectory: ensurePlansDirectoryMock,
  startPlanWatcher: startPlanWatcherMock,
  stopPlanWatcher: stopPlanWatcherMock,
}));

vi.mock('./pty.js', async () => {
  const actual = await vi.importActual<typeof import('./pty.js')>('./pty.js');
  return {
    ...actual,
    spawnAgent: spawnAgentMock,
  };
});

vi.mock('./tasks.js', () => ({
  createTask: createTaskMock,
  deleteTask: deleteTaskMock,
}));

vi.mock('./git-status-workflows.js', () => ({
  startTaskGitStatusMonitoring: startTaskGitStatusMonitoringMock,
  stopTaskGitStatusWatcher: stopTaskGitStatusWatcherMock,
}));

import {
  createTaskWorkflow,
  deleteTaskWorkflow,
  spawnTaskAgentWorkflow,
  type TaskWorkflowContext,
} from './task-workflows.js';

function createContext(): TaskWorkflowContext {
  return {
    emitIpcEvent: vi.fn(),
    sendToChannel: vi.fn(),
  };
}

describe('task workflows', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    resolveHydraAdapterLaunchMock.mockReturnValue({
      command: process.execPath,
      args: ['adapter-entry'],
      env: { HYDRA_BOOT: '1' },
      isInternalNodeProcess: true,
    });
    startTaskGitStatusMonitoringMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('routes hydra agent creation through the adapter and starts worktree watchers', () => {
    const context = createContext();

    spawnTaskAgentWorkflow(context, {
      taskId: 'task-1',
      agentId: 'agent-1',
      adapter: 'hydra',
      command: 'hydra',
      args: ['agents=codex'],
      cwd: '/tmp/task-1',
      env: {
        KEEP_ME: 'yes',
        DROP_ME: 42,
      },
      cols: 100,
      rows: 40,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    expect(resolveHydraAdapterLaunchMock).toHaveBeenCalledWith({
      command: 'hydra',
      args: ['agents=codex'],
      cwd: '/tmp/task-1',
      env: { KEEP_ME: 'yes' },
    });
    expect(spawnAgentMock).toHaveBeenCalledWith(
      context.sendToChannel,
      expect.objectContaining({
        taskId: 'task-1',
        agentId: 'agent-1',
        command: process.execPath,
        args: ['adapter-entry'],
        env: { HYDRA_BOOT: '1' },
        cols: 100,
        rows: 40,
        isInternalNodeProcess: true,
        onOutput: { __CHANNEL_ID__: 'channel-1' },
      }),
    );
    expect(ensurePlansDirectoryMock).toHaveBeenCalledWith('/tmp/task-1');
    expect(startPlanWatcherMock).toHaveBeenCalledWith(
      'task-1',
      '/tmp/task-1',
      expect.any(Function),
    );
    expect(startTaskGitStatusMonitoringMock).toHaveBeenCalledWith(context, {
      taskId: 'task-1',
      worktreePath: '/tmp/task-1',
    });
  });

  it('skips plan and git watchers for shell agents', () => {
    const context = createContext();

    spawnTaskAgentWorkflow(context, {
      taskId: 'task-1',
      agentId: 'agent-1',
      command: 'bash',
      args: ['-l'],
      cwd: '/tmp/task-1',
      env: {},
      cols: 80,
      rows: 24,
      isShell: true,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    expect(spawnAgentMock).toHaveBeenCalledOnce();
    expect(ensurePlansDirectoryMock).not.toHaveBeenCalled();
    expect(startPlanWatcherMock).not.toHaveBeenCalled();
    expect(startTaskGitStatusMonitoringMock).not.toHaveBeenCalled();
  });

  it('creates a task and starts its git watcher', async () => {
    const context = createContext();
    createTaskMock.mockResolvedValue({
      id: 'task-2',
      branch_name: 'task/workflow',
      worktree_path: '/tmp/task-2',
    });

    const result = await createTaskWorkflow(context, {
      name: 'Workflow task',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      symlinkDirs: ['node_modules'],
      branchPrefix: 'task',
    });

    expect(createTaskMock).toHaveBeenCalledWith(
      'Workflow task',
      '/tmp/project',
      ['node_modules'],
      'task',
    );
    expect(startTaskGitStatusMonitoringMock).toHaveBeenCalledWith(context, {
      taskId: 'task-2',
      worktreePath: '/tmp/task-2',
    });
    expect(result).toEqual({
      id: 'task-2',
      branch_name: 'task/workflow',
      worktree_path: '/tmp/task-2',
    });
  });

  it('logs and swallows git watcher startup failures during task creation', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createTaskMock.mockResolvedValue({
      id: 'task-4',
      branch_name: 'task/failure',
      worktree_path: '/tmp/task-4',
    });
    startTaskGitStatusMonitoringMock.mockRejectedValue(new Error('watch failed'));

    await createTaskWorkflow(createContext(), {
      name: 'Watcher failure',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      symlinkDirs: [],
      branchPrefix: 'task',
    });
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith('Failed to start git watcher:', expect.any(Error));

    warnSpy.mockRestore();
  });

  it('stops task watchers only after deletion succeeds', async () => {
    deleteTaskMock.mockResolvedValue(undefined);

    await deleteTaskWorkflow({
      taskId: 'task-3',
      agentIds: ['agent-1'],
      branchName: 'task/delete',
      deleteBranch: true,
      projectRoot: '/tmp/project',
    });

    expect(deleteTaskMock).toHaveBeenCalledWith(['agent-1'], 'task/delete', true, '/tmp/project');
    expect(stopPlanWatcherMock).toHaveBeenCalledWith('task-3');
    expect(stopTaskGitStatusWatcherMock).toHaveBeenCalledWith('task-3');
    expect(deleteTaskMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(
      stopPlanWatcherMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(
      stopPlanWatcherMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(
      stopTaskGitStatusWatcherMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('keeps task watchers running when deletion fails', async () => {
    deleteTaskMock.mockRejectedValue(new Error('delete failed'));

    await expect(
      deleteTaskWorkflow({
        taskId: 'task-3',
        agentIds: ['agent-1'],
        branchName: 'task/delete',
        deleteBranch: true,
        projectRoot: '/tmp/project',
      }),
    ).rejects.toThrow('delete failed');

    expect(stopPlanWatcherMock).not.toHaveBeenCalled();
    expect(stopTaskGitStatusWatcherMock).not.toHaveBeenCalled();
  });

  it('forwards plan watcher updates to the IPC event channel', () => {
    const context = createContext();

    spawnTaskAgentWorkflow(context, {
      taskId: 'task-1',
      agentId: 'agent-1',
      command: 'codex',
      args: ['run'],
      cwd: '/tmp/task-1',
      env: {},
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    const onPlanChange = startPlanWatcherMock.mock.calls[0]?.[2];
    expect(onPlanChange).toBeTypeOf('function');

    onPlanChange?.({
      taskId: 'task-1',
      content: 'updated plan',
      fileName: 'plan.md',
      relativePath: '.claude/plans/plan.md',
    });

    expect(context.emitIpcEvent).toHaveBeenCalledWith(IPC.PlanContent, {
      taskId: 'task-1',
      content: 'updated plan',
      fileName: 'plan.md',
      relativePath: '.claude/plans/plan.md',
    });
  });
});
