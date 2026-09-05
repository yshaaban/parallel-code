import { createHash } from 'node:crypto';

import { isRecord } from '../../src/lib/type-guards.js';
import {
  createShardedOperationStore,
  type ShardedOperationStore,
  type ShardedOperationStoreCommitResult,
  type ShardedOperationStoreDeleteResult,
  type ShardedOperationStoreFaultPoint,
  type ShardedOperationStoreHealth,
  type ShardedOperationStoreStartupResult,
} from './sharded-operation-store.js';
import type { StorageEnv } from './storage-environment.js';
import { getStateDirForEnv } from './storage-environment.js';
import { canonicalJsonStringify } from './workspace-state-storage.js';

export const TASK_SHELL_SESSION_JOURNAL_DIRECTORY_NAME = 'task-shell-session-operations';
export const TASK_SHELL_SESSION_JOURNAL_FORMAT_VERSION = 1;
export const TASK_SHELL_SESSION_JOURNAL_RECORD_LIMIT = 16_384;
export const TASK_SHELL_SESSION_JOURNAL_RICH_LIMIT = 4_096;
export const TASK_SHELL_SESSION_JOURNAL_ACTIVE_PER_PRINCIPAL_LIMIT = 32;
export const TASK_SHELL_SESSION_JOURNAL_ACTIVE_WORKSPACE_LIMIT = 256;
export const TASK_SHELL_SESSION_JOURNAL_MAX_CHARGED_BYTES = 32 * 1_024 * 1_024;
export const TASK_SHELL_SESSION_JOURNAL_INDEX_MAX_BYTES = 2 * 1_024 * 1_024;
export const TASK_SHELL_SESSION_RICH_RECORD_CHARGE_BYTES = 4 * 1_024;
export const TASK_SHELL_SESSION_MARKER_CHARGE_BYTES = 512;
export const TASK_SHELL_SESSION_DELETION_PENDING_CHARGE_BYTES = 2 * 1_024;
export const TASK_SHELL_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const JOURNAL_KIND = 'task-shell-session';
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTITY = /^[A-Za-z0-9._:@/-]+$/u;

export interface TaskShellSessionIdentity {
  committedWorkspaceRevision: number | null;
  creationOperationId: string;
  expectedGeneration: number;
  operationId: string;
  sessionId: string;
  taskId: string;
}

interface TaskShellSessionRecordBase extends TaskShellSessionIdentity {
  capabilityHash: string;
  createdAtMs: number;
  formatVersion: typeof TASK_SHELL_SESSION_JOURNAL_FORMAT_VERSION;
  recordVersion: number;
  updatedAtMs: number;
  workspacePrincipalHash: string;
}

export type TaskShellSessionActivePhase =
  | 'reserved-for-task-commit'
  | 'admitted'
  | 'spawning'
  | 'awaiting-spawn-ack'
  | 'manual-reconciliation-required';

export type TaskShellSessionTerminalPhase = 'running' | 'failed' | 'cancelled';

export type TaskShellSessionFullRecord = TaskShellSessionRecordBase &
  (
    | {
        kind: 'full';
        phase: 'reserved-for-task-commit';
      }
    | {
        kind: 'full';
        phase: 'admitted' | 'spawning';
      }
    | {
        kind: 'full';
        phase: 'awaiting-spawn-ack';
        supervisorIdentityHash: string;
      }
    | {
        completedAtMs: number;
        kind: 'full';
        phase: 'running';
        supervisorIdentityHash: string;
      }
    | {
        completedAtMs: number;
        failureDisposition: 'attempted-no-replay';
        kind: 'full';
        phase: 'failed';
      }
    | {
        completedAtMs: number;
        failureDisposition: 'same-tuple-retry';
        kind: 'full';
        phase: 'failed';
        retryUntilMs: number;
      }
    | {
        completedAtMs: number;
        kind: 'full';
        phase: 'cancelled';
      }
    | {
        kind: 'full';
        phase: 'manual-reconciliation-required';
        supervisorIdentityHash: string | null;
        taskSpawnQuarantined: true;
      }
  );

export type TaskShellSessionOutcomeClass = 'running-at-ack' | 'failed' | 'cancelled';

export type TaskShellSessionMarkerRecord = TaskShellSessionRecordBase & {
  completedAtMs: number;
  kind: 'initial-launch-marker';
  outcomeClass: TaskShellSessionOutcomeClass;
};

export type TaskShellSessionRestartPhase =
  | 'clean-restart-pending'
  | 'restart-spawning'
  | 'restart-awaiting-spawn-ack'
  | 'running'
  | 'failed'
  | 'manual-reconciliation-required';

