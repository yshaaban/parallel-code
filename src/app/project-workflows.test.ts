import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addProjectMock,
  clearMissingProjectMock,
  confirmMock,
  invokeMock,
  openDialogMock,
  saveCurrentRuntimeStateMock,
  setProjectPathMock,
} = vi.hoisted(() => ({
  addProjectMock: vi.fn(),
  clearMissingProjectMock: vi.fn(),
  confirmMock: vi.fn(),
  invokeMock: vi.fn(),
  openDialogMock: vi.fn(),
  saveCurrentRuntimeStateMock: vi.fn(),
  setProjectPathMock: vi.fn(),
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
  removeProject: vi.fn(),
  setProjectPath: setProjectPathMock,
}));

vi.mock('../store/persistence-save', () => ({
  saveCurrentRuntimeState: saveCurrentRuntimeStateMock,
}));

vi.mock('./task-workflows', () => ({
  closeTask: vi.fn(),
}));

import { IPC } from '../../electron/ipc/channels';
import { pickAndAddProject, relinkProject } from './project-workflows';

describe('project workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addProjectMock.mockReturnValue('project-1');
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);
  });

  it('adds a project when the selected folder is the git repo root', async () => {
    openDialogMock.mockResolvedValue('/repo/project');
    invokeMock.mockResolvedValue('/repo/project');

    await expect(pickAndAddProject()).resolves.toBe('project-1');

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

  it('relinks a project only when the new folder is the repo root', async () => {
    openDialogMock.mockResolvedValue('/repo/project');
    invokeMock.mockResolvedValue('/repo/project');

    await expect(relinkProject('project-1')).resolves.toBe(true);

    expect(setProjectPathMock).toHaveBeenCalledWith('project-1', '/repo/project');
    expect(clearMissingProjectMock).toHaveBeenCalledWith('project-1');
    expect(saveCurrentRuntimeStateMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('keeps the old project path when relink selects a non-git folder', async () => {
    openDialogMock.mockResolvedValue('/tmp/not-a-repo');
    invokeMock.mockResolvedValue(null);

    await expect(relinkProject('project-1')).resolves.toBe(false);

    expect(setProjectPathMock).not.toHaveBeenCalled();
    expect(clearMissingProjectMock).not.toHaveBeenCalled();
    expect(saveCurrentRuntimeStateMock).not.toHaveBeenCalled();
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining('not a git repository root'),
      expect.objectContaining({
        kind: 'warning',
        title: 'Invalid project folder',
      }),
    );
  });
});
