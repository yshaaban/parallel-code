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
import { isTaskRemoving } from '../domain/task-closing';
import { assertNever } from '../lib/assert-never';
import { invoke } from '../lib/ipc';
import { deleteRecordEntry } from '../store/record-utils';
import { setStore, store } from '../store/state';

const QUEUE_GROUP_BY_REVIEW_STATE: Record<TaskReviewState, TaskReviewQueueGroup | null> = {
  'dirty-uncommitted': 'needs-refresh',
  'merge-blocked': 'needs-refresh',
  'needs-refresh': 'needs-refresh',
  'no-changes': null,
  'review-ready': 'ready-to-review',
  unavailable: null,
};

const TASK_REVIEW_GROUP_ORDER: Record<TaskReviewQueueGroup, number> = {
  'needs-refresh': 0,
  'overlap-risk': 1,
  'ready-to-review': 2,
};

const TASK_REVIEW_STATE_ORDER: Record<TaskReviewState, number> = {
  'merge-blocked': 0,
  'needs-refresh': 1,
  'dirty-uncommitted': 2,
  'review-ready': 3,
  'no-changes': 4,
  unavailable: 5,
};

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
  const baseGroup = QUEUE_GROUP_BY_REVIEW_STATE[snapshot.state];
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
    return TASK_REVIEW_GROUP_ORDER[left.group] - TASK_REVIEW_GROUP_ORDER[right.group];
  }

  if (left.group === 'needs-refresh') {
    const stateDelta =
      TASK_REVIEW_STATE_ORDER[left.snapshot.state] - TASK_REVIEW_STATE_ORDER[right.snapshot.state];
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
