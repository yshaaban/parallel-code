import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  TaskCreationAgentOperationSnapshot,
  TaskCreationClientFacade,
  TaskCreationOperationLiveEventSource,
  TaskCreationOperationLiveMessage,
  TaskCreationTerminalOperationSnapshot,
} from '../domain/task-creation';
import {
  TASK_CREATION_TICKET_TTL_MS,
  type TaskCreationOperationCapability,
  type TaskCreationOperationId,
} from '../domain/task-creation-ticket';
import { TaskCreationController, type TaskCreationSubmission } from './task-creation-controller';
import { saveRemoteTaskCreationCredential } from './task-creation-credentials';

const operationId = Buffer.alloc(16, 0x31).toString('base64url') as TaskCreationOperationId;
const operationCapability = Buffer.alloc(32, 0x42).toString(
  'base64url',
) as TaskCreationOperationCapability;
const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

function createMemoryStorage(options: { failWrites?: boolean } = {}): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => {
      if (options.failWrites) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      values.set(key, value);
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function submission(): TaskCreationSubmission {
  return {
    launch: {
      agentDefId: 'claude-code',
      initialPrompt: 'Implement safely 🚀',
      kind: 'agent',
      skipPermissions: false,
    },
    location: { kind: 'project-root' },
    name: 'reliable-task',
    projectId: 'project-1',
    stepsTracking: true,
  };
}

function taskSummary() {
  return {
    branchLabel: 'feature/reliable-task',
    branchLabelTruncated: false,
    creationStatus: 'ready' as const,
    lifecycle: 'active' as const,
    location: 'project-root' as const,
    name: 'Reliable task',
    nameTruncated: false,
    ownership: 'shared' as const,
    projectId: 'project-1',
    sessionCount: 0,
    taskId: 'task-1',
    taskMode: 'agent' as const,
  };
}

function pendingSnapshot(
  phase: 'cancelled-before-preparation' | 'validating' = 'validating',
  version = phase === 'validating' ? 1 : 2,
): TaskCreationAgentOperationSnapshot {
  return {
    commit: 'not-committed',
    committedTaskId: null,
    committedWorkspaceRevision: null,
    current: {
      catalogVersion: 0,
      serverInstanceId: 'server-1',
      task: null,
      taskClosing: false,
      taskState: 'not-visible',
      workspaceRevision: 4,
    },
    managedArtifactRecovery: { kind: 'none' },
    operationId,
    phase,
    serverInstanceId: 'server-1',
    symlinkWarnings: [],
    taskMode: 'agent',
    version,
  };
}

function activeSnapshot(version = 3): TaskCreationAgentOperationSnapshot {
  return {
    commit: 'committed',
    committedTaskId: 'task-1',
    committedWorkspaceRevision: 5,
    current: {
      catalogVersion: 2,
      serverInstanceId: 'server-1',
      task: taskSummary(),
      taskClosing: false,
      taskState: 'present',
      workspaceRevision: 5,
    },
    managedArtifactRecovery: { kind: 'none' },
    operationId,
    phase: 'active',
    serverInstanceId: 'server-1',
    symlinkWarnings: [],
    taskMode: 'agent',
    version,
  };
}

function terminalRetrySnapshot(): TaskCreationTerminalOperationSnapshot {
  const terminalTask = {
    ...taskSummary(),
    creationStatus: 'needs-attention' as const,
    primarySessionId: 'shell-1',
    sessionCount: 1,
    taskMode: 'terminal' as const,
  };
  return {
    commit: 'committed',
    committedTaskId: 'task-1',
    committedWorkspaceRevision: 5,
    current: {
      catalogVersion: 2,
      serverInstanceId: 'server-1',
      task: terminalTask,
      taskClosing: false,
      taskState: 'present',
      workspaceRevision: 5,
    },
    issue: {
      code: 'launch-failed',
      message: 'The initial terminal launch failed safely.',
      retryable: true,
    },
    managedArtifactRecovery: { kind: 'none' },
    operationId,
    phase: 'created-needs-attention',
    serverInstanceId: 'server-1',
    shellLaunch: {
      current: {
        catalogVersion: 2,
        serverInstanceId: 'server-1',
        session: null,
        task: terminalTask,
        taskClosing: false,
        taskState: 'present',
        workspaceRevision: 5,
      },
      disposition: {
        kind: 'same-tuple-retry',
        reason: 'proven-safe-before-spawn',
        retryUntil: 10_000,
      },
      identity: {
        committedWorkspaceRevision: 5,
        creationOperationId: operationId,
        expectedGeneration: 0,
        operationId: 'launch-1',
        sessionId: 'shell-1',
        taskId: 'task-1',
      },
      phase: 'failed',
      recordVersion: 4,
      replayKind: 'full',
    },
    symlinkWarnings: [],
    taskMode: 'terminal',
    version: 3,
  };
}

function createFacade(): TaskCreationClientFacade {
  return {
    cancel: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    getCapabilities: vi.fn(),
    getPickerPage: vi.fn(),
    getWorktreeLinkCandidates: vi.fn(),
    issue: vi.fn(async () => ({
      expiresAt: 1 + TASK_CREATION_TICKET_TTL_MS,
      issuedAt: 1,
      operationId,
      operationTicket: 'ticket-1',
    })),
    retryShell: vi.fn(),
  };
}

function createLiveHarness(initial: readonly TaskCreationOperationLiveMessage[] = []) {
  let listener: ((message: TaskCreationOperationLiveMessage) => void) | null = null;
  const unsubscribe = vi.fn();
  const source: TaskCreationOperationLiveEventSource = {
    subscribe: vi.fn((_request, nextListener) => {
      listener = nextListener;
      for (const message of initial) nextListener(message);
      return unsubscribe;
    }),
  };
  return {
    emit(message: TaskCreationOperationLiveMessage): void {
      listener?.(message);
    },
    source,
    unsubscribe,
  };
}

describe('TaskCreationController', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: createMemoryStorage(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalSessionStorage) {
      Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
    } else {
      Reflect.deleteProperty(globalThis, 'sessionStorage');
    }
  });

  it('rejects an invalid request before issuing a secure ticket', async () => {
    const facade = createFacade();
    const controller = new TaskCreationController({ facade });

    await controller.submit({ ...submission(), name: '🚀'.repeat(65) });

    expect(facade.issue).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      activity: 'editing',
      credential: null,
      message: 'Review the task details before creating.',
      operation: { snapshot: null },
    });
    controller.dispose();
  });

  it('uses one protected identity across a lost response, status check, and identical retry', async () => {
    const facade = createFacade();
    vi.mocked(facade.create)
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ kind: 'snapshot', outcome: 'replayed', snapshot: activeSnapshot() });
    vi.mocked(facade.get)
      .mockResolvedValueOnce({ kind: 'operation-state-unavailable' })
      .mockResolvedValueOnce({ kind: 'operation-state-unavailable' });
    const controller = new TaskCreationController({ facade, now: () => 100 });

    await controller.submit(submission());
    const uncertain = controller.getSnapshot();
    expect(uncertain).toMatchObject({
      activity: 'tracking',
      canRetryIdentical: true,
      transportOutcomeUnknown: true,
    });
    expect(facade.create).toHaveBeenCalledOnce();
    expect(facade.get).toHaveBeenCalledOnce();
    const originalIntent = vi.mocked(facade.create).mock.calls[0]?.[0];

    await controller.retryIdenticalSubmission();
    expect(facade.create).toHaveBeenCalledTimes(2);
    expect(vi.mocked(facade.create).mock.calls[1]?.[0]).toEqual(originalIntent);
    expect(controller.getSnapshot()).toMatchObject({
      activity: 'tracking',
      credential: null,
      operation: { snapshot: { phase: 'active', version: 3 } },
      transportOutcomeUnknown: false,
    });
    controller.dispose();
  });

  it('does not dispatch Create when exact recovery credentials cannot be persisted', async () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: createMemoryStorage({ failWrites: true }),
    });
    const facade = createFacade();
    const controller = new TaskCreationController({ facade });

    await controller.submit(submission());

    expect(facade.issue).toHaveBeenCalledOnce();
    expect(facade.create).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      activity: 'editing',
      credential: null,
      operation: { snapshot: null },
    });
    expect(controller.getSnapshot().message).toContain('recovery storage is unavailable');
    controller.dispose();
  });

  it('blocks a second submission while a response-unknown credential is unresolved', async () => {
    const facade = createFacade();
    vi.mocked(facade.create).mockRejectedValue(new Error('response lost'));
    vi.mocked(facade.get).mockResolvedValue({ kind: 'operation-state-unavailable' });
    const controller = new TaskCreationController({ facade });

    await controller.submit(submission());
    await controller.submit({ ...submission(), name: 'must-not-start' });

    expect(facade.issue).toHaveBeenCalledOnce();
    expect(facade.create).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      activity: 'tracking',
      credential: { operationId },
      operation: { snapshot: null },
      transportOutcomeUnknown: true,
    });
    controller.dispose();
  });

  it('surfaces validating progress and safely reduces a concurrent Cancel before Create returns', async () => {
    vi.useFakeTimers();
    const facade = createFacade();
    const createResult = deferred<Awaited<ReturnType<TaskCreationClientFacade['create']>>>();
    vi.mocked(facade.create).mockReturnValue(createResult.promise);
    vi.mocked(facade.get).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'found',
      snapshot: pendingSnapshot(),
    });
    vi.mocked(facade.cancel).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'cancelled',
      snapshot: pendingSnapshot('cancelled-before-preparation'),
    });
    const controller = new TaskCreationController({ facade });

    const submitting = controller.submit(submission());
    await vi.waitFor(() => expect(facade.create).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() =>
      expect(controller.getSnapshot().operation.snapshot).toMatchObject({
        phase: 'validating',
        version: 1,
      }),
    );

    await controller.cancel();
    createResult.resolve({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot: pendingSnapshot(),
    });
    await submitting;

    expect(facade.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 1, operationId }),
    );
    expect(controller.getSnapshot().operation.snapshot).toMatchObject({
      phase: 'cancelled-before-preparation',
      version: 2,
    });
    controller.dispose();
  });

  it('keeps one status request in flight and cannot regress a newer Create response', async () => {
    vi.useFakeTimers();
    const facade = createFacade();
    const createResult = deferred<Awaited<ReturnType<TaskCreationClientFacade['create']>>>();
    const firstStatus = deferred<Awaited<ReturnType<TaskCreationClientFacade['get']>>>();
    const staleStatus = deferred<Awaited<ReturnType<TaskCreationClientFacade['get']>>>();
    vi.mocked(facade.create).mockReturnValue(createResult.promise);
    vi.mocked(facade.get)
      .mockReturnValueOnce(firstStatus.promise)
      .mockReturnValueOnce(staleStatus.promise);
    const controller = new TaskCreationController({ facade });

    const submitting = controller.submit(submission());
    await vi.waitFor(() => expect(facade.create).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(facade.get).toHaveBeenCalledOnce();

    firstStatus.resolve({ kind: 'snapshot', outcome: 'found', snapshot: pendingSnapshot() });
    await vi.waitFor(() =>
      expect(controller.getSnapshot().operation.snapshot?.phase).toBe('validating'),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(facade.get).toHaveBeenCalledTimes(2);

    createResult.resolve({ kind: 'snapshot', outcome: 'accepted', snapshot: activeSnapshot(5) });
    await submitting;
    staleStatus.resolve({
      kind: 'snapshot',
      outcome: 'found',
      snapshot: pendingSnapshot('validating', 2),
    });
    await vi.waitFor(() => expect(controller.getSnapshot().operation.snapshot?.version).toBe(5));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(controller.getSnapshot().operation.snapshot).toMatchObject({
      phase: 'active',
      version: 5,
    });
    expect(facade.get).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('ignores late status and Create callbacks after disposal', async () => {
    vi.useFakeTimers();
    const facade = createFacade();
    const createResult = deferred<Awaited<ReturnType<TaskCreationClientFacade['create']>>>();
    const statusResult = deferred<Awaited<ReturnType<TaskCreationClientFacade['get']>>>();
    vi.mocked(facade.create).mockReturnValue(createResult.promise);
    vi.mocked(facade.get).mockReturnValue(statusResult.promise);
    const controller = new TaskCreationController({ facade });

    const submitting = controller.submit(submission());
    await vi.waitFor(() => expect(facade.create).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(facade.get).toHaveBeenCalledOnce());
    controller.dispose();
    statusResult.resolve({ kind: 'snapshot', outcome: 'found', snapshot: pendingSnapshot() });
    createResult.resolve({ kind: 'snapshot', outcome: 'accepted', snapshot: activeSnapshot() });
    await submitting;

    expect(controller.getSnapshot().operation.snapshot).toBeNull();
  });

  it('keeps a reloaded absent operation protected until a post-expiry absence proof', async () => {
    let monotonicNow = 0;
    let wallNow = 100;
    const firstFacade = createFacade();
    vi.mocked(firstFacade.create).mockRejectedValueOnce(new Error('response lost'));
    vi.mocked(firstFacade.get).mockResolvedValue({ kind: 'operation-state-unavailable' });
    const firstController = new TaskCreationController({
      facade: firstFacade,
      monotonicNow: () => monotonicNow,
      now: () => wallNow,
    });

    await firstController.submit(submission());
    expect(sessionStorage.getItem('parallel-code.remote-task-creation.v1')).not.toContain(
      'Implement safely',
    );
    expect(sessionStorage.getItem('parallel-code.remote-task-creation.v1')).not.toContain(
      'ticket-1',
    );
    firstController.dispose();

    const recoveredFacade = createFacade();
    vi.mocked(recoveredFacade.get).mockResolvedValue({ kind: 'operation-state-unavailable' });
    const recoveredController = new TaskCreationController({
      facade: recoveredFacade,
      monotonicNow: () => monotonicNow,
      now: () => wallNow,
    });
    await recoveredController.recoverStoredOperation();
    expect(recoveredController.getSnapshot()).toMatchObject({
      activity: 'tracking',
      canRetryIdentical: false,
      credential: { operationId },
      transportOutcomeUnknown: true,
    });

    wallNow = Number.MAX_SAFE_INTEGER;
    recoveredController.startOver();
    expect(recoveredController.getSnapshot()).toMatchObject({
      activity: 'tracking',
      credential: { operationId },
    });

    await recoveredController.refreshStatus();
    expect(recoveredController.getSnapshot().credential).toMatchObject({ operationId });

    monotonicNow = TASK_CREATION_TICKET_TTL_MS;
    await recoveredController.refreshStatus();
    expect(recoveredController.getSnapshot()).toMatchObject({
      activity: 'editing',
      credential: null,
      operation: { snapshot: null },
      transportOutcomeUnknown: false,
    });
    expect(sessionStorage.getItem('parallel-code.remote-task-creation.v1')).toBeNull();
    recoveredController.dispose();
  });

  it('uses one recovery proof and one deadline proof without periodic polling on a healthy channel', async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    expect(saveRemoteTaskCreationCredential({ operationCapability, operationId })).toBe(true);
    const facade = createFacade();
    const recoveryProof = deferred<Awaited<ReturnType<TaskCreationClientFacade['get']>>>();
    vi.mocked(facade.get)
      .mockReturnValueOnce(recoveryProof.promise)
      .mockResolvedValueOnce({ kind: 'operation-state-unavailable' });
    const live = createLiveHarness([{ kind: 'connection-state', state: 'connected' }]);
    const controller = new TaskCreationController({
      facade,
      liveEvents: live.source,
      monotonicNow: () => monotonicNow,
    });

    const recovering = controller.recoverStoredOperation();
    expect(facade.get).toHaveBeenCalledOnce();
    const recoverySignal = vi.mocked(facade.get).mock.calls[0]?.[1];
    live.emit({ kind: 'subscription-state', state: 'ready' });
    expect(recoverySignal?.aborted).toBe(false);
    recoveryProof.resolve({ kind: 'operation-state-unavailable' });
    await recovering;

    await vi.advanceTimersByTimeAsync(TASK_CREATION_TICKET_TTL_MS - 1);
    expect(facade.get).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().credential).toMatchObject({ operationId });

    monotonicNow = TASK_CREATION_TICKET_TTL_MS;
    await vi.advanceTimersByTimeAsync(1);
    expect(facade.get).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      activity: 'editing',
      credential: null,
      operation: { snapshot: null },
      transportOutcomeUnknown: false,
    });
    expect(live.unsubscribe).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('surfaces a wrong stored capability from the required recovery proof', async () => {
    expect(saveRemoteTaskCreationCredential({ operationCapability, operationId })).toBe(true);
    const facade = createFacade();
    vi.mocked(facade.get).mockResolvedValue({
      code: 'capability-denied',
      kind: 'lookup-rejected-without-snapshot',
    });
    const live = createLiveHarness([
      { kind: 'connection-state', state: 'connected' },
      { kind: 'subscription-state', state: 'ready' },
    ]);
    const controller = new TaskCreationController({ facade, liveEvents: live.source });

    await controller.recoverStoredOperation();

    expect(facade.get).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      activity: 'tracking',
      credential: { operationId },
      operation: { overlay: { code: 'capability-denied', kind: 'lookup-rejected' } },
    });
    expect(controller.getSnapshot().message).toContain('restricted');
    controller.dispose();
  });

  it('performs one immediate proof and one deadline proof after a lost Create on a healthy channel', async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    const facade = createFacade();
    vi.mocked(facade.create).mockRejectedValue(new Error('response lost'));
    vi.mocked(facade.get).mockResolvedValue({ kind: 'operation-state-unavailable' });
    const live = createLiveHarness([
      { kind: 'connection-state', state: 'connected' },
      { kind: 'subscription-state', state: 'ready' },
    ]);
    const controller = new TaskCreationController({
      facade,
      liveEvents: live.source,
      monotonicNow: () => monotonicNow,
    });

    await controller.submit(submission());
    expect(facade.get).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(TASK_CREATION_TICKET_TTL_MS - 1);
    expect(facade.get).toHaveBeenCalledOnce();

    monotonicNow = TASK_CREATION_TICKET_TTL_MS;
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(facade.get).toHaveBeenCalledTimes(2));
    expect(controller.getSnapshot()).toMatchObject({ activity: 'editing', credential: null });
    controller.dispose();
  });

  it('degrades a synchronous live-subscription failure without suppressing Create or recovery', async () => {
    vi.useFakeTimers();
    const source: TaskCreationOperationLiveEventSource = {
      subscribe: vi.fn(() => {
        throw new Error('live source unavailable');
      }),
    };
    const submitFacade = createFacade();
    const createResult = deferred<Awaited<ReturnType<TaskCreationClientFacade['create']>>>();
    vi.mocked(submitFacade.create).mockReturnValue(createResult.promise);
    vi.mocked(submitFacade.get).mockResolvedValue({ kind: 'operation-state-unavailable' });
    const submitController = new TaskCreationController({
      facade: submitFacade,
      liveEvents: source,
    });

    const submitting = submitController.submit(submission());
    await Promise.resolve();
    await Promise.resolve();
    expect(submitFacade.create).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(submitFacade.get).toHaveBeenCalledOnce();
    createResult.resolve({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot: pendingSnapshot(),
    });
    await expect(submitting).resolves.toBeUndefined();
    submitController.dispose();

    sessionStorage.clear();
    expect(saveRemoteTaskCreationCredential({ operationCapability, operationId })).toBe(true);
    const recoveryFacade = createFacade();
    vi.mocked(recoveryFacade.get).mockResolvedValue({ kind: 'operation-state-unavailable' });
    const recoveryController = new TaskCreationController({
      facade: recoveryFacade,
      liveEvents: source,
    });

    await expect(recoveryController.recoverStoredOperation()).resolves.toBeUndefined();
    expect(recoveryFacade.get).toHaveBeenCalledOnce();
    expect(recoveryController.getSnapshot().credential).toMatchObject({ operationId });
    recoveryController.dispose();
  });

  it('contains a throwing live unsubscribe while clearing a completed operation', async () => {
    const facade = createFacade();
    vi.mocked(facade.create).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot: activeSnapshot(),
    });
    const unsubscribe = vi.fn(() => {
      throw new Error('transport cleanup failed');
    });
    const source: TaskCreationOperationLiveEventSource = {
      subscribe: vi.fn((_request, listener) => {
        listener({ kind: 'connection-state', state: 'connected' });
        listener({ kind: 'subscription-state', state: 'ready' });
        return unsubscribe;
      }),
    };
    const controller = new TaskCreationController({ facade, liveEvents: source });

    await expect(controller.submit(submission())).resolves.toBeUndefined();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      credential: null,
      operation: { snapshot: {} },
    });
    expect(() => controller.dispose()).not.toThrow();
  });

  it('immediately proves an ambiguous Cancel response without enabling healthy polling', async () => {
    const facade = createFacade();
    vi.mocked(facade.create).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot: pendingSnapshot(),
    });
    vi.mocked(facade.cancel).mockRejectedValue(new Error('cancel response lost'));
    vi.mocked(facade.get).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'found',
      snapshot: pendingSnapshot('cancelled-before-preparation'),
    });
    const live = createLiveHarness([
      { kind: 'connection-state', state: 'connected' },
      { kind: 'subscription-state', state: 'ready' },
    ]);
    const controller = new TaskCreationController({ facade, liveEvents: live.source });
    await controller.submit(submission());
    const listener = vi.fn();
    const stopListening = controller.subscribe(listener);
    listener.mockClear();

    await controller.cancel();

    expect(facade.get).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(4);
    expect(controller.getSnapshot().operation.snapshot).toMatchObject({
      phase: 'cancelled-before-preparation',
      version: 2,
    });
    stopListening();
    controller.dispose();
  });

  it('immediately proves an ambiguous identical retry response on the same identity', async () => {
    const facade = createFacade();
    vi.mocked(facade.create)
      .mockRejectedValueOnce(new Error('create response lost'))
      .mockRejectedValueOnce(new Error('retry response lost'));
    vi.mocked(facade.get)
      .mockResolvedValueOnce({ kind: 'operation-state-unavailable' })
      .mockResolvedValueOnce({ kind: 'operation-state-unavailable' })
      .mockResolvedValueOnce({ kind: 'snapshot', outcome: 'found', snapshot: activeSnapshot() });
    const live = createLiveHarness([
      { kind: 'connection-state', state: 'connected' },
      { kind: 'subscription-state', state: 'ready' },
    ]);
    const controller = new TaskCreationController({ facade, liveEvents: live.source });
    await controller.submit(submission());

    await controller.retryIdenticalSubmission();

    expect(facade.create).toHaveBeenCalledTimes(2);
    expect(facade.get).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot()).toMatchObject({
      credential: null,
      operation: { snapshot: { phase: 'active' } },
      transportOutcomeUnknown: false,
    });
    controller.dispose();
  });

  it('immediately joins creation status after an ambiguous shell-retry response', async () => {
    const facade = createFacade();
    const snapshot = terminalRetrySnapshot();
    vi.mocked(facade.create).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot,
    });
    vi.mocked(facade.retryShell).mockRejectedValue(new Error('shell response lost'));
    vi.mocked(facade.get).mockResolvedValue({ kind: 'snapshot', outcome: 'found', snapshot });
    const live = createLiveHarness([
      { kind: 'connection-state', state: 'connected' },
      { kind: 'subscription-state', state: 'ready' },
    ]);
    const controller = new TaskCreationController({ facade, liveEvents: live.source });
    await controller.submit({
      launch: { kind: 'terminal' },
      location: { kind: 'project-root' },
      name: 'terminal-task',
      projectId: 'project-1',
      stepsTracking: false,
    });

    await controller.retryShell();

    expect(facade.get).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().operation.snapshot).toMatchObject({
      phase: 'created-needs-attention',
      taskMode: 'terminal',
    });
    controller.dispose();
  });

  it('sends cancellation with the trusted version and applies the canonical result', async () => {
    const facade = createFacade();
    vi.mocked(facade.create).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot: pendingSnapshot(),
    });
    vi.mocked(facade.cancel).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'cancelled',
      snapshot: pendingSnapshot('cancelled-before-preparation'),
    });
    const controller = new TaskCreationController({ facade });

    await controller.submit(submission());
    const credential = controller.getSnapshot().credential;
    expect(credential).not.toBeNull();
    await controller.cancel();
    expect(facade.cancel).toHaveBeenCalledWith({
      ...credential,
      expectedVersion: 1,
    });
    expect(controller.getSnapshot().operation.snapshot).toMatchObject({
      phase: 'cancelled-before-preparation',
      version: 2,
    });
    controller.dispose();
  });

  it('retries the shell operation identity with the separate creation capability', async () => {
    const facade = createFacade();
    const snapshot = terminalRetrySnapshot();
    const shellLaunch = snapshot.shellLaunch;
    if (!shellLaunch) throw new Error('Terminal retry fixture requires a shell operation');
    vi.mocked(facade.create).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot,
    });
    vi.mocked(facade.retryShell).mockResolvedValue({
      outcome: 'accepted',
      shellLaunch,
    });
    const controller = new TaskCreationController({ facade });

    await controller.submit({
      launch: { kind: 'terminal' },
      location: { kind: 'project-root' },
      name: 'terminal-task',
      projectId: 'project-1',
      stepsTracking: false,
    });
    const credential = controller.getSnapshot().credential;
    expect(credential).not.toBeNull();

    await controller.retryShell();

    expect(facade.retryShell).toHaveBeenCalledWith({
      action: 'retry-same-tuple',
      expectedRecordVersion: 4,
      operationCapability: credential?.operationCapability,
      operationId: 'launch-1',
    });
    expect(credential?.operationId).toBe(operationId);
    expect(credential?.operationId).not.toBe('launch-1');
    controller.dispose();
  });

  it('merges a shell retry response into newer live operation truth', async () => {
    const facade = createFacade();
    const snapshot = terminalRetrySnapshot();
    const retryResult = deferred<Awaited<ReturnType<TaskCreationClientFacade['retryShell']>>>();
    vi.mocked(facade.create).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot,
    });
    vi.mocked(facade.retryShell).mockReturnValue(retryResult.promise);
    const controller = new TaskCreationController({ facade });

    await controller.submit({
      launch: { kind: 'terminal' },
      location: { kind: 'project-root' },
      name: 'terminal-task',
      projectId: 'project-1',
      stepsTracking: false,
    });
    const retryPromise = controller.retryShell();
    const task = snapshot.current.task;
    const shellLaunch = snapshot.shellLaunch;
    if (!task || !shellLaunch) throw new Error('Terminal retry fixture is incomplete');
    const closingTask = { ...task, lifecycle: 'closing' as const };
    controller.applySnapshot({
      ...snapshot,
      current: {
        ...snapshot.current,
        catalogVersion: 7,
        task: closingTask,
        taskClosing: true,
        workspaceRevision: 8,
      },
      shellLaunch: {
        ...shellLaunch,
        current: {
          ...shellLaunch.current,
          catalogVersion: 7,
          task: closingTask,
          taskClosing: true,
          workspaceRevision: 8,
        },
      },
      version: 4,
    });
    retryResult.resolve({
      outcome: 'accepted',
      shellLaunch: {
        ...shellLaunch,
        recordVersion: 5,
      },
    });
    await retryPromise;

    expect(controller.getSnapshot().operation.snapshot).toMatchObject({
      current: { catalogVersion: 7, taskClosing: true, workspaceRevision: 8 },
      shellLaunch: {
        current: { catalogVersion: 7, taskClosing: true, workspaceRevision: 8 },
        recordVersion: 5,
      },
      version: 4,
    });
    controller.dispose();
  });

  it('rejects a malformed ticket before creating or retaining an operation', async () => {
    const facade = createFacade();
    vi.mocked(facade.issue).mockResolvedValue({
      expiresAt: 10_000,
      issuedAt: 1,
      operationId,
      operationTicket: '',
    });
    const controller = new TaskCreationController({ facade });

    await controller.submit(submission());
    expect(facade.create).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      activity: 'editing',
      credential: null,
      operation: { snapshot: null },
    });
    controller.dispose();
  });

  it('keeps the latest operation truth when a stale bound snapshot arrives', async () => {
    const facade = createFacade();
    vi.mocked(facade.create).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot: pendingSnapshot('validating', 5),
    });
    const controller = new TaskCreationController({ facade });
    await controller.submit(submission());
    const staleSnapshot: TaskCreationAgentOperationSnapshot = {
      commit: 'not-committed',
      committedTaskId: null,
      committedWorkspaceRevision: null,
      current: {
        catalogVersion: 7,
        serverInstanceId: 'server-1',
        task: null,
        taskClosing: false,
        taskState: 'not-visible',
        workspaceRevision: 5,
      },
      managedArtifactRecovery: { kind: 'none' },
      operationId,
      phase: 'validating',
      serverInstanceId: 'server-1',
      symlinkWarnings: [],
      taskMode: 'agent',
      version: 4,
    };
    controller.applySnapshot(staleSnapshot);

    expect(controller.getSnapshot().operation.snapshot).toMatchObject({
      current: { catalogVersion: 0, taskClosing: false },
      phase: 'validating',
      version: 5,
    });
    controller.dispose();
  });
});
