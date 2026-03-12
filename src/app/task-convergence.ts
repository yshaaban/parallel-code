import { produce } from 'solid-js/store';

import { IPC } from '../../electron/ipc/channels';
import type { WorktreeStatus } from '../domain/server-state';
import type {
  TaskConvergenceSnapshot,
  TaskOverlapWarning,
  TaskReviewQueueEntry,
  TaskReviewQueueGroup,
  TaskReviewState,
} from '../domain/task-convergence';
import type { ChangedFile, MergeStatus } from '../ipc/types';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';

interface ProjectDiffResult {
  files: ChangedFile[];
  totalAdded: number;
  totalRemoved: number;
}

interface ReviewStateResult {
  state: TaskReviewState;
  summary: string;
}

const inFlightRefreshes = new Map<string, Promise<void>>();

function deleteRecordEntry<T>(record: Record<string, T>, key: string): void {
  Reflect.deleteProperty(record, key);
}

function countBranchCommits(branchLog: string): number {
  return branchLog
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getReviewState(
  worktreeStatus: WorktreeStatus,
  mergeStatus: MergeStatus,
): ReviewStateResult {
  if (mergeStatus.conflicting_files.length > 0) {
    return {
      state: 'merge-blocked',
      summary: `${formatCount(mergeStatus.conflicting_files.length, 'conflict')} with main`,
    };
  }

  if (mergeStatus.main_ahead_count > 0) {
    return {
      state: 'needs-refresh',
      summary: `Main is ahead by ${formatCount(mergeStatus.main_ahead_count, 'commit')}`,
    };
  }

  if (worktreeStatus.has_uncommitted_changes) {
    return {
      state: 'dirty-uncommitted',
      summary: 'Commit or discard uncommitted changes before merge review',
    };
  }

  if (worktreeStatus.has_committed_changes) {
    return {
      state: 'review-ready',
      summary: 'Branch is ready for review',
    };
  }

  return {
    state: 'no-changes',
    summary: 'No committed changes to review',
  };
}

function createUnavailableSnapshot(taskId: string): TaskConvergenceSnapshot | null {
  const task = store.tasks[taskId];
  if (!task) {
    return null;
  }

  return {
    branchFiles: [],
    branchName: task.branchName,
    changedFileCount: 0,
    commitCount: 0,
    conflictingFiles: [],
    hasCommittedChanges: false,
    hasUncommittedChanges: false,
    mainAheadCount: 0,
    overlapWarnings: [],
    projectId: task.projectId,
    state: 'unavailable',
    summary: 'Review data unavailable',
    taskId,
    totalAdded: 0,
    totalRemoved: 0,
    updatedAt: Date.now(),
    worktreePath: task.worktreePath,
  };
}

async function loadTaskConvergenceSnapshot(
  taskId: string,
): Promise<TaskConvergenceSnapshot | null> {
  const task = store.tasks[taskId];
  if (!task || task.closingStatus === 'removing') {
    return null;
  }

  try {
    const [projectDiff, worktreeStatus, mergeStatus, branchLog] = await Promise.all([
      invoke<ProjectDiffResult>(IPC.GetProjectDiff, {
        worktreePath: task.worktreePath,
        mode: 'branch',
      }),
      invoke<WorktreeStatus>(IPC.GetWorktreeStatus, {
        worktreePath: task.worktreePath,
      }),
      invoke<MergeStatus>(IPC.CheckMergeStatus, {
        worktreePath: task.worktreePath,
      }),
      invoke<string>(IPC.GetBranchLog, {
        worktreePath: task.worktreePath,
      }),
    ]);

    const reviewState = getReviewState(worktreeStatus, mergeStatus);
    const changedFileCount = projectDiff.files.length;
    const commitCount = countBranchCommits(branchLog);

    return {
      branchFiles: projectDiff.files.map((file) => file.path),
      branchName: task.branchName,
      changedFileCount,
      commitCount,
      conflictingFiles: mergeStatus.conflicting_files,
      hasCommittedChanges: worktreeStatus.has_committed_changes,
      hasUncommittedChanges: worktreeStatus.has_uncommitted_changes,
      mainAheadCount: mergeStatus.main_ahead_count,
      overlapWarnings: [],
      projectId: task.projectId,
      state: reviewState.state,
      summary:
        reviewState.state === 'review-ready'
          ? `${formatCount(commitCount, 'commit')}, ${formatCount(changedFileCount, 'file')} changed`
          : reviewState.summary,
      taskId,
      totalAdded: projectDiff.totalAdded,
      totalRemoved: projectDiff.totalRemoved,
      updatedAt: Date.now(),
      worktreePath: task.worktreePath,
    };
  } catch {
    return createUnavailableSnapshot(taskId);
  }
}

function setTaskConvergenceSnapshot(snapshot: TaskConvergenceSnapshot): void {
  setStore('taskConvergence', snapshot.taskId, snapshot);
}

function setTaskOverlapWarnings(taskId: string, overlapWarnings: TaskOverlapWarning[]): void {
  if (!store.taskConvergence[taskId]) {
    return;
  }

  setStore('taskConvergence', taskId, 'overlapWarnings', overlapWarnings);
}

function getSharedFiles(
  leftFiles: ReadonlyArray<string>,
  rightFiles: ReadonlyArray<string>,
): string[] {
  if (leftFiles.length === 0 || rightFiles.length === 0) {
    return [];
  }

  const rightSet = new Set(rightFiles);
  return leftFiles.filter((file) => rightSet.has(file));
}

function recomputeProjectOverlap(projectId: string): void {
  const snapshots = Object.values(store.taskConvergence)
    .filter((snapshot) => snapshot.projectId === projectId)
    .sort((left, right) => left.taskId.localeCompare(right.taskId));

  const warningsByTask = new Map<string, TaskOverlapWarning[]>();
  for (const snapshot of snapshots) {
    warningsByTask.set(snapshot.taskId, []);
  }

  for (let index = 0; index < snapshots.length; index += 1) {
    const left = snapshots[index];
    if (!left) {
      continue;
    }

    for (let innerIndex = index + 1; innerIndex < snapshots.length; innerIndex += 1) {
      const right = snapshots[innerIndex];
      if (!right) {
        continue;
      }

      const sharedFiles = getSharedFiles(left.branchFiles, right.branchFiles);
      if (sharedFiles.length === 0) {
        continue;
      }

      const leftTask = store.tasks[left.taskId];
      const rightTask = store.tasks[right.taskId];
      if (!leftTask || !rightTask) {
        continue;
      }

      warningsByTask.get(left.taskId)?.push({
        otherTaskId: right.taskId,
        otherTaskName: rightTask.name,
        sharedCount: sharedFiles.length,
        sharedFiles: sharedFiles.slice(0, 3),
      });
      warningsByTask.get(right.taskId)?.push({
        otherTaskId: left.taskId,
        otherTaskName: leftTask.name,
        sharedCount: sharedFiles.length,
        sharedFiles: sharedFiles.slice(0, 3),
      });
    }
  }

  for (const snapshot of snapshots) {
    const overlapWarnings = (warningsByTask.get(snapshot.taskId) ?? []).sort((left, right) => {
      if (left.sharedCount !== right.sharedCount) {
        return right.sharedCount - left.sharedCount;
      }

      return left.otherTaskName.localeCompare(right.otherTaskName);
    });
    setTaskOverlapWarnings(snapshot.taskId, overlapWarnings);
  }
}

async function refreshTaskConvergenceInternal(
  taskId: string,
  recomputeOverlap: boolean,
): Promise<void> {
  const snapshot = await loadTaskConvergenceSnapshot(taskId);
  const currentTask = store.tasks[taskId];

  if (!snapshot || !currentTask) {
    setStore('taskConvergence', (taskConvergence) => {
      const next = { ...taskConvergence };
      deleteRecordEntry(next, taskId);
      return next;
    });
    return;
  }

  if (
    currentTask.projectId !== snapshot.projectId ||
    currentTask.branchName !== snapshot.branchName ||
    currentTask.worktreePath !== snapshot.worktreePath
  ) {
    return;
  }

  setTaskConvergenceSnapshot(snapshot);
  if (recomputeOverlap) {
    recomputeProjectOverlap(snapshot.projectId);
  }
}

function getTaskRefreshPromise(taskId: string): Promise<void> | undefined {
  return inFlightRefreshes.get(taskId);
}

export function clearTaskConvergence(taskId: string): void {
  const snapshot = store.taskConvergence[taskId];
  if (!snapshot) {
    return;
  }

  setStore(
    produce((state) => {
      deleteRecordEntry(state.taskConvergence, taskId);
    }),
  );
  recomputeProjectOverlap(snapshot.projectId);
}

export async function refreshTaskConvergence(taskId: string): Promise<void> {
  const inFlight = getTaskRefreshPromise(taskId);
  if (inFlight) {
    await inFlight;
    return;
  }

  const promise = refreshTaskConvergenceInternal(taskId, true).finally(() => {
    if (inFlightRefreshes.get(taskId) === promise) {
      inFlightRefreshes.delete(taskId);
    }
  });
  inFlightRefreshes.set(taskId, promise);
  await promise;
}

export async function refreshProjectTaskConvergence(projectId: string): Promise<void> {
  const taskIds = Object.values(store.tasks)
    .filter((task) => task.projectId === projectId && task.closingStatus !== 'removing')
    .map((task) => task.id);

  await Promise.all(taskIds.map((taskId) => refreshTaskConvergence(taskId)));
  recomputeProjectOverlap(projectId);
}

export async function refreshAllTaskConvergence(): Promise<void> {
  const projectIds = new Set<string>();
  for (const task of Object.values(store.tasks)) {
    if (task.closingStatus === 'removing') {
      continue;
    }
    projectIds.add(task.projectId);
  }

  await Promise.all(
    Array.from(projectIds, (projectId) => refreshProjectTaskConvergence(projectId)),
  );
}

export function refreshTaskConvergenceFromGitStatusSync(taskIds: Iterable<string>): void {
  for (const taskId of taskIds) {
    void refreshTaskConvergence(taskId);
  }
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
