import {
  isArrayOf,
  isNonNegativeInteger,
  isOptionalNonNegativeInteger,
  isOptionalString,
  isRecord,
  isStringArray,
  isStringTupleMember,
} from '../lib/type-guards.js';
import {
  COORDINATOR_WORKFLOW_DYNAMIC_ACTION_KINDS,
  countCoordinatorWorkflowSpecStepLanes,
  isCoordinatorWorkflowSpecSnapshot,
  type CoordinatorWorkflowDynamicActionKind,
  type CoordinatorWorkflowDynamicActionSnapshot,
  type CoordinatorWorkflowSpecSnapshot,
  type CoordinatorWorkflowSpecStepSnapshot,
} from './coordinator-workflow-spec.js';
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

export const COORDINATOR_AGENT_INITIAL_ASSIGNMENT_MODES = [
  'spawn-seeded-interactive',
  'post-ready-prompt',
] as const;

export const COORDINATOR_AGENT_FOLLOWUP_PROMPT_MODES = ['post-ready-prompt', 'disallow'] as const;

export const COORDINATOR_AGENT_READINESS_POLICIES = ['codex', 'shell', 'terminal-generic'] as const;

export const COORDINATOR_SUBTASK_INITIAL_ASSIGNMENT_STATUSES = [
  'seeded-at-spawn',
  'pending-prompt',
  'delivered',
  'blocked-by-question',
  'failed',
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

export const COORDINATOR_TOOL_NAMES = [
  'append_workflow_steps',
  'close_task',
  'get_task_diff',
  'get_task_output',
  'get_task_status',
  'land_self',
  'list_tasks',
  'send_prompt',
  'signal_done',
  'spawn_many',
  'spawn_subtask',
  'start_workflow',
  'submit_result',
  'wait_for_idle',
] as const;

export const COORDINATOR_OPERATOR_ACTION_NAMES = [
  'approve_workflow_actions',
  'deny_workflow_actions',
  'pause_run',
  'resume_run',
  'retry_lane',
  'unpause_run',
] as const;

export const COORDINATOR_WORKFLOW_TEMPLATES = [
  'custom',
  'map_reduce',
  'adversarial_review',
  'repo_review',
] as const;

export const COORDINATOR_WORKFLOW_STATUSES = [
  'pending',
  'running',
  'waiting-for-results',
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'stale-after-restore',
] as const;

export const COORDINATOR_WORKFLOW_STAGE_KINDS = [
  'decision',
  'fan-out',
  'map',
  'reduce',
  'find',
  'verify',
  'judge',
  'synthesize',
  'custom',
] as const;

export const COORDINATOR_WORKFLOW_STAGE_STATUSES = [
  'pending',
  'running',
  'waiting-for-results',
  'completed',
  'skipped',
  'blocked',
  'failed',
  'cancelled',
  'stale-after-restore',
] as const;

export const COORDINATOR_WORKFLOW_PROGRAM_VERSION = 2 as const;

export const COORDINATOR_WORKFLOW_LANE_STATUSES = [
  'pending',
  'spawning',
  'running',
  'waiting-for-result',
  'completed',
  'blocked',
  'failed',
  'timed-out',
  'cancelled',
  'stale-after-restore',
] as const;

export const COORDINATOR_WORKFLOW_RESULT_STATUSES = [
  'completed',
  'blocked',
  'failed',
  'needs-followup',
] as const;

export const COORDINATOR_WORKFLOW_RESULT_CONFIDENCES = ['low', 'medium', 'high'] as const;

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
export type CoordinatorAgentInitialAssignmentMode =
  (typeof COORDINATOR_AGENT_INITIAL_ASSIGNMENT_MODES)[number];
export type CoordinatorAgentFollowupPromptMode =
  (typeof COORDINATOR_AGENT_FOLLOWUP_PROMPT_MODES)[number];
export type CoordinatorAgentReadinessPolicy = (typeof COORDINATOR_AGENT_READINESS_POLICIES)[number];
export type CoordinatorSubtaskInitialAssignmentStatus =
  (typeof COORDINATOR_SUBTASK_INITIAL_ASSIGNMENT_STATUSES)[number];
export type CoordinatorPromptKind = (typeof COORDINATOR_PROMPT_KINDS)[number];
export type CoordinatorPromptStatus = (typeof COORDINATOR_PROMPT_STATUSES)[number];
export type CoordinatorToolName = (typeof COORDINATOR_TOOL_NAMES)[number];
export type CoordinatorOperatorActionName = (typeof COORDINATOR_OPERATOR_ACTION_NAMES)[number];
export type CoordinatorWorkflowTemplate = (typeof COORDINATOR_WORKFLOW_TEMPLATES)[number];
export type CoordinatorWorkflowStatus = (typeof COORDINATOR_WORKFLOW_STATUSES)[number];
export type CoordinatorWorkflowStageKind = (typeof COORDINATOR_WORKFLOW_STAGE_KINDS)[number];
export type CoordinatorWorkflowStageStatus = (typeof COORDINATOR_WORKFLOW_STAGE_STATUSES)[number];
export type CoordinatorWorkflowLaneStatus = (typeof COORDINATOR_WORKFLOW_LANE_STATUSES)[number];
export type CoordinatorWorkflowResultStatus = (typeof COORDINATOR_WORKFLOW_RESULT_STATUSES)[number];
export type CoordinatorWorkflowResultConfidence =
  (typeof COORDINATOR_WORKFLOW_RESULT_CONFIDENCES)[number];
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
  maxWorkflowBranchIterations: 8,
  maxWorkflowFindings: 100,
  maxWorkflowEvidence: 200,
  maxWorkflowLanes: 12,
  maxWorkflowMetadataBytes: 16 * 1024,
  maxWorkflowDecisionActionsPerResult: 8,
  maxWorkflowResults: 500,
  maxWorkflowResultEntryChars: 2_000,
  maxWorkflowResultListItems: 100,
  maxWorkflowShortTextChars: 512,
  maxWorkflowSummaryChars: 12_000,
  maxWorkflowStepAppends: 24,
  maxWorkflowTotalRetries: 8,
  maxWorkflowTotalSteps: 24,
  spawnSpacingWhileSelectedRestoringMs: 500,
  workflowDefaultLaneTimeoutMs: 15 * 60 * 1000,
  workflowDefaultWallClockMs: 60 * 60 * 1000,
  workflowMaxLaneTimeoutMs: 24 * 60 * 60 * 1000,
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

export interface CoordinatorSpawnAgentConfig {
  args?: string[];
  command: string;
  env?: Record<string, string>;
  followupPromptMode?: CoordinatorAgentFollowupPromptMode;
  initialAssignmentMode?: CoordinatorAgentInitialAssignmentMode;
  name?: string;
  readinessPolicy?: CoordinatorAgentReadinessPolicy;
  skipPermissionsArgs?: string[];
}

export interface CoordinatorSubtaskStartupSnapshot {
  deliveredAt?: number;
  followupPromptMode: CoordinatorAgentFollowupPromptMode;
  initialAssignmentMode: CoordinatorAgentInitialAssignmentMode;
  initialAssignmentStatus: CoordinatorSubtaskInitialAssignmentStatus;
  readinessPolicy: CoordinatorAgentReadinessPolicy;
  seededAt?: number;
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
  interruptedByRestoreAt?: number;
  lastPromptRequestId?: string;
  parentCoordinatorTaskId: string;
  result?: string;
  startup?: CoordinatorSubtaskStartupSnapshot;
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

export const COORDINATOR_WORKFLOW_LANE_SPAWN_SOURCES = ['scheduler', 'operator', 'resume'] as const;

export type CoordinatorWorkflowLaneSpawnSource =
  (typeof COORDINATOR_WORKFLOW_LANE_SPAWN_SOURCES)[number];

export interface CoordinatorSubtaskLaunchSnapshot {
  agent: CoordinatorSpawnAgentConfig;
  assignment: string;
  baseBranch?: string;
  branchPrefix?: string;
  dedupeKey: string;
  name: string;
  recordedAt: number;
  runId: string;
  taskId: string;
}

export interface CoordinatorWorkflowPolicySnapshot {
  budgetHint?: string;
  continueOnFailure: boolean;
  maxConcurrentLanes: number;
  maxIterationsPerBranch: number;
  maxOutputBytesPerLane: number;
  maxTotalLanes?: number;
  maxTotalRetries?: number;
  maxTotalSteps?: number;
  maxWallClockMs?: number;
  requireDecisionApproval?: boolean;
  resultRequired: boolean;
  retryBackoffMs: number;
  retryCount: number;
  timeoutMs: number;
}

export interface CoordinatorWorkflowStageSnapshot {
  completedAt?: number;
  createdAt: number;
  dependsOn: string[];
  failure?: string;
  id: string;
  kind: CoordinatorWorkflowStageKind;
  laneIds: string[];
  name: string;
  resultIds: string[];
  startedAt?: number;
  status: CoordinatorWorkflowStageStatus;
  updatedAt: number;
}

export interface CoordinatorWorkflowLaneSnapshot {
  agentId?: string;
  assignment: string;
  attempt: number;
  completedAt?: number;
  createdAt: number;
  dedupeKey?: string;
  failure?: string;
  id: string;
  name: string;
  resultId?: string;
  role?: string;
  spawnedBy?: CoordinatorWorkflowLaneSpawnSource;
  stageId: string;
  startedAt?: number;
  status: CoordinatorWorkflowLaneStatus;
  /** Set when resume cancels this lane in favor of a replacement lane it spawned. */
  supersededByLaneId?: string;
  taskId?: string;
  timeoutAt?: number;
  updatedAt: number;
}

export interface CoordinatorWorkflowEvidenceSnapshot {
  file?: string;
  label: string;
  line?: number;
  note?: string;
  url?: string;
}

export interface CoordinatorWorkflowFindingSnapshot {
  confidence?: CoordinatorWorkflowResultConfidence;
  evidenceIds?: string[];
  fileRefs?: string[];
  id?: string;
  owner?: string;
  riskType?: string;
  severity?: 'critical' | 'major' | 'minor' | 'nit';
  sourceLaneId?: string;
  sourceResultId?: string;
  status?: 'confirmed' | 'semi-confirmed' | 'highly-likely' | 'rejected' | 'unknown';
  summary: string;
  title?: string;
}

export interface CoordinatorWorkflowVerdictSnapshot {
  createdAt: number;
  findingId: string;
  id: string;
  reason: string;
  resultId: string;
  status: 'confirmed' | 'refuted' | 'needs-more-evidence';
  verifierLaneId: string;
}

export interface CoordinatorWorkflowStepAppendSnapshot {
  appendId: string;
  createdAt: number;
  payloadHash: string;
  reason?: string;
  sourceLaneId?: string;
  sourceTaskId: string;
  stepIds: string[];
}

export interface CoordinatorWorkflowAppendPolicySnapshot {
  maxActionsPerDecision: number;
  maxStepAppends: number;
}

export interface CoordinatorWorkflowExpansionActionSnapshot {
  actionId: string;
  branchKey?: string;
  bundleId?: string;
  iteration?: number;
  kind: CoordinatorWorkflowDynamicActionKind;
  reason?: string;
  stepIds?: string[];
}

export interface CoordinatorWorkflowExpansionSnapshot {
  actions: CoordinatorWorkflowExpansionActionSnapshot[];
  createdAt: number;
  id: string;
  sourceLaneId: string;
  sourceResultId: string;
  sourceTaskId: string;
}

export const COORDINATOR_WORKFLOW_APPROVAL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'cancelled',
] as const;

export type CoordinatorWorkflowApprovalStatus =
  (typeof COORDINATOR_WORKFLOW_APPROVAL_STATUSES)[number];

export interface CoordinatorWorkflowPendingApprovalSnapshot {
  actions: CoordinatorWorkflowDynamicActionSnapshot[];
  createdAt: number;
  id: string;
  laneId: string;
  reason?: string;
  resolvedAt?: number;
  resultId: string;
  stageId: string;
  status: CoordinatorWorkflowApprovalStatus;
}

export const COORDINATOR_WORKFLOW_BUDGET_DIMENSIONS = [
  'steps',
  'lanes',
  'retries',
  'wall-clock',
] as const;

export type CoordinatorWorkflowBudgetDimension =
  (typeof COORDINATOR_WORKFLOW_BUDGET_DIMENSIONS)[number];

export interface CoordinatorWorkflowBudgetUsageSnapshot {
  limit: number;
  used: number;
}

export interface CoordinatorWorkflowBudgetSnapshot {
  deadlineAt: number;
  exhausted?: CoordinatorWorkflowBudgetDimension;
  lanes: CoordinatorWorkflowBudgetUsageSnapshot;
  retries: CoordinatorWorkflowBudgetUsageSnapshot;
  /** Set once when a lane retry is first denied by the retry budget; dedupes the journal entry. */
  retriesExhaustedAt?: number;
  steps: CoordinatorWorkflowBudgetUsageSnapshot;
}

export interface CoordinatorWorkflowBudgetLimits {
  maxTotalLanes: number;
  maxTotalRetries: number;
  maxTotalSteps: number;
  maxWallClockMs: number;
}

export interface CoordinatorWorkflowExecutionSnapshot {
  activeLaneCount: number;
  blockedReason?: string;
  budget?: CoordinatorWorkflowBudgetSnapshot;
  cancelledAt?: number;
  completedStageCount?: number;
  completionReason?: string;
  deadlineAt?: number;
  expansionCount?: number;
  failedLaneCount?: number;
  failureSummary?: string;
  lastTickAt: number;
  nextRetryAt?: number;
  pendingRetryLaneIds: string[];
  retryableLaneCount?: number;
  readyStageIds: string[];
  skippedStageCount?: number;
  timedOutLaneCount?: number;
}

export interface CoordinatorWorkflowResultSnapshot {
  agentId: string;
  commandsRun: string[];
  confidence?: CoordinatorWorkflowResultConfidence;
  createdAt: number;
  evidence: CoordinatorWorkflowEvidenceSnapshot[];
  findings: CoordinatorWorkflowFindingSnapshot[];
  id: string;
  laneId?: string;
  metadata?: Record<string, unknown>;
  risks: string[];
  runId: string;
  stageId?: string;
  status: CoordinatorWorkflowResultStatus;
  summary: string;
  taskId: string;
  workflowId?: string;
}

export interface CoordinatorWorkflowJournalEntrySnapshot {
  at: number;
  kind: string;
  laneId?: string;
  message: string;
  resultId?: string;
  seq: number;
  stageId?: string;
}

export interface CoordinatorWorkflowSnapshot {
  appendPolicy: CoordinatorWorkflowAppendPolicySnapshot;
  completedAt?: number;
  createdAt: number;
  eventVersion: number;
  execution?: CoordinatorWorkflowExecutionSnapshot;
  expansions?: CoordinatorWorkflowExpansionSnapshot[];
  id: string;
  journal: CoordinatorWorkflowJournalEntrySnapshot[];
  lanes: CoordinatorWorkflowLaneSnapshot[];
  pendingApprovals?: CoordinatorWorkflowPendingApprovalSnapshot[];
  policy: CoordinatorWorkflowPolicySnapshot;
  programVersion: number;
  results: CoordinatorWorkflowResultSnapshot[];
  runId: string;
  sourceSpec?: CoordinatorWorkflowSpecSnapshot;
  stages: CoordinatorWorkflowStageSnapshot[];
  startedAt?: number;
  status: CoordinatorWorkflowStatus;
  stepAppends?: CoordinatorWorkflowStepAppendSnapshot[];
  template: CoordinatorWorkflowTemplate;
  title: string;
  updatedAt: number;
  verdicts?: CoordinatorWorkflowVerdictSnapshot[];
}

export interface CoordinatorRunResumeSnapshot {
  failedTaskIds: string[];
  requestedAt: number;
  respawnedTaskIds: string[];
  resumeId: string;
}

export interface CoordinatorRunSnapshot {
  coordinatorTaskId: string;
  createdAt: number;
  eventVersion: number;
  id: string;
  landing: CoordinatorLandingStateSnapshot[];
  limits: CoordinatorRunLimits;
  /**
   * Set while the run is paused by the operator. The marker survives restore, so a paused run
   * that went stale across a restart is resumed back to `paused-by-user` instead of `running`.
   */
  pausedAt?: number;
  projectId: string;
  projectMode: ProjectMode;
  projectRoot: string;
  promptQueue: CoordinatorPromptRequestSnapshot[];
  resumes?: CoordinatorRunResumeSnapshot[];
  status: CoordinatorRunStatus;
  subtasks: CoordinatorSubtaskSnapshot[];
  updatedAt: number;
  workflows: CoordinatorWorkflowSnapshot[];
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
  toolName: CoordinatorToolName;
  token: string;
  payload?: unknown;
}

export interface CoordinatorToolCallResult {
  accepted: boolean;
  callId: string;
  error?: string;
  result?: unknown;
}

interface CoordinatorUiToolCallBase {
  controllerId?: string;
  coordinatorTaskId: string;
  requestId: string;
  runId: string;
}

export type CoordinatorUiToolCallRequest =
  | (CoordinatorUiToolCallBase & {
      payload?: undefined;
      toolName: 'get_task_status' | 'list_tasks';
    })
  | (CoordinatorUiToolCallBase & {
      payload?: CoordinatorGetTaskOutputPayload;
      toolName: 'get_task_output';
    })
  | (CoordinatorUiToolCallBase & {
      payload?: CoordinatorGetTaskDiffPayload;
      toolName: 'get_task_diff';
    })
  | (CoordinatorUiToolCallBase & {
      payload?: CoordinatorWaitForIdlePayload;
      toolName: 'wait_for_idle';
    })
  | (CoordinatorUiToolCallBase & {
      payload: CoordinatorSendPromptPayload;
      toolName: 'send_prompt';
    })
  | (CoordinatorUiToolCallBase & {
      payload: CoordinatorSpawnSubtaskPayload;
      toolName: 'spawn_subtask';
    })
  | (CoordinatorUiToolCallBase & {
      payload: CoordinatorSpawnManyPayload;
      toolName: 'spawn_many';
    })
  | (CoordinatorUiToolCallBase & {
      payload: CoordinatorStartWorkflowPayload;
      toolName: 'start_workflow';
    })
  | (CoordinatorUiToolCallBase & {
      payload: CoordinatorCloseTaskPayload;
      toolName: 'close_task';
    })
  | (CoordinatorUiToolCallBase & {
      payload?: undefined;
      toolName: 'pause_run';
    })
  | (CoordinatorUiToolCallBase & {
      payload?: undefined;
      toolName: 'resume_run';
    })
  | (CoordinatorUiToolCallBase & {
      payload?: undefined;
      toolName: 'unpause_run';
    })
  | (CoordinatorUiToolCallBase & {
      payload: CoordinatorApproveWorkflowActionsPayload;
      toolName: 'approve_workflow_actions';
    })
  | (CoordinatorUiToolCallBase & {
      payload: CoordinatorDenyWorkflowActionsPayload;
      toolName: 'deny_workflow_actions';
    })
  | (CoordinatorUiToolCallBase & {
      payload: CoordinatorRetryLanePayload;
      toolName: 'retry_lane';
    });

/**
 * One authority for renderer-initiated mutating coordinator actions. Presence in this table means
 * the action mutates the run and requires the coordinator task command lease; the value is the set
 * of run statuses that admit the action. The tool gateway enforces the rule and the renderer
 * projection derives its action gating from the same data.
 */
export const COORDINATOR_RENDERER_ACTION_ALLOWED_RUN_STATUSES: Record<
  | CoordinatorOperatorActionName
  | 'close_task'
  | 'send_prompt'
  | 'spawn_many'
  | 'spawn_subtask'
  | 'start_workflow',
  readonly CoordinatorRunStatus[]
> = {
  approve_workflow_actions: ['running', 'draining', 'paused-by-user'],
  close_task: ['running', 'draining'],
  deny_workflow_actions: ['running', 'draining', 'paused-by-user'],
  pause_run: ['running'],
  resume_run: ['stale-after-restore'],
  retry_lane: ['running'],
  send_prompt: ['running', 'draining'],
  spawn_many: ['running'],
  spawn_subtask: ['running'],
  start_workflow: ['running'],
  unpause_run: ['paused-by-user'],
};

export function getCoordinatorRendererActionAllowedRunStatuses(
  toolName: CoordinatorUiToolCallRequest['toolName'],
): readonly CoordinatorRunStatus[] | undefined {
  const table: Partial<
    Record<CoordinatorUiToolCallRequest['toolName'], readonly CoordinatorRunStatus[]>
  > = COORDINATOR_RENDERER_ACTION_ALLOWED_RUN_STATUSES;
  return table[toolName];
}

export interface CoordinatorApproveWorkflowActionsPayload {
  approvalId: string;
  workflowId: string;
}

export interface CoordinatorDenyWorkflowActionsPayload {
  approvalId: string;
  reason?: string;
  workflowId: string;
}

export interface CoordinatorRetryLanePayload {
  laneId: string;
  workflowId: string;
}

export interface CoordinatorRunResumeFailure {
  laneId?: string;
  reason: string;
  taskId?: string;
}

export interface CoordinatorRunResumeResult {
  failed: CoordinatorRunResumeFailure[];
  respawned: string[];
  resumeId: string;
  run: CoordinatorRunSnapshot;
}

export interface CoordinatorSpawnSubtaskPayload {
  agent: CoordinatorSpawnAgentConfig;
  assignment: string;
  baseBranch?: string;
  branchPrefix?: string;
  dedupeKey?: string;
  name: string;
}

export interface CoordinatorSpawnManyLanePayload {
  agent?: CoordinatorSpawnSubtaskPayload['agent'];
  assignment: string;
  attempt?: number;
  dedupeKey?: string;
  name: string;
  role?: string;
  spawnedBy?: CoordinatorWorkflowLaneSpawnSource;
}

export interface CoordinatorWorkflowPolicyPayload {
  budgetHint?: string;
  continueOnFailure?: boolean;
  maxConcurrentLanes?: number;
  maxIterationsPerBranch?: number;
  maxOutputBytesPerLane?: number;
  maxTotalLanes?: number;
  maxTotalRetries?: number;
  maxTotalSteps?: number;
  maxWallClockMs?: number;
  resultRequired?: boolean;
  retryBackoffMs?: number;
  retryCount?: number;
  timeoutMs?: number;
}

export interface CoordinatorSpawnManyPayload {
  agent?: CoordinatorSpawnSubtaskPayload['agent'];
  lanes: CoordinatorSpawnManyLanePayload[];
  policy?: CoordinatorWorkflowPolicyPayload;
  title?: string;
  workflowId?: string;
}

export interface CoordinatorStartWorkflowLanePayload {
  agent?: CoordinatorSpawnSubtaskPayload['agent'];
  assignment?: string;
  name: string;
  role?: string;
}

export interface CoordinatorStartWorkflowPayload {
  agent?: CoordinatorSpawnSubtaskPayload['agent'];
  lanes?: CoordinatorStartWorkflowLanePayload[];
  policy?: CoordinatorWorkflowPolicyPayload;
  problem: string;
  spec?: unknown;
  template: CoordinatorWorkflowTemplate;
  title?: string;
}

export interface CoordinatorAppendWorkflowStepsPayload {
  appendId: string;
  laneId?: string;
  reason?: string;
  steps: unknown[];
  workflowId: string;
}

export interface CoordinatorSubmitResultPayload {
  commandsRun?: string[];
  confidence?: CoordinatorWorkflowResultConfidence;
  evidence?: CoordinatorWorkflowEvidenceSnapshot[];
  findings?: CoordinatorWorkflowFindingSnapshot[];
  laneId?: string;
  metadata?: Record<string, unknown>;
  risks?: string[];
  status?: CoordinatorWorkflowResultStatus;
  summary: string;
  workflowId?: string;
}

export interface CoordinatorSendPromptPayload {
  dedupeKey?: string;
  kind?: CoordinatorPromptKind;
  targetTaskId: string;
  text: string;
}

export interface CoordinatorTargetTaskPayload {
  targetTaskId?: string;
}

export interface CoordinatorCloseTaskPayload {
  targetTaskId: string;
}

export interface CoordinatorGetTaskOutputPayload extends CoordinatorTargetTaskPayload {
  maxBytes?: number;
}

export interface CoordinatorGetTaskDiffPayload extends CoordinatorTargetTaskPayload {
  includePatch?: boolean;
  maxBytes?: number;
}

export interface CoordinatorWaitForIdlePayload extends CoordinatorTargetTaskPayload {
  timeoutMs?: number;
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

/**
 * A paused run stops admitting new coordinator work (spawns, prompt delivery, retries, ready-stage
 * starts) while in-flight work still settles. A missing run admits by default so callers that only
 * have an optional status can defer to their own existence checks.
 */
export function coordinatorRunAdmitsNewWork(
  status: CoordinatorRunStatus | null | undefined,
): boolean {
  return status !== 'paused-by-user';
}

export function isCoordinatorSubtaskStatus(value: unknown): value is CoordinatorSubtaskStatus {
  return isStringTupleMember(value, COORDINATOR_SUBTASK_STATUSES);
}

export function isCoordinatorAgentInitialAssignmentMode(
  value: unknown,
): value is CoordinatorAgentInitialAssignmentMode {
  return isStringTupleMember(value, COORDINATOR_AGENT_INITIAL_ASSIGNMENT_MODES);
}

export function isCoordinatorAgentFollowupPromptMode(
  value: unknown,
): value is CoordinatorAgentFollowupPromptMode {
  return isStringTupleMember(value, COORDINATOR_AGENT_FOLLOWUP_PROMPT_MODES);
}

export function isCoordinatorAgentReadinessPolicy(
  value: unknown,
): value is CoordinatorAgentReadinessPolicy {
  return isStringTupleMember(value, COORDINATOR_AGENT_READINESS_POLICIES);
}

export function isCoordinatorSubtaskInitialAssignmentStatus(
  value: unknown,
): value is CoordinatorSubtaskInitialAssignmentStatus {
  return isStringTupleMember(value, COORDINATOR_SUBTASK_INITIAL_ASSIGNMENT_STATUSES);
}

function getCoordinatorAgentCommandBasename(command: string): string {
  return command.split(/[\\/]/u).pop()?.trim().toLowerCase() ?? '';
}

export function isCodexCoordinatorAgentCommand(command: string): boolean {
  return getCoordinatorAgentCommandBasename(command) === 'codex';
}

export function getCoordinatorAgentInitialAssignmentMode(
  agent: CoordinatorSpawnAgentConfig,
): CoordinatorAgentInitialAssignmentMode {
  if (agent.initialAssignmentMode !== undefined) {
    return agent.initialAssignmentMode;
  }

  return isCodexCoordinatorAgentCommand(agent.command)
    ? 'spawn-seeded-interactive'
    : 'post-ready-prompt';
}

export function getCoordinatorAgentFollowupPromptMode(
  agent: CoordinatorSpawnAgentConfig,
): CoordinatorAgentFollowupPromptMode {
  if (agent.followupPromptMode !== undefined) {
    return agent.followupPromptMode;
  }

  return 'post-ready-prompt';
}

export function getCoordinatorAgentReadinessPolicy(
  agent: CoordinatorSpawnAgentConfig,
): CoordinatorAgentReadinessPolicy {
  if (agent.readinessPolicy !== undefined) {
    return agent.readinessPolicy;
  }

  return isCodexCoordinatorAgentCommand(agent.command) ? 'codex' : 'terminal-generic';
}

export function createCoordinatorSubtaskStartupSnapshot(
  agent: CoordinatorSpawnAgentConfig,
  initialAssignmentStatus: CoordinatorSubtaskInitialAssignmentStatus,
  now = Date.now(),
): CoordinatorSubtaskStartupSnapshot {
  return {
    followupPromptMode: getCoordinatorAgentFollowupPromptMode(agent),
    initialAssignmentMode: getCoordinatorAgentInitialAssignmentMode(agent),
    initialAssignmentStatus,
    readinessPolicy: getCoordinatorAgentReadinessPolicy(agent),
    ...(initialAssignmentStatus === 'seeded-at-spawn' ? { seededAt: now } : {}),
  };
}

export function getCoordinatorSubtaskStartupSnapshot(
  startup: CoordinatorSubtaskSnapshot['startup'],
): CoordinatorSubtaskStartupSnapshot {
  return (
    startup ?? {
      followupPromptMode: 'post-ready-prompt',
      initialAssignmentMode: 'post-ready-prompt',
      initialAssignmentStatus: 'delivered',
      readinessPolicy: 'terminal-generic',
    }
  );
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

export function isCoordinatorToolName(value: unknown): value is CoordinatorToolName {
  return isStringTupleMember(value, COORDINATOR_TOOL_NAMES);
}

export function isCoordinatorOperatorActionName(
  value: unknown,
): value is CoordinatorOperatorActionName {
  return isStringTupleMember(value, COORDINATOR_OPERATOR_ACTION_NAMES);
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

export function isCoordinatorWorkflowTemplate(
  value: unknown,
): value is CoordinatorWorkflowTemplate {
  return isStringTupleMember(value, COORDINATOR_WORKFLOW_TEMPLATES);
}

export function isCoordinatorWorkflowStatus(value: unknown): value is CoordinatorWorkflowStatus {
  return isStringTupleMember(value, COORDINATOR_WORKFLOW_STATUSES);
}

export function isCoordinatorWorkflowStageKind(
  value: unknown,
): value is CoordinatorWorkflowStageKind {
  return isStringTupleMember(value, COORDINATOR_WORKFLOW_STAGE_KINDS);
}

export function isCoordinatorWorkflowStageStatus(
  value: unknown,
): value is CoordinatorWorkflowStageStatus {
  return isStringTupleMember(value, COORDINATOR_WORKFLOW_STAGE_STATUSES);
}

export function isCoordinatorTerminalWorkflowStatus(status: CoordinatorWorkflowStatus): boolean {
  return (
    status === 'blocked' ||
    status === 'cancelled' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'stale-after-restore'
  );
}

export function isCoordinatorWorkflowLaneStatus(
  value: unknown,
): value is CoordinatorWorkflowLaneStatus {
  return isStringTupleMember(value, COORDINATOR_WORKFLOW_LANE_STATUSES);
}

export function isCoordinatorTerminalWorkflowLaneStatus(
  status: CoordinatorWorkflowLaneStatus,
): boolean {
  return (
    status === 'blocked' ||
    status === 'cancelled' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'stale-after-restore' ||
    status === 'timed-out'
  );
}

export function isCoordinatorWorkflowResultStatus(
  value: unknown,
): value is CoordinatorWorkflowResultStatus {
  return isStringTupleMember(value, COORDINATOR_WORKFLOW_RESULT_STATUSES);
}

export function isCoordinatorWorkflowResultConfidence(
  value: unknown,
): value is CoordinatorWorkflowResultConfidence {
  return isStringTupleMember(value, COORDINATOR_WORKFLOW_RESULT_CONFIDENCES);
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

function isOptionalRecord(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || isRecord(value);
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

function isCoordinatorSubtaskStartupSnapshot(
  value: unknown,
): value is CoordinatorSubtaskStartupSnapshot {
  return (
    isRecord(value) &&
    isOptionalNonNegativeInteger(value.deliveredAt) &&
    isCoordinatorAgentFollowupPromptMode(value.followupPromptMode) &&
    isCoordinatorAgentInitialAssignmentMode(value.initialAssignmentMode) &&
    isCoordinatorSubtaskInitialAssignmentStatus(value.initialAssignmentStatus) &&
    isCoordinatorAgentReadinessPolicy(value.readinessPolicy) &&
    isOptionalNonNegativeInteger(value.seededAt)
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
    isOptionalNonNegativeInteger(value.interruptedByRestoreAt) &&
    isOptionalString(value.lastPromptRequestId) &&
    typeof value.parentCoordinatorTaskId === 'string' &&
    isOptionalString(value.result) &&
    (value.startup === undefined || isCoordinatorSubtaskStartupSnapshot(value.startup)) &&
    isCoordinatorSubtaskStatus(value.status) &&
    typeof value.taskId === 'string' &&
    typeof value.toolTokenId === 'string' &&
    isNonNegativeInteger(value.updatedAt) &&
    typeof value.worktreePath === 'string'
  );
}

function isCoordinatorWorkflowPolicySnapshot(
  value: unknown,
): value is CoordinatorWorkflowPolicySnapshot {
  return (
    isRecord(value) &&
    isOptionalString(value.budgetHint) &&
    typeof value.continueOnFailure === 'boolean' &&
    isNonNegativeInteger(value.maxConcurrentLanes) &&
    isNonNegativeInteger(value.maxIterationsPerBranch) &&
    isNonNegativeInteger(value.maxOutputBytesPerLane) &&
    isOptionalNonNegativeInteger(value.maxTotalLanes) &&
    isOptionalNonNegativeInteger(value.maxTotalRetries) &&
    isOptionalNonNegativeInteger(value.maxTotalSteps) &&
    isOptionalNonNegativeInteger(value.maxWallClockMs) &&
    (value.requireDecisionApproval === undefined ||
      typeof value.requireDecisionApproval === 'boolean') &&
    typeof value.resultRequired === 'boolean' &&
    isNonNegativeInteger(value.retryBackoffMs) &&
    isNonNegativeInteger(value.retryCount) &&
    isNonNegativeInteger(value.timeoutMs)
  );
}

function isCoordinatorWorkflowAppendPolicySnapshot(
  value: unknown,
): value is CoordinatorWorkflowAppendPolicySnapshot {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.maxActionsPerDecision) &&
    isNonNegativeInteger(value.maxStepAppends)
  );
}

function isCoordinatorWorkflowStageSnapshot(
  value: unknown,
): value is CoordinatorWorkflowStageSnapshot {
  return (
    isRecord(value) &&
    isOptionalNonNegativeInteger(value.completedAt) &&
    isNonNegativeInteger(value.createdAt) &&
    isStringArray(value.dependsOn) &&
    isOptionalString(value.failure) &&
    typeof value.id === 'string' &&
    isCoordinatorWorkflowStageKind(value.kind) &&
    isStringArray(value.laneIds) &&
    typeof value.name === 'string' &&
    isStringArray(value.resultIds) &&
    isOptionalNonNegativeInteger(value.startedAt) &&
    isCoordinatorWorkflowStageStatus(value.status) &&
    isNonNegativeInteger(value.updatedAt)
  );
}

function isCoordinatorWorkflowLaneSnapshot(
  value: unknown,
): value is CoordinatorWorkflowLaneSnapshot {
  return (
    isRecord(value) &&
    isOptionalString(value.agentId) &&
    typeof value.assignment === 'string' &&
    isNonNegativeInteger(value.attempt) &&
    isOptionalNonNegativeInteger(value.completedAt) &&
    isNonNegativeInteger(value.createdAt) &&
    isOptionalString(value.dedupeKey) &&
    isOptionalString(value.failure) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isOptionalString(value.resultId) &&
    isOptionalString(value.role) &&
    (value.spawnedBy === undefined ||
      isStringTupleMember(value.spawnedBy, COORDINATOR_WORKFLOW_LANE_SPAWN_SOURCES)) &&
    typeof value.stageId === 'string' &&
    isOptionalNonNegativeInteger(value.startedAt) &&
    isCoordinatorWorkflowLaneStatus(value.status) &&
    isOptionalString(value.supersededByLaneId) &&
    isOptionalString(value.taskId) &&
    isOptionalNonNegativeInteger(value.timeoutAt) &&
    isNonNegativeInteger(value.updatedAt)
  );
}

function isCoordinatorWorkflowEvidenceSnapshot(
  value: unknown,
): value is CoordinatorWorkflowEvidenceSnapshot {
  return (
    isRecord(value) &&
    isOptionalString(value.file) &&
    typeof value.label === 'string' &&
    isOptionalNonNegativeInteger(value.line) &&
    isOptionalString(value.note) &&
    isOptionalString(value.url)
  );
}

function isCoordinatorWorkflowFindingSnapshot(
  value: unknown,
): value is CoordinatorWorkflowFindingSnapshot {
  return (
    isRecord(value) &&
    (value.confidence === undefined || isCoordinatorWorkflowResultConfidence(value.confidence)) &&
    (value.evidenceIds === undefined || isStringArray(value.evidenceIds)) &&
    (value.fileRefs === undefined || isStringArray(value.fileRefs)) &&
    isOptionalString(value.id) &&
    isOptionalString(value.owner) &&
    isOptionalString(value.riskType) &&
    (value.severity === undefined ||
      value.severity === 'critical' ||
      value.severity === 'major' ||
      value.severity === 'minor' ||
      value.severity === 'nit') &&
    isOptionalString(value.sourceLaneId) &&
    isOptionalString(value.sourceResultId) &&
    (value.status === undefined ||
      value.status === 'confirmed' ||
      value.status === 'semi-confirmed' ||
      value.status === 'highly-likely' ||
      value.status === 'rejected' ||
      value.status === 'unknown') &&
    typeof value.summary === 'string' &&
    isOptionalString(value.title)
  );
}

function isCoordinatorWorkflowVerdictSnapshot(
  value: unknown,
): value is CoordinatorWorkflowVerdictSnapshot {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.createdAt) &&
    typeof value.findingId === 'string' &&
    typeof value.id === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.resultId === 'string' &&
    (value.status === 'confirmed' ||
      value.status === 'refuted' ||
      value.status === 'needs-more-evidence') &&
    typeof value.verifierLaneId === 'string'
  );
}

function isCoordinatorWorkflowStepAppendSnapshot(
  value: unknown,
): value is CoordinatorWorkflowStepAppendSnapshot {
  return (
    isRecord(value) &&
    typeof value.appendId === 'string' &&
    isNonNegativeInteger(value.createdAt) &&
    typeof value.payloadHash === 'string' &&
    isOptionalString(value.reason) &&
    isOptionalString(value.sourceLaneId) &&
    typeof value.sourceTaskId === 'string' &&
    isStringArray(value.stepIds)
  );
}

function isCoordinatorWorkflowExpansionActionSnapshot(
  value: unknown,
): value is CoordinatorWorkflowExpansionActionSnapshot {
  return (
    isRecord(value) &&
    typeof value.actionId === 'string' &&
    (value.kind === 'append_branch_bundle' ||
      value.kind === 'append_fanout' ||
      value.kind === 'append_synthesize' ||
      value.kind === 'append_verify' ||
      value.kind === 'append_worker' ||
      value.kind === 'mark_blocked' ||
      value.kind === 'stop_workflow') &&
    isOptionalString(value.branchKey) &&
    isOptionalString(value.bundleId) &&
    isOptionalNonNegativeInteger(value.iteration) &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    (value.stepIds === undefined || isStringArray(value.stepIds))
  );
}

function isCoordinatorWorkflowExpansionSnapshot(
  value: unknown,
): value is CoordinatorWorkflowExpansionSnapshot {
  return (
    isRecord(value) &&
    isArrayOf(value.actions, isCoordinatorWorkflowExpansionActionSnapshot) &&
    isNonNegativeInteger(value.createdAt) &&
    typeof value.id === 'string' &&
    typeof value.sourceLaneId === 'string' &&
    typeof value.sourceResultId === 'string' &&
    typeof value.sourceTaskId === 'string'
  );
}

export function isCoordinatorWorkflowApprovalStatus(
  value: unknown,
): value is CoordinatorWorkflowApprovalStatus {
  return isStringTupleMember(value, COORDINATOR_WORKFLOW_APPROVAL_STATUSES);
}

function isCoordinatorWorkflowApprovalAction(
  value: unknown,
): value is CoordinatorWorkflowDynamicActionSnapshot {
  return (
    isRecord(value) && isStringTupleMember(value.kind, COORDINATOR_WORKFLOW_DYNAMIC_ACTION_KINDS)
  );
}

export function isCoordinatorWorkflowPendingApprovalSnapshot(
  value: unknown,
): value is CoordinatorWorkflowPendingApprovalSnapshot {
  return (
    isRecord(value) &&
    isArrayOf(value.actions, isCoordinatorWorkflowApprovalAction) &&
    isNonNegativeInteger(value.createdAt) &&
    typeof value.id === 'string' &&
    typeof value.laneId === 'string' &&
    isOptionalString(value.reason) &&
    isOptionalNonNegativeInteger(value.resolvedAt) &&
    typeof value.resultId === 'string' &&
    typeof value.stageId === 'string' &&
    isCoordinatorWorkflowApprovalStatus(value.status)
  );
}

export function isCoordinatorWorkflowBudgetDimension(
  value: unknown,
): value is CoordinatorWorkflowBudgetDimension {
  return isStringTupleMember(value, COORDINATOR_WORKFLOW_BUDGET_DIMENSIONS);
}

function isCoordinatorWorkflowBudgetUsageSnapshot(
  value: unknown,
): value is CoordinatorWorkflowBudgetUsageSnapshot {
  return isRecord(value) && isNonNegativeInteger(value.limit) && isNonNegativeInteger(value.used);
}

export function isCoordinatorWorkflowBudgetSnapshot(
  value: unknown,
): value is CoordinatorWorkflowBudgetSnapshot {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.deadlineAt) &&
    (value.exhausted === undefined || isCoordinatorWorkflowBudgetDimension(value.exhausted)) &&
    isCoordinatorWorkflowBudgetUsageSnapshot(value.lanes) &&
    isCoordinatorWorkflowBudgetUsageSnapshot(value.retries) &&
    isOptionalNonNegativeInteger(value.retriesExhaustedAt) &&
    isCoordinatorWorkflowBudgetUsageSnapshot(value.steps)
  );
}

