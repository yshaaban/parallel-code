import { describe, expect, it, vi } from 'vitest';

import type {
  IssuedTaskNotesOperation,
  TaskNotesCurrentEnvelope,
  UpdateTaskNotesRequest,
} from '../../src/domain/task-notes.js';
import { createIntendedTaskNotesWriterEntitlements } from '../../tests/harness/task-notes-writer-entitlements.js';
import { createTaskNotesWriterEntitlements } from './task-notes-writer-entitlements.js';
import {
  WorkspaceMutationDurabilityError,
  WorkspaceMutationNotCommittedError,
  WorkspaceMutationRecoveryError,
  type WorkspaceHostMutationSlices,
  type WorkspaceMutationDecision,
  type WorkspaceMutationRequest,
  type WorkspaceMutationResult,
  type WorkspacePrivateSnapshotAuthority,
} from './workspace-state-mutations.js';
import type { JsonObject } from './workspace-state-storage.js';
import {
  TASK_NOTES_ADMISSION_WINDOW_MS,
  TASK_NOTES_REPLAY_WINDOW_MS,
  classifyTaskNotesOperation,
  createEmptyTaskNotesOperationSegment,
  createTaskNotesContentVersion,
  deriveTaskNotesIncarnation,
  findTaskNotesOperationRecord,
  hashTaskNotesPrincipal,
  readTaskNotesOperationSegment,
  replaceTaskNotesOperationRecord,
  withTaskNotesOperationSegment,
} from './task-notes-operations.js';
import {
  TaskNotesService,
  createTaskNotesPrincipalContext,
  type TaskNotesCommonReadiness,
  type TaskNotesCurrentCollection,
  type TaskNotesMutationAdmission,
  type TaskNotesMutationLease,
  type TaskNotesPrincipalContext,
  type TaskNotesServiceOptions,
  type TaskNotesStructuralAuthority,
} from './task-notes-service.js';

const TASK_ID = 'task-1';
const STARTED_AT = Date.UTC(2026, 7, 3, 0, 0, 0);
const SERVER_INSTANCE_ID = '00000000-0000-4000-8000-000000000001';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class MemoryWorkspace implements WorkspacePrivateSnapshotAuthority {
  private readonly afterDecisionFaults = new Map<string, unknown[]>();
  private readonly beforeMutationHooks = new Map<string, Array<() => Promise<void> | void>>();
  readonly operations: string[] = [];
  readonly inspections: string[] = [];
  readonly warningOperations = new Set<string>();
  privateState: JsonObject = withTaskNotesOperationSegment(
    {},
    createEmptyTaskNotesOperationSegment(),
  );
  revision = 0;
  sharedState: JsonObject = { tasks: { [TASK_ID]: { id: TASK_ID, notes: '' } } };

  failAfterDecision(operation: string, error: unknown): void {
    const failures = this.afterDecisionFaults.get(operation) ?? [];
    failures.push(error);
    this.afterDecisionFaults.set(operation, failures);
  }

  beforeMutation(operation: string, hook: () => Promise<void> | void): void {
    const hooks = this.beforeMutationHooks.get(operation) ?? [];
    hooks.push(hook);
    this.beforeMutationHooks.set(operation, hooks);
  }

  async inspect<TResult>(
    request: WorkspaceMutationRequest,
    inspector: (slices: Readonly<WorkspaceHostMutationSlices>) => TResult,
  ): Promise<TResult> {
    this.inspections.push(request.operation);
    const result = inspector({
      localState: {},
      payloadDigest: '0'.repeat(64),
      privateState: clone(this.privateState),
      sharedRevision: this.revision,
      sharedState: clone(this.sharedState),
      storageGeneration: String(this.operations.length),
    });
    const failures = this.afterDecisionFaults.get(request.operation);
    const failure = failures?.shift();
    if (failure) throw failure;
    return result;
  }

  async mutate<TResult>(
    request: WorkspaceMutationRequest,
    mutator: (slices: Readonly<WorkspaceHostMutationSlices>) => WorkspaceMutationDecision<TResult>,
  ): Promise<WorkspaceMutationResult<TResult>> {
    this.operations.push(request.operation);
    const hooks = this.beforeMutationHooks.get(request.operation);
    const hook = hooks?.shift();
    if (hook) await hook();

    const decision = mutator({
      localState: {},
      payloadDigest: '0'.repeat(64),
      privateState: clone(this.privateState),
      sharedRevision: this.revision,
      sharedState: clone(this.sharedState),
      storageGeneration: String(this.operations.length),
    });
    const failures = this.afterDecisionFaults.get(request.operation);
    const failure = failures?.shift();
    if (failure) throw failure;

    if (decision.kind === 'changed') {
      if (decision.nextPrivateState) this.privateState = clone(decision.nextPrivateState);
      if (decision.nextSharedState) {
        this.sharedState = clone(decision.nextSharedState);
        this.revision += 1;
      }
    }
    return {
      changed: decision.kind === 'changed',
      result: decision.result,
      revision: this.revision,
      ...(this.warningOperations.has(request.operation)
        ? {
            warning: {
              code: 'projection-repair-required' as const,
              messages: ['injected projection failure'],
            },
          }
        : {}),
    };
  }
}

class StructuralHarness implements TaskNotesStructuralAuthority {
  admission: Exclude<TaskNotesMutationAdmission, { kind: 'admitted' }> | null = null;
  admissionCount = 0;
  collectOverride: TaskNotesCurrentCollection | null = null;
  currentWitness = hashTaskNotesPrincipal('task-1-witness');
  readonly errors: unknown[] = [];
  readonly order: string[] = [];
  readonly released: string[] = [];
  readonly retained: Array<{
    operationId: string;
    proposal: Parameters<TaskNotesMutationLease['retainUntilHostDurable']>[0];
  }> = [];
  readonly retainedRetryWindows: string[] = [];
  readiness: TaskNotesCommonReadiness = {
    generation: 'generation-1',
    kind: 'ready',
    writable: true,
  };
  taskClosing = false;
  taskVisible = true;
  onAdmit: (() => Promise<void> | void) | undefined;

  constructor(readonly workspace: MemoryWorkspace) {}

