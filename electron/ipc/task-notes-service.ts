import {
  isGetTaskNotesRequest,
  isIssueTaskNotesOperationRequest,
  isTaskNotesOpaque32ByteToken,
  isTaskNotesRetryAfterMs,
  isUpdateTaskNotesRequest,
  normalizeTaskNotesSourceId,
  type CurrentTaskLifecycleProjection,
  type GetTaskNotesRequest,
  type GetTaskNotesResult,
  type IssuedTaskNotesOperation,
  type IssueTaskNotesOperationRequest,
  type IssueTaskNotesOperationResult,
  type TaskNotesChangedNotification,
  type TaskNotesCurrentEnvelope,
  type TaskNotesKnownDisposition,
  type TaskNotesOperationOutcome,
  type TaskNotesWireResponse,
  type UpdateTaskNotesRequest,
  type UpdateTaskNotesResult,
} from '../../src/domain/task-notes.js';
import {
  WorkspaceMutationDurabilityError,
  WorkspaceMutationNotCommittedError,
  WorkspaceMutationRecoveryError,
  changed,
  unchanged,
  type WorkspaceHostMutationSlices,
  type WorkspaceMutationRequest,
  type WorkspacePrivateSnapshotAuthority,
} from './workspace-state-mutations.js';
import { cloneJsonObject, type JsonObject } from './workspace-state-storage.js';
import {
  classifyTaskNotesOperation,
  createTaskNotesContentVersion,
  createTaskNotesOperationFingerprint,
  deriveTaskNotesIncarnation,
  findTaskNotesOperationRecord,
  hashTaskNotesPrincipal,
  materializeTaskNotesRecoveryWindow,
  readTaskNotesOperationSegment,
  replaceTaskNotesOperationRecord,
  reserveTaskNotesOperation,
  terminalizeTaskNotesOperation,
  withTaskNotesOperationSegment,
  type ClassifyTaskNotesOperationResult,
  type TaskNotesOperationRecord,
} from './task-notes-operations.js';
import {
  isTaskNotesWriterEntitled,
  snapshotTaskNotesWriterEntitlements,
  type TaskNotesWriterEntitlements,
  type TaskNotesWriterSurface,
} from './task-notes-writer-entitlements.js';

const DEFAULT_RETRY_AFTER_MS = 500;
const DEFAULT_MAX_FRESH_IN_FLIGHT = 64;
const DEFAULT_MAX_RECOVERY_IN_FLIGHT = 16;
const DEFAULT_MAX_PRINCIPAL_IN_FLIGHT = 8;

export interface TaskNotesPrincipalContext {
  principalHash: string;
  sourceId?: string | null;
  writerSurface?: TaskNotesWriterSurface;
}

export type TaskNotesCommonReadiness =
  | { kind: 'ready'; generation: string; writable: boolean }
  | { kind: 'unavailable'; retryAfterMs: number };

export type TaskNotesCurrentCollection =
  | {
      kind: 'collected';
      current: TaskNotesCurrentEnvelope;
      /** Private, fixed digest. It never crosses the service result boundary. */
      taskIdentityWitness?: string;
    }
  | { kind: 'unavailable'; retryAfterMs: number };

export interface TaskNotesMutationLease {
  release(): Promise<void> | void;
  /** Transfer release to the structural/common host-repair owner. */
  retainUntilHostDurable(
    proposal: 'admission-only' | 'retry-window-only' | 'terminal-outcome',
  ): void;
  /**
   * Keep removal pinned after both the terminal proposal and its mandatory
   * fresh retry-window proposal were proven absent. The same stable operation
   * may join this hold to materialize that window; unrelated host readiness is
   * not degraded.
   */
  retainUntilRetryWindowMaterialized(): void;
}

export type TaskNotesMutationAdmission =
  | { kind: 'admitted'; lease: TaskNotesMutationLease }
  | { kind: 'task-closing' }
  | { kind: 'task-state-unavailable'; retryAfterMs: number };

export type TaskNotesIdentityRecheck =
  | { kind: 'same-incarnation' }
  | { kind: 'task-incarnation-changed' }
  | { kind: 'task-state-unavailable' };

/**
 * Narrow consumer view of Design 13's sole structural owner. Implementations compute witnesses,
 * readiness, coherent current, registrations, drains, and fences; this service cannot enumerate or
 * mutate those structures.
 */
export interface TaskNotesStructuralAuthority {
  admitTaskMutationSet(args: {
    operationId: string;
    readinessGeneration: string;
    taskIds: readonly string[];
  }): Promise<TaskNotesMutationAdmission>;
  collectTaskNotesCurrentEnvelope(args: {
    expectedTaskIdentityWitness?: string;
    readinessGeneration: string;
    taskId: string;
  }): Promise<TaskNotesCurrentCollection>;
  getTaskNotesCommonReadiness(): TaskNotesCommonReadiness;
  reportTaskNotesCanonicalStateFailure(error: unknown): void;
  recheckTaskIdentityWitness(
    slices: Readonly<WorkspaceHostMutationSlices>,
    taskId: string,
    expectedTaskIdentityWitness: string,
  ): TaskNotesIdentityRecheck;
}

export interface TaskNotesServiceOptions {
  emitTaskNotesChanged?: (notification: TaskNotesChangedNotification) => Promise<void> | void;
  maxFreshInFlight?: number;
  maxPrincipalInFlight?: number;
  maxRecoveryInFlight?: number;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  writerEntitlements?: TaskNotesWriterEntitlements;
}

interface TaskNotesSemanticCompletion {
  outcome: TaskNotesOperationOutcome;
  record: Extract<TaskNotesOperationRecord, { state: 'terminal' }>;
}

