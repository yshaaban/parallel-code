export const TASK_NOTES_MAX_BYTES = 100 * 1024;
export const TASK_NOTES_MAX_ACKNOWLEDGEMENTS = 16;
export const TASK_NOTES_MAX_TASK_ID_BYTES = 128;
export const TASK_NOTES_MAX_SOURCE_ID_BYTES = 64;
export const TASK_NOTES_MAX_BODY_BYTES = 1024 * 1024;
export const TASK_NOTES_CHANGED_MAX_BYTES = 896;
export const TASK_NOTES_RETRY_AFTER_MIN_MS = 250;
export const TASK_NOTES_RETRY_AFTER_MAX_MS = 60_000;

export interface TaskNotesCapability {
  read: boolean;
  write: boolean;
}

export function isTaskNotesCapability(value: unknown): value is TaskNotesCapability {
  const capability = value as Record<string, unknown>;
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    typeof capability.read === 'boolean' &&
    typeof capability.write === 'boolean' &&
    (!capability.write || capability.read)
  );
}

export interface TaskNotesSnapshot {
  taskId: string;
  taskIncarnation: string;
  notes: string;
  contentVersion: string;
  workspaceRevision: number;
}

export interface GetTaskNotesRequest {
  taskId: string;
}

export interface UpdateTaskNotesRequest {
  taskId: string;
  taskIncarnation: string;
  notes: string;
  baseContentVersion: string;
  operationId: string;
  operationCapability: string;
}

export interface AcknowledgedTaskNotesOperation {
  operationId: string;
  operationCapability: string;
}

export interface IssueTaskNotesOperationRequest {
  taskId: string;
  taskIncarnation: string;
  acknowledgedOperations?: AcknowledgedTaskNotesOperation[];
}

export interface IssuedTaskNotesOperation {
  operationId: string;
  operationCapability: string;
  admitUntil: string;
  replayUntil: string;
}

export type RetryAfterMs = number;

export type IssueTaskNotesOperationResult =
  | { kind: 'issued'; operation: IssuedTaskNotesOperation }
  | { kind: 'not-found' }
  | { kind: 'not-visible' }
  | { kind: 'task-incarnation-changed' }
  | { kind: 'task-state-unavailable'; retryAfterMs: RetryAfterMs }
  | {
      kind: 'durability-repair-required';
      reservation: 'withheld';
      acknowledgementReclamation: 'unknown';
    }
  | {
      kind: 'host-state-recovery-required';
      reservation: 'withheld';
      acknowledgementReclamation: 'unknown';
    };

export type TaskNotesOperationOutcome =
  | {
      kind: 'saved';
      changed: boolean;
      committedContentVersion: string;
      committedWorkspaceRevision: number;
    }
  | {
      kind: 'conflict';
      observedContentVersion: string;
      observedWorkspaceRevision: number;
    }
  | {
      kind: 'task-incarnation-changed';
      observedWorkspaceRevision: number;
    };

export type CurrentTaskNotes =
  | { kind: 'present'; snapshot: TaskNotesSnapshot }
  | { kind: 'unavailable'; reason: 'task-removed'; workspaceRevision: number }
  | { kind: 'unavailable'; reason: 'task-replaced'; workspaceRevision: number }
  | { kind: 'unavailable'; reason: 'task-not-visible'; workspaceRevision: number };

interface CurrentTaskLifecycleProjectionBase {
  serverInstanceId: string;
  catalogVersion: number;
}

export type CurrentTaskLifecycleProjection =
  | (CurrentTaskLifecycleProjectionBase & {
      taskState: 'present';
      taskClosing: boolean;
      taskIncarnation: string;
    })
  | (CurrentTaskLifecycleProjectionBase & {
      taskState: 'removed';
      taskClosing: false;
      taskIncarnation?: never;
    })
  | (CurrentTaskLifecycleProjectionBase & {
      taskState: 'not-visible';
      taskClosing: false;
      taskIncarnation?: never;
    });

