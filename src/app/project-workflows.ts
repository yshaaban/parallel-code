import { openDialog } from '../lib/dialog';
import { removeProject, addProject } from '../store/projects';
import { store } from '../store/state';
import { closeTask } from './task-workflows';

export async function pickAndAddProject(): Promise<string | null> {
  const selected = await openDialog({ directory: true, multiple: false });
  if (!selected) {
    return null;
  }

  const projectPath = selected as string;
  const pathSegments = projectPath.split('/');
  const projectName = pathSegments[pathSegments.length - 1] ?? projectPath;
  return addProject(projectName, projectPath);
}

export async function removeProjectWithTasks(projectId: string): Promise<void> {
  const activeTaskIds = store.taskOrder.filter(
    (taskId) => store.tasks[taskId]?.projectId === projectId,
  );
  const collapsedTaskIds = store.collapsedTaskOrder.filter(
    (taskId) => store.tasks[taskId]?.projectId === projectId,
  );

  for (const taskId of activeTaskIds) {
    await closeTask(taskId);
  }

  for (const taskId of collapsedTaskIds) {
    await closeTask(taskId);
  }

  const allProjectTaskIds = [...activeTaskIds, ...collapsedTaskIds];
  const hasRemainingTasks = allProjectTaskIds.some(
    (taskId) => store.tasks[taskId]?.projectId === projectId,
  );
  if (hasRemainingTasks) {
    return;
  }

  removeProject(projectId);
}