function isCoordinatorWorkflowExecutionSnapshot(
  value: unknown,
): value is CoordinatorWorkflowExecutionSnapshot {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.activeLaneCount) &&
    isOptionalString(value.blockedReason) &&
    (value.budget === undefined || isCoordinatorWorkflowBudgetSnapshot(value.budget)) &&
    isOptionalNonNegativeInteger(value.cancelledAt) &&
    isOptionalNonNegativeInteger(value.completedStageCount) &&
    isOptionalString(value.completionReason) &&
    isOptionalNonNegativeInteger(value.deadlineAt) &&
    isOptionalNonNegativeInteger(value.expansionCount) &&
    isOptionalNonNegativeInteger(value.failedLaneCount) &&
    isOptionalString(value.failureSummary) &&
    isNonNegativeInteger(value.lastTickAt) &&
    isOptionalNonNegativeInteger(value.nextRetryAt) &&
    isStringArray(value.pendingRetryLaneIds) &&
    isOptionalNonNegativeInteger(value.retryableLaneCount) &&
    isStringArray(value.readyStageIds) &&
    isOptionalNonNegativeInteger(value.skippedStageCount) &&
    isOptionalNonNegativeInteger(value.timedOutLaneCount)
  );
}

export function isCoordinatorWorkflowResultSnapshot(
  value: unknown,
): value is CoordinatorWorkflowResultSnapshot {
  return (
    isRecord(value) &&
    typeof value.agentId === 'string' &&
    isStringArray(value.commandsRun) &&
    (value.confidence === undefined || isCoordinatorWorkflowResultConfidence(value.confidence)) &&
    isNonNegativeInteger(value.createdAt) &&
    isArrayOf(value.evidence, isCoordinatorWorkflowEvidenceSnapshot) &&
    isArrayOf(value.findings, isCoordinatorWorkflowFindingSnapshot) &&
    typeof value.id === 'string' &&
    isOptionalString(value.laneId) &&
    isOptionalRecord(value.metadata) &&
    isStringArray(value.risks) &&
    typeof value.runId === 'string' &&
    isOptionalString(value.stageId) &&
    isCoordinatorWorkflowResultStatus(value.status) &&
    typeof value.summary === 'string' &&
    typeof value.taskId === 'string' &&
    isOptionalString(value.workflowId)
  );
}

