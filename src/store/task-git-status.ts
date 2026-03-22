import { IPC } from '../../electron/ipc/channels';
import {
  classifyGitStatusSyncEvent,
  type GitStatusSyncEvent,
  type GitStatusSyncSnapshotEvent,
} from '../domain/server-state';
import { invoke } from '../lib/ipc';
import { getProjectPath } from './projects';
import { setStore, store } from './state';
import { assertNever } from '../lib/assert-never';

export interface GitStatusSyncTarget {
  branchName?: string | null;
  projectRoot?: string;
  worktreePath?: string;
}

const recentTaskGitStatusPollAt = new Map<string, number>();

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

export function resetTaskGitStatusRuntimeState(): void {
  recentTaskGitStatusPollAt.clear();
}

async function refreshTaskGitStatus(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) {
    return;
  }

  try {
    const status = await invoke(IPC.GetWorktreeStatus, {
      worktreePath: task.worktreePath,
    });
    recentTaskGitStatusPollAt.set(normalizeWorktreePath(task.worktreePath), Date.now());
    setStore('taskGitStatus', taskId, status);
  } catch {
    // Worktree may not exist yet or was removed.
  }
}

function applyGitStatusPush(
  worktreePath: string,
  status: GitStatusSyncSnapshotEvent['status'],
): void {
  recentTaskGitStatusPollAt.set(normalizeWorktreePath(worktreePath), Date.now());

  for (const task of Object.values(store.tasks)) {
    if (task.worktreePath !== worktreePath) {
      continue;
    }

    setStore('taskGitStatus', task.id, status);
  }
}

export function refreshGitStatusFromServerEvent(message: GitStatusSyncEvent): void {
  const matchingTaskIds = collectMatchingTaskIds(message);
  for (const taskId of matchingTaskIds) {
    void refreshTaskGitStatus(taskId);
  }
}

export function handleGitStatusSyncEvent(message: GitStatusSyncEvent): void {
  const classification = classifyGitStatusSyncEvent(message);
  switch (classification.kind) {
    case 'snapshot':
      applyGitStatusPush(classification.event.worktreePath, classification.event.status);
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
): void {
  const statusByWorktreePath = new Map<string, GitStatusSyncSnapshotEvent['status']>();
  for (const snapshot of snapshots) {
    statusByWorktreePath.set(snapshot.worktreePath, snapshot.status);
  }

  setStore('taskGitStatus', () => {
    const next: typeof store.taskGitStatus = {};
    for (const task of Object.values(store.tasks)) {
      const status = statusByWorktreePath.get(task.worktreePath);
      if (status) {
        next[task.id] = status;
      }
    }
    return next;
  });
}
