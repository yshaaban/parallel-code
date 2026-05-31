import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addProjectMock,
  clearMissingProjectMock,
  closeTaskMock,
  confirmMock,
  invokeMock,
  openDialogMock,
  removeProjectMock,
  saveCurrentRuntimeStateMock,
  setProjectPathMock,
  updateProjectMock,
} = vi.hoisted(() => ({
  addProjectMock: vi.fn(),
  clearMissingProjectMock: vi.fn(),
  closeTaskMock: vi.fn(),
  confirmMock: vi.fn(),
  invokeMock: vi.fn(),
  openDialogMock: vi.fn(),
  removeProjectMock: vi.fn(),
  saveCurrentRuntimeStateMock: vi.fn(),
  setProjectPathMock: vi.fn(),
  updateProjectMock: vi.fn(),
}));

vi.mock('../lib/dialog', () => ({
  confirm: confirmMock,
  openDialog: openDialogMock,
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../store/projects', () => ({
  addProject: addProjectMock,
  clearMissingProject: clearMissingProjectMock,
  removeProject: removeProjectMock,
  setProjectPath: setProjectPathMock,
  updateProject: updateProjectMock,
}));

vi.mock('../store/persistence-save', () => ({
  saveCurrentRuntimeState: saveCurrentRuntimeStateMock,
}));

vi.mock('./task-workflows', () => ({
  closeTask: closeTaskMock,
}));

import { IPC } from '../../electron/ipc/channels';
import { setStore } from '../store/core';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';
import {
  addDiscoveredProject,
  pickAndAddProject,
  relinkProject,
  removeProjectWithTasks,
} from './project-workflows';

function seedProjectWithTask(): void {
  setStore('projects', [createTestProject({ id: 'project-1' })]);
  setStore('tasks', {
    'task-1': createTestTask({
      id: 'task-1',
      projectId: 'project-1',
    }),
  });
  setStore('taskOrder', ['task-1']);
}

