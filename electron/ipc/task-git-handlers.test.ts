import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import type { HandlerContext } from './handler-context.js';

const {
  cleanupTaskRuntimeWorkflowMock,
  createTaskWorkflowMock,
  deleteTaskWorkflowMock,
  getBranchCommitHistoryMock,
  getFileDiffFromBranchMock,
  getGitRepoRootMock,
  listImportableWorktreesMock,
  isTaskCommandLeaseHeldMock,
} = vi.hoisted(() => ({
  cleanupTaskRuntimeWorkflowMock: vi.fn(),
  createTaskWorkflowMock: vi.fn(),
  deleteTaskWorkflowMock: vi.fn(),
  getBranchCommitHistoryMock: vi.fn(),
  getFileDiffFromBranchMock: vi.fn(),
  getGitRepoRootMock: vi.fn(),
  listImportableWorktreesMock: vi.fn(),
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
    getBranchCommitHistory: getBranchCommitHistoryMock,
    getFileDiffFromBranch: getFileDiffFromBranchMock,
    getGitRepoRoot: getGitRepoRootMock,
    listImportableWorktrees: listImportableWorktreesMock,
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
    cleanupTaskRuntimeWorkflowMock.mockReturnValue({
      releasedTaskCommandController: null,
    });
    deleteTaskWorkflowMock.mockResolvedValue({
      releasedTaskCommandController: null,
    });
  });

  it('registers created task metadata through the shared registry owner', async () => {
    createTaskWorkflowMock.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/auth',
      worktree_path: '/tmp/project/.worktrees/task-auth',
      base_branch: 'main',
      git_isolation: 'worktree',
    });
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    const result = await handlers[IPC.CreateTask]?.({
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchPrefix: 'task',
      name: 'Auth Task',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      symlinkDirs: [],
      stepsTracking: true,
    });

    expect(createTaskWorkflowMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ branchPrefix: 'task', stepsTracking: true }),
    );
    expect(taskRegistry.registerCreatedTask).toHaveBeenCalledWith('task-1', {
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchName: 'task/auth',
      directMode: false,
      taskName: 'Auth Task',
      worktreePath: '/tmp/project/.worktrees/task-auth',
      worktreeOwnership: 'managed',
    });
    expect(result).toEqual({
      id: 'task-1',
      branch_name: 'task/auth',
      worktree_path: '/tmp/project/.worktrees/task-auth',
      base_branch: 'main',
      git_isolation: 'worktree',
    });
  });

  it('routes current-branch task creation through backend workflow metadata', async () => {
    createTaskWorkflowMock.mockResolvedValue({
      id: 'task-2',
      branch_name: 'personal/main',
      worktree_path: '/tmp/project',
      base_branch: 'personal/main',
      git_isolation: 'current-branch',
    });
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    const result = await handlers[IPC.CreateTask]?.({
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      baseBranch: 'personal/main',
      gitIsolation: 'current-branch',
      branchPrefix: 'task',
      name: 'Direct Task',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      symlinkDirs: [],
    });

    expect(createTaskWorkflowMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        baseBranch: 'personal/main',
        gitIsolation: 'current-branch',
      }),
    );
    expect(taskRegistry.registerCreatedTask).toHaveBeenCalledWith('task-2', {
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchName: 'personal/main',
      directMode: true,
      taskName: 'Direct Task',
      worktreePath: '/tmp/project',
      worktreeOwnership: 'managed',
    });
    expect(result).toEqual({
      id: 'task-2',
      branch_name: 'personal/main',
      worktree_path: '/tmp/project',
      base_branch: 'personal/main',
      git_isolation: 'current-branch',
    });
  });

  it('routes existing-worktree imports through backend workflow metadata without direct mode', async () => {
    createTaskWorkflowMock.mockResolvedValue({
      id: 'task-3',
      branch_name: 'task/imported',
      worktree_path: '/tmp/imported-worktree',
      base_branch: 'main',
      git_isolation: 'existing-worktree',
    });
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    const result = await handlers[IPC.CreateTask]?.({
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      baseBranch: 'main',
      branchPrefix: 'task',
      existingWorktreePath: '/tmp/imported-worktree',
      gitIsolation: 'existing-worktree',
      name: 'Imported Task',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      symlinkDirs: [],
    });

    expect(createTaskWorkflowMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        existingWorktreePath: '/tmp/imported-worktree',
        gitIsolation: 'existing-worktree',
      }),
    );
    expect(taskRegistry.registerCreatedTask).toHaveBeenCalledWith('task-3', {
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchName: 'task/imported',
      directMode: false,
      taskName: 'Imported Task',
      worktreePath: '/tmp/imported-worktree',
      worktreeOwnership: 'external',
    });
    expect(result).toEqual({
      id: 'task-3',
      branch_name: 'task/imported',
      worktree_path: '/tmp/imported-worktree',
      base_branch: 'main',
      git_isolation: 'existing-worktree',
    });
  });

  it('rejects malformed branch prefixes at the task creation boundary', async () => {
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    await expect(
      handlers[IPC.CreateTask]?.({
        branchPrefix: 'feature..bad',
        name: 'Bad Branch Task',
        projectId: 'project-1',
        projectRoot: '/tmp/project',
        symlinkDirs: [],
      }),
    ).rejects.toThrow('branchPrefix must be a valid branch name');

    expect(createTaskWorkflowMock).not.toHaveBeenCalled();
    expect(taskRegistry.registerCreatedTask).not.toHaveBeenCalled();
  });

  it('rejects malformed optional base branches before git handlers run', async () => {
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    expect(() =>
      handlers[IPC.GetChangedFiles]?.({
        baseBranch: 'feature..bad',
        worktreePath: '/tmp/project',
      }),
    ).toThrow('baseBranch must be a valid branch name');
  });

  it('rejects malformed branch names before branch diff handlers run', async () => {
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    expect(() =>
      handlers[IPC.GetFileDiffFromBranch]?.({
        branchName: 'feature..bad',
        filePath: 'src/new.ts',
        projectRoot: '/tmp/project',
      }),
    ).toThrow('branchName must be a valid branch name');

    expect(getFileDiffFromBranchMock).not.toHaveBeenCalled();
  });

  it('removes created task metadata through the shared registry owner on delete', async () => {
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

  it('emits released task command ownership when deleting a controlled task', async () => {
    const releasedController = {
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 2,
    };
    deleteTaskWorkflowMock.mockResolvedValue({
      releasedTaskCommandController: releasedController,
    });
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const context = {
      ...createContext(),
      emitIpcEvent: vi.fn(),
    };
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(context, taskRegistry);

    await handlers[IPC.DeleteTask]?.({
      agentIds: [],
      branchName: 'task/auth',
      controllerId: 'client-1',
      deleteBranch: true,
      projectRoot: '/tmp/project',
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-auth',
    });

    expect(context.emitIpcEvent).toHaveBeenCalledWith(
      IPC.TaskCommandControllerChanged,
      releasedController,
    );
  });

  it('rejects task deletion when another client keeps the task lease', async () => {
    isTaskCommandLeaseHeldMock.mockReturnValue(false);
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    await expect(
      handlers[IPC.DeleteTask]?.({
        agentIds: ['agent-1'],
        branchName: 'task/auth',
        controllerId: 'client-2',
        deleteBranch: true,
        projectRoot: '/tmp/project',
        taskId: 'task-1',
        worktreePath: '/tmp/project/.worktrees/task-auth',
      }),
    ).rejects.toThrow('Task is controlled by another client');

    expect(deleteTaskWorkflowMock).not.toHaveBeenCalled();
    expect(taskRegistry.deleteTask).not.toHaveBeenCalled();
  });

  it('cleans backend task runtime without deleting registry metadata for collapse-style cleanup', () => {
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

  it('emits released task command ownership when runtime cleanup is final', () => {
    const releasedController = {
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 2,
    };
    cleanupTaskRuntimeWorkflowMock.mockReturnValue({
      releasedTaskCommandController: releasedController,
    });
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const context = {
      ...createContext(),
      emitIpcEvent: vi.fn(),
    };
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(context, taskRegistry);

    handlers[IPC.CleanupTaskRuntime]?.({
      agentIds: ['agent-1'],
      controllerId: 'client-1',
      removeTaskState: true,
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-auth',
    });

    expect(context.emitIpcEvent).toHaveBeenCalledWith(
      IPC.TaskCommandControllerChanged,
      releasedController,
    );
  });

  it('rejects runtime cleanup when another client holds the task lease', () => {
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

  it('registers the importable worktree discovery handler through the git transport seam', async () => {
    listImportableWorktreesMock.mockResolvedValue([
      {
        branchName: 'task/imported',
        has_committed_changes: true,
        has_uncommitted_changes: false,
        path: '/tmp/project/.worktrees/imported',
      },
    ]);
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.ListImportableWorktrees]?.({
        baseBranch: 'main',
        projectRoot: '/tmp/project',
        registeredWorktreePaths: ['/tmp/project/.worktrees/registered'],
      }),
    ).resolves.toEqual([
      {
        branchName: 'task/imported',
        has_committed_changes: true,
        has_uncommitted_changes: false,
        path: '/tmp/project/.worktrees/imported',
      },
    ]);

    expect(listImportableWorktreesMock).toHaveBeenCalledWith('/tmp/project', {
      baseBranch: 'main',
      registeredWorktreePaths: ['/tmp/project/.worktrees/registered'],
    });
  });

  it('registers the branch commit history handler through the git transport seam', async () => {
    getBranchCommitHistoryMock.mockResolvedValue({
      baseHash: 'base',
      commits: [],
      headHash: 'head',
      revisionId: 'base:head',
    });
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.GetBranchCommitHistory]?.({
        baseBranch: 'main',
        branchName: 'feature/task',
        projectRoot: '/tmp/project',
      }),
    ).resolves.toEqual({
      baseHash: 'base',
      commits: [],
      headHash: 'head',
      revisionId: 'base:head',
    });

    expect(getBranchCommitHistoryMock).toHaveBeenCalledWith({
      baseBranch: 'main',
      branchName: 'feature/task',
      projectRoot: '/tmp/project',
    });
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
        baseBranch: 'release/main',
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
      'release/main',
    );
  });

  it('forwards commit-scoped branch diff requests', async () => {
    getFileDiffFromBranchMock.mockResolvedValue({
      diff: 'diff --git a/src/shared.ts b/src/shared.ts',
      newContent: 'commit version',
      oldContent: 'parent version',
    });
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.GetFileDiffFromBranch]?.({
        branchName: 'feature/task-1',
        commitHash: 'abc1234',
        filePath: 'src/shared.ts',
        projectRoot: '/tmp/project',
        status: 'M',
      }),
    ).resolves.toEqual({
      diff: 'diff --git a/src/shared.ts b/src/shared.ts',
      newContent: 'commit version',
      oldContent: 'parent version',
    });

    expect(getFileDiffFromBranchMock).toHaveBeenCalledWith(
      '/tmp/project',
      'feature/task-1',
      'src/shared.ts',
      { commitHash: 'abc1234', status: 'M' },
      undefined,
    );
  });
});