function isCoordinatorWorkflowJournalEntrySnapshot(
  value: unknown,
): value is CoordinatorWorkflowJournalEntrySnapshot {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.at) &&
    typeof value.kind === 'string' &&
    isOptionalString(value.laneId) &&
    typeof value.message === 'string' &&
    isOptionalString(value.resultId) &&
    isOptionalNonNegativeInteger(value.seq) &&
    isOptionalString(value.stageId)
  );
}

export function isCoordinatorWorkflowSnapshot(
  value: unknown,
): value is CoordinatorWorkflowSnapshot {
  return (
    isRecord(value) &&
    (value.appendPolicy === undefined ||
      isCoordinatorWorkflowAppendPolicySnapshot(value.appendPolicy)) &&
    isOptionalNonNegativeInteger(value.completedAt) &&
    isNonNegativeInteger(value.createdAt) &&
    isNonNegativeInteger(value.eventVersion) &&
    (value.execution === undefined || isCoordinatorWorkflowExecutionSnapshot(value.execution)) &&
    (value.expansions === undefined ||
      isArrayOf(value.expansions, isCoordinatorWorkflowExpansionSnapshot)) &&
    typeof value.id === 'string' &&
    isArrayOf(value.journal, isCoordinatorWorkflowJournalEntrySnapshot) &&
    isArrayOf(value.lanes, isCoordinatorWorkflowLaneSnapshot) &&
    (value.pendingApprovals === undefined ||
      isArrayOf(value.pendingApprovals, isCoordinatorWorkflowPendingApprovalSnapshot)) &&
    isCoordinatorWorkflowPolicySnapshot(value.policy) &&
    isOptionalNonNegativeInteger(value.programVersion) &&
    isArrayOf(value.results, isCoordinatorWorkflowResultSnapshot) &&
    typeof value.runId === 'string' &&
    (value.sourceSpec === undefined || isCoordinatorWorkflowSpecSnapshot(value.sourceSpec)) &&
    isArrayOf(value.stages, isCoordinatorWorkflowStageSnapshot) &&
    isOptionalNonNegativeInteger(value.startedAt) &&
    isCoordinatorWorkflowStatus(value.status) &&
    (value.stepAppends === undefined ||
      isArrayOf(value.stepAppends, isCoordinatorWorkflowStepAppendSnapshot)) &&
    isCoordinatorWorkflowTemplate(value.template) &&
    typeof value.title === 'string' &&
    isNonNegativeInteger(value.updatedAt) &&
    (value.verdicts === undefined ||
      isArrayOf(value.verdicts, isCoordinatorWorkflowVerdictSnapshot))
  );
}

