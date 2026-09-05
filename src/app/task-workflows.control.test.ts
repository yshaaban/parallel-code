import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { buildCoordinatorInitialPrompt } from '../domain/coordinator-instructions';
import type { RendererInvokeResponseMap } from '../domain/renderer-invoke';
import { consumePendingShellCommand } from '../lib/bookmarks';
import { setStore, store } from '../store/core';
import { resetPersistenceSessionStateForTests } from '../store/persistence-session';
import { resetTaskCommandControllerStateForTests } from '../store/task-command-controllers';
import { clearAgentBusyState, markAgentOutput } from '../store/taskStatus';
import {
  clearCompatibilityTerminalCreationsForTests,
  isCompatibilityTerminalCreationPending,
  markCompatibilityTerminalCreationPending,
} from '../runtime/compatibility-terminal-creation';
import {
  createTestAgent,
  createTestAgentDef,
  createTestProject,
  createTestTask,
  resetStoreForTest,
} from '../test/store-test-helpers';

const {
  confirmMock,
  invokeMock,
  runtimeClientIdMock,
  runtimeLeaseOwnerIdMock,
  saveBrowserWorkspaceStateMock,
  saveCurrentRuntimeStateMock,
  showNotificationMock,
  retireTaskNotesMock,
} = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  invokeMock: vi.fn(),
  runtimeClientIdMock: vi.fn(() => 'client-self'),
  runtimeLeaseOwnerIdMock: vi.fn(() => 'runtime-owner-self'),
  saveBrowserWorkspaceStateMock: vi.fn(() => Promise.resolve()),
  saveCurrentRuntimeStateMock: vi.fn(() => Promise.resolve()),
  showNotificationMock: vi.fn(),
  retireTaskNotesMock: vi.fn(),
}));

vi.mock('../lib/dialog', () => ({
  confirm: confirmMock,
}));

vi.mock('../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../lib/ipc')>('../lib/ipc');
  return {
    ...actual,
    invoke: invokeMock,
    invokeOnce: invokeMock,
  };
});

vi.mock('../lib/runtime-client-id', () => ({
  getRuntimeClientId: runtimeClientIdMock,
  getRuntimeLeaseOwnerId: runtimeLeaseOwnerIdMock,
}));

vi.mock('../store/persistence', async () => {
  const actual =
    await vi.importActual<typeof import('../store/persistence')>('../store/persistence');
  return {
    ...actual,
    saveBrowserWorkspaceState: saveBrowserWorkspaceStateMock,
    saveCurrentRuntimeState: saveCurrentRuntimeStateMock,
  };
});

vi.mock('../store/notification', () => ({
  showNotification: showNotificationMock,
}));

import {
  collapseTask,
  closeShell,
  closeTask,
  createCurrentBranchTask,
  createTask,
  mergeTask,
  pushTask,
  resetTaskLifecycleRuntimeStateForTests,
  retryCloseTask,
  runBookmarkInTask,
  sendAgentEnter,
  sendPrompt,
  uncollapseTask,
  spawnShellForTask,
} from './task-workflows';
import { resetTaskCommandLeaseStateForTests } from './task-command-lease';
import { clearRetainedTaskMergeOperation } from './task-merge-operation-access';
import { notifyTaskMergeFinalizerRepair } from './task-merge-operation-recovery';
import { getAgentPromptDispatchAt } from './task-prompt-dispatch';
import {
  publishUnsavedDesktopTaskNotes,
  registerDesktopTaskNotesOwner,
} from './task-notes-recovery-channel';

let taskCommandControllerVersion = 0;
let taskCommandLeaseGeneration = 0;

function createMemoryStorage(options: { failWrites?: boolean } = {}): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      if (options.failWrites) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      values.set(key, value);
    },
  };
}

function withControllerVersion<T extends { taskId: string }>(
  value: T,
): T & { leaseGeneration: number; version: number } {
  taskCommandControllerVersion += 1;
  return {
    ...value,
    version: taskCommandControllerVersion,
    leaseGeneration: ++taskCommandLeaseGeneration,
  };
}

function getTaskIdArg(args: unknown): string {
  return (args as { taskId: string }).taskId;
}

function createAcquireLeaseResult(
  args: unknown,
  action: string,
  acquired = true,
  controllerId = 'client-self',
): RendererInvokeResponseMap[IPC.AcquireTaskCommandLease] {
  return withControllerVersion({
    acquired,
    action,
    controllerId,
    taskId: getTaskIdArg(args),
  });
}

function createReleaseLeaseResult(
  args: unknown,
): RendererInvokeResponseMap[IPC.ReleaseTaskCommandLease] {
  return withControllerVersion({
    action: null,
    controllerId: null,
    taskId: getTaskIdArg(args),
  });
}

