import {
  createRemovedTaskStepsEvent,
  isRemovedTaskStepsEvent,
  type TaskStepsEvent,
  type TaskStepsSnapshot,
  type TaskStepsSummarySnapshot,
} from '../domain/task-steps';
import {
  clearKeyedSnapshotRecordEntry,
  replaceKeyedSnapshotRecord,
  setKeyedSnapshotRecordEntry,
} from './keyed-snapshot-record';
import { getKeyedSnapshotRecordEntry } from './keyed-snapshot-record';

export function applyTaskStepsEvent(event: TaskStepsEvent): void {
  if (isRemovedTaskStepsEvent(event)) {
    clearTaskSteps(event.taskId);
    return;
  }

  setKeyedSnapshotRecordEntry('taskStepSummaries', event.taskId, event);
}

export function replaceTaskStepsSummarySnapshots(
  snapshots: ReadonlyArray<TaskStepsSummarySnapshot>,
): void {
  replaceKeyedSnapshotRecord('taskStepSummaries', snapshots, (snapshot) => snapshot.taskId);
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