function clampWorkflowBudgetLimit(
  value: number | undefined,
  defaultValue: number,
  cap: number,
): number {
  return Math.min(value ?? defaultValue, cap);
}

export function getCoordinatorWorkflowBudgetLimits(
  policy:
    | Pick<
        CoordinatorWorkflowPolicySnapshot,
        'maxTotalLanes' | 'maxTotalRetries' | 'maxTotalSteps' | 'maxWallClockMs'
      >
    | undefined,
): CoordinatorWorkflowBudgetLimits {
  return {
    maxTotalLanes: clampWorkflowBudgetLimit(
      policy?.maxTotalLanes,
      COORDINATOR_LIMITS.maxWorkflowLanes,
      COORDINATOR_LIMITS.maxWorkflowLanes,
    ),
    maxTotalRetries: clampWorkflowBudgetLimit(
      policy?.maxTotalRetries,
      COORDINATOR_LIMITS.maxWorkflowTotalRetries,
      COORDINATOR_LIMITS.maxWorkflowTotalRetries,
    ),
    maxTotalSteps: clampWorkflowBudgetLimit(
      policy?.maxTotalSteps,
      COORDINATOR_LIMITS.maxWorkflowTotalSteps,
      COORDINATOR_LIMITS.maxWorkflowTotalSteps,
    ),
    maxWallClockMs: clampWorkflowBudgetLimit(
      policy?.maxWallClockMs,
      COORDINATOR_LIMITS.workflowDefaultWallClockMs,
      COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
    ),
  };
}