function createRenewLeaseResult(
  args: unknown,
): RendererInvokeResponseMap[IPC.RenewTaskCommandLease] {
  return withControllerVersion({
    action: 'noop',
    controllerId: 'client-self',
    renewed: true,
    taskId: getTaskIdArg(args),
  });
}

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  reject: (error?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function requireInvokeImplementation() {
  const implementation = invokeMock.getMockImplementation();
  if (!implementation) throw new Error('Expected the default IPC test implementation');
  return implementation;
}

function createWorkspacePayload(
  tasks: Record<string, unknown>,
  taskOrder = Object.keys(tasks),
  revision = 2,
): RendererInvokeResponseMap[IPC.LoadWorkspaceState] {
  return {
    json: JSON.stringify({
      collapsedTaskOrder: [],
      projects: store.projects,
      taskOrder,
      tasks,
    }),
    revision,
  };
}

type TaskMergeResponse = RendererInvokeResponseMap[IPC.StartTaskMergeOperation];

function createTaskMergeResult(
  cleanup: boolean,
  overrides: {
    currentRemoval?: TaskMergeResponse['currentRemoval'];
    outcome?: Partial<TaskMergeResponse['originalOutcome']>;
    replayed?: boolean;
  } = {},
): TaskMergeResponse {
  const defaultRemoval: TaskMergeResponse['currentRemoval'] = cleanup
    ? {
        deletionOperationId: 'merge-operation-1',
        removed: true,
        removalState: 'complete',
        taskId: 'task-1',
      }
    : null;
  return {
    currentProgress: {
      dateKey: '2026-08-04',
      linesAdded: cleanup ? 12 : 0,
      linesRemoved: cleanup ? 4 : 0,
      schemaVersion: 1 as const,
      tasksToday: cleanup ? 1 : 0,
      updatedAt: '2026-08-04T00:00:00.000Z',
      version: cleanup ? 1 : 0,
    },
    currentRemoval:
      overrides.currentRemoval === undefined ? defaultRemoval : overrides.currentRemoval,
    originalOutcome: {
      cleanupRequested: cleanup,
      counted: cleanup,
      gitMerged: true,
      linesAdded: 12,
      linesRemoved: 4,
      operationId: 'merge-operation-1',
      phase: cleanup ? ('completed' as const) : ('completed-not-counted' as const),
      ...(cleanup ? { progressVersionAtOutcome: 1 } : {}),
      taskId: 'task-1',
      taskReleased: cleanup,
      version: 4,
      ...overrides.outcome,
    },
    replayed: overrides.replayed ?? false,
  };
}

function installTaskFixture(): void {
  const project = createTestProject();
  const task = createTestTask({
    agentIds: ['agent-1'],
    shellAgentIds: ['shell-1'],
  });
  const agent = createTestAgent();
  const shellAgent = createTestAgent({
    id: 'shell-1',
    taskId: 'task-1',
  });

  setStore('projects', [project]);
  setStore('taskOrder', ['task-1']);
  setStore('tasks', {
    'task-1': task,
  });
  setStore('agents', {
    'agent-1': agent,
    'shell-1': shellAgent,
  });
  setStore('activeTaskId', 'task-1');
  setStore('activeAgentId', 'agent-1');
}

function markShellPromptReady(promptTail = '❯ ', shellId = 'shell-1', taskId = 'task-1'): void {
  markAgentOutput(shellId, new TextEncoder().encode(promptTail), taskId, 'shell');
  clearAgentBusyState(shellId);
}

describe('task workflow control leases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    taskCommandControllerVersion = 0;
    taskCommandLeaseGeneration = 0;
    vi.stubGlobal('sessionStorage', createMemoryStorage());
    resetTaskCommandControllerStateForTests();
    resetTaskCommandLeaseStateForTests();
    resetTaskLifecycleRuntimeStateForTests();
    resetPersistenceSessionStateForTests();
    clearCompatibilityTerminalCreationsForTests();
    resetStoreForTest();
    installTaskFixture();
    confirmMock.mockResolvedValue(true);
    runtimeClientIdMock.mockReturnValue('client-self');
    runtimeLeaseOwnerIdMock.mockReturnValue('runtime-owner-self');
    saveBrowserWorkspaceStateMock.mockReset();
    saveBrowserWorkspaceStateMock.mockResolvedValue(undefined);
    saveCurrentRuntimeStateMock.mockReset();
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);
    showNotificationMock.mockReset();
    retireTaskNotesMock.mockReset();
    publishUnsavedDesktopTaskNotes([]);
    registerDesktopTaskNotesOwner({
      discardRecovered: vi.fn(),
      reconcileTasks: vi.fn(),
      retireRemovedTask: retireTaskNotesMock,
    });
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.DeleteTask:
          return Promise.resolve({ cleanupWarnings: [] });
        case IPC.CleanupTaskRuntime:
          return Promise.resolve({ cleanupWarnings: [] });
        case IPC.IssueTaskMergeOperation:
          return Promise.resolve({
            firstAdmissionExpiresAt: Date.now() + 60_000,
            issuedAt: Date.now(),
            operationCapability: 'merge-capability-1',
            operationId: 'merge-operation-1',
          });
        case IPC.StartTaskMergeOperation:
          return Promise.resolve(
            createTaskMergeResult(
              (args as { semanticRequest: { cleanup: boolean } }).semanticRequest.cleanup,
            ),
          );
        case IPC.GetTaskMergeOperationStatus:
          return Promise.resolve(createTaskMergeResult(true));
        case IPC.LoadWorkspaceState:
          return Promise.resolve(createWorkspacePayload({}, [], 3));
        case IPC.WriteToAgent:
          return Promise.resolve(undefined);
        case IPC.SendTaskPromptInput:
          return Promise.resolve({
            admission: {
              admittedSupervisionVersion: 12,
              kind: 'accepted',
              lowLevelCallCount: 1,
            },
          });
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });
  });

  afterEach(() => {
    resetTaskCommandControllerStateForTests();
    resetTaskCommandLeaseStateForTests();
    resetTaskLifecycleRuntimeStateForTests();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('sends prompts under a task command lease and records the last prompt', async () => {
    const promise = sendPrompt('task-1', 'agent-1', 'Ship it');

    await promise;

    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.AcquireTaskCommandLease, {
      action: 'send a prompt',
      clientId: 'client-self',
      ownerId: 'runtime-owner-self',
      taskId: 'task-1',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.SendTaskPromptInput, {
      agentId: 'agent-1',
      controllerId: 'client-self',
      taskId: 'task-1',
      text: 'Ship it',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(
      3,
      IPC.ReleaseTaskCommandLease,
      expect.objectContaining({
        clientId: 'client-self',
        leaseGeneration: expect.any(Number),
        ownerId: 'runtime-owner-self',
        taskId: 'task-1',
      }),
    );
    expect(store.tasks['task-1']?.lastPrompt).toBe('Ship it');
  });

  it('creates non-git tasks without sending git-only creation fields', async () => {
    const agentDef = createTestAgentDef({ id: 'codex', name: 'Codex' });
    setStore('projects', [
      createTestProject({
        id: 'project-1',
        path: '/tmp/folder',
        projectMode: 'non-git',
      }),
    ]);
    const operationLink = {
      creationOperationId: 'creation-non-git',
      kind: 'creation-v1' as const,
      launchOperationId: 'launch-non-git',
    };
    const provenance = { creationWriterEpoch: 'managed-initial-shell-v1' as const };
    const shellOwnership = { kind: 'not-applicable-agent' as const, migrationSchemaVersion: 1 };
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.CreateTask) {
        return Promise.resolve({
          branch_name: '',
          creation_writer_epoch: 'managed-initial-shell-v1',
          id: 'task-non-git',
          project_mode: 'non-git',
          session_id: 'agent-non-git',
          task_creation_operation_link: operationLink,
          task_creation_provenance: provenance,
          task_initial_shell_ownership: shellOwnership,
          workspace_revision: 1,
          worktree_path: '/tmp/folder',
        });
      }
      if (channel === IPC.LoadWorkspaceState) {
        return Promise.resolve(
          createWorkspacePayload(
            {
              'task-non-git': {
                agentDef,
                agentId: 'agent-non-git',
                agentIds: ['agent-non-git'],
                branchName: '',
                id: 'task-non-git',
                lastPrompt: '',
                name: 'Folder task',
                notes: '',
                projectId: 'project-1',
                projectMode: 'non-git',
                selectedAgentId: 'agent-non-git',
                shellAgentIds: [],
                shellCount: 0,
                skipPermissions: false,
                taskCreationOperationLink: operationLink,
                taskCreationProvenance: provenance,
                taskInitialShellOwnership: shellOwnership,
                taskMode: 'agent',
                worktreePath: '/tmp/folder',
              },
            },
            ['task-non-git'],
            1,
          ),
        );
      }
      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    await expect(
      createTask({
        adapterOperationId: 'test-create-1',
        launch: { kind: 'agent', agentDef },
        branchPrefixOverride: 'feature',
        name: 'Folder task',
        projectId: 'project-1',
        projectMode: 'non-git',
        symlinkDirs: [],
      }),
    ).resolves.toBe('task-non-git');

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.CreateTask,
      expect.not.objectContaining({
        baseBranch: expect.anything(),
        branchPrefix: expect.anything(),
        existingWorktreePath: expect.anything(),
        gitIsolation: expect.anything(),
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      IPC.CreateTask,
      expect.objectContaining({
        operationId: expect.any(String),
        projectMode: 'non-git',
        projectRoot: '/tmp/folder',
      }),
    );
  });

  it('creates terminal-only tasks with one focused shell and no agent runtime', async () => {
    setStore('projects', [createTestProject({ id: 'project-1', path: '/repo' })]);
    const operationLink = {
      creationOperationId: 'creation-terminal',
      kind: 'creation-v1' as const,
      launchOperationId: 'launch-terminal',
    };
    const provenance = { creationWriterEpoch: 'managed-initial-shell-v1' as const };
    const shellOwnership = {
      expectedGeneration: 0,
      kind: 'managed-terminal-v1' as const,
      launchOperationId: 'launch-terminal',
      sessionId: 'shell-canonical',
    };
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.CreateTask)
        return Promise.resolve({
          base_branch: 'main',
          branch_name: 'task/terminal',
          creation_writer_epoch: 'managed-initial-shell-v1',
          git_isolation: 'worktree',
          id: 'task-terminal',
          session_id: 'shell-canonical',
          task_creation_operation_link: operationLink,
          task_creation_provenance: provenance,
          task_initial_shell_ownership: shellOwnership,
          workspace_revision: 1,
          worktree_path: '/repo/.worktrees/task-terminal',
        });
      if (channel === IPC.LoadWorkspaceState)
        return Promise.resolve(
          createWorkspacePayload(
            {
              'task-terminal': {
                agentDef: null,
                agentId: null,
                baseBranch: 'main',
                branchName: 'task/terminal',
                gitIsolation: 'worktree',
                id: 'task-terminal',
                lastPrompt: '',
                name: 'Terminal',
                notes: '',
                projectId: 'project-1',
                shellAgentIds: ['shell-canonical'],
                shellCount: 1,
                taskCreationOperationLink: operationLink,
                taskCreationProvenance: provenance,
                taskInitialShellOwnership: shellOwnership,
                taskMode: 'terminal',
                worktreePath: '/repo/.worktrees/task-terminal',
              },
            },
            ['task-terminal'],
            1,
          ),
        );
      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    await expect(
      createTask({
        adapterOperationId: 'test-create-2',
        launch: { kind: 'terminal' },
        name: 'Terminal',
        projectId: 'project-1',
      }),
    ).resolves.toBe('task-terminal');

    const task = store.tasks['task-terminal'];
    expect(task).toMatchObject({
      agentIds: [],
      shellAgentIds: ['shell-canonical'],
      taskCreationProvenance: { creationWriterEpoch: 'managed-initial-shell-v1' },
      taskMode: 'terminal',
    });
    expect(task?.selectedAgentId).toBeUndefined();
    expect(store.agents).not.toHaveProperty(task?.shellAgentIds[0] ?? '');
    expect(store.activeAgentId).toBe(task?.shellAgentIds[0]);
    expect(store.focusedPanel['task-terminal']).toBe('shell:0');
    expect(invokeMock).toHaveBeenCalledWith(
      IPC.CreateTask,
      expect.not.objectContaining({
        agentDefId: expect.anything(),
        agentDefName: expect.anything(),
      }),
    );
  });

  it('replays a committed project-root create after projection failure and later sync', async () => {
    const operationLink = {
      creationOperationId: 'creation-root-replay',
      kind: 'creation-v1' as const,
      launchOperationId: 'launch-root-replay',
    };
    const provenance = { creationWriterEpoch: 'managed-initial-shell-v1' as const };
    const shellOwnership = {
      expectedGeneration: 0,
      kind: 'managed-terminal-v1' as const,
      launchOperationId: 'launch-root-replay',
      sessionId: 'shell-root-replay',
    };
    const canonicalTask = {
      agentDef: null,
      agentId: null,
      branchName: 'main',
      gitIsolation: 'current-branch',
      id: 'task-root-replay',
      lastPrompt: '',
      name: 'Root terminal',
      notes: '',
      projectId: 'project-1',
      shellAgentIds: ['shell-root-replay'],
      shellCount: 1,
      taskCreationOperationLink: operationLink,
      taskCreationProvenance: provenance,
      taskInitialShellOwnership: shellOwnership,
      taskMode: 'terminal',
      worktreePath: '/repo',
    };
    const committedResult = {
      base_branch: 'main',
      branch_name: 'main',
      creation_writer_epoch: 'managed-initial-shell-v1' as const,
      git_isolation: 'current-branch' as const,
      id: 'task-root-replay',
      session_id: 'shell-root-replay',
      task_creation_operation_link: operationLink,
      task_creation_provenance: provenance,
      task_initial_shell_ownership: shellOwnership,
      workspace_revision: 4,
      worktree_path: '/repo',
    };
    let loadCount = 0;
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.CreateTask) return Promise.resolve(committedResult);
      if (channel === IPC.LoadWorkspaceState) {
        loadCount += 1;
        return loadCount === 1
          ? Promise.reject(new Error('projection response lost'))
          : Promise.resolve(
              createWorkspacePayload({ 'task-root-replay': canonicalTask }, undefined, 4),
            );
      }
      throw new Error(`Unexpected IPC channel: ${channel}`);
    });
    const options = {
      adapterOperationId: 'root-replay-adapter-operation',
      launch: { kind: 'terminal' as const },
      name: 'Root terminal',
      projectId: 'project-1',
    };

    await expect(createCurrentBranchTask(options)).rejects.toThrow('projection response lost');
    setStore('tasks', {
      'task-root-replay': createTestTask({
        branchName: 'main',
        gitIsolation: 'current-branch',
        id: 'task-root-replay',
        projectId: 'project-1',
        taskMode: 'terminal',
        worktreePath: '/repo',
      }),
    });
    setStore('taskOrder', ['task-root-replay']);

    await expect(createCurrentBranchTask(options)).resolves.toBe('task-root-replay');
    const createCalls = invokeMock.mock.calls.filter(([channel]) => channel === IPC.CreateTask);
    expect(createCalls).toHaveLength(2);
    expect(
      createCalls.map(([, request]) => (request as { operationId: string }).operationId),
    ).toEqual([options.adapterOperationId, options.adapterOperationId]);
    expect(store.taskOrder.filter((taskId) => taskId === 'task-root-replay')).toHaveLength(1);
  });

  it('keeps a successful task and surfaces one bounded ignored-file warning summary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStore('projects', [createTestProject({ id: 'project-1', path: '/repo' })]);
    const operationLink = {
      creationOperationId: 'creation-warnings',
      kind: 'creation-v1' as const,
      launchOperationId: 'launch-warnings',
    };
    const provenance = { creationWriterEpoch: 'managed-initial-shell-v1' as const };
    const shellOwnership = {
      expectedGeneration: 0,
      kind: 'managed-terminal-v1' as const,
      launchOperationId: 'launch-warnings',
      sessionId: 'shell-warnings',
    };
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.CreateTask)
        return Promise.resolve({
          base_branch: 'main',
          branch_name: 'task/warnings',
          creation_writer_epoch: 'managed-initial-shell-v1',
          git_isolation: 'worktree',
          id: 'task-warnings',
          session_id: 'shell-warnings',
          symlink_warnings: [
            {
              message: 'The requested source is no longer eligible.',
              name: '.env.local',
              reason: 'not_current_candidate' as const,
            },
            {
              message: 'The worktree destination already exists.',
              name: 'node_modules',
              reason: 'destination_exists' as const,
            },
          ],
          task_creation_operation_link: operationLink,
          task_creation_provenance: provenance,
          task_initial_shell_ownership: shellOwnership,
          workspace_revision: 1,
          worktree_path: '/repo/.worktrees/task-warnings',
        });
      if (channel === IPC.LoadWorkspaceState)
        return Promise.resolve(
          createWorkspacePayload(
            {
              'task-warnings': {
                agentDef: null,
                agentId: null,
                baseBranch: 'main',
                branchName: 'task/warnings',
                gitIsolation: 'worktree',
                id: 'task-warnings',
                lastPrompt: '',
                name: 'Warnings',
                notes: '',
                projectId: 'project-1',
                shellAgentIds: ['shell-warnings'],
                shellCount: 1,
                taskCreationOperationLink: operationLink,
                taskCreationProvenance: provenance,
                taskInitialShellOwnership: shellOwnership,
                taskMode: 'terminal',
                worktreePath: '/repo/.worktrees/task-warnings',
              },
            },
            ['task-warnings'],
            1,
          ),
        );
      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    await expect(
      createTask({
        adapterOperationId: 'test-create-3',
        launch: { kind: 'terminal' },
        name: 'Warnings',
        projectId: 'project-1',
      }),
    ).resolves.toBe('task-warnings');

    expect(store.tasks['task-warnings']).toBeDefined();
    expect(showNotificationMock).toHaveBeenCalledOnce();
    expect(showNotificationMock).toHaveBeenCalledWith(
      'Task created, but 2 ignored entries could not be shared with its worktree.',
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('Task created with ignored-file sharing warnings:', {
      count: 2,
      reasonCounts: {
        destination_exists: 1,
        not_current_candidate: 1,
      },
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('.env.local');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('node_modules');
  });

  it('wraps coordinator task prompts with tool instructions and preserves them as the saved initial prompt', async () => {
    const agentDef = createTestAgentDef({ id: 'codex', name: 'Codex' });
    setStore('projects', [
      createTestProject({
        id: 'project-1',
        path: '/repo',
      }),
    ]);
    const canonicalPrompt = buildCoordinatorInitialPrompt('Build the coordinator slice');
    const canonicalAgentDef = {
      ...agentDef,
      env: {
        ...(agentDef.env ?? {}),
        PARALLEL_CODE_COORDINATOR_CREDENTIAL: '/tmp/coordinator-credential.json',
        PARALLEL_CODE_COORDINATOR_RUN_ID: 'run-1',
        PARALLEL_CODE_COORDINATOR_TOOL: 'parallel-code-coordinator',
      },
    };
    const operationLink = {
      creationOperationId: 'creation-1',
      kind: 'creation-v1' as const,
      launchOperationId: 'launch-1',
    };
    const provenance = { creationWriterEpoch: 'managed-initial-shell-v1' as const };
    const shellOwnership = { kind: 'not-applicable-agent' as const, migrationSchemaVersion: 1 };
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.CreateTask:
          return Promise.resolve({
            base_branch: 'main',
            branch_name: 'feature/task-new',
            coordinator_credential_path: '/tmp/coordinator-credential.json',
            coordinator_run_id: 'run-1',
            coordinator_tool_command: 'parallel-code-coordinator',
            creation_writer_epoch: 'managed-initial-shell-v1',
            git_isolation: 'worktree',
            id: 'task-new',
            initial_prompt: canonicalPrompt,
            initial_prompt_delivery_id: 'delivery-1',
            session_id: 'session-canonical',
            task_creation_operation_link: operationLink,
            task_creation_provenance: provenance,
            task_initial_shell_ownership: shellOwnership,
            workspace_revision: 1,
            worktree_path: '/repo/.worktrees/task-new',
          });
        case IPC.LoadWorkspaceState:
          return Promise.resolve(
            createWorkspacePayload(
              {
                'task-new': {
                  agentDef: canonicalAgentDef,
                  agentId: 'session-canonical',
                  agentIds: ['session-canonical'],
                  baseBranch: 'main',
                  branchName: 'feature/task-new',
                  coordinatorCredentialPath: '/tmp/coordinator-credential.json',
                  coordinatorRole: 'coordinator',
                  coordinatorRunId: 'run-1',
                  coordinatorToolCommand: 'parallel-code-coordinator',
                  gitIsolation: 'worktree',
                  id: 'task-new',
                  initialPrompt: canonicalPrompt,
                  initialPromptDeliveryId: 'delivery-1',
                  initialPromptDeliveryMode: 'automatic',
                  lastPrompt: '',
                  name: 'Coordinator task',
                  notes: '',
                  projectId: 'project-1',
                  savedInitialPrompt: canonicalPrompt,
                  selectedAgentId: 'session-canonical',
                  shellAgentIds: [],
                  shellCount: 0,
                  skipPermissions: false,
                  taskCreationOperationLink: operationLink,
                  taskCreationProvenance: provenance,
                  taskInitialShellOwnership: shellOwnership,
                  taskMode: 'agent',
                  worktreePath: '/repo/.worktrees/task-new',
                },
              },
              ['task-new'],
              1,
            ),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(
      createTask({
        adapterOperationId: 'test-create-4',
        launch: {
          kind: 'agent',
          agentDef,
          coordinatorMode: true,
          initialPrompt: 'Build the coordinator slice',
        },
        name: 'Coordinator task',
        projectId: 'project-1',
      }),
    ).resolves.toBe('task-new');

    const task = store.tasks['task-new'];
    expect(task?.coordinatorCredentialPath).toBe('/tmp/coordinator-credential.json');
    expect(task?.coordinatorRunId).toBe('run-1');
    expect(task?.coordinatorToolCommand).toBe('parallel-code-coordinator');
    expect(task?.agentIds).toEqual(['session-canonical']);
    expect(task?.selectedAgentId).toBe('session-canonical');
    expect(task?.initialPromptDeliveryId).toBe('delivery-1');
    expect(task?.taskCreationProvenance).toEqual({
      creationWriterEpoch: 'managed-initial-shell-v1',
    });
    expect(task?.taskCreationOperationLink).toMatchObject({
      creationOperationId: 'creation-1',
      launchOperationId: 'launch-1',
    });
    expect(store.agents).toHaveProperty('session-canonical');
    expect(store.agents['session-canonical']?.def.env).toMatchObject({
      PARALLEL_CODE_COORDINATOR_CREDENTIAL: '/tmp/coordinator-credential.json',
      PARALLEL_CODE_COORDINATOR_RUN_ID: 'run-1',
      PARALLEL_CODE_COORDINATOR_TOOL: 'parallel-code-coordinator',
    });
    expect(task?.initialPrompt).toContain('You are the coordinator for this Parallel Code task.');
    expect(task?.initialPrompt).toContain(
      "Run coordinator tools with $PARALLEL_CODE_COORDINATOR_TOOL <tool-name> '<payload-json>'.",
    );
    expect(task?.initialPrompt).toContain('User task:\nBuild the coordinator slice');
    expect(task?.savedInitialPrompt).toBe(task?.initialPrompt);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledWith(
      IPC.CreateTask,
      expect.objectContaining({
        coordinatorMode: true,
        initialPrompt: 'Build the coordinator slice',
      }),
    );
  });

  it('leaves coordinator rollback to the atomic backend creation owner', async () => {
    const agentDef = createTestAgentDef({ id: 'codex', name: 'Codex' });
    setStore('projects', [
      createTestProject({
        id: 'project-1',
        path: '/repo',
      }),
    ]);
    invokeMock.mockRejectedValueOnce(new Error('coordinator unavailable'));

    await expect(
      createTask({
        adapterOperationId: 'test-create-5',
        launch: { kind: 'agent', agentDef, coordinatorMode: true },
        name: 'Coordinator task',
        projectId: 'project-1',
      }),
    ).rejects.toThrow('coordinator unavailable');

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith(
      IPC.CreateTask,
      expect.objectContaining({ coordinatorMode: true }),
    );
    expect(store.tasks['task-new']).toBeUndefined();
    expect(Object.values(store.agents)).not.toContainEqual(
      expect.objectContaining({ taskId: 'task-new' }),
    );
  });

  it('does not fork a renderer cleanup path for non-git coordinator failures', async () => {
    const agentDef = createTestAgentDef({ id: 'codex', name: 'Codex' });
    setStore('projects', [
      createTestProject({
        id: 'project-1',
        path: '/tmp/folder',
        projectMode: 'non-git',
      }),
    ]);
    invokeMock.mockRejectedValueOnce(new Error('coordinator unavailable'));

    await expect(
      createTask({
        adapterOperationId: 'test-create-6',
        launch: { kind: 'agent', agentDef, coordinatorMode: true },
        name: 'Folder coordinator task',
        projectId: 'project-1',
        projectMode: 'non-git',
      }),
    ).rejects.toThrow('coordinator unavailable');

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith(
      IPC.CreateTask,
      expect.objectContaining({ coordinatorMode: true, projectMode: 'non-git' }),
    );
    expect(store.tasks['task-non-git']).toBeUndefined();
  });

  it('rejects coordinator mode in Electron before creating a task', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electron: {
          ipcRenderer: {},
        },
      },
    });
    const agentDef = createTestAgentDef({ id: 'codex', name: 'Codex' });
    try {
      await expect(
        createTask({
          adapterOperationId: 'test-create-7',
          launch: { kind: 'agent', agentDef, coordinatorMode: true },
          name: 'Coordinator task',
          projectId: 'project-1',
        }),
      ).rejects.toThrow('Coordinator mode is available in browser server mode.');
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        delete (globalThis as { window?: unknown }).window;
      }
    }

    expect(invokeMock).not.toHaveBeenCalledWith(IPC.CreateTask, expect.anything());
  });

  it('rejects coordinator mode for non-host agent runners before creating a task', async () => {
    const agentDef = createTestAgentDef({ id: 'codex', name: 'Codex' });
    setStore('projects', [
      createTestProject({
        agentRunnerConfig: {
          image: 'node:20',
          provider: 'docker-container',
        },
        id: 'project-1',
        path: '/repo',
      }),
    ]);

    await expect(
      createTask({
        adapterOperationId: 'test-create-8',
        launch: { kind: 'agent', agentDef, coordinatorMode: true },
        name: 'Coordinator task',
        projectId: 'project-1',
      }),
    ).rejects.toThrow('Coordinator mode currently requires host-run agents.');

    expect(invokeMock).not.toHaveBeenCalledWith(IPC.CreateTask, expect.anything());
  });

  it('submits multiline prompts through one semantic backend command', async () => {
    await sendPrompt('task-1', 'agent-1', 'line 1\nline 2\nline 3');

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.SendTaskPromptInput),
    ).toEqual([
      [
        IPC.SendTaskPromptInput,
        {
          agentId: 'agent-1',
          controllerId: 'client-self',
          taskId: 'task-1',
          text: 'line 1\nline 2\nline 3',
        },
      ],
    ]);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.WriteToAgent, expect.anything());
    expect(store.tasks['task-1']?.lastPrompt).toBe('line 1\nline 2\nline 3');
  });

  it('passes controller identity through close-task deletion requests', async () => {
    const promise = closeTask('task-1');
    await promise;
    await vi.advanceTimersByTimeAsync(300);

    expect(invokeMock).toHaveBeenCalledWith(IPC.DeleteTask, {
      agentIds: ['agent-1', 'shell-1'],
      branchName: 'feature/task-1',
      controllerId: 'client-self',
      deleteBranch: true,
      projectRoot: '/tmp/project',
      taskId: 'task-1',
      worktreePath: '/tmp/project/task-1',
    });
  });

  it('keeps an unsaved notes draft and skips close effects when discard is declined', async () => {
    publishUnsavedDesktopTaskNotes(['task-1']);
    confirmMock.mockResolvedValueOnce(false);

    await closeTask('task-1');

    expect(confirmMock).toHaveBeenCalledWith(
      'This action will remove the task and discard its unsaved task notes. Continue?',
      expect.objectContaining({ okLabel: 'Discard notes and continue' }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.DeleteTask, expect.anything());
    expect(retireTaskNotesMock).not.toHaveBeenCalled();
    expect(store.tasks['task-1']).toBeDefined();
  });

  it('retires an admitted notes draft only after backend close commits', async () => {
    publishUnsavedDesktopTaskNotes(['task-1']);

    await closeTask('task-1');

    expect(retireTaskNotesMock).toHaveBeenCalledWith('task-1');
    const deleteCall = invokeMock.mock.calls.find(([channel]) => channel === IPC.DeleteTask);
    if (!deleteCall) throw new Error('Expected backend task deletion');
    expect(
      invokeMock.mock.invocationCallOrder[invokeMock.mock.calls.indexOf(deleteCall)],
    ).toBeLessThan(retireTaskNotesMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
  });

  it('removes and persists a task immediately after backend close succeeds', async () => {
    await closeTask('task-1');

    expect(store.tasks['task-1']).toBeUndefined();
    expect(saveCurrentRuntimeStateMock).toHaveBeenCalledTimes(1);
  });

  it('retains the local task when durable backend cleanup is still pending', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.DeleteTask:
          return Promise.resolve({ cleanupWarnings: [], removalState: 'cleanup-pending' });
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    try {
      await closeTask('task-1');

      expect(store.tasks['task-1']).toBeDefined();
      expect(store.tasks['task-1']?.closeState).toEqual({
        kind: 'error',
        message: 'Error: Task cleanup is still pending. Retry closing the task to continue safely.',
      });
      expect(saveCurrentRuntimeStateMock).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalledWith(IPC.KillAgent, expect.anything());
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    {
      cleanupWarnings: [
        {
          kind: 'worktree',
          message: 'Failed to clean task worktree while deleting task: remove failed',
        },
      ],
      expectedMessage:
        'Task closed, but worktree cleanup did not finish. Check server logs before reusing this task branch.',
      warningScope: 'worktree',
    },
    {
      cleanupWarnings: [
        {
          kind: 'runners',
          message: 'Failed to stop task runners while deleting task: timeout',
        },
      ],
      expectedMessage:
        'Task closed, but task process cleanup did not finish. Check server logs before reusing this task.',
      warningScope: 'runner',
    },
    {
      cleanupWarnings: [
        {
          kind: 'worktree',
          message: 'Failed to clean task worktree while deleting task: remove failed',
        },
        {
          kind: 'runners',
          message: 'Failed to stop task runners while deleting task: timeout',
        },
        {
          kind: 'containers',
          message: 'Failed to clean task containers while deleting task: daemon unavailable',
        },
      ],
      expectedMessage:
        'Task closed, but worktree, task process, and container cleanup did not finish. Check server logs before reusing this task branch.',
      warningScope: 'combined',
    },
  ])('surfaces $warningScope cleanup warnings after task deletion completes', async (testCase) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.DeleteTask:
          return Promise.resolve({
            cleanupWarnings: testCase.cleanupWarnings,
          });
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    try {
      await closeTask('task-1');

      expect(store.tasks['task-1']).toBeUndefined();
      expect(showNotificationMock).toHaveBeenCalledWith(testCase.expectedMessage);
      expect(warnSpy).toHaveBeenCalledWith(
        'Task task-1 closed with cleanup warnings:',
        testCase.cleanupWarnings,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('uses runtime cleanup instead of delete-task when closing a direct-mode task', async () => {
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: ['agent-1'],
        directMode: true,
        shellAgentIds: ['shell-1'],
      }),
    });

    await closeTask('task-1');

    expect(invokeMock).toHaveBeenCalledWith(IPC.CleanupTaskRuntime, {
      agentIds: ['agent-1', 'shell-1'],
      controllerId: 'client-self',
      projectRoot: '/tmp/project',
      removeTaskState: true,
      taskId: 'task-1',
      worktreePath: '/tmp/project/task-1',
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      IPC.DeleteTask,
      expect.objectContaining({ taskId: 'task-1' }),
    );
  });

  it('surfaces runtime cleanup warnings when closing a direct-mode task', async () => {
    const cleanupWarnings = [
      {
        kind: 'runners' as const,
        message: 'Failed to clean agent runners while removing task runtime: timeout',
      },
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: [],
        directMode: true,
        shellAgentIds: ['shell-1'],
        taskMode: 'terminal',
      }),
    });
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.CleanupTaskRuntime:
          return Promise.resolve({ cleanupWarnings });
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    try {
      await closeTask('task-1');

      expect(store.tasks['task-1']).toBeUndefined();
      expect(showNotificationMock).toHaveBeenCalledWith(
        'Task closed, but task process cleanup did not finish. Check server logs before reusing this task.',
      );
      expect(warnSpy).toHaveBeenCalledWith(
        'Task task-1 closed with cleanup warnings:',
        cleanupWarnings,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('uses runtime cleanup instead of delete-task when closing an external worktree task', async () => {
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: ['agent-1'],
        gitIsolation: 'existing-worktree',
        shellAgentIds: ['shell-1'],
        worktreeOwnership: 'external',
      }),
    });

    await closeTask('task-1');

    expect(invokeMock).toHaveBeenCalledWith(IPC.CleanupTaskRuntime, {
      agentIds: ['agent-1', 'shell-1'],
      controllerId: 'client-self',
      projectRoot: '/tmp/project',
      removeTaskState: true,
      taskId: 'task-1',
      worktreePath: '/tmp/project/task-1',
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      IPC.DeleteTask,
      expect.objectContaining({ taskId: 'task-1' }),
    );
  });

  it('marks non-git runtime cleanup so browser side effects skip git status refresh', async () => {
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: ['agent-1'],
        branchName: '',
        projectMode: 'non-git',
        shellAgentIds: ['shell-1'],
        worktreePath: '/tmp/folder',
      }),
    });

    await closeTask('task-1');

    expect(invokeMock).toHaveBeenCalledWith(IPC.CleanupTaskRuntime, {
      agentIds: ['agent-1', 'shell-1'],
      controllerId: 'client-self',
      projectMode: 'non-git',
      projectRoot: '/tmp/project',
      removeTaskState: true,
      taskId: 'task-1',
      worktreePath: '/tmp/folder',
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      IPC.DeleteTask,
      expect.objectContaining({ taskId: 'task-1' }),
    );
  });

  it('retries a direct-mode close after cleanup fails because the worktree is missing', async () => {
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: ['agent-1'],
        directMode: true,
        shellAgentIds: ['shell-1'],
      }),
    });

    let cleanupCalls = 0;
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.CleanupTaskRuntime:
          cleanupCalls += 1;
          return cleanupCalls === 1
            ? Promise.reject(new Error('missing worktree'))
            : Promise.resolve(undefined);
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await closeTask('task-1');

    expect(store.tasks['task-1']).toBeDefined();
    expect(store.tasks['task-1']?.closeState).toEqual({
      kind: 'error',
      message: 'Error: missing worktree',
    });

    await retryCloseTask('task-1');
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeUndefined();
    expect(store.completedTaskCount).toBe(0);
  });

  it('retries a direct-mode close after cleanup fails because control moved to another client', async () => {
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: ['agent-1'],
        directMode: true,
        shellAgentIds: ['shell-1'],
      }),
    });

    let cleanupCalls = 0;
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.CleanupTaskRuntime:
          cleanupCalls += 1;
          return cleanupCalls === 1
            ? Promise.reject(new Error('Task is controlled by another client'))
            : Promise.resolve(undefined);
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await closeTask('task-1');

    expect(store.tasks['task-1']).toBeDefined();
    expect(store.tasks['task-1']?.closeState).toEqual({
      kind: 'error',
      message: 'Error: Task is controlled by another client',
    });

    await retryCloseTask('task-1');
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeUndefined();
    expect(store.completedTaskCount).toBe(0);
  });

  it('retries a worktree close after delete-task fails because the worktree is missing', async () => {
    let deleteCalls = 0;
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.DeleteTask:
          deleteCalls += 1;
          return deleteCalls === 1
            ? Promise.reject(new Error('missing worktree'))
            : Promise.resolve({ cleanupWarnings: [] });
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await closeTask('task-1');

    expect(store.tasks['task-1']).toBeDefined();
    expect(store.tasks['task-1']?.closeState).toEqual({
      kind: 'error',
      message: 'Error: missing worktree',
    });

    await retryCloseTask('task-1');
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeUndefined();
  });

  it('retries a worktree close after delete-task fails because control moved to another client', async () => {
    let deleteCalls = 0;
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.DeleteTask:
          deleteCalls += 1;
          return deleteCalls === 1
            ? Promise.reject(new Error('Task is controlled by another client'))
            : Promise.resolve({ cleanupWarnings: [] });
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await closeTask('task-1');

    expect(store.tasks['task-1']).toBeDefined();
    expect(store.tasks['task-1']?.closeState).toEqual({
      kind: 'error',
      message: 'Error: Task is controlled by another client',
    });

    await retryCloseTask('task-1');
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeUndefined();
  });

  it('cleans all task-scoped store state when closing a task', async () => {
    setStore('taskGitStatus', {
      'task-1': {
        branch: 'feature/task-1',
        clean: true,
        hasRemote: true,
        staged: 0,
        unstaged: 0,
        untracked: 0,
      },
    } as never);
    setStore('taskPorts', {
      'task-1': {
        taskId: 'task-1',
        exposed: [],
        updatedAt: Date.now(),
      },
    } as never);
    setStore('taskConvergence', {
      'task-1': {
        taskId: 'task-1',
        state: 'review-ready',
        summary: 'Ready',
        updatedAt: Date.now(),
        commitCount: 1,
        changedFileCount: 1,
        mainAheadCount: 0,
        conflictingFiles: [],
        overlapWarnings: [],
      },
    } as never);
    setStore('taskReview', {
      'task-1': {
        taskId: 'task-1',
        state: 'ready',
        summary: 'Ready',
        updatedAt: Date.now(),
      },
    } as never);
    setStore('taskCommandControllers', {
      'task-1': {
        action: 'close this task',
        controllerId: 'client-self',
        version: 1,
      },
    });
    setStore('agentActive', {
      'agent-1': true,
      'shell-1': true,
    });
    setStore('agentSupervision', {
      'agent-1': {} as never,
      'shell-1': {} as never,
    });

    await closeTask('task-1');
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeUndefined();
    expect(store.taskGitStatus['task-1']).toBeUndefined();
    expect(store.taskPorts['task-1']).toBeUndefined();
    expect(store.taskConvergence['task-1']).toBeUndefined();
    expect(store.taskReview['task-1']).toBeUndefined();
    expect(store.taskCommandControllers['task-1']).toBeUndefined();
    expect(store.agents['agent-1']).toBeUndefined();
    expect(store.agents['shell-1']).toBeUndefined();
    expect(store.agentActive['agent-1']).toBeUndefined();
    expect(store.agentActive['shell-1']).toBeUndefined();
    expect(store.agentSupervision['agent-1']).toBeUndefined();
    expect(store.agentSupervision['shell-1']).toBeUndefined();
  });

  it('issues and starts a typed merge without sending renderer paths or calling the legacy writer', async () => {
    await mergeTask('task-1', {
      cleanup: false,
      message: 'merge commit',
      squash: true,
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.IssueTaskMergeOperation, {
      controllerId: 'client-self',
      taskId: 'task-1',
    });
    expect(invokeMock).toHaveBeenCalledWith(IPC.StartTaskMergeOperation, {
      access: {
        operationCapability: 'merge-capability-1',
        operationId: 'merge-operation-1',
      },
      controllerId: 'client-self',
      semanticRequest: {
        cleanup: false,
        message: 'merge commit',
        squash: true,
        taskId: 'task-1',
      },
    });
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.MergeTask, expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.CleanupTaskRuntime, expect.anything());
    expect(store.completedTaskCount).toBe(0);
  });

  it('does not start an issued merge when exact recovery retention exceeds browser quota', async () => {
    vi.stubGlobal('sessionStorage', createMemoryStorage({ failWrites: true }));
    resetTaskLifecycleRuntimeStateForTests();

    await expect(
      mergeTask('task-1', { cleanup: false, message: 'merge commit', squash: true }),
    ).rejects.toThrow('could not be retained for recovery');

    expect(invokeMock).toHaveBeenCalledWith(IPC.IssueTaskMergeOperation, {
      controllerId: 'client-self',
      taskId: 'task-1',
    });
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.StartTaskMergeOperation, expect.anything());
  });

  it('disables merge cleanup for external worktree tasks', async () => {
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: ['agent-1'],
        gitIsolation: 'existing-worktree',
        shellAgentIds: ['shell-1'],
        worktreeOwnership: 'external',
      }),
    });

    await mergeTask('task-1', {
      cleanup: true,
      squash: false,
    });

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.StartTaskMergeOperation,
      expect.objectContaining({
        semanticRequest: expect.objectContaining({ cleanup: false, taskId: 'task-1' }),
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      IPC.CleanupTaskRuntime,
      expect.objectContaining({ taskId: 'task-1' }),
    );
  });

  it('projects canonical task removal after backend-owned merge cleanup', async () => {
    await mergeTask('task-1', {
      cleanup: true,
      squash: false,
    });

    expect(invokeMock).not.toHaveBeenCalledWith(IPC.CleanupTaskRuntime, expect.anything());
    expect(invokeMock).toHaveBeenCalledWith(IPC.LoadWorkspaceState);
    expect(store.tasks['task-1']).toBeUndefined();
    expect(saveCurrentRuntimeStateMock).not.toHaveBeenCalled();
    expect(store.completedTaskCount).toBe(0);
    expect(retireTaskNotesMock).toHaveBeenCalledWith('task-1');
  });

  it('retains the notes draft when merge cleanup returns a canonical projection containing the task', async () => {
    const defaultInvoke = requireInvokeImplementation();
    publishUnsavedDesktopTaskNotes(['task-1']);
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      if (channel === IPC.LoadWorkspaceState) {
        return Promise.resolve(
          createWorkspacePayload({ 'task-1': store.tasks['task-1'] }, ['task-1'], 3),
        );
      }
      return defaultInvoke(channel, args);
    });

    await expect(mergeTask('task-1', { cleanup: true, squash: false })).rejects.toThrow(
      'Merged task remains in canonical workspace state',
    );

    expect(store.tasks['task-1']).toBeDefined();
    expect(retireTaskNotesMock).not.toHaveBeenCalled();
  });

  it('surfaces backend finalizer repair without running renderer cleanup', async () => {
    const defaultInvoke = requireInvokeImplementation();
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      if (channel === IPC.StartTaskMergeOperation) {
        return Promise.resolve(
          createTaskMergeResult(true, {
            currentRemoval: {
              deletionOperationId: 'merge-operation-1',
              pendingFinalizers: ['task-runtime'],
              removed: true,
              removalState: 'finalizer-repair-pending',
              taskId: 'task-1',
            },
          }),
        );
      }
      return defaultInvoke(channel, args);
    });

    await mergeTask('task-1', { cleanup: true, squash: false });

    expect(store.tasks['task-1']).toBeUndefined();
    expect(showNotificationMock).toHaveBeenCalledWith(
      'Task merged. Backend cleanup finalizers will continue automatically.',
    );
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.CleanupTaskRuntime, expect.anything());
  });

  it('does not duplicate finalizer repair when status recovery consumes access first', async () => {
    const defaultInvoke = requireInvokeImplementation();
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      if (channel === IPC.StartTaskMergeOperation) {
        const request = args as { access: { operationId: string } };
        expect(clearRetainedTaskMergeOperation('task-1', request.access.operationId)).toBe(true);
        notifyTaskMergeFinalizerRepair();
        return Promise.resolve(
          createTaskMergeResult(true, {
            currentRemoval: {
              deletionOperationId: request.access.operationId,
              pendingFinalizers: ['task-runtime'],
              removed: true,
              removalState: 'finalizer-repair-pending',
              taskId: 'task-1',
            },
          }),
        );
      }
      return defaultInvoke(channel, args);
    });

    await mergeTask('task-1', { cleanup: true, squash: false });

    expect(showNotificationMock).toHaveBeenCalledTimes(1);
    expect(showNotificationMock).toHaveBeenCalledWith(
      'Task merged. Backend cleanup finalizers will continue automatically.',
    );
  });

  it('does not count plain task close as merged progress', async () => {
    await closeTask('task-1');
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeUndefined();
    expect(store.completedTaskCount).toBe(0);
  });

  it('recovers a lost start response by checking status without issuing or starting again', async () => {
    const defaultInvoke = requireInvokeImplementation();
    let startCalls = 0;
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      if (channel === IPC.StartTaskMergeOperation) {
        startCalls += 1;
        return Promise.reject(new Error('connection lost after admission'));
      }
      if (channel === IPC.GetTaskMergeOperationStatus) {
        return Promise.resolve(createTaskMergeResult(true, { replayed: true }));
      }
      return defaultInvoke(channel, args);
    });

    await expect(mergeTask('task-1', { cleanup: true, squash: false })).rejects.toThrow(
      'connection lost after admission',
    );
    expect(store.tasks['task-1']).toBeDefined();

    await mergeTask('task-1', { cleanup: true, squash: false });

    expect(startCalls).toBe(1);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.IssueTaskMergeOperation),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.GetTaskMergeOperationStatus),
    ).toHaveLength(1);
    expect(store.tasks['task-1']).toBeUndefined();
  });

  it('clears terminal failed access so a corrected retry receives a new operation', async () => {
    const defaultInvoke = requireInvokeImplementation();
    let shouldFail = true;
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      if (channel === IPC.StartTaskMergeOperation && shouldFail) {
        return Promise.resolve(
          createTaskMergeResult(true, {
            currentRemoval: null,
            outcome: {
              counted: false,
              gitMerged: false,
              issue: {
                code: 'lease-lost-before-git',
                recovery: { kind: 'new-operation-after-correction' },
              },
              phase: 'failed',
              taskReleased: false,
            },
          }),
        );
      }
      return defaultInvoke(channel, args);
    });

    await expect(mergeTask('task-1', { cleanup: true, squash: false })).rejects.toThrow(
      'Task merge failed (lease-lost-before-git)',
    );
    expect(store.tasks['task-1']).toBeDefined();

    shouldFail = false;
    await mergeTask('task-1', { cleanup: true, squash: false });

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.IssueTaskMergeOperation),
    ).toHaveLength(2);
    expect(store.tasks['task-1']).toBeUndefined();
  });

  it('resumes backend removal with the retained operation after a pending result', async () => {
    const defaultInvoke = requireInvokeImplementation();
    const pending = createTaskMergeResult(true, {
      currentRemoval: {
        deletionOperationId: 'merge-operation-1',
        removed: false,
        removalState: 'cleanup-pending',
        taskId: 'task-1',
      },
      outcome: {
        counted: false,
        phase: 'merged-awaiting-removal',
        taskReleased: false,
      },
    });
    let startCalls = 0;
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      if (channel === IPC.StartTaskMergeOperation) {
        startCalls += 1;
        return Promise.resolve(startCalls === 1 ? pending : createTaskMergeResult(true));
      }
      if (channel === IPC.GetTaskMergeOperationStatus) return Promise.resolve(pending);
      return defaultInvoke(channel, args);
    });

    await expect(mergeTask('task-1', { cleanup: true, squash: false })).rejects.toThrow(
      'Task merge cleanup is still pending',
    );
    await mergeTask('task-1', { cleanup: true, squash: false });

    expect(startCalls).toBe(2);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.IssueTaskMergeOperation),
    ).toHaveLength(1);
    expect(store.tasks['task-1']).toBeUndefined();
  });

  it('rejects different options while a retained merge is nonterminal', async () => {
    const defaultInvoke = requireInvokeImplementation();
    const pending = createTaskMergeResult(true, {
      currentRemoval: null,
      outcome: {
        counted: false,
        phase: 'merged-awaiting-removal',
        taskReleased: false,
      },
    });
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      if (channel === IPC.StartTaskMergeOperation) return Promise.resolve(pending);
      if (channel === IPC.GetTaskMergeOperationStatus) return Promise.resolve(pending);
      return defaultInvoke(channel, args);
    });

    await expect(mergeTask('task-1', { cleanup: true, squash: false })).rejects.toThrow(
      'Task merge cleanup is still pending',
    );
    await expect(mergeTask('task-1', { cleanup: true, squash: true })).rejects.toThrow(
      'different options is already in progress',
    );

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.IssueTaskMergeOperation),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.StartTaskMergeOperation),
    ).toHaveLength(1);
  });

  it('sends prompt-enter through the task command lease helper', async () => {
    await sendAgentEnter('task-1', 'agent-1');

    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.AcquireTaskCommandLease, {
      action: 'send a prompt',
      clientId: 'client-self',
      ownerId: 'runtime-owner-self',
      taskId: 'task-1',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.WriteToAgent, {
      agentId: 'agent-1',
      controllerId: 'client-self',
      data: '\r',
      taskId: 'task-1',
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      IPC.ReleaseTaskCommandLease,
      expect.objectContaining({
        clientId: 'client-self',
        leaseGeneration: expect.any(Number),
        ownerId: 'runtime-owner-self',
        taskId: 'task-1',
      }),
    );
  });

  it('persists browser workspace state when opening a shell terminal', async () => {
    const shellId = spawnShellForTask('task-1');

    expect(store.tasks['task-1']?.shellAgentIds).toContain(shellId);
    expect(isCompatibilityTerminalCreationPending('task-1', shellId)).toBe(true);
    expect(store.focusedPanel['task-1']).toBe('shell:1');
    expect(saveBrowserWorkspaceStateMock).toHaveBeenCalledTimes(1);
  });

  it('does not stage orphaned shell activity or pending commands for a missing task', async () => {
    const shellId = spawnShellForTask('task-missing', 'npm test');

    expect(store.tasks['task-missing']).toBeUndefined();
    expect(store.agentActive[shellId]).toBeUndefined();
    expect(consumePendingShellCommand(shellId)).toBeUndefined();
    expect(saveBrowserWorkspaceStateMock).not.toHaveBeenCalled();
  });

  it('removes killed shell agents from store state when collapsing a task', async () => {
    setStore('agentActive', {
      'agent-1': true,
      'shell-1': true,
    });
    setStore('agentSupervision', {
      'agent-1': {} as never,
      'shell-1': {} as never,
    });

    await collapseTask('task-1');

    expect(store.tasks['task-1']?.collapsed).toBe(true);
    expect(store.tasks['task-1']?.agentIds).toEqual([]);
    expect(store.tasks['task-1']?.shellAgentIds).toEqual([]);
    expect(store.agents['agent-1']).toBeUndefined();
    expect(store.agents['shell-1']).toBeUndefined();
    expect(store.agentActive['agent-1']).toBeUndefined();
    expect(store.agentActive['shell-1']).toBeUndefined();
    expect(store.agentSupervision['agent-1']).toBeUndefined();
    expect(store.agentSupervision['shell-1']).toBeUndefined();
  });

  it('preserves all task agent definitions when collapsing a multi-agent task', async () => {
    const codexDef = createTestAgentDef({ id: 'codex', name: 'Codex' });
    setStore('tasks', 'task-1', 'agentIds', ['agent-1', 'agent-2']);
    setStore('tasks', 'task-1', 'selectedAgentId', 'agent-2');
    setStore('agents', 'agent-2', createTestAgent({ def: codexDef, id: 'agent-2' }));

    await collapseTask('task-1');

    expect(store.tasks['task-1']?.agentIds).toEqual([]);
    expect(store.tasks['task-1']?.selectedAgentId).toBeUndefined();
    expect(store.tasks['task-1']?.savedAgentDef?.id).toBe('claude');
    expect(store.tasks['task-1']?.savedAgentDefs?.map((agentDef) => agentDef.id)).toEqual([
      'claude',
      'codex',
    ]);
    expect(store.tasks['task-1']?.savedSelectedAgentIndex).toBe(1);
  });

  it('does not shift saved multi-agent definitions when an agent record is missing during collapse', async () => {
    const codexDef = createTestAgentDef({ id: 'codex', name: 'Codex' });
    setStore('tasks', 'task-1', 'agentIds', ['missing-agent', 'agent-2']);
    setStore('tasks', 'task-1', 'selectedAgentId', 'agent-2');
    setStore('agents', 'agent-2', createTestAgent({ def: codexDef, id: 'agent-2' }));

    await collapseTask('task-1');

    expect(store.tasks['task-1']?.agentIds).toEqual([]);
    expect(store.tasks['task-1']?.selectedAgentId).toBeUndefined();
    expect(store.tasks['task-1']?.savedAgentDef).toBeUndefined();
    expect(store.tasks['task-1']?.savedAgentDefs).toBeUndefined();
    expect(store.tasks['task-1']?.savedSelectedAgentIndex).toBeUndefined();
  });

  it('stops backend task watchers when collapsing a task', async () => {
    await collapseTask('task-1');

    expect(invokeMock).toHaveBeenCalledWith(IPC.CleanupTaskRuntime, {
      agentIds: ['agent-1', 'shell-1'],
      controllerId: 'client-self',
      taskId: 'task-1',
    });
  });

  it('keeps a task untouched when another client holds the close lease', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, 'close this task', false, 'peer-client'),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });
    confirmMock.mockResolvedValue(false);

    await closeTask('task-1');

    expect(store.tasks['task-1']?.closeState).toBeUndefined();
    expect(store.tasks['task-1']?.collapsed).not.toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.DeleteTask, expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.CleanupTaskRuntime, expect.anything());
  });

  it('keeps a collapsed task untouched when another client holds the collapse lease', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, 'collapse this task', false, 'peer-client'),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });
    confirmMock.mockResolvedValue(false);

    await collapseTask('task-1');

    expect(store.tasks['task-1']?.collapsed).not.toBe(true);
    expect(store.tasks['task-1']?.agentIds).toEqual(['agent-1']);
    expect(store.tasks['task-1']?.shellAgentIds).toEqual(['shell-1']);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.CleanupTaskRuntime, expect.anything());
  });

  it('ignores duplicate close requests while task removal is still in flight', async () => {
    const deleteDeferred = createDeferredPromise<{ cleanupWarnings: [] }>();
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.DeleteTask:
          return deleteDeferred.promise;
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const firstClose = closeTask('task-1');
    await vi.waitFor(() => {
      expect(store.tasks['task-1']?.closeState).toEqual({ kind: 'closing' });
    });
    const secondClose = closeTask('task-1');
    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.filter(([channel]) => channel === IPC.DeleteTask)).toHaveLength(
        1,
      );
    });

    deleteDeferred.resolve({ cleanupWarnings: [] });
    await Promise.all([firstClose, secondClose]);
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeUndefined();
  });

  it('ignores duplicate collapse requests while collapse cleanup is still in flight', async () => {
    const cleanupDeferred = createDeferredPromise<undefined>();
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.CleanupTaskRuntime:
          return cleanupDeferred.promise;
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const firstCollapse = collapseTask('task-1');
    await vi.waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([channel]) => channel === IPC.CleanupTaskRuntime),
      ).toHaveLength(1);
    });
    const secondCollapse = collapseTask('task-1');
    await vi.waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([channel]) => channel === IPC.CleanupTaskRuntime),
      ).toHaveLength(1);
    });

    cleanupDeferred.resolve(undefined);
    await Promise.all([firstCollapse, secondCollapse]);

    expect(store.tasks['task-1']?.collapsed).toBe(true);
  });

  it('still collapses the task locally when backend runtime cleanup fails', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.CleanupTaskRuntime:
          return Promise.reject(new Error('cleanup failed'));
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await collapseTask('task-1');

    expect(store.tasks['task-1']?.collapsed).toBe(true);
    expect(store.tasks['task-1']?.agentIds).toEqual([]);
    expect(store.tasks['task-1']?.shellAgentIds).toEqual([]);
  });

  it('keeps the task untouched when collapse cleanup loses task control mid-flight', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.CleanupTaskRuntime:
          return Promise.reject(new Error('Task is controlled by another client'));
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await collapseTask('task-1');

    expect(store.tasks['task-1']?.collapsed).not.toBe(true);
    expect(store.tasks['task-1']?.agentIds).toEqual(['agent-1']);
    expect(store.tasks['task-1']?.shellAgentIds).toEqual(['shell-1']);
  });

  it('allows a later collapse after collapse cleanup loses task control mid-flight', async () => {
    let cleanupCalls = 0;
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.CleanupTaskRuntime:
          cleanupCalls += 1;
          return cleanupCalls === 1
            ? Promise.reject(new Error('Task is controlled by another client'))
            : Promise.resolve(undefined);
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await collapseTask('task-1');

    expect(store.tasks['task-1']?.collapsed).not.toBe(true);

    await collapseTask('task-1');

    expect(store.tasks['task-1']?.collapsed).toBe(true);
    expect(store.tasks['task-1']?.agentIds).toEqual([]);
    expect(store.tasks['task-1']?.shellAgentIds).toEqual([]);
  });

  it('retries collapse successfully after task control is restored', async () => {
    let cleanupCalls = 0;
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        case IPC.KillAgent:
          return Promise.resolve(undefined);
        case IPC.CleanupTaskRuntime:
          cleanupCalls += 1;
          return cleanupCalls === 1
            ? Promise.reject(new Error('Task is controlled by another client'))
            : Promise.resolve(undefined);
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await collapseTask('task-1');

    expect(store.tasks['task-1']?.collapsed).not.toBe(true);
    expect(store.tasks['task-1']?.agentIds).toEqual(['agent-1']);

    await collapseTask('task-1');

    expect(store.tasks['task-1']?.collapsed).toBe(true);
    expect(store.tasks['task-1']?.agentIds).toEqual([]);
    expect(store.tasks['task-1']?.shellAgentIds).toEqual([]);
  });

  it('recycles a collapsed task to active state with a restored runtime agent', async () => {
    setStore('taskOrder', []);
    setStore('collapsedTaskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: [],
        collapsed: true,
        savedAgentDef: {
          args: [],
          command: 'agent',
          description: 'Agent',
          id: 'agent-1',
          name: 'Agent',
          resume_args: [],
          skip_permissions_args: [],
        },
        shellAgentIds: [],
      }),
    });
    setStore('agents', {});

    await uncollapseTask('task-1');

    expect(store.tasks['task-1']).toMatchObject({
      collapsed: false,
      agentIds: expect.any(Array),
      shellAgentIds: [],
    });
    expect(store.tasks['task-1']?.agentIds.length).toBe(1);
    expect(store.taskOrder).toContain('task-1');
    expect(store.collapsedTaskOrder).not.toContain('task-1');
    expect(store.activeTaskId).toBe('task-1');
    expect(store.agents[store.tasks['task-1']?.agentIds[0] ?? '']).toMatchObject({
      def: {
        id: 'agent-1',
        name: 'Agent',
      },
      taskId: 'task-1',
      resumed: true,
    });
    expect(store.tasks['task-1']?.agentIds[0]).not.toBe('agent-1');
  });

  it('restores a collapsed terminal-only task with a fresh primary shell', async () => {
    setStore('taskOrder', []);
    setStore('collapsedTaskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: [],
        collapsed: true,
        shellAgentIds: [],
        taskMode: 'terminal',
      }),
    });
    setStore('agents', {});

    await uncollapseTask('task-1');

    const restoredTask = store.tasks['task-1'];
    expect(restoredTask).toMatchObject({
      agentIds: [],
      collapsed: false,
      shellAgentIds: [expect.any(String)],
      taskMode: 'terminal',
    });
    expect(restoredTask?.savedAgentDef).toBeUndefined();
    expect(store.activeAgentId).toBe(restoredTask?.shellAgentIds[0]);
    expect(store.focusedPanel['task-1']).toBe('shell:0');
  });

  it('restores every saved agent definition when recycling a multi-agent collapsed task', async () => {
    setStore('taskOrder', []);
    setStore('collapsedTaskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: [],
        collapsed: true,
        savedAgentDefs: [
          createTestAgentDef({ id: 'claude', name: 'Claude' }),
          createTestAgentDef({ id: 'codex', name: 'Codex' }),
        ],
        shellAgentIds: [],
      }),
    });
    setStore('agents', {});

    await uncollapseTask('task-1');

    const restoredTask = store.tasks['task-1'];
    expect(restoredTask?.agentIds).toHaveLength(2);
    expect(restoredTask?.selectedAgentId).toBe(restoredTask?.agentIds[0]);
    expect(restoredTask?.savedAgentDefs).toBeUndefined();
    expect(restoredTask?.agentIds.map((agentId) => store.agents[agentId]?.def.id)).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('restores the selected saved agent when recycling a multi-agent collapsed task', async () => {
    setStore('taskOrder', []);
    setStore('collapsedTaskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: [],
        collapsed: true,
        savedAgentDefs: [
          createTestAgentDef({ id: 'claude', name: 'Claude' }),
          createTestAgentDef({ id: 'codex', name: 'Codex' }),
        ],
        savedSelectedAgentIndex: 1,
        shellAgentIds: [],
      }),
    });
    setStore('agents', {});

    await uncollapseTask('task-1');

    const restoredTask = store.tasks['task-1'];
    expect(restoredTask?.selectedAgentId).toBe(restoredTask?.agentIds[1]);
    expect(restoredTask?.savedSelectedAgentIndex).toBeUndefined();
  });

  it('no-ops restoring an already-active task', async () => {
    invokeMock.mockReset();
    await uncollapseTask('task-1');

    expect(store.tasks['task-1']?.collapsed).toBeFalsy();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('keeps a collapsed task untouched when restore lease is skipped by another client', async () => {
    setStore('taskOrder', []);
    setStore('collapsedTaskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: [],
        collapsed: true,
        savedAgentDef: {
          args: [],
          command: 'agent',
          description: 'Agent',
          id: 'agent-1',
          name: 'Agent',
          resume_args: [],
          skip_permissions_args: [],
        },
        shellAgentIds: [],
      }),
    });
    setStore('agents', {});
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(
              { taskId: 'task-1' },
              'restore this task',
              false,
              'peer-client',
            ),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult({ taskId: 'task-1' }));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });
    confirmMock.mockResolvedValue(false);

    await uncollapseTask('task-1');

    expect(store.tasks['task-1']?.collapsed).toBe(true);
  });

  it('ignores a collapse request when the task is already collapsed', async () => {
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: [],
        collapsed: true,
        shellAgentIds: [],
      }),
    });
    setStore('taskOrder', []);
    setStore('collapsedTaskOrder', ['task-1']);
    setStore('agents', {});

    await collapseTask('task-1');

    expect(store.tasks['task-1']?.collapsed).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does not merge direct-mode tasks and does not attempt backend merge recovery', async () => {
    setStore('tasks', {
      'task-1': createTestTask({
        directMode: true,
      }),
    });
    setStore('taskOrder', ['task-1']);

    await mergeTask('task-1');

    expect(invokeMock).not.toHaveBeenCalled();
    expect(showNotificationMock).toHaveBeenCalledWith(
      'This task already uses the project branch; there is no task worktree to merge.',
      { kind: 'warning' },
    );
  });

  it('does not merge already-collapsed tasks or tasks under cleanup', async () => {
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: [],
        collapsed: true,
      }),
      'task-2': createTestTask({
        agentIds: ['agent-1'],
        closeState: { kind: 'removing' },
      }),
    });

    await mergeTask('task-1');
    await mergeTask('task-2');

    expect(invokeMock).not.toHaveBeenCalledWith(IPC.MergeTask, expect.anything());
    expect(showNotificationMock).toHaveBeenNthCalledWith(
      1,
      'Restore this task before merging it.',
      {
        kind: 'warning',
      },
    );
    expect(showNotificationMock).toHaveBeenNthCalledWith(
      2,
      'Wait for the task to finish closing before merging.',
      { kind: 'warning' },
    );
  });

  it('revalidates project availability before a push lease or backend call', async () => {
    setStore('projects', []);

    await pushTask('task-1');

    expect(invokeMock).not.toHaveBeenCalled();
    expect(showNotificationMock).toHaveBeenCalledWith(
      'Reconnect the project folder before pushing this task.',
      { kind: 'warning' },
    );
  });

  it.each([
    {
      action: 'merge this task',
      backendChannel: IPC.MergeTask,
      message: 'Restore this task before merging it.',
      run: () => mergeTask('task-1'),
    },
    {
      action: 'push this task',
      backendChannel: IPC.PushTask,
      message: 'Restore this task before pushing it.',
      run: () => pushTask('task-1'),
    },
  ])(
    'revalidates task churn after acquiring the lease for $action',
    async ({ action, backendChannel, message, run }) => {
      invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
        switch (channel) {
          case IPC.AcquireTaskCommandLease:
            setStore('tasks', 'task-1', 'collapsed', true);
            return Promise.resolve(createAcquireLeaseResult(args, action));
          case IPC.ReleaseTaskCommandLease:
            return Promise.resolve(createReleaseLeaseResult(args));
          default:
            throw new Error(`Unexpected IPC channel: ${channel}`);
        }
      });

      await run();

      expect(invokeMock).not.toHaveBeenCalledWith(backendChannel, expect.anything());
      expect(invokeMock).toHaveBeenCalledWith(
        IPC.ReleaseTaskCommandLease,
        expect.objectContaining({ taskId: 'task-1' }),
      );
      expect(showNotificationMock).toHaveBeenCalledOnce();
      expect(showNotificationMock).toHaveBeenCalledWith(message, { kind: 'warning' });
    },
  );

  it('does not run merge when lease is rejected for this action', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, 'merge this task', false, 'peer-client'),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });
    confirmMock.mockResolvedValue(false);

    await mergeTask('task-1');

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith(
      IPC.AcquireTaskCommandLease,
      expect.objectContaining({
        action: 'merge this task',
        taskId: 'task-1',
      }),
    );
  });

  it('runs close-task cleanup from collapsed state and removes the task', async () => {
    setStore('taskOrder', []);
    setStore('collapsedTaskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: [],
        collapsed: true,
        shellAgentIds: [],
      }),
    });

    await closeTask('task-1');
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith(
      IPC.DeleteTask,
      expect.objectContaining({
        taskId: 'task-1',
        agentIds: [],
      }),
    );
  });

  it('persists browser workspace state when closing a shell terminal', async () => {
    await closeShell('task-1', 'shell-1');

    expect(store.tasks['task-1']?.shellAgentIds).not.toContain('shell-1');
    expect(saveBrowserWorkspaceStateMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the shell attached locally when backend shell termination fails', async () => {
    markCompatibilityTerminalCreationPending('task-1', 'shell-1');
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.KillAgent:
          return Promise.reject(new Error('kill failed'));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(closeShell('task-1', 'shell-1')).rejects.toThrow('kill failed');

    expect(store.tasks['task-1']?.shellAgentIds).toContain('shell-1');
    expect(isCompatibilityTerminalCreationPending('task-1', 'shell-1')).toBe(true);
    expect(saveBrowserWorkspaceStateMock).not.toHaveBeenCalled();
  });

  it('does not restore pending creation when the task removes the shell during a failed close', async () => {
    const killDeferred = createDeferredPromise<undefined>();
    markCompatibilityTerminalCreationPending('task-1', 'shell-1');
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.KillAgent:
          return killDeferred.promise;
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const closePromise = closeShell('task-1', 'shell-1');
    const closeRejection = expect(closePromise).rejects.toThrow('kill failed');
    expect(isCompatibilityTerminalCreationPending('task-1', 'shell-1')).toBe(false);

    setStore('tasks', 'task-1', 'shellAgentIds', []);
    killDeferred.reject(new Error('kill failed'));
    await closeRejection;

    expect(store.tasks['task-1']?.shellAgentIds).not.toContain('shell-1');
    expect(isCompatibilityTerminalCreationPending('task-1', 'shell-1')).toBe(false);
    expect(saveBrowserWorkspaceStateMock).not.toHaveBeenCalled();
  });

  it('reports skipped prompt sends when another client keeps control', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, 'send a prompt', false, 'peer-client'),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });
    confirmMock.mockResolvedValue(false);

    await expect(sendPrompt('task-1', 'agent-1', 'Ship it')).resolves.toBe(false);
    await expect(sendAgentEnter('task-1', 'agent-1')).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.SendTaskPromptInput, expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.WriteToAgent, expect.anything());
    expect(store.agentActive['agent-1'] ?? false).toBe(false);
  });

  it('returns false without recording the prompt when terminal control is lost after lease acquisition', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(createAcquireLeaseResult(args, 'send a prompt'));
        case IPC.SendTaskPromptInput:
          return Promise.resolve({
            admission: {
              kind: 'rejected-before-bytes',
              reason: 'control-or-lease-lost',
            },
          });
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(sendPrompt('task-1', 'agent-1', 'Ship it')).resolves.toBe(false);
    expect(store.tasks['task-1']?.lastPrompt).toBe('');
    expect(store.agentActive['agent-1']).toBe(false);
  });

  it.each([
    ['question-active', 'Agent is waiting for terminal input'],
    ['task-closing', 'This task is closing'],
    ['agent-generation-changed', 'Agent state changed'],
    ['supervision-version-changed', 'Agent state changed'],
    ['agent-not-ready', 'Agent is not ready for this prompt'],
  ] as const)('preserves the prompt after a safe %s rejection', async (reason, message) => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(createAcquireLeaseResult(args, 'send a prompt'));
        case IPC.SendTaskPromptInput:
          return Promise.resolve({
            admission: {
              ...(reason === 'agent-generation-changed' ? { currentGeneration: 99 } : {}),
              kind: 'rejected-before-bytes',
              reason,
            },
          });
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(sendPrompt('task-1', 'agent-1', 'Ship it')).rejects.toThrow(message);
    expect(store.tasks['task-1']?.lastPrompt).toBe('');
    expect(store.agentActive['agent-1']).toBe(false);
  });

  it('retries only a proven zero-byte rejection while the current agent session starts', async () => {
    let promptAttempts = 0;
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(createAcquireLeaseResult(args, 'send a prompt'));
        case IPC.SendTaskPromptInput:
          promptAttempts += 1;
          return Promise.resolve(
            promptAttempts === 1
              ? {
                  admission: {
                    currentGeneration: 0,
                    kind: 'rejected-before-bytes',
                    reason: 'agent-generation-changed',
                  },
                }
              : {
                  admission: {
                    admittedSupervisionVersion: 1,
                    kind: 'accepted',
                    lowLevelCallCount: 1,
                  },
                },
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const pending = sendPrompt('task-1', 'agent-1', 'Ship it');
    await vi.advanceTimersByTimeAsync(49);
    expect(promptAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe(true);
    expect(promptAttempts).toBe(2);
    expect(store.tasks['task-1']?.lastPrompt).toBe('Ship it');
  });

  it('preserves the prompt and requires inspection after an ambiguous admitted write', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(createAcquireLeaseResult(args, 'send a prompt'));
        case IPC.SendTaskPromptInput:
          return Promise.resolve({
            admission: {
              admittedSupervisionVersion: 12,
              bytesMayHaveBeenAccepted: true,
              kind: 'outcome-ambiguous',
            },
          });
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(sendPrompt('task-1', 'agent-1', 'Ship it')).rejects.toThrow(
      'Prompt outcome is uncertain',
    );
    expect(store.tasks['task-1']?.lastPrompt).toBe('');
    expect(store.agentActive['agent-1']).toBe(false);
  });

  it('does not leave a partial prompt write behind when dispatch fails after lease acquisition', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(createAcquireLeaseResult(args, 'send a prompt'));
        case IPC.SendTaskPromptInput:
          return Promise.reject(new Error('agent write failed'));
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(sendPrompt('task-1', 'agent-1', 'Ship it')).rejects.toThrow(
      'Prompt outcome is uncertain',
    );

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.SendTaskPromptInput),
    ).toHaveLength(1);
    expect(store.tasks['task-1']?.lastPrompt).toBe('');
    expect(store.agentActive['agent-1']).toBe(false);
  });

  it('clears prompt sending state when lease release fails after a successful write', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(createAcquireLeaseResult(args, 'send a prompt'));
        case IPC.SendTaskPromptInput:
          return Promise.resolve({
            admission: {
              admittedSupervisionVersion: 12,
              kind: 'accepted',
              lowLevelCallCount: 1,
            },
          });
        case IPC.ReleaseTaskCommandLease:
          return Promise.reject(new Error('release failed'));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const promise = expect(sendPrompt('task-1', 'agent-1', 'Ship it')).rejects.toThrow(
      'Failed to release task command lease for task-1',
    );

    await promise;

    expect(store.agentActive['agent-1']).toBe(false);
    expect(getAgentPromptDispatchAt('agent-1')).toBeNull();
    expect(store.tasks['task-1']?.lastPrompt).toBe('Ship it');
  });

  it('clears busy activity when enter dispatch loses terminal control after lease acquisition', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(createAcquireLeaseResult(args, 'send a prompt'));
        case IPC.WriteToAgent:
          return Promise.reject(new Error('Task is controlled by another client'));
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(sendAgentEnter('task-1', 'agent-1')).resolves.toBe(false);
    expect(store.agentActive['agent-1']).toBe(false);
  });

  it.each([['user@host:~$ '], ['build % '], ['root# '], ['❯ '], ['hydra[gpt-5.4]>']])(
    'reuses an idle shell when the tail is prompt-ready (%s)',
    async (promptTail) => {
      markShellPromptReady(promptTail);

      await runBookmarkInTask('task-1', 'npm test');

      expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.AcquireTaskCommandLease, {
        action: 'run a shell command',
        clientId: 'client-self',
        ownerId: 'runtime-owner-self',
        taskId: 'task-1',
      });
      expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.WriteToAgent, {
        agentId: 'shell-1',
        controllerId: 'client-self',
        data: 'npm test\r',
        taskId: 'task-1',
      });
      expect(invokeMock).toHaveBeenLastCalledWith(
        IPC.ReleaseTaskCommandLease,
        expect.objectContaining({
          clientId: 'client-self',
          leaseGeneration: expect.any(Number),
          ownerId: 'runtime-owner-self',
          taskId: 'task-1',
        }),
      );
      expect(store.tasks['task-1']?.shellAgentIds).toEqual(['shell-1']);
    },
  );

  it('does not reuse a shell when the tail only looks like output ending in a percent sign', async () => {
    markShellPromptReady('download progress 99%');

    await runBookmarkInTask('task-1', 'npm test');

    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.AcquireTaskCommandLease, {
      action: 'run a shell command',
      clientId: 'client-self',
      ownerId: 'runtime-owner-self',
      taskId: 'task-1',
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      IPC.ReleaseTaskCommandLease,
      expect.objectContaining({
        clientId: 'client-self',
        leaseGeneration: expect.any(Number),
        ownerId: 'runtime-owner-self',
        taskId: 'task-1',
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      IPC.WriteToAgent,
      expect.objectContaining({
        agentId: 'shell-1',
      }),
    );
    expect(store.tasks['task-1']?.shellAgentIds).toEqual(['shell-1', expect.any(String)]);
  });

  it('clears the attempted shell activity when bookmark reuse falls back to a new shell', async () => {
    markShellPromptReady();
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(createAcquireLeaseResult(args, 'run a shell command'));
        case IPC.WriteToAgent:
          return Promise.reject(new Error('stale shell'));
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await runBookmarkInTask('task-1', 'npm test');

    expect(store.agentActive['shell-1']).toBe(false);
    expect(store.tasks['task-1']?.shellAgentIds.length).toBe(2);
  });

  it('spawns a new shell instead of reusing one that is idle but not prompt-ready', async () => {
    clearAgentBusyState('shell-1');

    await runBookmarkInTask('task-1', 'npm test');

    expect(store.tasks['task-1']?.shellAgentIds.length).toBe(2);
    expect(
      invokeMock.mock.calls.some(
        ([channel, payload]) =>
          channel === IPC.WriteToAgent && (payload as { agentId?: string }).agentId === 'shell-1',
      ),
    ).toBe(false);
  });
});
