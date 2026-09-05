import {
  isTaskRemovalCurrentProjection,
  type TaskRemovalCurrentProjection,
} from './task-catalog.js';
import { isRecord } from '../lib/type-guards.js';
import { isWellFormedUnicodeScalarString } from '../lib/unicode-scalar.js';

export const TASK_INITIAL_PROMPT_READINESS_POLICY = 'agent-prompt-v1' as const;
export const TASK_INITIAL_PROMPT_READY_DEADLINE_MS = 45_000;
export const TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS = 5_000;
export const TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS = 250;
export const TASK_INITIAL_PROMPT_STABLE_OBSERVATION_MS = 500;
export const TASK_INITIAL_PROMPT_QUIESCENCE_MS = 1_500;
export const TASK_INITIAL_PROMPT_EVIDENCE_MAX_BYTES = 65_536;
export const TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES = 65_536;
export const TASK_INITIAL_PROMPT_HOOK_SET_VERSION = 'initial-prompt-owner-hooks-v1' as const;
export const MANUAL_INITIAL_PROMPT_SEND_RATE_LIMIT = Object.freeze({
  burst: 3,
  refillIntervalMs: 5_000,
});

export type TaskInitialPromptDeliveryStatus =
  | 'queued'
  | 'waiting-agent-session'
  | 'waiting-ready'
  | 'waiting-lease'
  | 'writing'
  | 'verifying'
  | 'retry-wait'
  | 'delivered'
  | 'manual-required'
  | 'cancelled';

export type TaskInitialPromptDeliveryReason =
  | 'agent-exited'
  | 'lease-taken-over'
  | 'generation-after-write'
  | 'verification-inconclusive'
  | 'retry-not-safe'
  | 'task-closing'
  | 'cancelled-before-write'
  | 'draft-edited-after-write'
  | 'backend-recovered-ambiguous-write';

export interface TaskInitialPromptDeliveryRequest {
  agentId: string;
  deliveryId: string;
  expectedDraftFingerprint: string;
  readinessPolicy: typeof TASK_INITIAL_PROMPT_READINESS_POLICY;
  taskId: string;
}

export function isTaskInitialPromptDeliveryRequest(
  value: unknown,
): value is TaskInitialPromptDeliveryRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'agentId',
      'deliveryId',
      'expectedDraftFingerprint',
      'readinessPolicy',
      'taskId',
    ]) &&
    isBoundedWireString(value.agentId, 512) &&
    isBoundedWireString(value.deliveryId) &&
    isLowercaseSha256Fingerprint(value.expectedDraftFingerprint as string) &&
    value.readinessPolicy === TASK_INITIAL_PROMPT_READINESS_POLICY &&
    isBoundedWireString(value.taskId, 512)
  );
}

export interface TaskInitialPromptDeliverySnapshot {
  agentId: string;
  attempts: 0 | 1 | 2;
  createdAt: string;
  deliveryId: string;
  reason?: TaskInitialPromptDeliveryReason;
  status: TaskInitialPromptDeliveryStatus;
  targetGeneration?: number;
  taskId: string;
  updatedAt: string;
  version: number;
}

export type TaskInitialPromptOwnerAvailability =
  | { kind: 'dark'; reason: 'delivery-owner-dark' }
  | {
      kind: 'active';
      cutoverEpoch: string;
      hookSetVersion: typeof TASK_INITIAL_PROMPT_HOOK_SET_VERSION;
    }
  | {
      kind: 'unavailable';
      reason: 'task-removal-gate-unavailable' | 'journal-unavailable';
    };

export type QueueTaskInitialPromptDeliveryResult =
  | {
      kind: 'accepted';
      replayed: boolean;
      snapshot: TaskInitialPromptDeliverySnapshot;
    }
  | {
      kind: 'admission-unavailable';
      reason: 'delivery-owner-dark' | 'task-removal-gate-unavailable' | 'journal-unavailable';
      replayed: false;
    };

export interface TaskInitialPromptDraftSnapshot {
  editRevision: number;
  fingerprint: string;
  mode: 'automatic' | 'manual-only';
  text: string;
  workspaceRevision: number;
}

export interface ReviseTaskInitialPromptDraftRequest {
  editOperationId: string;
  expectedDraftFingerprint: string;
  expectedEditRevision: number;
  revisedText: string;
  sourceDeliveryId: string;
  taskId: string;
}

export type ReviseTaskInitialPromptDraftResult =
  | {
      current: TaskInitialPromptDraftSnapshot | null;
      kind: 'saved-manual-draft' | 'replayed';
    }
  | {
      current: TaskInitialPromptDraftSnapshot | null;
      kind: 'delivery-closed' | 'draft-changed' | 'draft-conflict' | 'stale-edit' | 'task-missing';
    }
  | {
      kind: 'admission-unavailable';
      reason: 'delivery-owner-dark' | 'task-removal-gate-unavailable' | 'journal-unavailable';
    };

export type ManualInitialPromptSendAction =
  | { kind: 'send' }
  | { failedAttempt: number; kind: 'retry-proven-not-sent' };

export interface SendTaskInitialPromptManuallyRequest {
  action: ManualInitialPromptSendAction;
  agentId: string;
  confirmPossiblePriorAutomaticWrite: boolean;
  deliveryId: string;
  expectedAgentGeneration: number;
  expectedDraftFingerprint: string;
  expectedEditRevision: number;
  manualSendOperationId: string;
  taskId: string;
}

export type ManualInitialPromptSendPhase =
  | 'confirmation-required'
  | 'admitted'
  | 'automation-sealed'
  | 'waiting-lease'
  | 'write-intent-persisted'
  | 'write-accepted'
  | 'completed'
  | 'failed-before-write'
  | 'manual-reconciliation-required'
  | 'reconciled';

export type ManualInitialPromptSendAdmissionError =
  | { code: 'bad-request'; field?: string }
  | { code: 'not-authorized' }
  | { code: 'journal-unavailable' }
  | {
      code: 'task-removal-gate-unavailable';
      state: 'delivery-owner-dark' | 'gate-unavailable';
    }
  | { activeOperationId: string; code: 'manual-send-in-progress' }
  | { ambiguousOperationId: string; code: 'manual-reconciliation-pending' }
  | { code: 'rate-limited'; retryAfterMs: number };

export type ManualInitialPromptSendAdmissionRecovery =
  | { kind: 'correct-request' }
  | { kind: 'reauthorize' }
  | { kind: 'retry-same-request-when-service-ready' }
  | { kind: 'wait-and-retry-same-action'; retryAfterMs: number }
  | { activeOperationId: string; kind: 'adopt-active-operation' }
  | { ambiguousOperationId?: string; kind: 'inspect-terminal-and-copy-draft' }
  | { kind: 'none' };

