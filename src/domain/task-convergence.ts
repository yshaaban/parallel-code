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
  taskId: string;
}

export type TaskConvergenceEvent = TaskConvergenceSnapshot | RemovedTaskConvergenceEvent;

export type TaskReviewQueueGroup = 'needs-refresh' | 'overlap-risk' | 'ready-to-review';

export interface TaskReviewQueueEntry {
  group: TaskReviewQueueGroup;
  label: string;
  snapshot: TaskConvergenceSnapshot;
  taskId: string;
  taskName: string;
}

const TASK_REVIEW_STATE_LABELS: Record<TaskReviewState, string> = {
  'review-ready': 'Ready',
  'needs-refresh': 'Refresh',
  'merge-blocked': 'Blocked',
  'dirty-uncommitted': 'Dirty',
  'no-changes': 'No changes',
  unavailable: 'Unavailable',
};

const TASK_REVIEW_QUEUE_GROUP_LABELS: Record<TaskReviewQueueGroup, string> = {
  'needs-refresh': 'Needs Refresh',
  'overlap-risk': 'Overlap Risk',
  'ready-to-review': 'Ready To Review',
};

export function isRemovedTaskConvergenceEvent(
  event: TaskConvergenceEvent,
): event is RemovedTaskConvergenceEvent {
  return 'removed' in event;
}

export function getTaskReviewStateLabel(state: TaskReviewState): string {
  return TASK_REVIEW_STATE_LABELS[state];
}

export function getTaskReviewQueueGroupLabel(group: TaskReviewQueueGroup): string {
  return TASK_REVIEW_QUEUE_GROUP_LABELS[group];
}