export type TaskNotesCurrentEnvelope =
  | {
      relation: 'same-incarnation';
      currentNotes: Extract<CurrentTaskNotes, { kind: 'present' }>;
      currentTask: Extract<CurrentTaskLifecycleProjection, { taskState: 'present' }>;
    }
  | {
      relation: 'task-replaced';
      currentNotes: Extract<CurrentTaskNotes, { reason: 'task-replaced' }>;
      currentTask: Extract<CurrentTaskLifecycleProjection, { taskState: 'present' }>;
    }
  | {
      relation: 'task-removed';
      currentNotes: Extract<CurrentTaskNotes, { reason: 'task-removed' }>;
      currentTask: Extract<CurrentTaskLifecycleProjection, { taskState: 'removed' }>;
    }
  | {
      relation: 'task-not-visible';
      currentNotes: Extract<CurrentTaskNotes, { reason: 'task-not-visible' }>;
      currentTask: Extract<CurrentTaskLifecycleProjection, { taskState: 'not-visible' }>;
    };

export type GetTaskNotesResult =
  | {
      kind: 'loaded';
      current: Extract<TaskNotesCurrentEnvelope, { relation: 'same-incarnation' }>;
    }
  | {
      kind: 'not-found';
      current: Extract<TaskNotesCurrentEnvelope, { relation: 'task-removed' }>;
    }
  | {
      kind: 'not-visible';
      current: Extract<TaskNotesCurrentEnvelope, { relation: 'task-not-visible' }>;
    }
  | { kind: 'task-state-unavailable'; retryAfterMs: RetryAfterMs };

export type TaskNotesPostCommitWarning = 'projection-repair-required';

export type TaskNotesKnownDisposition =
  | { kind: 'unsettled' }
  | {
      kind: 'completed';
      originalOutcome: TaskNotesOperationOutcome;
      replayed: boolean;
      effectiveRetireAfter: string;
      postCommitWarning?: TaskNotesPostCommitWarning;
    }
  | { kind: 'task-closing' };

export type UpdateTaskNotesResult =
  | {
      kind: 'completed';
      originalOutcome: TaskNotesOperationOutcome;
      current: TaskNotesCurrentEnvelope;
      replayed: boolean;
      effectiveRetireAfter: string;
      postCommitWarning?: TaskNotesPostCommitWarning;
    }
  | {
      kind: 'task-closing';
      current: TaskNotesCurrentEnvelope;
      replayed: false;
    }
  | { kind: 'operation-expired'; expiredAt: string }
  | {
      kind: 'recovery-busy';
      retryAfterMs: RetryAfterMs;
      effectiveRetireAfter: string;
    }
  | {
      kind: 'task-state-unavailable';
      retryAfterMs: RetryAfterMs;
      knownDisposition: TaskNotesKnownDisposition;
    }
  | ({
      kind: 'durability-repair-required';
      replayed: boolean;
      retention: 'held';
    } & (
      | { semanticProposal: 'admission-only'; proposedOutcome?: never }
      | { semanticProposal: 'retry-window-only'; proposedOutcome?: never }
      | { semanticProposal: 'terminal-outcome'; proposedOutcome: TaskNotesOperationOutcome }
    ))
  | {
      kind: 'host-state-recovery-required';
      replayed: boolean;
      retention: 'held';
    };

export type TaskNotesRequestError =
  | { code: 'bad-request' | 'unsupported-media-type' | 'payload-too-large' }
  | { code: 'unauthenticated' | 'forbidden' }
  | { code: 'operation-identity-rejected' }
  | { code: 'rate-limited' | 'capacity-exhausted'; retryAfterMs: RetryAfterMs }
  | { code: 'persistence-unavailable' | 'internal-error'; retryable: boolean };

