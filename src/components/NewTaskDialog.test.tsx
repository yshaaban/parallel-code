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
  createExistingWorktreeTaskMock,
  createTaskMock,
  hasCurrentBranchTaskMock,
  invokeMock,
  loadAgentsMock,
  toggleNewTaskDialogMock,
  updateProjectMock,
} = vi.hoisted(() => ({
  createCurrentBranchTaskMock: vi.fn(),
  createExistingWorktreeTaskMock: vi.fn(),
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
  AgentSelector: (props: { selectedAgent: { name: string } | null }) => (
    <div>Selected agent: {props.selectedAgent?.name ?? 'none'}</div>
  ),
}));

vi.mock('./BranchPrefixField', () => ({
  BranchPrefixField: (props: { conflictMessage?: string }) => (
    <div>
      <Show when={props.conflictMessage}>
        <div role="alert">{props.conflictMessage}</div>
      </Show>
    </div>
  ),
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
    getProjectMode: (project: { projectMode?: 'git' | 'non-git' } | null | undefined) =>
      project?.projectMode === 'non-git' ? 'non-git' : 'git',
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
  createExistingWorktreeTask: createExistingWorktreeTaskMock,
  createTask: createTaskMock,
}));

vi.mock('../app/agent-catalog', () => ({
  loadAgents: loadAgentsMock,
}));

import { NewTaskDialog } from './NewTaskDialog';

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

async function openAdvanced(): Promise<void> {
  const toggle = await screen.findByRole('button', { name: /^Advanced/i });
  if (toggle.getAttribute('aria-expanded') !== 'true') {
    fireEvent.click(toggle);
  }
}

