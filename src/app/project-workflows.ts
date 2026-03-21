import path from 'path';

import { IPC } from '../../electron/ipc/channels';
import { confirm, openDialog } from '../lib/dialog';
import { invoke } from '../lib/ipc';
import { addProject, clearMissingProject, removeProject, setProjectPath } from '../store/projects';
import { saveCurrentRuntimeState } from '../store/persistence-save';
import { store } from '../store/state';
import { closeTask } from './task-workflows';

interface ProjectRootValidationResult {
  isValidRoot: boolean;
  repoRoot: string | null;
}

function isSelectedRootMatchingRepoRoot(selectedPath: string, repoRoot: string): boolean {
  return path.resolve(selectedPath) === path.resolve(repoRoot);
}

async function validateProjectRootSelection(
  selectedPath: string,
): Promise<ProjectRootValidationResult> {
  const repoRoot = await invoke(IPC.GetGitRepoRoot, { path: selectedPath });
  return {
    isValidRoot: repoRoot !== null && isSelectedRootMatchingRepoRoot(selectedPath, repoRoot),
    repoRoot,
  };
}

function getInvalidProjectRootMessage(selectedPath: string, repoRoot: string | null): string {
  if (repoRoot === null) {
    return [
      'The selected folder is not a git repository root.',
      '',
      'Choose the repository root folder for this project.',
    ].join('\n');
  }

  return [
    'The selected folder is inside a git repository, but it is not the repository root.',
    '',
    `Selected folder: ${selectedPath}`,
    `Repository root: ${repoRoot}`,
    '',
    'Choose the repository root folder for this project.',
  ].join('\n');
}

async function showInvalidProjectRootDialog(
  selectedPath: string,
  repoRoot: string | null,
): Promise<void> {
  await confirm(getInvalidProjectRootMessage(selectedPath, repoRoot), {
    cancelLabel: 'Close',
    kind: 'warning',
    okLabel: 'OK',
    title: 'Invalid project folder',
  });
}

export async function pickAndAddProject(): Promise<string | null> {
  const selected = await openDialog({ directory: true, multiple: false });
  if (!selected) {
    return null;
  }

  const projectPath = selected as string;
  const { repoRoot, isValidRoot } = await validateProjectRootSelection(projectPath);
  if (!isValidRoot) {
    await showInvalidProjectRootDialog(projectPath, repoRoot);
    return null;
  }

  const projectName = path.basename(projectPath) || projectPath;
  return addProject(projectName, projectPath);
}

export async function relinkProject(projectId: string): Promise<boolean> {
  const selected = await openDialog({ directory: true, multiple: false });
  if (!selected) return false;

  const newPath = selected as string;
  const { repoRoot, isValidRoot } = await validateProjectRootSelection(newPath);
  if (!isValidRoot) {
    await showInvalidProjectRootDialog(newPath, repoRoot);
    return false;
  }

  setProjectPath(projectId, newPath);
  clearMissingProject(projectId);
  await saveCurrentRuntimeState();
  return true;
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