export type TaskNotesWireResponse<Result> =
  | { ok: true; result: Result }
  | { ok: false; error: TaskNotesRequestError };

export interface TaskNotesChangedNotification {
  taskId: string;
  workspaceRevision: number;
  sourceId: string | null;
}

type UnknownRecord = Record<string, unknown>;
type Guard<T> = (value: unknown) => value is T;

const DANGEROUS_TASK_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const CANONICAL_16_BYTE_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const CANONICAL_32_BYTE_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const CANONICAL_DEADLINE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CANONICAL_SERVER_INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CANONICAL_SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

function isExactRecord(value: unknown, keys: readonly string[]): value is UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    return false;
  }

  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
  });
}

function keysWithOptional(
  required: readonly string[],
  optionalKey: string,
  hasOptional: boolean,
): string[] {
  return hasOptional ? [...required, optionalKey] : [...required];
}

export function getWellFormedUtf8ByteLength(value: string): number | null {
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return null;
      byteLength += 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return null;
    } else {
      byteLength += 3;
    }
  }
  return byteLength;
}

export function isTaskNotesText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const byteLength = getWellFormedUtf8ByteLength(value);
  return byteLength !== null && byteLength <= TASK_NOTES_MAX_BYTES;
}

export function getTaskNotesRemainingBytes(value: string): number | null {
  const byteLength = getWellFormedUtf8ByteLength(value);
  return byteLength === null ? null : Math.max(0, TASK_NOTES_MAX_BYTES - byteLength);
}

export function isTaskNotesTaskId(value: unknown): value is string {
  if (typeof value !== 'string' || DANGEROUS_TASK_IDS.has(value)) return false;
  const byteLength = getWellFormedUtf8ByteLength(value);
  return byteLength !== null && byteLength >= 1 && byteLength <= TASK_NOTES_MAX_TASK_ID_BYTES;
}

export function isTaskNotesSourceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= TASK_NOTES_MAX_SOURCE_ID_BYTES &&
    CANONICAL_SOURCE_ID_PATTERN.test(value)
  );
}

export function normalizeTaskNotesSourceId(value: unknown): string | null {
  return isTaskNotesSourceId(value) ? value : null;
}

export function isTaskNotesOperationId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_16_BYTE_BASE64URL_PATTERN.test(value);
}

export function isTaskNotesOpaque32ByteToken(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_32_BYTE_BASE64URL_PATTERN.test(value);
}

export const isTaskNotesOperationCapability = isTaskNotesOpaque32ByteToken;
export const isTaskNotesIncarnation = isTaskNotesOpaque32ByteToken;
export const isTaskNotesContentVersion = isTaskNotesOpaque32ByteToken;

export function isTaskNotesDeadline(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_DEADLINE_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function isTaskNotesRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isTaskNotesRetryAfterMs(value: unknown): value is RetryAfterMs {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TASK_NOTES_RETRY_AFTER_MIN_MS &&
    value <= TASK_NOTES_RETRY_AFTER_MAX_MS
  );
}

function isCanonicalServerInstanceId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_SERVER_INSTANCE_ID_PATTERN.test(value);
}

export function isTaskNotesSnapshot(value: unknown): value is TaskNotesSnapshot {
  return (
    isExactRecord(value, [
      'taskId',
      'taskIncarnation',
      'notes',
      'contentVersion',
      'workspaceRevision',
    ]) &&
    isTaskNotesTaskId(value.taskId) &&
    isTaskNotesIncarnation(value.taskIncarnation) &&
    isTaskNotesText(value.notes) &&
    isTaskNotesContentVersion(value.contentVersion) &&
    isTaskNotesRevision(value.workspaceRevision)
  );
}

export function isGetTaskNotesRequest(value: unknown): value is GetTaskNotesRequest {
  return isExactRecord(value, ['taskId']) && isTaskNotesTaskId(value.taskId);
}