export type ManualInitialPromptSendIssue =
  | { code: 'confirmation-required'; possiblePriorAutomaticWrite: true }
  | { code: 'task-missing' }
  | { code: 'delivery-closed' }
  | { code: 'draft-changed' }
  | { code: 'edit-revision-changed' }
  | { code: 'operation-superseded' }
  | { code: 'agent-not-running' }
  | { code: 'agent-not-ready' }
  | { code: 'agent-question-active' }
  | { code: 'agent-generation-changed'; currentGeneration?: number }
  | { code: 'supervision-changed-before-admission' }
  | { code: 'task-closing' }
  | { code: 'control-unavailable' }
  | { code: 'backend-restarted-before-write' }
  | { code: 'write-rejected-before-admission' }
  | { code: 'write-outcome-ambiguous' };

export type ManualInitialPromptSendRecovery =
  | { kind: 'confirm-possible-prior-automatic-write'; manualSendOperationId: string }
  | { kind: 'refresh-draft-and-use-derived-operation' }
  | {
      failedAttempt: number;
      kind: 'retry-proven-not-sent';
      manualSendOperationId: string;
    }
  | {
      failedAttempt: number;
      kind: 'take-control-then-retry-proven-not-sent';
      manualSendOperationId: string;
    }
  | { automaticRetryAllowed: false; kind: 'inspect-terminal-and-copy-exact-draft' }
  | { kind: 'none' };

export type ManualInitialPromptSendOutcome =
  | {
      acknowledgedDraftFingerprint: string;
      acknowledgedEditRevision: number;
      agentGeneration: number;
      clear: 'cleared' | 'already-cleared' | 'draft-changed';
      kind: 'sent';
    }
  | { issue: ManualInitialPromptSendIssue; kind: 'not-sent' }
  | {
      issue: Extract<ManualInitialPromptSendIssue, { code: 'write-outcome-ambiguous' }>;
      kind: 'write-outcome-ambiguous';
    }
  | {
      clear?: 'cleared' | 'already-cleared' | 'draft-changed';
      kind: 'reconciled';
      resolution: 'observed-sent' | 'abandon-to-terminal';
    };

export interface ManualInitialPromptSendAttemptReceipt {
  acknowledgedDraftFingerprint: string;
  acknowledgedEditRevision: number;
  agentId: string;
  attempt: number;
  completedAt: string;
  deliveryId: string;
  expectedAgentGeneration: number;
  manualSendOperationId: string;
  outcome: ManualInitialPromptSendOutcome;
  recovery: ManualInitialPromptSendRecovery;
  taskId: string;
  terminal: boolean;
}

export type ManualInitialPromptSendTerminalReceipt = ManualInitialPromptSendAttemptReceipt & {
  terminal: true;
};

export interface ManualInitialPromptSendOperationSnapshot {
  acknowledgedDraftFingerprint: string;
  acknowledgedEditRevision: number;
  agentId: string;
  attempt: number;
  createdAt: string;
  deliveryId: string;
  expectedAgentGeneration: number;
  latestAttemptReceipt?: ManualInitialPromptSendAttemptReceipt;
  manualSendOperationId: string;
  phase: ManualInitialPromptSendPhase;
  possiblePriorAutomaticWrite: boolean;
  taskId: string;
  terminalReceipt?: ManualInitialPromptSendTerminalReceipt;
  updatedAt: string;
  version: number;
}

export interface ManualInitialPromptSendHighWater {
  acknowledgedDraftFingerprint: string;
  disposition: 'proven-not-sent' | 'sent' | 'reconciled';
  highestAcknowledgedEditRevision: number;
  operationId: string;
}

export interface TaskInitialPromptDeliveryProjection {
  current: TaskRemovalCurrentProjection;
  currentDraft: TaskInitialPromptDraftSnapshot | null;
  delivery: TaskInitialPromptDeliverySnapshot;
  manualSendHighWater?: ManualInitialPromptSendHighWater;
  manualSendOperation?: ManualInitialPromptSendOperationSnapshot;
}

export interface TaskInitialPromptDeliveryProjectionWithManualOperation extends TaskInitialPromptDeliveryProjection {
  manualSendOperation: ManualInitialPromptSendOperationSnapshot;
}

export interface GetTaskInitialPromptDeliveryProjectionRequest {
  deliveryId: string;
}

export type SendTaskInitialPromptManuallyResult =
  | {
      current?: TaskRemovalCurrentProjection;
      error: ManualInitialPromptSendAdmissionError;
      kind: 'admission-rejected';
      recovery: ManualInitialPromptSendAdmissionRecovery;
    }
  | {
      current: TaskRemovalCurrentProjection;
      currentDraft: TaskInitialPromptDraftSnapshot | null;
      delivery: TaskInitialPromptDeliverySnapshot;
      issue: ManualInitialPromptSendIssue;
      kind: 'domain-rejected';
      recovery: ManualInitialPromptSendRecovery;
      replayed: boolean;
    }
  | {
      current: TaskRemovalCurrentProjection;
      currentDraft: TaskInitialPromptDraftSnapshot | null;
      delivery: TaskInitialPromptDeliverySnapshot;
      kind: 'operation';
      operation: ManualInitialPromptSendOperationSnapshot;
      recovery: ManualInitialPromptSendRecovery;
      replayed: boolean;
    };

export interface ResolveManualInitialPromptSendAmbiguityRequest {
  expectedOperationVersion: number;
  manualSendOperationId: string;
  resolution: 'observed-sent' | 'abandon-to-terminal';
}

export type ResolveManualInitialPromptSendAmbiguityResult =
  | {
      current?: TaskInitialPromptDeliveryProjection;
      error:
        | 'bad-request'
        | 'not-authorized'
        | 'journal-unavailable'
        | 'task-removal-gate-unavailable'
        | 'operation-not-ambiguous'
        | 'operation-version-changed'
        | 'task-missing';
      kind: 'rejected';
    }
  | {
      kind: 'resolved';
      projection: TaskInitialPromptDeliveryProjectionWithManualOperation;
      replayed: boolean;
    };

export interface FinalizeRemovedTaskInitialPromptStateRequest {
  deletionOperationId: string;
  taskId: string;
}

export type FinalizeRemovedTaskInitialPromptStateResult =
  | { kind: 'complete' | 'already-complete' }
  | { kind: 'retry-required'; reason: 'journal-unavailable' | 'removal-witness-mismatch' };

export interface ManualInitialPromptRateBucket {
  availableTokens: number;
  lastRefillAtMs: number;
}

export type ManualInitialPromptRateAdmission =
  | { bucket: ManualInitialPromptRateBucket; kind: 'admitted' }
  | {
      bucket: ManualInitialPromptRateBucket;
      kind: 'rate-limited';
      retryAfterMs: number;
    };

