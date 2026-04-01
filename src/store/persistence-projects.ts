import { normalizeBaseBranch } from '../lib/base-branch';
import { randomPastelColor } from './projects';
import { buildProjectGitIsolationFields } from './task-git-isolation';
import type { LegacyPersistedState } from './persistence-legacy-state';
import type { Project } from './types';

export function parseSharedProjects(raw: LegacyPersistedState): {
  lastProjectId: string | null;
  projects: Project[];
} {
  let projects: Project[] = raw.projects ?? [];
  let lastProjectId: string | null = raw.lastProjectId ?? null;

  for (const project of projects) {
    if (!project.color) {
      project.color = randomPastelColor();
    }
    const baseBranch = normalizeBaseBranch(project.baseBranch);
    if (baseBranch !== undefined) {
      project.baseBranch = baseBranch;
    } else {
      delete project.baseBranch;
    }
    Object.assign(project, buildProjectGitIsolationFields(project));
    if (project.defaultTaskGitIsolation !== 'current-branch') delete project.defaultDirectMode;
  }

  if (projects.length === 0 && raw.projectRoot) {
    const segments = raw.projectRoot.split('/');
    const name = segments[segments.length - 1] || raw.projectRoot;
    const id = crypto.randomUUID();
    projects = [
      {
        id,
        name,
        path: raw.projectRoot,
        color: randomPastelColor(),
        ...buildProjectGitIsolationFields(undefined),
      },
    ];
    lastProjectId = id;

    for (const taskId of raw.taskOrder) {
      const persistedTask = raw.tasks[taskId];
      if (persistedTask && !persistedTask.projectId) {
        persistedTask.projectId = id;
      }
    }
  }

  return {
    lastProjectId,
    projects,
  };
}