interface TaskNotesSemanticCommit {
  completion: TaskNotesSemanticCompletion;
  postCommitWarning?: 'projection-repair-required';
}

interface ActiveTaskNotesOperation {
  fingerprint: string;
  lane: 'fresh' | 'recovery';
  principalHash: string;
  promise: Promise<TaskNotesWireResponse<UpdateTaskNotesResult>>;
}

type TaskNotesIssueMutationResult =
  | IssuedTaskNotesOperation
  | 'capacity-exhausted'
  | 'identity-collision';

type TaskNotesAdmissionRecord =
  | Extract<TaskNotesOperationRecord, { state: 'admitted' }>
  | Extract<TaskNotesOperationRecord, { state: 'terminal' }>;

class TaskNotesCanonicalStateError extends Error {}

class TaskNotesOperationExpiredError extends Error {
  constructor(readonly expiredAt: string) {
    super('Task notes operation expired while waiting for admission');
  }
}

class TaskNotesOperationIdentityError extends Error {}

function activeOperationKey(principalHash: string, operationId: string): string {
  return `${principalHash}.${operationId}`;
}

function taskNotesMutationRequest(
  operation: string,
  sourceId: string | null | undefined,
): WorkspaceMutationRequest {
  return {
    operation,
    ...(sourceId !== undefined ? { sourceId } : {}),
  };
}

function requirePositiveCapacity(value: number | undefined, fallback: number): number {
  const capacity = value ?? fallback;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError('Task notes in-flight capacity must be a positive safe integer');
  }
  return capacity;
}

function errorResponse<Result>(
  error: TaskNotesWireResponse<Result> & { ok: false },
): TaskNotesWireResponse<Result> {
  return error;
}

function unavailableGet(retryAfterMs: number): TaskNotesWireResponse<GetTaskNotesResult> {
  return {
    ok: true,
    result: {
      kind: 'task-state-unavailable',
      retryAfterMs: isTaskNotesRetryAfterMs(retryAfterMs) ? retryAfterMs : DEFAULT_RETRY_AFTER_MS,
    },
  };
}

function unavailableIssue(
  retryAfterMs: number,
): TaskNotesWireResponse<IssueTaskNotesOperationResult> {
  return {
    ok: true,
    result: {
      kind: 'task-state-unavailable',
      retryAfterMs: isTaskNotesRetryAfterMs(retryAfterMs) ? retryAfterMs : DEFAULT_RETRY_AFTER_MS,
    },
  };
}

function unavailableUpdate(
  retryAfterMs: number,
  knownDisposition: TaskNotesKnownDisposition,
): TaskNotesWireResponse<UpdateTaskNotesResult> {
  return {
    ok: true,
    result: {
      kind: 'task-state-unavailable',
      knownDisposition,
      retryAfterMs: isTaskNotesRetryAfterMs(retryAfterMs) ? retryAfterMs : DEFAULT_RETRY_AFTER_MS,
    },
  };
}

function getOwnTask(sharedState: Readonly<JsonObject>, taskId: string): JsonObject | null {
  const tasks = sharedState.tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
    throw new TaskNotesCanonicalStateError('Canonical task map is unavailable');
  }
  if (!Object.prototype.hasOwnProperty.call(tasks, taskId)) return null;
  const task = tasks[taskId];
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new TaskNotesCanonicalStateError('Canonical task record is invalid');
  }
  return task as JsonObject;
}

function requireTaskNotes(task: Readonly<JsonObject>): string {
  if (typeof task.notes !== 'string') {
    throw new TaskNotesCanonicalStateError('Canonical task notes are invalid');
  }
  // The domain hash performs exact well-formed UTF-8 and decoded-size validation.
  createTaskNotesContentVersion(task.notes);
  return task.notes;
}

function nextSharedRevision(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new TaskNotesCanonicalStateError('Canonical workspace revision is exhausted');
  }
  return current + 1;
}

function replaceTaskNotes(
  sharedState: Readonly<JsonObject>,
  taskId: string,
  notes: string,
): JsonObject {
  const nextSharedState = cloneJsonObject(sharedState as JsonObject);
  const tasks = nextSharedState.tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
    throw new TaskNotesCanonicalStateError('Canonical task map is unavailable');
  }
  const task = tasks[taskId];
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new TaskNotesCanonicalStateError('Canonical task record disappeared after admission');
  }
  (task as JsonObject).notes = notes;
  return nextSharedState;
}

function getGetResult(current: TaskNotesCurrentEnvelope): GetTaskNotesResult | null {
  switch (current.relation) {
    case 'same-incarnation':
      return { kind: 'loaded', current };
    case 'task-removed':
      return { kind: 'not-found', current };
    case 'task-not-visible':
      return { kind: 'not-visible', current };
    case 'task-replaced':
      return null;
  }
}

function getKnownCompleted(
  record: Extract<TaskNotesOperationRecord, { state: 'terminal' }>,
): Extract<TaskNotesKnownDisposition, { kind: 'completed' }> {
  return {
    kind: 'completed',
    originalOutcome: record.outcome,
    replayed: true,
    effectiveRetireAfter: record.retireAfter,
  };
}

export function createTaskNotesPrincipalContext(
  principal: string,
  sourceId?: string | null,
  writerSurface?: TaskNotesWriterSurface,
): TaskNotesPrincipalContext {
  return {
    principalHash: hashTaskNotesPrincipal(principal),
    ...(sourceId !== undefined ? { sourceId: normalizeTaskNotesSourceId(sourceId) } : {}),
    ...(writerSurface !== undefined ? { writerSurface } : {}),
  };
}

