import { randomPastelColor } from '../domain/project-colors.js';
import { normalizeBaseBranch } from '../lib/base-branch.js';
import type { LegacyPersistedState } from './persistence-legacy-state.js';
import { buildProjectGitIsolationFields } from './task-git-isolation.js';
import type { Project } from './types.js';

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
