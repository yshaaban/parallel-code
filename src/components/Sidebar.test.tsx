import { fireEvent, render, screen } from '@solidjs/testing-library';
import { Show, type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

const {
  focusSidebarMock,
  isElectronRuntimeMock,
  pickAndAddProjectMock,
  removeProjectMock,
  removeProjectWithTasksMock,
  reorderTaskMock,
  setActiveTaskMock,
  setTaskFocusedPanelMock,
  uncollapseTaskMock,
  unfocusSidebarMock,
  toggleNewTaskDialogMock,
  toggleSettingsDialogMock,
  toggleSidebarMock,
} = vi.hoisted(() => ({
  focusSidebarMock: vi.fn(),
  isElectronRuntimeMock: vi.fn(),
  pickAndAddProjectMock: vi.fn(),
  removeProjectMock: vi.fn(),
  removeProjectWithTasksMock: vi.fn(),
  reorderTaskMock: vi.fn(),
  setActiveTaskMock: vi.fn(),
  setTaskFocusedPanelMock: vi.fn(),
  uncollapseTaskMock: vi.fn(),
  unfocusSidebarMock: vi.fn(),
  toggleNewTaskDialogMock: vi.fn(),
  toggleSettingsDialogMock: vi.fn(),
  toggleSidebarMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  isElectronRuntime: isElectronRuntimeMock,
}));

vi.mock('./IconButton', () => ({
  IconButton: (props: { onClick: () => void; title: string }) => (
    <button onClick={() => props.onClick()}>{props.title}</button>
  ),
}));

vi.mock('./SidebarFooter', () => ({
  SidebarFooter: () => <div>Footer</div>,
}));

vi.mock('./sidebar/SidebarProjectsSection', () => ({
  SidebarProjectsSection: (props: {
    onAddProject: () => void;
    onEditProject: (project: unknown) => void;
    onRemoveProject: (projectId: string) => void;
  }) => (
    <div>
      <button onClick={() => props.onAddProject()}>Add project</button>
      <button onClick={() => props.onEditProject(null)}>Edit project</button>
      <button onClick={() => props.onRemoveProject('project-1')}>Remove project</button>
    </div>
  ),
}));

vi.mock('./sidebar/SidebarTaskList', () => ({
  SidebarTaskList: (props: { setTaskListRef: (el: HTMLDivElement) => void }) => (
    <div
      ref={(element) => {
        props.setTaskListRef(element);
      }}
      data-testid="sidebar-task-list"
      tabIndex={0}
    />
  ),
}));

vi.mock('./sidebar/SidebarRemoteAccessButton', () => ({
  SidebarRemoteAccessButton: (props: { connected: boolean; onClick: () => void }) => (
    <button onClick={() => props.onClick()}>
      {props.connected ? 'Remote access connected' : 'Remote access idle'}
    </button>
  ),
}));

vi.mock('./ConnectPhoneModal', () => ({
  ConnectPhoneModal: (props: { open: boolean; onClose: () => void }) => (
    <Show when={props.open}>
      <div>Connect phone modal</div>
    </Show>
  ),
}));

vi.mock('./EditProjectDialog', () => ({
  EditProjectDialog: () => null,
}));

vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: (props: {
    open: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    title: string;
  }): JSX.Element => (
    <Show when={props.open}>
      <div>
        <div>{props.title}</div>
        <button onClick={() => props.onConfirm()}>Confirm remove</button>
        <button onClick={() => props.onCancel()}>Cancel</button>
      </div>
    </Show>
  ),
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    store: core.store,
    focusSidebar: focusSidebarMock,
    getPanelSize: vi.fn(),
    pickAndAddProject: pickAndAddProjectMock,
    registerFocusFn: vi.fn(),
    removeProject: removeProjectMock,
    removeProjectWithTasks: removeProjectWithTasksMock,
    reorderTask: reorderTaskMock,
    setActiveTask: setActiveTaskMock,
    setTaskFocusedPanel: setTaskFocusedPanelMock,
    setPanelSizes: vi.fn(),
    toggleNewTaskDialog: toggleNewTaskDialogMock,
    toggleSettingsDialog: toggleSettingsDialogMock,
    toggleSidebar: toggleSidebarMock,
    uncollapseTask: uncollapseTaskMock,
    unfocusSidebar: unfocusSidebarMock,
    unregisterFocusFn: vi.fn(),
  };
});

