import { store } from './core';

export interface GroupedSidebarTasks {
  grouped: Record<string, { active: string[]; collapsed: string[] }>;
  orphanedActive: string[];
  orphanedCollapsed: string[];
}

export function computeGroupedTasks(): GroupedSidebarTasks {
  const grouped: Record<string, { active: string[]; collapsed: string[] }> = {};
  const orphanedActive: string[] = [];
  const orphanedCollapsed: string[] = [];
  const projectIds = new Set(store.projects.map((project) => project.id));

  for (const taskId of store.taskOrder) {
    const task = store.tasks[taskId];
    if (!task) {
      continue;
    }

    if (task.projectId && projectIds.has(task.projectId)) {
      (grouped[task.projectId] ??= { active: [], collapsed: [] }).active.push(taskId);
    } else {
      orphanedActive.push(taskId);
    }
  }

  for (const taskId of store.collapsedTaskOrder) {
    const task = store.tasks[taskId];
    if (!task || !task.collapsed) {
      continue;
    }

    if (task.projectId && projectIds.has(task.projectId)) {
      (grouped[task.projectId] ??= { active: [], collapsed: [] }).collapsed.push(taskId);
    } else {
      orphanedCollapsed.push(taskId);
    }
  }

  return { grouped, orphanedActive, orphanedCollapsed };
}

export function computeSidebarTaskOrder(): string[] {
  const { grouped, orphanedActive, orphanedCollapsed } = computeGroupedTasks();
  const orderedTaskIds: string[] = [];

  for (const project of store.projects) {
    const group = grouped[project.id];
    if (!group) {
      continue;
    }

    orderedTaskIds.push(...group.active, ...group.collapsed);
  }

  orderedTaskIds.push(...orphanedActive, ...orphanedCollapsed);
  return orderedTaskIds;
}
