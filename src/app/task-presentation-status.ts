import { assertNever } from '../lib/assert-never';
import { isHydraAgentDef } from '../lib/hydra';
import { store } from '../store/core';
import type { PanelId } from '../store/types';
import type {
  AgentSupervisionSnapshot,
  AgentSupervisionState,
  RemoteAgentStatus,
  TaskAttentionReason,
} from '../domain/server-state';

export type TaskDotStatus =
  | 'busy'
  | 'waiting'
  | 'ready'
  | 'paused'
  | 'flow-controlled'
  | 'restoring'
  | 'failed';

export interface TaskAttentionEntry {
  agentId: string;
  dotStatus: TaskDotStatus;
  focusPanel: PanelId;
  group: 'needs-action' | 'quiet' | 'ready';
  label: string;
  lastOutputAt: number | null;
  preview: string;
  reason: TaskAttentionReason;
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

interface LifecycleMetadata {
  dotStatus: TaskDotStatus;
  reason: TaskAttentionReason | null;
  state: AgentSupervisionState;
}

export type TaskAttentionTone = 'accent' | 'error' | 'muted' | 'success' | 'warning';

const TASK_ATTENTION_REASON_METADATA: Record<
  TaskAttentionReason,
  {
    group: TaskAttentionEntry['group'];
    label: string;
    priority: number;
    tone: TaskAttentionTone;
  }
> = {
  failed: { group: 'needs-action', label: 'Failed', priority: 0, tone: 'error' },
  'waiting-input': { group: 'needs-action', label: 'Waiting', priority: 1, tone: 'warning' },
  'flow-controlled': {
    group: 'needs-action',
    label: 'Flow controlled',
    priority: 2,
    tone: 'accent',
  },
  paused: { group: 'needs-action', label: 'Paused', priority: 3, tone: 'warning' },
  restoring: { group: 'needs-action', label: 'Restoring', priority: 4, tone: 'accent' },
  'ready-for-next-step': { group: 'ready', label: 'Ready', priority: 5, tone: 'success' },
  'quiet-too-long': { group: 'quiet', label: 'Quiet', priority: 6, tone: 'muted' },
};

const TASK_ATTENTION_GROUP_TITLES: Record<TaskAttentionEntry['group'], string> = {
  'needs-action': 'Needs Action',
  ready: 'Ready',
  quiet: 'Quiet',
};

const PRESENTATION_PRIORITY_BY_STATE: Record<AgentSupervisionState, number> = {
  active: 7,
  'awaiting-input': 1,
  'exited-clean': 8,
  'exited-error': 0,
  'flow-controlled': 2,
  'idle-at-prompt': 5,
  paused: 3,
  quiet: 6,
  restoring: 4,
};

const REMOTE_AGENT_STATUS_METADATA: Record<
  Exclude<RemoteAgentStatus, 'exited'>,
  {
    dotStatus: TaskDotStatus;
    reason: TaskAttentionReason | null;
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

const EXITED_ERROR_LIFECYCLE_METADATA: LifecycleMetadata = {
  dotStatus: 'failed',
  reason: 'failed',
  state: 'exited-error',
};

function getAttentionMetadata(reason: TaskAttentionReason): {
  group: TaskAttentionEntry['group'];
  label: string;
  priority: number;
  tone: TaskAttentionTone;
} {
  return TASK_ATTENTION_REASON_METADATA[reason];
}

export function getTaskAttentionPriority(reason: TaskAttentionReason): number {
  return getAttentionMetadata(reason).priority;
}

export function getTaskAttentionGroupTitle(group: TaskAttentionEntry['group']): string {
  return TASK_ATTENTION_GROUP_TITLES[group];
}

export function getTaskAttentionTone(reason: TaskAttentionReason): TaskAttentionTone {
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
  reason: TaskAttentionReason | null,
  state: AgentSupervisionState,
): number {
  if (reason) {
    return getAttentionMetadata(reason).priority;
  }

  return PRESENTATION_PRIORITY_BY_STATE[state];
}

function compareSnapshots(left: AgentSupervisionSnapshot, right: AgentSupervisionSnapshot): number {
  const priorityDelta =
    getPresentationPriority(left.attentionReason, left.state) -
    getPresentationPriority(right.attentionReason, right.state);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return right.updatedAt - left.updatedAt;
}

function getTaskSupervisionSnapshot(taskId: string): AgentSupervisionSnapshot | null {
  const task = store.tasks[taskId];
  if (!task) {
    return null;
  }

  let bestSnapshot: AgentSupervisionSnapshot | null = null;
  for (const agentId of task.agentIds) {
    const snapshot = store.agentSupervision[agentId];
    if (!snapshot || snapshot.isShell || snapshot.taskId !== taskId) {
      continue;
    }

    if (!bestSnapshot || compareSnapshots(snapshot, bestSnapshot) < 0) {
      bestSnapshot = snapshot;
    }
  }

  return bestSnapshot;
}

function hasCleanCommittedChanges(taskId: string): boolean {
  const gitStatus = store.taskGitStatus[taskId];
  return !!gitStatus?.has_committed_changes && !gitStatus.has_uncommitted_changes;
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

function getFocusPanel(agentId: string, reason: TaskAttentionReason): PanelId {
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
  reason: TaskAttentionReason,
  state: AgentSupervisionState,
  dotStatus: TaskDotStatus,
  preview: string,
  lastOutputAt: number | null,
  updatedAt: number,
): TaskAttentionEntry {
  const metadata = getAttentionMetadata(reason);

  return {
    agentId,
    dotStatus,
    focusPanel: getFocusPanel(agentId, reason),
    group: metadata.group,
    label: metadata.label,
    lastOutputAt,
    preview,
    reason,
    state,
    taskId,
    updatedAt,
  };
}

function getSnapshotCandidate(taskId: string): TaskPresentationCandidate | null {
  const snapshot = getTaskSupervisionSnapshot(taskId);
  if (!snapshot) {
    return null;
  }

  const dotStatus = getDotStatusFromSnapshot(taskId, snapshot);
  return createCandidateFromState({
    taskId,
    agentId: snapshot.agentId,
    dotStatus,
    reason: snapshot.attentionReason,
    state: snapshot.state,
    preview: snapshot.preview,
    lastOutputAt: snapshot.lastOutputAt,
    updatedAt: snapshot.updatedAt,
  });
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
  reason: TaskAttentionReason | null;
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
        )
      : null,
    dotStatus: args.dotStatus,
    priority: getPresentationPriority(args.reason, args.state),
    updatedAt: args.updatedAt,
  });
}

function getLifecycleMetadata(agentId: string): LifecycleMetadata | null {
  const agent = store.agents[agentId];
  if (!agent) {
    return null;
  }

  if (agent.status === 'exited') {
    if ((agent.exitCode ?? 0) !== 0 || agent.signal === 'spawn_failed') {
      return EXITED_ERROR_LIFECYCLE_METADATA;
    }

    return null;
  }

  return REMOTE_AGENT_STATUS_METADATA[agent.status];
}

function getLifecycleCandidate(taskId: string): TaskPresentationCandidate | null {
  const task = store.tasks[taskId];
  if (!task) {
    return null;
  }

  let bestCandidate: TaskPresentationCandidate | null = null;
  for (const agentId of task.agentIds) {
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
    priority: hasCleanChanges ? 8 : DEFAULT_TASK_PRESENTATION_CANDIDATE.priority,
    updatedAt: 0,
  });
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

export function getTaskPresentationStatus(taskId: string): TaskPresentationStatus {
  const bestCandidate = pickBestCandidate([
    getSnapshotCandidate(taskId),
    getLifecycleCandidate(taskId),
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
