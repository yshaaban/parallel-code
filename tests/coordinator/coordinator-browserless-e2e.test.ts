import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTaskCommandLeasesForTest } from '../../electron/ipc/task-command-leases.js';
import {
  resetCoordinatorRuntimeForTests,
  updateCoordinatorSubtaskStatus,
} from '../../electron/coordinator/runtime.js';
import {
  resetCoordinatorServiceForTests,
  resolveCoordinatorToken,
} from '../../electron/coordinator/service.js';
import { resetCoordinatorToolGatewayForTests } from '../../electron/coordinator/tool-gateway.js';
import { clearTaskPortRegistry } from '../../electron/ipc/task-ports.js';
import { IPC } from '../../electron/ipc/channels.js';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
} from '../../src/domain/task-prompt-materialization.js';
import type { AgentSupervisionSnapshot } from '../../src/domain/server-state.js';
import type {
  CoordinatorPromptRequestSnapshot,
  CoordinatorRunSnapshot,
  CoordinatorSubtaskSnapshot,
  CoordinatorToolCallResult,
} from '../../src/domain/coordinator.js';
import type { ServerStateBootstrapSnapshot } from '../../src/domain/server-state-bootstrap.js';
import {
  createCoordinatorBrowserlessHarness,
  isCoordinatorEventMessage,
  type CoordinatorBrowserlessHarness,
} from './coordinator-browserless-harness.js';

const SHORT_ASYNC_SETTLE_MS = 25;

const mocks = vi.hoisted(() => {
  const agentMetaById = new Map<
    string,
    {
      agentId: string;
      generation: number;
      isShell: boolean;
      taskId: string;
    }
  >();
  const agentSessionIds = new Set<string>();
  const scrollbackByAgentId = new Map<string, Buffer>();
  const supervisionByAgentId = new Map<string, AgentSupervisionSnapshot>();
  const supervisionListeners = new Set<(event: unknown) => void>();
  const writes: Array<{ agentId: string; data: string }> = [];

  return {
    agentMetaById,
    agentSessionIds,
    cleanupTaskRuntimeWorkflowMock: vi.fn(() => ({ releasedTaskCommandController: null })),
    createTaskWorkflowMock: vi.fn(),
    deleteTaskWorkflowMock: vi.fn(() =>
      Promise.resolve({ cleanupWarnings: [], releasedTaskCommandController: null }),
    ),
    getAgentMetaMock: vi.fn((agentId: string) => agentMetaById.get(agentId) ?? null),
    getAgentScrollbackBufferMock: vi.fn(
      (agentId: string) => scrollbackByAgentId.get(agentId) ?? Buffer.alloc(0),
    ),
    getAgentSupervisionSnapshotMock: vi.fn(
      (agentId: string) => supervisionByAgentId.get(agentId) ?? null,
    ),
    getAllFileDiffsMock: vi.fn(() => Promise.resolve('')),
    getProjectDiffMock: vi.fn(() =>
      Promise.resolve({
        files: [],
        totalAdded: 0,
        totalRemoved: 0,
      }),
    ),
    getWorktreeStatusMock: vi.fn(() => Promise.resolve({ has_uncommitted_changes: false })),
    hasAgentSessionMock: vi.fn((agentId: string) => agentSessionIds.has(agentId)),
    mergeTaskMock: vi.fn(() =>
      Promise.resolve({
        main_branch: 'main',
      }),
    ),
    normalizeAgentRunnerProfileConfigMock: vi.fn(() => undefined),
    scrollbackByAgentId,
    spawnTaskAgentWorkflowMock: vi.fn(
      (
        _context: unknown,
        options: {
          agentId: string;
          isShell: boolean;
          taskId: string;
        },
      ) => {
        agentSessionIds.add(options.agentId);
        agentMetaById.set(options.agentId, {
          agentId: options.agentId,
          generation: 1,
          isShell: options.isShell,
          taskId: options.taskId,
        });
        supervisionByAgentId.set(options.agentId, createSupervisionSnapshot(options));
        return false;
      },
    ),
    subscribeAgentSupervisionMock: vi.fn((listener: (event: unknown) => void) => {
      supervisionListeners.add(listener);
      return () => supervisionListeners.delete(listener);
    }),
    supervisionByAgentId,
    supervisionListeners,
    writeToAgentMock: vi.fn((agentId: string, data: string) => {
      writes.push({ agentId, data });
    }),
    writes,
  };
});

vi.mock('../../electron/ipc/agent-runner-handlers.js', () => ({
  normalizeAgentRunnerProfileConfig: mocks.normalizeAgentRunnerProfileConfigMock,
}));

vi.mock('../../electron/ipc/agent-supervision.js', async () => {
  const actual = await vi.importActual<typeof import('../../electron/ipc/agent-supervision.js')>(
    '../../electron/ipc/agent-supervision.js',
  );
  return {
    ...actual,
    getAgentSupervisionSnapshot: mocks.getAgentSupervisionSnapshotMock,
    subscribeAgentSupervision: mocks.subscribeAgentSupervisionMock,
  };
});

vi.mock('../../electron/ipc/git.js', async () => {
  const actual = await vi.importActual<typeof import('../../electron/ipc/git.js')>(
    '../../electron/ipc/git.js',
  );
  return {
    ...actual,
    getAllFileDiffs: mocks.getAllFileDiffsMock,
    getProjectDiff: mocks.getProjectDiffMock,
    getWorktreeStatus: mocks.getWorktreeStatusMock,
    mergeTask: mocks.mergeTaskMock,
  };
});

