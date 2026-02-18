import { produce } from "solid-js/store";
import { open } from "@tauri-apps/plugin-dialog";
import { store, setStore } from "./core";
import { closeTask } from "./tasks";
import type { Project } from "./types";

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
    })
  );
  return id;
}

export function removeProject(projectId: string): void {
  setStore(
    produce((s) => {
      s.projects = s.projects.filter((p) => p.id !== projectId);
      if (s.lastProjectId === projectId) {
        s.lastProjectId = s.projects[0]?.id ?? null;
      }
    })
  );
}

export function updateProject(
  projectId: string,
  updates: Partial<Pick<Project, "name" | "color" | "branchPrefix" | "deleteBranchOnClose" | "terminalBookmarks">>
): void {
  setStore(
    produce((s) => {
      const idx = s.projects.findIndex((p) => p.id === projectId);
      if (idx === -1) return;
      if (updates.name !== undefined) s.projects[idx].name = updates.name;
      if (updates.color !== undefined) s.projects[idx].color = updates.color;
      if (updates.branchPrefix !== undefined) s.projects[idx].branchPrefix = updates.branchPrefix;
      if (updates.deleteBranchOnClose !== undefined) s.projects[idx].deleteBranchOnClose = updates.deleteBranchOnClose;
      if (updates.terminalBookmarks !== undefined) s.projects[idx].terminalBookmarks = updates.terminalBookmarks;
    })
  );
}

export function getProjectBranchPrefix(projectId: string): string {
  return store.projects.find((p) => p.id === projectId)?.branchPrefix ?? "task";
}

export function getProjectPath(projectId: string): string | undefined {
  return store.projects.find((p) => p.id === projectId)?.path;
}

export async function removeProjectWithTasks(projectId: string): Promise<void> {
  // Collect task IDs belonging to this project BEFORE removing anything
  const taskIds = store.taskOrder.filter(
    (tid) => store.tasks[tid]?.projectId === projectId
  );

  // Close all tasks first (kills agents, removes worktrees/branches)
  // Must happen before removeProject() since closeTask needs the project path
  await Promise.all(taskIds.map((tid) => closeTask(tid)));

  // Now remove the project itself
  removeProject(projectId);
}

export async function pickAndAddProject(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  if (!selected) return null;
  const path = selected as string;
  const segments = path.split("/");
  const name = segments[segments.length - 1] || path;
  return addProject(name, path);
}