export class TaskNotesService {
  private readonly activeOperations = new Map<string, ActiveTaskNotesOperation>();
  private readonly activeOperationsByPrincipal = new Map<string, number>();
  private activeFreshOperations = 0;
  private activeRecoveryOperations = 0;
  private readonly maxFreshInFlight: number;
  private readonly maxPrincipalInFlight: number;
  private readonly maxRecoveryInFlight: number;
  private readonly now: () => number;
  private readonly writerEntitlements: TaskNotesWriterEntitlements;

  constructor(
    private readonly workspace: WorkspacePrivateSnapshotAuthority,
    private readonly structural: TaskNotesStructuralAuthority,
    private readonly options: TaskNotesServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.writerEntitlements = snapshotTaskNotesWriterEntitlements(options.writerEntitlements);
    this.maxFreshInFlight = requirePositiveCapacity(
      options.maxFreshInFlight,
      DEFAULT_MAX_FRESH_IN_FLIGHT,
    );
    this.maxPrincipalInFlight = requirePositiveCapacity(
      options.maxPrincipalInFlight,
      DEFAULT_MAX_PRINCIPAL_IN_FLIGHT,
    );
    this.maxRecoveryInFlight = requirePositiveCapacity(
      options.maxRecoveryInFlight,
      DEFAULT_MAX_RECOVERY_IN_FLIGHT,
    );
  }

  async getTaskNotes(
    principal: TaskNotesPrincipalContext,
    request: GetTaskNotesRequest,
  ): Promise<TaskNotesWireResponse<GetTaskNotesResult>> {
    if (!isGetTaskNotesRequest(request))
      return errorResponse({ ok: false, error: { code: 'bad-request' } });
    if (!isTaskNotesOpaque32ByteToken(principal.principalHash)) {
      return errorResponse({ ok: false, error: { code: 'unauthenticated' } });
    }
    const readiness = this.getCommonReadiness();
    if (readiness.kind === 'unavailable') return unavailableGet(readiness.retryAfterMs);
    const collected = await this.collectCurrent({
      readinessGeneration: readiness.generation,
      taskId: request.taskId,
    });
    if (collected.kind === 'unavailable') return unavailableGet(collected.retryAfterMs);
    const result = getGetResult(collected.current);
    return result ? { ok: true, result } : unavailableGet(DEFAULT_RETRY_AFTER_MS);
  }

  async issueTaskNotesOperation(
    principal: TaskNotesPrincipalContext,
    request: IssueTaskNotesOperationRequest,
  ): Promise<TaskNotesWireResponse<IssueTaskNotesOperationResult>> {
    if (!isIssueTaskNotesOperationRequest(request)) {
      return errorResponse({ ok: false, error: { code: 'bad-request' } });
    }
    if (!isTaskNotesOpaque32ByteToken(principal.principalHash)) {
      return errorResponse({ ok: false, error: { code: 'unauthenticated' } });
    }
    if (!this.isWriterEntitled(principal)) {
      return errorResponse({ ok: false, error: { code: 'forbidden' } });
    }
    const readiness = this.getCommonReadiness();
    if (readiness.kind === 'unavailable') return unavailableIssue(readiness.retryAfterMs);
    if (!readiness.writable) {
      return errorResponse({
        ok: false,
        error: { code: 'capacity-exhausted', retryAfterMs: DEFAULT_RETRY_AFTER_MS },
      });
    }
    const collected = await this.collectCurrent({
      readinessGeneration: readiness.generation,
      taskId: request.taskId,
    });
    if (collected.kind === 'unavailable') return unavailableIssue(collected.retryAfterMs);
    if (collected.current.relation === 'task-removed') {
      return { ok: true, result: { kind: 'not-found' } };
    }
    if (collected.current.relation === 'task-not-visible') {
      return { ok: true, result: { kind: 'not-visible' } };
    }
    if (collected.current.relation !== 'same-incarnation' || !collected.taskIdentityWitness) {
      return unavailableIssue(DEFAULT_RETRY_AFTER_MS);
    }
    if (
      deriveTaskNotesIncarnation(collected.taskIdentityWitness) !==
        collected.current.currentTask.taskIncarnation ||
      collected.current.currentTask.taskIncarnation !==
        collected.current.currentNotes.snapshot.taskIncarnation
    ) {
      this.structural.reportTaskNotesCanonicalStateFailure(
        new TaskNotesCanonicalStateError('Coherent current witness projection is inconsistent'),
      );
      return unavailableIssue(DEFAULT_RETRY_AFTER_MS);
    }
    if (request.taskIncarnation !== collected.current.currentTask.taskIncarnation) {
      return { ok: true, result: { kind: 'task-incarnation-changed' } };
    }
    const taskIdentityWitness = collected.taskIdentityWitness;

    try {
      const mutation = await this.workspace.mutate<TaskNotesIssueMutationResult>(
        taskNotesMutationRequest('issue-task-notes-operation', principal.sourceId),
        (slices) => {
          const segment = readTaskNotesOperationSegment(slices.privateState);
          const reservation = reserveTaskNotesOperation(
            segment,
            {
              ...(request.acknowledgedOperations !== undefined
                ? { acknowledgedOperations: request.acknowledgedOperations }
                : {}),
              now: this.now(),
              principalHash: principal.principalHash,
              ...(this.options.randomBytes ? { randomBytes: this.options.randomBytes } : {}),
              taskId: request.taskId,
              taskIdentityWitness,
            },
            new Set(this.activeOperations.keys()),
          );
          if (reservation.kind !== 'reserved') return unchanged(reservation.kind);
          return changed(
            {
              nextPrivateState: withTaskNotesOperationSegment(
                slices.privateState,
                reservation.segment,
              ),
            },
            reservation.operation,
          );
        },
      );
      if (typeof mutation.result === 'string') {
        return mutation.result === 'capacity-exhausted'
          ? errorResponse({
              ok: false,
              error: { code: 'capacity-exhausted', retryAfterMs: DEFAULT_RETRY_AFTER_MS },
            })
          : errorResponse({ ok: false, error: { code: 'internal-error', retryable: true } });
      }
      return { ok: true, result: { kind: 'issued', operation: mutation.result } };
    } catch (error) {
      if (error instanceof WorkspaceMutationNotCommittedError) {
        return errorResponse({
          ok: false,
          error: { code: 'persistence-unavailable', retryable: true },
        });
      }
      if (error instanceof WorkspaceMutationDurabilityError) {
        this.structural.reportTaskNotesCanonicalStateFailure(error);
        return {
          ok: true,
          result: {
            kind: 'durability-repair-required',
            acknowledgementReclamation: 'unknown',
            reservation: 'withheld',
          },
        };
      }
      if (error instanceof WorkspaceMutationRecoveryError) {
        this.structural.reportTaskNotesCanonicalStateFailure(error);
        return {
          ok: true,
          result: {
            kind: 'host-state-recovery-required',
            acknowledgementReclamation: 'unknown',
            reservation: 'withheld',
          },
        };
      }
      this.structural.reportTaskNotesCanonicalStateFailure(error);
      return errorResponse({ ok: false, error: { code: 'internal-error', retryable: false } });
    }
  }