describe('project workflows', () => {
  beforeEach(() => {
    resetStoreForTest();
    vi.clearAllMocks();
    addProjectMock.mockReturnValue('project-1');
    closeTaskMock.mockResolvedValue(undefined);
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);
  });

  it('adds a project when the selected folder is the git repo root', async () => {
    openDialogMock.mockResolvedValue('/repo/project');
    invokeMock.mockResolvedValue('/repo/project');

    await expect(pickAndAddProject()).resolves.toBe('project-1');

    expect(openDialogMock).toHaveBeenCalledWith({
      allowSshClone: true,
      directory: true,
      multiple: false,
      suppressRecentProjects: true,
    });
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetGitRepoRoot, {
      path: '/repo/project',
    });
    expect(addProjectMock).toHaveBeenCalledWith('project', '/repo/project');
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('adds a project when the selected folder path includes redundant segments', async () => {
    openDialogMock.mockResolvedValue('C:\\repo\\project\\.\\');
    invokeMock.mockResolvedValue('c:/repo/project');

    await expect(pickAndAddProject()).resolves.toBe('project-1');

    expect(addProjectMock).toHaveBeenCalledWith('project', 'C:\\repo\\project\\.\\');
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('clones an SSH repository and adds it as a project', async () => {
    openDialogMock.mockResolvedValue('git@github.com:user/repo.git');
    invokeMock.mockResolvedValue({
      status: 'cloned',
      repoRoot: '/home/user/repo',
    });

    await expect(pickAndAddProject()).resolves.toBe('project-1');

    expect(invokeMock).toHaveBeenCalledWith(IPC.CloneGitRepo, {
      url: 'git@github.com:user/repo.git',
    });
    expect(addProjectMock).toHaveBeenCalledWith('repo', '/home/user/repo');
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('confirms the SSH host key before retrying a clone', async () => {
    openDialogMock.mockResolvedValue('git@gitlab.example.com:team/repo.git');
    invokeMock
      .mockResolvedValueOnce({
        status: 'host_key_confirmation_required',
        hostname: 'gitlab.example.com',
        port: 22,
        fingerprint: 'SHA256:abcdef',
      })
      .mockResolvedValueOnce({
        status: 'cloned',
        repoRoot: '/home/user/repo',
      });
    confirmMock.mockResolvedValue(true);

    await expect(pickAndAddProject()).resolves.toBe('project-1');

    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining("The authenticity of host 'gitlab.example.com'"),
      expect.objectContaining({
        title: 'SSH Host Key Verification',
      }),
    );
    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.CloneGitRepo, {
      url: 'git@gitlab.example.com:team/repo.git',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.CloneGitRepo, {
      url: 'git@gitlab.example.com:team/repo.git',
      acceptHostKey: true,
    });
  });

  it('cancels an SSH clone when the host key is not approved', async () => {
    openDialogMock.mockResolvedValue('git@gitlab.example.com:team/repo.git');
    invokeMock.mockResolvedValue({
      status: 'host_key_confirmation_required',
      hostname: 'gitlab.example.com',
      port: 22,
      fingerprint: 'SHA256:abcdef',
    });
    confirmMock.mockResolvedValue(false);

    await expect(pickAndAddProject()).resolves.toBeNull();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(addProjectMock).not.toHaveBeenCalled();
  });

  it('shows a warning when SSH clone fails', async () => {
    openDialogMock.mockResolvedValue('git@github.com:user/repo.git');
    invokeMock.mockRejectedValue(new Error('git is not installed'));

    await expect(pickAndAddProject()).resolves.toBeNull();

    expect(confirmMock).toHaveBeenCalledWith(
      'git is not installed',
      expect.objectContaining({
        kind: 'warning',
        title: 'Clone failed',
      }),
    );
    expect(addProjectMock).not.toHaveBeenCalled();
  });

  it('shows warning feedback and rejects nested project folders', async () => {
    openDialogMock.mockResolvedValue('/repo/project/packages/web');
    invokeMock.mockResolvedValue('/repo/project');

    await expect(pickAndAddProject()).resolves.toBeNull();

    expect(addProjectMock).not.toHaveBeenCalled();
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining('it is not the repository root'),
      expect.objectContaining({
        kind: 'warning',
        title: 'Invalid project folder',
      }),
    );
  });

  it('adds a discovered git project without opening the picker', async () => {
    invokeMock.mockResolvedValue('/repo/project');

    await expect(addDiscoveredProject('/repo/project')).resolves.toBe('project-1');

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetGitRepoRoot, {
      path: '/repo/project',
    });
    expect(openDialogMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(addProjectMock).toHaveBeenCalledWith('project', '/repo/project');
  });

  it('dedupes discovered subdirectories against an already-added repo root', async () => {
    setStore('projects', [createTestProject({ id: 'existing-project', path: '/repo/project' })]);
    invokeMock.mockResolvedValue('/repo/project');

    await expect(addDiscoveredProject('/repo/project/packages/web')).resolves.toBe(
      'existing-project',
    );

    expect(addProjectMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('adds an explicit discovered non-git folder without an extra confirmation prompt', async () => {
    invokeMock.mockResolvedValue(null);

    await expect(addDiscoveredProject('/tmp/notes')).resolves.toBe('project-1');

    expect(confirmMock).not.toHaveBeenCalled();
    expect(addProjectMock).toHaveBeenCalledWith('notes', '/tmp/notes', {
      projectMode: 'non-git',
    });
  });

  it('relinks a project only when the new folder is the repo root', async () => {
    openDialogMock.mockResolvedValue('/repo/project');
    invokeMock.mockResolvedValue('/repo/project');

    await expect(relinkProject('project-1')).resolves.toBe(true);

    expect(openDialogMock).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
    });
    expect(setProjectPathMock).toHaveBeenCalledWith('project-1', '/repo/project');
    expect(clearMissingProjectMock).toHaveBeenCalledWith('project-1');
    expect(saveCurrentRuntimeStateMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('adds an explicit non-git project when the selected folder is not a git repository', async () => {
    openDialogMock.mockResolvedValue('/tmp/not-a-repo');
    invokeMock.mockResolvedValue(null);
    confirmMock.mockResolvedValue(true);

    await expect(pickAndAddProject()).resolves.toBe('project-1');

    expect(addProjectMock).toHaveBeenCalledWith('not-a-repo', '/tmp/not-a-repo', {
      projectMode: 'non-git',
    });
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining('Add it as a non-git project?'),
      expect.objectContaining({
        title: 'Add non-git project',
      }),
    );
  });

  it('keeps the old project path when relink rejects a non-git folder', async () => {
    openDialogMock.mockResolvedValue('/tmp/not-a-repo');
    invokeMock.mockResolvedValue(null);
    confirmMock.mockResolvedValue(false);

    await expect(relinkProject('project-1')).resolves.toBe(false);

    expect(setProjectPathMock).not.toHaveBeenCalled();
    expect(clearMissingProjectMock).not.toHaveBeenCalled();
    expect(saveCurrentRuntimeStateMock).not.toHaveBeenCalled();
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining('Add it as a non-git project?'),
      expect.objectContaining({
        kind: 'warning',
        title: 'Add non-git project',
      }),
    );
  });

  it('removes a project after its tasks have entered the removing state', async () => {
    seedProjectWithTask();
    closeTaskMock.mockImplementation(async (taskId: string) => {
      setStore('tasks', taskId, 'closeState', { kind: 'removing' });
    });

    await removeProjectWithTasks('project-1');

    expect(closeTaskMock).toHaveBeenCalledWith('task-1');
    expect(removeProjectMock).toHaveBeenCalledWith('project-1');
    expect(saveCurrentRuntimeStateMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a project when one of its tasks failed to close', async () => {
    seedProjectWithTask();
    closeTaskMock.mockImplementation(async (taskId: string) => {
      setStore('tasks', taskId, 'closeState', { kind: 'error', message: 'Delete failed' });
    });

    await removeProjectWithTasks('project-1');

    expect(closeTaskMock).toHaveBeenCalledWith('task-1');
    expect(removeProjectMock).not.toHaveBeenCalled();
    expect(saveCurrentRuntimeStateMock).not.toHaveBeenCalled();
  });
});
