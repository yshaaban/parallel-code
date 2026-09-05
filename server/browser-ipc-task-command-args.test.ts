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

  it('rejects process-admitting channels when browser client identity is missing', () => {
    for (const channel of [
      IPC.SpawnAgent,
      IPC.AttachTerminalSession,
      IPC.EnsureAgentSessionsBatch,
    ]) {
      expect(() => normalizeBrowserIpcTaskCommandArgs(channel, { taskId: 'task-1' }, null)).toThrow(
        'Browser client identity is required for terminal session admission',
      );
    }
  });

  it('injects browser controller identity into spawned agents', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.SpawnAgent,
        { replaceExistingSession: true, taskId: 'task-1' },
        'client-1',
      ),
    ).toEqual({
      controllerId: 'client-1',
      replaceExistingSession: true,
      taskId: 'task-1',
    });
  });

  it('preserves task watcher ownership while normalizing a terminal attach', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.AttachTerminalSession,
        {
          clientId: 'spoofed-client',
          compatibilityIntent: 'create',
          controllerId: 'spoofed-client',
          isShell: true,
          sessionOwner: 'compatibility-shell',
          startsTaskWatchers: true,
          taskId: 'task-1',
        },
        'browser-client-1',
      ),
    ).toEqual({
      clientId: 'browser-client-1',
      compatibilityIntent: 'create',
      controllerId: 'browser-client-1',
      isShell: true,
      sessionOwner: 'compatibility-shell',
      startsTaskWatchers: true,
      taskId: 'task-1',
    });
  });

  it('does not inject task-command authority into managed terminal restore', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.AttachTerminalSession,
        {
          agentId: 'agent-1',
          controllerId: 'spoofed-client',
          sessionOwner: 'managed-agent',
          taskId: 'task-1',
        },
        'browser-client-1',
      ),
    ).toEqual({
      agentId: 'agent-1',
      clientId: 'browser-client-1',
      sessionOwner: 'managed-agent',
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
          taskId: 'task-1',
        },
      ],
    });
  });

  it('injects browser client identity into task-command lease requests', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.ReleaseTaskCommandLease,
        {
          clientId: 'spoofed-client',
          leaseGeneration: 3,
          ownerId: 'owner-1',
          taskId: 'task-1',
        },
        'browser-client-1',
      ),
    ).toEqual({
      clientId: 'browser-client-1',
      leaseGeneration: 3,
      ownerId: 'owner-1',
      taskId: 'task-1',
    });
  });

  it('strips task-command lease client identity when the browser client identity is missing', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.RenewTaskCommandLease,
        {
          clientId: 'spoofed-client',
          leaseGeneration: 3,
          ownerId: 'owner-1',
          taskId: 'task-1',
        },
        null,
      ),
    ).toEqual({
      leaseGeneration: 3,
      ownerId: 'owner-1',
      taskId: 'task-1',
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

  it('binds semantic prompt input to authenticated control and backend agent ownership', () => {
    const getAgentTaskId = vi.fn(() => 'task-from-agent');

    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.SendTaskPromptInput,
        {
          agentId: 'agent-1',
          controllerId: 'spoofed-client',
          taskId: 'spoofed-task',
          text: 'continue',
        },
        'client-1',
        getAgentTaskId,
      ),
    ).toEqual({
      agentId: 'agent-1',
      controllerId: 'client-1',
      taskId: 'task-from-agent',
      text: 'continue',
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

  it('injects browser controller identity into coordinator UI actions', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.CoordinatorUiToolCall,
        {
          controllerId: 'spoofed-client',
          coordinatorTaskId: 'task-coordinator',
          requestId: 'request-1',
          runId: 'run-1',
          toolName: 'send_prompt',
        },
        'browser-client-1',
      ),
    ).toEqual({
      controllerId: 'browser-client-1',
      coordinatorTaskId: 'task-coordinator',
      requestId: 'request-1',
      runId: 'run-1',
      toolName: 'send_prompt',
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
    expect(getWorktreeTaskId).toHaveBeenCalledWith('/repo/.worktrees/task-1', 'spoofed-task');
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

  it('retains the requested shared-root task after backend membership resolution', () => {
    const getWorktreeTaskId = vi.fn((_path: string, taskId?: string) =>
      taskId === 'root-2' ? 'root-2' : 'root-1',
    );
    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.CommitAll,
        {
          message: 'shared root change',
          taskId: 'root-2',
          controllerId: 'forged',
          worktreePath: '/repo',
        },
        'client-2',
        () => undefined,
        getWorktreeTaskId,
      ),
    ).toMatchObject({ taskId: 'root-2', controllerId: 'client-2' });
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
