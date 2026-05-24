import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IPC } from './channels.js';

const {
  resolveHydraAdapterLaunchMock,
  ensurePlansDirectoryMock,
  startPlanWatcherMock,
  stopPlanWatcherMock,
  spawnAgentMock,
  createCurrentBranchTaskMock,
  createNonGitTaskMock,
  createTaskMock,
  importExistingWorktreeTaskMock,
  deleteTaskMock,
  getMainBranchMock,
  startTaskGitStatusMonitoringMock,
  stopTaskGitStatusWatcherMock,
  removeTaskSupervisionMock,
  removeTaskConvergenceMock,
  removeTaskReviewMock,
  removeTaskReviewSignalsMock,
  removeTaskPortsMock,
  removeTaskContainerPreviewTargetsMock,
  removeGitStatusSnapshotMock,
  removeAgentSupervisionMock,
} = vi.hoisted(() => ({
  resolveHydraAdapterLaunchMock: vi.fn(),
  ensurePlansDirectoryMock: vi.fn(),
  startPlanWatcherMock: vi.fn(),
  stopPlanWatcherMock: vi.fn(),
  spawnAgentMock: vi.fn(),
  createCurrentBranchTaskMock: vi.fn(),
  createNonGitTaskMock: vi.fn(),
  createTaskMock: vi.fn(),
  importExistingWorktreeTaskMock: vi.fn(),
  deleteTaskMock: vi.fn(),
  getMainBranchMock: vi.fn(),
  startTaskGitStatusMonitoringMock: vi.fn(),
  stopTaskGitStatusWatcherMock: vi.fn(),
  removeTaskSupervisionMock: vi.fn(),
  removeTaskConvergenceMock: vi.fn(),
  removeTaskReviewMock: vi.fn(),
  removeTaskReviewSignalsMock: vi.fn(),
  removeTaskPortsMock: vi.fn(),
  removeTaskContainerPreviewTargetsMock: vi.fn(),
  removeGitStatusSnapshotMock: vi.fn(),
  removeAgentSupervisionMock: vi.fn(),
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
  createCurrentBranchTask: createCurrentBranchTaskMock,
  createNonGitTask: createNonGitTaskMock,
  createTask: createTaskMock,
  importExistingWorktreeTask: importExistingWorktreeTaskMock,
  deleteTask: deleteTaskMock,
}));

vi.mock('./git.js', () => ({
  getMainBranch: getMainBranchMock,
}));

vi.mock('./agent-supervision.js', () => ({
  removeAgentSupervision: removeAgentSupervisionMock,
  removeTaskSupervision: removeTaskSupervisionMock,
}));

vi.mock('./git-status-state.js', () => ({
  removeGitStatusSnapshot: removeGitStatusSnapshotMock,
}));

vi.mock('./git-status-workflows.js', () => ({
  startTaskGitStatusMonitoring: startTaskGitStatusMonitoringMock,
  stopTaskGitStatusWatcher: stopTaskGitStatusWatcherMock,
}));

vi.mock('./task-convergence-state.js', () => ({
  registerTaskConvergenceTask: vi.fn(),
  removeTaskConvergence: removeTaskConvergenceMock,
  scheduleTaskConvergenceRefresh: vi.fn(),
}));

vi.mock('./task-review-state.js', () => ({
  registerTaskReviewTask: vi.fn(),
  removeTaskReview: removeTaskReviewMock,
  scheduleTaskReviewRefresh: vi.fn(),
}));

vi.mock('./task-review-signals.js', () => ({
  registerTaskReviewSignalsTask: vi.fn(),
  removeTaskReviewSignals: removeTaskReviewSignalsMock,
  scheduleTaskReviewSignalsRefresh: vi.fn(),
}));

vi.mock('./task-ports.js', () => ({
  removeTaskPorts: removeTaskPortsMock,
}));

vi.mock('./task-containers.js', () => ({
  removeTaskContainerPreviewTargets: removeTaskContainerPreviewTargetsMock,
}));

import {
  clearTaskWorkflowWorktreeRegistryForTests,
  cleanupTaskRuntimeWorkflow,
  createTaskWorkflow,
  deleteTaskWorkflow,
  spawnTaskAgentWorkflow,
  syncTaskWorkflowWorktreesFromSavedState,
  type TaskWorkflowContext,
} from './task-workflows.js';
import {
  acquireTaskCommandLease,
  getTaskCommandControllers,
  resetTaskCommandLeasesForTest,
} from './task-command-leases.js';

