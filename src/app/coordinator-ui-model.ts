import type {
  CoordinatorLandingStateSnapshot,
  CoordinatorOperatorActionName,
  CoordinatorPromptRequestSnapshot,
  CoordinatorPromptStatus,
  CoordinatorRunSnapshot,
  CoordinatorRunStatus,
  CoordinatorSubtaskSnapshot,
  CoordinatorSubtaskStartupSnapshot,
  CoordinatorSubtaskStatus,
  CoordinatorToolName,
  CoordinatorWorkflowBudgetSnapshot,
  CoordinatorWorkflowPendingApprovalSnapshot,
  CoordinatorWorkflowSnapshot,
  CoordinatorWorkflowStageSnapshot,
} from '../domain/coordinator';
import {
  COORDINATOR_RENDERER_ACTION_ALLOWED_RUN_STATUSES,
  countCoordinatorWorkflowPendingApprovals,
  getCoordinatorSubtaskStartupSnapshot,
  hasScheduledCoordinatorWorkflowLaneRetry,
  isCoordinatorPendingPromptStatus,
  isCoordinatorTerminalSubtaskStatus,
  isCoordinatorTerminalWorkflowLaneStatus,
  isCoordinatorWorkflowStageDependencySatisfied,
} from '../domain/coordinator';
import type {
  CoordinatorWorkflowSpecSnapshot,
  CoordinatorWorkflowSpecStepJoinMode,
} from '../domain/coordinator-workflow-spec';

export type CoordinatorAttentionLevel = 'normal' | 'info' | 'success' | 'warning' | 'danger';

export type CoordinatorUiActionId =
  | 'approve-actions'
  | 'ask-land'
  | 'close'
  | 'copy-debug-command'
  | 'deny-actions'
  | 'inspect-diff'
  | 'inspect-output'
  | 'pause-run'
  | 'resume-run'
  | 'retry-lane'
  | 'send-prompt'
  | 'spawn-subtask'
  | 'unpause-run'
  | 'wait-for-idle';

type CoordinatorUiToolName =
  | Exclude<
      CoordinatorToolName,
      'append_workflow_steps' | 'land_self' | 'signal_done' | 'submit_result'
    >
  | CoordinatorOperatorActionName;

export interface CoordinatorUiAction {
  danger: boolean;
  disabled: boolean;
  id: CoordinatorUiActionId;
  label: string;
  reason?: string;
  toolName?: CoordinatorUiToolName;
}

export interface CoordinatorPromptBeadView {
  label: string;
  prompt: CoordinatorPromptRequestSnapshot;
  tone: CoordinatorAttentionLevel;
  title: string;
}

export interface CoordinatorSubtaskChipView {
  agentId: string;
  assignment: string;
  attentionRank: number;
  badgeText?: string;
  branchName?: string;
  diffHint: boolean;
  followupPromptEnabled: boolean;
  followupPromptModeLabel: string;
  initialAssignmentLabel: string;
  label: string;
  landing?: CoordinatorLandingStateSnapshot;
  landingLabel?: string;
  promptBeads: CoordinatorPromptBeadView[];
  readinessPolicyLabel: string;
  result?: string;
  status: CoordinatorSubtaskStatus;
  statusDetail?: string;
  statusLabel: string;
  taskId: string;
  title: string;
  tone: CoordinatorAttentionLevel;
  updatedAt: number;
  worktreePath: string;
}

export interface CoordinatorRunSummaryView {
  activeCount: number;
  attentionCount: number;
  blockedCount: number;
  failedCount: number;
  landingCount: number;
  paused: boolean;
  pendingApprovalCount: number;
  pendingPromptCount: number;
  readyCount: number;
  runStatus: CoordinatorRunStatus;
  runTone: CoordinatorAttentionLevel;
  stale: boolean;
  statusLabel: string;
  subtaskLimit: number;
}

export interface CoordinatorWorkflowStageView {
  blockedLaneCount: number;
  completedLaneCount: number;
  dependencySatisfied: boolean;
  dependencyStatusLabel: string;
  failedLaneCount: number;
  failure?: string;
  id: string;
  joinLabel: string;
  kind: CoordinatorWorkflowStageSnapshot['kind'];
  label: string;
  laneCount: number;
  name: string;
  resultCount: number;
  runningLaneCount: number;
  status: CoordinatorWorkflowStageSnapshot['status'];
  statusLabel: string;
  title: string;
  tone: CoordinatorAttentionLevel;
}

export interface CoordinatorWorkflowActivityView {
  at: number;
  kind: string;
  laneLabel?: string;
  message: string;
  resultLabel?: string;
  stageLabel?: string;
  tone: CoordinatorAttentionLevel;
}

export interface CoordinatorWorkflowResultView {
  commandCount: number;
  commandsPreview: string[];
  confidence?: string;
  evidenceCount: number;
  findingCount: number;
  findingsPreview: string[];
  id: string;
  laneLabel?: string;
  riskCount: number;
  risksPreview: string[];
  stageLabel?: string;
  status: CoordinatorWorkflowSnapshot['results'][number]['status'];
  statusLabel: string;
  summary: string;
  tone: CoordinatorAttentionLevel;
}

export interface CoordinatorWorkflowVerdictSummaryView {
  confirmed: number;
  needsMoreEvidence: number;
  refuted: number;
}

export interface CoordinatorWorkflowBudgetUsageView {
  limit: number;
  used: number;
}

export interface CoordinatorWorkflowBudgetView {
  deadlineAt: number;
  exhaustedLabel?: string;
  lanes: CoordinatorWorkflowBudgetUsageView;
  pressure: 'ok' | 'high' | 'exhausted';
  retries: CoordinatorWorkflowBudgetUsageView;
  steps: CoordinatorWorkflowBudgetUsageView;
}

export interface CoordinatorWorkflowApprovalView {
  actionSummary: string;
  approvalGateReason?: string;
  createdAt: number;
  id: string;
  laneLabel: string;
  stageLabel: string;
}

export interface CoordinatorWorkflowRetryableLaneView {
  failure?: string;
  laneId: string;
  name: string;
  retryGateReason?: string;
  status: 'failed' | 'timed-out';
}

