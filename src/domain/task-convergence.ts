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

export interface TaskOverlapWarning {
  otherTaskId: string;
  otherTaskName: string;
  sharedCount: number;
  sharedFiles: string[];
}

export interface TaskConvergenceSnapshot {
  branchFiles: string[];
  branchName: string;
  changedFileCount: number;
  commitCount: number;
  conflictingFiles: string[];
  hasCommittedChanges: boolean;
  hasUncommittedChanges: boolean;
  mainAheadCount: number;
  overlapWarnings: TaskOverlapWarning[];
  projectId: string;
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
    badgeLabel: 'Refresh',
    badgeTone: 'warning',
    label: 'Refresh',
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
      label: 'Needs Refresh',
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
    typeof value.branchName === 'string' &&
    isNonNegativeInteger(value.changedFileCount) &&
    isNonNegativeInteger(value.commitCount) &&
    isStringArray(value.conflictingFiles) &&
    typeof value.hasCommittedChanges === 'boolean' &&
    typeof value.hasUncommittedChanges === 'boolean' &&
    isNonNegativeInteger(value.mainAheadCount) &&
    isArrayOf(value.overlapWarnings, isTaskOverlapWarning) &&
    typeof value.projectId === 'string' &&
    isTaskReviewState(value.state) &&
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
