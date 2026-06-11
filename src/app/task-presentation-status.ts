import { assertNever } from '../lib/assert-never';
import { isHydraAgentDef } from '../lib/hydra';
import { isTerminalFocusedInputPromptSuppressionActive } from './terminal-focused-input';
import { getAgentPromptDispatchAt, PROMPT_DISPATCH_WINDOW_MS } from './task-prompt-dispatch';
import { getCoordinatorTaskAttentionSummary } from './coordinator-ui-model';
import { getAgentLastOutputAt } from '../store/agent-output-activity';
import { getCoordinatorRunForTask } from '../store/coordinator';
import { store } from '../store/state';
import { getSelectedTaskRuntimeAgentId } from '../store/task-agent-selection';
import { getTaskTerminalStartupSummary } from '../store/terminal-startup';
import type { PanelId } from '../store/types';
import { isFailedProcessExit } from '../domain/process-exit';
import type {
  AgentSupervisionSnapshot,
  AgentSupervisionState,
  RemoteAgentStatus,
  TaskAttentionReason,
} from '../domain/server-state';
import { isExitedRemoteAgentStatus } from '../domain/server-state';

export type TaskDotStatus =
  | 'busy'
  | 'waiting'
  | 'ready'
  | 'paused'
  | 'flow-controlled'
  | 'restoring'
  | 'failed';

export type TaskActivityStatus =
  | 'starting'
  | 'sending'
  | 'live'
  | 'waiting-input'
  | 'idle'
  | 'paused'
  | 'flow-controlled'
  | 'restoring'
  | 'failed';

// Renderer-side attention reasons widen the backend supervision vocabulary
// with coordinator-run projections. The domain wire type and its validator
// stay untouched; these extra reasons never travel over the wire.
export type TaskAttentionUiReason =
  | TaskAttentionReason
  | 'coordinator-approval'
  | 'coordinator-budget'
  | 'coordinator-stale';

export interface TaskAttentionEntry {
  agentId: string;
  dotStatus: TaskDotStatus;
  focusPanel: PanelId;
  group: 'needs-action' | 'quiet' | 'ready';
  label: string;
  lastOutputAt: number | null;
  preview: string;
  reason: TaskAttentionUiReason;
  state: AgentSupervisionState;
  taskId: string;
  updatedAt: number;
}

interface TaskPresentationStatus {
  attention: TaskAttentionEntry | null;
  dotStatus: TaskDotStatus;
}

interface TaskPresentationCandidate extends TaskPresentationStatus {
  priority: number;
  updatedAt: number;
}

interface TaskActivityCandidate {
  priority: number;
  status: TaskActivityStatus;
  updatedAt: number;
}

interface LifecycleMetadata {
  dotStatus: TaskDotStatus;
  reason: TaskAttentionUiReason | null;
  state: AgentSupervisionState;
}

export type TaskAttentionTone = 'accent' | 'error' | 'muted' | 'success' | 'warning';

const TASK_ATTENTION_REASON_METADATA: Record<
  TaskAttentionUiReason,
  {
    group: TaskAttentionEntry['group'];
    label: string;
    priority: number;
    tone: TaskAttentionTone;
  }
> = {
  failed: { group: 'needs-action', label: 'Failed', priority: 0, tone: 'error' },
  'coordinator-stale': { group: 'needs-action', label: 'Resume', priority: 1, tone: 'accent' },
  'waiting-input': { group: 'needs-action', label: 'Waiting', priority: 2, tone: 'warning' },
  'coordinator-approval': {
    group: 'needs-action',
    label: 'Approve',
    priority: 3,
    tone: 'warning',
  },
  'coordinator-budget': { group: 'needs-action', label: 'Budget', priority: 4, tone: 'warning' },
  'flow-controlled': {
    group: 'needs-action',
    label: 'Flow controlled',
    priority: 5,
    tone: 'accent',
  },
  paused: { group: 'needs-action', label: 'Paused', priority: 6, tone: 'warning' },
  restoring: { group: 'needs-action', label: 'Restoring', priority: 7, tone: 'accent' },
  'ready-for-next-step': { group: 'ready', label: 'Ready', priority: 8, tone: 'success' },
  'quiet-too-long': { group: 'quiet', label: 'Quiet', priority: 9, tone: 'muted' },
};

const TASK_ATTENTION_GROUP_TITLES: Record<TaskAttentionEntry['group'], string> = {
  'needs-action': 'Needs Action',
  ready: 'Ready',
  quiet: 'Quiet',
};

