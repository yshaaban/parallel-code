import { IPC } from '../../electron/ipc/channels';
import {
  getTaskReviewQueueGroupOrder,
  getTaskReviewStateQueueGroup,
  getTaskReviewStateQueueOrder,
  isRemovedTaskConvergenceEvent,
  type TaskConvergenceEvent,
  type TaskConvergenceSnapshot,
  type TaskReviewQueueEntry,
  type TaskReviewQueueGroup,
} from '../domain/task-convergence';
import { isTaskRemoving } from '../domain/task-closing';
import { assertNever } from '../lib/assert-never';
import { invoke } from '../lib/ipc';
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
import { store } from '../store/state';

const taskConvergenceVersionTracker = createServerStateVersionTracker();

export function getTaskConvergenceHighestAppliedVersion(): number {
  return taskConvergenceVersionTracker.highestVersion;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export async function fetchTaskConvergence(): Promise<TaskConvergenceSnapshot[]> {
  return invoke(IPC.GetTaskConvergence);
}

export function applyTaskConvergenceEvent(event: TaskConvergenceEvent): void {
  const stateVersion = getServerStatePayloadVersion(event);
  if (isRemovedTaskConvergenceEvent(event)) {
    if (
      !shouldApplyServerStateEventVersion(taskConvergenceVersionTracker, event.taskId, stateVersion)
    ) {
      return;
    }
    clearKeyedSnapshotRecordEntry('taskConvergence', event.taskId);
    noteServerStateEventVersion(taskConvergenceVersionTracker, event.taskId, stateVersion);
    return;
  }

  const current = getKeyedSnapshotRecordEntry('taskConvergence', event.taskId);
  if (
    !shouldApplyServerStateSnapshotEvent(
      taskConvergenceVersionTracker,
      event.taskId,
      stateVersion,
      current?.updatedAt,
      event.updatedAt,
    )
  ) {
    return;
  }

  setKeyedSnapshotRecordEntry(
    'taskConvergence',
    event.taskId,
    stripServerStatePayloadVersion(event),
  );
  noteServerStateEventVersion(taskConvergenceVersionTracker, event.taskId, stateVersion);
}

export function replaceTaskConvergenceSnapshots(
  snapshots: ReadonlyArray<TaskConvergenceSnapshot>,
  options: { replaceVersion?: number } = {},
): void {
  if (!shouldApplyServerStateReplacement(taskConvergenceVersionTracker, options.replaceVersion)) {
    return;
  }

  replaceKeyedSnapshotRecord('taskConvergence', snapshots, (snapshot) => snapshot.taskId);
  noteServerStateReplacement(
    taskConvergenceVersionTracker,
    snapshots.map((snapshot) => snapshot.taskId),
    options.replaceVersion,
  );
}

export function clearTaskConvergence(taskId: string): void {
  clearKeyedSnapshotRecordEntry('taskConvergence', taskId);
}

export function getTaskConvergenceSnapshot(taskId: string): TaskConvergenceSnapshot | undefined {
  return getKeyedSnapshotRecordEntry('taskConvergence', taskId);
}

function getQueueGroup(snapshot: TaskConvergenceSnapshot): TaskReviewQueueGroup | null {
  const baseGroup = getTaskReviewStateQueueGroup(snapshot.state);
  if (snapshot.state === 'review-ready' && snapshot.overlapWarnings.length > 0) {
    return 'overlap-risk';
  }

  return baseGroup;
}

function getQueueLabel(snapshot: TaskConvergenceSnapshot, group: TaskReviewQueueGroup): string {
  if (group === 'overlap-risk') {
    const topOverlap = snapshot.overlapWarnings[0];
    if (!topOverlap) {
      return 'Overlapping changes';
    }

    return `${formatCount(topOverlap.sharedCount, 'shared file')} with ${topOverlap.otherTaskName}`;
  }

  switch (snapshot.state) {
    case 'merge-blocked':
      return `${formatCount(snapshot.conflictingFiles.length, 'conflict')} with main`;
    case 'needs-refresh':
      return `Main ahead by ${formatCount(snapshot.mainAheadCount, 'commit')}`;
    case 'dirty-uncommitted':
      return 'Commit or discard changes';
    case 'review-ready':
      return `${formatCount(snapshot.commitCount, 'commit')}, ${formatCount(snapshot.changedFileCount, 'file')}`;
    case 'no-changes':
    case 'unavailable':
      return snapshot.summary;
  }

  return assertNever(snapshot.state, 'Unhandled task review state');
}

function compareQueueEntries(left: TaskReviewQueueEntry, right: TaskReviewQueueEntry): number {
  if (left.group !== right.group) {
    return getTaskReviewQueueGroupOrder(left.group) - getTaskReviewQueueGroupOrder(right.group);
  }

  if (left.group === 'needs-refresh') {
    const stateDelta =
      getTaskReviewStateQueueOrder(left.snapshot.state) -
      getTaskReviewStateQueueOrder(right.snapshot.state);
    if (stateDelta !== 0) {
      return stateDelta;
    }
  }

  if (left.group === 'overlap-risk') {
    const leftShared = left.snapshot.overlapWarnings[0]?.sharedCount ?? 0;
    const rightShared = right.snapshot.overlapWarnings[0]?.sharedCount ?? 0;
    if (leftShared !== rightShared) {
      return rightShared - leftShared;
    }
  }

  if (left.group === 'ready-to-review') {
    if (left.snapshot.commitCount !== right.snapshot.commitCount) {
      return right.snapshot.commitCount - left.snapshot.commitCount;
    }
    if (left.snapshot.changedFileCount !== right.snapshot.changedFileCount) {
      return right.snapshot.changedFileCount - left.snapshot.changedFileCount;
    }
  }

  return right.snapshot.updatedAt - left.snapshot.updatedAt;
}

export function getTaskReviewQueueEntries(): TaskReviewQueueEntry[] {
  const entries: TaskReviewQueueEntry[] = [];

  for (const snapshot of Object.values(store.taskConvergence)) {
    const task = store.tasks[snapshot.taskId];
    if (!task || isTaskRemoving(task)) {
      continue;
    }

    const group = getQueueGroup(snapshot);
    if (!group) {
      continue;
    }

    entries.push({
      group,
      label: getQueueLabel(snapshot, group),
      snapshot,
      taskId: task.id,
      taskName: task.name,
    });
  }

  return entries.sort(compareQueueEntries);
}

// Per-boot version tracking is reset when the server instance changes; see
// resetServerStateVersionTrackingForInstanceChange.
export function resetTaskConvergenceVersionTracking(): void {
  resetServerStateVersionTracker(taskConvergenceVersionTracker);
}

export function resetTaskConvergenceProjectionStateForTests(): void {
  resetTaskConvergenceVersionTracking();
}
