import { parseGitHubUrl, taskNameFromGitHubUrl } from '../lib/github-url';
import { createRandomId } from '../lib/random-id';
import { reorderTaskOrderWithinSidebarGroup } from './sidebar-order';
import { setStore, store, updateWindowTitle } from './core';
import { enqueueWorkspaceEditIntent } from './persistence-session';
export function updateTaskName(taskId: string, name: string): void {
  const baseName = store.tasks[taskId]?.name;
  if (baseName === undefined || baseName === name) return;
  enqueueWorkspaceEditIntent({
    baseName,
    kind: 'rename-task',
    nextName: name,
    operationId: createRandomId(),
    taskId,
  });
  setStore('tasks', taskId, 'name', name);
  if (store.activeTaskId === taskId) {
    updateWindowTitle(name);
  }
}

export function setLastPrompt(taskId: string, text: string): void {
  setStore('tasks', taskId, 'lastPrompt', text);
}

export function clearPrefillPrompt(taskId: string): void {
  setStore('tasks', taskId, 'prefillPrompt', undefined);
}

export function setPrefillPrompt(taskId: string, text: string): void {
  setStore('tasks', taskId, 'prefillPrompt', text);
}

export function reorderTask(fromIndex: number, toIndex: number): void {
  if (fromIndex === toIndex) return;
  const nextTaskOrder = [...store.taskOrder];
  const length = nextTaskOrder.length;
  if (fromIndex < 0 || fromIndex >= length || toIndex < 0 || toIndex >= length) return;
  const [moved] = nextTaskOrder.splice(fromIndex, 1);
  if (!moved) return;
  nextTaskOrder.splice(toIndex, 0, moved);
  enqueueSharedTaskOrderIntent(nextTaskOrder);
  setStore('taskOrder', nextTaskOrder);
}

function enqueueSharedTaskOrderIntent(nextTaskOrder: readonly string[]): void {
  const baseOrder = store.taskOrder.filter((taskId) => store.tasks[taskId] !== undefined);
  const nextOrder = nextTaskOrder.filter((taskId) => store.tasks[taskId] !== undefined);
  if (
    baseOrder.length === nextOrder.length &&
    baseOrder.every((id, index) => id === nextOrder[index])
  ) {
    return;
  }
  enqueueWorkspaceEditIntent({
    baseOrder,
    kind: 'reorder-tasks',
    list: 'active',
    nextOrder,
    operationId: createRandomId(),
  });
}

export function reorderTaskWithinSidebarGroup(
  taskId: string,
  targetGroupId: string,
  targetIndex: number,
): void {
  const nextTaskOrder = reorderTaskOrderWithinSidebarGroup(taskId, targetGroupId, targetIndex);
  if (!nextTaskOrder) {
    return;
  }

  enqueueSharedTaskOrderIntent(nextTaskOrder);
  setStore('taskOrder', nextTaskOrder);
}

function matchProject(repoName: string): string | null {
  const lower = repoName.toLowerCase();
  for (const project of store.projects) {
    const basename = project.path.split('/').pop() ?? '';
    if (basename.toLowerCase() === lower) return project.id;
  }
  return null;
}

export function getGitHubDropDefaults(
  url: string,
): { name: string; projectId: string | null } | null {
  const parsed = parseGitHubUrl(url);
  if (!parsed) return null;
  return {
    name: taskNameFromGitHubUrl(parsed),
    projectId: matchProject(parsed.repo),
  };
}

export function setNewTaskDropUrl(url: string): void {
  setStore('newTaskDropUrl', url);
}

export function setNewTaskPrefillPrompt(prompt: string, projectId: string | null): void {
  setStore('newTaskPrefillPrompt', { prompt, projectId });
}

export function setPlanContent(
  taskId: string,
  content: string | null,
  fileName: string | null,
  relativePath: string | null,
): void {
  setStore('tasks', taskId, 'planContent', content ?? undefined);
  setStore('tasks', taskId, 'planFileName', fileName ?? undefined);
  setStore('tasks', taskId, 'planRelativePath', relativePath ?? undefined);
}
