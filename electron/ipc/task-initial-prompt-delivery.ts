import type { AgentSupervisionState } from '../../src/domain/server-state.js';
import type { TaskRemovalCurrentProjection } from '../../src/domain/task-catalog.js';
import type { TaskRemovalParticipantGate } from '../../src/domain/task-removal-owner.js';
import {
  MANUAL_INITIAL_PROMPT_SEND_RATE_LIMIT,
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  TASK_INITIAL_PROMPT_READY_DEADLINE_MS,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS,
  TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS,
  consumeManualInitialPromptRateToken,
  createManualInitialPromptRateBucket,
  deriveManualInitialPromptSendOperationId,
  getManualInitialPromptSendRecovery,
  isLowercaseSha256Fingerprint,
  isManualInitialPromptSendPreIntentPhase,
  isManualInitialPromptSendSettled,
  isManualInitialPromptSendTerminalPhase,
  reduceTaskInitialPromptDelivery,
  type FinalizeRemovedTaskInitialPromptStateRequest,
  type FinalizeRemovedTaskInitialPromptStateResult,
  type ManualInitialPromptRateBucket,
  type ManualInitialPromptSendAttemptReceipt,
  type ManualInitialPromptSendHighWater,
  type ManualInitialPromptSendIssue,
  type ManualInitialPromptSendOperationSnapshot,
  type ManualInitialPromptSendRecovery,
  type QueueTaskInitialPromptDeliveryResult,
  type ResolveManualInitialPromptSendAmbiguityRequest,
  type ResolveManualInitialPromptSendAmbiguityResult,
  type ReviseTaskInitialPromptDraftRequest,
  type ReviseTaskInitialPromptDraftResult,
  type SendTaskInitialPromptManuallyRequest,
  type SendTaskInitialPromptManuallyResult,
  type TaskInitialPromptDeliveryProjection,
  type TaskInitialPromptDeliveryProjectionWithManualOperation,
  type TaskInitialPromptDeliveryRequest,
  type TaskInitialPromptDeliverySnapshot,
  type TaskInitialPromptDraftSnapshot,
  type TaskInitialPromptOwnerAvailability,
} from '../../src/domain/task-initial-prompt-delivery.js';
import { materializePromptDispatch } from '../../src/domain/task-prompt-materialization.js';
import type {
  PromptInputAdmissionExpectation,
  PromptInputAdmissionResult,
} from '../../src/domain/task-prompt-input-admission.js';
import {
  classifyPromptDeliveryEvidence,
  type PromptDeliveryReadyCandidate,
} from '../../src/lib/prompt-delivery-readiness.js';
import type { MaterializedPromptInputDispatch } from './task-prompt-input-admission.js';

export interface TaskInitialPromptDeliveryJournalRecord {
  automationSealed: boolean;
  automaticReadyDeadlineAtMs?: number;
  automaticReadyDeadlineExtensionUsed?: boolean;
  draftEditRevision: number;
  editHighWater?: {
    editSealed: boolean;
    highestEditRevision: number;
    highestInputFingerprint: string;
    highestOperationId: string;
  };
  expectedDraftFingerprint: string;
  manualSendHighWater?: ManualInitialPromptSendHighWater;
  manualSendOperation?: ManualInitialPromptSendOperationSnapshot;
  preWriteReadyFingerprint?: string;
  readyCandidate?: PromptDeliveryReadyCandidate;
  request: TaskInitialPromptDeliveryRequest;
  schemaVersion: 1;
  snapshot: TaskInitialPromptDeliverySnapshot;
  writeBegan: boolean;
}

export const TASK_INITIAL_PROMPT_AUTOMATIC_RICH_REPLAY_LIMIT = 256;

/**
 * Rich readiness evidence is useful for recent delivered-operation replay, but
 * it is not correctness state once the exact canonical draft has been
 * compare-cleared. The sealed edit high-water and terminal snapshot remain.
 */
export function isAcknowledgedAutomaticReplayRecord(
  record: Readonly<TaskInitialPromptDeliveryJournalRecord>,
): boolean {
  return (
    record.snapshot.status === 'delivered' &&
    record.editHighWater?.editSealed === true &&
    record.manualSendOperation === undefined
  );
}

export function compactAcknowledgedAutomaticReplayRecord(
  record: Readonly<TaskInitialPromptDeliveryJournalRecord>,
): TaskInitialPromptDeliveryJournalRecord {
  const compact = structuredClone(record);
  Reflect.deleteProperty(compact, 'preWriteReadyFingerprint');
  Reflect.deleteProperty(compact, 'readyCandidate');
  return compact;
}

export function selectAcknowledgedAutomaticRichReplayIdsToCompact(
  records: readonly Readonly<TaskInitialPromptDeliveryJournalRecord>[],
): string[] {
  const rich = records.filter(
    (record) =>
      isAcknowledgedAutomaticReplayRecord(record) &&
      (record.preWriteReadyFingerprint !== undefined || record.readyCandidate !== undefined),
  );
  if (rich.length <= TASK_INITIAL_PROMPT_AUTOMATIC_RICH_REPLAY_LIMIT) return [];
  rich.sort((left, right) => {
    const byUpdatedAt = left.snapshot.updatedAt.localeCompare(right.snapshot.updatedAt);
    return byUpdatedAt !== 0
      ? byUpdatedAt
      : left.request.deliveryId.localeCompare(right.request.deliveryId);
  });
  return rich
    .slice(0, rich.length - TASK_INITIAL_PROMPT_AUTOMATIC_RICH_REPLAY_LIMIT)
    .map((record) => record.request.deliveryId);
}

export interface TaskInitialPromptDeliveryJournal {
  deleteTaskRecords(taskId: string): Promise<'complete' | 'already-complete'>;
  findManualOperation(
    manualSendOperationId: string,
  ): Promise<TaskInitialPromptDeliveryJournalRecord | null>;
  isAvailable(): boolean;
  listRecords(): Promise<TaskInitialPromptDeliveryJournalRecord[]>;
  listTaskRecords(taskId: string): Promise<TaskInitialPromptDeliveryJournalRecord[]>;
  load(deliveryId: string): Promise<TaskInitialPromptDeliveryJournalRecord | null>;
  save(record: TaskInitialPromptDeliveryJournalRecord): Promise<void>;
}

export interface TaskInitialPromptDraftRepository {
  /** Atomically clears the canonical draft and seals its journal edit high-water. */
  clearAfterAcceptedOutcome(args: {
    deliveryId: string;
    expectedDraftFingerprint: string;
    expectedEditRevision: number;
    reason: 'automatic-delivered' | 'manual-send-accepted';
    taskId: string;
  }): Promise<{
    kind: 'cleared' | 'already-cleared' | 'draft-changed';
    workspaceRevision: number;
  }>;
  loadCurrentDraft(
    taskId: string,
    deliveryId: string,
  ): Promise<TaskInitialPromptDraftSnapshot | null>;
  loadExactDraft(args: {
    deliveryId: string;
    expectedDraftFingerprint: string;
    expectedEditRevision?: number;
    taskId: string;
  }): Promise<TaskInitialPromptDraftSnapshot>;
  /** Atomically revises the canonical draft and its delivery/edit journal record. */
  reviseAfterUserEdit(
    request: ReviseTaskInitialPromptDraftRequest,
  ): Promise<Exclude<ReviseTaskInitialPromptDraftResult, { kind: 'admission-unavailable' }>>;
}

export type TaskInitialPromptRemovalGate = TaskRemovalParticipantGate<
  typeof TASK_INITIAL_PROMPT_HOOK_SET_VERSION
>;

export interface TaskInitialPromptAgentRuntimeSnapshot {
  generation: number;
  lastOutputAtMs: number;
  state: AgentSupervisionState;
  supervisionVersion: number;
  tail: string;
  taskId: string;
}

export interface TaskInitialPromptCommandLease {
  controllerId: string;
  leaseGeneration: number;
  leaseOwnerId: string;
  release(): Promise<void> | void;
}

export interface TaskInitialPromptDeliveryClock {
  nowMs(): number;
  sleep(delayMs: number): Promise<void>;
  toIso(ms: number): string;
}

export interface TaskInitialPromptDeliveryDependencies {
  acquireCommandLease(args: {
    agentId: string;
    taskId: string;
  }): Promise<TaskInitialPromptCommandLease | null>;
  admitPrompt(
    expectation: PromptInputAdmissionExpectation,
    dispatch: MaterializedPromptInputDispatch,
  ): Promise<PromptInputAdmissionResult>;
  clock?: TaskInitialPromptDeliveryClock;
  draftRepository: TaskInitialPromptDraftRepository;
  getAgentRuntime(agentId: string): TaskInitialPromptAgentRuntimeSnapshot | null;
  getOwnerAvailability(): TaskInitialPromptOwnerAvailability;
  journal: TaskInitialPromptDeliveryJournal;
  removalGate: TaskInitialPromptRemovalGate;
}

export interface TaskInitialPromptAgentObservation {
  activityTransitionObserved?: boolean;
  agentId: string;
  generation: number;
  lastOutputAtMs: number;
  nowMs: number;
  returnedToReadySnapshot?: boolean;
  state: AgentSupervisionState;
  supervisionVersion: number;
  tail: string;
}

export type ProcessTaskInitialPromptObservationResult =
  | { kind: 'admission-unavailable'; reason: UnavailableReason }
  | { kind: 'missing' }
  | { kind: 'snapshot'; snapshot: TaskInitialPromptDeliverySnapshot };

export interface DrainTaskInitialPromptForRemovalRequest {
  deletionOperationId: string;
  taskId: string;
}

