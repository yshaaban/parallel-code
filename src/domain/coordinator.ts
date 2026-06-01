import {
  isArrayOf,
  isNonNegativeInteger,
  isOptionalNonNegativeInteger,
  isOptionalString,
  isRecord,
  isStringArray,
  isStringTupleMember,
} from '../lib/type-guards.js';
import type { ProjectMode } from '../store/types.js';

export const COORDINATOR_RUN_STATUSES = [
  'starting',
  'running',
  'paused-by-user',
  'draining',
  'completed',
  'failed',
  'cancelled',
  'stale-after-restore',
] as const;

export const COORDINATOR_SUBTASK_STATUSES = [
  'queued',
  'spawning',
  'waiting-for-agent-ready',
  'running',
  'waiting-for-user',
  'waiting-for-coordinator',
  'ready-for-review',
  'landing',
  'landed',
  'landing-failed',
  'cleanup-failed',
  'failed',
  'exited',
  'cancelled',
] as const;

export const COORDINATOR_PROMPT_KINDS = [
  'initial-assignment',
  'follow-up',
  'review-finding',
  'system',
] as const;

export const COORDINATOR_PROMPT_STATUSES = [
  'queued',
  'waiting-for-agent-session',
  'waiting-for-terminal-prompt',
  'waiting-for-user-idle',
  'waiting-for-terminal-input-clear',
  'waiting-for-command-lease',
  'blocked-by-question',
  'delivering',
  'delivered',
  'write-unknown-after-restore',
  'failed',
  'cancelled',
] as const;

export const COORDINATOR_LANDING_STATUSES = [
  'requested',
  'validating',
  'verification-failed',
  'dirty-worktree',
  'dirty-parent-worktree',
  'blocked-by-parent-control',
  'merging',
  'merged',
  'cleanup',
  'landed',
  'landing-failed',
  'merge-conflict',
  'cleanup-failed',
  'rejected',
] as const;

export const COORDINATOR_EVENT_TYPES = [
  'snapshot-required',
  'run-upserted',
  'run-removed',
  'subtask-upserted',
  'subtask-removed',
  'prompt-upserted',
  'prompt-removed',
  'landing-upserted',
] as const;

export type CoordinatorRunStatus = (typeof COORDINATOR_RUN_STATUSES)[number];
export type CoordinatorSubtaskStatus = (typeof COORDINATOR_SUBTASK_STATUSES)[number];
export type CoordinatorPromptKind = (typeof COORDINATOR_PROMPT_KINDS)[number];
export type CoordinatorPromptStatus = (typeof COORDINATOR_PROMPT_STATUSES)[number];
export type CoordinatorLandingStatus = (typeof COORDINATOR_LANDING_STATUSES)[number];
export type CoordinatorEventType = (typeof COORDINATOR_EVENT_TYPES)[number];

export const COORDINATOR_LIMITS = {
  assignmentTextMaxChars: 16_000,
  coordinatorEventPayloadMaxBytes: 64 * 1024,
  promptTextMaxChars: 32_000,
  snapshotMaxBytes: 256 * 1024,
  summaryTextMaxChars: 8_000,
  verificationEntryMaxChars: 2_000,
  maxActiveSubtasksPerRun: 5,
  maxQueuedSubtasksPerRun: 20,
  maxConcurrentPromptDeliveriesGlobal: 4,
  maxConcurrentPromptDeliveriesPerRun: 2,
  maxConcurrentSpawnsGlobal: 2,
  maxConcurrentSpawnsPerProject: 1,
  maxRememberedToolCallResults: 500,
  maxPendingPromptsPerTarget: 3,
  spawnSpacingWhileSelectedRestoringMs: 500,
} as const;

export interface CoordinatorRunLimits {
  maxActiveSubtasks: number;
  maxQueuedSubtasks: number;
  maxPendingPromptsPerTarget: number;
}

export interface CoordinatorHiddenOutputState {
  droppedBytes: number;
  retainedBytes: number;
  spoolLimitBytes: number;
  updatedAt: number;
}

export interface CoordinatorPromptDeliveryJournalEntry {
  agentGeneration: number;
  deliveryAttemptId: string;
  ptySessionId: string;
  requestId: string;
  writeAcceptedAt?: number;
  writePreparedAt: number;
}

