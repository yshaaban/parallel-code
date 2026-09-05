import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskNameRegistry } from '../../server/task-names.js';
import {
  COORDINATOR_LIMITS,
  type CoordinatorSubtaskStatus,
  type CoordinatorUiToolCallRequest,
} from '../../src/domain/coordinator.js';
import type { HandlerContext } from '../ipc/handler-context.js';
import type { StorageEnv } from '../ipc/storage.js';

const mocks = vi.hoisted(() => {
  const supervisionListeners = new Set<(event: unknown) => void>();
  const spawnTaskAgentWorkflowMock = vi.fn(() => false);
  return {
    cleanupTaskRuntimeWorkflowMock: vi.fn(() => ({ releasedTaskCommandController: null })),
    createTaskWorkflowMock: vi.fn(),
    deleteTaskWorkflowMock: vi.fn(() =>
      Promise.resolve({ cleanupWarnings: [], releasedTaskCommandController: null }),
    ),
    getAgentMetaMock: vi.fn(),
    getAgentScrollbackBufferMock: vi.fn(),
    getAgentSupervisionSnapshotMock: vi.fn(),
    getAllFileDiffsMock: vi.fn(),
    getProjectDiffMock: vi.fn(),
    getWorktreeStatusMock: vi.fn(),
    hasAgentSessionMock: vi.fn(),
    killAgentAndWaitForRunnerCleanupMock: vi.fn(async () => undefined),
    mergeTaskMock: vi.fn(),
    normalizeAgentRunnerProfileConfigMock: vi.fn(() => undefined),
    spawnOwnedTaskAgentWorkflowMock: vi.fn(
      (context: unknown, ownership: unknown, request: unknown) => {
        void ownership;
        return spawnTaskAgentWorkflowMock(context, request);
      },
    ),
    spawnTaskAgentWorkflowMock,
    stopTaskAgentWorkflowsForTaskMock: vi.fn(async () => undefined),
    subscribeAgentSupervisionMock: vi.fn((listener: (event: unknown) => void) => {
      supervisionListeners.add(listener);
      return () => supervisionListeners.delete(listener);
    }),
    supervisionListeners,
    writeToAgentMock: vi.fn(),
  };
});

vi.mock('../ipc/agent-supervision.js', () => ({
  getAgentSupervisionSnapshot: mocks.getAgentSupervisionSnapshotMock,
  subscribeAgentSupervision: mocks.subscribeAgentSupervisionMock,
}));

vi.mock('../ipc/agent-runner-handlers.js', () => ({
  normalizeAgentRunnerProfileConfig: mocks.normalizeAgentRunnerProfileConfigMock,
}));

vi.mock('../ipc/git.js', () => ({
  getAllFileDiffs: mocks.getAllFileDiffsMock,
  getProjectDiff: mocks.getProjectDiffMock,
  getWorktreeStatus: mocks.getWorktreeStatusMock,
  mergeTask: mocks.mergeTaskMock,
}));

vi.mock('../ipc/pty.js', () => ({
  getAgentMeta: mocks.getAgentMetaMock,
  getAgentScrollbackBuffer: mocks.getAgentScrollbackBufferMock,
  hasAgentSession: mocks.hasAgentSessionMock,
  killAgentAndWaitForRunnerCleanup: mocks.killAgentAndWaitForRunnerCleanupMock,
  writeToAgent: mocks.writeToAgentMock,
}));

vi.mock('../ipc/task-workflows.js', () => ({
  cleanupTaskRuntimeWorkflow: mocks.cleanupTaskRuntimeWorkflowMock,
  createTaskWorkflow: mocks.createTaskWorkflowMock,
  deleteTaskWorkflow: mocks.deleteTaskWorkflowMock,
  hasRegisteredSharedRootTask: vi.fn(() => false),
  spawnOwnedTaskAgentWorkflow: mocks.spawnOwnedTaskAgentWorkflowMock,
  spawnTaskAgentWorkflow: mocks.spawnTaskAgentWorkflowMock,
  stopTaskAgentWorkflowsForTask: mocks.stopTaskAgentWorkflowsForTaskMock,
}));

import {
  acquireTaskCommandLease,
  resetTaskCommandLeasesForTest,
} from '../ipc/task-command-leases.js';
import {
  addCoordinatorSubtask,
  getCoordinatorRun,
  resetCoordinatorRuntimeForTests,
  updateCoordinatorRunStatus,
  updateCoordinatorSubtaskStatus,
  updateCoordinatorWorkflow,
} from './runtime.js';
import * as coordinatorRuntime from './runtime.js';
import {
  cleanupCoordinatorStateForTask,
  createCoordinatorCredential,
  createCoordinatorRunForTask,
  ensureCoordinatorServiceLoaded,
  flushCoordinatorRuntimeState,
  getCoordinatorTaskCredentialPath,
  resetCoordinatorServiceForTests,
  resolveCoordinatorToken,
} from './service.js';
import {
  COORDINATOR_PARENT_CLEANUP_TIMEOUT_MS,
  cleanupCoordinatorProducersForShutdown,
  cleanupCoordinatorTaskStateAndOwnedSubtasks,
  executeCoordinatorProducer,
  executeCoordinatorRendererAction,
  executeCoordinatorToolCall,
  resetCoordinatorToolGatewayForTests,
  startCoordinatorPromptDeliveryRuntime,
} from './tool-gateway.js';
import {
  createContext,
  createStorageEnv as createCoordinatorTestStorageEnv,
  createSupervisionSnapshot,
  removeStorageEnv,
} from './test-helpers.test-helper.js';

function createStorageEnv(): StorageEnv {
  return createCoordinatorTestStorageEnv('parallel-code-coordinator-gateway-');
}

function readCredentialToken(credentialPath: string): string {
  return (JSON.parse(fs.readFileSync(credentialPath, 'utf8')) as { token: string }).token;
}

function createTaskRegistry(): Pick<
  TaskNameRegistry,
  'deleteTask' | 'markTaskClosing' | 'registerCreatedTask'
> {
  return {
    deleteTask: vi.fn(),
    markTaskClosing: vi.fn(),
    registerCreatedTask: vi.fn(),
  };
}

function unsafeRendererRequest(value: unknown): CoordinatorUiToolCallRequest {
  return value as CoordinatorUiToolCallRequest;
}

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function mockCreatedTaskResult(): void {
  mocks.createTaskWorkflowMock.mockResolvedValue({
    base_branch: 'main',
    branch_name: 'feature/child',
    git_isolation: 'worktree',
    id: 'task-child',
    worktree_path: '/repo/task-child',
  });
}

function mockCreatedTaskSequence(taskIds: string[]): void {
  let index = 0;
  mocks.createTaskWorkflowMock.mockImplementation(async () => {
    const taskId = taskIds[index] ?? `task-child-${index}`;
    index += 1;
    return {
      base_branch: 'main',
      branch_name: `feature/${taskId}`,
      git_isolation: 'worktree',
      id: taskId,
      worktree_path: `/repo/${taskId}`,
    };
  });
}

function readTaskCredentialToken(taskId: string): string {
  const credentialPath = getCoordinatorTaskCredentialPath(taskId);
  if (credentialPath === null) {
    throw new Error(`Missing coordinator credential for ${taskId}`);
  }

  return readCredentialToken(credentialPath);
}

function restartCoordinatorRuntime(): void {
  const persisted = coordinatorRuntime.getCoordinatorRuntimeState();
  resetCoordinatorRuntimeForTests();
  coordinatorRuntime.restoreCoordinatorRuntimeState(persisted);
}

function addExitedCoordinatorOwnedSubtask(
  context: HandlerContext,
  runId: string,
): ReturnType<typeof createCoordinatorCredential> {
  addCoordinatorSubtask({
    agentId: 'agent-child',
    assignment: 'Do the work',
    branchName: 'feature/child',
    parentCoordinatorTaskId: 'task-coordinator',
    runId,
    status: 'exited',
    taskId: 'task-child',
    toolTokenId: 'token-child',
    worktreePath: '/repo/task-child',
  });

  return createCoordinatorCredential(context, {
    agentId: 'agent-child',
    runId,
    taskId: 'task-child',
    toolCallUrl: context.coordinatorToolCallUrl,
  });
}

