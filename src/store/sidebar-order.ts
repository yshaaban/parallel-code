import { store } from './core';

export const SIDEBAR_ORPHANED_ACTIVE_GROUP_ID = '__sidebar-orphaned-active__';

export interface GroupedSidebarTasks {
  grouped: Record<string, { active: string[]; collapsed: string[] }>;
  orphanedActive: string[];
  orphanedCollapsed: string[];
}

export interface SidebarActiveTaskGroup {
  groupId: string;
  projectId: string | null;
  taskIds: string[];
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

export function computeSidebarActiveGroups(): SidebarActiveTaskGroup[] {
  const { grouped, orphanedActive } = computeGroupedTasks();
  const orderedGroups: SidebarActiveTaskGroup[] = [];

  for (const project of store.projects) {
    const activeTaskIds = grouped[project.id]?.active ?? [];
    if (activeTaskIds.length === 0) {
      continue;
    }

    orderedGroups.push({
      groupId: project.id,
      projectId: project.id,
      taskIds: activeTaskIds,
    });
  }

  if (orphanedActive.length > 0) {
    orderedGroups.push({
      groupId: SIDEBAR_ORPHANED_ACTIVE_GROUP_ID,
      projectId: null,
      taskIds: orphanedActive,
    });
  }

  return orderedGroups;
}

export function computeSidebarActiveOrder(): string[] {
  return computeSidebarActiveGroups().flatMap((group) => group.taskIds);
}

export function getSidebarActiveTaskGroup(taskId: string): SidebarActiveTaskGroup | null {
  for (const group of computeSidebarActiveGroups()) {
    if (group.taskIds.includes(taskId)) {
      return group;
    }
  }

  return null;
}

export function getSidebarActiveTaskGroupId(taskId: string): string | null {
  return getSidebarActiveTaskGroup(taskId)?.groupId ?? null;
}

export function reorderTaskOrderWithinSidebarGroup(
  taskId: string,
  targetGroupId: string,
  targetIndex: number,
): string[] | null {
  const sourceGroup = getSidebarActiveTaskGroup(taskId);
  if (!sourceGroup || sourceGroup.groupId !== targetGroupId) {
    return null;
  }

  const sourceIndex = sourceGroup.taskIds.indexOf(taskId);
  if (sourceIndex === -1) {
    return null;
  }

  const clampedTargetIndex = Math.max(0, Math.min(sourceGroup.taskIds.length, targetIndex));
  const adjustedTargetIndex =
    clampedTargetIndex > sourceIndex ? clampedTargetIndex - 1 : clampedTargetIndex;
  if (adjustedTargetIndex === sourceIndex) {
    return null;
  }

  const nextGroupTaskIds = [...sourceGroup.taskIds];
  nextGroupTaskIds.splice(sourceIndex, 1);
  nextGroupTaskIds.splice(adjustedTargetIndex, 0, taskId);

  const groupTaskIdSet = new Set(sourceGroup.taskIds);
  let replacementIndex = 0;

  return store.taskOrder.map((currentTaskId) => {
    if (!groupTaskIdSet.has(currentTaskId)) {
      return currentTaskId;
    }

    const nextTaskId = nextGroupTaskIds[replacementIndex];
    replacementIndex += 1;
    return nextTaskId ?? currentTaskId;
  });
}