const PRESENTATION_PRIORITY_BY_STATE: Record<AgentSupervisionState, number> = {
  active: 10,
  'awaiting-input': 2,
  'exited-clean': 11,
  'exited-error': 0,
  'flow-controlled': 5,
  'idle-at-prompt': 8,
  paused: 6,
  quiet: 9,
  restoring: 7,
};

const REMOTE_AGENT_STATUS_METADATA: Record<
  Exclude<RemoteAgentStatus, 'exited'>,
  {
    dotStatus: TaskDotStatus;
    reason: TaskAttentionUiReason | null;
    state: AgentSupervisionState;
  }
> = {
  'flow-controlled': {
    dotStatus: 'flow-controlled',
    reason: 'flow-controlled',
    state: 'flow-controlled',
  },
  paused: { dotStatus: 'paused', reason: 'paused', state: 'paused' },
  restoring: { dotStatus: 'restoring', reason: 'restoring', state: 'restoring' },
  running: { dotStatus: 'busy', reason: null, state: 'active' },
};

const DEFAULT_TASK_PRESENTATION_CANDIDATE: TaskPresentationCandidate = {
  attention: null,
  dotStatus: 'waiting',
  priority: 99,
  updatedAt: 0,
};

const DEFAULT_TASK_ACTIVITY_CANDIDATE: TaskActivityCandidate = {
  priority: 99,
  status: 'idle',
  updatedAt: 0,
};

const TASK_ACTIVITY_LIVE_WINDOW_MS = 2_000;
const TASK_ACTIVITY_PRIORITY: Record<TaskActivityStatus, number> = {
  failed: 0,
  restoring: 1,
  'flow-controlled': 2,
  paused: 3,
  live: 4,
  sending: 5,
  'waiting-input': 6,
  starting: 7,
  idle: 8,
};

const TASK_ACTIVITY_LABELS: Record<TaskActivityStatus, string> = {
  failed: 'Failed',
  starting: 'Starting',
  sending: 'Sending',
  restoring: 'Restoring',
  'flow-controlled': 'Flow controlled',
  paused: 'Paused',
  'waiting-input': 'Waiting',
  live: 'Live',
  idle: 'Idle',
};

const EXITED_ERROR_LIFECYCLE_METADATA: LifecycleMetadata = {
  dotStatus: 'failed',
  reason: 'failed',
  state: 'exited-error',
};

function getAttentionMetadata(reason: TaskAttentionUiReason): {
  group: TaskAttentionEntry['group'];
  label: string;
  priority: number;
  tone: TaskAttentionTone;
} {
  return TASK_ATTENTION_REASON_METADATA[reason];
}

export function getTaskAttentionPriority(reason: TaskAttentionUiReason): number {
  return getAttentionMetadata(reason).priority;
}

export function getTaskAttentionGroupTitle(group: TaskAttentionEntry['group']): string {
  return TASK_ATTENTION_GROUP_TITLES[group];
}

export function getTaskAttentionTone(reason: TaskAttentionUiReason): TaskAttentionTone {
  return getAttentionMetadata(reason).tone;
}

function isBetterCandidate(
  candidate: TaskPresentationCandidate,
  current: TaskPresentationCandidate | null,
): boolean {
  return (
    current === null ||
    candidate.priority < current.priority ||
    (candidate.priority === current.priority && candidate.updatedAt > current.updatedAt)
  );
}

function getPresentationPriority(
  reason: TaskAttentionUiReason | null,
  state: AgentSupervisionState,
): number {
  if (reason) {
    return getAttentionMetadata(reason).priority;
  }

  return PRESENTATION_PRIORITY_BY_STATE[state];
}

function listTaskAgentIds(taskId: string, includeShell: boolean): string[] {
  const task = store.tasks[taskId];
  if (!task) {
    return [];
  }

  if (!includeShell) {
    return [...task.agentIds];
  }

  return [...task.agentIds, ...task.shellAgentIds];
}

function listTaskSupervisionSnapshots(
  taskId: string,
  includeShell: boolean,
): AgentSupervisionSnapshot[] {
  const snapshots: AgentSupervisionSnapshot[] = [];
  for (const agentId of listTaskAgentIds(taskId, includeShell)) {
    const snapshot = store.agentSupervision[agentId];
    if (!snapshot || snapshot.taskId !== taskId) {
      continue;
    }

    if (!includeShell && snapshot.isShell) {
      continue;
    }

    snapshots.push(snapshot);
  }

  return snapshots;
}