/**
 * Retry budget counts scheduler-spawned retry attempts only. Lanes spawned by `resume` (and any
 * future non-scheduler provenance such as `operator`) are excluded from the counter entirely, not
 * merely exempt from the admission gate.
 */
export function countCoordinatorWorkflowRetriesUsed(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'lanes'>,
): number {
  return workflow.lanes.filter(
    (lane) => lane.attempt > 1 && (lane.spawnedBy ?? 'scheduler') === 'scheduler',
  ).length;
}

export function countCoordinatorWorkflowPendingApprovals(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'pendingApprovals'>,
): number {
  return (workflow.pendingApprovals ?? []).filter((approval) => approval.status === 'pending')
    .length;
}

/**
 * One authority for the lane-retry dedupe-key scheme. The backend executor derives scheduled and
 * manual retry lanes from this key, and the renderer projection uses the same helper to decide
 * whether a retry is already scheduled instead of recomputing the scheme inline.
 */
export function getCoordinatorWorkflowLaneRetryDedupeKey(
  lane: Pick<CoordinatorWorkflowLaneSnapshot, 'attempt' | 'dedupeKey' | 'id'>,
): string {
  return `${lane.dedupeKey ?? lane.id}:retry:${lane.attempt + 1}`;
}

export function hasScheduledCoordinatorWorkflowLaneRetry(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'lanes'>,
  lane: Pick<CoordinatorWorkflowLaneSnapshot, 'attempt' | 'dedupeKey' | 'id'>,
): boolean {
  const retryDedupeKey = getCoordinatorWorkflowLaneRetryDedupeKey(lane);
  return workflow.lanes.some((candidate) => candidate.dedupeKey === retryDedupeKey);
}

