import { isTerminalTask } from '../domain/task-mode';
import { isNonGitProject } from '../store/project-mode';
import {
  getTaskWorktreeOwnership,
  isCurrentBranchTask,
  isExistingWorktreeTask,
} from '../store/task-git-isolation';
import type { Project, Task } from '../store/types';

export type TaskCloseLocation =
  | 'non-git'
  | 'project-root'
  | 'existing-worktree'
  | 'managed-worktree';

export interface TaskClosePolicy {
  location: TaskCloseLocation;
  runningProcessesLabel: 'agents and shells' | 'shells';
  willDeleteBranch: boolean;
}

export function getTaskClosePolicy(
  task: Task,
  project: Pick<Project, 'deleteBranchOnClose'> | null | undefined,
): TaskClosePolicy {
  const runningProcessesLabel = isTerminalTask(task) ? 'shells' : 'agents and shells';

  if (isNonGitProject(task)) {
    return {
      location: 'non-git',
      runningProcessesLabel,
      willDeleteBranch: false,
    };
  }

  if (isCurrentBranchTask(task)) {
    return {
      location: 'project-root',
      runningProcessesLabel,
      willDeleteBranch: false,
    };
  }

  if (isExistingWorktreeTask(task) || getTaskWorktreeOwnership(task) === 'external') {
    return {
      location: 'existing-worktree',
      runningProcessesLabel,
      willDeleteBranch: false,
    };
  }

  return {
    location: 'managed-worktree',
    runningProcessesLabel,
    willDeleteBranch: project?.deleteBranchOnClose ?? true,
  };
}

export function getEmergencyTaskCloseMessage(
  task: Task,
  project: Pick<Project, 'deleteBranchOnClose'> | null | undefined,
): string {
  const policy = getTaskClosePolicy(task, project);
  const processCopy = `Running ${policy.runningProcessesLabel} will be stopped.`;

  switch (policy.location) {
    case 'non-git':
    case 'project-root':
      return `Close this task? ${processCopy} No git operations will be performed.`;
    case 'existing-worktree':
      return `Close this task? ${processCopy} The existing worktree and branch will be kept.`;
    case 'managed-worktree':
      return policy.willDeleteBranch
        ? `Close this task? ${processCopy} The worktree and branch will be deleted.`
        : `Close this task? ${processCopy} The worktree will be removed and the branch will be kept.`;
  }
}

export function getProjectRemovalTaskCloseMessage(taskCount: number): string {
  const taskNoun = taskCount === 1 ? 'task' : 'tasks';
  const taskReference = taskCount === 1 ? 'it' : 'them';
  return `This project has ${taskCount} open ${taskNoun}. Removing the project will close ${taskReference}. Managed worktrees will be removed. Project-root folders and existing worktrees will be kept; managed branches will be deleted only when configured.`;
}
