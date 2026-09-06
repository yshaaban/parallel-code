import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  TaskCreationAgentOperationSnapshot,
  TaskCreationCapabilities,
  TaskCreationClientFacade,
  TaskCreationPickerPage,
} from '../domain/task-creation';
import { TASK_CREATION_TICKET_TTL_MS } from '../domain/task-creation-ticket';
import type { TaskCreationOperationId } from '../domain/task-creation-ticket';
import type { RemoteAgentChoice, RemoteProjectSummary } from '../domain/task-catalog';
import { NewTaskView } from './NewTaskView';
import { REMOTE_NEW_TASK_PREFERENCES_STORAGE_KEY } from './new-task-preferences';
import type { TaskCatalogProjection } from './task-catalog-store';

const operationId = Buffer.alloc(16, 0x31).toString('base64url') as TaskCreationOperationId;

function capabilities(): TaskCreationCapabilities {
  return {
    coordinator: { reason: 'coordinator-not-supported', supported: false },
    enabled: true,
    locations: {
      'existing-worktree': { enabled: true },
      'managed-worktree': { enabled: true },
      'project-root': { enabled: true },
    },
    modes: { agent: { enabled: true }, terminal: { enabled: true } },
    permissionBypass: { enabled: true },
  };
}

function project(): RemoteProjectSummary {
  return {
    baseBranchChoiceCount: 1,
    baseBranchChoicesTruncated: false,
    id: 'project-1',
    label: 'Core project',
    labelTruncated: false,
    locations: {
      'existing-worktree': { enabled: true },
      'managed-worktree': { enabled: true },
      'project-root': { enabled: true },
    },
    projectMode: 'git',
    worktreeChoiceCount: 1,
    worktreeChoicesTruncated: false,
  };
}

function agent(): RemoteAgentChoice {
  return {
    agentDefId: 'claude-code',
    displayName: 'Claude Code',
    displayNameTruncated: false,
    glyph: null,
    glyphTruncated: false,
    providerLabel: 'Anthropic',
    providerLabelTruncated: false,
    supportsInitialPrompt: true,
    supportsPermissionBypass: true,
  };
}

function catalog(): TaskCatalogProjection {
  return {
    agents: new Map([['claude-code', agent()]]),
    catalogVersion: 2,
    projects: new Map([['project-1', project()]]),
    serverInstanceId: 'server-1',
    sessions: new Map(),
    sessionsByTask: new Map(),
    tasks: new Map(),
  };
}

function pickerPage(kind: TaskCreationPickerPage['kind']): TaskCreationPickerPage {
  return {
    catalogVersion: 2,
    generation: 1,
    items:
      kind === 'base-branch'
        ? [{ branchLabel: 'main', kind, label: 'main', ref: 'branch-main' }]
        : [
            {
              branchLabel: 'feature/imported',
              kind,
              label: 'Imported worktree',
              ownershipLabel: 'Externally owned',
              ref: 'worktree-1',
            },
          ],
    kind,
    nextCursor: null,
    serverInstanceId: 'server-1',
    truncated: false,
  };
}

function facade(): TaskCreationClientFacade {
  return {
    cancel: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    getCapabilities: vi.fn(async () => capabilities()),
    getPickerPage: vi.fn(async (request) => pickerPage(request.kind)),
    getWorktreeLinkCandidates: vi.fn(async () => ({
      candidates: [],
      kind: 'found' as const,
      truncated: false,
    })),
    issue: vi.fn(async () => ({
      expiresAt: 1 + TASK_CREATION_TICKET_TTL_MS,
      issuedAt: 1,
      operationId,
      operationTicket: 'ticket-1',
    })),
    retryShell: vi.fn(),
  };
}