  async updateTaskNotes(
    principal: TaskNotesPrincipalContext,
    request: UpdateTaskNotesRequest,
  ): Promise<TaskNotesWireResponse<UpdateTaskNotesResult>> {
    if (!isUpdateTaskNotesRequest(request)) {
      return errorResponse({ ok: false, error: { code: 'bad-request' } });
    }
    if (!isTaskNotesOpaque32ByteToken(principal.principalHash)) {
      return errorResponse({ ok: false, error: { code: 'unauthenticated' } });
    }
    let fingerprint: string;
    try {
      fingerprint = createTaskNotesOperationFingerprint(request);
    } catch {
      return errorResponse({ ok: false, error: { code: 'operation-identity-rejected' } });
    }
    const activeKey = activeOperationKey(principal.principalHash, request.operationId);
    const active = this.activeOperations.get(activeKey);
    if (active) {
      return active.fingerprint === fingerprint
        ? active.promise
        : errorResponse({ ok: false, error: { code: 'operation-identity-rejected' } });
    }

    const readiness = this.getCommonReadiness();
    if (readiness.kind === 'unavailable') {
      try {
        const classified = await this.inspectOperation(principal, request);
        if (classified.kind === 'replay') {
          return unavailableUpdate(readiness.retryAfterMs, getKnownCompleted(classified.record));
        }
      } catch {
        // The snapshot owner rejects in-flight, pending-durability, and recovery-ambiguous hosts
        // before invoking the classifier. No nonterminal disposition is observable while the
        // structural/current barrier is unavailable.
      }
      return unavailableUpdate(readiness.retryAfterMs, { kind: 'unsettled' });
    }

    let inspected: ClassifyTaskNotesOperationResult;
    try {
      inspected = await this.inspectOperation(principal, request);
    } catch (error) {
      if (
        error instanceof WorkspaceMutationDurabilityError ||
        error instanceof WorkspaceMutationRecoveryError
      ) {
        this.structural.reportTaskNotesCanonicalStateFailure(error);
        return unavailableUpdate(DEFAULT_RETRY_AFTER_MS, { kind: 'unsettled' });
      }
      if (error instanceof WorkspaceMutationNotCommittedError) {
        return errorResponse({
          ok: false,
          error: { code: 'persistence-unavailable', retryable: true },
        });
      }
      this.structural.reportTaskNotesCanonicalStateFailure(error);
      return errorResponse({ ok: false, error: { code: 'internal-error', retryable: false } });
    }
    if (inspected.kind === 'operation-identity-rejected') {
      return errorResponse({ ok: false, error: { code: 'operation-identity-rejected' } });
    }
    if (inspected.kind === 'operation-expired') {
      return { ok: true, result: inspected };
    }
    if (inspected.kind === 'replay') {
      return this.completeWithCurrent(readiness, request.taskId, inspected.record, true);
    }
    // Rollback/default-dark closes Issue and first Update admission, but exact admitted recovery
    // and absorbing terminal replay remain available so acknowledged work is never stranded.
    if (inspected.kind === 'admit' && !this.isWriterEntitled(principal)) {
      return errorResponse({ ok: false, error: { code: 'forbidden' } });
    }
    if (!readiness.writable) {
      return unavailableUpdate(DEFAULT_RETRY_AFTER_MS, { kind: 'unsettled' });
    }

    const inspectedFingerprint =
      inspected.kind === 'admit' ? inspected.fingerprint : inspected.record.fingerprint;
    if (inspectedFingerprint !== fingerprint) {
      return errorResponse({ ok: false, error: { code: 'operation-identity-rejected' } });
    }
    // Inspection is tentative and asynchronous. Another identical request may have reserved this
    // operation while this call was inspecting, so join it before charging capacity or touching the
    // structural admission owner.
    const racedActive = this.activeOperations.get(activeKey);
    if (racedActive) {
      return racedActive.fingerprint === fingerprint
        ? racedActive.promise
        : errorResponse({ ok: false, error: { code: 'operation-identity-rejected' } });
    }
    const lane = inspected.kind === 'resume' ? 'recovery' : 'fresh';
    if (!this.hasExecutionCapacity(principal.principalHash, lane)) {
      return this.executionCapacityRejection(inspected);
    }

    let resolveActive!: (result: TaskNotesWireResponse<UpdateTaskNotesResult>) => void;
    let rejectActive!: (error: unknown) => void;
    const promise = new Promise<TaskNotesWireResponse<UpdateTaskNotesResult>>((resolve, reject) => {
      resolveActive = resolve;
      rejectActive = reject;
    });
    // Reserve the stable operation identity and both counters synchronously before the first await
    // in structural admission. This prevents concurrent distinct operations from overbooking a
    // lane/principal and prevents identical requests from creating duplicate structural leases.
    this.trackActiveOperation(activeKey, {
      fingerprint,
      lane,
      principalHash: principal.principalHash,
      promise,
    });
    const clearActiveOperation = () => {
      if (this.activeOperations.get(activeKey)?.promise === promise) {
        this.untrackActiveOperation(activeKey);
      }
    };
    void promise.then(clearActiveOperation, clearActiveOperation);
    void this.admitAndExecuteUpdate(readiness, principal, request, inspected, fingerprint).then(
      resolveActive,
      rejectActive,
    );
    return promise;
  }

