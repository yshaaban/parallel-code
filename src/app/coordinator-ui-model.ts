import type {
  CoordinatorLandingStateSnapshot,
  CoordinatorPromptRequestSnapshot,
  CoordinatorPromptStatus,
  CoordinatorRunSnapshot,
  CoordinatorRunStatus,
  CoordinatorSubtaskSnapshot,
  CoordinatorSubtaskStatus,
  CoordinatorToolName,
  CoordinatorWorkflowSnapshot,
  CoordinatorWorkflowStageSnapshot,
} from '../domain/coordinator';
import {
  isCoordinatorPendingPromptStatus,
  isCoordinatorTerminalSubtaskStatus,
  isCoordinatorTerminalWorkflowLaneStatus,
} from '../domain/coordinator';

export type CoordinatorAttentionLevel = 'normal' | 'info' | 'success' | 'warning' | 'danger';

export type CoordinatorUiActionId =
  | 'ask-land'
  | 'close'
  | 'copy-debug-command'
  | 'inspect-diff'
  | 'inspect-output'
  | 'send-prompt'
  | 'spawn-subtask'
  | 'wait-for-idle';

type CoordinatorUiToolName = Exclude<
  CoordinatorToolName,
  'append_workflow_steps' | 'land_self' | 'signal_done' | 'submit_result'
>;

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
  label: string;
  landing?: CoordinatorLandingStateSnapshot;
  landingLabel?: string;
  promptBeads: CoordinatorPromptBeadView[];
  result?: string;
  status: CoordinatorSubtaskStatus;
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
  pendingPromptCount: number;
  readyCount: number;
  runStatus: CoordinatorRunStatus;
  runTone: CoordinatorAttentionLevel;
  stale: boolean;
  statusLabel: string;
  subtaskLimit: number;
}

export interface CoordinatorWorkflowStageView {
  completedLaneCount: number;
  id: string;
  label: string;
  laneCount: number;
  resultCount: number;
  status: CoordinatorWorkflowStageSnapshot['status'];
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

export interface CoordinatorWorkflowTimelineView {
  activeLaneCount: number;
  appendCount: number;
  activityCount: number;
  activityPreview: CoordinatorWorkflowActivityView[];
  blockedReason?: string;
  failedLaneCount: number;
  failedLaneReason?: string;
  findingCount: number;
  hasMoreActivity: boolean;
  hasMoreResults: boolean;
  id: string;
  latestActivityLabel?: string;
  resultPreview: CoordinatorWorkflowResultView[];
  resultCount: number;
  stages: CoordinatorWorkflowStageView[];
  stepCount: number;
  status: CoordinatorWorkflowSnapshot['status'];
  statusLabel: string;
  stale: boolean;
  template: CoordinatorWorkflowSnapshot['template'];
  title: string;
  tone: CoordinatorAttentionLevel;
  updatedAt: number;
  verdictSummary: CoordinatorWorkflowVerdictSummaryView;
}

export interface CoordinatorRunView {
  chips: CoordinatorSubtaskChipView[];
  debugCommand?: string;
  empty: boolean;
  run: CoordinatorRunSnapshot;
  spawnAction: CoordinatorUiAction;
  summary: CoordinatorRunSummaryView;
  workflows: CoordinatorWorkflowTimelineView[];
}

const MAX_PROMPT_BEADS_PER_SUBTASK = 3;
const MAX_WORKFLOW_ACTIVITY_PREVIEW = 5;
const MAX_WORKFLOW_RESULT_PREVIEW = 4;
const MAX_WORKFLOW_RESULT_TEXT_PREVIEW = 3;

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
        label,
        ...(landing !== undefined ? { landing } : {}),
        ...(landingLabel !== undefined ? { landingLabel } : {}),
        promptBeads: getPromptBeads(pendingPrompts),
        ...(subtask.result !== undefined ? { result: subtask.result } : {}),
        status: subtask.status,
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