import { Sidebar } from './Sidebar';

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    isElectronRuntimeMock.mockReturnValue(false);
  });

  it('links a project when none exist', () => {
    render(() => <Sidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'Link Project' }));

    expect(pickAndAddProjectMock).toHaveBeenCalledTimes(1);
  });

  it('opens the new-task flow and remote-access modal when projects exist', async () => {
    setStore('projects', [createTestProject()]);

    render(() => <Sidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
    expect(toggleNewTaskDialogMock).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Remote access idle' }));
    expect(await screen.findByText('Connect phone modal')).toBeDefined();
  });

  it('confirms project removal when the project still has tasks', async () => {
    setStore('projects', [createTestProject()]);
    setStore('tasks', {
      'task-1': createTestTask(),
    });
    setStore('taskOrder', ['task-1']);

    render(() => <Sidebar />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove project' }));
    expect(await screen.findByText('Remove project?')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    expect(removeProjectWithTasksMock).toHaveBeenCalledWith('project-1');
    expect(removeProjectMock).not.toHaveBeenCalled();
  });

  it('shows the review queue and activates the task from a queue entry', async () => {
    setStore('projects', [createTestProject()]);
    setStore('tasks', {
      'task-1': createTestTask({
        id: 'task-1',
        name: 'Review ready task',
      }),
    });
    setStore('taskOrder', ['task-1']);
    setStore('taskConvergence', {
      'task-1': {
        branchFiles: ['src/feature.ts'],
        branchName: 'feature/task-1',
        changedFileCount: 1,
        commitCount: 2,
        conflictingFiles: [],
        hasCommittedChanges: true,
        hasUncommittedChanges: false,
        mainAheadCount: 0,
        overlapWarnings: [],
        projectId: 'project-1',
        state: 'review-ready',
        summary: '2 commits, 1 file changed',
        taskId: 'task-1',
        totalAdded: 5,
        totalRemoved: 1,
        updatedAt: Date.now(),
        worktreePath: '/tmp/project/task-1',
      },
    });

    render(() => <Sidebar />);

    expect(screen.getByText('Review Queue')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Review ready task/i }));

    expect(setActiveTaskMock).toHaveBeenCalledWith('task-1');
  });

  it('restores a collapsed task from the review queue before opening review', async () => {
    setStore('projects', [createTestProject()]);
    setStore('tasks', {
      'task-1': createTestTask({
        id: 'task-1',
        name: 'Collapsed task',
        collapsed: true,
      }),
    });
    setStore('collapsedTaskOrder', ['task-1']);
    setStore('taskConvergence', {
      'task-1': {
        branchFiles: ['src/feature.ts'],
        branchName: 'feature/task-1',
        changedFileCount: 1,
        commitCount: 1,
        conflictingFiles: [],
        hasCommittedChanges: true,
        hasUncommittedChanges: false,
        mainAheadCount: 0,
        overlapWarnings: [],
        projectId: 'project-1',
        state: 'review-ready',
        summary: '1 commit, 1 file changed',
        taskId: 'task-1',
        totalAdded: 2,
        totalRemoved: 0,
        updatedAt: Date.now(),
        worktreePath: '/tmp/project/task-1',
      },
    });

    render(() => <Sidebar />);

    fireEvent.click(screen.getByRole('button', { name: /Collapsed task/i }));

    expect(uncollapseTaskMock).toHaveBeenCalledWith('task-1');
    expect(setActiveTaskMock).not.toHaveBeenCalledWith('task-1');
  });
});