export function isAcknowledgedTaskNotesOperation(
  value: unknown,
): value is AcknowledgedTaskNotesOperation {
  return (
    isExactRecord(value, ['operationId', 'operationCapability']) &&
    isTaskNotesOperationId(value.operationId) &&
    isTaskNotesOperationCapability(value.operationCapability)
  );
}

export function isIssueTaskNotesOperationRequest(
  value: unknown,
): value is IssueTaskNotesOperationRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const hasAcknowledgements = Object.prototype.hasOwnProperty.call(value, 'acknowledgedOperations');
  if (
    !isExactRecord(
      value,
      keysWithOptional(
        ['taskId', 'taskIncarnation'],
        'acknowledgedOperations',
        hasAcknowledgements,
      ),
    ) ||
    !isTaskNotesTaskId(value.taskId) ||
    !isTaskNotesIncarnation(value.taskIncarnation)
  ) {
    return false;
  }
  if (!hasAcknowledgements) return true;
  if (
    !Array.isArray(value.acknowledgedOperations) ||
    value.acknowledgedOperations.length > TASK_NOTES_MAX_ACKNOWLEDGEMENTS ||
    !value.acknowledgedOperations.every(isAcknowledgedTaskNotesOperation)
  ) {
    return false;
  }
  const operationIds = value.acknowledgedOperations.map((entry) => entry.operationId);
  return new Set(operationIds).size === operationIds.length;
}

export function isUpdateTaskNotesRequest(value: unknown): value is UpdateTaskNotesRequest {
  return (
    isExactRecord(value, [
      'taskId',
      'taskIncarnation',
      'notes',
      'baseContentVersion',
      'operationId',
      'operationCapability',
    ]) &&
    isTaskNotesTaskId(value.taskId) &&
    isTaskNotesIncarnation(value.taskIncarnation) &&
    isTaskNotesText(value.notes) &&
    isTaskNotesContentVersion(value.baseContentVersion) &&
    isTaskNotesOperationId(value.operationId) &&
    isTaskNotesOperationCapability(value.operationCapability)
  );
}

export function isIssuedTaskNotesOperation(value: unknown): value is IssuedTaskNotesOperation {
  return (
    isExactRecord(value, ['operationId', 'operationCapability', 'admitUntil', 'replayUntil']) &&
    isTaskNotesOperationId(value.operationId) &&
    isTaskNotesOperationCapability(value.operationCapability) &&
    isTaskNotesDeadline(value.admitUntil) &&
    isTaskNotesDeadline(value.replayUntil) &&
    value.admitUntil < value.replayUntil
  );
}

export function isTaskNotesOperationOutcome(value: unknown): value is TaskNotesOperationOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as UnknownRecord).kind;
  if (kind === 'saved') {
    return (
      isExactRecord(value, [
        'kind',
        'changed',
        'committedContentVersion',
        'committedWorkspaceRevision',
      ]) &&
      typeof value.changed === 'boolean' &&
      isTaskNotesContentVersion(value.committedContentVersion) &&
      isTaskNotesRevision(value.committedWorkspaceRevision)
    );
  }
  if (kind === 'conflict') {
    return (
      isExactRecord(value, ['kind', 'observedContentVersion', 'observedWorkspaceRevision']) &&
      isTaskNotesContentVersion(value.observedContentVersion) &&
      isTaskNotesRevision(value.observedWorkspaceRevision)
    );
  }
  return (
    kind === 'task-incarnation-changed' &&
    isExactRecord(value, ['kind', 'observedWorkspaceRevision']) &&
    isTaskNotesRevision(value.observedWorkspaceRevision)
  );
}

export function isCurrentTaskNotes(value: unknown): value is CurrentTaskNotes {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as UnknownRecord).kind;
  if (kind === 'present') {
    return isExactRecord(value, ['kind', 'snapshot']) && isTaskNotesSnapshot(value.snapshot);
  }
  return (
    kind === 'unavailable' &&
    isExactRecord(value, ['kind', 'reason', 'workspaceRevision']) &&
    (value.reason === 'task-removed' ||
      value.reason === 'task-replaced' ||
      value.reason === 'task-not-visible') &&
    isTaskNotesRevision(value.workspaceRevision)
  );
}

