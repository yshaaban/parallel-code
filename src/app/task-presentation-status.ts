import { isHydraAgentDef } from '../lib/hydra';
import { store } from '../store/core';
import type { PanelId } from '../store/types';
import type {
  AgentSupervisionSnapshot,
  AgentSupervisionState,
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

function getAttentionGroup(reason: TaskAttentionReason): TaskAttentionEntry['group'] {
  switch (reason) {
    case 'ready-for-next-step':
      return 'ready';
    case 'quiet-too-long':
      return 'quiet';
    default:
      return 'needs-action';
  }
}

function getAttentionLabel(reason: TaskAttentionReason): string {
  switch (reason) {
    case 'failed':
      return 'Failed';
    case 'flow-controlled':
      return 'Flow controlled';
    case 'paused':
      return 'Paused';
    case 'quiet-too-long':
      return 'Quiet';
    case 'ready-for-next-step':
      return 'Ready';
    case 'restoring':
      return 'Restoring';
    case 'waiting-input':
      return 'Waiting';
    default:
      return 'Attention';
  }
}

function getAttentionPriority(reason: TaskAttentionReason): number {
  switch (reason) {
    case 'failed':
      return 0;
    case 'waiting-input':
      return 1;
    case 'flow-controlled':
      return 2;
    case 'paused':
      return 3;
    case 'restoring':
      return 4;
    case 'ready-for-next-step':
      return 5;
    case 'quiet-too-long':
      return 6;
    default:
      return 99;
  }
}

function getPresentationPriority(
  reason: TaskAttentionReason | null,
  state: AgentSupervisionState,
): number {
  if (reason) {
    return getAttentionPriority(reason);
  }

  switch (state) {
    case 'exited-error':
      return 0;
    case 'awaiting-input':
      return 1;
    case 'flow-controlled':
      return 2;
    case 'paused':
      return 3;
    case 'restoring':
      return 4;
    case 'idle-at-prompt':
      return 5;
    case 'quiet':
      return 6;
    case 'active':
      return 7;
    case 'exited-clean':
      return 8;
    default:
      return 99;
  }
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
    default:
      return 'waiting';
  }
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
  return {
    agentId,
    dotStatus,
    focusPanel: getFocusPanel(agentId, reason),
    group: getAttentionGroup(reason),
    label: getAttentionLabel(reason),
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
  return {
    attention: snapshot.attentionReason
      ? createAttentionEntry(
          taskId,
          snapshot.agentId,
          snapshot.attentionReason,
          snapshot.state,
          dotStatus,
          snapshot.preview,
          snapshot.lastOutputAt,
          snapshot.updatedAt,
        )
      : null,
    dotStatus,
    priority: getPresentationPriority(snapshot.attentionReason, snapshot.state),
    updatedAt: snapshot.updatedAt,
  };
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

    let reason: TaskAttentionReason | null = null;
    let state: AgentSupervisionState = 'exited-clean';
    let dotStatus: TaskDotStatus = 'waiting';
    let includeCandidate = false;

    switch (agent.status) {
      case 'flow-controlled':
        reason = 'flow-controlled';
        state = 'flow-controlled';
        dotStatus = 'flow-controlled';
        includeCandidate = true;
        break;
      case 'paused':
        reason = 'paused';
        state = 'paused';
        dotStatus = 'paused';
        includeCandidate = true;
        break;
      case 'restoring':
        reason = 'restoring';
        state = 'restoring';
        dotStatus = 'restoring';
        includeCandidate = true;
        break;
      case 'running':
        state = 'active';
        dotStatus = 'busy';
        includeCandidate = true;
        break;
      case 'exited':
        if ((agent.exitCode ?? 0) !== 0 || agent.signal === 'spawn_failed') {
          reason = 'failed';
          state = 'exited-error';
          dotStatus = 'failed';
          includeCandidate = true;
        }
        break;
      default:
        break;
    }

    if (!includeCandidate) {
      continue;
    }

    const candidate: TaskPresentationCandidate = {
      attention: reason
        ? createAttentionEntry(
            taskId,
            agentId,
            reason,
            state,
            dotStatus,
            agent.lastOutput[agent.lastOutput.length - 1] ?? '',
            null,
            0,
          )
        : null,
      dotStatus,
      priority: getPresentationPriority(reason, state),
      updatedAt: 0,
    };

    if (
      !bestCandidate ||
      candidate.priority < bestCandidate.priority ||
      (candidate.priority === bestCandidate.priority &&
        candidate.updatedAt > bestCandidate.updatedAt)
    ) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function getGitCandidate(taskId: string): TaskPresentationCandidate {
  return {
    attention: null,
    dotStatus: hasCleanCommittedChanges(taskId) ? 'ready' : 'waiting',
    priority: hasCleanCommittedChanges(taskId) ? 8 : 99,
    updatedAt: 0,
  };
}

function pickBestCandidate(
  candidates: Array<TaskPresentationCandidate | null>,
): TaskPresentationCandidate {
  let bestCandidate: TaskPresentationCandidate | null = null;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (
      !bestCandidate ||
      candidate.priority < bestCandidate.priority ||
      (candidate.priority === bestCandidate.priority &&
        candidate.updatedAt > bestCandidate.updatedAt)
    ) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate ?? { attention: null, dotStatus: 'waiting', priority: 99, updatedAt: 0 };
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
