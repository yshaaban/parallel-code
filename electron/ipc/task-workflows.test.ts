import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IPC } from './channels.js';

const {
  resolveHydraAdapterLaunchMock,
  cleanupPendingDockerAgentRunnerBuildsMock,
  createDockerAgentRunnerLaunchMock,
  ensurePlansDirectoryMock,
  startPlanWatcherMock,
  stopPlanWatcherMock,
  spawnAgentMock,
  hasAgentSessionMock,
  killAgentAndWaitForRunnerCleanupMock,
  killAllAgentsAndWaitForRunnerCleanupMock,
  killTaskAgentsAndWaitForRunnerCleanupMock,
  createCurrentBranchTaskMock,
  createNonGitTaskMock,
  createTaskMock,
  importExistingWorktreeTaskMock,
  deleteTaskMock,
  getGitRepoRootMock,
  getMainBranchMock,
  startTaskGitStatusMonitoringMock,
  stopTaskGitStatusWatcherMock,
  removeTaskSupervisionMock,
  removeTaskConvergenceMock,
  removeTaskReviewMock,
  removeTaskReviewSignalsMock,
  removeTaskPortsMock,
  removeTaskContainerPreviewTargetsMock,
  destroyManagedTaskContainersByLabelsMock,
  removeGitStatusSnapshotMock,
  removeAgentSupervisionMock,
} = vi.hoisted(() => ({
  resolveHydraAdapterLaunchMock: vi.fn(),
  cleanupPendingDockerAgentRunnerBuildsMock: vi.fn(),
  createDockerAgentRunnerLaunchMock: vi.fn(),
  ensurePlansDirectoryMock: vi.fn(),
  startPlanWatcherMock: vi.fn(),
  stopPlanWatcherMock: vi.fn(),
  spawnAgentMock: vi.fn(),
  hasAgentSessionMock: vi.fn(),
  killAgentAndWaitForRunnerCleanupMock: vi.fn(),
  killAllAgentsAndWaitForRunnerCleanupMock: vi.fn(),
  killTaskAgentsAndWaitForRunnerCleanupMock: vi.fn(),
  createCurrentBranchTaskMock: vi.fn(),
  createNonGitTaskMock: vi.fn(),
  createTaskMock: vi.fn(),
  importExistingWorktreeTaskMock: vi.fn(),
  deleteTaskMock: vi.fn(),
  getGitRepoRootMock: vi.fn(),
  getMainBranchMock: vi.fn(),
  startTaskGitStatusMonitoringMock: vi.fn(),
  stopTaskGitStatusWatcherMock: vi.fn(),
  removeTaskSupervisionMock: vi.fn(),
  removeTaskConvergenceMock: vi.fn(),
  removeTaskReviewMock: vi.fn(),
  removeTaskReviewSignalsMock: vi.fn(),
  removeTaskPortsMock: vi.fn(),
  removeTaskContainerPreviewTargetsMock: vi.fn(),
  destroyManagedTaskContainersByLabelsMock: vi.fn(),
  removeGitStatusSnapshotMock: vi.fn(),
  removeAgentSupervisionMock: vi.fn(),
}));

vi.mock('./hydra-adapter.js', () => ({
  resolveHydraAdapterLaunch: resolveHydraAdapterLaunchMock,
}));

vi.mock('./agent-runner-docker.js', () => ({
  cleanupPendingDockerAgentRunnerBuilds: cleanupPendingDockerAgentRunnerBuildsMock,
  createDockerAgentRunnerLaunch: createDockerAgentRunnerLaunchMock,
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
    hasAgentSession: hasAgentSessionMock,
    killAllAgentsAndWaitForRunnerCleanup: killAllAgentsAndWaitForRunnerCleanupMock,
    killAgentAndWaitForRunnerCleanup: killAgentAndWaitForRunnerCleanupMock,
    killTaskAgentsAndWaitForRunnerCleanup: killTaskAgentsAndWaitForRunnerCleanupMock,
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
  getGitRepoRoot: getGitRepoRootMock,
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
  destroyManagedTaskContainersByLabels: destroyManagedTaskContainersByLabelsMock,
  removeTaskContainerPreviewTargets: removeTaskContainerPreviewTargetsMock,
}));

import {
  clearTaskWorkflowWorktreeRegistryForTests,
  cleanupTaskRuntimeWorkflow,
  countRunningAndPendingTaskAgents,
  createTaskWorkflow,
  deleteTaskWorkflow,
  findRegisteredTaskIdForWorktreePath,
  spawnTaskAgentWorkflow,
  stopAllTaskAgentWorkflows,
  stopTaskAgentWorkflow,
  syncTaskWorkflowWorktreesFromSavedState,
  type CreateTaskWorkflowRequest,
  type TaskWorkflowContext,
} from './task-workflows.js';
import {
  acquireTaskCommandLease,
  getTaskCommandControllers,
  resetTaskCommandLeasesForTest,
} from './task-command-leases.js';
import { clearTaskStepsRegistry, stopAllTaskStepsWatchers } from './task-steps.js';