vi.mock('../../electron/ipc/pty.js', async () => {
  const actual = await vi.importActual<typeof import('../../electron/ipc/pty.js')>(
    '../../electron/ipc/pty.js',
  );
  return {
    ...actual,
    getAgentMeta: mocks.getAgentMetaMock,
    getAgentScrollbackBuffer: mocks.getAgentScrollbackBufferMock,
    hasAgentSession: mocks.hasAgentSessionMock,
    writeToAgent: mocks.writeToAgentMock,
  };
});

vi.mock('../../electron/ipc/task-workflows.js', async () => {
  const actual = await vi.importActual<typeof import('../../electron/ipc/task-workflows.js')>(
    '../../electron/ipc/task-workflows.js',
  );
  return {
    ...actual,
    cleanupTaskRuntimeWorkflow: mocks.cleanupTaskRuntimeWorkflowMock,
    createTaskWorkflow: mocks.createTaskWorkflowMock,
    deleteTaskWorkflow: mocks.deleteTaskWorkflowMock,
    spawnTaskAgentWorkflow: mocks.spawnTaskAgentWorkflowMock,
  };
});

interface SpawnedAgentOptions {
  agentId: string;
  args?: string[];
  command: string;
  cwd: string;
  env: Record<string, string>;
  projectMode?: 'git' | 'non-git';
  taskId: string;
}

interface MockCreateTaskWorkflowOptions {
  gitIsolation?: 'current-branch' | 'worktree';
  name: string;
  projectMode?: 'non-git';
  projectRoot: string;
}

interface SpawnCoordinatorSubtaskOverrides {
  args?: string[];
  assignment?: string;
  callId?: string;
  command?: string;
  dedupeKey?: string;
  env?: Record<string, string>;
  name?: string;
  skipPermissionsArgs?: string[];
}

interface SequencedRunUpsertedMessage {
  event: {
    eventType: 'run-upserted';
    payload: CoordinatorRunSnapshot;
    runId: string;
  };
  seq: number;
  type: 'coordinator-event';
}

interface SubtaskUpsertedMessage {
  event: {
    eventType: 'subtask-upserted';
    payload: CoordinatorSubtaskSnapshot;
    runId: string;
  };
  seq?: number;
  type: 'coordinator-event';
}

function createSupervisionSnapshot(options: {
  agentId: string;
  isShell: boolean;
  taskId: string;
}): AgentSupervisionSnapshot {
  return {
    agentId: options.agentId,
    attentionReason: 'ready-for-next-step',
    isShell: options.isShell,
    lastOutputAt: 1_000,
    preview: '',
    state: 'idle-at-prompt',
    taskId: options.taskId,
    updatedAt: 1_000,
  };
}

function getToolResult<T>(response: CoordinatorToolCallResult): T {
  return response.result as T;
}

function hasNumericSeq(message: { seq?: unknown }): message is { seq: number } {
  return typeof message.seq === 'number';
}

function getEventPayloadRecord(message: { event: { payload: unknown } }): Record<string, unknown> {
  if (typeof message.event.payload === 'object' && message.event.payload !== null) {
    return message.event.payload as Record<string, unknown>;
  }

  return {};
}

function isSequencedRunUpsertedMessage(message: unknown): message is SequencedRunUpsertedMessage {
  return (
    isCoordinatorEventMessage(message) &&
    message.event.eventType === 'run-upserted' &&
    hasNumericSeq(message)
  );
}

function isSubtaskUpsertedMessage(message: unknown): message is SubtaskUpsertedMessage {
  return isCoordinatorEventMessage(message) && message.event.eventType === 'subtask-upserted';
}

function isRunningSubtaskUpsertedMessage(message: unknown): message is SubtaskUpsertedMessage {
  return isSubtaskUpsertedMessage(message) && getEventPayloadRecord(message).status === 'running';
}

function createSequencedSubtaskUpsertedPredicate(
  taskId: string,
): (message: unknown) => message is SubtaskUpsertedMessage & { seq: number } {
  return function isSequencedSubtaskUpsertedMessage(
    message: unknown,
  ): message is SubtaskUpsertedMessage & { seq: number } {
    return (
      isSubtaskUpsertedMessage(message) &&
      getEventPayloadRecord(message).taskId === taskId &&
      hasNumericSeq(message)
    );
  };
}

