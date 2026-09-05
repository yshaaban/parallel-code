import {
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  deriveLegacyTaskInitialPromptDeliveryId,
  deriveTaskInitialPromptDraftFingerprint,
  isLowercaseSha256Fingerprint,
  isManualInitialPromptSendHighWaterForDelivery,
  isManualInitialPromptSendOperationForDelivery,
  isTaskInitialPromptDeliveryRequest,
  isTaskInitialPromptDeliverySnapshot,
  isTaskInitialPromptDraftWithinLimit,
  type ManualInitialPromptSendOperationSnapshot,
  reduceTaskInitialPromptDelivery,
  type ReviseTaskInitialPromptDraftRequest,
  type ReviseTaskInitialPromptDraftResult,
  type TaskInitialPromptDeliverySnapshot,
  type TaskInitialPromptDraftSnapshot,
} from '../../src/domain/task-initial-prompt-delivery.js';
import {
  activateProtectedPolicies,
  changed,
  getProtectedPolicyVersions,
  unchanged,
  type WorkspaceMutationService,
  type WorkspacePrivateMutationAuthority,
} from './workspace-state-mutations.js';
import { cloneJsonObject, type JsonObject, type JsonValue } from './workspace-state-storage.js';
import {
  compactAcknowledgedAutomaticReplayRecord,
  isAcknowledgedAutomaticReplayRecord,
  selectAcknowledgedAutomaticRichReplayIdsToCompact,
  type TaskInitialPromptDeliveryJournal,
  type TaskInitialPromptDeliveryJournalRecord,
  type TaskInitialPromptDraftRepository,
} from './task-initial-prompt-delivery.js';

const JOURNAL_KEY = 'initialPromptDeliveryJournal';
const OWNER_SCHEMA_KEY = 'initialPromptDeliveryOwnerSchema';
const JOURNAL_SCHEMA_VERSION = 1;
const MAX_JOURNAL_RECORDS = 4_096;
const MAX_RECORD_BYTES = 16_384;

interface PromptJournalState {
  deliveryIdByManualOperationId: Record<string, string>;
  deliveryIdsByTaskId: Record<string, string[]>;
  recordsByDeliveryId: Record<string, JsonObject>;
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
}

type PromptDraftClearResult = {
  kind: 'cleared' | 'already-cleared' | 'draft-changed';
  workspaceRevision: number;
};

type PromptDraftReviseResult = Exclude<
  ReviseTaskInitialPromptDraftResult,
  { kind: 'admission-unavailable' }
>;

export interface TaskInitialPromptProtectionCutoverResult {
  cutoverEpoch: string;
  hookSetVersion: typeof TASK_INITIAL_PROMPT_HOOK_SET_VERSION;
  legacyWritersDisabled: true;
  migratedLegacyDrafts: number;
  protectedPolicyVersion: '1';
}

export interface WorkspaceTaskInitialPromptPersistence {
  activatePromptProtectionAndDisableLegacyWriters(
    cutoverEpoch: string,
  ): Promise<TaskInitialPromptProtectionCutoverResult>;
  ensureDarkJournalReady(): Promise<void>;
  journal: TaskInitialPromptDeliveryJournal;
  repository: TaskInitialPromptDraftRepository;
  verifyPromptProtectionCutover(cutoverEpoch: string): Promise<void>;
}

export class TaskInitialPromptPersistenceRecoveryError extends Error {
  readonly code = 'initial-prompt-persistence-recovery-required';
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createEmptyJournal(): PromptJournalState {
  return {
    deliveryIdByManualOperationId: {},
    deliveryIdsByTaskId: {},
    recordsByDeliveryId: {},
    schemaVersion: JOURNAL_SCHEMA_VERSION,
  };
}

function isStringRecord(value: JsonValue | undefined): value is JsonObject {
  return isJsonObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isStringArrayRecord(value: JsonValue | undefined): value is JsonObject {
  return (
    isJsonObject(value) &&
    Object.values(value).every(
      (entry) => Array.isArray(entry) && entry.every((item) => typeof item === 'string'),
    )
  );
}

function containsPromptText(value: JsonValue, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsPromptText(entry, seen));
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'text' || key === 'promptText' || key === 'initialPrompt') return true;
    if (containsPromptText(entry, seen)) return true;
  }
  return false;
}

function hasExactJsonKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => key in value);
}

function isFiniteTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function hasFiniteManualOperationTimestamps(
  operation: ManualInitialPromptSendOperationSnapshot,
): boolean {
  return (
    isFiniteTimestamp(operation.createdAt) &&
    isFiniteTimestamp(operation.updatedAt) &&
    (operation.latestAttemptReceipt === undefined ||
      isFiniteTimestamp(operation.latestAttemptReceipt.completedAt)) &&
    (operation.terminalReceipt === undefined ||
      isFiniteTimestamp(operation.terminalReceipt.completedAt))
  );
}

