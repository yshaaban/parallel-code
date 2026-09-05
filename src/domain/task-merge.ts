import { getLocalDateKey } from '../lib/date.js';
import { isWellFormedUnicodeScalarString } from '../lib/unicode-scalar.js';

export const MERGE_PROGRESS_SCHEMA_VERSION = 1 as const;
export const TASK_MERGE_MESSAGE_MAX_UTF8_BYTES = 64 * 1_024;

export interface IssueTaskMergeOperationRequest {
  taskId: string;
}

export interface TaskMergeOperationAccess {
  operationCapability: string;
  operationId: string;
}

export interface IssuedTaskMergeOperation extends TaskMergeOperationAccess {
  firstAdmissionExpiresAt: number;
  issuedAt: number;
}

export interface StartTaskMergeOperationRequest {
  access: TaskMergeOperationAccess;
  controllerId: string;
  semanticRequest: TaskMergeSemanticRequest;
}

export interface GetTaskMergeOperationStatusRequest {
  access: TaskMergeOperationAccess;
  controllerId: string;
}

export interface TaskMergeSemanticRequest {
  cleanup: boolean;
  message?: string;
  squash: boolean;
  taskId: string;
}

export type TaskMergePhase =
  | 'issued'
  | 'expired-unused'
  | 'superseded-unused'
  | 'admitted'
  | 'merging'
  | 'merged-awaiting-removal'
  | 'manual-reconciliation-required'
  | 'completed'
  | 'completed-not-counted'
  | 'failed';

export function isTerminalTaskMergePhase(phase: TaskMergePhase): boolean {
  return (
    phase === 'expired-unused' ||
    phase === 'superseded-unused' ||
    phase === 'completed' ||
    phase === 'completed-not-counted' ||
    phase === 'failed'
  );
}

export type TaskMergeGitReconciliationAction =
  | 'recheck-evidence'
  | 'resume-identical-if-proven-no-side-effect'
  | 'adopt-if-proven-merged';

export type TaskMergeIssue =
  | {
      code:
        | 'validation'
        | 'lease-lost-before-git'
        | 'git-failed'
        | 'removal-operation-conflict'
        | 'task-not-current';
      recovery: { kind: 'new-operation-after-correction' };
    }
  | {
      code: 'removal-capacity';
      recovery: { kind: 'retry-same-operation-after-capacity' };
    }
  | {
      code: 'atomic-no-replace-unavailable' | 'recovery-quarantine-unavailable';
      recovery: { kind: 'retry-same-operation-after-capability' };
    }
  | {
      code: 'git-outcome-ambiguous';
      recovery: {
        allowedActions: TaskMergeGitReconciliationAction[];
        kind: 'local-operator-reconciliation';
      };
    };

export interface MergeProgressSnapshot {
  dateKey: string;
  linesAdded: number;
  linesRemoved: number;
  schemaVersion: typeof MERGE_PROGRESS_SCHEMA_VERSION;
  tasksToday: number;
  updatedAt: string;
  version: number;
}

export interface CommittedMergeOperationMarker {
  committedAt: string;
  operationId: string;
  progressVersion: number;
  taskId: string;
}

export type MergeProgressPersistenceProjection =
  | {
      committedMergeOperationId?: never;
      mergeOperation?: never;
      mergeProgress: MergeProgressSnapshot;
    }
  | {
      committedMergeOperationId: string;
      mergeOperation: CommittedMergeOperationMarker;
      mergeProgress: MergeProgressSnapshot;
    };

export interface MergeProgressPersistenceInput {
  committedMergeOperationId?: unknown;
  mergeOperation?: unknown;
  mergeProgress?: unknown;
}

export interface TaskMergeOperationSnapshot {
  cleanupRequested: boolean;
  counted: boolean;
  gitMerged: boolean;
  issue?: TaskMergeIssue;
  linesAdded?: number;
  linesRemoved?: number;
  operationId: string;
  phase: TaskMergePhase;
  progressVersionAtOutcome?: number;
  taskId: string;
  taskReleased: boolean;
  version: number;
}

/** Generic envelope over D13's canonical public removal projection. */
export interface TaskMergeResultEnvelope<TRemoval> {
  currentProgress: MergeProgressSnapshot;
  currentRemoval: TRemoval | null;
  originalOutcome: TaskMergeOperationSnapshot;
  replayed: boolean;
}

export interface LegacyMergeProgressFields {
  completedTaskCount?: unknown;
  completedTaskDate?: unknown;
  mergedLinesAdded?: unknown;
  mergedLinesRemoved?: unknown;
}

