import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';

import {
  isTaskCreationOperationCapability,
  isTaskCreationOperationId,
  type TaskCreationOperationCapability,
  type TaskCreationOperationId,
} from '../../src/domain/task-creation-ticket.js';
import type { WorktreeSymlinkWarning, WorktreeSymlinkWarningReason } from '../../src/ipc/types.js';
import { isRecord } from '../../src/lib/type-guards.js';
import { isWellFormedUnicodeScalarString } from '../../src/lib/unicode-scalar.js';
import {
  assertTaskWorktreeLinkRequestV1,
  type TaskWorktreeLinkRequestV1,
} from './git-worktree-symlinks.js';
import {
  createShardedOperationStore,
  type ShardedOperationStore,
  type ShardedOperationStoreCommitResult,
  type ShardedOperationStoreHealth,
  type ShardedOperationStoreStartupResult,
  type ShardedOperationStoreFaultPoint,
} from './sharded-operation-store.js';
import type { StorageEnv } from './storage-environment.js';
import { getStateDirForEnv } from './storage-environment.js';
import {
  canonicalJsonStringify,
  type JsonObject,
  type JsonValue,
} from './workspace-state-storage.js';

export const TASK_CREATION_JOURNAL_DIRECTORY_NAME = 'task-creation-operations';
export const TASK_CREATION_JOURNAL_FORMAT_VERSION = 1;
export const TASK_CREATION_JOURNAL_RECORD_LIMIT = 4_096;
export const TASK_CREATION_JOURNAL_NONTERMINAL_PER_PRINCIPAL_LIMIT = 32;
export const TASK_CREATION_JOURNAL_NONTERMINAL_WORKSPACE_LIMIT = 256;
export const TASK_CREATION_JOURNAL_MAX_CHARGED_BYTES = 32 * 1_024 * 1_024;
export const TASK_CREATION_JOURNAL_INDEX_MAX_BYTES = 512 * 1_024;
export const TASK_CREATION_JOURNAL_CORE_MAX_BYTES = 4_096;
export const TASK_CREATION_WARNING_STRUCTURAL_BINARY_MAX_BYTES = 33_026;
export const TASK_CREATION_WARNING_STRUCTURAL_BASE64URL_MAX_BYTES = 44_035;
export const TASK_CREATION_WARNING_STRUCTURAL_COMPONENT_MAX_BYTES = 44_058;
export const TASK_CREATION_WARNING_COMPONENT_ENVELOPE_MAX_BYTES = 44_096;
export const TASK_CREATION_JOURNAL_STRUCTURAL_RECORD_MAX_BYTES = 48_154;
export const TASK_CREATION_JOURNAL_COMPONENT_HARD_SUM_BYTES = 48_192;
export const TASK_CREATION_JOURNAL_RECORD_TIER_BYTES = 49_152;
export const TASK_CREATION_WARNING_WORKFLOW_BINARY_MAX_BYTES = 16_512;
export const TASK_CREATION_WARNING_WORKFLOW_BASE64URL_MAX_BYTES = 22_016;
export const TASK_CREATION_WARNING_WORKFLOW_COMPONENT_MAX_BYTES = 22_039;
export const TASK_CREATION_JOURNAL_WORKFLOW_RECORD_MAX_BYTES = 26_135;
export const TASK_CREATION_JOURNAL_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const TASK_CREATION_JOURNAL_KIND = 'task-creation';
const TASK_CREATION_SEMANTIC_FINGERPRINT_PURPOSE = 'task-creation-semantic-fingerprint:v1';
const TASK_CREATION_SEMANTIC_REQUEST = Symbol('NormalizedTaskCreationSemanticRequestV1');
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:@/-]+$/u;
const OPAQUE_RESOURCE_ID_PATTERN = /^[A-Za-z0-9._:@-]+$/u;
const BASE64URL_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const WARNING_REASON_CODE = Object.freeze({
  candidate_query_failed: 0,
  not_current_candidate: 1,
  invalid_name: 2,
  reserved_name: 3,
  source_missing: 4,
  source_symlink: 5,
  unsupported_source_kind: 6,
  destination_exists: 7,
  link_failed: 8,
  exclude_update_failed: 9,
  ignore_postcondition_failed: 10,
} satisfies Record<WorktreeSymlinkWarningReason, number>);

const WARNING_REASON_BY_CODE = new Map<number, WorktreeSymlinkWarningReason>(
  Object.entries(WARNING_REASON_CODE).map(([reason, code]) => [
    code,
    reason as WorktreeSymlinkWarningReason,
  ]),
);

export type TaskCreationJournalPhase =
  | 'validating'
  | 'preparing'
  | 'committing'
  | 'starting'
  | 'delivering-prompt'
  | 'active'
  | 'created-needs-attention'
  | 'failed-before-commit'
  | 'cancelled-before-preparation'
  | 'manual-reconciliation-required'
  | 'removed-tombstone';

export type TaskCreationJournalIssueCode =
  | 'terminal-launch-capacity'
  | 'reservation-conflict'
  | 'preparation-failed'
  | 'workspace-conflict'
  | 'operation-journal-repair-required'
  | 'manual-reconciliation-required'
  | 'launch-failed'
  | 'prompt-enqueue-rejected'
  | 'projection-repair-required';

export type TaskCreationConflictKeyKind =
  | 'project'
  | 'project-root'
  | 'managed-worktree'
  | 'branch'
  | 'existing-worktree'
  | 'task'
  | 'launch-operation';

export interface TaskCreationConflictKey {
  digest: string;
  kind: TaskCreationConflictKeyKind;
}

export interface TaskCreationReconciliationResource {
  conflictKey: TaskCreationConflictKey;
  resourceId: string;
}

export type TaskCreationBranchDeleteState =
  | { state: 'not-applicable' | 'pending' | 'complete' | 'abandoned-preserved' }
  | { attempt: number; state: 'in-progress' }
  | {
      challengeId: string;
      confirmationVersion: number;
      observedRefFrontierWitness: string;
      state: 'confirmation-required';
    };

export type TaskCreationJournalReconciliationState =
  | { kind: 'none' }
  | {
      expectedTaskId: string;
      kind: 'mapping-ambiguous';
      resource: TaskCreationReconciliationResource;
    }
  | { kind: 'artifact-ambiguous'; resources: TaskCreationReconciliationResource[] }
  | {
      branchDelete: TaskCreationBranchDeleteState;
      conflictKey: TaskCreationConflictKey;
      kind: 'retained-quarantine';
      operationLockOwnershipWitness: string;
      operationLockResourceId: string;
      quarantineLocator: string;
      recoveryId: string;
      resourceId: string;
      restore:
        | { kind: 'released' | 'retained' }
        | {
            destinationFilesystemWitness: string;
            destinationLocator: string;
            destinationParentWitness: string;
            kind: 'restore-pending';
          }
        | {
            destinationFilesystemWitness: string;
            destinationLocator: string;
            destinationParentWitness: string;
            kind: 'unlock-pending';
            restoredResourceWitness: string;
          };
    }
  | { kind: 'abandoned-conflicts'; resources: TaskCreationReconciliationResource[] };

export function getTaskCreationReconciliationConflictKeys(
  reconciliation: Readonly<TaskCreationJournalReconciliationState>,
): TaskCreationConflictKey[] {
  switch (reconciliation.kind) {
    case 'none':
      return [];
    case 'mapping-ambiguous':
      return [reconciliation.resource.conflictKey];
    case 'artifact-ambiguous':
    case 'abandoned-conflicts':
      return reconciliation.resources.map((resource) => resource.conflictKey);
    case 'retained-quarantine':
      return [reconciliation.conflictKey];
  }
}

export interface TaskCreationJournalWarningEnvelope {
  symlinkWarningsV1?: string;
  warningReservationBytes: number;
}

export type TaskCreationJournalRetention =
  | { kind: 'nonterminal' }
  | { kind: 'live-task' }
  | { expiresAtMs: number; kind: 'tombstone' }
  | { kind: 'retained-artifact' };

