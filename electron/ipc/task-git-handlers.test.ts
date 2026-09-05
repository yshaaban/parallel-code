import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import type { HandlerContext } from './handler-context.js';
import type { WorkspaceTaskMergeLegacyWriterGate } from './task-merge-legacy-writer-gate.js';
import type { WorkspaceTaskRemovalLegacyWriterGate } from './task-removal-legacy-writer-gate.js';
import type {
  TaskRemovalDispatchResult,
  TaskStructureMutationService,
} from './task-structure-mutations.js';
import type { WorkspaceMutationService } from './workspace-state-mutations.js';

const {
  cleanupTaskRuntimeWorkflowMock,
  cleanupCoordinatorTaskStateAndOwnedSubtasksMock,
  commitAllWorkflowMock,
  createWorktreeMock,
  createTaskWorkflowMock,
  deleteTaskWorkflowMock,
  discardUncommittedWorkflowMock,
  destroyManagedTaskContainersByLabelsMock,
  executeCoordinatorProducerMock,
  findRegisteredTaskIdForWorktreePathMock,
  getBranchCommitHistoryMock,
  getFileDiffFromBranchMock,
  getGitRepoRootMock,
  getWorktreeSymlinkCandidatesMock,
  listBranchesMock,
  listImportableWorktreesMock,
  mergeTaskMock,
  rebaseTaskWorkflowMock,
  removeWorktreeMock,
  isTaskCommandLeaseHeldMock,
  streamPushTaskMock,
  stopTaskAgentWorkflowsForTaskMock,
} = vi.hoisted(() => ({
  cleanupTaskRuntimeWorkflowMock: vi.fn(),
  cleanupCoordinatorTaskStateAndOwnedSubtasksMock: vi.fn(),
  commitAllWorkflowMock: vi.fn(),
  createWorktreeMock: vi.fn(),
  createTaskWorkflowMock: vi.fn(),
  deleteTaskWorkflowMock: vi.fn(),
  discardUncommittedWorkflowMock: vi.fn(),
  destroyManagedTaskContainersByLabelsMock: vi.fn(),
  executeCoordinatorProducerMock: vi.fn(
    async (_context: unknown, operation: () => Promise<unknown> | unknown) => operation(),
  ),
  findRegisteredTaskIdForWorktreePathMock: vi.fn(),
  getBranchCommitHistoryMock: vi.fn(),
  getFileDiffFromBranchMock: vi.fn(),
  getGitRepoRootMock: vi.fn(),
  getWorktreeSymlinkCandidatesMock: vi.fn(),
  listBranchesMock: vi.fn(),
  listImportableWorktreesMock: vi.fn(),
  mergeTaskMock: vi.fn(),
  rebaseTaskWorkflowMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  isTaskCommandLeaseHeldMock: vi.fn(),
  streamPushTaskMock: vi.fn(),
  stopTaskAgentWorkflowsForTaskMock: vi.fn(),
}));

vi.mock('../coordinator/tool-gateway.js', () => ({
  cleanupCoordinatorTaskStateAndOwnedSubtasks: cleanupCoordinatorTaskStateAndOwnedSubtasksMock,
  executeCoordinatorProducer: executeCoordinatorProducerMock,
}));

vi.mock('./task-workflows.js', () => ({
  cleanupTaskRuntimeWorkflow: cleanupTaskRuntimeWorkflowMock,
  createTaskWorkflow: createTaskWorkflowMock,
  deleteTaskWorkflow: deleteTaskWorkflowMock,
  findRegisteredTaskIdForWorktreePath: findRegisteredTaskIdForWorktreePathMock,
  hasRegisteredSharedRootTask: vi.fn(() => false),
  stopTaskAgentWorkflowsForTask: stopTaskAgentWorkflowsForTaskMock,
}));

vi.mock('./task-command-leases.js', () => ({
  isTaskCommandLeaseHeld: isTaskCommandLeaseHeldMock,
}));

vi.mock('./task-containers.js', () => ({
  destroyManagedTaskContainersByLabels: destroyManagedTaskContainersByLabelsMock,
}));

vi.mock('./git-status-workflows.js', () => ({
  commitAllWorkflow: commitAllWorkflowMock,
  discardUncommittedWorkflow: discardUncommittedWorkflowMock,
  rebaseTaskWorkflow: rebaseTaskWorkflowMock,
  scheduleTaskConvergenceRefreshForGitTarget: vi.fn(),
  scheduleTaskReviewRefreshForGitTarget: vi.fn(),
}));

vi.mock('./task-review-signals.js', () => ({
  scheduleTaskReviewSignalsRefresh: vi.fn(),
}));

vi.mock('./git.js', async () => {
  const actual = await vi.importActual<typeof import('./git.js')>('./git.js');
  return {
    ...actual,
    createWorktree: createWorktreeMock,
    getBranchCommitHistory: getBranchCommitHistoryMock,
    getFileDiffFromBranch: getFileDiffFromBranchMock,
    getGitRepoRoot: getGitRepoRootMock,
    listBranches: listBranchesMock,
    listImportableWorktrees: listImportableWorktreesMock,
    mergeTask: mergeTaskMock,
    removeWorktree: removeWorktreeMock,
    streamPushTask: streamPushTaskMock,
  };
});

vi.mock('./git-worktree-symlinks.js', async () => {
  const actual = await vi.importActual<typeof import('./git-worktree-symlinks.js')>(
    './git-worktree-symlinks.js',
  );
  return {
    ...actual,
    getWorktreeSymlinkCandidates: getWorktreeSymlinkCandidatesMock,
  };
});

import { createTaskAndGitIpcHandlers, executeBackendTaskMergeGit } from './task-git-handlers.js';

function createContext(): HandlerContext {
  return {
    isPackaged: false,
    sendToChannel: vi.fn(),
    userDataPath: '/tmp/parallel-code-task-git-handlers-test',
  };
}

