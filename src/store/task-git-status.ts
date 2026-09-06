import { IPC } from '../../electron/ipc/channels';
import {
  classifyGitStatusSyncEvent,
  type GitStatusSyncEvent,
  type GitStatusSyncSnapshotEvent,
  type WorktreeStatus,
} from '../domain/server-state';
import { assertNever } from '../lib/assert-never';
import { invoke } from '../lib/ipc';
import { getProjectPath } from './projects';
import {
  createServerStateVersionTracker,
  getServerStatePayloadVersion,
  noteServerStateEventVersion,
  noteServerStateReplacement,
  resetServerStateVersionTracker,
  shouldApplyServerStateEventVersion,
  shouldApplyServerStateReplacement,
} from './server-state-versioning';
import { setStore, store } from './state';

export interface GitStatusSyncTarget {
  branchName?: string | null;
  projectRoot?: string;
  worktreePath?: string;
}

const recentTaskGitStatusPollAt = new Map<string, number>();
const gitStatusVersionTracker = createServerStateVersionTracker();

export function getGitStatusHighestAppliedVersion(): number {
  return gitStatusVersionTracker.highestVersion;
}
const gitStatusRefreshGenerationByTaskId = new Map<string, number>();
const GENERIC_GIT_STATUS_ERROR = 'Unable to verify current git status.';

function normalizeWorktreePath(worktreePath: string): string {
  return worktreePath.replace(/\/+$/, '');
}

export function gitStatusEventMatchesTarget(
  message: GitStatusSyncEvent,
  target: GitStatusSyncTarget,
): boolean {
  const matchesWorktree =
    typeof message.worktreePath === 'string' && message.worktreePath === target.worktreePath;
  const matchesBranch =
    typeof message.branchName === 'string' &&
    typeof target.branchName === 'string' &&
    message.branchName === target.branchName &&
    (message.projectRoot === undefined || message.projectRoot === target.projectRoot);
  const matchesProject =
    typeof message.projectRoot === 'string' && message.projectRoot === target.projectRoot;

  return matchesWorktree || matchesBranch || matchesProject;
}

function collectMatchingTaskIds(message: GitStatusSyncEvent): Set<string> {
  const seen = new Set<string>();
  for (const task of Object.values(store.tasks)) {
    if (seen.has(task.id)) {
      continue;
    }

    const projectRoot = getProjectPath(task.projectId);
    if (
      !gitStatusEventMatchesTarget(message, {
        worktreePath: task.worktreePath,
        branchName: task.branchName,
        ...(projectRoot ? { projectRoot } : {}),
      })
    ) {
      continue;
    }

    seen.add(task.id);
  }

  return seen;
}

export function getRecentTaskGitStatusPollAge(worktreePath: string): number | null {
  if (!worktreePath) {
    return null;
  }

  const normalizedPath = normalizeWorktreePath(worktreePath);
  const polledAt = recentTaskGitStatusPollAt.get(normalizedPath);
  if (polledAt === undefined) {
    return null;
  }

  return Date.now() - polledAt;
}

export function clearRecentTaskGitStatusPollAge(worktreePath: string): void {
  if (!worktreePath) {
    return;
  }

  recentTaskGitStatusPollAt.delete(normalizeWorktreePath(worktreePath));
}

// Per-boot version tracking is reset when the server instance changes; see
// resetServerStateVersionTrackingForInstanceChange.
export function resetGitStatusVersionTracking(): void {
  resetServerStateVersionTracker(gitStatusVersionTracker);
}

export function resetTaskGitStatusRuntimeState(): void {
  recentTaskGitStatusPollAt.clear();
  gitStatusRefreshGenerationByTaskId.clear();
  resetGitStatusVersionTracking();
}

export function getTaskGitStatus(taskId: string): WorktreeStatus | undefined {
  return store.taskGitStatus[taskId];
}

export function isTaskGitStatusFresh(status: WorktreeStatus | undefined): boolean {
  return status !== undefined && status.freshness !== 'stale';
}

function createFreshWorktreeStatus(status: WorktreeStatus, updatedAt: number): WorktreeStatus {
  return {
    ...status,
    errorMessage: null,
    freshness: 'fresh',
    updatedAt,
  };
}

function getGitStatusRefreshErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return GENERIC_GIT_STATUS_ERROR;
}

function createStaleWorktreeStatus(
  previousStatus: WorktreeStatus | undefined,
  error: unknown,
): WorktreeStatus {
  const staleStatus: WorktreeStatus = {
    has_committed_changes: previousStatus?.has_committed_changes ?? false,
    has_uncommitted_changes: previousStatus?.has_uncommitted_changes ?? false,
    errorMessage: getGitStatusRefreshErrorMessage(error),
    freshness: 'stale',
  };

  if (previousStatus?.updatedAt !== undefined) {
    staleStatus.updatedAt = previousStatus.updatedAt;
  }

  return staleStatus;
}