  async admitTaskMutationSet(args: {
    operationId: string;
    readinessGeneration: string;
    taskIds: readonly string[];
  }): Promise<TaskNotesMutationAdmission> {
    this.admissionCount += 1;
    this.order.push('admit');
    await this.onAdmit?.();
    if (this.admission) return this.admission;
    let retained = false;
    return {
      kind: 'admitted',
      lease: {
        release: () => {
          if (retained) throw new Error('A retained task-notes lease cannot be released directly');
          this.order.push('release');
          this.released.push(args.operationId);
        },
        retainUntilHostDurable: (proposal) => {
          retained = true;
          this.order.push(`retain:${proposal}`);
          this.retained.push({ operationId: args.operationId, proposal });
        },
        retainUntilRetryWindowMaterialized: () => {
          retained = true;
          this.order.push('retain:retry-window-materialization');
          this.retainedRetryWindows.push(args.operationId);
        },
      },
    };
  }

  async collectTaskNotesCurrentEnvelope(args: {
    expectedTaskIdentityWitness?: string;
    readinessGeneration: string;
    taskId: string;
  }): Promise<TaskNotesCurrentCollection> {
    this.order.push('collect');
    if (this.collectOverride) return this.collectOverride;
    if (!this.taskVisible) return { kind: 'collected', current: this.notVisibleEnvelope() };

    const tasks = this.workspace.sharedState.tasks as JsonObject;
    const task = tasks[args.taskId] as JsonObject | undefined;
    if (!task) return { kind: 'collected', current: this.removedEnvelope() };
    const taskIncarnation = deriveTaskNotesIncarnation(this.currentWitness);
    if (
      args.expectedTaskIdentityWitness &&
      args.expectedTaskIdentityWitness !== this.currentWitness
    ) {
      return { kind: 'collected', current: this.replacedEnvelope(taskIncarnation) };
    }
    const notes = task.notes;
    if (typeof notes !== 'string') throw new Error('invalid fixture notes');
    return {
      kind: 'collected',
      current: {
        relation: 'same-incarnation',
        currentNotes: {
          kind: 'present',
          snapshot: {
            taskId: args.taskId,
            taskIncarnation,
            notes,
            contentVersion: createTaskNotesContentVersion(notes),
            workspaceRevision: this.workspace.revision,
          },
        },
        currentTask: {
          serverInstanceId: SERVER_INSTANCE_ID,
          catalogVersion: this.workspace.revision,
          taskState: 'present',
          taskClosing: this.taskClosing,
          taskIncarnation,
        },
      },
      taskIdentityWitness: this.currentWitness,
    };
  }

  getTaskNotesCommonReadiness(): TaskNotesCommonReadiness {
    return this.readiness;
  }

  reportTaskNotesCanonicalStateFailure(error: unknown): void {
    this.errors.push(error);
  }

  recheckTaskIdentityWitness(
    _slices: Readonly<{
      localState: JsonObject;
      privateState: JsonObject;
      sharedRevision: number;
      sharedState: JsonObject;
    }>,
    _taskId: string,
    expectedTaskIdentityWitness: string,
  ) {
    return expectedTaskIdentityWitness === this.currentWitness
      ? ({ kind: 'same-incarnation' } as const)
      : ({ kind: 'task-incarnation-changed' } as const);
  }

  private removedEnvelope(): TaskNotesCurrentEnvelope {
    return {
      relation: 'task-removed',
      currentNotes: {
        kind: 'unavailable',
        reason: 'task-removed',
        workspaceRevision: this.workspace.revision,
      },
      currentTask: {
        serverInstanceId: SERVER_INSTANCE_ID,
        catalogVersion: this.workspace.revision,
        taskClosing: false,
        taskState: 'removed',
      },
    };
  }

  private notVisibleEnvelope(): TaskNotesCurrentEnvelope {
    return {
      relation: 'task-not-visible',
      currentNotes: {
        kind: 'unavailable',
        reason: 'task-not-visible',
        workspaceRevision: this.workspace.revision,
      },
      currentTask: {
        serverInstanceId: SERVER_INSTANCE_ID,
        catalogVersion: this.workspace.revision,
        taskClosing: false,
        taskState: 'not-visible',
      },
    };
  }

  private replacedEnvelope(taskIncarnation: string): TaskNotesCurrentEnvelope {
    return {
      relation: 'task-replaced',
      currentNotes: {
        kind: 'unavailable',
        reason: 'task-replaced',
        workspaceRevision: this.workspace.revision,
      },
      currentTask: {
        serverInstanceId: SERVER_INSTANCE_ID,
        catalogVersion: this.workspace.revision,
        taskClosing: this.taskClosing,
        taskIncarnation,
        taskState: 'present',
      },
    };
  }
}

interface Harness {
  now: { value: number };
  principal: TaskNotesPrincipalContext;
  service: TaskNotesService;
  structural: StructuralHarness;
  workspace: MemoryWorkspace;
}

function createHarness(options: TaskNotesServiceOptions = {}): Harness {
  const now = { value: STARTED_AT };
  const workspace = new MemoryWorkspace();
  const structural = new StructuralHarness(workspace);
  let randomValue = 1;
  const service = new TaskNotesService(workspace, structural, {
    ...options,
    now: () => now.value,
    randomBytes: (size) => new Uint8Array(size).fill(randomValue++),
    writerEntitlements:
      options.writerEntitlements ?? createIntendedTaskNotesWriterEntitlements(['desktop']),
  });
  return {
    now,
    principal: createTaskNotesPrincipalContext('workspace-principal', 'client-1', 'desktop'),
    service,
    structural,
    workspace,
  };
}

async function issueOperation(harness: Harness): Promise<IssuedTaskNotesOperation> {
  const response = await harness.service.issueTaskNotesOperation(harness.principal, {
    taskId: TASK_ID,
    taskIncarnation: deriveTaskNotesIncarnation(harness.structural.currentWitness),
  });
  if (!response.ok || response.result.kind !== 'issued') {
    throw new Error(`Expected issued operation, received ${JSON.stringify(response)}`);
  }
  return response.result.operation;
}

