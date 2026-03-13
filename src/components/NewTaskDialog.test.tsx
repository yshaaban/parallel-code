import { render, screen, waitFor } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { createSignal, Show, type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setStore } from '../store/core';
import {
  createTestAgentDef,
  createTestProject,
  resetStoreForTest,
} from '../test/store-test-helpers';

const {
  createDirectTaskMock,
  createTaskMock,
  invokeMock,
  loadAgentsMock,
  toggleNewTaskDialogMock,
  updateProjectMock,
} = vi.hoisted(() => ({
  createDirectTaskMock: vi.fn(),
  createTaskMock: vi.fn(),
  invokeMock: vi.fn(),
  loadAgentsMock: vi.fn(),
  toggleNewTaskDialogMock: vi.fn(),
  updateProjectMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('./Dialog', () => ({
  Dialog: (props: { children: JSX.Element; open: boolean }) => (
    <Show when={props.open}>{props.children}</Show>
  ),
}));

vi.mock('./AgentSelector', () => ({
  AgentSelector: () => <div>Agent selector</div>,
}));

vi.mock('./BranchPrefixField', () => ({
  BranchPrefixField: () => null,
}));

vi.mock('./ProjectSelect', () => ({
  ProjectSelect: () => <div>Project select</div>,
}));

vi.mock('./SymlinkDirPicker', () => ({
  SymlinkDirPicker: () => null,
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    store: core.store,
    createTask: createTaskMock,
    createDirectTask: createDirectTaskMock,
    toggleNewTaskDialog: toggleNewTaskDialogMock,
    loadAgents: loadAgentsMock,
    getProject: (projectId: string) =>
      core.store.projects.find((project) => project.id === projectId) ?? null,
    getProjectPath: (projectId: string) =>
      core.store.projects.find((project) => project.id === projectId)?.path,
    getProjectBranchPrefix: (projectId: string) =>
      core.store.projects.find((project) => project.id === projectId)?.branchPrefix ?? 'task',
    updateProject: updateProjectMock,
    hasDirectModeTask: () => false,
    getGitHubDropDefaults: () => null,
    setPrefillPrompt: vi.fn(),
  };
});

import { NewTaskDialog } from './NewTaskDialog';

describe('NewTaskDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    setStore('projects', [createTestProject()]);
    setStore('availableAgents', []);
    loadAgentsMock.mockResolvedValue([
      createTestAgentDef({
        id: 'codex',
        name: 'Codex',
        skip_permissions_args: ['--yolo'],
      }),
    ]);
    invokeMock.mockResolvedValue([]);
  });

  it('resets dangerously skip confirms back to checked when the dialog reopens', async () => {
    const user = userEvent.setup();
    const [open, setOpen] = createSignal(true);

    render(() => <NewTaskDialog open={open()} onClose={() => setOpen(false)} />);

    const checkbox = await screen.findByRole('checkbox', {
      name: /Dangerously skip all confirms/i,
    });
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    await user.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    setOpen(false);
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Dangerously skip all confirms/i })).toBeNull();
    });

    setOpen(true);
    const reopenedCheckbox = await screen.findByRole('checkbox', {
      name: /Dangerously skip all confirms/i,
    });
    expect((reopenedCheckbox as HTMLInputElement).checked).toBe(true);
  });

  it('passes skipPermissions through task creation by default', async () => {
    const user = userEvent.setup();
    createTaskMock.mockResolvedValue('task-1');

    render(() => <NewTaskDialog open onClose={() => {}} />);

    const taskNameInput = await screen.findByPlaceholderText('Add user authentication');
    await user.type(taskNameInput, 'Ship it');

    const submitButton = screen.getByRole('button', { name: 'Create Task' });
    await user.click(submitButton);

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Ship it',
          projectId: 'project-1',
          skipPermissions: true,
        }),
      );
    });
  });
});