function createdNeedsAttentionSnapshot(): TaskCreationAgentOperationSnapshot {
  return {
    commit: 'committed',
    committedTaskId: 'task-1',
    committedWorkspaceRevision: 5,
    current: {
      catalogVersion: 3,
      serverInstanceId: 'server-1',
      task: {
        branchLabel: 'feature/remote-agent',
        branchLabelTruncated: false,
        creationStatus: 'needs-attention',
        lifecycle: 'active',
        location: 'managed-worktree',
        name: 'Remote agent',
        nameTruncated: false,
        ownership: 'managed',
        projectId: 'project-1',
        sessionCount: 0,
        taskId: 'task-1',
        taskMode: 'agent',
      },
      taskClosing: false,
      taskState: 'present',
      workspaceRevision: 5,
    },
    issue: { code: 'launch-failed', message: 'Agent launch needs attention.', retryable: true },
    managedArtifactRecovery: { kind: 'none' },
    operationId,
    phase: 'created-needs-attention',
    recovery: {
      committedWorkspaceRevision: 5,
      kind: 'retry-agent-launch',
      launchOperationId: 'launch-1',
    },
    serverInstanceId: 'server-1',
    symlinkWarnings: [],
    taskMode: 'agent',
    version: 3,
  };
}

function renderView(currentFacade = facade(), onCreated = vi.fn(), currentCatalog = catalog()) {
  const result = render(() => (
    <NewTaskView
      capabilities={capabilities()}
      catalog={currentCatalog}
      facade={currentFacade}
      onBack={vi.fn()}
      onCreated={onCreated}
    />
  ));
  return { facade: currentFacade, onCreated, result };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function multiProjectCatalog(): TaskCatalogProjection {
  return {
    ...catalog(),
    projects: new Map([
      ['project-1', project()],
      ['project-2', { ...project(), id: 'project-2', label: 'Second project' }],
    ]),
  };
}

describe('NewTaskView', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('clears all project-scoped choices and consent before the next project loads', async () => {
    const currentFacade = facade();
    const branches = deferred<TaskCreationPickerPage>();
    const worktrees = deferred<TaskCreationPickerPage>();
    const links =
      deferred<Awaited<ReturnType<TaskCreationClientFacade['getWorktreeLinkCandidates']>>>();
    vi.mocked(currentFacade.getPickerPage).mockImplementation((request) =>
      request.projectId === 'project-1'
        ? Promise.resolve(pickerPage(request.kind))
        : request.kind === 'base-branch'
          ? branches.promise
          : worktrees.promise,
    );
    vi.mocked(currentFacade.getWorktreeLinkCandidates).mockImplementation((request) =>
      request.projectId === 'project-1'
        ? Promise.resolve({
            kind: 'found',
            candidates: [{ name: 'node_modules', isDefault: true }],
            truncated: false,
          })
        : links.promise,
    );
    renderView(currentFacade, vi.fn(), multiProjectCatalog());
    await screen.findByRole('option', { name: 'main' });
    await fireEvent.change(screen.getByLabelText('Base branch (optional)'), {
      target: { value: 'branch-main' },
    });
    await fireEvent.click(screen.getByLabelText('Reuse selected project dependencies'));
    await fireEvent.change(screen.getByLabelText('Working location'), {
      target: { value: 'existing-worktree' },
    });
    await fireEvent.change(screen.getByLabelText('Imported worktree'), {
      target: { value: 'worktree-1' },
    });

    await fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-2' } });
    const branchSelect = screen.getByLabelText('Base branch (optional)') as HTMLSelectElement;
    const worktreeSelect = screen.getByLabelText('Imported worktree') as HTMLSelectElement;
    expect(branchSelect.disabled).toBe(true);
    expect(branchSelect.value).toBe('');
    expect(worktreeSelect.disabled).toBe(true);
    expect(worktreeSelect.value).toBe('');
    expect(screen.queryByRole('option', { name: 'main' })).toBeNull();
    expect(screen.queryByRole('option', { name: /Imported worktree —/ })).toBeNull();
    expect(screen.getByText('Loading worktrees…')).toBeDefined();
    await fireEvent.change(screen.getByLabelText('Working location'), {
      target: { value: 'managed-worktree' },
    });
    expect(screen.queryByLabelText('Reuse selected project dependencies')).toBeNull();
    expect(screen.queryByText(/Links: node_modules/)).toBeNull();

    branches.resolve({
      ...pickerPage('base-branch'),
      items: [{ kind: 'base-branch', label: 'trunk', branchLabel: 'trunk', ref: 'branch-trunk' }],
    });
    worktrees.resolve({ ...pickerPage('existing-worktree'), items: [] });
    links.resolve({
      kind: 'found',
      candidates: [{ name: '.env', isDefault: true }],
      truncated: false,
    });
    await screen.findByRole('option', { name: 'trunk' });
    expect(branchSelect.disabled).toBe(false);
    expect(
      (screen.getByLabelText('Reuse selected project dependencies') as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.queryByText(/Loading/)).toBeNull();
    expect(screen.queryByText(/Links:/)).toBeNull();
  });

  it('retries failed choices independently and clears failure text when requests recover', async () => {
    const currentFacade = facade();
    vi.mocked(currentFacade.getPickerPage)
      .mockRejectedValueOnce(new Error('Branches offline'))
      .mockRejectedValueOnce(new Error('Worktrees offline'));
    vi.mocked(currentFacade.getWorktreeLinkCandidates).mockResolvedValueOnce({
      kind: 'unavailable',
    });
    renderView(currentFacade);
    const retryBranches = await screen.findByRole('button', { name: 'Retry branches' });
    const retryLinks = await screen.findByRole('button', { name: 'Retry reusable dependencies' });
    await fireEvent.click(retryBranches);
    await screen.findByRole('option', { name: 'main' });
    expect(screen.queryByText(/Could not load branches/)).toBeNull();
    expect(currentFacade.getPickerPage).toHaveBeenCalledTimes(3);
    await fireEvent.click(retryLinks);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Retry reusable dependencies' })).toBeNull(),
    );
    await fireEvent.change(screen.getByLabelText('Working location'), {
      target: { value: 'existing-worktree' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Retry worktrees' }));
    await screen.findByRole('option', { name: /Imported worktree —/ });
    expect(screen.queryByText(/Could not load/)).toBeNull();
    expect(currentFacade.getPickerPage).toHaveBeenCalledTimes(4);
  });

  it('allows root creation without waiting for unrelated metadata', async () => {
    const currentFacade = facade();
    vi.mocked(currentFacade.getPickerPage).mockImplementation(() => new Promise(() => {}));
    vi.mocked(currentFacade.getWorktreeLinkCandidates).mockImplementation(
      () => new Promise(() => {}),
    );
    vi.mocked(currentFacade.create).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot: createdNeedsAttentionSnapshot(),
    });
    renderView(currentFacade);
    await fireEvent.change(screen.getByLabelText('Working location'), {
      target: { value: 'project-root' },
    });
    await fireEvent.input(screen.getByLabelText('Task name'), {
      target: { value: 'Root while offline' },
    });
    expect((screen.getByLabelText('Agent') as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByText(/Loading/)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Ready to create' }));
    await waitFor(() => expect(currentFacade.create).toHaveBeenCalledOnce());
    expect(vi.mocked(currentFacade.create).mock.calls[0]?.[0]).toMatchObject({
      location: { kind: 'project-root' },
    });
  });

  it('ignores obsolete successes and errors after A → B → A, and aborts on teardown', async () => {
    const currentFacade = facade();
    const oldBranches = deferred<TaskCreationPickerPage>();
    const oldWorktrees = deferred<TaskCreationPickerPage>();
    const oldLinks =
      deferred<Awaited<ReturnType<TaskCreationClientFacade['getWorktreeLinkCandidates']>>>();
    vi.mocked(currentFacade.getPickerPage)
      .mockImplementationOnce(() => oldBranches.promise)
      .mockImplementationOnce(() => oldWorktrees.promise);
    vi.mocked(currentFacade.getWorktreeLinkCandidates).mockImplementationOnce(
      () => oldLinks.promise,
    );
    const current = renderView(currentFacade, vi.fn(), multiProjectCatalog());
    await fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-2' } });
    await fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-1' } });
    await screen.findByRole('option', { name: 'main' });
    await fireEvent.change(screen.getByLabelText('Base branch (optional)'), {
      target: { value: 'branch-main' },
    });

    oldBranches.resolve({
      ...pickerPage('base-branch'),
      items: [
        { kind: 'base-branch', label: 'obsolete', branchLabel: 'obsolete', ref: 'branch-obsolete' },
      ],
    });
    oldWorktrees.reject(new Error('Obsolete failure'));
    oldLinks.resolve({
      kind: 'found',
      candidates: [{ name: 'obsolete-secret', isDefault: true }],
      truncated: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole('option', { name: 'obsolete' })).toBeNull();
    expect((screen.getByLabelText('Base branch (optional)') as HTMLSelectElement).value).toBe(
      'branch-main',
    );
    expect(screen.queryByLabelText('Reuse selected project dependencies')).toBeNull();
    await fireEvent.change(screen.getByLabelText('Working location'), {
      target: { value: 'existing-worktree' },
    });
    expect(screen.getByRole('option', { name: /Imported worktree —/ })).toBeDefined();
    expect(screen.queryByText(/Could not load/)).toBeNull();
    const pickerCalls = vi.mocked(currentFacade.getPickerPage).mock.calls;
    expect(pickerCalls).toHaveLength(6);
    expect(pickerCalls.slice(0, 4).every((call) => call[1]?.aborted)).toBe(true);
    expect(pickerCalls.slice(4).every((call) => call[1]?.aborted === false)).toBe(true);
    current.result.unmount();
    expect(pickerCalls.every((call) => call[1]?.aborted)).toBe(true);
    expect(
      vi
        .mocked(currentFacade.getWorktreeLinkCandidates)
        .mock.calls.every((call) => call[1]?.aborted),
    ).toBe(true);
  });

  it('bounds cyclic picker pagination and exposes retry instead of spinning', async () => {
    const currentFacade = facade();
    vi.mocked(currentFacade.getPickerPage).mockImplementation(async (request) => ({
      ...pickerPage(request.kind),
      items: [],
      nextCursor: 'repeated-cursor',
    }));
    renderView(currentFacade);
    await screen.findByRole('button', { name: 'Retry branches' });
    expect(currentFacade.getPickerPage).toHaveBeenCalledTimes(4);
    expect((screen.getByLabelText('Base branch (optional)') as HTMLSelectElement).disabled).toBe(
      true,
    );
  });

  it('focuses and associates an exact UTF-8 validation error before ticket issue', async () => {
    const current = renderView();
    const nameInput = screen.getByLabelText('Task name') as HTMLInputElement;
    await fireEvent.input(nameInput, { target: { value: '🚀'.repeat(65) } });
    await fireEvent.click(screen.getByRole('button', { name: 'Ready to create' }));

    await screen.findByRole('alert');
    const error = document.getElementById('new-task-name-error');
    expect(error?.textContent).toMatch(/Task name must be at most 256 UTF-8 bytes/u);
    await waitFor(() => expect(document.activeElement).toBe(nameInput));
    expect(nameInput.getAttribute('aria-invalid')).toBe('true');
    expect(nameInput.getAttribute('aria-describedby')).toBe('new-task-name-error');
    expect(current.facade.issue).not.toHaveBeenCalled();
  });

  it('renders and associates the imported-worktree requirement', async () => {
    const current = renderView();
    await fireEvent.input(screen.getByLabelText('Task name'), {
      target: { value: 'Imported task' },
    });
    await fireEvent.change(screen.getByLabelText('Working location'), {
      target: { value: 'existing-worktree' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Ready to create' }));

    const select = screen.getByRole('combobox', { name: 'Imported worktree' }) as HTMLSelectElement;
    await screen.findByRole('alert');
    const error = document.getElementById('new-task-worktree-error');
    expect(error?.textContent).toBe('Choose an imported worktree.');
    await waitFor(() => expect(document.activeElement).toBe(select));
    expect(select.getAttribute('aria-describedby')).toContain('new-task-worktree-error');
    expect(current.facade.issue).not.toHaveBeenCalled();
  });

  it('navigates a committed task that needs attention instead of stranding it in the form', async () => {
    const currentFacade = facade();
    vi.mocked(currentFacade.create).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot: createdNeedsAttentionSnapshot(),
    });
    const onCreated = vi.fn();
    renderView(currentFacade, onCreated);
    await fireEvent.input(screen.getByLabelText('Task name'), {
      target: { value: 'Remote agent' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Ready to create' }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ phase: 'created-needs-attention' }),
      );
    });
  });

  it('keeps project-root creation independent from a previously selected worktree base', async () => {
    const currentFacade = facade();
    vi.mocked(currentFacade.create).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot: createdNeedsAttentionSnapshot(),
    });
    renderView(currentFacade);
    await screen.findByRole('option', { name: 'main' });
    await fireEvent.change(screen.getByLabelText('Base branch (optional)'), {
      target: { value: 'branch-main' },
    });
    await fireEvent.input(screen.getByLabelText('Branch prefix (optional)'), {
      target: { value: '🚀'.repeat(25) },
    });
    await fireEvent.change(screen.getByLabelText('Working location'), {
      target: { value: 'project-root' },
    });
    expect(screen.queryByLabelText('Base branch (optional)')).toBeNull();
    expect(screen.queryByLabelText('Branch prefix (optional)')).toBeNull();
    expect(screen.getByText(/Uses the checked-out branch without switching it/)).toBeDefined();
    await fireEvent.input(screen.getByLabelText('Task name'), {
      target: { value: 'Parallel root agent' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Ready to create' }));
    await waitFor(() => expect(currentFacade.create).toHaveBeenCalledOnce());
    expect(vi.mocked(currentFacade.create).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ location: { kind: 'project-root' } }),
    );
    expect(vi.mocked(currentFacade.create).mock.calls[0]?.[0]).not.toHaveProperty('baseBranchRef');
    expect(vi.mocked(currentFacade.create).mock.calls[0]?.[0]).not.toHaveProperty(
      'branchPrefixPreference',
    );
  });

  it('does not promise Git branches or worktree isolation for a non-Git project root', async () => {
    const nonGitProject: RemoteProjectSummary = {
      ...project(),
      projectMode: 'non-git',
      locations: {
        'existing-worktree': { enabled: false, reason: 'project-mode-unavailable' },
        'managed-worktree': { enabled: false, reason: 'project-mode-unavailable' },
        'project-root': { enabled: true },
      },
    };
    const currentCatalog: TaskCatalogProjection = {
      ...catalog(),
      projects: new Map([['project-1', nonGitProject]]),
    };
    renderView(facade(), vi.fn(), currentCatalog);
    await waitFor(() =>
      expect((screen.getByLabelText('Working location') as HTMLSelectElement).value).toBe(
        'project-root',
      ),
    );
    expect(screen.queryByLabelText('Base branch (optional)')).toBeNull();
    expect(screen.queryByLabelText('Branch prefix (optional)')).toBeNull();
    expect(
      screen.getByText(
        'Project-root tasks share files in this folder, so concurrent edits can overlap.',
      ),
    ).toBeDefined();
    expect(screen.queryByText(/checked-out branch/)).toBeNull();
  });

  it('requires permission bypass to be selected again on every new form', async () => {
    window.localStorage.setItem(
      REMOTE_NEW_TASK_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        agentDefId: 'claude-code',
        branchPrefixPreference: 'legacy-prefix',
        location: 'project-root',
        projectId: 'project-1',
        reuseDependencies: true,
        skipPermissions: true,
        stepsTracking: false,
        taskMode: 'terminal',
      }),
    );
    const currentFacade = facade();
    vi.mocked(currentFacade.create).mockResolvedValue({
      kind: 'snapshot',
      outcome: 'accepted',
      snapshot: createdNeedsAttentionSnapshot(),
    });
    const first = renderView(currentFacade);

    const firstBypass = screen.getByLabelText(
      'Bypass agent permission prompts',
    ) as HTMLInputElement;
    expect(firstBypass.checked).toBe(false);
    expect((screen.getByLabelText('Working location') as HTMLSelectElement).value).toBe(
      'managed-worktree',
    );
    expect((screen.getByLabelText('Track task steps') as HTMLInputElement).checked).toBe(true);

    await fireEvent.click(firstBypass);
    await fireEvent.input(screen.getByLabelText('Task name'), {
      target: { value: 'Explicit bypass' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Ready to create' }));
    await waitFor(() => expect(first.onCreated).toHaveBeenCalledOnce());
    expect(
      JSON.parse(window.localStorage.getItem(REMOTE_NEW_TASK_PREFERENCES_STORAGE_KEY) ?? ''),
    ).toEqual({
      agentDefId: 'claude-code',
      projectId: 'project-1',
    });

    first.result.unmount();
    window.sessionStorage.clear();
    renderView();
    expect(
      (screen.getByLabelText('Bypass agent permission prompts') as HTMLInputElement).checked,
    ).toBe(false);
  });
});