export async function refreshTaskGitStatusForTask(taskId: string): Promise<boolean> {
  const task = store.tasks[taskId];
  if (!task) {
    return false;
  }

  const refreshGeneration = (gitStatusRefreshGenerationByTaskId.get(taskId) ?? 0) + 1;
  gitStatusRefreshGenerationByTaskId.set(taskId, refreshGeneration);
  // A pending replacement is not verification of the cached observation. Keep its facts for
  // display, but let every consumer use the same fail-closed freshness until a response or push.
  setStore('taskGitStatus', taskId, (previousStatus) =>
    createStaleWorktreeStatus(previousStatus, previousStatus?.errorMessage),
  );

  try {
    const status = await invoke(IPC.GetWorktreeStatus, {
      worktreePath: task.worktreePath,
      ...(task.baseBranch !== undefined ? { baseBranch: task.baseBranch } : {}),
    });
    if (gitStatusRefreshGenerationByTaskId.get(taskId) !== refreshGeneration) {
      return isTaskGitStatusFresh(getTaskGitStatus(taskId));
    }

    const refreshedAt = Date.now();
    recentTaskGitStatusPollAt.set(normalizeWorktreePath(task.worktreePath), refreshedAt);
    setStore('taskGitStatus', taskId, createFreshWorktreeStatus(status, refreshedAt));
    return true;
  } catch (error) {
    // Worktree may not exist yet or was removed.
    if (gitStatusRefreshGenerationByTaskId.get(taskId) !== refreshGeneration) {
      return isTaskGitStatusFresh(getTaskGitStatus(taskId));
    }

    setStore(
      'taskGitStatus',
      taskId,
      createStaleWorktreeStatus(store.taskGitStatus[taskId], error),
    );
    return false;
  }
}

function applyGitStatusPush(
  worktreePath: string,
  status: GitStatusSyncSnapshotEvent['status'],
  stateVersion: number | undefined,
): void {
  if (!shouldApplyServerStateEventVersion(gitStatusVersionTracker, worktreePath, stateVersion)) {
    return;
  }

  const refreshedAt = Date.now();
  const freshStatus = createFreshWorktreeStatus(status, refreshedAt);
  recentTaskGitStatusPollAt.set(normalizeWorktreePath(worktreePath), refreshedAt);

  for (const task of Object.values(store.tasks)) {
    if (task.worktreePath !== worktreePath) {
      continue;
    }

    gitStatusRefreshGenerationByTaskId.set(
      task.id,
      (gitStatusRefreshGenerationByTaskId.get(task.id) ?? 0) + 1,
    );
    setStore('taskGitStatus', task.id, freshStatus);
  }
  noteServerStateEventVersion(gitStatusVersionTracker, worktreePath, stateVersion);
}

export function refreshGitStatusFromServerEvent(message: GitStatusSyncEvent): void {
  const matchingTaskIds = collectMatchingTaskIds(message);
  for (const taskId of matchingTaskIds) {
    void refreshTaskGitStatusForTask(taskId);
  }
}

export function handleGitStatusSyncEvent(message: GitStatusSyncEvent): void {
  const classification = classifyGitStatusSyncEvent(message);
  switch (classification.kind) {
    case 'snapshot':
      applyGitStatusPush(
        classification.event.worktreePath,
        classification.event.status,
        getServerStatePayloadVersion(classification.event),
      );
      return;
    case 'refresh':
      refreshGitStatusFromServerEvent(classification.event);
      return;
    default:
      assertNever(classification, 'Unhandled git status sync event kind');
  }
}

export function replaceGitStatusSnapshots(
  snapshots: ReadonlyArray<GitStatusSyncSnapshotEvent>,
  options: { replaceVersion?: number } = {},
): void {
  if (!shouldApplyServerStateReplacement(gitStatusVersionTracker, options.replaceVersion)) {
    return;
  }

  const refreshedAt = Date.now();
  const statusByWorktreePath = new Map<string, GitStatusSyncSnapshotEvent['status']>();
  for (const snapshot of snapshots) {
    statusByWorktreePath.set(snapshot.worktreePath, snapshot.status);
    recentTaskGitStatusPollAt.set(normalizeWorktreePath(snapshot.worktreePath), refreshedAt);
  }

  setStore('taskGitStatus', () => {
    const next: typeof store.taskGitStatus = {};
    for (const task of Object.values(store.tasks)) {
      gitStatusRefreshGenerationByTaskId.set(
        task.id,
        (gitStatusRefreshGenerationByTaskId.get(task.id) ?? 0) + 1,
      );
      const status = statusByWorktreePath.get(task.worktreePath);
      if (status) {
        next[task.id] = createFreshWorktreeStatus(status, refreshedAt);
      }
    }
    return next;
  });
  noteServerStateReplacement(
    gitStatusVersionTracker,
    snapshots.map((snapshot) => snapshot.worktreePath),
    options.replaceVersion,
  );
}