export type TaskCreationJournalCommit =
  | { kind: 'not-committed' }
  | { kind: 'committed'; taskId: string; workspaceRevision: number };

export interface TaskCreationJournalRecord {
  activeConflictKeys: TaskCreationConflictKey[];
  capabilityHash: string;
  commit: TaskCreationJournalCommit;
  conflictKeys: TaskCreationConflictKey[];
  createdAtMs: number;
  formatVersion: typeof TASK_CREATION_JOURNAL_FORMAT_VERSION;
  identities: {
    deliveryId: string | null;
    launchOperationId: string;
    sessionId: string;
    taskId: string;
  };
  issueCode: TaskCreationJournalIssueCode | null;
  operationId: TaskCreationOperationId;
  phase: TaskCreationJournalPhase;
  reconciliation: TaskCreationJournalReconciliationState;
  recordVersion: number;
  retention: TaskCreationJournalRetention;
  semanticFingerprint: string;
  taskMode: 'agent' | 'terminal';
  updatedAtMs: number;
  warning: TaskCreationJournalWarningEnvelope;
  workspacePrincipalHash: string;
}

export interface TaskCreationJournalCounts {
  chargedBytes: number;
  nonterminal: number;
  records: number;
}

export interface TaskCreationJournal {
  activateFresh(): Promise<ShardedOperationStoreStartupResult>;
  activateFromLegacy(
    records: readonly TaskCreationJournalRecord[],
    legacyDigest: string,
  ): Promise<ShardedOperationStoreStartupResult>;
  close(): Promise<void>;
  compactExpired(nowMs: number): Promise<number>;
  findConflict(key: TaskCreationConflictKey): TaskCreationJournalRecord[];
  flushDerivedIndex(): Promise<boolean>;
  get(
    workspacePrincipalHash: string,
    operationId: TaskCreationOperationId,
  ): TaskCreationJournalRecord | null;
  getByOperationId(operationId: TaskCreationOperationId): TaskCreationJournalRecord | null;
  getByTaskId(taskId: string): TaskCreationJournalRecord | null;
  getCounts(): TaskCreationJournalCounts;
  getHealth(): ShardedOperationStoreHealth;
  getTopologyEpoch(): string | null;
  hasOperationId(operationId: TaskCreationOperationId): boolean;
  list(): TaskCreationJournalRecord[];
  repairDurability(): Promise<boolean>;
  save(
    record: TaskCreationJournalRecord,
    expectedVersion: number | null,
  ): Promise<ShardedOperationStoreCommitResult>;
  startup(): Promise<ShardedOperationStoreStartupResult>;
}

export interface TaskCreationJournalOptions {
  faultInjector?: (point: ShardedOperationStoreFaultPoint) => Promise<void> | void;
  now?: () => number;
  rootPath?: string;
}

/**
 * A fresh operation attempted to claim a resource that is still owned by an
 * active or retained creation operation. The journal raises this from inside
 * its serialized save boundary so callers cannot race a separate preflight.
 */
export class TaskCreationConflictAdmissionError extends Error {
  constructor(
    readonly conflictKey: TaskCreationConflictKey,
    readonly conflictingOperationIds: readonly TaskCreationOperationId[],
  ) {
    super('Task-creation operation conflicts with an active resource owner');
    this.name = 'TaskCreationConflictAdmissionError';
  }
}

export type NormalizedTaskCreationSemanticRequestV1 = Readonly<{
  [TASK_CREATION_SEMANTIC_REQUEST]: true;
  baseBranchRef?: string;
  branchPrefixPreference?: string;
  githubUrl?: string;
  launch:
    | Readonly<{
        agentDefId: string;
        initialPrompt?: string;
        kind: 'agent';
        skipPermissions: boolean;
      }>
    | Readonly<{ kind: 'terminal' }>;
  location:
    | Readonly<{
        kind: 'managed-worktree';
        worktreeLinkRequest: TaskWorktreeLinkRequestV1;
      }>
    | Readonly<{ kind: 'project-root' }>
    | Readonly<{ kind: 'existing-worktree'; worktreeRef: string }>;
  name: string;
  projectId: string;
  stepsTracking: boolean;
}>;

export type TaskCreationSemanticRequestV1Input = Omit<
  NormalizedTaskCreationSemanticRequestV1,
  typeof TASK_CREATION_SEMANTIC_REQUEST
>;

export interface TaskCreationDecodedJournalWarning {
  name: string;
  reason: WorktreeSymlinkWarningReason;
}

const PHASE_TRANSITIONS = Object.freeze({
  active: ['removed-tombstone'],
  'cancelled-before-preparation': [],
  committing: ['starting', 'failed-before-commit', 'manual-reconciliation-required'],
  'created-needs-attention': ['removed-tombstone'],
  'delivering-prompt': ['active', 'created-needs-attention'],
  'failed-before-commit': [],
  'manual-reconciliation-required': ['failed-before-commit', 'starting', 'created-needs-attention'],
  preparing: ['committing', 'failed-before-commit', 'manual-reconciliation-required'],
  'removed-tombstone': [],
  starting: ['delivering-prompt', 'active', 'created-needs-attention'],
  validating: [
    'preparing',
    'failed-before-commit',
    'cancelled-before-preparation',
    'manual-reconciliation-required',
  ],
} satisfies Record<TaskCreationJournalPhase, readonly TaskCreationJournalPhase[]>);

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isSafeId(value: unknown, maxBytes = 64): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    SAFE_ID_PATTERN.test(value) &&
    !value.includes('\u0000')
  );
}

function isOpaqueResourceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 64 &&
    OPAQUE_RESOURCE_ID_PATTERN.test(value)
  );
}

function isBoundedScalarString(
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    isWellFormedUnicodeScalarString(value) &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    !value.includes('\u0000')
  );
}

function isBoundedWarningName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    isWellFormedUnicodeScalarString(value) &&
    Buffer.byteLength(value, 'utf8') <= 255
  );
}

function hasOwnDefined(value: Record<string, unknown>, key: string): boolean {
  return !Object.prototype.hasOwnProperty.call(value, key) || value[key] !== undefined;
}

function isConflictKeyKind(value: unknown): value is TaskCreationConflictKeyKind {
  return (
    value === 'project' ||
    value === 'project-root' ||
    value === 'managed-worktree' ||
    value === 'branch' ||
    value === 'existing-worktree' ||
    value === 'task' ||
    value === 'launch-operation'
  );
}

function isConflictKey(value: unknown): value is TaskCreationConflictKey & JsonObject {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['digest', 'kind']) &&
    isSha256(value.digest) &&
    isConflictKeyKind(value.kind)
  );
}

function compareConflictKeys(
  left: TaskCreationConflictKey,
  right: TaskCreationConflictKey,
): number {
  return left.kind.localeCompare(right.kind) || left.digest.localeCompare(right.digest);
}

export function taskCreationConflictKeyId(key: TaskCreationConflictKey): string {
  if (!isConflictKey(key)) throw new Error('Invalid task-creation conflict key');
  return `${key.kind}:${key.digest}`;
}

export function deriveTaskCreationConflictKey(
  kind: TaskCreationConflictKeyKind,
  canonicalIdentity: string,
): TaskCreationConflictKey {
  if (
    !isConflictKeyKind(kind) ||
    typeof canonicalIdentity !== 'string' ||
    canonicalIdentity.length === 0 ||
    canonicalIdentity.includes('\u0000') ||
    !isWellFormedUnicodeScalarString(canonicalIdentity) ||
    Buffer.byteLength(canonicalIdentity, 'utf8') > 4_096
  ) {
    throw new Error('Invalid task-creation conflict identity');
  }
  const domain = Buffer.from(`parallel-code:task-creation-conflict:${kind}:v1`, 'utf8');
  const identity = Buffer.from(canonicalIdentity, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(identity.byteLength);
  return {
    digest: createHash('sha256').update(domain).update(length).update(identity).digest('hex'),
    kind,
  };
}

function isReconciliationResource(
  value: unknown,
): value is TaskCreationReconciliationResource & JsonObject {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['conflictKey', 'resourceId']) &&
    isConflictKey(value.conflictKey) &&
    isOpaqueResourceId(value.resourceId)
  );
}

