import {
  createRemovedTaskStepsEvent,
  isRemovedTaskStepsEvent,
  type TaskStepsEvent,
  type TaskStepsSnapshot,
  type TaskStepsSummarySnapshot,
} from '../domain/task-steps';
import {
  clearKeyedSnapshotRecordEntry,
  getKeyedSnapshotRecordEntry,
  replaceKeyedSnapshotRecord,
  setKeyedSnapshotRecordEntry,
} from './keyed-snapshot-record';
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
} from './server-state-versioning';

const taskStepsSummaryVersionTracker = createServerStateVersionTracker();

export function getTaskStepsHighestAppliedVersion(): number {
  return taskStepsSummaryVersionTracker.highestVersion;
}

export function applyTaskStepsEvent(event: TaskStepsEvent): void {
  const stateVersion = getServerStatePayloadVersion(event);
  if (isRemovedTaskStepsEvent(event)) {
    if (
      !shouldApplyServerStateEventVersion(
        taskStepsSummaryVersionTracker,
        event.taskId,
        stateVersion,
      )
    ) {
      return;
    }
    clearTaskSteps(event.taskId);
    noteServerStateEventVersion(taskStepsSummaryVersionTracker, event.taskId, stateVersion);
    return;
  }

  const current = getKeyedSnapshotRecordEntry('taskStepSummaries', event.taskId);
  if (
    !shouldApplyServerStateSnapshotEvent(
      taskStepsSummaryVersionTracker,
      event.taskId,
      stateVersion,
      current?.updatedAt,
      event.updatedAt,
    )
  ) {
    return;
  }

  setKeyedSnapshotRecordEntry(
    'taskStepSummaries',
    event.taskId,
    stripServerStatePayloadVersion(event),
  );
  noteServerStateEventVersion(taskStepsSummaryVersionTracker, event.taskId, stateVersion);
}

export function replaceTaskStepsSummarySnapshots(
  snapshots: ReadonlyArray<TaskStepsSummarySnapshot>,
  options: { replaceVersion?: number } = {},
): void {
  if (!shouldApplyServerStateReplacement(taskStepsSummaryVersionTracker, options.replaceVersion)) {
    return;
  }

  replaceKeyedSnapshotRecord('taskStepSummaries', snapshots, (snapshot) => snapshot.taskId);
  noteServerStateReplacement(
    taskStepsSummaryVersionTracker,
    snapshots.map((snapshot) => snapshot.taskId),
    options.replaceVersion,
  );
}

export function setTaskStepsSnapshot(snapshot: TaskStepsSnapshot): void {
  setKeyedSnapshotRecordEntry('taskSteps', snapshot.taskId, snapshot);
}

export function getTaskStepsSnapshot(taskId: string): TaskStepsSnapshot | undefined {
  return getKeyedSnapshotRecordEntry('taskSteps', taskId);
}

export function getTaskStepsSummary(taskId: string): TaskStepsSummarySnapshot | undefined {
  return getKeyedSnapshotRecordEntry('taskStepSummaries', taskId);
}

export function clearTaskSteps(taskId: string): void {
  clearKeyedSnapshotRecordEntry('taskSteps', taskId);
  clearKeyedSnapshotRecordEntry('taskStepSummaries', taskId);
}

export function createRemovedTaskStepsSummaryEvent(taskId: string): TaskStepsEvent {
  return createRemovedTaskStepsEvent(taskId);
}

// Per-boot version tracking is reset when the server instance changes; see
// resetServerStateVersionTrackingForInstanceChange.
export function resetTaskStepsVersionTracking(): void {
  resetServerStateVersionTracker(taskStepsSummaryVersionTracker);
}

export function resetTaskStepsProjectionStateForTests(): void {
  resetTaskStepsVersionTracking();
}
