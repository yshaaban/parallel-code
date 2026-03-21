import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import type { HandlerContext } from './handler-context.js';

const {
  cleanupTaskRuntimeWorkflowMock,
  createTaskWorkflowMock,
  deleteTaskWorkflowMock,
  getFileDiffFromBranchMock,
  getGitRepoRootMock,
  isTaskCommandLeaseHeldMock,
} = vi.hoisted(() => ({
  cleanupTaskRuntimeWorkflowMock: vi.fn(),
  createTaskWorkflowMock: vi.fn(),
  deleteTaskWorkflowMock: vi.fn(),
  getFileDiffFromBranchMock: vi.fn(),
  getGitRepoRootMock: vi.fn(),
  isTaskCommandLeaseHeldMock: vi.fn(),
}));

vi.mock('./task-workflows.js', () => ({
  cleanupTaskRuntimeWorkflow: cleanupTaskRuntimeWorkflowMock,
  createTaskWorkflow: createTaskWorkflowMock,
  deleteTaskWorkflow: deleteTaskWorkflowMock,
}));

vi.mock('./task-command-leases.js', () => ({
  isTaskCommandLeaseHeld: isTaskCommandLeaseHeldMock,
}));

vi.mock('./git.js', async () => {
  const actual = await vi.importActual<typeof import('./git.js')>('./git.js');
  return {
    ...actual,
    getFileDiffFromBranch: getFileDiffFromBranchMock,
    getGitRepoRoot: getGitRepoRootMock,
  };
});

import { createTaskAndGitIpcHandlers } from './task-git-handlers.js';

function createContext(): HandlerContext {
  return {
    isPackaged: false,
    sendToChannel: vi.fn(),
    userDataPath: '/tmp/parallel-code-task-git-handlers-test',
  };
}

describe('createTaskAndGitIpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('cleans backend task runtime without deleting registry metadata for collapse-style cleanup', () => {
    cleanupTaskRuntimeWorkflowMock.mockReturnValue(undefined);
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    handlers[IPC.CleanupTaskRuntime]?.({
      agentIds: ['agent-1'],
      controllerId: 'client-1',
      taskId: 'task-1',
    });

    expect(cleanupTaskRuntimeWorkflowMock).toHaveBeenCalledWith({
      agentIds: ['agent-1'],
      removeTaskState: false,
      taskId: 'task-1',
    });
    expect(taskRegistry.deleteTask).not.toHaveBeenCalled();
  });

  it('removes registry metadata when runtime cleanup is final', () => {
    cleanupTaskRuntimeWorkflowMock.mockReturnValue(undefined);
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    handlers[IPC.CleanupTaskRuntime]?.({
      agentIds: ['agent-1'],
      controllerId: 'client-1',
      removeTaskState: true,
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-auth',
    });

    expect(cleanupTaskRuntimeWorkflowMock).toHaveBeenCalledWith({
      agentIds: ['agent-1'],
      removeTaskState: true,
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-auth',
    });
    expect(taskRegistry.deleteTask).toHaveBeenCalledWith('task-1');
  });

  it('rejects runtime cleanup when another client holds the task lease', () => {
    cleanupTaskRuntimeWorkflowMock.mockReturnValue(undefined);
    isTaskCommandLeaseHeldMock.mockReturnValue(false);
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    expect(() =>
      handlers[IPC.CleanupTaskRuntime]?.({
        agentIds: ['agent-1'],
        controllerId: 'client-2',
        removeTaskState: true,
        taskId: 'task-1',
      }),
    ).toThrow('Task is controlled by another client');

    expect(cleanupTaskRuntimeWorkflowMock).not.toHaveBeenCalled();
    expect(taskRegistry.deleteTask).not.toHaveBeenCalled();
  });

  it('registers the repo-root query handler through the git transport seam', async () => {
    getGitRepoRootMock.mockResolvedValue('/tmp/project');
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(handlers[IPC.GetGitRepoRoot]?.({ path: '/tmp/project' })).resolves.toBe(
      '/tmp/project',
    );

    expect(getGitRepoRootMock).toHaveBeenCalledWith('/tmp/project');
  });

  it('forwards optional changed-file status on branch diff requests', async () => {
    getFileDiffFromBranchMock.mockResolvedValue({
      diff: 'diff --git a/src/new.ts b/src/new.ts',
      newContent: 'next',
      oldContent: '',
    });
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.GetFileDiffFromBranch]?.({
        branchName: 'feature/task-1',
        filePath: 'src/new.ts',
        projectRoot: '/tmp/project',
        status: 'A',
      }),
    ).resolves.toEqual({
      diff: 'diff --git a/src/new.ts b/src/new.ts',
      newContent: 'next',
      oldContent: '',
    });

    expect(getFileDiffFromBranchMock).toHaveBeenCalledWith(
      '/tmp/project',
      'feature/task-1',
      'src/new.ts',
      { status: 'A' },
    );
  });
});