function areCanonicalConflictKeys(
  value: unknown,
): value is Array<TaskCreationConflictKey & JsonObject> {
  if (!Array.isArray(value) || value.length > 8 || !value.every(isConflictKey)) return false;
  const sorted = [...value].sort(compareConflictKeys);
  return (
    canonicalJsonStringify(sorted as unknown as JsonValue) ===
      canonicalJsonStringify(value as unknown as JsonValue) &&
    new Set(value.map(taskCreationConflictKeyId)).size === value.length
  );
}

function areCanonicalReconciliationResources(
  value: unknown,
): value is Array<TaskCreationReconciliationResource & JsonObject> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return false;
  if (!value.every(isReconciliationResource)) return false;
  const sorted = [...value].sort(
    (left, right) =>
      compareConflictKeys(left.conflictKey, right.conflictKey) ||
      Buffer.compare(Buffer.from(left.resourceId, 'utf8'), Buffer.from(right.resourceId, 'utf8')),
  );
  return (
    canonicalJsonStringify(sorted as unknown as JsonValue) ===
      canonicalJsonStringify(value as unknown as JsonValue) &&
    new Set(value.map((resource) => resource.resourceId)).size === value.length &&
    new Set(value.map((resource) => taskCreationConflictKeyId(resource.conflictKey))).size ===
      value.length
  );
}

function isBranchDeleteState(value: unknown): value is TaskCreationBranchDeleteState & JsonObject {
  if (!isRecord(value) || typeof value.state !== 'string') return false;
  switch (value.state) {
    case 'not-applicable':
    case 'pending':
    case 'complete':
    case 'abandoned-preserved':
      return hasOnlyKeys(value, ['state']);
    case 'in-progress':
      return hasOnlyKeys(value, ['attempt', 'state']) && isPositiveSafeInteger(value.attempt);
    case 'confirmation-required':
      return (
        hasOnlyKeys(value, [
          'challengeId',
          'confirmationVersion',
          'observedRefFrontierWitness',
          'state',
        ]) &&
        isSafeId(value.challengeId) &&
        isPositiveSafeInteger(value.confirmationVersion) &&
        typeof value.observedRefFrontierWitness === 'string' &&
        BASE64URL_SHA256_PATTERN.test(value.observedRefFrontierWitness)
      );
    default:
      return false;
  }
}

function isRestoreState(
  value: unknown,
): value is Extract<
  TaskCreationJournalReconciliationState,
  { kind: 'retained-quarantine' }
>['restore'] &
  JsonObject {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'retained' || value.kind === 'released') {
    return hasOnlyKeys(value, ['kind']);
  }
  const common =
    isBoundedScalarString(value.destinationLocator, 384) &&
    typeof value.destinationFilesystemWitness === 'string' &&
    BASE64URL_SHA256_PATTERN.test(value.destinationFilesystemWitness) &&
    typeof value.destinationParentWitness === 'string' &&
    BASE64URL_SHA256_PATTERN.test(value.destinationParentWitness);
  if (value.kind === 'restore-pending') {
    return (
      hasOnlyKeys(value, [
        'destinationFilesystemWitness',
        'destinationLocator',
        'destinationParentWitness',
        'kind',
      ]) && common
    );
  }
  if (value.kind === 'unlock-pending') {
    return (
      hasOnlyKeys(value, [
        'destinationFilesystemWitness',
        'destinationLocator',
        'destinationParentWitness',
        'kind',
        'restoredResourceWitness',
      ]) &&
      common &&
      typeof value.restoredResourceWitness === 'string' &&
      BASE64URL_SHA256_PATTERN.test(value.restoredResourceWitness)
    );
  }
  return false;
}

function isReconciliationState(
  value: unknown,
): value is TaskCreationJournalReconciliationState & JsonObject {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'none':
      return hasOnlyKeys(value, ['kind']);
    case 'mapping-ambiguous':
      return (
        hasOnlyKeys(value, ['expectedTaskId', 'kind', 'resource']) &&
        isSafeId(value.expectedTaskId) &&
        isReconciliationResource(value.resource)
      );
    case 'artifact-ambiguous':
    case 'abandoned-conflicts':
      return (
        hasOnlyKeys(value, ['kind', 'resources']) &&
        areCanonicalReconciliationResources(value.resources)
      );
    case 'retained-quarantine':
      return (
        hasOnlyKeys(value, [
          'branchDelete',
          'conflictKey',
          'kind',
          'operationLockOwnershipWitness',
          'operationLockResourceId',
          'quarantineLocator',
          'recoveryId',
          'resourceId',
          'restore',
        ]) &&
        isBranchDeleteState(value.branchDelete) &&
        isConflictKey(value.conflictKey) &&
        isOpaqueResourceId(value.operationLockResourceId) &&
        typeof value.operationLockOwnershipWitness === 'string' &&
        BASE64URL_SHA256_PATTERN.test(value.operationLockOwnershipWitness) &&
        isBoundedScalarString(value.quarantineLocator, 384) &&
        isOpaqueResourceId(value.recoveryId) &&
        isOpaqueResourceId(value.resourceId) &&
        isRestoreState(value.restore)
      );
    default:
      return false;
  }
}

function isRetention(value: unknown): value is TaskCreationJournalRetention & JsonObject {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (
    value.kind === 'nonterminal' ||
    value.kind === 'live-task' ||
    value.kind === 'retained-artifact'
  ) {
    return hasOnlyKeys(value, ['kind']);
  }
  return (
    value.kind === 'tombstone' &&
    hasOnlyKeys(value, ['expiresAtMs', 'kind']) &&
    isNonNegativeSafeInteger(value.expiresAtMs)
  );
}

function isCapacityActive(record: TaskCreationJournalRecord): boolean {
  return record.retention.kind === 'nonterminal' || record.retention.kind === 'retained-artifact';
}

function isCommit(value: unknown): value is TaskCreationJournalCommit & JsonObject {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'not-committed') return hasOnlyKeys(value, ['kind']);
  return (
    value.kind === 'committed' &&
    hasOnlyKeys(value, ['kind', 'taskId', 'workspaceRevision']) &&
    isSafeId(value.taskId) &&
    isPositiveSafeInteger(value.workspaceRevision)
  );
}

function isWarningEnvelope(
  value: unknown,
): value is TaskCreationJournalWarningEnvelope & JsonObject {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['symlinkWarningsV1', 'warningReservationBytes']) ||
    !isNonNegativeSafeInteger(value.warningReservationBytes) ||
    value.warningReservationBytes > TASK_CREATION_WARNING_WORKFLOW_COMPONENT_MAX_BYTES ||
    (value.symlinkWarningsV1 !== undefined && typeof value.symlinkWarningsV1 !== 'string') ||
    (value.symlinkWarningsV1 !== undefined && value.warningReservationBytes !== 0)
  ) {
    return false;
  }
  if (value.symlinkWarningsV1 !== undefined) {
    try {
      decodeTaskCreationJournalWarnings(value.symlinkWarningsV1);
    } catch {
      return false;
    }
  }
  return true;
}

function isJournalPhase(value: unknown): value is TaskCreationJournalPhase {
  return typeof value === 'string' && value in PHASE_TRANSITIONS;
}

function isJournalIssueCode(value: unknown): value is TaskCreationJournalIssueCode {
  return (
    value === 'terminal-launch-capacity' ||
    value === 'reservation-conflict' ||
    value === 'preparation-failed' ||
    value === 'workspace-conflict' ||
    value === 'operation-journal-repair-required' ||
    value === 'manual-reconciliation-required' ||
    value === 'launch-failed' ||
    value === 'prompt-enqueue-rejected' ||
    value === 'projection-repair-required'
  );
}