function updateRequest(
  harness: Harness,
  operation: IssuedTaskNotesOperation,
  overrides: Partial<UpdateTaskNotesRequest> = {},
): UpdateTaskNotesRequest {
  const task = (harness.workspace.sharedState.tasks as JsonObject)[TASK_ID] as JsonObject;
  const notes = task.notes as string;
  return {
    taskId: TASK_ID,
    taskIncarnation: deriveTaskNotesIncarnation(harness.structural.currentWitness),
    notes: 'updated notes',
    baseContentVersion: createTaskNotesContentVersion(notes),
    operationId: operation.operationId,
    operationCapability: operation.operationCapability,
    ...overrides,
  };
}

function terminalRecord(harness: Harness, operation: IssuedTaskNotesOperation) {
  return findTaskNotesOperationRecord(
    readTaskNotesOperationSegment(harness.workspace.privateState),
    harness.principal.principalHash,
    operation.operationId,
  );
}

function admitForRecovery(
  harness: Harness,
  operation: IssuedTaskNotesOperation,
  request: UpdateTaskNotesRequest,
): void {
  const segment = readTaskNotesOperationSegment(harness.workspace.privateState);
  const issued = findTaskNotesOperationRecord(
    segment,
    harness.principal.principalHash,
    operation.operationId,
  );
  const classified = classifyTaskNotesOperation(issued, {
    now: harness.now.value,
    principalHash: harness.principal.principalHash,
    request,
  });
  if (classified.kind !== 'admit') throw new Error('fixture did not admit');
  harness.workspace.privateState = withTaskNotesOperationSegment(
    harness.workspace.privateState,
    replaceTaskNotesOperationRecord(segment, classified.record),
  );
}

function deferredGate(): { promise: Promise<void>; release(): void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release: () => release?.(),
  };
}