  return {
    activeCount,
    attentionCount: attentionTaskIds.size,
    blockedCount,
    failedCount,
    landingCount,
    pendingPromptCount,
    readyCount,
    runStatus: run.status,
    runTone: getRunTone(run.status),
    stale: run.status === 'stale-after-restore',
    statusLabel: humanizeStatus(run.status),
    subtaskLimit: run.limits.maxActiveSubtasks,
  };
}

function createWorkflowStageView(
  workflow: CoordinatorWorkflowSnapshot,
  stage: CoordinatorWorkflowStageSnapshot,
): CoordinatorWorkflowStageView {
  const stageLaneIds = new Set(stage.laneIds);
  const lanes = workflow.lanes.filter((lane) => stageLaneIds.has(lane.id));
  const completedLaneCount = lanes.filter((lane) =>
    isCoordinatorTerminalWorkflowLaneStatus(lane.status),
  ).length;
  const label = stage.name.slice(0, 1).toUpperCase();

  return {
    completedLaneCount,
    id: stage.id,
    label,
    laneCount: lanes.length,
    resultCount: stage.resultIds.length,
    status: stage.status,
    title: `${stage.name}: ${humanizeStatus(stage.status)} (${completedLaneCount}/${lanes.length} lanes, ${stage.resultIds.length} results)`,
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

function getWorkflowActivityTone(kind: string): CoordinatorAttentionLevel {
  if (kind.includes('failed') || kind.includes('timed-out') || kind.includes('cancelled')) {
    return 'danger';
  }
  if (kind.includes('retry') || kind.includes('blocked')) {
    return 'warning';
  }
  if (kind.includes('result') || kind.includes('completed') || kind.includes('verdict')) {
    return 'success';
  }
  if (kind.includes('appended') || kind.includes('running') || kind.includes('spawning')) {
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
): CoordinatorWorkflowTimelineView {
  const activeLaneCount = workflow.lanes.filter(
    (lane) => !isCoordinatorTerminalWorkflowLaneStatus(lane.status),
  ).length;
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
  const latestActivityLabel = activityPreview[0]?.message;
  const resultPreview = createWorkflowResultViews(workflow);
  const stepCount = workflow.sourceSpec?.steps.length ?? workflow.stages.length;

  return {
    activeLaneCount,
    appendCount: workflow.stepAppends?.length ?? 0,
    activityCount: workflow.journal.length,
    activityPreview,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
    failedLaneCount: failedLanes.length,
    ...(failedLanes[0]?.failure !== undefined ? { failedLaneReason: failedLanes[0].failure } : {}),
    findingCount,
    hasMoreActivity: workflow.journal.length > activityPreview.length,
    hasMoreResults: workflow.results.length > resultPreview.length,
    id: workflow.id,
    ...(latestActivityLabel !== undefined ? { latestActivityLabel } : {}),
    resultPreview,
    resultCount: workflow.results.length,
    stages: workflow.stages.map((stage) => createWorkflowStageView(workflow, stage)),
    stepCount,
    status: workflow.status,
    statusLabel: humanizeStatus(workflow.status),
    stale: workflow.status === 'stale-after-restore',
    template: workflow.template,
    title: workflow.title,
    tone: getWorkflowTone(workflow.status),
    updatedAt: workflow.updatedAt,
    verdictSummary: createWorkflowVerdictSummary(workflow),
  };
}

function createWorkflowTimelineViews(
  run: CoordinatorRunSnapshot,
): CoordinatorWorkflowTimelineView[] {
  return (run.workflows ?? [])
    .map(createWorkflowTimelineView)
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
  run: CoordinatorRunSnapshot,
  terminal: boolean,
): string | undefined {
  if (terminal) {
    return 'Terminal subtask cannot receive follow-up prompts.';
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
  const sendPromptReason = getSendPromptDisabledReason(run, terminal);
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
