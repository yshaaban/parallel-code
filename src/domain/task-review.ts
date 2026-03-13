import type { ChangedFile } from '../ipc/types.js';

export type TaskReviewSource = 'worktree' | 'branch-fallback' | 'unavailable';

export interface TaskReviewSnapshot {
  branchName: string;
  files: ChangedFile[];
  projectId: string;
  revisionId: string;
  source: TaskReviewSource;
  taskId: string;
  totalAdded: number;
  totalRemoved: number;
  updatedAt: number;
  worktreePath: string;
}

export interface RemovedTaskReviewEvent {
  removed: true;
  taskId: string;
}

export type TaskReviewEvent = TaskReviewSnapshot | RemovedTaskReviewEvent;

export function isRemovedTaskReviewEvent(event: TaskReviewEvent): event is RemovedTaskReviewEvent {
  return 'removed' in event;
}
