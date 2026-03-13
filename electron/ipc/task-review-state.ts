import { getChangedFilesFromBranch, getProjectDiff } from './git.js';
import type { ChangedFile } from '../../src/ipc/types.js';
import type {
  RemovedTaskReviewEvent,
  TaskReviewEvent,
  TaskReviewSnapshot,
  TaskReviewSource,
} from '../../src/domain/task-review.js';

interface TaskReviewMetadata {
  branchName: string;
  projectId: string;
  projectRoot: string;
  taskId: string;
  worktreePath: string;
}

interface SavedProjectState {
  id?: string;
  path?: string;
}

interface SavedTaskState {
  branchName?: string;
  id?: string;
  name?: string;
  projectId?: string;
  worktreePath?: string;
}

interface SavedTaskStoreState {
  projects?: SavedProjectState[];
  tasks?: Record<string, SavedTaskState>;
}

type TaskReviewListener = (event: TaskReviewEvent) => void;

const taskReviewMetadata = new Map<string, TaskReviewMetadata>();
const taskReviewSnapshots = new Map<string, TaskReviewSnapshot>();
const taskReviewListeners = new Set<TaskReviewListener>();
const inFlightRefreshes = new Map<string, Promise<void>>();
let taskReviewStateVersion = 0;

function bumpTaskReviewStateVersion(): number {
  taskReviewStateVersion += 1;
  return taskReviewStateVersion;
}

function emitTaskReviewEvent(event: TaskReviewEvent): void {
  bumpTaskReviewStateVersion();
  for (const listener of taskReviewListeners) {
    listener(event);
  }
}

function createRemovedTaskReviewEvent(taskId: string): RemovedTaskReviewEvent {
  return {
    removed: true,
    taskId,
  };
}

function summarizeChangedFiles(files: ReadonlyArray<ChangedFile>): {
  totalAdded: number;
  totalRemoved: number;
} {
  return {
    totalAdded: files.reduce((sum, file) => sum + file.lines_added, 0),
    totalRemoved: files.reduce((sum, file) => sum + file.lines_removed, 0),
  };
}

function createTaskReviewRevisionId(
  source: TaskReviewSource,
  worktreePath: string,
  branchName: string,
  files: ReadonlyArray<ChangedFile>,
  totals: { totalAdded: number; totalRemoved: number },
): string {
  const fileIdentity = files
    .map(
      (file) =>
        `${file.path}:${file.status}:${file.committed ? '1' : '0'}:${file.lines_added}:${file.lines_removed}`,
    )
    .join('|');

  return [
    source,
    worktreePath,
    branchName,
    `${totals.totalAdded}`,
    `${totals.totalRemoved}`,
    fileIdentity,
  ].join('::');
}

function createTaskReviewSnapshot(
  metadata: TaskReviewMetadata,
  files: ChangedFile[],
  source: TaskReviewSource,
): TaskReviewSnapshot {
  const totals = summarizeChangedFiles(files);
  return {
    branchName: metadata.branchName,
    files,
    projectId: metadata.projectId,
    revisionId: createTaskReviewRevisionId(
      source,
      metadata.worktreePath,
      metadata.branchName,
      files,
      totals,
    ),
    source,
    taskId: metadata.taskId,
    totalAdded: totals.totalAdded,
    totalRemoved: totals.totalRemoved,
    updatedAt: Date.now(),
    worktreePath: metadata.worktreePath,
  };
}

function createUnavailableTaskReviewSnapshot(metadata: TaskReviewMetadata): TaskReviewSnapshot {
  return createTaskReviewSnapshot(metadata, [], 'unavailable');
}

function areChangedFilesEqual(
  left: ReadonlyArray<ChangedFile>,
  right: ReadonlyArray<ChangedFile>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftFile = left[index];
    const rightFile = right[index];
    if (
      !leftFile ||
      !rightFile ||
      leftFile.path !== rightFile.path ||
      leftFile.status !== rightFile.status ||
      leftFile.committed !== rightFile.committed ||
      leftFile.lines_added !== rightFile.lines_added ||
      leftFile.lines_removed !== rightFile.lines_removed
    ) {
      return false;
    }
  }

  return true;
}

function areTaskReviewSnapshotsEqual(
  left: TaskReviewSnapshot | undefined,
  right: TaskReviewSnapshot,
): boolean {
  if (!left) {
    return false;
  }

  return (
    left.taskId === right.taskId &&
    left.projectId === right.projectId &&
    left.worktreePath === right.worktreePath &&
    left.branchName === right.branchName &&
    left.source === right.source &&
    left.revisionId === right.revisionId &&
    left.totalAdded === right.totalAdded &&
    left.totalRemoved === right.totalRemoved &&
    areChangedFilesEqual(left.files, right.files)
  );
}

function setTaskReviewSnapshot(snapshot: TaskReviewSnapshot): void {
  const current = taskReviewSnapshots.get(snapshot.taskId);
  if (areTaskReviewSnapshotsEqual(current, snapshot)) {
    return;
  }

  const nextSnapshot: TaskReviewSnapshot = {
    ...snapshot,
    updatedAt: Date.now(),
  };
  taskReviewSnapshots.set(nextSnapshot.taskId, nextSnapshot);
  emitTaskReviewEvent(nextSnapshot);
}

