import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COORDINATOR_LIMITS,
  createCoordinatorSubtaskStartupSnapshot,
  type CoordinatorPromptKind,
  type CoordinatorPromptRequestSnapshot,
} from '../../src/domain/coordinator.js';
import type { HandlerContext } from '../ipc/handler-context.js';
import type { StorageEnv } from '../ipc/storage.js';

const mocks = vi.hoisted(() => {
  const supervisionListeners = new Set<(event: unknown) => void>();
  return {
    getAgentMetaMock: vi.fn(),
    getAgentScrollbackBufferMock: vi.fn(),
    getAgentSupervisionSnapshotMock: vi.fn(),
    hasAgentSessionMock: vi.fn(),
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

vi.mock('../ipc/pty.js', () => ({
  getAgentMeta: mocks.getAgentMetaMock,
  getAgentScrollbackBuffer: mocks.getAgentScrollbackBufferMock,
  hasAgentSession: mocks.hasAgentSessionMock,
  writeToAgent: mocks.writeToAgentMock,
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
  setCoordinatorRunPaused,
  updateCoordinatorPrompt,
} from './runtime.js';
import {
  cleanupCoordinatorStateForTask,
  createCoordinatorRunForTask,
  resetCoordinatorServiceForTests,
} from './service.js';
import {
  coordinatorRunAdmitsPromptDelivery,
  deliverCoordinatorPromptWithAdmission,
  queueCoordinatorPromptForDelivery,
  resetCoordinatorPromptDeliveryForTests,
  scheduleCoordinatorPromptDelivery,
  startCoordinatorPromptDeliveryLoop,
  STALE_DELIVERING_REQUEUE_MS,
  stopCoordinatorPromptDeliveryLoop,
} from './prompt-delivery.js';
import {
  createContext,
  createStorageEnv as createCoordinatorTestStorageEnv,
  createSupervisionSnapshot,
  removeStorageEnv,
} from './test-helpers.js';

const CODEX_COMPOSER_TAIL = ['Codex session ready.', '', '› Describe the next change'].join('\n');

function createStorageEnv(): StorageEnv {
  return createCoordinatorTestStorageEnv('parallel-code-coordinator-delivery-');
}

function createRunForCoordinatorTask(context: HandlerContext): string {
  return createCoordinatorRunForTask(context, {
    coordinatorAgentId: 'agent-coordinator',
    coordinatorTaskId: 'task-coordinator',
    projectId: 'project-1',
    projectMode: 'git',
    projectRoot: '/repo',
  }).run.id;
}

function addRunningSubtask(runId: string, suffix: string): void {
  addCoordinatorSubtask({
    agentId: `agent-${suffix}`,
    assignment: `Do the work ${suffix}`,
    parentCoordinatorTaskId: 'task-coordinator',
    runId,
    status: 'running',
    taskId: `task-${suffix}`,
    toolTokenId: `token-${suffix}`,
    worktreePath: `/repo/task-${suffix}`,
  });
}

function queuePrompt(
  context: HandlerContext,
  runId: string,
  targetTaskId: string,
  text: string,
  options: { dedupeKey?: string; kind?: CoordinatorPromptKind } = {},
): Promise<CoordinatorPromptRequestSnapshot> {
  const run = getCoordinatorRun(runId);
  const subtask = run?.subtasks.find((candidate) => candidate.taskId === targetTaskId);
  if (!run || !subtask) {
    throw new Error(`Coordinator subtask not found: ${targetTaskId}`);
  }

  return queueCoordinatorPromptForDelivery(context, {
    ...(options.dedupeKey !== undefined ? { dedupeKey: options.dedupeKey } : {}),
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
    run,
    sourceTaskId: run.coordinatorTaskId,
    subtask,
    text,
  });
}

describe('coordinator prompt delivery', () => {
  const envs: StorageEnv[] = [];

  beforeEach(() => {
    mocks.getAgentScrollbackBufferMock.mockReturnValue(Buffer.from(''));
  });

  afterEach(() => {
    resetCoordinatorPromptDeliveryForTests();
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

  it('serializes concurrent prompt writes to the same target terminal', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const runId = createRunForCoordinatorTask(context);
    addRunningSubtask(runId, 'child');
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

    const first = queuePrompt(context, runId, 'task-child', 'First line\nSecond line');
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.writeToAgentMock).toHaveBeenCalledTimes(1);

    const second = queuePrompt(context, runId, 'task-child', 'Follow up');
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
    const runId = createRunForCoordinatorTask(context);
    addRunningSubtask(runId, 'child');
    addRunningSubtask(runId, 'sibling');
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

    const first = queuePrompt(context, runId, 'task-child', 'First line\nSecond line');
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.writeToAgentMock).toHaveBeenCalledTimes(1);

    const sameTarget = queuePrompt(context, runId, 'task-child', 'Follow up');
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.writeToAgentMock).toHaveBeenCalledTimes(1);

    const sibling = queuePrompt(context, runId, 'task-sibling', 'Sibling prompt');
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
    const runId = createRunForCoordinatorTask(context);
    for (let index = 0; index < 3; index += 1) {
      addRunningSubtask(runId, `child-${index}`);
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
    startCoordinatorPromptDeliveryLoop(context);

    const first = queuePrompt(context, runId, 'task-child-0', 'First line\nSecond line');
    const second = queuePrompt(context, runId, 'task-child-1', 'First line\nSecond line');
    await Promise.resolve();
    await Promise.resolve();

    const third = await queuePrompt(context, runId, 'task-child-2', 'Third prompt');

    expect(third).toMatchObject({
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
    const runId = createRunForCoordinatorTask(context);
    const multilinePrompt = 'First line\nSecond line';
    startCoordinatorPromptDeliveryLoop(context);
    for (let index = 0; index < 3; index += 1) {
      addRunningSubtask(runId, `child-${index}`);
      enqueueCoordinatorPrompt({
        kind: 'follow-up',
        runId,
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
    expect(getCoordinatorRun(runId)?.promptQueue).toEqual([
      expect.objectContaining({ status: 'delivering', targetTaskId: 'task-child-0' }),
      expect.objectContaining({ status: 'delivering', targetTaskId: 'task-child-1' }),
      expect.objectContaining({ status: 'queued', targetTaskId: 'task-child-2' }),
    ]);

    await vi.runAllTimersAsync();

    expect(mocks.writeToAgentMock.mock.calls.map((call) => call[1])).toContain(
      '\x1B[200~First line\nSecond line\x1B[201~',
    );
    expect(getCoordinatorRun(runId)?.promptQueue).toEqual([
      expect.objectContaining({ status: 'delivered', targetTaskId: 'task-child-0' }),
      expect.objectContaining({ status: 'delivered', targetTaskId: 'task-child-1' }),
      expect.objectContaining({ status: 'delivered', targetTaskId: 'task-child-2' }),
    ]);
  });

  it('gates prompt admission through the run-status hook while the run is paused', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const runId = createRunForCoordinatorTask(context);
    addRunningSubtask(runId, 'child');
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
    startCoordinatorPromptDeliveryLoop(context);
    setCoordinatorRunPaused(runId, true);

    expect(coordinatorRunAdmitsPromptDelivery({ status: 'paused-by-user' })).toBe(false);
    expect(coordinatorRunAdmitsPromptDelivery({ status: 'running' })).toBe(true);

    const prompt = await queuePrompt(context, runId, 'task-child', 'Deferred prompt');
    expect(prompt.status).toBe('queued');
    expect(mocks.writeToAgentMock).not.toHaveBeenCalled();

    scheduleCoordinatorPromptDelivery(0, true);
    await vi.runAllTimersAsync();
    expect(mocks.writeToAgentMock).not.toHaveBeenCalled();
    expect(getCoordinatorRun(runId)?.promptQueue[0]?.status).toBe('queued');

    setCoordinatorRunPaused(runId, false);
    scheduleCoordinatorPromptDelivery(0, true);
    await vi.runAllTimersAsync();

    expect(mocks.writeToAgentMock).toHaveBeenCalled();
    expect(getCoordinatorRun(runId)?.promptQueue[0]?.status).toBe('delivered');
  });

  it('blocks prompt delivery while the target agent is awaiting input', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const runId = createRunForCoordinatorTask(context);
    addRunningSubtask(runId, 'child');
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

    const response = await queuePrompt(context, runId, 'task-child', 'Please continue');

    expect(response).toMatchObject({
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
    const runId = createRunForCoordinatorTask(context);
    addRunningSubtask(runId, 'child');
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

    const responsePromise = queuePrompt(context, runId, 'task-child', 'First line\nSecond line');

    await Promise.resolve();
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response).toMatchObject({
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
    const runId = createRunForCoordinatorTask(context);
    addRunningSubtask(runId, 'child');
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

    const delivery = queuePrompt(context, runId, 'task-child', 'First line\nSecond line');
    await Promise.resolve();

    cleanupCoordinatorStateForTask(context, 'task-child');
    await vi.runAllTimersAsync();
    await delivery;

    expect(getCoordinatorRun(runId)?.promptQueue[0]).toMatchObject({
      status: 'cancelled',
      waitingReason: 'task-cleaned-up',
    });
  });

  it('deduplicates and bounds pending coordinator prompts per target', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const runId = createRunForCoordinatorTask(context);
    addRunningSubtask(runId, 'child');
    mocks.hasAgentSessionMock.mockReturnValue(false);

    const first = await queuePrompt(context, runId, 'task-child', 'Continue now', {
      dedupeKey: 'stable-prompt',
    });
    const second = await queuePrompt(context, runId, 'task-child', 'Continue now', {
      dedupeKey: 'stable-prompt',
    });

    expect(second).toEqual(first);
    const limits = getCoordinatorRun(runId)?.limits;
    if (!limits) {
      throw new Error('Coordinator run limits missing');
    }
    for (let index = 0; index < limits.maxPendingPromptsPerTarget - 1; index += 1) {
      await queuePrompt(context, runId, 'task-child', `Prompt ${index}`);
    }

    await expect(queuePrompt(context, runId, 'task-child', 'One too many')).rejects.toThrow(
      'Coordinator prompt limit reached for target task',
    );
  });

  it('retries queued prompt delivery after a supervision event reports an idle prompt', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const runId = createRunForCoordinatorTask(context);
    addRunningSubtask(runId, 'child');
    mocks.hasAgentSessionMock.mockReturnValue(true);
    mocks.getAgentMetaMock.mockReturnValue({
      agentId: 'agent-child',
      generation: 1,
      isShell: false,
      taskId: 'task-child',
    });
    mocks.getAgentSupervisionSnapshotMock.mockReturnValue(createSupervisionSnapshot('active'));
    startCoordinatorPromptDeliveryLoop(context);

    const waiting = await queuePrompt(context, runId, 'task-child', 'Continue now');

    expect(waiting).toMatchObject({
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
    expect(getCoordinatorRun(runId)?.promptQueue[0]?.status).toBe('delivered');
    expect(getCoordinatorRun(runId)?.subtasks[0]?.status).toBe('running');
  });

  it('gates idle-at-prompt delivery on the readiness policy against the visible tail', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const runId = createRunForCoordinatorTask(context);
    const policies = ['shell', 'codex', 'terminal-generic'] as const;
    for (const policy of policies) {
      addCoordinatorSubtask({
        agentId: `agent-${policy}`,
        assignment: `Do the ${policy} work`,
        parentCoordinatorTaskId: 'task-coordinator',
        runId,
        startup: createCoordinatorSubtaskStartupSnapshot(
          { command: 'custom-agent', readinessPolicy: policy },
          'delivered',
        ),
        status: 'running',
        taskId: `task-${policy}`,
        toolTokenId: `token-${policy}`,
        worktreePath: `/repo/task-${policy}`,
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
    mocks.getAgentScrollbackBufferMock.mockReturnValue(Buffer.from(CODEX_COMPOSER_TAIL));

    const shellGated = await queuePrompt(context, runId, 'task-shell', 'Continue now');
    expect(shellGated).toMatchObject({
      status: 'waiting-for-terminal-prompt',
      waitingReason: 'agent-quiet',
    });

    const codexDelivered = await queuePrompt(context, runId, 'task-codex', 'Continue now');
    expect(codexDelivered).toMatchObject({ status: 'delivered' });

    const genericDelivered = await queuePrompt(
      context,
      runId,
      'task-terminal-generic',
      'Continue now',
    );
    expect(genericDelivered).toMatchObject({ status: 'delivered' });

    expect(mocks.writeToAgentMock.mock.calls.map((call) => call[0])).toEqual([
      'agent-codex',
      'agent-terminal-generic',
    ]);
  });

  it('rejects follow-up prompts for subtasks whose launch contract disallows them', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const runId = createRunForCoordinatorTask(context);
    addCoordinatorSubtask({
      agentId: 'agent-child',
      assignment: 'Do the work',
      parentCoordinatorTaskId: 'task-coordinator',
      runId,
      startup: createCoordinatorSubtaskStartupSnapshot(
        { command: 'codex', followupPromptMode: 'disallow' },
        'seeded-at-spawn',
      ),
      status: 'running',
      taskId: 'task-child',
      toolTokenId: 'token-child',
      worktreePath: '/repo/task-child',
    });
    mocks.hasAgentSessionMock.mockReturnValue(false);

    await expect(queuePrompt(context, runId, 'task-child', 'Continue now')).rejects.toThrow(
      'targetTaskId does not accept follow-up prompts',
    );
    expect(getCoordinatorRun(runId)?.promptQueue).toEqual([]);

    const initialAssignment = await queuePrompt(context, runId, 'task-child', 'Initial work', {
      kind: 'initial-assignment',
    });
    expect(initialAssignment).toMatchObject({
      kind: 'initial-assignment',
      status: 'waiting-for-agent-session',
    });
  });

  it('mirrors initial-assignment delivery outcomes onto the subtask status', async () => {
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const runId = createRunForCoordinatorTask(context);
    const targets = [
      { agentId: 'agent-delivered', taskId: 'task-delivered' },
      { agentId: 'agent-failed', taskId: 'task-failed' },
      { agentId: 'agent-blocked', taskId: 'task-blocked' },
    ];
    for (const target of targets) {
      addCoordinatorSubtask({
        agentId: target.agentId,
        assignment: 'Do the work',
        parentCoordinatorTaskId: 'task-coordinator',
        runId,
        startup: createCoordinatorSubtaskStartupSnapshot(
          { command: 'custom-agent', initialAssignmentMode: 'post-ready-prompt' },
          'pending-prompt',
        ),
        status: 'waiting-for-agent-ready',
        taskId: target.taskId,
        toolTokenId: `token-${target.taskId}`,
        worktreePath: `/repo/${target.taskId}`,
      });
    }
    mocks.hasAgentSessionMock.mockReturnValue(true);
    mocks.getAgentMetaMock.mockImplementation((agentId: string) => ({
      agentId,
      generation: 1,
      isShell: false,
      taskId: agentId === 'agent-failed' ? 'task-other' : agentId.replace('agent-', 'task-'),
    }));
    mocks.getAgentSupervisionSnapshotMock.mockImplementation((agentId: string) =>
      createSupervisionSnapshot(agentId === 'agent-blocked' ? 'awaiting-input' : 'idle-at-prompt', {
        agentId,
        taskId: agentId.replace('agent-', 'task-'),
      }),
    );

    for (const target of targets) {
      await queuePrompt(context, runId, target.taskId, 'Start the assignment', {
        kind: 'initial-assignment',
      });
    }

    const subtasks = getCoordinatorRun(runId)?.subtasks ?? [];
    expect(subtasks.find((subtask) => subtask.taskId === 'task-delivered')).toMatchObject({
      startup: expect.objectContaining({ initialAssignmentStatus: 'delivered' }),
      status: 'running',
    });
    expect(subtasks.find((subtask) => subtask.taskId === 'task-failed')).toMatchObject({
      result: 'agent-task-mismatch',
      startup: expect.objectContaining({ initialAssignmentStatus: 'failed' }),
      status: 'failed',
    });
    expect(subtasks.find((subtask) => subtask.taskId === 'task-blocked')).toMatchObject({
      startup: expect.objectContaining({ initialAssignmentStatus: 'blocked-by-question' }),
      status: 'waiting-for-user',
    });
  });

  it('requeues a stale delivering prompt with no live delivery owner and delivers it', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const runId = createRunForCoordinatorTask(context);
    addRunningSubtask(runId, 'child');
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

    // A crash between the 'delivering' transition and the terminal status
    // update used to wedge the prompt forever: 'delivering' is not a
    // deliverable status, so no retry sweep would pick it up.
    const prompt = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      runId,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Continue the work',
    });
    updateCoordinatorPrompt(runId, prompt.requestId, {
      deliveryJournal: [
        {
          agentGeneration: 1,
          deliveryAttemptId: 'wedged-attempt',
          ptySessionId: 'agent-child:1',
          requestId: prompt.requestId,
          writePreparedAt: Date.now(),
        },
      ],
      status: 'delivering',
    });

    startCoordinatorPromptDeliveryLoop(context);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      getCoordinatorRun(runId)?.promptQueue.find(
        (candidate) => candidate.requestId === prompt.requestId,
      )?.status,
    ).toBe('delivering');

    await vi.advanceTimersByTimeAsync(STALE_DELIVERING_REQUEUE_MS);
    scheduleCoordinatorPromptDelivery(0, true);
    await vi.runAllTimersAsync();

    const settledPrompt = getCoordinatorRun(runId)?.promptQueue.find(
      (candidate) => candidate.requestId === prompt.requestId,
    );
    expect(settledPrompt?.status).toBe('delivered');
    expect(mocks.writeToAgentMock).toHaveBeenCalled();
    stopCoordinatorPromptDeliveryLoop();
  });

  it('keeps an actively delivering prompt out of the stale requeue sweep', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const runId = createRunForCoordinatorTask(context);
    addRunningSubtask(runId, 'child');
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
    // The multi-write dispatch keeps the prompt in an ACTIVE delivery chain
    // (mid-write delay timers pending) that the sweep must never touch.
    mocks.writeToAgentMock.mockImplementation(() => {});
    const deliveryPromise = queuePrompt(context, runId, 'task-child', `slow\n${'y'.repeat(10)}`);
    await Promise.resolve();
    await Promise.resolve();

    const inFlight = getCoordinatorRun(runId)?.promptQueue[0];
    expect(inFlight?.status).toBe('delivering');

    // The active delivery key keeps the sweep away even past the deadline.
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();
    await deliveryPromise;
    expect(getCoordinatorRun(runId)?.promptQueue[0]?.status).toBe('delivered');
    stopCoordinatorPromptDeliveryLoop();
  });

  it('no-ops scheduled sweeps while detached and clears subscriptions across start/stop cycles', async () => {
    vi.useFakeTimers();
    const env = createStorageEnv();
    envs.push(env);
    const context = createContext(env);
    const runId = createRunForCoordinatorTask(context);
    addRunningSubtask(runId, 'child');
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

    const prompt = enqueueCoordinatorPrompt({
      kind: 'follow-up',
      runId,
      sourceTaskId: 'task-coordinator',
      targetAgentId: 'agent-child',
      targetTaskId: 'task-child',
      text: 'Continue now',
    });
    scheduleCoordinatorPromptDelivery(0);
    await vi.runAllTimersAsync();

    expect(mocks.writeToAgentMock).not.toHaveBeenCalled();
    expect(getCoordinatorRun(runId)?.promptQueue[0]?.status).toBe('queued');

    const delivered = await deliverCoordinatorPromptWithAdmission(context, prompt);
    expect(delivered).toMatchObject({ status: 'delivered' });

    startCoordinatorPromptDeliveryLoop(context);
    expect(mocks.supervisionListeners.size).toBe(1);
    startCoordinatorPromptDeliveryLoop(context);
    expect(mocks.supervisionListeners.size).toBe(1);
    stopCoordinatorPromptDeliveryLoop();
    expect(mocks.supervisionListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    startCoordinatorPromptDeliveryLoop(context);
    expect(mocks.supervisionListeners.size).toBe(1);
    stopCoordinatorPromptDeliveryLoop();
    expect(mocks.supervisionListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(mocks.writeToAgentMock).toHaveBeenCalledTimes(1);
  });
});