function hasLegalRecordState(record: TaskCreationJournalRecord): boolean {
  const notCommitted = record.commit.kind === 'not-committed';
  const hasActiveConflicts = record.activeConflictKeys.length > 0;
  switch (record.phase) {
    case 'validating':
    case 'preparing':
    case 'committing':
      return (
        notCommitted &&
        hasActiveConflicts &&
        record.issueCode === null &&
        record.retention.kind === 'nonterminal' &&
        record.reconciliation.kind === 'none'
      );
    case 'manual-reconciliation-required':
      return (
        notCommitted &&
        hasActiveConflicts &&
        (record.issueCode === 'manual-reconciliation-required' ||
          record.issueCode === 'operation-journal-repair-required') &&
        (record.retention.kind === 'nonterminal' ||
          record.retention.kind === 'retained-artifact') &&
        record.reconciliation.kind !== 'none'
      );
    case 'failed-before-commit':
      return (
        notCommitted &&
        (record.issueCode === 'reservation-conflict' ||
          record.issueCode === 'preparation-failed' ||
          record.issueCode === 'workspace-conflict' ||
          (record.taskMode === 'terminal' && record.issueCode === 'terminal-launch-capacity')) &&
        (record.retention.kind === 'tombstone'
          ? !hasActiveConflicts && record.reconciliation.kind === 'none'
          : hasActiveConflicts &&
            record.retention.kind === 'retained-artifact' &&
            record.reconciliation.kind !== 'none')
      );
    case 'cancelled-before-preparation':
      return (
        notCommitted &&
        !hasActiveConflicts &&
        record.issueCode === null &&
        record.retention.kind === 'tombstone' &&
        record.reconciliation.kind === 'none'
      );
    case 'starting':
    case 'delivering-prompt':
    case 'active':
    case 'created-needs-attention':
      return (
        !notCommitted &&
        !hasActiveConflicts &&
        (record.phase === 'created-needs-attention'
          ? record.issueCode === 'launch-failed' ||
            record.issueCode === 'operation-journal-repair-required' ||
            record.issueCode === 'projection-repair-required' ||
            (record.taskMode === 'agent' && record.issueCode === 'prompt-enqueue-rejected')
          : record.issueCode === null) &&
        record.retention.kind === 'live-task' &&
        record.reconciliation.kind === 'none'
      );
    case 'removed-tombstone':
      return (
        !notCommitted &&
        !hasActiveConflicts &&
        record.issueCode === null &&
        record.retention.kind === 'tombstone' &&
        record.reconciliation.kind === 'none'
      );
  }
}

function decodeTaskCreationJournalRecord(value: unknown): TaskCreationJournalRecord {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'activeConflictKeys',
      'capabilityHash',
      'commit',
      'conflictKeys',
      'createdAtMs',
      'formatVersion',
      'identities',
      'issueCode',
      'operationId',
      'phase',
      'reconciliation',
      'recordVersion',
      'retention',
      'semanticFingerprint',
      'taskMode',
      'updatedAtMs',
      'warning',
      'workspacePrincipalHash',
    ]) ||
    value.formatVersion !== TASK_CREATION_JOURNAL_FORMAT_VERSION ||
    !isTaskCreationOperationId(value.operationId) ||
    !isSha256(value.workspacePrincipalHash) ||
    !isSha256(value.capabilityHash) ||
    !isSha256(value.semanticFingerprint) ||
    (value.taskMode !== 'agent' && value.taskMode !== 'terminal') ||
    !isJournalPhase(value.phase) ||
    !isPositiveSafeInteger(value.recordVersion) ||
    !isNonNegativeSafeInteger(value.createdAtMs) ||
    !isNonNegativeSafeInteger(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs ||
    !areCanonicalConflictKeys(value.conflictKeys) ||
    value.conflictKeys.length === 0 ||
    !areCanonicalConflictKeys(value.activeConflictKeys) ||
    !isCommit(value.commit) ||
    !isRetention(value.retention) ||
    !isReconciliationState(value.reconciliation) ||
    !isWarningEnvelope(value.warning) ||
    (value.issueCode !== null && !isJournalIssueCode(value.issueCode)) ||
    !isRecord(value.identities) ||
    !hasOnlyKeys(value.identities, ['deliveryId', 'launchOperationId', 'sessionId', 'taskId']) ||
    !isSafeId(value.identities.taskId) ||
    !isSafeId(value.identities.launchOperationId) ||
    !isSafeId(value.identities.sessionId) ||
    (value.identities.deliveryId !== null && !isSafeId(value.identities.deliveryId))
  ) {
    throw new Error('Invalid task-creation journal record');
  }
  const record = value as unknown as TaskCreationJournalRecord;
  const declaredConflictIds = new Set(record.conflictKeys.map(taskCreationConflictKeyId));
  const activeConflictIds = new Set(record.activeConflictKeys.map(taskCreationConflictKeyId));
  const reconciliationConflictIds = getTaskCreationReconciliationConflictKeys(
    record.reconciliation,
  ).map(taskCreationConflictKeyId);
  if (
    [...activeConflictIds].some((key) => !declaredConflictIds.has(key)) ||
    reconciliationConflictIds.some((key) => !activeConflictIds.has(key)) ||
    (record.reconciliation.kind !== 'none' &&
      (reconciliationConflictIds.length !== activeConflictIds.size ||
        [...activeConflictIds].some((key) => !reconciliationConflictIds.includes(key)))) ||
    (record.commit.kind === 'committed' && record.commit.taskId !== record.identities.taskId) ||
    (record.taskMode === 'terminal' && record.identities.deliveryId !== null) ||
    (record.phase === 'delivering-prompt' &&
      (record.taskMode !== 'agent' || record.identities.deliveryId === null)) ||
    !hasLegalRecordState(record)
  ) {
    throw new Error('Inconsistent task-creation journal record');
  }
  assertTaskCreationRecordByteLimits(record);
  return structuredClone(record);
}

function warningComponentBytes(encoded: string | undefined): number {
  if (encoded === undefined) return 0;
  return Buffer.byteLength(`,"symlinkWarningsV1":${JSON.stringify(encoded)}`, 'utf8');
}

function recordCoreValue(record: TaskCreationJournalRecord): JsonObject {
  return {
    ...record,
    warning: { warningReservationBytes: record.warning.warningReservationBytes },
  } as unknown as JsonObject;
}

export function getTaskCreationJournalRecordCharge(record: TaskCreationJournalRecord): number {
  const actualWarningBytes = warningComponentBytes(record.warning.symlinkWarningsV1);
  return (
    TASK_CREATION_JOURNAL_CORE_MAX_BYTES +
    Math.max(actualWarningBytes, record.warning.warningReservationBytes)
  );
}

export function assertTaskCreationRecordByteLimits(record: TaskCreationJournalRecord): void {
  const coreBytes = Buffer.byteLength(
    canonicalJsonStringify(recordCoreValue(record) as unknown as JsonObject),
    'utf8',
  );
  const componentBytes = warningComponentBytes(record.warning.symlinkWarningsV1);
  const recordBytes = Buffer.byteLength(
    canonicalJsonStringify(record as unknown as JsonObject),
    'utf8',
  );
  if (coreBytes > TASK_CREATION_JOURNAL_CORE_MAX_BYTES) {
    throw new Error('Task-creation journal core exceeds 4,096 bytes');
  }
  if (componentBytes > TASK_CREATION_WARNING_STRUCTURAL_COMPONENT_MAX_BYTES) {
    throw new Error('Task-creation warning component exceeds structural limit');
  }
  if (recordBytes > TASK_CREATION_JOURNAL_STRUCTURAL_RECORD_MAX_BYTES) {
    throw new Error('Task-creation journal record exceeds structural limit');
  }
  if (recordBytes > TASK_CREATION_JOURNAL_RECORD_TIER_BYTES) {
    throw new Error('Task-creation journal record exceeds 48 KiB tier');
  }
}