function createWorkspaceMutationContext() {
  const addTask = vi.fn().mockResolvedValue({
    changed: true,
    result: { task: {}, taskId: 'task-1' },
    revision: 1,
  });
  const removeTask = vi.fn().mockResolvedValue({
    changed: true,
    result: { removed: true, taskId: 'task-1' },
    revision: 2,
  });
  const removeTaskWithLegacyFallback = vi.fn(
    async (
      mutation: { operation: string },
      taskId: string,
      effect: () => Promise<unknown>,
    ): Promise<TaskRemovalDispatchResult<unknown>> => ({
      effectResult: await effect(),
      kind: 'legacy-fallback',
      removal: await removeTask(mutation, taskId),
    }),
  );
  const taskStructure = {
    addTask,
    removeTask,
    removeTaskWithLegacyFallback,
  } as unknown as TaskStructureMutationService;
  const runLegacyRemoval = vi.fn(async <TResult>(effect: () => Promise<TResult>) => effect());
  const context: HandlerContext = {
    ...createContext(),
    workspaceMutations: {
      getTaskMergeLegacyWriterGate: vi.fn(
        async () =>
          ({
            runLegacyMerge: async <TResult>(effect: () => Promise<TResult>) => effect(),
          }) as WorkspaceTaskMergeLegacyWriterGate,
      ),
      getTaskRemovalLegacyWriterGate: vi.fn(
        async () => ({ runLegacyRemoval }) as unknown as WorkspaceTaskRemovalLegacyWriterGate,
      ),
      getTaskStructureService: vi.fn(async () => taskStructure),
      getWorkspaceService: vi.fn(async () => ({}) as WorkspaceMutationService),
    },
  };
  return { addTask, context, removeTask, removeTaskWithLegacyFallback, runLegacyRemoval };
}