  private async admitAndExecuteUpdate(
    readiness: Extract<TaskNotesCommonReadiness, { kind: 'ready' }>,
    principal: TaskNotesPrincipalContext,
    request: UpdateTaskNotesRequest,
    inspected: Extract<ClassifyTaskNotesOperationResult, { kind: 'admit' | 'resume' }>,
    fingerprint: string,
  ): Promise<TaskNotesWireResponse<UpdateTaskNotesResult>> {
    let admission: TaskNotesMutationAdmission;
    try {
      admission = await this.structural.admitTaskMutationSet({
        operationId: request.operationId,
        readinessGeneration: readiness.generation,
        taskIds: [request.taskId],
      });
    } catch (error) {
      this.structural.reportTaskNotesCanonicalStateFailure(error);
      return unavailableUpdate(DEFAULT_RETRY_AFTER_MS, { kind: 'unsettled' });
    }
    if (admission.kind === 'task-state-unavailable') {
      return unavailableUpdate(admission.retryAfterMs, { kind: 'unsettled' });
    }
    if (admission.kind === 'task-closing') {
      // A terminal outcome can race the tentative snapshot and closing admission. Reinspect the
      // immutable operation store before returning closing so completed truth remains absorbing.
      let closingClassification: ClassifyTaskNotesOperationResult;
      try {
        closingClassification = await this.inspectOperation(principal, request);
      } catch (error) {
        this.structural.reportTaskNotesCanonicalStateFailure(error);
        return unavailableUpdate(DEFAULT_RETRY_AFTER_MS, { kind: 'unsettled' });
      }
      if (closingClassification.kind === 'replay') {
        return this.completeWithCurrent(
          readiness,
          request.taskId,
          closingClassification.record,
          true,
        );
      }
      return this.completeTaskClosing(
        readiness,
        request.taskId,
        inspected.record.taskIdentityWitness,
      );
    }
    return this.executeUpdate(
      readiness,
      principal,
      request,
      inspected,
      fingerprint,
      admission.lease,
    );
  }

  private async inspectOperation(
    principal: TaskNotesPrincipalContext,
    request: UpdateTaskNotesRequest,
  ): Promise<ClassifyTaskNotesOperationResult> {
    return this.workspace.inspect(
      taskNotesMutationRequest('inspect-task-notes-operation', principal.sourceId),
      (slices) => {
        const segment = readTaskNotesOperationSegment(slices.privateState);
        return classifyTaskNotesOperation(
          findTaskNotesOperationRecord(segment, principal.principalHash, request.operationId),
          { now: this.now(), principalHash: principal.principalHash, request },
        );
      },
    );
  }