function hasCoherentManualOperationReceipts(
  operation: ManualInitialPromptSendOperationSnapshot,
): boolean {
  const latest = operation.latestAttemptReceipt;
  const terminal = operation.terminalReceipt;
  if (latest && (latest.terminal || latest.outcome.kind !== 'not-sent')) return false;

  switch (operation.phase) {
    case 'admitted':
    case 'automation-sealed':
    case 'confirmation-required':
    case 'waiting-lease':
    case 'write-intent-persisted':
    case 'write-accepted':
      return terminal === undefined;
    case 'failed-before-write':
      if (!terminal) return latest !== undefined;
      return (
        latest === undefined &&
        terminal.outcome.kind === 'not-sent' &&
        terminal.outcome.issue.code === 'task-closing' &&
        terminal.recovery.kind === 'none'
      );
    case 'completed':
      return (
        latest === undefined &&
        terminal?.outcome.kind === 'sent' &&
        terminal.recovery.kind === 'none'
      );
    case 'manual-reconciliation-required':
      return (
        latest === undefined &&
        terminal?.outcome.kind === 'write-outcome-ambiguous' &&
        terminal.recovery.kind === 'inspect-terminal-and-copy-exact-draft'
      );
    case 'reconciled':
      return (
        latest === undefined &&
        terminal?.outcome.kind === 'reconciled' &&
        terminal.recovery.kind === 'none'
      );
  }
}

function isEditHighWater(
  value: JsonValue | undefined,
  expectedDraftFingerprint: string,
  draftEditRevision: number,
): boolean {
  return (
    isJsonObject(value) &&
    hasExactJsonKeys(value, [
      'editSealed',
      'highestEditRevision',
      'highestInputFingerprint',
      'highestOperationId',
    ]) &&
    typeof value.editSealed === 'boolean' &&
    value.highestEditRevision === draftEditRevision &&
    value.highestInputFingerprint === expectedDraftFingerprint &&
    typeof value.highestOperationId === 'string' &&
    value.highestOperationId.length > 0 &&
    value.highestOperationId.length <= 1_024
  );
}

function isReadyCandidate(
  value: JsonValue | undefined,
  targetGeneration: number | undefined,
): boolean {
  return (
    isJsonObject(value) &&
    hasExactJsonKeys(value, ['generation', 'normalizedFrameFingerprint', 'observedAtMs']) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) >= 0 &&
    (targetGeneration === undefined || value.generation === targetGeneration) &&
    typeof value.normalizedFrameFingerprint === 'string' &&
    isLowercaseSha256Fingerprint(value.normalizedFrameFingerprint) &&
    Number.isSafeInteger(value.observedAtMs) &&
    (value.observedAtMs as number) >= 0
  );
}

function isJournalSnapshotStateCoherent(args: {
  hasReadyDeadline: boolean;
  preWriteReadyFingerprint: JsonValue | undefined;
  readyCandidate: JsonValue | undefined;
  snapshot: TaskInitialPromptDeliverySnapshot;
  writeBegan: boolean;
}): boolean {
  const { snapshot } = args;
  const noSessionEvidence =
    snapshot.targetGeneration === undefined &&
    !args.hasReadyDeadline &&
    args.readyCandidate === undefined &&
    args.preWriteReadyFingerprint === undefined &&
    !args.writeBegan;
  switch (snapshot.status) {
    case 'queued':
    case 'waiting-agent-session':
      return snapshot.attempts === 0 && noSessionEvidence;
    case 'waiting-ready':
    case 'waiting-lease':
      return (
        snapshot.targetGeneration !== undefined &&
        snapshot.attempts <= 1 &&
        args.writeBegan === snapshot.attempts > 0
      );
    case 'writing':
      return snapshot.targetGeneration !== undefined && snapshot.attempts <= 1;
    case 'retry-wait':
      return snapshot.targetGeneration !== undefined && snapshot.attempts === 1;
    case 'verifying':
    case 'delivered':
      return snapshot.targetGeneration !== undefined && snapshot.attempts > 0;
    case 'cancelled':
      return snapshot.attempts === 0 && !args.writeBegan;
    case 'manual-required':
      return true;
  }
}

