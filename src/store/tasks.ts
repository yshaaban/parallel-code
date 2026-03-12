import { produce } from 'solid-js/store';
import { parseGitHubUrl, taskNameFromGitHubUrl } from '../lib/github-url';
import { setStore, store, updateWindowTitle } from './core';

export {
  type CreateDirectTaskOptions,
  type CreateTaskOptions,
  closeShell,
  closeTask,
  collapseTask,
  createDirectTask,
  createTask,
  mergeTask,
  pushTask,
  retryCloseTask,
  runBookmarkInTask,
  sendPrompt,
  spawnShellForTask,
  uncollapseTask,
} from '../app/task-workflows';

export function updateTaskName(taskId: string, name: string): void {
  setStore('tasks', taskId, 'name', name);
  if (store.activeTaskId === taskId) {
    updateWindowTitle(name);
  }
}

export function updateTaskNotes(taskId: string, notes: string): void {
  setStore('tasks', taskId, 'notes', notes);
}

export function setLastPrompt(taskId: string, text: string): void {
  setStore('tasks', taskId, 'lastPrompt', text);
}

export function clearInitialPrompt(taskId: string): void {
  setStore('tasks', taskId, 'initialPrompt', undefined);
}

export function clearPrefillPrompt(taskId: string): void {
  setStore('tasks', taskId, 'prefillPrompt', undefined);
}

export function setPrefillPrompt(taskId: string, text: string): void {
  setStore('tasks', taskId, 'prefillPrompt', text);
}

export function reorderTask(fromIndex: number, toIndex: number): void {
  if (fromIndex === toIndex) return;
  setStore(
    produce((state) => {
      const length = state.taskOrder.length;
      if (fromIndex < 0 || fromIndex >= length || toIndex < 0 || toIndex >= length) return;
      const [moved] = state.taskOrder.splice(fromIndex, 1);
      state.taskOrder.splice(toIndex, 0, moved);
    }),
  );
}

export function hasDirectModeTask(projectId: string): boolean {
  const allTaskIds = [...store.taskOrder, ...store.collapsedTaskOrder];
  return allTaskIds.some((taskId) => {
    const task = store.tasks[taskId];
    return (
      task && task.projectId === projectId && task.directMode && task.closingStatus !== 'removing'
    );
  });
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
): void {
  setStore('tasks', taskId, 'planContent', content ?? undefined);
  setStore('tasks', taskId, 'planFileName', fileName ?? undefined);
}