export function isCurrentTaskLifecycleProjection(
  value: unknown,
): value is CurrentTaskLifecycleProjection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = (value as UnknownRecord).taskState;
  if (state === 'present') {
    return (
      isExactRecord(value, [
        'serverInstanceId',
        'catalogVersion',
        'taskState',
        'taskClosing',
        'taskIncarnation',
      ]) &&
      isCanonicalServerInstanceId(value.serverInstanceId) &&
      isTaskNotesRevision(value.catalogVersion) &&
      typeof value.taskClosing === 'boolean' &&
      isTaskNotesIncarnation(value.taskIncarnation)
    );
  }
  return (
    (state === 'removed' || state === 'not-visible') &&
    isExactRecord(value, ['serverInstanceId', 'catalogVersion', 'taskState', 'taskClosing']) &&
    isCanonicalServerInstanceId(value.serverInstanceId) &&
    isTaskNotesRevision(value.catalogVersion) &&
    value.taskClosing === false
  );
}

export function isTaskNotesCurrentEnvelope(value: unknown): value is TaskNotesCurrentEnvelope {
  if (
    !isExactRecord(value, ['relation', 'currentNotes', 'currentTask']) ||
    !isCurrentTaskNotes(value.currentNotes) ||
    !isCurrentTaskLifecycleProjection(value.currentTask)
  ) {
    return false;
  }
  switch (value.relation) {
    case 'same-incarnation':
      return (
        value.currentNotes.kind === 'present' &&
        value.currentTask.taskState === 'present' &&
        value.currentNotes.snapshot.taskIncarnation === value.currentTask.taskIncarnation
      );
    case 'task-replaced':
      return (
        value.currentNotes.kind === 'unavailable' &&
        value.currentNotes.reason === 'task-replaced' &&
        value.currentTask.taskState === 'present'
      );
    case 'task-removed':
      return (
        value.currentNotes.kind === 'unavailable' &&
        value.currentNotes.reason === 'task-removed' &&
        value.currentTask.taskState === 'removed'
      );
    case 'task-not-visible':
      return (
        value.currentNotes.kind === 'unavailable' &&
        value.currentNotes.reason === 'task-not-visible' &&
        value.currentTask.taskState === 'not-visible'
      );
    default:
      return false;
  }
}

export function isGetTaskNotesResult(value: unknown): value is GetTaskNotesResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as UnknownRecord).kind;
  if (kind === 'task-state-unavailable') {
    return (
      isExactRecord(value, ['kind', 'retryAfterMs']) && isTaskNotesRetryAfterMs(value.retryAfterMs)
    );
  }
  if (!isExactRecord(value, ['kind', 'current']) || !isTaskNotesCurrentEnvelope(value.current)) {
    return false;
  }
  return (
    (kind === 'loaded' && value.current.relation === 'same-incarnation') ||
    (kind === 'not-found' && value.current.relation === 'task-removed') ||
    (kind === 'not-visible' && value.current.relation === 'task-not-visible')
  );
}

export function isIssueTaskNotesOperationResult(
  value: unknown,
): value is IssueTaskNotesOperationResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as UnknownRecord).kind;
  if (kind === 'issued') {
    return (
      isExactRecord(value, ['kind', 'operation']) && isIssuedTaskNotesOperation(value.operation)
    );
  }
  if (kind === 'not-found' || kind === 'not-visible' || kind === 'task-incarnation-changed') {
    return isExactRecord(value, ['kind']);
  }
  if (kind === 'task-state-unavailable') {
    return (
      isExactRecord(value, ['kind', 'retryAfterMs']) && isTaskNotesRetryAfterMs(value.retryAfterMs)
    );
  }
  if (kind === 'durability-repair-required' || kind === 'host-state-recovery-required') {
    return (
      isExactRecord(value, ['kind', 'reservation', 'acknowledgementReclamation']) &&
      value.reservation === 'withheld' &&
      value.acknowledgementReclamation === 'unknown'
    );
  }
  return false;
}