function hasCleanCommittedChanges(taskId: string): boolean {
  const gitStatus = store.taskGitStatus[taskId];
  return !!gitStatus?.has_committed_changes && !gitStatus.has_uncommitted_changes;
}

function shouldSuppressPromptSnapshot(agentId: string, state: AgentSupervisionState): boolean {
  if (state !== 'awaiting-input' && state !== 'idle-at-prompt') {
    return false;
  }

  return isTerminalFocusedInputPromptSuppressionActive(agentId);
}

function getTaskActivityStatusFromSnapshot(
  snapshot: AgentSupervisionSnapshot,
  now: number,
): TaskActivityStatus {
  const lastOutputAt = getSnapshotLastOutputAt(snapshot);
  const suppressPromptSnapshot = shouldSuppressPromptSnapshot(snapshot.agentId, snapshot.state);

  switch (snapshot.state) {
    case 'awaiting-input':
      if (suppressPromptSnapshot) {
        return getLiveOrIdleStatus(lastOutputAt, now);
      }
      return 'waiting-input';
    case 'idle-at-prompt':
      if (suppressPromptSnapshot) {
        return getLiveOrIdleStatus(lastOutputAt, now);
      }
      return 'idle';
    case 'quiet':
    case 'exited-clean':
      return 'idle';
    case 'paused':
      return 'paused';
    case 'flow-controlled':
      return 'flow-controlled';
    case 'restoring':
      return 'restoring';
    case 'exited-error':
      return 'failed';
    case 'active':
      return getLiveOrIdleStatus(lastOutputAt, now);
  }

  return assertNever(snapshot.state, 'Unhandled task activity supervision state');
}

function getSnapshotLastOutputAt(snapshot: AgentSupervisionSnapshot): number | null {
  const lastOutputAt = Math.max(
    snapshot.lastOutputAt ?? 0,
    getAgentLastOutputAt(snapshot.agentId) ?? 0,
  );
  return lastOutputAt > 0 ? lastOutputAt : null;
}

function hasRecentOutput(lastOutputAt: number | null, now: number): boolean {
  return lastOutputAt !== null && now - lastOutputAt <= TASK_ACTIVITY_LIVE_WINDOW_MS;
}

function getLiveOrIdleStatus(lastOutputAt: number | null, now: number): TaskActivityStatus {
  return hasRecentOutput(lastOutputAt, now) ? 'live' : 'idle';
}

function shouldSuppressQuietSnapshotAttention(
  snapshot: AgentSupervisionSnapshot,
  now: number,
): boolean {
  if (snapshot.attentionReason !== 'quiet-too-long') {
    return false;
  }

  return hasRecentOutput(getSnapshotLastOutputAt(snapshot), now);
}

function getDotStatusFromSnapshot(
  taskId: string,
  snapshot: AgentSupervisionSnapshot,
): TaskDotStatus {
  switch (snapshot.state) {
    case 'awaiting-input':
      return 'waiting';
    case 'idle-at-prompt':
      return 'ready';
    case 'paused':
      return 'paused';
    case 'flow-controlled':
      return 'flow-controlled';
    case 'restoring':
      return 'restoring';
    case 'active':
    case 'quiet':
      return 'busy';
    case 'exited-error':
      return 'failed';
    case 'exited-clean':
      if (hasCleanCommittedChanges(taskId)) {
        return 'ready';
      }
      return 'waiting';
  }

  return assertNever(snapshot.state, 'Unhandled agent supervision state');
}

function isCoordinatorAttentionReason(reason: TaskAttentionUiReason): boolean {
  return (
    reason === 'coordinator-approval' ||
    reason === 'coordinator-budget' ||
    reason === 'coordinator-stale'
  );
}

function getFocusPanel(taskId: string, agentId: string, reason: TaskAttentionUiReason): PanelId {
  if (isCoordinatorAttentionReason(reason)) {
    return 'coordinator';
  }

  const task = store.tasks[taskId];
  const shellIndex = task?.shellAgentIds.indexOf(agentId) ?? -1;
  if (shellIndex >= 0) {
    return `shell:${shellIndex}`;
  }

  if (reason === 'ready-for-next-step') {
    const agent = store.agents[agentId];
    if (agent && !isHydraAgentDef(agent.def)) {
      return 'prompt';
    }
  }

  return 'ai-terminal';
}