describe('createTaskAndGitIpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeCoordinatorProducerMock.mockImplementation(
      async (_context: unknown, operation: () => Promise<unknown> | unknown) => operation(),
    );
    cleanupTaskRuntimeWorkflowMock.mockReturnValue({
      releasedTaskCommandController: null,
    });
    cleanupCoordinatorTaskStateAndOwnedSubtasksMock.mockResolvedValue([]);
    deleteTaskWorkflowMock.mockResolvedValue({
      cleanupWarnings: [],
      releasedTaskCommandController: null,
    });
    mergeTaskMock.mockResolvedValue({
      lines_added: 0,
      lines_removed: 0,
    });
    commitAllWorkflowMock.mockResolvedValue(undefined);
    createWorktreeMock.mockResolvedValue({
      branch: 'arena/test',
      path: '/tmp/project/.worktrees/arena/test',
    });
    discardUncommittedWorkflowMock.mockResolvedValue(undefined);
    destroyManagedTaskContainersByLabelsMock.mockResolvedValue(undefined);
    rebaseTaskWorkflowMock.mockResolvedValue(undefined);
    removeWorktreeMock.mockResolvedValue(undefined);
    streamPushTaskMock.mockResolvedValue(undefined);
    stopTaskAgentWorkflowsForTaskMock.mockResolvedValue(undefined);
    findRegisteredTaskIdForWorktreePathMock.mockReturnValue(null);
    getGitRepoRootMock.mockResolvedValue('/tmp/project');
    getWorktreeSymlinkCandidatesMock.mockResolvedValue({
      candidates: [],
      truncated: false,
    });
  });

  it('forces cleanup off in the backend operation adapter', async () => {
    mergeTaskMock.mockResolvedValueOnce({
      lines_added: 11,
      lines_removed: 4,
      main_branch: 'main',
    });

    await expect(
      executeBackendTaskMergeGit({
        branchName: 'task/auth',
        cleanup: false,
        message: 'Merge safely',
        projectRoot: '/tmp/project',
        squash: true,
        taskId: 'task-1',
        worktreePath: '/tmp/project/.worktrees/task-auth',
      }),
    ).resolves.toEqual({ linesAdded: 11, linesRemoved: 4 });
    expect(mergeTaskMock).toHaveBeenCalledWith(
      '/tmp/project',
      '/tmp/project/.worktrees/task-auth',
      'task/auth',
      true,
      'Merge safely',
      false,
      undefined,
      expect.any(Function),
    );
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
      markTaskClosing: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    const result = await handlers[IPC.CreateTask]?.({
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchPrefix: 'task',
      name: 'Auth Task',
      operationId: 'create-task-1',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      symlinkDirs: [],
      stepsTracking: true,
    });

    expect(createTaskWorkflowMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentDefId: 'codex',
        agentDefName: 'Codex CLI',
        branchPrefix: 'task',
        operationId: 'create-task-1',
        stepsTracking: true,
      }),
    );
    expect(taskRegistry.registerCreatedTask).toHaveBeenCalledWith('task-1', {
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchName: 'task/auth',
      directMode: false,
      gitIsolation: 'worktree',
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

  it('awaits managed creation activation before any effect and never falls back afterward', async () => {
    const { addTask, context } = createWorkspaceMutationContext();
    let activate: ((command: { create: ReturnType<typeof vi.fn> }) => void) | undefined;
    const activation = new Promise<{ create: ReturnType<typeof vi.fn> }>((resolve) => {
      activate = resolve;
    });
    const create = vi.fn(async () => ({
      agent_def_id: 'codex',
      agent_def_name: 'Canonical Codex',
      branch_name: 'task/managed',
      creation_writer_epoch: 'managed-initial-shell-v1' as const,
      git_isolation: 'worktree' as const,
      id: 'task-managed',
      project_mode: 'git' as const,
      session_id: 'session-managed',
      task_name: 'Canonical managed task',
      worktree_path: '/tmp/project/.worktrees/task-managed',
    }));
    context.getTaskCreationCommand = vi.fn(() => activation as never);
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(context, taskRegistry);

    const pending = handlers[IPC.CreateTask]?.({
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      coordinatorMode: true,
      initialPrompt: 'Coordinate this',
      name: 'Managed task',
      operationId: 'managed-operation-1',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      skipPermissions: true,
      symlinkDirs: [],
    });
    await Promise.resolve();

    expect(createTaskWorkflowMock).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    activate?.({ create });
    await expect(pending).resolves.toMatchObject({
      id: 'task-managed',
      session_id: 'session-managed',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDefId: 'codex',
        coordinatorMode: true,
        initialPrompt: 'Coordinate this',
        adapterOperationId: 'managed-operation-1',
        skipPermissions: true,
      }),
    );
    expect(createTaskWorkflowMock).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(taskRegistry.registerCreatedTask).toHaveBeenCalledWith(
      'task-managed',
      expect.objectContaining({
        agentDefId: 'codex',
        agentDefName: 'Canonical Codex',
        taskName: 'Canonical managed task',
      }),
    );
  });

  it('fails closed when managed creation activation fails', async () => {
    const context = createContext();
    context.getTaskCreationCommand = vi.fn(async () => {
      throw new Error('managed creation activation failed');
    });
    const handlers = createTaskAndGitIpcHandlers(context, {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.CreateTask]?.({
        name: 'No legacy fallback',
        operationId: 'managed-operation-2',
        projectId: 'project-1',
        projectRoot: '/tmp/project',
        symlinkDirs: [],
      }),
    ).rejects.toThrow('managed creation activation failed');
    expect(createTaskWorkflowMock).not.toHaveBeenCalled();
  });

  it('commits a backend-constructed task before publishing created task metadata', async () => {
    createTaskWorkflowMock.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/auth',
      worktree_path: '/tmp/project/.worktrees/task-auth',
      base_branch: 'main',
      git_isolation: 'worktree',
      project_mode: 'git',
    });
    const { addTask, context } = createWorkspaceMutationContext();
    const taskRegistry = {
      deleteTask: vi.fn(),
      markTaskClosing: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(context, taskRegistry);

    await handlers[IPC.CreateTask]?.({
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchPrefix: 'task',
      githubUrl: 'https://example.test/repo',
      name: 'Auth Task',
      operationId: 'create-task-1',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      symlinkDirs: [],
      stepsTracking: true,
    });

    expect(addTask).toHaveBeenCalledWith(
      { operation: 'create-task:create-task-1' },
      {
        baseBranch: 'main',
        branchName: 'task/auth',
        gitIsolation: 'worktree',
        githubUrl: 'https://example.test/repo',
        name: 'Auth Task',
        projectId: 'project-1',
        projectMode: 'git',
        projectRoot: '/tmp/project',
        stepsTracking: true,
        taskId: 'task-1',
        taskMode: 'agent',
        worktreePath: '/tmp/project/.worktrees/task-auth',
      },
    );
    expect(addTask.mock.invocationCallOrder[0]).toBeLessThan(
      taskRegistry.registerCreatedTask.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it.each(['', '   ', 'x'.repeat(129)])(
    'rejects malformed task operation id %j',
    async (operationId) => {
      const handlers = createTaskAndGitIpcHandlers(createContext(), {
        deleteTask: vi.fn(),
        registerCreatedTask: vi.fn(),
      });

      await expect(
        handlers[IPC.CreateTask]?.({
          name: 'Invalid operation',
          operationId,
          projectId: 'project-1',
          projectRoot: '/tmp/project',
          symlinkDirs: [],
        }),
      ).rejects.toThrow('operationId must be a non-empty string no longer than 128 characters');

      expect(createTaskWorkflowMock).not.toHaveBeenCalled();
    },
  );

  it('routes Arena link hints through the canonical V1 owner exactly once', async () => {
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.CreateArenaWorktree]?.({
        agentId: 'agent-arena',
        branchName: 'arena/test',
        projectRoot: '/tmp/project',
        symlinkDirs: ['z', 'a', 'z'],
        taskId: 'competitor-1',
      }),
    ).resolves.toEqual({
      branch: 'arena/test',
      launchToken: expect.any(String),
      path: '/tmp/project/.worktrees/arena/test',
    });

    expect(createWorktreeMock).toHaveBeenCalledWith(
      '/tmp/project',
      'arena/test',
      expect.objectContaining({
        encodedLength: 8,
        format: 1,
        names: ['a', 'z'],
      }),
      true,
    );
  });

  it('returns typed worktree symlink discovery instead of the compatibility name list', async () => {
    getWorktreeSymlinkCandidatesMock.mockResolvedValue({
      candidates: [
        {
          isDefault: true,
          name: 'node_modules',
        },
      ],
      truncated: false,
    });
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.GetGitignoredDirs]?.({ projectRoot: '/tmp/project' }),
    ).resolves.toEqual({
      candidates: [{ isDefault: true, name: 'node_modules' }],
      truncated: false,
    });
    expect(getWorktreeSymlinkCandidatesMock).toHaveBeenCalledWith('/tmp/project');
  });

  it('uses the backend-canonical repository root for Arena creation and removal', async () => {
    getGitRepoRootMock.mockResolvedValue('/real/project');
    createWorktreeMock.mockResolvedValue({
      branch: 'arena/canonical',
      path: '/real/project/.worktrees/arena/canonical',
    });
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.CreateArenaWorktree]?.({
        agentId: 'agent-arena',
        branchName: 'arena/canonical',
        projectRoot: '/alias/project',
        taskId: 'competitor-1',
      }),
    ).resolves.toEqual({
      branch: 'arena/canonical',
      launchToken: expect.any(String),
      path: '/real/project/.worktrees/arena/canonical',
    });
    await handlers[IPC.RemoveArenaWorktree]?.({
      branchName: 'arena/canonical',
      projectRoot: '/alias/project',
    });

    expect(getGitRepoRootMock).toHaveBeenNthCalledWith(1, '/alias/project');
    expect(getGitRepoRootMock).toHaveBeenNthCalledWith(2, '/alias/project');
    expect(createWorktreeMock).toHaveBeenCalledWith(
      '/real/project',
      'arena/canonical',
      expect.anything(),
      true,
    );
    expect(removeWorktreeMock).toHaveBeenCalledWith('/real/project', 'arena/canonical', true);
  });

  it('rejects Arena creation outside a backend-confirmed Git repository', async () => {
    getGitRepoRootMock.mockResolvedValue(null);
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.CreateArenaWorktree]?.({
        agentId: 'agent-arena',
        branchName: 'arena/untrusted',
        projectRoot: '/tmp/not-a-repository',
        taskId: 'competitor-1',
      }),
    ).rejects.toThrow('projectRoot must identify a Git repository');

    expect(createWorktreeMock).not.toHaveBeenCalled();
  });

  it.each([IPC.CreateArenaWorktree, IPC.RemoveArenaWorktree])(
    'rejects non-Arena branches on %s',
    async (channel) => {
      const handlers = createTaskAndGitIpcHandlers(createContext(), {
        deleteTask: vi.fn(),
        registerCreatedTask: vi.fn(),
      });
      const request =
        channel === IPC.CreateArenaWorktree
          ? {
              agentId: 'agent-arena',
              branchName: 'task/not-arena',
              projectRoot: '/tmp/project',
              taskId: 'competitor-1',
            }
          : {
              branchName: 'task/not-arena',
              projectRoot: '/tmp/project',
            };

      await expect(handlers[channel]?.(request)).rejects.toThrow(
        'branchName must be an arena branch',
      );
      expect(createWorktreeMock).not.toHaveBeenCalled();
      expect(removeWorktreeMock).not.toHaveBeenCalled();
    },
  );

  it('rejects oversized Arena link hints before worktree creation', async () => {
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.CreateArenaWorktree]?.({
        agentId: 'agent-arena',
        branchName: 'arena/oversized',
        projectRoot: '/tmp/project',
        symlinkDirs: Array(129).fill('cache'),
        taskId: 'competitor-1',
      }),
    ).rejects.toThrow('symlinkDirs must contain at most 128 entries');
    expect(createWorktreeMock).not.toHaveBeenCalled();
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
      operationId: 'create-task-2',
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
      gitIsolation: 'current-branch',
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
      operationId: 'create-task-3',
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
      gitIsolation: 'existing-worktree',
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

  it('routes non-git task creation without git ownership metadata', async () => {
    createTaskWorkflowMock.mockResolvedValue({
      id: 'task-4',
      branch_name: '',
      project_mode: 'non-git',
      worktree_path: '/tmp/folder',
    });
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    const result = await handlers[IPC.CreateTask]?.({
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      name: 'Folder Task',
      operationId: 'create-task-4',
      projectId: 'project-1',
      projectMode: 'non-git',
      projectRoot: '/tmp/folder',
      symlinkDirs: [],
    });

    expect(createTaskWorkflowMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectMode: 'non-git',
      }),
    );
    expect(taskRegistry.registerCreatedTask).toHaveBeenCalledWith('task-4', {
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      branchName: '',
      directMode: false,
      projectMode: 'non-git',
      taskName: 'Folder Task',
      worktreePath: '/tmp/folder',
      worktreeOwnership: null,
    });
    expect(result).toEqual({
      id: 'task-4',
      branch_name: '',
      project_mode: 'non-git',
      worktree_path: '/tmp/folder',
    });
  });

  it('rejects git-only fields on non-git task creation', async () => {
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.CreateTask]?.({
        baseBranch: 'main',
        name: 'Bad Folder Task',
        operationId: 'invalid-base-operation',
        projectId: 'project-1',
        projectMode: 'non-git',
        projectRoot: '/tmp/folder',
        symlinkDirs: [],
      }),
    ).rejects.toThrow('baseBranch is not valid for non-git tasks');
    await expect(
      handlers[IPC.CreateTask]?.({
        branchPrefix: 'task',
        name: 'Bad Folder Task',
        operationId: 'invalid-prefix-operation',
        projectId: 'project-1',
        projectMode: 'non-git',
        projectRoot: '/tmp/folder',
        symlinkDirs: [],
      }),
    ).rejects.toThrow('branchPrefix is not valid for non-git tasks');

    expect(createTaskWorkflowMock).not.toHaveBeenCalled();
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
        operationId: 'malformed-prefix-operation',
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
    const context = createContext();
    const taskRegistry = {
      deleteTask: vi.fn(),
      markTaskClosing: vi.fn(),
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

    expect(taskRegistry.deleteTask).toHaveBeenCalledWith('task-1');
    expect(taskRegistry.markTaskClosing).toHaveBeenCalledWith('task-1');
    expect(taskRegistry.markTaskClosing.mock.invocationCallOrder[0]).toBeLessThan(
      deleteTaskWorkflowMock.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(executeCoordinatorProducerMock).toHaveBeenCalledWith(context, expect.any(Function));
    expect(cleanupCoordinatorTaskStateAndOwnedSubtasksMock).toHaveBeenCalledWith(
      { context: expect.anything(), taskNames: taskRegistry },
      'task-1',
    );
  });

  it('commits canonical task removal before deleting registry metadata', async () => {
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const { context, removeTask, runLegacyRemoval } = createWorkspaceMutationContext();
    const taskRegistry = {
      deleteTask: vi.fn(),
      markTaskClosing: vi.fn(),
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

    expect(removeTask).toHaveBeenCalledWith({ operation: 'delete-task:task-1' }, 'task-1');
    expect(removeTask.mock.invocationCallOrder[0]).toBeLessThan(
      taskRegistry.deleteTask.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(runLegacyRemoval).toHaveBeenCalledTimes(1);
    expect(runLegacyRemoval.mock.invocationCallOrder[0]).toBeLessThan(
      deleteTaskWorkflowMock.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('routes managed-worktree deletion through the generic owner without legacy effects', async () => {
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const { context, removeTaskWithLegacyFallback, runLegacyRemoval } =
      createWorkspaceMutationContext();
    removeTaskWithLegacyFallback.mockResolvedValueOnce({
      kind: 'generic-owner',
      removal: {
        changed: true,
        result: {
          deletionOperationId: 'deletion-operation-1',
          removed: false,
          removalState: 'cleanup-pending',
          taskId: 'task-1',
        },
        revision: 3,
      },
    });
    const taskRegistry = {
      deleteTask: vi.fn(),
      markTaskClosing: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(context, taskRegistry);

    await expect(
      handlers[IPC.DeleteTask]?.({
        agentIds: ['renderer-stale-agent'],
        branchName: 'renderer/stale-branch',
        controllerId: 'client-1',
        deleteBranch: false,
        projectRoot: '/renderer/stale-project',
        taskId: 'task-1',
        worktreePath: '/renderer/stale-worktree',
      }),
    ).resolves.toEqual({ cleanupWarnings: [], removalState: 'cleanup-pending' });

    expect(removeTaskWithLegacyFallback).toHaveBeenCalledWith(
      { operation: 'delete-task:task-1' },
      'task-1',
      expect.any(Function),
    );
    expect(runLegacyRemoval).not.toHaveBeenCalled();
    expect(deleteTaskWorkflowMock).not.toHaveBeenCalled();
    expect(cleanupCoordinatorTaskStateAndOwnedSubtasksMock).not.toHaveBeenCalled();
    expect(taskRegistry.deleteTask).not.toHaveBeenCalled();
  });

  it('emits released task command ownership when deleting a controlled task', async () => {
    const releasedController = {
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 2,
    };
    deleteTaskWorkflowMock.mockResolvedValue({
      cleanupWarnings: [],
      releasedTaskCommandController: releasedController,
    });
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const context = {
      ...createContext(),
      emitIpcEvent: vi.fn(),
    };
    const taskRegistry = {
      deleteTask: vi.fn(),
      markTaskClosing: vi.fn(),
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

  it('returns cleanup warnings from task deletion workflow', async () => {
    deleteTaskWorkflowMock.mockResolvedValue({
      cleanupWarnings: [
        {
          kind: 'worktree',
          message: 'Failed to clean task worktree while deleting task: remove failed',
        },
      ],
      releasedTaskCommandController: null,
    });
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    const result = await handlers[IPC.DeleteTask]?.({
      agentIds: [],
      branchName: 'task/auth',
      controllerId: 'client-1',
      deleteBranch: true,
      projectRoot: '/tmp/project',
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-auth',
    });

    expect(result).toEqual({
      cleanupWarnings: [
        {
          kind: 'worktree',
          message: 'Failed to clean task worktree while deleting task: remove failed',
        },
      ],
    });
  });

  it('returns coordinator-owned subtask cleanup warnings from task deletion', async () => {
    cleanupCoordinatorTaskStateAndOwnedSubtasksMock.mockResolvedValue([
      {
        kind: 'worktree',
        message: 'Coordinator subtask task-child cleanup did not finish: remove failed',
      },
    ]);
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    const result = await handlers[IPC.DeleteTask]?.({
      agentIds: [],
      branchName: 'task/auth',
      controllerId: 'client-1',
      deleteBranch: true,
      projectRoot: '/tmp/project',
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-auth',
    });

    expect(result).toEqual({
      cleanupWarnings: [
        {
          kind: 'worktree',
          message: 'Coordinator subtask task-child cleanup did not finish: remove failed',
        },
      ],
    });
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

  it('revalidates the task lease after coordinator producer admission', async () => {
    let releaseAdmission: (() => void) | undefined;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    executeCoordinatorProducerMock.mockImplementationOnce(
      async (_context: unknown, operation: () => Promise<unknown> | unknown) => {
        await admission;
        return operation();
      },
    );
    isTaskCommandLeaseHeldMock.mockReturnValueOnce(true).mockReturnValue(false);
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    const deletion = handlers[IPC.DeleteTask]?.({
      agentIds: ['agent-1'],
      branchName: 'task/auth',
      controllerId: 'client-1',
      deleteBranch: true,
      projectRoot: '/tmp/project',
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-auth',
    });
    releaseAdmission?.();

    await expect(deletion).rejects.toThrow('Task is controlled by another client');
    expect(isTaskCommandLeaseHeldMock).toHaveBeenCalledTimes(2);
    expect(deleteTaskWorkflowMock).not.toHaveBeenCalled();
    expect(taskRegistry.deleteTask).not.toHaveBeenCalled();
  });

  it('rejects task deletion without lease identity before deleting anything', async () => {
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    await expect(
      handlers[IPC.DeleteTask]?.({
        agentIds: ['agent-1'],
        branchName: 'task/auth',
        deleteBranch: true,
        projectRoot: '/tmp/project',
        worktreePath: '/tmp/project/.worktrees/task-auth',
      }),
    ).rejects.toThrow('controllerId must be a string');

    expect(isTaskCommandLeaseHeldMock).not.toHaveBeenCalled();
    expect(deleteTaskWorkflowMock).not.toHaveBeenCalled();
    expect(taskRegistry.deleteTask).not.toHaveBeenCalled();
  });

  it('rejects task merge without lease identity before merging', () => {
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    expect(() =>
      handlers[IPC.MergeTask]?.({
        branchName: 'task/auth',
        projectRoot: '/tmp/project',
        squash: false,
        worktreePath: '/tmp/project/.worktrees/task-auth',
      }),
    ).toThrow('controllerId must be a string');

    expect(isTaskCommandLeaseHeldMock).not.toHaveBeenCalled();
    expect(mergeTaskMock).not.toHaveBeenCalled();
  });

  it('routes the legacy merge effect through the workspace cutover gate', async () => {
    const { context } = createWorkspaceMutationContext();
    const workspaceMutations = context.workspaceMutations;
    if (!workspaceMutations) throw new Error('workspace mutation host fixture is missing');
    const disabled = new Error('legacy merge disabled');
    const runLegacyMerge = vi.fn(async () => {
      throw disabled;
    });
    workspaceMutations.getTaskMergeLegacyWriterGate = vi.fn(
      async () => ({ runLegacyMerge }) as unknown as WorkspaceTaskMergeLegacyWriterGate,
    );
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const handlers = createTaskAndGitIpcHandlers(context, {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.MergeTask]?.({
        branchName: 'task/auth',
        controllerId: 'controller-1',
        projectRoot: '/tmp/project',
        squash: false,
        taskId: 'task-1',
        worktreePath: '/tmp/project/.worktrees/task-auth',
      }),
    ).rejects.toBe(disabled);

    expect(runLegacyMerge).toHaveBeenCalledOnce();
    expect(mergeTaskMock).not.toHaveBeenCalled();
  });

  it('rejects task pushes without lease identity before pushing', async () => {
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.PushTask]?.({
        branchName: 'task/auth',
        projectRoot: '/tmp/project',
      }),
    ).rejects.toThrow('controllerId must be a string');

    expect(isTaskCommandLeaseHeldMock).not.toHaveBeenCalled();
    expect(streamPushTaskMock).not.toHaveBeenCalled();
  });

  it('rejects task rebases without lease identity before rebasing', async () => {
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.RebaseTask]?.({
        worktreePath: '/tmp/project/.worktrees/task-auth',
      }),
    ).rejects.toThrow('controllerId must be a string');

    expect(isTaskCommandLeaseHeldMock).not.toHaveBeenCalled();
    expect(rebaseTaskWorkflowMock).not.toHaveBeenCalled();
  });

  it('requires a held task lease before committing a registered task worktree', async () => {
    findRegisteredTaskIdForWorktreePathMock.mockReturnValue('task-1');
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await handlers[IPC.CommitAll]?.({
      controllerId: 'client-1',
      message: 'task commit',
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-1',
    });

    expect(isTaskCommandLeaseHeldMock).toHaveBeenCalledWith('task-1', 'client-1');
    expect(commitAllWorkflowMock).toHaveBeenCalledWith(expect.anything(), {
      message: 'task commit',
      worktreePath: '/tmp/project/.worktrees/task-1',
    });
  });

  it('rejects registered task worktree commits without lease identity', async () => {
    findRegisteredTaskIdForWorktreePathMock.mockReturnValue('task-1');
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.CommitAll]?.({
        message: 'task commit',
        worktreePath: '/tmp/project/.worktrees/task-1',
      }),
    ).rejects.toThrow('taskId is required for task git mutations');

    expect(isTaskCommandLeaseHeldMock).not.toHaveBeenCalled();
    expect(commitAllWorkflowMock).not.toHaveBeenCalled();
  });

  it('uses the requested shared-root task membership and its exact command lease', async () => {
    findRegisteredTaskIdForWorktreePathMock.mockImplementation((_path: string, taskId?: string) =>
      taskId === 'root-2' ? 'root-2' : 'root-1',
    );
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });
    await handlers[IPC.CommitAll]?.({
      controllerId: 'client-2',
      message: 'shared changes',
      taskId: 'root-2',
      worktreePath: '/repo',
    });
    expect(isTaskCommandLeaseHeldMock).toHaveBeenCalledWith('root-2', 'client-2');
    await expect(
      handlers[IPC.CommitAll]?.({
        controllerId: 'client-2',
        message: 'invalid',
        taskId: 'unrelated-task',
        worktreePath: '/repo',
      }),
    ).rejects.toThrow('taskId must match');
    expect(commitAllWorkflowMock).toHaveBeenCalledOnce();
  });

  it('rejects registered task worktree discards when the lease is held by another client', async () => {
    findRegisteredTaskIdForWorktreePathMock.mockReturnValue('task-1');
    isTaskCommandLeaseHeldMock.mockReturnValue(false);
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.DiscardUncommitted]?.({
        controllerId: 'client-2',
        taskId: 'task-1',
        worktreePath: '/tmp/project/.worktrees/task-1',
      }),
    ).rejects.toThrow('Task is controlled by another client');

    expect(discardUncommittedWorkflowMock).not.toHaveBeenCalled();
  });

  it('keeps arena merges on an explicit arena worktree route', async () => {
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await handlers[IPC.MergeArenaWorktree]?.({
      branchName: 'arena/codex-run-1',
      cleanup: true,
      message: 'arena: merge Codex',
      projectRoot: '/tmp/project',
      squash: true,
      worktreePath: '/tmp/project/.worktrees/arena/codex-run-1',
    });

    expect(isTaskCommandLeaseHeldMock).not.toHaveBeenCalled();
    expect(mergeTaskMock).toHaveBeenCalledWith(
      '/tmp/project',
      '/tmp/project/.worktrees/arena/codex-run-1',
      'arena/codex-run-1',
      true,
      'arena: merge Codex',
      true,
      undefined,
      expect.any(Function),
    );
  });

  it('rejects non-arena branches on the explicit arena merge route', () => {
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    expect(() =>
      handlers[IPC.MergeArenaWorktree]?.({
        branchName: 'task/auth',
        projectRoot: '/tmp/project',
        squash: true,
        worktreePath: '/tmp/project/.worktrees/task-auth',
      }),
    ).toThrow('branchName must be an arena branch');

    expect(mergeTaskMock).not.toHaveBeenCalled();
  });

  it('cleans backend task runtime without deleting registry metadata for collapse-style cleanup', async () => {
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const context = createContext();
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(context, taskRegistry);

    const result = await handlers[IPC.CleanupTaskRuntime]?.({
      agentIds: ['agent-1'],
      controllerId: 'client-1',
      taskId: 'task-1',
    });

    expect(result).toEqual({ cleanupWarnings: [] });
    expect(cleanupTaskRuntimeWorkflowMock).toHaveBeenCalledWith({
      agentIds: ['agent-1'],
      removeTaskState: false,
      taskId: 'task-1',
    });
    expect(executeCoordinatorProducerMock).not.toHaveBeenCalled();
    expect(taskRegistry.deleteTask).not.toHaveBeenCalled();
  });

  it('removes registry metadata when runtime cleanup is final', async () => {
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const context = createContext();
    const taskRegistry = {
      deleteTask: vi.fn(),
      markTaskClosing: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(context, taskRegistry);

    await handlers[IPC.CleanupTaskRuntime]?.({
      agentIds: ['agent-1'],
      controllerId: 'client-1',
      projectMode: 'non-git',
      removeTaskState: true,
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-auth',
    });

    expect(executeCoordinatorProducerMock).toHaveBeenCalledWith(context, expect.any(Function));

    expect(cleanupTaskRuntimeWorkflowMock).toHaveBeenCalledWith({
      agentIds: ['agent-1'],
      projectMode: 'non-git',
      removeTaskState: true,
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-auth',
    });
    expect(stopTaskAgentWorkflowsForTaskMock).toHaveBeenCalledWith('task-1', ['agent-1']);
    expect(taskRegistry.deleteTask).toHaveBeenCalledWith('task-1');
    expect(taskRegistry.markTaskClosing).toHaveBeenCalledWith('task-1');
    expect(taskRegistry.markTaskClosing.mock.invocationCallOrder[0]).toBeLessThan(
      stopTaskAgentWorkflowsForTaskMock.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it.each(['terminal', 'agent'] as const)(
    'routes final root-backed %s cleanup through canonical generic-owner inputs',
    async () => {
      isTaskCommandLeaseHeldMock.mockReturnValue(true);
      const { context, removeTaskWithLegacyFallback, runLegacyRemoval } =
        createWorkspaceMutationContext();
      removeTaskWithLegacyFallback.mockResolvedValueOnce({
        kind: 'generic-owner',
        removal: {
          changed: true,
          result: {
            deletionOperationId: 'deletion-operation-1',
            removed: true,
            removalState: 'complete',
            taskId: 'task-1',
          },
          revision: 3,
        },
      });
      const taskRegistry = {
        deleteTask: vi.fn(),
        markTaskClosing: vi.fn(),
        registerCreatedTask: vi.fn(),
      };
      const handlers = createTaskAndGitIpcHandlers(context, taskRegistry);

      await expect(
        handlers[IPC.CleanupTaskRuntime]?.({
          agentIds: ['renderer-stale-agent'],
          controllerId: 'client-1',
          projectMode: 'non-git',
          projectRoot: '/renderer/stale-project',
          removeTaskState: true,
          taskId: 'task-1',
          worktreePath: '/renderer/stale-worktree',
        }),
      ).resolves.toEqual({ cleanupWarnings: [], removalState: 'complete' });

      expect(removeTaskWithLegacyFallback).toHaveBeenCalledWith(
        { operation: 'cleanup-task-runtime:task-1' },
        'task-1',
        expect.any(Function),
      );
      expect(runLegacyRemoval).not.toHaveBeenCalled();
      expect(stopTaskAgentWorkflowsForTaskMock).not.toHaveBeenCalled();
      expect(destroyManagedTaskContainersByLabelsMock).not.toHaveBeenCalled();
      expect(cleanupTaskRuntimeWorkflowMock).not.toHaveBeenCalled();
      expect(cleanupCoordinatorTaskStateAndOwnedSubtasksMock).not.toHaveBeenCalled();
      expect(taskRegistry.deleteTask).not.toHaveBeenCalled();
    },
  );

  it('returns a warning after releasing final task state when runner cleanup fails', async () => {
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    stopTaskAgentWorkflowsForTaskMock.mockRejectedValueOnce(new Error('runner cleanup failed'));
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    await expect(
      handlers[IPC.CleanupTaskRuntime]?.({
        agentIds: ['agent-1'],
        controllerId: 'client-1',
        projectMode: 'non-git',
        removeTaskState: true,
        taskId: 'task-1',
      }),
    ).resolves.toEqual({
      cleanupWarnings: [
        {
          kind: 'runners',
          message:
            'Failed to clean agent runners while removing task runtime: runner cleanup failed',
        },
      ],
    });

    expect(cleanupTaskRuntimeWorkflowMock).toHaveBeenCalledWith({
      agentIds: ['agent-1'],
      projectMode: 'non-git',
      removeTaskState: true,
      taskId: 'task-1',
    });
    expect(taskRegistry.deleteTask).toHaveBeenCalledWith('task-1');
    expect(cleanupCoordinatorTaskStateAndOwnedSubtasksMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskNames: taskRegistry }),
      'task-1',
    );
  });

  it('does not erase an undefined runner cleanup rejection from the warning result', async () => {
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    stopTaskAgentWorkflowsForTaskMock.mockRejectedValueOnce(undefined);
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    const cleanup = handlers[IPC.CleanupTaskRuntime]?.({
      agentIds: ['agent-1'],
      controllerId: 'client-1',
      projectMode: 'non-git',
      removeTaskState: true,
      taskId: 'task-1',
    });
    await expect(cleanup).resolves.toEqual({
      cleanupWarnings: [
        {
          kind: 'runners',
          message: 'Failed to clean agent runners while removing task runtime: undefined',
        },
      ],
    });
    expect(cleanupTaskRuntimeWorkflowMock).toHaveBeenCalledOnce();
    expect(taskRegistry.deleteTask).toHaveBeenCalledWith('task-1');
  });

  it('returns coordinator-owned cleanup warnings from final runtime cleanup', async () => {
    cleanupCoordinatorTaskStateAndOwnedSubtasksMock.mockResolvedValueOnce([
      {
        kind: 'worktree',
        message: 'Coordinator subtask task-child cleanup did not finish: worktree busy',
      },
    ]);
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.CleanupTaskRuntime]?.({
        agentIds: ['agent-1'],
        controllerId: 'client-1',
        projectMode: 'non-git',
        removeTaskState: true,
        taskId: 'task-1',
      }),
    ).resolves.toEqual({
      cleanupWarnings: [
        {
          kind: 'worktree',
          message: 'Coordinator subtask task-child cleanup did not finish: worktree busy',
        },
      ],
    });
  });

  it('aggregates runner, container, and coordinator warnings during final runtime cleanup', async () => {
    stopTaskAgentWorkflowsForTaskMock.mockRejectedValueOnce(new Error('runner timeout'));
    destroyManagedTaskContainersByLabelsMock.mockRejectedValueOnce(
      new Error('container daemon unavailable'),
    );
    cleanupCoordinatorTaskStateAndOwnedSubtasksMock.mockResolvedValueOnce([
      {
        kind: 'runners',
        message: 'Coordinator subtask task-child runner cleanup did not finish: busy',
      },
    ]);
    isTaskCommandLeaseHeldMock.mockReturnValue(true);
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.CleanupTaskRuntime]?.({
        agentIds: ['agent-1'],
        controllerId: 'client-1',
        projectRoot: '/tmp/project',
        removeTaskState: true,
        taskId: 'task-1',
        worktreePath: '/tmp/project/.worktrees/task-auth',
      }),
    ).resolves.toEqual({
      cleanupWarnings: [
        {
          kind: 'runners',
          message: 'Failed to clean agent runners while removing task runtime: runner timeout',
        },
        {
          kind: 'containers',
          message:
            'Failed to clean task containers while removing task runtime: container daemon unavailable',
        },
        {
          kind: 'runners',
          message: 'Coordinator subtask task-child runner cleanup did not finish: busy',
        },
      ],
    });
    expect(destroyManagedTaskContainersByLabelsMock).toHaveBeenCalledWith({
      projectPath: '/tmp/project',
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-auth',
    });
    expect(cleanupTaskRuntimeWorkflowMock).toHaveBeenCalledOnce();
  });

  it('emits released task command ownership when runtime cleanup is final', async () => {
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

    await handlers[IPC.CleanupTaskRuntime]?.({
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

  it('rejects runtime cleanup when another client holds the task lease', async () => {
    isTaskCommandLeaseHeldMock.mockReturnValue(false);
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    await expect(
      handlers[IPC.CleanupTaskRuntime]?.({
        agentIds: ['agent-1'],
        controllerId: 'client-2',
        removeTaskState: true,
        taskId: 'task-1',
      }),
    ).rejects.toThrow('Task is controlled by another client');

    expect(cleanupTaskRuntimeWorkflowMock).not.toHaveBeenCalled();
    expect(taskRegistry.deleteTask).not.toHaveBeenCalled();
  });

  it('revalidates the task lease after final cleanup producer admission', async () => {
    let releaseAdmission: (() => void) | undefined;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    executeCoordinatorProducerMock.mockImplementationOnce(
      async (_context: unknown, operation: () => Promise<unknown> | unknown) => {
        await admission;
        return operation();
      },
    );
    isTaskCommandLeaseHeldMock.mockReturnValueOnce(true).mockReturnValue(false);
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    const cleanup = handlers[IPC.CleanupTaskRuntime]?.({
      agentIds: ['agent-1'],
      controllerId: 'client-1',
      removeTaskState: true,
      taskId: 'task-1',
    });
    releaseAdmission?.();

    await expect(cleanup).rejects.toThrow('Task is controlled by another client');
    expect(isTaskCommandLeaseHeldMock).toHaveBeenCalledTimes(2);
    expect(stopTaskAgentWorkflowsForTaskMock).not.toHaveBeenCalled();
    expect(cleanupTaskRuntimeWorkflowMock).not.toHaveBeenCalled();
    expect(taskRegistry.deleteTask).not.toHaveBeenCalled();
  });

  it('rejects runtime cleanup without lease identity before cleanup', async () => {
    const taskRegistry = {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    };
    const handlers = createTaskAndGitIpcHandlers(createContext(), taskRegistry);

    await expect(
      handlers[IPC.CleanupTaskRuntime]?.({
        agentIds: ['agent-1'],
        removeTaskState: true,
        taskId: 'task-1',
      }),
    ).rejects.toThrow('controllerId must be a string');

    expect(isTaskCommandLeaseHeldMock).not.toHaveBeenCalled();
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

  it('registers the branch list handler through the git transport seam', async () => {
    listBranchesMock.mockResolvedValue({
      branches: [
        {
          current: false,
          local: true,
          name: 'main',
          remote: true,
        },
      ],
      defaultBranch: 'main',
      generatedAt: 123,
    });
    const handlers = createTaskAndGitIpcHandlers(createContext(), {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });

    await expect(
      handlers[IPC.ListBranches]?.({
        projectRoot: '/tmp/project',
      }),
    ).resolves.toEqual({
      branches: [
        {
          current: false,
          local: true,
          name: 'main',
          remote: true,
        },
      ],
      defaultBranch: 'main',
      generatedAt: 123,
    });

    expect(listBranchesMock).toHaveBeenCalledWith('/tmp/project');
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