function mockListBranches(localBranchNames: string[]): void {
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'list_branches') {
      return Promise.resolve({
        branches: localBranchNames.map((name, index) => ({
          current: index === 0,
          local: true,
          name,
          remote: name === 'main' || name === 'release/main',
        })),
        defaultBranch: 'main',
        generatedAt: 123,
      });
    }

    return Promise.resolve([]);
  });
}

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
    mockListBranches(['main', 'release/main']);
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

    await openAdvanced();
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
    await openAdvanced();
    const reopenedCheckbox = await screen.findByRole('checkbox', {
      name: /Dangerously skip all confirms/i,
    });
    expect((reopenedCheckbox as HTMLInputElement).checked).toBe(true);
  });

  it('ignores stale agent loads after the dialog closes and reopens', async () => {
    const firstAgents = createDeferredPromise<ReturnType<typeof createTestAgentDef>[]>();
    const secondAgents = createDeferredPromise<ReturnType<typeof createTestAgentDef>[]>();
    loadAgentsMock
      .mockImplementationOnce(() => firstAgents.promise)
      .mockImplementationOnce(() => secondAgents.promise);
    const [open, setOpen] = createSignal(true);

    render(() => <NewTaskDialog open={open()} onClose={() => setOpen(false)} />);

    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    });

    setOpen(false);
    setOpen(true);

    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(2);
    });

    secondAgents.resolve([
      createTestAgentDef({
        id: 'fresh-agent',
        name: 'Fresh Agent',
        skip_permissions_args: ['--yolo'],
      }),
    ]);

    await waitFor(() => {
      expect(screen.getByText('Selected agent: Fresh Agent')).toBeDefined();
    });

    firstAgents.resolve([
      createTestAgentDef({
        id: 'stale-agent',
        name: 'Stale Agent',
        skip_permissions_args: ['--yolo'],
      }),
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText('Selected agent: Fresh Agent')).toBeDefined();
    expect(screen.queryByText('Selected agent: Stale Agent')).toBeNull();
  });

  it('passes skipPermissions through task creation by default', async () => {
    createTaskMock.mockResolvedValue('task-1');

    render(() => <NewTaskDialog open onClose={() => {}} />);
    // Default skip-permissions should apply without ever expanding the Advanced section.
    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(/Runs without confirmation/i)).toBeDefined();

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

  it('passes stepsTracking through task creation when enabled', async () => {
    createTaskMock.mockResolvedValue('task-steps');

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    });

    await openAdvanced();
    const stepsTrackingCheckbox = await screen.findByRole('checkbox', {
      name: /Track task steps/i,
    });
    const taskNameInput = screen.getByPlaceholderText('Add user authentication');

    fireEvent.click(stepsTrackingCheckbox);
    fireEvent.input(taskNameInput, {
      target: { value: 'Tracked task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Tracked task',
          projectId: 'project-1',
          stepsTracking: true,
        }),
      );
    });
  });

  it('shows ignored directory suggestion failures without blocking task creation', async () => {
    createTaskMock.mockResolvedValue('task-1');
    invokeMock.mockRejectedValue(new Error('gitignored backend unavailable'));

    render(() => <NewTaskDialog open onClose={() => {}} />);

    expect(
      await screen.findByText(
        'Ignored directory suggestions unavailable: gitignored backend unavailable',
      ),
    ).toBeDefined();

    const taskNameInput = screen.getByPlaceholderText('Add user authentication');
    fireEvent.input(taskNameInput, {
      target: { value: 'Ship it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Ship it',
          projectId: 'project-1',
          symlinkDirs: [],
        }),
      );
    });
  });

  it('resets steps tracking when the dialog reopens', async () => {
    const user = userEvent.setup();
    const [open, setOpen] = createSignal(true);

    render(() => <NewTaskDialog open={open()} onClose={() => setOpen(false)} />);

    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    });

    await openAdvanced();
    const stepsTrackingCheckbox = await screen.findByRole('checkbox', {
      name: /Track task steps/i,
    });
    expect((stepsTrackingCheckbox as HTMLInputElement).checked).toBe(false);

    await user.click(stepsTrackingCheckbox);
    expect((stepsTrackingCheckbox as HTMLInputElement).checked).toBe(true);

    setOpen(false);
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Track task steps/i })).toBeNull();
    });

    setOpen(true);
    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(2);
    });

    await openAdvanced();
    const reopenedCheckbox = await screen.findByRole('checkbox', {
      name: /Track task steps/i,
    });
    expect((reopenedCheckbox as HTMLInputElement).checked).toBe(false);
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

    const currentBranchButton = await screen.findByRole('button', { name: /^Current branch/i });
    expect((currentBranchButton as HTMLButtonElement).disabled).toBe(true);
    expect(currentBranchButton.getAttribute('aria-pressed')).toBe('false');
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

    expect(document.querySelector('[data-dialog-width="560px"]')).not.toBeNull();
  });

  it('widens the dialog and exposes isolation guidance in titles when current-branch mode is active', async () => {
    setStore('projects', [
      createTestProject({
        defaultTaskGitIsolation: 'current-branch',
        id: 'project-1',
        path: '/repo',
      }),
    ]);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    });

    expect(document.querySelector('[data-dialog-width="560px"]')).not.toBeNull();
    expect(
      screen.getByTitle(/Reuses the project root instead of creating a worktree/i),
    ).toBeTruthy();
    await openAdvanced();
    expect(
      screen.getByTitle(
        /Runs without asking for confirmation\. The agent can read, write, delete, and execute commands without your approval\./i,
      ),
    ).toBeTruthy();
  });

  it('passes the configured project base branch through current-branch task creation', async () => {
    const user = userEvent.setup();
    createCurrentBranchTaskMock.mockResolvedValue('task-1');
    setStore('projects', [createTestProject({ baseBranch: 'personal/main', path: '/repo' })]);
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'list_branches') {
        return Promise.resolve({
          branches: [
            {
              current: false,
              local: true,
              name: 'personal/main',
              remote: true,
            },
          ],
          defaultBranch: 'personal/main',
          generatedAt: 123,
        });
      }

      return Promise.resolve([]);
    });
    render(() => <NewTaskDialog open onClose={() => {}} />);

    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    });
    const currentBranchButton = await screen.findByRole('button', { name: /^Current branch/i });
    await Promise.resolve();
    await user.click(currentBranchButton);

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

  it('passes the selected base branch through managed task creation', async () => {
    const user = userEvent.setup();
    createTaskMock.mockResolvedValue('task-1');
    render(() => <NewTaskDialog open onClose={() => {}} />);

    await openAdvanced();
    const branchSelect = (await screen.findByLabelText('Base branch')) as HTMLSelectElement;
    await waitFor(() => {
      expect(
        Array.from(branchSelect.options).some((option) => option.value === 'release/main'),
      ).toBe(true);
    });
    await user.selectOptions(branchSelect, 'release/main');

    const taskNameInput = screen.getByPlaceholderText('Add user authentication');
    await user.type(taskNameInput, 'Ship it');
    await user.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baseBranch: 'release/main',
          name: 'Ship it',
          projectId: 'project-1',
        }),
      );
    });
  });

  it('blocks managed task creation when the local branch prefix would conflict', async () => {
    const user = userEvent.setup();
    setStore('projects', [
      createTestProject({
        branchPrefix: 'feature',
      }),
    ]);
    mockListBranches(['main', 'feature']);

    render(() => <NewTaskDialog open onClose={() => {}} />);
    await openAdvanced();

    const taskNameInput = screen.getByPlaceholderText('Add user authentication');
    await user.type(taskNameInput, 'Ship it');

    expect(await screen.findByText(/Cannot create branch "feature\/ship-it"/)).toBeDefined();
    const createButton = screen.getByRole('button', {
      name: 'Create Task',
    }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);

    await user.click(createButton);
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('reveals the branch conflict when submit is clicked with advanced collapsed', async () => {
    const user = userEvent.setup();
    setStore('projects', [
      createTestProject({
        branchPrefix: 'feature',
      }),
    ]);
    mockListBranches(['main', 'feature']);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    const taskNameInput = screen.getByPlaceholderText('Add user authentication');
    await user.type(taskNameInput, 'Ship it');

    const advancedToggle = await screen.findByRole('button', { name: /^Advanced/i });
    expect(advancedToggle.getAttribute('aria-expanded')).toBe('false');

    const createButton = screen.getByRole('button', {
      name: 'Create Task',
    }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);

    await user.click(createButton);

    expect(createTaskMock).not.toHaveBeenCalled();
    expect(advancedToggle.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findAllByText(/Cannot create branch "feature\/ship-it"/)).not.toHaveLength(
      0,
    );
  });

  it('creates non-git project tasks without branch controls', async () => {
    const user = userEvent.setup();
    createTaskMock.mockResolvedValue('task-1');
    setStore('projects', [
      createTestProject({
        path: '/tmp/folder',
        projectMode: 'non-git',
      }),
    ]);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByLabelText('Base branch')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Current branch/i })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Use existing worktree/i })).toBeNull();

    const taskNameInput = screen.getByPlaceholderText('Add user authentication');
    await user.type(taskNameInput, 'Inspect folder');
    await user.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Inspect folder',
          projectId: 'project-1',
          projectMode: 'non-git',
        }),
      );
    });
  });
});