function createContext(): TaskWorkflowContext {
  return {
    emitIpcEvent: vi.fn(),
    sendToChannel: vi.fn(),
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type TestGitTaskResult = {
  base_branch: string;
  branch_name: string;
  git_isolation: 'current-branch' | 'existing-worktree';
  id: string;
  worktree_path: string;
};

function createTestGitTaskResult(
  id: string,
  worktreePath: string,
  gitIsolation: TestGitTaskResult['git_isolation'],
): TestGitTaskResult {
  return {
    base_branch: 'main',
    branch_name: gitIsolation === 'current-branch' ? 'main' : 'task/imported',
    git_isolation: gitIsolation,
    id,
    worktree_path: worktreePath,
  };
}

function createCurrentBranchWorkflowRequest(
  projectRoot: string,
  name = 'Direct task',
): CreateTaskWorkflowRequest {
  return {
    gitIsolation: 'current-branch',
    name,
    projectId: 'project-1',
    projectRoot,
    symlinkDirs: [],
  };
}

function createExistingWorktreeWorkflowRequest(
  existingWorktreePath: string,
  name = 'Imported task',
): CreateTaskWorkflowRequest {
  return {
    baseBranch: 'main',
    branchPrefix: 'task',
    existingWorktreePath,
    gitIsolation: 'existing-worktree',
    name,
    projectId: 'project-1',
    projectRoot: '/tmp/project',
    symlinkDirs: [],
  };
}

describe('task workflows', () => {
  beforeEach(() => {
    clearTaskWorkflowWorktreeRegistryForTests();
    clearTaskStepsRegistry();
    stopAllTaskStepsWatchers();
    resetTaskCommandLeasesForTest();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    getGitRepoRootMock.mockImplementation((candidatePath: string) =>
      Promise.resolve(candidatePath),
    );
    spawnAgentMock.mockReturnValue({
      channelAttached: true,
      kind: 'created-session',
    });
    hasAgentSessionMock.mockReturnValue(false);
    killAgentAndWaitForRunnerCleanupMock.mockResolvedValue(undefined);
    killAllAgentsAndWaitForRunnerCleanupMock.mockResolvedValue(undefined);
    killTaskAgentsAndWaitForRunnerCleanupMock.mockImplementation(
      async (_taskId: string, agentIds: readonly string[]) => {
        const results = await Promise.allSettled(
          agentIds.map((agentId) => killAgentAndWaitForRunnerCleanupMock(agentId)),
        );
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failure) throw failure.reason;
      },
    );
    cleanupPendingDockerAgentRunnerBuildsMock.mockResolvedValue(undefined);
    resolveHydraAdapterLaunchMock.mockReturnValue({
      command: process.execPath,
      args: ['adapter-entry'],
      env: { HYDRA_BOOT: '1' },
      isInternalNodeProcess: true,
    });
    createDockerAgentRunnerLaunchMock.mockReturnValue({
      args: ['run', '--name', 'parallel-code-agent', 'agent:latest', 'codex'],
      cleanup: vi.fn(),
      command: 'docker',
      cwd: '/tmp/task-1',
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
    getMainBranchMock.mockResolvedValue('main');
    startTaskGitStatusMonitoringMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopAllTaskStepsWatchers();
    clearTaskStepsRegistry();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('routes hydra agent creation through the adapter and starts worktree watchers', async () => {
    const context = createContext();

    await spawnTaskAgentWorkflow(context, {
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

  it('wraps non-shell agent launches through a configured Docker runner', async () => {
    const context = createContext();
    const cleanup = vi.fn();
    createDockerAgentRunnerLaunchMock.mockReturnValueOnce({
      args: ['run', '--name', 'parallel-code-agent', 'agent:latest', 'codex', 'run'],
      cleanup,
      command: 'docker',
      cwd: '/tmp/task-1',
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

    await spawnTaskAgentWorkflow(context, {
      taskId: 'task-1',
      agentId: 'agent-1',
      command: 'codex',
      args: ['run'],
      baseBranch: 'main',
      cwd: '/tmp/task-1',
      env: { KEEP_ME: 'yes', DROP_ME: 42 },
      cols: 80,
      rows: 24,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
      runnerProfile: {
        image: 'agent:latest',
        provider: 'docker-container',
      },
    });

    expect(createDockerAgentRunnerLaunchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        args: ['run'],
        command: 'codex',
        cwd: '/tmp/task-1',
        env: { KEEP_ME: 'yes' },
        profile: {
          image: 'agent:latest',
          provider: 'docker-container',
        },
        taskId: 'task-1',
      }),
    );
    expect(spawnAgentMock).toHaveBeenCalledWith(
      context.sendToChannel,
      expect.objectContaining({
        args: ['run', '--name', 'parallel-code-agent', 'agent:latest', 'codex', 'run'],
        command: 'docker',
        cwd: '/tmp/task-1',
        env: {},
        isInternalNodeProcess: false,
        onExitCleanup: cleanup,
        runnerIdentity: expect.objectContaining({
          provider: 'docker-container',
          runnerInstanceId: 'runner-1',
        }),
      }),
    );
    expect(startTaskGitStatusMonitoringMock).toHaveBeenCalledWith(context, {
      baseBranch: 'main',
      taskId: 'task-1',
      worktreePath: '/tmp/task-1',
    });
  });

  it('cleans a prepared Docker runner when PTY spawn fails', async () => {
    const context = createContext();
    const cleanup = vi.fn();
    createDockerAgentRunnerLaunchMock.mockReturnValueOnce({
      args: ['run', '--name', 'parallel-code-agent', 'agent:latest', 'codex'],
      cleanup,
      command: 'docker',
      cwd: '/tmp/task-1',
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
    spawnAgentMock.mockImplementationOnce(() => {
      throw new Error('pty spawn failed');
    });

    await expect(
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
        runnerProfile: {
          image: 'agent:latest',
          provider: 'docker-container',
        },
      }),
    ).rejects.toThrow('pty spawn failed');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(startTaskGitStatusMonitoringMock).not.toHaveBeenCalled();
  });

  it('cleans an async Docker launch when spawn admission closes before PTY creation', async () => {
    const context = createContext();
    const cleanup = vi.fn();
    const assertSpawnAdmitted = vi.fn();
    let resolveDockerLaunch!: (launch: {
      args: string[];
      cleanup: () => void;
      command: string;
      cwd: string;
      env: Record<string, string>;
      identity: {
        agentId: string;
        labels: Record<string, string>;
        profileId: string;
        provider: 'docker-container';
        runnerInstanceId: string;
        startedAt: string;
        taskId: string;
      };
    }) => void;
    createDockerAgentRunnerLaunchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDockerLaunch = resolve;
      }),
    );

    const spawn = spawnTaskAgentWorkflow(context, {
      agentId: 'agent-1',
      args: ['run'],
      assertSpawnAdmitted,
      cols: 80,
      command: 'codex',
      cwd: '/tmp/task-1',
      env: {},
      onOutput: { __CHANNEL_ID__: 'channel-1' },
      rows: 24,
      runnerProfile: { image: 'agent:latest', provider: 'docker-container' },
      taskId: 'task-1',
    });
    await vi.waitFor(() => {
      expect(createDockerAgentRunnerLaunchMock).toHaveBeenCalledOnce();
    });
    assertSpawnAdmitted.mockImplementation(() => {
      throw new Error('spawn admission closed');
    });
    resolveDockerLaunch({
      args: ['run', 'agent:latest', 'codex'],
      cleanup,
      command: 'docker',
      cwd: '/tmp/task-1',
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

    await expect(spawn).rejects.toThrow('spawn admission closed');
    expect(assertSpawnAdmitted).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('cleans a prepared Docker launch that loses a concurrent session-creation race', async () => {
    const context = createContext();
    const cleanup = vi.fn();
    createDockerAgentRunnerLaunchMock.mockResolvedValueOnce({
      args: ['run', 'agent:latest', 'codex'],
      cleanup,
      command: 'docker',
      cwd: '/tmp/task-1',
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
    spawnAgentMock.mockReturnValueOnce({
      channelAttached: true,
      kind: 'attached-existing',
    });

    await expect(
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-1',
        args: ['run'],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-1',
        env: {},
        onOutput: { __CHANNEL_ID__: 'channel-1' },
        rows: 24,
        runnerProfile: { image: 'agent:latest', provider: 'docker-container' },
        taskId: 'task-1',
      }),
    ).resolves.toEqual({
      channelAttached: true,
      kind: 'attached-existing',
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects Hydra adapter agents for Docker container runners before creating Docker resources', async () => {
    const context = createContext();

    await expect(
      spawnTaskAgentWorkflow(context, {
        taskId: 'task-1',
        agentId: 'agent-1',
        adapter: 'hydra',
        command: 'hydra',
        args: ['agents=codex'],
        cwd: '/tmp/task-1',
        env: {},
        cols: 80,
        rows: 24,
        onOutput: { __CHANNEL_ID__: 'channel-1' },
        runnerProfile: {
          image: 'agent:latest',
          provider: 'docker-container',
        },
      }),
    ).rejects.toThrow('Docker container agent runners do not support Hydra adapter agents yet.');
    expect(createDockerAgentRunnerLaunchMock).not.toHaveBeenCalled();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('cancels pending Docker setup before a killed agent can spawn late', async () => {
    const context = createContext();
    createDockerAgentRunnerLaunchMock.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );

    const spawn = spawnTaskAgentWorkflow(context, {
      agentId: 'agent-pending-build',
      args: [],
      cols: 80,
      command: 'codex',
      cwd: '/tmp/task-pending-build',
      env: {},
      rows: 24,
      runnerProfile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
      taskId: 'task-pending-build',
    });
    await vi.waitFor(() => {
      expect(createDockerAgentRunnerLaunchMock).toHaveBeenCalledOnce();
    });
    expect(countRunningAndPendingTaskAgents()).toBe(1);

    await expect(stopTaskAgentWorkflow('agent-pending-build')).resolves.toBeUndefined();
    await expect(spawn).rejects.toThrow('Agent agent-pending-build was stopped');

    expect(spawnAgentMock).not.toHaveBeenCalled();
    expect(countRunningAndPendingTaskAgents()).toBe(0);
  });

  it('removes a cancelled spawn from the global admission queue without waiting for active builds', async () => {
    const context = createContext();
    createDockerAgentRunnerLaunchMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const spawns = Array.from({ length: 5 }, (_, index) =>
      spawnTaskAgentWorkflow(context, {
        agentId: `agent-queued-${index}`,
        args: [],
        cols: 80,
        command: 'codex',
        cwd: `/tmp/task-queued-${index}`,
        env: {},
        rows: 24,
        runnerProfile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
        taskId: `task-queued-${index}`,
      }),
    );
    await vi.waitFor(() => {
      expect(createDockerAgentRunnerLaunchMock).toHaveBeenCalledTimes(4);
    });

    await expect(stopTaskAgentWorkflow('agent-queued-4')).resolves.toBeUndefined();
    await expect(spawns[4]).rejects.toThrow('Agent agent-queued-4 was stopped');
    expect(createDockerAgentRunnerLaunchMock).toHaveBeenCalledTimes(4);

    await expect(stopAllTaskAgentWorkflows()).resolves.toBeUndefined();
    await Promise.allSettled(spawns.slice(0, 4));
  });

  it('attaches to an existing session without waiting behind runner preparation', async () => {
    const context = createContext();
    createDockerAgentRunnerLaunchMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const builds = Array.from({ length: 4 }, (_, index) =>
      spawnTaskAgentWorkflow(context, {
        agentId: `agent-building-${index}`,
        args: [],
        cols: 80,
        command: 'codex',
        cwd: `/tmp/task-building-${index}`,
        env: {},
        rows: 24,
        runnerProfile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
        taskId: `task-building-${index}`,
      }),
    );
    await vi.waitFor(() => {
      expect(createDockerAgentRunnerLaunchMock).toHaveBeenCalledTimes(4);
    });
    hasAgentSessionMock.mockImplementation((agentId: string) => agentId === 'agent-existing');
    spawnAgentMock.mockReturnValueOnce({
      channelAttached: true,
      kind: 'attached-existing',
    });

    await expect(
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-existing',
        args: [],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-existing',
        env: {},
        onOutput: { __CHANNEL_ID__: 'existing-channel' },
        rows: 24,
        taskId: 'task-existing',
      }),
    ).resolves.toEqual({
      channelAttached: true,
      kind: 'attached-existing',
    });
    expect(createDockerAgentRunnerLaunchMock).toHaveBeenCalledTimes(4);

    await stopAllTaskAgentWorkflows();
    await Promise.allSettled(builds);
  });

  it('cancels and drains pending setup before deleting task resources', async () => {
    const context = createContext();
    createDockerAgentRunnerLaunchMock.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const spawn = spawnTaskAgentWorkflow(context, {
      agentId: 'agent-delete-pending',
      args: [],
      cols: 80,
      command: 'codex',
      cwd: '/tmp/task-delete-pending',
      env: {},
      rows: 24,
      runnerProfile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
      taskId: 'task-delete-pending',
    });
    await vi.waitFor(() => {
      expect(createDockerAgentRunnerLaunchMock).toHaveBeenCalledOnce();
    });

    await expect(
      deleteTaskWorkflow({
        agentIds: ['agent-delete-pending'],
        branchName: 'task/delete-pending',
        deleteBranch: true,
        projectRoot: '/tmp/project',
        taskId: 'task-delete-pending',
        worktreePath: '/tmp/task-delete-pending',
      }),
    ).resolves.toMatchObject({ cleanupWarnings: [] });
    await expect(spawn).rejects.toThrow('Task task-delete-pending was closed');

    expect(spawnAgentMock).not.toHaveBeenCalled();
    expect(deleteTaskMock).toHaveBeenCalledOnce();
  });

  it('retains a failed prepared cleanup owner for an explicit stop retry', async () => {
    const context = createContext();
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('daemon temporarily unavailable'))
      .mockResolvedValueOnce(undefined);
    createDockerAgentRunnerLaunchMock.mockResolvedValueOnce({
      args: ['run', 'agent:latest', 'codex'],
      cleanup,
      command: 'docker',
      cwd: '/tmp/task-cleanup-retry',
      env: {},
      identity: {
        agentId: 'agent-cleanup-retry',
        labels: {},
        profileId: 'profile-1',
        provider: 'docker-container',
        runnerInstanceId: 'runner-1',
        startedAt: '2026-05-24T00:00:00.000Z',
        taskId: 'task-cleanup-retry',
      },
    });
    spawnAgentMock.mockImplementationOnce(() => {
      throw new Error('pty spawn failed');
    });

    await expect(
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-cleanup-retry',
        args: [],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-cleanup-retry',
        env: {},
        rows: 24,
        runnerProfile: { image: 'agent:latest', provider: 'docker-container' },
        taskId: 'task-cleanup-retry',
      }),
    ).rejects.toThrow('prepared runner cleanup also failed');
    await expect(stopTaskAgentWorkflow('agent-cleanup-retry')).resolves.toBeUndefined();

    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('rechecks admission after awaiting replacement cleanup', async () => {
    const context = createContext();
    let resolveReplacementCleanup!: () => void;
    const replacedSessionCleanup = new Promise<void>((resolve) => {
      resolveReplacementCleanup = resolve;
    });
    spawnAgentMock.mockReturnValueOnce({
      channelAttached: true,
      kind: 'created-session',
      replacedSessionCleanup,
    });
    const assertSpawnAdmitted = vi.fn();
    const spawn = spawnTaskAgentWorkflow(context, {
      agentId: 'agent-replacement-admission',
      args: [],
      assertSpawnAdmitted,
      cols: 80,
      command: 'codex',
      cwd: '/tmp/task-replacement-admission',
      env: {},
      replaceExistingSession: true,
      rows: 24,
      taskId: 'task-replacement-admission',
    });
    await vi.waitFor(() => {
      expect(spawnAgentMock).toHaveBeenCalledOnce();
    });
    expect(killAgentAndWaitForRunnerCleanupMock).not.toHaveBeenCalled();
    assertSpawnAdmitted.mockImplementation(() => {
      throw new Error('replacement admission closed');
    });
    resolveReplacementCleanup();

    await expect(spawn).rejects.toThrow('replacement admission closed');
    expect(assertSpawnAdmitted).toHaveBeenCalledTimes(3);
    expect(killAgentAndWaitForRunnerCleanupMock).toHaveBeenCalledWith(
      'agent-replacement-admission',
    );
  });

  it('starts replacement rollback as soon as a pending spawn is cancelled', async () => {
    const context = createContext();
    let resolveReplacementCleanup!: () => void;
    const replacedSessionCleanup = new Promise<void>((resolve) => {
      resolveReplacementCleanup = resolve;
    });
    spawnAgentMock.mockReturnValueOnce({
      channelAttached: true,
      kind: 'created-session',
      replacedSessionCleanup,
    });
    const spawn = spawnTaskAgentWorkflow(context, {
      agentId: 'agent-cancelled-replacement',
      args: [],
      cols: 80,
      command: 'codex',
      cwd: '/tmp/task-cancelled-replacement',
      env: {},
      replaceExistingSession: true,
      rows: 24,
      taskId: 'task-cancelled-replacement',
    });
    const spawnFailure = spawn.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(spawnAgentMock).toHaveBeenCalledOnce();
    });

    let stopSettled = false;
    const stop = stopTaskAgentWorkflow('agent-cancelled-replacement').finally(() => {
      stopSettled = true;
    });
    await vi.waitFor(() => {
      expect(killAgentAndWaitForRunnerCleanupMock).toHaveBeenCalledWith(
        'agent-cancelled-replacement',
      );
    });
    expect(stopSettled).toBe(false);

    resolveReplacementCleanup();
    await stop;
    const spawnError = await spawnFailure;
    expect(spawnError).toEqual(expect.objectContaining({ name: 'AbortError' }));
    expect((spawnError as Error).message).toContain(
      'Agent agent-cancelled-replacement was stopped',
    );
  });

  it('retains an undefined replacement rollback rejection', async () => {
    const context = createContext();
    let rejectReplacementCleanup!: (error: Error) => void;
    const replacedSessionCleanup = new Promise<void>((_resolve, reject) => {
      rejectReplacementCleanup = reject;
    });
    spawnAgentMock.mockReturnValueOnce({
      channelAttached: true,
      kind: 'created-session',
      replacedSessionCleanup,
    });
    killAgentAndWaitForRunnerCleanupMock.mockRejectedValue(undefined);
    const spawn = spawnTaskAgentWorkflow(context, {
      agentId: 'agent-failed-replacement',
      args: [],
      cols: 80,
      command: 'codex',
      cwd: '/tmp/task-failed-replacement',
      env: {},
      replaceExistingSession: true,
      rows: 24,
      taskId: 'task-failed-replacement',
    });
    await vi.waitFor(() => {
      expect(spawnAgentMock).toHaveBeenCalledOnce();
    });

    const replacementError = new Error('old session cleanup failed');
    rejectReplacementCleanup(replacementError);
    const failure = await spawn.catch((error: unknown) => error);

    expect(failure).toEqual(
      expect.objectContaining({
        cause: [replacementError, undefined],
        message: 'Agent replacement cleanup failed and the replacement runner rollback also failed',
      }),
    );
    expect(killAgentAndWaitForRunnerCleanupMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a healthy existing session when replacement validation or spawn fails', async () => {
    const context = createContext();
    spawnAgentMock.mockImplementationOnce(() => {
      throw new Error('replacement command is invalid');
    });

    await expect(
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-invalid-replacement',
        args: [],
        cols: 80,
        command: 'invalid;command',
        cwd: '/tmp/task-invalid-replacement',
        env: {},
        replaceExistingSession: true,
        rows: 24,
        taskId: 'task-invalid-replacement',
      }),
    ).rejects.toThrow('replacement command is invalid');

    expect(killAgentAndWaitForRunnerCleanupMock).not.toHaveBeenCalled();
  });

  it('shares overlapping global stop work until cleanup fully settles', async () => {
    let resolveCleanup!: () => void;
    killAllAgentsAndWaitForRunnerCleanupMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      }),
    );

    const firstStop = stopAllTaskAgentWorkflows();
    const secondStop = stopAllTaskAgentWorkflows();
    expect(secondStop).toBe(firstStop);
    await vi.waitFor(() => {
      expect(killAllAgentsAndWaitForRunnerCleanupMock).toHaveBeenCalledOnce();
    });

    resolveCleanup();
    await Promise.all([firstStop, secondStop]);
    expect(killAllAgentsAndWaitForRunnerCleanupMock).toHaveBeenCalledOnce();
  });

  it('retains failed global stop admission until an explicit shared retry settles successfully', async () => {
    const context = createContext();
    let resolveRetry!: () => void;
    killAllAgentsAndWaitForRunnerCleanupMock
      .mockRejectedValueOnce(new Error('global runner cleanup failed'))
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
      );

    await expect(stopAllTaskAgentWorkflows()).rejects.toThrow('global runner cleanup failed');
    await expect(
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-global-stop-retry',
        args: [],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-global-stop-retry',
        env: {},
        rows: 24,
        taskId: 'task-global-stop-retry',
      }),
    ).rejects.toThrow('Agent sessions are stopping and do not admit new spawns');

    const firstRetry = stopAllTaskAgentWorkflows();
    const secondRetry = stopAllTaskAgentWorkflows();
    expect(secondRetry).toBe(firstRetry);
    await vi.waitFor(() => {
      expect(killAllAgentsAndWaitForRunnerCleanupMock).toHaveBeenCalledTimes(2);
    });
    await expect(
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-global-stop-retry',
        args: [],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-global-stop-retry',
        env: {},
        rows: 24,
        taskId: 'task-global-stop-retry',
      }),
    ).rejects.toThrow('Agent sessions are stopping and do not admit new spawns');
    expect(spawnAgentMock).not.toHaveBeenCalled();

    resolveRetry();
    await Promise.all([firstRetry, secondRetry]);
    await expect(
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-global-stop-retry',
        args: [],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-global-stop-retry',
        env: {},
        rows: 24,
        taskId: 'task-global-stop-retry',
      }),
    ).resolves.toMatchObject({ kind: 'created-session' });

    expect(killAllAgentsAndWaitForRunnerCleanupMock).toHaveBeenCalledTimes(2);
    expect(spawnAgentMock).toHaveBeenCalledOnce();
  });

  it('lets successful global cleanup supersede retained per-agent stop failures', async () => {
    const context = createContext();
    killAgentAndWaitForRunnerCleanupMock.mockRejectedValueOnce(
      new Error('individual runner cleanup failed'),
    );

    await expect(stopTaskAgentWorkflow('agent-global-recovery')).rejects.toThrow(
      'individual runner cleanup failed',
    );
    await expect(
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-global-recovery',
        args: [],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-global-recovery',
        env: {},
        rows: 24,
        taskId: 'task-global-recovery',
      }),
    ).rejects.toThrow('Agent agent-global-recovery is stopping and does not admit new spawns');

    await expect(stopAllTaskAgentWorkflows()).resolves.toBeUndefined();
    await expect(
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-global-recovery',
        args: [],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-global-recovery',
        env: {},
        rows: 24,
        taskId: 'task-global-recovery',
      }),
    ).resolves.toMatchObject({ kind: 'created-session' });

    expect(killAllAgentsAndWaitForRunnerCleanupMock).toHaveBeenCalledOnce();
    expect(spawnAgentMock).toHaveBeenCalledOnce();
  });

  it('shares overlapping per-agent stops and keeps spawn admission closed through cleanup', async () => {
    const context = createContext();
    let resolveCleanup!: () => void;
    killAgentAndWaitForRunnerCleanupMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      }),
    );

    const firstStop = stopTaskAgentWorkflow('agent-stop-owner');
    const secondStop = stopTaskAgentWorkflow('agent-stop-owner');
    expect(secondStop).toBe(firstStop);

    const blockedSpawn = spawnTaskAgentWorkflow(context, {
      agentId: 'agent-stop-owner',
      args: [],
      cols: 80,
      command: 'codex',
      cwd: '/tmp/task-stop-owner',
      env: {},
      rows: 24,
      taskId: 'task-stop-owner',
    });
    await expect(blockedSpawn).rejects.toThrow(
      'Agent agent-stop-owner is stopping and does not admit new spawns',
    );
    await vi.waitFor(() => {
      expect(killAgentAndWaitForRunnerCleanupMock).toHaveBeenCalledOnce();
    });
    expect(spawnAgentMock).not.toHaveBeenCalled();

    resolveCleanup();
    await Promise.all([firstStop, secondStop]);

    await expect(
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-stop-owner',
        args: [],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-stop-owner',
        env: {},
        rows: 24,
        taskId: 'task-stop-owner',
      }),
    ).resolves.toMatchObject({ kind: 'created-session' });
    expect(spawnAgentMock).toHaveBeenCalledOnce();
    expect(killAgentAndWaitForRunnerCleanupMock).toHaveBeenCalledOnce();
  });

  it('rejects every spawn initiated during stop instead of queuing behind a cancelled predecessor', async () => {
    const context = createContext();
    let rejectPredecessor!: (error: unknown) => void;
    let reportPredecessorAbort!: () => void;
    const predecessorAborted = new Promise<void>((resolve) => {
      reportPredecessorAbort = resolve;
    });
    createDockerAgentRunnerLaunchMock.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          rejectPredecessor = reject;
          signal.addEventListener('abort', reportPredecessorAbort, { once: true });
        }),
    );
    const predecessor = spawnTaskAgentWorkflow(context, {
      agentId: 'agent-stop-predecessor',
      args: [],
      cols: 80,
      command: 'codex',
      cwd: '/tmp/task-stop-predecessor',
      env: {},
      rows: 24,
      runnerProfile: { dockerfile: 'Dockerfile', provider: 'docker-container' },
      taskId: 'task-stop-predecessor',
    });
    await vi.waitFor(() => {
      expect(createDockerAgentRunnerLaunchMock).toHaveBeenCalledOnce();
    });

    const stop = stopTaskAgentWorkflow('agent-stop-predecessor');
    await predecessorAborted;
    const spawnsDuringStop = Array.from({ length: 8 }, () =>
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-stop-predecessor',
        args: [],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-stop-predecessor',
        env: {},
        rows: 24,
        taskId: 'task-stop-predecessor',
      }),
    );

    rejectPredecessor(new Error('cancelled predecessor settled'));
    await expect(predecessor).rejects.toThrow('cancelled predecessor settled');
    await expect(stop).resolves.toBeUndefined();
    for (const spawnDuringStop of spawnsDuringStop) {
      await expect(spawnDuringStop).rejects.toThrow(
        'Agent agent-stop-predecessor is stopping and does not admit new spawns',
      );
    }
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('retains failed per-agent stop admission until an explicit retry settles successfully', async () => {
    const context = createContext();
    killAgentAndWaitForRunnerCleanupMock
      .mockRejectedValueOnce(new Error('runner cleanup failed'))
      .mockResolvedValueOnce(undefined);

    await expect(stopTaskAgentWorkflow('agent-stop-retry')).rejects.toThrow(
      'runner cleanup failed',
    );
    await expect(
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-stop-retry',
        args: [],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-stop-retry',
        env: {},
        rows: 24,
        taskId: 'task-stop-retry',
      }),
    ).rejects.toThrow('Agent agent-stop-retry is stopping and does not admit new spawns');
    expect(spawnAgentMock).not.toHaveBeenCalled();

    await expect(stopTaskAgentWorkflow('agent-stop-retry')).resolves.toBeUndefined();
    await expect(
      spawnTaskAgentWorkflow(context, {
        agentId: 'agent-stop-retry',
        args: [],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-stop-retry',
        env: {},
        rows: 24,
        taskId: 'task-stop-retry',
      }),
    ).resolves.toMatchObject({ kind: 'created-session' });

    expect(killAgentAndWaitForRunnerCleanupMock).toHaveBeenCalledTimes(2);
    expect(spawnAgentMock).toHaveBeenCalledOnce();
  });

  it('attempts every per-agent cleanup owner when PTY cleanup throws synchronously', async () => {
    const preparedCleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('retain prepared cleanup'))
      .mockResolvedValueOnce(undefined);
    createDockerAgentRunnerLaunchMock.mockResolvedValueOnce({
      args: ['run', 'agent:latest', 'codex'],
      cleanup: preparedCleanup,
      command: 'docker',
      cwd: '/tmp/task-sync-stop-cleanup',
      env: {},
      identity: {
        agentId: 'agent-sync-stop-cleanup',
        labels: {},
        profileId: 'profile-1',
        provider: 'docker-container',
        runnerInstanceId: 'runner-sync-stop-cleanup',
        startedAt: '2026-05-24T00:00:00.000Z',
        taskId: 'task-sync-stop-cleanup',
      },
    });
    spawnAgentMock.mockImplementationOnce(() => {
      throw new Error('PTY spawn failed');
    });
    await expect(
      spawnTaskAgentWorkflow(createContext(), {
        agentId: 'agent-sync-stop-cleanup',
        args: [],
        cols: 80,
        command: 'codex',
        cwd: '/tmp/task-sync-stop-cleanup',
        env: {},
        rows: 24,
        runnerProfile: { image: 'agent:latest', provider: 'docker-container' },
        taskId: 'task-sync-stop-cleanup',
      }),
    ).rejects.toThrow('prepared runner cleanup also failed');
    killAgentAndWaitForRunnerCleanupMock.mockImplementationOnce(() => {
      throw new Error('synchronous PTY cleanup failed');
    });

    await expect(stopTaskAgentWorkflow('agent-sync-stop-cleanup')).rejects.toThrow(
      'synchronous PTY cleanup failed',
    );

    expect(killAgentAndWaitForRunnerCleanupMock).toHaveBeenCalledOnce();
    expect(preparedCleanup).toHaveBeenCalledTimes(2);
    expect(cleanupPendingDockerAgentRunnerBuildsMock).toHaveBeenCalledWith({
      agentIds: new Set(['agent-sync-stop-cleanup']),
    });
  });

  it('skips plan and git watchers for shell agents', async () => {
    const context = createContext();

    await spawnTaskAgentWorkflow(context, {
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

  it('starts git task watchers for the watcher-owning shell', async () => {
    const context = createContext();

    await spawnTaskAgentWorkflow(context, {
      taskId: 'task-terminal-git',
      agentId: 'shell-terminal-git',
      command: 'bash',
      args: ['-l'],
      baseBranch: 'release/main',
      cwd: '/tmp/task-terminal-git',
      env: {},
      cols: 80,
      rows: 24,
      isShell: true,
      startsTaskWatchers: true,
      onOutput: { __CHANNEL_ID__: 'channel-terminal-git' },
    });

    expect(spawnAgentMock).toHaveBeenCalledOnce();
    expect(ensurePlansDirectoryMock).toHaveBeenCalledWith('/tmp/task-terminal-git');
    expect(startPlanWatcherMock).toHaveBeenCalledWith(
      'task-terminal-git',
      '/tmp/task-terminal-git',
      expect.any(Function),
    );
    expect(startTaskGitStatusMonitoringMock).toHaveBeenCalledWith(context, {
      baseBranch: 'release/main',
      taskId: 'task-terminal-git',
      worktreePath: '/tmp/task-terminal-git',
    });
  });

  it('restores plan watchers when the watcher-owning non-git shell attaches', async () => {
    const context = createContext();
    hasAgentSessionMock.mockReturnValue(true);

    await spawnTaskAgentWorkflow(context, {
      taskId: 'task-terminal-non-git',
      agentId: 'shell-terminal-non-git',
      command: 'bash',
      args: ['-l'],
      cwd: '/tmp/task-terminal-non-git',
      env: {},
      cols: 80,
      rows: 24,
      isShell: true,
      projectMode: 'non-git',
      startsTaskWatchers: true,
      onOutput: { __CHANNEL_ID__: 'channel-terminal-non-git' },
    });

    expect(spawnAgentMock).toHaveBeenCalledOnce();
    expect(ensurePlansDirectoryMock).toHaveBeenCalledWith('/tmp/task-terminal-non-git');
    expect(startPlanWatcherMock).toHaveBeenCalledWith(
      'task-terminal-non-git',
      '/tmp/task-terminal-non-git',
      expect.any(Function),
    );
    expect(startTaskGitStatusMonitoringMock).not.toHaveBeenCalled();
  });

  it('starts plan watchers but not git watchers for non-git agents', async () => {
    const context = createContext();

    await spawnTaskAgentWorkflow(context, {
      taskId: 'task-non-git',
      agentId: 'agent-non-git',
      command: 'codex',
      args: ['run'],
      cwd: '/tmp/non-git-task',
      env: {},
      cols: 80,
      rows: 24,
      projectMode: 'non-git',
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    expect(spawnAgentMock).toHaveBeenCalledOnce();
    expect(ensurePlansDirectoryMock).toHaveBeenCalledWith('/tmp/non-git-task');
    expect(startPlanWatcherMock).toHaveBeenCalledWith(
      'task-non-git',
      '/tmp/non-git-task',
      expect.any(Function),
    );
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
      'main',
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

  it('resolves the managed base branch before creation and retries without leaking a worktree', async () => {
    const context = createContext();
    const request = {
      branchPrefix: 'task',
      name: 'Ordered task',
      operationId: 'create-operation-base-resolution',
      projectId: 'project-1',
      projectRoot: '/tmp/project',
      symlinkDirs: [],
    };
    getMainBranchMock
      .mockRejectedValueOnce(new Error('cannot resolve base branch'))
      .mockResolvedValueOnce('main');
    createTaskMock.mockResolvedValueOnce({
      branch_name: 'task/ordered-task',
      git_isolation: 'worktree',
      id: 'task-ordered',
      worktree_path: '/tmp/project/.worktrees/task/ordered-task',
    });

    await expect(createTaskWorkflow(context, request)).rejects.toThrow(
      'cannot resolve base branch',
    );
    expect(createTaskMock).not.toHaveBeenCalled();

    await expect(createTaskWorkflow(context, request)).resolves.toMatchObject({
      base_branch: 'main',
      id: 'task-ordered',
    });
    expect(createTaskMock).toHaveBeenCalledOnce();
    expect(createTaskMock).toHaveBeenCalledWith('Ordered task', '/tmp/project', [], 'task', 'main');
  });

  it('creates non-git task runtime without git metadata or git watchers', async () => {
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

  it('replays a concurrent task creation operation without repeating side effects', async () => {
    const context = createContext();
    const deferred = createDeferred<TestGitTaskResult>();
    createCurrentBranchTaskMock.mockReturnValue(deferred.promise);
    const request = {
      ...createCurrentBranchWorkflowRequest('/tmp/project'),
      agentDefId: 'codex',
      agentDefName: 'Codex CLI',
      operationId: 'create-operation-1',
    };

    const first = createTaskWorkflow(context, request);
    const replay = createTaskWorkflow(context, request);
    deferred.resolve(createTestGitTaskResult('task-replayed', '/tmp/project', 'current-branch'));

    await expect(Promise.all([first, replay])).resolves.toEqual([
      createTestGitTaskResult('task-replayed', '/tmp/project', 'current-branch'),
      createTestGitTaskResult('task-replayed', '/tmp/project', 'current-branch'),
    ]);
    expect(createCurrentBranchTaskMock).toHaveBeenCalledTimes(1);
    expect(startTaskGitStatusMonitoringMock).toHaveBeenCalledTimes(1);

    await expect(createTaskWorkflow(context, request)).resolves.toEqual(
      createTestGitTaskResult('task-replayed', '/tmp/project', 'current-branch'),
    );
    expect(createCurrentBranchTaskMock).toHaveBeenCalledTimes(1);
  });

  it('rejects task creation operation ids reused with different inputs', async () => {
    const context = createContext();
    const deferred = createDeferred<TestGitTaskResult>();
    createCurrentBranchTaskMock.mockReturnValue(deferred.promise);
    const request = {
      ...createCurrentBranchWorkflowRequest('/tmp/project'),
      operationId: 'create-operation-conflict',
    };
    const first = createTaskWorkflow(context, request);

    await expect(
      createTaskWorkflow(context, { ...request, name: 'Different task' }),
    ).rejects.toThrow('was reused with different inputs');

    deferred.resolve(createTestGitTaskResult('task-original', '/tmp/project', 'current-branch'));
    await expect(first).resolves.toEqual(
      createTestGitTaskResult('task-original', '/tmp/project', 'current-branch'),
    );
    expect(createCurrentBranchTaskMock).toHaveBeenCalledTimes(1);
  });

  it('releases failed task creation operations for a real retry', async () => {
    const context = createContext();
    const request = {
      ...createCurrentBranchWorkflowRequest('/tmp/project'),
      operationId: 'create-operation-retry',
    };
    createCurrentBranchTaskMock
      .mockRejectedValueOnce(new Error('checkout failed'))
      .mockResolvedValueOnce(
        createTestGitTaskResult('task-retried', '/tmp/project', 'current-branch'),
      );

    await expect(createTaskWorkflow(context, request)).rejects.toThrow('checkout failed');
    await expect(createTaskWorkflow(context, request)).resolves.toEqual(
      createTestGitTaskResult('task-retried', '/tmp/project', 'current-branch'),
    );
    expect(createCurrentBranchTaskMock).toHaveBeenCalledTimes(2);
  });

  it('forgets task creation replay state when the task is removed', async () => {
    const context = createContext();
    const request = {
      ...createCurrentBranchWorkflowRequest('/tmp/project'),
      operationId: 'create-operation-removed',
    };
    createCurrentBranchTaskMock
      .mockResolvedValueOnce(
        createTestGitTaskResult('task-first', '/tmp/project', 'current-branch'),
      )
      .mockResolvedValueOnce(
        createTestGitTaskResult('task-second', '/tmp/project', 'current-branch'),
      );

    await expect(createTaskWorkflow(context, request)).resolves.toMatchObject({ id: 'task-first' });
    cleanupTaskRuntimeWorkflow({
      agentIds: [],
      projectMode: 'git',
      removeTaskState: true,
      taskId: 'task-first',
      worktreePath: '/tmp/project',
    });
    await expect(createTaskWorkflow(context, request)).resolves.toMatchObject({
      id: 'task-second',
    });

    expect(createCurrentBranchTaskMock).toHaveBeenCalledTimes(2);
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

  it('reserves an existing worktree across the asynchronous import boundary', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-workflow-pending-'));
    const worktreePath = path.join(tempRoot, 'imported-worktree');
    const aliasedWorktreePath = path.join(tempRoot, 'aliased-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.symlinkSync(worktreePath, aliasedWorktreePath, 'dir');
    const deferred = createDeferred<TestGitTaskResult>();
    importExistingWorktreeTaskMock.mockReturnValueOnce(deferred.promise);

    try {
      const firstCreation = createTaskWorkflow(
        createContext(),
        createExistingWorktreeWorkflowRequest(worktreePath),
      );

      await expect(
        createTaskWorkflow(
          createContext(),
          createExistingWorktreeWorkflowRequest(aliasedWorktreePath, 'Concurrent imported task'),
        ),
      ).rejects.toThrow('already being registered');
      expect(importExistingWorktreeTaskMock).toHaveBeenCalledTimes(1);

      deferred.resolve(createTestGitTaskResult('task-imported', worktreePath, 'existing-worktree'));
      await expect(firstCreation).resolves.toMatchObject({ id: 'task-imported' });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps a lagging saved snapshot from claiming a reserved worktree mid-import', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-workflow-sync-race-'));
    const worktreePath = path.join(tempRoot, 'imported-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });
    const deferred = createDeferred<TestGitTaskResult>();
    importExistingWorktreeTaskMock.mockReturnValueOnce(deferred.promise);

    try {
      const creation = createTaskWorkflow(
        createContext(),
        createExistingWorktreeWorkflowRequest(worktreePath),
      );
      await vi.waitFor(() => {
        expect(importExistingWorktreeTaskMock).toHaveBeenCalledOnce();
      });

      syncTaskWorkflowWorktreesFromSavedState(
        JSON.stringify({
          tasks: {
            'task-stale': {
              id: 'task-stale',
              worktreePath,
            },
          },
        }),
      );

      deferred.resolve(createTestGitTaskResult('task-imported', worktreePath, 'existing-worktree'));
      await expect(creation).resolves.toMatchObject({ id: 'task-imported' });
      expect(findRegisteredTaskIdForWorktreePath(worktreePath)).toBe('task-imported');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('resolves existing-worktree subdirectories to their Git root before admission', async () => {
    getGitRepoRootMock.mockImplementation((candidatePath: string) =>
      Promise.resolve(
        candidatePath === '/tmp/project' ? '/tmp/project' : '/repo/.worktrees/imported',
      ),
    );
    importExistingWorktreeTaskMock.mockResolvedValue(
      createTestGitTaskResult(
        'task-imported-root',
        '/repo/.worktrees/imported',
        'existing-worktree',
      ),
    );

    await expect(
      createTaskWorkflow(
        createContext(),
        createExistingWorktreeWorkflowRequest('/repo/.worktrees/imported/src'),
      ),
    ).resolves.toMatchObject({ id: 'task-imported-root' });

    expect(getGitRepoRootMock).toHaveBeenCalledWith('/repo/.worktrees/imported/src');
    expect(importExistingWorktreeTaskMock).toHaveBeenCalledWith(
      '/tmp/project',
      '/repo/.worktrees/imported',
      'main',
    );
    await expect(
      createTaskWorkflow(
        createContext(),
        createExistingWorktreeWorkflowRequest('/repo/.worktrees/imported'),
      ),
    ).rejects.toThrow('already registered for task task-imported-root');
    expect(importExistingWorktreeTaskMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an existing-worktree path outside a Git repository before import', async () => {
    getGitRepoRootMock.mockImplementation((candidatePath: string) =>
      Promise.resolve(candidatePath === '/tmp/project' ? '/tmp/project' : null),
    );

    await expect(
      createTaskWorkflow(
        createContext(),
        createExistingWorktreeWorkflowRequest('/tmp/not-a-worktree'),
      ),
    ).rejects.toThrow('Existing worktree is not a Git repository');
    expect(importExistingWorktreeTaskMock).not.toHaveBeenCalled();
  });

  it('rejects the main checkout when project and imported paths resolve to the same Git root', async () => {
    getGitRepoRootMock.mockResolvedValue('/repo');

    await expect(
      createTaskWorkflow(createContext(), {
        ...createExistingWorktreeWorkflowRequest('/repo'),
        projectRoot: '/repo/packages/app',
      }),
    ).rejects.toThrow('Existing worktree import cannot use the project root');

    expect(getGitRepoRootMock).toHaveBeenCalledWith('/repo/packages/app');
    expect(getGitRepoRootMock).toHaveBeenCalledWith('/repo');
    expect(importExistingWorktreeTaskMock).not.toHaveBeenCalled();
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

  it('normalizes a legacy saved worktree subdirectory to its nearest Git root', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-workflow-legacy-root-'));
    const worktreePath = path.join(tempRoot, 'imported-worktree');
    const nestedPath = path.join(worktreePath, 'packages', 'frontend');
    fs.mkdirSync(path.join(worktreePath, '.git'), { recursive: true });
    fs.mkdirSync(nestedPath, { recursive: true });

    try {
      syncTaskWorkflowWorktreesFromSavedState(
        JSON.stringify({
          tasks: {
            'task-existing': {
              id: 'task-existing',
              worktreePath: nestedPath,
            },
          },
        }),
      );

      expect(findRegisteredTaskIdForWorktreePath(worktreePath)).toBe('task-existing');
      await expect(
        createTaskWorkflow(
          createContext(),
          createExistingWorktreeWorkflowRequest(worktreePath, 'Duplicate imported task'),
        ),
      ).rejects.toThrow('already registered for task task-existing');
      expect(importExistingWorktreeTaskMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps a nested Git worktree distinct from its parent checkout during saved-state migration', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-workflow-nested-root-'));
    const projectRoot = path.join(tempRoot, 'project');
    const worktreePath = path.join(projectRoot, '.worktrees', 'feature');
    const nestedPath = path.join(worktreePath, 'packages', 'frontend');
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(worktreePath, '.git'), { recursive: true });
    fs.mkdirSync(nestedPath, { recursive: true });

    try {
      syncTaskWorkflowWorktreesFromSavedState(
        JSON.stringify({
          tasks: {
            'task-root': {
              id: 'task-root',
              worktreePath: projectRoot,
            },
            'task-worktree': {
              id: 'task-worktree',
              worktreePath: nestedPath,
            },
          },
        }),
      );

      expect(findRegisteredTaskIdForWorktreePath(projectRoot)).toBe('task-root');
      expect(findRegisteredTaskIdForWorktreePath(worktreePath)).toBe('task-worktree');
      expect(findRegisteredTaskIdForWorktreePath(nestedPath)).toBe('task-worktree');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not map a missing saved worktree onto an ancestor repository', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-workflow-missing-root-'));
    const projectRoot = path.join(tempRoot, 'project');
    const missingWorktreePath = path.join(projectRoot, '.worktrees', 'missing');
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });

    try {
      syncTaskWorkflowWorktreesFromSavedState(
        JSON.stringify({
          tasks: {
            'task-missing': {
              id: 'task-missing',
              worktreePath: missingWorktreePath,
            },
          },
        }),
      );

      expect(findRegisteredTaskIdForWorktreePath(missingWorktreePath)).toBe('task-missing');
      expect(findRegisteredTaskIdForWorktreePath(projectRoot)).toBeNull();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('maps registered task worktree descendants to the owning task without matching siblings', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-workflow-owner-'));
    const worktreePath = path.join(tempRoot, 'task');
    const nestedPath = path.join(worktreePath, 'packages', 'frontend');
    const dotPrefixedNestedPath = path.join(worktreePath, '..frontend');
    const siblingPath = path.join(tempRoot, 'task-sibling');
    fs.mkdirSync(nestedPath, { recursive: true });
    fs.mkdirSync(dotPrefixedNestedPath, { recursive: true });
    fs.mkdirSync(siblingPath, { recursive: true });

    try {
      syncTaskWorkflowWorktreesFromSavedState(
        JSON.stringify({
          tasks: {
            'task-owner': {
              id: 'task-owner',
              worktreePath,
            },
          },
        }),
      );

      expect(findRegisteredTaskIdForWorktreePath(nestedPath)).toBe('task-owner');
      expect(findRegisteredTaskIdForWorktreePath(dotPrefixedNestedPath)).toBe('task-owner');
      expect(findRegisteredTaskIdForWorktreePath(siblingPath)).toBeNull();
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
      ).resolves.toEqual({
        id: 'task-imported',
        branch_name: 'task/imported',
        worktree_path: folderPath,
        base_branch: 'main',
        git_isolation: 'existing-worktree',
      });
      expect(importExistingWorktreeTaskMock).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('allows multiple non-git tasks in the same folder', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-non-git-duplicate-'));
    const folderPath = path.join(tempRoot, 'folder');
    const aliasedFolderPath = path.join(tempRoot, 'folder-alias');
    fs.mkdirSync(folderPath, { recursive: true });
    fs.symlinkSync(folderPath, aliasedFolderPath, 'dir');
    createNonGitTaskMock
      .mockReturnValueOnce({
        id: 'task-non-git-1',
        branch_name: '',
        project_mode: 'non-git',
        worktree_path: folderPath,
      })
      .mockReturnValueOnce({
        id: 'task-non-git-2',
        branch_name: '',
        project_mode: 'non-git',
        worktree_path: aliasedFolderPath,
      });

    try {
      await expect(
        createTaskWorkflow(createContext(), {
          name: 'Folder task',
          projectId: 'project-1',
          projectMode: 'non-git',
          projectRoot: folderPath,
          symlinkDirs: [],
        }),
      ).resolves.toEqual({
        id: 'task-non-git-1',
        branch_name: '',
        project_mode: 'non-git',
        worktree_path: folderPath,
      });

      await expect(
        createTaskWorkflow(createContext(), {
          name: 'Second folder task',
          projectId: 'project-1',
          projectMode: 'non-git',
          projectRoot: aliasedFolderPath,
          symlinkDirs: [],
        }),
      ).resolves.toEqual({
        id: 'task-non-git-2',
        branch_name: '',
        project_mode: 'non-git',
        worktree_path: aliasedFolderPath,
      });
      expect(createNonGitTaskMock).toHaveBeenCalledTimes(2);
      expect(createNonGitTaskMock).toHaveBeenNthCalledWith(1, folderPath);
      expect(createNonGitTaskMock).toHaveBeenNthCalledWith(2, aliasedFolderPath);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects duplicate non-git task step tracking across canonical path aliases', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-non-git-steps-'));
    const folderPath = path.join(tempRoot, 'folder');
    const aliasedFolderPath = path.join(tempRoot, 'folder-alias');
    fs.mkdirSync(folderPath, { recursive: true });
    fs.symlinkSync(folderPath, aliasedFolderPath, 'dir');
    createNonGitTaskMock.mockReturnValueOnce({
      id: 'task-non-git-steps',
      branch_name: '',
      project_mode: 'non-git',
      worktree_path: folderPath,
    });

    try {
      await createTaskWorkflow(createContext(), {
        name: 'Folder task',
        projectId: 'project-1',
        projectMode: 'non-git',
        projectRoot: folderPath,
        symlinkDirs: [],
        stepsTracking: true,
      });

      await expect(
        createTaskWorkflow(createContext(), {
          name: 'Second folder task',
          projectId: 'project-1',
          projectMode: 'non-git',
          projectRoot: aliasedFolderPath,
          symlinkDirs: [],
          stepsTracking: true,
        }),
      ).rejects.toThrow('Task steps are already registered for task task-non-git-steps');
      expect(createNonGitTaskMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps a current-branch path reserved while creation is pending across saved-state syncs', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-current-pending-'));
    const folderPath = path.join(tempRoot, 'folder');
    const aliasedFolderPath = path.join(tempRoot, 'folder-alias');
    fs.mkdirSync(folderPath, { recursive: true });
    fs.symlinkSync(folderPath, aliasedFolderPath, 'dir');
    const deferred = createDeferred<TestGitTaskResult>();
    createCurrentBranchTaskMock.mockReturnValueOnce(deferred.promise);

    try {
      const firstCreation = createTaskWorkflow(
        createContext(),
        createCurrentBranchWorkflowRequest(folderPath),
      );

      syncTaskWorkflowWorktreesFromSavedState(JSON.stringify({ tasks: {} }));
      await expect(
        createTaskWorkflow(
          createContext(),
          createCurrentBranchWorkflowRequest(aliasedFolderPath, 'Concurrent direct task'),
        ),
      ).rejects.toThrow('already being registered');
      expect(createCurrentBranchTaskMock).toHaveBeenCalledTimes(1);

      deferred.resolve(createTestGitTaskResult('task-current', folderPath, 'current-branch'));
      await expect(firstCreation).resolves.toMatchObject({ id: 'task-current' });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('resolves current-branch tasks to the backend Git root before admission or checkout', async () => {
    getGitRepoRootMock.mockResolvedValue('/repo');
    createCurrentBranchTaskMock.mockResolvedValue(
      createTestGitTaskResult('task-current-root', '/repo', 'current-branch'),
    );

    await expect(
      createTaskWorkflow(
        createContext(),
        createCurrentBranchWorkflowRequest('/repo/packages/frontend'),
      ),
    ).resolves.toMatchObject({
      id: 'task-current-root',
      worktree_path: '/repo',
    });

    expect(getGitRepoRootMock).toHaveBeenCalledWith('/repo/packages/frontend');
    expect(createCurrentBranchTaskMock).toHaveBeenCalledWith('/repo', undefined);
    await expect(
      createTaskWorkflow(createContext(), createCurrentBranchWorkflowRequest('/repo')),
    ).rejects.toThrow('already registered for task task-current-root');
    expect(createCurrentBranchTaskMock).toHaveBeenCalledTimes(1);
  });

  it('rejects project-root tasks outside a Git repository before mutation', async () => {
    getGitRepoRootMock.mockResolvedValue(null);

    await expect(
      createTaskWorkflow(createContext(), createCurrentBranchWorkflowRequest('/tmp/not-a-repo')),
    ).rejects.toThrow('Project root is not a Git repository');
    expect(createCurrentBranchTaskMock).not.toHaveBeenCalled();
  });

  it('releases a current-branch reservation when creation fails', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-current-retry-'));
    const folderPath = path.join(tempRoot, 'folder');
    fs.mkdirSync(folderPath, { recursive: true });
    const deferred = createDeferred<TestGitTaskResult>();
    createCurrentBranchTaskMock
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValueOnce(
        createTestGitTaskResult('task-current-retry', folderPath, 'current-branch'),
      );

    try {
      const failedCreation = createTaskWorkflow(
        createContext(),
        createCurrentBranchWorkflowRequest(folderPath),
      );
      deferred.reject(new Error('branch switch failed'));
      await expect(failedCreation).rejects.toThrow('branch switch failed');

      await expect(
        createTaskWorkflow(
          createContext(),
          createCurrentBranchWorkflowRequest(folderPath, 'Retried direct task'),
        ),
      ).resolves.toMatchObject({ id: 'task-current-retry' });
      await vi.waitFor(() => {
        expect(createCurrentBranchTaskMock).toHaveBeenCalledTimes(2);
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not serialize current-branch creation for different canonical paths', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-current-concurrent-'));
    const firstPath = path.join(tempRoot, 'first');
    const secondPath = path.join(tempRoot, 'second');
    fs.mkdirSync(firstPath, { recursive: true });
    fs.mkdirSync(secondPath, { recursive: true });
    const firstDeferred = createDeferred<TestGitTaskResult>();
    const secondDeferred = createDeferred<TestGitTaskResult>();
    createCurrentBranchTaskMock
      .mockReturnValueOnce(firstDeferred.promise)
      .mockReturnValueOnce(secondDeferred.promise);

    try {
      const firstCreation = createTaskWorkflow(
        createContext(),
        createCurrentBranchWorkflowRequest(firstPath, 'First direct task'),
      );
      const secondCreation = createTaskWorkflow(createContext(), {
        ...createCurrentBranchWorkflowRequest(secondPath, 'Second direct task'),
        projectId: 'project-2',
      });

      await vi.waitFor(() => {
        expect(createCurrentBranchTaskMock).toHaveBeenCalledTimes(2);
      });
      firstDeferred.resolve(
        createTestGitTaskResult('task-current-first', firstPath, 'current-branch'),
      );
      secondDeferred.resolve(
        createTestGitTaskResult('task-current-second', secondPath, 'current-branch'),
      );

      await expect(Promise.all([firstCreation, secondCreation])).resolves.toHaveLength(2);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps live worktree registrations authoritative over lagging saved snapshots', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-current-live-'));
    const folderPath = path.join(tempRoot, 'folder');
    const aliasedFolderPath = path.join(tempRoot, 'folder-alias');
    fs.mkdirSync(folderPath, { recursive: true });
    fs.symlinkSync(folderPath, aliasedFolderPath, 'dir');
    createCurrentBranchTaskMock.mockResolvedValueOnce(
      createTestGitTaskResult('task-current-live', folderPath, 'current-branch'),
    );

    try {
      await createTaskWorkflow(createContext(), createCurrentBranchWorkflowRequest(folderPath));
      syncTaskWorkflowWorktreesFromSavedState(JSON.stringify({ tasks: {} }));

      await expect(
        createTaskWorkflow(
          createContext(),
          createCurrentBranchWorkflowRequest(aliasedFolderPath, 'Stale snapshot duplicate'),
        ),
      ).rejects.toThrow('already registered for task task-current-live');
      expect(createCurrentBranchTaskMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not resurrect a cleaned worktree registration from a stale saved snapshot', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-current-removed-'));
    const folderPath = path.join(tempRoot, 'folder');
    fs.mkdirSync(folderPath, { recursive: true });
    createCurrentBranchTaskMock
      .mockResolvedValueOnce(
        createTestGitTaskResult('task-current-removed', folderPath, 'current-branch'),
      )
      .mockResolvedValueOnce(
        createTestGitTaskResult('task-current-replacement', folderPath, 'current-branch'),
      );

    try {
      await createTaskWorkflow(createContext(), createCurrentBranchWorkflowRequest(folderPath));
      cleanupTaskRuntimeWorkflow({
        agentIds: [],
        removeTaskState: true,
        taskId: 'task-current-removed',
        worktreePath: folderPath,
      });
      syncTaskWorkflowWorktreesFromSavedState(
        JSON.stringify({
          tasks: {
            'task-current-removed': {
              id: 'task-current-removed',
              worktreePath: folderPath,
            },
          },
        }),
      );

      await expect(
        createTaskWorkflow(
          createContext(),
          createCurrentBranchWorkflowRequest(folderPath, 'Replacement direct task'),
        ),
      ).resolves.toMatchObject({ id: 'task-current-replacement' });
      expect(createCurrentBranchTaskMock).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('still rejects duplicate current-branch tasks across canonical path aliases', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-current-duplicate-'));
    const folderPath = path.join(tempRoot, 'folder');
    const aliasedFolderPath = path.join(tempRoot, 'folder-alias');
    fs.mkdirSync(folderPath, { recursive: true });
    fs.symlinkSync(folderPath, aliasedFolderPath, 'dir');
    createCurrentBranchTaskMock.mockResolvedValueOnce({
      id: 'task-current',
      branch_name: 'main',
      worktree_path: folderPath,
      base_branch: 'main',
      git_isolation: 'current-branch',
    });

    try {
      await createTaskWorkflow(createContext(), {
        name: 'Folder task',
        projectId: 'project-1',
        projectRoot: folderPath,
        symlinkDirs: [],
        gitIsolation: 'current-branch',
      });

      await expect(
        createTaskWorkflow(createContext(), {
          name: 'Duplicate folder task',
          projectId: 'project-1',
          projectRoot: aliasedFolderPath,
          symlinkDirs: [],
          gitIsolation: 'current-branch',
        }),
      ).rejects.toThrow('already registered for task task-current');
      expect(createCurrentBranchTaskMock).toHaveBeenCalledTimes(1);
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

  it('stops task watchers after deletion cleanup is attempted', async () => {
    deleteTaskMock.mockResolvedValue(undefined);

    const result = await deleteTaskWorkflow({
      taskId: 'task-3',
      agentIds: ['agent-1'],
      branchName: 'task/delete',
      deleteBranch: true,
      projectRoot: '/tmp/project',
      worktreePath: '/tmp/project/.worktrees/task-3',
    });

    expect(result.cleanupWarnings).toEqual([]);
    expect(destroyManagedTaskContainersByLabelsMock).toHaveBeenCalledWith({
      projectPath: '/tmp/project',
      taskId: 'task-3',
      worktreePath: '/tmp/project/.worktrees/task-3',
    });
    expect(killAgentAndWaitForRunnerCleanupMock).toHaveBeenCalledWith('agent-1');
    expect(deleteTaskMock).toHaveBeenCalledWith('task/delete', true, '/tmp/project');
    expect(stopPlanWatcherMock).toHaveBeenCalledWith('task-3');
    expect(stopTaskGitStatusWatcherMock).toHaveBeenCalledWith('task-3');
    expect(removeTaskSupervisionMock).toHaveBeenCalledWith('task-3');
    expect(removeTaskConvergenceMock).toHaveBeenCalledWith('task-3');
    expect(removeTaskReviewMock).toHaveBeenCalledWith('task-3');
    expect(removeTaskReviewSignalsMock).toHaveBeenCalledWith('task-3');
    expect(removeTaskPortsMock).toHaveBeenCalledWith('task-3');
    expect(removeTaskContainerPreviewTargetsMock).toHaveBeenCalledWith('task-3');
    expect(removeGitStatusSnapshotMock).toHaveBeenCalledWith('/tmp/project/.worktrees/task-3');
    expect(
      destroyManagedTaskContainersByLabelsMock.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    ).toBeLessThan(deleteTaskMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
    expect(deleteTaskMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(
      stopPlanWatcherMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(
      stopPlanWatcherMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(
      stopTaskGitStatusWatcherMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('still removes backend task state when task worktree cleanup fails', async () => {
    deleteTaskMock.mockRejectedValue(new Error('delete failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await deleteTaskWorkflow({
        taskId: 'task-3',
        agentIds: ['agent-1'],
        branchName: 'task/delete',
        deleteBranch: true,
        projectRoot: '/tmp/project',
        worktreePath: '/tmp/project/.worktrees/task-3',
      });

      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to clean task worktree while deleting task:',
        expect.any(Error),
      );
      expect(result.cleanupWarnings).toEqual([
        {
          kind: 'worktree',
          message: 'Failed to clean task worktree while deleting task: delete failed',
        },
      ]);
      expect(stopPlanWatcherMock).toHaveBeenCalledWith('task-3');
      expect(stopTaskGitStatusWatcherMock).toHaveBeenCalledWith('task-3');
      expect(removeTaskSupervisionMock).toHaveBeenCalledWith('task-3');
      expect(removeTaskConvergenceMock).toHaveBeenCalledWith('task-3');
      expect(removeTaskReviewMock).toHaveBeenCalledWith('task-3');
      expect(removeTaskReviewSignalsMock).toHaveBeenCalledWith('task-3');
      expect(removeTaskPortsMock).toHaveBeenCalledWith('task-3');
      expect(removeTaskContainerPreviewTargetsMock).toHaveBeenCalledWith('task-3');
      expect(removeGitStatusSnapshotMock).toHaveBeenCalledWith('/tmp/project/.worktrees/task-3');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('awaits runner cleanup and reports failures without skipping later deletion steps', async () => {
    killAgentAndWaitForRunnerCleanupMock.mockRejectedValue(new Error('runner cleanup failed'));
    deleteTaskMock.mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await deleteTaskWorkflow({
        agentIds: ['agent-1'],
        branchName: 'task/delete',
        deleteBranch: true,
        projectRoot: '/tmp/project',
        taskId: 'task-3',
        worktreePath: '/tmp/project/.worktrees/task-3',
      });

      expect(result.cleanupWarnings).toContainEqual({
        kind: 'runners',
        message: 'Failed to clean agent runners while deleting task: runner cleanup failed',
      });
      expect(destroyManagedTaskContainersByLabelsMock).toHaveBeenCalledOnce();
      expect(deleteTaskMock).toHaveBeenCalledOnce();
      expect(removeTaskSupervisionMock).toHaveBeenCalledWith('task-3');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reports synchronous task runner cleanup failure after attempting later owners', async () => {
    killTaskAgentsAndWaitForRunnerCleanupMock.mockImplementationOnce(() => {
      throw new Error('synchronous task runner cleanup failed');
    });
    deleteTaskMock.mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await deleteTaskWorkflow({
        agentIds: ['agent-1'],
        branchName: 'task/delete',
        deleteBranch: true,
        projectRoot: '/tmp/project',
        taskId: 'task-3',
        worktreePath: '/tmp/project/.worktrees/task-3',
      });

      expect(result.cleanupWarnings).toContainEqual({
        kind: 'runners',
        message:
          'Failed to clean agent runners while deleting task: synchronous task runner cleanup failed',
      });
      expect(cleanupPendingDockerAgentRunnerBuildsMock).toHaveBeenCalledWith({ taskId: 'task-3' });
      expect(deleteTaskMock).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still removes backend task state when task container cleanup fails', async () => {
    destroyManagedTaskContainersByLabelsMock.mockRejectedValue(new Error('container failed'));
    deleteTaskMock.mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await deleteTaskWorkflow({
        taskId: 'task-3',
        agentIds: ['agent-1'],
        branchName: 'task/delete',
        deleteBranch: true,
        projectRoot: '/tmp/project',
        worktreePath: '/tmp/project/.worktrees/task-3',
      });

      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to clean task containers while deleting task:',
        expect.any(Error),
      );
      expect(result.cleanupWarnings).toEqual([
        {
          kind: 'containers',
          message: 'Failed to clean task containers while deleting task: container failed',
        },
      ]);
      expect(deleteTaskMock).toHaveBeenCalledWith('task/delete', true, '/tmp/project');
      expect(stopPlanWatcherMock).toHaveBeenCalledWith('task-3');
      expect(stopTaskGitStatusWatcherMock).toHaveBeenCalledWith('task-3');
    } finally {
      warnSpy.mockRestore();
    }
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

  it('forwards plan watcher updates to the IPC event channel', async () => {
    const context = createContext();

    await spawnTaskAgentWorkflow(context, {
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
