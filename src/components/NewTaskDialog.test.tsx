import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { createSignal, Show } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import {
  createTestAgentDef,
  createTestProject,
  createTestTask,
  resetStoreForTest,
} from '../test/store-test-helpers';
import { installManualAnimationFrame } from '../test/manual-animation-frame';

const {
  createCurrentBranchTaskMock,
  createExistingWorktreeTaskMock,
  createTaskMock,
  invokeMock,
  invokeWithAbortSignalMock,
  updateProjectMock,
} = vi.hoisted(() => {
  const invokeMock = vi.fn();
  return {
    createCurrentBranchTaskMock: vi.fn(),
    createExistingWorktreeTaskMock: vi.fn(),
    createTaskMock: vi.fn(),
    invokeMock,
    invokeWithAbortSignalMock: vi.fn(
      async (channel: string, signal: AbortSignal, args?: unknown) => {
        signal.throwIfAborted();
        const result = await invokeMock(channel, args);
        signal.throwIfAborted();
        return result;
      },
    ),
    updateProjectMock: vi.fn(),
  };
});

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
  invokeWithAbortSignal: invokeWithAbortSignalMock,
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
  ProjectSelect: (props: {
    onChange: (projectId: string | null) => void;
    value: string | null;
  }) => (
    <select
      aria-label="Project"
      onChange={(event) => props.onChange(event.currentTarget.value || null)}
      value={props.value ?? ''}
    >
      <option value="project-1">Project 1</option>
      <option value="project-2">Project 2</option>
    </select>
  ),
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    store: core.store,
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

import {
  createTaskOptimistically,
  listPendingTaskCreations,
  resetPendingTaskCreationsForTests,
  retryPendingTaskCreation,
} from '../app/task-creation-optimism';
import { NewTaskDialog } from './NewTaskDialog';

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

    if (channel === 'get_gitignored_dirs') {
      return Promise.resolve({ candidates: [], truncated: false });
    }

    return Promise.resolve([]);
  });
}