export type TaskInitialPromptDeliveryEvent =
  | { kind: 'session-available'; targetGeneration: number }
  | { kind: 'ready-stable' }
  | { kind: 'lease-acquired' }
  | { kind: 'write-started' }
  | { kind: 'write-rejected-before-bytes' }
  | { kind: 'write-accepted' }
  | { kind: 'write-outcome-ambiguous' }
  | { kind: 'evidence-delivered' }
  | { kind: 'evidence-absence-proven' }
  | { kind: 'retry-not-safe' }
  | { kind: 'verification-inconclusive' }
  | { kind: 'agent-exited' }
  | { kind: 'lease-taken-over' }
  | { kind: 'generation-changed'; targetGeneration: number }
  | { kind: 'edit-accepted' }
  | { kind: 'automation-sealed'; possiblePriorWrite: boolean }
  | { kind: 'task-closing' }
  | { kind: 'cancel' };

export type TaskInitialPromptDeliveryTransition =
  | { kind: 'ignored'; snapshot: TaskInitialPromptDeliverySnapshot }
  | { kind: 'transitioned'; snapshot: TaskInitialPromptDeliverySnapshot };

const DELIVERY_STATUSES = new Set<TaskInitialPromptDeliveryStatus>([
  'cancelled',
  'delivered',
  'manual-required',
  'queued',
  'retry-wait',
  'verifying',
  'waiting-agent-session',
  'waiting-lease',
  'waiting-ready',
  'writing',
]);
const DELIVERY_REASONS = new Set<TaskInitialPromptDeliveryReason>([
  'agent-exited',
  'backend-recovered-ambiguous-write',
  'cancelled-before-write',
  'draft-edited-after-write',
  'generation-after-write',
  'lease-taken-over',
  'retry-not-safe',
  'task-closing',
  'verification-inconclusive',
]);
const MANUAL_SEND_PHASES = new Set<ManualInitialPromptSendPhase>([
  'admitted',
  'automation-sealed',
  'completed',
  'confirmation-required',
  'failed-before-write',
  'manual-reconciliation-required',
  'reconciled',
  'waiting-lease',
  'write-accepted',
  'write-intent-persisted',
]);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedWireString(value: unknown, maxLength = 1_024): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\p{Cc}]/u.test(value) &&
    isWellFormedUnicodeScalarString(value)
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\p{Cc}]/u.test(value)
  );
}

function isTaskInitialPromptDraftSnapshot(value: unknown): value is TaskInitialPromptDraftSnapshot {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['editRevision', 'fingerprint', 'mode', 'text', 'workspaceRevision']) &&
    isNonNegativeSafeInteger(value.editRevision) &&
    isLowercaseSha256Fingerprint(value.fingerprint as string) &&
    (value.mode === 'automatic' || value.mode === 'manual-only') &&
    typeof value.text === 'string' &&
    isWellFormedUnicodeScalarString(value.text) &&
    isTaskInitialPromptDraftWithinLimit(value.text) &&
    isNonNegativeSafeInteger(value.workspaceRevision)
  );
}

export function isTaskInitialPromptDeliverySnapshot(
  value: unknown,
): value is TaskInitialPromptDeliverySnapshot {
  if (!isRecord(value)) return false;
  const reason = value.reason;
  const targetGeneration = value.targetGeneration;
  return (
    hasExactKeys(value, [
      'agentId',
      'attempts',
      'createdAt',
      'deliveryId',
      ...(reason === undefined ? [] : ['reason']),
      'status',
      ...(targetGeneration === undefined ? [] : ['targetGeneration']),
      'taskId',
      'updatedAt',
      'version',
    ]) &&
    isBoundedWireString(value.agentId, 512) &&
    (value.attempts === 0 || value.attempts === 1 || value.attempts === 2) &&
    isTimestamp(value.createdAt) &&
    isBoundedWireString(value.deliveryId) &&
    (reason === undefined ||
      (typeof reason === 'string' &&
        DELIVERY_REASONS.has(reason as TaskInitialPromptDeliveryReason))) &&
    typeof value.status === 'string' &&
    DELIVERY_STATUSES.has(value.status as TaskInitialPromptDeliveryStatus) &&
    (targetGeneration === undefined || isNonNegativeSafeInteger(targetGeneration)) &&
    isBoundedWireString(value.taskId, 512) &&
    isTimestamp(value.updatedAt) &&
    isNonNegativeSafeInteger(value.version) &&
    value.version > 0
  );
}

function isManualInitialPromptSendIssue(value: unknown): value is ManualInitialPromptSendIssue {
  if (!isRecord(value) || typeof value.code !== 'string') return false;
  switch (value.code) {
    case 'confirmation-required':
      return (
        hasExactKeys(value, ['code', 'possiblePriorAutomaticWrite']) &&
        value.possiblePriorAutomaticWrite === true
      );
    case 'agent-generation-changed':
      return (
        hasExactKeys(value, [
          'code',
          ...(value.currentGeneration === undefined ? [] : ['currentGeneration']),
        ]) &&
        (value.currentGeneration === undefined || isNonNegativeSafeInteger(value.currentGeneration))
      );
    case 'agent-not-ready':
    case 'agent-not-running':
    case 'agent-question-active':
    case 'backend-restarted-before-write':
    case 'control-unavailable':
    case 'delivery-closed':
    case 'draft-changed':
    case 'edit-revision-changed':
    case 'operation-superseded':
    case 'supervision-changed-before-admission':
    case 'task-closing':
    case 'task-missing':
    case 'write-outcome-ambiguous':
    case 'write-rejected-before-admission':
      return hasExactKeys(value, ['code']);
    default:
      return false;
  }
}

function isManualInitialPromptSendRecovery(
  value: unknown,
): value is ManualInitialPromptSendRecovery {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'confirm-possible-prior-automatic-write':
      return (
        hasExactKeys(value, ['kind', 'manualSendOperationId']) &&
        isBoundedWireString(value.manualSendOperationId)
      );
    case 'retry-proven-not-sent':
    case 'take-control-then-retry-proven-not-sent':
      return (
        hasExactKeys(value, ['failedAttempt', 'kind', 'manualSendOperationId']) &&
        isNonNegativeSafeInteger(value.failedAttempt) &&
        value.failedAttempt > 0 &&
        isBoundedWireString(value.manualSendOperationId)
      );
    case 'inspect-terminal-and-copy-exact-draft':
      return (
        hasExactKeys(value, ['automaticRetryAllowed', 'kind']) &&
        value.automaticRetryAllowed === false
      );
    case 'none':
    case 'refresh-draft-and-use-derived-operation':
      return hasExactKeys(value, ['kind']);
    default:
      return false;
  }
}