export function assertTaskCreationWorkflowRecordByteLimits(
  record: TaskCreationJournalRecord,
): void {
  assertTaskCreationRecordByteLimits(record);
  const componentBytes = warningComponentBytes(record.warning.symlinkWarningsV1);
  const recordBytes = Buffer.byteLength(
    canonicalJsonStringify(record as unknown as JsonObject),
    'utf8',
  );
  if (componentBytes > TASK_CREATION_WARNING_WORKFLOW_COMPONENT_MAX_BYTES) {
    throw new Error('Task-creation warning component exceeds workflow limit');
  }
  if (recordBytes > TASK_CREATION_JOURNAL_WORKFLOW_RECORD_MAX_BYTES) {
    throw new Error('Task-creation journal record exceeds workflow limit');
  }
}

function base64urlLength(byteLength: number): number {
  return 4 * Math.floor(byteLength / 3) + (byteLength % 3 === 0 ? 0 : (byteLength % 3) + 1);
}

export function createTaskCreationWarningReservation(
  request: TaskWorktreeLinkRequestV1,
): TaskCreationJournalWarningEnvelope {
  assertTaskWorktreeLinkRequestV1(request);
  const futureBinaryBytes = request.encodedLength + request.names.length;
  if (futureBinaryBytes > TASK_CREATION_WARNING_WORKFLOW_BINARY_MAX_BYTES) {
    throw new Error('Task-creation warning reservation exceeds workflow maximum');
  }
  return {
    warningReservationBytes:
      request.names.length === 0 ? 0 : 23 + base64urlLength(futureBinaryBytes),
  };
}

function exactUtf8Key(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

export function encodeTaskCreationJournalWarnings(
  warnings: readonly Pick<WorktreeSymlinkWarning, 'name' | 'reason'>[],
): string | undefined {
  if (!Array.isArray(warnings) || warnings.length > 128) {
    throw new Error('Task-creation warning count exceeds 128');
  }
  if (warnings.length === 0) return undefined;
  const entries = warnings.map((warning) => {
    if (
      !isRecord(warning) ||
      !hasOnlyKeys(warning, ['message', 'name', 'reason']) ||
      !isBoundedWarningName(warning.name) ||
      typeof warning.reason !== 'string' ||
      !Object.prototype.hasOwnProperty.call(WARNING_REASON_CODE, warning.reason)
    ) {
      throw new Error('Invalid task-creation warning');
    }
    const reason = warning.reason as WorktreeSymlinkWarningReason;
    return {
      bytes: Buffer.from(warning.name, 'utf8'),
      name: warning.name,
      reason,
    };
  });
  entries.sort((left, right) => Buffer.compare(left.bytes, right.bytes));
  for (let index = 1; index < entries.length; index += 1) {
    const previousEntry = entries[index - 1];
    const currentEntry = entries[index];
    if (!previousEntry || !currentEntry) {
      throw new Error('Task-creation warning ordering invariant failed');
    }
    if (Buffer.compare(previousEntry.bytes, currentEntry.bytes) >= 0) {
      throw new Error('Task-creation warnings must have exact unique names');
    }
  }
  const binaryBytes = 2 + entries.reduce((total, entry) => total + 3 + entry.bytes.length, 0);
  if (binaryBytes > TASK_CREATION_WARNING_STRUCTURAL_BINARY_MAX_BYTES) {
    throw new Error('Task-creation warning binary exceeds structural limit');
  }
  const output = Buffer.allocUnsafe(binaryBytes);
  output[0] = 1;
  output[1] = entries.length;
  let offset = 2;
  for (const entry of entries) {
    output[offset] = WARNING_REASON_CODE[entry.reason];
    output.writeUInt16BE(entry.bytes.length, offset + 1);
    offset += 3;
    entry.bytes.copy(output, offset);
    offset += entry.bytes.length;
  }
  const encoded = output.toString('base64url');
  if (encoded.length > TASK_CREATION_WARNING_STRUCTURAL_BASE64URL_MAX_BYTES) {
    throw new Error('Task-creation warning base64url exceeds structural limit');
  }
  return encoded;
}

export function decodeTaskCreationJournalWarnings(
  encoded: string,
): TaskCreationDecodedJournalWarning[] {
  if (
    typeof encoded !== 'string' ||
    encoded.length < 1 ||
    encoded.length > TASK_CREATION_WARNING_STRUCTURAL_BASE64URL_MAX_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    throw new Error('Invalid task-creation warning encoding');
  }
  const binary = Buffer.from(encoded, 'base64url');
  const warningCount = binary[1];
  if (
    binary.toString('base64url') !== encoded ||
    binary.length < 2 ||
    binary.length > TASK_CREATION_WARNING_STRUCTURAL_BINARY_MAX_BYTES ||
    binary[0] !== 1 ||
    warningCount === undefined ||
    warningCount > 128
  ) {
    throw new Error('Invalid task-creation warning encoding');
  }
  const warnings: TaskCreationDecodedJournalWarning[] = [];
  let offset = 2;
  let previous: Buffer | null = null;
  for (let index = 0; index < warningCount; index += 1) {
    if (offset + 3 > binary.length) throw new Error('Truncated task-creation warning');
    const reasonCode = binary[offset];
    const reason = reasonCode === undefined ? undefined : WARNING_REASON_BY_CODE.get(reasonCode);
    const nameLength = binary.readUInt16BE(offset + 1);
    offset += 3;
    if (!reason || nameLength < 1 || nameLength > 255 || offset + nameLength > binary.length) {
      throw new Error('Invalid task-creation warning entry');
    }
    const bytes = binary.subarray(offset, offset + nameLength);
    let name: string;
    try {
      name = UTF8_DECODER.decode(bytes);
    } catch {
      throw new Error('Task-creation warning name is not valid UTF-8');
    }
    if (
      !isWellFormedUnicodeScalarString(name) ||
      !Buffer.from(name, 'utf8').equals(bytes) ||
      (previous !== null && Buffer.compare(previous, bytes) >= 0)
    ) {
      throw new Error('Task-creation warning names are not canonical');
    }
    warnings.push({ name, reason });
    previous = bytes;
    offset += nameLength;
  }
  if (offset !== binary.length)
    throw new Error('Task-creation warning encoding has trailing bytes');
  return warnings;
}

export function installTaskCreationJournalWarnings(
  request: TaskWorktreeLinkRequestV1,
  warnings: readonly Pick<WorktreeSymlinkWarning, 'name' | 'reason'>[],
  reservation: TaskCreationJournalWarningEnvelope,
): TaskCreationJournalWarningEnvelope {
  assertTaskWorktreeLinkRequestV1(request);
  if (
    reservation.symlinkWarningsV1 !== undefined ||
    reservation.warningReservationBytes !==
      createTaskCreationWarningReservation(request).warningReservationBytes
  ) {
    throw new Error('Task-creation warning reservation does not match owner-returned bytes');
  }
  const encoded = encodeTaskCreationJournalWarnings(warnings);
  const decoded = encoded === undefined ? [] : decodeTaskCreationJournalWarnings(encoded);
  const requestNames = new Set(request.names.map(exactUtf8Key));
  for (const warning of decoded) {
    if (!requestNames.has(exactUtf8Key(warning.name))) {
      throw new Error('Task-creation warning is not an exact requested-name subset');
    }
  }
  if (encoded === undefined) return { warningReservationBytes: 0 };
  const binaryBytes = Buffer.from(encoded, 'base64url').byteLength;
  if (
    binaryBytes > request.encodedLength + request.names.length ||
    warningComponentBytes(encoded) > reservation.warningReservationBytes
  ) {
    throw new Error('Task-creation warning result exceeds its durable reservation');
  }
  return { symlinkWarningsV1: encoded, warningReservationBytes: 0 };
}

function freezeSemanticRequest(
  request: TaskCreationSemanticRequestV1Input,
): NormalizedTaskCreationSemanticRequestV1 {
  return Object.freeze({
    ...request,
    launch: Object.freeze({ ...request.launch }),
    location: Object.freeze({ ...request.location }),
    [TASK_CREATION_SEMANTIC_REQUEST]: true as const,
  }) as NormalizedTaskCreationSemanticRequestV1;
}

export function createNormalizedTaskCreationSemanticRequestV1(
  request: TaskCreationSemanticRequestV1Input,
): NormalizedTaskCreationSemanticRequestV1 {
  if (
    !isRecord(request) ||
    !hasOnlyKeys(request, [
      'baseBranchRef',
      'branchPrefixPreference',
      'githubUrl',
      'launch',
      'location',
      'name',
      'projectId',
      'stepsTracking',
    ]) ||
    !hasOwnDefined(request, 'baseBranchRef') ||
    !hasOwnDefined(request, 'branchPrefixPreference') ||
    !hasOwnDefined(request, 'githubUrl') ||
    !isRecord(request.location) ||
    !isRecord(request.launch)
  ) {
    throw new Error('Invalid normalized task-creation semantic request shape');
  }
  if (
    !isSafeId(request.projectId) ||
    !isBoundedScalarString(request.name, 256) ||
    request.name !== request.name.trim() ||
    typeof request.stepsTracking !== 'boolean' ||
    (request.baseBranchRef !== undefined && !isSafeId(request.baseBranchRef)) ||
    (request.branchPrefixPreference !== undefined &&
      !isBoundedScalarString(request.branchPrefixPreference, 96)) ||
    (request.githubUrl !== undefined && !isBoundedScalarString(request.githubUrl, 2_048))
  ) {
    throw new Error('Invalid normalized task-creation semantic request');
  }
  switch (request.location.kind) {
    case 'managed-worktree':
      if (!hasOnlyKeys(request.location, ['kind', 'worktreeLinkRequest'])) {
        throw new Error('Managed task creation contains inactive location fields');
      }
      assertTaskWorktreeLinkRequestV1(request.location.worktreeLinkRequest);
      break;
    case 'existing-worktree':
      if (
        !hasOnlyKeys(request.location, ['kind', 'worktreeRef']) ||
        !isSafeId(request.location.worktreeRef)
      ) {
        throw new Error('Invalid normalized existing-worktree reference');
      }
      break;
    case 'project-root':
      if (!hasOnlyKeys(request.location, ['kind'])) {
        throw new Error('Project-root task creation contains inactive location fields');
      }
      break;
    default:
      throw new Error('Invalid normalized task-creation location');
  }
  switch (request.launch.kind) {
    case 'agent':
      if (
        !hasOnlyKeys(request.launch, ['agentDefId', 'initialPrompt', 'kind', 'skipPermissions']) ||
        !hasOwnDefined(request.launch, 'initialPrompt') ||
        !isSafeId(request.launch.agentDefId) ||
        typeof request.launch.skipPermissions !== 'boolean' ||
        (request.launch.initialPrompt !== undefined &&
          !isBoundedScalarString(request.launch.initialPrompt, 1_048_576, true))
      ) {
        throw new Error('Invalid normalized task-creation agent launch');
      }
      break;
    case 'terminal':
      if (!hasOnlyKeys(request.launch, ['kind'])) {
        throw new Error('Terminal task creation contains inactive agent fields');
      }
      break;
    default:
      throw new Error('Invalid normalized task-creation launch');
  }
  if (request.launch.kind === 'agent' && request.launch.initialPrompt === '') {
    const { initialPrompt: _emptyPrompt, ...launch } = request.launch;
    return freezeSemanticRequest({ ...request, launch });
  }
  return freezeSemanticRequest(request);
}

class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  private byteLength = 0;

  build(): Uint8Array {
    const result = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  lp(value: string | Readonly<Uint8Array>): void {
    const bytes = typeof value === 'string' ? UTF8_ENCODER.encode(value) : value;
    if (bytes.byteLength > 0xffff_ffff)
      throw new Error('Semantic fingerprint field exceeds uint32');
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.byteLength, false);
    this.push(length);
    this.push(bytes);
  }

  optional(value: string | undefined): void {
    if (value === undefined) {
      this.u8(0);
    } else {
      this.u8(1);
      this.lp(value);
    }
  }

  u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error('Semantic fingerprint tag exceeds uint8');
    }
    this.push(Uint8Array.of(value));
  }

  private push(value: Readonly<Uint8Array>): void {
    this.byteLength += value.byteLength;
    if (!Number.isSafeInteger(this.byteLength) || this.byteLength > 1_048_576) {
      throw new Error('Semantic fingerprint input exceeds 1 MiB');
    }
    this.chunks.push(Uint8Array.from(value));
  }
}

