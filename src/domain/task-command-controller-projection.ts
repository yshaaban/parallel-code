import type { TaskCommandControllerSnapshot } from './server-state.js';

export type TaskCommandControllerSnapshotRecord = Record<string, TaskCommandControllerSnapshot>;

export function shouldApplyTaskCommandControllerSnapshot(
  previous: TaskCommandControllerSnapshot | undefined,
  next: TaskCommandControllerSnapshot,
): boolean {
  return !previous || next.version >= previous.version;
}

export function shouldApplyTaskCommandControllerVersion(
  currentVersion: number,
  next: TaskCommandControllerSnapshot,
): boolean {
  return next.version >= currentVersion;
}

function omitSnapshotRecordKey(
  record: TaskCommandControllerSnapshotRecord,
  taskId: string,
): TaskCommandControllerSnapshotRecord {
  const { [taskId]: _omitted, ...nextRecord } = record;
  return nextRecord;
}

export function applyTaskCommandControllerSnapshotRecord(
  previous: TaskCommandControllerSnapshotRecord,
  snapshot: TaskCommandControllerSnapshot,
): TaskCommandControllerSnapshotRecord {
  const current = previous[snapshot.taskId];
  if (!shouldApplyTaskCommandControllerSnapshot(current, snapshot)) {
    return previous;
  }

  if (!snapshot.controllerId) {
    if (!current) {
      return previous;
    }

    return omitSnapshotRecordKey(previous, snapshot.taskId);
  }

  return {
    ...previous,
    [snapshot.taskId]: snapshot,
  };
}

export function normalizeTaskCommandControllerSnapshots(
  snapshots: ReadonlyArray<TaskCommandControllerSnapshot>,
): TaskCommandControllerSnapshotRecord {
  let nextRecord: TaskCommandControllerSnapshotRecord = {};
  const sortedSnapshots = [...snapshots].sort((left, right) => left.version - right.version);

  for (const snapshot of sortedSnapshots) {
    nextRecord = applyTaskCommandControllerSnapshotRecord(nextRecord, snapshot);
  }

  return nextRecord;
}
