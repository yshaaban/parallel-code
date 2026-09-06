import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  isTaskShellSessionCurrentProjection,
  type ResolveTaskShellSessionAmbiguityRequest,
  type ResolveTaskShellSessionAmbiguityResult,
  type RetryTaskShellSessionOperationRequest,
  type RetryTaskShellSessionOperationResult,
  type TaskShellSessionCurrentProjection,
  type TaskShellSessionOperationReplay,
} from '../../src/domain/task-shell-session-operation.js';
import {
  isTaskCreationOperationCapability,
  type TaskCreationOperationCapability,
} from '../../src/domain/task-creation-ticket.js';
import {
  TASK_SHELL_SESSION_JOURNAL_FORMAT_VERSION,
  TASK_SHELL_SESSION_RETENTION_MS,
  deriveTaskShellSessionRecordDigest,
  type TaskShellSessionDeletionPendingRecord,
  type TaskShellSessionDeletionReconciliationRecord,
  type TaskShellSessionDeletionTombstoneRecord,
  type TaskShellSessionFullRecord,
  type TaskShellSessionIdentity,
  type TaskShellSessionJournal,
  type TaskShellSessionJournalRecord,
  type TaskShellSessionRestartRecord,
} from './task-shell-session-journal.js';

type RestartRecordForPhase<Phase extends TaskShellSessionRestartRecord['phase']> = Extract<
  TaskShellSessionRestartRecord,
  { phase: Phase }
>;

export interface ReserveTaskShellSessionOperationRequest {
  capabilityHash: string;
  creationOperationId: string;
  expectedGeneration: number;
  operationId: string;
  sessionId: string;
  taskId: string;
  workspacePrincipalHash: string;
}

export interface AdmitTaskShellSessionOperationRequest {
  committedWorkspaceRevision: number;
  creationOperationId: string;
  operationId: string;
  taskId: string;
}

export interface StartTaskShellSessionOperationRequest {
  creationOperationId: string;
  operationId: string;
  taskId: string;
}

export interface PrepareTaskShellSessionRemovalRequest {
  deletionOperationId: string;
  launchOperationId: string;
  preparedWorkspaceRevision: number;
  taskId: string;
  taskIdentityWitness: string;
}

export interface FinalizeTaskShellSessionRemovalRequest {
  deletionOperationId: string;
  launchOperationId: string;
  removedWorkspaceRevision: number;
  taskId: string;
}

export type TaskShellTupleInspection =
  | { kind: 'not-admitted' }
  | { kind: 'failed' }
  | { kind: 'running'; supervisorIdentityHash: string }
  | { kind: 'ambiguous'; supervisorIdentityHash: string | null };

export type TaskShellTupleSpawnResult =
  | { kind: 'accepted'; supervisorIdentityHash: string }
  | { kind: 'deferred-before-process' }
  | { kind: 'failed-before-process' }
  | { kind: 'ambiguous'; supervisorIdentityHash: string | null };

/**
 * One concrete PTY effect identity. The initial launch identity remains
 * immutable while a clean restart receives its own operation and generation.
 */
export interface TaskShellSessionRuntimeTupleIdentity extends TaskShellSessionIdentity {
  admissionKind: 'clean-restart' | 'initial' | 'unclean-recovery';
  initialExpectedGeneration: number;
  launchOperationId: string;
}

export interface TaskShellSessionTupleAuthority {
  closeExactOperationOwnedTuple(
    identity: Readonly<TaskShellSessionRuntimeTupleIdentity>,
  ): Promise<'closed' | 'already-absent' | 'proof-insufficient'>;
  inspectExactTuple(
    identity: Readonly<TaskShellSessionRuntimeTupleIdentity>,
  ): Promise<TaskShellTupleInspection>;
  spawnExactTuple(
    identity: Readonly<TaskShellSessionRuntimeTupleIdentity>,
  ): Promise<TaskShellTupleSpawnResult>;
}

export interface TaskShellSessionCleanRestartCandidate {
  candidateId: string;
  expectedRecordVersion: number;
  launchOperationId: string;
  sessionId: string;
  sourceGeneration: number;
  targetGeneration: number;
  taskId: string;
}

export type TaskShellSessionCleanRestartPermitResult =
  | {
      kind: 'prepared';
      operationId: string;
      sessionId: string;
      sourceGeneration: number;
      targetGeneration: number;
      taskId: string;
    }
  | {
      kind: 'unavailable';
      reason:
        | 'candidate-unavailable'
        | 'identity-unavailable'
        | 'journal-unavailable'
        | 'session-still-running'
        | 'stop-not-proven';
    };

export interface RestoreManagedTaskShellSessionRequest {
  launchOperationId: string;
  sessionId: string;
  taskId: string;
}

export type RestoreManagedTaskShellSessionResult =
  | {
      generation: number;
      kind: 'existing' | 'restored';
      sessionId: string;
      taskId: string;
    }
  | {
      kind: 'unavailable';
      reason:
        | 'clean-restart-permit-unavailable'
        | 'identity-unavailable'
        | 'initial-shell-reconciliation-required'
        | 'restore-failed'
        | 'session-state-unavailable'
        | 'task-unavailable';
    };

export type TaskShellCreationMappingInspection =
  | { kind: 'absent' }
  | { kind: 'ambiguous' }
  | { committedWorkspaceRevision: number; kind: 'committed' };

export interface TaskShellSessionWorkflowDependencies {
  authority: TaskShellSessionTupleAuthority;
  inspectCreationMapping(
    identity: Readonly<TaskShellSessionIdentity>,
  ): Promise<TaskShellCreationMappingInspection>;
  journal: TaskShellSessionJournal;
  now?: () => number;
  readCurrent(
    identity: Readonly<TaskShellSessionIdentity>,
  ): Promise<TaskShellSessionCurrentProjection>;
  verifyCreationReservation(
    request: Readonly<ReserveTaskShellSessionOperationRequest>,
  ): Promise<boolean>;
  verifyRemovalCommit(request: Readonly<FinalizeTaskShellSessionRemovalRequest>): Promise<boolean>;
  verifyTaskIdentityForRemoval(
    request: Readonly<PrepareTaskShellSessionRemovalRequest>,
    identity: Readonly<TaskShellSessionIdentity>,
  ): Promise<boolean>;
}

export interface TaskShellSessionStartupRepairResult {
  cancelledBeforeCommit: number;
  manualReconciliationRequired: number;
  promotedAfterCommit: number;
  runningRecovered: number;
}

export interface TaskShellSessionWorkflow {
  admitAfterTaskCommit(
    request: AdmitTaskShellSessionOperationRequest,
  ): Promise<TaskShellSessionOperationReplay>;
  abortCleanRestartDrain(): boolean;
  beginCleanRestartDrain(): Promise<TaskShellSessionCleanRestartCandidate[]>;
  beginTaskSuspension(taskId: string): Promise<TaskShellSessionCleanRestartCandidate[]>;
  cancelBeforeTaskCommit(operationId: string): Promise<TaskShellSessionOperationReplay>;
  finalizeTaskRemoval(
    request: FinalizeTaskShellSessionRemovalRequest,
  ): Promise<TaskShellSessionOperationReplay>;
  get(operationId: string): Promise<TaskShellSessionOperationReplay | null>;
  isTaskSpawnQuarantined(taskId: string): boolean;
  markTaskRemovalCommitted(
    request: FinalizeTaskShellSessionRemovalRequest,
  ): Promise<TaskShellSessionOperationReplay>;
  prepareTaskRemoval(
    request: PrepareTaskShellSessionRemovalRequest,
  ): Promise<TaskShellSessionOperationReplay>;
  persistCleanRestartPermit(
    candidate: Readonly<TaskShellSessionCleanRestartCandidate>,
  ): Promise<TaskShellSessionCleanRestartPermitResult>;
  repairAfterRestart(): Promise<TaskShellSessionStartupRepairResult>;
  reserveForTaskCommit(
    request: ReserveTaskShellSessionOperationRequest,
  ): Promise<TaskShellSessionOperationReplay>;
  resolveAmbiguity(
    request: ResolveTaskShellSessionAmbiguityRequest,
  ): Promise<ResolveTaskShellSessionAmbiguityResult>;
  retrySameTuple(
    request: RetryTaskShellSessionOperationRequest,
  ): Promise<RetryTaskShellSessionOperationResult>;
  restoreManagedSession(
    request: Readonly<RestoreManagedTaskShellSessionRequest>,
  ): Promise<RestoreManagedTaskShellSessionResult>;
  start(request: StartTaskShellSessionOperationRequest): Promise<TaskShellSessionOperationReplay>;
}

export class TaskShellSessionCapacityError extends Error {
  readonly code = 'terminal-launch-capacity';
}

export class TaskShellSessionConflictError extends Error {
  readonly code = 'task-shell-session-conflict';
}