export interface CoordinatorPromptRequestSnapshot {
  attempts: number;
  createdAt: number;
  dedupeKey: string;
  deliveryJournal: CoordinatorPromptDeliveryJournalEntry[];
  earliestDeliveryAt: number;
  failedAt?: number;
  kind: CoordinatorPromptKind;
  requestId: string;
  runId: string;
  sourceTaskId: string;
  status: CoordinatorPromptStatus;
  targetAgentId: string;
  targetTaskId: string;
  text: string;
  waitingReason?: string;
  deliveredAt?: number;
}

export interface CoordinatorLandingStateSnapshot {
  cleanupAttemptId?: string;
  commit?: string;
  failure?: string;
  landedCommit?: string;
  landingAttemptId?: string;
  requestedAt: number;
  requestedByAgentId: string;
  runId: string;
  sourceBranch?: string;
  sourceHead?: string;
  status: CoordinatorLandingStatus;
  summary: string;
  targetBranch?: string;
  targetHeadBefore?: string;
  taskId: string;
  verification: string[];
}

export interface CoordinatorSubtaskSnapshot {
  agentId: string;
  assignment: string;
  branchName?: string;
  createdAt: number;
  dedupeKey?: string;
  hiddenOutputState?: CoordinatorHiddenOutputState;
  lastPromptRequestId?: string;
  parentCoordinatorTaskId: string;
  result?: string;
  status: CoordinatorSubtaskStatus;
  taskId: string;
  /**
   * Public credential identifier for diagnostics. The bearer token itself lives only in the
   * per-agent credential file and backend token index.
   */
  toolTokenId: string;
  updatedAt: number;
  worktreePath: string;
}

export interface CoordinatorRunSnapshot {
  coordinatorTaskId: string;
  createdAt: number;
  eventVersion: number;
  id: string;
  landing: CoordinatorLandingStateSnapshot[];
  limits: CoordinatorRunLimits;
  projectId: string;
  projectMode: ProjectMode;
  projectRoot: string;
  promptQueue: CoordinatorPromptRequestSnapshot[];
  status: CoordinatorRunStatus;
  subtasks: CoordinatorSubtaskSnapshot[];
  updatedAt: number;
}

export interface CoordinatorBootstrapSnapshot {
  generatedAt: number;
  runs: CoordinatorRunSnapshot[];
  stateVersion: number;
}

export interface CoordinatorEventEnvelope {
  categorySeq: number;
  createdAt: number;
  entityKey: string;
  entityVersion: number;
  eventType: CoordinatorEventType;
  payload: unknown;
  runId: string;
  snapshotRequired?: boolean;
  tombstone?: boolean;
}

export interface CoordinatorDiagnosticsSnapshot {
  activeRuns: number;
  activeSubtasks: number;
  coordinatorEvents: number;
  droppedToSnapshotEvents: number;
  hiddenOutputDroppedBytes: number;
  hiddenOutputRetainedBytes: number;
  promptQueueDepth: number;
  queuedSpawns: number;
  stateVersion: number;
}

export interface CoordinatorCreateRunRequest {
  coordinatorAgentId: string;
  coordinatorTaskId: string;
  projectId: string;
  projectMode: ProjectMode;
  projectRoot: string;
}

export interface CoordinatorCreateRunResult {
  credentialPath: string;
  run: CoordinatorRunSnapshot;
  toolCommand?: string;
}

export interface CoordinatorActivityHintRequest {
  agentGeneration: number;
  blocked: boolean;
  clientId: string;
  kind:
    | 'prompt-draft'
    | 'terminal-printable-input'
    | 'terminal-pending-input'
    | 'terminal-focus'
    | 'manual-prompt-sent';
  seq: number;
  taskId: string;
  ttlMs?: number;
}

export interface CoordinatorToolCallEnvelope {
  callId: string;
  runId: string;
  taskId: string;
  toolName: 'get_task_status' | 'spawn_subtask' | 'send_prompt' | 'signal_done' | 'land_self';
  token: string;
  payload?: unknown;
}

export interface CoordinatorToolCallResult {
  accepted: boolean;
  callId: string;
  error?: string;
  result?: unknown;
}

export interface CoordinatorSpawnSubtaskPayload {
  agent: {
    args?: string[];
    command: string;
    env?: Record<string, string>;
    name?: string;
    skipPermissionsArgs?: string[];
  };
  assignment: string;
  baseBranch?: string;
  branchPrefix?: string;
  dedupeKey?: string;
  name: string;
}

export interface CoordinatorSendPromptPayload {
  dedupeKey?: string;
  kind?: CoordinatorPromptKind;
  targetTaskId: string;
  text: string;
}

export interface CoordinatorSignalDonePayload {
  result?: string;
}

export interface CoordinatorLandSelfPayload {
  summary: string;
  verification: string[];
}