export function encodeTaskCreationSemanticFingerprintInputV1(
  request: NormalizedTaskCreationSemanticRequestV1,
): Uint8Array {
  if (request[TASK_CREATION_SEMANTIC_REQUEST] !== true) {
    throw new Error('Task-creation semantic request was not normalized by its owner');
  }
  const writer = new ByteWriter();
  writer.lp(TASK_CREATION_SEMANTIC_FINGERPRINT_PURPOSE);
  writer.lp(request.projectId);
  writer.lp(request.name);
  switch (request.location.kind) {
    case 'managed-worktree':
      writer.u8(0);
      writer.lp(request.location.worktreeLinkRequest.encodedBytes);
      break;
    case 'project-root':
      writer.u8(1);
      break;
    case 'existing-worktree':
      writer.u8(2);
      writer.lp(request.location.worktreeRef);
      break;
  }
  switch (request.launch.kind) {
    case 'agent':
      writer.u8(0);
      writer.u8(1);
      writer.lp(request.launch.agentDefId);
      writer.optional(request.launch.initialPrompt);
      writer.u8(request.launch.skipPermissions ? 1 : 0);
      break;
    case 'terminal':
      writer.u8(1);
      writer.u8(0);
      writer.u8(0);
      writer.u8(0);
      break;
  }
  writer.optional(request.baseBranchRef);
  writer.optional(request.branchPrefixPreference);
  writer.optional(request.githubUrl);
  writer.u8(request.stepsTracking ? 1 : 0);
  return writer.build();
}

export function deriveTaskCreationSemanticFingerprint(
  capability: TaskCreationOperationCapability,
  request: NormalizedTaskCreationSemanticRequestV1,
): string {
  if (!isTaskCreationOperationCapability(capability)) {
    throw new Error('Invalid task-creation operation capability');
  }
  return createHmac('sha256', Buffer.from(capability, 'base64url'))
    .update(encodeTaskCreationSemanticFingerprintInputV1(request))
    .digest('hex');
}

export function taskCreationJournalCanonicalKey(
  workspacePrincipalHash: string,
  operationId: TaskCreationOperationId,
): string {
  if (!isSha256(workspacePrincipalHash) || !isTaskCreationOperationId(operationId)) {
    throw new Error('Invalid task-creation journal identity');
  }
  return `${workspacePrincipalHash}:${operationId}`;
}

