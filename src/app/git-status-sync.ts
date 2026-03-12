import type { GitStatusSyncEvent } from '../domain/server-state';
import { refreshTaskConvergenceFromGitStatusSync } from './task-convergence';
import { applyGitStatusFromPush } from '../store/taskStatus';
import { getProjectPath, refreshTaskStatus, store } from '../store/store';

export interface GitStatusSyncTarget {
  branchName?: string | null;
  projectRoot?: string;
  taskId?: string;
  worktreePath?: string;
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
    if (seen.has(task.id)) continue;
    const projectRoot = getProjectPath(task.projectId);

    if (
      gitStatusEventMatchesTarget(message, {
        taskId: task.id,
        worktreePath: task.worktreePath,
        branchName: task.branchName,
        ...(projectRoot ? { projectRoot } : {}),
      })
    ) {
      seen.add(task.id);
    }
  }

  return seen;
}

export function refreshGitStatusFromServerEvent(message: GitStatusSyncEvent): void {
  const seen = collectMatchingTaskIds(message);
  for (const taskId of seen) {
    refreshTaskStatus(taskId);
  }

  refreshTaskConvergenceFromGitStatusSync(seen);
}

export function handleGitStatusSyncEvent(message: GitStatusSyncEvent): void {
  if (message.worktreePath && message.status) {
    applyGitStatusFromPush(message.worktreePath, message.status);
    refreshTaskConvergenceFromGitStatusSync(collectMatchingTaskIds(message));
    return;
  }

  refreshGitStatusFromServerEvent(message);
}
