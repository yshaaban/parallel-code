import { describe, expect, it } from 'vitest';

import {
  TASK_NOTES_CHANGED_MAX_BYTES,
  TASK_NOTES_MAX_BODY_BYTES,
  TASK_NOTES_MAX_BYTES,
  getWellFormedUtf8ByteLength,
  isTaskNotesChangedNotification,
  isUpdateTaskNotesRequest,
  serializeTaskNotesChangedNotification,
  type AcknowledgedTaskNotesOperation,
  type IssuedTaskNotesOperation,
  type TaskNotesCurrentEnvelope,
  type TaskNotesSnapshot,
  type UpdateTaskNotesRequest,
} from '../../src/domain/task-notes.js';
import { createIntendedTaskNotesWriterEntitlements } from '../../tests/harness/task-notes-writer-entitlements.js';
import {
  TASK_NOTES_MAX_OPERATIONS_PER_PRINCIPAL,
  TASK_NOTES_MAX_OPERATIONS_PER_WORKSPACE,
  TASK_NOTES_MAX_OPERATION_RECORD_BYTES,
  TASK_NOTES_MAX_OPERATION_SEGMENT_BYTES,
  TASK_NOTES_OPERATIONS_PRIVATE_STATE_KEY,
  assertTaskNotesOperationSegment,
  createEmptyTaskNotesOperationSegment,
  createTaskNotesContentVersion,
  createTaskNotesOperationFingerprint,
  deriveTaskNotesIncarnation,
  getTaskNotesOperationRecordBytes,
  getTaskNotesOperationSegmentBytes,
  hashTaskNotesPrincipal,
  readTaskNotesOperationSegment,
  withTaskNotesOperationSegment,
  type TaskNotesOperationRecord,
  type TaskNotesOperationSegment,
} from './task-notes-operations.js';
import {
  TaskNotesService,
  createTaskNotesPrincipalContext,
  type TaskNotesCommonReadiness,
  type TaskNotesCurrentCollection,
  type TaskNotesMutationAdmission,
  type TaskNotesMutationLease,
  type TaskNotesPrincipalContext,
  type TaskNotesStructuralAuthority,
} from './task-notes-service.js';
import type {
  WorkspaceHostMutationSlices,
  WorkspaceMutationDecision,
  WorkspaceMutationRequest,
  WorkspaceMutationResult,
  WorkspacePrivateSnapshotAuthority,
} from './workspace-state-mutations.js';
import type { JsonObject } from './workspace-state-storage.js';

const HASH_SAMPLE_COUNT = 250;
const READ_SAMPLE_COUNT = 10_000;
const AUTOSAVE_SAMPLE_COUNT = 10_000;
const HASH_P95_BUDGET_MS = 3;
const READ_P95_BUDGET_MS = 150;
const ISSUE_SAVE_P95_BUDGET_MS = 250;
const SEGMENT_GUARD_P95_BUDGET_MS = 50;
const SEGMENT_REPLACE_P95_BUDGET_MS = 150;
const TASK_ID = 'task-performance';
const STARTED_AT = Date.UTC(2026, 7, 3, 0, 0, 0);
const SERVER_INSTANCE_ID = '00000000-0000-4000-8000-000000000001';
const MAX_DEADLINE = '9999-12-31T23:59:59.999Z';
const TASK_WITNESS = hashTaskNotesPrincipal('task-performance-witness');
const TASK_INCARNATION = deriveTaskNotesIncarnation(TASK_WITNESS);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function percentile(sorted: ArrayLike<number>, quantile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? Infinity;
}

function reportDistribution(
  name: string,
  samples: Float64Array | number[],
  budgetMs: number,
): { p50: number; p95: number; p99: number } {
  samples.sort();
  const result = {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
  };
  process.stdout.write(
    `${name} samples=${samples.length} p50=${result.p50.toFixed(3)}ms p95=${result.p95.toFixed(3)}ms p99=${result.p99.toFixed(3)}ms budget=${budgetMs}ms\n`,
  );
  return result;
}

