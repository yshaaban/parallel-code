import { IPC } from '../../electron/ipc/channels';
import { isTaskRemoving } from '../domain/task-closing';
import { assertNever } from '../lib/assert-never';
import { confirm, openDialog } from '../lib/dialog';
import { isGitSshUrl } from '../lib/git-ssh-url';
import { invoke } from '../lib/ipc';
import {
  addProject,
  clearMissingProject,
  removeProject,
  setProjectPath,
  updateProject,
} from '../store/projects';
import { getProjectMode } from '../store/project-mode';
import { saveCurrentRuntimeState } from '../store/persistence-save';
import { store } from '../store/state';
import type { ProjectMode } from '../store/types';
import { hasUnsavedDesktopTaskNotes } from './task-notes-recovery-channel';
import { closeTask } from './task-workflows';

function normalizeProjectPath(pathValue: string): string {
  const normalizedPath = pathValue.replace(/\\/g, '/');
  const drivePrefixMatch = normalizedPath.match(/^[A-Za-z]:/);
  const drivePrefixToken = drivePrefixMatch?.[0] ?? '';
  const drivePrefix = drivePrefixToken ? `${drivePrefixToken.charAt(0).toLowerCase()}:` : '';
  const pathAfterDrive = drivePrefixMatch
    ? normalizedPath.slice(drivePrefixMatch[0].length)
    : normalizedPath;
  const hasAbsoluteDrivePrefix = drivePrefixMatch ? pathAfterDrive.startsWith('/') : false;
  const hasNetworkPrefix = !drivePrefix && normalizedPath.startsWith('//');
  const hasRootPrefix =
    hasNetworkPrefix || normalizedPath.startsWith('/') || hasAbsoluteDrivePrefix;
  let pathWithoutPrefix = normalizedPath;

  if (drivePrefixMatch) {
    pathWithoutPrefix = hasAbsoluteDrivePrefix ? pathAfterDrive.slice(1) : pathAfterDrive;
  } else if (hasNetworkPrefix) {
    pathWithoutPrefix = normalizedPath.slice(2);
  } else if (normalizedPath.startsWith('/')) {
    pathWithoutPrefix = normalizedPath.slice(1);
  }

  const segments: string[] = [];
  for (const segment of pathWithoutPrefix.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
        continue;
      }

      if (!hasRootPrefix) {
        segments.push('..');
      }
      continue;
    }

    segments.push(segment);
  }

  let rootPrefix = '';
  if (drivePrefix) {
    rootPrefix = hasAbsoluteDrivePrefix ? `${drivePrefix}/` : drivePrefix;
  } else if (hasNetworkPrefix) {
    rootPrefix = '//';
  } else if (normalizedPath.startsWith('/')) {
    rootPrefix = '/';
  }
  if (segments.length === 0) {
    if (!rootPrefix) {
      return '.';
    }

    return rootPrefix;
  }

  if (!rootPrefix) {
    return segments.join('/');
  }

  return `${rootPrefix}${segments.join('/')}`;
}

function isSelectedRootMatchingRepoRoot(selectedPath: string, repoRoot: string): boolean {
  return normalizeProjectPath(selectedPath) === normalizeProjectPath(repoRoot);
}