function createContext(): TaskWorkflowContext {
  return {
    emitIpcEvent: vi.fn(),
    sendToChannel: vi.fn(),
  };
}

describe('task workflows', () => {
  beforeEach(() => {
    clearTaskWorkflowWorktreeRegistryForTests();
    resetTaskCommandLeasesForTest();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    resolveHydraAdapterLaunchMock.mockReturnValue({
      command: process.execPath,
      args: ['adapter-entry'],
      env: { HYDRA_BOOT: '1' },
      isInternalNodeProcess: true,
    });
    getMainBranchMock.mockResolvedValue('main');
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
      baseBranch: 'release/main',
      cwd: '/tmp/task-1',
      env: {
        KEEP_ME: 'yes',
        DROP_ME: 42,
      },
      resumeOnStart: true,
      cols: 100,
      rows: 40,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    expect(resolveHydraAdapterLaunchMock).toHaveBeenCalledWith({
      command: 'hydra',
      args: ['agents=codex'],
      cwd: '/tmp/task-1',
      env: { KEEP_ME: 'yes' },
      resumeOnStart: true,
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
      baseBranch: 'release/main',
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
      git_isolation: 'worktree',
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
      baseBranch: 'main',
      taskId: 'task-2',
      worktreePath: '/tmp/task-2',
    });
    expect(result).toEqual({
      id: 'task-2',
      branch_name: 'task/workflow',
      worktree_path: '/tmp/task-2',
      base_branch: 'main',
      git_isolation: 'worktree',
    });
  });

  it('starts managed worktrees from the selected base branch', async () => {
    const context = createContext();
    createTaskMock.mockResolvedValue({
      id: 'task-2',
      branch_name: 'task/workflow',
      worktree_path: '/tmp/task-2',
      git_isolation: 'worktree',
    });
    getMainBranchMock.mockResolvedValue('release/main');

    const result = await createTaskWorkflow(context, {
      name: 'Workflow task',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      symlinkDirs: ['node_modules'],
      branchPrefix: 'task',
      baseBranch: 'release/main',
    });

    expect(createTaskMock).toHaveBeenCalledWith(
      'Workflow task',
      '/tmp/project',
      ['node_modules'],
      'task',
      'release/main',
    );
    expect(startTaskGitStatusMonitoringMock).toHaveBeenCalledWith(context, {
      baseBranch: 'release/main',
      taskId: 'task-2',
      worktreePath: '/tmp/task-2',
    });
    expect(result).toEqual({
      id: 'task-2',
      branch_name: 'task/workflow',
      worktree_path: '/tmp/task-2',
      base_branch: 'release/main',
      git_isolation: 'worktree',
    });
  });

  it('creates non-git task runtime without git metadata or watchers', async () => {
    const context = createContext();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-non-git-task-'));
    createNonGitTaskMock.mockReturnValue({
      id: 'task-non-git',
      branch_name: '',
      project_mode: 'non-git',
      worktree_path: tempRoot,
    });

    try {
      const result = await createTaskWorkflow(context, {
        name: 'Folder task',
        projectId: 'project-1',
        projectMode: 'non-git',
        projectRoot: tempRoot,
        symlinkDirs: [],
        stepsTracking: true,
      });

      expect(createNonGitTaskMock).toHaveBeenCalledWith(tempRoot);
      expect(createTaskMock).not.toHaveBeenCalled();
      expect(getMainBranchMock).not.toHaveBeenCalled();
      expect(startTaskGitStatusMonitoringMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: 'task-non-git',
        branch_name: '',
        project_mode: 'non-git',
        worktree_path: tempRoot,
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('creates a current-branch task through the backend-owned branch workflow', async () => {
    const context = createContext();
    createCurrentBranchTaskMock.mockResolvedValue({
      id: 'task-3',
      branch_name: 'personal/main',
      worktree_path: '/tmp/project',
      base_branch: 'personal/main',
      git_isolation: 'current-branch',
    });

    const result = await createTaskWorkflow(context, {
      name: 'Direct task',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      symlinkDirs: [],
      branchPrefix: 'task',
      gitIsolation: 'current-branch',
      baseBranch: 'personal/main',
    });

    expect(createCurrentBranchTaskMock).toHaveBeenCalledWith('/tmp/project', 'personal/main');
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(startTaskGitStatusMonitoringMock).toHaveBeenCalledWith(context, {
      baseBranch: 'personal/main',
      taskId: 'task-3',
      worktreePath: '/tmp/project',
    });
    expect(result).toEqual({
      id: 'task-3',
      branch_name: 'personal/main',
      worktree_path: '/tmp/project',
      base_branch: 'personal/main',
      git_isolation: 'current-branch',
    });
  });

  it('imports an existing worktree and registers git-backed task metadata', async () => {
    const context = createContext();
    importExistingWorktreeTaskMock.mockResolvedValue({
      id: 'task-4',
      branch_name: 'task/imported',
      worktree_path: '/tmp/imported-worktree',
      base_branch: 'main',
      git_isolation: 'existing-worktree',
    });

    const result = await createTaskWorkflow(context, {
      name: 'Imported task',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      symlinkDirs: [],
      branchPrefix: 'task',
      gitIsolation: 'existing-worktree',
      existingWorktreePath: '/tmp/imported-worktree',
      baseBranch: 'main',
    });

    expect(importExistingWorktreeTaskMock).toHaveBeenCalledWith(
      '/tmp/project',
      '/tmp/imported-worktree',
      'main',
    );
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(startTaskGitStatusMonitoringMock).toHaveBeenCalledWith(context, {
      baseBranch: 'main',
      taskId: 'task-4',
      worktreePath: '/tmp/imported-worktree',
    });
    expect(result).toEqual({
      id: 'task-4',
      branch_name: 'task/imported',
      worktree_path: '/tmp/imported-worktree',
      base_branch: 'main',
      git_isolation: 'existing-worktree',
    });
  });

  it('rejects duplicate existing-worktree imports across canonical path aliases', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-workflow-test-'));
    const worktreePath = path.join(tempRoot, 'imported-worktree');
    const aliasedWorktreePath = path.join(tempRoot, 'aliased-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.symlinkSync(worktreePath, aliasedWorktreePath, 'dir');

    importExistingWorktreeTaskMock.mockResolvedValueOnce({
      id: 'task-4',
      branch_name: 'task/imported',
      worktree_path: worktreePath,
      base_branch: 'main',
      git_isolation: 'existing-worktree',
    });

    try {
      await createTaskWorkflow(createContext(), {
        name: 'Imported task',
        projectId: 'project-1',
        projectRoot: '/tmp/project',
        symlinkDirs: [],
        branchPrefix: 'task',
        gitIsolation: 'existing-worktree',
        existingWorktreePath: worktreePath,
        baseBranch: 'main',
      });

      await expect(
        createTaskWorkflow(createContext(), {
          name: 'Duplicate imported task',
          projectId: 'project-1',
          projectRoot: '/tmp/project',
          symlinkDirs: [],
          branchPrefix: 'task',
          gitIsolation: 'existing-worktree',
          existingWorktreePath: aliasedWorktreePath,
          baseBranch: 'main',
        }),
      ).rejects.toThrow('already registered for task task-4');
      expect(importExistingWorktreeTaskMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('restores saved worktree identities before accepting new existing-worktree imports', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-workflow-test-'));
    const worktreePath = path.join(tempRoot, 'imported-worktree');
    const aliasedWorktreePath = path.join(tempRoot, 'aliased-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.symlinkSync(worktreePath, aliasedWorktreePath, 'dir');

    try {
      syncTaskWorkflowWorktreesFromSavedState(
        JSON.stringify({
          tasks: {
            'task-existing': {
              id: 'task-existing',
              worktreePath,
            },
          },
        }),
      );

      await expect(
        createTaskWorkflow(createContext(), {
          name: 'Duplicate imported task',
          projectId: 'project-1',
          projectRoot: '/tmp/project',
          symlinkDirs: [],
          branchPrefix: 'task',
          gitIsolation: 'existing-worktree',
          existingWorktreePath: aliasedWorktreePath,
          baseBranch: 'main',
        }),
      ).rejects.toThrow('already registered for task task-existing');
      expect(importExistingWorktreeTaskMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not restore non-git task folders into the git worktree identity registry', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-non-git-registry-'));
    const folderPath = path.join(tempRoot, 'folder');
    fs.mkdirSync(folderPath, { recursive: true });

    try {
      syncTaskWorkflowWorktreesFromSavedState(
        JSON.stringify({
          tasks: {
            'task-non-git': {
              id: 'task-non-git',
              projectMode: 'non-git',
              worktreePath: folderPath,
            },
          },
        }),
      );

      importExistingWorktreeTaskMock.mockResolvedValueOnce({
        id: 'task-imported',
        branch_name: 'task/imported',
        worktree_path: folderPath,
        base_branch: 'main',
        git_isolation: 'existing-worktree',
      });

      await expect(
        createTaskWorkflow(createContext(), {
          name: 'Imported task',
          projectId: 'project-1',
          projectRoot: '/tmp/project',
          symlinkDirs: [],
          branchPrefix: 'task',
          gitIsolation: 'existing-worktree',
          existingWorktreePath: folderPath,
          baseBranch: 'main',
        }),
      ).resolves.toMatchObject({
        id: 'task-imported',
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('logs and swallows git watcher startup failures during task creation', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createTaskMock.mockResolvedValue({
      id: 'task-4',
      branch_name: 'task/failure',
      worktree_path: '/tmp/task-4',
      git_isolation: 'worktree',
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

  it('still removes agent supervision when deletion has no task id', async () => {
    deleteTaskMock.mockResolvedValue(undefined);

    await deleteTaskWorkflow({
      agentIds: ['agent-1'],
      branchName: 'task/delete',
      deleteBranch: true,
      projectRoot: '/tmp/project',
    });

    expect(removeAgentSupervisionMock).toHaveBeenCalledWith('agent-1');
    expect(stopPlanWatcherMock).not.toHaveBeenCalled();
    expect(stopTaskGitStatusWatcherMock).not.toHaveBeenCalled();
  });

  it('stops task watchers without removing task snapshots when runtime state is preserved', () => {
    cleanupTaskRuntimeWorkflow({
      agentIds: ['agent-1'],
      taskId: 'task-3',
    });

    expect(removeAgentSupervisionMock).toHaveBeenCalledWith('agent-1');
    expect(stopPlanWatcherMock).toHaveBeenCalledWith('task-3');
    expect(stopTaskGitStatusWatcherMock).toHaveBeenCalledWith('task-3');
    expect(removeTaskSupervisionMock).not.toHaveBeenCalled();
    expect(removeTaskConvergenceMock).not.toHaveBeenCalled();
    expect(removeTaskReviewMock).not.toHaveBeenCalled();
    expect(removeTaskPortsMock).not.toHaveBeenCalled();
    expect(removeTaskContainerPreviewTargetsMock).not.toHaveBeenCalled();
    expect(removeGitStatusSnapshotMock).not.toHaveBeenCalled();
  });

  it('removes backend task state when runtime cleanup is final', () => {
    acquireTaskCommandLease('task-3', 'client-a', 'owner-a', 'close this task', false, Date.now());

    const result = cleanupTaskRuntimeWorkflow({
      agentIds: ['agent-1'],
      removeTaskState: true,
      taskId: 'task-3',
      worktreePath: '/tmp/project/.worktrees/task-3',
    });

    expect(result.releasedTaskCommandController).toEqual({
      action: null,
      controllerId: null,
      taskId: 'task-3',
      version: 2,
    });
    expect(getTaskCommandControllers()).toEqual([]);
    expect(removeTaskSupervisionMock).toHaveBeenCalledWith('task-3');
    expect(removeTaskConvergenceMock).toHaveBeenCalledWith('task-3');
    expect(removeTaskReviewMock).toHaveBeenCalledWith('task-3');
    expect(removeTaskPortsMock).toHaveBeenCalledWith('task-3');
    expect(removeTaskContainerPreviewTargetsMock).toHaveBeenCalledWith('task-3');
    expect(removeGitStatusSnapshotMock).toHaveBeenCalledWith('/tmp/project/.worktrees/task-3');
  });

  it('does not remove git status snapshots for non-git runtime cleanup', () => {
    cleanupTaskRuntimeWorkflow({
      agentIds: ['agent-1'],
      projectMode: 'non-git',
      removeTaskState: true,
      taskId: 'task-3',
      worktreePath: '/tmp/folder',
    });

    expect(removeTaskSupervisionMock).toHaveBeenCalledWith('task-3');
    expect(removeGitStatusSnapshotMock).not.toHaveBeenCalled();
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