describe('TaskNotesService reads and issuance', () => {
  it('keeps direct service writes dark without an exact composition entitlement', async () => {
    const workspace = new MemoryWorkspace();
    const structural = new StructuralHarness(workspace);
    const service = new TaskNotesService(workspace, structural);
    const principal = createTaskNotesPrincipalContext('workspace-principal', 'client-1', 'desktop');

    await expect(
      service.issueTaskNotesOperation(principal, {
        taskId: TASK_ID,
        taskIncarnation: deriveTaskNotesIncarnation(structural.currentWitness),
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(structural.order).toEqual([]);
    expect(workspace.operations).toEqual([]);
  });

  it('cannot be enabled by replacing a mutable outer entitlement after composition', async () => {
    const workspace = new MemoryWorkspace();
    const structural = new StructuralHarness(workspace);
    const dark = createTaskNotesWriterEntitlements();
    const source = { desktop: dark.desktop, remote: dark.remote };
    const service = new TaskNotesService(workspace, structural, {
      writerEntitlements: source,
    });
    const principal = createTaskNotesPrincipalContext('workspace-principal', 'client-1', 'desktop');

    source.desktop = createIntendedTaskNotesWriterEntitlements(['desktop']).desktop;

    await expect(
      service.issueTaskNotesOperation(principal, {
        taskId: TASK_ID,
        taskIncarnation: deriveTaskNotesIncarnation(structural.currentWitness),
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(structural.order).toEqual([]);
    expect(workspace.operations).toEqual([]);
  });

  it('loads only a coherent current envelope and authenticates every method', async () => {
    const harness = createHarness();

    await expect(
      harness.service.getTaskNotes(harness.principal, { taskId: TASK_ID }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ kind: 'loaded' }),
      }),
    );
    await expect(
      harness.service.getTaskNotes({ principalHash: 'invalid' }, { taskId: TASK_ID }),
    ).resolves.toEqual({ ok: false, error: { code: 'unauthenticated' } });
    expect(createTaskNotesPrincipalContext('p', 'unsafe source')).toEqual({
      principalHash: hashTaskNotesPrincipal('p'),
      sourceId: null,
    });
  });

  it('keeps pre-barrier reads and writes out of collectors and storage', async () => {
    const harness = createHarness();
    harness.structural.readiness = { kind: 'unavailable', retryAfterMs: 750 };

    await expect(
      harness.service.getTaskNotes(harness.principal, { taskId: TASK_ID }),
    ).resolves.toEqual({
      ok: true,
      result: { kind: 'task-state-unavailable', retryAfterMs: 750 },
    });
    await expect(
      harness.service.issueTaskNotesOperation(harness.principal, {
        taskId: TASK_ID,
        taskIncarnation: deriveTaskNotesIncarnation(harness.structural.currentWitness),
      }),
    ).resolves.toEqual({
      ok: true,
      result: { kind: 'task-state-unavailable', retryAfterMs: 750 },
    });
    expect(harness.structural.order).toEqual([]);
    expect(harness.workspace.operations).toEqual([]);
  });

  it('returns precise absent, hidden, and incarnation-changed Issue outcomes without writing', async () => {
    const harness = createHarness();
    Reflect.deleteProperty(harness.workspace.sharedState.tasks as JsonObject, TASK_ID);
    await expect(
      harness.service.issueTaskNotesOperation(harness.principal, {
        taskId: TASK_ID,
        taskIncarnation: deriveTaskNotesIncarnation(harness.structural.currentWitness),
      }),
    ).resolves.toEqual({ ok: true, result: { kind: 'not-found' } });

    (harness.workspace.sharedState.tasks as JsonObject)[TASK_ID] = { id: TASK_ID, notes: '' };
    harness.structural.taskVisible = false;
    await expect(
      harness.service.issueTaskNotesOperation(harness.principal, {
        taskId: TASK_ID,
        taskIncarnation: deriveTaskNotesIncarnation(harness.structural.currentWitness),
      }),
    ).resolves.toEqual({ ok: true, result: { kind: 'not-visible' } });

    harness.structural.taskVisible = true;
    await expect(
      harness.service.issueTaskNotesOperation(harness.principal, {
        taskId: TASK_ID,
        taskIncarnation: hashTaskNotesPrincipal('stale-incarnation'),
      }),
    ).resolves.toEqual({ ok: true, result: { kind: 'task-incarnation-changed' } });
    expect(harness.workspace.operations).toEqual([]);
  });

  it('atomically issues an opaque operation and persists no capability secret', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    const record = terminalRecord(harness, operation);

    expect(record).toMatchObject({
      operationId: operation.operationId,
      principalHash: harness.principal.principalHash,
      state: 'issued',
      taskId: TASK_ID,
    });
    expect(JSON.stringify(harness.workspace.privateState)).not.toContain(
      operation.operationCapability,
    );
    expect(harness.workspace.revision).toBe(0);
  });
});

describe('TaskNotesService update semantics', () => {
  it('blocks a dark first Update before structural admission or host mutation', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    const request = updateRequest(harness, operation);
    const darkService = new TaskNotesService(harness.workspace, harness.structural, {
      now: () => harness.now.value,
    });
    const queuedCount = harness.workspace.operations.length;

    await expect(darkService.updateTaskNotes(harness.principal, request)).resolves.toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(harness.structural.admissionCount).toBe(0);
    expect(harness.workspace.operations).toHaveLength(queuedCount);
  });

  it('keeps exact terminal replay available after writer entitlement is withdrawn', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    const request = updateRequest(harness, operation);
    await harness.service.updateTaskNotes(harness.principal, request);
    const darkService = new TaskNotesService(harness.workspace, harness.structural, {
      now: () => harness.now.value,
    });
    const admissionCount = harness.structural.admissionCount;
    const queuedCount = harness.workspace.operations.length;

    await expect(darkService.updateTaskNotes(harness.principal, request)).resolves.toMatchObject({
      ok: true,
      result: { kind: 'completed', replayed: true },
    });
    expect(harness.structural.admissionCount).toBe(admissionCount);
    expect(harness.workspace.operations).toHaveLength(queuedCount);
  });

  it('keeps an exact admitted recovery operation available after entitlement withdrawal', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    const request = updateRequest(harness, operation);
    admitForRecovery(harness, operation, request);
    const darkService = new TaskNotesService(harness.workspace, harness.structural, {
      now: () => harness.now.value,
    });

    await expect(darkService.updateTaskNotes(harness.principal, request)).resolves.toMatchObject({
      ok: true,
      result: { kind: 'completed' },
    });
    expect(harness.structural.admissionCount).toBe(1);
    expect(terminalRecord(harness, operation)).toMatchObject({ state: 'terminal' });
  });

  it('commits note and receipt atomically, releases its removal lease before current collection, and emits once', async () => {
    const emit = vi.fn();
    const harness = createHarness({ emitTaskNotesChanged: emit });
    const operation = await issueOperation(harness);
    harness.structural.order.length = 0;

    const response = await harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, operation),
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        kind: 'completed',
        replayed: false,
        originalOutcome: { kind: 'saved', changed: true, committedWorkspaceRevision: 1 },
        current: {
          relation: 'same-incarnation',
          currentNotes: { snapshot: { notes: 'updated notes', workspaceRevision: 1 } },
        },
      },
    });
    expect((harness.workspace.sharedState.tasks as JsonObject)[TASK_ID]).toMatchObject({
      notes: 'updated notes',
    });
    expect(terminalRecord(harness, operation)).toMatchObject({ state: 'terminal' });
    expect(harness.structural.order).toEqual(['admit', 'release', 'collect']);
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      sourceId: 'client-1',
      taskId: TASK_ID,
      workspaceRevision: 1,
    });
  });

  it('treats already-converged text as a no-op even when the submitted base is stale', async () => {
    const emit = vi.fn();
    const harness = createHarness({ emitTaskNotesChanged: emit });
    (harness.workspace.sharedState.tasks as JsonObject)[TASK_ID] = {
      id: TASK_ID,
      notes: 'already there',
    };
    const operation = await issueOperation(harness);

    const response = await harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, operation, {
        baseContentVersion: createTaskNotesContentVersion('old base'),
        notes: 'already there',
      }),
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        kind: 'completed',
        originalOutcome: { kind: 'saved', changed: false, committedWorkspaceRevision: 0 },
      },
    });
    expect(harness.workspace.revision).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('preserves canonical text and returns a field-scoped conflict for a stale changed submission', async () => {
    const harness = createHarness();
    (harness.workspace.sharedState.tasks as JsonObject)[TASK_ID] = {
      id: TASK_ID,
      notes: 'server text',
    };
    const operation = await issueOperation(harness);

    const response = await harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, operation, {
        baseContentVersion: createTaskNotesContentVersion('old base'),
        notes: 'local text',
      }),
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        kind: 'completed',
        originalOutcome: {
          kind: 'conflict',
          observedContentVersion: createTaskNotesContentVersion('server text'),
          observedWorkspaceRevision: 0,
        },
      },
    });
    expect((harness.workspace.sharedState.tasks as JsonObject)[TASK_ID]).toMatchObject({
      notes: 'server text',
    });
    expect(harness.workspace.revision).toBe(0);
  });

  it('binds the operation to the private task witness across same-ID replacement', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    const oldIncarnation = deriveTaskNotesIncarnation(harness.structural.currentWitness);
    harness.structural.currentWitness = hashTaskNotesPrincipal('replacement-witness');

    const response = await harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, operation, { taskIncarnation: oldIncarnation }),
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        kind: 'completed',
        current: { relation: 'task-replaced' },
        originalOutcome: { kind: 'task-incarnation-changed', observedWorkspaceRevision: 0 },
      },
    });
    expect((harness.workspace.sharedState.tasks as JsonObject)[TASK_ID]).toMatchObject({
      notes: '',
    });
  });

  it('replays the immutable terminal result without a second admission or semantic write', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    const request = updateRequest(harness, operation);
    await harness.service.updateTaskNotes(harness.principal, request);
    const admissionCount = harness.structural.admissionCount;
    const completionWrites = harness.workspace.operations.filter(
      (name) => name === 'complete-task-notes-operation',
    ).length;

    const replay = await harness.service.updateTaskNotes(harness.principal, request);

    expect(replay).toMatchObject({ ok: true, result: { kind: 'completed', replayed: true } });
    expect(harness.structural.admissionCount).toBe(admissionCount);
    expect(
      harness.workspace.operations.filter((name) => name === 'complete-task-notes-operation'),
    ).toHaveLength(completionWrites);
  });

  it('preserves safely inspected terminal truth while the structural/current barrier is unavailable', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    const request = updateRequest(harness, operation);
    await harness.service.updateTaskNotes(harness.principal, request);
    harness.structural.readiness = { kind: 'unavailable', retryAfterMs: 750 };
    const baseline = {
      admissions: harness.structural.admissionCount,
      inspections: harness.workspace.inspections.length,
      operations: harness.workspace.operations.length,
      order: harness.structural.order.length,
    };

    const replay = await harness.service.updateTaskNotes(harness.principal, request);

    expect(replay).toMatchObject({
      ok: true,
      result: {
        kind: 'task-state-unavailable',
        retryAfterMs: 750,
        knownDisposition: {
          kind: 'completed',
          replayed: true,
          originalOutcome: { kind: 'saved' },
        },
      },
    });
    expect(replay).not.toHaveProperty('result.current');
    expect(harness.workspace.inspections).toHaveLength(baseline.inspections + 1);
    expect(harness.workspace.operations).toHaveLength(baseline.operations);
    expect(harness.structural.admissionCount).toBe(baseline.admissions);
    expect(harness.structural.order).toHaveLength(baseline.order);
  });

  it('keeps issued and admitted operation existence unsettled behind an unavailable barrier', async () => {
    for (const state of ['issued', 'admitted'] as const) {
      const harness = createHarness();
      const operation = await issueOperation(harness);
      const request = updateRequest(harness, operation);
      if (state === 'admitted') admitForRecovery(harness, operation, request);
      harness.structural.readiness = { kind: 'unavailable', retryAfterMs: 750 };
      const baseline = {
        admissions: harness.structural.admissionCount,
        inspections: harness.workspace.inspections.length,
        operations: harness.workspace.operations.length,
        order: harness.structural.order.length,
      };

      await expect(harness.service.updateTaskNotes(harness.principal, request)).resolves.toEqual({
        ok: true,
        result: {
          kind: 'task-state-unavailable',
          knownDisposition: { kind: 'unsettled' },
          retryAfterMs: 750,
        },
      });
      expect(harness.workspace.inspections).toHaveLength(baseline.inspections + 1);
      expect(harness.workspace.operations).toHaveLength(baseline.operations);
      expect(harness.structural.admissionCount).toBe(baseline.admissions);
      expect(harness.structural.order).toHaveLength(baseline.order);
    }
  });

  it('keeps completed truth absorbing when the task starts closing before a replay', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    const request = updateRequest(harness, operation);
    await harness.service.updateTaskNotes(harness.principal, request);
    const admissionCount = harness.structural.admissionCount;
    const queuedCount = harness.workspace.operations.length;
    harness.structural.admission = { kind: 'task-closing' };
    harness.structural.taskClosing = true;

    const replay = await harness.service.updateTaskNotes(harness.principal, request);

    expect(replay).toMatchObject({
      ok: true,
      result: {
        kind: 'completed',
        replayed: true,
        current: { currentTask: { taskClosing: true } },
      },
    });
    expect(harness.structural.admissionCount).toBe(admissionCount);
    expect(harness.workspace.operations).toHaveLength(queuedCount);
  });

  it('rejects an invalid operation from the nonqueued snapshot without structural admission', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    const queuedCount = harness.workspace.operations.length;
    const before = clone(harness.workspace.privateState);

    const response = await harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, operation, {
        operationCapability: hashTaskNotesPrincipal('wrong-capability-source'),
      }),
    );

    expect(response).toEqual({
      ok: false,
      error: { code: 'operation-identity-rejected' },
    });
    expect(harness.structural.admissionCount).toBe(0);
    expect(harness.workspace.operations).toHaveLength(queuedCount);
    expect(harness.workspace.privateState).toEqual(before);
  });

  it('joins an identical active request while rejecting a different payload without another slot', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    const request = updateRequest(harness, operation);
    let releaseCompletion: (() => void) | undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    harness.workspace.beforeMutation('complete-task-notes-operation', () => completionGate);

    const first = harness.service.updateTaskNotes(harness.principal, request);
    await vi.waitFor(() => {
      expect(harness.workspace.operations).toContain('complete-task-notes-operation');
    });
    const joined = harness.service.updateTaskNotes(harness.principal, request);
    const rejected = await harness.service.updateTaskNotes(harness.principal, {
      ...request,
      notes: 'different text',
    });
    releaseCompletion?.();

    await expect(joined).resolves.toEqual(await first);
    expect(rejected).toEqual({
      ok: false,
      error: { code: 'operation-identity-rejected' },
    });
    expect(harness.structural.admissionCount).toBe(1);
    expect(
      harness.workspace.operations.filter((name) => name === 'complete-task-notes-operation'),
    ).toHaveLength(1);
  });

  it('reserves an identical simultaneous request before admission and shares one completion', async () => {
    const emitTaskNotesChanged = vi.fn();
    const harness = createHarness({ emitTaskNotesChanged, maxFreshInFlight: 1 });
    const operation = await issueOperation(harness);
    const request = updateRequest(harness, operation);
    const admission = deferredGate();
    const completion = deferredGate();
    harness.structural.onAdmit = () => admission.promise;
    harness.workspace.beforeMutation('complete-task-notes-operation', () => completion.promise);

    const first = harness.service.updateTaskNotes(harness.principal, request);
    const second = harness.service.updateTaskNotes(harness.principal, request);
    await vi.waitFor(() => expect(harness.structural.admissionCount).toBe(1));
    admission.release();
    await vi.waitFor(() => {
      expect(harness.workspace.operations).toContain('complete-task-notes-operation');
    });
    completion.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toEqual(firstResult);
    expect(firstResult).toMatchObject({ ok: true, result: { kind: 'completed' } });
    expect(harness.structural.admissionCount).toBe(1);
    expect(
      harness.workspace.operations.filter((name) => name === 'complete-task-notes-operation'),
    ).toHaveLength(1);
    expect(emitTaskNotesChanged).toHaveBeenCalledTimes(1);
    expect(harness.structural.released.filter((id) => id === operation.operationId)).toHaveLength(
      1,
    );

    const laterOperation = await issueOperation(harness);
    await expect(
      harness.service.updateTaskNotes(
        harness.principal,
        updateRequest(harness, laterOperation, { notes: 'later update' }),
      ),
    ).resolves.toMatchObject({ ok: true, result: { kind: 'completed' } });
  });

  it('bounds fresh operations, releases the slot exactly once, and permits a later retry', async () => {
    const harness = createHarness({ maxFreshInFlight: 1 });
    const firstOperation = await issueOperation(harness);
    const secondOperation = await issueOperation(harness);
    let releaseCompletion: (() => void) | undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    harness.workspace.beforeMutation('complete-task-notes-operation', () => completionGate);

    const first = harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, firstOperation),
    );
    await vi.waitFor(() => {
      expect(harness.workspace.operations).toContain('complete-task-notes-operation');
    });
    await expect(
      harness.service.updateTaskNotes(
        harness.principal,
        updateRequest(harness, secondOperation, { notes: 'second' }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'rate-limited', retryAfterMs: 500 },
    });

    releaseCompletion?.();
    await first;
    await expect(
      harness.service.updateTaskNotes(
        harness.principal,
        updateRequest(harness, secondOperation, { notes: 'second' }),
      ),
    ).resolves.toMatchObject({ ok: true, result: { kind: 'completed' } });
  });

  it('reserves fresh capacity before deferred admission without creating a loser lease', async () => {
    const harness = createHarness({ maxFreshInFlight: 1 });
    const firstOperation = await issueOperation(harness);
    const secondOperation = await issueOperation(harness);
    const admissions = deferredGate();
    const completion = deferredGate();
    harness.structural.onAdmit = () => admissions.promise;
    harness.workspace.beforeMutation('complete-task-notes-operation', () => completion.promise);

    const first = harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, firstOperation),
    );
    const second = harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, secondOperation, { notes: 'second' }),
    );
    await vi.waitFor(() => expect(harness.structural.admissionCount).toBe(1));
    await expect(second).resolves.toEqual({
      ok: false,
      error: { code: 'rate-limited', retryAfterMs: 500 },
    });
    expect(harness.structural.released).not.toContain(secondOperation.operationId);
    admissions.release();
    await vi.waitFor(() => {
      expect(harness.workspace.operations).toContain('complete-task-notes-operation');
    });

    expect(
      harness.workspace.operations.filter((name) => name === 'complete-task-notes-operation'),
    ).toHaveLength(1);
    expect(terminalRecord(harness, secondOperation)).toMatchObject({ state: 'issued' });
    completion.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toMatchObject({ ok: true, result: { kind: 'completed' } });
    expect(secondResult).toEqual({
      ok: false,
      error: { code: 'rate-limited', retryAfterMs: 500 },
    });
    expect(
      harness.structural.released.filter((id) => id === firstOperation.operationId),
    ).toHaveLength(1);
    expect(
      harness.structural.released.filter((id) => id === secondOperation.operationId),
    ).toHaveLength(0);
  });

  it('reserves a bounded recovery lane without consuming or changing the queued retry', async () => {
    const harness = createHarness({ maxRecoveryInFlight: 1 });
    const firstOperation = await issueOperation(harness);
    const secondOperation = await issueOperation(harness);
    const firstRequest = updateRequest(harness, firstOperation);
    const secondRequest = updateRequest(harness, secondOperation, { notes: 'second' });
    admitForRecovery(harness, firstOperation, firstRequest);
    admitForRecovery(harness, secondOperation, secondRequest);
    let releaseCompletion: (() => void) | undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    harness.workspace.beforeMutation('complete-task-notes-operation', () => completionGate);

    const first = harness.service.updateTaskNotes(harness.principal, firstRequest);
    await vi.waitFor(() => {
      expect(harness.workspace.operations).toContain('complete-task-notes-operation');
    });
    await expect(
      harness.service.updateTaskNotes(harness.principal, secondRequest),
    ).resolves.toEqual({
      ok: true,
      result: {
        kind: 'recovery-busy',
        effectiveRetireAfter: secondOperation.replayUntil,
        retryAfterMs: 500,
      },
    });
    expect(terminalRecord(harness, secondOperation)).toMatchObject({ state: 'admitted' });

    releaseCompletion?.();
    await first;
    await expect(
      harness.service.updateTaskNotes(harness.principal, secondRequest),
    ).resolves.toMatchObject({ ok: true, result: { kind: 'completed' } });
  });

  it('reserves recovery capacity before deferred admission without creating a loser lease', async () => {
    const harness = createHarness({ maxRecoveryInFlight: 1 });
    const firstOperation = await issueOperation(harness);
    const secondOperation = await issueOperation(harness);
    const firstRequest = updateRequest(harness, firstOperation);
    const secondRequest = updateRequest(harness, secondOperation, { notes: 'second' });
    admitForRecovery(harness, firstOperation, firstRequest);
    admitForRecovery(harness, secondOperation, secondRequest);
    const admissions = deferredGate();
    const completion = deferredGate();
    harness.structural.onAdmit = () => admissions.promise;
    harness.workspace.beforeMutation('complete-task-notes-operation', () => completion.promise);

    const first = harness.service.updateTaskNotes(harness.principal, firstRequest);
    const second = harness.service.updateTaskNotes(harness.principal, secondRequest);
    await vi.waitFor(() => expect(harness.structural.admissionCount).toBe(1));
    await expect(second).resolves.toEqual({
      ok: true,
      result: {
        kind: 'recovery-busy',
        effectiveRetireAfter: secondOperation.replayUntil,
        retryAfterMs: 500,
      },
    });
    expect(harness.structural.released).not.toContain(secondOperation.operationId);
    admissions.release();
    await vi.waitFor(() => {
      expect(harness.workspace.operations).toContain('complete-task-notes-operation');
    });

    expect(
      harness.workspace.operations.filter((name) => name === 'complete-task-notes-operation'),
    ).toHaveLength(1);
    expect(terminalRecord(harness, secondOperation)).toMatchObject({ state: 'admitted' });
    completion.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toMatchObject({ ok: true, result: { kind: 'completed' } });
    expect(secondResult).toEqual({
      ok: true,
      result: {
        kind: 'recovery-busy',
        effectiveRetireAfter: secondOperation.replayUntil,
        retryAfterMs: 500,
      },
    });
    expect(
      harness.structural.released.filter((id) => id === firstOperation.operationId),
    ).toHaveLength(1);
    expect(
      harness.structural.released.filter((id) => id === secondOperation.operationId),
    ).toHaveLength(0);
  });

  it('rechecks same-principal capacity across fresh and recovery lanes after deferred admission', async () => {
    const harness = createHarness({
      maxFreshInFlight: 2,
      maxPrincipalInFlight: 1,
      maxRecoveryInFlight: 2,
    });
    const freshOperation = await issueOperation(harness);
    const recoveryOperation = await issueOperation(harness);
    const freshRequest = updateRequest(harness, freshOperation);
    const recoveryRequest = updateRequest(harness, recoveryOperation, { notes: 'recovery' });
    admitForRecovery(harness, recoveryOperation, recoveryRequest);
    const admissions = deferredGate();
    const completion = deferredGate();
    harness.structural.onAdmit = () => admissions.promise;
    harness.workspace.beforeMutation('complete-task-notes-operation', () => completion.promise);

    const fresh = harness.service.updateTaskNotes(harness.principal, freshRequest);
    const recovery = harness.service.updateTaskNotes(harness.principal, recoveryRequest);
    await vi.waitFor(() => expect(harness.structural.admissionCount).toBe(1));
    await expect(recovery).resolves.toMatchObject({
      ok: true,
      result: { kind: 'recovery-busy' },
    });
    expect(harness.structural.released).not.toContain(recoveryOperation.operationId);
    admissions.release();
    await vi.waitFor(() => {
      expect(harness.workspace.operations).toContain('complete-task-notes-operation');
    });

    expect(
      harness.workspace.operations.filter((name) => name === 'complete-task-notes-operation'),
    ).toHaveLength(1);
    completion.release();
    const [freshResult, recoveryResult] = await Promise.all([fresh, recovery]);

    expect(freshResult).toMatchObject({ ok: true, result: { kind: 'completed' } });
    expect(recoveryResult).toMatchObject({ ok: true, result: { kind: 'recovery-busy' } });
    expect(
      harness.structural.released.filter((id) => id === freshOperation.operationId),
    ).toHaveLength(1);
    expect(
      harness.structural.released.filter((id) => id === recoveryOperation.operationId),
    ).toHaveLength(0);
  });

  it('returns nonqueued task-closing without changing the operation or task', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    const before = clone(harness.workspace.privateState);
    const queuedCount = harness.workspace.operations.length;
    harness.structural.onAdmit = () => {
      harness.structural.admission = { kind: 'task-closing' };
      harness.structural.taskClosing = true;
    };

    const response = await harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, operation),
    );

    expect(response).toMatchObject({
      ok: true,
      result: { kind: 'task-closing', replayed: false },
    });
    expect(harness.workspace.privateState).toEqual(before);
    expect(harness.workspace.operations).toHaveLength(queuedCount);
    expect(harness.workspace.operations).not.toContain('admit-task-notes-operation');
    expect(harness.workspace.revision).toBe(0);
  });

  it('keeps completed truth when coherent current collection is temporarily unavailable', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    harness.structural.collectOverride = { kind: 'unavailable', retryAfterMs: 500 };

    const response = await harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, operation),
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        kind: 'task-state-unavailable',
        retryAfterMs: 500,
        knownDisposition: {
          kind: 'completed',
          originalOutcome: { kind: 'saved', changed: true },
        },
      },
    });
  });

  it('marks durable completion when either projection publication or targeted invalidation fails', async () => {
    const emit = vi.fn(() => {
      throw new Error('event unavailable');
    });
    const harness = createHarness({ emitTaskNotesChanged: emit });
    harness.workspace.warningOperations.add('complete-task-notes-operation');
    const operation = await issueOperation(harness);

    const response = await harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, operation),
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        kind: 'completed',
        originalOutcome: { kind: 'saved', changed: true },
        postCommitWarning: 'projection-repair-required',
      },
    });
    expect((harness.workspace.sharedState.tasks as JsonObject)[TASK_ID]).toMatchObject({
      notes: 'updated notes',
    });
  });
});

