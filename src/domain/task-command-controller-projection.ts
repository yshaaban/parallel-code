import { omitRecordKey } from '../lib/record-utils';
import type { TaskCommandControllerSnapshot } from './server-state.js';

export type TaskCommandControllerSnapshotRecord = Record<string, TaskCommandControllerSnapshot>;

interface TaskCommandControllerIdentityLike {
  action: string | null | undefined;
  controllerId: string | null | undefined;
}

interface TaskCommandControllerSnapshotSource extends TaskCommandControllerIdentityLike {
  version: number | undefined;
}

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

export function getTaskCommandControllerSnapshot(
  taskId: string,
  controller: TaskCommandControllerSnapshotSource | null | undefined,
  fallbackVersion: number,
): TaskCommandControllerSnapshot {
  if (controller) {
    return {
      action: controller.action ?? null,
      controllerId: controller.controllerId ?? null,
      taskId,
      version: controller.version ?? fallbackVersion,
    };
  }

  return {
    action: null,
    controllerId: null,
    taskId,
    version: fallbackVersion,
  };
}

export function areTaskCommandControllerStatesEqual(
  left: TaskCommandControllerIdentityLike | null | undefined,
  right: TaskCommandControllerIdentityLike | null | undefined,
): boolean {
  return left?.action === right?.action && left?.controllerId === right?.controllerId;
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

    return omitRecordKey(previous, snapshot.taskId);
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