class BenchmarkWorkspace implements WorkspacePrivateSnapshotAuthority {
  changedPrivateWrites = 0;
  changedSharedWrites = 0;
  changedWrites = 0;
  readonly inspections: string[] = [];
  readonly operations: string[] = [];
  privateState: JsonObject = withTaskNotesOperationSegment(
    {},
    createEmptyTaskNotesOperationSegment(),
  );
  revision = 0;
  sharedState: JsonObject = { tasks: { [TASK_ID]: { id: TASK_ID, notes: '' } } };

  async inspect<TResult>(
    request: WorkspaceMutationRequest,
    inspector: (slices: Readonly<WorkspaceHostMutationSlices>) => TResult,
  ): Promise<TResult> {
    this.inspections.push(request.operation);
    return inspector(this.snapshot());
  }

  async mutate<TResult>(
    request: WorkspaceMutationRequest,
    mutator: (slices: Readonly<WorkspaceHostMutationSlices>) => WorkspaceMutationDecision<TResult>,
  ): Promise<WorkspaceMutationResult<TResult>> {
    this.operations.push(request.operation);
    const decision = mutator(this.snapshot());
    if (decision.kind === 'changed') {
      this.changedWrites += 1;
      if (decision.nextPrivateState) {
        this.privateState = clone(decision.nextPrivateState);
        this.changedPrivateWrites += 1;
      }
      if (decision.nextSharedState) {
        this.sharedState = clone(decision.nextSharedState);
        this.revision += 1;
        this.changedSharedWrites += 1;
      }
    }
    return {
      changed: decision.kind === 'changed',
      result: decision.result,
      revision: this.revision,
    };
  }

  private snapshot(): WorkspaceHostMutationSlices {
    return {
      localState: {},
      payloadDigest: '0'.repeat(64),
      privateState: clone(this.privateState),
      sharedRevision: this.revision,
      sharedState: clone(this.sharedState),
      storageGeneration: String(this.operations.length),
    };
  }
}

class BenchmarkStructuralAuthority implements TaskNotesStructuralAuthority {
  admission: Exclude<TaskNotesMutationAdmission, { kind: 'admitted' }> | null = null;
  admissionCount = 0;
  collectCount = 0;
  eventCount = 0;
  releaseCount = 0;
  readiness: TaskNotesCommonReadiness = {
    generation: 'benchmark-generation',
    kind: 'ready',
    writable: true,
  };

  constructor(readonly workspace: BenchmarkWorkspace) {}

  async admitTaskMutationSet(): Promise<TaskNotesMutationAdmission> {
    this.admissionCount += 1;
    if (this.admission) return this.admission;
    let retained = false;
    const lease: TaskNotesMutationLease = {
      release: () => {
        if (!retained) this.releaseCount += 1;
      },
      retainUntilHostDurable: () => {
        retained = true;
      },
      retainUntilRetryWindowMaterialized: () => {
        retained = true;
      },
    };
    return { kind: 'admitted', lease };
  }

  async collectTaskNotesCurrentEnvelope(args: {
    expectedTaskIdentityWitness?: string;
    readinessGeneration: string;
    taskId: string;
  }): Promise<TaskNotesCurrentCollection> {
    this.collectCount += 1;
    const task = (this.workspace.sharedState.tasks as JsonObject)[args.taskId] as
      | JsonObject
      | undefined;
    if (!task) throw new Error('Benchmark task disappeared');
    const notes = task.notes;
    if (typeof notes !== 'string') throw new Error('Benchmark notes are invalid');
    const current = currentEnvelope(notes, this.workspace.revision);
    return { current, kind: 'collected', taskIdentityWitness: TASK_WITNESS };
  }

  getTaskNotesCommonReadiness(): TaskNotesCommonReadiness {
    return this.readiness;
  }

  recheckTaskIdentityWitness(
    _slices: Readonly<WorkspaceHostMutationSlices>,
    _taskId: string,
    expectedTaskIdentityWitness: string,
  ) {
    return expectedTaskIdentityWitness === TASK_WITNESS
      ? ({ kind: 'same-incarnation' } as const)
      : ({ kind: 'task-incarnation-changed' } as const);
  }

  reportTaskNotesCanonicalStateFailure(error: unknown): void {
    throw error;
  }
}

interface BenchmarkHarness {
  now: { value: number };
  principal: TaskNotesPrincipalContext;
  service: TaskNotesService;
  structural: BenchmarkStructuralAuthority;
  workspace: BenchmarkWorkspace;
}

