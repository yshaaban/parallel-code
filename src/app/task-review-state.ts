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
import {
  createServerStateVersionTracker,
  getServerStatePayloadVersion,
  noteServerStateEventVersion,
  noteServerStateReplacement,
  resetServerStateVersionTracker,
  shouldApplyServerStateEventVersion,
  shouldApplyServerStateReplacement,
  shouldApplyServerStateSnapshotEvent,
  stripServerStatePayloadVersion,
} from '../store/server-state-versioning';

const taskReviewVersionTracker = createServerStateVersionTracker();

export function applyTaskReviewEvent(event: TaskReviewEvent): void {
  const stateVersion = getServerStatePayloadVersion(event);
  if (isRemovedTaskReviewEvent(event)) {
    if (!shouldApplyServerStateEventVersion(taskReviewVersionTracker, event.taskId, stateVersion)) {
      return;
    }
    clearKeyedSnapshotRecordEntry('taskReview', event.taskId);
    noteServerStateEventVersion(taskReviewVersionTracker, event.taskId, stateVersion);
    return;
  }

  const current = getKeyedSnapshotRecordEntry('taskReview', event.taskId);
  if (
    !shouldApplyServerStateSnapshotEvent(
      taskReviewVersionTracker,
      event.taskId,
      stateVersion,
      current?.updatedAt,
      event.updatedAt,
    )
  ) {
    return;
  }

  setKeyedSnapshotRecordEntry('taskReview', event.taskId, stripServerStatePayloadVersion(event));
  noteServerStateEventVersion(taskReviewVersionTracker, event.taskId, stateVersion);
}

export function replaceTaskReviewSnapshots(
  snapshots: ReadonlyArray<TaskReviewSnapshot>,
  options: { replaceVersion?: number } = {},
): void {
  if (!shouldApplyServerStateReplacement(taskReviewVersionTracker, options.replaceVersion)) {
    return;
  }

  replaceKeyedSnapshotRecord('taskReview', snapshots, (snapshot) => snapshot.taskId);
  noteServerStateReplacement(
    taskReviewVersionTracker,
    snapshots.map((snapshot) => snapshot.taskId),
    options.replaceVersion,
  );
}

export function clearTaskReview(taskId: string): void {
  clearKeyedSnapshotRecordEntry('taskReview', taskId);
}

export function getTaskReviewSnapshot(taskId: string): TaskReviewSnapshot | undefined {
  return getKeyedSnapshotRecordEntry('taskReview', taskId);
}

export function resetTaskReviewProjectionStateForTests(): void {
  resetServerStateVersionTracker(taskReviewVersionTracker);
}
