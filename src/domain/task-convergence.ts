import {
  isArrayOf,
  isNonNegativeInteger,
  isOptionalNonNegativeInteger,
  isRecord,
  isStringArray,
  isStringKeyOf,
} from '../lib/type-guards.js';
import { isRemovedTaskScopedEvent } from './removed-task-event.js';

export type TaskReviewState =
  | 'review-ready'
  | 'needs-refresh'
  | 'merge-blocked'
  | 'dirty-uncommitted'
  | 'no-changes'
  | 'unavailable';

export type TaskReviewReason = 'behind-base' | 'branch-mismatch' | 'detached-head' | 'conflicts';

export interface TaskOverlapWarning {
  otherTaskId: string;
  otherTaskName: string;
  sharedCount: number;
  sharedFiles: string[];
}

export interface TaskConvergenceSnapshot {
  /** Optional so persisted snapshots from older servers remain readable. */
  baseBranch?: string;
  branchFiles: string[];
  branchName: string;
  changedFileCount: number;
  commitCount: number;
  conflictingFiles: string[];
  currentBranch?: string | null;
  hasCommittedChanges: boolean;
  hasUncommittedChanges: boolean;
  mainAheadCount: number;
  overlapWarnings: TaskOverlapWarning[];
  projectId: string;
  reviewReason?: TaskReviewReason;
  state: TaskReviewState;
  summary: string;
  taskId: string;
  totalAdded: number;
  totalRemoved: number;
  updatedAt: number;
  worktreePath: string;
}

export interface RemovedTaskConvergenceEvent {
  removed: true;
  stateVersion?: number;
  taskId: string;
}

export type TaskConvergenceEvent =
  | (TaskConvergenceSnapshot & { stateVersion?: number })
  | RemovedTaskConvergenceEvent;

export type TaskReviewQueueGroup = 'needs-refresh' | 'overlap-risk' | 'ready-to-review';
export type TaskReviewTone = 'accent' | 'error' | 'muted' | 'subtle' | 'success' | 'warning';

export interface TaskReviewQueueEntry {
  group: TaskReviewQueueGroup;
  label: string;
  snapshot: TaskConvergenceSnapshot;
  taskId: string;
  taskName: string;
}

interface TaskReviewStateMetadata {
  badgeLabel: string | null;
  badgeTone: TaskReviewTone;
  label: string;
  panelTone: TaskReviewTone;
  queueGroup: TaskReviewQueueGroup | null;
  queueOrder: number;
}

interface TaskReviewQueueGroupMetadata {
  label: string;
  order: number;
}

const TASK_REVIEW_STATE_METADATA: Record<TaskReviewState, TaskReviewStateMetadata> = {
  'review-ready': {
    badgeLabel: 'Ready',
    badgeTone: 'success',
    label: 'Ready',
    panelTone: 'success',
    queueGroup: 'ready-to-review',
    queueOrder: 3,
  },
  'needs-refresh': {
    badgeLabel: 'Needs attention',
    badgeTone: 'warning',
    label: 'Needs attention',
    panelTone: 'warning',
    queueGroup: 'needs-refresh',
    queueOrder: 1,
  },
  'merge-blocked': {
    badgeLabel: 'Blocked',
    badgeTone: 'error',
    label: 'Blocked',
    panelTone: 'error',
    queueGroup: 'needs-refresh',
    queueOrder: 0,
  },
  'dirty-uncommitted': {
    badgeLabel: 'Dirty',
    badgeTone: 'accent',
    label: 'Dirty',
    panelTone: 'accent',
    queueGroup: 'needs-refresh',
    queueOrder: 2,
  },
  'no-changes': {
    badgeLabel: null,
    badgeTone: 'muted',
    label: 'No changes',
    panelTone: 'subtle',
    queueGroup: null,
    queueOrder: 4,
  },
  unavailable: {
    badgeLabel: null,
    badgeTone: 'muted',
    label: 'Unavailable',
    panelTone: 'muted',
    queueGroup: null,
    queueOrder: 5,
  },
};

const TASK_REVIEW_QUEUE_GROUP_METADATA: Record<TaskReviewQueueGroup, TaskReviewQueueGroupMetadata> =
  {
    'needs-refresh': {
      label: 'Needs attention',
      order: 0,
    },
    'overlap-risk': {
      label: 'Overlap Risk',
      order: 1,
    },
    'ready-to-review': {
      label: 'Ready To Review',
      order: 2,
    },
  };

export function isTaskReviewState(value: unknown): value is TaskReviewState {
  return isStringKeyOf(value, TASK_REVIEW_STATE_METADATA);
}

export function isTaskOverlapWarning(value: unknown): value is TaskOverlapWarning {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.otherTaskId === 'string' &&
    typeof value.otherTaskName === 'string' &&
    isNonNegativeInteger(value.sharedCount) &&
    isStringArray(value.sharedFiles)
  );
}