export interface CompletedMergeProgressInput {
  committedAt: Date;
  linesAdded: unknown;
  linesRemoved: unknown;
}

export type MergeProgressSnapshotDisposition = 'newer' | 'duplicate' | 'stale' | 'conflict';

export class MergeProgressValidationError extends Error {
  readonly code = 'merge-progress-invalid';
}

export class MergeProgressOverflowError extends Error {
  readonly code = 'merge-progress-overflow';
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TASK_MERGE_PHASES = new Set<TaskMergePhase>([
  'issued',
  'expired-unused',
  'superseded-unused',
  'admitted',
  'merging',
  'merged-awaiting-removal',
  'manual-reconciliation-required',
  'completed',
  'completed-not-counted',
  'failed',
]);
const GIT_RECONCILIATION_ACTIONS = new Set<TaskMergeGitReconciliationAction>([
  'recheck-evidence',
  'resume-identical-if-proven-no-side-effect',
  'adopt-if-proven-merged',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isBoundedIdentifier(value: unknown, maxBytes = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    isWellFormedUnicodeScalarString(value) &&
    new TextEncoder().encode(value).byteLength <= maxBytes &&
    !value.includes('\u0000')
  );
}

export function isTaskMergeOperationAccess(value: unknown): value is TaskMergeOperationAccess {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['operationCapability', 'operationId']) &&
    isBoundedIdentifier(value.operationId, 128) &&
    isBoundedIdentifier(value.operationCapability, 64)
  );
}

export function isIssuedTaskMergeOperation(value: unknown): value is IssuedTaskMergeOperation {
  const record = isRecord(value) ? value : null;
  return (
    record !== null &&
    hasExactKeys(record, [
      'firstAdmissionExpiresAt',
      'issuedAt',
      'operationCapability',
      'operationId',
    ]) &&
    isBoundedIdentifier(record.operationId, 128) &&
    isBoundedIdentifier(record.operationCapability, 64) &&
    isNonNegativeSafeInteger(record.issuedAt) &&
    isNonNegativeSafeInteger(record.firstAdmissionExpiresAt) &&
    record.firstAdmissionExpiresAt >= record.issuedAt
  );
}

export function isTaskMergeSemanticRequest(value: unknown): value is TaskMergeSemanticRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'cleanup',
      ...(value.message === undefined ? [] : ['message']),
      'squash',
      'taskId',
    ]) &&
    isBoundedIdentifier(value.taskId) &&
    typeof value.cleanup === 'boolean' &&
    typeof value.squash === 'boolean' &&
    (value.message === undefined ||
      (typeof value.message === 'string' &&
        isWellFormedUnicodeScalarString(value.message) &&
        !value.message.includes('\u0000') &&
        new TextEncoder().encode(value.message).byteLength <= TASK_MERGE_MESSAGE_MAX_UTF8_BYTES))
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function isMergeProgressDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_KEY_PATTERN.test(value)) return false;
  const candidate = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(candidate.getTime()) && candidate.toISOString().slice(0, 10) === value;
}

export function normalizeMergeProgressInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

export function isMergeProgressSnapshot(value: unknown): value is MergeProgressSnapshot {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      'dateKey',
      'linesAdded',
      'linesRemoved',
      'schemaVersion',
      'tasksToday',
      'updatedAt',
      'version',
    ]) &&
    value.schemaVersion === MERGE_PROGRESS_SCHEMA_VERSION &&
    isNonNegativeSafeInteger(value.version) &&
    isMergeProgressDateKey(value.dateKey) &&
    isNonNegativeSafeInteger(value.tasksToday) &&
    isNonNegativeSafeInteger(value.linesAdded) &&
    isNonNegativeSafeInteger(value.linesRemoved) &&
    isCanonicalIsoTimestamp(value.updatedAt)
  );
}

export function isCommittedMergeOperationMarker(
  value: unknown,
): value is CommittedMergeOperationMarker {
  if (!isRecord(value)) return false;
  return (
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    typeof value.taskId === 'string' &&
    value.taskId.length > 0 &&
    isNonNegativeSafeInteger(value.progressVersion) &&
    isCanonicalIsoTimestamp(value.committedAt)
  );
}