export interface DrainTaskInitialPromptForRemovalResult {
  kind: 'complete' | 'already-complete' | 'retry-required';
  retainedRecordCount: number;
}

export interface TaskInitialPromptDeliveryService {
  close(): Promise<void>;
  drainTaskForRemoval(
    request: DrainTaskInitialPromptForRemovalRequest,
  ): Promise<DrainTaskInitialPromptForRemovalResult>;
  finalizeRemovedTaskInitialPromptState(
    request: FinalizeRemovedTaskInitialPromptStateRequest,
  ): Promise<FinalizeRemovedTaskInitialPromptStateResult>;
  getProjection(deliveryId: string): Promise<TaskInitialPromptDeliveryProjection | null>;
  getOwnerAvailability(): TaskInitialPromptOwnerAvailability;
  expireDueDelivery(
    deliveryId: string,
    nowMs: number,
  ): Promise<ProcessTaskInitialPromptObservationResult>;
  probeRemovalHooks(): {
    drainHookVersion: typeof TASK_INITIAL_PROMPT_HOOK_SET_VERSION;
    finalizerHookVersion: typeof TASK_INITIAL_PROMPT_HOOK_SET_VERSION;
  };
  processObservation(
    deliveryId: string,
    observation: TaskInitialPromptAgentObservation,
  ): Promise<ProcessTaskInitialPromptObservationResult>;
  queue(request: TaskInitialPromptDeliveryRequest): Promise<QueueTaskInitialPromptDeliveryResult>;
  repairAfterRestart(): Promise<{
    ambiguousManualOperations: number;
    automaticManualRequired: number;
    completedAcceptedManualOperations: number;
    provenNotSentManualOperations: number;
  }>;
  resolveManualAmbiguity(
    request: ResolveManualInitialPromptSendAmbiguityRequest,
  ): Promise<ResolveManualInitialPromptSendAmbiguityResult>;
  reviseDraft(
    request: ReviseTaskInitialPromptDraftRequest,
  ): Promise<ReviseTaskInitialPromptDraftResult>;
  sendManually(
    request: SendTaskInitialPromptManuallyRequest,
  ): Promise<SendTaskInitialPromptManuallyResult>;
}

export interface TaskInitialPromptDeliveryResourceDiagnostics {
  automaticLeaseCount: number;
  manualLeaseCount: number;
  rateBucketCount: number;
}

type UnavailableReason =
  | 'delivery-owner-dark'
  | 'task-removal-gate-unavailable'
  | 'journal-unavailable';

type EffectBarrier =
  | { kind: 'unavailable'; reason: UnavailableReason }
  | {
      availability: Extract<TaskInitialPromptOwnerAvailability, { kind: 'active' }>;
      current: TaskRemovalCurrentProjection;
      kind: 'open';
    }
  | {
      availability: Extract<TaskInitialPromptOwnerAvailability, { kind: 'active' }>;
      current: TaskRemovalCurrentProjection;
      kind: 'closing';
    };

const DEFAULT_CLOCK: TaskInitialPromptDeliveryClock = {
  nowMs: () => Date.now(),
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  toIso: (ms) => new Date(ms).toISOString(),
};

export class TaskInitialPromptBadRequestError extends Error {
  readonly code = 'bad-request';
}

function cloneRecord(
  record: TaskInitialPromptDeliveryJournalRecord,
): TaskInitialPromptDeliveryJournalRecord {
  return structuredClone(record);
}

export function createMemoryTaskInitialPromptDeliveryJournal(
  options: { available?: boolean } = {},
): TaskInitialPromptDeliveryJournal & {
  recordCount(): number;
  setAvailable(available: boolean): void;
} {
  const records = new Map<string, TaskInitialPromptDeliveryJournalRecord>();
  const deliveryIdByManualOperationId = new Map<string, string>();
  let available = options.available ?? true;

  function compactRichAutomaticReplayWindow(): void {
    const deliveryIds = selectAcknowledgedAutomaticRichReplayIdsToCompact([...records.values()]);
    for (const deliveryId of deliveryIds) {
      const record = records.get(deliveryId);
      if (record) records.set(deliveryId, compactAcknowledgedAutomaticReplayRecord(record));
    }
  }

  return {
    async deleteTaskRecords(taskId) {
      let changed = false;
      for (const [deliveryId, record] of records) {
        if (record.request.taskId !== taskId) continue;
        if (record.manualSendOperation) {
          deliveryIdByManualOperationId.delete(record.manualSendOperation.manualSendOperationId);
        }
        records.delete(deliveryId);
        changed = true;
      }
      return changed ? 'complete' : 'already-complete';
    },
    async findManualOperation(manualSendOperationId) {
      const deliveryId = deliveryIdByManualOperationId.get(manualSendOperationId);
      const record = deliveryId ? records.get(deliveryId) : undefined;
      return record ? cloneRecord(record) : null;
    },
    isAvailable: () => available,
    async listRecords() {
      return [...records.values()].map(cloneRecord);
    },
    async listTaskRecords(taskId) {
      return [...records.values()]
        .filter((record) => record.request.taskId === taskId)
        .map(cloneRecord);
    },
    async load(deliveryId) {
      const record = records.get(deliveryId);
      return record ? cloneRecord(record) : null;
    },
    recordCount: () => records.size,
    async save(record) {
      const prior = records.get(record.request.deliveryId);
      const priorManualId = prior?.manualSendOperation?.manualSendOperationId;
      const nextManualId = record.manualSendOperation?.manualSendOperationId;
      if (priorManualId && priorManualId !== nextManualId) {
        deliveryIdByManualOperationId.delete(priorManualId);
      }
      records.set(record.request.deliveryId, cloneRecord(record));
      if (nextManualId) {
        deliveryIdByManualOperationId.set(nextManualId, record.request.deliveryId);
      }
      if (isAcknowledgedAutomaticReplayRecord(record)) compactRichAutomaticReplayWindow();
    },
    setAvailable(next) {
      available = next;
    },
  };
}

function validateDeliveryRequest(request: TaskInitialPromptDeliveryRequest): void {
  for (const [field, value] of [
    ['deliveryId', request.deliveryId],
    ['taskId', request.taskId],
    ['agentId', request.agentId],
  ] as const) {
    if (value.trim().length === 0 || value.length > 512) {
      throw new TaskInitialPromptBadRequestError(`${field} is invalid`);
    }
  }
  if (request.readinessPolicy !== TASK_INITIAL_PROMPT_READINESS_POLICY) {
    throw new TaskInitialPromptBadRequestError('readinessPolicy is invalid');
  }
  if (!isLowercaseSha256Fingerprint(request.expectedDraftFingerprint)) {
    throw new TaskInitialPromptBadRequestError('expectedDraftFingerprint is invalid');
  }
}

function sameRequest(
  left: TaskInitialPromptDeliveryRequest,
  right: TaskInitialPromptDeliveryRequest,
): boolean {
  return (
    left.deliveryId === right.deliveryId &&
    left.taskId === right.taskId &&
    left.agentId === right.agentId &&
    left.expectedDraftFingerprint === right.expectedDraftFingerprint &&
    left.readinessPolicy === right.readinessPolicy
  );
}

function createDispatch(text: string): MaterializedPromptInputDispatch {
  const writes = materializePromptDispatch(text).writes;
  const first = writes[0];
  if (!first) throw new Error('Prompt materialization produced no frame');
  const submit = writes[1];
  return {
    firstFrame: first.data,
    ...(submit ? { submitDelayMs: first.delayAfterMs, submitFrame: submit.data } : {}),
  };
}

function isAutomaticTerminal(snapshot: TaskInitialPromptDeliverySnapshot): boolean {
  return (
    snapshot.status === 'delivered' ||
    snapshot.status === 'manual-required' ||
    snapshot.status === 'cancelled'
  );
}

function mapAdmissionIssue(
  result: Extract<PromptInputAdmissionResult, { kind: 'rejected-before-bytes' }>,
): ManualInitialPromptSendIssue {
  switch (result.reason) {
    case 'agent-generation-changed':
      return {
        code: 'agent-generation-changed',
        ...(result.currentGeneration !== undefined
          ? { currentGeneration: result.currentGeneration }
          : {}),
      };
    case 'supervision-version-changed':
      return { code: 'supervision-changed-before-admission' };
    case 'control-or-lease-lost':
      return { code: 'control-unavailable' };
    case 'question-active':
      return { code: 'agent-question-active' };
    case 'agent-not-ready':
      return { code: 'agent-not-ready' };
    case 'task-closing':
      return { code: 'task-closing' };
  }
}

