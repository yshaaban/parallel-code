import type { WorktreeStatus } from '../ipc/types';
import { applyGitStatusFromPush } from '../store/taskStatus';
import { getProjectPath, refreshTaskStatus, store } from '../store/store';

export interface GitStatusSyncEvent {
  branchName?: string;
  projectRoot?: string;
  status?: WorktreeStatus;
  worktreePath?: string;
}

export function refreshGitStatusFromServerEvent(message: GitStatusSyncEvent): void {
  const seen = new Set<string>();
  for (const task of Object.values(store.tasks)) {
    if (seen.has(task.id)) continue;

    const matchesWorktree =
      typeof message.worktreePath === 'string' && task.worktreePath === message.worktreePath;
    const matchesBranch =
      typeof message.branchName === 'string' &&
      task.branchName === message.branchName &&
      (message.projectRoot === undefined || getProjectPath(task.projectId) === message.projectRoot);
    const matchesProject =
      typeof message.projectRoot === 'string' &&
      getProjectPath(task.projectId) === message.projectRoot;

    if (matchesWorktree || matchesBranch || matchesProject) {
      seen.add(task.id);
      refreshTaskStatus(task.id);
    }
  }
}

export function handleGitStatusSyncEvent(message: GitStatusSyncEvent): void {
  if (message.worktreePath && message.status) {
    applyGitStatusFromPush(message.worktreePath, message.status);
    return;
  }

  refreshGitStatusFromServerEvent(message);
}