function isJournalRecord(value: JsonObject, deliveryId: string): boolean {
  const request = value.request;
  const snapshot = value.snapshot;
  const hasReadyDeadline = value.automaticReadyDeadlineAtMs !== undefined;
  const hasReadyDeadlineExtension = value.automaticReadyDeadlineExtensionUsed !== undefined;
  const editHighWater = value.editHighWater;
  const manualSendHighWater = value.manualSendHighWater;
  const manualSendOperation = value.manualSendOperation;
  const preWriteReadyFingerprint = value.preWriteReadyFingerprint;
  const readyCandidate = value.readyCandidate;
  if (
    !hasExactJsonKeys(value, [
      'automationSealed',
      ...(hasReadyDeadline ? ['automaticReadyDeadlineAtMs'] : []),
      ...(hasReadyDeadlineExtension ? ['automaticReadyDeadlineExtensionUsed'] : []),
      'draftEditRevision',
      ...(editHighWater === undefined ? [] : ['editHighWater']),
      'expectedDraftFingerprint',
      ...(manualSendHighWater === undefined ? [] : ['manualSendHighWater']),
      ...(manualSendOperation === undefined ? [] : ['manualSendOperation']),
      ...(preWriteReadyFingerprint === undefined ? [] : ['preWriteReadyFingerprint']),
      ...(readyCandidate === undefined ? [] : ['readyCandidate']),
      'request',
      'schemaVersion',
      'snapshot',
      'writeBegan',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.automationSealed !== 'boolean' ||
    typeof value.writeBegan !== 'boolean' ||
    typeof value.draftEditRevision !== 'number' ||
    !Number.isSafeInteger(value.draftEditRevision) ||
    value.draftEditRevision < 0 ||
    typeof value.expectedDraftFingerprint !== 'string' ||
    !isLowercaseSha256Fingerprint(value.expectedDraftFingerprint) ||
    hasReadyDeadline !== hasReadyDeadlineExtension ||
    (hasReadyDeadline &&
      (typeof value.automaticReadyDeadlineAtMs !== 'number' ||
        !Number.isSafeInteger(value.automaticReadyDeadlineAtMs) ||
        value.automaticReadyDeadlineAtMs < 0)) ||
    (hasReadyDeadlineExtension && typeof value.automaticReadyDeadlineExtensionUsed !== 'boolean') ||
    !isTaskInitialPromptDeliveryRequest(request) ||
    request.deliveryId !== deliveryId ||
    !isTaskInitialPromptDeliverySnapshot(snapshot) ||
    snapshot.deliveryId !== deliveryId ||
    snapshot.taskId !== request.taskId ||
    snapshot.agentId !== request.agentId ||
    !isFiniteTimestamp(snapshot.createdAt) ||
    !isFiniteTimestamp(snapshot.updatedAt)
  ) {
    return false;
  }

  const terminal =
    snapshot.status === 'cancelled' ||
    snapshot.status === 'delivered' ||
    snapshot.status === 'manual-required';
  return (
    (editHighWater === undefined ||
      isEditHighWater(
        editHighWater,
        value.expectedDraftFingerprint,
        value.draftEditRevision as number,
      )) &&
    (preWriteReadyFingerprint === undefined ||
      (typeof preWriteReadyFingerprint === 'string' &&
        isLowercaseSha256Fingerprint(preWriteReadyFingerprint) &&
        value.writeBegan)) &&
    (readyCandidate === undefined || isReadyCandidate(readyCandidate, snapshot.targetGeneration)) &&
    (manualSendHighWater === undefined ||
      isManualInitialPromptSendHighWaterForDelivery(manualSendHighWater, snapshot)) &&
    (manualSendOperation === undefined ||
      (isManualInitialPromptSendOperationForDelivery(manualSendOperation, snapshot) &&
        hasFiniteManualOperationTimestamps(manualSendOperation) &&
        hasCoherentManualOperationReceipts(manualSendOperation) &&
        value.automationSealed)) &&
    (snapshot.attempts === 0 || value.writeBegan) &&
    (!value.automationSealed || terminal) &&
    isJournalSnapshotStateCoherent({
      hasReadyDeadline,
      preWriteReadyFingerprint,
      readyCandidate,
      snapshot,
      writeBegan: value.writeBegan,
    }) &&
    !containsPromptText(value)
  );
}

function readJournal(privateState: JsonObject): PromptJournalState {
  const raw = privateState[JOURNAL_KEY];
  if (!isJsonObject(raw)) {
    throw new TaskInitialPromptPersistenceRecoveryError('Initial prompt journal is missing');
  }
  if (
    raw.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    !isJsonObject(raw.recordsByDeliveryId) ||
    !isStringArrayRecord(raw.deliveryIdsByTaskId) ||
    !isStringRecord(raw.deliveryIdByManualOperationId)
  ) {
    throw new TaskInitialPromptPersistenceRecoveryError('Initial prompt journal schema is invalid');
  }
  const recordEntries = Object.entries(raw.recordsByDeliveryId);
  if (recordEntries.length > MAX_JOURNAL_RECORDS) {
    throw new TaskInitialPromptPersistenceRecoveryError('Initial prompt journal exceeds its bound');
  }
  for (const [deliveryId, value] of recordEntries) {
    if (!isJsonObject(value) || !isJournalRecord(value, deliveryId)) {
      throw new TaskInitialPromptPersistenceRecoveryError(
        `Initial prompt journal record ${deliveryId} is invalid`,
      );
    }
    const request = value.request as JsonObject;
    const taskDeliveryIds = raw.deliveryIdsByTaskId[String(request.taskId)];
    if (
      !Array.isArray(taskDeliveryIds) ||
      taskDeliveryIds.filter((candidate) => candidate === deliveryId).length !== 1
    ) {
      throw new TaskInitialPromptPersistenceRecoveryError(
        `Initial prompt journal record ${deliveryId} is missing from its task index`,
      );
    }
    const manualOperation = value.manualSendOperation;
    if (
      isJsonObject(manualOperation) &&
      raw.deliveryIdByManualOperationId[String(manualOperation.manualSendOperationId)] !==
        deliveryId
    ) {
      throw new TaskInitialPromptPersistenceRecoveryError(
        `Initial prompt journal record ${deliveryId} is missing from its manual-operation index`,
      );
    }
  }
  for (const [taskId, deliveryIdsValue] of Object.entries(raw.deliveryIdsByTaskId)) {
    const deliveryIds = deliveryIdsValue as JsonValue[];
    if (new Set(deliveryIds).size !== deliveryIds.length) {
      throw new TaskInitialPromptPersistenceRecoveryError(
        `Initial prompt task index ${taskId} contains duplicates`,
      );
    }
    for (const deliveryId of deliveryIds) {
      if (typeof deliveryId !== 'string') continue;
      const record = raw.recordsByDeliveryId[deliveryId];
      if (
        !isJsonObject(record) ||
        !isJsonObject(record.request) ||
        record.request.taskId !== taskId
      ) {
        throw new TaskInitialPromptPersistenceRecoveryError(
          `Initial prompt task index ${taskId} is inconsistent`,
        );
      }
    }
  }
  for (const [operationId, deliveryIdValue] of Object.entries(raw.deliveryIdByManualOperationId)) {
    if (typeof deliveryIdValue !== 'string') continue;
    const record = raw.recordsByDeliveryId[deliveryIdValue];
    if (
      !isJsonObject(record) ||
      !isJsonObject(record.manualSendOperation) ||
      record.manualSendOperation.manualSendOperationId !== operationId
    ) {
      throw new TaskInitialPromptPersistenceRecoveryError(
        `Initial prompt manual-operation index ${operationId} is inconsistent`,
      );
    }
  }
  return {
    deliveryIdByManualOperationId: Object.fromEntries(
      Object.entries(raw.deliveryIdByManualOperationId).map(([key, value]) => [key, String(value)]),
    ),
    deliveryIdsByTaskId: Object.fromEntries(
      Object.entries(raw.deliveryIdsByTaskId).map(([key, value]) => [
        key,
        [...(value as string[])],
      ]),
    ),
    recordsByDeliveryId: cloneJsonObject(raw.recordsByDeliveryId) as Record<string, JsonObject>,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
  };
}

function withJournal(privateState: JsonObject, journal: PromptJournalState): JsonObject {
  return {
    ...cloneJsonObject(privateState),
    [JOURNAL_KEY]: journal as unknown as JsonObject,
  };
}

function toJsonRecord(record: TaskInitialPromptDeliveryJournalRecord): JsonObject {
  const serialized = JSON.stringify(record);
  if (new TextEncoder().encode(serialized).length > MAX_RECORD_BYTES) {
    throw new TaskInitialPromptPersistenceRecoveryError(
      'Initial prompt journal record exceeds its byte bound',
    );
  }
  const value = JSON.parse(serialized) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskInitialPromptPersistenceRecoveryError('Initial prompt journal record is invalid');
  }
  const object = value as JsonObject;
  if (!isJournalRecord(object, record.request.deliveryId)) {
    throw new TaskInitialPromptPersistenceRecoveryError(
      'Initial prompt journal record contains invalid or forbidden data',
    );
  }
  return object;
}

function fromJsonRecord(value: JsonObject): TaskInitialPromptDeliveryJournalRecord {
  return structuredClone(value) as unknown as TaskInitialPromptDeliveryJournalRecord;
}

function requireTasks(sharedState: JsonObject): JsonObject {
  const tasks = sharedState.tasks;
  if (!isJsonObject(tasks)) {
    throw new TaskInitialPromptPersistenceRecoveryError('Canonical tasks are invalid');
  }
  return tasks;
}

function getTaskAgentId(task: JsonObject): string | null {
  if (typeof task.agentId === 'string' && task.agentId.length > 0) return task.agentId;
  if (Array.isArray(task.agentIds)) {
    const first = task.agentIds.find((value) => typeof value === 'string' && value.length > 0);
    if (typeof first === 'string') return first;
  }
  return null;
}

function getTaskDraft(
  taskId: string,
  task: JsonObject,
  journal: PromptJournalState,
  expectedDeliveryId?: string,
): TaskInitialPromptDraftSnapshot | null {
  const text = task.initialPrompt;
  const deliveryId = task.initialPromptDeliveryId;
  const agentId = getTaskAgentId(task);
  if (
    typeof text !== 'string' ||
    typeof deliveryId !== 'string' ||
    (expectedDeliveryId !== undefined && deliveryId !== expectedDeliveryId) ||
    !agentId
  ) {
    return null;
  }
  const recordValue = journal.recordsByDeliveryId[deliveryId];
  const editRevision =
    isJsonObject(recordValue) && Number.isSafeInteger(recordValue.draftEditRevision)
      ? (recordValue.draftEditRevision as number)
      : 0;
  return {
    editRevision,
    fingerprint: deriveTaskInitialPromptDraftFingerprint({
      agentId,
      readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
      taskId,
      text,
    }),
    mode: task.initialPromptDeliveryMode === 'manual-only' ? 'manual-only' : 'automatic',
    text,
    workspaceRevision: 0,
  };
}

function setRecordInJournal(
  journal: PromptJournalState,
  record: TaskInitialPromptDeliveryJournalRecord,
): void {
  const deliveryId = record.request.deliveryId;
  const prior = journal.recordsByDeliveryId[deliveryId];
  const priorManualId =
    isJsonObject(prior) && isJsonObject(prior.manualSendOperation)
      ? prior.manualSendOperation.manualSendOperationId
      : undefined;
  const nextManualId = record.manualSendOperation?.manualSendOperationId;
  if (typeof priorManualId === 'string' && priorManualId !== nextManualId) {
    Reflect.deleteProperty(journal.deliveryIdByManualOperationId, priorManualId);
  }
  journal.recordsByDeliveryId[deliveryId] = toJsonRecord(record);
  const taskIds = journal.deliveryIdsByTaskId[record.request.taskId] ?? [];
  if (!taskIds.includes(deliveryId)) {
    journal.deliveryIdsByTaskId[record.request.taskId] = [...taskIds, deliveryId];
  }
  if (nextManualId) journal.deliveryIdByManualOperationId[nextManualId] = deliveryId;
  if (isAcknowledgedAutomaticReplayRecord(record)) compactRichAutomaticReplayWindow(journal);
}

function compactRichAutomaticReplayWindow(journal: PromptJournalState): boolean {
  const records = Object.values(journal.recordsByDeliveryId).map(fromJsonRecord);
  const deliveryIds = selectAcknowledgedAutomaticRichReplayIdsToCompact(records);
  for (const deliveryId of deliveryIds) {
    const value = journal.recordsByDeliveryId[deliveryId];
    if (!value) continue;
    journal.recordsByDeliveryId[deliveryId] = toJsonRecord(
      compactAcknowledgedAutomaticReplayRecord(fromJsonRecord(value)),
    );
  }
  return deliveryIds.length > 0;
}

function getOwnerSchema(privateState: JsonObject): JsonObject | null {
  const schema = privateState[OWNER_SCHEMA_KEY];
  if (schema === undefined) return null;
  if (!isJsonObject(schema)) {
    throw new TaskInitialPromptPersistenceRecoveryError('Initial prompt owner schema is invalid');
  }
  return schema;
}

export function createWorkspaceTaskInitialPromptPersistence(
  workspace: WorkspaceMutationService,
  options: { privateAuthority?: WorkspacePrivateMutationAuthority; now?: () => number } = {},
): WorkspaceTaskInitialPromptPersistence {
  const authority = options.privateAuthority ?? workspace.createPrivateMutationAuthority();
  const now = options.now ?? Date.now;
  let journalHealthy = false;

  async function ensureDarkJournalReady(): Promise<void> {
    await authority.mutate({ operation: 'prepare-dark-initial-prompt-journal' }, (slices) => {
      if (slices.privateState[JOURNAL_KEY] === undefined) {
        return changed(
          { nextPrivateState: withJournal(slices.privateState, createEmptyJournal()) },
          undefined,
        );
      }
      const state = readJournal(slices.privateState);
      if (compactRichAutomaticReplayWindow(state)) {
        return changed({ nextPrivateState: withJournal(slices.privateState, state) }, undefined);
      }
      return unchanged(undefined);
    });
    await authority.mutate({ operation: 'verify-dark-initial-prompt-journal' }, (slices) => {
      readJournal(slices.privateState);
      return unchanged(undefined);
    });
    journalHealthy = true;
  }

  function requireHealthy(): void {
    if (!journalHealthy) {
      throw new TaskInitialPromptPersistenceRecoveryError(
        'Initial prompt journal startup barrier is incomplete',
      );
    }
  }

  const journal: TaskInitialPromptDeliveryJournal = {
    async deleteTaskRecords(taskId) {
      requireHealthy();
      const result = await authority.mutate<'complete' | 'already-complete'>(
        { operation: 'finalize-removed-task-initial-prompt-state' },
        (slices) => {
          const state = readJournal(slices.privateState);
          const deliveryIds = state.deliveryIdsByTaskId[taskId] ?? [];
          if (deliveryIds.length === 0) return unchanged<'already-complete'>('already-complete');
          for (const deliveryId of deliveryIds) {
            const record = state.recordsByDeliveryId[deliveryId];
            if (isJsonObject(record) && isJsonObject(record.manualSendOperation)) {
              const operationId = record.manualSendOperation.manualSendOperationId;
              if (typeof operationId === 'string') {
                Reflect.deleteProperty(state.deliveryIdByManualOperationId, operationId);
              }
            }
            Reflect.deleteProperty(state.recordsByDeliveryId, deliveryId);
          }
          Reflect.deleteProperty(state.deliveryIdsByTaskId, taskId);
          return changed(
            { nextPrivateState: withJournal(slices.privateState, state) },
            'complete' as const,
          );
        },
      );
      return result.result;
    },
    async findManualOperation(manualSendOperationId) {
      requireHealthy();
      const result = await authority.mutate<TaskInitialPromptDeliveryJournalRecord | null>(
        { operation: 'read-initial-prompt-manual-operation' },
        (slices) => {
          const state = readJournal(slices.privateState);
          const deliveryId = state.deliveryIdByManualOperationId[manualSendOperationId];
          const value = deliveryId ? state.recordsByDeliveryId[deliveryId] : undefined;
          return unchanged(value && isJsonObject(value) ? fromJsonRecord(value) : null);
        },
      );
      return result.result;
    },
    isAvailable: () => journalHealthy,
    async listRecords() {
      requireHealthy();
      const result = await authority.mutate(
        { operation: 'list-initial-prompt-journal-records' },
        (slices) =>
          unchanged(
            Object.values(readJournal(slices.privateState).recordsByDeliveryId).map(fromJsonRecord),
          ),
      );
      return result.result;
    },
    async listTaskRecords(taskId) {
      requireHealthy();
      const result = await authority.mutate(
        { operation: 'list-task-initial-prompt-journal-records' },
        (slices) => {
          const state = readJournal(slices.privateState);
          return unchanged(
            (state.deliveryIdsByTaskId[taskId] ?? []).map((deliveryId) => {
              const value = state.recordsByDeliveryId[deliveryId];
              if (!value) {
                throw new TaskInitialPromptPersistenceRecoveryError(
                  `Initial prompt record ${deliveryId} is missing from its task index`,
                );
              }
              return fromJsonRecord(value);
            }),
          );
        },
      );
      return result.result;
    },
    async load(deliveryId) {
      requireHealthy();
      const result = await authority.mutate(
        { operation: 'read-initial-prompt-journal-record' },
        (slices) => {
          const value = readJournal(slices.privateState).recordsByDeliveryId[deliveryId];
          return unchanged(value ? fromJsonRecord(value) : null);
        },
      );
      return result.result;
    },
    async save(record) {
      requireHealthy();
      await authority.mutate({ operation: 'write-initial-prompt-journal-record' }, (slices) => {
        const state = readJournal(slices.privateState);
        if (
          state.recordsByDeliveryId[record.request.deliveryId] === undefined &&
          Object.keys(state.recordsByDeliveryId).length >= MAX_JOURNAL_RECORDS
        ) {
          throw new TaskInitialPromptPersistenceRecoveryError(
            'Initial prompt journal has no record capacity',
          );
        }
        setRecordInJournal(state, record);
        return changed({ nextPrivateState: withJournal(slices.privateState, state) }, undefined);
      });
    },
  };

  async function loadCurrentDraft(
    taskId: string,
    deliveryId: string,
  ): Promise<TaskInitialPromptDraftSnapshot | null> {
    requireHealthy();
    const result = await authority.mutate(
      { operation: 'read-current-initial-prompt-draft' },
      (slices) => {
        const taskValue = requireTasks(slices.sharedState)[taskId];
        if (!isJsonObject(taskValue)) return unchanged(null);
        return unchanged(
          getTaskDraft(taskId, taskValue, readJournal(slices.privateState), deliveryId),
        );
      },
    );
    return result.result ? { ...result.result, workspaceRevision: result.revision } : null;
  }

  const repository: TaskInitialPromptDraftRepository = {
    async clearAfterAcceptedOutcome(args) {
      requireHealthy();
      const result = await authority.mutate<PromptDraftClearResult>(
        { operation: `clear-initial-prompt-${args.reason}` },
        (slices) => {
          const tasks = requireTasks(slices.sharedState);
          const taskValue = tasks[args.taskId];
          if (!isJsonObject(taskValue)) {
            return unchanged({ kind: 'already-cleared' as const, workspaceRevision: 0 });
          }
          const state = readJournal(slices.privateState);
          const current = getTaskDraft(args.taskId, taskValue, state, args.deliveryId);
          const recordValue = state.recordsByDeliveryId[args.deliveryId];
          if (!current) {
            if (isJsonObject(recordValue)) {
              const record = fromJsonRecord(recordValue);
              record.editHighWater = {
                editSealed: true,
                highestEditRevision: args.expectedEditRevision,
                highestInputFingerprint: args.expectedDraftFingerprint,
                highestOperationId: record.editHighWater?.highestOperationId ?? 'clear',
              };
              setRecordInJournal(state, record);
              return changed(
                { nextPrivateState: withJournal(slices.privateState, state) },
                { kind: 'already-cleared' as const, workspaceRevision: 0 },
              );
            }
            return unchanged({ kind: 'already-cleared' as const, workspaceRevision: 0 });
          }
          if (
            current.fingerprint !== args.expectedDraftFingerprint ||
            current.editRevision !== args.expectedEditRevision
          ) {
            return unchanged({ kind: 'draft-changed' as const, workspaceRevision: 0 });
          }
          const nextTask = cloneJsonObject(taskValue);
          for (const field of [
            'initialPrompt',
            'initialPromptDeliveryId',
            'initialPromptDeliveryMode',
            'savedInitialPrompt',
          ]) {
            Reflect.deleteProperty(nextTask, field);
          }
          const nextTasks = cloneJsonObject(tasks);
          nextTasks[args.taskId] = nextTask;
          const nextShared = cloneJsonObject(slices.sharedState);
          nextShared.tasks = nextTasks;
          if (isJsonObject(recordValue)) {
            const record = fromJsonRecord(recordValue);
            record.editHighWater = {
              editSealed: true,
              highestEditRevision: args.expectedEditRevision,
              highestInputFingerprint: args.expectedDraftFingerprint,
              highestOperationId: record.editHighWater?.highestOperationId ?? 'clear',
            };
            setRecordInJournal(state, record);
          }
          return changed(
            {
              nextPrivateState: withJournal(slices.privateState, state),
              nextSharedState: nextShared,
            },
            { kind: 'cleared' as const, workspaceRevision: 0 },
          );
        },
      );
      return { ...result.result, workspaceRevision: result.revision };
    },
    loadCurrentDraft,
    async loadExactDraft(args) {
      const current = await loadCurrentDraft(args.taskId, args.deliveryId);
      if (
        !current ||
        current.fingerprint !== args.expectedDraftFingerprint ||
        (args.expectedEditRevision !== undefined &&
          current.editRevision !== args.expectedEditRevision)
      ) {
        throw new TaskInitialPromptPersistenceRecoveryError(
          'Initial prompt draft no longer matches the acknowledged snapshot',
        );
      }
      return current;
    },
    async reviseAfterUserEdit(
      request: ReviseTaskInitialPromptDraftRequest,
    ): Promise<Exclude<ReviseTaskInitialPromptDraftResult, { kind: 'admission-unavailable' }>> {
      requireHealthy();
      if (!isTaskInitialPromptDraftWithinLimit(request.revisedText)) {
        throw new TaskInitialPromptPersistenceRecoveryError(
          'Revised initial prompt exceeds the UTF-8 byte limit',
        );
      }
      const result = await authority.mutate<PromptDraftReviseResult>(
        { operation: 'revise-initial-prompt-draft' },
        (slices) => {
          const tasks = requireTasks(slices.sharedState);
          const taskValue = tasks[request.taskId];
          if (!isJsonObject(taskValue)) {
            return unchanged({ current: null, kind: 'task-missing' as const });
          }
          const state = readJournal(slices.privateState);
          const recordValue = state.recordsByDeliveryId[request.sourceDeliveryId];
          if (!isJsonObject(recordValue)) {
            return unchanged({ current: null, kind: 'delivery-closed' as const });
          }
          const record = fromJsonRecord(recordValue);
          const current = getTaskDraft(request.taskId, taskValue, state, request.sourceDeliveryId);
          if (record.editHighWater?.editSealed || !current) {
            return unchanged({ current, kind: 'delivery-closed' as const });
          }
          const nextRevision = request.expectedEditRevision + 1;
          if (
            record.editHighWater?.highestOperationId === request.editOperationId &&
            record.editHighWater.highestEditRevision === nextRevision
          ) {
            return unchanged({ current, kind: 'replayed' as const });
          }
          if (
            record.editHighWater &&
            record.editHighWater.highestEditRevision > request.expectedEditRevision
          ) {
            return unchanged({
              current,
              kind:
                record.editHighWater.highestEditRevision === nextRevision
                  ? ('draft-conflict' as const)
                  : ('stale-edit' as const),
            });
          }
          if (
            current.fingerprint !== request.expectedDraftFingerprint ||
            current.editRevision !== request.expectedEditRevision
          ) {
            return unchanged({ current, kind: 'draft-conflict' as const });
          }
          const agentId = getTaskAgentId(taskValue);
          if (!agentId) {
            return unchanged({ current, kind: 'task-missing' as const });
          }
          const fingerprint = deriveTaskInitialPromptDraftFingerprint({
            agentId,
            readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
            taskId: request.taskId,
            text: request.revisedText,
          });
          const nextTask = cloneJsonObject(taskValue);
          nextTask.initialPrompt = request.revisedText;
          nextTask.initialPromptDeliveryId = request.sourceDeliveryId;
          nextTask.initialPromptDeliveryMode = 'manual-only';
          Reflect.deleteProperty(nextTask, 'savedInitialPrompt');
          const nextTasks = cloneJsonObject(tasks);
          nextTasks[request.taskId] = nextTask;
          const nextShared = cloneJsonObject(slices.sharedState);
          nextShared.tasks = nextTasks;
          record.draftEditRevision = nextRevision;
          record.expectedDraftFingerprint = fingerprint;
          record.editHighWater = {
            editSealed: false,
            highestEditRevision: nextRevision,
            highestInputFingerprint: fingerprint,
            highestOperationId: request.editOperationId,
          };
          record.snapshot = reduceTaskInitialPromptDelivery(
            record.snapshot,
            { kind: 'edit-accepted' },
            new Date(now()).toISOString(),
          ).snapshot;
          setRecordInJournal(state, record);
          return changed(
            {
              nextPrivateState: withJournal(slices.privateState, state),
              nextSharedState: nextShared,
            },
            {
              current: {
                editRevision: nextRevision,
                fingerprint,
                mode: 'manual-only' as const,
                text: request.revisedText,
                workspaceRevision: 0,
              },
              kind: 'saved-manual-draft' as const,
            },
          );
        },
      );
      return {
        ...result.result,
        current: result.result.current
          ? { ...result.result.current, workspaceRevision: result.revision }
          : null,
      };
    },
  };

  async function activatePromptProtectionAndDisableLegacyWriters(
    cutoverEpoch: string,
  ): Promise<TaskInitialPromptProtectionCutoverResult> {
    requireHealthy();
    if (cutoverEpoch.trim().length === 0) {
      throw new TaskInitialPromptPersistenceRecoveryError('Prompt cutover epoch is empty');
    }
    const result = await authority.mutate(
      { operation: 'activate-initial-prompt-protection' },
      (slices) => {
        const existingSchema = getOwnerSchema(slices.privateState);
        if (existingSchema) {
          if (
            existingSchema.cutoverEpoch !== cutoverEpoch ||
            existingSchema.hookSetVersion !== TASK_INITIAL_PROMPT_HOOK_SET_VERSION ||
            existingSchema.legacyWritersDisabled !== true
          ) {
            throw new TaskInitialPromptPersistenceRecoveryError(
              'Initial prompt owner cutover does not match the requested epoch',
            );
          }
          const versions = getProtectedPolicyVersions(slices.privateState);
          if (versions['initial-prompt'] !== '1') {
            throw new TaskInitialPromptPersistenceRecoveryError(
              'Initial prompt protection is only partially activated',
            );
          }
          return unchanged({
            cutoverEpoch,
            hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
            legacyWritersDisabled: true as const,
            migratedLegacyDrafts: 0,
            protectedPolicyVersion: '1' as const,
          });
        }

        const tasks = requireTasks(slices.sharedState);
        const nextTasks = cloneJsonObject(tasks);
        let migratedLegacyDrafts = 0;
        for (const [taskId, taskValue] of Object.entries(nextTasks)) {
          if (!isJsonObject(taskValue)) {
            throw new TaskInitialPromptPersistenceRecoveryError(
              `Canonical task ${taskId} is invalid during prompt cutover`,
            );
          }
          const canonicalPrompt =
            typeof taskValue.initialPrompt === 'string'
              ? taskValue.initialPrompt
              : typeof taskValue.savedInitialPrompt === 'string'
                ? taskValue.savedInitialPrompt
                : undefined;
          Reflect.deleteProperty(taskValue, 'savedInitialPrompt');
          if (canonicalPrompt === undefined || canonicalPrompt.trim().length === 0) {
            Reflect.deleteProperty(taskValue, 'initialPrompt');
            Reflect.deleteProperty(taskValue, 'initialPromptDeliveryId');
            Reflect.deleteProperty(taskValue, 'initialPromptDeliveryMode');
            continue;
          }
          const agentId = getTaskAgentId(taskValue);
          if (!agentId) {
            throw new TaskInitialPromptPersistenceRecoveryError(
              `Task ${taskId} has a prompt without an agent identity`,
            );
          }
          taskValue.initialPrompt = canonicalPrompt;
          if (typeof taskValue.initialPromptDeliveryId !== 'string') {
            taskValue.initialPromptDeliveryId = deriveLegacyTaskInitialPromptDeliveryId({
              agentId,
              readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
              taskId,
              text: canonicalPrompt,
            });
            migratedLegacyDrafts += 1;
          }
          if (
            taskValue.initialPromptDeliveryMode !== 'automatic' &&
            taskValue.initialPromptDeliveryMode !== 'manual-only'
          ) {
            taskValue.initialPromptDeliveryMode = 'automatic';
          }
        }
        const nextShared = cloneJsonObject(slices.sharedState);
        nextShared.tasks = nextTasks;
        const nextPrivate = activateProtectedPolicies(slices.privateState, ['initial-prompt']);
        nextPrivate[OWNER_SCHEMA_KEY] = {
          cutoverEpoch,
          hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
          legacyWritersDisabled: true,
        };
        return changed(
          { nextPrivateState: nextPrivate, nextSharedState: nextShared },
          {
            cutoverEpoch,
            hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
            legacyWritersDisabled: true as const,
            migratedLegacyDrafts,
            protectedPolicyVersion: '1' as const,
          },
        );
      },
    );
    await verifyPromptProtectionCutover(cutoverEpoch);
    return result.result;
  }

  async function verifyPromptProtectionCutover(cutoverEpoch: string): Promise<void> {
    requireHealthy();
    await authority.mutate({ operation: 'verify-initial-prompt-protection' }, (slices) => {
      readJournal(slices.privateState);
      const schema = getOwnerSchema(slices.privateState);
      if (
        !schema ||
        schema.cutoverEpoch !== cutoverEpoch ||
        schema.hookSetVersion !== TASK_INITIAL_PROMPT_HOOK_SET_VERSION ||
        schema.legacyWritersDisabled !== true ||
        getProtectedPolicyVersions(slices.privateState)['initial-prompt'] !== '1'
      ) {
        throw new TaskInitialPromptPersistenceRecoveryError(
          'Initial prompt protection cutover verification failed',
        );
      }
      return unchanged(undefined);
    });
  }

  return {
    activatePromptProtectionAndDisableLegacyWriters,
    ensureDarkJournalReady,
    journal,
    repository,
    verifyPromptProtectionCutover,
  };
}
