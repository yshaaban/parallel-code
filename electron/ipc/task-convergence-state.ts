import {
  checkMergeStatus,
  getBranchLog,
  getProjectDiff,
  getWorktreeStatus,
  invalidateWorktreeStatusCache,
} from './git.js';
import { runQueuedRefresh } from './queued-refresh.js';
import type { MergeStatus } from '../../src/ipc/types.js';
import type { WorktreeStatus } from '../../src/domain/server-state.js';
import type {
  RemovedTaskConvergenceEvent,
  TaskConvergenceEvent,
  TaskConvergenceSnapshot,
  TaskOverlapWarning,
  TaskReviewState,
} from '../../src/domain/task-convergence.js';
import { parsePersistedTaskLookupState } from './persisted-task-lookup-state.js';

interface TaskConvergenceMetadata {
  branchName: string;
  projectId: string;
  projectRoot: string;
  taskId: string;
  taskName: string;
  worktreePath: string;
}

interface ReviewStateResult {
  state: TaskReviewState;
  summary: string;
}

type TaskConvergenceListener = (event: TaskConvergenceEvent) => void;

const taskMetadata = new Map<string, TaskConvergenceMetadata>();
const taskSnapshots = new Map<string, TaskConvergenceSnapshot>();
const taskConvergenceListeners = new Set<TaskConvergenceListener>();
const inFlightRefreshes = new Map<string, Promise<void>>();
const pendingRefreshes = new Set<string>();
let taskConvergenceStateVersion = 0;

function bumpTaskConvergenceStateVersion(): number {
  taskConvergenceStateVersion += 1;
  return taskConvergenceStateVersion;
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

function createRemovedTaskConvergenceEvent(taskId: string): RemovedTaskConvergenceEvent {
  return {
    removed: true,
    taskId,
  };
}

function emitTaskConvergenceEvent(event: TaskConvergenceEvent): void {
  bumpTaskConvergenceStateVersion();
  for (const listener of taskConvergenceListeners) {
    listener(event);
  }
}

function createUnavailableSnapshot(metadata: TaskConvergenceMetadata): TaskConvergenceSnapshot {
  return {
    branchFiles: [],
    branchName: metadata.branchName,
    changedFileCount: 0,
    commitCount: 0,
    conflictingFiles: [],
    hasCommittedChanges: false,
    hasUncommittedChanges: false,
    mainAheadCount: 0,
    overlapWarnings: [],
    projectId: metadata.projectId,
    state: 'unavailable',
    summary: 'Review data unavailable',
    taskId: metadata.taskId,
    totalAdded: 0,
    totalRemoved: 0,
    updatedAt: Date.now(),
    worktreePath: metadata.worktreePath,
  };
}

function areStringArraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function areOverlapWarningsEqual(
  left: ReadonlyArray<TaskOverlapWarning>,
  right: ReadonlyArray<TaskOverlapWarning>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftWarning = left[index];
    const rightWarning = right[index];
    if (!leftWarning || !rightWarning) {
      return false;
    }
    if (
      leftWarning.otherTaskId !== rightWarning.otherTaskId ||
      leftWarning.otherTaskName !== rightWarning.otherTaskName ||
      leftWarning.sharedCount !== rightWarning.sharedCount ||
      !areStringArraysEqual(leftWarning.sharedFiles, rightWarning.sharedFiles)
    ) {
      return false;
    }
  }

  return true;
}