describe('coordinator tool gateway', () => {
  const envs: StorageEnv[] = [];

  beforeEach(() => {
    mocks.cleanupTaskRuntimeWorkflowMock.mockReturnValue({ releasedTaskCommandController: null });
    mocks.deleteTaskWorkflowMock.mockResolvedValue({
      cleanupWarnings: [],
      releasedTaskCommandController: null,
    });
    mocks.getAgentScrollbackBufferMock.mockReturnValue(Buffer.from(''));
    mocks.getAllFileDiffsMock.mockResolvedValue('');
    mocks.getProjectDiffMock.mockResolvedValue({
      files: [],
      totalAdded: 0,
      totalRemoved: 0,
    });
    mocks.normalizeAgentRunnerProfileConfigMock.mockReturnValue(undefined);
    mocks.killAgentAndWaitForRunnerCleanupMock.mockResolvedValue(undefined);
    mocks.spawnTaskAgentWorkflowMock.mockReturnValue(false);
  });

  afterEach(async () => {
    resetCoordinatorToolGatewayForTests();
    await resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    resetTaskCommandLeasesForTest();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.supervisionListeners.clear();
    for (const env of envs) {
      removeStorageEnv(env);
    }
    envs.length = 0;
  });

  it('reopens spawn admission when the coordinator runtime starts after a clean shutdown', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);

    const stopFirstRuntime = startCoordinatorPromptDeliveryRuntime(context);
    await stopFirstRuntime();

    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    mockCreatedTaskResult();
    mocks.hasAgentSessionMock.mockReturnValue(false);
    const stopSecondRuntime = startCoordinatorPromptDeliveryRuntime(context);

    try {
      await expect(
        executeCoordinatorToolCall(
          { context, taskNames: createTaskRegistry() },
          {
            callId: 'spawn-after-runtime-restart',
            runId: result.run.id,
            taskId: 'task-coordinator',
            token: readCredentialToken(result.credentialPath),
            toolName: 'spawn_subtask',
            payload: {
              agent: { command: 'custom-agent' },
              assignment: 'Prove restarted admission.',
              name: 'Restarted child',
            },
          },
        ),
      ).resolves.toMatchObject({ result: expect.objectContaining({ taskId: 'task-child' }) });
    } finally {
      await stopSecondRuntime();
    }
  });

  it('drains an admitted direct producer before coordinator shutdown completes', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const operation = createDeferredPromise<string>();
    const stopRuntime = startCoordinatorPromptDeliveryRuntime(context);

    const producer = executeCoordinatorProducer(context, () => operation.promise);
    await Promise.resolve();

    let shutdownSettled = false;
    const shutdown = stopRuntime().finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    operation.resolve('done');
    await expect(producer).resolves.toBe('done');
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('rejects a late producer from the preceding server lifecycle after restart', async () => {
    const firstEnv = createStorageEnv();
    const secondEnv = createStorageEnv();
    envs.push(firstEnv, secondEnv);
    const firstContext = createContext(firstEnv);
    const secondContext = createContext(secondEnv);
    const stopFirstRuntime = startCoordinatorPromptDeliveryRuntime(firstContext);
    await stopFirstRuntime();
    const stopSecondRuntime = startCoordinatorPromptDeliveryRuntime(secondContext);
    const lateOperation = vi.fn();

    await expect(executeCoordinatorProducer(firstContext, lateOperation)).rejects.toThrow(
      'stopped server lifecycle',
    );
    expect(lateOperation).not.toHaveBeenCalled();
    await expect(executeCoordinatorProducer(secondContext, () => 'current')).resolves.toBe(
      'current',
    );

    await stopSecondRuntime();
  });

  it('closes call admission and drains admitted agent and renderer writes before restart', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const taskNames = createTaskRegistry();
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    for (const suffix of ['agent-call', 'renderer-action']) {
      addCoordinatorSubtask({
        agentId: `agent-${suffix}`,
        assignment: `Close through ${suffix}`,
        branchName: `feature/${suffix}`,
        parentCoordinatorTaskId: 'task-coordinator',
        runId: result.run.id,
        status: 'running',
        taskId: `task-${suffix}`,
        toolTokenId: `token-${suffix}`,
        worktreePath: `/repo/task-${suffix}`,
      });
    }
    acquireTaskCommandLease(
      'task-coordinator',
      'browser-client-1',
      'user',
      'close a coordinator subtask',
    );
    const agentCleanup = createDeferredPromise<{
      cleanupWarnings: [];
      releasedTaskCommandController: null;
    }>();
    const rendererCleanup = createDeferredPromise<{
      cleanupWarnings: [];
      releasedTaskCommandController: null;
    }>();
    mocks.deleteTaskWorkflowMock
      .mockReturnValueOnce(agentCleanup.promise)
      .mockReturnValueOnce(rendererCleanup.promise);
    const stopRuntime = startCoordinatorPromptDeliveryRuntime(context, taskNames);
    const token = readCredentialToken(result.credentialPath);
    const cachedInspection = {
      coordinatorTaskId: 'task-coordinator',
      requestId: 'inspect-before-shutdown',
      runId: result.run.id,
      toolName: 'get_task_status' as const,
    };
    await expect(
      executeCoordinatorRendererAction({ context, taskNames }, cachedInspection),
    ).resolves.toMatchObject({ accepted: true });

    const agentRequest = {
      callId: 'agent-close-before-shutdown',
      payload: { targetTaskId: 'task-agent-call' },
      runId: result.run.id,
      taskId: 'task-coordinator',
      token,
      toolName: 'close_task' as const,
    };
    const rendererRequest = {
      controllerId: 'browser-client-1',
      coordinatorTaskId: 'task-coordinator',
      payload: { targetTaskId: 'task-renderer-action' },
      requestId: 'renderer-close-before-shutdown',
      runId: result.run.id,
      toolName: 'close_task' as const,
    };
    const agentMutation = executeCoordinatorToolCall({ context, taskNames }, agentRequest);
    const rendererMutation = executeCoordinatorRendererAction(
      { context, taskNames },
      rendererRequest,
    );
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledTimes(2);

    let shutdownSettled = false;
    const shutdown = stopRuntime().finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(() => startCoordinatorPromptDeliveryRuntime(context, taskNames)).toThrow(
      'previous shutdown is pending',
    );
    await expect(
      executeCoordinatorToolCall(
        { context, taskNames },
        {
          callId: 'agent-close-after-shutdown',
          payload: { targetTaskId: 'task-agent-call' },
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'close_task',
        },
      ),
    ).rejects.toThrow('Coordinator runtime is stopping');
    await expect(
      executeCoordinatorRendererAction({ context, taskNames }, cachedInspection),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames },
        {
          coordinatorTaskId: 'task-coordinator',
          requestId: 'new-inspection-during-shutdown',
          runId: result.run.id,
          toolName: 'get_task_status',
        },
      ),
    ).rejects.toThrow('Coordinator runtime is stopping');

    agentCleanup.resolve({ cleanupWarnings: [], releasedTaskCommandController: null });
    await expect(agentMutation).resolves.toMatchObject({ accepted: true });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    rendererCleanup.resolve({ cleanupWarnings: [], releasedTaskCommandController: null });
    await expect(shutdown).resolves.toBeUndefined();
    await expect(rendererMutation).resolves.toMatchObject({ accepted: true });
    // Both full calls, including their persisted result-ledger writes, completed before shutdown.
    // Their replays remain available while new call admission stays closed.
    await expect(
      executeCoordinatorToolCall({ context, taskNames }, agentRequest),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      executeCoordinatorRendererAction({ context, taskNames }, rendererRequest),
    ).resolves.toMatchObject({ accepted: true });

    const stopRestartedRuntime = startCoordinatorPromptDeliveryRuntime(context, taskNames);
    await stopRestartedRuntime();
  });

  it('retries queued prompt delivery when the target TUI reaches an idle prompt', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });

    mocks.hasAgentSessionMock.mockReturnValue(true);
    mocks.getAgentMetaMock.mockReturnValue({
      agentId: 'agent-child',
      generation: 1,
      isShell: false,
      taskId: 'task-child',
    });
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(createSupervisionSnapshot('active'));
    startCoordinatorPromptDeliveryRuntime(context);

    const response = await executeCoordinatorToolCall(
      {
        context,
        taskNames: createTaskRegistry(),
      },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-child',
          text: 'Continue now',
        },
      },
    );

    expect(response.result).toMatchObject({
      status: 'waiting-for-terminal-prompt',
      waitingReason: 'agent-active',
    });
    expect(mocks.writeToAgentMock).not.toHaveBeenCalled();

    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(
      createSupervisionSnapshot('idle-at-prompt'),
    );
    for (const listener of mocks.supervisionListeners) {
      listener({ kind: 'snapshot' });
    }
    await vi.runAllTimersAsync();

    expect(mocks.writeToAgentMock).toHaveBeenCalled();
    expect(getCoordinatorRun(result.run.id)?.promptQueue[0]?.status).toBe('delivered');
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]?.status).toBe('running');
  });

  it('cancels queued prompts and rejects child credentials after subtask cleanup', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    const childCredential = createCoordinatorCredential(context, {
      agentId: 'agent-child',
      runId: result.run.id,
      taskId: 'task-child',
      toolCallUrl: context.coordinatorToolCallUrl,
    });
    mocks.hasAgentSessionMock.mockReturnValue(false);
    startCoordinatorPromptDeliveryRuntime(context);

    const response = await executeCoordinatorToolCall(
      {
        context,
        taskNames: createTaskRegistry(),
      },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-child',
          text: 'Continue now',
        },
      },
    );
    expect(response.result).toMatchObject({
      status: 'waiting-for-agent-session',
    });

    cleanupCoordinatorStateForTask(context, 'task-child');
    mocks.hasAgentSessionMock.mockReturnValue(true);
    mocks.getAgentMetaMock.mockReturnValue({
      agentId: 'agent-child',
      generation: 1,
      isShell: false,
      taskId: 'task-child',
    });
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(
      createSupervisionSnapshot('idle-at-prompt'),
    );
    for (const listener of mocks.supervisionListeners) {
      listener({ kind: 'snapshot' });
    }
    await vi.runAllTimersAsync();

    expect(mocks.writeToAgentMock).not.toHaveBeenCalled();
    expect(getCoordinatorRun(result.run.id)?.promptQueue[0]).toMatchObject({
      status: 'cancelled',
      waitingReason: 'task-cleaned-up',
    });
    await expect(
      executeCoordinatorToolCall(
        {
          context,
          taskNames: createTaskRegistry(),
        },
        {
          callId: 'call-child',
          runId: result.run.id,
          taskId: 'task-child',
          token: childCredential.token,
          toolName: 'get_task_status',
        },
      ),
    ).rejects.toThrow('Invalid coordinator tool token');
  });

  it('closes a coordinator-owned subtask through cleanup, prompt cancellation, and credential revocation', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      branchName: 'feature/child',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    const childCredential = createCoordinatorCredential(context, {
      agentId: 'agent-child',
      runId: result.run.id,
      taskId: 'task-child',
      toolCallUrl: context.coordinatorToolCallUrl,
    });
    mocks.hasAgentSessionMock.mockReturnValue(false);
    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-prompt',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-child',
          text: 'Continue now',
        },
      },
    );

    const taskNames = createTaskRegistry();
    const response = await executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'call-close',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'close_task',
        payload: {
          targetTaskId: 'task-child',
        },
      },
    );

    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentIds: ['agent-child'],
        branchName: 'feature/child',
        deleteBranch: true,
        taskId: 'task-child',
        worktreePath: '/repo/task-child',
      }),
    );
    expect(taskNames.deleteTask).toHaveBeenCalledWith('task-child');
    expect(resolveCoordinatorToken(childCredential.token)).toBeNull();
    expect(response.result).toEqual({
      cleanupWarnings: [],
      status: 'cancelled',
      taskId: 'task-child',
    });
    expect(getCoordinatorRun(result.run.id)?.promptQueue[0]).toMatchObject({
      status: 'cancelled',
      waitingReason: 'subtask-cleaned-up',
    });
  });

  it('cleans up an exited coordinator-owned subtask when the coordinator closes it', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    const childCredential = addExitedCoordinatorOwnedSubtask(context, result.run.id);
    const taskNames = createTaskRegistry();

    const response = await executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'call-close',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'close_task',
        payload: {
          targetTaskId: 'task-child',
        },
      },
    );

    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentIds: ['agent-child'],
        branchName: 'feature/child',
        deleteBranch: true,
        taskId: 'task-child',
        worktreePath: '/repo/task-child',
      }),
    );
    expect(taskNames.deleteTask).toHaveBeenCalledWith('task-child');
    expect(resolveCoordinatorToken(childCredential.token)).toBeNull();
    expect(response.result).toEqual({
      cleanupWarnings: [],
      status: 'cancelled',
      taskId: 'task-child',
    });
  });

  it('rejects subtask tokens for coordinator-only inspection and wait tools', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child-1',
      assignment: 'Do the first slice',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child-1',
      toolTokenId: 'token-child-1',
      worktreePath: '/repo/task-child-1',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child-2',
      assignment: 'Do the second slice',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child-2',
      toolTokenId: 'token-child-2',
      worktreePath: '/repo/task-child-2',
    });
    const childCredential = createCoordinatorCredential(context, {
      agentId: 'agent-child-1',
      runId: result.run.id,
      taskId: 'task-child-1',
      toolCallUrl: context.coordinatorToolCallUrl,
    });

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'child-status',
          runId: result.run.id,
          taskId: 'task-child-1',
          token: childCredential.token,
          toolName: 'get_task_status',
        },
      ),
    ).rejects.toThrow('Only the coordinator task can call this tool');
    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'child-output',
          runId: result.run.id,
          taskId: 'task-child-1',
          token: childCredential.token,
          toolName: 'get_task_output',
          payload: {
            targetTaskId: 'task-child-2',
          },
        },
      ),
    ).rejects.toThrow('Only the coordinator task can call this tool');
    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'child-wait',
          runId: result.run.id,
          taskId: 'task-child-1',
          token: childCredential.token,
          toolName: 'wait_for_idle',
          payload: {
            targetTaskId: 'task-child-2',
          },
        },
      ),
    ).rejects.toThrow('Only the coordinator task can call this tool');
  });

  it('lists run-owned tasks and returns capped terminal output', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      branchName: 'feature/child',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    mocks.getAgentScrollbackBufferMock.mockReturnValue(Buffer.from('A🙂BC'));

    const listed = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-list',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'list_tasks',
      },
    );
    const output = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-output',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'get_task_output',
        payload: {
          maxBytes: 4,
          targetTaskId: 'task-child',
        },
      },
    );

    expect(listed.result).toEqual([
      expect.objectContaining({
        assignment: 'Do the work',
        branchName: 'feature/child',
        status: 'running',
        taskId: 'task-child',
      }),
    ]);
    expect(output.result).toEqual({
      agentId: 'agent-child',
      output: 'BC',
      taskId: 'task-child',
      truncatedBytes: 5,
    });
  });

  it('returns git diff summaries and rejects diff inspection for non-git runs', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'ready-for-review',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    mocks.getProjectDiffMock.mockResolvedValue({
      files: [{ committed: false, lines_added: 2, lines_removed: 1, path: 'file.ts', status: 'M' }],
      totalAdded: 2,
      totalRemoved: 1,
    });
    mocks.getAllFileDiffsMock.mockResolvedValue('A🙂BC');

    const diff = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-diff',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'get_task_diff',
        payload: {
          includePatch: true,
          maxBytes: 4,
          targetTaskId: 'task-child',
        },
      },
    );

    expect(diff.result).toMatchObject({
      patch: 'BC',
      taskId: 'task-child',
      totalAdded: 2,
      totalRemoved: 1,
      truncatedBytes: 5,
    });

    const nonGitResult = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-non-git',
      coordinatorTaskId: 'task-non-git',
      projectId: 'project-1',
      projectMode: 'non-git',
      projectRoot: '/repo',
    });
    const nonGitToken = readCredentialToken(nonGitResult.credentialPath);
    addCoordinatorSubtask({
      agentId: 'agent-non-git-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-non-git',
      runId: nonGitResult.run.id,
      status: 'running',
      taskId: 'task-non-git-child',
      toolTokenId: 'token-non-git-child',
      worktreePath: '/repo',
    });

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'call-non-git-diff',
          runId: nonGitResult.run.id,
          taskId: 'task-non-git',
          token: nonGitToken,
          toolName: 'get_task_diff',
          payload: {
            targetTaskId: 'task-non-git-child',
          },
        },
      ),
    ).rejects.toThrow('get_task_diff requires a git-backed coordinator run');
  });

  it('keeps inspection and prompt admission on narrow runtime reads', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    mocks.getAgentScrollbackBufferMock.mockReturnValue(Buffer.from('child output'));
    mocks.hasAgentSessionMock.mockReturnValue(false);

    const fullRunRead = vi.spyOn(coordinatorRuntime, 'getCoordinatorRun');
    try {
      const tasks = await executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'narrow-list',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'list_tasks',
        },
      );
      const output = await executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'narrow-output',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'get_task_output',
          payload: { targetTaskId: 'task-child' },
        },
      );
      const diff = await executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'narrow-diff',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'get_task_diff',
          payload: { targetTaskId: 'task-child' },
        },
      );
      const prompt = await executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'narrow-prompt',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'send_prompt',
          payload: { targetTaskId: 'task-child', text: 'Continue' },
        },
      );

      expect(tasks.result).toEqual([
        expect.objectContaining({ assignment: 'Do the work', taskId: 'task-child' }),
      ]);
      expect(output.result).toMatchObject({ output: 'child output', taskId: 'task-child' });
      expect(diff.result).toMatchObject({ taskId: 'task-child' });
      expect(prompt.result).toMatchObject({
        status: 'waiting-for-agent-session',
        targetTaskId: 'task-child',
      });
      expect(fullRunRead).not.toHaveBeenCalled();
    } finally {
      fullRunRead.mockRestore();
    }
  });

  it('validates inspection payloads and rejects inactive targets', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    addCoordinatorSubtask({
      agentId: 'agent-cancelled',
      assignment: 'Cancelled work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'cancelled',
      taskId: 'task-cancelled',
      toolTokenId: 'token-cancelled',
      worktreePath: '/repo/task-cancelled',
    });
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(createSupervisionSnapshot('active'));

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'invalid-output-limit',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'get_task_output',
          payload: {
            maxBytes: 0,
            targetTaskId: 'task-child',
          },
        },
      ),
    ).rejects.toThrow('maxBytes must be a positive integer');
    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'invalid-include-patch',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'get_task_diff',
          payload: {
            includePatch: 'yes',
            targetTaskId: 'task-child',
          },
        },
      ),
    ).rejects.toThrow('includePatch must be a boolean when provided');
    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'inactive-output',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'get_task_output',
          payload: {
            targetTaskId: 'task-cancelled',
          },
        },
      ),
    ).rejects.toThrow('targetTaskId is no longer active');
    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'inactive-prompt',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'send_prompt',
          payload: {
            targetTaskId: 'task-cancelled',
            text: 'Resume work',
          },
        },
      ),
    ).rejects.toThrow('targetTaskId is no longer active');

    const idle = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'idle-timeout',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'wait_for_idle',
        payload: {
          targetTaskId: 'task-child',
          timeoutMs: 0,
        },
      },
    );

    expect(idle.result).toMatchObject({
      idle: false,
      state: 'active',
      taskId: 'task-child',
      timedOut: true,
    });
  });

  it('waits for a target task to become idle without acquiring command control', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    mocks.getAgentSupervisionSnapshotMock
      .mockReturnValueOnce(createSupervisionSnapshot('active'))
      .mockReturnValue(createSupervisionSnapshot('idle-at-prompt'));

    const idle = executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-idle',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'wait_for_idle',
        payload: {
          targetTaskId: 'task-child',
          timeoutMs: 1_000,
        },
      },
    );

    await vi.advanceTimersByTimeAsync(100);

    await expect(idle).resolves.toMatchObject({
      result: {
        agentId: 'agent-child',
        idle: true,
        state: 'idle-at-prompt',
        taskId: 'task-child',
        timedOut: false,
      },
    });
  });

  it('stops waiting for idle when the target task reaches a terminal coordinator status', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(createSupervisionSnapshot('active'));

    const idle = executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-idle-terminal',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'wait_for_idle',
        payload: {
          targetTaskId: 'task-child',
          timeoutMs: 60_000,
        },
      },
    );

    await Promise.resolve();
    updateCoordinatorSubtaskStatus(result.run.id, 'task-child', 'cancelled');
    await vi.advanceTimersByTimeAsync(100);

    await expect(idle).resolves.toMatchObject({
      result: {
        agentId: 'agent-child',
        idle: false,
        state: 'missing',
        taskId: 'task-child',
        timedOut: false,
      },
    });
  });

  it('spawns hidden subtasks without binding browser output channels', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    const taskNames = createTaskRegistry();
    mockCreatedTaskResult();
    mocks.hasAgentSessionMock.mockReturnValue(false);

    const response = await executeCoordinatorToolCall(
      {
        context,
        taskNames,
      },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: {
            args: ['--model', 'fast'],
            command: 'custom-agent',
            env: { CUSTOM_FLAG: '1' },
            name: 'Custom Agent',
            skipPermissionsArgs: ['--unsafe', '--model'],
          },
          assignment: 'Build the slice',
          name: 'Child Task',
        },
      },
    );

    expect(taskNames.registerCreatedTask).toHaveBeenCalledWith(
      'task-child',
      expect.objectContaining({
        agentDefName: 'Custom Agent',
        taskName: 'Child Task',
      }),
    );
    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        gitIsolation: 'worktree',
      }),
    );
    expect(mocks.spawnOwnedTaskAgentWorkflowMock).toHaveBeenCalledWith(
      context,
      {
        operationId: expect.stringMatching(/^coordinator-session:v1:[A-Za-z0-9_-]{43}$/),
        purpose: 'coordinator-session',
      },
      expect.objectContaining({
        agentId: expect.any(String),
        args: ['--model', 'fast', '--unsafe'],
        assertSpawnAdmitted: expect.any(Function),
        command: 'custom-agent',
        env: expect.objectContaining({
          CUSTOM_FLAG: '1',
          PARALLEL_CODE_COORDINATOR_CREDENTIAL: expect.any(String),
          PARALLEL_CODE_COORDINATOR_RUN_ID: result.run.id,
        }),
        taskId: 'task-child',
      }),
    );
    const ownedSpawnRequest = mocks.spawnOwnedTaskAgentWorkflowMock.mock.calls[0]?.[2];
    expect(ownedSpawnRequest).not.toHaveProperty('onOutput');
    expect(mocks.spawnTaskAgentWorkflowMock).toHaveBeenCalledWith(context, ownedSpawnRequest);
    expect(response.result).toMatchObject({
      status: 'waiting-for-agent-ready',
      taskId: 'task-child',
    });
    const spawnRequest = ownedSpawnRequest as {
      assertSpawnAdmitted?: () => void;
    };
    expect(() => spawnRequest.assertSpawnAdmitted?.()).not.toThrow();
    updateCoordinatorRunStatus(result.run.id, 'completed');
    expect(() => spawnRequest.assertSpawnAdmitted?.()).toThrow('Coordinator run is completed');
  });

  it('seeds the initial Codex assignment at spawn instead of queueing a prompt', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();

    const response = await executeCoordinatorToolCall(
      {
        context,
        taskNames: createTaskRegistry(),
      },
      {
        callId: 'spawn-seeded-codex',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: {
            args: ['--model', 'gpt-5.5'],
            command: 'codex',
          },
          assignment: 'Review the coordinator startup path.',
          name: 'Codex child',
        },
      },
    );

    expect(mocks.spawnTaskAgentWorkflowMock).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        args: [
          '--model',
          'gpt-5.5',
          expect.stringContaining('Review the coordinator startup path.'),
        ],
        command: 'codex',
      }),
    );
    expect(mocks.writeToAgentMock).not.toHaveBeenCalled();
    expect(getCoordinatorRun(result.run.id)?.promptQueue).toEqual([]);
    expect(response.result).toMatchObject({
      startup: {
        followupPromptMode: 'post-ready-prompt',
        initialAssignmentMode: 'spawn-seeded-interactive',
        initialAssignmentStatus: 'seeded-at-spawn',
        readinessPolicy: 'codex',
      },
      status: 'running',
      taskId: 'task-child',
    });
  });

  it('rejects unsupported noninteractive seeded startup', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    await expect(
      executeCoordinatorToolCall(
        {
          context,
          taskNames: createTaskRegistry(),
        },
        {
          callId: 'spawn-seeded-codex-noninteractive',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'spawn_subtask',
          payload: {
            agent: {
              command: 'codex',
              followupPromptMode: 'disallow',
              initialAssignmentMode: 'spawn-seeded-noninteractive',
            },
            assignment: 'Summarize the startup path.',
            name: 'Codex one-shot child',
          },
        },
      ),
    ).rejects.toThrow(
      'agent.initialAssignmentMode must be spawn-seeded-interactive or post-ready-prompt',
    );
  });

  it('marks spawned subtasks running after the initial assignment is delivered', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();
    mocks.hasAgentSessionMock.mockReturnValue(true);
    mocks.getAgentMetaMock.mockImplementation((agentId: string) => ({
      agentId,
      generation: 1,
      isShell: false,
      taskId: 'task-child',
    }));
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(
      createSupervisionSnapshot('idle-at-prompt'),
    );

    const response = await executeCoordinatorToolCall(
      {
        context,
        taskNames: createTaskRegistry(),
      },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: {
            command: 'custom-agent',
          },
          assignment: 'Build the slice',
          name: 'Child Task',
        },
      },
    );

    expect(response.result).toMatchObject({
      status: 'running',
      taskId: 'task-child',
    });
    expect(getCoordinatorRun(result.run.id)?.promptQueue[0]).toMatchObject({
      status: 'delivered',
    });
    expect(mocks.writeToAgentMock).toHaveBeenCalled();
  });

  it('keeps prompt-delivered startup waiting when shell readiness sees only a Codex composer prompt', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();
    mocks.hasAgentSessionMock.mockReturnValue(true);
    mocks.getAgentMetaMock.mockImplementation((agentId: string) => ({
      agentId,
      generation: 1,
      isShell: false,
      taskId: 'task-child',
    }));
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(
      createSupervisionSnapshot('idle-at-prompt'),
    );
    mocks.getAgentScrollbackBufferMock.mockReturnValue(
      Buffer.from('› Improve documentation in @docs/ARCHITECTURE.md'),
    );

    const response = await executeCoordinatorToolCall(
      {
        context,
        taskNames: createTaskRegistry(),
      },
      {
        callId: 'spawn-shell-readiness-codex-tail',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: {
            command: 'custom-agent',
            readinessPolicy: 'shell',
          },
          assignment: 'Build the slice',
          name: 'Child Task',
        },
      },
    );

    expect(response.result).toMatchObject({
      startup: {
        initialAssignmentMode: 'post-ready-prompt',
        initialAssignmentStatus: 'pending-prompt',
        readinessPolicy: 'shell',
      },
      status: 'waiting-for-agent-ready',
      taskId: 'task-child',
    });
    expect(getCoordinatorRun(result.run.id)?.promptQueue[0]).toMatchObject({
      status: 'waiting-for-terminal-prompt',
      waitingReason: 'agent-quiet',
    });
    expect(mocks.writeToAgentMock).not.toHaveBeenCalled();
  });

  it('delivers prompt-delivered startup when codex readiness sees a Codex composer prompt', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();
    mocks.hasAgentSessionMock.mockReturnValue(true);
    mocks.getAgentMetaMock.mockImplementation((agentId: string) => ({
      agentId,
      generation: 1,
      isShell: false,
      taskId: 'task-child',
    }));
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(
      createSupervisionSnapshot('idle-at-prompt'),
    );
    mocks.getAgentScrollbackBufferMock.mockReturnValue(
      Buffer.from('› Improve documentation in @docs/ARCHITECTURE.md'),
    );

    const response = await executeCoordinatorToolCall(
      {
        context,
        taskNames: createTaskRegistry(),
      },
      {
        callId: 'spawn-codex-readiness-codex-tail',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: {
            command: 'custom-agent',
            readinessPolicy: 'codex',
          },
          assignment: 'Build the slice',
          name: 'Child Task',
        },
      },
    );

    expect(response.result).toMatchObject({
      startup: {
        initialAssignmentMode: 'post-ready-prompt',
        initialAssignmentStatus: 'delivered',
        readinessPolicy: 'codex',
      },
      status: 'running',
      taskId: 'task-child',
    });
    expect(getCoordinatorRun(result.run.id)?.promptQueue[0]).toMatchObject({
      status: 'delivered',
    });
    expect(mocks.writeToAgentMock).toHaveBeenCalled();
  });

  it('rejects seeded initial assignment for unsupported non-Codex agents', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);

    await expect(
      executeCoordinatorToolCall(
        {
          context,
          taskNames: createTaskRegistry(),
        },
        {
          callId: 'spawn-unsupported-seeded',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'spawn_subtask',
          payload: {
            agent: {
              command: 'custom-agent',
              initialAssignmentMode: 'spawn-seeded-interactive',
            },
            assignment: 'Build the slice',
            name: 'Child Task',
          },
        },
      ),
    ).rejects.toThrow(
      'Seeded initial assignment modes are currently supported only for codex agents',
    );
  });

  it('deduplicates logical spawn retries before creating another hidden task', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();
    mocks.hasAgentSessionMock.mockReturnValue(false);
    const taskNames = createTaskRegistry();
    const payload = {
      agent: {
        command: 'custom-agent',
      },
      assignment: 'Build the slice',
      dedupeKey: 'stable-spawn-key',
      name: 'Child Task',
    };

    const first = await executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload,
      },
    );
    const second = await executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'call-2',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload,
      },
    );

    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(1);
    expect(first.result).toMatchObject({ taskId: 'task-child' });
    expect(second.result).toMatchObject({ taskId: 'task-child' });
    expect(getCoordinatorRun(result.run.id)?.subtasks).toHaveLength(1);
  });

  it('deduplicates concurrent spawn requests while task creation is still in flight', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    const taskNames = createTaskRegistry();
    const deferredTask = createDeferredPromise<{
      base_branch: string;
      branch_name: string;
      git_isolation: 'worktree';
      id: string;
      worktree_path: string;
    }>();
    mocks.createTaskWorkflowMock.mockReturnValue(deferredTask.promise);
    mocks.hasAgentSessionMock.mockReturnValue(false);
    const payload = {
      agent: {
        command: 'custom-agent',
      },
      assignment: 'Build the slice',
      dedupeKey: 'stable-spawn-key',
      name: 'Child Task',
    };

    const first = executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload,
      },
    );
    const second = executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'call-2',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload,
      },
    );

    await Promise.resolve();
    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(1);
    deferredTask.resolve({
      base_branch: 'main',
      branch_name: 'feature/child',
      git_isolation: 'worktree',
      id: 'task-child',
      worktree_path: '/repo/task-child',
    });
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(1);
    expect(mocks.spawnTaskAgentWorkflowMock).toHaveBeenCalledTimes(1);
    expect(firstResponse.result).toMatchObject({ taskId: 'task-child' });
    expect(secondResponse.result).toMatchObject({ taskId: 'task-child' });
    expect(getCoordinatorRun(result.run.id)?.subtasks).toHaveLength(1);
  });

  it('starts a map-reduce workflow and advances to reduce when a map lane submits a typed result', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-map', 'task-reduce']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    const started = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'workflow-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          agent: { command: 'codex' },
          lanes: [{ assignment: 'Map backend risks.', name: 'Backend', role: 'map' }],
          problem: 'Review startup latency.',
          template: 'map_reduce',
          title: 'Startup review',
        },
      },
    );
    expect(started.result).toMatchObject({
      lanes: [
        expect.objectContaining({ subtask: expect.objectContaining({ taskId: 'task-map' }) }),
      ],
      workflow: expect.objectContaining({ template: 'map_reduce' }),
    });

    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;
    expect(workflowId).toEqual(expect.any(String));
    const childToken = readTaskCredentialToken('task-map');

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'map-result',
        runId: result.run.id,
        taskId: 'task-map',
        token: childToken,
        toolName: 'submit_result',
        payload: {
          commandsRun: ['npm test'],
          confidence: 'high',
          evidence: [{ label: 'gateway test' }],
          findings: [{ severity: 'major', status: 'confirmed', summary: 'Map finding' }],
          summary: 'Mapped startup latency.',
          workflowId,
        },
      },
    );

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow?.stages).toEqual([
      expect.objectContaining({ id: 'map', status: 'completed' }),
      expect.objectContaining({ id: 'reduce', status: 'waiting-for-results' }),
    ]);
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({
        resultId: expect.any(String),
        status: 'completed',
        taskId: 'task-map',
      }),
      expect.objectContaining({
        role: 'reduce',
        status: 'waiting-for-result',
        taskId: 'task-reduce',
      }),
    ]);
    expect(workflow?.results[0]).toMatchObject({
      confidence: 'high',
      summary: 'Mapped startup latency.',
    });
  });

  it('lets a workflow lane append dependent steps before submitting its result', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-scout', 'task-followup']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'adaptive-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          problem: 'Find whether the workflow needs more lanes.',
          spec: {
            steps: [{ id: 'scout', kind: 'worker', name: 'Scout' }],
          },
          template: 'custom',
          title: 'Adaptive workflow',
        },
      },
    );

    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;
    if (workflowId === undefined) {
      throw new Error('Expected adaptive workflow id');
    }
    const scoutToken = readTaskCredentialToken('task-scout');
    const appendPayload = {
      appendId: 'append-followup',
      reason: 'Scout found a follow-up lane is needed.',
      steps: [
        {
          dependsOn: ['scout'],
          id: 'followup',
          kind: 'worker',
          name: 'Followup',
        },
      ],
      workflowId,
    };

    const appended = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'adaptive-append',
        runId: result.run.id,
        taskId: 'task-scout',
        token: scoutToken,
        toolName: 'append_workflow_steps',
        payload: appendPayload,
      },
    );
    expect(appended.result).toMatchObject({
      append: expect.objectContaining({
        appendId: 'append-followup',
        sourceTaskId: 'task-scout',
        stepIds: ['followup'],
      }),
      lanes: [],
    });
    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(1);

    const repeatedAppend = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'adaptive-append-repeat',
        runId: result.run.id,
        taskId: 'task-scout',
        token: scoutToken,
        toolName: 'append_workflow_steps',
        payload: appendPayload,
      },
    );
    expect(repeatedAppend.result).toMatchObject({
      lanes: [],
      workflow: expect.objectContaining({
        stepAppends: [expect.objectContaining({ appendId: 'append-followup' })],
      }),
    });
    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.stages).toHaveLength(2);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'adaptive-scout-result',
        runId: result.run.id,
        taskId: 'task-scout',
        token: scoutToken,
        toolName: 'submit_result',
        payload: {
          summary: 'Scout completed.',
          workflowId,
        },
      },
    );

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow).toMatchObject({
      sourceSpec: {
        steps: [
          expect.objectContaining({ id: 'scout' }),
          expect.objectContaining({ dependsOn: ['scout'], id: 'followup' }),
        ],
      },
      stages: [
        expect.objectContaining({ id: 'scout', status: 'completed' }),
        expect.objectContaining({ id: 'followup', status: 'waiting-for-results' }),
      ],
    });
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({ name: 'Scout', status: 'completed', taskId: 'task-scout' }),
      expect.objectContaining({
        name: 'Followup',
        status: 'waiting-for-result',
        taskId: 'task-followup',
      }),
    ]);
  });

  it('rejects invalid appended workflow steps without mutating the workflow', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-scout']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'adaptive-invalid-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          problem: 'Find whether the workflow needs more lanes.',
          spec: {
            steps: [{ id: 'scout', kind: 'worker', name: 'Scout' }],
          },
          template: 'custom',
          title: 'Adaptive invalid workflow',
        },
      },
    );

    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;
    if (workflowId === undefined) {
      throw new Error('Expected adaptive workflow id');
    }
    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'adaptive-invalid-append',
          runId: result.run.id,
          taskId: 'task-scout',
          token: readTaskCredentialToken('task-scout'),
          toolName: 'append_workflow_steps',
          payload: {
            appendId: 'append-invalid',
            steps: [{ dependsOn: ['missing'], id: 'followup', kind: 'worker' }],
            workflowId,
          },
        },
      ),
    ).rejects.toThrow('missing step missing');

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow?.sourceSpec?.steps.map((step) => step.id)).toEqual(['scout']);
    expect(workflow?.stages.map((stage) => stage.id)).toEqual(['scout']);
    expect(workflow?.stepAppends).toBeUndefined();
  });

  it('rejects appended steps from a lane that already submitted a terminal result', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-scout']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'adaptive-append-after-result-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          problem: 'Find whether the workflow needs more lanes.',
          spec: {
            steps: [{ id: 'scout', kind: 'worker', name: 'Scout' }],
          },
          template: 'custom',
          title: 'Adaptive append after result',
        },
      },
    );

    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;
    if (workflowId === undefined) {
      throw new Error('Expected adaptive workflow id');
    }
    const scoutToken = readTaskCredentialToken('task-scout');
    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'adaptive-append-after-result-submit',
        runId: result.run.id,
        taskId: 'task-scout',
        token: scoutToken,
        toolName: 'submit_result',
        payload: {
          summary: 'Scout completed.',
          workflowId,
        },
      },
    );

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'adaptive-append-after-result',
          runId: result.run.id,
          taskId: 'task-scout',
          token: scoutToken,
          toolName: 'append_workflow_steps',
          payload: {
            appendId: 'append-after-result',
            steps: [{ dependsOn: ['scout'], id: 'followup', kind: 'worker' }],
            workflowId,
          },
        },
      ),
    ).rejects.toThrow(
      'append_workflow_steps requires an active workflow lane without a terminal result',
    );

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow?.sourceSpec?.steps.map((step) => step.id)).toEqual(['scout']);
    expect(workflow?.stages.map((stage) => stage.id)).toEqual(['scout']);
    expect(workflow?.stepAppends).toBeUndefined();
  });

  it('lets a decision lane submit structured workflowActions for follow-up work', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-scout', 'task-decide', 'task-followup']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'decision-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          problem: 'Decide whether a focused follow-up is needed.',
          spec: {
            steps: [
              { id: 'scout', kind: 'worker', name: 'Scout' },
              {
                dependsOn: ['scout'],
                id: 'decide',
                kind: 'decision',
                name: 'Decide',
                sourceStepIds: ['scout'],
              },
            ],
          },
          template: 'custom',
          title: 'Decision workflow',
        },
      },
    );

    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;
    if (workflowId === undefined) {
      throw new Error('Expected decision workflow id');
    }

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'decision-scout-result',
        runId: result.run.id,
        taskId: 'task-scout',
        token: readTaskCredentialToken('task-scout'),
        toolName: 'submit_result',
        payload: {
          summary: 'Scout completed.',
          workflowId,
        },
      },
    );

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'decision-result',
        runId: result.run.id,
        taskId: 'task-decide',
        token: readTaskCredentialToken('task-decide'),
        toolName: 'submit_result',
        payload: {
          metadata: {
            workflowActions: [{ id: 'followup', kind: 'append_worker', name: 'Followup' }],
          },
          summary: 'Decision appended a focused follow-up.',
          workflowId,
        },
      },
    );

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow).toMatchObject({
      expansions: [
        expect.objectContaining({
          actions: [expect.objectContaining({ kind: 'append_worker', stepIds: ['followup'] })],
        }),
      ],
      stages: [
        expect.objectContaining({ id: 'scout', status: 'completed' }),
        expect.objectContaining({ id: 'decide', status: 'completed' }),
        expect.objectContaining({ id: 'followup', status: 'waiting-for-results' }),
      ],
    });
    expect(workflow?.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'task-scout', status: 'completed' }),
        expect.objectContaining({ taskId: 'task-decide', status: 'completed' }),
        expect.objectContaining({ taskId: 'task-followup', status: 'waiting-for-result' }),
      ]),
    );
  });

  it('rejects invalid decision workflowActions before storing a terminal result', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-scout', 'task-decide']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'decision-invalid-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          problem: 'Decide whether a focused follow-up is needed.',
          spec: {
            steps: [
              { id: 'scout', kind: 'worker', name: 'Scout' },
              {
                dependsOn: ['scout'],
                id: 'decide',
                kind: 'decision',
                name: 'Decide',
                sourceStepIds: ['scout'],
              },
            ],
          },
          template: 'custom',
          title: 'Decision workflow',
        },
      },
    );

    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;
    if (workflowId === undefined) {
      throw new Error('Expected decision workflow id');
    }

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'decision-invalid-scout-result',
        runId: result.run.id,
        taskId: 'task-scout',
        token: readTaskCredentialToken('task-scout'),
        toolName: 'submit_result',
        payload: {
          summary: 'Scout completed.',
          workflowId,
        },
      },
    );

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'decision-invalid-result',
          runId: result.run.id,
          taskId: 'task-decide',
          token: readTaskCredentialToken('task-decide'),
          toolName: 'submit_result',
          payload: {
            metadata: {
              workflowActions: [
                {
                  dependsOn: ['missing-step'],
                  id: 'followup',
                  kind: 'append_worker',
                  name: 'Followup',
                },
              ],
            },
            summary: 'Decision attempted an invalid follow-up.',
            workflowId,
          },
        },
      ),
    ).rejects.toThrow('step followup depends on missing step missing-step');

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow?.results).toHaveLength(1);
    expect(workflow?.results[0]).toMatchObject({ summary: 'Scout completed.' });
    expect(workflow?.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'task-scout', status: 'completed' }),
        expect.objectContaining({ taskId: 'task-decide', status: 'waiting-for-result' }),
      ]),
    );
    expect(workflow?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'decide', status: 'waiting-for-results' }),
      ]),
    );
    expect(workflow?.stepAppends).toBeUndefined();
    expect(workflow?.expansions).toBeUndefined();
  });

  it('runs a spec-backed fanout verify synthesize workflow with typed verdicts', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-backend', 'task-ui', 'task-skeptic', 'task-synthesis']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spec-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          problem: 'Review reliability.',
          spec: {
            steps: [
              {
                id: 'find',
                kind: 'fanout',
                lanes: [
                  { assignment: 'Find backend risks.', id: 'backend', name: 'Backend' },
                  { assignment: 'Find UI risks.', id: 'ui', name: 'UI' },
                ],
              },
              {
                dependsOn: ['find'],
                findingSourceStepId: 'find',
                id: 'verify',
                kind: 'verify',
                verifiers: [{ id: 'skeptic', name: 'Skeptic' }],
              },
              {
                dependsOn: ['verify'],
                id: 'synthesize',
                kind: 'synthesize',
                sourceStepIds: ['find', 'verify'],
              },
            ],
          },
          template: 'custom',
          title: 'Reliability review',
        },
      },
    );

    let workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow).toMatchObject({
      sourceSpec: expect.objectContaining({ version: 2 }),
      stages: [
        expect.objectContaining({ id: 'find', status: 'waiting-for-results' }),
        expect.objectContaining({ id: 'verify', status: 'pending' }),
        expect.objectContaining({ id: 'synthesize', status: 'pending' }),
      ],
    });
    expect(workflow?.lanes).toHaveLength(2);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'backend-result',
        runId: result.run.id,
        taskId: 'task-backend',
        token: readTaskCredentialToken('task-backend'),
        toolName: 'submit_result',
        payload: {
          findings: [{ severity: 'major', summary: 'Backend race can wedge the run.' }],
          summary: 'Backend finding submitted.',
          workflowId: workflow?.id,
        },
      },
    );
    workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow?.stages).toEqual([
      expect.objectContaining({ id: 'find', status: 'waiting-for-results' }),
      expect.objectContaining({ id: 'verify', status: 'pending' }),
      expect.objectContaining({ id: 'synthesize', status: 'pending' }),
    ]);
    expect(workflow?.lanes).toHaveLength(2);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'ui-result',
        runId: result.run.id,
        taskId: 'task-ui',
        token: readTaskCredentialToken('task-ui'),
        toolName: 'submit_result',
        payload: {
          findings: [{ severity: 'minor', summary: 'UI copy is unclear.' }],
          summary: 'UI finding submitted.',
          workflowId: workflow?.id,
        },
      },
    );
    workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    const backendFindingId = workflow?.results[0]?.findings[0]?.id;
    expect(backendFindingId).toEqual(expect.any(String));
    expect(workflow).toMatchObject({
      stages: [
        expect.objectContaining({ id: 'find', status: 'completed' }),
        expect.objectContaining({ id: 'verify', status: 'waiting-for-results' }),
        expect.objectContaining({ id: 'synthesize', status: 'pending' }),
      ],
    });
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({ taskId: 'task-backend', status: 'completed' }),
      expect.objectContaining({ taskId: 'task-ui', status: 'completed' }),
      expect.objectContaining({ role: 'verifier', taskId: 'task-skeptic' }),
    ]);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'verify-result',
        runId: result.run.id,
        taskId: 'task-skeptic',
        token: readTaskCredentialToken('task-skeptic'),
        toolName: 'submit_result',
        payload: {
          metadata: {
            verdicts: [
              {
                findingId: backendFindingId,
                reason: 'The evidence matches the source.',
                status: 'confirmed',
              },
            ],
          },
          summary: 'Verified one finding.',
          workflowId: workflow?.id,
        },
      },
    );

    workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow).toMatchObject({
      stages: [
        expect.objectContaining({ id: 'find', status: 'completed' }),
        expect.objectContaining({ id: 'verify', status: 'completed' }),
        expect.objectContaining({ id: 'synthesize', status: 'waiting-for-results' }),
      ],
      verdicts: [
        expect.objectContaining({
          findingId: backendFindingId,
          reason: 'The evidence matches the source.',
          status: 'confirmed',
        }),
      ],
    });
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({ taskId: 'task-backend', status: 'completed' }),
      expect.objectContaining({ taskId: 'task-ui', status: 'completed' }),
      expect.objectContaining({ taskId: 'task-skeptic', status: 'completed' }),
      expect.objectContaining({ role: 'synthesize', taskId: 'task-synthesis' }),
    ]);
  });

  it('ticks workflow lane timeouts through the coordinator runtime scheduler', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const taskNames = createTaskRegistry();
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-worker']);
    mocks.hasAgentSessionMock.mockReturnValue(false);
    startCoordinatorPromptDeliveryRuntime(context, taskNames);

    await executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'scheduled-timeout-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          problem: 'Review scheduled timeout.',
          spec: {
            steps: [
              {
                assignment: 'Run a timeout lane.',
                id: 'worker',
                kind: 'worker',
                policy: {
                  retryCount: 0,
                  timeoutMs: 5,
                },
              },
            ],
          },
          template: 'custom',
          title: 'Scheduled timeout',
        },
      },
    );
    expect(getCoordinatorRun(result.run.id)?.workflows[0]).toMatchObject({
      status: 'running',
      lanes: [expect.objectContaining({ status: 'waiting-for-result' })],
    });

    await vi.advanceTimersByTimeAsync(5);

    expect(getCoordinatorRun(result.run.id)?.workflows[0]).toMatchObject({
      status: 'failed',
      stages: [expect.objectContaining({ status: 'failed' })],
      lanes: [
        expect.objectContaining({
          failure: 'Lane timed out after 5 ms.',
          status: 'timed-out',
        }),
      ],
    });
  });

  it('marks the workflow failed when the runtime scheduler tick throws', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const taskNames = createTaskRegistry();
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-worker']);
    mocks.hasAgentSessionMock.mockReturnValue(false);
    startCoordinatorPromptDeliveryRuntime(context, taskNames);

    await executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'scheduled-failure-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          problem: 'Review scheduled failure handling.',
          spec: {
            steps: [
              {
                assignment: 'Run a timeout lane.',
                id: 'worker',
                kind: 'worker',
                policy: {
                  retryCount: 0,
                  timeoutMs: 5,
                },
              },
            ],
          },
          template: 'custom',
          title: 'Scheduled failure handling',
        },
      },
    );

    const updateLaneSpy = vi
      .spyOn(coordinatorRuntime, 'updateCoordinatorWorkflowLane')
      .mockImplementationOnce(() => {
        throw new Error('runtime lane update failed');
      });

    await vi.advanceTimersByTimeAsync(5);

    expect(updateLaneSpy).toHaveBeenCalled();
    expect(getCoordinatorRun(result.run.id)?.workflows[0]).toMatchObject({
      execution: expect.objectContaining({
        failureSummary: 'Workflow scheduler failed: runtime lane update failed',
        pendingRetryLaneIds: [],
        readyStageIds: [],
      }),
      journal: expect.arrayContaining([
        expect.objectContaining({
          kind: 'workflow-scheduler-failed',
          message: 'Workflow scheduler failed: runtime lane update failed',
        }),
      ]),
      lanes: [expect.objectContaining({ status: 'failed' })],
      stages: [expect.objectContaining({ status: 'failed' })],
      status: 'failed',
    });
  });

  it('admits workflow retries through the coordinator runtime scheduler after backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const taskNames = createTaskRegistry();
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-worker', 'task-worker-retry']);
    mocks.hasAgentSessionMock.mockReturnValue(false);
    startCoordinatorPromptDeliveryRuntime(context, taskNames);

    await executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'scheduled-retry-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          problem: 'Review scheduled retry.',
          spec: {
            steps: [
              {
                assignment: 'Run a retry lane.',
                id: 'worker',
                kind: 'worker',
                policy: {
                  retryBackoffMs: 5,
                  retryCount: 1,
                  timeoutMs: 5,
                },
              },
            ],
          },
          template: 'custom',
          title: 'Scheduled retry',
        },
      },
    );

    await vi.advanceTimersByTimeAsync(5);

    expect(getCoordinatorRun(result.run.id)?.workflows[0]).toMatchObject({
      status: 'running',
      execution: expect.objectContaining({ nextRetryAt: 1_010 }),
      stages: [expect.objectContaining({ status: 'waiting-for-results' })],
      lanes: [expect.objectContaining({ attempt: 1, status: 'timed-out' })],
    });

    await vi.advanceTimersByTimeAsync(5);

    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.lanes).toEqual([
      expect.objectContaining({ attempt: 1, status: 'timed-out', taskId: 'task-worker' }),
      expect.objectContaining({
        attempt: 2,
        status: 'waiting-for-result',
        taskId: 'task-worker-retry',
      }),
    ]);
  });

  it('drains the active workflow scheduler execution before runtime shutdown settles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const taskNames = createTaskRegistry();
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const retryTask = createDeferredPromise<{
      base_branch: string;
      branch_name: string;
      git_isolation: 'worktree';
      id: string;
      worktree_path: string;
    }>();
    mocks.createTaskWorkflowMock
      .mockResolvedValueOnce({
        base_branch: 'main',
        branch_name: 'feature/task-worker',
        git_isolation: 'worktree',
        id: 'task-worker',
        worktree_path: '/repo/task-worker',
      })
      .mockReturnValueOnce(retryTask.promise);
    mocks.hasAgentSessionMock.mockReturnValue(false);
    const stopRuntime = startCoordinatorPromptDeliveryRuntime(context, taskNames);

    await executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'scheduler-shutdown-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token: readCredentialToken(result.credentialPath),
        toolName: 'start_workflow',
        payload: {
          problem: 'Prove scheduler shutdown ownership.',
          spec: {
            steps: [
              {
                assignment: 'Retry while shutdown begins.',
                id: 'worker',
                kind: 'worker',
                policy: { retryBackoffMs: 5, retryCount: 1, timeoutMs: 5 },
              },
            ],
          },
          template: 'custom',
          title: 'Scheduler shutdown ownership',
        },
      },
    );
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(5);
    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(2);

    let shutdownSettled = false;
    const shutdown = stopRuntime().finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    retryTask.resolve({
      base_branch: 'main',
      branch_name: 'feature/task-worker-retry',
      git_isolation: 'worktree',
      id: 'task-worker-retry',
      worktree_path: '/repo/task-worker-retry',
    });
    await expect(shutdown).resolves.toBeUndefined();
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-worker-retry' }),
    );
    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempt: 2,
          failure: 'Coordinator runtime is stopping',
          status: 'failed',
        }),
      ]),
    );
  });

  it('keeps timeout ticks live while paused and schedules a ready retry after unpause', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const taskNames = createTaskRegistry();
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-worker', 'task-worker-retry']);
    mocks.hasAgentSessionMock.mockReturnValue(false);
    startCoordinatorPromptDeliveryRuntime(context, taskNames);

    await executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'paused-scheduled-retry-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          problem: 'Review paused scheduled retry.',
          spec: {
            steps: [
              {
                assignment: 'Run a retry lane.',
                id: 'worker',
                kind: 'worker',
                policy: {
                  retryBackoffMs: 5,
                  retryCount: 1,
                  timeoutMs: 5,
                },
              },
            ],
          },
          template: 'custom',
          title: 'Paused scheduled retry',
        },
      },
    );
    coordinatorRuntime.setCoordinatorRunPaused(result.run.id, true, 1_001);

    await vi.advanceTimersByTimeAsync(5);

    expect(getCoordinatorRun(result.run.id)).toMatchObject({
      status: 'paused-by-user',
      workflows: [
        expect.objectContaining({
          lanes: [expect.objectContaining({ attempt: 1, status: 'timed-out' })],
          status: 'running',
        }),
      ],
    });

    await vi.advanceTimersByTimeAsync(5);
    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.lanes).toHaveLength(1);

    coordinatorRuntime.setCoordinatorRunPaused(result.run.id, false, 1_010);
    await vi.advanceTimersByTimeAsync(0);

    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.lanes).toEqual([
      expect.objectContaining({ attempt: 1, status: 'timed-out', taskId: 'task-worker' }),
      expect.objectContaining({
        attempt: 2,
        status: 'waiting-for-result',
        taskId: 'task-worker-retry',
      }),
    ]);
  });

  it('records partial spawn_many lane failures without losing successful lanes', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    let createCount = 0;
    mocks.createTaskWorkflowMock.mockImplementation(async () => {
      createCount += 1;
      if (createCount === 2) {
        throw new Error('spawn failed');
      }

      return {
        base_branch: 'main',
        branch_name: 'feature/task-map',
        git_isolation: 'worktree',
        id: 'task-map',
        worktree_path: '/repo/task-map',
      };
    });
    mocks.hasAgentSessionMock.mockReturnValue(false);

    const response = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-many',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_many',
        payload: {
          lanes: [
            { assignment: 'Map backend risks.', name: 'Backend' },
            { assignment: 'Map UI risks.', name: 'UI' },
          ],
          title: 'Fan out review',
        },
      },
    );

    expect(response.result).toMatchObject({
      lanes: [
        expect.objectContaining({ subtask: expect.objectContaining({ taskId: 'task-map' }) }),
        expect.objectContaining({ error: 'spawn failed' }),
      ],
    });
    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.lanes).toEqual([
      expect.objectContaining({
        name: 'Backend',
        status: 'waiting-for-result',
        taskId: 'task-map',
      }),
      expect.objectContaining({ failure: 'spawn failed', name: 'UI', status: 'failed' }),
    ]);
  });

  it('rejects invalid workflow admission without leaving empty workflow state', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'workflow-over-cap',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'start_workflow',
          payload: {
            lanes: [
              { assignment: 'Map backend risks.', name: 'Backend' },
              { assignment: 'Map UI risks.', name: 'UI' },
            ],
            policy: { maxConcurrentLanes: 1 },
            problem: 'Review cap behavior.',
            template: 'map_reduce',
          },
        },
      ),
    ).rejects.toThrow('start_workflow exceeds workflow maxConcurrentLanes');
    expect(getCoordinatorRun(result.run.id)?.workflows).toHaveLength(0);

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'workflow-spec-template-mismatch',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'start_workflow',
          payload: {
            problem: 'Review spec mismatch.',
            spec: {
              steps: [{ id: 'worker', kind: 'worker' }],
            },
            template: 'map_reduce',
          },
        },
      ),
    ).rejects.toThrow('spec is only supported with the custom workflow template');
    expect(getCoordinatorRun(result.run.id)?.workflows).toHaveLength(0);

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'spawn-many-missing-workflow',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'spawn_many',
          payload: {
            lanes: [{ assignment: 'Map backend risks.', name: 'Backend' }],
            workflowId: 'missing-workflow',
          },
        },
      ),
    ).rejects.toThrow('Coordinator workflow not found');
    expect(getCoordinatorRun(result.run.id)?.workflows).toHaveLength(0);
  });

  it('uses existing workflow policy when extending a custom fan-out workflow', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-one', 'task-two']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-many-create-capped',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_many',
        payload: {
          lanes: [{ assignment: 'Map backend risks.', name: 'Backend' }],
          policy: { maxConcurrentLanes: 1 },
          title: 'Capped fan out',
        },
      },
    );
    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'spawn-many-extend-over-cap',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'spawn_many',
          payload: {
            lanes: [{ assignment: 'Map UI risks.', name: 'UI' }],
            workflowId,
          },
        },
      ),
    ).rejects.toThrow('spawn_many exceeds workflow maxConcurrentLanes');
    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.lanes).toHaveLength(1);

    const duplicate = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-many-extend-duplicate',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_many',
        payload: {
          lanes: [{ assignment: 'Map backend risks.', name: 'Backend' }],
          workflowId,
        },
      },
    );
    expect(duplicate.result).toMatchObject({
      lanes: [
        expect.objectContaining({ subtask: expect.objectContaining({ taskId: 'task-one' }) }),
      ],
    });
    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.lanes).toHaveLength(1);
  });

  it('rejects workflow budget policies above server caps before any workflow state exists', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    const overCapPolicies: Array<{ message: string; policy: Record<string, number> }> = [
      {
        message: `policy.maxTotalSteps must be no greater than ${COORDINATOR_LIMITS.maxWorkflowTotalSteps}`,
        policy: { maxTotalSteps: COORDINATOR_LIMITS.maxWorkflowTotalSteps + 1 },
      },
      {
        message: `policy.maxTotalLanes must be no greater than ${COORDINATOR_LIMITS.maxWorkflowLanes}`,
        policy: { maxTotalLanes: COORDINATOR_LIMITS.maxWorkflowLanes + 1 },
      },
      {
        message: `policy.maxTotalRetries must be no greater than ${COORDINATOR_LIMITS.maxWorkflowTotalRetries}`,
        policy: { maxTotalRetries: COORDINATOR_LIMITS.maxWorkflowTotalRetries + 1 },
      },
      {
        message: `policy.maxWallClockMs must be no greater than ${COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs}`,
        policy: { maxWallClockMs: COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs + 1 },
      },
    ];

    for (const [index, overCap] of overCapPolicies.entries()) {
      await expect(
        executeCoordinatorToolCall(
          { context, taskNames: createTaskRegistry() },
          {
            callId: `workflow-budget-over-cap-${index}`,
            runId: result.run.id,
            taskId: 'task-coordinator',
            token,
            toolName: 'start_workflow',
            payload: {
              policy: overCap.policy,
              problem: 'Review budget caps.',
              spec: { steps: [{ id: 'worker', kind: 'worker' }] },
              template: 'custom',
            },
          },
        ),
      ).rejects.toThrow(overCap.message);
    }
    expect(getCoordinatorRun(result.run.id)?.workflows).toHaveLength(0);
  });

  it('applies lowered budget policies to the workflow snapshot and execution budget', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-worker']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'workflow-budget-lowered',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          policy: {
            maxTotalLanes: 4,
            maxTotalRetries: 1,
            maxTotalSteps: 6,
            maxWallClockMs: 120_000,
          },
          problem: 'Review lowered budgets.',
          spec: { steps: [{ id: 'worker', kind: 'worker' }] },
          template: 'custom',
        },
      },
    );

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow?.policy).toMatchObject({
      maxTotalLanes: 4,
      maxTotalRetries: 1,
      maxTotalSteps: 6,
      maxWallClockMs: 120_000,
    });
    expect(workflow?.execution?.deadlineAt).toEqual(expect.any(Number));
    expect(workflow?.execution?.budget).toMatchObject({
      lanes: { limit: 4, used: 1 },
      retries: { limit: 1, used: 0 },
      steps: { limit: 6, used: 1 },
    });
  });

  it('rejects decision workflowActions above the step budget without recording the result', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-scout', 'task-decide']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'budget-decision-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          policy: { maxTotalSteps: 2 },
          problem: 'Decide within a step budget.',
          spec: {
            steps: [
              { id: 'scout', kind: 'worker', name: 'Scout' },
              {
                dependsOn: ['scout'],
                id: 'decide',
                kind: 'decision',
                name: 'Decide',
                sourceStepIds: ['scout'],
              },
            ],
          },
          template: 'custom',
          title: 'Budget decision workflow',
        },
      },
    );
    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;
    if (workflowId === undefined) {
      throw new Error('Expected budget decision workflow id');
    }

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'budget-decision-scout-result',
        runId: result.run.id,
        taskId: 'task-scout',
        token: readTaskCredentialToken('task-scout'),
        toolName: 'submit_result',
        payload: {
          summary: 'Scout completed.',
          workflowId,
        },
      },
    );

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'budget-decision-result',
          runId: result.run.id,
          taskId: 'task-decide',
          token: readTaskCredentialToken('task-decide'),
          toolName: 'submit_result',
          payload: {
            metadata: {
              workflowActions: [{ id: 'followup', kind: 'append_worker', name: 'Followup' }],
            },
            summary: 'Decision wants one more step.',
            workflowId,
          },
        },
      ),
    ).rejects.toThrow('workflowActions would exceed workflow step budget 2');

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow?.results.map((entry) => entry.summary)).toEqual(['Scout completed.']);
    expect(workflow?.lanes.find((lane) => lane.taskId === 'task-decide')?.resultId).toBeUndefined();
    expect(workflow?.expansions).toBeUndefined();
    expect(workflow?.stages.map((stage) => stage.id)).toEqual(['scout', 'decide']);
  });

  it('enforces a lowered total-lane budget when spawn_many extends an existing workflow', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-one', 'task-two']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-many-budget-create',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_many',
        payload: {
          lanes: [{ assignment: 'Map backend risks.', name: 'Backend' }],
          policy: { maxTotalLanes: 1 },
          title: 'Lane budget fan out',
        },
      },
    );
    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'spawn-many-budget-extend',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'spawn_many',
          payload: {
            lanes: [{ assignment: 'Map UI risks.', name: 'UI' }],
            workflowId,
          },
        },
      ),
    ).rejects.toThrow('spawn_many would exceed workflow lane limit 1');
    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.lanes).toHaveLength(1);
  });

  it('rejects spawn_many extensions once the workflow wall-clock deadline has passed', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-one']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-many-deadline-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          policy: { maxWallClockMs: 60_000 },
          problem: 'Review deadline gating for spawn_many.',
          spec: {
            steps: [
              {
                id: 'fan',
                kind: 'fanout',
                lanes: [{ assignment: 'Map backend risks.', id: 'backend', name: 'Backend' }],
              },
            ],
          },
          template: 'custom',
          title: 'Deadline-gated fan out',
        },
      },
    );
    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    if (workflow?.execution === undefined) {
      throw new Error('Expected workflow execution state');
    }
    updateCoordinatorWorkflow(result.run.id, workflow.id, {
      execution: { ...workflow.execution, deadlineAt: 1 },
    });

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'spawn-many-deadline-extend',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'spawn_many',
          payload: {
            lanes: [{ assignment: 'Map UI risks.', name: 'UI' }],
            workflowId: workflow.id,
          },
        },
      ),
    ).rejects.toThrow('budget-exhausted: wall-clock (60000/60000)');
    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.lanes).toHaveLength(1);
  });

  it('accepts a zero retry budget policy and records it on the workflow snapshot', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-worker']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'workflow-zero-retry-budget',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          policy: { maxTotalRetries: 0 },
          problem: 'Review a zero retry budget.',
          spec: { steps: [{ id: 'worker', kind: 'worker' }] },
          template: 'custom',
        },
      },
    );

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow?.policy).toMatchObject({ maxTotalRetries: 0 });
    expect(workflow?.execution?.budget).toMatchObject({ retries: { limit: 0, used: 0 } });
  });

  it('blocks workflow advancement when a lane submits a needs-followup result', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-map', 'task-reduce']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'workflow-start-needs-followup',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          lanes: [{ assignment: 'Map backend risks.', name: 'Backend' }],
          problem: 'Review follow-up behavior.',
          template: 'map_reduce',
        },
      },
    );
    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;
    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'workflow-needs-followup',
        runId: result.run.id,
        taskId: 'task-map',
        token: readTaskCredentialToken('task-map'),
        toolName: 'submit_result',
        payload: {
          status: 'needs-followup',
          summary: 'Need coordinator input before reducing.',
          workflowId,
        },
      },
    );

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow).toMatchObject({
      status: 'blocked',
      stages: [
        expect.objectContaining({ id: 'map', status: 'blocked' }),
        expect.objectContaining({ id: 'reduce', status: 'pending' }),
      ],
    });
    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(1);
  });

  it('fails a workflow when a required follow-up lane cannot spawn', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    let createCount = 0;
    mocks.createTaskWorkflowMock.mockImplementation(async () => {
      createCount += 1;
      if (createCount === 2) {
        throw new Error('reduce spawn failed');
      }

      return {
        base_branch: 'main',
        branch_name: 'feature/task-map',
        git_isolation: 'worktree',
        id: 'task-map',
        worktree_path: '/repo/task-map',
      };
    });
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'workflow-start-reduce-fail',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          lanes: [{ assignment: 'Map backend risks.', name: 'Backend' }],
          problem: 'Review follow-up spawn behavior.',
          template: 'map_reduce',
        },
      },
    );
    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'workflow-map-result-reduce-fail',
        runId: result.run.id,
        taskId: 'task-map',
        token: readTaskCredentialToken('task-map'),
        toolName: 'submit_result',
        payload: {
          summary: 'Map result ready.',
          workflowId,
        },
      },
    );

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow).toMatchObject({
      status: 'failed',
      stages: [
        expect.objectContaining({ id: 'map', status: 'completed' }),
        expect.objectContaining({ id: 'reduce', status: 'failed' }),
      ],
    });
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({ status: 'completed', taskId: 'task-map' }),
      expect.objectContaining({ failure: 'reduce spawn failed', role: 'reduce', status: 'failed' }),
    ]);
  });

  it('fails a workflow instead of advancing when required initial lanes all fail before results', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mocks.createTaskWorkflowMock.mockRejectedValue(new Error('initial spawn failed'));
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'workflow-start-initial-fail',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          lanes: [{ assignment: 'Map backend risks.', name: 'Backend' }],
          problem: 'Review initial spawn behavior.',
          template: 'map_reduce',
        },
      },
    );

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow).toMatchObject({
      status: 'failed',
      stages: [
        expect.objectContaining({ id: 'map', status: 'failed' }),
        expect.objectContaining({ id: 'reduce', status: 'pending' }),
      ],
    });
    expect(workflow?.lanes).toEqual([
      expect.objectContaining({
        failure: 'initial spawn failed',
        name: 'Backend',
        status: 'failed',
      }),
    ]);
    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized workflow result payloads before storing them', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-map']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'workflow-start-result-limits',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          lanes: [{ assignment: 'Map backend risks.', name: 'Backend' }],
          problem: 'Review result limits.',
          template: 'map_reduce',
        },
      },
    );
    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;
    const childToken = readTaskCredentialToken('task-map');
    const oversizedText = 'x'.repeat(COORDINATOR_LIMITS.maxWorkflowResultEntryChars + 1);

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'workflow-result-command-limit',
          runId: result.run.id,
          taskId: 'task-map',
          token: childToken,
          toolName: 'submit_result',
          payload: {
            commandsRun: Array.from(
              { length: COORDINATOR_LIMITS.maxWorkflowResultListItems + 1 },
              (_, index) => `command-${index}`,
            ),
            summary: 'Oversized commands.',
            workflowId,
          },
        },
      ),
    ).rejects.toThrow('commandsRun must be no longer');

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'workflow-result-risk-limit',
          runId: result.run.id,
          taskId: 'task-map',
          token: childToken,
          toolName: 'submit_result',
          payload: {
            risks: [oversizedText],
            summary: 'Oversized risk.',
            workflowId,
          },
        },
      ),
    ).rejects.toThrow('risks entry must be no longer');

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'workflow-result-metadata-limit',
          runId: result.run.id,
          taskId: 'task-map',
          token: childToken,
          toolName: 'submit_result',
          payload: {
            metadata: { payload: 'x'.repeat(COORDINATOR_LIMITS.maxWorkflowMetadataBytes + 1) },
            summary: 'Oversized metadata.',
            workflowId,
          },
        },
      ),
    ).rejects.toThrow('metadata must be no larger');

    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.results).toHaveLength(0);
  });

  it('cancels workflow lanes when the coordinator closes their hidden subtask', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-map']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'workflow-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          lanes: [{ assignment: 'Map backend risks.', name: 'Backend' }],
          problem: 'Review cleanup behavior.',
          template: 'map_reduce',
        },
      },
    );
    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'workflow-close',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'close_task',
        payload: { targetTaskId: 'task-map' },
      },
    );

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow).toMatchObject({
      status: 'cancelled',
      stages: [expect.objectContaining({ id: 'map', status: 'cancelled' }), expect.any(Object)],
    });
    expect(workflow?.lanes[0]).toMatchObject({
      failure: 'subtask-cleaned-up',
      status: 'cancelled',
    });
  });

  it('enforces project spawn concurrency while a hidden task is being created', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    const taskNames = createTaskRegistry();
    const deferredTask = createDeferredPromise<{
      base_branch: string;
      branch_name: string;
      git_isolation: 'worktree';
      id: string;
      worktree_path: string;
    }>();
    mocks.createTaskWorkflowMock.mockReturnValue(deferredTask.promise);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    const first = executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: {
            command: 'custom-agent',
          },
          assignment: 'Build the slice',
          dedupeKey: 'first-spawn',
          name: 'Child Task 1',
        },
      },
    );

    await Promise.resolve();
    await expect(
      executeCoordinatorToolCall(
        { context, taskNames },
        {
          callId: 'call-2',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'spawn_subtask',
          payload: {
            agent: {
              command: 'custom-agent',
            },
            assignment: 'Build another slice',
            dedupeKey: 'second-spawn',
            name: 'Child Task 2',
          },
        },
      ),
    ).rejects.toThrow('Coordinator project spawn limit reached');

    deferredTask.resolve({
      base_branch: 'main',
      branch_name: 'feature/child',
      git_isolation: 'worktree',
      id: 'task-child',
      worktree_path: '/repo/task-child',
    });
    await first;

    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(1);
  });

  it('counts waiting and review subtasks against the coordinator subtask limit', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    const activeStatuses: CoordinatorSubtaskStatus[] = [
      'waiting-for-user',
      'waiting-for-coordinator',
      'ready-for-review',
      'landing',
      'running',
    ];

    for (
      let index = 0;
      index <
      COORDINATOR_LIMITS.maxActiveSubtasksPerRun + COORDINATOR_LIMITS.maxQueuedSubtasksPerRun;
      index += 1
    ) {
      addCoordinatorSubtask({
        agentId: `agent-child-${index}`,
        assignment: `Do the work ${index}`,
        parentCoordinatorTaskId: 'task-coordinator',
        runId: result.run.id,
        status: activeStatuses[index % activeStatuses.length],
        taskId: `task-child-${index}`,
        toolTokenId: `token-child-${index}`,
        worktreePath: `/repo/task-child-${index}`,
      });
    }

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'call-over-limit',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'spawn_subtask',
          payload: {
            agent: {
              command: 'custom-agent',
            },
            assignment: 'Build another slice',
            name: 'Child Task',
          },
        },
      ),
    ).rejects.toThrow('Coordinator subtask limit reached');
    expect(mocks.createTaskWorkflowMock).not.toHaveBeenCalled();
  });

  it('rejects tool calls from cleanup-failed and landing-failed subtasks', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });

    for (const status of ['cleanup-failed', 'landing-failed'] as const) {
      const taskId = `task-${status}`;
      addCoordinatorSubtask({
        agentId: `agent-${status}`,
        assignment: 'Do the work',
        parentCoordinatorTaskId: 'task-coordinator',
        runId: result.run.id,
        status,
        taskId,
        toolTokenId: `token-${status}`,
        worktreePath: `/repo/${taskId}`,
      });
      const credential = createCoordinatorCredential(context, {
        agentId: `agent-${status}`,
        runId: result.run.id,
        taskId,
        toolCallUrl: context.coordinatorToolCallUrl,
      });

      await expect(
        executeCoordinatorToolCall(
          { context, taskNames: createTaskRegistry() },
          {
            callId: `call-${status}`,
            runId: result.run.id,
            taskId,
            token: credential.token,
            toolName: 'get_task_status',
          },
        ),
      ).rejects.toThrow('Coordinator subtask is no longer active');
    }
  });

  it('rolls back registry, credential, and created task state when hidden spawn fails', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    const taskNames = createTaskRegistry();
    mockCreatedTaskResult();
    mocks.spawnTaskAgentWorkflowMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const response = await executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: {
            command: 'custom-agent',
          },
          assignment: 'Build the slice',
          name: 'Child Task',
        },
      },
    );

    expect(taskNames.deleteTask).toHaveBeenCalledWith('task-child');
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: 'feature/child',
        deleteBranch: true,
        taskId: 'task-child',
      }),
    );
    expect(response.result).toMatchObject({
      result: 'spawn failed',
      status: 'failed',
      taskId: 'task-child',
    });
    expect(coordinatorRuntime.getCoordinatorSubtaskLaunch(result.run.id, 'task-child')).toBeNull();
    const childTokenId = getCoordinatorRun(result.run.id)?.subtasks[0]?.toolTokenId;
    expect(childTokenId).toEqual(expect.any(String));
  });

  it('retains a failed spawn rollback as a coordinator cleanup owner', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const taskNames = createTaskRegistry();
    mockCreatedTaskResult();
    mocks.spawnTaskAgentWorkflowMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    mocks.deleteTaskWorkflowMock
      .mockResolvedValueOnce({
        cleanupWarnings: [{ kind: 'worktree', message: 'worktree busy' }],
        releasedTaskCommandController: null,
      })
      .mockResolvedValueOnce({ cleanupWarnings: [], releasedTaskCommandController: null });

    const response = await executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'spawn-with-cleanup-failure',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token: readCredentialToken(result.credentialPath),
        toolName: 'spawn_subtask',
        payload: {
          agent: { command: 'custom-agent' },
          assignment: 'Build the slice',
          name: 'Child Task',
        },
      },
    );

    expect(response.result).toMatchObject({
      result: expect.stringContaining('worktree busy'),
      status: 'cleanup-failed',
      taskId: 'task-child',
    });
    await expect(
      cleanupCoordinatorTaskStateAndOwnedSubtasks({ context, taskNames }, 'task-coordinator'),
    ).resolves.toEqual([]);
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledTimes(2);
    expect(getCoordinatorRun(result.run.id)).toBeNull();
  });

  it('lands a clean subtask through parent lease, merge, cleanup, registry deletion, and credential revocation', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      branchName: 'feature/child',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    const childCredential = createCoordinatorCredential(context, {
      agentId: 'agent-child',
      runId: result.run.id,
      taskId: 'task-child',
      toolCallUrl: context.coordinatorToolCallUrl,
    });
    coordinatorRuntime.recordCoordinatorSubtaskLaunch({
      agent: { command: 'custom-agent', env: { CUSTOM_FLAG: '1' } },
      assignment: 'Do the work',
      dedupeKey: 'launch-task-child',
      name: 'Child Task',
      recordedAt: Date.now(),
      runId: result.run.id,
      taskId: 'task-child',
    });
    const taskNames = createTaskRegistry();
    mocks.getWorktreeStatusMock.mockResolvedValue({ has_uncommitted_changes: false });
    mocks.mergeTaskMock.mockResolvedValue({ main_branch: 'main' });

    const response = await executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-child',
        token: childCredential.token,
        toolName: 'land_self',
        payload: {
          summary: 'Landed child work',
          verification: ['npm test'],
        },
      },
    );

    expect(mocks.mergeTaskMock).toHaveBeenCalledWith(
      '/repo',
      '/repo/task-child',
      'feature/child',
      false,
      'Landed child work',
      false,
      undefined,
      expect.any(Function),
    );
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentIds: ['agent-child'],
        branchName: 'feature/child',
        deleteBranch: true,
        taskId: 'task-child',
      }),
    );
    expect(taskNames.markTaskClosing).toHaveBeenCalledWith('task-child');
    expect(vi.mocked(taskNames.markTaskClosing).mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteTaskWorkflowMock.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(taskNames.deleteTask).toHaveBeenCalledWith('task-child');
    expect(resolveCoordinatorToken(childCredential.token)).toBeNull();
    expect(coordinatorRuntime.getCoordinatorSubtaskLaunch(result.run.id, 'task-child')).toBeNull();
    expect(response.result).toMatchObject({
      status: 'landed',
      taskId: 'task-child',
    });
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]).toMatchObject({
      status: 'landed',
    });
  });

  it('records cleanup-failed when landing merge succeeds but hidden task deletion reports warnings', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      branchName: 'feature/child',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    const childCredential = createCoordinatorCredential(context, {
      agentId: 'agent-child',
      runId: result.run.id,
      taskId: 'task-child',
      toolCallUrl: context.coordinatorToolCallUrl,
    });
    mocks.getWorktreeStatusMock.mockResolvedValue({ has_uncommitted_changes: false });
    mocks.mergeTaskMock.mockResolvedValue({ main_branch: 'main' });
    mocks.deleteTaskWorkflowMock.mockResolvedValue({
      cleanupWarnings: [
        {
          kind: 'worktree',
          message: 'Worktree cleanup failed',
        },
      ],
      releasedTaskCommandController: null,
    });

    const response = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-child',
        token: childCredential.token,
        toolName: 'land_self',
        payload: {
          summary: 'Landed child work',
          verification: ['npm test'],
        },
      },
    );

    expect(response.result).toMatchObject({
      failure: 'Worktree cleanup failed',
      status: 'cleanup-failed',
      taskId: 'task-child',
    });
    expect(resolveCoordinatorToken(childCredential.token)).toBeNull();
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]).toMatchObject({
      status: 'cleanup-failed',
    });
  });

  it('blocks self-landing while a user holds the parent task command lease', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      branchName: 'feature/child',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    const childCredential = createCoordinatorCredential(context, {
      agentId: 'agent-child',
      runId: result.run.id,
      taskId: 'task-child',
      toolCallUrl: context.coordinatorToolCallUrl,
    });
    acquireTaskCommandLease(
      'task-coordinator',
      'user-client',
      'user-client',
      'typing in coordinator terminal',
    );

    const response = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-child',
        token: childCredential.token,
        toolName: 'land_self',
        payload: {
          summary: 'Landed child work',
          verification: ['npm test'],
        },
      },
    );

    expect(response.result).toMatchObject({
      failure: 'Coordinator task is currently controlled by a user.',
      status: 'blocked-by-parent-control',
      taskId: 'task-child',
    });
    expect(mocks.mergeTaskMock).not.toHaveBeenCalled();
    expect(mocks.deleteTaskWorkflowMock).not.toHaveBeenCalled();
  });

  it('cleans coordinator-owned hidden subtasks before removing a parent run', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      branchName: 'feature/child',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    const childCredential = createCoordinatorCredential(context, {
      agentId: 'agent-child',
      runId: result.run.id,
      taskId: 'task-child',
      toolCallUrl: context.coordinatorToolCallUrl,
    });
    const taskNames = createTaskRegistry();

    const fullRunRead = vi.spyOn(coordinatorRuntime, 'getCoordinatorRun');
    try {
      const warnings = await cleanupCoordinatorTaskStateAndOwnedSubtasks(
        { context, taskNames },
        'task-coordinator',
      );
      expect(warnings).toEqual([]);
      expect(fullRunRead).not.toHaveBeenCalled();
    } finally {
      fullRunRead.mockRestore();
    }

    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentIds: ['agent-child'],
        branchName: 'feature/child',
        deleteBranch: true,
        taskId: 'task-child',
        worktreePath: '/repo/task-child',
      }),
    );
    expect(taskNames.deleteTask).toHaveBeenCalledWith('task-child');
    expect(resolveCoordinatorToken(childCredential.token)).toBeNull();
    expect(getCoordinatorRun(result.run.id)).toBeNull();
  });

  it('cancels admission and drains an in-flight spawn before removing its parent run', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    const taskNames = createTaskRegistry();
    const deferredTask = createDeferredPromise<{
      base_branch: string;
      branch_name: string;
      git_isolation: 'worktree';
      id: string;
      worktree_path: string;
    }>();
    mocks.createTaskWorkflowMock.mockReturnValue(deferredTask.promise);
    mocks.hasAgentSessionMock.mockReturnValue(false);
    const runEventTypes: string[] = [];
    const unsubscribe = coordinatorRuntime.subscribeCoordinatorEvents((event) => {
      if (event.runId === result.run.id) {
        runEventTypes.push(event.eventType);
      }
    });

    const spawn = executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'spawn-during-parent-cleanup',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: { command: 'custom-agent' },
          assignment: 'Finish before parent cleanup.',
          name: 'Deferred child',
        },
      },
    );
    const spawnFailure = spawn.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();
    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(1);

    let cleanupSettled = false;
    const cleanup = cleanupCoordinatorTaskStateAndOwnedSubtasks(
      { context, taskNames },
      'task-coordinator',
    ).finally(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();

    expect(cleanupSettled).toBe(false);
    expect(coordinatorRuntime.getCoordinatorRunMeta(result.run.id)?.status).toBe('cancelled');
    await expect(
      executeCoordinatorToolCall(
        { context, taskNames },
        {
          callId: 'spawn-after-cleanup-cancelled',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'spawn_subtask',
          payload: {
            agent: { command: 'custom-agent' },
            assignment: 'Must not be admitted.',
            name: 'Rejected child',
          },
        },
      ),
    ).rejects.toThrow('Coordinator run is cancelled');

    deferredTask.resolve({
      base_branch: 'main',
      branch_name: 'feature/deferred-child',
      git_isolation: 'worktree',
      id: 'task-deferred-child',
      worktree_path: '/repo/task-deferred-child',
    });
    const cleanupWarnings = await cleanup;
    const spawnError = await spawnFailure;

    expect(spawnError).toEqual(expect.objectContaining({ message: 'Coordinator run is closing' }));
    expect(cleanupWarnings).toEqual([]);
    expect(taskNames.registerCreatedTask).not.toHaveBeenCalled();
    expect(mocks.spawnTaskAgentWorkflowMock).not.toHaveBeenCalled();
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-deferred-child' }),
    );
    expect(getCoordinatorRun(result.run.id)).toBeNull();
    const removedIndex = runEventTypes.lastIndexOf('run-removed');
    expect(removedIndex).toBeGreaterThanOrEqual(0);
    expect(runEventTypes.slice(removedIndex + 1)).toEqual([]);
    unsubscribe();

    await flushCoordinatorRuntimeState(context);
    await resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    ensureCoordinatorServiceLoaded(context);
    expect(getCoordinatorRun(result.run.id)).toBeNull();
  });

  it('does not admit a later lane when parent cleanup closes a multi-lane workflow', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    const taskNames = createTaskRegistry();
    const firstTask = createDeferredPromise<{
      base_branch: string;
      branch_name: string;
      git_isolation: 'worktree';
      id: string;
      worktree_path: string;
    }>();
    mocks.createTaskWorkflowMock.mockReturnValueOnce(firstTask.promise);

    const workflowStart = executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'multi-lane-cleanup-race',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          agent: { command: 'custom-agent' },
          lanes: [
            { assignment: 'Inspect backend.', name: 'Backend' },
            { assignment: 'Inspect renderer.', name: 'Renderer' },
          ],
          problem: 'Review both surfaces.',
          template: 'custom',
          title: 'Cleanup admission race',
        },
      },
    );
    const workflowFailure = workflowStart.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();
    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(1);

    const cleanup = cleanupCoordinatorTaskStateAndOwnedSubtasks(
      { context, taskNames },
      'task-coordinator',
    );
    await Promise.resolve();
    expect(coordinatorRuntime.getCoordinatorRunMeta(result.run.id)?.status).toBe('cancelled');

    firstTask.resolve({
      base_branch: 'main',
      branch_name: 'feature/first-lane',
      git_isolation: 'worktree',
      id: 'task-first-lane',
      worktree_path: '/repo/task-first-lane',
    });

    expect(await cleanup).toEqual([]);
    expect(await workflowFailure).toEqual(
      expect.objectContaining({ message: 'Coordinator run is closing' }),
    );
    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(1);
    expect(mocks.spawnTaskAgentWorkflowMock).not.toHaveBeenCalled();
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledTimes(1);
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-first-lane' }),
    );
    expect(getCoordinatorRun(result.run.id)).toBeNull();
  });

  it('bounds a never-settling spawn drain, releases capacity, and self-cleans a late result', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const firstRun = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator-1',
      coordinatorTaskId: 'task-coordinator-1',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const firstToken = readCredentialToken(firstRun.credentialPath);
    const firstTaskNames = createTaskRegistry();
    const lateTask = createDeferredPromise<{
      base_branch: string;
      branch_name: string;
      git_isolation: 'worktree';
      id: string;
      worktree_path: string;
    }>();
    mocks.createTaskWorkflowMock.mockReturnValueOnce(lateTask.promise).mockResolvedValueOnce({
      base_branch: 'main',
      branch_name: 'feature/next-child',
      git_isolation: 'worktree',
      id: 'task-next-child',
      worktree_path: '/repo/task-next-child',
    });

    const firstSpawn = executeCoordinatorToolCall(
      { context, taskNames: firstTaskNames },
      {
        callId: 'never-settling-spawn',
        runId: firstRun.run.id,
        taskId: 'task-coordinator-1',
        token: firstToken,
        toolName: 'spawn_subtask',
        payload: {
          agent: { command: 'custom-agent' },
          assignment: 'May finish after cleanup.',
          name: 'Late child',
        },
      },
    );
    const firstSpawnFailure = firstSpawn.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();
    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(1);

    const cleanup = cleanupCoordinatorTaskStateAndOwnedSubtasks(
      { context, taskNames: firstTaskNames },
      'task-coordinator-1',
    );
    await vi.advanceTimersByTimeAsync(COORDINATOR_PARENT_CLEANUP_TIMEOUT_MS);
    const cleanupWarnings = await cleanup;

    expect(cleanupWarnings).toEqual([
      expect.objectContaining({
        kind: 'worktree',
        message: expect.stringContaining('stopped waiting for 1 in-flight spawn'),
      }),
    ]);
    expect(getCoordinatorRun(firstRun.run.id)).toBeNull();

    // The timed-out reservation no longer consumes the per-project spawn slot even though its
    // underlying task-creation promise is still unresolved.
    const secondRun = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator-2',
      coordinatorTaskId: 'task-coordinator-2',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const secondSpawn = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-after-drain-timeout',
        runId: secondRun.run.id,
        taskId: 'task-coordinator-2',
        token: readCredentialToken(secondRun.credentialPath),
        toolName: 'spawn_subtask',
        payload: {
          agent: { command: 'custom-agent' },
          assignment: 'Use the released capacity.',
          name: 'Next child',
        },
      },
    );
    expect(secondSpawn.result).toMatchObject({ taskId: 'task-next-child' });

    lateTask.resolve({
      base_branch: 'main',
      branch_name: 'feature/late-child',
      git_isolation: 'worktree',
      id: 'task-late-child',
      worktree_path: '/repo/task-late-child',
    });
    expect(await firstSpawnFailure).toEqual(
      expect.objectContaining({ message: 'Coordinator run is no longer active' }),
    );
    expect(firstTaskNames.registerCreatedTask).not.toHaveBeenCalled();
    expect(mocks.spawnTaskAgentWorkflowMock).toHaveBeenCalledTimes(1);
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-late-child' }),
    );
    expect(getCoordinatorRun(firstRun.run.id)).toBeNull();
  });

  it('keeps a timed-out spawn owned through shutdown until its late task is rolled back', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const lateTask = createDeferredPromise<{
      base_branch: string;
      branch_name: string;
      git_isolation: 'worktree';
      id: string;
      worktree_path: string;
    }>();
    mocks.createTaskWorkflowMock.mockReturnValueOnce(lateTask.promise);
    const taskNames = createTaskRegistry();
    const spawn = executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'shutdown-owned-late-spawn',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token: readCredentialToken(result.credentialPath),
        toolName: 'spawn_subtask',
        payload: {
          agent: { command: 'custom-agent' },
          assignment: 'Resolve only after shutdown starts.',
          name: 'Shutdown-owned child',
        },
      },
    );
    const spawnFailure = spawn.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();

    const parentCleanup = cleanupCoordinatorTaskStateAndOwnedSubtasks(
      { context, taskNames },
      'task-coordinator',
    );
    await vi.advanceTimersByTimeAsync(COORDINATOR_PARENT_CLEANUP_TIMEOUT_MS);
    await expect(parentCleanup).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining('stopped waiting for 1') }),
    ]);

    let shutdownSettled = false;
    const shutdown = cleanupCoordinatorProducersForShutdown().finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    lateTask.resolve({
      base_branch: 'main',
      branch_name: 'feature/shutdown-owned-child',
      git_isolation: 'worktree',
      id: 'task-shutdown-owned-child',
      worktree_path: '/repo/task-shutdown-owned-child',
    });

    await expect(shutdown).resolves.toBeUndefined();
    expect(await spawnFailure).toEqual(
      expect.objectContaining({ message: 'Coordinator runtime is stopping' }),
    );
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-shutdown-owned-child' }),
    );
  });

  it('retains and retries a late-created task rollback after the parent deadline', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const lateTask = createDeferredPromise<{
      base_branch: string;
      branch_name: string;
      git_isolation: 'worktree';
      id: string;
      worktree_path: string;
    }>();
    mocks.createTaskWorkflowMock.mockReturnValueOnce(lateTask.promise);
    const taskNames = createTaskRegistry();
    const spawn = executeCoordinatorToolCall(
      { context, taskNames },
      {
        callId: 'late-cleanup-retry',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token: readCredentialToken(result.credentialPath),
        toolName: 'spawn_subtask',
        payload: {
          agent: { command: 'custom-agent' },
          assignment: 'Resolve after parent cleanup.',
          name: 'Late child',
        },
      },
    );
    const spawnFailure = spawn.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();

    const cleanup = cleanupCoordinatorTaskStateAndOwnedSubtasks(
      { context, taskNames },
      'task-coordinator',
    );
    await vi.advanceTimersByTimeAsync(COORDINATOR_PARENT_CLEANUP_TIMEOUT_MS);
    await expect(cleanup).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining('stopped waiting for 1') }),
    ]);
    mocks.deleteTaskWorkflowMock
      .mockResolvedValueOnce({
        cleanupWarnings: [{ kind: 'worktree', message: 'worktree still busy' }],
        releasedTaskCommandController: null,
      })
      .mockResolvedValueOnce({ cleanupWarnings: [], releasedTaskCommandController: null });

    lateTask.resolve({
      base_branch: 'main',
      branch_name: 'feature/late-cleanup',
      git_isolation: 'worktree',
      id: 'task-late-cleanup',
      worktree_path: '/repo/task-late-cleanup',
    });
    expect(await spawnFailure).toEqual(
      expect.objectContaining({ message: expect.stringContaining('cleanup incomplete') }),
    );
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledTimes(2);
    await expect(
      cleanupCoordinatorTaskStateAndOwnedSubtasks({ context, taskNames }, 'task-coordinator'),
    ).resolves.toEqual([]);
  });

  it('releases non-git backend state even when runner cleanup fails', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'non-git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo',
    });
    mocks.stopTaskAgentWorkflowsForTaskMock.mockRejectedValueOnce(
      new Error('runner daemon unavailable'),
    );

    const warnings = await cleanupCoordinatorTaskStateAndOwnedSubtasks(
      { context, taskNames: createTaskRegistry() },
      'task-coordinator',
    );

    expect(warnings).toEqual([
      expect.objectContaining({
        kind: 'runners',
        message: expect.stringContaining('runner daemon unavailable'),
      }),
    ]);
    expect(mocks.cleanupTaskRuntimeWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ removeTaskState: true, taskId: 'task-child' }),
    );
    expect(getCoordinatorRun(result.run.id)).toBeNull();
  });

  it('retains a non-git cleanup warning for an undefined runner rejection', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'non-git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo',
    });
    mocks.stopTaskAgentWorkflowsForTaskMock.mockRejectedValueOnce(undefined);

    const warnings = await cleanupCoordinatorTaskStateAndOwnedSubtasks(
      { context, taskNames: createTaskRegistry() },
      'task-coordinator',
    );

    expect(warnings).toEqual([
      expect.objectContaining({
        kind: 'runners',
        message: expect.stringContaining('undefined'),
      }),
    ]);
    expect(mocks.cleanupTaskRuntimeWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ removeTaskState: true, taskId: 'task-child' }),
    );
  });

  it('cleans exited coordinator-owned hidden subtasks before removing a parent run', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const childCredential = addExitedCoordinatorOwnedSubtask(context, result.run.id);
    const taskNames = createTaskRegistry();

    const warnings = await cleanupCoordinatorTaskStateAndOwnedSubtasks(
      { context, taskNames },
      'task-coordinator',
    );

    expect(warnings).toEqual([]);
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentIds: ['agent-child'],
        branchName: 'feature/child',
        deleteBranch: true,
        taskId: 'task-child',
        worktreePath: '/repo/task-child',
      }),
    );
    expect(taskNames.deleteTask).toHaveBeenCalledWith('task-child');
    expect(resolveCoordinatorToken(childCredential.token)).toBeNull();
    expect(getCoordinatorRun(result.run.id)).toBeNull();
  });

  it('preserves cleanup warning kinds from coordinator-owned hidden subtasks', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addExitedCoordinatorOwnedSubtask(context, result.run.id);
    mocks.deleteTaskWorkflowMock.mockResolvedValueOnce({
      cleanupWarnings: [{ kind: 'containers', message: 'container daemon unavailable' }],
      releasedTaskCommandController: null,
    });

    const warnings = await cleanupCoordinatorTaskStateAndOwnedSubtasks(
      { context, taskNames: createTaskRegistry() },
      'task-coordinator',
    );

    expect(warnings).toEqual([
      {
        kind: 'containers',
        message: expect.stringContaining('container daemon unavailable'),
      },
    ]);
    expect(getCoordinatorRun(result.run.id)).toBeNull();
  });

  it('bounds external child cleanup under the same parent deadline', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const childCredential = addExitedCoordinatorOwnedSubtask(context, result.run.id);
    const taskNames = createTaskRegistry();
    const externalCleanup = createDeferredPromise<{
      cleanupWarnings: [];
      releasedTaskCommandController: null;
    }>();
    mocks.deleteTaskWorkflowMock.mockReturnValueOnce(externalCleanup.promise);

    const cleanup = cleanupCoordinatorTaskStateAndOwnedSubtasks(
      { context, taskNames },
      'task-coordinator',
    );
    await Promise.resolve();
    expect(taskNames.deleteTask).toHaveBeenCalledWith('task-child');
    expect(resolveCoordinatorToken(childCredential.token)).toBeNull();

    await vi.advanceTimersByTimeAsync(COORDINATOR_PARENT_CLEANUP_TIMEOUT_MS);
    const warnings = await cleanup;
    expect(warnings).toEqual([
      expect.objectContaining({
        kind: 'worktree',
        message: expect.stringContaining('parent cleanup deadline elapsed'),
      }),
    ]);
    expect(getCoordinatorRun(result.run.id)).toBeNull();

    let shutdownSettled = false;
    const shutdown = cleanupCoordinatorProducersForShutdown().finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    externalCleanup.resolve({ cleanupWarnings: [], releasedTaskCommandController: null });
    await expect(shutdown).resolves.toBeUndefined();
    expect(getCoordinatorRun(result.run.id)).toBeNull();
  });

  it('lets renderer actions inspect coordinator subtasks without tool tokens', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const credentialToken = readCredentialToken(result.credentialPath);
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    mocks.getAgentScrollbackBufferMock.mockReturnValue(Buffer.from('renderer output'));

    const list = await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      {
        coordinatorTaskId: 'task-coordinator',
        requestId: 'renderer-list',
        runId: result.run.id,
        toolName: 'list_tasks',
      },
    );
    const output = await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      {
        coordinatorTaskId: 'task-coordinator',
        payload: { targetTaskId: 'task-child' },
        requestId: 'renderer-output',
        runId: result.run.id,
        toolName: 'get_task_output',
      },
    );

    expect(JSON.stringify(list)).not.toContain(credentialToken);
    expect(list.result).toEqual([
      expect.objectContaining({
        assignment: 'Do the work',
        taskId: 'task-child',
      }),
    ]);
    expect(output.result).toMatchObject({
      output: 'renderer output',
      taskId: 'task-child',
    });
  });

  it('rejects renderer coordinator mutations without the task command lease', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });

    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          payload: {
            targetTaskId: 'task-child',
            text: 'Continue',
          },
          requestId: 'renderer-send',
          runId: result.run.id,
          toolName: 'send_prompt',
        },
      ),
    ).rejects.toThrow('Coordinator task command lease is required');
  });

  it('requires the coordinator task lease for renderer workflow starts', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    mockCreatedTaskSequence(['task-map']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    const request = {
      controllerId: 'browser-client-1',
      coordinatorTaskId: 'task-coordinator',
      payload: {
        lanes: [{ assignment: 'Map backend risks.', name: 'Backend' }],
        problem: 'Review startup.',
        template: 'map_reduce' as const,
      },
      requestId: 'renderer-start-workflow',
      runId: result.run.id,
      toolName: 'start_workflow' as const,
    };

    await expect(
      executeCoordinatorRendererAction({ context, taskNames: createTaskRegistry() }, request),
    ).rejects.toThrow('Coordinator task command lease is required');

    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'coordinate subtasks');
    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          ...request,
          requestId: 'renderer-start-workflow-with-lease',
        },
      ),
    ).resolves.toMatchObject({
      accepted: true,
      result: {
        workflow: expect.objectContaining({ template: 'map_reduce' }),
      },
    });
  });

  it('allows renderer inspection on inactive runs but rejects inactive-run mutations', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    updateCoordinatorRunStatus(result.run.id, 'completed');
    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'coordinate subtasks');

    const list = await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      {
        coordinatorTaskId: 'task-coordinator',
        requestId: 'renderer-list-completed',
        runId: result.run.id,
        toolName: 'list_tasks',
      },
    );

    expect(list.result).toEqual([
      expect.objectContaining({
        taskId: 'task-child',
      }),
    ]);
    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          payload: {
            targetTaskId: 'task-child',
            text: 'Continue',
          },
          requestId: 'renderer-send-completed',
          runId: result.run.id,
          toolName: 'send_prompt',
        },
      ),
    ).rejects.toThrow('Coordinator run is completed');
  });

  it('rejects renderer subtask spawn while a run is draining', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    updateCoordinatorRunStatus(result.run.id, 'draining');
    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'coordinate subtasks');

    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          payload: {
            agent: { command: 'codex' },
            assignment: 'Do the work',
            name: 'child',
          },
          requestId: 'renderer-spawn-draining',
          runId: result.run.id,
          toolName: 'spawn_subtask',
        },
      ),
    ).rejects.toThrow('Coordinator run is draining');
  });

  it('rejects subtask-owned tools through renderer coordinator actions', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });

    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        unsafeRendererRequest({
          coordinatorTaskId: 'task-coordinator',
          payload: {
            summary: 'Land work',
            verification: ['npm test'],
          },
          requestId: 'renderer-land',
          runId: result.run.id,
          toolName: 'land_self',
        }),
      ),
    ).rejects.toThrow('Coordinator UI cannot call land_self');
    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        unsafeRendererRequest({
          coordinatorTaskId: 'task-coordinator',
          payload: {
            summary: 'Done',
          },
          requestId: 'renderer-submit-result',
          runId: result.run.id,
          toolName: 'submit_result',
        }),
      ),
    ).rejects.toThrow('Coordinator UI cannot call submit_result');
    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        unsafeRendererRequest({
          coordinatorTaskId: 'task-coordinator',
          payload: {
            appendId: 'renderer-append',
            steps: [{ id: 'followup', kind: 'worker' }],
            workflowId: 'workflow-1',
          },
          requestId: 'renderer-append',
          runId: result.run.id,
          toolName: 'append_workflow_steps',
        }),
      ),
    ).rejects.toThrow('Coordinator UI cannot call append_workflow_steps');
  });

  it('rejects renderer coordinator actions for tasks that do not own the run', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });

    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          coordinatorTaskId: 'task-other',
          requestId: 'renderer-list',
          runId: result.run.id,
          toolName: 'list_tasks',
        },
      ),
    ).rejects.toThrow('coordinatorTaskId must own the coordinator run');
  });

  it('dedupes renderer coordinator mutations by request id after lease validation', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'coordinate subtasks');

    const request = {
      controllerId: 'browser-client-1',
      coordinatorTaskId: 'task-coordinator',
      payload: {
        targetTaskId: 'task-child',
        text: 'Continue',
      },
      requestId: 'renderer-send',
      runId: result.run.id,
      toolName: 'send_prompt' as const,
    };
    const first = await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      request,
    );
    const second = await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      request,
    );

    expect(second).toEqual(first);
    expect(getCoordinatorRun(result.run.id)?.promptQueue).toHaveLength(1);
  });

  it('records durable launch payloads at spawn and removes them on subtask cleanup', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-launch-payload',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: {
            args: ['--model', 'fast'],
            command: 'custom-agent',
            env: { CUSTOM_FLAG: '1' },
            skipPermissionsArgs: ['--unsafe'],
          },
          assignment: 'Build the slice',
          name: 'Child Task',
        },
      },
    );

    expect(
      coordinatorRuntime.getCoordinatorSubtaskLaunch(result.run.id, 'task-child'),
    ).toMatchObject({
      agent: {
        args: ['--model', 'fast'],
        command: 'custom-agent',
        env: { CUSTOM_FLAG: '1' },
        skipPermissionsArgs: ['--unsafe'],
      },
      assignment: 'Build the slice',
      name: 'Child Task',
      runId: result.run.id,
      taskId: 'task-child',
    });

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'close-launch-payload',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'close_task',
        payload: { targetTaskId: 'task-child' },
      },
    );

    expect(coordinatorRuntime.getCoordinatorSubtaskLaunch(result.run.id, 'task-child')).toBeNull();
  });

  it('authorizes resume_run only for lease-held renderer calls on stale runs', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        unsafeRendererRequest({
          callId: 'agent-resume',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'resume_run',
        }) as never,
      ),
    ).rejects.toThrow('Unknown coordinator tool');

    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'resume the run');
    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          requestId: 'resume-running',
          runId: result.run.id,
          toolName: 'resume_run',
        },
      ),
    ).rejects.toThrow('Coordinator run is running');

    restartCoordinatorRuntime();
    resetTaskCommandLeasesForTest();

    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          coordinatorTaskId: 'task-coordinator',
          requestId: 'resume-no-controller',
          runId: result.run.id,
          toolName: 'resume_run',
        },
      ),
    ).rejects.toThrow('controllerId is required for coordinator mutations');
    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          requestId: 'resume-no-lease',
          runId: result.run.id,
          toolName: 'resume_run',
        },
      ),
    ).rejects.toThrow('Coordinator task command lease is required');
  });

  it('pauses run admission for new work while accepting in-flight completions', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();
    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'pause-spawn-before',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: { command: 'codex' },
          assignment: 'Work before the pause.',
          name: 'Child',
        },
      },
    );

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        unsafeRendererRequest({
          callId: 'agent-pause',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'pause_run',
        }) as never,
      ),
    ).rejects.toThrow('Unknown coordinator tool');

    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'pause the run');
    await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      {
        controllerId: 'browser-client-1',
        coordinatorTaskId: 'task-coordinator',
        requestId: 'pause-run',
        runId: result.run.id,
        toolName: 'pause_run',
      },
    );
    expect(getCoordinatorRun(result.run.id)).toMatchObject({ status: 'paused-by-user' });
    expect(getCoordinatorRun(result.run.id)?.pausedAt).toBeGreaterThan(0);

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'paused-spawn',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'spawn_subtask',
          payload: {
            agent: { command: 'codex' },
            assignment: 'Work during the pause.',
            name: 'Deferred child',
          },
        },
      ),
    ).rejects.toThrow('Coordinator run is paused-by-user');
    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'paused-prompt',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'send_prompt',
          payload: { targetTaskId: 'task-child', text: 'Keep going' },
        },
      ),
    ).rejects.toThrow('Coordinator run is paused-by-user');

    const listed = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'paused-list',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'list_tasks',
      },
    );
    expect(listed.accepted).toBe(true);

    const signalled = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'paused-signal-done',
        runId: result.run.id,
        taskId: 'task-child',
        token: readTaskCredentialToken('task-child'),
        toolName: 'signal_done',
        payload: { result: 'Finished during the pause.' },
      },
    );
    expect(signalled.accepted).toBe(true);
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]?.status).toBe('ready-for-review');

    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          requestId: 'paused-renderer-spawn',
          runId: result.run.id,
          toolName: 'spawn_subtask',
          payload: {
            agent: { command: 'codex' },
            assignment: 'Renderer spawn during pause.',
            name: 'Renderer child',
          },
        },
      ),
    ).rejects.toThrow('Coordinator run is paused-by-user');
    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          requestId: 'pause-while-paused',
          runId: result.run.id,
          toolName: 'pause_run',
        },
      ),
    ).rejects.toThrow('Coordinator run is paused-by-user');

    await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      {
        controllerId: 'browser-client-1',
        coordinatorTaskId: 'task-coordinator',
        requestId: 'unpause-run',
        runId: result.run.id,
        toolName: 'unpause_run',
      },
    );
    expect(getCoordinatorRun(result.run.id)).toMatchObject({ status: 'running' });
    expect(getCoordinatorRun(result.run.id)?.pausedAt).toBeUndefined();
    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          requestId: 'unpause-running',
          runId: result.run.id,
          toolName: 'unpause_run',
        },
      ),
    ).rejects.toThrow('Coordinator run is running');
  });

  it('holds gated decision actions for approval and applies them through approve_workflow_actions', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-scout', 'task-decide', 'task-follow']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'gated-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          policy: { requireDecisionApproval: true },
          problem: 'Decide with operator approval.',
          spec: {
            steps: [
              { id: 'scout', kind: 'worker', name: 'Scout' },
              {
                dependsOn: ['scout'],
                id: 'decide',
                kind: 'decision',
                name: 'Decide',
                sourceStepIds: ['scout'],
              },
            ],
          },
          template: 'custom',
          title: 'Gated decision workflow',
        },
      },
    );
    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;
    if (workflowId === undefined) {
      throw new Error('Expected gated workflow id');
    }
    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'gated-scout-result',
        runId: result.run.id,
        taskId: 'task-scout',
        token: readTaskCredentialToken('task-scout'),
        toolName: 'submit_result',
        payload: { summary: 'Scout completed.', workflowId },
      },
    );

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'gated-decide-result',
        runId: result.run.id,
        taskId: 'task-decide',
        token: readTaskCredentialToken('task-decide'),
        toolName: 'submit_result',
        payload: {
          metadata: {
            workflowActions: [{ id: 'followup', kind: 'append_worker', name: 'Followup' }],
          },
          summary: 'Decision wants a follow-up step.',
          workflowId,
        },
      },
    );

    const held = getCoordinatorRun(result.run.id)?.workflows[0];
    const approvalId = held?.pendingApprovals?.[0]?.id;
    if (approvalId === undefined) {
      throw new Error('Expected pending approval id');
    }
    expect(held?.pendingApprovals).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(held?.lanes.find((lane) => lane.taskId === 'task-decide')).toMatchObject({
      status: 'waiting-for-result',
    });
    expect(held?.lanes.find((lane) => lane.taskId === 'task-decide')?.resultId).toBeUndefined();
    expect(held?.stages.map((stage) => stage.id)).toEqual(['scout', 'decide']);
    expect(held?.journal.some((entry) => entry.kind === 'decision-approval-requested')).toBe(true);

    await expect(
      executeCoordinatorToolCall(
        { context, taskNames: createTaskRegistry() },
        {
          callId: 'gated-decide-second-result',
          runId: result.run.id,
          taskId: 'task-decide',
          token: readTaskCredentialToken('task-decide'),
          toolName: 'submit_result',
          payload: { summary: 'Second decision result.', workflowId },
        },
      ),
    ).rejects.toThrow('workflow lane already has a result pending approval');
    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          requestId: 'approve-no-lease',
          runId: result.run.id,
          toolName: 'approve_workflow_actions',
          payload: { approvalId, workflowId },
        },
      ),
    ).rejects.toThrow('Coordinator task command lease is required');

    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'approve actions');
    const approveRequest = {
      controllerId: 'browser-client-1',
      coordinatorTaskId: 'task-coordinator',
      requestId: 'approve-actions',
      runId: result.run.id,
      toolName: 'approve_workflow_actions' as const,
      payload: { approvalId, workflowId },
    };
    const approved = await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      approveRequest,
    );
    expect(approved.accepted).toBe(true);

    const applied = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(applied?.pendingApprovals).toEqual([expect.objectContaining({ status: 'approved' })]);
    expect(applied?.stages.map((stage) => stage.id)).toEqual(['scout', 'decide', 'followup']);
    expect(applied?.lanes.find((lane) => lane.taskId === 'task-decide')).toMatchObject({
      status: 'completed',
    });
    expect(applied?.lanes.find((lane) => lane.taskId === 'task-follow')).toMatchObject({
      stageId: 'followup',
    });
    expect(applied?.stepAppends).toHaveLength(1);
    expect(applied?.journal.some((entry) => entry.kind === 'decision-approval-approved')).toBe(
      true,
    );

    const replayed = await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      approveRequest,
    );
    expect(replayed).toEqual(approved);
    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.stepAppends).toHaveLength(1);
  });

  it('discards gated decision actions through deny_workflow_actions with a journaled reason', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-scout', 'task-decide', 'task-report']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'deny-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          policy: { requireDecisionApproval: true },
          problem: 'Decide with operator approval.',
          spec: {
            steps: [
              { id: 'scout', kind: 'worker', name: 'Scout' },
              {
                dependsOn: ['scout'],
                id: 'decide',
                kind: 'decision',
                name: 'Decide',
                sourceStepIds: ['scout'],
              },
              { dependsOn: ['decide'], id: 'report', kind: 'worker', name: 'Report' },
            ],
          },
          template: 'custom',
          title: 'Denied decision workflow',
        },
      },
    );
    const workflowId = getCoordinatorRun(result.run.id)?.workflows[0]?.id;
    if (workflowId === undefined) {
      throw new Error('Expected denied workflow id');
    }
    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'deny-scout-result',
        runId: result.run.id,
        taskId: 'task-scout',
        token: readTaskCredentialToken('task-scout'),
        toolName: 'submit_result',
        payload: { summary: 'Scout completed.', workflowId },
      },
    );
    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'deny-decide-result',
        runId: result.run.id,
        taskId: 'task-decide',
        token: readTaskCredentialToken('task-decide'),
        toolName: 'submit_result',
        payload: {
          metadata: {
            workflowActions: [{ kind: 'stop_workflow', reason: 'No more work needed.' }],
          },
          summary: 'Decision wants to stop early.',
          workflowId,
        },
      },
    );
    const approvalId = getCoordinatorRun(result.run.id)?.workflows[0]?.pendingApprovals?.[0]?.id;
    if (approvalId === undefined) {
      throw new Error('Expected pending approval id');
    }

    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          requestId: 'deny-no-lease',
          runId: result.run.id,
          toolName: 'deny_workflow_actions',
          payload: { approvalId, reason: 'Keep the planned report stage.', workflowId },
        },
      ),
    ).rejects.toThrow('Coordinator task command lease is required');

    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'deny actions');
    const denied = await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      {
        controllerId: 'browser-client-1',
        coordinatorTaskId: 'task-coordinator',
        requestId: 'deny-actions',
        runId: result.run.id,
        toolName: 'deny_workflow_actions',
        payload: { approvalId, reason: 'Keep the planned report stage.', workflowId },
      },
    );
    expect(denied.accepted).toBe(true);

    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    expect(workflow?.pendingApprovals).toEqual([
      expect.objectContaining({
        reason: 'Keep the planned report stage.',
        status: 'denied',
      }),
    ]);
    expect(workflow?.lanes.find((lane) => lane.taskId === 'task-decide')).toMatchObject({
      status: 'completed',
    });
    expect(workflow?.lanes.find((lane) => lane.taskId === 'task-report')).toMatchObject({
      stageId: 'report',
    });
    expect(workflow?.status).not.toBe('completed');
    expect(workflow?.expansions).toBeUndefined();
    expect(
      workflow?.journal.some(
        (entry) =>
          entry.kind === 'decision-approval-denied' &&
          entry.message.includes('Keep the planned report stage.'),
      ),
    ).toBe(true);
  });

  it('retries failed lanes through the lease-gated retry_lane operator action', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-a', 'task-b', 'task-a-retry']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'retry-start',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          policy: { retryCount: 0 },
          problem: 'Scan both halves.',
          spec: {
            steps: [
              {
                id: 'scan',
                kind: 'fanout',
                lanes: [
                  { assignment: 'Scan the backend.', id: 'lane-a', name: 'Backend' },
                  { assignment: 'Scan the frontend.', id: 'lane-b', name: 'Frontend' },
                ],
                name: 'Scan',
              },
            ],
          },
          template: 'custom',
          title: 'Manual retry workflow',
        },
      },
    );
    const workflow = getCoordinatorRun(result.run.id)?.workflows[0];
    const failedLane = workflow?.lanes.find((lane) => lane.taskId === 'task-a');
    if (!workflow || !failedLane) {
      throw new Error('Expected backend lane');
    }
    coordinatorRuntime.updateCoordinatorWorkflowLane(result.run.id, workflow.id, failedLane.id, {
      completedAt: Date.now(),
      failure: 'agent crashed',
      status: 'failed',
    });

    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          requestId: 'retry-no-lease',
          runId: result.run.id,
          toolName: 'retry_lane',
          payload: { laneId: failedLane.id, workflowId: workflow.id },
        },
      ),
    ).rejects.toThrow('Coordinator task command lease is required');

    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'retry the lane');
    const retried = await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      {
        controllerId: 'browser-client-1',
        coordinatorTaskId: 'task-coordinator',
        requestId: 'retry-lane',
        runId: result.run.id,
        toolName: 'retry_lane',
        payload: { laneId: failedLane.id, workflowId: workflow.id },
      },
    );
    expect(retried.accepted).toBe(true);

    const updated = getCoordinatorRun(result.run.id)?.workflows[0];
    const retryLane = updated?.lanes.find(
      (lane) => lane.dedupeKey === `${failedLane.dedupeKey ?? failedLane.id}:retry:2`,
    );
    expect(retryLane).toMatchObject({
      attempt: 2,
      spawnedBy: 'operator',
      taskId: 'task-a-retry',
    });
    expect(updated?.journal.some((entry) => entry.kind === 'lane-manual-retry')).toBe(true);
    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          requestId: 'retry-lane-again',
          runId: result.run.id,
          toolName: 'retry_lane',
          payload: { laneId: failedLane.id, workflowId: workflow.id },
        },
      ),
    ).rejects.toThrow('Lane retry was already scheduled');
  });

  it('resumes readiness-gated workflow lanes without materializing the full run', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskSequence(['task-worker']);
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'workflow-before-restore',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'start_workflow',
        payload: {
          agent: { command: 'custom-agent' },
          lanes: [{ assignment: 'Inspect the worker path.', name: 'Worker', role: 'map' }],
          problem: 'Verify workflow resume reads.',
          template: 'map_reduce',
          title: 'Resume read boundary',
        },
      },
    );

    restartCoordinatorRuntime();
    expect(getCoordinatorRun(result.run.id)?.workflows[0]?.lanes[0]).toMatchObject({
      status: 'stale-after-restore',
      taskId: 'task-worker',
    });
    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'resume the run');

    const fullRunRead = vi.spyOn(coordinatorRuntime, 'getCoordinatorRun');
    try {
      const response = await executeCoordinatorRendererAction(
        { context, taskNames: createTaskRegistry() },
        {
          controllerId: 'browser-client-1',
          coordinatorTaskId: 'task-coordinator',
          requestId: 'resume-workflow-lane',
          runId: result.run.id,
          toolName: 'resume_run',
        },
      );

      expect(response.result).toMatchObject({ failed: [], respawned: ['task-worker'] });
      expect(fullRunRead).not.toHaveBeenCalled();
    } finally {
      fullRunRead.mockRestore();
    }

    expect(getCoordinatorRun(result.run.id)?.promptQueue).toEqual([
      expect.objectContaining({ status: 'write-unknown-after-restore' }),
      expect.objectContaining({
        dedupeKey: 'resume:resume-workflow-lane:task-worker:initial',
        status: 'waiting-for-agent-session',
      }),
    ]);
  });

  it('respawns interrupted seeded subtasks with rotated credentials and rebuilt launch args', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-seeded-codex',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: {
            args: ['--model', 'gpt-5.5'],
            command: 'codex',
            env: { CODEX_FLAG: '1' },
          },
          assignment: 'Review the coordinator startup path.',
          name: 'Codex child',
        },
      },
    );
    const oldChildToken = readTaskCredentialToken('task-child');
    const originalSpawn = mocks.spawnTaskAgentWorkflowMock.mock.calls[0]?.[1] as {
      agentId: string;
      env: Record<string, string>;
    };

    restartCoordinatorRuntime();
    expect(getCoordinatorRun(result.run.id)).toMatchObject({ status: 'stale-after-restore' });
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]).toMatchObject({
      interruptedByRestoreAt: expect.any(Number),
      status: 'exited',
    });

    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'resume the run');
    const taskNames = createTaskRegistry();
    const resumeRequest = {
      controllerId: 'browser-client-1',
      coordinatorTaskId: 'task-coordinator',
      requestId: 'resume-1',
      runId: result.run.id,
      toolName: 'resume_run' as const,
    };
    const response = await executeCoordinatorRendererAction({ context, taskNames }, resumeRequest);

    expect(response.result).toMatchObject({
      failed: [],
      respawned: ['task-child'],
      resumeId: 'resume-1',
      run: expect.objectContaining({
        resumes: [
          expect.objectContaining({
            failedTaskIds: [],
            respawnedTaskIds: ['task-child'],
            resumeId: 'resume-1',
          }),
        ],
        status: 'running',
      }),
    });
    expect(taskNames.registerCreatedTask).toHaveBeenCalledWith(
      'task-child',
      expect.objectContaining({
        agentDefName: 'codex',
        taskName: 'Codex child',
        worktreePath: '/repo/task-child',
      }),
    );
    expect(mocks.spawnTaskAgentWorkflowMock).toHaveBeenCalledTimes(2);
    const respawn = mocks.spawnTaskAgentWorkflowMock.mock.calls[1]?.[1] as {
      agentId: string;
      args: string[];
      command: string;
      cwd: string;
      env: Record<string, string>;
      replaceExistingSession: boolean;
      taskId: string;
    };
    expect(respawn).toMatchObject({
      agentId: originalSpawn.agentId,
      command: 'codex',
      cwd: '/repo/task-child',
      replaceExistingSession: true,
      taskId: 'task-child',
    });
    expect(respawn.args).toEqual([
      '--model',
      'gpt-5.5',
      expect.stringContaining('Review the coordinator startup path.'),
    ]);
    expect(respawn.env).toMatchObject({
      CODEX_FLAG: '1',
      PARALLEL_CODE_COORDINATOR_RUN_ID: result.run.id,
    });
    expect(respawn.env.PARALLEL_CODE_COORDINATOR_CREDENTIAL).not.toBe(
      originalSpawn.env.PARALLEL_CODE_COORDINATOR_CREDENTIAL,
    );

    expect(resolveCoordinatorToken(oldChildToken)).toBeNull();
    const newChildToken = readTaskCredentialToken('task-child');
    expect(newChildToken).not.toBe(oldChildToken);
    expect(resolveCoordinatorToken(newChildToken)).toMatchObject({
      agentId: originalSpawn.agentId,
      taskId: 'task-child',
    });
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]).toMatchObject({
      status: 'running',
      toolTokenId: resolveCoordinatorToken(newChildToken)?.tokenId,
    });
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]?.result).toBeUndefined();
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]?.interruptedByRestoreAt).toBeUndefined();

    const replayed = await executeCoordinatorRendererAction({ context, taskNames }, resumeRequest);
    expect(replayed).toEqual(response);
    expect(mocks.spawnTaskAgentWorkflowMock).toHaveBeenCalledTimes(2);

    await expect(
      executeCoordinatorRendererAction(
        { context, taskNames },
        { ...resumeRequest, requestId: 'resume-2' },
      ),
    ).rejects.toThrow('Coordinator run is running');

    resetTaskCommandLeasesForTest();
    await expect(
      executeCoordinatorRendererAction({ context, taskNames }, resumeRequest),
    ).rejects.toThrow('Coordinator task command lease is required');
    expect(mocks.spawnTaskAgentWorkflowMock).toHaveBeenCalledTimes(2);
  });

  it('revokes a replacement credential without changing task registration when respawn launch fails', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-before-failed-resume',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: { command: 'codex' },
          assignment: 'Review the coordinator startup path.',
          name: 'Codex child',
        },
      },
    );
    const originalSpawn = mocks.spawnTaskAgentWorkflowMock.mock.calls[0]?.[1] as {
      agentId: string;
    };
    const oldChildToken = readTaskCredentialToken('task-child');

    restartCoordinatorRuntime();
    mocks.spawnTaskAgentWorkflowMock.mockImplementationOnce(() => {
      throw new Error('respawn launch failed');
    });
    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'resume the run');
    const taskNames = createTaskRegistry();

    const response = await executeCoordinatorRendererAction(
      { context, taskNames },
      {
        controllerId: 'browser-client-1',
        coordinatorTaskId: 'task-coordinator',
        requestId: 'resume-launch-failure',
        runId: result.run.id,
        toolName: 'resume_run',
      },
    );

    expect(response.result).toMatchObject({
      failed: [
        {
          reason: 'respawn launch failed',
          taskId: 'task-child',
        },
      ],
      respawned: [],
    });
    expect(taskNames.registerCreatedTask).not.toHaveBeenCalled();
    expect(mocks.killAgentAndWaitForRunnerCleanupMock).toHaveBeenCalledOnce();
    expect(mocks.killAgentAndWaitForRunnerCleanupMock).toHaveBeenCalledWith(originalSpawn.agentId);
    expect(getCoordinatorTaskCredentialPath('task-child')).toBeNull();
    expect(resolveCoordinatorToken(oldChildToken)).toBeNull();
  });

  it('revokes credentials and cleans the spawned session when respawn prompt setup fails', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-before-prompt-setup-failure',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: { command: 'custom-agent' },
          assignment: 'Build the slice.',
          name: 'Custom child',
        },
      },
    );
    const originalSpawn = mocks.spawnTaskAgentWorkflowMock.mock.calls[0]?.[1] as {
      agentId: string;
    };
    const oldChildToken = readTaskCredentialToken('task-child');

    restartCoordinatorRuntime();
    const staleRun = getCoordinatorRun(result.run.id);
    if (!staleRun) {
      throw new Error('Expected restored coordinator run');
    }
    for (let index = 0; index < staleRun.limits.maxPendingPromptsPerTarget; index += 1) {
      coordinatorRuntime.enqueueCoordinatorPrompt({
        dedupeKey: `saturate-resume-prompts:${index}`,
        kind: 'follow-up',
        runId: staleRun.id,
        sourceTaskId: staleRun.coordinatorTaskId,
        targetAgentId: originalSpawn.agentId,
        targetTaskId: 'task-child',
        text: `Pending prompt ${index}`,
      });
    }
    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'resume the run');
    const taskNames = createTaskRegistry();

    const response = await executeCoordinatorRendererAction(
      { context, taskNames },
      {
        controllerId: 'browser-client-1',
        coordinatorTaskId: 'task-coordinator',
        requestId: 'resume-prompt-setup-failure',
        runId: result.run.id,
        toolName: 'resume_run',
      },
    );

    expect(response.result).toMatchObject({
      failed: [
        {
          reason: 'Coordinator prompt limit reached for target task',
          taskId: 'task-child',
        },
      ],
      respawned: [],
    });
    expect(mocks.killAgentAndWaitForRunnerCleanupMock).toHaveBeenCalledOnce();
    expect(mocks.killAgentAndWaitForRunnerCleanupMock).toHaveBeenCalledWith(originalSpawn.agentId);
    expect(taskNames.registerCreatedTask).not.toHaveBeenCalled();
    expect(getCoordinatorTaskCredentialPath('task-child')).toBeNull();
    expect(resolveCoordinatorToken(oldChildToken)).toBeNull();
  });

  it('isolates a workflow resume failure, records the resume outcome, and keeps the replay result', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-seeded-codex',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: { command: 'codex' },
          assignment: 'Review the coordinator startup path.',
          name: 'Codex child',
        },
      },
    );
    const workflow = coordinatorRuntime.createCoordinatorWorkflow({
      runId: result.run.id,
      stages: [{ id: 'worker', kind: 'worker', name: 'Worker' }],
      template: 'custom',
      title: 'Stale workflow',
    });

    restartCoordinatorRuntime();
    expect(getCoordinatorRun(result.run.id)?.workflows[0]).toMatchObject({
      status: 'stale-after-restore',
    });
    // The stale workflow status changes between the resume snapshot and the workflow
    // loop; the per-workflow failure must stay isolated instead of stranding the run.
    mocks.spawnTaskAgentWorkflowMock.mockImplementation(() => {
      coordinatorRuntime.updateCoordinatorWorkflow(result.run.id, workflow.id, {
        status: 'cancelled',
      });
      return false;
    });
    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'resume the run');
    const taskNames = createTaskRegistry();
    const resumeRequest = {
      controllerId: 'browser-client-1',
      coordinatorTaskId: 'task-coordinator',
      requestId: 'resume-workflow-failure',
      runId: result.run.id,
      toolName: 'resume_run' as const,
    };

    const response = await executeCoordinatorRendererAction({ context, taskNames }, resumeRequest);

    expect(response.result).toMatchObject({
      failed: [
        expect.objectContaining({
          reason: expect.stringContaining(
            `Coordinator workflow ${workflow.id} resume failed: Coordinator workflow is cancelled`,
          ),
        }),
      ],
      respawned: ['task-child'],
    });
    expect(getCoordinatorRun(result.run.id)).toMatchObject({
      resumes: [
        expect.objectContaining({
          respawnedTaskIds: ['task-child'],
          resumeId: 'resume-workflow-failure',
        }),
      ],
      status: 'running',
    });

    const replayed = await executeCoordinatorRendererAction({ context, taskNames }, resumeRequest);
    expect(replayed).toEqual(response);
  });

  it('re-establishes undelivered initial assignments once without redelivering write-unknown prompts', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-readiness-gated',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: { command: 'custom-agent' },
          assignment: 'Build the slice',
          name: 'Child Task',
        },
      },
    );
    const subtask = getCoordinatorRun(result.run.id)?.subtasks[0];
    if (!subtask) {
      throw new Error('Missing spawned subtask fixture');
    }

    restartCoordinatorRuntime();
    expect(getCoordinatorRun(result.run.id)?.promptQueue[0]).toMatchObject({
      kind: 'initial-assignment',
      status: 'write-unknown-after-restore',
    });

    mocks.hasAgentSessionMock.mockReturnValue(true);
    mocks.getAgentMetaMock.mockImplementation((agentId: string) => ({
      agentId,
      generation: 2,
      isShell: false,
      taskId: 'task-child',
    }));
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(
      createSupervisionSnapshot('idle-at-prompt', { agentId: subtask.agentId }),
    );
    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'resume the run');

    const response = await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      {
        controllerId: 'browser-client-1',
        coordinatorTaskId: 'task-coordinator',
        requestId: 'resume-prompted',
        runId: result.run.id,
        toolName: 'resume_run',
      },
    );

    expect(response.result).toMatchObject({ respawned: ['task-child'] });
    const prompts = getCoordinatorRun(result.run.id)?.promptQueue ?? [];
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatchObject({ status: 'write-unknown-after-restore' });
    expect(prompts[1]).toMatchObject({
      dedupeKey: 'resume:resume-prompted:task-child:initial',
      kind: 'initial-assignment',
      status: 'delivered',
    });
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]).toMatchObject({ status: 'running' });
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]?.result).toBeUndefined();
    const writtenPrompts = mocks.writeToAgentMock.mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('Build the slice'),
    );
    expect(writtenPrompts).toHaveLength(1);
  });

  it('replays delivered readiness-gated initial assignments after respawn because the old PTY is gone', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    const token = readCredentialToken(result.credentialPath);
    mockCreatedTaskResult();
    mocks.hasAgentSessionMock.mockReturnValue(true);
    mocks.getAgentMetaMock.mockImplementation((agentId: string) => ({
      agentId,
      generation: 1,
      isShell: false,
      taskId: 'task-child',
    }));
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(
      createSupervisionSnapshot('idle-at-prompt', { agentId: 'agent-child' }),
    );

    await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'spawn-readiness-gated-delivered',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'spawn_subtask',
        payload: {
          agent: { command: 'custom-agent' },
          assignment: 'Rebuild the dead PTY context.',
          name: 'Child Task',
        },
      },
    );
    expect(getCoordinatorRun(result.run.id)?.promptQueue[0]).toMatchObject({
      kind: 'initial-assignment',
      status: 'delivered',
    });

    restartCoordinatorRuntime();
    expect(getCoordinatorRun(result.run.id)?.promptQueue[0]).toMatchObject({
      kind: 'initial-assignment',
      status: 'delivered',
    });

    mocks.getAgentMetaMock.mockImplementation((agentId: string) => ({
      agentId,
      generation: 2,
      isShell: false,
      taskId: 'task-child',
    }));
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(
      createSupervisionSnapshot('idle-at-prompt', { agentId: 'agent-child' }),
    );
    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'resume the run');

    const response = await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      {
        controllerId: 'browser-client-1',
        coordinatorTaskId: 'task-coordinator',
        requestId: 'resume-redelivered-initial',
        runId: result.run.id,
        toolName: 'resume_run',
      },
    );

    expect(response.result).toMatchObject({ respawned: ['task-child'] });
    const prompts = getCoordinatorRun(result.run.id)?.promptQueue ?? [];
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatchObject({ status: 'delivered' });
    expect(prompts[1]).toMatchObject({
      dedupeKey: 'resume:resume-redelivered-initial:task-child:initial',
      kind: 'initial-assignment',
      status: 'delivered',
    });
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]).toMatchObject({ status: 'running' });
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]?.interruptedByRestoreAt).toBeUndefined();
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]?.result).toBeUndefined();
    const writtenPrompts = mocks.writeToAgentMock.mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('Rebuild the dead PTY context.'),
    );
    expect(writtenPrompts).toHaveLength(2);
  });

  it('marks interrupted subtasks failed when no launch payload is recorded', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const result = createCoordinatorRunForTask(context, {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    addCoordinatorSubtask({
      agentId: 'agent-legacy',
      assignment: 'Legacy work without a launch payload',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-legacy',
      toolTokenId: 'token-legacy',
      worktreePath: '/repo/task-legacy',
    });

    restartCoordinatorRuntime();
    acquireTaskCommandLease('task-coordinator', 'browser-client-1', 'user', 'resume the run');

    const response = await executeCoordinatorRendererAction(
      { context, taskNames: createTaskRegistry() },
      {
        controllerId: 'browser-client-1',
        coordinatorTaskId: 'task-coordinator',
        requestId: 'resume-legacy',
        runId: result.run.id,
        toolName: 'resume_run',
      },
    );

    expect(response.result).toMatchObject({
      failed: [
        expect.objectContaining({
          reason: expect.stringContaining('no recorded launch payload'),
          taskId: 'task-legacy',
        }),
      ],
      respawned: [],
    });
    expect(mocks.spawnTaskAgentWorkflowMock).not.toHaveBeenCalled();
    expect(getCoordinatorRun(result.run.id)).toMatchObject({ status: 'running' });
    expect(getCoordinatorRun(result.run.id)?.subtasks[0]).toMatchObject({
      result: expect.stringContaining('no recorded launch payload'),
      status: 'failed',
    });
  });
});