/** Decode the complete canonical merge projection without accepting half-written markers. */
export function decodeMergeProgressPersistenceProjection(
  input: MergeProgressPersistenceInput,
): MergeProgressPersistenceProjection | null {
  if (!isMergeProgressSnapshot(input.mergeProgress)) return null;
  const hasCommittedId = input.committedMergeOperationId !== undefined;
  const hasMarker = input.mergeOperation !== undefined;
  if (!hasCommittedId && !hasMarker) {
    return { mergeProgress: input.mergeProgress };
  }
  if (
    !hasCommittedId ||
    !hasMarker ||
    !isCommittedMergeOperationMarker(input.mergeOperation) ||
    input.committedMergeOperationId !== input.mergeOperation.operationId ||
    input.mergeOperation.progressVersion !== input.mergeProgress.version
  ) {
    return null;
  }
  return {
    committedMergeOperationId: input.committedMergeOperationId,
    mergeOperation: input.mergeOperation,
    mergeProgress: input.mergeProgress,
  };
}

export function assertMergeProgressSnapshot(
  value: unknown,
): asserts value is MergeProgressSnapshot {
  if (!isMergeProgressSnapshot(value)) {
    throw new MergeProgressValidationError('Merge progress snapshot is invalid');
  }
}

export function areMergeProgressSnapshotsEqual(
  left: Readonly<MergeProgressSnapshot>,
  right: Readonly<MergeProgressSnapshot>,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.version === right.version &&
    left.dateKey === right.dateKey &&
    left.tasksToday === right.tasksToday &&
    left.linesAdded === right.linesAdded &&
    left.linesRemoved === right.linesRemoved &&
    left.updatedAt === right.updatedAt
  );
}

export function getMergeProgressSnapshotDisposition(
  current: Readonly<MergeProgressSnapshot> | null,
  next: MergeProgressSnapshot,
): MergeProgressSnapshotDisposition {
  assertMergeProgressSnapshot(next);
  if (!current || next.version > current.version) return 'newer';
  if (next.version < current.version) return 'stale';
  return areMergeProgressSnapshotsEqual(current, next) ? 'duplicate' : 'conflict';
}

function requireValidDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new MergeProgressValidationError('Merge progress commit time is invalid');
  }
}

function checkedIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new MergeProgressOverflowError(`${label} cannot be incremented safely`);
  }
  return value + 1;
}

function checkedAdd(value: number, delta: number, label: string): number {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(delta) || value < 0 || delta < 0) {
    throw new MergeProgressValidationError(`${label} is invalid`);
  }
  if (value > Number.MAX_SAFE_INTEGER - delta) {
    throw new MergeProgressOverflowError(`${label} cannot be advanced safely`);
  }
  return value + delta;
}

export function seedMergeProgressSnapshot(
  legacy: LegacyMergeProgressFields,
  seededAt: Date,
): MergeProgressSnapshot {
  requireValidDate(seededAt);
  const today = getLocalDateKey(seededAt);
  const legacyDate = legacy.completedTaskDate;
  const hasValidLegacyDate = isMergeProgressDateKey(legacyDate);
  const dateKey = hasValidLegacyDate ? legacyDate : today;
  const hasLegacyField = [
    'completedTaskCount',
    'completedTaskDate',
    'mergedLinesAdded',
    'mergedLinesRemoved',
  ].some((field) => Object.prototype.hasOwnProperty.call(legacy, field));

  return {
    schemaVersion: MERGE_PROGRESS_SCHEMA_VERSION,
    version: hasLegacyField ? 1 : 0,
    dateKey,
    tasksToday:
      hasValidLegacyDate && dateKey === today
        ? normalizeMergeProgressInteger(legacy.completedTaskCount)
        : 0,
    linesAdded: normalizeMergeProgressInteger(legacy.mergedLinesAdded),
    linesRemoved: normalizeMergeProgressInteger(legacy.mergedLinesRemoved),
    updatedAt: seededAt.toISOString(),
  };
}

export function advanceCompletedMergeProgress(
  current: MergeProgressSnapshot,
  input: CompletedMergeProgressInput,
): MergeProgressSnapshot {
  assertMergeProgressSnapshot(current);
  requireValidDate(input.committedAt);
  const commitDateKey = getLocalDateKey(input.committedAt);
  const currentTasksToday = current.dateKey === commitDateKey ? current.tasksToday : 0;
  const linesAdded = normalizeMergeProgressInteger(input.linesAdded);
  const linesRemoved = normalizeMergeProgressInteger(input.linesRemoved);

  return {
    schemaVersion: MERGE_PROGRESS_SCHEMA_VERSION,
    version: checkedIncrement(current.version, 'Merge progress version'),
    dateKey: commitDateKey,
    tasksToday: checkedIncrement(currentTasksToday, 'Merged task count'),
    linesAdded: checkedAdd(current.linesAdded, linesAdded, 'Merged added-line total'),
    linesRemoved: checkedAdd(current.linesRemoved, linesRemoved, 'Merged removed-line total'),
    updatedAt: input.committedAt.toISOString(),
  };
}

