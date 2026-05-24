import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { randomPastelColor } from '../domain/project-colors.js';
import { normalizeBaseBranch } from '../lib/base-branch.js';
import { sanitizeBranchPrefix } from '../lib/branch-name';
import { invoke } from '../lib/ipc';
import { createRandomId } from '../lib/random-id';
import { store, setStore } from './core';
import { buildProjectModeFields, getProjectMode } from './project-mode';
import {
  buildProjectGitIsolationFields,
  clearProjectGitFields,
  getProjectDefaultTaskGitIsolation,
} from './task-git-isolation';
import type { Project, ProjectMode } from './types.js';

export { PASTEL_HUES, randomPastelColor } from '../domain/project-colors.js';

let projectPathValidationGeneration = 0;

function getProjectPathValidationSignature(): string {
  return store.projects
    .map((project) => `${project.id}:${project.path}`)
    .sort()
    .join('\n');
}

export function getProject(projectId: string): Project | undefined {
  return store.projects.find((p) => p.id === projectId);
}

export function addProject(
  name: string,
  path: string,
  options?: { projectMode?: ProjectMode },
): string {
  const id = createRandomId();
  const color = randomPastelColor();
  const project: Project = {
    id,
    name,
    path,
    color,
    ...buildProjectModeFields(options),
    ...buildProjectGitIsolationFields(options),
  };
  setStore(
    produce((s) => {
      s.projects.push(project);
      s.lastProjectId = id;
    }),
  );
  return id;
}

export function setProjectPath(projectId: string, path: string): void {
  setStore(
    produce((s) => {
      const idx = s.projects.findIndex((p) => p.id === projectId);
      if (idx === -1) return;
      const project = s.projects[idx];
      if (!project) return;
      project.path = path;
    }),
  );
}

export function removeProject(projectId: string): void {
  // Guard: skip removal if any tasks still reference this project
  const allTaskIds = [...store.taskOrder, ...store.collapsedTaskOrder];
  const hasLinkedTasks = allTaskIds.some((tid) => store.tasks[tid]?.projectId === projectId);
  if (hasLinkedTasks) {
    console.warn(
      'removeProject: skipped — tasks still reference this project. Use removeProjectWithTasks.',
    );
    return;
  }

  setStore(
    produce((s) => {
      s.projects = s.projects.filter((p) => p.id !== projectId);
      if (s.lastProjectId === projectId) {
        s.lastProjectId = s.projects[0]?.id ?? null;
      }
      delete s.missingProjectIds[projectId];
    }),
  );
}

export function updateProject(
  projectId: string,
  updates: Partial<
    Pick<
      Project,
      | 'name'
      | 'color'
      | 'baseBranch'
      | 'branchPrefix'
      | 'deleteBranchOnClose'
      | 'defaultDirectMode'
      | 'defaultTaskGitIsolation'
      | 'projectMode'
      | 'terminalBookmarks'
    >
  >,
): void {
  setStore(
    produce((s) => {
      const idx = s.projects.findIndex((p) => p.id === projectId);
      if (idx === -1) return;
      const project = s.projects[idx];
      if (!project) return;

      if (updates.name !== undefined) project.name = updates.name;
      if (updates.color !== undefined) project.color = updates.color;
      if (updates.projectMode !== undefined) {
        if (getProjectMode(updates) === 'non-git') {
          project.projectMode = 'non-git';
        } else {
          delete project.projectMode;
          Object.assign(project, buildProjectGitIsolationFields(project));
        }
      }
      if (getProjectMode(project) === 'non-git') {
        clearProjectGitFields(project);
      } else {
        if (updates.baseBranch !== undefined) {
          const baseBranch = normalizeBaseBranch(updates.baseBranch);
          if (baseBranch !== undefined) {
            project.baseBranch = baseBranch;
          } else {
            delete project.baseBranch;
          }
        }
        if (updates.branchPrefix !== undefined)
          project.branchPrefix = sanitizeBranchPrefix(updates.branchPrefix);
        if (updates.deleteBranchOnClose !== undefined)
          project.deleteBranchOnClose = updates.deleteBranchOnClose;
      }
      if (
        getProjectMode(project) === 'git' &&
        (updates.defaultTaskGitIsolation !== undefined || updates.defaultDirectMode !== undefined)
      ) {
        const gitIsolation = getProjectDefaultTaskGitIsolation({
          defaultDirectMode: updates.defaultDirectMode ?? project.defaultDirectMode,
          defaultTaskGitIsolation:
            updates.defaultTaskGitIsolation ?? project.defaultTaskGitIsolation,
        });
        Object.assign(
          project,
          buildProjectGitIsolationFields({ defaultTaskGitIsolation: gitIsolation }),
        );
        if (gitIsolation !== 'current-branch') delete project.defaultDirectMode;
      }
      if (updates.terminalBookmarks !== undefined)
        project.terminalBookmarks = updates.terminalBookmarks;
    }),
  );
}

export function getProjectBaseBranch(projectId: string): string | undefined {
  const project = getProject(projectId);
  if (getProjectMode(project) === 'non-git') {
    return undefined;
  }

  return normalizeBaseBranch(project?.baseBranch);
}

export function getProjectBranchPrefix(projectId: string): string {
  const project = getProject(projectId);
  const raw = getProjectMode(project) === 'non-git' ? 'task' : (project?.branchPrefix ?? 'task');
  return sanitizeBranchPrefix(raw);
}

export function getProjectPath(projectId: string): string | undefined {
  return getProject(projectId)?.path;
}

/** Check each project path and record which ones are missing. */
export async function validateProjectPaths(): Promise<void> {
  const validationGeneration = ++projectPathValidationGeneration;
  const projectPaths = [...new Set(store.projects.map((project) => project.path))];
  const validationSignature = getProjectPathValidationSignature();
  if (projectPaths.length === 0) {
    setStore('missingProjectIds', {});
    return;
  }

  let existingPaths: Record<string, boolean>;

  try {
    existingPaths = await invoke(IPC.CheckPathsExist, { paths: projectPaths });
  } catch (error) {
    console.warn('validateProjectPaths: bulk path check failed', error);
    return;
  }

  if (validationGeneration !== projectPathValidationGeneration) {
    return;
  }

  if (validationSignature !== getProjectPathValidationSignature()) {
    void validateProjectPaths();
    return;
  }

  const missing: Record<string, true> = {};
  for (const project of store.projects) {
    if (!existingPaths[project.path]) {
      missing[project.id] = true;
    }
  }

  setStore('missingProjectIds', missing);
}

export function isProjectMissing(projectId: string): boolean {
  return projectId in store.missingProjectIds;
}

export function clearMissingProject(projectId: string): void {
  setStore('missingProjectIds', (prev: Record<string, true>) => {
    const next = { ...prev };
    delete next[projectId];
    return next;
  });
}