describe('TaskNotesService deadlines and storage classification', () => {
  it('returns expiry only for an authenticated matching retained operation', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    harness.now.value += TASK_NOTES_ADMISSION_WINDOW_MS;

    await expect(
      harness.service.updateTaskNotes(harness.principal, updateRequest(harness, operation)),
    ).resolves.toEqual({
      ok: true,
      result: { kind: 'operation-expired', expiredAt: operation.admitUntil },
    });
    await expect(
      harness.service.updateTaskNotes(harness.principal, {
        ...updateRequest(harness, operation),
        operationCapability: hashTaskNotesPrincipal('wrong-capability'),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'operation-identity-rejected' },
    });
  });

  it('rechecks a first admission deadline after waiting for the structural gate', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    harness.structural.onAdmit = () => {
      harness.now.value += TASK_NOTES_ADMISSION_WINDOW_MS;
    };

    const response = await harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, operation),
    );

    expect(response).toEqual({
      ok: true,
      result: { kind: 'operation-expired', expiredAt: operation.admitUntil },
    });
    expect(harness.structural.released).toEqual([operation.operationId]);
    expect(terminalRecord(harness, operation)).toMatchObject({ state: 'issued' });
  });

  it('lets an accepted admitted retry finish after its ordinary retirement boundary', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    const request = updateRequest(harness, operation);
    const segment = readTaskNotesOperationSegment(harness.workspace.privateState);
    const issued = findTaskNotesOperationRecord(
      segment,
      harness.principal.principalHash,
      operation.operationId,
    );
    const admitted = classifyTaskNotesOperation(issued, {
      now: harness.now.value,
      principalHash: harness.principal.principalHash,
      request,
    });
    if (admitted.kind !== 'admit') throw new Error('fixture did not admit');
    harness.workspace.privateState = withTaskNotesOperationSegment(
      harness.workspace.privateState,
      replaceTaskNotesOperationRecord(segment, admitted.record),
    );
    harness.structural.onAdmit = () => {
      harness.now.value += TASK_NOTES_REPLAY_WINDOW_MS;
    };

    const response = await harness.service.updateTaskNotes(harness.principal, request);

    expect(response).toMatchObject({
      ok: true,
      result: { kind: 'completed', originalOutcome: { kind: 'saved', changed: true } },
    });
    expect(terminalRecord(harness, operation)).toMatchObject({ state: 'terminal' });
  });

  it('returns unsettled state when record inspection is blocked by host durability', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    harness.workspace.failAfterDecision(
      'inspect-task-notes-operation',
      new WorkspaceMutationDurabilityError(0),
    );

    await expect(
      harness.service.updateTaskNotes(harness.principal, updateRequest(harness, operation)),
    ).resolves.toEqual({
      ok: true,
      result: {
        kind: 'task-state-unavailable',
        knownDisposition: { kind: 'unsettled' },
        retryAfterMs: 500,
      },
    });
    expect(harness.structural.admissionCount).toBe(0);
  });

  it('retains admission-only and terminal durability proposals without acknowledging success', async () => {
    const admissionHarness = createHarness();
    const admissionOperation = await issueOperation(admissionHarness);
    admissionHarness.workspace.failAfterDecision(
      'admit-task-notes-operation',
      new WorkspaceMutationDurabilityError(0),
    );
    await expect(
      admissionHarness.service.updateTaskNotes(
        admissionHarness.principal,
        updateRequest(admissionHarness, admissionOperation),
      ),
    ).resolves.toEqual({
      ok: true,
      result: {
        kind: 'durability-repair-required',
        replayed: false,
        retention: 'held',
        semanticProposal: 'admission-only',
      },
    });
    expect(admissionHarness.structural.retained).toEqual([
      { operationId: admissionOperation.operationId, proposal: 'admission-only' },
    ]);
    expect(admissionHarness.structural.released).toEqual([]);

    const terminalHarness = createHarness();
    const terminalOperation = await issueOperation(terminalHarness);
    terminalHarness.workspace.failAfterDecision(
      'complete-task-notes-operation',
      new WorkspaceMutationDurabilityError(0),
    );
    const terminalResponse = await terminalHarness.service.updateTaskNotes(
      terminalHarness.principal,
      updateRequest(terminalHarness, terminalOperation),
    );
    expect(terminalResponse).toMatchObject({
      ok: true,
      result: {
        kind: 'durability-repair-required',
        proposedOutcome: { kind: 'saved', changed: true },
        replayed: false,
        retention: 'held',
        semanticProposal: 'terminal-outcome',
      },
    });
    expect(terminalHarness.structural.released).toEqual([]);
  });

  it('transfers a host-recovery gate before returning and never releases the lease directly', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    harness.workspace.failAfterDecision(
      'complete-task-notes-operation',
      new WorkspaceMutationRecoveryError('ambiguous primary'),
    );

    const response = await harness.service.updateTaskNotes(
      harness.principal,
      updateRequest(harness, operation),
    );

    expect(response).toEqual({
      ok: true,
      result: { kind: 'host-state-recovery-required', replayed: false, retention: 'held' },
    });
    expect(harness.structural.retained).toEqual([
      { operationId: operation.operationId, proposal: 'terminal-outcome' },
    ]);
    expect(harness.structural.released).toEqual([]);
  });

  it('does not invent a retry-window write when admission is proven not committed', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    harness.workspace.failAfterDecision(
      'admit-task-notes-operation',
      new WorkspaceMutationNotCommittedError(new Error('exact prior')),
    );

    await expect(
      harness.service.updateTaskNotes(harness.principal, updateRequest(harness, operation)),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'persistence-unavailable', retryable: true },
    });
    expect(harness.workspace.operations).not.toContain('repair-task-notes-retry-window');
    expect(terminalRecord(harness, operation)).toMatchObject({ state: 'issued' });
    expect(harness.structural.released).toEqual([operation.operationId]);
  });

  it('durably extends an admitted retry window before releasing a proven-no-terminal attempt', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    harness.workspace.beforeMutation('complete-task-notes-operation', () => {
      harness.now.value += 1_000;
    });
    harness.workspace.failAfterDecision(
      'complete-task-notes-operation',
      new WorkspaceMutationNotCommittedError(new Error('exact prior')),
    );

    await expect(
      harness.service.updateTaskNotes(harness.principal, updateRequest(harness, operation)),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'persistence-unavailable', retryable: true },
    });
    expect(harness.workspace.operations).toContain('repair-task-notes-retry-window');
    expect(terminalRecord(harness, operation)).toMatchObject({ state: 'admitted' });
    expect(terminalRecord(harness, operation)?.retireAfter).toBe(
      new Date(STARTED_AT + 1_000 + TASK_NOTES_REPLAY_WINDOW_MS).toISOString(),
    );
    expect(harness.structural.released).toEqual([operation.operationId]);
  });

  it('retains the structural registration when the fresh retry-window write is also proven absent', async () => {
    const harness = createHarness();
    const operation = await issueOperation(harness);
    harness.workspace.failAfterDecision(
      'complete-task-notes-operation',
      new WorkspaceMutationNotCommittedError(new Error('terminal exact prior')),
    );
    harness.workspace.failAfterDecision(
      'repair-task-notes-retry-window',
      new WorkspaceMutationNotCommittedError(new Error('retry-window exact prior')),
    );

    await expect(
      harness.service.updateTaskNotes(harness.principal, updateRequest(harness, operation)),
    ).resolves.toEqual({
      ok: true,
      result: {
        kind: 'durability-repair-required',
        replayed: false,
        retention: 'held',
        semanticProposal: 'retry-window-only',
      },
    });
    expect(harness.structural.retained).toEqual([]);
    expect(harness.structural.retainedRetryWindows).toEqual([operation.operationId]);
    expect(harness.structural.released).toEqual([]);
    expect(terminalRecord(harness, operation)).toMatchObject({ state: 'admitted' });
  });
});