function isManualInitialPromptSendOutcome(value: unknown): value is ManualInitialPromptSendOutcome {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'sent':
      return (
        hasExactKeys(value, [
          'acknowledgedDraftFingerprint',
          'acknowledgedEditRevision',
          'agentGeneration',
          'clear',
          'kind',
        ]) &&
        isLowercaseSha256Fingerprint(value.acknowledgedDraftFingerprint as string) &&
        isNonNegativeSafeInteger(value.acknowledgedEditRevision) &&
        isNonNegativeSafeInteger(value.agentGeneration) &&
        (value.clear === 'cleared' ||
          value.clear === 'already-cleared' ||
          value.clear === 'draft-changed')
      );
    case 'not-sent':
      return hasExactKeys(value, ['issue', 'kind']) && isManualInitialPromptSendIssue(value.issue);
    case 'write-outcome-ambiguous':
      return (
        hasExactKeys(value, ['issue', 'kind']) &&
        isManualInitialPromptSendIssue(value.issue) &&
        value.issue.code === 'write-outcome-ambiguous'
      );
    case 'reconciled':
      return (
        hasExactKeys(value, [
          'kind',
          'resolution',
          ...(value.clear === undefined ? [] : ['clear']),
        ]) &&
        (value.resolution === 'observed-sent' || value.resolution === 'abandon-to-terminal') &&
        (value.clear === undefined ||
          value.clear === 'cleared' ||
          value.clear === 'already-cleared' ||
          value.clear === 'draft-changed')
      );
    default:
      return false;
  }
}

function isManualInitialPromptSendAttemptReceipt(
  value: unknown,
): value is ManualInitialPromptSendAttemptReceipt {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'acknowledgedDraftFingerprint',
      'acknowledgedEditRevision',
      'agentId',
      'attempt',
      'completedAt',
      'deliveryId',
      'expectedAgentGeneration',
      'manualSendOperationId',
      'outcome',
      'recovery',
      'taskId',
      'terminal',
    ]) &&
    isLowercaseSha256Fingerprint(value.acknowledgedDraftFingerprint as string) &&
    isNonNegativeSafeInteger(value.acknowledgedEditRevision) &&
    isBoundedWireString(value.agentId, 512) &&
    isNonNegativeSafeInteger(value.attempt) &&
    value.attempt > 0 &&
    isTimestamp(value.completedAt) &&
    isBoundedWireString(value.deliveryId) &&
    isNonNegativeSafeInteger(value.expectedAgentGeneration) &&
    isBoundedWireString(value.manualSendOperationId) &&
    isManualInitialPromptSendOutcome(value.outcome) &&
    isManualInitialPromptSendRecovery(value.recovery) &&
    isBoundedWireString(value.taskId, 512) &&
    typeof value.terminal === 'boolean'
  );
}

function isManualInitialPromptSendOperationSnapshot(
  value: unknown,
): value is ManualInitialPromptSendOperationSnapshot {
  if (!isRecord(value)) return false;
  const latestAttemptReceipt = value.latestAttemptReceipt;
  const terminalReceipt = value.terminalReceipt;
  return (
    hasExactKeys(value, [
      'acknowledgedDraftFingerprint',
      'acknowledgedEditRevision',
      'agentId',
      'attempt',
      'createdAt',
      'deliveryId',
      'expectedAgentGeneration',
      ...(latestAttemptReceipt === undefined ? [] : ['latestAttemptReceipt']),
      'manualSendOperationId',
      'phase',
      'possiblePriorAutomaticWrite',
      'taskId',
      ...(terminalReceipt === undefined ? [] : ['terminalReceipt']),
      'updatedAt',
      'version',
    ]) &&
    isLowercaseSha256Fingerprint(value.acknowledgedDraftFingerprint as string) &&
    isNonNegativeSafeInteger(value.acknowledgedEditRevision) &&
    isBoundedWireString(value.agentId, 512) &&
    isNonNegativeSafeInteger(value.attempt) &&
    value.attempt > 0 &&
    isTimestamp(value.createdAt) &&
    isBoundedWireString(value.deliveryId) &&
    isNonNegativeSafeInteger(value.expectedAgentGeneration) &&
    (latestAttemptReceipt === undefined ||
      isManualInitialPromptSendAttemptReceipt(latestAttemptReceipt)) &&
    isBoundedWireString(value.manualSendOperationId) &&
    typeof value.phase === 'string' &&
    MANUAL_SEND_PHASES.has(value.phase as ManualInitialPromptSendPhase) &&
    typeof value.possiblePriorAutomaticWrite === 'boolean' &&
    isBoundedWireString(value.taskId, 512) &&
    (terminalReceipt === undefined ||
      (isManualInitialPromptSendAttemptReceipt(terminalReceipt) &&
        terminalReceipt.terminal === true)) &&
    isTimestamp(value.updatedAt) &&
    isNonNegativeSafeInteger(value.version) &&
    value.version > 0
  );
}

function isManualInitialPromptSendHighWater(
  value: unknown,
): value is ManualInitialPromptSendHighWater {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'acknowledgedDraftFingerprint',
      'disposition',
      'highestAcknowledgedEditRevision',
      'operationId',
    ]) &&
    isLowercaseSha256Fingerprint(value.acknowledgedDraftFingerprint as string) &&
    (value.disposition === 'proven-not-sent' ||
      value.disposition === 'sent' ||
      value.disposition === 'reconciled') &&
    isNonNegativeSafeInteger(value.highestAcknowledgedEditRevision) &&
    isBoundedWireString(value.operationId)
  );
}

function isDraftConsistentWithDelivery(
  draft: TaskInitialPromptDraftSnapshot | null,
  delivery: TaskInitialPromptDeliverySnapshot,
): boolean {
  return (
    draft === null ||
    draft.fingerprint ===
      deriveTaskInitialPromptDraftFingerprint({
        agentId: delivery.agentId,
        readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
        taskId: delivery.taskId,
        text: draft.text,
      })
  );
}

function recoveryMatchesManualOperation(
  recovery: ManualInitialPromptSendRecovery,
  operationId: string,
): boolean {
  switch (recovery.kind) {
    case 'confirm-possible-prior-automatic-write':
    case 'retry-proven-not-sent':
    case 'take-control-then-retry-proven-not-sent':
      return recovery.manualSendOperationId === operationId;
    default:
      return true;
  }
}

function receiptMatchesManualOperation(
  receipt: ManualInitialPromptSendAttemptReceipt,
  operation: ManualInitialPromptSendOperationSnapshot,
): boolean {
  return (
    receipt.manualSendOperationId === operation.manualSendOperationId &&
    receipt.taskId === operation.taskId &&
    receipt.deliveryId === operation.deliveryId &&
    receipt.agentId === operation.agentId &&
    receipt.acknowledgedDraftFingerprint === operation.acknowledgedDraftFingerprint &&
    receipt.acknowledgedEditRevision === operation.acknowledgedEditRevision &&
    receipt.expectedAgentGeneration === operation.expectedAgentGeneration &&
    receipt.attempt <= operation.attempt &&
    recoveryMatchesManualOperation(receipt.recovery, operation.manualSendOperationId) &&
    (receipt.outcome.kind !== 'sent' ||
      (receipt.outcome.acknowledgedDraftFingerprint === receipt.acknowledgedDraftFingerprint &&
        receipt.outcome.acknowledgedEditRevision === receipt.acknowledgedEditRevision &&
        receipt.outcome.agentGeneration === receipt.expectedAgentGeneration))
  );
}

