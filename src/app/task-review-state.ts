import {
  isRemovedTaskReviewEvent,
  type TaskReviewEvent,
  type TaskReviewSnapshot,
} from '../domain/task-review';
import {
  clearKeyedSnapshotRecordEntry,
  getKeyedSnapshotRecordEntry,
  replaceKeyedSnapshotRecord,
  setKeyedSnapshotRecordEntry,
} from '../store/keyed-snapshot-record';

export function applyTaskReviewEvent(event: TaskReviewEvent): void {
  if (isRemovedTaskReviewEvent(event)) {
    clearKeyedSnapshotRecordEntry('taskReview', event.taskId);
    return;
  }

  setKeyedSnapshotRecordEntry('taskReview', event.taskId, event);
}

export function replaceTaskReviewSnapshots(snapshots: ReadonlyArray<TaskReviewSnapshot>): void {
  replaceKeyedSnapshotRecord('taskReview', snapshots, (snapshot) => snapshot.taskId);
}

export function clearTaskReview(taskId: string): void {
  clearKeyedSnapshotRecordEntry('taskReview', taskId);
}

export function getTaskReviewSnapshot(taskId: string): TaskReviewSnapshot | undefined {
  return getKeyedSnapshotRecordEntry('taskReview', taskId);
}
