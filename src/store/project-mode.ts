import type { Project, ProjectMode, Task } from './types.js';

type ProjectModeLike = { projectMode?: ProjectMode | undefined } | null | undefined;

export function getProjectMode(project: ProjectModeLike): ProjectMode {
  return project?.projectMode === 'non-git' ? 'non-git' : 'git';
}

export function isGitProject(project: ProjectModeLike): boolean {
  return getProjectMode(project) === 'git';
}

export function isNonGitProject(project: ProjectModeLike): boolean {
  return getProjectMode(project) === 'non-git';
}

export function buildProjectModeFields(
  project: ProjectModeLike,
): Partial<Pick<Project, 'projectMode'>> {
  return isNonGitProject(project) ? { projectMode: 'non-git' } : {};
}

export function buildTaskProjectModeFields(
  project: ProjectModeLike,
): Partial<Pick<Task, 'projectMode'>> {
  return isNonGitProject(project) ? { projectMode: 'non-git' } : {};
}