type TaskShellSessionRestartRecordBase = TaskShellSessionRecordBase & {
  generationHighWater: number;
  kind: 'restart-lifecycle';
  restartOperationId: string;
};

/**
 * Durable runtime state for generations after the immutable initial launch.
 * A pending clean-restart permit is written only after the previous exact
 * generation has been observed running, stopped by the host, and then proven
 * absent by the tuple authority. The target generation is the high-water
 * value and is therefore never inferred from process-local state.
 */
export type TaskShellSessionRestartRecord = TaskShellSessionRestartRecordBase &
  (
    | {
        cleanStopSupervisorIdentityHash: string;
        phase: 'clean-restart-pending';
        sourceGeneration: number;
      }
    | {
        cleanStopSupervisorIdentityHash: string;
        phase: 'restart-spawning';
        sourceGeneration: number;
      }
    | {
        cleanStopSupervisorIdentityHash: string;
        phase: 'restart-awaiting-spawn-ack';
        sourceGeneration: number;
        supervisorIdentityHash: string;
      }
    | {
        completedAtMs: number;
        phase: 'running';
        supervisorIdentityHash: string;
      }
    | {
        completedAtMs: number;
        phase: 'failed';
      }
    | {
        phase: 'manual-reconciliation-required';
        supervisorIdentityHash: string | null;
        taskSpawnQuarantined: true;
      }
  );

export interface TaskShellSessionDeletionWitness {
  deletionOperationId: string;
  preparedWorkspaceRevision: number;
  priorCanonicalDigest: string;
  priorOutcomeClass: 'proven-safe-active' | TaskShellSessionOutcomeClass;
  priorRecordVersion: number;
  taskIdentityWitness: string;
}

export type TaskShellSessionDeletionPendingRecord = TaskShellSessionRecordBase & {
  deletion: TaskShellSessionDeletionWitness;
  kind: 'deletion-pending';
  outcome: 'task-removal-not-committed' | 'task-removed-finalization-pending';
};

export type TaskShellSessionDeletionTombstoneRecord = TaskShellSessionRecordBase & {
  completedAtMs: number;
  expiresAtMs: number;
  kind: 'deletion-tombstone';
  outcome: 'cancelled-before-task-commit' | 'task-removed-no-replay';
};

export type TaskShellSessionDeletionReconciliationRecord = TaskShellSessionRecordBase & {
  deletion: TaskShellSessionDeletionWitness;
  kind: 'deletion-reconciliation-required';
  taskSpawnQuarantined: true;
};

export type TaskShellSessionJournalRecord =
  | TaskShellSessionFullRecord
  | TaskShellSessionMarkerRecord
  | TaskShellSessionRestartRecord
  | TaskShellSessionDeletionPendingRecord
  | TaskShellSessionDeletionTombstoneRecord
  | TaskShellSessionDeletionReconciliationRecord;

export interface TaskShellSessionJournalCounts {
  active: number;
  chargedBytes: number;
  lifecycle: number;
  records: number;
  richAndReserved: number;
}

export interface TaskShellSessionJournal {
  activateFresh(): Promise<ShardedOperationStoreStartupResult>;
  activateFromLegacy(
    records: readonly TaskShellSessionJournalRecord[],
    legacyDigest: string,
  ): Promise<ShardedOperationStoreStartupResult>;
  close(): Promise<void>;
  compact(nowMs: number): Promise<{ deletedTombstones: number; markersWritten: number }>;
  delete(operationId: string, expectedVersion: number): Promise<ShardedOperationStoreDeleteResult>;
  flushDerivedIndex(): Promise<boolean>;
  get(operationId: string): TaskShellSessionJournalRecord | null;
  getByTaskId(taskId: string): TaskShellSessionJournalRecord | null;
  getCounts(): TaskShellSessionJournalCounts;
  getHealth(): ShardedOperationStoreHealth;
  getTopologyEpoch(): string | null;
  list(): TaskShellSessionJournalRecord[];
  repairDurability(): Promise<boolean>;
  save(
    record: TaskShellSessionJournalRecord,
    expectedVersion: number | null,
  ): Promise<ShardedOperationStoreCommitResult>;
  startup(): Promise<ShardedOperationStoreStartupResult>;
}

