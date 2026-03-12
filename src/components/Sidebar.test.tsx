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
    setPanelSizes: vi.fn(),
    toggleNewTaskDialog: toggleNewTaskDialogMock,
    toggleSettingsDialog: toggleSettingsDialogMock,
    toggleSidebar: toggleSidebarMock,
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
});