export interface CoordinatorWorkflowTimelineView {
  activeLaneCount: number;
  appendCount: number;
  activityCount: number;
  activityPreview: CoordinatorWorkflowActivityView[];
  blockedStageCount: number;
  blockedReason?: string;
  branchIterationCount: number;
  budget?: CoordinatorWorkflowBudgetView;
  completedStageCount: number;
  completionReason?: string;
  dependencySatisfiedStageCount: number;
  expansionCount: number;
  failedLaneCount: number;
  failedLaneReason?: string;
  findingCount: number;
  hasMoreActivity: boolean;
  hasMoreResults: boolean;
  id: string;
  latestActivityLabel?: string;
  pendingApprovals: CoordinatorWorkflowApprovalView[];
  resultPreview: CoordinatorWorkflowResultView[];
  resultCount: number;
  retryableLaneCount: number;
  retryableManualLanes: CoordinatorWorkflowRetryableLaneView[];
  skippedStageCount: number;
  stages: CoordinatorWorkflowStageView[];
  stepCount: number;
  status: CoordinatorWorkflowSnapshot['status'];
  statusLabel: string;
  stale: boolean;
  template: CoordinatorWorkflowSnapshot['template'];
  timedOutLaneCount: number;
  title: string;
  tone: CoordinatorAttentionLevel;
  updatedAt: number;
  verdictSummary: CoordinatorWorkflowVerdictSummaryView;
}

export interface CoordinatorRunView {
  chips: CoordinatorSubtaskChipView[];
  debugCommand?: string;
  empty: boolean;
  pauseAction: CoordinatorUiAction;
  resumeAction: CoordinatorUiAction;
  run: CoordinatorRunSnapshot;
  spawnAction: CoordinatorUiAction;
  summary: CoordinatorRunSummaryView;
  workflows: CoordinatorWorkflowTimelineView[];
}

const MAX_PROMPT_BEADS_PER_SUBTASK = 3;
const MAX_WORKFLOW_ACTIVITY_PREVIEW = 5;
const MAX_WORKFLOW_RESULT_PREVIEW = 4;
const MAX_WORKFLOW_RESULT_TEXT_PREVIEW = 3;
const MAX_WORKFLOW_RETRYABLE_LANE_PREVIEW = 4;

const BLOCKED_SUBTASK_STATUSES = new Set<CoordinatorSubtaskStatus>([
  'waiting-for-user',
  'waiting-for-coordinator',
]);

const FAILED_SUBTASK_STATUSES = new Set<CoordinatorSubtaskStatus>([
  'cleanup-failed',
  'failed',
  'landing-failed',
]);

const LANDING_SUBTASK_STATUSES = new Set<CoordinatorSubtaskStatus>(['landing']);

const READY_SUBTASK_STATUSES = new Set<CoordinatorSubtaskStatus>(['ready-for-review']);

const ACTIVE_SUBTASK_STATUSES = new Set<CoordinatorSubtaskStatus>([
  'queued',
  'spawning',
  'waiting-for-agent-ready',
  'running',
  'waiting-for-user',
  'waiting-for-coordinator',
  'ready-for-review',
  'landing',
]);

const FAILED_LANDING_STATUSES = new Set<CoordinatorLandingStateSnapshot['status']>([
  'blocked-by-parent-control',
  'cleanup-failed',
  'dirty-parent-worktree',
  'dirty-worktree',
  'landing-failed',
  'merge-conflict',
  'rejected',
  'verification-failed',
]);

const ACTIVE_LANDING_STATUSES = new Set<CoordinatorLandingStateSnapshot['status']>([
  'cleanup',
  'merging',
  'requested',
  'validating',
]);