export interface TaskShellSessionJournalOptions {
  faultInjector?: (point: ShardedOperationStoreFaultPoint) => Promise<void> | void;
  rootPath?: string;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 512 &&
    IDENTITY.test(value) &&
    !value.includes('\u0000')
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

const BASE_KEYS = Object.freeze([
  'capabilityHash',
  'committedWorkspaceRevision',
  'createdAtMs',
  'creationOperationId',
  'expectedGeneration',
  'formatVersion',
  'kind',
  'operationId',
  'recordVersion',
  'sessionId',
  'taskId',
  'updatedAtMs',
  'workspacePrincipalHash',
] as const);

function keys(...extra: string[]): string[] {
  return [...BASE_KEYS, ...extra];
}

function isBaseRecord(value: Record<string, unknown>): boolean {
  return (
    value.formatVersion === TASK_SHELL_SESSION_JOURNAL_FORMAT_VERSION &&
    isIdentifier(value.operationId) &&
    isIdentifier(value.creationOperationId) &&
    isIdentifier(value.taskId) &&
    isIdentifier(value.sessionId) &&
    isNonNegativeInteger(value.expectedGeneration) &&
    (value.committedWorkspaceRevision === null ||
      isPositiveInteger(value.committedWorkspaceRevision)) &&
    isDigest(value.capabilityHash) &&
    isDigest(value.workspacePrincipalHash) &&
    isPositiveInteger(value.recordVersion) &&
    isNonNegativeInteger(value.createdAtMs) &&
    isNonNegativeInteger(value.updatedAtMs) &&
    (value.updatedAtMs as number) >= (value.createdAtMs as number)
  );
}

function isDeletionWitness(value: unknown): value is TaskShellSessionDeletionWitness {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'deletionOperationId',
      'preparedWorkspaceRevision',
      'priorCanonicalDigest',
      'priorOutcomeClass',
      'priorRecordVersion',
      'taskIdentityWitness',
    ]) &&
    isIdentifier(value.deletionOperationId) &&
    isPositiveInteger(value.preparedWorkspaceRevision) &&
    isDigest(value.priorCanonicalDigest) &&
    (value.priorOutcomeClass === 'proven-safe-active' ||
      value.priorOutcomeClass === 'running-at-ack' ||
      value.priorOutcomeClass === 'failed' ||
      value.priorOutcomeClass === 'cancelled') &&
    isPositiveInteger(value.priorRecordVersion) &&
    isDigest(value.taskIdentityWitness)
  );
}

