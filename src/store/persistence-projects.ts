import { parseAgentRunnerProfileConfig } from '../domain/agent-runners.js';
import { randomPastelColor } from '../domain/project-colors.js';
import { normalizeBaseBranch } from '../lib/base-branch.js';
import { createRandomId } from '../lib/random-id.js';
import { isRecord } from '../lib/type-guards.js';
import { isPersistedTask, type LegacyPersistedState } from './persistence-legacy-state.js';
import { buildProjectModeFields, isNonGitProject } from './project-mode.js';
import { buildProjectGitIsolationFields, clearProjectGitFields } from './task-git-isolation.js';
import type { Project } from './types.js';

type PersistedProjectInput = Omit<Project, 'color'> & { color?: string };

function isPersistedProject(value: unknown): value is PersistedProjectInput {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    (value.color === undefined || typeof value.color === 'string')
  );
}

function getPersistedProjects(value: unknown): Project[] {
  return Array.isArray(value)
    ? value.filter(isPersistedProject).map((project) => {
        const { agentRunnerConfig: rawAgentRunnerConfig, ...persistedProject } = project;
        const agentRunnerConfig = parseAgentRunnerProfileConfig(rawAgentRunnerConfig);
        return {
          ...persistedProject,
          ...(agentRunnerConfig !== undefined ? { agentRunnerConfig } : {}),
          color: project.color ?? '',
        };
      })
    : [];
}

export function parseSharedProjects(raw: LegacyPersistedState): {
  lastProjectId: string | null;
  projects: Project[];
} {
  let projects = getPersistedProjects(raw.projects);
  let lastProjectId = typeof raw.lastProjectId === 'string' ? raw.lastProjectId : null;

  for (const project of projects) {
    if (!project.color) {
      project.color = randomPastelColor();
    }
    Object.assign(project, buildProjectModeFields(project));
    if (isNonGitProject(project)) {
      clearProjectGitFields(project);
      continue;
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

  if (projects.length === 0 && typeof raw.projectRoot === 'string') {
    const segments = raw.projectRoot.split('/');
    const name = segments[segments.length - 1] || raw.projectRoot;
    const id = createRandomId();
    projects = [
      {
        id,
        name,
        path: raw.projectRoot,
        color: randomPastelColor(),
        ...buildProjectModeFields(undefined),
        ...buildProjectGitIsolationFields(undefined),
      },
    ];
    lastProjectId = id;

    for (const taskId of new Set([...raw.taskOrder, ...(raw.collapsedTaskOrder ?? [])])) {
      const persistedTask = raw.tasks[taskId];
      if (isPersistedTask(persistedTask) && !persistedTask.projectId) {
        persistedTask.projectId = id;
      }
    }
  }

  return {
    lastProjectId,
    projects,
  };
}
