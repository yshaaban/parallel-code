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

export type TaskReviewQueueGroup = 'needs-refresh' | 'overlap-risk' | 'ready-to-review';

export interface TaskReviewQueueEntry {
  group: TaskReviewQueueGroup;
  label: string;
  snapshot: TaskConvergenceSnapshot;
  taskId: string;
  taskName: string;
}

export function getTaskReviewStateLabel(state: TaskReviewState): string {
  switch (state) {
    case 'review-ready':
      return 'Ready';
    case 'needs-refresh':
      return 'Refresh';
    case 'merge-blocked':
      return 'Blocked';
    case 'dirty-uncommitted':
      return 'Dirty';
    case 'no-changes':
      return 'No changes';
    case 'unavailable':
      return 'Unavailable';
    default:
      return 'Review';
  }
}

export function getTaskReviewQueueGroupLabel(group: TaskReviewQueueGroup): string {
  switch (group) {
    case 'needs-refresh':
      return 'Needs Refresh';
    case 'overlap-risk':
      return 'Overlap Risk';
    case 'ready-to-review':
      return 'Ready To Review';
    default:
      return 'Review';
  }
}
