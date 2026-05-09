import type { ChangedFile } from '../ipc/types.js';
import { isChangedFileStatus } from './git-status.js';
import {
  isArrayOf,
  isNonNegativeInteger,
  isOptionalNonNegativeInteger,
  isRecord,
  isStringMember,
} from '../lib/type-guards.js';
import { isRemovedTaskScopedEvent } from './removed-task-event.js';

export type TaskReviewSource = 'worktree' | 'branch-fallback' | 'unavailable';

const TASK_REVIEW_SOURCE_VALUES = {
  'branch-fallback': true,
  unavailable: true,
  worktree: true,
} satisfies Record<TaskReviewSource, true>;

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
  stateVersion?: number;
  taskId: string;
}

export type TaskReviewEvent =
  | (TaskReviewSnapshot & { stateVersion?: number })
  | RemovedTaskReviewEvent;

export function isRemovedTaskReviewEvent(event: unknown): event is RemovedTaskReviewEvent {
  return isRemovedTaskScopedEvent(event);
}

export function isTaskReviewSource(value: unknown): value is TaskReviewSource {
  return isStringMember(value, TASK_REVIEW_SOURCE_VALUES);
}

export function isTaskReviewFile(value: unknown): value is TaskReviewSnapshot['files'][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.path === 'string' &&
    isChangedFileStatus(value.status) &&
    typeof value.committed === 'boolean' &&
    isNonNegativeInteger(value.lines_added) &&
    isNonNegativeInteger(value.lines_removed)
  );
}

export function isTaskReviewSnapshot(value: unknown): value is TaskReviewSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.taskId === 'string' &&
    typeof value.branchName === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.revisionId === 'string' &&
    isArrayOf(value.files, isTaskReviewFile) &&
    isTaskReviewSource(value.source) &&
    isNonNegativeInteger(value.totalAdded) &&
    isNonNegativeInteger(value.totalRemoved) &&
    isNonNegativeInteger(value.updatedAt) &&
    typeof value.worktreePath === 'string'
  );
}

export function isTaskReviewEvent(value: unknown): value is TaskReviewEvent {
  if (!isRecord(value)) {
    return false;
  }

  if (isRemovedTaskReviewEvent(value)) {
    return true;
  }

  return isTaskReviewSnapshot(value) && isOptionalNonNegativeInteger(value.stateVersion);
}