function createAttentionEntry(
  taskId: string,
  agentId: string,
  reason: TaskAttentionUiReason,
  state: AgentSupervisionState,
  dotStatus: TaskDotStatus,
  preview: string,
  lastOutputAt: number | null,
  updatedAt: number,
  label?: string,
): TaskAttentionEntry {
  const metadata = getAttentionMetadata(reason);

  return {
    agentId,
    dotStatus,
    focusPanel: getFocusPanel(taskId, agentId, reason),
    group: metadata.group,
    label: label ?? metadata.label,
    lastOutputAt,
    preview,
    reason,
    state,
    taskId,
    updatedAt,
  };
}

function createPresentationCandidate(args: {
  attention: TaskAttentionEntry | null;
  dotStatus: TaskDotStatus;
  priority: number;
  updatedAt: number;
}): TaskPresentationCandidate {
  return {
    attention: args.attention,
    dotStatus: args.dotStatus,
    priority: args.priority,
    updatedAt: args.updatedAt,
  };
}

function createCandidateFromState(args: {
  taskId: string;
  agentId: string;
  dotStatus: TaskDotStatus;
  label?: string;
  reason: TaskAttentionUiReason | null;
  state: AgentSupervisionState;
  preview: string;
  lastOutputAt: number | null;
  updatedAt: number;
}): TaskPresentationCandidate {
  return createPresentationCandidate({
    attention: args.reason
      ? createAttentionEntry(
          args.taskId,
          args.agentId,
          args.reason,
          args.state,
          args.dotStatus,
          args.preview,
          args.lastOutputAt,
          args.updatedAt,
          args.label,
        )
      : null,
    dotStatus: args.dotStatus,
    priority: getPresentationPriority(args.reason, args.state),
    updatedAt: args.updatedAt,
  });
}