export function decodeTaskShellSessionJournalRecord(value: unknown): TaskShellSessionJournalRecord {
  if (!isRecord(value) || !isBaseRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Invalid task-shell-session journal record');
  }

  let valid = false;
  switch (value.kind) {
    case 'full':
      if (typeof value.phase !== 'string') break;
      switch (value.phase) {
        case 'reserved-for-task-commit':
          valid = hasExactKeys(value, keys('phase')) && value.committedWorkspaceRevision === null;
          break;
        case 'admitted':
        case 'spawning':
          valid =
            hasExactKeys(value, keys('phase')) &&
            isPositiveInteger(value.committedWorkspaceRevision);
          break;
        case 'awaiting-spawn-ack':
          valid =
            hasExactKeys(value, keys('phase', 'supervisorIdentityHash')) &&
            isPositiveInteger(value.committedWorkspaceRevision) &&
            isDigest(value.supervisorIdentityHash);
          break;
        case 'running':
          valid =
            hasExactKeys(value, keys('completedAtMs', 'phase', 'supervisorIdentityHash')) &&
            isPositiveInteger(value.committedWorkspaceRevision) &&
            isNonNegativeInteger(value.completedAtMs) &&
            (value.completedAtMs as number) >= (value.createdAtMs as number) &&
            isDigest(value.supervisorIdentityHash);
          break;
        case 'failed':
          valid =
            isPositiveInteger(value.committedWorkspaceRevision) &&
            isNonNegativeInteger(value.completedAtMs) &&
            (value.completedAtMs as number) >= (value.createdAtMs as number) &&
            (value.failureDisposition === 'attempted-no-replay'
              ? hasExactKeys(value, keys('completedAtMs', 'failureDisposition', 'phase'))
              : value.failureDisposition === 'same-tuple-retry' &&
                hasExactKeys(
                  value,
                  keys('completedAtMs', 'failureDisposition', 'phase', 'retryUntilMs'),
                ) &&
                isPositiveInteger(value.retryUntilMs) &&
                (value.retryUntilMs as number) ===
                  (value.completedAtMs as number) + TASK_SHELL_SESSION_RETENTION_MS);
          break;
        case 'cancelled':
          valid =
            hasExactKeys(value, keys('completedAtMs', 'phase')) &&
            isNonNegativeInteger(value.completedAtMs) &&
            (value.completedAtMs as number) >= (value.createdAtMs as number);
          break;
        case 'manual-reconciliation-required':
          valid =
            hasExactKeys(value, keys('phase', 'supervisorIdentityHash', 'taskSpawnQuarantined')) &&
            isPositiveInteger(value.committedWorkspaceRevision) &&
            (value.supervisorIdentityHash === null || isDigest(value.supervisorIdentityHash)) &&
            value.taskSpawnQuarantined === true;
          break;
      }
      break;
    case 'initial-launch-marker':
      valid =
        hasExactKeys(value, keys('completedAtMs', 'outcomeClass')) &&
        isPositiveInteger(value.committedWorkspaceRevision) &&
        isNonNegativeInteger(value.completedAtMs) &&
        (value.outcomeClass === 'running-at-ack' ||
          value.outcomeClass === 'failed' ||
          value.outcomeClass === 'cancelled');
      break;
    case 'restart-lifecycle': {
      if (
        typeof value.phase !== 'string' ||
        !isNonNegativeInteger(value.generationHighWater) ||
        (value.generationHighWater as number) < (value.expectedGeneration as number) ||
        !isIdentifier(value.restartOperationId) ||
        !isPositiveInteger(value.committedWorkspaceRevision)
      ) {
        break;
      }
      switch (value.phase) {
        case 'clean-restart-pending':
        case 'restart-spawning':
          valid =
            hasExactKeys(
              value,
              keys(
                'cleanStopSupervisorIdentityHash',
                'generationHighWater',
                'phase',
                'restartOperationId',
                'sourceGeneration',
              ),
            ) &&
            isDigest(value.cleanStopSupervisorIdentityHash) &&
            isNonNegativeInteger(value.sourceGeneration) &&
            (value.generationHighWater as number) === (value.sourceGeneration as number) + 1;
          break;
        case 'restart-awaiting-spawn-ack':
          valid =
            hasExactKeys(
              value,
              keys(
                'cleanStopSupervisorIdentityHash',
                'generationHighWater',
                'phase',
                'restartOperationId',
                'sourceGeneration',
                'supervisorIdentityHash',
              ),
            ) &&
            isDigest(value.cleanStopSupervisorIdentityHash) &&
            isNonNegativeInteger(value.sourceGeneration) &&
            (value.generationHighWater as number) === (value.sourceGeneration as number) + 1 &&
            isDigest(value.supervisorIdentityHash);
          break;
        case 'running':
          valid =
            hasExactKeys(
              value,
              keys(
                'completedAtMs',
                'generationHighWater',
                'phase',
                'restartOperationId',
                'supervisorIdentityHash',
              ),
            ) &&
            isNonNegativeInteger(value.completedAtMs) &&
            (value.completedAtMs as number) >= (value.createdAtMs as number) &&
            isDigest(value.supervisorIdentityHash);
          break;
        case 'failed':
          valid =
            hasExactKeys(
              value,
              keys('completedAtMs', 'generationHighWater', 'phase', 'restartOperationId'),
            ) &&
            isNonNegativeInteger(value.completedAtMs) &&
            (value.completedAtMs as number) >= (value.createdAtMs as number);
          break;
        case 'manual-reconciliation-required':
          valid =
            hasExactKeys(
              value,
              keys(
                'generationHighWater',
                'phase',
                'restartOperationId',
                'supervisorIdentityHash',
                'taskSpawnQuarantined',
              ),
            ) &&
            (value.supervisorIdentityHash === null || isDigest(value.supervisorIdentityHash)) &&
            value.taskSpawnQuarantined === true;
          break;
      }
      break;
    }
    case 'deletion-pending':
      valid =
        hasExactKeys(value, keys('deletion', 'outcome')) &&
        isPositiveInteger(value.committedWorkspaceRevision) &&
        isDeletionWitness(value.deletion) &&
        (value.outcome === 'task-removal-not-committed' ||
          value.outcome === 'task-removed-finalization-pending');
      break;
    case 'deletion-tombstone':
      valid =
        hasExactKeys(value, keys('completedAtMs', 'expiresAtMs', 'outcome')) &&
        isNonNegativeInteger(value.completedAtMs) &&
        isPositiveInteger(value.expiresAtMs) &&
        (value.expiresAtMs as number) ===
          (value.completedAtMs as number) + TASK_SHELL_SESSION_RETENTION_MS &&
        (value.outcome === 'cancelled-before-task-commit' ||
          value.outcome === 'task-removed-no-replay');
      break;
    case 'deletion-reconciliation-required':
      valid =
        hasExactKeys(value, keys('deletion', 'taskSpawnQuarantined')) &&
        isPositiveInteger(value.committedWorkspaceRevision) &&
        isDeletionWitness(value.deletion) &&
        value.taskSpawnQuarantined === true;
      break;
  }
  if (!valid) throw new Error('Invalid task-shell-session journal record shape');
  return structuredClone(value) as unknown as TaskShellSessionJournalRecord;
}

