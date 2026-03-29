import { IPC } from '../../electron/ipc/channels';
import { confirm, openDialog } from '../lib/dialog';
import { invoke } from '../lib/ipc';
import { addProject, clearMissingProject, removeProject, setProjectPath } from '../store/projects';
import { saveCurrentRuntimeState } from '../store/persistence-save';
import { store } from '../store/state';
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

async function pickValidatedProjectRoot(): Promise<string | null> {
  const projectPath = await openDialog({ directory: true, multiple: false });
  if (!projectPath) {
    return null;
  }

  const repoRoot = await invoke(IPC.GetGitRepoRoot, { path: projectPath });
  if (repoRoot === null || !isSelectedRootMatchingRepoRoot(projectPath, repoRoot)) {
    await showInvalidProjectRootDialog(projectPath, repoRoot);
    return null;
  }

  return projectPath;
}

function getProjectTaskIds(projectId: string): string[] {
  return [...new Set([...store.taskOrder, ...store.collapsedTaskOrder])].filter(
    (taskId) => store.tasks[taskId]?.projectId === projectId,
  );
}

import { isGitSshUrl } from '../../electron/ipc/git-ssh-url';

export async function pickAndAddProject(): Promise<string | null> {
  const selectedPath = await openDialog({ allowSshClone: true, directory: true, multiple: false });
  if (!selectedPath) {
    return null;
  }

  if (isGitSshUrl(selectedPath)) {
    try {
      let result = await invoke(IPC.CloneGitRepo, { url: selectedPath });

      if (result.status === 'host_key_confirmation_required') {
        const approved = await confirm(
          [
            `The authenticity of host '${result.hostname}' (port ${result.port}) can't be established.`,
            '',
            result.fingerprint,
            '',
            'Are you sure you want to continue connecting?',
          ].join('\n'),
          { title: 'SSH Host Key Verification', okLabel: 'Trust & Connect', cancelLabel: 'Cancel' },
        );

        if (!approved) {
          return null;
        }

        result = await invoke(IPC.CloneGitRepo, { url: selectedPath, acceptHostKey: true });
      }

      if (result.status === 'cloned') {
        return addProject(getProjectNameFromPath(result.repoRoot), result.repoRoot);
      }

      return null;
    } catch (error) {
      await confirm(error instanceof Error ? error.message : String(error), {
        kind: 'warning',
        title: 'Clone failed',
        okLabel: 'OK',
        cancelLabel: 'Close',
      });
      return null;
    }
  }

  const repoRoot = await invoke(IPC.GetGitRepoRoot, { path: selectedPath });
  if (repoRoot === null || !isSelectedRootMatchingRepoRoot(selectedPath, repoRoot)) {
    await showInvalidProjectRootDialog(selectedPath, repoRoot);
    return null;
  }

  return addProject(getProjectNameFromPath(selectedPath), selectedPath);
}

export async function relinkProject(projectId: string): Promise<boolean> {
  const projectPath = await pickValidatedProjectRoot();
  if (!projectPath) {
    return false;
  }

  setProjectPath(projectId, projectPath);
  clearMissingProject(projectId);
  await saveCurrentRuntimeState();
  return true;
}

export async function removeProjectWithTasks(projectId: string): Promise<void> {
  const projectTaskIds = getProjectTaskIds(projectId);
  for (const taskId of projectTaskIds) {
    await closeTask(taskId);
  }

  const hasRemainingTasks = projectTaskIds.some(
    (taskId) => store.tasks[taskId]?.projectId === projectId,
  );
  if (hasRemainingTasks) {
    return;
  }

  removeProject(projectId);
}