describe('NewTaskDialog', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    resetPendingTaskCreationsForTests();
    resetStoreForTest();
    setStore('projects', [createTestProject()]);
    setStore('availableAgents', [
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

  it.each(['Cancel', 'overlay', 'Escape'] as const)(
    'guards a dirty prompt from the %s close route and commits discard once',
    async (closeRoute) => {
      const onClose = vi.fn();
      render(() => <NewTaskDialog open onClose={onClose} />);

      const prompt = await screen.findByPlaceholderText(/Describe the task/i);
      fireEvent.input(prompt, { target: { value: 'Keep this authored prompt' } });

      if (closeRoute === 'Cancel') {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      } else if (closeRoute === 'overlay') {
        const overlay = screen.getByRole('dialog', { name: 'New Task' }).closest('.dialog-overlay');
        if (!(overlay instanceof HTMLElement)) {
          throw new Error('Expected the New Task overlay');
        }
        fireEvent.click(overlay);
      } else {
        fireEvent.keyDown(document, { key: 'Escape' });
      }

      expect(screen.getByRole('dialog', { name: 'Discard new task draft?' })).toBeDefined();
      expect(
        screen.getByText('Your prompt or task name has changes that will be lost.'),
      ).toBeDefined();
      expect((prompt as HTMLTextAreaElement).value).toBe('Keep this authored prompt');
      expect(onClose).not.toHaveBeenCalled();

      const discard = screen.getByRole('button', { name: 'Discard draft' });
      fireEvent.click(discard);
      fireEvent.click(discard);

      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('closes untouched, whitespace-only, and reverted text without confirmation', async () => {
    const onClose = vi.fn();
    render(() => <NewTaskDialog open onClose={onClose} />);

    const prompt = await screen.findByPlaceholderText(/Describe the task/i);
    fireEvent.input(prompt, { target: { value: 'Temporary text' } });
    fireEvent.input(prompt, { target: { value: '  \n  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Discard new task draft?' })).toBeNull();
  });

  it('guards an explicit task-name edit even when the prompt is untouched', async () => {
    const onClose = vi.fn();
    render(() => <NewTaskDialog open onClose={onClose} />);

    fireEvent.input(await screen.findByPlaceholderText('Add user authentication'), {
      target: { value: 'Important explicit name' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('dialog', { name: 'Discard new task draft?' })).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'GitHub drop',
      prepare: () => setStore('newTaskDropUrl', 'https://github.com/acme/widget/pull/42'),
      expectedName: '',
      expectedPrompt: 'review https://github.com/acme/widget/pull/42',
    },
    {
      label: 'arena',
      prepare: () =>
        setStore('newTaskPrefillPrompt', {
          projectId: 'project-1',
          prompt: 'Compare these arena candidates',
        }),
      expectedName: 'Compare arena results',
      expectedPrompt: 'Compare these arena candidates',
    },
  ])('treats an untouched $label prefill as the clean baseline', async (prefillCase) => {
    const onClose = vi.fn();
    prefillCase.prepare();
    render(() => <NewTaskDialog open onClose={onClose} />);

    const prompt = (await screen.findByPlaceholderText(
      /Describe the task/i,
    )) as HTMLTextAreaElement;
    const name = document.querySelector<HTMLInputElement>(
      '.new-task-dialog-form input.input-field[type="text"]',
    );
    if (!name) {
      throw new Error('Expected the task name input');
    }
    expect(prompt.value).toBe(prefillCase.expectedPrompt);
    expect(name.value).toBe(prefillCase.expectedName);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Discard new task draft?' })).toBeNull();
  });

  it.each([
    {
      label: 'GitHub drop prompt',
      prepare: () => setStore('newTaskDropUrl', 'https://github.com/acme/widget/pull/42'),
      field: 'prompt' as const,
    },
    {
      label: 'arena name',
      prepare: () =>
        setStore('newTaskPrefillPrompt', {
          projectId: 'project-1',
          prompt: 'Compare these arena candidates',
        }),
      field: 'name' as const,
    },
  ])('guards deleting the prefilled $label', async (prefillCase) => {
    prefillCase.prepare();
    render(() => <NewTaskDialog open onClose={() => {}} />);

    const target =
      prefillCase.field === 'prompt'
        ? await screen.findByPlaceholderText(/Describe the task/i)
        : await screen.findByDisplayValue('Compare arena results');
    fireEvent.input(target, { target: { value: '' } });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByRole('dialog', { name: 'Discard new task draft?' })).toBeDefined();
  });

  it('keeps the complete form intact and restores the prompt caret after cancelling discard', async () => {
    const animationFrame = installManualAnimationFrame();
    render(() => <NewTaskDialog open onClose={() => {}} />);

    const prompt = (await screen.findByPlaceholderText(
      /Describe the task/i,
    )) as HTMLTextAreaElement;
    const name = screen.getByPlaceholderText('Add user authentication') as HTMLInputElement;
    fireEvent.input(prompt, { target: { value: 'Draft prompt with caret' } });
    fireEvent.input(name, { target: { value: 'Draft name' } });
    await openAdvanced();
    const steps = screen.getByRole('checkbox', { name: /Track task steps/i });
    fireEvent.click(steps);
    prompt.focus();
    prompt.setSelectionRange(6, 6);

    fireEvent.keyDown(document, { key: 'Escape' });
    animationFrame.flush();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' }));
    expect(prompt.value).toBe('Draft prompt with caret');
    expect(name.value).toBe('Draft name');
    expect((steps as HTMLInputElement).checked).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    animationFrame.flush();

    expect(screen.queryByRole('dialog', { name: 'Discard new task draft?' })).toBeNull();
    expect(document.activeElement).toBe(prompt);
    expect(prompt.selectionStart).toBe(6);
    expect(prompt.selectionEnd).toBe(6);
    expect(prompt.value).toBe('Draft prompt with caret');
    expect(name.value).toBe('Draft name');
    expect((steps as HTMLInputElement).checked).toBe(true);
  });

  it('falls back to the terminal name field when the prior focus is not editable', async () => {
    const animationFrame = installManualAnimationFrame();
    const user = userEvent.setup();
    render(() => <NewTaskDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Terminal' }));
    const name = screen.getByPlaceholderText('Terminal') as HTMLInputElement;
    await user.type(name, 'Edited terminal name');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    await user.click(cancel);
    animationFrame.flush();

    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    animationFrame.flush();

    expect(document.activeElement).toBe(name);
    expect(name.value).toBe('Edited terminal name');
  });

  it('does not guard changes to intentionally unprotected form options', async () => {
    const onClose = vi.fn();
    render(() => <NewTaskDialog open onClose={onClose} />);
    await openAdvanced();

    fireEvent.click(screen.getByRole('checkbox', { name: /Track task steps/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Discard new task draft?' })).toBeNull();
  });

  it('resets a confirmed discarded draft only on the next open generation', async () => {
    const [open, setOpen] = createSignal(true);
    render(() => <NewTaskDialog open={open()} onClose={() => setOpen(false)} />);

    fireEvent.input(await screen.findByPlaceholderText(/Describe the task/i), {
      target: { value: 'Discard me' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(screen.queryByRole('dialog', { name: 'New Task' })).toBeNull();

    setOpen(true);
    const reopenedPrompt = (await screen.findByPlaceholderText(
      /Describe the task/i,
    )) as HTMLTextAreaElement;
    expect(reopenedPrompt.value).toBe('');
  });

  it('does not leave discard confirmation mounted after the parent closes externally', async () => {
    const [open, setOpen] = createSignal(true);
    render(() => <NewTaskDialog open={open()} onClose={() => setOpen(false)} />);

    fireEvent.input(await screen.findByPlaceholderText(/Describe the task/i), {
      target: { value: 'Draft from an obsolete open generation' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Discard new task draft?' })).toBeDefined();

    setOpen(false);
    expect(screen.queryByRole('dialog', { name: 'New Task' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Discard new task draft?' })).toBeNull();

    setOpen(true);
    const reopenedPrompt = (await screen.findByPlaceholderText(
      /Describe the task/i,
    )) as HTMLTextAreaElement;
    expect(reopenedPrompt.value).toBe('');
    expect(screen.queryByRole('dialog', { name: 'Discard new task draft?' })).toBeNull();
  });

  it('does not reset or rebaseline text after agent, settings, project, and Git updates', async () => {
    let resolveBranches:
      | ((value: {
          branches: Array<{ current: boolean; local: boolean; name: string; remote: boolean }>;
          defaultBranch: string;
          generatedAt: number;
        }) => void)
      | undefined;
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'list_branches') {
        return new Promise((resolve) => {
          resolveBranches = resolve;
        });
      }
      if (channel === 'get_gitignored_dirs') {
        return Promise.resolve({
          candidates: [{ isDefault: true, name: 'node_modules' }],
          truncated: false,
        });
      }
      return Promise.resolve([]);
    });

    render(() => <NewTaskDialog open onClose={() => {}} />);
    const prompt = (await screen.findByPlaceholderText(
      /Describe the task/i,
    )) as HTMLTextAreaElement;
    const name = screen.getByPlaceholderText('Add user authentication') as HTMLInputElement;
    fireEvent.input(prompt, { target: { value: 'Stable authored prompt' } });
    fireEvent.input(name, { target: { value: 'Stable authored name' } });
    await openAdvanced();

    setStore('availableAgents', [
      createTestAgentDef({
        id: 'codex',
        name: 'Codex refreshed',
        skip_permissions_args: [],
      }),
    ]);
    setStore('newTaskDefaults', { skipPermissions: false, stepsTracking: true });
    setStore('projects', 0, 'name', 'Project refreshed');
    await waitFor(() => expect(resolveBranches).toBeTypeOf('function'));
    resolveBranches?.({
      branches: [
        { current: true, local: true, name: 'main', remote: true },
        { current: false, local: true, name: 'release/main', remote: true },
      ],
      defaultBranch: 'main',
      generatedAt: 456,
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Base branch')).toBeDefined();
    });

    expect(prompt.value).toBe('Stable authored prompt');
    expect(name.value).toBe('Stable authored name');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Discard new task draft?' })).toBeDefined();
  });

  it('returns to editing after synchronous validation fails and still protects the draft', async () => {
    const onClose = vi.fn();
    setStore('projects', []);
    render(() => <NewTaskDialog open onClose={onClose} />);

    fireEvent.input(await screen.findByPlaceholderText(/Describe the task/i), {
      target: { value: 'Draft without a project' },
    });
    const createButton = screen.getByRole('button', { name: 'Create Task' });
    fireEvent.submit(createButton.closest('form') as HTMLFormElement);
    expect(screen.getByText('Select a project')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Discard new task draft?' })).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uses saved defaults without letting one-task overrides mutate them', async () => {
    setStore('newTaskDefaults', {
      skipPermissions: false,
      stepsTracking: true,
    });

    render(() => <NewTaskDialog open onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Create Task' });

    await openAdvanced();
    const permissionsCheckbox = await screen.findByRole('checkbox', {
      name: /Dangerously skip all confirms/i,
    });
    const stepsCheckbox = await screen.findByRole('checkbox', {
      name: /Track task steps/i,
    });
    expect((permissionsCheckbox as HTMLInputElement).checked).toBe(false);
    expect((stepsCheckbox as HTMLInputElement).checked).toBe(true);

    fireEvent.click(permissionsCheckbox);
    fireEvent.click(stepsCheckbox);
    expect((permissionsCheckbox as HTMLInputElement).checked).toBe(true);
    expect((stepsCheckbox as HTMLInputElement).checked).toBe(false);
    expect(store.newTaskDefaults).toEqual({
      skipPermissions: false,
      stepsTracking: true,
    });
  });

  it('reloads only the final selected project when reopening with a different default', async () => {
    const [open, setOpen] = createSignal(true);
    setStore('projects', [
      createTestProject({ id: 'project-1', path: '/repo-a' }),
      createTestProject({ id: 'project-2', path: '/repo-b' }),
    ]);
    setStore('lastProjectId', 'project-1');
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'list_branches') {
        return Promise.resolve({
          branches: [
            {
              current: true,
              local: true,
              name: 'main',
              remote: true,
            },
          ],
          defaultBranch: 'main',
          generatedAt: 123,
        });
      }
      if (channel === 'get_gitignored_dirs') {
        return Promise.resolve({ candidates: [], truncated: false });
      }
      return Promise.resolve([]);
    });

    render(() => <NewTaskDialog open={open()} onClose={() => setOpen(false)} />);
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(
          ([channel, args]) => channel === 'list_branches' && args?.projectRoot === '/repo-a',
        ),
      ).toHaveLength(1);
    });

    setOpen(false);
    setStore('lastProjectId', 'project-2');
    setOpen(true);

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(
          ([channel, args]) => channel === 'list_branches' && args?.projectRoot === '/repo-b',
        ),
      ).toHaveLength(1);
    });
    expect(
      invokeMock.mock.calls.filter(
        ([channel, args]) => channel === 'list_branches' && args?.projectRoot === '/repo-a',
      ),
    ).toHaveLength(1);
  });

  it('opens synchronously from the store catalog and fires a background availability refresh', async () => {
    render(() => <NewTaskDialog open onClose={() => {}} />);

    // The default selection comes from store.availableAgents synchronously:
    // no awaited list_agents fetch sits on the dialog-open path.
    expect(screen.getByText('Selected agent: Codex')).toBeDefined();
    const invokedChannels = invokeMock.mock.calls.map(([channel]) => channel);
    expect(invokedChannels).not.toContain('list_agents');
    expect(invokeMock).toHaveBeenCalledWith('refresh_agent_availability', undefined);
  });

  it('forwards the hydra command override with the background availability refresh', async () => {
    setStore('hydraCommand', '/custom/hydra');

    render(() => <NewTaskDialog open onClose={() => {}} />);

    expect(invokeMock).toHaveBeenCalledWith('refresh_agent_availability', {
      hydraCommand: '/custom/hydra',
    });
  });

  it('treats probing agents as launchable for the default selection', async () => {
    setStore('availableAgents', [
      createTestAgentDef({
        availabilityStatus: 'probing',
        id: 'codex',
        name: 'Codex',
      }),
      createTestAgentDef({
        id: 'claude-code',
        name: 'Claude',
      }),
    ]);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    expect(screen.getByText('Selected agent: Codex')).toBeDefined();
  });

  it('selects the first available agent instead of an unavailable Codex entry', async () => {
    setStore('availableAgents', [
      createTestAgentDef({
        available: false,
        id: 'codex',
        name: 'Codex',
      }),
      createTestAgentDef({
        id: 'claude-code',
        name: 'Claude',
      }),
    ]);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await screen.findByRole('button', { name: 'Create Task' });

    expect(screen.getByText('Selected agent: Claude')).toBeDefined();
  });

  it('creates a project-backed terminal task without requiring or launching an agent', async () => {
    const user = userEvent.setup();
    createTaskMock.mockResolvedValue('task-terminal');
    setStore('availableAgents', []);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Terminal' }));

    expect(screen.queryByText(/Selected agent:/)).toBeNull();
    expect(screen.queryByPlaceholderText(/Describe the task/i)).toBeNull();
    expect(screen.queryByText(/Runs without confirmation/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Create Terminal Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          launch: { kind: 'terminal' },
          name: 'Terminal',
          projectId: 'project-1',
        }),
      );
    });
    expect(listPendingTaskCreations()).toEqual([]);
  });

  it('reuses one backend adapter operation identity after a lost-response retry', async () => {
    const user = userEvent.setup();
    createTaskMock
      .mockRejectedValueOnce(new Error('Response lost after commit'))
      .mockResolvedValueOnce('task-terminal');

    render(() => <NewTaskDialog open onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Terminal' }));
    await user.click(screen.getByRole('button', { name: 'Create Terminal Task' }));

    await waitFor(() => {
      expect(listPendingTaskCreations()[0]?.state).toMatchObject({ kind: 'error' });
    });
    const pendingId = listPendingTaskCreations()[0]?.pendingId;
    if (!pendingId) throw new Error('Expected a failed optimistic task');
    const firstOperationId = createTaskMock.mock.calls[0]?.[0]?.adapterOperationId;

    retryPendingTaskCreation(pendingId);
    await waitFor(() => expect(createTaskMock).toHaveBeenCalledTimes(2));

    expect(firstOperationId).toEqual(expect.any(String));
    expect(createTaskMock.mock.calls[1]?.[0]?.adapterOperationId).toBe(firstOperationId);
    await waitFor(() => expect(listPendingTaskCreations()).toEqual([]));
  });

  it('ignores a hidden agent prompt after switching to terminal mode', async () => {
    const user = userEvent.setup();
    createTaskMock.mockResolvedValue('task-terminal');

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await user.type(
      await screen.findByPlaceholderText(/Describe the task/i),
      'Review https://github.com/acme/widget/pull/42',
    );
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    expect(screen.getByPlaceholderText('Terminal')).toBeDefined();
    expect(screen.getByText('task/terminal')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Create Terminal Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          launch: { kind: 'terminal' },
          name: 'Terminal',
        }),
      );
    });
    expect(createTaskMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ githubUrl: expect.any(String) }),
    );
  });

  it('chooses a collision-free default terminal name across active, collapsed, and pending tasks', async () => {
    const user = userEvent.setup();
    createTaskMock.mockResolvedValue('task-terminal-4');
    setStore('tasks', {
      'task-terminal': createTestTask({
        id: 'task-terminal',
        name: 'Terminal',
        taskMode: 'terminal',
      }),
      'task-terminal-2': createTestTask({
        branchName: 'task/terminal-2',
        collapsed: true,
        id: 'task-terminal-2',
        name: 'Archived shell',
        taskMode: 'terminal',
      }),
    });
    setStore('taskOrder', ['task-terminal']);
    setStore('collapsedTaskOrder', ['task-terminal-2']);
    createTaskOptimistically({
      launchLabel: 'Terminal',
      name: 'Terminal 3',
      projectId: 'project-1',
      run: () => new Promise<string>(() => {}),
      taskMode: 'terminal',
    });

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Terminal' }));

    expect(screen.getByPlaceholderText('Terminal 4')).toBeDefined();
    expect(screen.getByText('task/terminal-4')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Create Terminal Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          launch: { kind: 'terminal' },
          name: 'Terminal 4',
          projectId: 'project-1',
        }),
      );
    });
  });

  it('clears stale submission errors whenever the task mode changes', async () => {
    const user = userEvent.setup();
    setStore('availableAgents', []);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Coordinator' }));
    fireEvent.input(screen.getByPlaceholderText('Add user authentication'), {
      target: { value: 'Coordinate work' },
    });
    const form = screen.getByRole('button', { name: 'Create Task' }).closest('form');
    if (!form) {
      throw new Error('Expected task creation form');
    }
    fireEvent.submit(form);
    expect(screen.getByText('Select an available agent')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Agent' }));
    expect(screen.queryByText('Select an available agent')).toBeNull();

    fireEvent.submit(form);
    expect(screen.getByText('Select an available agent')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.queryByText('Select an available agent')).toBeNull();
  });

  it('describes steps tracking without implying that terminal tasks have an agent', async () => {
    const user = userEvent.setup();

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Terminal' }));
    await openAdvanced();

    expect(
      screen.getByTitle(
        'Watches .claude/steps.json so the task panel can show durable step history and next-step guidance for this terminal task.',
      ),
    ).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Agent' }));
    expect(
      screen.getByTitle(
        'Lets the agent maintain .claude/steps.json so the task panel can show durable step history and next-step guidance.',
      ),
    ).toBeDefined();
  });

  it('creates a terminal task in the project root through the shared root workflow', async () => {
    const user = userEvent.setup();
    createCurrentBranchTaskMock.mockImplementation(() => new Promise<string>(() => {}));

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Terminal' }));
    await user.click(await screen.findByRole('button', { name: 'Project root' }));
    await user.click(screen.getByRole('button', { name: 'Create Terminal Task' }));

    await waitFor(() => {
      expect(createCurrentBranchTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          launch: { kind: 'terminal' },
          name: 'Terminal',
          projectId: 'project-1',
        }),
      );
    });
    expect(listPendingTaskCreations()).toMatchObject([
      {
        gitIsolation: 'current-branch',
        taskMode: 'terminal',
      },
    ]);
    expect(listPendingTaskCreations()[0]).not.toHaveProperty('baseBranch');
  });

  it('does not query ignored-file candidates when a project opens in root mode', async () => {
    const user = userEvent.setup();
    const [open, setOpen] = createSignal(true);
    createCurrentBranchTaskMock.mockResolvedValue('task-root');
    setStore('projects', [
      createTestProject({
        defaultTaskGitIsolation: 'current-branch',
        id: 'project-1',
        path: '/repo',
      }),
    ]);

    render(() => <NewTaskDialog open={open()} onClose={() => setOpen(false)} />);
    const projectRootButton = await screen.findByRole('button', { name: 'Project root' });
    expect(projectRootButton.getAttribute('aria-pressed')).toBe('true');
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === 'get_gitignored_dirs'),
    ).toHaveLength(0);

    await user.type(screen.getByPlaceholderText('Add user authentication'), 'Root task');
    await user.click(screen.getByRole('button', { name: 'Create Task' }));
    await waitFor(() => expect(createCurrentBranchTaskMock).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog', { name: 'New Task' })).toBeNull();
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === 'get_gitignored_dirs'),
    ).toHaveLength(0);
  });

  it('allows another project-root task while a terminal root task is pending', async () => {
    const user = userEvent.setup();
    createTaskOptimistically({
      baseBranch: 'main',
      gitIsolation: 'current-branch',
      launchLabel: 'Terminal',
      name: 'Terminal',
      projectId: 'project-1',
      run: () => new Promise<string>(() => {}),
      taskMode: 'terminal',
    });

    render(() => <NewTaskDialog open onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Terminal' }));

    const projectRootButton = screen.getByRole('button', { name: 'Project root' });
    expect((projectRootButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(projectRootButton);
    await user.click(screen.getByRole('button', { name: 'Create Terminal Task' }));
    await waitFor(() => expect(createCurrentBranchTaskMock).toHaveBeenCalledOnce());
  });

  it('creates a terminal task in an existing worktree through the shared import workflow', async () => {
    const user = userEvent.setup();
    createExistingWorktreeTaskMock.mockImplementation(() => new Promise<string>(() => {}));

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Terminal' }));
    await openAdvanced();
    await user.click(screen.getByRole('checkbox', { name: /Use existing worktree/i }));
    await user.type(
      screen.getByPlaceholderText('/path/to/existing/worktree'),
      '/repo-worktrees/review',
    );
    await user.click(screen.getByRole('button', { name: 'Create Terminal Task' }));

    await waitFor(() => {
      expect(createExistingWorktreeTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          existingWorktreePath: '/repo-worktrees/review',
          launch: { kind: 'terminal' },
          name: 'Terminal',
          projectId: 'project-1',
        }),
      );
    });
    expect(listPendingTaskCreations()).toMatchObject([
      {
        baseBranch: 'main',
        gitIsolation: 'existing-worktree',
        taskMode: 'terminal',
      },
    ]);
  });

  it('creates a task from a custom command with parsed arguments', async () => {
    const user = userEvent.setup();
    createTaskMock.mockResolvedValue('task-custom');

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await screen.findByRole('button', { name: 'Create Task' });

    await user.click(screen.getByRole('checkbox', { name: /Use custom command/i }));
    await user.type(screen.getByPlaceholderText('codex'), 'codex --model fast');
    await user.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          launch: expect.objectContaining({
            kind: 'agent',
            agentDef: expect.objectContaining({
              args: ['--model', 'fast'],
              command: 'codex',
              name: 'Terminal: codex --model fast',
            }),
          }),
          name: 'codex --model fast',
          projectId: 'project-1',
        }),
      );
    });
    expect(createTaskMock.mock.calls[0]?.[0].launch).not.toHaveProperty('skipPermissions');
  });

  it('shows custom command parse errors before submit', async () => {
    const user = userEvent.setup();

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await screen.findByRole('button', { name: 'Create Task' });

    await user.click(screen.getByRole('checkbox', { name: /Use custom command/i }));
    await user.type(screen.getByPlaceholderText('codex'), 'codex "unfinished');

    expect(screen.getByText('Command has an unterminated quote or escape.')).toBeDefined();
    expect(
      (screen.getByRole('button', { name: 'Create Task' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('passes skipPermissions through task creation by default', async () => {
    createTaskMock.mockResolvedValue('task-1');

    render(() => <NewTaskDialog open onClose={() => {}} />);
    // Default skip-permissions should apply without ever expanding the Advanced section.
    await screen.findByRole('button', { name: 'Create Task' });
    expect(screen.getByText(/Runs without confirmation/i)).toBeDefined();

    const taskNameInput = await screen.findByPlaceholderText('Add user authentication');
    fireEvent.input(taskNameInput, {
      target: { value: 'Ship it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          launch: expect.objectContaining({
            kind: 'agent',
            skipPermissions: true,
          }),
          name: 'Ship it',
          projectId: 'project-1',
        }),
      );
    });
  });

  it('does not pass the saved skip-permission default to an unsupported agent', async () => {
    createTaskMock.mockResolvedValue('task-unsupported');
    setStore('availableAgents', [
      createTestAgentDef({
        id: 'plain-agent',
        name: 'Plain agent',
        skip_permissions_args: [],
      }),
    ]);

    render(() => <NewTaskDialog open onClose={() => {}} />);
    await openAdvanced();

    expect(screen.queryByRole('checkbox', { name: /Dangerously skip all confirms/i })).toBeNull();
    fireEvent.input(screen.getByPlaceholderText('Add user authentication'), {
      target: { value: 'Safe launch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(createTaskMock).toHaveBeenCalledTimes(1));
    expect(createTaskMock.mock.calls[0]?.[0].launch).not.toHaveProperty('skipPermissions');
  });

  it('does not pass the saved skip-permission default to Hydra', async () => {
    createTaskMock.mockResolvedValue('task-hydra');
    setStore('availableAgents', [
      createTestAgentDef({
        adapter: 'hydra',
        id: 'hydra',
        name: 'Hydra',
        skip_permissions_args: ['--unsafe'],
      }),
    ]);

    render(() => <NewTaskDialog open onClose={() => {}} />);
    await openAdvanced();

    expect(screen.queryByRole('checkbox', { name: /Dangerously skip all confirms/i })).toBeNull();
    fireEvent.input(screen.getByPlaceholderText('Add user authentication'), {
      target: { value: 'Hydra launch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(createTaskMock).toHaveBeenCalledTimes(1));
    expect(createTaskMock.mock.calls[0]?.[0].launch).not.toHaveProperty('skipPermissions');
  });

  it('rechecks skip-permission capability at submit when the selected agent changes', async () => {
    createTaskMock.mockResolvedValue('task-capability-change');

    render(() => <NewTaskDialog open onClose={() => {}} />);
    await openAdvanced();
    expect(screen.getByRole('checkbox', { name: /Dangerously skip all confirms/i })).toBeDefined();

    setStore('availableAgents', 0, 'skip_permissions_args', []);
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Dangerously skip all confirms/i })).toBeNull();
    });

    fireEvent.input(screen.getByPlaceholderText('Add user authentication'), {
      target: { value: 'Capability changed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(createTaskMock).toHaveBeenCalledTimes(1));
    expect(createTaskMock.mock.calls[0]?.[0].launch).not.toHaveProperty('skipPermissions');
  });

  it('blocks submit when the selected agent becomes unavailable', async () => {
    render(() => <NewTaskDialog open onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Create Task' });
    fireEvent.input(screen.getByPlaceholderText('Add user authentication'), {
      target: { value: 'Unavailable agent' },
    });

    setStore('availableAgents', 0, 'available', false);
    const createButton = screen.getByRole('button', { name: 'Create Task' });
    await waitFor(() => expect((createButton as HTMLButtonElement).disabled).toBe(true));

    fireEvent.submit(createButton.closest('form') as HTMLFormElement);
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(screen.getByText('Select an available agent')).toBeDefined();
  });

  it('closes the dialog synchronously while the create round trip is still in flight', async () => {
    let resolveCreate: (taskId: string) => void = () => {};
    const onClose = vi.fn();
    createTaskMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    render(() => <NewTaskDialog open onClose={onClose} />);
    await screen.findByRole('button', { name: 'Create Task' });
    const taskNameInput = await screen.findByPlaceholderText('Add user authentication');
    fireEvent.input(taskNameInput, { target: { value: 'Instant task' } });
    const createButton = screen.getByRole('button', { name: 'Create Task' });
    fireEvent.click(createButton);
    fireEvent.click(createButton);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(updateProjectMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Discard new task draft?' })).toBeNull();
    expect(listPendingTaskCreations()).toMatchObject([
      { name: 'Instant task', state: { kind: 'creating' } },
    ]);

    resolveCreate('task-real');
    await waitFor(() => {
      expect(listPendingTaskCreations()).toEqual([]);
    });
  });

  it('keeps the dialog open when synchronous validation fails', async () => {
    const onClose = vi.fn();
    render(() => <NewTaskDialog open onClose={onClose} />);
    await screen.findByRole('button', { name: 'Create Task' });

    fireEvent.submit(
      screen.getByRole('button', { name: 'Create Task' }).closest('form') as HTMLFormElement,
    );

    expect(onClose).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(listPendingTaskCreations()).toEqual([]);
  });

  it('passes stepsTracking through task creation when enabled', async () => {
    createTaskMock.mockResolvedValue('task-steps');

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await screen.findByRole('button', { name: 'Create Task' });

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

  it('shows ignored file suggestion failures with retry without blocking task creation', async () => {
    createTaskMock.mockResolvedValue('task-1');
    invokeMock.mockRejectedValue(new Error('gitignored backend unavailable'));

    render(() => <NewTaskDialog open onClose={() => {}} />);

    expect(
      await screen.findByText(
        'Ignored file suggestions unavailable: gitignored backend unavailable',
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

  it('blocks only managed-worktree submission while ignored files are loading', async () => {
    const user = userEvent.setup();
    let resolveCandidates:
      | ((value: {
          candidates: Array<{ isDefault: boolean; name: string }>;
          truncated: boolean;
        }) => void)
      | undefined;
    createTaskMock.mockResolvedValue('task-1');
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'list_branches') {
        return Promise.resolve({
          branches: [{ current: true, local: true, name: 'main', remote: true }],
          defaultBranch: 'main',
          generatedAt: 123,
        });
      }
      if (channel === 'get_gitignored_dirs') {
        return new Promise((resolve) => {
          resolveCandidates = resolve;
        });
      }
      return Promise.resolve([]);
    });

    render(() => <NewTaskDialog open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText('Add user authentication'), 'Ship safely');
    expect(await screen.findByText('Checking ignored files…')).toBeDefined();
    const createButton = screen.getByRole('button', { name: 'Create Task' }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);

    fireEvent.submit(createButton.closest('form') as HTMLFormElement);
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(screen.getByText('Checking ignored files before creating the worktree.')).toBeDefined();

    resolveCandidates?.({
      candidates: [{ isDefault: true, name: '.claude' }],
      truncated: false,
    });
    await waitFor(() => expect(createButton.disabled).toBe(false));
    await user.click(createButton);

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({ symlinkDirs: ['.claude'] }),
      );
    });
  });

  it('submits the selected ignored-file entries', async () => {
    const user = userEvent.setup();
    createTaskMock.mockResolvedValue('task-1');
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'list_branches') {
        return Promise.resolve({
          branches: [
            {
              current: true,
              local: true,
              name: 'main',
              remote: true,
            },
          ],
          defaultBranch: 'main',
          generatedAt: 123,
        });
      }
      if (channel === 'get_gitignored_dirs') {
        return Promise.resolve({
          candidates: [
            { isDefault: true, name: 'node_modules' },
            { isDefault: false, name: '.venv' },
          ],
          truncated: false,
        });
      }
      return Promise.resolve([]);
    });

    render(() => <NewTaskDialog open onClose={() => {}} />);
    await openAdvanced();

    const nodeModules = (await screen.findByRole('checkbox', {
      name: 'node_modules',
    })) as HTMLInputElement;
    const virtualEnvironment = screen.getByRole('checkbox', {
      name: '.venv',
    }) as HTMLInputElement;
    expect(nodeModules.checked).toBe(true);
    expect(virtualEnvironment.checked).toBe(false);
    await user.click(virtualEnvironment);

    await user.type(screen.getByPlaceholderText('Add user authentication'), 'Ship it');
    await user.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Ship it',
          projectId: 'project-1',
          symlinkDirs: ['node_modules', '.venv'],
        }),
      );
    });
  });

  it('does not submit ignored-file selections from the previous project', async () => {
    const user = userEvent.setup();
    createTaskMock.mockResolvedValue('task-2');
    setStore('projects', [
      createTestProject({ id: 'project-1', path: '/repo-a' }),
      createTestProject({ id: 'project-2', path: '/repo-b' }),
    ]);
    invokeMock.mockImplementation((channel: string, args?: { projectRoot?: string }) => {
      if (channel === 'list_branches') {
        return Promise.resolve({
          branches: [
            {
              current: true,
              local: true,
              name: 'main',
              remote: true,
            },
          ],
          defaultBranch: 'main',
          generatedAt: 123,
        });
      }
      if (channel === 'get_gitignored_dirs') {
        return args?.projectRoot === '/repo-a'
          ? Promise.resolve({
              candidates: [{ isDefault: true, name: 'node_modules' }],
              truncated: false,
            })
          : Promise.reject(new Error('project B candidates unavailable'));
      }
      return Promise.resolve([]);
    });

    render(() => <NewTaskDialog open onClose={() => {}} />);
    await openAdvanced();
    await screen.findByRole('checkbox', { name: 'node_modules' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'project-2');
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: 'node_modules' })).toBeNull();
    });
    await screen.findByText(
      'Ignored file suggestions unavailable: project B candidates unavailable',
    );
    await user.type(screen.getByPlaceholderText('Add user authentication'), 'Project B task');
    await user.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Project B task',
          projectId: 'project-2',
          symlinkDirs: [],
        }),
      );
    });
  });

  it('retries only the failed branch request and restores branch selection', async () => {
    const user = userEvent.setup();
    let branchRequestCount = 0;
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'list_branches') {
        branchRequestCount += 1;
        if (branchRequestCount === 1) {
          return Promise.reject(new Error('branch backend unavailable'));
        }

        return Promise.resolve({
          branches: [
            {
              current: true,
              local: true,
              name: 'main',
              remote: true,
            },
            {
              current: false,
              local: true,
              name: 'release/main',
              remote: true,
            },
          ],
          defaultBranch: 'main',
          generatedAt: 123,
        });
      }

      if (channel === 'get_gitignored_dirs') {
        return Promise.resolve({
          candidates: [{ isDefault: true, name: 'node_modules' }],
          truncated: false,
        });
      }

      return Promise.resolve([]);
    });

    render(() => <NewTaskDialog open onClose={() => {}} />);
    await openAdvanced();

    expect(
      await screen.findByText(/Branch list unavailable: branch backend unavailable/),
    ).toBeDefined();
    const ignoredRequestCount = invokeMock.mock.calls.filter(
      ([channel]) => channel === 'get_gitignored_dirs',
    ).length;
    expect(ignoredRequestCount).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    const branchSelect = (await screen.findByLabelText('Base branch')) as HTMLSelectElement;
    await waitFor(() => {
      expect(branchRequestCount).toBe(2);
      expect(
        Array.from(branchSelect.options).some((option) => option.value === 'release/main'),
      ).toBe(true);
    });
    expect(branchSelect.value).toBe('main');
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === 'get_gitignored_dirs'),
    ).toHaveLength(ignoredRequestCount);
  });

  it('samples defaults once per open and applies later settings changes on the next open', async () => {
    const [open, setOpen] = createSignal(true);
    setStore('newTaskDefaults', {
      skipPermissions: false,
      stepsTracking: false,
    });

    render(() => <NewTaskDialog open={open()} onClose={() => setOpen(false)} />);

    await screen.findByRole('button', { name: 'Create Task' });

    await openAdvanced();
    const stepsTrackingCheckbox = await screen.findByRole('checkbox', {
      name: /Track task steps/i,
    });
    const permissionsCheckbox = await screen.findByRole('checkbox', {
      name: /Dangerously skip all confirms/i,
    });
    expect((stepsTrackingCheckbox as HTMLInputElement).checked).toBe(false);
    expect((permissionsCheckbox as HTMLInputElement).checked).toBe(false);

    setStore('newTaskDefaults', {
      skipPermissions: true,
      stepsTracking: true,
    });
    expect((stepsTrackingCheckbox as HTMLInputElement).checked).toBe(false);
    expect((permissionsCheckbox as HTMLInputElement).checked).toBe(false);

    setOpen(false);
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Track task steps/i })).toBeNull();
    });

    setOpen(true);
    await screen.findByRole('button', { name: 'Create Task' });

    await openAdvanced();
    const reopenedCheckbox = await screen.findByRole('checkbox', {
      name: /Track task steps/i,
    });
    const reopenedPermissionsCheckbox = await screen.findByRole('checkbox', {
      name: /Dangerously skip all confirms/i,
    });
    expect((reopenedCheckbox as HTMLInputElement).checked).toBe(true);
    expect((reopenedPermissionsCheckbox as HTMLInputElement).checked).toBe(true);
  });

  it('keeps project-root mode available alongside active and collapsed project-root tasks', async () => {
    const user = userEvent.setup();
    setStore('tasks', {
      'root-active': createTestTask({ id: 'root-active', gitIsolation: 'current-branch' }),
      'root-collapsed': createTestTask({ id: 'root-collapsed', gitIsolation: 'current-branch' }),
    });
    setStore('taskOrder', ['root-active']);
    setStore('collapsedTaskOrder', ['root-collapsed']);
    setStore('projects', [
      createTestProject({
        defaultTaskGitIsolation: 'current-branch',
        id: 'project-1',
        path: '/repo',
      }),
    ]);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    const currentBranchButton = await screen.findByRole('button', { name: /^Project root/i });
    expect((currentBranchButton as HTMLButtonElement).disabled).toBe(false);
    expect(currentBranchButton.getAttribute('aria-pressed')).toBe('true');
    expect(currentBranchButton.getAttribute('title')).toMatch(
      /Reuses the project root instead of creating a worktree/i,
    );
    await user.type(screen.getByPlaceholderText('Add user authentication'), 'Parallel root agent');
    await user.click(screen.getByRole('button', { name: 'Create Task' }));
    await waitFor(() => expect(createCurrentBranchTaskMock).toHaveBeenCalledOnce());
  });

  it('widens the dialog when many agents are available', async () => {
    const agents = Array.from({ length: 9 }, (_, index) =>
      createTestAgentDef({
        id: `agent-${index}`,
        name: `Agent ${index}`,
      }),
    );
    setStore('availableAgents', agents);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await screen.findByRole('button', { name: 'Create Task' });

    expect(screen.getByRole('dialog', { name: 'New Task' }).style.width).toBe('560px');
  });

  it('widens the dialog and exposes isolation guidance in titles when project-root mode is active', async () => {
    setStore('projects', [
      createTestProject({
        defaultTaskGitIsolation: 'current-branch',
        id: 'project-1',
        path: '/repo',
      }),
    ]);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await screen.findByRole('button', { name: 'Create Task' });

    expect(screen.getByRole('dialog', { name: 'New Task' }).style.width).toBe('560px');
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

  it('does not submit a configured base branch as a root checkout selection', async () => {
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

      if (channel === 'get_gitignored_dirs') {
        return Promise.resolve({ candidates: [], truncated: false });
      }

      return Promise.resolve([]);
    });
    render(() => <NewTaskDialog open onClose={() => {}} />);

    await screen.findByRole('button', { name: 'Create Task' });
    const currentBranchButton = await screen.findByRole('button', { name: /^Project root/i });
    await Promise.resolve();
    await user.click(currentBranchButton);

    const taskNameInput = screen.getByPlaceholderText('Add user authentication');
    await user.type(taskNameInput, 'Ship it');

    await user.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(createCurrentBranchTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Ship it',
          projectId: 'project-1',
        }),
      );
    });
    expect(createCurrentBranchTaskMock.mock.calls[0]?.[0]).not.toHaveProperty('baseBranch');
  });

  it.each(['loading', 'unavailable', 'stale-default'] as const)(
    'allows root creation while branch metadata is %s without exposing a checkout selector',
    async (branchState) => {
      const user = userEvent.setup();
      setStore('projects', [
        createTestProject({
          baseBranch: 'removed/default',
          defaultTaskGitIsolation: 'current-branch',
        }),
      ]);
      invokeMock.mockImplementation((channel: string) => {
        if (channel !== 'list_branches') return Promise.resolve([]);
        if (branchState === 'loading') return new Promise(() => {});
        if (branchState === 'unavailable') return Promise.reject(new Error('Git unavailable'));
        return Promise.resolve({
          branches: [{ current: true, local: true, name: 'trunk', remote: false }],
          defaultBranch: 'trunk',
          generatedAt: 123,
        });
      });
      render(() => <NewTaskDialog open onClose={() => {}} />);
      await user.type(screen.getByPlaceholderText('Add user authentication'), 'Root task');
      await openAdvanced();
      expect(screen.queryByRole('combobox', { name: 'Base branch' })).toBeNull();
      expect(screen.getByText(/Uses the checked-out branch without switching it/)).toBeDefined();
      const submit = screen.getByRole('button', { name: 'Create Task' });
      expect((submit as HTMLButtonElement).disabled).toBe(false);
      await user.click(submit);
      await waitFor(() => expect(createCurrentBranchTaskMock).toHaveBeenCalledOnce());
      expect(createCurrentBranchTaskMock.mock.calls[0]?.[0]).not.toHaveProperty('baseBranch');
    },
  );

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

    await screen.findByRole('button', { name: 'Create Task' });
    expect(screen.queryByLabelText('Base branch')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Project root/i })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Use existing worktree/i })).toBeNull();
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === 'get_gitignored_dirs'),
    ).toHaveLength(0);

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

  it('creates terminal-only tasks for non-git projects without Git location metadata', async () => {
    const user = userEvent.setup();
    createTaskMock.mockImplementation(() => new Promise<string>(() => {}));
    setStore('projects', [
      createTestProject({
        path: '/tmp/folder',
        projectMode: 'non-git',
      }),
    ]);

    render(() => <NewTaskDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Terminal' }));
    await user.click(screen.getByRole('button', { name: 'Create Terminal Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          launch: { kind: 'terminal' },
          name: 'Terminal',
          projectId: 'project-1',
          projectMode: 'non-git',
        }),
      );
    });
    expect(listPendingTaskCreations()).toMatchObject([
      {
        taskMode: 'terminal',
      },
    ]);
    expect(listPendingTaskCreations()[0]).not.toHaveProperty('gitIsolation');
  });
});