function manualOperationMatchesDelivery(
  operation: ManualInitialPromptSendOperationSnapshot,
  delivery: TaskInitialPromptDeliverySnapshot,
): boolean {
  return (
    operation.taskId === delivery.taskId &&
    operation.deliveryId === delivery.deliveryId &&
    operation.agentId === delivery.agentId &&
    operation.manualSendOperationId ===
      deriveManualInitialPromptSendOperationId({
        acknowledgedDraftFingerprint: operation.acknowledgedDraftFingerprint,
        acknowledgedEditRevision: operation.acknowledgedEditRevision,
        deliveryId: operation.deliveryId,
      }) &&
    (operation.latestAttemptReceipt === undefined ||
      receiptMatchesManualOperation(operation.latestAttemptReceipt, operation)) &&
    (operation.terminalReceipt === undefined ||
      receiptMatchesManualOperation(operation.terminalReceipt, operation))
  );
}

function highWaterMatchesDelivery(
  highWater: ManualInitialPromptSendHighWater,
  delivery: TaskInitialPromptDeliverySnapshot,
): boolean {
  return (
    highWater.operationId ===
    deriveManualInitialPromptSendOperationId({
      acknowledgedDraftFingerprint: highWater.acknowledgedDraftFingerprint,
      acknowledgedEditRevision: highWater.highestAcknowledgedEditRevision,
      deliveryId: delivery.deliveryId,
    })
  );
}

export function isManualInitialPromptSendOperationForDelivery(
  value: unknown,
  delivery: TaskInitialPromptDeliverySnapshot,
): value is ManualInitialPromptSendOperationSnapshot {
  return (
    isManualInitialPromptSendOperationSnapshot(value) &&
    manualOperationMatchesDelivery(value, delivery)
  );
}

export function isManualInitialPromptSendHighWaterForDelivery(
  value: unknown,
  delivery: TaskInitialPromptDeliverySnapshot,
): value is ManualInitialPromptSendHighWater {
  return isManualInitialPromptSendHighWater(value) && highWaterMatchesDelivery(value, delivery);
}

export function isTaskInitialPromptDeliveryProjection(
  value: unknown,
): value is TaskInitialPromptDeliveryProjection {
  if (!isRecord(value)) return false;
  const manualSendHighWater = value.manualSendHighWater;
  const manualSendOperation = value.manualSendOperation;
  if (
    !(
      hasExactKeys(value, [
        'current',
        'currentDraft',
        'delivery',
        ...(manualSendHighWater === undefined ? [] : ['manualSendHighWater']),
        ...(manualSendOperation === undefined ? [] : ['manualSendOperation']),
      ]) &&
      isTaskRemovalCurrentProjection(value.current) &&
      (value.currentDraft === null || isTaskInitialPromptDraftSnapshot(value.currentDraft)) &&
      isTaskInitialPromptDeliverySnapshot(value.delivery) &&
      (manualSendHighWater === undefined ||
        isManualInitialPromptSendHighWater(manualSendHighWater)) &&
      (manualSendOperation === undefined ||
        isManualInitialPromptSendOperationSnapshot(manualSendOperation))
    )
  ) {
    return false;
  }
  return (
    isDraftConsistentWithDelivery(value.currentDraft, value.delivery) &&
    (manualSendOperation === undefined ||
      manualOperationMatchesDelivery(manualSendOperation, value.delivery)) &&
    (manualSendHighWater === undefined ||
      highWaterMatchesDelivery(manualSendHighWater, value.delivery))
  );
}

export function isGetTaskInitialPromptDeliveryProjectionRequest(
  value: unknown,
): value is GetTaskInitialPromptDeliveryProjectionRequest {
  return (
    isRecord(value) && hasExactKeys(value, ['deliveryId']) && isBoundedWireString(value.deliveryId)
  );
}

export function isReviseTaskInitialPromptDraftRequest(
  value: unknown,
): value is ReviseTaskInitialPromptDraftRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'editOperationId',
      'expectedDraftFingerprint',
      'expectedEditRevision',
      'revisedText',
      'sourceDeliveryId',
      'taskId',
    ]) &&
    isBoundedWireString(value.editOperationId) &&
    isLowercaseSha256Fingerprint(value.expectedDraftFingerprint as string) &&
    isNonNegativeSafeInteger(value.expectedEditRevision) &&
    typeof value.revisedText === 'string' &&
    isWellFormedUnicodeScalarString(value.revisedText) &&
    isTaskInitialPromptDraftWithinLimit(value.revisedText) &&
    isBoundedWireString(value.sourceDeliveryId) &&
    isBoundedWireString(value.taskId, 512)
  );
}

export function isReviseTaskInitialPromptDraftResult(
  value: unknown,
): value is ReviseTaskInitialPromptDraftResult {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'admission-unavailable') {
    return (
      hasExactKeys(value, ['kind', 'reason']) &&
      (value.reason === 'delivery-owner-dark' ||
        value.reason === 'journal-unavailable' ||
        value.reason === 'task-removal-gate-unavailable')
    );
  }
  return (
    hasExactKeys(value, ['current', 'kind']) &&
    (value.current === null || isTaskInitialPromptDraftSnapshot(value.current)) &&
    (value.kind === 'saved-manual-draft' ||
      value.kind === 'replayed' ||
      value.kind === 'delivery-closed' ||
      value.kind === 'draft-changed' ||
      value.kind === 'draft-conflict' ||
      value.kind === 'stale-edit' ||
      value.kind === 'task-missing')
  );
}

