import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskNameRegistry } from '../../server/task-names.js';
import { COORDINATOR_LIMITS, type CoordinatorSubtaskStatus } from '../../src/domain/coordinator.js';
import type { AgentSupervisionSnapshot } from '../../src/domain/server-state.js';
import type { HandlerContext } from '../ipc/handler-context.js';
import type { StorageEnv } from '../ipc/storage.js';

const mocks = vi.hoisted(() => {
  const supervisionListeners = new Set<(event: unknown) => void>();
  return {
    cleanupTaskRuntimeWorkflowMock: vi.fn(() => ({ releasedTaskCommandController: null })),
    createTaskWorkflowMock: vi.fn(),
    deleteTaskWorkflowMock: vi.fn(() =>
      Promise.resolve({ cleanupWarnings: [], releasedTaskCommandController: null }),
    ),
    getAgentMetaMock: vi.fn(),
    getAgentSupervisionSnapshotMock: vi.fn(),
    getWorktreeStatusMock: vi.fn(),
    hasAgentSessionMock: vi.fn(),
    mergeTaskMock: vi.fn(),
    normalizeAgentRunnerProfileConfigMock: vi.fn(() => undefined),
    spawnTaskAgentWorkflowMock: vi.fn(() => false),
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
  getWorktreeStatus: mocks.getWorktreeStatusMock,
  mergeTask: mocks.mergeTaskMock,
}));

vi.mock('../ipc/pty.js', () => ({
  getAgentMeta: mocks.getAgentMetaMock,
  hasAgentSession: mocks.hasAgentSessionMock,
  writeToAgent: mocks.writeToAgentMock,
}));

vi.mock('../ipc/task-workflows.js', () => ({
  cleanupTaskRuntimeWorkflow: mocks.cleanupTaskRuntimeWorkflowMock,
  createTaskWorkflow: mocks.createTaskWorkflowMock,
  deleteTaskWorkflow: mocks.deleteTaskWorkflowMock,
  spawnTaskAgentWorkflow: mocks.spawnTaskAgentWorkflowMock,
}));

import {
  acquireTaskCommandLease,
  resetTaskCommandLeasesForTest,
} from '../ipc/task-command-leases.js';
import {
  addCoordinatorSubtask,
  getCoordinatorRun,
  resetCoordinatorRuntimeForTests,
} from './runtime.js';
import {
  cleanupCoordinatorStateForTask,
  createCoordinatorCredential,
  createCoordinatorRunForTask,
  resetCoordinatorServiceForTests,
  resolveCoordinatorToken,
} from './service.js';
import {
  cleanupCoordinatorTaskStateAndOwnedSubtasks,
  executeCoordinatorToolCall,
  resetCoordinatorToolGatewayForTests,
  startCoordinatorPromptDeliveryRuntime,
} from './tool-gateway.js';

function createStorageEnv(): StorageEnv {
  return {
    isPackaged: false,
    coordinatorToolCallUrl: 'http://127.0.0.1:43117/api/coordinator/tool-call',
    userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-coordinator-gateway-')),
  } as StorageEnv & { coordinatorToolCallUrl: string };
}

function removeStorageEnv(env: StorageEnv): void {
  fs.rmSync(env.userDataPath, { force: true, recursive: true });
  fs.rmSync(`${env.userDataPath}-dev`, { force: true, recursive: true });
}

function readCredentialToken(credentialPath: string): string {
  return (JSON.parse(fs.readFileSync(credentialPath, 'utf8')) as { token: string }).token;
}

function createContext(env: StorageEnv): HandlerContext {
  return {
    ...env,
    emitIpcEvent: vi.fn(),
    sendToChannel: vi.fn(),
  };
}

function createTaskRegistry(): Pick<TaskNameRegistry, 'deleteTask' | 'registerCreatedTask'> {
  return {
    deleteTask: vi.fn(),
    registerCreatedTask: vi.fn(),
  };
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

function createSupervisionSnapshot(
  state: AgentSupervisionSnapshot['state'],
): AgentSupervisionSnapshot {
  return {
    agentId: 'agent-child',
    attentionReason: state === 'idle-at-prompt' ? 'ready-for-next-step' : null,
    isShell: false,
    lastOutputAt: 1_000,
    preview: '',
    state,
    taskId: 'task-child',
    updatedAt: 1_000,
  };
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

describe('coordinator tool gateway', () => {
  const envs: StorageEnv[] = [];

  beforeEach(() => {
    mocks.cleanupTaskRuntimeWorkflowMock.mockReturnValue({ releasedTaskCommandController: null });
    mocks.deleteTaskWorkflowMock.mockResolvedValue({
      cleanupWarnings: [],
      releasedTaskCommandController: null,
    });
    mocks.normalizeAgentRunnerProfileConfigMock.mockReturnValue(undefined);
    mocks.spawnTaskAgentWorkflowMock.mockReturnValue(false);
  });

  afterEach(() => {
    resetCoordinatorToolGatewayForTests();
    resetCoordinatorServiceForTests();
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

  it('deduplicates and bounds pending coordinator prompts per target', async () => {
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
    mocks.hasAgentSessionMock.mockReturnValue(false);

    const first = await executeCoordinatorToolCall(
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
          dedupeKey: 'stable-prompt',
          targetTaskId: 'task-child',
          text: 'Continue now',
        },
      },
    );
    const second = await executeCoordinatorToolCall(
      {
        context,
        taskNames: createTaskRegistry(),
      },
      {
        callId: 'call-2',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          dedupeKey: 'stable-prompt',
          targetTaskId: 'task-child',
          text: 'Continue now',
        },
      },
    );

    expect(second.result).toEqual(first.result);
    for (let index = 0; index < result.run.limits.maxPendingPromptsPerTarget - 1; index += 1) {
      await executeCoordinatorToolCall(
        {
          context,
          taskNames: createTaskRegistry(),
        },
        {
          callId: `call-extra-${index}`,
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'send_prompt',
          payload: {
            targetTaskId: 'task-child',
            text: `Prompt ${index}`,
          },
        },
      );
    }

    await expect(
      executeCoordinatorToolCall(
        {
          context,
          taskNames: createTaskRegistry(),
        },
        {
          callId: 'call-over-limit',
          runId: result.run.id,
          taskId: 'task-coordinator',
          token,
          toolName: 'send_prompt',
          payload: {
            targetTaskId: 'task-child',
            text: 'One too many',
          },
        },
      ),
    ).rejects.toThrow('Coordinator prompt limit reached for target task');
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
    expect(mocks.spawnTaskAgentWorkflowMock).toHaveBeenCalledWith(
      context,
      expect.not.objectContaining({ onOutput: expect.anything() }),
    );
    expect(mocks.spawnTaskAgentWorkflowMock).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        agentId: expect.any(String),
        command: 'custom-agent',
        env: expect.objectContaining({
          CUSTOM_FLAG: '1',
          PARALLEL_CODE_COORDINATOR_CREDENTIAL: expect.any(String),
        }),
        taskId: 'task-child',
      }),
    );
    expect(response.result).toMatchObject({
      status: 'waiting-for-agent-ready',
      taskId: 'task-child',
    });
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
    const childTokenId = getCoordinatorRun(result.run.id)?.subtasks[0]?.toolTokenId;
    expect(childTokenId).toEqual(expect.any(String));
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
    );
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentIds: ['agent-child'],
        branchName: 'feature/child',
        deleteBranch: true,
        taskId: 'task-child',
      }),
    );
    expect(taskNames.deleteTask).toHaveBeenCalledWith('task-child');
    expect(resolveCoordinatorToken(childCredential.token)).toBeNull();
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
});