function isTaskMergeGitReconciliationAction(
  value: unknown,
): value is TaskMergeGitReconciliationAction {
  return (
    typeof value === 'string' &&
    GIT_RECONCILIATION_ACTIONS.has(value as TaskMergeGitReconciliationAction)
  );
}

export function isTaskMergeIssue(value: unknown): value is TaskMergeIssue {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['code', 'recovery']) ||
    typeof value.code !== 'string' ||
    !isRecord(value.recovery)
  ) {
    return false;
  }
  switch (value.code) {
    case 'validation':
    case 'lease-lost-before-git':
    case 'git-failed':
    case 'removal-operation-conflict':
    case 'task-not-current':
      return (
        hasExactKeys(value.recovery, ['kind']) &&
        value.recovery.kind === 'new-operation-after-correction'
      );
    case 'removal-capacity':
      return (
        hasExactKeys(value.recovery, ['kind']) &&
        value.recovery.kind === 'retry-same-operation-after-capacity'
      );
    case 'atomic-no-replace-unavailable':
    case 'recovery-quarantine-unavailable':
      return (
        hasExactKeys(value.recovery, ['kind']) &&
        value.recovery.kind === 'retry-same-operation-after-capability'
      );
    case 'git-outcome-ambiguous':
      return (
        hasExactKeys(value.recovery, ['allowedActions', 'kind']) &&
        value.recovery.kind === 'local-operator-reconciliation' &&
        Array.isArray(value.recovery.allowedActions) &&
        value.recovery.allowedActions.length > 0 &&
        new Set(value.recovery.allowedActions).size === value.recovery.allowedActions.length &&
        value.recovery.allowedActions.every(isTaskMergeGitReconciliationAction)
      );
    default:
      return false;
  }
}

function isOptionalNonNegativeSafeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeSafeInteger(value);
}

export function isTaskMergeOperationSnapshot(value: unknown): value is TaskMergeOperationSnapshot {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      'cleanupRequested',
      'counted',
      'gitMerged',
      ...(value.issue === undefined ? [] : ['issue']),
      ...(value.linesAdded === undefined ? [] : ['linesAdded']),
      ...(value.linesRemoved === undefined ? [] : ['linesRemoved']),
      'operationId',
      'phase',
      ...(value.progressVersionAtOutcome === undefined ? [] : ['progressVersionAtOutcome']),
      'taskId',
      'taskReleased',
      'version',
    ]) ||
    !isBoundedIdentifier(value.operationId, 128) ||
    !isBoundedIdentifier(value.taskId) ||
    !isNonNegativeSafeInteger(value.version) ||
    typeof value.phase !== 'string' ||
    !TASK_MERGE_PHASES.has(value.phase as TaskMergePhase) ||
    typeof value.gitMerged !== 'boolean' ||
    typeof value.cleanupRequested !== 'boolean' ||
    typeof value.taskReleased !== 'boolean' ||
    typeof value.counted !== 'boolean' ||
    !isOptionalNonNegativeSafeInteger(value.linesAdded) ||
    !isOptionalNonNegativeSafeInteger(value.linesRemoved) ||
    !isOptionalNonNegativeSafeInteger(value.progressVersionAtOutcome) ||
    (value.issue !== undefined && !isTaskMergeIssue(value.issue))
  ) {
    return false;
  }
  if (value.counted && (!value.taskReleased || !value.gitMerged || !value.cleanupRequested)) {
    return false;
  }
  if (value.phase === 'completed' && (!value.counted || !value.taskReleased)) return false;
  if (value.phase === 'completed-not-counted' && value.counted) return false;
  return true;
}

export function isTaskMergeResultEnvelope<TRemoval>(
  value: unknown,
  isRemoval: (candidate: unknown) => candidate is TRemoval,
): value is TaskMergeResultEnvelope<TRemoval> {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, ['currentProgress', 'currentRemoval', 'originalOutcome', 'replayed']) &&
    isTaskMergeOperationSnapshot(value.originalOutcome) &&
    isMergeProgressSnapshot(value.currentProgress) &&
    (value.currentRemoval === null || isRemoval(value.currentRemoval)) &&
    typeof value.replayed === 'boolean'
  );
}