export function isTaskNotesKnownDisposition(value: unknown): value is TaskNotesKnownDisposition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as UnknownRecord).kind;
  if (kind === 'unsettled' || kind === 'task-closing') return isExactRecord(value, ['kind']);
  if (kind !== 'completed') return false;
  const hasWarning = Object.prototype.hasOwnProperty.call(value, 'postCommitWarning');
  return (
    isExactRecord(
      value,
      keysWithOptional(
        ['kind', 'originalOutcome', 'replayed', 'effectiveRetireAfter'],
        'postCommitWarning',
        hasWarning,
      ),
    ) &&
    isTaskNotesOperationOutcome(value.originalOutcome) &&
    typeof value.replayed === 'boolean' &&
    isTaskNotesDeadline(value.effectiveRetireAfter) &&
    (!hasWarning || value.postCommitWarning === 'projection-repair-required')
  );
}

export function isUpdateTaskNotesResult(value: unknown): value is UpdateTaskNotesResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as UnknownRecord).kind;
  if (kind === 'completed') {
    const hasWarning = Object.prototype.hasOwnProperty.call(value, 'postCommitWarning');
    return (
      isExactRecord(
        value,
        keysWithOptional(
          ['kind', 'originalOutcome', 'current', 'replayed', 'effectiveRetireAfter'],
          'postCommitWarning',
          hasWarning,
        ),
      ) &&
      isTaskNotesOperationOutcome(value.originalOutcome) &&
      isTaskNotesCurrentEnvelope(value.current) &&
      typeof value.replayed === 'boolean' &&
      isTaskNotesDeadline(value.effectiveRetireAfter) &&
      (!hasWarning || value.postCommitWarning === 'projection-repair-required')
    );
  }
  if (kind === 'task-closing') {
    return (
      isExactRecord(value, ['kind', 'current', 'replayed']) &&
      isTaskNotesCurrentEnvelope(value.current) &&
      value.replayed === false
    );
  }
  if (kind === 'operation-expired') {
    return isExactRecord(value, ['kind', 'expiredAt']) && isTaskNotesDeadline(value.expiredAt);
  }
  if (kind === 'recovery-busy') {
    return (
      isExactRecord(value, ['kind', 'retryAfterMs', 'effectiveRetireAfter']) &&
      isTaskNotesRetryAfterMs(value.retryAfterMs) &&
      isTaskNotesDeadline(value.effectiveRetireAfter)
    );
  }
  if (kind === 'task-state-unavailable') {
    return (
      isExactRecord(value, ['kind', 'retryAfterMs', 'knownDisposition']) &&
      isTaskNotesRetryAfterMs(value.retryAfterMs) &&
      isTaskNotesKnownDisposition(value.knownDisposition)
    );
  }
  if (kind === 'durability-repair-required') {
    const proposal = (value as UnknownRecord).semanticProposal;
    if (proposal === 'terminal-outcome') {
      return (
        isExactRecord(value, [
          'kind',
          'replayed',
          'retention',
          'semanticProposal',
          'proposedOutcome',
        ]) &&
        typeof value.replayed === 'boolean' &&
        value.retention === 'held' &&
        isTaskNotesOperationOutcome(value.proposedOutcome)
      );
    }
    return (
      (proposal === 'admission-only' || proposal === 'retry-window-only') &&
      isExactRecord(value, ['kind', 'replayed', 'retention', 'semanticProposal']) &&
      typeof value.replayed === 'boolean' &&
      value.retention === 'held'
    );
  }
  if (kind === 'host-state-recovery-required') {
    return (
      isExactRecord(value, ['kind', 'replayed', 'retention']) &&
      typeof value.replayed === 'boolean' &&
      value.retention === 'held'
    );
  }
  return false;
}

