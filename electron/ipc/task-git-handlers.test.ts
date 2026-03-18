import { describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import type { HandlerContext } from './handler-context.js';

const { createTaskWorkflowMock, deleteTaskWorkflowMock, isTaskCommandLeaseHeldMock } = vi.hoisted(
  () => ({
    createTaskWorkflowMock: vi.fn(),
    deleteTaskWorkflowMock: vi.fn(),
    isTaskCommandLeaseHeldMock: vi.fn(),
  }),
);

vi.mock('./task-workflows.js', () => ({
  createTaskWorkflow: createTaskWorkflowMock,
  deleteTaskWorkflow: deleteTaskWorkflowMock,
}));

vi.mock('./task-command-leases.js', () => ({
  isTaskCommandLeaseHeld: isTaskCommandLeaseHeldMock,
}));

import { createTaskAndGitIpcHandlers } from './task-git-handlers.js';

function createContext(): HandlerContext {
  return {
    isPackaged: false,
    sendToChannel: vi.fn(),
    userDataPath: '/tmp/parallel-code-task-git-handlers-test',
  };
}

describe('createTaskAndGitIpcHandlers', () => {
  it('registers created task metadata through the shared registry owner', async () => {
    createTaskWorkflowMock.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/auth',
      worktree_path: '/tmp/project/.worktrees/task-auth',
    });
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    const result = await handlers[IPC.CreateTask]?.({
      branchPrefix: 'task',
      name: 'Auth Task',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      symlinkDirs: [],
    });

    expect(taskRegistry.registerCreatedTask).toHaveBeenCalledWith('task-1', {
      branchName: 'task/auth',
      directMode: false,
      taskName: 'Auth Task',
      worktreePath: '/tmp/project/.worktrees/task-auth',
    });
    expect(result).toEqual({
      id: 'task-1',
      branch_name: 'task/auth',
      worktree_path: '/tmp/project/.worktrees/task-auth',
    });
  });

  it('removes created task metadata through the shared registry owner on delete', async () => {
    deleteTaskWorkflowMock.mockResolvedValue(undefined);
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    await handlers[IPC.DeleteTask]?.({
      agentIds: [],
      branchName: 'task/auth',
      controllerId: 'client-1',
      deleteBranch: true,
      projectRoot: '/tmp/project',
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-auth',
    });

    expect(taskRegistry.deleteTask).toHaveBeenCalledWith('task-1');
  });
});