function isCommittedPlannedStageStatus(status: CoordinatorWorkflowStageStatus): boolean {
  return (
    status !== 'blocked' &&
    status !== 'cancelled' &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'skipped' &&
    status !== 'stale-after-restore'
  );
}

export function getCommittedWorkflowLaneCount(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'lanes' | 'sourceSpec' | 'stages'>,
): number {
  let plannedLaneCount = 0;
  for (const stage of workflow.stages) {
    if (stage.laneIds.length > 0 || !isCommittedPlannedStageStatus(stage.status)) {
      continue;
    }

    const step = workflow.sourceSpec?.steps.find((candidate) => candidate.id === stage.id);
    if (step !== undefined) {
      plannedLaneCount += countCoordinatorWorkflowSpecStepLanes(step);
    }
  }

  return workflow.lanes.length + plannedLaneCount;
}

export function getCoordinatorWorkflowStageSatisfiedResultCount(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'lanes'>,
  stage: Pick<CoordinatorWorkflowStageSnapshot, 'laneIds'>,
): number {
  const stageLaneIds = new Set(stage.laneIds);
  return workflow.lanes.filter(
    (lane) =>
      stageLaneIds.has(lane.id) &&
      lane.resultId !== undefined &&
      (lane.status === 'completed' || lane.status === 'waiting-for-result'),
  ).length;
}