export function isCoordinatorRunStatus(value: unknown): value is CoordinatorRunStatus {
  return isStringTupleMember(value, COORDINATOR_RUN_STATUSES);
}

export function isCoordinatorSubtaskStatus(value: unknown): value is CoordinatorSubtaskStatus {
  return isStringTupleMember(value, COORDINATOR_SUBTASK_STATUSES);
}

export function isCoordinatorTerminalSubtaskStatus(status: CoordinatorSubtaskStatus): boolean {
  return (
    status === 'cancelled' ||
    status === 'cleanup-failed' ||
    status === 'exited' ||
    status === 'failed' ||
    status === 'landed' ||
    status === 'landing-failed'
  );
}

export function isCoordinatorPromptKind(value: unknown): value is CoordinatorPromptKind {
  return isStringTupleMember(value, COORDINATOR_PROMPT_KINDS);
}

export function isCoordinatorPromptStatus(value: unknown): value is CoordinatorPromptStatus {
  return isStringTupleMember(value, COORDINATOR_PROMPT_STATUSES);
}

export function isCoordinatorPendingPromptStatus(status: CoordinatorPromptStatus): boolean {
  return (
    status === 'blocked-by-question' ||
    status === 'delivering' ||
    status === 'queued' ||
    status === 'waiting-for-agent-session' ||
    status === 'waiting-for-command-lease' ||
    status === 'waiting-for-terminal-input-clear' ||
    status === 'waiting-for-terminal-prompt' ||
    status === 'waiting-for-user-idle'
  );
}

export function isCoordinatorLandingStatus(value: unknown): value is CoordinatorLandingStatus {
  return isStringTupleMember(value, COORDINATOR_LANDING_STATUSES);
}

export function isCoordinatorEventType(value: unknown): value is CoordinatorEventType {
  return isStringTupleMember(value, COORDINATOR_EVENT_TYPES);
}

function isProjectMode(value: unknown): value is ProjectMode {
  return value === 'git' || value === 'non-git';
}

function isCoordinatorRunLimits(value: unknown): value is CoordinatorRunLimits {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.maxActiveSubtasks) &&
    isNonNegativeInteger(value.maxQueuedSubtasks) &&
    isNonNegativeInteger(value.maxPendingPromptsPerTarget)
  );
}

function isCoordinatorHiddenOutputState(value: unknown): value is CoordinatorHiddenOutputState {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.droppedBytes) &&
    isNonNegativeInteger(value.retainedBytes) &&
    isNonNegativeInteger(value.spoolLimitBytes) &&
    isNonNegativeInteger(value.updatedAt)
  );
}

function isCoordinatorPromptDeliveryJournalEntry(
  value: unknown,
): value is CoordinatorPromptDeliveryJournalEntry {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.agentGeneration) &&
    typeof value.deliveryAttemptId === 'string' &&
    typeof value.ptySessionId === 'string' &&
    typeof value.requestId === 'string' &&
    isNonNegativeInteger(value.writePreparedAt) &&
    isOptionalNonNegativeInteger(value.writeAcceptedAt)
  );
}

export function isCoordinatorPromptRequestSnapshot(
  value: unknown,
): value is CoordinatorPromptRequestSnapshot {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.attempts) &&
    isNonNegativeInteger(value.createdAt) &&
    typeof value.dedupeKey === 'string' &&
    isArrayOf(value.deliveryJournal, isCoordinatorPromptDeliveryJournalEntry) &&
    isNonNegativeInteger(value.earliestDeliveryAt) &&
    isOptionalNonNegativeInteger(value.failedAt) &&
    isCoordinatorPromptKind(value.kind) &&
    typeof value.requestId === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.sourceTaskId === 'string' &&
    isCoordinatorPromptStatus(value.status) &&
    typeof value.targetAgentId === 'string' &&
    typeof value.targetTaskId === 'string' &&
    typeof value.text === 'string' &&
    isOptionalString(value.waitingReason) &&
    isOptionalNonNegativeInteger(value.deliveredAt)
  );
}

export function isCoordinatorLandingStateSnapshot(
  value: unknown,
): value is CoordinatorLandingStateSnapshot {
  return (
    isRecord(value) &&
    isOptionalString(value.cleanupAttemptId) &&
    isOptionalString(value.commit) &&
    isOptionalString(value.failure) &&
    isOptionalString(value.landedCommit) &&
    isOptionalString(value.landingAttemptId) &&
    isNonNegativeInteger(value.requestedAt) &&
    typeof value.requestedByAgentId === 'string' &&
    typeof value.runId === 'string' &&
    isOptionalString(value.sourceBranch) &&
    isOptionalString(value.sourceHead) &&
    isCoordinatorLandingStatus(value.status) &&
    typeof value.summary === 'string' &&
    isOptionalString(value.targetBranch) &&
    isOptionalString(value.targetHeadBefore) &&
    typeof value.taskId === 'string' &&
    isStringArray(value.verification)
  );
}