  private async executeUpdate(
    readiness: Extract<TaskNotesCommonReadiness, { kind: 'ready' }>,
    principal: TaskNotesPrincipalContext,
    request: UpdateTaskNotesRequest,
    inspected: Extract<ClassifyTaskNotesOperationResult, { kind: 'admit' | 'resume' }>,
    fingerprint: string,
    lease: TaskNotesMutationLease,
  ): Promise<TaskNotesWireResponse<UpdateTaskNotesResult>> {
    let releaseLease = true;
    let proposal: 'admission-only' | 'retry-window-only' | 'terminal-outcome' = 'admission-only';
    let proposedOutcome: TaskNotesOperationOutcome | undefined;
    try {
      const admittedRecord = await this.persistAdmission(
        principal,
        request,
        fingerprint,
        inspected.kind === 'resume',
      );
      if (admittedRecord.state === 'terminal') {
        const released = await this.releaseLease(lease);
        releaseLease = false;
        if (!released) {
          return unavailableUpdate(DEFAULT_RETRY_AFTER_MS, getKnownCompleted(admittedRecord));
        }
        return await this.completeWithCurrent(readiness, request.taskId, admittedRecord, true);
      }
      proposal = 'terminal-outcome';
      const committed = await this.persistSemanticCompletion(
        principal,
        request,
        admittedRecord,
        (outcome) => {
          proposedOutcome = outcome;
        },
      );
      const warning = await this.emitCommittedChangeIfNeeded(
        principal,
        request,
        committed.completion.outcome,
      );
      const released = await this.releaseLease(lease);
      releaseLease = false;
      if (!released) {
        return unavailableUpdate(DEFAULT_RETRY_AFTER_MS, {
          ...getKnownCompleted(committed.completion.record),
          ...((committed.postCommitWarning ?? warning)
            ? { postCommitWarning: 'projection-repair-required' as const }
            : {}),
        });
      }
      return await this.completeWithCurrent(
        readiness,
        request.taskId,
        committed.completion.record,
        false,
        committed.postCommitWarning ?? warning,
      );
    } catch (error) {
      if (error instanceof TaskNotesOperationExpiredError) {
        return { ok: true, result: { kind: 'operation-expired', expiredAt: error.expiredAt } };
      }
      if (error instanceof TaskNotesOperationIdentityError) {
        return errorResponse({ ok: false, error: { code: 'operation-identity-rejected' } });
      }
      if (error instanceof WorkspaceMutationNotCommittedError) {
        if (proposal === 'terminal-outcome') {
          proposal = 'retry-window-only';
          try {
            await this.materializeRetryWindow(principal, request);
          } catch (repairError) {
            if (
              repairError instanceof WorkspaceMutationDurabilityError ||
              repairError instanceof WorkspaceMutationRecoveryError
            ) {
              releaseLease = false;
              const heldResult = this.mapHeldWorkspaceError(
                repairError,
                lease,
                'retry-window-only',
              );
              if (heldResult) return heldResult;
              throw new TaskNotesCanonicalStateError(
                'Workspace recovery error was not mapped to a held result',
              );
            }
            if (!(repairError instanceof WorkspaceMutationNotCommittedError)) {
              this.structural.reportTaskNotesCanonicalStateFailure(repairError);
              return errorResponse({
                ok: false,
                error: { code: 'internal-error', retryable: false },
              });
            }

            // The terminal proposal is proven absent, but its fresh recovery window is not yet
            // durable. Keep the operation-keyed structural registration pinned so removal cannot
            // fence past this admitted writer. A matching retry joins the same registration and
            // releases every retained holder only after the retry-window or terminal proposal is
            // durably classified.
            releaseLease = false;
            lease.retainUntilRetryWindowMaterialized();
            return {
              ok: true,
              result: {
                kind: 'durability-repair-required',
                replayed: false,
                retention: 'held',
                semanticProposal: 'retry-window-only',
              },
            };
          }
        }
        return errorResponse({
          ok: false,
          error: { code: 'persistence-unavailable', retryable: true },
        });
      }
      if (
        error instanceof WorkspaceMutationDurabilityError ||
        error instanceof WorkspaceMutationRecoveryError
      ) {
        releaseLease = false;
      }
      const mapped = this.mapHeldWorkspaceError(error, lease, proposal, proposedOutcome);
      if (mapped) {
        return mapped;
      }
      this.structural.reportTaskNotesCanonicalStateFailure(error);
      return errorResponse({ ok: false, error: { code: 'internal-error', retryable: false } });
    } finally {
      if (releaseLease) await this.releaseLease(lease);
    }
  }

  private async persistAdmission(
    principal: TaskNotesPrincipalContext,
    request: UpdateTaskNotesRequest,
    fingerprint: string,
    allowExpiredExactJoin: boolean,
  ): Promise<
    | Extract<TaskNotesOperationRecord, { state: 'admitted' }>
    | Extract<TaskNotesOperationRecord, { state: 'terminal' }>
  > {
    const mutation = await this.workspace.mutate<TaskNotesAdmissionRecord>(
      taskNotesMutationRequest('admit-task-notes-operation', principal.sourceId),
      (slices) => {
        const segment = readTaskNotesOperationSegment(slices.privateState);
        const classified = classifyTaskNotesOperation(
          findTaskNotesOperationRecord(segment, principal.principalHash, request.operationId),
          {
            allowExpiredExactJoin,
            now: this.now(),
            principalHash: principal.principalHash,
            request,
          },
        );
        if (classified.kind === 'replay') return unchanged(classified.record);
        if (classified.kind === 'resume') return unchanged(classified.record);
        if (classified.kind === 'operation-expired') {
          throw new TaskNotesOperationExpiredError(classified.expiredAt);
        }
        if (classified.kind !== 'admit' || classified.fingerprint !== fingerprint) {
          throw new TaskNotesOperationIdentityError(
            'Task notes admission identity changed in queue',
          );
        }
        const nextSegment = replaceTaskNotesOperationRecord(segment, classified.record);
        return changed(
          {
            nextPrivateState: withTaskNotesOperationSegment(slices.privateState, nextSegment),
          },
          classified.record,
        );
      },
    );
    return mutation.result;
  }

