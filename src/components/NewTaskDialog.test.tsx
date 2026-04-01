import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { createSignal, Show, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import {
  createTestAgentDef,
  createTestProject,
  resetStoreForTest,
} from '../test/store-test-helpers';

const {
  createCurrentBranchTaskMock,
  createTaskMock,
  hasCurrentBranchTaskMock,
  invokeMock,
  loadAgentsMock,
  toggleNewTaskDialogMock,
  updateProjectMock,
} = vi.hoisted(() => ({
  createCurrentBranchTaskMock: vi.fn(),
  createTaskMock: vi.fn(),
  hasCurrentBranchTaskMock: vi.fn(() => false),
  invokeMock: vi.fn(),
  loadAgentsMock: vi.fn(),
  toggleNewTaskDialogMock: vi.fn(),
  updateProjectMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('./Dialog', () => ({
  Dialog: (props: { children: JSX.Element; open: boolean; width?: string }) => (
    <Show when={props.open}>
      <div data-dialog-width={props.width}>{props.children}</div>
    </Show>
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
    toggleNewTaskDialog: toggleNewTaskDialogMock,
    getProject: (projectId: string) =>
      core.store.projects.find((project) => project.id === projectId) ?? null,
    getProjectPath: (projectId: string) =>
      core.store.projects.find((project) => project.id === projectId)?.path,
    getProjectBaseBranch: (projectId: string) =>
      core.store.projects.find((project) => project.id === projectId)?.baseBranch,
    getProjectBranchPrefix: (projectId: string) =>
      core.store.projects.find((project) => project.id === projectId)?.branchPrefix ?? 'task',
    updateProject: updateProjectMock,
    hasCurrentBranchTask: hasCurrentBranchTaskMock,
    getGitHubDropDefaults: () => null,
    setPrefillPrompt: vi.fn(),
  };
});

vi.mock('../app/task-workflows', () => ({
  createCurrentBranchTask: createCurrentBranchTaskMock,
  createDirectTask: createCurrentBranchTaskMock,
  createTask: createTaskMock,
}));

vi.mock('../app/agent-catalog', () => ({
  loadAgents: loadAgentsMock,
}));

import { NewTaskDialog } from './NewTaskDialog';

describe('NewTaskDialog', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    resetStoreForTest();
    setStore('projects', [createTestProject()]);
    setStore('availableAgents', []);
    hasCurrentBranchTaskMock.mockReturnValue(false);
    loadAgentsMock.mockResolvedValue([
      createTestAgentDef({
        id: 'codex',
        name: 'Codex',
        skip_permissions_args: ['--yolo'],
      }),
    ]);
    invokeMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets dangerously skip confirms back to checked when the dialog reopens', async () => {
    const [open, setOpen] = createSignal(true);

    render(() => <NewTaskDialog open={open()} onClose={() => setOpen(false)} />);
    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    });

    const checkbox = await screen.findByRole('checkbox', {
      name: /Dangerously skip all confirms/i,
    });
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    setOpen(false);
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Dangerously skip all confirms/i })).toBeNull();
    });

    setOpen(true);
    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(2);
    });
    const reopenedCheckbox = await screen.findByRole('checkbox', {
      name: /Dangerously skip all confirms/i,
    });
    expect((reopenedCheckbox as HTMLInputElement).checked).toBe(true);
  });

  it('passes skipPermissions through task creation by default', async () => {
    createTaskMock.mockResolvedValue('task-1');

    render(() => <NewTaskDialog open onClose={() => {}} />);
    await screen.findByRole('checkbox', {
      name: /Dangerously skip all confirms/i,
    });
    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    });

    const taskNameInput = await screen.findByPlaceholderText('Add user authentication');
    fireEvent.input(taskNameInput, {
      target: { value: 'Ship it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

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

  it('clears current-branch mode when the selected project already has a current-branch task', async () => {
    hasCurrentBranchTaskMock.mockReturnValue(true);
    setStore('projects', [
      createTestProject({
        defaultTaskGitIsolation: 'current-branch',
        id: 'project-1',
        path: '/repo',
      }),
    ]);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    const currentBranchCheckbox = await screen.findByRole('checkbox', {
      name: /Work on current branch/i,
    });

    expect((currentBranchCheckbox as HTMLInputElement).checked).toBe(false);
    expect((currentBranchCheckbox as HTMLInputElement).disabled).toBe(true);
  });

  it('widens the dialog when many agents are available', async () => {
    const agents = Array.from({ length: 9 }, (_, index) =>
      createTestAgentDef({
        id: `agent-${index}`,
        name: `Agent ${index}`,
      }),
    );
    setStore('availableAgents', agents);
    loadAgentsMock.mockResolvedValue(agents);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    });

    expect(document.querySelector('[data-dialog-width="540px"]')).not.toBeNull();
  });

  it('passes the configured project base branch through current-branch task creation', async () => {
    const user = userEvent.setup();
    createCurrentBranchTaskMock.mockResolvedValue('task-1');
    setStore('projects', [createTestProject({ baseBranch: 'personal/main', path: '/repo' })]);
    render(() => <NewTaskDialog open onClose={() => {}} />);

    const currentBranchCheckbox = await screen.findByRole('checkbox', {
      name: /Work on current branch/i,
    });
    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    await user.click(currentBranchCheckbox);

    const taskNameInput = screen.getByPlaceholderText('Add user authentication');
    await user.type(taskNameInput, 'Ship it');

    await user.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(createCurrentBranchTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baseBranch: 'personal/main',
          name: 'Ship it',
          projectId: 'project-1',
        }),
      );
    });
  });
});