function humanizeStatus(status: string): string {
  return status
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function humanizeWaitingReason(reason: string): string {
  switch (reason) {
    case 'agent-active':
      return 'Agent is still rendering output';
    case 'agent-awaiting-input':
      return 'Agent is blocked on an interactive question';
    case 'agent-quiet':
      return 'Waiting for the terminal to reach a prompt';
    case 'agent-session-missing':
      return 'Waiting for the agent session';
    case 'agent-supervision-missing':
      return 'Waiting for agent supervision';
    case 'task-command-lease-held':
      return 'Waiting for command control';
    case 'terminal-pending-input':
      return 'Waiting for pending terminal input to clear';
    case 'terminal-printable-input':
      return 'Waiting for terminal input to clear';
    case 'prompt-draft':
      return 'Waiting for the prompt draft to clear';
    case 'terminal-focus':
      return 'Waiting for terminal focus to clear';
    case 'manual-prompt-sent':
      return 'Waiting for another prompt to finish';
    default:
      if (reason.startsWith('agent-')) {
        return humanizeStatus(reason.slice('agent-'.length));
      }

      return humanizeStatus(reason);
  }
}

function getInitialAssignmentLabel(subtask: CoordinatorSubtaskSnapshot): string {
  const startup = getCoordinatorSubtaskStartupSnapshot(subtask.startup);
  switch (startup.initialAssignmentStatus) {
    case 'blocked-by-question':
      return 'Initial assignment blocked by question';
    case 'delivered':
      return 'Initial assignment delivered after prompt';
    case 'failed':
      return 'Initial assignment delivery failed';
    case 'pending-prompt':
      return 'Initial assignment waits for prompt readiness';
    case 'seeded-at-spawn':
      return 'Initial assignment seeded at spawn';
  }
}

function getFollowupPromptModeLabel(subtask: CoordinatorSubtaskSnapshot): string {
  const startup = getCoordinatorSubtaskStartupSnapshot(subtask.startup);
  switch (startup.followupPromptMode) {
    case 'disallow':
      return 'Follow-up prompts disabled';
    case 'post-ready-prompt':
      return 'Follow-up prompts wait for readiness';
  }
}

function getReadinessPolicyLabel(subtask: CoordinatorSubtaskSnapshot): string {
  const startup = getCoordinatorSubtaskStartupSnapshot(subtask.startup);
  switch (startup.readinessPolicy) {
    case 'codex':
      return 'Codex readiness detection';
    case 'shell':
      return 'Shell prompt detection';
    case 'terminal-generic':
      return 'Generic terminal prompt detection';
  }
}

function getWaitingForPromptDetail(
  readinessPolicy: CoordinatorSubtaskStartupSnapshot['readinessPolicy'],
): string {
  if (readinessPolicy === 'codex') {
    return 'Waiting for the Codex composer prompt';
  }

  return 'Waiting for a terminal prompt';
}

function getPromptStatusDetail(
  prompt: CoordinatorPromptRequestSnapshot,
  subtask: CoordinatorSubtaskSnapshot,
): string | undefined {
  const startup = getCoordinatorSubtaskStartupSnapshot(subtask.startup);
  switch (prompt.status) {
    case 'blocked-by-question':
      return 'Blocked on an interactive question';
    case 'waiting-for-agent-session':
      return 'Waiting for the agent session';
    case 'waiting-for-command-lease':
      return 'Waiting for command control';
    case 'waiting-for-terminal-input-clear':
      return 'Waiting for terminal input to clear';
    case 'waiting-for-terminal-prompt':
      return getWaitingForPromptDetail(startup.readinessPolicy);
    case 'waiting-for-user-idle':
      return 'Waiting for manual terminal activity to stop';
    case 'queued':
      return 'Queued for delivery';
    case 'delivering':
      return 'Delivering prompt';
    case 'cancelled':
    case 'delivered':
    case 'failed':
    case 'write-unknown-after-restore':
      break;
  }

  return prompt.waitingReason ? humanizeWaitingReason(prompt.waitingReason) : undefined;
}

function getSubtaskStatusDetail(
  subtask: CoordinatorSubtaskSnapshot,
  pendingPrompts: readonly CoordinatorPromptRequestSnapshot[],
): string | undefined {
  const startup = getCoordinatorSubtaskStartupSnapshot(subtask.startup);
  const nextPrompt = pendingPrompts[0];
  if (nextPrompt) {
    return getPromptStatusDetail(nextPrompt, subtask);
  }

  if (subtask.status === 'running' && startup.initialAssignmentStatus === 'seeded-at-spawn') {
    return 'Started with the assignment at launch';
  }

  if (
    subtask.status === 'waiting-for-agent-ready' &&
    startup.initialAssignmentStatus === 'pending-prompt'
  ) {
    return getWaitingForPromptDetail(startup.readinessPolicy);
  }

  return undefined;
}

function getRunTone(status: CoordinatorRunStatus): CoordinatorAttentionLevel {
  switch (status) {
    case 'cancelled':
    case 'failed':
    case 'stale-after-restore':
      return 'danger';
    case 'draining':
    case 'paused-by-user':
      return 'warning';
    case 'completed':
      return 'success';
    case 'starting':
      return 'info';
    case 'running':
      return 'normal';
  }
}

function getWorkflowTone(status: CoordinatorWorkflowSnapshot['status']): CoordinatorAttentionLevel {
  switch (status) {
    case 'blocked':
    case 'cancelled':
    case 'failed':
    case 'stale-after-restore':
      return 'danger';
    case 'pending':
    case 'running':
    case 'waiting-for-results':
      return 'info';
    case 'completed':
      return 'success';
  }
}

function getWorkflowStageTone(
  status: CoordinatorWorkflowStageSnapshot['status'],
): CoordinatorAttentionLevel {
  switch (status) {
    case 'blocked':
    case 'cancelled':
    case 'failed':
    case 'stale-after-restore':
      return 'danger';
    case 'pending':
    case 'skipped':
      return 'normal';
    case 'running':
    case 'waiting-for-results':
      return 'info';
    case 'completed':
      return 'success';
  }
}

function getWorkflowResultTone(
  status: CoordinatorWorkflowSnapshot['results'][number]['status'],
): CoordinatorAttentionLevel {
  switch (status) {
    case 'blocked':
    case 'needs-followup':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'completed':
      return 'success';
  }
}

function getPromptTone(status: CoordinatorPromptStatus): CoordinatorAttentionLevel {
  switch (status) {
    case 'blocked-by-question':
    case 'failed':
    case 'write-unknown-after-restore':
      return 'danger';
    case 'waiting-for-agent-session':
    case 'waiting-for-command-lease':
    case 'waiting-for-terminal-input-clear':
    case 'waiting-for-terminal-prompt':
    case 'waiting-for-user-idle':
      return 'warning';
    case 'delivering':
    case 'queued':
      return 'info';
    case 'cancelled':
      return 'warning';
    case 'delivered':
      return 'success';
  }
}

function getSubtaskTone(
  subtask: CoordinatorSubtaskSnapshot,
  landing: CoordinatorLandingStateSnapshot | undefined,
): CoordinatorAttentionLevel {
  if (landing && FAILED_LANDING_STATUSES.has(landing.status)) {
    return 'danger';
  }
  if (FAILED_SUBTASK_STATUSES.has(subtask.status)) {
    return 'danger';
  }
  if (BLOCKED_SUBTASK_STATUSES.has(subtask.status)) {
    return 'warning';
  }
  if (landing && ACTIVE_LANDING_STATUSES.has(landing.status)) {
    return 'info';
  }
  if (LANDING_SUBTASK_STATUSES.has(subtask.status)) {
    return 'info';
  }
  if (READY_SUBTASK_STATUSES.has(subtask.status)) {
    return 'success';
  }
  if (subtask.status === 'landed') {
    return 'success';
  }
  if (subtask.status === 'queued' || subtask.status === 'spawning') {
    return 'info';
  }

  return 'normal';
}

function getAttentionRank(
  tone: CoordinatorAttentionLevel,
  status: CoordinatorSubtaskStatus,
): number {
  if (tone === 'danger') {
    return 0;
  }
  if (tone === 'warning') {
    return 1;
  }
  if (READY_SUBTASK_STATUSES.has(status)) {
    return 2;
  }
  if (tone === 'info') {
    return 3;
  }
  if (tone === 'success') {
    return 4;
  }

  return 5;
}

function getSubtaskLabel(subtask: CoordinatorSubtaskSnapshot, index: number): string {
  const trimmedAssignment = subtask.assignment.trim();
  if (trimmedAssignment.length === 0) {
    return String(index + 1);
  }

  const firstWord = trimmedAssignment.split(/\s+/)[0] ?? trimmedAssignment;
  return firstWord.slice(0, 1).toUpperCase();
}

function getPromptBeads(
  prompts: readonly CoordinatorPromptRequestSnapshot[],
): CoordinatorPromptBeadView[] {
  return prompts.slice(0, MAX_PROMPT_BEADS_PER_SUBTASK).map((prompt) => {
    const label = prompt.status === 'blocked-by-question' ? '?' : '•';
    return {
      label,
      prompt,
      tone: getPromptTone(prompt.status),
      title: `${humanizeStatus(prompt.status)}: ${prompt.text}`,
    };
  });
}

function getLandingLabel(landing: CoordinatorLandingStateSnapshot | undefined): string | undefined {
  if (!landing) {
    return undefined;
  }

  if (landing.status === 'landed') {
    return 'Landed';
  }
  if (FAILED_LANDING_STATUSES.has(landing.status)) {
    return humanizeStatus(landing.status);
  }
  if (ACTIVE_LANDING_STATUSES.has(landing.status)) {
    return humanizeStatus(landing.status);
  }

  return undefined;
}

function getSubtaskBadgeText(
  subtask: CoordinatorSubtaskSnapshot,
  pendingPrompts: readonly CoordinatorPromptRequestSnapshot[],
  landing: CoordinatorLandingStateSnapshot | undefined,
): string | undefined {
  if (pendingPrompts.length > 0) {
    return String(pendingPrompts.length);
  }
  if (landing && landing.status === 'landed') {
    return '✓';
  }
  if (READY_SUBTASK_STATUSES.has(subtask.status)) {
    return 'R';
  }
  if (FAILED_SUBTASK_STATUSES.has(subtask.status)) {
    return '!';
  }

  return undefined;
}

function getChipTitle(
  subtask: CoordinatorSubtaskSnapshot,
  pendingPrompts: readonly CoordinatorPromptRequestSnapshot[],
  landing: CoordinatorLandingStateSnapshot | undefined,
): string {
  const parts = [subtask.assignment, humanizeStatus(subtask.status)];
  const statusDetail = getSubtaskStatusDetail(subtask, pendingPrompts);
  if (statusDetail !== undefined) {
    parts.push(statusDetail);
  }
  if (pendingPrompts.length > 0) {
    parts.push(`${pendingPrompts.length} pending prompt${pendingPrompts.length === 1 ? '' : 's'}`);
  }
  if (landing) {
    parts.push(`Landing: ${humanizeStatus(landing.status)}`);
  }
  if (subtask.result) {
    parts.push(subtask.result);
  }

  return parts.join(' · ');
}

function getPendingPromptsByTarget(
  run: CoordinatorRunSnapshot,
): Map<string, CoordinatorPromptRequestSnapshot[]> {
  const promptsByTarget = new Map<string, CoordinatorPromptRequestSnapshot[]>();
  for (const prompt of run.promptQueue) {
    if (!isCoordinatorPendingPromptStatus(prompt.status)) {
      continue;
    }

    const prompts = promptsByTarget.get(prompt.targetTaskId) ?? [];
    prompts.push(prompt);
    promptsByTarget.set(prompt.targetTaskId, prompts);
  }

  return promptsByTarget;
}

function getLandingByTask(
  run: CoordinatorRunSnapshot,
): Map<string, CoordinatorLandingStateSnapshot> {
  const landingByTask = new Map<string, CoordinatorLandingStateSnapshot>();
  for (const landing of run.landing) {
    landingByTask.set(landing.taskId, landing);
  }

  return landingByTask;
}

function createSubtaskChipViews(run: CoordinatorRunSnapshot): CoordinatorSubtaskChipView[] {
  const promptsByTarget = getPendingPromptsByTarget(run);
  const landingByTask = getLandingByTask(run);

  return run.subtasks
    .map((subtask, index) => {
      const pendingPrompts = promptsByTarget.get(subtask.taskId) ?? [];
      const landing = landingByTask.get(subtask.taskId);
      const tone = getSubtaskTone(subtask, landing);
      const label = getSubtaskLabel(subtask, index);
      const badgeText = getSubtaskBadgeText(subtask, pendingPrompts, landing);
      const landingLabel = getLandingLabel(landing);
      const statusDetail = getSubtaskStatusDetail(subtask, pendingPrompts);
      const startup = getCoordinatorSubtaskStartupSnapshot(subtask.startup);
      return {
        agentId: subtask.agentId,
        assignment: subtask.assignment,
        attentionRank: getAttentionRank(tone, subtask.status),
        ...(badgeText !== undefined ? { badgeText } : {}),
        ...(subtask.branchName !== undefined ? { branchName: subtask.branchName } : {}),
        diffHint:
          subtask.status === 'ready-for-review' ||
          subtask.status === 'landing' ||
          (landing !== undefined && landing.status !== 'landed'),
        followupPromptEnabled: startup.followupPromptMode === 'post-ready-prompt',
        followupPromptModeLabel: getFollowupPromptModeLabel(subtask),
        initialAssignmentLabel: getInitialAssignmentLabel(subtask),
        label,
        ...(landing !== undefined ? { landing } : {}),
        ...(landingLabel !== undefined ? { landingLabel } : {}),
        promptBeads: getPromptBeads(pendingPrompts),
        readinessPolicyLabel: getReadinessPolicyLabel(subtask),
        ...(subtask.result !== undefined ? { result: subtask.result } : {}),
        status: subtask.status,
        ...(statusDetail !== undefined ? { statusDetail } : {}),
        statusLabel: humanizeStatus(subtask.status),
        taskId: subtask.taskId,
        title: getChipTitle(subtask, pendingPrompts, landing),
        tone,
        updatedAt: subtask.updatedAt,
        worktreePath: subtask.worktreePath,
      };
    })
    .sort((left, right) => {
      if (left.attentionRank !== right.attentionRank) {
        return left.attentionRank - right.attentionRank;
      }

      return right.updatedAt - left.updatedAt;
    });
}

function createSummaryView(run: CoordinatorRunSnapshot): CoordinatorRunSummaryView {
  let activeCount = 0;
  let blockedCount = 0;
  let failedCount = 0;
  let landingCount = 0;
  let readyCount = 0;
  const attentionTaskIds = new Set<string>();

  const landingByTask = getLandingByTask(run);
  for (const subtask of run.subtasks) {
    const landing = landingByTask.get(subtask.taskId);
    const tone = getSubtaskTone(subtask, landing);
    if (ACTIVE_SUBTASK_STATUSES.has(subtask.status)) {
      activeCount += 1;
    }
    if (tone === 'danger') {
      failedCount += 1;
      attentionTaskIds.add(subtask.taskId);
    }
    if (tone === 'warning') {
      blockedCount += 1;
      attentionTaskIds.add(subtask.taskId);
    }
    if (READY_SUBTASK_STATUSES.has(subtask.status)) {
      readyCount += 1;
      attentionTaskIds.add(subtask.taskId);
    }
    if (
      landing &&
      (ACTIVE_LANDING_STATUSES.has(landing.status) || FAILED_LANDING_STATUSES.has(landing.status))
    ) {
      landingCount += 1;
      attentionTaskIds.add(subtask.taskId);
    }
  }

  const pendingPromptCount = run.promptQueue.filter((prompt) =>
    isCoordinatorPendingPromptStatus(prompt.status),
  ).length;
  const pendingApprovalCount = (run.workflows ?? []).reduce(
    (count, workflow) => count + countCoordinatorWorkflowPendingApprovals(workflow),
    0,
  );

  return {
    activeCount,
    attentionCount: attentionTaskIds.size + pendingApprovalCount,
    blockedCount,
    failedCount,
    landingCount,
    paused: run.status === 'paused-by-user',
    pendingApprovalCount,
    pendingPromptCount,
    readyCount,
    runStatus: run.status,
    runTone: getRunTone(run.status),
    stale: run.status === 'stale-after-restore',
    statusLabel: humanizeStatus(run.status),
    subtaskLimit: run.limits.maxActiveSubtasks,
  };
}

function getWorkflowSpecStep(
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
): CoordinatorWorkflowSpecSnapshot['steps'][number] | undefined {
  return workflow.sourceSpec?.steps.find((step) => step.id === stageId);
}

function getWorkflowJoinModeLabel(
  joinMode: CoordinatorWorkflowSpecStepJoinMode | undefined,
  quorumCount: number | undefined,
): string {
  switch (joinMode) {
    case 'any':
      return 'Join any';
    case 'first-success':
      return 'Join first success';
    case 'quorum':
      return `Join quorum${quorumCount !== undefined ? ` ${quorumCount}` : ''}`;
    case 'all':
    case undefined:
      return 'Join all';
  }
}

function createWorkflowStageView(
  workflow: CoordinatorWorkflowSnapshot,
  stage: CoordinatorWorkflowStageSnapshot,
): CoordinatorWorkflowStageView {
  const step = getWorkflowSpecStep(workflow, stage.id);
  const stageLaneIds = new Set(stage.laneIds);
  let blockedLaneCount = 0;
  let completedLaneCount = 0;
  let failedLaneCount = 0;
  let laneCount = 0;
  let runningLaneCount = 0;
  for (const lane of workflow.lanes) {
    if (!stageLaneIds.has(lane.id)) {
      continue;
    }

    laneCount += 1;
    if (isCoordinatorTerminalWorkflowLaneStatus(lane.status)) {
      completedLaneCount += 1;
    } else {
      runningLaneCount += 1;
    }
    if (lane.status === 'blocked' || lane.status === 'cancelled') {
      blockedLaneCount += 1;
    }
    if (
      lane.status === 'failed' ||
      lane.status === 'timed-out' ||
      lane.status === 'stale-after-restore'
    ) {
      failedLaneCount += 1;
    }
  }
  const dependencySatisfied = isCoordinatorWorkflowStageDependencySatisfied(workflow, stage, step);
  const label = stage.name.slice(0, 1).toUpperCase();
  const joinLabel = getWorkflowJoinModeLabel(step?.policy?.joinMode, step?.policy?.quorumCount);
  const dependencyStatusLabel = dependencySatisfied
    ? 'Downstream unblocked'
    : step?.policy?.joinMode !== undefined && step.policy.joinMode !== 'all'
      ? 'Waiting for join'
      : 'Waits for full completion';
  const titleParts = [
    `${stage.name}: ${humanizeStatus(stage.status)} (${completedLaneCount}/${laneCount} lanes, ${stage.resultIds.length} results)`,
    joinLabel,
    dependencyStatusLabel,
  ];
  if (stage.failure !== undefined) {
    titleParts.push(stage.failure);
  }

  return {
    blockedLaneCount,
    completedLaneCount,
    dependencySatisfied,
    dependencyStatusLabel,
    failedLaneCount,
    ...(stage.failure !== undefined ? { failure: stage.failure } : {}),
    id: stage.id,
    joinLabel,
    kind: stage.kind,
    label,
    laneCount,
    name: stage.name,
    resultCount: stage.resultIds.length,
    runningLaneCount,
    status: stage.status,
    statusLabel: humanizeStatus(stage.status),
    title: titleParts.join(' · '),
    tone: getWorkflowStageTone(stage.status),
  };
}

function getWorkflowStageName(
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
): string | undefined {
  return workflow.stages.find((stage) => stage.id === stageId)?.name;
}

function getWorkflowLaneName(
  workflow: CoordinatorWorkflowSnapshot,
  laneId: string,
): string | undefined {
  return workflow.lanes.find((lane) => lane.id === laneId)?.name;
}

function getWorkflowResultLabel(
  workflow: CoordinatorWorkflowSnapshot,
  resultId: string,
): string | undefined {
  const result = workflow.results.find((candidate) => candidate.id === resultId);
  if (!result) {
    return undefined;
  }

  return result.summary.slice(0, 80);
}

const WORKFLOW_ACTIVITY_TONE_BY_KIND: Record<string, CoordinatorAttentionLevel> = {
  'decision-approval-approved': 'success',
  'decision-approval-cancelled': 'danger',
  'decision-approval-denied': 'warning',
  'decision-approval-requested': 'warning',
  'lane-manual-retry': 'info',
  'run-paused': 'warning',
  'run-unpaused': 'info',
  'workflow-budget-exhausted': 'danger',
};

function getWorkflowActivityTone(kind: string): CoordinatorAttentionLevel {
  const exactTone = WORKFLOW_ACTIVITY_TONE_BY_KIND[kind];
  if (exactTone !== undefined) {
    return exactTone;
  }
  if (kind.includes('failed') || kind.includes('timed-out') || kind.includes('cancelled')) {
    return 'danger';
  }
  if (kind.includes('retry') || kind.includes('blocked')) {
    return 'warning';
  }
  if (
    kind.includes('result') ||
    kind.includes('completed') ||
    kind.includes('stopped') ||
    kind.includes('verdict')
  ) {
    return 'success';
  }
  if (
    kind.includes('appended') ||
    kind.includes('running') ||
    kind.includes('spawning') ||
    kind.includes('skipped')
  ) {
    return 'info';
  }

  return 'normal';
}

function createWorkflowActivityViews(
  workflow: CoordinatorWorkflowSnapshot,
): CoordinatorWorkflowActivityView[] {
  return workflow.journal
    .slice(-MAX_WORKFLOW_ACTIVITY_PREVIEW)
    .reverse()
    .map((entry) => {
      const view: CoordinatorWorkflowActivityView = {
        at: entry.at,
        kind: entry.kind,
        message: entry.message,
        tone: getWorkflowActivityTone(entry.kind),
      };
      if (entry.laneId !== undefined) {
        view.laneLabel = getWorkflowLaneName(workflow, entry.laneId) ?? entry.laneId;
      }
      if (entry.resultId !== undefined) {
        view.resultLabel = getWorkflowResultLabel(workflow, entry.resultId) ?? entry.resultId;
      }
      if (entry.stageId !== undefined) {
        view.stageLabel = getWorkflowStageName(workflow, entry.stageId) ?? entry.stageId;
      }
      return view;
    });
}

function createWorkflowResultViews(
  workflow: CoordinatorWorkflowSnapshot,
): CoordinatorWorkflowResultView[] {
  return workflow.results
    .slice(-MAX_WORKFLOW_RESULT_PREVIEW)
    .reverse()
    .map((result) => {
      const view: CoordinatorWorkflowResultView = {
        commandCount: result.commandsRun.length,
        commandsPreview: result.commandsRun.slice(0, MAX_WORKFLOW_RESULT_TEXT_PREVIEW),
        evidenceCount: result.evidence.length,
        findingCount: result.findings.length,
        findingsPreview: result.findings
          .map((finding) => finding.title ?? finding.summary)
          .slice(0, MAX_WORKFLOW_RESULT_TEXT_PREVIEW),
        id: result.id,
        riskCount: result.risks.length,
        risksPreview: result.risks.slice(0, MAX_WORKFLOW_RESULT_TEXT_PREVIEW),
        status: result.status,
        statusLabel: humanizeStatus(result.status),
        summary: result.summary,
        tone: getWorkflowResultTone(result.status),
      };
      if (result.confidence !== undefined) {
        view.confidence = result.confidence;
      }
      if (result.laneId !== undefined) {
        view.laneLabel = getWorkflowLaneName(workflow, result.laneId) ?? result.laneId;
      }
      if (result.stageId !== undefined) {
        view.stageLabel = getWorkflowStageName(workflow, result.stageId) ?? result.stageId;
      }
      return view;
    });
}

function createWorkflowBudgetView(
  budget: CoordinatorWorkflowBudgetSnapshot,
): CoordinatorWorkflowBudgetView {
  const usages = [budget.lanes, budget.retries, budget.steps];
  const highPressure = usages.some((usage) => usage.limit > 0 && usage.used >= usage.limit * 0.8);

  let pressure: CoordinatorWorkflowBudgetView['pressure'] = 'ok';
  if (budget.exhausted !== undefined) {
    pressure = 'exhausted';
  } else if (highPressure) {
    pressure = 'high';
  }

  return {
    deadlineAt: budget.deadlineAt,
    ...(budget.exhausted !== undefined ? { exhaustedLabel: budget.exhausted } : {}),
    lanes: { limit: budget.lanes.limit, used: budget.lanes.used },
    pressure,
    retries: { limit: budget.retries.limit, used: budget.retries.used },
    steps: { limit: budget.steps.limit, used: budget.steps.used },
  };
}

function getWorkflowApprovalActionSummary(
  actions: CoordinatorWorkflowPendingApprovalSnapshot['actions'],
): string {
  return actions
    .map((action) => {
      switch (action.kind) {
        case 'append_branch_bundle':
          return `${action.kind} ${action.bundleId}`;
        case 'mark_blocked':
        case 'stop_workflow':
          return `${action.kind}: ${action.reason}`;
        case 'append_fanout':
        case 'append_synthesize':
        case 'append_verify':
        case 'append_worker':
          return `${action.kind} ${action.step.id}`;
      }
    })
    .join(' · ');
}

function getWorkflowApprovalGateReason(
  run: CoordinatorRunSnapshot,
  workflow: CoordinatorWorkflowSnapshot,
): string | undefined {
  if (
    !COORDINATOR_RENDERER_ACTION_ALLOWED_RUN_STATUSES.approve_workflow_actions.includes(run.status)
  ) {
    return `Run is ${run.status}.`;
  }
  if (workflow.status !== 'running' && workflow.status !== 'waiting-for-results') {
    return `Workflow is ${workflow.status}.`;
  }

  return undefined;
}

function getWorkflowManualRetryGateReason(
  run: CoordinatorRunSnapshot,
  workflow: CoordinatorWorkflowSnapshot,
): string | undefined {
  if (!COORDINATOR_RENDERER_ACTION_ALLOWED_RUN_STATUSES.retry_lane.includes(run.status)) {
    return `Run is ${run.status}.`;
  }
  if (workflow.status !== 'running' && workflow.status !== 'waiting-for-results') {
    return `Workflow is ${workflow.status}.`;
  }

  return undefined;
}

function createWorkflowApprovalViews(
  workflow: CoordinatorWorkflowSnapshot,
  run: CoordinatorRunSnapshot,
): CoordinatorWorkflowApprovalView[] {
  const gateReason = getWorkflowApprovalGateReason(run, workflow);
  return (workflow.pendingApprovals ?? [])
    .filter((approval) => approval.status === 'pending')
    .map((approval) => ({
      actionSummary: getWorkflowApprovalActionSummary(approval.actions),
      ...(gateReason !== undefined ? { approvalGateReason: gateReason } : {}),
      createdAt: approval.createdAt,
      id: approval.id,
      laneLabel: getWorkflowLaneName(workflow, approval.laneId) ?? approval.laneId,
      stageLabel: getWorkflowStageName(workflow, approval.stageId) ?? approval.stageId,
    }));
}

function createWorkflowRetryableLaneViews(
  workflow: CoordinatorWorkflowSnapshot,
  run: CoordinatorRunSnapshot,
): CoordinatorWorkflowRetryableLaneView[] {
  const gateReason = getWorkflowManualRetryGateReason(run, workflow);
  return workflow.lanes
    .flatMap((lane) => {
      if (lane.status !== 'failed' && lane.status !== 'timed-out') {
        return [];
      }
      if (lane.resultId !== undefined || hasScheduledCoordinatorWorkflowLaneRetry(workflow, lane)) {
        return [];
      }

      return [
        {
          ...(lane.failure !== undefined ? { failure: lane.failure } : {}),
          laneId: lane.id,
          name: lane.name,
          ...(gateReason !== undefined ? { retryGateReason: gateReason } : {}),
          status: lane.status,
        },
      ];
    })
    .slice(0, MAX_WORKFLOW_RETRYABLE_LANE_PREVIEW);
}

function createWorkflowVerdictSummary(
  workflow: CoordinatorWorkflowSnapshot,
): CoordinatorWorkflowVerdictSummaryView {
  const verdicts = workflow.verdicts ?? [];
  return {
    confirmed: verdicts.filter((verdict) => verdict.status === 'confirmed').length,
    needsMoreEvidence: verdicts.filter((verdict) => verdict.status === 'needs-more-evidence')
      .length,
    refuted: verdicts.filter((verdict) => verdict.status === 'refuted').length,
  };
}

function createWorkflowTimelineView(
  workflow: CoordinatorWorkflowSnapshot,
  run: CoordinatorRunSnapshot,
): CoordinatorWorkflowTimelineView {
  const stages = workflow.stages.map((stage) => createWorkflowStageView(workflow, stage));
  const activeLaneCount =
    workflow.execution?.activeLaneCount ??
    workflow.lanes.filter((lane) => !isCoordinatorTerminalWorkflowLaneStatus(lane.status)).length;
  const blockedStageCount = workflow.stages.filter((stage) => stage.status === 'blocked').length;
  const branchIterationCount = (workflow.expansions ?? [])
    .flatMap((expansion) => expansion.actions)
    .filter((action) => action.iteration !== undefined).length;
  const completedStageCount =
    workflow.execution?.completedStageCount ??
    workflow.stages.filter((stage) => stage.status === 'completed').length;
  const dependencySatisfiedStageCount = stages.filter((stage) => stage.dependencySatisfied).length;
  const expansionCount = workflow.execution?.expansionCount ?? workflow.expansions?.length ?? 0;
  const findingCount = workflow.results.reduce(
    (count, result) => count + result.findings.length,
    0,
  );
  const failedLanes = workflow.lanes.filter(
    (lane) =>
      lane.status === 'failed' ||
      lane.status === 'timed-out' ||
      lane.status === 'stale-after-restore',
  );
  const activityPreview = createWorkflowActivityViews(workflow);
  const blockedReason = workflow.execution?.blockedReason;
  const budget = workflow.execution?.budget;
  const completionReason = workflow.execution?.completionReason;
  const failedLaneReason = failedLanes[0]?.failure;
  const latestActivityLabel = activityPreview[0]?.message;
  const resultPreview = createWorkflowResultViews(workflow);
  const retryableLaneCount = workflow.execution?.retryableLaneCount ?? 0;
  const skippedStageCount =
    workflow.execution?.skippedStageCount ??
    workflow.stages.filter((stage) => stage.status === 'skipped').length;
  const stepCount = workflow.sourceSpec?.steps.length ?? workflow.stages.length;
  const timedOutLaneCount =
    workflow.execution?.timedOutLaneCount ??
    workflow.lanes.filter((lane) => lane.status === 'timed-out').length;
  const pendingApprovals = createWorkflowApprovalViews(workflow, run);
  const retryableManualLanes = createWorkflowRetryableLaneViews(workflow, run);
  const baseTone = getWorkflowTone(workflow.status);

  return {
    activeLaneCount,
    appendCount: workflow.stepAppends?.length ?? 0,
    activityCount: workflow.journal.length,
    activityPreview,
    blockedStageCount,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
    branchIterationCount,
    ...(budget !== undefined ? { budget: createWorkflowBudgetView(budget) } : {}),
    completedStageCount,
    ...(completionReason !== undefined ? { completionReason } : {}),
    dependencySatisfiedStageCount,
    expansionCount,
    failedLaneCount: failedLanes.length,
    ...(failedLaneReason !== undefined ? { failedLaneReason } : {}),
    findingCount,
    hasMoreActivity: workflow.journal.length > activityPreview.length,
    hasMoreResults: workflow.results.length > resultPreview.length,
    id: workflow.id,
    ...(latestActivityLabel !== undefined ? { latestActivityLabel } : {}),
    pendingApprovals,
    resultPreview,
    resultCount: workflow.results.length,
    retryableLaneCount,
    retryableManualLanes,
    skippedStageCount,
    stages,
    stepCount,
    status: workflow.status,
    statusLabel: humanizeStatus(workflow.status),
    stale: workflow.status === 'stale-after-restore',
    template: workflow.template,
    timedOutLaneCount,
    title: workflow.title,
    tone: pendingApprovals.length > 0 && baseTone === 'info' ? 'warning' : baseTone,
    updatedAt: workflow.updatedAt,
    verdictSummary: createWorkflowVerdictSummary(workflow),
  };
}

function createWorkflowTimelineViews(
  run: CoordinatorRunSnapshot,
): CoordinatorWorkflowTimelineView[] {
  return (run.workflows ?? [])
    .map((workflow) => createWorkflowTimelineView(workflow, run))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function createSpawnAction(run: CoordinatorRunSnapshot): CoordinatorUiAction {
  const activeOrQueuedCount = run.subtasks.filter((subtask) =>
    ACTIVE_SUBTASK_STATUSES.has(subtask.status),
  ).length;
  const limit = run.limits.maxActiveSubtasks + run.limits.maxQueuedSubtasks;
  const disabled = activeOrQueuedCount >= limit || run.status !== 'running';

  return {
    danger: false,
    disabled,
    id: 'spawn-subtask',
    label: 'Spawn subtask',
    ...(disabled
      ? {
          reason:
            activeOrQueuedCount >= limit
              ? 'Coordinator subtask queue is full.'
              : `Run is ${run.status}.`,
        }
      : {}),
    toolName: 'spawn_subtask',
  };
}

function createPauseAction(run: CoordinatorRunSnapshot): CoordinatorUiAction {
  if (COORDINATOR_RENDERER_ACTION_ALLOWED_RUN_STATUSES.unpause_run.includes(run.status)) {
    return {
      danger: false,
      disabled: false,
      id: 'unpause-run',
      label: 'Unpause',
      toolName: 'unpause_run',
    };
  }

  const disabled = !COORDINATOR_RENDERER_ACTION_ALLOWED_RUN_STATUSES.pause_run.includes(run.status);
  return {
    danger: false,
    disabled,
    id: 'pause-run',
    label: 'Pause',
    ...(disabled ? { reason: `Run is ${run.status}; only running runs can be paused.` } : {}),
    toolName: 'pause_run',
  };
}

function createResumeAction(run: CoordinatorRunSnapshot): CoordinatorUiAction {
  const disabled = !COORDINATOR_RENDERER_ACTION_ALLOWED_RUN_STATUSES.resume_run.includes(
    run.status,
  );

  return {
    danger: false,
    disabled,
    id: 'resume-run',
    label: 'Resume run',
    ...(disabled ? { reason: `Run is ${run.status}; only stale runs can be resumed.` } : {}),
    toolName: 'resume_run',
  };
}

function getTerminalDisabledReason(terminal: boolean): string | undefined {
  if (!terminal) {
    return undefined;
  }

  return 'Terminal subtask is no longer active.';
}

function getInspectDiffDisabledReason(nonGit: boolean, terminal: boolean): string | undefined {
  if (terminal) {
    return getTerminalDisabledReason(terminal);
  }
  if (nonGit) {
    return 'Diff inspection requires a git-backed coordinator run.';
  }

  return undefined;
}

function getMutationDisabledReason(run: CoordinatorRunSnapshot): string | undefined {
  if (run.status === 'running' || run.status === 'draining') {
    return undefined;
  }

  return `Run is ${run.status}.`;
}

function getSendPromptDisabledReason(
  chip: CoordinatorSubtaskChipView,
  run: CoordinatorRunSnapshot,
  terminal: boolean,
): string | undefined {
  if (terminal) {
    return 'Terminal subtask cannot receive follow-up prompts.';
  }
  if (!chip.followupPromptEnabled) {
    return 'This subtask only accepts the initial seeded assignment.';
  }

  return getMutationDisabledReason(run);
}

function getAskLandDisabledReason(
  chip: CoordinatorSubtaskChipView,
  nonGit: boolean,
  run: CoordinatorRunSnapshot,
  terminal: boolean,
): string | undefined {
  if (terminal) {
    return getTerminalDisabledReason(terminal);
  }
  const mutationReason = getMutationDisabledReason(run);
  if (mutationReason !== undefined) {
    return mutationReason;
  }
  if (chip.status !== 'ready-for-review') {
    return 'Subtask must be ready for review before landing.';
  }
  if (!chip.followupPromptEnabled) {
    return 'This subtask does not accept follow-up prompts.';
  }
  if (nonGit) {
    return 'Landing requires a git-backed coordinator run.';
  }

  return undefined;
}

export function createCoordinatorRunView(
  run: CoordinatorRunSnapshot,
  options: { debugCommand?: string } = {},
): CoordinatorRunView {
  return {
    chips: createSubtaskChipViews(run),
    ...(options.debugCommand !== undefined ? { debugCommand: options.debugCommand } : {}),
    empty: run.subtasks.length === 0,
    pauseAction: createPauseAction(run),
    resumeAction: createResumeAction(run),
    run,
    spawnAction: createSpawnAction(run),
    summary: createSummaryView(run),
    workflows: createWorkflowTimelineViews(run),
  };
}

export function getCoordinatorSubtaskActions(
  chip: CoordinatorSubtaskChipView,
  run: CoordinatorRunSnapshot,
): CoordinatorUiAction[] {
  const terminal = isCoordinatorTerminalSubtaskStatus(chip.status);
  const nonGit = run.projectMode === 'non-git';
  const terminalReason = getTerminalDisabledReason(terminal);
  const inspectDiffReason = getInspectDiffDisabledReason(nonGit, terminal);
  const mutationReason = getMutationDisabledReason(run);
  const sendPromptReason = getSendPromptDisabledReason(chip, run, terminal);
  const askLandReason = getAskLandDisabledReason(chip, nonGit, run, terminal);
  const actions: CoordinatorUiAction[] = [
    {
      danger: false,
      disabled: terminal,
      id: 'inspect-output',
      label: 'Inspect output',
      ...(terminalReason !== undefined ? { reason: terminalReason } : {}),
      toolName: 'get_task_output',
    },
    {
      danger: false,
      disabled: inspectDiffReason !== undefined,
      id: 'inspect-diff',
      label: 'Inspect diff',
      ...(inspectDiffReason !== undefined ? { reason: inspectDiffReason } : {}),
      toolName: 'get_task_diff',
    },
    {
      danger: false,
      disabled: sendPromptReason !== undefined,
      id: 'send-prompt',
      label: 'Send follow-up',
      ...(sendPromptReason !== undefined ? { reason: sendPromptReason } : {}),
      toolName: 'send_prompt',
    },
    {
      danger: false,
      disabled: terminal,
      id: 'wait-for-idle',
      label: 'Wait for idle',
      ...(terminalReason !== undefined ? { reason: terminalReason } : {}),
      toolName: 'wait_for_idle',
    },
    {
      danger: false,
      disabled: askLandReason !== undefined,
      id: 'ask-land',
      label: 'Ask to land',
      ...(askLandReason !== undefined ? { reason: askLandReason } : {}),
      toolName: 'send_prompt',
    },
    {
      danger: true,
      disabled: mutationReason !== undefined,
      id: 'close',
      label: 'Close subtask',
      ...(mutationReason !== undefined ? { reason: mutationReason } : {}),
      toolName: 'close_task',
    },
  ];

  return actions;
}