export function createTaskInitialPromptDeliveryService(
  dependencies: TaskInitialPromptDeliveryDependencies,
): TaskInitialPromptDeliveryService & {
  getResourceDiagnostics(): TaskInitialPromptDeliveryResourceDiagnostics;
} {
  const clock = dependencies.clock ?? DEFAULT_CLOCK;
  const serializerTails = new Map<string, Promise<void>>();
  const automaticLeases = new Map<string, TaskInitialPromptCommandLease>();
  const automaticLeaseReleases = new Map<string, Promise<void>>();
  const manualLeases = new Map<string, TaskInitialPromptCommandLease>();
  const manualLeaseReleases = new Map<string, Promise<void>>();
  const rateBuckets = new Map<string, ManualInitialPromptRateBucket>();
  let closed = false;

  async function serialized<TResult>(deliveryId: string, operation: () => Promise<TResult>) {
    const predecessor = serializerTails.get(deliveryId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    serializerTails.set(deliveryId, turn);
    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (serializerTails.get(deliveryId) === turn) serializerTails.delete(deliveryId);
    }
  }

  function barrier(taskId: string): EffectBarrier {
    if (closed) return { kind: 'unavailable', reason: 'delivery-owner-dark' };
    const availability = dependencies.getOwnerAvailability();
    if (availability.kind === 'dark') {
      return { kind: 'unavailable', reason: 'delivery-owner-dark' };
    }
    if (availability.kind === 'unavailable') return availability;
    const gate = dependencies.removalGate.getTaskSnapshot(taskId);
    if (
      gate.kind !== 'active' ||
      gate.cutoverEpoch !== availability.cutoverEpoch ||
      gate.hookSetVersion !== availability.hookSetVersion
    ) {
      return { kind: 'unavailable', reason: 'task-removal-gate-unavailable' };
    }
    if (!dependencies.journal.isAvailable()) {
      return { kind: 'unavailable', reason: 'journal-unavailable' };
    }
    return {
      availability,
      current: gate.current,
      kind: gate.current.taskState === 'present' && !gate.current.taskClosing ? 'open' : 'closing',
    };
  }

  function unavailableBeforeTaskLookup(): UnavailableReason | null {
    if (closed) return 'delivery-owner-dark';
    const availability = dependencies.getOwnerAvailability();
    if (availability.kind === 'dark') return 'delivery-owner-dark';
    if (availability.kind === 'unavailable') return availability.reason;
    if (!dependencies.journal.isAvailable()) return 'journal-unavailable';
    return null;
  }

  async function releaseRetainedLease(
    key: string,
    leases: Map<string, TaskInitialPromptCommandLease>,
    releases: Map<string, Promise<void>>,
  ): Promise<void> {
    const pendingRelease = releases.get(key);
    if (pendingRelease) return pendingRelease;
    const lease = leases.get(key);
    if (!lease) return;
    const release = Promise.resolve()
      .then(() => lease.release())
      .then(() => {
        if (leases.get(key) === lease) leases.delete(key);
      })
      .finally(() => {
        if (releases.get(key) === release) releases.delete(key);
      });
    releases.set(key, release);
    await release;
  }

  function releaseAutomaticLease(deliveryId: string): Promise<void> {
    return releaseRetainedLease(deliveryId, automaticLeases, automaticLeaseReleases);
  }

  function releaseManualLease(deliveryId: string): Promise<void> {
    return releaseRetainedLease(deliveryId, manualLeases, manualLeaseReleases);
  }

  async function releaseDeliveryLeases(deliveryId: string): Promise<void> {
    await Promise.all([releaseAutomaticLease(deliveryId), releaseManualLease(deliveryId)]);
  }

  async function getProjectionFromRecord(
    record: TaskInitialPromptDeliveryJournalRecord,
    current: TaskRemovalCurrentProjection,
  ): Promise<TaskInitialPromptDeliveryProjection> {
    const latestGate = dependencies.removalGate.getTaskSnapshot(record.request.taskId);
    const latestCurrent = latestGate.kind === 'active' ? latestGate.current : current;
    const currentDraft = await dependencies.draftRepository.loadCurrentDraft(
      record.request.taskId,
      record.request.deliveryId,
    );
    return {
      current: latestCurrent,
      currentDraft,
      delivery: record.snapshot,
      ...(record.manualSendHighWater ? { manualSendHighWater: record.manualSendHighWater } : {}),
      ...(record.manualSendOperation ? { manualSendOperation: record.manualSendOperation } : {}),
    };
  }

  async function getManualOperationProjectionFromRecord(
    record: TaskInitialPromptDeliveryJournalRecord,
    current: TaskRemovalCurrentProjection,
  ): Promise<TaskInitialPromptDeliveryProjectionWithManualOperation> {
    const projection = await getProjectionFromRecord(record, current);
    if (!projection.manualSendOperation) {
      throw new Error('Resolved manual operation is missing');
    }
    return {
      ...projection,
      manualSendOperation: projection.manualSendOperation,
    };
  }

  async function persistAutomaticTransition(
    record: TaskInitialPromptDeliveryJournalRecord,
    event: Parameters<typeof reduceTaskInitialPromptDelivery>[1],
    nowMs: number,
  ): Promise<void> {
    record.snapshot = reduceTaskInitialPromptDelivery(
      record.snapshot,
      event,
      clock.toIso(nowMs),
    ).snapshot;
    await dependencies.journal.save(record);
  }

  function startAutomaticReadyDeadline(
    record: TaskInitialPromptDeliveryJournalRecord,
    nowMs: number,
    extensionUsed: boolean,
  ): void {
    record.automaticReadyDeadlineAtMs = nowMs + TASK_INITIAL_PROMPT_READY_DEADLINE_MS;
    record.automaticReadyDeadlineExtensionUsed = extensionUsed;
  }

  function ensureAutomaticReadyDeadline(
    record: TaskInitialPromptDeliveryJournalRecord,
    nowMs: number,
  ): number {
    const existingDeadlineAtMs = record.automaticReadyDeadlineAtMs;
    if (existingDeadlineAtMs !== undefined) return existingDeadlineAtMs;

    // Pre-deadline journal records receive a full window on first use. This is
    // conservative and avoids converting an upgrade into an immediate
    // manual-recovery requirement.
    const deadlineAtMs = nowMs + TASK_INITIAL_PROMPT_READY_DEADLINE_MS;
    record.automaticReadyDeadlineAtMs = deadlineAtMs;
    record.automaticReadyDeadlineExtensionUsed = false;
    return deadlineAtMs;
  }

  async function settleAutomaticDeadline(
    record: TaskInitialPromptDeliveryJournalRecord,
    nowMs: number,
  ): Promise<boolean> {
    const status = record.snapshot.status;
    const due =
      status === 'verifying'
        ? nowMs - Date.parse(record.snapshot.updatedAt) >=
          TASK_INITIAL_PROMPT_VERIFICATION_WINDOW_MS
        : (status === 'waiting-ready' || status === 'waiting-lease') &&
          nowMs >= ensureAutomaticReadyDeadline(record, nowMs);
    if (!due) return false;

    await persistAutomaticTransition(record, { kind: 'verification-inconclusive' }, nowMs);
    await releaseAutomaticLease(record.request.deliveryId);
    return true;
  }

  async function settleAutomaticWriteAmbiguity(
    record: TaskInitialPromptDeliveryJournalRecord,
    nowMs: number,
  ): Promise<void> {
    await persistAutomaticTransition(record, { kind: 'write-outcome-ambiguous' }, nowMs);
    await releaseAutomaticLease(record.request.deliveryId);
  }

  async function settleUnsafeAutomaticRetry(
    record: TaskInitialPromptDeliveryJournalRecord,
    nowMs: number,
  ): Promise<void> {
    await persistAutomaticTransition(record, { kind: 'retry-not-safe' }, nowMs);
    await releaseAutomaticLease(record.request.deliveryId);
  }

  function resetRejectedAutomaticWriteIntent(record: TaskInitialPromptDeliveryJournalRecord): void {
    record.writeBegan = record.snapshot.attempts > 0;
    if (!record.writeBegan) Reflect.deleteProperty(record, 'preWriteReadyFingerprint');
  }

  async function dispatchAutomatic(
    record: TaskInitialPromptDeliveryJournalRecord,
    observation: TaskInitialPromptAgentObservation,
  ): Promise<void> {
    const draft = await dependencies.draftRepository.loadExactDraft({
      deliveryId: record.request.deliveryId,
      expectedDraftFingerprint: record.expectedDraftFingerprint,
      expectedEditRevision: record.draftEditRevision,
      taskId: record.request.taskId,
    });
    if (closed) return;
    if (await settleAutomaticDeadline(record, clock.nowMs())) return;
    let lease = automaticLeases.get(record.request.deliveryId);
    if (!lease) {
      const acquiredLease = await dependencies.acquireCommandLease({
        agentId: record.request.agentId,
        taskId: record.request.taskId,
      });
      if (!acquiredLease) return;
      lease = acquiredLease;
      automaticLeases.set(record.request.deliveryId, acquiredLease);
    }
    if (closed) {
      await releaseAutomaticLease(record.request.deliveryId);
      return;
    }
    const writeStartedAtMs = clock.nowMs();
    if (await settleAutomaticDeadline(record, writeStartedAtMs)) return;

    // `writing` is the durable write-intent boundary. Do not enter it until a
    // command lease is actually held: a restart while merely waiting for a
    // lease is proven not to have dispatched any prompt bytes.
    await persistAutomaticTransition(record, { kind: 'write-started' }, writeStartedAtMs);
    record.writeBegan = true;
    if (record.readyCandidate) {
      record.preWriteReadyFingerprint = record.readyCandidate.normalizedFrameFingerprint;
    } else {
      Reflect.deleteProperty(record, 'preWriteReadyFingerprint');
    }
    await dependencies.journal.save(record);

    const finalBarrier = barrier(record.request.taskId);
    if (finalBarrier.kind !== 'open') {
      const rejectedAtMs = clock.nowMs();
      resetRejectedAutomaticWriteIntent(record);
      await persistAutomaticTransition(
        record,
        { kind: 'write-rejected-before-bytes' },
        rejectedAtMs,
      );
      await persistAutomaticTransition(record, { kind: 'task-closing' }, rejectedAtMs);
      await releaseAutomaticLease(record.request.deliveryId);
      return;
    }
    let result: PromptInputAdmissionResult;
    try {
      result = await dependencies.admitPrompt(
        {
          agentGeneration: observation.generation,
          agentId: record.request.agentId,
          controllerId: lease.controllerId,
          leaseGeneration: lease.leaseGeneration,
          leaseOwnerId: lease.leaseOwnerId,
          purpose: 'initial-delivery',
          supervisionVersion: observation.supervisionVersion,
          taskId: record.request.taskId,
        },
        createDispatch(draft.text),
      );
    } catch {
      await settleAutomaticWriteAmbiguity(record, clock.nowMs());
      return;
    }
    const completedAtMs = clock.nowMs();
    if (result.kind === 'rejected-before-bytes') {
      resetRejectedAutomaticWriteIntent(record);
      await persistAutomaticTransition(
        record,
        { kind: 'write-rejected-before-bytes' },
        completedAtMs,
      );
      if (result.reason === 'task-closing') {
        await persistAutomaticTransition(record, { kind: 'task-closing' }, completedAtMs);
      } else if (result.reason === 'control-or-lease-lost') {
        await persistAutomaticTransition(record, { kind: 'lease-taken-over' }, completedAtMs);
      }
      await releaseAutomaticLease(record.request.deliveryId);
      return;
    }
    if (result.kind === 'outcome-ambiguous') {
      await settleAutomaticWriteAmbiguity(record, completedAtMs);
      return;
    }
    await persistAutomaticTransition(record, { kind: 'write-accepted' }, completedAtMs);
  }

  async function queue(
    request: TaskInitialPromptDeliveryRequest,
  ): Promise<QueueTaskInitialPromptDeliveryResult> {
    const admission = barrier(request.taskId);
    if (admission.kind !== 'open') {
      return {
        kind: 'admission-unavailable',
        reason:
          admission.kind === 'unavailable' ? admission.reason : 'task-removal-gate-unavailable',
        replayed: false,
      };
    }
    validateDeliveryRequest(request);
    return serialized(request.deliveryId, async () => {
      const existing = await dependencies.journal.load(request.deliveryId);
      if (existing) {
        if (!sameRequest(existing.request, request)) {
          throw new TaskInitialPromptBadRequestError(
            'deliveryId is already bound to another initial prompt',
          );
        }
        return { kind: 'accepted', replayed: true, snapshot: existing.snapshot };
      }
      const draft = await dependencies.draftRepository.loadExactDraft({
        deliveryId: request.deliveryId,
        expectedDraftFingerprint: request.expectedDraftFingerprint,
        taskId: request.taskId,
      });
      if (draft.mode !== 'automatic') {
        throw new TaskInitialPromptBadRequestError('Manual-only drafts cannot be auto-enqueued');
      }
      const finalAdmission = barrier(request.taskId);
      if (finalAdmission.kind !== 'open') {
        return {
          kind: 'admission-unavailable',
          reason:
            finalAdmission.kind === 'unavailable'
              ? finalAdmission.reason
              : 'task-removal-gate-unavailable',
          replayed: false,
        };
      }
      const nowMs = clock.nowMs();
      const snapshot: TaskInitialPromptDeliverySnapshot = {
        agentId: request.agentId,
        attempts: 0,
        createdAt: clock.toIso(nowMs),
        deliveryId: request.deliveryId,
        status: 'waiting-agent-session',
        taskId: request.taskId,
        updatedAt: clock.toIso(nowMs),
        version: 1,
      };
      await dependencies.journal.save({
        automationSealed: false,
        draftEditRevision: draft.editRevision,
        expectedDraftFingerprint: draft.fingerprint,
        request: { ...request },
        schemaVersion: 1,
        snapshot,
        writeBegan: false,
      });
      return { kind: 'accepted', replayed: false, snapshot };
    });
  }

  async function expireDueDelivery(
    deliveryId: string,
    nowMs: number,
  ): Promise<ProcessTaskInitialPromptObservationResult> {
    if (!Number.isFinite(nowMs)) {
      throw new TaskInitialPromptBadRequestError('Deadline timestamp must be finite');
    }
    const unavailable = unavailableBeforeTaskLookup();
    if (unavailable) return { kind: 'admission-unavailable', reason: unavailable };
    return serialized(deliveryId, async () => {
      const record = await dependencies.journal.load(deliveryId);
      if (!record) return { kind: 'missing' };
      const admission = barrier(record.request.taskId);
      if (admission.kind !== 'open') {
        return {
          kind: 'admission-unavailable',
          reason:
            admission.kind === 'unavailable' ? admission.reason : 'task-removal-gate-unavailable',
        };
      }
      if (record.automationSealed || isAutomaticTerminal(record.snapshot)) {
        await releaseDeliveryLeases(deliveryId);
        return { kind: 'snapshot', snapshot: record.snapshot };
      }
      if (record.snapshot.status === 'writing') {
        await settleAutomaticWriteAmbiguity(record, clock.nowMs());
        return { kind: 'snapshot', snapshot: record.snapshot };
      }
      if (record.snapshot.status === 'retry-wait') {
        await settleUnsafeAutomaticRetry(record, clock.nowMs());
        return { kind: 'snapshot', snapshot: record.snapshot };
      }

      const initializedReadyDeadline =
        (record.snapshot.status === 'waiting-ready' ||
          record.snapshot.status === 'waiting-lease') &&
        record.automaticReadyDeadlineAtMs === undefined;
      const settled = await settleAutomaticDeadline(record, nowMs);
      if (initializedReadyDeadline && !settled) {
        await dependencies.journal.save(record);
      }
      return { kind: 'snapshot', snapshot: record.snapshot };
    });
  }

  async function processObservation(
    deliveryId: string,
    observation: TaskInitialPromptAgentObservation,
  ): Promise<ProcessTaskInitialPromptObservationResult> {
    const unavailable = unavailableBeforeTaskLookup();
    if (unavailable) return { kind: 'admission-unavailable', reason: unavailable };
    return serialized(deliveryId, async () => {
      const record = await dependencies.journal.load(deliveryId);
      if (!record) return { kind: 'missing' };
      const admission = barrier(record.request.taskId);
      if (admission.kind !== 'open') {
        return {
          kind: 'admission-unavailable',
          reason:
            admission.kind === 'unavailable' ? admission.reason : 'task-removal-gate-unavailable',
        };
      }
      if (record.automationSealed || isAutomaticTerminal(record.snapshot)) {
        if (record.snapshot.status === 'delivered') {
          try {
            await dependencies.draftRepository.clearAfterAcceptedOutcome({
              deliveryId,
              expectedDraftFingerprint: record.expectedDraftFingerprint,
              expectedEditRevision: record.draftEditRevision,
              reason: 'automatic-delivered',
              taskId: record.request.taskId,
            });
          } finally {
            await releaseDeliveryLeases(deliveryId);
          }
        } else {
          await releaseDeliveryLeases(deliveryId);
        }
        return { kind: 'snapshot', snapshot: record.snapshot };
      }
      if (
        observation.agentId !== record.request.agentId ||
        observation.generation < 0 ||
        !Number.isSafeInteger(observation.generation)
      ) {
        throw new TaskInitialPromptBadRequestError('Observation does not match delivery agent');
      }
      if (record.snapshot.status === 'writing') {
        await settleAutomaticWriteAmbiguity(record, clock.nowMs());
        return { kind: 'snapshot', snapshot: record.snapshot };
      }

      if (observation.state === 'exited-clean' || observation.state === 'exited-error') {
        await persistAutomaticTransition(record, { kind: 'agent-exited' }, observation.nowMs);
        await releaseDeliveryLeases(deliveryId);
        return { kind: 'snapshot', snapshot: record.snapshot };
      }

      if (record.snapshot.status === 'waiting-agent-session') {
        startAutomaticReadyDeadline(record, observation.nowMs, false);
        await persistAutomaticTransition(
          record,
          { kind: 'session-available', targetGeneration: observation.generation },
          observation.nowMs,
        );
      } else if (record.snapshot.targetGeneration !== observation.generation) {
        if (
          !record.writeBegan &&
          record.snapshot.attempts === 0 &&
          record.automaticReadyDeadlineExtensionUsed !== true
        ) {
          startAutomaticReadyDeadline(record, observation.nowMs, true);
        }
        Reflect.deleteProperty(record, 'readyCandidate');
        await persistAutomaticTransition(
          record,
          { kind: 'generation-changed', targetGeneration: observation.generation },
          observation.nowMs,
        );
      }
      if (isAutomaticTerminal(record.snapshot)) {
        await releaseDeliveryLeases(deliveryId);
        return { kind: 'snapshot', snapshot: record.snapshot };
      }

      if (
        record.snapshot.status !== 'verifying' &&
        (await settleAutomaticDeadline(record, observation.nowMs))
      ) {
        return { kind: 'snapshot', snapshot: record.snapshot };
      }

      const classification = classifyPromptDeliveryEvidence({
        generation: observation.generation,
        lastOutputAtMs: observation.lastOutputAtMs,
        nowMs: observation.nowMs,
        ...(record.snapshot.status === 'verifying'
          ? {
              postWrite: {
                activityTransitionObserved: observation.activityTransitionObserved ?? false,
                promptPrefix: (
                  await dependencies.draftRepository.loadExactDraft({
                    deliveryId: record.request.deliveryId,
                    expectedDraftFingerprint: record.expectedDraftFingerprint,
                    expectedEditRevision: record.draftEditRevision,
                    taskId: record.request.taskId,
                  })
                ).text,
                returnedToReadySnapshot: observation.returnedToReadySnapshot ?? false,
              },
            }
          : {}),
        ...(record.readyCandidate ? { previousReadyCandidate: record.readyCandidate } : {}),
        supervisionState: observation.state,
        tail: observation.tail,
      });
      if (classification.readyCandidate) record.readyCandidate = classification.readyCandidate;
      else Reflect.deleteProperty(record, 'readyCandidate');
      await dependencies.journal.save(record);

      if (record.snapshot.status === 'retry-wait' && classification.kind !== 'ready') {
        await settleUnsafeAutomaticRetry(record, observation.nowMs);
        return { kind: 'snapshot', snapshot: record.snapshot };
      }

      if (record.snapshot.status === 'verifying') {
        if (classification.kind === 'delivered') {
          await persistAutomaticTransition(
            record,
            { kind: 'evidence-delivered' },
            observation.nowMs,
          );
          try {
            await dependencies.draftRepository.clearAfterAcceptedOutcome({
              deliveryId,
              expectedDraftFingerprint: record.expectedDraftFingerprint,
              expectedEditRevision: record.draftEditRevision,
              reason: 'automatic-delivered',
              taskId: record.request.taskId,
            });
          } finally {
            await releaseDeliveryLeases(deliveryId);
          }
        } else if (
          await settleAutomaticDeadline(record, Math.max(observation.nowMs, clock.nowMs()))
        ) {
          // Positive delivery evidence remains authoritative when observed
          // late, but a timed-out verification cannot use late absence as
          // permission for another write.
        } else if (classification.kind === 'absence-proven') {
          const retryAllowed = record.snapshot.attempts === 1;
          await persistAutomaticTransition(
            record,
            { kind: 'evidence-absence-proven' },
            observation.nowMs,
          );
          if (retryAllowed) {
            await clock.sleep(TASK_INITIAL_PROMPT_RETRY_BACKOFF_MS);
            await dispatchAutomatic(record, observation);
          } else {
            await releaseDeliveryLeases(deliveryId);
          }
        }
        return { kind: 'snapshot', snapshot: record.snapshot };
      }

      if (classification.kind === 'ready') {
        await persistAutomaticTransition(record, { kind: 'ready-stable' }, observation.nowMs);
        await dispatchAutomatic(record, observation);
      }
      return { kind: 'snapshot', snapshot: record.snapshot };
    });
  }

  function admissionRejected(
    reason: UnavailableReason,
    current?: TaskRemovalCurrentProjection,
  ): SendTaskInitialPromptManuallyResult {
    return {
      ...(current ? { current } : {}),
      error:
        reason === 'journal-unavailable'
          ? { code: 'journal-unavailable' }
          : {
              code: 'task-removal-gate-unavailable',
              state: reason === 'delivery-owner-dark' ? 'delivery-owner-dark' : 'gate-unavailable',
            },
      kind: 'admission-rejected',
      recovery: { kind: 'retry-same-request-when-service-ready' },
    };
  }

  async function manualAdmissionRejectedByBarrier(
    request: SendTaskInitialPromptManuallyRequest,
    admission: Exclude<EffectBarrier, { kind: 'open' }>,
    record?: TaskInitialPromptDeliveryJournalRecord | null,
  ): Promise<SendTaskInitialPromptManuallyResult> {
    if (admission.kind === 'unavailable') return admissionRejected(admission.reason);
    const currentRecord = record ?? (await dependencies.journal.load(request.deliveryId));
    if (!currentRecord) {
      return admissionRejected('task-removal-gate-unavailable', admission.current);
    }
    return {
      current: admission.current,
      currentDraft: await dependencies.draftRepository.loadCurrentDraft(
        currentRecord.request.taskId,
        currentRecord.request.deliveryId,
      ),
      delivery: currentRecord.snapshot,
      issue: { code: 'task-closing' },
      kind: 'domain-rejected',
      recovery: { kind: 'none' },
      replayed: false,
    };
  }

  function consumeRateToken(deliveryId: string, nowMs: number) {
    const current = rateBuckets.get(deliveryId) ?? createManualInitialPromptRateBucket(nowMs);
    const admission = consumeManualInitialPromptRateToken(current, nowMs);
    rateBuckets.set(deliveryId, admission.bucket);
    return admission;
  }

  function supersededManualDisposition(
    operation: ManualInitialPromptSendOperationSnapshot,
  ): ManualInitialPromptSendHighWater['disposition'] {
    if (
      operation.phase === 'failed-before-write' ||
      isManualInitialPromptSendPreIntentPhase(operation.phase)
    ) {
      return 'proven-not-sent';
    }
    return operation.phase === 'reconciled' ? 'reconciled' : 'sent';
  }

  async function createManualResult(
    record: TaskInitialPromptDeliveryJournalRecord,
    current: TaskRemovalCurrentProjection,
    recovery: ManualInitialPromptSendRecovery,
    replayed: boolean,
  ): Promise<SendTaskInitialPromptManuallyResult> {
    if (!record.manualSendOperation) throw new Error('Manual operation is missing');
    return {
      current,
      currentDraft: await dependencies.draftRepository.loadCurrentDraft(
        record.request.taskId,
        record.request.deliveryId,
      ),
      delivery: record.snapshot,
      kind: 'operation',
      operation: record.manualSendOperation,
      recovery,
      replayed,
    };
  }

  function createAttemptReceipt(args: {
    issue?: ManualInitialPromptSendIssue;
    operation: ManualInitialPromptSendOperationSnapshot;
    outcome?: ManualInitialPromptSendAttemptReceipt['outcome'];
    recovery: ManualInitialPromptSendRecovery;
    terminal: boolean;
  }): ManualInitialPromptSendAttemptReceipt {
    return {
      acknowledgedDraftFingerprint: args.operation.acknowledgedDraftFingerprint,
      acknowledgedEditRevision: args.operation.acknowledgedEditRevision,
      agentId: args.operation.agentId,
      attempt: args.operation.attempt,
      completedAt: clock.toIso(clock.nowMs()),
      deliveryId: args.operation.deliveryId,
      expectedAgentGeneration: args.operation.expectedAgentGeneration,
      manualSendOperationId: args.operation.manualSendOperationId,
      outcome: args.outcome ?? {
        issue: args.issue ?? { code: 'write-rejected-before-admission' },
        kind: 'not-sent',
      },
      recovery: args.recovery,
      taskId: args.operation.taskId,
      terminal: args.terminal,
    };
  }

  function completeManualOperation(
    operation: ManualInitialPromptSendOperationSnapshot,
    phase: 'completed' | 'failed-before-write' | 'manual-reconciliation-required' | 'reconciled',
    receipt: ManualInitialPromptSendAttemptReceipt,
  ): ManualInitialPromptSendOperationSnapshot {
    const completed: ManualInitialPromptSendOperationSnapshot = {
      ...operation,
      phase,
      terminalReceipt: { ...receipt, terminal: true },
      updatedAt: clock.toIso(clock.nowMs()),
      version: operation.version + 1,
    };
    // The terminal receipt is also the latest receipt. Persisting it twice
    // adds roughly 600 bytes to every retained operation without adding any
    // replay information and breaks the bounded-metadata target.
    Reflect.deleteProperty(completed, 'latestAttemptReceipt');
    return completed;
  }

  async function persistManualFailure(
    record: TaskInitialPromptDeliveryJournalRecord,
    issue: ManualInitialPromptSendIssue,
  ): Promise<ManualInitialPromptSendRecovery> {
    const operation = record.manualSendOperation;
    if (!operation) throw new Error('Manual operation is missing');
    const recovery = getManualInitialPromptSendRecovery({
      failedAttempt: operation.attempt,
      issue,
      manualSendOperationId: operation.manualSendOperationId,
    });
    const terminal = issue.code === 'task-closing';
    const receipt = createAttemptReceipt({ issue, operation, recovery, terminal });
    record.manualSendOperation = terminal
      ? completeManualOperation(operation, 'failed-before-write', receipt)
      : {
          ...operation,
          latestAttemptReceipt: receipt,
          phase: 'failed-before-write',
          updatedAt: clock.toIso(clock.nowMs()),
          version: operation.version + 1,
        };
    await dependencies.journal.save(record);
    return recovery;
  }

  async function persistManualAmbiguity(
    record: TaskInitialPromptDeliveryJournalRecord,
  ): Promise<ManualInitialPromptSendRecovery> {
    const operation = record.manualSendOperation;
    if (!operation) throw new Error('Manual operation is missing');
    const issue = { code: 'write-outcome-ambiguous' } as const;
    const recovery = getManualInitialPromptSendRecovery({
      failedAttempt: operation.attempt,
      issue,
      manualSendOperationId: operation.manualSendOperationId,
    });
    const receipt = createAttemptReceipt({
      operation,
      outcome: { issue, kind: 'write-outcome-ambiguous' },
      recovery,
      terminal: true,
    });
    record.manualSendOperation = completeManualOperation(
      operation,
      'manual-reconciliation-required',
      receipt,
    );
    await dependencies.journal.save(record);
    return recovery;
  }

  async function loadRecordAfterDraftMutation(
    record: TaskInitialPromptDeliveryJournalRecord,
  ): Promise<TaskInitialPromptDeliveryJournalRecord> {
    const refreshed = await dependencies.journal.load(record.request.deliveryId);
    if (!refreshed || !sameRequest(refreshed.request, record.request)) {
      throw new Error('Initial prompt record disappeared during atomic draft mutation');
    }
    return refreshed;
  }

  async function settleAcceptedManualOperation(
    record: TaskInitialPromptDeliveryJournalRecord,
  ): Promise<{ completed: boolean; record: TaskInitialPromptDeliveryJournalRecord }> {
    const operation = record.manualSendOperation;
    if (!operation || operation.phase !== 'write-accepted') {
      throw new Error('Accepted manual operation is missing');
    }
    let clear: Awaited<ReturnType<TaskInitialPromptDraftRepository['clearAfterAcceptedOutcome']>>;
    try {
      clear = await dependencies.draftRepository.clearAfterAcceptedOutcome({
        deliveryId: operation.deliveryId,
        expectedDraftFingerprint: operation.acknowledgedDraftFingerprint,
        expectedEditRevision: operation.acknowledgedEditRevision,
        reason: 'manual-send-accepted',
        taskId: operation.taskId,
      });
    } catch {
      // The accepted write is durable and must never be repeated. A replay of
      // this same derived operation retries only the exact compare-clear.
      return { completed: false, record };
    }
    record = await loadRecordAfterDraftMutation(record);
    const refreshedOperation = record.manualSendOperation;
    if (!refreshedOperation || refreshedOperation.phase !== 'write-accepted') {
      throw new Error('Accepted manual operation changed during atomic draft mutation');
    }
    const receipt = createAttemptReceipt({
      operation: refreshedOperation,
      outcome: {
        acknowledgedDraftFingerprint: refreshedOperation.acknowledgedDraftFingerprint,
        acknowledgedEditRevision: refreshedOperation.acknowledgedEditRevision,
        agentGeneration: refreshedOperation.expectedAgentGeneration,
        clear: clear.kind,
        kind: 'sent',
      },
      recovery: { kind: 'none' },
      terminal: true,
    });
    record.manualSendOperation = completeManualOperation(refreshedOperation, 'completed', receipt);
    record.manualSendHighWater = {
      acknowledgedDraftFingerprint: refreshedOperation.acknowledgedDraftFingerprint,
      disposition: 'sent',
      highestAcknowledgedEditRevision: refreshedOperation.acknowledgedEditRevision,
      operationId: refreshedOperation.manualSendOperationId,
    };
    await dependencies.journal.save(record);
    return { completed: true, record };
  }

  async function completeAcceptedManualOperation(
    record: TaskInitialPromptDeliveryJournalRecord,
    current: TaskRemovalCurrentProjection,
    replayed: boolean,
  ): Promise<SendTaskInitialPromptManuallyResult> {
    const settlement = await settleAcceptedManualOperation(record);
    return createManualResult(settlement.record, current, { kind: 'none' }, replayed);
  }

  async function sendManually(
    request: SendTaskInitialPromptManuallyRequest,
  ): Promise<SendTaskInitialPromptManuallyResult> {
    const initialAdmission = barrier(request.taskId);
    if (initialAdmission.kind === 'unavailable') {
      return admissionRejected(initialAdmission.reason);
    }
    return serialized(request.deliveryId, async () => {
      await releaseManualLease(request.deliveryId);
      const record = await dependencies.journal.load(request.deliveryId);
      let admission = barrier(request.taskId);
      if (admission.kind !== 'open') {
        return manualAdmissionRejectedByBarrier(request, admission, record);
      }
      if (
        !record ||
        record.request.taskId !== request.taskId ||
        record.request.agentId !== request.agentId
      ) {
        return {
          current: admission.current,
          currentDraft: null,
          delivery: record?.snapshot ?? {
            agentId: request.agentId,
            attempts: 0,
            createdAt: clock.toIso(clock.nowMs()),
            deliveryId: request.deliveryId,
            status: 'cancelled',
            taskId: request.taskId,
            updatedAt: clock.toIso(clock.nowMs()),
            version: 0,
          },
          issue: { code: 'task-missing' },
          kind: 'domain-rejected',
          recovery: { kind: 'none' },
          replayed: false,
        };
      }
      const expectedId = deriveManualInitialPromptSendOperationId({
        acknowledgedDraftFingerprint: request.expectedDraftFingerprint,
        acknowledgedEditRevision: request.expectedEditRevision,
        deliveryId: request.deliveryId,
      });
      if (expectedId !== request.manualSendOperationId) {
        return {
          current: admission.current,
          error: { code: 'bad-request', field: 'manualSendOperationId' },
          kind: 'admission-rejected',
          recovery: { kind: 'correct-request' },
        };
      }

      // Once the durable automation seal exists, every replay helps finish the
      // corresponding automatic-lease release before doing any manual work.
      // A failed release stays retained and is retried by the next replay.
      if (record.automationSealed) {
        await releaseAutomaticLease(request.deliveryId);
      }
      admission = barrier(request.taskId);
      if (admission.kind !== 'open') {
        return manualAdmissionRejectedByBarrier(request, admission, record);
      }

      let operation = record.manualSendOperation;
      if (
        operation?.manualSendOperationId === request.manualSendOperationId &&
        isManualInitialPromptSendTerminalPhase(operation.phase)
      ) {
        return createManualResult(
          record,
          admission.current,
          operation.latestAttemptReceipt?.recovery ??
            operation.terminalReceipt?.recovery ?? { kind: 'none' },
          true,
        );
      }
      if (
        operation?.manualSendOperationId === request.manualSendOperationId &&
        operation.phase === 'write-accepted'
      ) {
        return completeAcceptedManualOperation(record, admission.current, true);
      }
      if (
        operation?.manualSendOperationId === request.manualSendOperationId &&
        operation.phase === 'write-intent-persisted'
      ) {
        const recovery = await persistManualAmbiguity(record);
        return createManualResult(record, admission.current, recovery, true);
      }
      let draft: TaskInitialPromptDraftSnapshot;
      try {
        draft = await dependencies.draftRepository.loadExactDraft({
          deliveryId: request.deliveryId,
          expectedDraftFingerprint: request.expectedDraftFingerprint,
          expectedEditRevision: request.expectedEditRevision,
          taskId: request.taskId,
        });
      } catch {
        admission = barrier(request.taskId);
        if (admission.kind !== 'open') {
          return manualAdmissionRejectedByBarrier(request, admission, record);
        }
        return {
          current: admission.current,
          currentDraft: await dependencies.draftRepository.loadCurrentDraft(
            request.taskId,
            request.deliveryId,
          ),
          delivery: record.snapshot,
          issue: { code: 'draft-changed' },
          kind: 'domain-rejected',
          recovery: { kind: 'refresh-draft-and-use-derived-operation' },
          replayed: false,
        };
      }
      admission = barrier(request.taskId);
      if (admission.kind !== 'open') {
        return manualAdmissionRejectedByBarrier(request, admission, record);
      }

      if (operation?.manualSendOperationId === request.manualSendOperationId) {
        if (operation.phase === 'failed-before-write') {
          if (
            request.action.kind !== 'retry-proven-not-sent' ||
            request.action.failedAttempt !== operation.attempt
          ) {
            return createManualResult(
              record,
              admission.current,
              operation.latestAttemptReceipt?.recovery ??
                operation.terminalReceipt?.recovery ?? { kind: 'none' },
              true,
            );
          }
          const rate = consumeRateToken(request.deliveryId, clock.nowMs());
          if (rate.kind === 'rate-limited') {
            return {
              current: admission.current,
              error: { code: 'rate-limited', retryAfterMs: rate.retryAfterMs },
              kind: 'admission-rejected',
              recovery: { kind: 'wait-and-retry-same-action', retryAfterMs: rate.retryAfterMs },
            };
          }
          operation = {
            ...operation,
            attempt: operation.attempt + 1,
            expectedAgentGeneration: request.expectedAgentGeneration,
            phase: 'automation-sealed',
            updatedAt: clock.toIso(clock.nowMs()),
            version: operation.version + 1,
          };
          record.manualSendOperation = operation;
          await dependencies.journal.save(record);
        } else if (
          operation.phase === 'confirmation-required' &&
          request.confirmPossiblePriorAutomaticWrite
        ) {
          operation = {
            ...operation,
            phase: 'automation-sealed',
            updatedAt: clock.toIso(clock.nowMs()),
            version: operation.version + 1,
          };
          record.manualSendOperation = operation;
          await dependencies.journal.save(record);
        } else if (operation.phase !== 'automation-sealed') {
          const recovery: ManualInitialPromptSendRecovery =
            operation.phase === 'confirmation-required'
              ? {
                  kind: 'confirm-possible-prior-automatic-write',
                  manualSendOperationId: operation.manualSendOperationId,
                }
              : { kind: 'none' };
          return createManualResult(record, admission.current, recovery, true);
        }
      } else {
        if (request.action.kind !== 'send') {
          return {
            current: admission.current,
            error: { code: 'bad-request', field: 'action' },
            kind: 'admission-rejected',
            recovery: { kind: 'correct-request' },
          };
        }
        if (operation) {
          if (operation.phase === 'manual-reconciliation-required') {
            return {
              current: admission.current,
              error: {
                ambiguousOperationId: operation.manualSendOperationId,
                code: 'manual-reconciliation-pending',
              },
              kind: 'admission-rejected',
              recovery: {
                ambiguousOperationId: operation.manualSendOperationId,
                kind: 'inspect-terminal-and-copy-draft',
              },
            };
          }
          if (
            !isManualInitialPromptSendTerminalPhase(operation.phase) &&
            operation.phase !== 'failed-before-write' &&
            !isManualInitialPromptSendPreIntentPhase(operation.phase)
          ) {
            return {
              current: admission.current,
              error: {
                activeOperationId: operation.manualSendOperationId,
                code: 'manual-send-in-progress',
              },
              kind: 'admission-rejected',
              recovery: {
                activeOperationId: operation.manualSendOperationId,
                kind: 'adopt-active-operation',
              },
            };
          }
          record.manualSendHighWater = {
            acknowledgedDraftFingerprint: operation.acknowledgedDraftFingerprint,
            disposition: supersededManualDisposition(operation),
            highestAcknowledgedEditRevision: operation.acknowledgedEditRevision,
            operationId: operation.manualSendOperationId,
          };
        }
        if (
          record.manualSendHighWater &&
          request.expectedEditRevision <= record.manualSendHighWater.highestAcknowledgedEditRevision
        ) {
          return {
            current: admission.current,
            currentDraft: draft,
            delivery: record.snapshot,
            issue: { code: 'operation-superseded' },
            kind: 'domain-rejected',
            recovery: { kind: 'refresh-draft-and-use-derived-operation' },
            replayed: false,
          };
        }
        const rate = consumeRateToken(request.deliveryId, clock.nowMs());
        if (rate.kind === 'rate-limited') {
          return {
            current: admission.current,
            error: { code: 'rate-limited', retryAfterMs: rate.retryAfterMs },
            kind: 'admission-rejected',
            recovery: { kind: 'wait-and-retry-same-action', retryAfterMs: rate.retryAfterMs },
          };
        }
        const possiblePriorAutomaticWrite = record.writeBegan || record.snapshot.attempts > 0;
        const now = clock.toIso(clock.nowMs());
        operation = {
          acknowledgedDraftFingerprint: request.expectedDraftFingerprint,
          acknowledgedEditRevision: request.expectedEditRevision,
          agentId: request.agentId,
          attempt: 1,
          createdAt: now,
          deliveryId: request.deliveryId,
          expectedAgentGeneration: request.expectedAgentGeneration,
          manualSendOperationId: request.manualSendOperationId,
          phase:
            possiblePriorAutomaticWrite && !request.confirmPossiblePriorAutomaticWrite
              ? 'confirmation-required'
              : 'automation-sealed',
          possiblePriorAutomaticWrite,
          taskId: request.taskId,
          updatedAt: now,
          version: 1,
        };
        record.automationSealed = true;
        record.manualSendOperation = operation;
        record.snapshot = reduceTaskInitialPromptDelivery(
          record.snapshot,
          { kind: 'automation-sealed', possiblePriorWrite: possiblePriorAutomaticWrite },
          now,
        ).snapshot;
        await dependencies.journal.save(record);
        await releaseAutomaticLease(request.deliveryId);
        if (operation.phase === 'confirmation-required') {
          return createManualResult(
            record,
            admission.current,
            {
              kind: 'confirm-possible-prior-automatic-write',
              manualSendOperationId: operation.manualSendOperationId,
            },
            false,
          );
        }
      }

      operation = record.manualSendOperation;
      if (!operation) throw new Error('Manual operation admission was not persisted');
      const runtime = dependencies.getAgentRuntime(request.agentId);
      let issue: ManualInitialPromptSendIssue | null = null;
      if (!runtime || runtime.taskId !== request.taskId) issue = { code: 'agent-not-running' };
      else if (runtime.generation !== request.expectedAgentGeneration) {
        issue = { code: 'agent-generation-changed', currentGeneration: runtime.generation };
      } else if (runtime.state === 'awaiting-input') issue = { code: 'agent-question-active' };
      else if (runtime.state !== 'idle-at-prompt') issue = { code: 'agent-not-ready' };
      if (issue) {
        const recovery = await persistManualFailure(record, issue);
        return createManualResult(record, admission.current, recovery, false);
      }

      const lease = await dependencies.acquireCommandLease({
        agentId: request.agentId,
        taskId: request.taskId,
      });
      if (!lease) {
        const recovery = await persistManualFailure(record, { code: 'control-unavailable' });
        return createManualResult(record, admission.current, recovery, false);
      }
      manualLeases.set(request.deliveryId, lease);
      try {
        operation = record.manualSendOperation;
        if (!operation) throw new Error('Manual operation disappeared');
        operation = {
          ...operation,
          phase: 'write-intent-persisted',
          updatedAt: clock.toIso(clock.nowMs()),
          version: operation.version + 1,
        };
        record.manualSendOperation = operation;
        await dependencies.journal.save(record);

        const finalBarrier = barrier(request.taskId);
        if (finalBarrier.kind !== 'open') {
          const recovery = await persistManualFailure(record, { code: 'task-closing' });
          return createManualResult(record, admission.current, recovery, false);
        }
        let result: PromptInputAdmissionResult;
        try {
          result = await dependencies.admitPrompt(
            {
              agentGeneration: runtime?.generation ?? request.expectedAgentGeneration,
              agentId: request.agentId,
              controllerId: lease.controllerId,
              leaseGeneration: lease.leaseGeneration,
              leaseOwnerId: lease.leaseOwnerId,
              purpose: 'initial-delivery',
              supervisionVersion: runtime?.supervisionVersion ?? 0,
              taskId: request.taskId,
            },
            createDispatch(draft.text),
          );
        } catch {
          const recovery = await persistManualAmbiguity(record);
          return createManualResult(record, admission.current, recovery, false);
        }
        if (result.kind === 'rejected-before-bytes') {
          const rejectedIssue = mapAdmissionIssue(result);
          const recovery = await persistManualFailure(record, rejectedIssue);
          return createManualResult(record, admission.current, recovery, false);
        }
        if (result.kind === 'outcome-ambiguous') {
          const recovery = await persistManualAmbiguity(record);
          return createManualResult(record, admission.current, recovery, false);
        }

        operation = record.manualSendOperation;
        if (!operation) throw new Error('Manual operation disappeared');
        operation = {
          ...operation,
          phase: 'write-accepted',
          updatedAt: clock.toIso(clock.nowMs()),
          version: operation.version + 1,
        };
        record.manualSendOperation = operation;
        await dependencies.journal.save(record);
        return completeAcceptedManualOperation(record, admission.current, false);
      } finally {
        await releaseManualLease(request.deliveryId);
      }
    });
  }

  async function reviseDraft(
    request: ReviseTaskInitialPromptDraftRequest,
  ): Promise<ReviseTaskInitialPromptDraftResult> {
    const admission = barrier(request.taskId);
    if (admission.kind !== 'open') {
      return {
        kind: 'admission-unavailable',
        reason:
          admission.kind === 'unavailable' ? admission.reason : 'task-removal-gate-unavailable',
      };
    }
    return serialized(request.sourceDeliveryId, async () => {
      const turnAdmission = barrier(request.taskId);
      if (turnAdmission.kind !== 'open') {
        return {
          kind: 'admission-unavailable',
          reason:
            turnAdmission.kind === 'unavailable'
              ? turnAdmission.reason
              : 'task-removal-gate-unavailable',
        };
      }
      const result = await dependencies.draftRepository.reviseAfterUserEdit(request);
      if (result.kind === 'saved-manual-draft' || result.kind === 'replayed') {
        await releaseAutomaticLease(request.sourceDeliveryId);
      }
      return result;
    });
  }

  async function resolveManualAmbiguity(
    request: ResolveManualInitialPromptSendAmbiguityRequest,
  ): Promise<ResolveManualInitialPromptSendAmbiguityResult> {
    const unavailable = unavailableBeforeTaskLookup();
    if (unavailable) {
      return {
        error:
          unavailable === 'journal-unavailable'
            ? 'journal-unavailable'
            : 'task-removal-gate-unavailable',
        kind: 'rejected',
      };
    }
    const located = await dependencies.journal.findManualOperation(request.manualSendOperationId);
    if (!located) return { error: 'operation-not-ambiguous', kind: 'rejected' };
    return serialized(located.request.deliveryId, async () => {
      let record = await dependencies.journal.findManualOperation(request.manualSendOperationId);
      if (!record?.manualSendOperation) {
        return { error: 'operation-not-ambiguous', kind: 'rejected' };
      }
      const admission = barrier(record.request.taskId);
      if (admission.kind !== 'open') {
        return {
          error: 'task-removal-gate-unavailable',
          kind: 'rejected',
          ...(admission.kind === 'unavailable'
            ? {}
            : { current: await getProjectionFromRecord(record, admission.current) }),
        };
      }
      let operation = record.manualSendOperation;
      if (operation.phase === 'reconciled') {
        const resolution = operation.terminalReceipt?.outcome;
        if (
          resolution?.kind === 'reconciled' &&
          resolution.resolution === request.resolution &&
          request.expectedOperationVersion === operation.version - 1
        ) {
          return {
            kind: 'resolved',
            projection: await getManualOperationProjectionFromRecord(record, admission.current),
            replayed: true,
          };
        }
        return {
          current: await getProjectionFromRecord(record, admission.current),
          error: 'operation-version-changed',
          kind: 'rejected',
        };
      }
      if (operation.phase !== 'manual-reconciliation-required') {
        return {
          current: await getProjectionFromRecord(record, admission.current),
          error: 'operation-not-ambiguous',
          kind: 'rejected',
        };
      }
      if (operation.version !== request.expectedOperationVersion) {
        return {
          current: await getProjectionFromRecord(record, admission.current),
          error: 'operation-version-changed',
          kind: 'rejected',
        };
      }
      let clear:
        | Awaited<ReturnType<TaskInitialPromptDraftRepository['clearAfterAcceptedOutcome']>>
        | undefined;
      if (request.resolution === 'observed-sent') {
        clear = await dependencies.draftRepository.clearAfterAcceptedOutcome({
          deliveryId: operation.deliveryId,
          expectedDraftFingerprint: operation.acknowledgedDraftFingerprint,
          expectedEditRevision: operation.acknowledgedEditRevision,
          reason: 'manual-send-accepted',
          taskId: operation.taskId,
        });
        record = await loadRecordAfterDraftMutation(record);
        const refreshedOperation = record.manualSendOperation;
        if (
          !refreshedOperation ||
          refreshedOperation.phase !== 'manual-reconciliation-required' ||
          refreshedOperation.version !== request.expectedOperationVersion
        ) {
          throw new Error('Manual reconciliation changed during atomic draft mutation');
        }
        operation = refreshedOperation;
      }
      const recovery = { kind: 'none' } as const;
      const receipt = createAttemptReceipt({
        operation,
        outcome: {
          ...(clear ? { clear: clear.kind } : {}),
          kind: 'reconciled',
          resolution: request.resolution,
        },
        recovery,
        terminal: true,
      });
      record.manualSendOperation = completeManualOperation(operation, 'reconciled', receipt);
      record.manualSendHighWater = {
        acknowledgedDraftFingerprint: operation.acknowledgedDraftFingerprint,
        disposition: 'reconciled',
        highestAcknowledgedEditRevision: operation.acknowledgedEditRevision,
        operationId: operation.manualSendOperationId,
      };
      await dependencies.journal.save(record);
      return {
        kind: 'resolved',
        projection: await getManualOperationProjectionFromRecord(record, admission.current),
        replayed: false,
      };
    });
  }

  async function repairAfterRestart(): Promise<{
    ambiguousManualOperations: number;
    automaticManualRequired: number;
    completedAcceptedManualOperations: number;
    provenNotSentManualOperations: number;
  }> {
    if (!dependencies.journal.isAvailable()) {
      throw new Error('Initial prompt journal is unavailable for restart repair');
    }
    const counts = {
      ambiguousManualOperations: 0,
      automaticManualRequired: 0,
      completedAcceptedManualOperations: 0,
      provenNotSentManualOperations: 0,
    };
    const records = await dependencies.journal.listRecords();
    for (const candidate of records) {
      await serialized(candidate.request.deliveryId, async () => {
        const record = await dependencies.journal.load(candidate.request.deliveryId);
        if (!record) return;
        if (
          !isAutomaticTerminal(record.snapshot) &&
          (record.writeBegan ||
            record.snapshot.attempts > 0 ||
            record.snapshot.status === 'writing' ||
            record.snapshot.status === 'verifying' ||
            record.snapshot.status === 'retry-wait')
        ) {
          record.snapshot = {
            ...record.snapshot,
            reason: 'backend-recovered-ambiguous-write',
            status: 'manual-required',
            updatedAt: clock.toIso(clock.nowMs()),
            version: record.snapshot.version + 1,
          };
          counts.automaticManualRequired += 1;
          await dependencies.journal.save(record);
        }

        const operation = record.manualSendOperation;
        if (!operation || isManualInitialPromptSendSettled(operation)) {
          if (record.snapshot.status === 'delivered') {
            await dependencies.draftRepository.clearAfterAcceptedOutcome({
              deliveryId: record.request.deliveryId,
              expectedDraftFingerprint: record.expectedDraftFingerprint,
              expectedEditRevision: record.draftEditRevision,
              reason: 'automatic-delivered',
              taskId: record.request.taskId,
            });
          }
          return;
        }
        if (
          operation.phase === 'admitted' ||
          operation.phase === 'automation-sealed' ||
          operation.phase === 'confirmation-required' ||
          operation.phase === 'waiting-lease'
        ) {
          await persistManualFailure(record, { code: 'backend-restarted-before-write' });
          counts.provenNotSentManualOperations += 1;
          return;
        }
        if (operation.phase === 'write-intent-persisted') {
          const issue = { code: 'write-outcome-ambiguous' } as const;
          const recovery = getManualInitialPromptSendRecovery({
            failedAttempt: operation.attempt,
            issue,
            manualSendOperationId: operation.manualSendOperationId,
          });
          const receipt = createAttemptReceipt({
            operation,
            outcome: { issue, kind: 'write-outcome-ambiguous' },
            recovery,
            terminal: true,
          });
          record.manualSendOperation = completeManualOperation(
            operation,
            'manual-reconciliation-required',
            receipt,
          );
          await dependencies.journal.save(record);
          counts.ambiguousManualOperations += 1;
          return;
        }
        if (operation.phase === 'write-accepted') {
          const settlement = await settleAcceptedManualOperation(record);
          if (!settlement.completed) {
            throw new Error('Accepted manual prompt completion remains pending after restart');
          }
          counts.completedAcceptedManualOperations += 1;
          return;
        }
        await dependencies.journal.save(record);
      });
    }
    return counts;
  }

  async function getProjection(
    deliveryId: string,
  ): Promise<TaskInitialPromptDeliveryProjection | null> {
    // Projection is part of the eventual public owner surface. A direct call
    // must fail closed while dark just like every mutating entrypoint; loading
    // the private journal first would leak a partially cut-over owner.
    if (unavailableBeforeTaskLookup()) return null;
    const record = await dependencies.journal.load(deliveryId);
    if (!record) return null;
    const admission = barrier(record.request.taskId);
    if (admission.kind === 'unavailable') return null;
    return getProjectionFromRecord(record, admission.current);
  }

  async function drainTaskForRemoval(
    request: DrainTaskInitialPromptForRemovalRequest,
  ): Promise<DrainTaskInitialPromptForRemovalResult> {
    if (!dependencies.journal.isAvailable())
      return { kind: 'retry-required', retainedRecordCount: 0 };
    const records = await dependencies.journal.listTaskRecords(request.taskId);
    let changed = false;
    for (const record of records) {
      await serialized(record.request.deliveryId, async () => {
        const latest = await dependencies.journal.load(record.request.deliveryId);
        if (!latest) return;
        let needsSave = false;
        if (!isAutomaticTerminal(latest.snapshot)) {
          latest.snapshot = reduceTaskInitialPromptDelivery(
            latest.snapshot,
            { kind: 'task-closing' },
            clock.toIso(clock.nowMs()),
          ).snapshot;
          changed = true;
          needsSave = true;
        }
        const manual = latest.manualSendOperation;
        if (manual && !isManualInitialPromptSendSettled(manual)) {
          if (manual.phase === 'write-accepted') {
            const settlement = await settleAcceptedManualOperation(latest);
            if (!settlement.completed) {
              await releaseDeliveryLeases(record.request.deliveryId);
              throw new Error('Accepted manual prompt completion remains pending');
            }
            needsSave = false;
          } else if (manual.phase === 'write-intent-persisted') {
            const issue = { code: 'write-outcome-ambiguous' } as const;
            const recovery = getManualInitialPromptSendRecovery({
              failedAttempt: manual.attempt,
              issue,
              manualSendOperationId: manual.manualSendOperationId,
            });
            const receipt = createAttemptReceipt({
              operation: manual,
              outcome: { issue, kind: 'write-outcome-ambiguous' },
              recovery,
              terminal: true,
            });
            latest.manualSendOperation = completeManualOperation(
              manual,
              'manual-reconciliation-required',
              receipt,
            );
            needsSave = true;
          } else {
            await persistManualFailure(latest, { code: 'task-closing' });
            needsSave = false;
          }
          changed = true;
        }
        if (needsSave) await dependencies.journal.save(latest);
        await releaseDeliveryLeases(record.request.deliveryId);
        rateBuckets.delete(record.request.deliveryId);
      });
    }
    return {
      kind: changed ? 'complete' : 'already-complete',
      retainedRecordCount: records.length,
    };
  }

  async function finalizeRemovedTaskInitialPromptState(
    request: FinalizeRemovedTaskInitialPromptStateRequest,
  ): Promise<FinalizeRemovedTaskInitialPromptStateResult> {
    if (!dependencies.journal.isAvailable()) {
      return { kind: 'retry-required', reason: 'journal-unavailable' };
    }
    if (!dependencies.removalGate.verifyCommittedRemoval(request)) {
      return { kind: 'retry-required', reason: 'removal-witness-mismatch' };
    }
    return { kind: await dependencies.journal.deleteTaskRecords(request.taskId) };
  }

  async function releaseAllRetainedLeases(
    leases: Map<string, TaskInitialPromptCommandLease>,
    releases: Map<string, Promise<void>>,
  ): Promise<void> {
    const keys = [...leases.keys()];
    const firstRelease = await Promise.allSettled(
      keys.map((key) => releaseRetainedLease(key, leases, releases)),
    );
    const retryKeys = keys.filter((_key, index) => firstRelease[index]?.status === 'rejected');
    await Promise.allSettled(retryKeys.map((key) => releaseRetainedLease(key, leases, releases)));
    releases.clear();
    leases.clear();
  }

  return {
    async close() {
      if (closed) return;
      closed = true;
      rateBuckets.clear();
      await Promise.all([
        releaseAllRetainedLeases(automaticLeases, automaticLeaseReleases),
        releaseAllRetainedLeases(manualLeases, manualLeaseReleases),
      ]);
    },
    drainTaskForRemoval,
    expireDueDelivery,
    finalizeRemovedTaskInitialPromptState,
    getProjection,
    getResourceDiagnostics: () => ({
      automaticLeaseCount: automaticLeases.size,
      manualLeaseCount: manualLeases.size,
      rateBucketCount: rateBuckets.size,
    }),
    getOwnerAvailability: dependencies.getOwnerAvailability,
    probeRemovalHooks: () => ({
      drainHookVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
      finalizerHookVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
    }),
    processObservation,
    queue,
    repairAfterRestart,
    resolveManualAmbiguity,
    reviseDraft,
    sendManually,
  };
}

export function queueTaskInitialPromptForDelivery(
  service: TaskInitialPromptDeliveryService,
  request: TaskInitialPromptDeliveryRequest,
): Promise<QueueTaskInitialPromptDeliveryResult> {
  return service.queue(request);
}

export function sendTaskInitialPromptManually(
  service: TaskInitialPromptDeliveryService,
  request: SendTaskInitialPromptManuallyRequest,
): Promise<SendTaskInitialPromptManuallyResult> {
  return service.sendManually(request);
}

export function finalizeRemovedTaskInitialPromptState(
  service: TaskInitialPromptDeliveryService,
  request: FinalizeRemovedTaskInitialPromptStateRequest,
): Promise<FinalizeRemovedTaskInitialPromptStateResult> {
  return service.finalizeRemovedTaskInitialPromptState(request);
}

export const TASK_INITIAL_PROMPT_MANUAL_RATE_BURST = MANUAL_INITIAL_PROMPT_SEND_RATE_LIMIT.burst;
