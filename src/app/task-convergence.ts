import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import {
  isRemovedTaskConvergenceEvent,
  type TaskConvergenceEvent,
  type TaskConvergenceSnapshot,
  type TaskReviewQueueEntry,
  type TaskReviewQueueGroup,
  type TaskReviewState,
} from '../domain/task-convergence';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';

function deleteRecordEntry<T>(record: Record<string, T>, key: string): void {
  Reflect.deleteProperty(record, key);
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export async function fetchTaskConvergence(): Promise<TaskConvergenceSnapshot[]> {
  return invoke(IPC.GetTaskConvergence);
}

export function applyTaskConvergenceEvent(event: TaskConvergenceEvent): void {
  if (isRemovedTaskConvergenceEvent(event)) {
    setStore(
      produce((state) => {
        deleteRecordEntry(state.taskConvergence, event.taskId);
      }),
    );
    return;
  }

  setStore('taskConvergence', event.taskId, event);
}

export function replaceTaskConvergenceSnapshots(
  snapshots: ReadonlyArray<TaskConvergenceSnapshot>,
): void {
  setStore(
    produce((state) => {
      state.taskConvergence = Object.fromEntries(
        snapshots.map((snapshot) => [snapshot.taskId, snapshot]),
      );
    }),
  );
}

export function clearTaskConvergence(taskId: string): void {
  setStore(
    produce((state) => {
      deleteRecordEntry(state.taskConvergence, taskId);
    }),
  );
}

export function getTaskConvergenceSnapshot(taskId: string): TaskConvergenceSnapshot | undefined {
  return store.taskConvergence[taskId];
}

function getQueueGroup(snapshot: TaskConvergenceSnapshot): TaskReviewQueueGroup | null {
  switch (snapshot.state) {
    case 'merge-blocked':
    case 'needs-refresh':
    case 'dirty-uncommitted':
      return 'needs-refresh';
    case 'review-ready':
      return snapshot.overlapWarnings.length > 0 ? 'overlap-risk' : 'ready-to-review';
    case 'no-changes':
    case 'unavailable':
      return null;
    default:
      return null;
  }
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
    default:
      return snapshot.summary;
  }
}

function compareQueueEntries(left: TaskReviewQueueEntry, right: TaskReviewQueueEntry): number {
  if (left.group !== right.group) {
    const groupOrder: Record<TaskReviewQueueGroup, number> = {
      'needs-refresh': 0,
      'overlap-risk': 1,
      'ready-to-review': 2,
    };
    return groupOrder[left.group] - groupOrder[right.group];
  }

  if (left.group === 'needs-refresh') {
    const stateOrder: Record<TaskReviewState, number> = {
      'merge-blocked': 0,
      'needs-refresh': 1,
      'dirty-uncommitted': 2,
      'review-ready': 3,
      'no-changes': 4,
      unavailable: 5,
    };
    const stateDelta = stateOrder[left.snapshot.state] - stateOrder[right.snapshot.state];
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
    if (!task || task.closingStatus === 'removing') {
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