  private async persistSemanticCompletion(
    principal: TaskNotesPrincipalContext,
    request: UpdateTaskNotesRequest,
    admittedRecord: Extract<TaskNotesOperationRecord, { state: 'admitted' }>,
    onProposal: (outcome: TaskNotesOperationOutcome) => void,
  ): Promise<TaskNotesSemanticCommit> {
    const mutation = await this.workspace.mutate<TaskNotesSemanticCompletion>(
      taskNotesMutationRequest('complete-task-notes-operation', principal.sourceId),
      (slices) => {
        const segment = readTaskNotesOperationSegment(slices.privateState);
        const stored = findTaskNotesOperationRecord(
          segment,
          principal.principalHash,
          request.operationId,
        );
        const classified = classifyTaskNotesOperation(stored, {
          allowExpiredExactJoin: true,
          now: this.now(),
          principalHash: principal.principalHash,
          request,
        });
        if (classified.kind === 'replay') {
          return unchanged({ outcome: classified.record.outcome, record: classified.record });
        }
        if (
          classified.kind !== 'resume' ||
          classified.record.fingerprint !== admittedRecord.fingerprint
        ) {
          throw new TaskNotesCanonicalStateError('Task notes completion identity changed in queue');
        }

        const identity = this.structural.recheckTaskIdentityWitness(
          slices,
          request.taskId,
          admittedRecord.taskIdentityWitness,
        );
        let outcome: TaskNotesOperationOutcome;
        let nextSharedState: JsonObject | undefined;
        if (identity.kind === 'task-state-unavailable') {
          throw new TaskNotesCanonicalStateError(
            'Task identity could not be rechecked under lease',
          );
        }
        if (identity.kind === 'task-incarnation-changed') {
          outcome = {
            kind: 'task-incarnation-changed',
            observedWorkspaceRevision: slices.sharedRevision,
          };
        } else {
          const task = getOwnTask(slices.sharedState, request.taskId);
          if (!task) {
            throw new TaskNotesCanonicalStateError('Admitted task disappeared before note commit');
          }
          const currentNotes = requireTaskNotes(task);
          const currentContentVersion = createTaskNotesContentVersion(currentNotes);
          if (currentNotes === request.notes) {
            outcome = {
              kind: 'saved',
              changed: false,
              committedContentVersion: currentContentVersion,
              committedWorkspaceRevision: slices.sharedRevision,
            };
          } else if (currentContentVersion !== request.baseContentVersion) {
            outcome = {
              kind: 'conflict',
              observedContentVersion: currentContentVersion,
              observedWorkspaceRevision: slices.sharedRevision,
            };
          } else {
            const revision = nextSharedRevision(slices.sharedRevision);
            outcome = {
              kind: 'saved',
              changed: true,
              committedContentVersion: createTaskNotesContentVersion(request.notes),
              committedWorkspaceRevision: revision,
            };
            nextSharedState = replaceTaskNotes(slices.sharedState, request.taskId, request.notes);
          }
        }
        onProposal(outcome);
        const terminal = terminalizeTaskNotesOperation(classified.record, outcome, this.now());
        const nextSegment = replaceTaskNotesOperationRecord(segment, terminal);
        return changed(
          {
            nextPrivateState: withTaskNotesOperationSegment(slices.privateState, nextSegment),
            ...(nextSharedState ? { nextSharedState } : {}),
          },
          { outcome, record: terminal },
        );
      },
    );
    return {
      completion: mutation.result,
      ...(mutation.warning ? { postCommitWarning: 'projection-repair-required' as const } : {}),
    };
  }

  private async materializeRetryWindow(
    principal: TaskNotesPrincipalContext,
    request: UpdateTaskNotesRequest,
  ): Promise<void> {
    await this.workspace.mutate(
      taskNotesMutationRequest('repair-task-notes-retry-window', principal.sourceId),
      (slices) => {
        const segment = readTaskNotesOperationSegment(slices.privateState);
        const stored = findTaskNotesOperationRecord(
          segment,
          principal.principalHash,
          request.operationId,
        );
        if (!stored || stored.state === 'issued') {
          throw new TaskNotesCanonicalStateError('Admitted notes operation is missing');
        }
        const repaired = materializeTaskNotesRecoveryWindow(stored, this.now());
        return changed(
          {
            nextPrivateState: withTaskNotesOperationSegment(
              slices.privateState,
              replaceTaskNotesOperationRecord(segment, repaired),
            ),
          },
          undefined,
        );
      },
    );
  }

  private async completeTaskClosing(
    readiness: Extract<TaskNotesCommonReadiness, { kind: 'ready' }>,
    taskId: string,
    expectedTaskIdentityWitness: string,
  ): Promise<TaskNotesWireResponse<UpdateTaskNotesResult>> {
    const collected = await this.collectCurrent({
      expectedTaskIdentityWitness,
      readinessGeneration: readiness.generation,
      taskId,
    });
    return collected.kind === 'unavailable'
      ? unavailableUpdate(collected.retryAfterMs, { kind: 'task-closing' })
      : { ok: true, result: { kind: 'task-closing', current: collected.current, replayed: false } };
  }

  private async completeWithCurrent(
    readiness: Extract<TaskNotesCommonReadiness, { kind: 'ready' }>,
    taskId: string,
    record: Extract<TaskNotesOperationRecord, { state: 'terminal' }>,
    replayed: boolean,
    postCommitWarning?: 'projection-repair-required',
  ): Promise<TaskNotesWireResponse<UpdateTaskNotesResult>> {
    const collected = await this.collectCurrent({
      expectedTaskIdentityWitness: record.taskIdentityWitness,
      readinessGeneration: readiness.generation,
      taskId,
    });
    if (collected.kind === 'unavailable') {
      return unavailableUpdate(collected.retryAfterMs, {
        ...getKnownCompleted(record),
        ...(postCommitWarning ? { postCommitWarning } : {}),
      });
    }
    return {
      ok: true,
      result: {
        kind: 'completed',
        current: collected.current,
        effectiveRetireAfter: record.retireAfter,
        originalOutcome: record.outcome,
        replayed,
        ...(postCommitWarning ? { postCommitWarning } : {}),
      },
    };
  }