export class TaskShellSessionJournalUnavailableError extends Error {
  readonly code = 'operation-journal-repair-required';
}

const SHA256 = /^[a-f0-9]{64}$/u;

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !value.includes('\u0000')
  );
}

function assertReserveRequest(request: ReserveTaskShellSessionOperationRequest): void {
  if (
    !isIdentity(request.operationId) ||
    !isIdentity(request.creationOperationId) ||
    !isIdentity(request.taskId) ||
    !isIdentity(request.sessionId) ||
    !isNonNegativeInteger(request.expectedGeneration) ||
    !SHA256.test(request.capabilityHash) ||
    !SHA256.test(request.workspacePrincipalHash)
  ) {
    throw new TaskShellSessionConflictError('Invalid initial shell reservation');
  }
}

function assertAdmitRequest(request: AdmitTaskShellSessionOperationRequest): void {
  if (
    !isIdentity(request.operationId) ||
    !isIdentity(request.creationOperationId) ||
    !isIdentity(request.taskId) ||
    !isPositiveInteger(request.committedWorkspaceRevision)
  ) {
    throw new TaskShellSessionConflictError('Invalid initial shell commit admission');
  }
}

function sameReservation(
  record: TaskShellSessionJournalRecord,
  request: ReserveTaskShellSessionOperationRequest,
): boolean {
  return (
    record.operationId === request.operationId &&
    record.creationOperationId === request.creationOperationId &&
    record.taskId === request.taskId &&
    record.sessionId === request.sessionId &&
    record.expectedGeneration === request.expectedGeneration &&
    record.workspacePrincipalHash === request.workspacePrincipalHash &&
    record.capabilityHash === request.capabilityHash
  );
}

function sameCreationIdentity(
  record: TaskShellSessionJournalRecord,
  request: StartTaskShellSessionOperationRequest,
): boolean {
  return (
    record.operationId === request.operationId &&
    record.creationOperationId === request.creationOperationId &&
    record.taskId === request.taskId
  );
}

function identity(record: TaskShellSessionJournalRecord): TaskShellSessionIdentity {
  return {
    committedWorkspaceRevision: record.committedWorkspaceRevision,
    creationOperationId: record.creationOperationId,
    expectedGeneration: record.expectedGeneration,
    operationId: record.operationId,
    sessionId: record.sessionId,
    taskId: record.taskId,
  };
}

function runtimeTupleIdentity(
  record: TaskShellSessionJournalRecord,
): TaskShellSessionRuntimeTupleIdentity {
  const restart = record.kind === 'restart-lifecycle' ? record : null;
  return {
    admissionKind:
      restart === null
        ? 'initial'
        : restart.phase === 'manual-reconciliation-required'
          ? 'unclean-recovery'
          : 'clean-restart',
    committedWorkspaceRevision: record.committedWorkspaceRevision,
    creationOperationId: record.creationOperationId,
    expectedGeneration: restart?.generationHighWater ?? record.expectedGeneration,
    initialExpectedGeneration: record.expectedGeneration,
    launchOperationId: record.operationId,
    operationId: restart?.restartOperationId ?? record.operationId,
    sessionId: record.sessionId,
    taskId: record.taskId,
  };
}

function isRunningRecord(record: TaskShellSessionJournalRecord): boolean {
  return (
    (record.kind === 'full' && record.phase === 'running') ||
    (record.kind === 'initial-launch-marker' && record.outcomeClass === 'running-at-ack') ||
    (record.kind === 'restart-lifecycle' && record.phase === 'running')
  );
}

function deriveRestartOperationId(args: {
  launchOperationId: string;
  sessionId: string;
  sourceGeneration: number;
  targetGeneration: number;
  taskId: string;
}): string {
  const hash = createHash('sha256')
    .update('task-shell-clean-restart:v1\0', 'utf8')
    .update(args.launchOperationId, 'utf8')
    .update('\0', 'utf8')
    .update(args.taskId, 'utf8')
    .update('\0', 'utf8')
    .update(args.sessionId, 'utf8')
    .update('\0', 'utf8')
    .update(String(args.sourceGeneration), 'utf8')
    .update('\0', 'utf8')
    .update(String(args.targetGeneration), 'utf8')
    .digest('hex');
  return `shell-restart:v1:${hash}`;
}

function deriveUncleanRecoveryOperationId(record: TaskShellSessionJournalRecord): string {
  const generation = runtimeTupleIdentity(record).expectedGeneration;
  const hash = createHash('sha256')
    .update('task-shell-unclean-recovery:v1\0', 'utf8')
    .update(record.operationId, 'utf8')
    .update('\0', 'utf8')
    .update(record.taskId, 'utf8')
    .update('\0', 'utf8')
    .update(record.sessionId, 'utf8')
    .update('\0', 'utf8')
    .update(String(generation), 'utf8')
    .digest('hex');
  return `shell-unclean:v1:${hash}`;
}

function hashCapability(capability: string): Buffer {
  if (!isTaskCreationOperationCapability(capability)) {
    throw new TaskShellSessionConflictError('Invalid initial shell operation capability');
  }
  const decoded = Buffer.from(capability, 'base64url');
  if (decoded.toString('base64url') !== capability) {
    throw new TaskShellSessionConflictError('Invalid initial shell operation capability');
  }
  return createHash('sha256').update(decoded).digest();
}