function recordCharge(record: TaskShellSessionJournalRecord): number {
  switch (record.kind) {
    case 'full':
      return TASK_SHELL_SESSION_RICH_RECORD_CHARGE_BYTES;
    case 'deletion-pending':
    case 'deletion-reconciliation-required':
    case 'restart-lifecycle':
      return TASK_SHELL_SESSION_DELETION_PENDING_CHARGE_BYTES;
    case 'initial-launch-marker':
    case 'deletion-tombstone':
      return TASK_SHELL_SESSION_MARKER_CHARGE_BYTES;
  }
}

function isActive(record: TaskShellSessionJournalRecord): boolean {
  return (
    (record.kind === 'full' &&
      (record.phase === 'reserved-for-task-commit' ||
        record.phase === 'admitted' ||
        record.phase === 'spawning' ||
        record.phase === 'awaiting-spawn-ack' ||
        record.phase === 'manual-reconciliation-required')) ||
    record.kind === 'deletion-pending' ||
    record.kind === 'deletion-reconciliation-required'
  );
}

function holdsRichSlot(record: TaskShellSessionJournalRecord): boolean {
  return record.kind === 'full';
}

function sameImmutableIdentity(
  current: TaskShellSessionJournalRecord,
  proposed: TaskShellSessionJournalRecord,
): boolean {
  return (
    current.operationId === proposed.operationId &&
    current.creationOperationId === proposed.creationOperationId &&
    current.taskId === proposed.taskId &&
    current.sessionId === proposed.sessionId &&
    current.expectedGeneration === proposed.expectedGeneration &&
    current.workspacePrincipalHash === proposed.workspacePrincipalHash &&
    current.capabilityHash === proposed.capabilityHash &&
    current.createdAtMs === proposed.createdAtMs
  );
}

function recordDigest(record: TaskShellSessionJournalRecord): string {
  return createHash('sha256')
    .update(canonicalJsonStringify(record as unknown as Record<string, never>))
    .digest('hex');
}

function isSameRecord(
  current: TaskShellSessionJournalRecord,
  proposed: TaskShellSessionJournalRecord,
): boolean {
  return recordDigest(current) === recordDigest(proposed);
}

