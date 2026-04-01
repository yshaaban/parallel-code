import { normalizeBaseBranch } from '../lib/base-branch.js';
import type { Project, Task, TaskGitIsolationMode } from './types.js';

type ProjectGitIsolationLike =
  | {
      defaultDirectMode?: boolean | undefined;
      defaultTaskGitIsolation?: TaskGitIsolationMode | undefined;
    }
  | null
  | undefined;

type TaskGitIsolationLike =
  | { directMode?: boolean; gitIsolation?: TaskGitIsolationMode | undefined }
  | null
  | undefined;

type TaskBaseBranchLike = { baseBranch?: string | undefined } | null | undefined;

export function getProjectDefaultTaskGitIsolation(
  project: ProjectGitIsolationLike,
): TaskGitIsolationMode {
  const gitIsolation = project?.defaultTaskGitIsolation;
  if (gitIsolation === 'worktree' || gitIsolation === 'current-branch') {
    return gitIsolation;
  }

  return project?.defaultDirectMode === true ? 'current-branch' : 'worktree';
}

export function getTaskGitIsolation(task: TaskGitIsolationLike): TaskGitIsolationMode {
  const gitIsolation = task?.gitIsolation;
  if (gitIsolation === 'worktree' || gitIsolation === 'current-branch') {
    return gitIsolation;
  }

  return task?.directMode === true ? 'current-branch' : 'worktree';
}

export function isCurrentBranchTask(task: TaskGitIsolationLike): boolean {
  return getTaskGitIsolation(task) === 'current-branch';
}

export function normalizeTaskBaseBranch(task: TaskBaseBranchLike): string | undefined {
  return normalizeBaseBranch(task?.baseBranch);
}

export function buildProjectGitIsolationFields(
  project: ProjectGitIsolationLike,
): Pick<Project, 'defaultTaskGitIsolation'> & Partial<Pick<Project, 'defaultDirectMode'>> {
  const defaultTaskGitIsolation = getProjectDefaultTaskGitIsolation(project);
  return {
    defaultTaskGitIsolation,
    ...(defaultTaskGitIsolation === 'current-branch' ? { defaultDirectMode: true } : {}),
  };
}

export function buildTaskGitIsolationFields(
  task: TaskGitIsolationLike,
): Pick<Task, 'gitIsolation'> & Partial<Pick<Task, 'directMode'>> {
  const gitIsolation = getTaskGitIsolation(task);
  return {
    gitIsolation,
    ...(gitIsolation === 'current-branch' ? { directMode: true } : {}),
  };
}