export function isSendTaskInitialPromptManuallyRequest(
  value: unknown,
): value is SendTaskInitialPromptManuallyRequest {
  if (!isRecord(value)) return false;
  const action = value.action;
  return (
    hasExactKeys(value, [
      'action',
      'agentId',
      'confirmPossiblePriorAutomaticWrite',
      'deliveryId',
      'expectedAgentGeneration',
      'expectedDraftFingerprint',
      'expectedEditRevision',
      'manualSendOperationId',
      'taskId',
    ]) &&
    isRecord(action) &&
    ((hasExactKeys(action, ['kind']) && action.kind === 'send') ||
      (hasExactKeys(action, ['failedAttempt', 'kind']) &&
        action.kind === 'retry-proven-not-sent' &&
        isNonNegativeSafeInteger(action.failedAttempt) &&
        action.failedAttempt > 0)) &&
    isBoundedWireString(value.agentId, 512) &&
    typeof value.confirmPossiblePriorAutomaticWrite === 'boolean' &&
    isBoundedWireString(value.deliveryId) &&
    isNonNegativeSafeInteger(value.expectedAgentGeneration) &&
    isLowercaseSha256Fingerprint(value.expectedDraftFingerprint as string) &&
    isNonNegativeSafeInteger(value.expectedEditRevision) &&
    isBoundedWireString(value.manualSendOperationId) &&
    value.manualSendOperationId ===
      deriveManualInitialPromptSendOperationId({
        acknowledgedDraftFingerprint: value.expectedDraftFingerprint as string,
        acknowledgedEditRevision: value.expectedEditRevision,
        deliveryId: value.deliveryId,
      }) &&
    isBoundedWireString(value.taskId, 512)
  );
}

function isManualInitialPromptSendAdmissionError(
  value: unknown,
): value is ManualInitialPromptSendAdmissionError {
  if (!isRecord(value) || typeof value.code !== 'string') return false;
  switch (value.code) {
    case 'bad-request':
      return (
        hasExactKeys(value, ['code', ...(value.field === undefined ? [] : ['field'])]) &&
        (value.field === undefined || isBoundedWireString(value.field, 128))
      );
    case 'manual-send-in-progress':
      return (
        hasExactKeys(value, ['activeOperationId', 'code']) &&
        isBoundedWireString(value.activeOperationId)
      );
    case 'manual-reconciliation-pending':
      return (
        hasExactKeys(value, ['ambiguousOperationId', 'code']) &&
        isBoundedWireString(value.ambiguousOperationId)
      );
    case 'rate-limited':
      return (
        hasExactKeys(value, ['code', 'retryAfterMs']) &&
        isNonNegativeSafeInteger(value.retryAfterMs)
      );
    case 'task-removal-gate-unavailable':
      return (
        hasExactKeys(value, ['code', 'state']) &&
        (value.state === 'delivery-owner-dark' || value.state === 'gate-unavailable')
      );
    case 'journal-unavailable':
    case 'not-authorized':
      return hasExactKeys(value, ['code']);
    default:
      return false;
  }
}

function isManualInitialPromptSendAdmissionRecovery(
  value: unknown,
): value is ManualInitialPromptSendAdmissionRecovery {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'adopt-active-operation':
      return (
        hasExactKeys(value, ['activeOperationId', 'kind']) &&
        isBoundedWireString(value.activeOperationId)
      );
    case 'inspect-terminal-and-copy-draft':
      return (
        hasExactKeys(value, [
          ...(value.ambiguousOperationId === undefined ? [] : ['ambiguousOperationId']),
          'kind',
        ]) &&
        (value.ambiguousOperationId === undefined ||
          isBoundedWireString(value.ambiguousOperationId))
      );
    case 'wait-and-retry-same-action':
      return (
        hasExactKeys(value, ['kind', 'retryAfterMs']) &&
        isNonNegativeSafeInteger(value.retryAfterMs)
      );
    case 'correct-request':
    case 'none':
    case 'reauthorize':
    case 'retry-same-request-when-service-ready':
      return hasExactKeys(value, ['kind']);
    default:
      return false;
  }
}

export function isSendTaskInitialPromptManuallyResult(
  value: unknown,
): value is SendTaskInitialPromptManuallyResult {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'admission-rejected') {
    return (
      hasExactKeys(value, [
        ...(value.current === undefined ? [] : ['current']),
        'error',
        'kind',
        'recovery',
      ]) &&
      (value.current === undefined || isTaskRemovalCurrentProjection(value.current)) &&
      isManualInitialPromptSendAdmissionError(value.error) &&
      isManualInitialPromptSendAdmissionRecovery(value.recovery)
    );
  }
  const shared =
    isTaskRemovalCurrentProjection(value.current) &&
    (value.currentDraft === null || isTaskInitialPromptDraftSnapshot(value.currentDraft)) &&
    isTaskInitialPromptDeliverySnapshot(value.delivery) &&
    typeof value.replayed === 'boolean' &&
    isManualInitialPromptSendRecovery(value.recovery);
  if (!shared) return false;
  const delivery = value.delivery as TaskInitialPromptDeliverySnapshot;
  const currentDraft = value.currentDraft as TaskInitialPromptDraftSnapshot | null;
  const recovery = value.recovery as ManualInitialPromptSendRecovery;
  if (!isDraftConsistentWithDelivery(currentDraft, delivery)) return false;
  if (value.kind === 'domain-rejected') {
    return (
      hasExactKeys(value, [
        'current',
        'currentDraft',
        'delivery',
        'issue',
        'kind',
        'recovery',
        'replayed',
      ]) && isManualInitialPromptSendIssue(value.issue)
    );
  }
  return (
    value.kind === 'operation' &&
    hasExactKeys(value, [
      'current',
      'currentDraft',
      'delivery',
      'kind',
      'operation',
      'recovery',
      'replayed',
    ]) &&
    isManualInitialPromptSendOperationSnapshot(value.operation) &&
    manualOperationMatchesDelivery(value.operation, delivery) &&
    recoveryMatchesManualOperation(recovery, value.operation.manualSendOperationId)
  );
}

export function isResolveManualInitialPromptSendAmbiguityRequest(
  value: unknown,
): value is ResolveManualInitialPromptSendAmbiguityRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['expectedOperationVersion', 'manualSendOperationId', 'resolution']) &&
    isNonNegativeSafeInteger(value.expectedOperationVersion) &&
    value.expectedOperationVersion > 0 &&
    isBoundedWireString(value.manualSendOperationId) &&
    (value.resolution === 'observed-sent' || value.resolution === 'abandon-to-terminal')
  );
}