export function getCoordinatorWorkflowStageRequiredResultCount(
  step: CoordinatorWorkflowSpecStepSnapshot | undefined,
): number {
  if (step?.kind === 'verify' && step.minimumVerifierCount !== undefined) {
    return step.minimumVerifierCount;
  }

  return 1;
}

/**
 * One authority for join-mode satisfaction. The backend executor and the renderer projection both
 * decide whether a stage unblocks its dependents from this helper; `step` is the stage's
 * `sourceSpec` step when one exists. The quorum fallback is the stage's required result count, not
 * a bare 1, so verify steps without an explicit quorum still honor `minimumVerifierCount`.
 */
export function isCoordinatorWorkflowStageDependencySatisfied(
  workflow: Pick<CoordinatorWorkflowSnapshot, 'lanes'>,
  stage: Pick<CoordinatorWorkflowStageSnapshot, 'laneIds' | 'status'>,
  step: CoordinatorWorkflowSpecStepSnapshot | undefined,
): boolean {
  if (
    stage.status === 'blocked' ||
    stage.status === 'cancelled' ||
    stage.status === 'failed' ||
    stage.status === 'stale-after-restore'
  ) {
    return false;
  }
  if (stage.status === 'completed') {
    return true;
  }
  if (stage.laneIds.length === 0) {
    return false;
  }

  const joinMode = step?.policy?.joinMode ?? 'all';
  const satisfiedResultCount = getCoordinatorWorkflowStageSatisfiedResultCount(workflow, stage);
  switch (joinMode) {
    case 'all':
      return false;
    case 'any':
      return satisfiedResultCount >= 1;
    case 'first-success':
      return satisfiedResultCount >= 1;
    case 'quorum':
      return (
        satisfiedResultCount >=
        (step?.policy?.quorumCount ?? getCoordinatorWorkflowStageRequiredResultCount(step))
      );
  }
}