function areSnapshotsEqual(
  left: TaskConvergenceSnapshot | undefined,
  right: TaskConvergenceSnapshot,
): boolean {
  if (!left) {
    return false;
  }

  return (
    left.taskId === right.taskId &&
    left.projectId === right.projectId &&
    left.branchName === right.branchName &&
    left.worktreePath === right.worktreePath &&
    left.state === right.state &&
    left.summary === right.summary &&
    left.changedFileCount === right.changedFileCount &&
    left.commitCount === right.commitCount &&
    left.totalAdded === right.totalAdded &&
    left.totalRemoved === right.totalRemoved &&
    left.mainAheadCount === right.mainAheadCount &&
    left.hasCommittedChanges === right.hasCommittedChanges &&
    left.hasUncommittedChanges === right.hasUncommittedChanges &&
    areStringArraysEqual(left.branchFiles, right.branchFiles) &&
    areStringArraysEqual(left.conflictingFiles, right.conflictingFiles) &&
    areOverlapWarningsEqual(left.overlapWarnings, right.overlapWarnings)
  );
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

function setTaskConvergenceSnapshot(snapshot: TaskConvergenceSnapshot): void {
  const current = taskSnapshots.get(snapshot.taskId);
  if (areSnapshotsEqual(current, snapshot)) {
    return;
  }

  const nextSnapshot: TaskConvergenceSnapshot = {
    ...snapshot,
    updatedAt: Date.now(),
  };
  taskSnapshots.set(nextSnapshot.taskId, nextSnapshot);
  emitTaskConvergenceEvent(nextSnapshot);
}

function recomputeProjectOverlap(projectId: string): void {
  const snapshots = Array.from(taskSnapshots.values())
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

      const leftTask = taskMetadata.get(left.taskId);
      const rightTask = taskMetadata.get(right.taskId);
      if (!leftTask || !rightTask) {
        continue;
      }

      warningsByTask.get(left.taskId)?.push({
        otherTaskId: right.taskId,
        otherTaskName: rightTask.taskName,
        sharedCount: sharedFiles.length,
        sharedFiles: sharedFiles.slice(0, 3),
      });
      warningsByTask.get(right.taskId)?.push({
        otherTaskId: left.taskId,
        otherTaskName: leftTask.taskName,
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

    setTaskConvergenceSnapshot({
      ...snapshot,
      overlapWarnings,
      updatedAt: snapshot.updatedAt,
    });
  }
}

async function loadTaskConvergenceSnapshot(
  metadata: TaskConvergenceMetadata,
): Promise<TaskConvergenceSnapshot> {
  invalidateWorktreeStatusCache(metadata.worktreePath);

  try {
    const [projectDiff, worktreeStatus, mergeStatus, branchLog] = await Promise.all([
      getProjectDiff(metadata.worktreePath, 'branch'),
      getWorktreeStatus(metadata.worktreePath),
      checkMergeStatus(metadata.worktreePath),
      getBranchLog(metadata.worktreePath),
    ]);

    const reviewState = getReviewState(worktreeStatus, mergeStatus);
    const changedFileCount = projectDiff.files.length;
    const commitCount = countBranchCommits(branchLog);

    return {
      branchFiles: projectDiff.files.map((file) => file.path),
      branchName: metadata.branchName,
      changedFileCount,
      commitCount,
      conflictingFiles: mergeStatus.conflicting_files,
      hasCommittedChanges: worktreeStatus.has_committed_changes,
      hasUncommittedChanges: worktreeStatus.has_uncommitted_changes,
      mainAheadCount: mergeStatus.main_ahead_count,
      overlapWarnings: [],
      projectId: metadata.projectId,
      state: reviewState.state,
      summary:
        reviewState.state === 'review-ready'
          ? `${formatCount(commitCount, 'commit')}, ${formatCount(changedFileCount, 'file')} changed`
          : reviewState.summary,
      taskId: metadata.taskId,
      totalAdded: projectDiff.totalAdded,
      totalRemoved: projectDiff.totalRemoved,
      updatedAt: Date.now(),
      worktreePath: metadata.worktreePath,
    };
  } catch {
    return createUnavailableSnapshot(metadata);
  }
}

async function refreshTaskConvergenceInternal(
  taskId: string,
  recomputeOverlap: boolean,
): Promise<void> {
  const metadata = taskMetadata.get(taskId);
  if (!metadata) {
    return;
  }

  const snapshot = await loadTaskConvergenceSnapshot(metadata);
  const currentMetadata = taskMetadata.get(taskId);
  if (!currentMetadata) {
    return;
  }

  if (
    currentMetadata.projectId !== snapshot.projectId ||
    currentMetadata.branchName !== snapshot.branchName ||
    currentMetadata.worktreePath !== snapshot.worktreePath
  ) {
    return;
  }

  setTaskConvergenceSnapshot(snapshot);
  if (recomputeOverlap) {
    recomputeProjectOverlap(snapshot.projectId);
  }
}

function removeTaskConvergenceSnapshot(taskId: string): void {
  if (!taskSnapshots.delete(taskId)) {
    return;
  }

  emitTaskConvergenceEvent(createRemovedTaskConvergenceEvent(taskId));
}

function collectTaskMetadataFromSavedState(savedJson: string): TaskConvergenceMetadata[] {
  const parsed = parsePersistedTaskLookupState(savedJson);
  const projectsById = new Map<string, string>();
  for (const project of parsed.projects) {
    if (!project.id || !project.path) {
      continue;
    }

    projectsById.set(project.id, project.path);
  }

  const metadata: TaskConvergenceMetadata[] = [];
  for (const task of Object.values(parsed.tasks)) {
    if (!task.id || !task.name || !task.projectId || !task.branchName || !task.worktreePath) {
      continue;
    }

    const projectRoot = projectsById.get(task.projectId);
    if (!projectRoot) {
      continue;
    }

    metadata.push({
      branchName: task.branchName,
      projectId: task.projectId,
      projectRoot,
      taskId: task.id,
      taskName: task.name,
      worktreePath: task.worktreePath,
    });
  }

  return metadata;
}

export function subscribeTaskConvergence(listener: TaskConvergenceListener): () => void {
  taskConvergenceListeners.add(listener);
  return () => {
    taskConvergenceListeners.delete(listener);
  };
}

export function listTaskConvergenceSnapshots(): TaskConvergenceSnapshot[] {
  return Array.from(taskSnapshots.values()).sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  );
}

export function getTaskConvergenceStateVersion(): number {
  return taskConvergenceStateVersion;
}

export function getTaskConvergenceSnapshots(): TaskConvergenceSnapshot[] {
  return listTaskConvergenceSnapshots();
}

export function getTaskConvergenceSnapshot(taskId: string): TaskConvergenceSnapshot | undefined {
  return taskSnapshots.get(taskId);
}

export function registerTaskConvergenceTask(metadata: TaskConvergenceMetadata): void {
  const previous = taskMetadata.get(metadata.taskId);
  taskMetadata.set(metadata.taskId, metadata);

  if (!previous) {
    return;
  }

  const metadataChanged =
    previous.projectId !== metadata.projectId ||
    previous.projectRoot !== metadata.projectRoot ||
    previous.branchName !== metadata.branchName ||
    previous.worktreePath !== metadata.worktreePath;
  const nameChanged = previous.taskName !== metadata.taskName;

  if (metadataChanged) {
    removeTaskConvergenceSnapshot(metadata.taskId);
    recomputeProjectOverlap(previous.projectId);
    void refreshTaskConvergence(metadata.taskId);
    return;
  }

  if (nameChanged) {
    recomputeProjectOverlap(metadata.projectId);
  }
}

export function syncTaskConvergenceFromSavedState(savedJson: string): void {
  const nextMetadata = collectTaskMetadataFromSavedState(savedJson);
  const nextTaskIds = new Set(nextMetadata.map((metadata) => metadata.taskId));

  for (const [taskId, metadata] of taskMetadata) {
    if (nextTaskIds.has(taskId)) {
      continue;
    }

    taskMetadata.delete(taskId);
    removeTaskConvergenceSnapshot(taskId);
    recomputeProjectOverlap(metadata.projectId);
  }

  for (const metadata of nextMetadata) {
    registerTaskConvergenceTask(metadata);
  }
}

export function restoreSavedTaskConvergence(savedJson: string): void {
  syncTaskConvergenceFromSavedState(savedJson);

  for (const metadata of collectTaskMetadataFromSavedState(savedJson)) {
    void refreshTaskConvergence(metadata.taskId);
  }
}

export function removeTaskConvergence(taskId: string): void {
  const metadata = taskMetadata.get(taskId);
  taskMetadata.delete(taskId);
  removeTaskConvergenceSnapshot(taskId);
  if (metadata) {
    recomputeProjectOverlap(metadata.projectId);
  }
}

export async function refreshTaskConvergence(taskId: string): Promise<void> {
  await runQueuedRefresh(taskId, inFlightRefreshes, pendingRefreshes, () =>
    refreshTaskConvergenceInternal(taskId, true),
  );
}

export function scheduleTaskConvergenceRefresh(taskId: string): void {
  void refreshTaskConvergence(taskId);
}

export function scheduleTaskConvergenceRefreshForWorktree(worktreePath: string): void {
  for (const metadata of taskMetadata.values()) {
    if (metadata.worktreePath !== worktreePath) {
      continue;
    }

    scheduleTaskConvergenceRefresh(metadata.taskId);
  }
}

export function scheduleTaskConvergenceRefreshForBranch(
  projectRoot: string,
  branchName: string,
): void {
  for (const metadata of taskMetadata.values()) {
    if (metadata.projectRoot !== projectRoot || metadata.branchName !== branchName) {
      continue;
    }

    scheduleTaskConvergenceRefresh(metadata.taskId);
  }
}

export function scheduleProjectTaskConvergenceRefresh(projectRoot: string): void {
  for (const metadata of taskMetadata.values()) {
    if (metadata.projectRoot !== projectRoot) {
      continue;
    }

    scheduleTaskConvergenceRefresh(metadata.taskId);
  }
}

export function clearTaskConvergenceRegistry(): void {
  taskMetadata.clear();
  taskSnapshots.clear();
  inFlightRefreshes.clear();
  pendingRefreshes.clear();
}