async function loadTaskReviewSnapshot(metadata: TaskReviewMetadata): Promise<TaskReviewSnapshot> {
  try {
    const projectDiff = await getProjectDiff(metadata.worktreePath, 'all');
    return createTaskReviewSnapshot(metadata, projectDiff.files, 'worktree');
  } catch {
    try {
      const files = await getChangedFilesFromBranch(metadata.projectRoot, metadata.branchName);
      return createTaskReviewSnapshot(metadata, files, 'branch-fallback');
    } catch {
      return createUnavailableTaskReviewSnapshot(metadata);
    }
  }
}

async function refreshTaskReviewInternal(taskId: string): Promise<void> {
  const metadata = taskReviewMetadata.get(taskId);
  if (!metadata) {
    return;
  }

  const snapshot = await loadTaskReviewSnapshot(metadata);
  const currentMetadata = taskReviewMetadata.get(taskId);
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

  setTaskReviewSnapshot(snapshot);
}

function getTaskRefreshPromise(taskId: string): Promise<void> | undefined {
  return inFlightRefreshes.get(taskId);
}

function removeTaskReviewSnapshot(taskId: string): void {
  if (!taskReviewSnapshots.delete(taskId)) {
    return;
  }

  emitTaskReviewEvent(createRemovedTaskReviewEvent(taskId));
}

function collectTaskReviewMetadataFromSavedState(savedJson: string): TaskReviewMetadata[] {
  try {
    const parsed = JSON.parse(savedJson) as SavedTaskStoreState;
    const projectsById = new Map<string, string>();

    for (const project of parsed.projects ?? []) {
      if (!project.id || !project.path) {
        continue;
      }

      projectsById.set(project.id, project.path);
    }

    const metadata: TaskReviewMetadata[] = [];
    for (const task of Object.values(parsed.tasks ?? {})) {
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
        worktreePath: task.worktreePath,
      });
    }

    return metadata;
  } catch {
    return [];
  }
}

export function subscribeTaskReview(listener: TaskReviewListener): () => void {
  taskReviewListeners.add(listener);
  return () => {
    taskReviewListeners.delete(listener);
  };
}

export function listTaskReviewSnapshots(): TaskReviewSnapshot[] {
  return Array.from(taskReviewSnapshots.values()).sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  );
}

export function getTaskReviewStateVersion(): number {
  return taskReviewStateVersion;
}

export function getTaskReviewSnapshot(taskId: string): TaskReviewSnapshot | undefined {
  return taskReviewSnapshots.get(taskId);
}

export function registerTaskReviewTask(metadata: TaskReviewMetadata): void {
  const previous = taskReviewMetadata.get(metadata.taskId);
  taskReviewMetadata.set(metadata.taskId, metadata);

  if (!previous) {
    return;
  }

  const metadataChanged =
    previous.projectId !== metadata.projectId ||
    previous.projectRoot !== metadata.projectRoot ||
    previous.branchName !== metadata.branchName ||
    previous.worktreePath !== metadata.worktreePath;

  if (metadataChanged) {
    removeTaskReviewSnapshot(metadata.taskId);
    void refreshTaskReview(metadata.taskId);
  }
}

export function syncTaskReviewFromSavedState(savedJson: string): void {
  const nextMetadata = collectTaskReviewMetadataFromSavedState(savedJson);
  const nextTaskIds = new Set(nextMetadata.map((metadata) => metadata.taskId));

  for (const taskId of taskReviewMetadata.keys()) {
    if (nextTaskIds.has(taskId)) {
      continue;
    }

    taskReviewMetadata.delete(taskId);
    removeTaskReviewSnapshot(taskId);
  }

  for (const metadata of nextMetadata) {
    registerTaskReviewTask(metadata);
  }
}

export function restoreSavedTaskReview(savedJson: string): void {
  syncTaskReviewFromSavedState(savedJson);

  for (const metadata of collectTaskReviewMetadataFromSavedState(savedJson)) {
    void refreshTaskReview(metadata.taskId);
  }
}

export function removeTaskReview(taskId: string): void {
  taskReviewMetadata.delete(taskId);
  removeTaskReviewSnapshot(taskId);
}

export async function refreshTaskReview(taskId: string): Promise<void> {
  const inFlight = getTaskRefreshPromise(taskId);
  if (inFlight) {
    await inFlight;
    return;
  }

  const promise = refreshTaskReviewInternal(taskId).finally(() => {
    if (inFlightRefreshes.get(taskId) === promise) {
      inFlightRefreshes.delete(taskId);
    }
  });
  inFlightRefreshes.set(taskId, promise);
  await promise;
}

export function scheduleTaskReviewRefresh(taskId: string): void {
  void refreshTaskReview(taskId);
}

export function scheduleTaskReviewRefreshForWorktree(worktreePath: string): void {
  for (const metadata of taskReviewMetadata.values()) {
    if (metadata.worktreePath !== worktreePath) {
      continue;
    }

    scheduleTaskReviewRefresh(metadata.taskId);
  }
}

export function scheduleTaskReviewRefreshForBranch(projectRoot: string, branchName: string): void {
  for (const metadata of taskReviewMetadata.values()) {
    if (metadata.projectRoot !== projectRoot || metadata.branchName !== branchName) {
      continue;
    }

    scheduleTaskReviewRefresh(metadata.taskId);
  }
}

export function scheduleProjectTaskReviewRefresh(projectRoot: string): void {
  for (const metadata of taskReviewMetadata.values()) {
    if (metadata.projectRoot !== projectRoot) {
      continue;
    }

    scheduleTaskReviewRefresh(metadata.taskId);
  }
}

export function clearTaskReviewRegistry(): void {
  taskReviewMetadata.clear();
  taskReviewSnapshots.clear();
  inFlightRefreshes.clear();
}