function assertImmutableProgress(
  prior: TaskCreationJournalRecord,
  proposed: TaskCreationJournalRecord,
): void {
  const immutable = (record: TaskCreationJournalRecord): JsonObject => ({
    capabilityHash: record.capabilityHash,
    conflictKeys: record.conflictKeys as unknown as JsonValue,
    createdAtMs: record.createdAtMs,
    formatVersion: record.formatVersion,
    identities: record.identities as unknown as JsonValue,
    operationId: record.operationId,
    semanticFingerprint: record.semanticFingerprint,
    taskMode: record.taskMode,
    workspacePrincipalHash: record.workspacePrincipalHash,
  });
  if (
    canonicalJsonStringify(immutable(prior)) !== canonicalJsonStringify(immutable(proposed)) ||
    proposed.updatedAtMs < prior.updatedAtMs ||
    proposed.recordVersion !== prior.recordVersion + 1
  ) {
    throw new Error('Invalid task-creation journal record progression');
  }
  const allowedNextPhases: readonly TaskCreationJournalPhase[] = PHASE_TRANSITIONS[prior.phase];
  if (proposed.phase !== prior.phase && !allowedNextPhases.includes(proposed.phase)) {
    throw new Error('Invalid task-creation journal phase progression');
  }
  const priorActiveConflictIds = new Set(prior.activeConflictKeys.map(taskCreationConflictKeyId));
  if (
    proposed.activeConflictKeys.some(
      (conflictKey) => !priorActiveConflictIds.has(taskCreationConflictKeyId(conflictKey)),
    )
  ) {
    throw new Error('Task-creation active conflict scope may only shrink');
  }
  if (
    prior.warning.symlinkWarningsV1 !== undefined &&
    (proposed.warning.symlinkWarningsV1 !== prior.warning.symlinkWarningsV1 ||
      proposed.warning.warningReservationBytes !== 0)
  ) {
    throw new Error('Task-creation journal warning outcome is immutable');
  }
  if (prior.warning.symlinkWarningsV1 === undefined) {
    const sameReservation =
      proposed.warning.symlinkWarningsV1 === undefined &&
      proposed.warning.warningReservationBytes === prior.warning.warningReservationBytes;
    const installedWithinReservation =
      proposed.warning.warningReservationBytes === 0 &&
      warningComponentBytes(proposed.warning.symlinkWarningsV1) <=
        prior.warning.warningReservationBytes;
    if (!sameReservation && !installedWithinReservation) {
      throw new Error('Task-creation journal warning reservation may only be consumed once');
    }
  }
  if (prior.commit.kind === 'committed') {
    if (canonicalJsonStringify(prior.commit) !== canonicalJsonStringify(proposed.commit)) {
      throw new Error('Task-creation journal commit identity is immutable');
    }
  }
}

class TaskCreationJournalImpl implements TaskCreationJournal {
  private readonly store: ShardedOperationStore<TaskCreationJournalRecord>;
  private queue: Promise<void> = Promise.resolve();
  private readonly operationById = new Map<TaskCreationOperationId, string>();
  private readonly operationByTaskId = new Map<string, string>();
  private readonly operationKeysByConflict = new Map<string, Set<string>>();
  private readonly nonterminalByPrincipal = new Map<string, number>();
  private readonly now: () => number;
  private nonterminalCount = 0;

  constructor(rootPath: string, options: TaskCreationJournalOptions) {
    this.now = options.now ?? Date.now;
    this.store = createShardedOperationStore({
      codec: {
        decodePayload: decodeTaskCreationJournalRecord,
        getCanonicalKey: (record) =>
          taskCreationJournalCanonicalKey(record.workspacePrincipalHash, record.operationId),
        getChargedBytes: getTaskCreationJournalRecordCharge,
        getRecordVersion: (record) => record.recordVersion,
      },
      ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
      journalKind: TASK_CREATION_JOURNAL_KIND,
      limits: {
        maxChargedBytes: TASK_CREATION_JOURNAL_MAX_CHARGED_BYTES,
        maxIndexBytes: TASK_CREATION_JOURNAL_INDEX_MAX_BYTES,
        maxRecordCount: TASK_CREATION_JOURNAL_RECORD_LIMIT,
        maxRecordEnvelopeBytes: TASK_CREATION_JOURNAL_RECORD_TIER_BYTES + 1_024,
      },
      rootPath,
    });
  }

  activateFresh(): Promise<ShardedOperationStoreStartupResult> {
    return this.enqueue(async () => {
      const result = await this.store.activateFresh();
      if (result.health === 'healthy') this.rebuildIndexes();
      return result;
    });
  }

  activateFromLegacy(
    records: readonly TaskCreationJournalRecord[],
    legacyDigest: string,
  ): Promise<ShardedOperationStoreStartupResult> {
    return this.enqueue(async () => {
      const stable = records.map(decodeTaskCreationJournalRecord);
      this.assertUniqueIndexes(stable);
      this.assertNonterminalCapacity(stable);
      const result = await this.store.activateFromLegacy(stable, legacyDigest);
      if (result.health === 'healthy') this.rebuildIndexes();
      return result;
    });
  }

  close(): Promise<void> {
    return this.enqueue(() => this.store.close());
  }

  compactExpired(nowMs: number): Promise<number> {
    if (!isNonNegativeSafeInteger(nowMs))
      return Promise.reject(new Error('Invalid compaction time'));
    return this.enqueue(async () => {
      const result = await this.store.compact(
        (record) => record.retention.kind === 'tombstone' && record.retention.expiresAtMs <= nowMs,
      );
      this.rebuildIndexes();
      return result.deleted;
    });
  }

  findConflict(key: TaskCreationConflictKey): TaskCreationJournalRecord[] {
    if (!isConflictKey(key)) throw new Error('Invalid task-creation conflict key');
    const operationKeys = this.operationKeysByConflict.get(taskCreationConflictKeyId(key));
    if (!operationKeys) return [];
    return [...operationKeys]
      .map((operationKey) => this.store.get(operationKey))
      .filter((record): record is TaskCreationJournalRecord => record !== null);
  }

  flushDerivedIndex(): Promise<boolean> {
    return this.store.flushDerivedIndex();
  }

  get(
    workspacePrincipalHash: string,
    operationId: TaskCreationOperationId,
  ): TaskCreationJournalRecord | null {
    return this.store.get(taskCreationJournalCanonicalKey(workspacePrincipalHash, operationId));
  }

  getByOperationId(operationId: TaskCreationOperationId): TaskCreationJournalRecord | null {
    if (!isTaskCreationOperationId(operationId)) return null;
    const key = this.operationById.get(operationId);
    return key ? this.store.get(key) : null;
  }

  getByTaskId(taskId: string): TaskCreationJournalRecord | null {
    if (!isSafeId(taskId)) return null;
    const key = this.operationByTaskId.get(taskId);
    return key ? this.store.get(key) : null;
  }

  getCounts(): TaskCreationJournalCounts {
    const counts = this.store.getCounts();
    return { ...counts, nonterminal: this.nonterminalCount };
  }

  getHealth(): ShardedOperationStoreHealth {
    return this.store.getHealth();
  }

  getTopologyEpoch(): string | null {
    return this.store.getTopologyEpoch();
  }

  hasOperationId(operationId: TaskCreationOperationId): boolean {
    return isTaskCreationOperationId(operationId) && this.operationById.has(operationId);
  }

  list(): TaskCreationJournalRecord[] {
    return this.store.list();
  }

  repairDurability(): Promise<boolean> {
    return this.enqueue(async () => {
      const repaired = await this.store.repairDurability();
      if (repaired) this.rebuildIndexes();
      return repaired;
    });
  }

  save(
    record: TaskCreationJournalRecord,
    expectedVersion: number | null,
  ): Promise<ShardedOperationStoreCommitResult> {
    return this.enqueue(async () => {
      const stable = decodeTaskCreationJournalRecord(record);
      assertTaskCreationWorkflowRecordByteLimits(stable);
      const key = taskCreationJournalCanonicalKey(
        stable.workspacePrincipalHash,
        stable.operationId,
      );
      let prior = this.store.get(key);
      if (prior === null && expectedVersion === null && isCapacityActive(stable)) {
        this.assertFreshConflictAdmission(stable);
      }
      if (prior === null && expectedVersion === null && this.wouldExceedStoreCapacity(stable)) {
        const now = this.now();
        if (!isNonNegativeSafeInteger(now)) {
          throw new Error('Invalid task-creation journal clock');
        }
        await this.store.compact(
          (candidate) =>
            candidate.retention.kind === 'tombstone' && candidate.retention.expiresAtMs <= now,
        );
        this.rebuildIndexes();
        prior = this.store.get(key);
      }
      if (prior) {
        const exactCurrent =
          canonicalJsonStringify(prior as unknown as JsonObject) ===
          canonicalJsonStringify(stable as unknown as JsonObject);
        if (exactCurrent) {
          if (
            expectedVersion !== prior.recordVersion &&
            expectedVersion !== prior.recordVersion - 1 &&
            !(expectedVersion === null && prior.recordVersion === 1)
          ) {
            throw new Error('Task-creation journal exact replay has a stale base version');
          }
          return { kind: 'already-current' };
        }
        assertImmutableProgress(prior, stable);
      } else if (expectedVersion !== null || stable.recordVersion !== 1) {
        throw new Error('First task-creation journal record must use version 1');
      }
      this.assertProspectiveIndexes(prior, stable);
      const result = await this.store.save(stable, expectedVersion);
      if (result.kind === 'committed' || result.kind === 'already-current') {
        this.replaceIndexes(prior, stable);
      }
      return result;
    });
  }