export function isResolveManualInitialPromptSendAmbiguityResult(
  value: unknown,
): value is ResolveManualInitialPromptSendAmbiguityResult {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'resolved') {
    return (
      hasExactKeys(value, ['kind', 'projection', 'replayed']) &&
      isTaskInitialPromptDeliveryProjection(value.projection) &&
      value.projection.manualSendOperation !== undefined &&
      typeof value.replayed === 'boolean'
    );
  }
  return (
    value.kind === 'rejected' &&
    hasExactKeys(
      value,
      ['current', 'error', 'kind'].filter(
        (key) => key !== 'current' || value.current !== undefined,
      ),
    ) &&
    (value.current === undefined || isTaskInitialPromptDeliveryProjection(value.current)) &&
    (value.error === 'bad-request' ||
      value.error === 'not-authorized' ||
      value.error === 'journal-unavailable' ||
      value.error === 'task-removal-gate-unavailable' ||
      value.error === 'operation-not-ambiguous' ||
      value.error === 'operation-version-changed' ||
      value.error === 'task-missing')
  );
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Bytes(value: string): Uint8Array {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = BigInt(input.length) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn), false);
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn), false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15] ?? 0;
      const word2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let a = hash[0] ?? 0;
    let b = hash[1] ?? 0;
    let c = hash[2] ?? 0;
    let d = hash[3] ?? 0;
    let e = hash[4] ?? 0;
    let f = hash[5] ?? 0;
    let g = hash[6] ?? 0;
    let h = hash[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + sum1 + choice + (SHA256_ROUND_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0;
    hash[1] = ((hash[1] ?? 0) + b) >>> 0;
    hash[2] = ((hash[2] ?? 0) + c) >>> 0;
    hash[3] = ((hash[3] ?? 0) + d) >>> 0;
    hash[4] = ((hash[4] ?? 0) + e) >>> 0;
    hash[5] = ((hash[5] ?? 0) + f) >>> 0;
    hash[6] = ((hash[6] ?? 0) + g) >>> 0;
    hash[7] = ((hash[7] ?? 0) + h) >>> 0;
  }

  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  for (let index = 0; index < hash.length; index += 1) {
    outputView.setUint32(index * 4, hash[index] ?? 0, false);
  }
  return output;
}

function bytesToHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >>> 2];
    output += alphabet[((first & 0x03) << 4) | ((second ?? 0) >>> 4)];
    if (second !== undefined) {
      output += alphabet[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)];
    }
    if (third !== undefined) output += alphabet[third & 0x3f];
  }
  return output;
}

export function sha256Hex(value: string): string {
  return bytesToHex(sha256Bytes(value));
}