function legalTransition(
  current: TaskShellSessionJournalRecord,
  proposed: TaskShellSessionJournalRecord,
): boolean {
  if (
    current.kind === 'full' &&
    current.phase === 'reserved-for-task-commit' &&
    proposed.kind === 'deletion-tombstone' &&
    proposed.outcome === 'cancelled-before-task-commit'
  ) {
    return true;
  }
  if (proposed.kind === 'deletion-pending') return current.kind !== 'deletion-tombstone';
  if (
    current.kind === 'deletion-pending' &&
    (proposed.kind === 'deletion-tombstone' || proposed.kind === 'deletion-reconciliation-required')
  ) {
    return true;
  }
  if (
    current.kind === 'deletion-reconciliation-required' &&
    proposed.kind === 'deletion-tombstone'
  ) {
    return true;
  }
  if (current.kind === 'deletion-tombstone') return false;
  if (proposed.kind === 'restart-lifecycle') {
    if (
      (current.kind === 'full' && current.phase === 'running') ||
      (current.kind === 'initial-launch-marker' && current.outcomeClass === 'running-at-ack')
    ) {
      return proposed.phase === 'clean-restart-pending'
        ? proposed.sourceGeneration === current.expectedGeneration &&
            proposed.generationHighWater === current.expectedGeneration + 1
        : proposed.phase === 'manual-reconciliation-required' &&
            proposed.generationHighWater === current.expectedGeneration;
    }
    if (current.kind !== 'restart-lifecycle') return false;
    if (proposed.phase === 'clean-restart-pending') {
      return (
        current.phase === 'running' &&
        proposed.sourceGeneration === current.generationHighWater &&
        proposed.generationHighWater === current.generationHighWater + 1
      );
    }
    if (
      proposed.restartOperationId !== current.restartOperationId ||
      proposed.generationHighWater !== current.generationHighWater
    ) {
      return false;
    }
    switch (current.phase) {
      case 'clean-restart-pending':
        return (
          proposed.phase === 'restart-spawning' ||
          proposed.phase === 'manual-reconciliation-required'
        );
      case 'restart-spawning':
        return (
          proposed.phase === 'restart-awaiting-spawn-ack' ||
          proposed.phase === 'running' ||
          proposed.phase === 'failed' ||
          proposed.phase === 'manual-reconciliation-required'
        );
      case 'restart-awaiting-spawn-ack':
        return (
          proposed.phase === 'running' ||
          proposed.phase === 'failed' ||
          proposed.phase === 'manual-reconciliation-required'
        );
      case 'running':
        return proposed.phase === 'manual-reconciliation-required';
      case 'manual-reconciliation-required':
        return proposed.phase === 'running' || proposed.phase === 'failed';
      case 'failed':
        return false;
    }
  }
  if (proposed.kind === 'initial-launch-marker') {
    return (
      current.kind === 'full' &&
      (current.phase === 'running' || current.phase === 'failed' || current.phase === 'cancelled')
    );
  }
  if (current.kind !== 'full' || proposed.kind !== 'full') return false;
  switch (current.phase) {
    case 'reserved-for-task-commit':
      return proposed.phase === 'admitted' || proposed.phase === 'cancelled';
    case 'admitted':
      return proposed.phase === 'spawning' || proposed.phase === 'cancelled';
    case 'spawning':
      return (
        proposed.phase === 'awaiting-spawn-ack' ||
        proposed.phase === 'running' ||
        proposed.phase === 'failed' ||
        proposed.phase === 'manual-reconciliation-required'
      );
    case 'awaiting-spawn-ack':
      return (
        proposed.phase === 'running' ||
        proposed.phase === 'failed' ||
        proposed.phase === 'manual-reconciliation-required'
      );
    case 'failed':
      return current.failureDisposition === 'same-tuple-retry' && proposed.phase === 'admitted';
    case 'manual-reconciliation-required':
      return proposed.phase === 'running' || proposed.phase === 'failed';
    case 'running':
    case 'cancelled':
      return false;
  }
}

class FileTaskShellSessionJournal implements TaskShellSessionJournal {
  private readonly store: ShardedOperationStore<TaskShellSessionJournalRecord>;
  private readonly recordsByOperationId = new Map<string, TaskShellSessionJournalRecord>();
  private readonly operationIdByTaskId = new Map<string, string>();
  private readonly activeByPrincipal = new Map<string, number>();
  private active = 0;
  private richAndReserved = 0;

  constructor(rootPath: string, options: TaskShellSessionJournalOptions) {
    this.store = createShardedOperationStore({
      codec: {
        decodePayload: decodeTaskShellSessionJournalRecord,
        getCanonicalKey: (record) => record.operationId,
        getChargedBytes: recordCharge,
        getRecordVersion: (record) => record.recordVersion,
      },
      ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
      journalKind: JOURNAL_KIND,
      limits: {
        maxChargedBytes: TASK_SHELL_SESSION_JOURNAL_MAX_CHARGED_BYTES,
        maxIndexBytes: TASK_SHELL_SESSION_JOURNAL_INDEX_MAX_BYTES,
        maxRecordCount: TASK_SHELL_SESSION_JOURNAL_RECORD_LIMIT,
        maxRecordEnvelopeBytes: 16 * 1_024,
      },
      rootPath,
    });
  }

  async activateFresh(): Promise<ShardedOperationStoreStartupResult> {
    const result = await this.store.activateFresh();
    if (result.health === 'healthy') this.rebuildIndexes();
    return result;
  }

  async activateFromLegacy(
    records: readonly TaskShellSessionJournalRecord[],
    legacyDigest: string,
  ): Promise<ShardedOperationStoreStartupResult> {
    const result = await this.store.activateFromLegacy(records, legacyDigest);
    if (result.health === 'healthy') this.rebuildIndexes();
    return result;
  }

  close(): Promise<void> {
    return this.store.close();
  }