function currentEnvelope(notes: string, revision: number): TaskNotesCurrentEnvelope {
  return {
    relation: 'same-incarnation',
    currentNotes: {
      kind: 'present',
      snapshot: {
        contentVersion: createTaskNotesContentVersion(notes),
        notes,
        taskId: TASK_ID,
        taskIncarnation: TASK_INCARNATION,
        workspaceRevision: revision,
      },
    },
    currentTask: {
      catalogVersion: revision,
      serverInstanceId: SERVER_INSTANCE_ID,
      taskClosing: false,
      taskIncarnation: TASK_INCARNATION,
      taskState: 'present',
    },
  };
}

function createHarness(): BenchmarkHarness {
  const now = { value: STARTED_AT };
  const workspace = new BenchmarkWorkspace();
  const structural = new BenchmarkStructuralAuthority(workspace);
  let randomValue = 1;
  const service = new TaskNotesService(workspace, structural, {
    emitTaskNotesChanged: () => {
      structural.eventCount += 1;
    },
    now: () => now.value,
    randomBytes: (size) => {
      const bytes = Buffer.alloc(size);
      bytes.writeUInt32BE(randomValue, size - 4);
      randomValue = (randomValue + 1) >>> 0;
      return bytes;
    },
    writerEntitlements: createIntendedTaskNotesWriterEntitlements(['desktop']),
  });
  return {
    now,
    principal: createTaskNotesPrincipalContext(
      'benchmark-principal',
      'benchmark-client',
      'desktop',
    ),
    service,
    structural,
    workspace,
  };
}

async function issueOperation(
  harness: BenchmarkHarness,
  acknowledgedOperations?: AcknowledgedTaskNotesOperation[],
): Promise<IssuedTaskNotesOperation> {
  const response = await harness.service.issueTaskNotesOperation(harness.principal, {
    ...(acknowledgedOperations ? { acknowledgedOperations } : {}),
    taskId: TASK_ID,
    taskIncarnation: TASK_INCARNATION,
  });
  if (!response.ok || response.result.kind !== 'issued') {
    throw new Error(`Expected issued operation, received ${JSON.stringify(response)}`);
  }
  return response.result.operation;
}

function updateRequest(
  harness: BenchmarkHarness,
  operation: IssuedTaskNotesOperation,
  notes: string,
): UpdateTaskNotesRequest {
  const task = (harness.workspace.sharedState.tasks as JsonObject)[TASK_ID] as JsonObject;
  return {
    baseContentVersion: createTaskNotesContentVersion(String(task.notes)),
    notes,
    operationCapability: operation.operationCapability,
    operationId: operation.operationId,
    taskId: TASK_ID,
    taskIncarnation: TASK_INCARNATION,
  };
}

function canonicalToken(byteLength: 16 | 32, value: number): string {
  const bytes = Buffer.alloc(byteLength);
  bytes.writeUInt32BE(value >>> 0, byteLength - 4);
  return bytes.toString('base64url');
}

function createMaximumShapeSegment(): TaskNotesOperationSegment {
  const createSegment = (nulCount: number): TaskNotesOperationSegment => {
    const operations: Record<string, TaskNotesOperationRecord> = Object.create(null) as Record<
      string,
      TaskNotesOperationRecord
    >;
    const taskId = `${'\0'.repeat(nulCount)}${'a'.repeat(128 - nulCount)}`;
    for (let index = 0; index < TASK_NOTES_MAX_OPERATIONS_PER_WORKSPACE; index += 1) {
      const principalHash = canonicalToken(
        32,
        100 + Math.floor(index / TASK_NOTES_MAX_OPERATIONS_PER_PRINCIPAL),
      );
      const operationId = canonicalToken(16, index + 1);
      const record: TaskNotesOperationRecord = {
        admitUntil: '2026-08-03T00:10:00.000Z',
        admittedAt: '2026-08-03T00:00:00.000Z',
        capabilityHash: canonicalToken(32, 1),
        completedAt: '2026-08-03T00:00:00.000Z',
        fingerprint: canonicalToken(32, 2),
        operationId,
        outcome: {
          changed: true,
          committedContentVersion: canonicalToken(32, 3),
          committedWorkspaceRevision: Number.MAX_SAFE_INTEGER,
          kind: 'saved',
        },
        principalHash,
        replayUntil: '2026-08-04T00:00:00.000Z',
        retireAfter: '2026-08-04T00:00:00.000Z',
        state: 'terminal',
        taskId,
        taskIdentityWitness: canonicalToken(32, 4),
      };
      operations[`${principalHash}.${operationId}`] = record;
    }
    return { formatVersion: 1, operations };
  };

  let nulCount = 128;
  let segment = createSegment(nulCount);
  while (getTaskNotesOperationSegmentBytes(segment) > TASK_NOTES_MAX_OPERATION_SEGMENT_BYTES) {
    nulCount -= 1;
    if (nulCount < 0) throw new Error('Maximum-count operation fixture cannot fit the byte cap');
    segment = createSegment(nulCount);
  }
  return segment;
}

