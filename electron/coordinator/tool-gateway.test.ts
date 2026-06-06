import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskNameRegistry } from '../../server/task-names.js';
import {
  COORDINATOR_LIMITS,
  type CoordinatorSubtaskStatus,
  type CoordinatorUiToolCallRequest,
} from '../../src/domain/coordinator.js';
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
  enqueueCoordinatorPrompt,
  getCoordinatorRun,
  resetCoordinatorRuntimeForTests,
  updateCoordinatorRunStatus,
  updateCoordinatorSubtaskStatus,
} from './runtime.js';
import * as coordinatorRuntime from './runtime.js';
import {
  cleanupCoordinatorStateForTask,
  createCoordinatorCredential,
  createCoordinatorRunForTask,
  getCoordinatorTaskCredentialPath,
  resetCoordinatorServiceForTests,
  resolveCoordinatorToken,
} from './service.js';
import {
  cleanupCoordinatorTaskStateAndOwnedSubtasks,
  executeCoordinatorRendererAction,
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

  it('applies prompt delivery admission caps during queued prompt sweeps', async () => {
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
    const multilinePrompt = 'First line\nSecond line';
    startCoordinatorPromptDeliveryRuntime(context);
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
      enqueueCoordinatorPrompt({
        kind: 'follow-up',
        runId: result.run.id,
        sourceTaskId: 'task-coordinator',
        targetAgentId: `agent-child-${index}`,
        targetTaskId: `task-child-${index}`,
        text: multilinePrompt,
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

    for (const listener of mocks.supervisionListeners) {
      listener({ kind: 'snapshot' });
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.writeToAgentMock).toHaveBeenCalledTimes(
      COORDINATOR_LIMITS.maxConcurrentPromptDeliveriesPerRun,
    );
    expect(getCoordinatorRun(result.run.id)?.promptQueue).toEqual([
      expect.objectContaining({ status: 'delivering', targetTaskId: 'task-child-0' }),
      expect.objectContaining({ status: 'delivering', targetTaskId: 'task-child-1' }),
      expect.objectContaining({ status: 'queued', targetTaskId: 'task-child-2' }),
    ]);

    await vi.runAllTimersAsync();

    expect(mocks.writeToAgentMock.mock.calls.map((call) => call[1])).toContain(
      '\x1B[200~First line\nSecond line\x1B[201~',
    );
    expect(getCoordinatorRun(result.run.id)?.promptQueue).toEqual([
      expect.objectContaining({ status: 'delivered', targetTaskId: 'task-child-0' }),
      expect.objectContaining({ status: 'delivered', targetTaskId: 'task-child-1' }),
      expect.objectContaining({ status: 'delivered', targetTaskId: 'task-child-2' }),
    ]);
  });

  it('blocks prompt delivery while the target agent is awaiting input', async () => {
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
      createSupervisionSnapshot('awaiting-input'),
    );

    const response = await executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-awaiting-input',
        runId: result.run.id,
        taskId: 'task-coordinator',
        token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: 'task-child',
          text: 'Please continue',
        },
      },
    );

    expect(response.result).toMatchObject({
      status: 'blocked-by-question',
      waitingReason: 'agent-awaiting-input',
    });
    expect(mocks.writeToAgentMock).not.toHaveBeenCalled();
  });

  it('fails prompt delivery when the task command lease is lost mid-write', async () => {
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
    let didStealLease = false;
    mocks.writeToAgentMock.mockImplementation(() => {
      if (didStealLease) {
        return;
      }
      didStealLease = true;
      acquireTaskCommandLease(
        'task-child',
        'intruder-client',
        'intruder-owner',
        'interrupt prompt delivery',
        true,
      );
    });

    const responsePromise = executeCoordinatorToolCall(
      { context, taskNames: createTaskRegistry() },
      {
        callId: 'call-lose-lease',
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
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.result).toMatchObject({
      status: 'failed',
      waitingReason: 'Task command lease was lost during prompt delivery',
    });
    expect(mocks.writeToAgentMock).toHaveBeenCalledTimes(1);
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
      sourceSpec: expect.objectContaining({ version: 1 }),
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
});