export function isTaskNotesRequestError(value: unknown): value is TaskNotesRequestError {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const code = (value as UnknownRecord).code;
  if (
    code === 'bad-request' ||
    code === 'unsupported-media-type' ||
    code === 'payload-too-large' ||
    code === 'unauthenticated' ||
    code === 'forbidden' ||
    code === 'operation-identity-rejected'
  ) {
    return isExactRecord(value, ['code']);
  }
  if (code === 'rate-limited' || code === 'capacity-exhausted') {
    return (
      isExactRecord(value, ['code', 'retryAfterMs']) && isTaskNotesRetryAfterMs(value.retryAfterMs)
    );
  }
  if (code === 'persistence-unavailable' || code === 'internal-error') {
    return isExactRecord(value, ['code', 'retryable']) && typeof value.retryable === 'boolean';
  }
  return false;
}

export function isTaskNotesWireResponse<Result>(
  value: unknown,
  isResult: Guard<Result>,
): value is TaskNotesWireResponse<Result> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ok = (value as UnknownRecord).ok;
  return ok === true
    ? isExactRecord(value, ['ok', 'result']) && isResult(value.result)
    : ok === false && isExactRecord(value, ['ok', 'error']) && isTaskNotesRequestError(value.error);
}

export const isGetTaskNotesWireResponse = (
  value: unknown,
): value is TaskNotesWireResponse<GetTaskNotesResult> =>
  isTaskNotesWireResponse(value, isGetTaskNotesResult);

export const isIssueTaskNotesOperationWireResponse = (
  value: unknown,
): value is TaskNotesWireResponse<IssueTaskNotesOperationResult> =>
  isTaskNotesWireResponse(value, isIssueTaskNotesOperationResult);

export const isUpdateTaskNotesWireResponse = (
  value: unknown,
): value is TaskNotesWireResponse<UpdateTaskNotesResult> =>
  isTaskNotesWireResponse(value, isUpdateTaskNotesResult);

export function isTaskNotesChangedNotification(
  value: unknown,
): value is TaskNotesChangedNotification {
  return (
    isExactRecord(value, ['taskId', 'workspaceRevision', 'sourceId']) &&
    isTaskNotesTaskId(value.taskId) &&
    isTaskNotesRevision(value.workspaceRevision) &&
    (value.sourceId === null || isTaskNotesSourceId(value.sourceId))
  );
}

export function serializeTaskNotesChangedNotification(
  notification: TaskNotesChangedNotification,
): string {
  if (!isTaskNotesChangedNotification(notification)) {
    throw new TypeError('Invalid task notes notification');
  }
  const serialized = JSON.stringify({
    taskId: notification.taskId,
    workspaceRevision: notification.workspaceRevision,
    sourceId: notification.sourceId,
  });
  const byteLength = getWellFormedUtf8ByteLength(serialized);
  if (byteLength === null || byteLength > TASK_NOTES_CHANGED_MAX_BYTES) {
    throw new TypeError('Task notes notification exceeds its wire budget');
  }
  return serialized;
}

export function getTaskNotesRequestErrorHttpStatus(error: TaskNotesRequestError): number {
  switch (error.code) {
    case 'bad-request':
      return 400;
    case 'unauthenticated':
      return 401;
    case 'forbidden':
      return 403;
    case 'operation-identity-rejected':
      return 409;
    case 'payload-too-large':
      return 413;
    case 'unsupported-media-type':
      return 415;
    case 'rate-limited':
      return 429;
    case 'capacity-exhausted':
    case 'persistence-unavailable':
      return 503;
    case 'internal-error':
      return 500;
  }
}