function capabilityMatches(record: TaskShellSessionJournalRecord, capability: string): boolean {
  const expected = Buffer.from(record.capabilityHash, 'hex');
  const actual = hashCapability(capability);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

function baseReplacement(
  record: TaskShellSessionJournalRecord,
  nowMs: number,
): Omit<TaskShellSessionFullRecord, 'kind' | 'phase'> {
  return {
    capabilityHash: record.capabilityHash,
    committedWorkspaceRevision: record.committedWorkspaceRevision,
    createdAtMs: record.createdAtMs,
    creationOperationId: record.creationOperationId,
    expectedGeneration: record.expectedGeneration,
    formatVersion: TASK_SHELL_SESSION_JOURNAL_FORMAT_VERSION,
    operationId: record.operationId,
    recordVersion: record.recordVersion + 1,
    sessionId: record.sessionId,
    taskId: record.taskId,
    updatedAtMs: nowMs,
    workspacePrincipalHash: record.workspacePrincipalHash,
  };
}

function toRunning(
  record: TaskShellSessionJournalRecord,
  supervisorIdentityHash: string,
  nowMs: number,
): TaskShellSessionFullRecord {
  if (!SHA256.test(supervisorIdentityHash)) {
    throw new TaskShellSessionConflictError('Invalid supervisor identity witness');
  }
  return {
    ...baseReplacement(record, nowMs),
    committedWorkspaceRevision: requireCommittedRevision(record),
    completedAtMs: nowMs,
    kind: 'full',
    phase: 'running',
    supervisorIdentityHash,
  };
}

function toFailed(
  record: TaskShellSessionJournalRecord,
  retryable: boolean,
  nowMs: number,
): TaskShellSessionFullRecord {
  return retryable
    ? {
        ...baseReplacement(record, nowMs),
        committedWorkspaceRevision: requireCommittedRevision(record),
        completedAtMs: nowMs,
        failureDisposition: 'same-tuple-retry',
        kind: 'full',
        phase: 'failed',
        retryUntilMs: nowMs + TASK_SHELL_SESSION_RETENTION_MS,
      }
    : {
        ...baseReplacement(record, nowMs),
        committedWorkspaceRevision: requireCommittedRevision(record),
        completedAtMs: nowMs,
        failureDisposition: 'attempted-no-replay',
        kind: 'full',
        phase: 'failed',
      };
}

function toManual(
  record: TaskShellSessionJournalRecord,
  supervisorIdentityHash: string | null,
  nowMs: number,
): TaskShellSessionFullRecord {
  if (supervisorIdentityHash !== null && !SHA256.test(supervisorIdentityHash)) {
    throw new TaskShellSessionConflictError('Invalid ambiguous supervisor witness');
  }
  return {
    ...baseReplacement(record, nowMs),
    committedWorkspaceRevision: requireCommittedRevision(record),
    kind: 'full',
    phase: 'manual-reconciliation-required',
    supervisorIdentityHash,
    taskSpawnQuarantined: true,
  };
}

function toRestartPending(
  record: TaskShellSessionJournalRecord,
  candidate: Readonly<TaskShellSessionCleanRestartCandidate>,
  supervisorIdentityHash: string,
  nowMs: number,
): RestartRecordForPhase<'clean-restart-pending'> {
  if (!SHA256.test(supervisorIdentityHash)) {
    throw new TaskShellSessionConflictError('Invalid clean-stop supervisor witness');
  }
  return {
    ...baseReplacement(record, nowMs),
    cleanStopSupervisorIdentityHash: supervisorIdentityHash,
    committedWorkspaceRevision: requireCommittedRevision(record),
    generationHighWater: candidate.targetGeneration,
    kind: 'restart-lifecycle',
    phase: 'clean-restart-pending',
    restartOperationId: deriveRestartOperationId(candidate),
    sourceGeneration: candidate.sourceGeneration,
  };
}

function toRestartSpawning(
  record: RestartRecordForPhase<'clean-restart-pending'>,
  nowMs: number,
): RestartRecordForPhase<'restart-spawning'> {
  return {
    ...baseReplacement(record, nowMs),
    cleanStopSupervisorIdentityHash: record.cleanStopSupervisorIdentityHash,
    committedWorkspaceRevision: requireCommittedRevision(record),
    generationHighWater: record.generationHighWater,
    kind: 'restart-lifecycle',
    phase: 'restart-spawning',
    restartOperationId: record.restartOperationId,
    sourceGeneration: record.sourceGeneration,
  };
}

function toRestartAwaiting(
  record:
    | RestartRecordForPhase<'clean-restart-pending'>
    | RestartRecordForPhase<'restart-spawning'>,
  supervisorIdentityHash: string,
  nowMs: number,
): RestartRecordForPhase<'restart-awaiting-spawn-ack'> {
  if (!SHA256.test(supervisorIdentityHash)) {
    throw new TaskShellSessionConflictError('Invalid restart supervisor witness');
  }
  return {
    ...baseReplacement(record, nowMs),
    cleanStopSupervisorIdentityHash: record.cleanStopSupervisorIdentityHash,
    committedWorkspaceRevision: requireCommittedRevision(record),
    generationHighWater: record.generationHighWater,
    kind: 'restart-lifecycle',
    phase: 'restart-awaiting-spawn-ack',
    restartOperationId: record.restartOperationId,
    sourceGeneration: record.sourceGeneration,
    supervisorIdentityHash,
  };
}

function toRestartRunning(
  record: TaskShellSessionRestartRecord,
  supervisorIdentityHash: string,
  nowMs: number,
): RestartRecordForPhase<'running'> {
  if (!SHA256.test(supervisorIdentityHash)) {
    throw new TaskShellSessionConflictError('Invalid restart supervisor witness');
  }
  return {
    ...baseReplacement(record, nowMs),
    committedWorkspaceRevision: requireCommittedRevision(record),
    completedAtMs: nowMs,
    generationHighWater: record.generationHighWater,
    kind: 'restart-lifecycle',
    phase: 'running',
    restartOperationId: record.restartOperationId,
    supervisorIdentityHash,
  };
}

function toRestartFailed(
  record: TaskShellSessionRestartRecord,
  nowMs: number,
): RestartRecordForPhase<'failed'> {
  return {
    ...baseReplacement(record, nowMs),
    committedWorkspaceRevision: requireCommittedRevision(record),
    completedAtMs: nowMs,
    generationHighWater: record.generationHighWater,
    kind: 'restart-lifecycle',
    phase: 'failed',
    restartOperationId: record.restartOperationId,
  };
}

function toRestartManual(
  record: TaskShellSessionJournalRecord,
  supervisorIdentityHash: string | null,
  nowMs: number,
): RestartRecordForPhase<'manual-reconciliation-required'> {
  if (supervisorIdentityHash !== null && !SHA256.test(supervisorIdentityHash)) {
    throw new TaskShellSessionConflictError('Invalid restart reconciliation witness');
  }
  const restart = record.kind === 'restart-lifecycle' ? record : null;
  return {
    ...baseReplacement(record, nowMs),
    committedWorkspaceRevision: requireCommittedRevision(record),
    generationHighWater: restart?.generationHighWater ?? record.expectedGeneration,
    kind: 'restart-lifecycle',
    phase: 'manual-reconciliation-required',
    restartOperationId: restart?.restartOperationId ?? deriveUncleanRecoveryOperationId(record),
    supervisorIdentityHash,
    taskSpawnQuarantined: true,
  };
}

function requireCommittedRevision(record: TaskShellSessionJournalRecord): number {
  if (!isPositiveInteger(record.committedWorkspaceRevision)) {
    throw new TaskShellSessionConflictError('Initial shell has no committed task revision');
  }
  return record.committedWorkspaceRevision;
}

function requireRecord(
  journal: TaskShellSessionJournal,
  operationId: string,
): TaskShellSessionJournalRecord {
  const record = journal.get(operationId);
  if (!record) throw new TaskShellSessionConflictError('Initial shell operation is unavailable');
  return record;
}

function outcomeClass(
  record: TaskShellSessionJournalRecord,
): 'proven-safe-active' | 'running-at-ack' | 'failed' | 'cancelled' {
  if (record.kind === 'initial-launch-marker') return record.outcomeClass;
  if (record.kind === 'restart-lifecycle') {
    if (record.phase === 'running') return 'running-at-ack';
    if (record.phase === 'failed') return 'failed';
    return 'proven-safe-active';
  }
  if (record.kind !== 'full') return 'proven-safe-active';
  if (record.phase === 'running') return 'running-at-ack';
  if (record.phase === 'failed') return 'failed';
  if (record.phase === 'cancelled') return 'cancelled';
  return 'proven-safe-active';
}

class TaskShellSessionWorkflowImpl implements TaskShellSessionWorkflow {
  private readonly quarantinedTaskIds = new Set<string>();
  private readonly operationQueues = new Map<string, Promise<void>>();
  private readonly cleanRestartCandidates = new Map<
    string,
    {
      candidate: TaskShellSessionCleanRestartCandidate;
      supervisorIdentityHash: string;
    }
  >();
  private cleanRestartDrainActive = false;
  private cleanRestartPermitPersisted = false;

  constructor(private readonly dependencies: TaskShellSessionWorkflowDependencies) {
    for (const record of dependencies.journal.list()) this.updateQuarantine(record);
  }

  abortCleanRestartDrain(): boolean {
    if (this.cleanRestartPermitPersisted) return false;
    this.cleanRestartCandidates.clear();
    this.cleanRestartDrainActive = false;
    return true;
  }

  async beginCleanRestartDrain(): Promise<TaskShellSessionCleanRestartCandidate[]> {
    if (this.cleanRestartDrainActive) {
      return [...this.cleanRestartCandidates.values()].map(({ candidate }) =>
        structuredClone(candidate),
      );
    }
    this.cleanRestartDrainActive = true;
    this.cleanRestartPermitPersisted = false;
    await this.waitForOperations();
    return this.captureCleanRestartCandidates();
  }

  beginTaskSuspension(taskId: string): Promise<TaskShellSessionCleanRestartCandidate[]> {
    return this.captureCleanRestartCandidates(taskId);
  }

  private async captureCleanRestartCandidates(
    taskId?: string,
  ): Promise<TaskShellSessionCleanRestartCandidate[]> {
    for (const observed of this.dependencies.journal.list()) {
      if (taskId !== undefined && observed.taskId !== taskId) continue;
      await this.serialized(observed.operationId, async () => {
        const record = requireRecord(this.dependencies.journal, observed.operationId);
        if (
          [...this.cleanRestartCandidates.values()].some(
            ({ candidate }) =>
              candidate.launchOperationId === record.operationId &&
              candidate.expectedRecordVersion === record.recordVersion,
          )
        )
          return;
        if (!isRunningRecord(record) || this.quarantinedTaskIds.has(record.taskId)) return;
        const current = await this.dependencies.readCurrent(identity(record));
        if (current.taskState !== 'present' || current.taskClosing) return;
        const mapping = await this.dependencies.inspectCreationMapping(identity(record));
        if (mapping.kind !== 'committed') return;
        const tuple = runtimeTupleIdentity(record);
        const inspection = await this.dependencies.authority.inspectExactTuple(tuple);
        if (inspection.kind !== 'running') return;
        if (tuple.expectedGeneration >= Number.MAX_SAFE_INTEGER) return;
        const candidate: TaskShellSessionCleanRestartCandidate = {
          candidateId: randomUUID(),
          expectedRecordVersion: record.recordVersion,
          launchOperationId: record.operationId,
          sessionId: record.sessionId,
          sourceGeneration: tuple.expectedGeneration,
          targetGeneration: tuple.expectedGeneration + 1,
          taskId: record.taskId,
        };
        this.cleanRestartCandidates.set(candidate.candidateId, {
          candidate,
          supervisorIdentityHash: inspection.supervisorIdentityHash,
        });
      });
    }
    return [...this.cleanRestartCandidates.values()].flatMap(({ candidate }) =>
      taskId === undefined || candidate.taskId === taskId ? [structuredClone(candidate)] : [],
    );
  }

  admitAfterTaskCommit(
    request: AdmitTaskShellSessionOperationRequest,
  ): Promise<TaskShellSessionOperationReplay> {
    this.assertSpawnAdmissionsOpen();
    return this.serialized(request.operationId, async () => {
      assertAdmitRequest(request);
      const record = requireRecord(this.dependencies.journal, request.operationId);
      if (
        record.creationOperationId !== request.creationOperationId ||
        record.taskId !== request.taskId
      ) {
        throw new TaskShellSessionConflictError('Initial shell commit mapping changed');
      }
      if (record.kind !== 'full' || record.phase !== 'reserved-for-task-commit') {
        if (record.committedWorkspaceRevision === request.committedWorkspaceRevision) {
          return this.replay(record);
        }
        throw new TaskShellSessionConflictError('Initial shell reservation is not promotable');
      }
      const observed = await this.dependencies.inspectCreationMapping(identity(record));
      if (
        observed.kind !== 'committed' ||
        observed.committedWorkspaceRevision !== request.committedWorkspaceRevision
      ) {
        throw new TaskShellSessionConflictError('Canonical task commit mapping is unavailable');
      }
      const proposed: TaskShellSessionFullRecord = {
        ...baseReplacement(record, this.now()),
        committedWorkspaceRevision: request.committedWorkspaceRevision,
        kind: 'full',
        phase: 'admitted',
      };
      await this.persist(proposed, record.recordVersion);
      return this.replay(proposed);
    });
  }

  cancelBeforeTaskCommit(operationId: string): Promise<TaskShellSessionOperationReplay> {
    return this.serialized(operationId, async () => {
      const record = requireRecord(this.dependencies.journal, operationId);
      if (record.kind === 'deletion-tombstone') return this.replay(record);
      if (record.kind !== 'full' || record.phase !== 'reserved-for-task-commit') {
        throw new TaskShellSessionConflictError('Initial shell reservation is already committed');
      }
      const nowMs = this.now();
      const proposed: TaskShellSessionDeletionTombstoneRecord = {
        ...baseReplacement(record, nowMs),
        committedWorkspaceRevision: null,
        completedAtMs: nowMs,
        expiresAtMs: nowMs + TASK_SHELL_SESSION_RETENTION_MS,
        kind: 'deletion-tombstone',
        outcome: 'cancelled-before-task-commit',
      };
      await this.persist(proposed, record.recordVersion);
      return this.replay(proposed);
    });
  }

  finalizeTaskRemoval(
    request: FinalizeTaskShellSessionRemovalRequest,
  ): Promise<TaskShellSessionOperationReplay> {
    return this.serialized(request.launchOperationId, async () => {
      const record = requireRecord(this.dependencies.journal, request.launchOperationId);
      if (record.kind === 'deletion-tombstone') {
        if (
          record.taskId === request.taskId &&
          record.outcome === 'task-removed-no-replay' &&
          (await this.dependencies.verifyRemovalCommit(request))
        ) {
          this.retireTaskCleanRestartCandidates(request.taskId, request.launchOperationId);
        }
        return this.replay(record);
      }
      if (
        record.kind !== 'deletion-pending' ||
        record.deletion.deletionOperationId !== request.deletionOperationId ||
        record.taskId !== request.taskId ||
        record.outcome !== 'task-removed-finalization-pending'
      ) {
        throw new TaskShellSessionConflictError('Initial shell removal is not finalizable');
      }
      if (!(await this.dependencies.verifyRemovalCommit(request))) {
        const reconciliation: TaskShellSessionDeletionReconciliationRecord = {
          ...baseReplacement(record, this.now()),
          committedWorkspaceRevision: requireCommittedRevision(record),
          deletion: record.deletion,
          kind: 'deletion-reconciliation-required',
          taskSpawnQuarantined: true,
        };
        await this.persist(reconciliation, record.recordVersion);
        return this.replay(reconciliation);
      }
      const nowMs = this.now();
      const tombstone: TaskShellSessionDeletionTombstoneRecord = {
        ...baseReplacement(record, nowMs),
        committedWorkspaceRevision: requireCommittedRevision(record),
        completedAtMs: nowMs,
        expiresAtMs: nowMs + TASK_SHELL_SESSION_RETENTION_MS,
        kind: 'deletion-tombstone',
        outcome: 'task-removed-no-replay',
      };
      await this.persist(tombstone, record.recordVersion);
      this.retireTaskCleanRestartCandidates(request.taskId, request.launchOperationId);
      return this.replay(tombstone);
    });
  }

  private retireTaskCleanRestartCandidates(taskId: string, launchOperationId: string): void {
    for (const [id, { candidate }] of this.cleanRestartCandidates) {
      if (candidate.taskId === taskId && candidate.launchOperationId === launchOperationId)
        this.cleanRestartCandidates.delete(id);
    }
  }

  async get(operationId: string): Promise<TaskShellSessionOperationReplay | null> {
    const record = this.dependencies.journal.get(operationId);
    if (!record) return null;
    if (
      record.kind === 'full' &&
      record.phase === 'failed' &&
      record.failureDisposition === 'same-tuple-retry' &&
      this.now() >= record.retryUntilMs
    ) {
      await this.dependencies.journal.compact(this.now());
      return this.replay(requireRecord(this.dependencies.journal, operationId));
    }
    return this.replay(record);
  }

  isTaskSpawnQuarantined(taskId: string): boolean {
    return this.quarantinedTaskIds.has(taskId);
  }

  markTaskRemovalCommitted(
    request: FinalizeTaskShellSessionRemovalRequest,
  ): Promise<TaskShellSessionOperationReplay> {
    return this.serialized(request.launchOperationId, async () => {
      const record = requireRecord(this.dependencies.journal, request.launchOperationId);
      if (
        record.kind !== 'deletion-pending' ||
        record.deletion.deletionOperationId !== request.deletionOperationId ||
        record.taskId !== request.taskId
      ) {
        throw new TaskShellSessionConflictError('Initial shell removal mapping changed');
      }
      if (record.outcome === 'task-removed-finalization-pending') return this.replay(record);
      if (!(await this.dependencies.verifyRemovalCommit(request))) {
        throw new TaskShellSessionConflictError('Canonical task removal is not committed');
      }
      const proposed: TaskShellSessionDeletionPendingRecord = {
        ...baseReplacement(record, this.now()),
        committedWorkspaceRevision: requireCommittedRevision(record),
        deletion: record.deletion,
        kind: 'deletion-pending',
        outcome: 'task-removed-finalization-pending',
      };
      await this.persist(proposed, record.recordVersion);
      return this.replay(proposed);
    });
  }

  prepareTaskRemoval(
    request: PrepareTaskShellSessionRemovalRequest,
  ): Promise<TaskShellSessionOperationReplay> {
    return this.serialized(request.launchOperationId, async () => {
      if (
        !isIdentity(request.deletionOperationId) ||
        !isIdentity(request.launchOperationId) ||
        !isIdentity(request.taskId) ||
        !isPositiveInteger(request.preparedWorkspaceRevision) ||
        !SHA256.test(request.taskIdentityWitness)
      ) {
        throw new TaskShellSessionConflictError('Invalid initial shell removal preparation');
      }
      const record = requireRecord(this.dependencies.journal, request.launchOperationId);
      if (record.kind === 'deletion-pending') {
        if (
          record.deletion.deletionOperationId === request.deletionOperationId &&
          record.taskId === request.taskId
        ) {
          return this.replay(record);
        }
        throw new TaskShellSessionConflictError('Initial shell removal operation changed');
      }
      if (
        record.taskId !== request.taskId ||
        !(await this.dependencies.verifyTaskIdentityForRemoval(request, identity(record)))
      ) {
        throw new TaskShellSessionConflictError('Initial shell removal identity is stale');
      }
      const proposed: TaskShellSessionDeletionPendingRecord = {
        ...baseReplacement(record, this.now()),
        committedWorkspaceRevision: requireCommittedRevision(record),
        deletion: {
          deletionOperationId: request.deletionOperationId,
          preparedWorkspaceRevision: request.preparedWorkspaceRevision,
          priorCanonicalDigest: deriveTaskShellSessionRecordDigest(record),
          priorOutcomeClass: outcomeClass(record),
          priorRecordVersion: record.recordVersion,
          taskIdentityWitness: request.taskIdentityWitness,
        },
        kind: 'deletion-pending',
        outcome: 'task-removal-not-committed',
      };
      await this.persist(proposed, record.recordVersion);
      return this.replay(proposed);
    });
  }

  async persistCleanRestartPermit(
    candidate: Readonly<TaskShellSessionCleanRestartCandidate>,
  ): Promise<TaskShellSessionCleanRestartPermitResult> {
    if (!this.isValidCleanRestartCandidate(candidate)) {
      return { kind: 'unavailable', reason: 'candidate-unavailable' };
    }
    const issued = this.cleanRestartCandidates.get(candidate.candidateId);
    if (!issued || !this.sameCleanRestartCandidate(issued.candidate, candidate)) {
      return { kind: 'unavailable', reason: 'candidate-unavailable' };
    }

    return this.serialized(candidate.launchOperationId, async () => {
      const record = this.dependencies.journal.get(candidate.launchOperationId);
      if (
        !record ||
        record.recordVersion !== candidate.expectedRecordVersion ||
        record.taskId !== candidate.taskId ||
        record.sessionId !== candidate.sessionId ||
        !isRunningRecord(record)
      ) {
        return { kind: 'unavailable', reason: 'identity-unavailable' } as const;
      }
      const tuple = runtimeTupleIdentity(record);
      if (
        tuple.expectedGeneration !== candidate.sourceGeneration ||
        candidate.targetGeneration !== candidate.sourceGeneration + 1
      ) {
        return { kind: 'unavailable', reason: 'identity-unavailable' } as const;
      }
      const current = await this.dependencies.readCurrent(identity(record));
      const mapping = await this.dependencies.inspectCreationMapping(identity(record));
      if (current.taskState !== 'present' || current.taskClosing || mapping.kind !== 'committed') {
        return { kind: 'unavailable', reason: 'identity-unavailable' } as const;
      }
      const inspection = await this.dependencies.authority.inspectExactTuple(tuple);
      if (inspection.kind === 'running') {
        return { kind: 'unavailable', reason: 'session-still-running' } as const;
      }
      // `failed` means this exact generation was consumed and no matching PTY
      // remains. `not-admitted` and `ambiguous` cannot prove that the process
      // observed by beginCleanRestartDrain was stopped by the caller.
      if (inspection.kind !== 'failed') {
        return { kind: 'unavailable', reason: 'stop-not-proven' } as const;
      }
      const pending = toRestartPending(
        record,
        candidate,
        issued.supervisorIdentityHash,
        this.now(),
      );
      try {
        await this.persist(pending, record.recordVersion);
      } catch {
        return { kind: 'unavailable', reason: 'journal-unavailable' } as const;
      }
      this.cleanRestartCandidates.delete(candidate.candidateId);
      if (this.cleanRestartDrainActive) this.cleanRestartPermitPersisted = true;
      return {
        kind: 'prepared',
        operationId: pending.restartOperationId,
        sessionId: pending.sessionId,
        sourceGeneration: candidate.sourceGeneration,
        targetGeneration: pending.generationHighWater,
        taskId: pending.taskId,
      } as const;
    });
  }

  async repairAfterRestart(): Promise<TaskShellSessionStartupRepairResult> {
    const result: TaskShellSessionStartupRepairResult = {
      cancelledBeforeCommit: 0,
      manualReconciliationRequired: 0,
      promotedAfterCommit: 0,
      runningRecovered: 0,
    };
    this.quarantinedTaskIds.clear();
    for (const observed of this.dependencies.journal.list()) {
      await this.serialized(observed.operationId, async () => {
        const record = requireRecord(this.dependencies.journal, observed.operationId);
        if (record.kind === 'restart-lifecycle') {
          if (record.phase === 'failed' || record.phase === 'manual-reconciliation-required') {
            this.updateQuarantine(record);
            return;
          }
          const inspection = await this.dependencies.authority.inspectExactTuple(
            runtimeTupleIdentity(record),
          );
          if (record.phase === 'clean-restart-pending') {
            if (inspection.kind === 'not-admitted') return;
            const manual = toRestartManual(
              record,
              inspection.kind === 'running' || inspection.kind === 'ambiguous'
                ? inspection.supervisorIdentityHash
                : null,
              this.now(),
            );
            await this.persist(manual, record.recordVersion);
            result.manualReconciliationRequired += 1;
            return;
          }
          if (
            inspection.kind === 'running' &&
            (record.phase !== 'restart-awaiting-spawn-ack' ||
              inspection.supervisorIdentityHash === record.supervisorIdentityHash)
          ) {
            if (record.phase !== 'running') {
              const running = toRestartRunning(
                record,
                inspection.supervisorIdentityHash,
                this.now(),
              );
              await this.persist(running, record.recordVersion);
              result.runningRecovered += 1;
            }
            return;
          }
          const manual = toRestartManual(
            record,
            inspection.kind === 'ambiguous' ? inspection.supervisorIdentityHash : null,
            this.now(),
          );
          await this.persist(manual, record.recordVersion);
          result.manualReconciliationRequired += 1;
          return;
        }
        if (
          isRunningRecord(record) &&
          (record.kind === 'full' || record.kind === 'initial-launch-marker')
        ) {
          const inspection = await this.dependencies.authority.inspectExactTuple(
            runtimeTupleIdentity(record),
          );
          if (inspection.kind === 'running') return;
          const manual = toRestartManual(
            record,
            inspection.kind === 'ambiguous' ? inspection.supervisorIdentityHash : null,
            this.now(),
          );
          await this.persist(manual, record.recordVersion);
          result.manualReconciliationRequired += 1;
          return;
        }
        if (record.kind !== 'full') {
          this.updateQuarantine(record);
          return;
        }
        if (record.phase === 'reserved-for-task-commit') {
          const mapping = await this.dependencies.inspectCreationMapping(identity(record));
          if (mapping.kind === 'absent') {
            await this.cancelBeforeTaskCommitInsideQueue(record);
            result.cancelledBeforeCommit += 1;
          } else if (mapping.kind === 'committed') {
            const proposed: TaskShellSessionFullRecord = {
              ...baseReplacement(record, this.now()),
              committedWorkspaceRevision: mapping.committedWorkspaceRevision,
              kind: 'full',
              phase: 'admitted',
            };
            await this.persist(proposed, record.recordVersion);
            result.promotedAfterCommit += 1;
          }
          return;
        }
        if (
          record.phase !== 'admitted' &&
          record.phase !== 'spawning' &&
          record.phase !== 'awaiting-spawn-ack'
        ) {
          this.updateQuarantine(record);
          return;
        }
        const inspection = await this.dependencies.authority.inspectExactTuple(
          runtimeTupleIdentity(record),
        );
        if (inspection.kind === 'running') {
          const running = toRunning(record, inspection.supervisorIdentityHash, this.now());
          await this.persist(running, record.recordVersion);
          result.runningRecovered += 1;
          return;
        }
        if (inspection.kind === 'failed') {
          const failed = toFailed(record, false, this.now());
          await this.persist(failed, record.recordVersion);
          return;
        }
        if (record.phase !== 'admitted' || inspection.kind === 'ambiguous') {
          const manual = toManual(
            record,
            inspection.kind === 'ambiguous' ? inspection.supervisorIdentityHash : null,
            this.now(),
          );
          await this.persist(manual, record.recordVersion);
          result.manualReconciliationRequired += 1;
        }
      });
    }
    return result;
  }

  reserveForTaskCommit(
    request: ReserveTaskShellSessionOperationRequest,
  ): Promise<TaskShellSessionOperationReplay> {
    this.assertSpawnAdmissionsOpen();
    return this.serialized(request.operationId, async () => {
      assertReserveRequest(request);
      const current = this.dependencies.journal.get(request.operationId);
      if (current) {
        if (!sameReservation(current, request)) {
          throw new TaskShellSessionConflictError('Initial shell operation identity changed');
        }
        return this.replay(current);
      }
      if (!(await this.dependencies.verifyCreationReservation(request))) {
        throw new TaskShellSessionConflictError('Creation operation cannot reserve this shell');
      }
      const nowMs = this.now();
      const record: TaskShellSessionFullRecord = {
        capabilityHash: request.capabilityHash,
        committedWorkspaceRevision: null,
        createdAtMs: nowMs,
        creationOperationId: request.creationOperationId,
        expectedGeneration: request.expectedGeneration,
        formatVersion: TASK_SHELL_SESSION_JOURNAL_FORMAT_VERSION,
        kind: 'full',
        operationId: request.operationId,
        phase: 'reserved-for-task-commit',
        recordVersion: 1,
        sessionId: request.sessionId,
        taskId: request.taskId,
        updatedAtMs: nowMs,
        workspacePrincipalHash: request.workspacePrincipalHash,
      };
      try {
        await this.persist(record, null);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('capacity')) throw error;
        await this.dependencies.journal.compact(nowMs);
        try {
          await this.persist(record, null);
        } catch (retryError) {
          if (retryError instanceof Error && retryError.message.includes('capacity')) {
            throw new TaskShellSessionCapacityError('Initial terminal launch capacity is full');
          }
          throw retryError;
        }
      }
      return this.replay(record);
    });
  }

  resolveAmbiguity(
    request: ResolveTaskShellSessionAmbiguityRequest,
  ): Promise<ResolveTaskShellSessionAmbiguityResult> {
    return this.serialized(request.operationId, async () => {
      const record = requireRecord(this.dependencies.journal, request.operationId);
      if (record.recordVersion !== request.expectedRecordVersion) {
        return { outcome: 'version-conflict', shellLaunch: await this.replay(record) };
      }
      if (
        (record.kind !== 'full' && record.kind !== 'restart-lifecycle') ||
        record.phase !== 'manual-reconciliation-required'
      ) {
        return { outcome: 'replayed', shellLaunch: await this.replay(record) };
      }
      let inspection = await this.dependencies.authority.inspectExactTuple(
        runtimeTupleIdentity(record),
      );
      if (request.action === 'adopt-if-exact-running') {
        if (inspection.kind !== 'running') {
          return { outcome: 'proof-insufficient', shellLaunch: await this.replay(record) };
        }
        const running =
          record.kind === 'restart-lifecycle'
            ? toRestartRunning(record, inspection.supervisorIdentityHash, this.now())
            : toRunning(record, inspection.supervisorIdentityHash, this.now());
        await this.persist(running, record.recordVersion);
        return { outcome: 'adopted', shellLaunch: await this.replay(running) };
      }
      if (request.action === 'close-exact-operation-owned-process') {
        const closed = await this.dependencies.authority.closeExactOperationOwnedTuple(
          runtimeTupleIdentity(record),
        );
        if (closed === 'proof-insufficient') {
          return { outcome: 'proof-insufficient', shellLaunch: await this.replay(record) };
        }
        inspection = { kind: 'not-admitted' };
      }
      if (inspection.kind !== 'not-admitted' && inspection.kind !== 'failed') {
        return { outcome: 'proof-insufficient', shellLaunch: await this.replay(record) };
      }
      const failed =
        record.kind === 'restart-lifecycle'
          ? toRestartFailed(record, this.now())
          : toFailed(record, false, this.now());
      await this.persist(failed, record.recordVersion);
      return { outcome: 'resolved-no-replay', shellLaunch: await this.replay(failed) };
    });
  }

  restoreManagedSession(
    request: Readonly<RestoreManagedTaskShellSessionRequest>,
  ): Promise<RestoreManagedTaskShellSessionResult> {
    if (
      this.cleanRestartDrainActive ||
      this.dependencies.journal.getHealth() !== 'healthy' ||
      !isIdentity(request.launchOperationId) ||
      !isIdentity(request.sessionId) ||
      !isIdentity(request.taskId)
    ) {
      return Promise.resolve({ kind: 'unavailable', reason: 'session-state-unavailable' });
    }
    return this.serialized(request.launchOperationId, async () => {
      try {
        if (this.cleanRestartDrainActive) {
          return { kind: 'unavailable', reason: 'session-state-unavailable' } as const;
        }
        const record = this.dependencies.journal.get(request.launchOperationId);
        if (
          !record ||
          record.operationId !== request.launchOperationId ||
          record.sessionId !== request.sessionId ||
          record.taskId !== request.taskId
        ) {
          return { kind: 'unavailable', reason: 'identity-unavailable' } as const;
        }
        if (
          record.kind === 'deletion-pending' ||
          record.kind === 'deletion-tombstone' ||
          record.kind === 'deletion-reconciliation-required'
        ) {
          return { kind: 'unavailable', reason: 'task-unavailable' } as const;
        }
        const current = await this.dependencies.readCurrent(identity(record));
        if (current.taskState === 'removed' || current.taskClosing) {
          return { kind: 'unavailable', reason: 'task-unavailable' } as const;
        }
        if (current.taskState !== 'present') {
          return { kind: 'unavailable', reason: 'identity-unavailable' } as const;
        }
        const mapping = await this.dependencies.inspectCreationMapping(identity(record));
        if (mapping.kind === 'absent') {
          return { kind: 'unavailable', reason: 'task-unavailable' } as const;
        }
        if (mapping.kind !== 'committed') {
          return { kind: 'unavailable', reason: 'identity-unavailable' } as const;
        }

        if (record.kind === 'full') {
          if (record.phase === 'admitted') {
            // Durable admitted state proves that no initial process attempt is outstanding.
            await this.startInsideQueue(record);
            const started = requireRecord(this.dependencies.journal, record.operationId);
            if (isRunningRecord(started)) {
              return {
                kind: 'restored',
                generation: runtimeTupleIdentity(started).expectedGeneration,
                sessionId: started.sessionId,
                taskId: started.taskId,
              } as const;
            }
            return { kind: 'unavailable', reason: 'session-state-unavailable' } as const;
          }
          if (record.phase === 'manual-reconciliation-required') {
            return {
              kind: 'unavailable',
              reason: 'initial-shell-reconciliation-required',
            } as const;
          }
          if (record.phase !== 'running') {
            return {
              kind: 'unavailable',
              reason:
                record.phase === 'failed' || record.phase === 'cancelled'
                  ? 'clean-restart-permit-unavailable'
                  : 'session-state-unavailable',
            } as const;
          }
          return this.restoreOrQuarantineRunningRecord(record);
        }
        if (record.kind === 'initial-launch-marker') {
          if (record.outcomeClass !== 'running-at-ack') {
            return {
              kind: 'unavailable',
              reason: 'clean-restart-permit-unavailable',
            } as const;
          }
          return this.restoreOrQuarantineRunningRecord(record);
        }
        switch (record.phase) {
          case 'running':
            return this.restoreOrQuarantineRunningRecord(record);
          case 'failed':
            return { kind: 'unavailable', reason: 'restore-failed' } as const;
          case 'manual-reconciliation-required':
            return {
              kind: 'unavailable',
              reason: 'initial-shell-reconciliation-required',
            } as const;
          case 'restart-spawning':
          case 'restart-awaiting-spawn-ack':
            return this.reconcilePresentedRestart(record);
          case 'clean-restart-pending':
            return this.restorePendingRestart(record);
        }
      } catch {
        return { kind: 'unavailable', reason: 'session-state-unavailable' } as const;
      }
    });
  }

  retrySameTuple(
    request: RetryTaskShellSessionOperationRequest,
  ): Promise<RetryTaskShellSessionOperationResult> {
    this.assertSpawnAdmissionsOpen();
    return this.serialized(request.operationId, async () => {
      let record = requireRecord(this.dependencies.journal, request.operationId);
      if (!capabilityMatches(record, request.operationCapability)) {
        throw new TaskShellSessionConflictError('Initial shell operation capability denied');
      }
      if (record.recordVersion !== request.expectedRecordVersion) {
        return { outcome: 'version-conflict', shellLaunch: await this.replay(record) };
      }
      if (
        record.kind !== 'full' ||
        record.phase !== 'failed' ||
        record.failureDisposition !== 'same-tuple-retry'
      ) {
        return { outcome: 'not-retryable', shellLaunch: await this.replay(record) };
      }
      if (this.now() >= record.retryUntilMs) {
        await this.dependencies.journal.compact(this.now());
        record = requireRecord(this.dependencies.journal, request.operationId);
        return { outcome: 'not-retryable', shellLaunch: await this.replay(record) };
      }
      const proposed: TaskShellSessionFullRecord = {
        ...baseReplacement(record, this.now()),
        committedWorkspaceRevision: requireCommittedRevision(record),
        kind: 'full',
        phase: 'admitted',
      };
      await this.persist(proposed, record.recordVersion);
      const shellLaunch = await this.startInsideQueue(proposed);
      return { outcome: 'accepted', shellLaunch };
    });
  }

  start(request: StartTaskShellSessionOperationRequest): Promise<TaskShellSessionOperationReplay> {
    this.assertSpawnAdmissionsOpen();
    return this.serialized(request.operationId, async () => {
      const record = requireRecord(this.dependencies.journal, request.operationId);
      if (!sameCreationIdentity(record, request)) {
        throw new TaskShellSessionConflictError('Initial shell start mapping changed');
      }
      return this.startInsideQueue(record);
    });
  }

  private async startInsideQueue(
    initial: TaskShellSessionJournalRecord,
  ): Promise<TaskShellSessionOperationReplay> {
    let record = initial;
    if (record.kind !== 'full') return this.replay(record);
    if (
      record.phase === 'running' ||
      record.phase === 'failed' ||
      record.phase === 'cancelled' ||
      record.phase === 'manual-reconciliation-required' ||
      record.phase === 'reserved-for-task-commit'
    ) {
      return this.replay(record);
    }
    if (record.phase === 'admitted') {
      const spawning: TaskShellSessionFullRecord = {
        ...baseReplacement(record, this.now()),
        committedWorkspaceRevision: requireCommittedRevision(record),
        kind: 'full',
        phase: 'spawning',
      };
      await this.persist(spawning, record.recordVersion);
      record = spawning;
    }
    const inspection = await this.dependencies.authority.inspectExactTuple(
      runtimeTupleIdentity(record),
    );
    if (inspection.kind === 'running') {
      const running = toRunning(record, inspection.supervisorIdentityHash, this.now());
      await this.persist(running, record.recordVersion);
      return this.replay(running);
    }
    if (inspection.kind === 'failed') {
      const failed = toFailed(record, false, this.now());
      await this.persist(failed, record.recordVersion);
      return this.replay(failed);
    }
    if (inspection.kind === 'ambiguous' || record.phase === 'awaiting-spawn-ack') {
      const manual = toManual(
        record,
        inspection.kind === 'ambiguous' ? inspection.supervisorIdentityHash : null,
        this.now(),
      );
      await this.persist(manual, record.recordVersion);
      return this.replay(manual);
    }
    const spawned = await this.dependencies.authority.spawnExactTuple(runtimeTupleIdentity(record));
    if (spawned.kind === 'deferred-before-process') {
      const admitted: TaskShellSessionFullRecord = {
        ...baseReplacement(record, this.now()),
        committedWorkspaceRevision: requireCommittedRevision(record),
        kind: 'full',
        phase: 'admitted',
      };
      await this.persist(admitted, record.recordVersion);
      return this.replay(admitted);
    }
    if (spawned.kind === 'failed-before-process') {
      const failed = toFailed(record, true, this.now());
      await this.persist(failed, record.recordVersion);
      return this.replay(failed);
    }
    if (spawned.kind === 'ambiguous') {
      const manual = toManual(record, spawned.supervisorIdentityHash, this.now());
      await this.persist(manual, record.recordVersion);
      return this.replay(manual);
    }
    const awaiting: TaskShellSessionFullRecord = {
      ...baseReplacement(record, this.now()),
      committedWorkspaceRevision: requireCommittedRevision(record),
      kind: 'full',
      phase: 'awaiting-spawn-ack',
      supervisorIdentityHash: spawned.supervisorIdentityHash,
    };
    await this.persist(awaiting, record.recordVersion);
    const acknowledged = await this.dependencies.authority.inspectExactTuple(
      runtimeTupleIdentity(awaiting),
    );
    if (
      acknowledged.kind === 'running' &&
      acknowledged.supervisorIdentityHash === awaiting.supervisorIdentityHash
    ) {
      const running = toRunning(awaiting, acknowledged.supervisorIdentityHash, this.now());
      await this.persist(running, awaiting.recordVersion);
      return this.replay(running);
    }
    if (acknowledged.kind === 'failed') {
      const failed = toFailed(awaiting, false, this.now());
      await this.persist(failed, awaiting.recordVersion);
      return this.replay(failed);
    }
    const manual = toManual(
      awaiting,
      acknowledged.kind === 'ambiguous'
        ? acknowledged.supervisorIdentityHash
        : awaiting.supervisorIdentityHash,
      this.now(),
    );
    await this.persist(manual, awaiting.recordVersion);
    return this.replay(manual);
  }

  private async restoreOrQuarantineRunningRecord(
    record:
      | TaskShellSessionFullRecord
      | TaskShellSessionRestartRecord
      | TaskShellSessionJournalRecord,
  ): Promise<RestoreManagedTaskShellSessionResult> {
    const tuple = runtimeTupleIdentity(record);
    const inspection = await this.dependencies.authority.inspectExactTuple(tuple);
    if (inspection.kind === 'running') {
      return {
        generation: tuple.expectedGeneration,
        kind: 'existing',
        sessionId: record.sessionId,
        taskId: record.taskId,
      };
    }
    const manual = toRestartManual(
      record,
      inspection.kind === 'ambiguous' ? inspection.supervisorIdentityHash : null,
      this.now(),
    );
    await this.persist(manual, record.recordVersion);
    return { kind: 'unavailable', reason: 'initial-shell-reconciliation-required' };
  }

  private async reconcilePresentedRestart(
    record:
      | RestartRecordForPhase<'restart-awaiting-spawn-ack'>
      | RestartRecordForPhase<'restart-spawning'>,
  ): Promise<RestoreManagedTaskShellSessionResult> {
    const inspection = await this.dependencies.authority.inspectExactTuple(
      runtimeTupleIdentity(record),
    );
    if (
      inspection.kind === 'running' &&
      (record.phase !== 'restart-awaiting-spawn-ack' ||
        inspection.supervisorIdentityHash === record.supervisorIdentityHash)
    ) {
      const running = toRestartRunning(record, inspection.supervisorIdentityHash, this.now());
      await this.persist(running, record.recordVersion);
      return {
        generation: running.generationHighWater,
        kind: 'existing',
        sessionId: running.sessionId,
        taskId: running.taskId,
      };
    }
    const manual = toRestartManual(
      record,
      inspection.kind === 'ambiguous' ? inspection.supervisorIdentityHash : null,
      this.now(),
    );
    await this.persist(manual, record.recordVersion);
    return { kind: 'unavailable', reason: 'initial-shell-reconciliation-required' };
  }

  private async restorePendingRestart(
    pending: RestartRecordForPhase<'clean-restart-pending'>,
  ): Promise<RestoreManagedTaskShellSessionResult> {
    const tuple = runtimeTupleIdentity(pending);
    const before = await this.dependencies.authority.inspectExactTuple(tuple);
    if (before.kind !== 'not-admitted') {
      const manual = toRestartManual(
        pending,
        before.kind === 'running' || before.kind === 'ambiguous'
          ? before.supervisorIdentityHash
          : null,
        this.now(),
      );
      await this.persist(manual, pending.recordVersion);
      return { kind: 'unavailable', reason: 'initial-shell-reconciliation-required' };
    }

    const spawning = toRestartSpawning(pending, this.now());
    await this.persist(spawning, pending.recordVersion);
    let spawned: TaskShellTupleSpawnResult;
    try {
      spawned = await this.dependencies.authority.spawnExactTuple(runtimeTupleIdentity(spawning));
    } catch {
      this.quarantinedTaskIds.add(spawning.taskId);
      const after = await this.dependencies.authority
        .inspectExactTuple(runtimeTupleIdentity(spawning))
        .catch(
          (): TaskShellTupleInspection => ({
            kind: 'ambiguous',
            supervisorIdentityHash: null,
          }),
        );
      const manual = toRestartManual(
        spawning,
        after.kind === 'running' || after.kind === 'ambiguous'
          ? after.supervisorIdentityHash
          : null,
        this.now(),
      );
      await this.persist(manual, spawning.recordVersion);
      return { kind: 'unavailable', reason: 'initial-shell-reconciliation-required' };
    }
    if (spawned.kind === 'deferred-before-process') {
      const deferred: RestartRecordForPhase<'clean-restart-pending'> = {
        ...pending,
        recordVersion: spawning.recordVersion + 1,
        updatedAtMs: this.now(),
      };
      await this.persist(deferred, spawning.recordVersion);
      return { kind: 'unavailable', reason: 'task-unavailable' };
    }
    if (spawned.kind === 'failed-before-process') {
      const failed = toRestartFailed(spawning, this.now());
      await this.persist(failed, spawning.recordVersion);
      return { kind: 'unavailable', reason: 'restore-failed' };
    }
    if (spawned.kind === 'ambiguous') {
      this.quarantinedTaskIds.add(spawning.taskId);
      const manual = toRestartManual(spawning, spawned.supervisorIdentityHash, this.now());
      await this.persist(manual, spawning.recordVersion);
      return { kind: 'unavailable', reason: 'initial-shell-reconciliation-required' };
    }

    this.quarantinedTaskIds.add(spawning.taskId);
    const awaiting = toRestartAwaiting(spawning, spawned.supervisorIdentityHash, this.now());
    await this.persist(awaiting, spawning.recordVersion);
    const acknowledged = await this.dependencies.authority.inspectExactTuple(
      runtimeTupleIdentity(awaiting),
    );
    if (
      acknowledged.kind === 'running' &&
      acknowledged.supervisorIdentityHash === awaiting.supervisorIdentityHash
    ) {
      const running = toRestartRunning(awaiting, acknowledged.supervisorIdentityHash, this.now());
      await this.persist(running, awaiting.recordVersion);
      return {
        generation: running.generationHighWater,
        kind: 'restored',
        sessionId: running.sessionId,
        taskId: running.taskId,
      };
    }
    const manual = toRestartManual(
      awaiting,
      acknowledged.kind === 'running' || acknowledged.kind === 'ambiguous'
        ? acknowledged.supervisorIdentityHash
        : awaiting.supervisorIdentityHash,
      this.now(),
    );
    await this.persist(manual, awaiting.recordVersion);
    return { kind: 'unavailable', reason: 'initial-shell-reconciliation-required' };
  }

  private async replay(
    record: TaskShellSessionJournalRecord,
  ): Promise<TaskShellSessionOperationReplay> {
    const current = await this.dependencies.readCurrent(identity(record));
    if (!isTaskShellSessionCurrentProjection(current)) {
      throw new TaskShellSessionConflictError('Fresh initial shell projection is invalid');
    }
    const common = {
      current,
      identity: identity(record),
      recordVersion: record.recordVersion,
    };
    switch (record.kind) {
      case 'full':
        switch (record.phase) {
          case 'reserved-for-task-commit':
            return {
              ...common,
              disposition: { kind: 'in-progress', reason: 'task-commit-pending' },
              phase: record.phase,
              replayKind: 'full',
            };
          case 'admitted':
          case 'spawning':
            return {
              ...common,
              disposition: { kind: 'in-progress', reason: 'spawn-admission-in-progress' },
              phase: record.phase,
              replayKind: 'full',
            };
          case 'awaiting-spawn-ack':
            return {
              ...common,
              disposition: { kind: 'in-progress', reason: 'spawn-ack-pending' },
              phase: record.phase,
              replayKind: 'full',
            };
          case 'running':
            return {
              ...common,
              disposition: { kind: 'attempted-no-replay', reason: 'running-at-ack' },
              phase: record.phase,
              replayKind: 'full',
            };
          case 'failed':
            return {
              ...common,
              disposition:
                record.failureDisposition === 'same-tuple-retry'
                  ? {
                      kind: 'same-tuple-retry',
                      reason: 'proven-safe-before-spawn',
                      retryUntil: record.retryUntilMs,
                    }
                  : { kind: 'attempted-no-replay', reason: 'failed-after-admission' },
              phase: record.phase,
              replayKind: 'full',
            };
          case 'cancelled':
            return {
              ...common,
              disposition: { kind: 'attempted-no-replay', reason: 'cancelled' },
              phase: record.phase,
              replayKind: 'full',
            };
          case 'manual-reconciliation-required':
            return {
              ...common,
              disposition: {
                kind: 'local-review',
                reason: 'spawn-outcome-ambiguous',
                taskSpawnQuarantined: true,
              },
              phase: record.phase,
              replayKind: 'full',
            };
          default:
            return assertNever(record);
        }
      case 'initial-launch-marker':
        return {
          ...common,
          disposition: {
            kind: 'attempted-no-replay',
            reason:
              record.outcomeClass === 'running-at-ack'
                ? 'running-at-ack'
                : record.outcomeClass === 'cancelled'
                  ? 'cancelled'
                  : 'retry-window-expired',
          },
          outcome: 'attempted-no-replay',
          outcomeClass: record.outcomeClass,
          replayKind: 'initial-launch-marker',
        } as TaskShellSessionOperationReplay;
      case 'restart-lifecycle': {
        const phase =
          record.phase === 'clean-restart-pending'
            ? 'admitted'
            : record.phase === 'restart-spawning'
              ? 'spawning'
              : record.phase === 'restart-awaiting-spawn-ack'
                ? 'awaiting-spawn-ack'
                : record.phase;
        const disposition =
          phase === 'admitted' || phase === 'spawning'
            ? ({ kind: 'in-progress', reason: 'spawn-admission-in-progress' } as const)
            : phase === 'awaiting-spawn-ack'
              ? ({ kind: 'in-progress', reason: 'spawn-ack-pending' } as const)
              : phase === 'running'
                ? ({ kind: 'attempted-no-replay', reason: 'running-at-ack' } as const)
                : phase === 'failed'
                  ? ({ kind: 'attempted-no-replay', reason: 'failed-after-admission' } as const)
                  : ({
                      kind: 'local-review',
                      reason: 'spawn-outcome-ambiguous',
                      taskSpawnQuarantined: true,
                    } as const);
        return {
          ...common,
          disposition,
          phase,
          replayKind: 'full',
        } as TaskShellSessionOperationReplay;
      }
      case 'deletion-pending':
        return record.outcome === 'task-removal-not-committed'
          ? {
              ...common,
              disposition: { kind: 'in-progress', reason: 'task-removal-commit-pending' },
              outcome: 'task-removal-not-committed',
              replayKind: 'deletion-pending',
            }
          : {
              ...common,
              disposition: {
                kind: 'in-progress',
                reason: 'task-removal-finalization-pending',
              },
              outcome: 'task-removed-finalization-pending',
              replayKind: 'deletion-pending',
            };
      case 'deletion-tombstone':
        return record.outcome === 'cancelled-before-task-commit'
          ? {
              ...common,
              disposition: { kind: 'attempted-no-replay', reason: 'cancelled' },
              outcome: 'cancelled-before-task-commit',
              replayKind: 'deletion-tombstone',
            }
          : {
              ...common,
              disposition: { kind: 'attempted-no-replay', reason: 'task-removed' },
              outcome: 'task-removed-no-replay',
              replayKind: 'deletion-tombstone',
            };
      case 'deletion-reconciliation-required':
        return {
          ...common,
          disposition: {
            kind: 'local-review',
            reason: 'task-removal-state-inconsistent',
            taskSpawnQuarantined: true,
          },
          outcome: 'removal-state-inconsistent',
          replayKind: 'deletion-reconciliation-required',
        };
    }
  }

  private async persist(
    proposed: TaskShellSessionJournalRecord,
    expectedVersion: number | null,
  ): Promise<void> {
    const result = await this.dependencies.journal.save(proposed, expectedVersion);
    switch (result.kind) {
      case 'committed':
      case 'already-current':
        this.updateQuarantine(proposed);
        return;
      case 'not-committed':
        throw new TaskShellSessionJournalUnavailableError('Initial shell write was not committed');
      case 'durability-repair-required':
      case 'recovery-required':
        throw new TaskShellSessionJournalUnavailableError(
          'Initial shell journal requires durability recovery',
        );
    }
  }

  private updateQuarantine(record: TaskShellSessionJournalRecord): void {
    if (
      (record.kind === 'full' && record.phase === 'manual-reconciliation-required') ||
      (record.kind === 'restart-lifecycle' && record.phase === 'manual-reconciliation-required') ||
      record.kind === 'deletion-reconciliation-required'
    ) {
      this.quarantinedTaskIds.add(record.taskId);
    } else {
      this.quarantinedTaskIds.delete(record.taskId);
    }
  }

  private cancelBeforeTaskCommitInsideQueue(record: TaskShellSessionFullRecord): Promise<void> {
    const nowMs = this.now();
    const proposed: TaskShellSessionDeletionTombstoneRecord = {
      ...baseReplacement(record, nowMs),
      committedWorkspaceRevision: null,
      completedAtMs: nowMs,
      expiresAtMs: nowMs + TASK_SHELL_SESSION_RETENTION_MS,
      kind: 'deletion-tombstone',
      outcome: 'cancelled-before-task-commit',
    };
    return this.persist(proposed, record.recordVersion);
  }

  private assertSpawnAdmissionsOpen(): void {
    if (this.cleanRestartDrainActive) {
      throw new TaskShellSessionJournalUnavailableError(
        'Initial shell admissions are closed for clean restart',
      );
    }
  }

  private isValidCleanRestartCandidate(
    candidate: Readonly<TaskShellSessionCleanRestartCandidate>,
  ): boolean {
    return (
      isIdentity(candidate.candidateId) &&
      isPositiveInteger(candidate.expectedRecordVersion) &&
      isIdentity(candidate.launchOperationId) &&
      isIdentity(candidate.sessionId) &&
      isIdentity(candidate.taskId) &&
      isNonNegativeInteger(candidate.sourceGeneration) &&
      isNonNegativeInteger(candidate.targetGeneration) &&
      candidate.targetGeneration === candidate.sourceGeneration + 1
    );
  }

  private sameCleanRestartCandidate(
    left: Readonly<TaskShellSessionCleanRestartCandidate>,
    right: Readonly<TaskShellSessionCleanRestartCandidate>,
  ): boolean {
    return (
      left.candidateId === right.candidateId &&
      left.expectedRecordVersion === right.expectedRecordVersion &&
      left.launchOperationId === right.launchOperationId &&
      left.sessionId === right.sessionId &&
      left.sourceGeneration === right.sourceGeneration &&
      left.targetGeneration === right.targetGeneration &&
      left.taskId === right.taskId
    );
  }

  private async waitForOperations(): Promise<void> {
    while (this.operationQueues.size > 0) {
      await Promise.allSettled([...this.operationQueues.values()]);
    }
  }

  private serialized<TResult>(
    operationId: string,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const prior = this.operationQueues.get(operationId) ?? Promise.resolve();
    const run = prior.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.operationQueues.set(operationId, tail);
    void tail.finally(() => {
      if (this.operationQueues.get(operationId) === tail) this.operationQueues.delete(operationId);
    });
    return run;
  }

  private now(): number {
    const value = this.dependencies.now?.() ?? Date.now();
    if (!isNonNegativeInteger(value)) throw new Error('Task-shell-session clock is invalid');
    return value;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported task-shell-session state: ${String(value)}`);
}

export function createTaskShellSessionWorkflow(
  dependencies: TaskShellSessionWorkflowDependencies,
): TaskShellSessionWorkflow {
  return new TaskShellSessionWorkflowImpl(dependencies);
}

export function hashTaskShellSessionOperationCapability(
  capability: TaskCreationOperationCapability,
): string {
  return hashCapability(capability).toString('hex');
}