export function createCoordinatorWorkflowBudgetSnapshot(
  workflow: CoordinatorWorkflowSnapshot,
): CoordinatorWorkflowBudgetSnapshot {
  const limits = getCoordinatorWorkflowBudgetLimits(workflow.policy);
  const exhausted = workflow.execution?.budget?.exhausted;
  const retriesExhaustedAt = workflow.execution?.budget?.retriesExhaustedAt;
  return {
    deadlineAt:
      workflow.execution?.deadlineAt ??
      (workflow.startedAt ?? workflow.createdAt) + limits.maxWallClockMs,
    ...(exhausted !== undefined ? { exhausted } : {}),
    lanes: { limit: limits.maxTotalLanes, used: getCommittedWorkflowLaneCount(workflow) },
    retries: {
      limit: limits.maxTotalRetries,
      used: countCoordinatorWorkflowRetriesUsed(workflow),
    },
    ...(retriesExhaustedAt !== undefined ? { retriesExhaustedAt } : {}),
    steps: {
      limit: limits.maxTotalSteps,
      used: workflow.sourceSpec?.steps.length ?? workflow.stages.length,
    },
  };
}

export function formatCoordinatorWorkflowBudgetExhaustedReason(
  dimension: CoordinatorWorkflowBudgetDimension,
  usage: CoordinatorWorkflowBudgetUsageSnapshot,
): string {
  return `budget-exhausted: ${dimension} (${usage.used}/${usage.limit})`;
}

function isCoordinatorSpawnAgentConfig(value: unknown): value is CoordinatorSpawnAgentConfig {
  return (
    isRecord(value) &&
    (value.args === undefined || isStringArray(value.args)) &&
    typeof value.command === 'string' &&
    (value.env === undefined ||
      (isRecord(value.env) &&
        Object.values(value.env).every((entry) => typeof entry === 'string'))) &&
    (value.followupPromptMode === undefined ||
      isCoordinatorAgentFollowupPromptMode(value.followupPromptMode)) &&
    (value.initialAssignmentMode === undefined ||
      isCoordinatorAgentInitialAssignmentMode(value.initialAssignmentMode)) &&
    isOptionalString(value.name) &&
    (value.readinessPolicy === undefined ||
      isCoordinatorAgentReadinessPolicy(value.readinessPolicy)) &&
    (value.skipPermissionsArgs === undefined || isStringArray(value.skipPermissionsArgs))
  );
}

export function isCoordinatorSubtaskLaunchSnapshot(
  value: unknown,
): value is CoordinatorSubtaskLaunchSnapshot {
  return (
    isRecord(value) &&
    isCoordinatorSpawnAgentConfig(value.agent) &&
    typeof value.assignment === 'string' &&
    isOptionalString(value.baseBranch) &&
    isOptionalString(value.branchPrefix) &&
    typeof value.dedupeKey === 'string' &&
    typeof value.name === 'string' &&
    isNonNegativeInteger(value.recordedAt) &&
    typeof value.runId === 'string' &&
    typeof value.taskId === 'string'
  );
}

export function isCoordinatorRunResumeSnapshot(
  value: unknown,
): value is CoordinatorRunResumeSnapshot {
  return (
    isRecord(value) &&
    isStringArray(value.failedTaskIds) &&
    isNonNegativeInteger(value.requestedAt) &&
    isStringArray(value.respawnedTaskIds) &&
    typeof value.resumeId === 'string'
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
    isOptionalNonNegativeInteger(value.pausedAt) &&
    typeof value.projectId === 'string' &&
    isProjectMode(value.projectMode) &&
    typeof value.projectRoot === 'string' &&
    isArrayOf(value.promptQueue, isCoordinatorPromptRequestSnapshot) &&
    (value.resumes === undefined || isArrayOf(value.resumes, isCoordinatorRunResumeSnapshot)) &&
    isCoordinatorRunStatus(value.status) &&
    isArrayOf(value.subtasks, isCoordinatorSubtaskSnapshot) &&
    isNonNegativeInteger(value.updatedAt) &&
    (value.workflows === undefined || isArrayOf(value.workflows, isCoordinatorWorkflowSnapshot))
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
