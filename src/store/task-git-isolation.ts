import { normalizeBaseBranch } from '../lib/base-branch.js';
import type {
  DefaultTaskGitIsolationMode,
  Project,
  Task,
  TaskGitIsolationMode,
  WorktreeOwnership,
} from './types.js';
import { isNonGitProject } from './project-mode.js';

type ProjectGitIsolationLike =
  | {
      defaultDirectMode?: boolean | undefined;
      defaultTaskGitIsolation?: DefaultTaskGitIsolationMode | undefined;
      projectMode?: 'git' | 'non-git' | undefined;
    }
  | null
  | undefined;

type TaskGitIsolationLike =
  | {
      directMode?: boolean;
      gitIsolation?: TaskGitIsolationMode | undefined;
      projectMode?: 'git' | 'non-git' | undefined;
      worktreeOwnership?: WorktreeOwnership | undefined;
    }
  | null
  | undefined;

type TaskBaseBranchLike = { baseBranch?: string | undefined } | null | undefined;

export function getProjectDefaultTaskGitIsolation(
  project: ProjectGitIsolationLike,
): DefaultTaskGitIsolationMode {
  const gitIsolation = project?.defaultTaskGitIsolation;
  if (gitIsolation === 'worktree' || gitIsolation === 'current-branch') {
    return gitIsolation;
  }

  return project?.defaultDirectMode === true ? 'current-branch' : 'worktree';
}

export function getTaskGitIsolation(task: TaskGitIsolationLike): TaskGitIsolationMode {
  const gitIsolation = task?.gitIsolation;
  if (
    gitIsolation === 'worktree' ||
    gitIsolation === 'current-branch' ||
    gitIsolation === 'existing-worktree'
  ) {
    return gitIsolation;
  }

  return task?.directMode === true ? 'current-branch' : 'worktree';
}

export function isCurrentBranchTask(task: TaskGitIsolationLike): boolean {
  return getTaskGitIsolation(task) === 'current-branch';
}

export function isExistingWorktreeTask(task: TaskGitIsolationLike): boolean {
  return getTaskGitIsolation(task) === 'existing-worktree';
}

export function isManagedWorktreeTask(task: TaskGitIsolationLike): boolean {
  if (isNonGitProject(task)) {
    return false;
  }

  if (task?.worktreeOwnership === 'external') {
    return false;
  }

  return getTaskGitIsolation(task) === 'worktree';
}

export function getTaskWorktreeOwnership(task: TaskGitIsolationLike): WorktreeOwnership {
  if (task?.worktreeOwnership === 'managed' || task?.worktreeOwnership === 'external') {
    return task.worktreeOwnership;
  }

  return isExistingWorktreeTask(task) ? 'external' : 'managed';
}

export function normalizeTaskBaseBranch(task: TaskBaseBranchLike): string | undefined {
  return normalizeBaseBranch(task?.baseBranch);
}

export function buildProjectGitIsolationFields(
  project: ProjectGitIsolationLike,
): Partial<Pick<Project, 'defaultDirectMode' | 'defaultTaskGitIsolation'>> {
  if (isNonGitProject(project)) {
    return {};
  }

  const defaultTaskGitIsolation = getProjectDefaultTaskGitIsolation(project);
  return {
    defaultTaskGitIsolation,
    ...(defaultTaskGitIsolation === 'current-branch' ? { defaultDirectMode: true } : {}),
  };
}

export function clearProjectGitFields(project: Project): void {
  delete project.baseBranch;
  delete project.branchPrefix;
  delete project.defaultDirectMode;
  delete project.defaultTaskGitIsolation;
  delete project.deleteBranchOnClose;
}

export function buildTaskGitIsolationFields(
  task: TaskGitIsolationLike,
): Pick<Task, 'gitIsolation'> & Partial<Pick<Task, 'directMode' | 'worktreeOwnership'>> {
  const gitIsolation = getTaskGitIsolation(task);
  const worktreeOwnership = task?.worktreeOwnership ?? getTaskWorktreeOwnership({ gitIsolation });
  return {
    gitIsolation,
    ...(worktreeOwnership === 'external' ? { worktreeOwnership } : {}),
    ...(gitIsolation === 'current-branch' ? { directMode: true } : {}),
  };
}