function getSnapshotCandidate(taskId: string): TaskPresentationCandidate | null {
  let bestCandidate: TaskPresentationCandidate | null = null;
  const now = Date.now();

  for (const snapshot of listTaskSupervisionSnapshots(taskId, true)) {
    const suppressPromptSnapshot = shouldSuppressPromptSnapshot(snapshot.agentId, snapshot.state);
    const suppressQuietAttention = shouldSuppressQuietSnapshotAttention(snapshot, now);
    const suppressAttention = suppressPromptSnapshot || suppressQuietAttention;
    const candidate = createCandidateFromState({
      taskId,
      agentId: snapshot.agentId,
      dotStatus: suppressPromptSnapshot ? 'busy' : getDotStatusFromSnapshot(taskId, snapshot),
      reason: suppressAttention ? null : snapshot.attentionReason,
      state: suppressPromptSnapshot ? 'active' : snapshot.state,
      preview: snapshot.preview,
      lastOutputAt: getSnapshotLastOutputAt(snapshot),
      updatedAt: snapshot.updatedAt,
    });

    if (isBetterCandidate(candidate, bestCandidate)) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function getLifecycleMetadata(agentId: string): LifecycleMetadata | null {
  const agent = store.agents[agentId];
  if (!agent) {
    return null;
  }

  if (isExitedRemoteAgentStatus(agent.status)) {
    if (isFailedProcessExit(agent.exitCode, agent.signal)) {
      return EXITED_ERROR_LIFECYCLE_METADATA;
    }

    return null;
  }

  return REMOTE_AGENT_STATUS_METADATA[agent.status];
}

function getTaskActivityStatusFromAgentLifecycle(
  agentId: string,
  now: number,
): TaskActivityStatus | null {
  const agent = store.agents[agentId];
  if (!agent) {
    return null;
  }

  const lastLocalOutputAt = getAgentLastOutputAt(agentId);

  if (isExitedRemoteAgentStatus(agent.status)) {
    if (isFailedProcessExit(agent.exitCode, agent.signal)) {
      return 'failed';
    }

    return 'idle';
  }

  switch (agent.status) {
    case 'paused':
      return 'paused';
    case 'flow-controlled':
      return 'flow-controlled';
    case 'restoring':
      return 'restoring';
    case 'running':
      if (lastLocalOutputAt !== null && now - lastLocalOutputAt <= TASK_ACTIVITY_LIVE_WINDOW_MS) {
        return 'live';
      }
      return 'idle';
  }

  return assertNever(agent.status, 'Unhandled task activity agent lifecycle status');
}

function getLifecycleCandidate(taskId: string): TaskPresentationCandidate | null {
  let bestCandidate: TaskPresentationCandidate | null = null;
  for (const agentId of listTaskAgentIds(taskId, true)) {
    const agent = store.agents[agentId];
    if (!agent) {
      continue;
    }

    const lifecycleMetadata = getLifecycleMetadata(agentId);
    if (!lifecycleMetadata) {
      continue;
    }

    const candidate = createCandidateFromState({
      taskId,
      agentId,
      dotStatus: lifecycleMetadata.dotStatus,
      reason: lifecycleMetadata.reason,
      state: lifecycleMetadata.state,
      preview: agent.lastOutput[agent.lastOutput.length - 1] ?? '',
      lastOutputAt: null,
      updatedAt: 0,
    });

    if (isBetterCandidate(candidate, bestCandidate)) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function getGitCandidate(taskId: string): TaskPresentationCandidate {
  const hasCleanChanges = hasCleanCommittedChanges(taskId);

  return createPresentationCandidate({
    attention: null,
    dotStatus: hasCleanChanges ? 'ready' : 'waiting',
    priority: hasCleanChanges ? 11 : DEFAULT_TASK_PRESENTATION_CANDIDATE.priority,
    updatedAt: 0,
  });
}

// Coordinator-run operator states are renderer projections of backend run
// snapshots: a stale-after-restore run, pending workflow approvals, and
// budget-exhausted workflows all need the operator, so they surface through
// the same attention pipeline as supervision reasons.
export function getCoordinatorAttentionCandidate(taskId: string): TaskPresentationCandidate | null {
  const task = store.tasks[taskId];
  if (!task || task.coordinatorRole !== 'coordinator') {
    return null;
  }

  const run = getCoordinatorRunForTask(taskId);
  if (!run) {
    return null;
  }

  const agentId = getSelectedTaskRuntimeAgentId(task) ?? task.agentIds[0] ?? '';
  const summary = getCoordinatorTaskAttentionSummary(run);
  if (summary.staleAfterRestore) {
    return createCandidateFromState({
      taskId,
      agentId,
      dotStatus: 'paused',
      reason: 'coordinator-stale',
      state: 'paused',
      preview: 'Coordinator run is stale after a restart. Resume to respawn unfinished work.',
      lastOutputAt: null,
      updatedAt: run.updatedAt,
    });
  }

  if (summary.pendingApprovalCount > 0) {
    return createCandidateFromState({
      taskId,
      agentId,
      dotStatus: 'waiting',
      reason: 'coordinator-approval',
      state: 'awaiting-input',
      preview: `${summary.pendingApprovalCount} workflow action${
        summary.pendingApprovalCount === 1 ? '' : 's'
      } awaiting approval.`,
      lastOutputAt: null,
      updatedAt: run.updatedAt,
    });
  }

  if (summary.budgetExhaustedWorkflowCount > 0) {
    return createCandidateFromState({
      taskId,
      agentId,
      dotStatus: 'waiting',
      reason: 'coordinator-budget',
      state: 'awaiting-input',
      preview: `${summary.budgetExhaustedWorkflowCount} workflow${
        summary.budgetExhaustedWorkflowCount === 1 ? '' : 's'
      } exhausted a budget.`,
      lastOutputAt: null,
      updatedAt: run.updatedAt,
    });
  }

  return null;
}

function getTaskStepsCandidate(taskId: string): TaskPresentationCandidate | null {
  const summary = store.taskStepSummaries[taskId];
  if (!summary || summary.state !== 'ready') {
    return null;
  }

  if (listTaskSupervisionSnapshots(taskId, true).some((snapshot) => snapshot.state === 'active')) {
    return null;
  }

  const task = store.tasks[taskId];
  const agentId = task ? getSelectedTaskRuntimeAgentId(task) : null;
  if (!agentId) {
    return null;
  }

  const candidateArgs: Parameters<typeof createCandidateFromState>[0] = {
    taskId,
    agentId,
    dotStatus: 'ready',
    reason: 'ready-for-next-step',
    state: 'idle-at-prompt',
    preview: summary.preview ?? summary.latestStep?.summary ?? '',
    lastOutputAt: null,
    updatedAt: summary.updatedAt,
  };
  if (summary.latestStep?.status === 'awaiting_review') {
    candidateArgs.label = 'Review';
  }

  return createCandidateFromState(candidateArgs);
}

function pickBestCandidate(
  candidates: Array<TaskPresentationCandidate | null>,
): TaskPresentationCandidate {
  let bestCandidate: TaskPresentationCandidate | null = null;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (isBetterCandidate(candidate, bestCandidate)) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate ?? DEFAULT_TASK_PRESENTATION_CANDIDATE;
}

function createTaskActivityCandidate(
  status: TaskActivityStatus,
  updatedAt: number,
): TaskActivityCandidate {
  return {
    priority: TASK_ACTIVITY_PRIORITY[status],
    status,
    updatedAt,
  };
}

function isBetterTaskActivityCandidate(
  candidate: TaskActivityCandidate,
  current: TaskActivityCandidate | null,
): boolean {
  return (
    current === null ||
    candidate.priority < current.priority ||
    (candidate.priority === current.priority && candidate.updatedAt > current.updatedAt)
  );
}

function pickBestTaskActivityCandidate(
  candidates: Array<TaskActivityCandidate | null>,
): TaskActivityCandidate {
  let bestCandidate: TaskActivityCandidate | null = null;

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (isBetterTaskActivityCandidate(candidate, bestCandidate)) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate ?? DEFAULT_TASK_ACTIVITY_CANDIDATE;
}

function getTaskActivitySnapshotCandidate(
  taskId: string,
  now: number,
): TaskActivityCandidate | null {
  let bestCandidate: TaskActivityCandidate | null = null;

  for (const snapshot of listTaskSupervisionSnapshots(taskId, true)) {
    const candidate = createTaskActivityCandidate(
      getTaskActivityStatusFromSnapshot(snapshot, now),
      snapshot.updatedAt,
    );

    if (isBetterTaskActivityCandidate(candidate, bestCandidate)) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function getTaskActivityStartupCandidate(taskId: string): TaskActivityCandidate | null {
  if (!getTaskTerminalStartupSummary(taskId)) {
    return null;
  }

  return createTaskActivityCandidate('starting', 0);
}

function getAgentLatestTaskSignalAt(agentId: string): number {
  const snapshotUpdatedAt = store.agentSupervision[agentId]?.updatedAt ?? 0;
  const localOutputAt = getAgentLastOutputAt(agentId) ?? 0;
  return Math.max(snapshotUpdatedAt, localOutputAt);
}

function getTaskActivitySendingCandidate(
  taskId: string,
  now: number,
): TaskActivityCandidate | null {
  let bestCandidate: TaskActivityCandidate | null = null;

  for (const agentId of listTaskAgentIds(taskId, false)) {
    const dispatchAt = getAgentPromptDispatchAt(
      agentId,
      store.agents[agentId]?.generation ?? null,
      now,
    );
    if (!dispatchAt || now - dispatchAt > PROMPT_DISPATCH_WINDOW_MS) {
      continue;
    }

    if (getAgentLatestTaskSignalAt(agentId) > dispatchAt) {
      continue;
    }

    const candidate = createTaskActivityCandidate('sending', dispatchAt);
    if (isBetterTaskActivityCandidate(candidate, bestCandidate)) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function getTaskActivityLifecycleCandidate(
  taskId: string,
  now: number,
): TaskActivityCandidate | null {
  let bestCandidate: TaskActivityCandidate | null = null;

  for (const agentId of listTaskAgentIds(taskId, true)) {
    const status = getTaskActivityStatusFromAgentLifecycle(agentId, now);
    if (!status) {
      continue;
    }

    const candidate = createTaskActivityCandidate(status, 0);
    if (isBetterTaskActivityCandidate(candidate, bestCandidate)) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

export function getTaskPresentationStatus(taskId: string): TaskPresentationStatus {
  const bestCandidate = pickBestCandidate([
    getSnapshotCandidate(taskId),
    getLifecycleCandidate(taskId),
    getCoordinatorAttentionCandidate(taskId),
    getTaskStepsCandidate(taskId),
    getGitCandidate(taskId),
  ]);

  return {
    attention: bestCandidate.attention,
    dotStatus: bestCandidate.dotStatus,
  };
}

export function getTaskAttentionEntry(taskId: string): TaskAttentionEntry | null {
  return getTaskPresentationStatus(taskId).attention;
}

export function getTaskDotStatus(taskId: string): TaskDotStatus {
  return getTaskPresentationStatus(taskId).dotStatus;
}

export function getTaskActivityStatus(taskId: string, now = Date.now()): TaskActivityStatus {
  const bestCandidate = pickBestTaskActivityCandidate([
    getTaskActivityStartupCandidate(taskId),
    getTaskActivitySendingCandidate(taskId, now),
    getTaskActivitySnapshotCandidate(taskId, now),
    getTaskActivityLifecycleCandidate(taskId, now),
  ]);

  return bestCandidate.status;
}

export function getTaskActivityStatusLabel(status: TaskActivityStatus): string {
  return TASK_ACTIVITY_LABELS[status];
}
