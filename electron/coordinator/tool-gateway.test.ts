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
    getAgentScrollbackBufferMock: vi.fn(),
    getAgentSupervisionSnapshotMock: vi.fn(),
    getAllFileDiffsMock: vi.fn(),
    getProjectDiffMock: vi.fn(),
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
  getAllFileDiffs: mocks.getAllFileDiffsMock,
  getProjectDiff: mocks.getProjectDiffMock,
  getWorktreeStatus: mocks.getWorktreeStatusMock,
  mergeTask: mocks.mergeTaskMock,
}));

vi.mock('../ipc/pty.js', () => ({
  getAgentMeta: mocks.getAgentMetaMock,
  getAgentScrollbackBuffer: mocks.getAgentScrollbackBufferMock,
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
  updateCoordinatorSubtaskStatus,
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
  overrides: Partial<Pick<AgentSupervisionSnapshot, 'agentId' | 'taskId'>> = {},
): AgentSupervisionSnapshot {
  const agentId = overrides.agentId ?? 'agent-child';
  const taskId = overrides.taskId ?? 'task-child';
  return {
    agentId,
    attentionReason: state === 'idle-at-prompt' ? 'ready-for-next-step' : null,
    isShell: false,
    lastOutputAt: 1_000,
    preview: '',
    state,
    taskId,
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
    mocks.getAgentScrollbackBufferMock.mockReturnValue(Buffer.from(''));
    mocks.getAllFileDiffsMock.mockResolvedValue('');
    mocks.getProjectDiffMock.mockResolvedValue({
      files: [],
      totalAdded: 0,
      totalRemoved: 0,
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

  it('serializes concurrent prompt writes to the same target terminal', async () => {
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
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(
      createSupervisionSnapshot('idle-at-prompt'),
    );

    const first = executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-child',
          text: 'First line\nSecond line',
        },
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.writeToAgentMock).toHaveBeenCalledTimes(1);

    const second = executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-2',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-child',
          text: 'Follow up',
        },
      },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.writeToAgentMock).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);

    expect(mocks.writeToAgentMock.mock.calls.map((call) => call[1])).toEqual([
      '\x1B[200~First line\nSecond line\x1B[201~',
      '\r',
      'Follow up\r',
    ]);
  });

  it('does not spend prompt delivery capacity while a prompt waits behind the same target', async () => {
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
      agentId: 'agent-sibling',
      assignment: 'Do sibling work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId: result.run.id,
      status: 'running',
      taskId: 'task-sibling',
      toolTokenId: 'token-sibling',
      worktreePath: '/repo/task-sibling',
    });
    mocks.hasAgentSessionMock.mockReturnValue(true);
    mocks.getAgentMetaMock.mockImplementation((agentId: string) => ({
      agentId,
      generation: 1,
      isShell: false,
      taskId: agentId === 'agent-sibling' ? 'task-sibling' : 'task-child',
    }));
    mocks.getAgentSupervisionSnapshotMock.mockImplementation((agentId: string) =>
      createSupervisionSnapshot('idle-at-prompt', {
        agentId,
        taskId: agentId === 'agent-sibling' ? 'task-sibling' : 'task-child',
      }),
    );

    const first = executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-child',
          text: 'First line\nSecond line',
        },
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.writeToAgentMock).toHaveBeenCalledTimes(1);

    const sameTarget = executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-2',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-child',
          text: 'Follow up',
        },
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.writeToAgentMock).toHaveBeenCalledTimes(1);

    const sibling = executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-3',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-sibling',
          text: 'Sibling prompt',
        },
      },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.writeToAgentMock.mock.calls.map((call) => call[1])).toEqual([
      '\x1B[200~First line\nSecond line\x1B[201~',
      'Sibling prompt\r',
    ]);

    await vi.runAllTimersAsync();
    await Promise.all([first, sameTarget, sibling]);

    expect(mocks.writeToAgentMock.mock.calls.map((call) => call[1])).toEqual([
      '\x1B[200~First line\nSecond line\x1B[201~',
      'Sibling prompt\r',
      '\r',
      'Follow up\r',
    ]);
  });

  it('applies prompt delivery admission caps to direct multi-target sends', async () => {
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
    for (let index = 0; index < 3; index += 1) {
      addCoordinatorSubtask({
        agentId: `agent-child-${index}`,
        assignment: `Do the work ${index}`,
        parentCoordinatorTaskId: 'task-coordinator',
        runId: result.run.id,
        status: 'running',
        taskId: `task-child-${index}`,
        toolTokenId: `token-child-${index}`,
        worktreePath: `/repo/task-child-${index}`,
      });
    }
    mocks.hasAgentSessionMock.mockReturnValue(true);
    mocks.getAgentMetaMock.mockImplementation((agentId: string) => ({
      agentId,
      generation: 1,
      isShell: false,
      taskId: agentId.replace('agent-', 'task-'),
    }));
    mocks.getAgentSupervisionSnapshotMock.mockImplementation((agentId: string) =>
      createSupervisionSnapshot('idle-at-prompt', {
        agentId,
        taskId: agentId.replace('agent-', 'task-'),
      }),
    );
    startCoordinatorPromptDeliveryRuntime(context);

    const first = executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-child-0',
          text: 'First line\nSecond line',
        },
      },
    );
    const second = executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-2',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-child-1',
          text: 'First line\nSecond line',
        },
      },
    );
    await Promise.resolve();
    await Promise.resolve();

    const third = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-3',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-child-2',
          text: 'Third prompt',
        },
      },
    );

    expect(third.result).toMatchObject({
      status: 'queued',
      targetTaskId: 'task-child-2',
    });
    expect(mocks.writeToAgentMock).toHaveBeenCalledTimes(
      COORDINATOR_LIMITS.maxConcurrentPromptDeliveriesPerRun,
    );

    await vi.runAllTimersAsync();
    await Promise.all([first, second]);

    expect(mocks.writeToAgentMock.mock.calls.map((call) => call[1])).toContain('Third prompt\r');
  });

  it('does not overwrite prompt cancellation after an in-flight write finishes', async () => {
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
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(
      createSupervisionSnapshot('idle-at-prompt'),
    );

    const delivery = executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-1',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-child',
          text: 'First line\nSecond line',
        },
      },
    );
    await Promise.resolve();

    cleanupCoordinatorStateForTask(context, 'task-child');
    await vi.runAllTimersAsync();
    await delivery;

    expect(getCoordinatorRun(result.run.id)?.promptQueue[0]).toMatchObject({
      status: 'cancelled',
      waitingReason: 'task-cleaned-up',
    });
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
    expect(mocks.spawnTaskAgentWorkflowMock).toHaveBeenCalledWith(
      context,
      expect.not.objectContaining({ onOutput: expect.anything() }),
    );
    expect(mocks.spawnTaskAgentWorkflowMock).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        agentId: expect.any(String),
        args: ['--model', 'fast', '--unsafe'],
        command: 'custom-agent',
        env: expect.objectContaining({
          CUSTOM_FLAG: '1',
          PARALLEL_CODE_COORDINATOR_CREDENTIAL: expect.any(String),
          PARALLEL_CODE_COORDINATOR_RUN_ID: result.run.id,
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
