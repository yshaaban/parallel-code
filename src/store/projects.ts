import { produce } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import type { Project } from './types';
import { normalizeBaseBranch } from '../lib/base-branch';
import { sanitizeBranchPrefix } from '../lib/branch-name';

export const PASTEL_HUES = [0, 30, 60, 120, 180, 210, 260, 300, 330];

export function randomPastelColor(): string {
  const hue = PASTEL_HUES[Math.floor(Math.random() * PASTEL_HUES.length)];
  return `hsl(${hue}, 70%, 75%)`;
}

export function getProject(projectId: string): Project | undefined {
  return store.projects.find((p) => p.id === projectId);
}

export function addProject(name: string, path: string): string {
  const id = crypto.randomUUID();
  const color = randomPastelColor();
  const project: Project = { id, name, path, color };
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
      if (updates.defaultDirectMode !== undefined)
        project.defaultDirectMode = updates.defaultDirectMode;
      if (updates.terminalBookmarks !== undefined)
        project.terminalBookmarks = updates.terminalBookmarks;
    }),
  );
}

export function getProjectBaseBranch(projectId: string): string | undefined {
  return normalizeBaseBranch(getProject(projectId)?.baseBranch);
}

export function getProjectBranchPrefix(projectId: string): string {
  const raw = getProject(projectId)?.branchPrefix ?? 'task';
  return sanitizeBranchPrefix(raw);
}

export function getProjectPath(projectId: string): string | undefined {
  return getProject(projectId)?.path;
}

/** Check each project path and record which ones are missing. */
export async function validateProjectPaths(): Promise<void> {
  const projectPaths = [...new Set(store.projects.map((project) => project.path))];
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