function maximumSnapshot(taskId: string, notes: string): TaskNotesSnapshot {
  return {
    contentVersion: canonicalToken(32, 0),
    notes,
    taskId,
    taskIncarnation: canonicalToken(32, 0),
    workspaceRevision: Number.MAX_SAFE_INTEGER,
  };
}

function maximumCurrent(snapshot: TaskNotesSnapshot): TaskNotesCurrentEnvelope {
  return {
    relation: 'same-incarnation',
    currentNotes: { kind: 'present', snapshot },
    currentTask: {
      catalogVersion: Number.MAX_SAFE_INTEGER,
      serverInstanceId: '00000000-0000-0000-0000-000000000000',
      taskClosing: false,
      taskIncarnation: snapshot.taskIncarnation,
      taskState: 'present',
    },
  };
}

describe('TaskNotesService executable performance contracts', () => {
  it('keeps exact 100 KiB validation, content hash, and capability fingerprint below 3ms p95', () => {
    const notes = '\0'.repeat(TASK_NOTES_MAX_BYTES);
    const request: UpdateTaskNotesRequest = {
      baseContentVersion: canonicalToken(32, 5),
      notes,
      operationCapability: canonicalToken(32, 6),
      operationId: canonicalToken(16, 7),
      taskId: '\0'.repeat(128),
      taskIncarnation: canonicalToken(32, 8),
    };
    expect(isUpdateTaskNotesRequest(request)).toBe(true);
    for (let index = 0; index < 20; index += 1) {
      getWellFormedUtf8ByteLength(notes);
      createTaskNotesContentVersion(notes);
      createTaskNotesOperationFingerprint(request);
    }

    const beforeHeap = process.memoryUsage().heapUsed;
    const samples = new Float64Array(HASH_SAMPLE_COUNT);
    for (let index = 0; index < HASH_SAMPLE_COUNT; index += 1) {
      const startedAt = performance.now();
      const byteLength = getWellFormedUtf8ByteLength(notes);
      const contentVersion = createTaskNotesContentVersion(notes);
      const fingerprint = createTaskNotesOperationFingerprint(request);
      samples[index] = performance.now() - startedAt;
      if (byteLength !== TASK_NOTES_MAX_BYTES || !contentVersion || !fingerprint) {
        throw new Error('100 KiB benchmark left the production validation/hash path');
      }
    }
    const distribution = reportDistribution(
      'task-notes-100k-validation-hash-fingerprint',
      samples,
      HASH_P95_BUDGET_MS,
    );
    process.stdout.write(
      `task-notes-100k-heap-delta bytes=${Math.max(0, process.memoryUsage().heapUsed - beforeHeap)}\n`,
    );
    expect(distribution.p95).toBeLessThan(HASH_P95_BUDGET_MS);
  });

  it('keeps an authenticated coherent read below the service-boundary p95 budget', async () => {
    const harness = createHarness();
    for (let index = 0; index < 100; index += 1) {
      await harness.service.getTaskNotes(harness.principal, { taskId: TASK_ID });
    }

    const samples = new Float64Array(READ_SAMPLE_COUNT);
    for (let index = 0; index < READ_SAMPLE_COUNT; index += 1) {
      const startedAt = performance.now();
      const result = await harness.service.getTaskNotes(harness.principal, { taskId: TASK_ID });
      samples[index] = performance.now() - startedAt;
      if (!result.ok || result.result.kind !== 'loaded') {
        throw new Error('Task notes read benchmark left the stable loaded path');
      }
    }
    const distribution = reportDistribution('task-notes-service-read', samples, READ_P95_BUDGET_MS);
    expect(distribution.p95).toBeLessThan(READ_P95_BUDGET_MS);
    expect(harness.workspace.operations).toHaveLength(0);
  });

  it('classifies 10,000 acknowledged saves, replay, and closing with bounded records and writes', async () => {
    const harness = createHarness();
    const samples = new Float64Array(AUTOSAVE_SAMPLE_COUNT);
    let acknowledgement: AcknowledgedTaskNotesOperation | undefined;
    let lastRequest: UpdateTaskNotesRequest | undefined;
    let maxLiveRecords = 0;

    for (let index = 0; index < AUTOSAVE_SAMPLE_COUNT; index += 1) {
      const operationCount = harness.workspace.operations.length;
      const changedWriteCount = harness.workspace.changedWrites;
      const startedAt = performance.now();
      const operation = await issueOperation(
        harness,
        acknowledgement ? [acknowledgement] : undefined,
      );
      const request = updateRequest(harness, operation, `saved-note-${index}`);
      const result = await harness.service.updateTaskNotes(harness.principal, request);
      samples[index] = performance.now() - startedAt;
      if (
        !result.ok ||
        result.result.kind !== 'completed' ||
        result.result.originalOutcome.kind !== 'saved' ||
        !result.result.originalOutcome.changed
      ) {
        throw new Error(`Autosave ${index} did not reach the changed terminal path`);
      }
      if (
        harness.workspace.operations.length - operationCount !== 3 ||
        harness.workspace.changedWrites - changedWriteCount !== 3
      ) {
        throw new Error(`Autosave ${index} violated Issue/admission/terminal write counts`);
      }
      const liveRecords = Object.keys(
        readTaskNotesOperationSegment(harness.workspace.privateState).operations,
      ).length;
      maxLiveRecords = Math.max(maxLiveRecords, liveRecords);
      if (liveRecords >= 4) throw new Error(`Autosave ${index} retained ${liveRecords} records`);
      acknowledgement = {
        operationCapability: operation.operationCapability,
        operationId: operation.operationId,
      };
      lastRequest = request;
      harness.now.value += 1;
    }

    const distribution = reportDistribution(
      'task-notes-issue-save',
      samples,
      ISSUE_SAVE_P95_BUDGET_MS,
    );
    process.stdout.write(
      `task-notes-autosave writes=${harness.workspace.changedWrites} privateWrites=${harness.workspace.changedPrivateWrites} sharedWrites=${harness.workspace.changedSharedWrites} admissions=${harness.structural.admissionCount} events=${harness.structural.eventCount} maxLiveRecords=${maxLiveRecords}\n`,
    );
    expect(distribution.p95).toBeLessThan(ISSUE_SAVE_P95_BUDGET_MS);
    expect(maxLiveRecords).toBeLessThan(4);
    expect(harness.workspace.operations).toHaveLength(AUTOSAVE_SAMPLE_COUNT * 3);
    expect(harness.workspace.changedWrites).toBe(AUTOSAVE_SAMPLE_COUNT * 3);
    expect(harness.workspace.changedPrivateWrites).toBe(AUTOSAVE_SAMPLE_COUNT * 3);
    expect(harness.workspace.changedSharedWrites).toBe(AUTOSAVE_SAMPLE_COUNT);
    expect(harness.structural.admissionCount).toBe(AUTOSAVE_SAMPLE_COUNT);
    expect(harness.structural.eventCount).toBe(AUTOSAVE_SAMPLE_COUNT);

    if (!lastRequest || !acknowledgement) throw new Error('Autosave fixture did not complete');
    const replayBaseline = {
      admissions: harness.structural.admissionCount,
      events: harness.structural.eventCount,
      inspections: harness.workspace.inspections.length,
      operations: harness.workspace.operations.length,
      revision: harness.workspace.revision,
      writes: harness.workspace.changedWrites,
    };
    const replayStartedAt = performance.now();
    const replay = await harness.service.updateTaskNotes(harness.principal, lastRequest);
    const replayMs = performance.now() - replayStartedAt;
    expect(replay).toMatchObject({ ok: true, result: { kind: 'completed', replayed: true } });
    expect(harness.workspace.operations).toHaveLength(replayBaseline.operations);
    expect(harness.workspace.changedWrites).toBe(replayBaseline.writes);
    expect(harness.workspace.revision).toBe(replayBaseline.revision);
    expect(harness.structural.admissionCount).toBe(replayBaseline.admissions);
    expect(harness.structural.eventCount).toBe(replayBaseline.events);
    expect(harness.workspace.inspections).toHaveLength(replayBaseline.inspections + 1);

    const closingOperation = await issueOperation(harness, [acknowledgement]);
    const closingRequest = updateRequest(harness, closingOperation, 'closing-note');
    const closingQueueBaseline = harness.workspace.operations.length;
    const closingWriteBaseline = harness.workspace.changedWrites;
    harness.structural.admission = { kind: 'task-closing' };
    const closing = await harness.service.updateTaskNotes(harness.principal, closingRequest);
    expect(closing).toMatchObject({ ok: true, result: { kind: 'task-closing' } });
    expect(harness.workspace.operations).toHaveLength(closingQueueBaseline);
    expect(harness.workspace.changedWrites).toBe(closingWriteBaseline);
    process.stdout.write(`task-notes-terminal-replay latency=${replayMs.toFixed(3)}ms writes=0\n`);
  }, 120_000);

  it('guards and replaces the maximum-count, maximum-encoded legal operation segment', () => {
    const segment = createMaximumShapeSegment();
    assertTaskNotesOperationSegment(segment);
    const records = Object.values(segment.operations);
    const recordBytes = records.map(getTaskNotesOperationRecordBytes);
    const segmentBytes = getTaskNotesOperationSegmentBytes(segment);
    expect(records).toHaveLength(TASK_NOTES_MAX_OPERATIONS_PER_WORKSPACE);
    expect(Math.max(...recordBytes)).toBeLessThanOrEqual(TASK_NOTES_MAX_OPERATION_RECORD_BYTES);
    expect(segmentBytes).toBeLessThanOrEqual(TASK_NOTES_MAX_OPERATION_SEGMENT_BYTES);

    const privateState = withTaskNotesOperationSegment({}, segment);
    readTaskNotesOperationSegment(privateState);
    const guardSamples: number[] = [];
    const replaceSamples: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      let startedAt = performance.now();
      readTaskNotesOperationSegment(privateState);
      guardSamples.push(performance.now() - startedAt);
      startedAt = performance.now();
      withTaskNotesOperationSegment({}, segment);
      replaceSamples.push(performance.now() - startedAt);
    }
    const guard = reportDistribution(
      'task-notes-max-segment-read-guard',
      guardSamples,
      SEGMENT_GUARD_P95_BUDGET_MS,
    );
    const replace = reportDistribution(
      'task-notes-max-segment-replace',
      replaceSamples,
      SEGMENT_REPLACE_P95_BUDGET_MS,
    );
    process.stdout.write(
      `task-notes-max-segment bytes=${segmentBytes} ceiling=${TASK_NOTES_MAX_OPERATION_SEGMENT_BYTES} records=${records.length} maxRecordBytes=${Math.max(...recordBytes)}\n`,
    );
    expect(guard.p95).toBeLessThan(SEGMENT_GUARD_P95_BUDGET_MS);
    expect(replace.p95).toBeLessThan(SEGMENT_REPLACE_P95_BUDGET_MS);

    const extra = clone(records[0]);
    extra.operationId = canonicalToken(16, TASK_NOTES_MAX_OPERATIONS_PER_WORKSPACE + 1);
    extra.principalHash = canonicalToken(32, 999);
    const overCount: TaskNotesOperationSegment = {
      formatVersion: 1,
      operations: {
        ...segment.operations,
        [`${extra.principalHash}.${extra.operationId}`]: extra,
      },
    };
    expect(() => assertTaskNotesOperationSegment(overCount)).toThrow('workspace limit');
    expect(privateState[TASK_NOTES_OPERATIONS_PRIVATE_STATE_KEY]).toBeDefined();
  }, 120_000);

  it('pins exact legal-control request/result and invalidation wire maxima', () => {
    const token = canonicalToken(32, 0);
    const operationId = canonicalToken(16, 0);
    const maximumRequest: UpdateTaskNotesRequest = {
      baseContentVersion: token,
      notes: '\0'.repeat(TASK_NOTES_MAX_BYTES),
      operationCapability: token,
      operationId,
      taskId: '\0'.repeat(128),
      taskIncarnation: token,
    };
    const unescapedRequest = {
      ...maximumRequest,
      notes: 'a'.repeat(TASK_NOTES_MAX_BYTES),
      taskId: 'a'.repeat(128),
    };
    expect(isUpdateTaskNotesRequest(maximumRequest)).toBe(true);

    const maximumCurrentValue = maximumCurrent(
      maximumSnapshot(maximumRequest.taskId, maximumRequest.notes),
    );
    const loadedResult = { current: maximumCurrentValue, kind: 'loaded' };
    const loadedWire = { ok: true, result: loadedResult };
    const completedWire = {
      ok: true,
      result: {
        current: maximumCurrentValue,
        effectiveRetireAfter: MAX_DEADLINE,
        kind: 'completed',
        originalOutcome: {
          changed: false,
          committedContentVersion: token,
          committedWorkspaceRevision: Number.MAX_SAFE_INTEGER,
          kind: 'saved',
        },
        postCommitWarning: 'projection-repair-required',
        replayed: false,
      },
    };
    const unescapedCurrent = maximumCurrent(
      maximumSnapshot(unescapedRequest.taskId, unescapedRequest.notes),
    );
    const unescapedLoaded = { current: unescapedCurrent, kind: 'loaded' };
    const wireBytes = {
      escapedCompleted: Buffer.byteLength(JSON.stringify(completedWire)),
      escapedLoaded: Buffer.byteLength(JSON.stringify(loadedResult)),
      escapedLoadedWire: Buffer.byteLength(JSON.stringify(loadedWire)),
      escapedRequest: Buffer.byteLength(JSON.stringify(maximumRequest)),
      unescapedCompleted: Buffer.byteLength(
        JSON.stringify({
          ...completedWire,
          result: { ...completedWire.result, current: unescapedCurrent },
        }),
      ),
      unescapedLoaded: Buffer.byteLength(JSON.stringify(unescapedLoaded)),
      unescapedLoadedWire: Buffer.byteLength(JSON.stringify({ ok: true, result: unescapedLoaded })),
      unescapedRequest: Buffer.byteLength(JSON.stringify(unescapedRequest)),
    };
    expect(wireBytes).toEqual({
      escapedCompleted: 615_984,
      escapedLoaded: 615_675,
      escapedLoadedWire: 615_696,
      escapedRequest: 615_430,
      unescapedCompleted: 103_344,
      unescapedLoaded: 103_035,
      unescapedLoadedWire: 103_056,
      unescapedRequest: 102_790,
    });
    expect(wireBytes.escapedCompleted).toBeLessThan(TASK_NOTES_MAX_BODY_BYTES);

    const escapedNotification = serializeTaskNotesChangedNotification({
      sourceId: 'a'.repeat(64),
      taskId: '\0'.repeat(128),
      workspaceRevision: Number.MAX_SAFE_INTEGER,
    });
    const unescapedNotification = serializeTaskNotesChangedNotification({
      sourceId: 'a'.repeat(64),
      taskId: 'a'.repeat(128),
      workspaceRevision: Number.MAX_SAFE_INTEGER,
    });
    expect(Buffer.byteLength(escapedNotification)).toBe(TASK_NOTES_CHANGED_MAX_BYTES);
    expect(Buffer.byteLength(unescapedNotification)).toBe(256);
    expect(isTaskNotesChangedNotification(JSON.parse(escapedNotification))).toBe(true);
    process.stdout.write(
      `task-notes-wire-bytes ${JSON.stringify({ ...wireBytes, escapedInvalidation: Buffer.byteLength(escapedNotification), unescapedInvalidation: Buffer.byteLength(unescapedNotification) })}\n`,
    );
  });
});