  async compact(nowMs: number): Promise<{ deletedTombstones: number; markersWritten: number }> {
    if (!isNonNegativeInteger(nowMs)) throw new Error('Compaction time is invalid');
    let deletedTombstones = 0;
    let markersWritten = 0;
    for (const record of this.list()) {
      if (record.kind === 'deletion-tombstone' && record.expiresAtMs <= nowMs) {
        const result = await this.delete(record.operationId, record.recordVersion);
        if (result.kind === 'deleted') deletedTombstones += 1;
        continue;
      }
      if (
        record.kind === 'full' &&
        (record.phase === 'running' || record.phase === 'failed' || record.phase === 'cancelled') &&
        record.completedAtMs + TASK_SHELL_SESSION_RETENTION_MS <= nowMs
      ) {
        const marker: TaskShellSessionMarkerRecord = {
          capabilityHash: record.capabilityHash,
          committedWorkspaceRevision: record.committedWorkspaceRevision,
          completedAtMs: record.completedAtMs,
          createdAtMs: record.createdAtMs,
          creationOperationId: record.creationOperationId,
          expectedGeneration: record.expectedGeneration,
          formatVersion: TASK_SHELL_SESSION_JOURNAL_FORMAT_VERSION,
          kind: 'initial-launch-marker',
          operationId: record.operationId,
          outcomeClass:
            record.phase === 'running'
              ? 'running-at-ack'
              : record.phase === 'failed'
                ? 'failed'
                : 'cancelled',
          recordVersion: record.recordVersion + 1,
          sessionId: record.sessionId,
          taskId: record.taskId,
          updatedAtMs: nowMs,
          workspacePrincipalHash: record.workspacePrincipalHash,
        };
        const result = await this.save(marker, record.recordVersion);
        if (result.kind === 'committed') markersWritten += 1;
      }
    }
    return { deletedTombstones, markersWritten };
  }

  async delete(
    operationId: string,
    expectedVersion: number,
  ): Promise<ShardedOperationStoreDeleteResult> {
    const current = this.recordsByOperationId.get(operationId);
    const result = await this.store.delete(operationId, expectedVersion);
    if ((result.kind === 'deleted' || result.kind === 'already-absent') && current) {
      this.removeFromIndexes(current);
    }
    return result;
  }

  flushDerivedIndex(): Promise<boolean> {
    return this.store.flushDerivedIndex();
  }

  get(operationId: string): TaskShellSessionJournalRecord | null {
    const record = this.recordsByOperationId.get(operationId);
    return record ? structuredClone(record) : null;
  }

  getByTaskId(taskId: string): TaskShellSessionJournalRecord | null {
    const operationId = this.operationIdByTaskId.get(taskId);
    return operationId ? this.get(operationId) : null;
  }

  getCounts(): TaskShellSessionJournalCounts {
    const counts = this.store.getCounts();
    return {
      active: this.active,
      chargedBytes: counts.chargedBytes,
      lifecycle: counts.records,
      records: counts.records,
      richAndReserved: this.richAndReserved,
    };
  }

  getHealth(): ShardedOperationStoreHealth {
    return this.store.getHealth();
  }

  getTopologyEpoch(): string | null {
    return this.store.getTopologyEpoch();
  }

  list(): TaskShellSessionJournalRecord[] {
    return [...this.recordsByOperationId.values()]
      .sort((left, right) => left.operationId.localeCompare(right.operationId))
      .map((record) => structuredClone(record));
  }

  async repairDurability(): Promise<boolean> {
    const repaired = await this.store.repairDurability();
    if (repaired) this.rebuildIndexes();
    return repaired;
  }

  async save(
    record: TaskShellSessionJournalRecord,
    expectedVersion: number | null,
  ): Promise<ShardedOperationStoreCommitResult> {
    const proposed = decodeTaskShellSessionJournalRecord(record);
    const current = this.recordsByOperationId.get(proposed.operationId) ?? null;
    if (current) {
      if (expectedVersion !== current.recordVersion) {
        throw new Error('Task-shell-session record version conflict');
      }
      if (isSameRecord(current, proposed)) return { kind: 'already-current' };
      if (
        proposed.recordVersion !== current.recordVersion + 1 ||
        !sameImmutableIdentity(current, proposed) ||
        !legalTransition(current, proposed)
      ) {
        throw new Error('Illegal task-shell-session record transition');
      }
      if (
        current.committedWorkspaceRevision !== null &&
        proposed.committedWorkspaceRevision !== current.committedWorkspaceRevision
      ) {
        throw new Error('Task-shell-session committed revision changed');
      }
    } else {
      if (expectedVersion !== null || proposed.recordVersion !== 1) {
        throw new Error('First task-shell-session record must use version 1');
      }
      const existingForTask = this.operationIdByTaskId.get(proposed.taskId);
      if (existingForTask && existingForTask !== proposed.operationId) {
        throw new Error('Task already has an initial shell operation');
      }
    }
    this.assertCapacity(current, proposed);
    const result = await this.store.save(proposed, expectedVersion);
    if (result.kind === 'committed' || result.kind === 'already-current') {
      if (current) this.removeFromIndexes(current);
      this.addToIndexes(proposed);
    }
    return result;
  }

