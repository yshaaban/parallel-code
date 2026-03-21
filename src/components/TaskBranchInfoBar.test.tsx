import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../store/types';

const {
  openInEditorMock,
  revealItemInDirMock,
  showNotificationMock,
  windowOpenMock,
  writeTextMock,
} = vi.hoisted(() => ({
  openInEditorMock: vi.fn(),
  revealItemInDirMock: vi.fn(),
  showNotificationMock: vi.fn(),
  windowOpenMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock('../lib/shell', () => ({
  openInEditor: openInEditorMock,
  revealItemInDir: revealItemInDirMock,
}));

vi.mock('../store/store', () => ({
  showNotification: showNotificationMock,
}));

import { TaskBranchInfoBar } from './TaskBranchInfoBar';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    agentIds: [],
    branchName: 'task/example',
    collapsed: false,
    directMode: false,
    githubUrl: 'https://github.com/example/repo',
    id: 'task-1',
    name: 'Task',
    projectId: 'project-1',
    shellAgentIds: [],
    worktreePath: '/tmp/worktree',
    ...overrides,
  } as Task;
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    color: '#fff',
    id: 'project-1',
    name: 'Project',
    path: '/tmp/project',
    ...overrides,
  };
}

describe('TaskBranchInfoBar', () => {
  const originalClipboard = navigator.clipboard;
  const originalWindowOpen = window.open;

  beforeEach(() => {
    vi.clearAllMocks();
    openInEditorMock.mockResolvedValue(undefined);
    revealItemInDirMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    });
    Object.defineProperty(window, 'open', {
      configurable: true,
      value: windowOpenMock,
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    });
    Object.defineProperty(window, 'open', {
      configurable: true,
      value: originalWindowOpen,
    });
  });

  it('opens the editor only from the branch and folder buttons', async () => {
    render(() => (
      <TaskBranchInfoBar
        editorCommand="code"
        electronRuntime
        onEditProject={vi.fn()}
        project={createProject()}
        task={createTask()}
      />
    ));

    fireEvent.click(screen.getByText('Project'));
    fireEvent.click(screen.getByText('example/repo'));
    expect(openInEditorMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('task/example'));
    await waitFor(() => {
      expect(openInEditorMock).toHaveBeenCalledWith('code', '/tmp/worktree');
    });

    fireEvent.click(screen.getByText('/tmp/worktree'));
    await waitFor(() => {
      expect(openInEditorMock).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps the project and GitHub actions on their own buttons', async () => {
    const onEditProject = vi.fn();

    render(() => (
      <TaskBranchInfoBar
        editorCommand="code"
        electronRuntime
        onEditProject={onEditProject}
        project={createProject()}
        task={createTask()}
      />
    ));

    fireEvent.click(screen.getByText('Project'));
    expect(onEditProject).toHaveBeenCalledTimes(1);
    expect(openInEditorMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('example/repo'));

    await waitFor(() => {
      expect(windowOpenMock).toHaveBeenCalledWith('https://github.com/example/repo', '_blank');
    });
    expect(openInEditorMock).not.toHaveBeenCalled();
  });

  it('reveals the worktree in the file manager on modifier click', async () => {
    render(() => (
      <TaskBranchInfoBar
        editorCommand="code"
        electronRuntime
        onEditProject={vi.fn()}
        project={createProject()}
        task={createTask()}
      />
    ));

    fireEvent.click(screen.getByText('task/example'), { ctrlKey: true });

    await waitFor(() => {
      expect(revealItemInDirMock).toHaveBeenCalledWith('/tmp/worktree');
    });
    expect(openInEditorMock).not.toHaveBeenCalled();
  });

  it('copies the worktree path from the branch and folder buttons in browser mode', async () => {
    writeTextMock.mockResolvedValue(undefined);

    render(() => (
      <TaskBranchInfoBar
        editorCommand=""
        electronRuntime={false}
        onEditProject={vi.fn()}
        project={createProject()}
        task={createTask()}
      />
    ));

    fireEvent.click(screen.getByText('task/example'));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('/tmp/worktree');
    });

    fireEvent.click(screen.getByText('/tmp/worktree'));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(2);
      expect(showNotificationMock).toHaveBeenCalledWith('Worktree path copied');
    });
  });
});
