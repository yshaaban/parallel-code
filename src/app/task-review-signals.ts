import {
  isRemovedTaskReviewSignalsEvent,
  type TaskReviewSignalsEvent,
  type TaskReviewSignalsSnapshot,
} from '../domain/task-review-signals';
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

const taskReviewSignalsVersionTracker = createServerStateVersionTracker();

export function getTaskReviewSignalsHighestAppliedVersion(): number {
  return taskReviewSignalsVersionTracker.highestVersion;
}

export function applyTaskReviewSignalsEvent(event: TaskReviewSignalsEvent): void {
  const stateVersion = getServerStatePayloadVersion(event);
  if (isRemovedTaskReviewSignalsEvent(event)) {
    if (
      !shouldApplyServerStateEventVersion(
        taskReviewSignalsVersionTracker,
        event.taskId,
        stateVersion,
      )
    ) {
      return;
    }
    clearKeyedSnapshotRecordEntry('taskReviewSignals', event.taskId);
    noteServerStateEventVersion(taskReviewSignalsVersionTracker, event.taskId, stateVersion);
    return;
  }

  const current = getKeyedSnapshotRecordEntry('taskReviewSignals', event.taskId);
  if (
    !shouldApplyServerStateSnapshotEvent(
      taskReviewSignalsVersionTracker,
      event.taskId,
      stateVersion,
      current?.updatedAt,
      event.updatedAt,
    )
  ) {
    return;
  }

  setKeyedSnapshotRecordEntry(
    'taskReviewSignals',
    event.taskId,
    stripServerStatePayloadVersion(event),
  );
  noteServerStateEventVersion(taskReviewSignalsVersionTracker, event.taskId, stateVersion);
}

export function replaceTaskReviewSignalsSnapshots(
  snapshots: ReadonlyArray<TaskReviewSignalsSnapshot>,
  options: { replaceVersion?: number } = {},
): void {
  if (!shouldApplyServerStateReplacement(taskReviewSignalsVersionTracker, options.replaceVersion)) {
    return;
  }

  replaceKeyedSnapshotRecord('taskReviewSignals', snapshots, (snapshot) => snapshot.taskId);
  noteServerStateReplacement(
    taskReviewSignalsVersionTracker,
    snapshots.map((snapshot) => snapshot.taskId),
    options.replaceVersion,
  );
}

export function clearTaskReviewSignals(taskId: string): void {
  clearKeyedSnapshotRecordEntry('taskReviewSignals', taskId);
}

export function getTaskReviewSignalsSnapshot(
  taskId: string,
): TaskReviewSignalsSnapshot | undefined {
  return getKeyedSnapshotRecordEntry('taskReviewSignals', taskId);
}

// Per-boot version tracking is reset when the server instance changes; see
// resetServerStateVersionTrackingForInstanceChange.
export function resetTaskReviewSignalsVersionTracking(): void {
  resetServerStateVersionTracker(taskReviewSignalsVersionTracker);
}

export function resetTaskReviewSignalsProjectionStateForTests(): void {
  resetTaskReviewSignalsVersionTracking();
}