export function isLowercaseSha256Fingerprint(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

export function deriveTaskInitialPromptDraftFingerprint(args: {
  agentId: string;
  readinessPolicy: typeof TASK_INITIAL_PROMPT_READINESS_POLICY;
  taskId: string;
  text: string;
}): string {
  requireNonEmpty(args.agentId, 'agentId');
  requireNonEmpty(args.taskId, 'taskId');
  return sha256Hex(
    `initial-prompt-draft-v1\0${args.taskId}\0${args.agentId}\0${args.readinessPolicy}\0${args.text}`,
  );
}

export function deriveLegacyTaskInitialPromptDeliveryId(args: {
  agentId: string;
  readinessPolicy: typeof TASK_INITIAL_PROMPT_READINESS_POLICY;
  taskId: string;
  text: string;
}): string {
  return `legacy:${args.taskId}:${args.agentId}:${deriveTaskInitialPromptDraftFingerprint(args)}`;
}

export function deriveManualInitialPromptSendOperationId(args: {
  acknowledgedDraftFingerprint: string;
  acknowledgedEditRevision: number;
  deliveryId: string;
}): string {
  requireNonEmpty(args.deliveryId, 'deliveryId');
  if (!Number.isSafeInteger(args.acknowledgedEditRevision) || args.acknowledgedEditRevision < 0) {
    throw new Error('acknowledgedEditRevision must be a non-negative safe integer');
  }
  if (!isLowercaseSha256Fingerprint(args.acknowledgedDraftFingerprint)) {
    throw new Error('acknowledgedDraftFingerprint must be a lowercase SHA-256 fingerprint');
  }
  const digest = sha256Bytes(
    `initial-prompt-manual-v1\0${args.deliveryId}\0${args.acknowledgedEditRevision}\0${args.acknowledgedDraftFingerprint}`,
  );
  return `manual:v1:${bytesToBase64Url(digest)}`;
}

export function isTaskInitialPromptDraftWithinLimit(text: string): boolean {
  return new TextEncoder().encode(text).length <= TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES;
}

export function consumeManualInitialPromptRateToken(
  bucket: ManualInitialPromptRateBucket,
  nowMs: number,
): ManualInitialPromptRateAdmission {
  if (!Number.isFinite(nowMs) || nowMs < bucket.lastRefillAtMs) {
    throw new Error('Manual prompt rate clock must be finite and monotonic');
  }
  const elapsed = nowMs - bucket.lastRefillAtMs;
  const refillCount = Math.floor(elapsed / MANUAL_INITIAL_PROMPT_SEND_RATE_LIMIT.refillIntervalMs);
  const availableTokens = Math.min(
    MANUAL_INITIAL_PROMPT_SEND_RATE_LIMIT.burst,
    bucket.availableTokens + refillCount,
  );
  const lastRefillAtMs =
    refillCount > 0
      ? bucket.lastRefillAtMs + refillCount * MANUAL_INITIAL_PROMPT_SEND_RATE_LIMIT.refillIntervalMs
      : bucket.lastRefillAtMs;
  if (availableTokens < 1) {
    return {
      bucket: { availableTokens, lastRefillAtMs },
      kind: 'rate-limited',
      retryAfterMs:
        MANUAL_INITIAL_PROMPT_SEND_RATE_LIMIT.refillIntervalMs - (nowMs - lastRefillAtMs),
    };
  }
  return {
    bucket: { availableTokens: availableTokens - 1, lastRefillAtMs },
    kind: 'admitted',
  };
}

export function createManualInitialPromptRateBucket(nowMs: number): ManualInitialPromptRateBucket {
  if (!Number.isFinite(nowMs)) throw new Error('Manual prompt rate clock must be finite');
  return {
    availableTokens: MANUAL_INITIAL_PROMPT_SEND_RATE_LIMIT.burst,
    lastRefillAtMs: nowMs,
  };
}

function transitionSnapshot(
  snapshot: TaskInitialPromptDeliverySnapshot,
  now: string,
  changes: Partial<TaskInitialPromptDeliverySnapshot>,
  clearReason = false,
): TaskInitialPromptDeliveryTransition {
  const next: TaskInitialPromptDeliverySnapshot = {
    ...snapshot,
    ...changes,
    updatedAt: now,
    version: snapshot.version + 1,
  };
  if (clearReason) Reflect.deleteProperty(next, 'reason');
  return {
    kind: 'transitioned',
    snapshot: next,
  };
}

function hasPossibleAutomaticWrite(snapshot: TaskInitialPromptDeliverySnapshot): boolean {
  return snapshot.attempts > 0 || snapshot.status === 'writing' || snapshot.status === 'verifying';
}

export function reduceTaskInitialPromptDelivery(
  snapshot: TaskInitialPromptDeliverySnapshot,
  event: TaskInitialPromptDeliveryEvent,
  now: string,
): TaskInitialPromptDeliveryTransition {
  const ignore = (): TaskInitialPromptDeliveryTransition => ({ kind: 'ignored', snapshot });
  const terminal =
    snapshot.status === 'delivered' ||
    snapshot.status === 'manual-required' ||
    snapshot.status === 'cancelled';

  switch (event.kind) {
    case 'session-available':
      return snapshot.status === 'queued' || snapshot.status === 'waiting-agent-session'
        ? transitionSnapshot(snapshot, now, {
            status: 'waiting-ready',
            targetGeneration: event.targetGeneration,
          })
        : ignore();
    case 'ready-stable':
      return snapshot.status === 'waiting-ready'
        ? transitionSnapshot(snapshot, now, { status: 'waiting-lease' })
        : ignore();
    case 'lease-acquired':
      return snapshot.status === 'waiting-lease'
        ? transitionSnapshot(snapshot, now, { status: 'writing' })
        : ignore();
    case 'write-started':
      return snapshot.status === 'waiting-lease' || snapshot.status === 'retry-wait'
        ? transitionSnapshot(snapshot, now, { status: 'writing' })
        : ignore();
    case 'write-rejected-before-bytes':
      return snapshot.status === 'writing'
        ? transitionSnapshot(snapshot, now, { status: 'waiting-ready' })
        : ignore();
    case 'write-accepted':
      return snapshot.status === 'writing' && snapshot.attempts < 2
        ? transitionSnapshot(snapshot, now, {
            attempts: (snapshot.attempts + 1) as 1 | 2,
            status: 'verifying',
          })
        : ignore();
    case 'write-outcome-ambiguous':
      return terminal
        ? ignore()
        : transitionSnapshot(snapshot, now, {
            reason: 'backend-recovered-ambiguous-write',
            status: 'manual-required',
          });
    case 'evidence-delivered':
      return snapshot.status === 'verifying'
        ? transitionSnapshot(snapshot, now, { status: 'delivered' }, true)
        : ignore();
    case 'evidence-absence-proven':
      if (snapshot.status !== 'verifying') return ignore();
      return snapshot.attempts === 1
        ? transitionSnapshot(snapshot, now, { status: 'retry-wait' })
        : transitionSnapshot(snapshot, now, {
            reason: 'retry-not-safe',
            status: 'manual-required',
          });
    case 'retry-not-safe':
      return snapshot.status === 'retry-wait'
        ? transitionSnapshot(snapshot, now, {
            reason: 'retry-not-safe',
            status: 'manual-required',
          })
        : ignore();
    case 'verification-inconclusive':
      return snapshot.status === 'waiting-ready' ||
        snapshot.status === 'waiting-lease' ||
        snapshot.status === 'verifying'
        ? transitionSnapshot(snapshot, now, {
            reason: 'verification-inconclusive',
            status: 'manual-required',
          })
        : ignore();
    case 'agent-exited':
      return terminal
        ? ignore()
        : transitionSnapshot(snapshot, now, {
            reason: 'agent-exited',
            status: 'manual-required',
          });
    case 'lease-taken-over':
      return terminal
        ? ignore()
        : transitionSnapshot(snapshot, now, {
            reason: 'lease-taken-over',
            status: 'manual-required',
          });
    case 'generation-changed':
      if (terminal) return ignore();
      return hasPossibleAutomaticWrite(snapshot)
        ? transitionSnapshot(snapshot, now, {
            reason: 'generation-after-write',
            status: 'manual-required',
          })
        : transitionSnapshot(snapshot, now, {
            status: 'waiting-ready',
            targetGeneration: event.targetGeneration,
          });
    case 'edit-accepted':
      if (snapshot.status === 'delivered' || snapshot.status === 'cancelled') return ignore();
      return hasPossibleAutomaticWrite(snapshot)
        ? transitionSnapshot(snapshot, now, {
            reason: 'draft-edited-after-write',
            status: 'manual-required',
          })
        : transitionSnapshot(snapshot, now, {
            reason: 'cancelled-before-write',
            status: 'cancelled',
          });
    case 'automation-sealed':
      if (terminal) return ignore();
      return event.possiblePriorWrite || hasPossibleAutomaticWrite(snapshot)
        ? transitionSnapshot(snapshot, now, {
            reason: 'retry-not-safe',
            status: 'manual-required',
          })
        : transitionSnapshot(snapshot, now, { status: 'cancelled' });
    case 'task-closing':
      if (terminal) return ignore();
      return transitionSnapshot(snapshot, now, {
        reason: 'task-closing',
        status: hasPossibleAutomaticWrite(snapshot) ? 'manual-required' : 'cancelled',
      });
    case 'cancel':
      return terminal ? ignore() : transitionSnapshot(snapshot, now, { status: 'cancelled' });
  }
}

export function getManualInitialPromptSendRecovery(args: {
  failedAttempt: number;
  issue: ManualInitialPromptSendIssue;
  manualSendOperationId: string;
}): ManualInitialPromptSendRecovery {
  switch (args.issue.code) {
    case 'confirmation-required':
      return {
        kind: 'confirm-possible-prior-automatic-write',
        manualSendOperationId: args.manualSendOperationId,
      };
    case 'draft-changed':
    case 'edit-revision-changed':
    case 'operation-superseded':
      return { kind: 'refresh-draft-and-use-derived-operation' };
    case 'control-unavailable':
      return {
        failedAttempt: args.failedAttempt,
        kind: 'take-control-then-retry-proven-not-sent',
        manualSendOperationId: args.manualSendOperationId,
      };
    case 'agent-not-running':
    case 'agent-not-ready':
    case 'agent-question-active':
    case 'agent-generation-changed':
    case 'supervision-changed-before-admission':
    case 'backend-restarted-before-write':
    case 'write-rejected-before-admission':
      return {
        failedAttempt: args.failedAttempt,
        kind: 'retry-proven-not-sent',
        manualSendOperationId: args.manualSendOperationId,
      };
    case 'write-outcome-ambiguous':
      return {
        automaticRetryAllowed: false,
        kind: 'inspect-terminal-and-copy-exact-draft',
      };
    case 'task-missing':
    case 'delivery-closed':
    case 'task-closing':
      return { kind: 'none' };
  }
}

export function isManualInitialPromptSendTerminalPhase(
  phase: ManualInitialPromptSendPhase,
): boolean {
  return (
    phase === 'completed' || phase === 'manual-reconciliation-required' || phase === 'reconciled'
  );
}

export function isManualInitialPromptSendPreIntentPhase(
  phase: ManualInitialPromptSendPhase,
): boolean {
  return (
    phase === 'admitted' ||
    phase === 'automation-sealed' ||
    phase === 'confirmation-required' ||
    phase === 'waiting-lease'
  );
}

export function isManualInitialPromptSendSettled(
  operation: ManualInitialPromptSendOperationSnapshot,
): boolean {
  return (
    isManualInitialPromptSendTerminalPhase(operation.phase) ||
    (operation.phase === 'failed-before-write' && operation.terminalReceipt?.terminal === true)
  );
}