  async startup(): Promise<ShardedOperationStoreStartupResult> {
    const result = await this.store.startup();
    if (result.health === 'healthy') this.rebuildIndexes();
    return result;
  }

  private assertCapacity(
    current: TaskShellSessionJournalRecord | null,
    proposed: TaskShellSessionJournalRecord,
  ): void {
    const nextActive =
      this.active - (current && isActive(current) ? 1 : 0) + (isActive(proposed) ? 1 : 0);
    const nextRich =
      this.richAndReserved -
      (current && holdsRichSlot(current) ? 1 : 0) +
      (holdsRichSlot(proposed) ? 1 : 0);
    if (nextActive > TASK_SHELL_SESSION_JOURNAL_ACTIVE_WORKSPACE_LIMIT) {
      throw new Error('Task-shell-session active workspace capacity exhausted');
    }
    if (nextRich > TASK_SHELL_SESSION_JOURNAL_RICH_LIMIT) {
      throw new Error('Task-shell-session rich receipt capacity exhausted');
    }
    if (isActive(proposed)) {
      const principalCount =
        (this.activeByPrincipal.get(proposed.workspacePrincipalHash) ?? 0) -
        (current && isActive(current) ? 1 : 0) +
        1;
      if (principalCount > TASK_SHELL_SESSION_JOURNAL_ACTIVE_PER_PRINCIPAL_LIMIT) {
        throw new Error('Task-shell-session active principal capacity exhausted');
      }
    }
  }

  private addToIndexes(record: TaskShellSessionJournalRecord): void {
    this.recordsByOperationId.set(record.operationId, structuredClone(record));
    const existing = this.operationIdByTaskId.get(record.taskId);
    if (existing && existing !== record.operationId) {
      throw new Error('Multiple initial shell operations target one task');
    }
    this.operationIdByTaskId.set(record.taskId, record.operationId);
    if (isActive(record)) {
      this.active += 1;
      this.activeByPrincipal.set(
        record.workspacePrincipalHash,
        (this.activeByPrincipal.get(record.workspacePrincipalHash) ?? 0) + 1,
      );
    }
    if (holdsRichSlot(record)) this.richAndReserved += 1;
  }

  private removeFromIndexes(record: TaskShellSessionJournalRecord): void {
    this.recordsByOperationId.delete(record.operationId);
    if (this.operationIdByTaskId.get(record.taskId) === record.operationId) {
      this.operationIdByTaskId.delete(record.taskId);
    }
    if (isActive(record)) {
      this.active -= 1;
      const count = (this.activeByPrincipal.get(record.workspacePrincipalHash) ?? 1) - 1;
      if (count === 0) this.activeByPrincipal.delete(record.workspacePrincipalHash);
      else this.activeByPrincipal.set(record.workspacePrincipalHash, count);
    }
    if (holdsRichSlot(record)) this.richAndReserved -= 1;
  }

  private rebuildIndexes(): void {
    this.recordsByOperationId.clear();
    this.operationIdByTaskId.clear();
    this.activeByPrincipal.clear();
    this.active = 0;
    this.richAndReserved = 0;
    for (const record of this.store.list()) this.addToIndexes(record);
    if (
      this.active > TASK_SHELL_SESSION_JOURNAL_ACTIVE_WORKSPACE_LIMIT ||
      this.richAndReserved > TASK_SHELL_SESSION_JOURNAL_RICH_LIMIT ||
      [...this.activeByPrincipal.values()].some(
        (count) => count > TASK_SHELL_SESSION_JOURNAL_ACTIVE_PER_PRINCIPAL_LIMIT,
      )
    ) {
      throw new Error('Task-shell-session journal exceeds reconstructed capacity');
    }
  }
}

export function createTaskShellSessionJournal(
  env: StorageEnv,
  options: TaskShellSessionJournalOptions = {},
): TaskShellSessionJournal {
  const rootPath =
    options.rootPath ?? `${getStateDirForEnv(env)}/${TASK_SHELL_SESSION_JOURNAL_DIRECTORY_NAME}`;
  return new FileTaskShellSessionJournal(rootPath, options);
}

export function deriveTaskShellSessionRecordDigest(record: TaskShellSessionJournalRecord): string {
  return recordDigest(decodeTaskShellSessionJournalRecord(record));
}