  private async emitCommittedChangeIfNeeded(
    principal: TaskNotesPrincipalContext,
    request: UpdateTaskNotesRequest,
    outcome: TaskNotesOperationOutcome,
  ): Promise<'projection-repair-required' | undefined> {
    if (outcome.kind !== 'saved' || !outcome.changed || !this.options.emitTaskNotesChanged) {
      return undefined;
    }
    try {
      await this.options.emitTaskNotesChanged({
        sourceId: principal.sourceId ?? null,
        taskId: request.taskId,
        workspaceRevision: outcome.committedWorkspaceRevision,
      });
      return undefined;
    } catch {
      return 'projection-repair-required';
    }
  }

  private getCommonReadiness(): TaskNotesCommonReadiness {
    try {
      return this.structural.getTaskNotesCommonReadiness();
    } catch (error) {
      this.structural.reportTaskNotesCanonicalStateFailure(error);
      return { kind: 'unavailable', retryAfterMs: DEFAULT_RETRY_AFTER_MS };
    }
  }

  private isWriterEntitled(principal: TaskNotesPrincipalContext): boolean {
    const surface = principal.writerSurface;
    return (
      surface !== undefined && isTaskNotesWriterEntitled(this.writerEntitlements[surface], surface)
    );
  }

  private async collectCurrent(args: {
    expectedTaskIdentityWitness?: string;
    readinessGeneration: string;
    taskId: string;
  }): Promise<TaskNotesCurrentCollection> {
    try {
      return await this.structural.collectTaskNotesCurrentEnvelope(args);
    } catch (error) {
      this.structural.reportTaskNotesCanonicalStateFailure(error);
      return { kind: 'unavailable', retryAfterMs: DEFAULT_RETRY_AFTER_MS };
    }
  }

  private async releaseLease(lease: TaskNotesMutationLease): Promise<boolean> {
    try {
      await lease.release();
      return true;
    } catch (error) {
      this.structural.reportTaskNotesCanonicalStateFailure(error);
      return false;
    }
  }

  private hasExecutionCapacity(principalHash: string, lane: 'fresh' | 'recovery'): boolean {
    if ((this.activeOperationsByPrincipal.get(principalHash) ?? 0) >= this.maxPrincipalInFlight) {
      return false;
    }
    return lane === 'fresh'
      ? this.activeFreshOperations < this.maxFreshInFlight
      : this.activeRecoveryOperations < this.maxRecoveryInFlight;
  }

  private executionCapacityRejection(
    inspected: Extract<ClassifyTaskNotesOperationResult, { kind: 'admit' | 'resume' }>,
  ): TaskNotesWireResponse<UpdateTaskNotesResult> {
    return inspected.kind === 'resume'
      ? {
          ok: true,
          result: {
            kind: 'recovery-busy',
            effectiveRetireAfter: inspected.record.retireAfter,
            retryAfterMs: DEFAULT_RETRY_AFTER_MS,
          },
        }
      : errorResponse({
          ok: false,
          error: { code: 'rate-limited', retryAfterMs: DEFAULT_RETRY_AFTER_MS },
        });
  }

  private trackActiveOperation(key: string, operation: ActiveTaskNotesOperation): void {
    this.activeOperations.set(key, operation);
    this.activeOperationsByPrincipal.set(
      operation.principalHash,
      (this.activeOperationsByPrincipal.get(operation.principalHash) ?? 0) + 1,
    );
    if (operation.lane === 'fresh') this.activeFreshOperations += 1;
    else this.activeRecoveryOperations += 1;
  }

  private untrackActiveOperation(key: string): void {
    const operation = this.activeOperations.get(key);
    if (!operation) return;
    this.activeOperations.delete(key);
    const principalCount = (this.activeOperationsByPrincipal.get(operation.principalHash) ?? 1) - 1;
    if (principalCount === 0) this.activeOperationsByPrincipal.delete(operation.principalHash);
    else this.activeOperationsByPrincipal.set(operation.principalHash, principalCount);
    if (operation.lane === 'fresh') this.activeFreshOperations -= 1;
    else this.activeRecoveryOperations -= 1;
  }

  private mapHeldWorkspaceError(
    error: unknown,
    lease: TaskNotesMutationLease,
    proposal: 'admission-only' | 'retry-window-only' | 'terminal-outcome',
    proposedOutcome?: TaskNotesOperationOutcome,
  ): TaskNotesWireResponse<UpdateTaskNotesResult> | null {
    if (error instanceof WorkspaceMutationDurabilityError) {
      lease.retainUntilHostDurable(proposal);
      if (proposal === 'terminal-outcome') {
        if (!proposedOutcome) {
          this.structural.reportTaskNotesCanonicalStateFailure(
            new TaskNotesCanonicalStateError('Terminal durability result is missing its outcome'),
          );
          return errorResponse({
            ok: false,
            error: { code: 'internal-error', retryable: false },
          });
        }
        return {
          ok: true,
          result: {
            kind: 'durability-repair-required',
            proposedOutcome,
            replayed: false,
            retention: 'held',
            semanticProposal: 'terminal-outcome',
          },
        };
      }
      return {
        ok: true,
        result:
          proposal === 'retry-window-only'
            ? {
                kind: 'durability-repair-required',
                replayed: false,
                retention: 'held',
                semanticProposal: 'retry-window-only',
              }
            : {
                kind: 'durability-repair-required',
                replayed: false,
                retention: 'held',
                semanticProposal: 'admission-only',
              },
      };
    }
    if (error instanceof WorkspaceMutationRecoveryError) {
      lease.retainUntilHostDurable(proposal);
      return {
        ok: true,
        result: { kind: 'host-state-recovery-required', replayed: false, retention: 'held' },
      };
    }
    return null;
  }
}

export function taskNotesLifecycleProjection(
  current: TaskNotesCurrentEnvelope,
): CurrentTaskLifecycleProjection {
  return current.currentTask;
}