function getProjectNameFromPath(projectPath: string): string {
  const normalizedPath = normalizeProjectPath(projectPath);
  const lastSeparatorIndex = normalizedPath.lastIndexOf('/');
  if (lastSeparatorIndex === -1) {
    return normalizedPath;
  }

  const projectName = normalizedPath.slice(lastSeparatorIndex + 1);
  return projectName.length > 0 ? projectName : projectPath;
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

function getCloneFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ValidatedProjectRoot {
  path: string;
  projectMode: ProjectMode;
}

function addProjectFromPath(projectPath: string, projectMode: ProjectMode = 'git'): string {
  const projectName = getProjectNameFromPath(projectPath);
  if (projectMode === 'git') {
    return addProject(projectName, projectPath);
  }

  return addProject(projectName, projectPath, { projectMode });
}

async function persistProjectRemovalBestEffort(projectId: string): Promise<void> {
  try {
    await saveCurrentRuntimeState();
  } catch (error) {
    console.warn(`Failed to persist project removal for ${projectId}:`, error);
  }
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

async function confirmAddNonGitProject(selectedPath: string): Promise<boolean> {
  return confirm(
    [
      'The selected folder is not a git repository.',
      '',
      'Add it as a non-git project? Agents can work in the folder, but review, branch, merge, and changed-file features will be unavailable.',
      '',
      `Folder: ${selectedPath}`,
    ].join('\n'),
    {
      cancelLabel: 'Cancel',
      kind: 'warning',
      okLabel: 'Add non-git project',
      title: 'Add non-git project',
    },
  );
}

async function validateSelectedProjectRoot(
  selectedPath: string,
): Promise<ValidatedProjectRoot | null> {
  const repoRoot = await invoke(IPC.GetGitRepoRoot, { path: selectedPath });
  if (repoRoot === null) {
    const approved = await confirmAddNonGitProject(selectedPath);
    return approved ? { path: selectedPath, projectMode: 'non-git' } : null;
  }

  if (!isSelectedRootMatchingRepoRoot(selectedPath, repoRoot)) {
    await showInvalidProjectRootDialog(selectedPath, repoRoot);
    return null;
  }

  return { path: selectedPath, projectMode: 'git' };
}

async function pickValidatedProjectRoot(): Promise<ValidatedProjectRoot | null> {
  const projectPath = await openDialog({ directory: true, multiple: false });
  if (!projectPath) {
    return null;
  }

  return validateSelectedProjectRoot(projectPath);
}

function getProjectTaskIds(projectId: string): string[] {
  return [...new Set([...store.taskOrder, ...store.collapsedTaskOrder])].filter(
    (taskId) => store.tasks[taskId]?.projectId === projectId,
  );
}

async function confirmCloneHostKey(
  hostname: string,
  port: number,
  fingerprint: string,
): Promise<boolean> {
  return confirm(
    [
      `The authenticity of host '${hostname}' (port ${port}) can't be established.`,
      '',
      fingerprint,
      '',
      'Are you sure you want to continue connecting?',
    ].join('\n'),
    { title: 'SSH Host Key Verification', okLabel: 'Trust & Connect', cancelLabel: 'Cancel' },
  );
}

async function showCloneFailedDialog(error: unknown): Promise<void> {
  await confirm(getCloneFailureMessage(error), {
    kind: 'warning',
    title: 'Clone failed',
    okLabel: 'OK',
    cancelLabel: 'Close',
  });
}

async function cloneAndAddProject(url: string): Promise<string | null> {
  try {
    let result = await invoke(IPC.CloneGitRepo, { url });

    switch (result.status) {
      case 'host_key_confirmation_required': {
        const approved = await confirmCloneHostKey(
          result.hostname,
          result.port,
          result.fingerprint,
        );
        if (!approved) {
          return null;
        }

        result = await invoke(IPC.CloneGitRepo, { url, acceptHostKey: true });
        break;
      }
      case 'cloned':
        break;
      default:
        return assertNever(result, 'Unexpected clone result status');
    }

    switch (result.status) {
      case 'cloned':
        return addProjectFromPath(result.repoRoot);
      case 'host_key_confirmation_required':
        return null;
      default:
        return assertNever(result, 'Unexpected clone result status');
    }
  } catch (error) {
    await showCloneFailedDialog(error);
    return null;
  }
}

export async function pickAndAddProject(): Promise<string | null> {
  const selectedPath = await openDialog({
    allowSshClone: true,
    directory: true,
    multiple: false,
    suppressRecentProjects: true,
  });
  if (!selectedPath) {
    return null;
  }

  if (isGitSshUrl(selectedPath)) {
    return cloneAndAddProject(selectedPath);
  }

  const projectRoot = await validateSelectedProjectRoot(selectedPath);
  if (!projectRoot) {
    return null;
  }

  return addProjectFromPath(projectRoot.path, projectRoot.projectMode);
}

/**
 * Add a project the user picked from the discovered-projects proposal. Resolves the git repo root
 * (snapping a session subdirectory up to its repository), dedupes against already-added projects,
 * and adds non-git folders without the extra confirm prompt since the choice was explicit.
 */
export async function addDiscoveredProject(discoveredPath: string): Promise<string | null> {
  const repoRoot = await invoke(IPC.GetGitRepoRoot, { path: discoveredPath });
  const targetPath = repoRoot ?? discoveredPath;
  const projectMode: ProjectMode = repoRoot ? 'git' : 'non-git';

  const existingProject = store.projects.find((project) =>
    isSelectedRootMatchingRepoRoot(project.path, targetPath),
  );
  if (existingProject) {
    return existingProject.id;
  }

  return addProjectFromPath(targetPath, projectMode);
}

export async function relinkProject(projectId: string): Promise<boolean> {
  const projectRoot = await pickValidatedProjectRoot();
  if (!projectRoot) {
    return false;
  }

  setProjectPath(projectId, projectRoot.path);
  const currentProject = store.projects.find((project) => project.id === projectId);
  if (getProjectMode(currentProject) !== projectRoot.projectMode) {
    updateProject(projectId, { projectMode: projectRoot.projectMode });
  }
  clearMissingProject(projectId);
  await saveCurrentRuntimeState();
  return true;
}

export async function removeProjectWithTasks(projectId: string): Promise<void> {
  const projectTaskIds = getProjectTaskIds(projectId);
  const taskIdsWithUnsavedNotes = new Set(
    projectTaskIds.filter((taskId) => hasUnsavedDesktopTaskNotes(taskId)),
  );
  if (
    taskIdsWithUnsavedNotes.size > 0 &&
    !(await confirm(
      taskIdsWithUnsavedNotes.size === 1
        ? 'Removing this project will discard unsaved task notes in 1 task. Continue?'
        : `Removing this project will discard unsaved task notes in ${taskIdsWithUnsavedNotes.size} tasks. Continue?`,
      {
        cancelLabel: 'Keep project',
        kind: 'warning',
        okLabel: 'Discard notes and remove',
        title: 'Discard unsaved task notes?',
      },
    ))
  ) {
    return;
  }

  for (const taskId of projectTaskIds) {
    await closeTask(taskId, {
      taskNotesDiscardConfirmed: taskIdsWithUnsavedNotes.has(taskId),
    });
  }

  const hasRemainingTasks = projectTaskIds.some((taskId) => {
    const task = store.tasks[taskId];
    return task?.projectId === projectId && !isTaskRemoving(task);
  });
  if (hasRemainingTasks) {
    return;
  }

  removeProject(projectId);
  await persistProjectRemovalBestEffort(projectId);
}
