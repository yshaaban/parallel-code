import { describe, expect, it, vi } from 'vitest';

import { IPC } from '../electron/ipc/channels.js';
import { normalizeBrowserIpcTaskCommandArgs } from './browser-ipc-task-command-args.js';

describe('browser IPC task-command args', () => {
  it('strips task command identity when the browser client identity is missing', () => {
    const args = {
      agentId: 'agent-1',
      controllerId: 'spoofed-client',
      data: 'echo ok\n',
      taskId: 'task-1',
    };

    expect(normalizeBrowserIpcTaskCommandArgs(IPC.WriteToAgent, args, null)).toEqual({
      agentId: 'agent-1',
      data: 'echo ok\n',
    });
  });

  it('strips nested batch ensure identity when the browser client identity is missing', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.EnsureAgentSessionsBatch,
        {
          clientId: 'spoofed-client',
          reason: 'startup-restore',
          requests: [
            {
              agentId: 'agent-1',
              args: [],
              controllerId: 'spoofed-client',
              taskId: 'task-1',
            },
          ],
        },
        null,
      ),
    ).toEqual({
      reason: 'startup-restore',
      requests: [
        {
          agentId: 'agent-1',
          args: [],
        },
      ],
    });
  });

  it('injects browser controller identity into spawned agents', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(IPC.SpawnAgent, { taskId: 'task-1' }, 'client-1'),
    ).toEqual({
      controllerId: 'client-1',
      taskId: 'task-1',
    });
  });

  it('injects browser client identity into batch session ensure requests', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.EnsureAgentSessionsBatch,
        {
          clientId: 'spoofed-client',
          reason: 'startup-restore',
          requests: [
            {
              agentId: 'agent-1',
              args: [],
              cols: 120,
              rows: 40,
              taskId: 'task-1',
            },
          ],
        },
        'browser-client-1',
      ),
    ).toEqual({
      clientId: 'browser-client-1',
      reason: 'startup-restore',
      requests: [
        {
          agentId: 'agent-1',
          args: [],
          cols: 120,
          rows: 40,
          taskId: 'task-1',
        },
      ],
    });
  });

  it('uses backend-owned agent task ids for browser terminal writes', () => {
    const getAgentTaskId = vi.fn(() => 'task-from-agent');

    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.WriteToAgent,
        {
          agentId: 'agent-1',
          data: 'echo ok\n',
          taskId: 'spoofed-task',
        },
        'client-1',
        getAgentTaskId,
      ),
    ).toEqual({
      agentId: 'agent-1',
      controllerId: 'client-1',
      data: 'echo ok\n',
      taskId: 'task-from-agent',
    });
    expect(getAgentTaskId).toHaveBeenCalledWith('agent-1');
  });

  it('resolves missing task ids from backend-owned agent metadata for terminal commands', () => {
    const getAgentTaskId = vi.fn(() => 'task-from-agent');

    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.ResizeAgent,
        {
          agentId: 'agent-1',
          cols: 120,
          rows: 32,
        },
        'client-1',
        getAgentTaskId,
      ),
    ).toEqual({
      agentId: 'agent-1',
      cols: 120,
      controllerId: 'client-1',
      rows: 32,
      taskId: 'task-from-agent',
    });
    expect(getAgentTaskId).toHaveBeenCalledWith('agent-1');
  });

  it('strips explicit browser terminal task ids when backend agent metadata has no task', () => {
    const getAgentTaskId = vi.fn(() => undefined);

    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.WriteToAgent,
        {
          agentId: 'agent-1',
          data: 'echo ok\n',
          taskId: 'spoofed-task',
        },
        'client-1',
        getAgentTaskId,
      ),
    ).toEqual({
      agentId: 'agent-1',
      controllerId: 'client-1',
      data: 'echo ok\n',
    });
    expect(getAgentTaskId).toHaveBeenCalledWith('agent-1');
  });

  it('overrides browser task mutation controller identity from the request header identity', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.DeleteTask,
        {
          branchName: 'task/delete',
          controllerId: 'spoofed-client',
          projectRoot: '/repo',
          taskId: 'task-1',
          worktreePath: '/repo/.worktrees/task-1',
        },
        'browser-client-1',
      ),
    ).toMatchObject({
      branchName: 'task/delete',
      controllerId: 'browser-client-1',
      taskId: 'task-1',
    });
  });

  it('injects browser controller identity into registered worktree git mutations', () => {
    const getAgentTaskId = vi.fn();
    const getWorktreeTaskId = vi.fn(() => 'task-from-worktree');

    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.CommitAll,
        {
          controllerId: 'spoofed-client',
          message: 'save',
          taskId: 'spoofed-task',
          worktreePath: '/repo/.worktrees/task-1',
        },
        'browser-client-1',
        getAgentTaskId,
        getWorktreeTaskId,
      ),
    ).toEqual({
      controllerId: 'browser-client-1',
      message: 'save',
      taskId: 'task-from-worktree',
      worktreePath: '/repo/.worktrees/task-1',
    });
    expect(getWorktreeTaskId).toHaveBeenCalledWith('/repo/.worktrees/task-1');
  });

  it('keeps unregistered worktree git mutations outside task command ownership', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.MergeArenaWorktree,
        {
          branchName: 'arena/a',
          controllerId: 'spoofed-client',
          projectRoot: '/repo',
          squash: true,
          taskId: 'spoofed-task',
          worktreePath: '/repo/.arena/a',
        },
        'browser-client-1',
        vi.fn(),
        vi.fn(() => null),
      ),
    ).toEqual({
      branchName: 'arena/a',
      projectRoot: '/repo',
      squash: true,
      worktreePath: '/repo/.arena/a',
    });
  });

  it('injects browser controller identity into task container mutations', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.ContainersStartTask,
        {
          controllerId: 'spoofed-client',
          projectPath: '/repo',
          taskId: 'task-1',
          worktreePath: '/repo/.worktrees/task-1',
        },
        'browser-client-1',
      ),
    ).toEqual({
      controllerId: 'browser-client-1',
      projectPath: '/repo',
      taskId: 'task-1',
      worktreePath: '/repo/.worktrees/task-1',
    });
  });

  it('removes spoofed task mutation identity when the browser client identity is missing', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.CleanupTaskRuntime,
        {
          agentIds: [],
          controllerId: 'spoofed-client',
          removeTaskState: true,
          taskId: 'task-1',
        },
        null,
      ),
    ).toEqual({
      agentIds: [],
      removeTaskState: true,
    });
  });

  it('does not add controller identity to unrelated IPC channels', () => {
    const args = { json: '{}' };

    expect(normalizeBrowserIpcTaskCommandArgs(IPC.SaveAppState, args, 'client-1')).toBe(args);
  });
});