export function isCoordinatorSubtaskSnapshot(value: unknown): value is CoordinatorSubtaskSnapshot {
  return (
    isRecord(value) &&
    typeof value.agentId === 'string' &&
    typeof value.assignment === 'string' &&
    isOptionalString(value.branchName) &&
    isNonNegativeInteger(value.createdAt) &&
    isOptionalString(value.dedupeKey) &&
    (value.hiddenOutputState === undefined ||
      isCoordinatorHiddenOutputState(value.hiddenOutputState)) &&
    isOptionalString(value.lastPromptRequestId) &&
    typeof value.parentCoordinatorTaskId === 'string' &&
    isOptionalString(value.result) &&
    isCoordinatorSubtaskStatus(value.status) &&
    typeof value.taskId === 'string' &&
    typeof value.toolTokenId === 'string' &&
    isNonNegativeInteger(value.updatedAt) &&
    typeof value.worktreePath === 'string'
  );
}

export function isCoordinatorRunSnapshot(value: unknown): value is CoordinatorRunSnapshot {
  return (
    isRecord(value) &&
    typeof value.coordinatorTaskId === 'string' &&
    isNonNegativeInteger(value.createdAt) &&
    isNonNegativeInteger(value.eventVersion) &&
    typeof value.id === 'string' &&
    isArrayOf(value.landing, isCoordinatorLandingStateSnapshot) &&
    isCoordinatorRunLimits(value.limits) &&
    typeof value.projectId === 'string' &&
    isProjectMode(value.projectMode) &&
    typeof value.projectRoot === 'string' &&
    isArrayOf(value.promptQueue, isCoordinatorPromptRequestSnapshot) &&
    isCoordinatorRunStatus(value.status) &&
    isArrayOf(value.subtasks, isCoordinatorSubtaskSnapshot) &&
    isNonNegativeInteger(value.updatedAt)
  );
}

export function isCoordinatorBootstrapSnapshot(
  value: unknown,
): value is CoordinatorBootstrapSnapshot {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.generatedAt) &&
    isArrayOf(value.runs, isCoordinatorRunSnapshot) &&
    isNonNegativeInteger(value.stateVersion)
  );
}

export function isCoordinatorEventEnvelope(value: unknown): value is CoordinatorEventEnvelope {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.categorySeq) ||
    !isNonNegativeInteger(value.createdAt) ||
    typeof value.entityKey !== 'string' ||
    !isNonNegativeInteger(value.entityVersion) ||
    !isCoordinatorEventType(value.eventType) ||
    typeof value.runId !== 'string' ||
    (value.snapshotRequired !== undefined && typeof value.snapshotRequired !== 'boolean') ||
    (value.tombstone !== undefined && typeof value.tombstone !== 'boolean')
  ) {
    return false;
  }

  switch (value.eventType) {
    case 'snapshot-required':
    case 'run-removed':
    case 'subtask-removed':
    case 'prompt-removed':
      return value.payload === null || value.payload === undefined || isRecord(value.payload);
    case 'run-upserted':
      return isCoordinatorRunSnapshot(value.payload);
    case 'subtask-upserted':
      return isCoordinatorSubtaskSnapshot(value.payload);
    case 'prompt-upserted':
      return isCoordinatorPromptRequestSnapshot(value.payload);
    case 'landing-upserted':
      return isCoordinatorLandingStateSnapshot(value.payload);
  }
}

export function isCoordinatorDiagnosticsSnapshot(
  value: unknown,
): value is CoordinatorDiagnosticsSnapshot {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.activeRuns) &&
    isNonNegativeInteger(value.activeSubtasks) &&
    isNonNegativeInteger(value.coordinatorEvents) &&
    isNonNegativeInteger(value.droppedToSnapshotEvents) &&
    isNonNegativeInteger(value.hiddenOutputDroppedBytes) &&
    isNonNegativeInteger(value.hiddenOutputRetainedBytes) &&
    isNonNegativeInteger(value.promptQueueDepth) &&
    isNonNegativeInteger(value.queuedSpawns) &&
    isNonNegativeInteger(value.stateVersion)
  );
}