  startup(): Promise<ShardedOperationStoreStartupResult> {
    return this.enqueue(async () => {
      const result = await this.store.startup();
      if (result.health === 'healthy') this.rebuildIndexes();
      return result;
    });
  }

  private assertNonterminalCapacity(records: readonly TaskCreationJournalRecord[]): void {
    const counts = new Map<string, number>();
    let total = 0;
    for (const record of records) {
      if (!isCapacityActive(record)) continue;
      total += 1;
      counts.set(
        record.workspacePrincipalHash,
        (counts.get(record.workspacePrincipalHash) ?? 0) + 1,
      );
    }
    if (total > TASK_CREATION_JOURNAL_NONTERMINAL_WORKSPACE_LIMIT) {
      throw new Error('Task-creation nonterminal workspace capacity exceeded');
    }
    if (
      [...counts.values()].some(
        (count) => count > TASK_CREATION_JOURNAL_NONTERMINAL_PER_PRINCIPAL_LIMIT,
      )
    ) {
      throw new Error('Task-creation nonterminal principal capacity exceeded');
    }
  }

  private assertFreshConflictAdmission(proposed: TaskCreationJournalRecord): void {
    for (const conflictKey of proposed.activeConflictKeys) {
      const conflictingOperationIds = this.findConflict(conflictKey)
        .map((record) => record.operationId)
        .filter((operationId) => operationId !== proposed.operationId)
        .sort();
      if (conflictingOperationIds.length > 0) {
        throw new TaskCreationConflictAdmissionError(conflictKey, conflictingOperationIds);
      }
    }
  }

  private assertProspectiveIndexes(
    prior: TaskCreationJournalRecord | null,
    proposed: TaskCreationJournalRecord,
  ): void {
    const operationOwner = this.operationById.get(proposed.operationId);
    const key = taskCreationJournalCanonicalKey(
      proposed.workspacePrincipalHash,
      proposed.operationId,
    );
    if (operationOwner && operationOwner !== key) {
      throw new Error('Task-creation operation ID collides across principals');
    }
    if (proposed.commit.kind === 'committed') {
      const taskOwner = this.operationByTaskId.get(proposed.commit.taskId);
      if (taskOwner && taskOwner !== key) {
        throw new Error('Canonical task maps to multiple task-creation operations');
      }
    }
    const priorActive = prior !== null && isCapacityActive(prior);
    const proposedActive = isCapacityActive(proposed);
    const total = this.nonterminalCount - (priorActive ? 1 : 0) + (proposedActive ? 1 : 0);
    const principal =
      (this.nonterminalByPrincipal.get(proposed.workspacePrincipalHash) ?? 0) -
      (priorActive ? 1 : 0) +
      (proposedActive ? 1 : 0);
    if (total > TASK_CREATION_JOURNAL_NONTERMINAL_WORKSPACE_LIMIT) {
      throw new Error('Task-creation nonterminal workspace capacity exceeded');
    }
    if (principal > TASK_CREATION_JOURNAL_NONTERMINAL_PER_PRINCIPAL_LIMIT) {
      throw new Error('Task-creation nonterminal principal capacity exceeded');
    }
  }

  private assertUniqueIndexes(records: readonly TaskCreationJournalRecord[]): void {
    const operationIds = new Set<string>();
    const taskIds = new Set<string>();
    for (const record of records) {
      if (operationIds.has(record.operationId)) {
        throw new Error('Duplicate task-creation operation ID');
      }
      operationIds.add(record.operationId);
      if (record.commit.kind === 'committed') {
        if (taskIds.has(record.commit.taskId)) {
          throw new Error('Duplicate task-creation task mapping');
        }
        taskIds.add(record.commit.taskId);
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private addIndexes(record: TaskCreationJournalRecord): void {
    const key = taskCreationJournalCanonicalKey(record.workspacePrincipalHash, record.operationId);
    this.operationById.set(record.operationId, key);
    if (record.commit.kind === 'committed') {
      this.operationByTaskId.set(record.commit.taskId, key);
    }
    if (isCapacityActive(record)) {
      this.nonterminalCount += 1;
      this.nonterminalByPrincipal.set(
        record.workspacePrincipalHash,
        (this.nonterminalByPrincipal.get(record.workspacePrincipalHash) ?? 0) + 1,
      );
      for (const conflictKey of record.activeConflictKeys) {
        const conflictId = taskCreationConflictKeyId(conflictKey);
        const operations = this.operationKeysByConflict.get(conflictId) ?? new Set<string>();
        operations.add(key);
        this.operationKeysByConflict.set(conflictId, operations);
      }
    }
  }

  private removeIndexes(record: TaskCreationJournalRecord): void {
    const key = taskCreationJournalCanonicalKey(record.workspacePrincipalHash, record.operationId);
    if (this.operationById.get(record.operationId) === key) {
      this.operationById.delete(record.operationId);
    }
    if (
      record.commit.kind === 'committed' &&
      this.operationByTaskId.get(record.commit.taskId) === key
    ) {
      this.operationByTaskId.delete(record.commit.taskId);
    }
    if (isCapacityActive(record)) {
      this.nonterminalCount -= 1;
      const principalCount =
        (this.nonterminalByPrincipal.get(record.workspacePrincipalHash) ?? 1) - 1;
      if (principalCount === 0) this.nonterminalByPrincipal.delete(record.workspacePrincipalHash);
      else this.nonterminalByPrincipal.set(record.workspacePrincipalHash, principalCount);
      for (const conflictKey of record.activeConflictKeys) {
        const conflictId = taskCreationConflictKeyId(conflictKey);
        const operations = this.operationKeysByConflict.get(conflictId);
        operations?.delete(key);
        if (operations?.size === 0) this.operationKeysByConflict.delete(conflictId);
      }
    }
  }

  private replaceIndexes(
    prior: TaskCreationJournalRecord | null,
    proposed: TaskCreationJournalRecord,
  ): void {
    if (prior) this.removeIndexes(prior);
    this.addIndexes(proposed);
  }

  private rebuildIndexes(): void {
    this.operationById.clear();
    this.operationByTaskId.clear();
    this.operationKeysByConflict.clear();
    this.nonterminalByPrincipal.clear();
    this.nonterminalCount = 0;
    const records = this.store.list();
    this.assertUniqueIndexes(records);
    this.assertNonterminalCapacity(records);
    for (const record of records) this.addIndexes(record);
  }

  private wouldExceedStoreCapacity(record: TaskCreationJournalRecord): boolean {
    const counts = this.store.getCounts();
    return (
      counts.records >= TASK_CREATION_JOURNAL_RECORD_LIMIT ||
      counts.chargedBytes + getTaskCreationJournalRecordCharge(record) >
        TASK_CREATION_JOURNAL_MAX_CHARGED_BYTES
    );
  }
}

export function createTaskCreationJournal(
  env: StorageEnv,
  options: TaskCreationJournalOptions = {},
): TaskCreationJournal {
  const rootPath =
    options.rootPath ?? path.join(getStateDirForEnv(env), TASK_CREATION_JOURNAL_DIRECTORY_NAME);
  return new TaskCreationJournalImpl(rootPath, options);
}