function getSpawnedAgentOptions(index = 0): SpawnedAgentOptions {
  const call = mocks.spawnTaskAgentWorkflowMock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected spawned agent call at index ${index}`);
  }

  return call[1] as SpawnedAgentOptions;
}

function setAgentSupervision(
  agentId: string,
  state: AgentSupervisionSnapshot['state'],
  options: Partial<Pick<AgentSupervisionSnapshot, 'taskId'>> = {},
): void {
  const meta = mocks.agentMetaById.get(agentId);
  if (!meta) {
    throw new Error(`Agent metadata missing for ${agentId}`);
  }

  mocks.supervisionByAgentId.set(agentId, {
    ...createSupervisionSnapshot({
      agentId,
      isShell: meta.isShell,
      taskId: options.taskId ?? meta.taskId,
    }),
    attentionReason: state === 'idle-at-prompt' ? 'ready-for-next-step' : null,
    state,
  });
}

function emitSupervision(agentId: string): void {
  const snapshot = mocks.supervisionByAgentId.get(agentId);
  for (const listener of mocks.supervisionListeners) {
    listener({
      agentId,
      snapshot,
    });
  }
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForShortAsyncWindow(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, SHORT_ASYNC_SETTLE_MS);
  });
}

function expectPromptStatus(
  run: CoordinatorRunSnapshot,
  requestId: string,
  status: CoordinatorPromptRequestSnapshot['status'],
): void {
  expect(run.promptQueue.find((prompt) => prompt.requestId === requestId)?.status).toBe(status);
}

async function createHarnessWithRun(): Promise<{
  credential: { token: string };
  harness: CoordinatorBrowserlessHarness;
  run: CoordinatorRunSnapshot;
}> {
  const harness = await createCoordinatorBrowserlessHarness();
  activeHarnesses.push(harness);
  const { credential, result } = await harness.createCoordinatorRun();
  return { credential, harness, run: result.run };
}

async function spawnCoordinatorSubtask(
  harness: CoordinatorBrowserlessHarness,
  run: CoordinatorRunSnapshot,
  token: string,
  overrides: SpawnCoordinatorSubtaskOverrides = {},
): Promise<CoordinatorSubtaskSnapshot> {
  spawnCallIndex += 1;
  const callId = overrides.callId ?? `spawn-${spawnCallIndex}`;
  const response = await harness.callCoordinatorTool({
    callId,
    runId: run.id,
    taskId: run.coordinatorTaskId,
    token,
    toolName: 'spawn_subtask',
    payload: {
      agent: {
        args: overrides.args ?? ['--model', 'gpt-5.5'],
        command: overrides.command ?? 'codex',
        env: overrides.env ?? { FOO: '1' },
        skipPermissionsArgs: overrides.skipPermissionsArgs ?? ['--yolo'],
      },
      assignment: overrides.assignment ?? 'Investigate coordinator E2E behavior.',
      dedupeKey: overrides.dedupeKey ?? `${callId}:${overrides.name ?? 'Coordinator child'}`,
      name: overrides.name ?? 'Coordinator child',
    },
  });
  return getToolResult<CoordinatorSubtaskSnapshot>(response);
}

function createCustomSpawnOverrides(
  callId: string,
  dedupeKey: string,
): SpawnCoordinatorSubtaskOverrides {
  return {
    args: ['--profile', 'fast'],
    assignment: 'Run the custom coordinator child.',
    callId,
    command: 'custom-agent',
    dedupeKey,
    env: { CUSTOM: '1' },
    name: 'Custom child',
    skipPermissionsArgs: ['--no-confirm'],
  };
}

async function expectRejectedUiPromptMutation(options: {
  clientId: string;
  harness: CoordinatorBrowserlessHarness;
  requestId: string;
  run: CoordinatorRunSnapshot;
  subtask: CoordinatorSubtaskSnapshot;
  text: string;
}): Promise<void> {
  const response = await options.harness.ipcResponse(
    IPC.CoordinatorUiToolCall,
    {
      coordinatorTaskId: options.run.coordinatorTaskId,
      payload: {
        targetTaskId: options.subtask.taskId,
        text: options.text,
      },
      requestId: options.requestId,
      runId: options.run.id,
      toolName: 'send_prompt',
    },
    { clientId: options.clientId },
  );
  const body = (await response.json()) as { error?: string };
  expect(response.status).toBe(400);
  expect(body.error).toBe('Coordinator task command lease is required');
}

function resetMockState(): void {
  mocks.agentMetaById.clear();
  mocks.agentSessionIds.clear();
  mocks.scrollbackByAgentId.clear();
  mocks.supervisionByAgentId.clear();
  mocks.supervisionListeners.clear();
  mocks.writes.length = 0;
}

function installDefaultWorkflowMocks(): void {
  let taskIndex = 0;
  mocks.createTaskWorkflowMock.mockImplementation(
    async (_context: unknown, options: MockCreateTaskWorkflowOptions) => {
      taskIndex += 1;
      const id = `task-child-${taskIndex}`;
      const worktreePath =
        options.projectMode === 'non-git'
          ? options.projectRoot
          : path.join(options.projectRoot, '.worktrees', id);

      if (options.projectMode !== 'non-git') {
        await mkdir(worktreePath, { recursive: true });
      }

      return {
        base_branch: 'main',
        branch_name: options.projectMode === 'non-git' ? '' : `feature/${id}`,
        git_isolation: options.gitIsolation ?? 'worktree',
        id,
        worktree_path: worktreePath,
      };
    },
  );
}

const activeHarnesses: CoordinatorBrowserlessHarness[] = [];
const tempDirs: string[] = [];
let spawnCallIndex = 0;

function forgetActiveHarness(harness: CoordinatorBrowserlessHarness): void {
  const index = activeHarnesses.indexOf(harness);
  if (index >= 0) {
    activeHarnesses.splice(index, 1);
  }
}

describe('browser-less coordinator E2E', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    clearTaskPortRegistry();
    resetTaskCommandLeasesForTest();
    resetCoordinatorToolGatewayForTests();
    resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    resetMockState();
    spawnCallIndex = 0;
    installDefaultWorkflowMocks();
    mocks.cleanupTaskRuntimeWorkflowMock.mockReturnValue({ releasedTaskCommandController: null });
    mocks.deleteTaskWorkflowMock.mockResolvedValue({
      cleanupWarnings: [],
      releasedTaskCommandController: null,
    });
    mocks.getAllFileDiffsMock.mockResolvedValue('');
    mocks.getProjectDiffMock.mockResolvedValue({
      files: [],
      totalAdded: 0,
      totalRemoved: 0,
    });
    mocks.getWorktreeStatusMock.mockResolvedValue({ has_uncommitted_changes: false });
    mocks.mergeTaskMock.mockResolvedValue({ main_branch: 'main' });
  });

  afterEach(async () => {
    await Promise.all(activeHarnesses.splice(0).map((harness) => harness.close()));
    await Promise.all(
      tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
    clearTaskPortRegistry();
    resetTaskCommandLeasesForTest();
    resetCoordinatorToolGatewayForTests();
    resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    resetMockState();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('routes coordinator tool calls through browser-server HTTP and WS without browser auth authority', async () => {
    const harness = await createCoordinatorBrowserlessHarness();
    activeHarnesses.push(harness);
    const socket = await harness.connectWebSocket('coordinator-client');
    const runEvent = harness.waitForSocketMessage(socket, isSequencedRunUpsertedMessage);

    try {
      const { credential, result } = await harness.createCoordinatorRun();
      await expect(runEvent).resolves.toMatchObject({
        event: {
          payload: {
            coordinatorTaskId: 'task-coordinator',
            id: result.run.id,
          },
          runId: result.run.id,
        },
        type: 'coordinator-event',
      });

      const browserTokenResponse = await harness.toolCallResponse({
        callId: 'browser-token-status',
        runId: result.run.id,
        taskId: result.run.coordinatorTaskId,
        token: harness.token,
        toolName: 'get_task_status',
      });
      const browserTokenBody = (await browserTokenResponse.json()) as { error?: string };
      expect(browserTokenResponse.status).toBe(400);
      expect(browserTokenBody.error).toBe('Invalid coordinator tool token');

      const status = await harness.callCoordinatorTool({
        callId: 'credential-status',
        runId: result.run.id,
        taskId: result.run.coordinatorTaskId,
        token: credential.token,
        toolName: 'get_task_status',
      });
      expect(getToolResult<CoordinatorRunSnapshot>(status)).toMatchObject({
        coordinatorTaskId: 'task-coordinator',
        id: result.run.id,
        status: 'running',
      });
    } finally {
      socket.close();
    }
  });

  it('spawns a hidden subtask, injects credentials, delivers assignment, and emits subtask events', async () => {
    const { credential, harness, run } = await createHarnessWithRun();
    const subtaskEventSocket = await harness.connectWebSocket('coordinator-events-client');
    const subtaskEvent = harness.waitForSocketMessage(
      subtaskEventSocket,
      isRunningSubtaskUpsertedMessage,
    );

    try {
      const subtask = await spawnCoordinatorSubtask(harness, run, credential.token);
      const spawnedAgent = getSpawnedAgentOptions();

      expect(subtask.status).toBe('running');
      expect(spawnedAgent).toMatchObject({
        args: ['--model', 'gpt-5.5', '--yolo'],
        command: 'codex',
        cwd: subtask.worktreePath,
        taskId: subtask.taskId,
      });
      expect(spawnedAgent.env).toMatchObject({
        FOO: '1',
        PARALLEL_CODE_COORDINATOR_RUN_ID: run.id,
      });
      expect(spawnedAgent.env.PARALLEL_CODE_COORDINATOR_CREDENTIAL).toContain(
        'coordinator-credentials',
      );
      expect(mocks.writes.map((write) => write.data).join('\n')).toContain(
        'Investigate coordinator E2E behavior.',
      );
      await expect(subtaskEvent).resolves.toMatchObject({
        event: {
          payload: {
            status: 'running',
            taskId: subtask.taskId,
          },
        },
      });

      mocks.scrollbackByAgentId.set(subtask.agentId, Buffer.from('hidden child output'));
      const output = await harness.callCoordinatorTool({
        callId: 'output-1',
        runId: run.id,
        taskId: run.coordinatorTaskId,
        token: credential.token,
        toolName: 'get_task_output',
        payload: { targetTaskId: subtask.taskId },
      });
      expect(getToolResult<{ output: string }>(output).output).toBe('hidden child output');
    } finally {
      subtaskEventSocket.close();
    }
  });

  it('deduplicates route-level spawns and preserves custom agent launch config', async () => {
    const { credential, harness, run } = await createHarnessWithRun();
    const createTaskWorkflowImpl = mocks.createTaskWorkflowMock.getMockImplementation();
    if (!createTaskWorkflowImpl) {
      throw new Error('Expected createTaskWorkflow mock implementation');
    }

    let releaseFirstCreate: (() => void) | undefined;
    let firstCreateStarted = false;
    mocks.createTaskWorkflowMock.mockImplementation(
      async (context: unknown, options: MockCreateTaskWorkflowOptions) => {
        if (!firstCreateStarted) {
          firstCreateStarted = true;
          await new Promise<void>((resolve) => {
            releaseFirstCreate = resolve;
          });
        }

        return createTaskWorkflowImpl(context, options);
      },
    );

    const dedupeKey = 'stable-route-spawn';
    const firstPromise = spawnCoordinatorSubtask(
      harness,
      run,
      credential.token,
      createCustomSpawnOverrides('spawn-custom-first', dedupeKey),
    );
    await waitForCondition(() => firstCreateStarted, 'first spawn create admission');

    let secondResolved = false;
    const secondPromise = spawnCoordinatorSubtask(
      harness,
      run,
      credential.token,
      createCustomSpawnOverrides('spawn-custom-second', dedupeKey),
    ).then((subtask) => {
      secondResolved = true;
      return subtask;
    });
    await waitForShortAsyncWindow();
    const secondResolvedBeforeRelease = secondResolved;
    const createWorkflowCallsBeforeRelease = mocks.createTaskWorkflowMock.mock.calls.length;
    releaseFirstCreate?.();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(secondResolvedBeforeRelease).toBe(false);
    expect(createWorkflowCallsBeforeRelease).toBe(1);
    expect(second.taskId).toBe(first.taskId);
    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledTimes(1);
    expect(mocks.spawnTaskAgentWorkflowMock).toHaveBeenCalledTimes(1);
    expect(getSpawnedAgentOptions()).toMatchObject({
      args: ['--profile', 'fast', '--no-confirm'],
      command: 'custom-agent',
      env: expect.objectContaining({
        CUSTOM: '1',
        PARALLEL_CODE_COORDINATOR_RUN_ID: run.id,
      }),
    });

    const status = await harness.callCoordinatorTool({
      callId: 'status-after-dedupe',
      runId: run.id,
      taskId: run.coordinatorTaskId,
      token: credential.token,
      toolName: 'get_task_status',
    });
    expect(getToolResult<CoordinatorRunSnapshot>(status).subtasks).toHaveLength(1);
  });

  it('queues prompt delivery behind TUI busy state and resumes through supervision without interleaving writes', async () => {
    const { credential, harness, run } = await createHarnessWithRun();
    const subtask = await spawnCoordinatorSubtask(harness, run, credential.token);
    mocks.writes.length = 0;
    setAgentSupervision(subtask.agentId, 'active');

    const queuedResponse = await harness.callCoordinatorTool({
      callId: 'send-while-active',
      runId: run.id,
      taskId: run.coordinatorTaskId,
      token: credential.token,
      toolName: 'send_prompt',
      payload: {
        targetTaskId: subtask.taskId,
        text: 'line 1\nline 2',
      },
    });
    const queuedPrompt = getToolResult<CoordinatorPromptRequestSnapshot>(queuedResponse);
    expect(queuedPrompt.status).toBe('waiting-for-terminal-prompt');
    expect(mocks.writes).toEqual([]);

    setAgentSupervision(subtask.agentId, 'idle-at-prompt');
    emitSupervision(subtask.agentId);
    await waitForCondition(
      () =>
        mocks.writes.length === 2 &&
        mocks.writes.some((write) => write.data.includes('line 1\nline 2')),
      'queued multiline prompt delivery',
    );

    expect(mocks.writes.map((write) => write.data)).toEqual([
      `${BRACKETED_PASTE_START}line 1\nline 2${BRACKETED_PASTE_END}`,
      '\r',
    ]);

    const status = await harness.callCoordinatorTool({
      callId: 'status-after-prompt',
      runId: run.id,
      taskId: run.coordinatorTaskId,
      token: credential.token,
      toolName: 'get_task_status',
    });
    expectPromptStatus(
      getToolResult<CoordinatorRunSnapshot>(status),
      queuedPrompt.requestId,
      'delivered',
    );
  });

  it('cancels queued prompts when their target closes before delivery', async () => {
    const { credential, harness, run } = await createHarnessWithRun();
    const subtask = await spawnCoordinatorSubtask(harness, run, credential.token);
    mocks.writes.length = 0;
    setAgentSupervision(subtask.agentId, 'active');

    const queuedResponse = await harness.callCoordinatorTool({
      callId: 'queued-before-target-close',
      runId: run.id,
      taskId: run.coordinatorTaskId,
      token: credential.token,
      toolName: 'send_prompt',
      payload: {
        targetTaskId: subtask.taskId,
        text: 'do not deliver',
      },
    });
    const queuedPrompt = getToolResult<CoordinatorPromptRequestSnapshot>(queuedResponse);
    expect(queuedPrompt.status).toBe('waiting-for-terminal-prompt');
    expect(mocks.writes).toEqual([]);

    const closeResponse = await harness.callCoordinatorTool({
      callId: 'close-before-delivery',
      runId: run.id,
      taskId: run.coordinatorTaskId,
      token: credential.token,
      toolName: 'close_task',
      payload: { targetTaskId: subtask.taskId },
    });
    expect(getToolResult<{ status: string }>(closeResponse).status).toBe('cancelled');

    setAgentSupervision(subtask.agentId, 'idle-at-prompt');
    emitSupervision(subtask.agentId);
    await waitForShortAsyncWindow();
    expect(mocks.writes).toEqual([]);

    const status = await harness.callCoordinatorTool({
      callId: 'status-after-cancelled-prompt',
      runId: run.id,
      taskId: run.coordinatorTaskId,
      token: credential.token,
      toolName: 'get_task_status',
    });
    expectPromptStatus(
      getToolResult<CoordinatorRunSnapshot>(status),
      queuedPrompt.requestId,
      'cancelled',
    );
  });

  it('enforces renderer UI action identity, credential stripping, and lease-gated mutations', async () => {
    const { credential, harness, run } = await createHarnessWithRun();
    const subtask = await spawnCoordinatorSubtask(harness, run, credential.token);
    mocks.writes.length = 0;

    const noLeaseResponse = await harness.ipcResponse(
      IPC.CoordinatorUiToolCall,
      {
        coordinatorTaskId: run.coordinatorTaskId,
        payload: {
          targetTaskId: subtask.taskId,
          text: 'queued from UI',
        },
        requestId: 'ui-send-no-lease',
        runId: run.id,
        toolName: 'send_prompt',
      },
      { clientId: 'ui-client' },
    );
    const noLeaseBody = (await noLeaseResponse.json()) as { error?: string };
    expect(noLeaseResponse.status).toBe(400);
    expect(noLeaseBody.error).toBe('Coordinator task command lease is required');

    const credentialLeakResponse = await harness.ipcResponse(
      IPC.CoordinatorUiToolCall,
      {
        coordinatorTaskId: run.coordinatorTaskId,
        requestId: 'ui-credential-leak',
        runId: run.id,
        token: credential.token,
        toolName: 'get_task_status',
      },
      { clientId: 'ui-client' },
    );
    const credentialLeakBody = (await credentialLeakResponse.json()) as { error?: string };
    expect(credentialLeakResponse.status).toBe(400);
    expect(credentialLeakBody.error).toBe(
      'Coordinator UI action must not include tool credentials',
    );

    const leaseSocket = await harness.connectWebSocket('ui-client');
    try {
      const leaseResult = await harness.sendTaskCommandLease(leaseSocket, {
        type: 'task-command-lease',
        action: 'manage coordinator subtasks',
        operation: 'acquire',
        ownerId: 'ui-test',
        requestId: 'ui-lease-acquire',
        taskId: run.coordinatorTaskId,
        takeover: true,
      });
      expect(leaseResult).toMatchObject({
        operation: 'acquire',
        requestId: 'ui-lease-acquire',
        result: {
          acquired: true,
          controllerId: 'ui-client',
          taskId: run.coordinatorTaskId,
        },
        type: 'task-command-lease-result',
      });

      const accepted = await harness.ipc<CoordinatorToolCallResult>(
        IPC.CoordinatorUiToolCall,
        {
          controllerId: 'spoofed-client',
          coordinatorTaskId: run.coordinatorTaskId,
          payload: {
            targetTaskId: subtask.taskId,
            text: 'queued from UI',
          },
          requestId: 'ui-send-with-lease',
          runId: run.id,
          toolName: 'send_prompt',
        },
        { clientId: 'ui-client' },
      );

      expect(accepted.accepted).toBe(true);
      expect(getToolResult<CoordinatorPromptRequestSnapshot>(accepted)).toMatchObject({
        sourceTaskId: run.coordinatorTaskId,
        status: 'delivered',
        targetTaskId: subtask.taskId,
        text: 'queued from UI',
      });
      expect(mocks.writes).toEqual([{ agentId: subtask.agentId, data: 'queued from UI\r' }]);
    } finally {
      leaseSocket.close();
    }
  });

  it('rejects renderer mutations from peer clients and after websocket lease release', async () => {
    const { credential, harness, run } = await createHarnessWithRun();
    const subtask = await spawnCoordinatorSubtask(harness, run, credential.token);
    const leaseSocket = await harness.connectWebSocket('ui-owner-client');

    try {
      const leaseResult = await harness.sendTaskCommandLease(leaseSocket, {
        type: 'task-command-lease',
        action: 'manage coordinator subtasks',
        operation: 'acquire',
        ownerId: 'ui-owner',
        requestId: 'ui-owner-lease',
        taskId: run.coordinatorTaskId,
        takeover: true,
      });
      if (leaseResult.operation !== 'acquire' || 'error' in leaseResult) {
        throw new Error('Expected task command lease acquisition');
      }

      await expectRejectedUiPromptMutation({
        clientId: 'ui-peer-client',
        harness,
        requestId: 'peer-send-without-owned-lease',
        run,
        subtask,
        text: 'peer prompt',
      });

      await harness.sendTaskCommandLease(leaseSocket, {
        type: 'task-command-lease',
        leaseGeneration: leaseResult.result.leaseGeneration,
        operation: 'release',
        ownerId: 'ui-owner',
        requestId: 'ui-owner-release',
        taskId: run.coordinatorTaskId,
      });

      await expectRejectedUiPromptMutation({
        clientId: 'ui-owner-client',
        harness,
        requestId: 'owner-send-after-release',
        run,
        subtask,
        text: 'released owner prompt',
      });
    } finally {
      leaseSocket.close();
    }
  });

  it('supports non-git route spawn and prompt flow while rejecting git-only tools', async () => {
    const harness = await createCoordinatorBrowserlessHarness();
    activeHarnesses.push(harness);
    const { credential, result } = await harness.createCoordinatorRun({
      coordinatorAgentId: 'agent-non-git-coordinator',
      coordinatorTaskId: 'task-non-git-coordinator',
      projectId: 'project-non-git',
      projectMode: 'non-git',
      projectRoot: harness.rootDir,
    });
    const run = result.run;
    const subtask = await spawnCoordinatorSubtask(harness, run, credential.token, {
      callId: 'spawn-non-git-child',
      command: 'custom-agent',
      name: 'Folder child',
    });
    const spawnedAgent = getSpawnedAgentOptions();

    expect(mocks.createTaskWorkflowMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectMode: 'non-git',
        projectRoot: harness.rootDir,
      }),
    );
    expect(spawnedAgent).toMatchObject({
      command: 'custom-agent',
      cwd: harness.rootDir,
      projectMode: 'non-git',
    });
    expect(subtask.branchName).toBe('');
    expect(subtask.worktreePath).toBe(harness.rootDir);

    mocks.writes.length = 0;
    const promptResponse = await harness.callCoordinatorTool({
      callId: 'non-git-follow-up',
      runId: run.id,
      taskId: run.coordinatorTaskId,
      token: credential.token,
      toolName: 'send_prompt',
      payload: {
        targetTaskId: subtask.taskId,
        text: 'non-git follow-up',
      },
    });
    expect(getToolResult<CoordinatorPromptRequestSnapshot>(promptResponse).status).toBe(
      'delivered',
    );
    expect(mocks.writes).toEqual([{ agentId: subtask.agentId, data: 'non-git follow-up\r' }]);

    mocks.scrollbackByAgentId.set(subtask.agentId, Buffer.from('folder output'));
    const outputResponse = await harness.callCoordinatorTool({
      callId: 'non-git-output',
      runId: run.id,
      taskId: run.coordinatorTaskId,
      token: credential.token,
      toolName: 'get_task_output',
      payload: { targetTaskId: subtask.taskId },
    });
    expect(getToolResult<{ output: string }>(outputResponse).output).toBe('folder output');

    const diffResponse = await harness.toolCallResponse({
      callId: 'non-git-diff',
      runId: run.id,
      taskId: run.coordinatorTaskId,
      token: credential.token,
      toolName: 'get_task_diff',
      payload: { targetTaskId: subtask.taskId },
    });
    const diffBody = (await diffResponse.json()) as { error?: string };
    expect(diffResponse.status).toBe(400);
    expect(diffBody.error).toBe('get_task_diff requires a git-backed coordinator run');

    const childCredentialPath = spawnedAgent.env.PARALLEL_CODE_COORDINATOR_CREDENTIAL;
    const childCredential = JSON.parse(await readFile(childCredentialPath, 'utf8')) as {
      token: string;
    };
    const landingResponse = await harness.callCoordinatorTool({
      callId: 'non-git-land',
      runId: run.id,
      taskId: subtask.taskId,
      token: childCredential.token,
      toolName: 'land_self',
      payload: {
        summary: 'Try non-git landing',
        verification: [],
      },
    });
    expect(getToolResult<{ failure?: string; status: string }>(landingResponse)).toMatchObject({
      failure: 'Self-landing is only available for git-backed subtasks.',
      status: 'rejected',
    });
  });

  it('cleans running and exited subtasks through route-level close with prompt cancellation and credential revocation', async () => {
    const { credential, harness, run } = await createHarnessWithRun();
    const runningSubtask = await spawnCoordinatorSubtask(harness, run, credential.token, {
      callId: 'spawn-running',
      name: 'Running child',
    });
    const runningCredentialPath =
      getSpawnedAgentOptions(0).env.PARALLEL_CODE_COORDINATOR_CREDENTIAL;
    const runningCredential = JSON.parse(await readFile(runningCredentialPath, 'utf8')) as {
      token: string;
    };
    mocks.writes.length = 0;
    setAgentSupervision(runningSubtask.agentId, 'active');
    const prompt = getToolResult<CoordinatorPromptRequestSnapshot>(
      await harness.callCoordinatorTool({
        callId: 'queued-before-close',
        runId: run.id,
        taskId: run.coordinatorTaskId,
        token: credential.token,
        toolName: 'send_prompt',
        payload: {
          targetTaskId: runningSubtask.taskId,
          text: 'cancel me',
        },
      }),
    );

    const closeRunning = await harness.callCoordinatorTool({
      callId: 'close-running',
      runId: run.id,
      taskId: run.coordinatorTaskId,
      token: credential.token,
      toolName: 'close_task',
      payload: { targetTaskId: runningSubtask.taskId },
    });
    expect(getToolResult<{ status: string; taskId: string }>(closeRunning)).toEqual({
      cleanupWarnings: [],
      status: 'cancelled',
      taskId: runningSubtask.taskId,
    });
    expect(resolveCoordinatorToken(runningCredential.token)).toBeNull();
    const rejectedChildResponse = await harness.toolCallResponse({
      callId: 'child-after-close',
      runId: run.id,
      taskId: runningSubtask.taskId,
      token: runningCredential.token,
      toolName: 'signal_done',
    });
    expect(rejectedChildResponse.status).toBe(400);

    const statusAfterClose = await harness.callCoordinatorTool({
      callId: 'status-after-close',
      runId: run.id,
      taskId: run.coordinatorTaskId,
      token: credential.token,
      toolName: 'get_task_status',
    });
    expectPromptStatus(
      getToolResult<CoordinatorRunSnapshot>(statusAfterClose),
      prompt.requestId,
      'cancelled',
    );

    const exitedSubtask = await spawnCoordinatorSubtask(harness, run, credential.token, {
      callId: 'spawn-exited',
      name: 'Exited child',
    });
    updateCoordinatorSubtaskStatus(run.id, exitedSubtask.taskId, 'exited');
    const closeExited = await harness.callCoordinatorTool({
      callId: 'close-exited',
      runId: run.id,
      taskId: run.coordinatorTaskId,
      token: credential.token,
      toolName: 'close_task',
      payload: { targetTaskId: exitedSubtask.taskId },
    });
    expect(getToolResult<{ status: string }>(closeExited).status).toBe('cancelled');
    expect(mocks.deleteTaskWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: exitedSubtask.taskId,
        worktreePath: exitedSubtask.worktreePath,
      }),
    );
  });

  it('lands a clean subtask through HTTP tool calls and records cleanup warnings', async () => {
    const { credential, harness, run } = await createHarnessWithRun();
    const subtask = await spawnCoordinatorSubtask(harness, run, credential.token);
    const childCredentialPath = getSpawnedAgentOptions().env.PARALLEL_CODE_COORDINATOR_CREDENTIAL;
    const childCredential = JSON.parse(await readFile(childCredentialPath, 'utf8')) as {
      token: string;
    };

    const done = await harness.callCoordinatorTool({
      callId: 'child-done',
      runId: run.id,
      taskId: subtask.taskId,
      token: childCredential.token,
      toolName: 'signal_done',
      payload: { result: 'ready' },
    });
    expect(getToolResult<CoordinatorSubtaskSnapshot>(done).status).toBe('ready-for-review');

    mocks.deleteTaskWorkflowMock.mockResolvedValueOnce({
      cleanupWarnings: [],
      releasedTaskCommandController: null,
    });
    const landing = await harness.callCoordinatorTool({
      callId: 'child-land',
      runId: run.id,
      taskId: subtask.taskId,
      token: childCredential.token,
      toolName: 'land_self',
      payload: {
        summary: 'Merge coordinator child',
        verification: ['npm test'],
      },
    });
    expect(getToolResult<{ status: string; targetBranch?: string }>(landing)).toMatchObject({
      status: 'landed',
      targetBranch: 'main',
    });
    expect(mocks.mergeTaskMock).toHaveBeenCalledWith(
      run.projectRoot,
      subtask.worktreePath,
      subtask.branchName,
      false,
      'Merge coordinator child',
      false,
    );

    const warningSubtask = await spawnCoordinatorSubtask(harness, run, credential.token, {
      callId: 'spawn-warning-child',
      name: 'Warning child',
    });
    const warningCredentialPath =
      getSpawnedAgentOptions(1).env.PARALLEL_CODE_COORDINATOR_CREDENTIAL;
    const warningCredential = JSON.parse(await readFile(warningCredentialPath, 'utf8')) as {
      token: string;
    };
    mocks.deleteTaskWorkflowMock.mockResolvedValueOnce({
      cleanupWarnings: [{ kind: 'worktree', message: 'remove failed' }],
      releasedTaskCommandController: null,
    });

    const warningLanding = await harness.callCoordinatorTool({
      callId: 'warning-child-land',
      runId: run.id,
      taskId: warningSubtask.taskId,
      token: warningCredential.token,
      toolName: 'land_self',
      payload: {
        summary: 'Merge warning child',
        verification: ['npm test'],
      },
    });
    expect(getToolResult<{ failure?: string; status: string }>(warningLanding)).toMatchObject({
      failure: 'remove failed',
      status: 'cleanup-failed',
    });
  });

  it('restores coordinator runs as stale and rejects old credentials after server restart', async () => {
    const persistedRoot = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-coordinator-state-'));
    tempDirs.push(persistedRoot);
    const firstHarness = await createCoordinatorBrowserlessHarness({
      userDataPath: path.join(persistedRoot, 'user-data'),
    });
    activeHarnesses.push(firstHarness);
    const { credential, result } = await firstHarness.createCoordinatorRun();
    await spawnCoordinatorSubtask(firstHarness, result.run, credential.token);
    await firstHarness.close();
    forgetActiveHarness(firstHarness);
    resetCoordinatorToolGatewayForTests();
    resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    resetTaskCommandLeasesForTest();

    const restoredHarness = await createCoordinatorBrowserlessHarness({
      userDataPath: path.join(persistedRoot, 'user-data'),
    });
    activeHarnesses.push(restoredHarness);
    const bootstrap = await restoredHarness.ipc<ServerStateBootstrapSnapshot[]>(
      IPC.GetServerStateBootstrap,
      {},
    );
    const coordinatorSnapshot = bootstrap.find((entry) => entry.category === 'coordinator');
    const restoredRun = coordinatorSnapshot?.payload.runs.find((run) => run.id === result.run.id);
    expect(restoredRun).toMatchObject({
      id: result.run.id,
      status: 'stale-after-restore',
    });
    expect(restoredRun?.subtasks[0]).toMatchObject({
      status: 'exited',
      taskId: 'task-child-1',
    });

    const oldCredentialResponse = await restoredHarness.toolCallResponse({
      callId: 'old-credential-after-restore',
      runId: result.run.id,
      taskId: result.run.coordinatorTaskId,
      token: credential.token,
      toolName: 'get_task_status',
    });
    const body = (await oldCredentialResponse.json()) as { error?: string };
    expect(oldCredentialResponse.status).toBe(400);
    expect(body.error).toBe('Coordinator run is stale-after-restore');
  });

  it('replays coordinator events to reconnecting websocket clients using browser control sequence cursors', async () => {
    const { credential, harness, run } = await createHarnessWithRun();
    const { message: runEvent, socket: firstSocket } = await harness.connectWebSocketAndWait(
      'replay-client',
      -1,
      isSequencedRunUpsertedMessage,
    );
    firstSocket.close();

    const subtask = await spawnCoordinatorSubtask(harness, run, credential.token);
    const { message: replayedSubtaskEvent, socket: replaySocket } =
      await harness.connectWebSocketAndWait(
        'replay-client',
        runEvent.seq,
        createSequencedSubtaskUpsertedPredicate(subtask.taskId),
      );

    expect(replayedSubtaskEvent.seq).toBeGreaterThan(runEvent.seq);
    replaySocket.close();
  });
});