export function isTaskConvergenceSnapshot(value: unknown): value is TaskConvergenceSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isStringArray(value.branchFiles) &&
    (value.baseBranch === undefined || typeof value.baseBranch === 'string') &&
    typeof value.branchName === 'string' &&
    isNonNegativeInteger(value.changedFileCount) &&
    isNonNegativeInteger(value.commitCount) &&
    isStringArray(value.conflictingFiles) &&
    (value.currentBranch === undefined ||
      value.currentBranch === null ||
      typeof value.currentBranch === 'string') &&
    typeof value.hasCommittedChanges === 'boolean' &&
    typeof value.hasUncommittedChanges === 'boolean' &&
    isNonNegativeInteger(value.mainAheadCount) &&
    isArrayOf(value.overlapWarnings, isTaskOverlapWarning) &&
    typeof value.projectId === 'string' &&
    isTaskReviewState(value.state) &&
    (value.reviewReason === undefined ||
      value.reviewReason === 'behind-base' ||
      value.reviewReason === 'branch-mismatch' ||
      value.reviewReason === 'detached-head' ||
      value.reviewReason === 'conflicts') &&
    typeof value.summary === 'string' &&
    typeof value.taskId === 'string' &&
    isNonNegativeInteger(value.totalAdded) &&
    isNonNegativeInteger(value.totalRemoved) &&
    isNonNegativeInteger(value.updatedAt) &&
    typeof value.worktreePath === 'string'
  );
}

export function isRemovedTaskConvergenceEvent(
  event: unknown,
): event is RemovedTaskConvergenceEvent {
  return isRemovedTaskScopedEvent(event);
}

export function isTaskConvergenceEvent(value: unknown): value is TaskConvergenceEvent {
  if (!isRecord(value)) {
    return false;
  }

  if (isRemovedTaskConvergenceEvent(value)) {
    return true;
  }

  return isTaskConvergenceSnapshot(value) && isOptionalNonNegativeInteger(value.stateVersion);
}

export function getTaskReviewStateLabel(state: TaskReviewState): string {
  return TASK_REVIEW_STATE_METADATA[state].label;
}

export function getTaskReviewStateBadgeLabel(state: TaskReviewState): string | null {
  return TASK_REVIEW_STATE_METADATA[state].badgeLabel;
}

/** Present backend reasons; never infer readiness or branch identity from legacy summary text. */
export function getTaskReviewPresentation(snapshot: TaskConvergenceSnapshot): {
  badgeLabel: string | null;
  label: string;
  summary: string;
} {
  const base = snapshot.baseBranch ? `"${snapshot.baseBranch}"` : 'the base branch';
  let label = getTaskReviewStateLabel(snapshot.state);
  let summary = snapshot.summary;
  if (snapshot.state === 'needs-refresh') {
    switch (snapshot.reviewReason) {
      case 'behind-base':
        label = `Behind ${snapshot.mainAheadCount}`;
        summary = `This branch is behind ${base} by ${snapshot.mainAheadCount} ${snapshot.mainAheadCount === 1 ? 'commit' : 'commits'}. Review the branch differences before updating this checkout.`;
        break;
      case 'branch-mismatch':
        label = 'Branch changed';
        summary = `Checkout is on ${snapshot.currentBranch ? `"${snapshot.currentBranch}"` : 'a different branch'}, recorded task branch is "${snapshot.branchName}". Inspect the checkout before changing branches; other tasks may share it.`;
        break;
      case 'detached-head':
        label = 'Detached';
        summary = `Checkout has no named branch (detached HEAD); the recorded task branch is "${snapshot.branchName}". Inspect the checkout before changing branches; other tasks may share it.`;
        break;
    }
  } else if (snapshot.state === 'merge-blocked' && snapshot.reviewReason === 'conflicts') {
    const count = snapshot.conflictingFiles.length;
    label = `Conflicts ${count}`;
    summary = `${count} ${count === 1 ? 'file conflicts' : 'files conflict'} with ${base}. Resolve the conflicts before merging.`;
  }
  return {
    badgeLabel: getTaskReviewStateBadgeLabel(snapshot.state) === null ? null : label,
    label,
    summary,
  };
}

export function getTaskReviewStateBadgeTone(state: TaskReviewState): TaskReviewTone {
  return TASK_REVIEW_STATE_METADATA[state].badgeTone;
}

export function getTaskReviewStatePanelTone(state: TaskReviewState): TaskReviewTone {
  return TASK_REVIEW_STATE_METADATA[state].panelTone;
}

export function getTaskReviewStateQueueGroup(state: TaskReviewState): TaskReviewQueueGroup | null {
  return TASK_REVIEW_STATE_METADATA[state].queueGroup;
}

export function getTaskReviewStateQueueOrder(state: TaskReviewState): number {
  return TASK_REVIEW_STATE_METADATA[state].queueOrder;
}

export function getTaskReviewQueueGroupLabel(group: TaskReviewQueueGroup): string {
  return TASK_REVIEW_QUEUE_GROUP_METADATA[group].label;
}

export function getTaskReviewQueueGroupOrder(group: TaskReviewQueueGroup): number {
  return TASK_REVIEW_QUEUE_GROUP_METADATA[group].order;
}
