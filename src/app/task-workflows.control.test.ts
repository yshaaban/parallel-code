import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { RendererInvokeResponseMap } from '../domain/renderer-invoke';
import { consumePendingShellCommand } from '../lib/bookmarks';
import { setStore, store } from '../store/core';
import { resetTaskCommandControllerStateForTests } from '../store/task-command-controllers';
import { clearAgentBusyState, markAgentOutput } from '../store/taskStatus';
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
} = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  invokeMock: vi.fn(),
  runtimeClientIdMock: vi.fn(() => 'client-self'),
  runtimeLeaseOwnerIdMock: vi.fn(() => 'runtime-owner-self'),
  saveBrowserWorkspaceStateMock: vi.fn(() => Promise.resolve()),
  saveCurrentRuntimeStateMock: vi.fn(() => Promise.resolve()),
  showNotificationMock: vi.fn(),
}));

vi.mock('../lib/dialog', () => ({
  confirm: confirmMock,
}));

vi.mock('../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../lib/ipc')>('../lib/ipc');
  return {
    ...actual,
    invoke: invokeMock,
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
  createTask,
  mergeTask,
  resetTaskLifecycleRuntimeStateForTests,
  retryCloseTask,
  runBookmarkInTask,
  sendAgentEnter,
  sendPrompt,
  uncollapseTask,
  spawnShellForTask,
} from './task-workflows';
import { resetTaskCommandLeaseStateForTests } from './task-command-lease';
import { getAgentPromptDispatchAt } from './task-prompt-dispatch';

let taskCommandControllerVersion = 0;
let taskCommandLeaseGeneration = 0;

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
    resetTaskCommandControllerStateForTests();
    resetTaskCommandLeaseStateForTests();
    resetTaskLifecycleRuntimeStateForTests();
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
          return Promise.resolve(undefined);
        case IPC.MergeTask:
          return Promise.resolve({
            lines_added: 12,
            lines_removed: 4,
          });
        case IPC.WriteToAgent:
          return Promise.resolve(undefined);
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
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.WriteToAgent, {
      agentId: 'agent-1',
      controllerId: 'client-self',
      data: 'Ship it\r',
      taskId: 'task-1',
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
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel !== IPC.CreateTask) {
        throw new Error(`Unexpected IPC channel: ${channel}`);
      }

      return Promise.resolve({
        id: 'task-non-git',
        branch_name: '',
        project_mode: 'non-git',
        worktree_path: '/tmp/folder',
      });
    });

    await expect(
      createTask({
        agentDef,
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
        projectMode: 'non-git',
        projectRoot: '/tmp/folder',
      }),
    );
  });

  it('rolls back a managed worktree when coordinator setup fails after task creation', async () => {
    const agentDef = createTestAgentDef({ id: 'codex', name: 'Codex' });
    setStore('projects', [
      createTestProject({
        id: 'project-1',
        path: '/repo',
      }),
    ]);
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.CreateTask:
          return Promise.resolve({
            base_branch: 'main',
            branch_name: 'feature/task-new',
            git_isolation: 'worktree',
            id: 'task-new',
            worktree_path: '/repo/.worktrees/task-new',
          });
        case IPC.CoordinatorCreateRun:
          return Promise.reject(new Error('coordinator unavailable'));
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.DeleteTask:
          return Promise.resolve({ cleanupWarnings: [] });
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(
      createTask({
        agentDef,
        coordinatorMode: true,
        name: 'Coordinator task',
        projectId: 'project-1',
      }),
    ).rejects.toThrow('coordinator unavailable');

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.AcquireTaskCommandLease,
      expect.objectContaining({
        action: 'roll back failed coordinator setup',
        taskId: 'task-new',
        takeover: true,
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      IPC.DeleteTask,
      expect.objectContaining({
        agentIds: [],
        branchName: 'feature/task-new',
        deleteBranch: true,
        taskId: 'task-new',
        worktreePath: '/repo/.worktrees/task-new',
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      IPC.ReleaseTaskCommandLease,
      expect.objectContaining({
        taskId: 'task-new',
      }),
    );
    expect(store.tasks['task-new']).toBeUndefined();
    expect(store.agents).not.toHaveProperty('task-new');
  });

  it('rolls back non-git coordinator setup failures through runtime cleanup', async () => {
    const agentDef = createTestAgentDef({ id: 'codex', name: 'Codex' });
    setStore('projects', [
      createTestProject({
        id: 'project-1',
        path: '/tmp/folder',
        projectMode: 'non-git',
      }),
    ]);
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.CreateTask:
          return Promise.resolve({
            branch_name: '',
            id: 'task-non-git',
            project_mode: 'non-git',
            worktree_path: '/tmp/folder',
          });
        case IPC.CoordinatorCreateRun:
          return Promise.reject(new Error('coordinator unavailable'));
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            createAcquireLeaseResult(args, (args as { action: string }).action),
          );
        case IPC.CleanupTaskRuntime:
          return Promise.resolve(undefined);
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(
      createTask({
        agentDef,
        coordinatorMode: true,
        name: 'Folder coordinator task',
        projectId: 'project-1',
        projectMode: 'non-git',
      }),
    ).rejects.toThrow('coordinator unavailable');

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.CleanupTaskRuntime,
      expect.objectContaining({
        agentIds: [],
        projectMode: 'non-git',
        removeTaskState: true,
        taskId: 'task-non-git',
        worktreePath: '/tmp/folder',
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      IPC.ReleaseTaskCommandLease,
      expect.objectContaining({
        taskId: 'task-non-git',
      }),
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
          agentDef,
          coordinatorMode: true,
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
        agentDef,
        coordinatorMode: true,
        name: 'Coordinator task',
        projectId: 'project-1',
      }),
    ).rejects.toThrow('Coordinator mode currently requires host-run agents.');

    expect(invokeMock).not.toHaveBeenCalledWith(IPC.CreateTask, expect.anything());
  });

  it('waits longer before submitting multiline bracketed paste prompts', async () => {
    vi.useFakeTimers();

    const promise = sendPrompt('task-1', 'agent-1', 'line 1\nline 2\nline 3');

    await vi.advanceTimersByTimeAsync(40);

    expect(invokeMock.mock.calls.filter(([channel]) => channel === IPC.WriteToAgent)).toEqual([
      [
        IPC.WriteToAgent,
        {
          agentId: 'agent-1',
          controllerId: 'client-self',
          data: '\x1b[200~line 1\nline 2\nline 3\x1b[201~',
          taskId: 'task-1',
        },
      ],
    ]);

    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(invokeMock.mock.calls.filter(([channel]) => channel === IPC.WriteToAgent)).toEqual([
      [
        IPC.WriteToAgent,
        {
          agentId: 'agent-1',
          controllerId: 'client-self',
          data: '\x1b[200~line 1\nline 2\nline 3\x1b[201~',
          taskId: 'task-1',
        },
      ],
      [
        IPC.WriteToAgent,
        {
          agentId: 'agent-1',
          controllerId: 'client-self',
          data: '\r',
          taskId: 'task-1',
        },
      ],
    ]);
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

  it('removes and persists a task immediately after backend close succeeds', async () => {
    await closeTask('task-1');

    expect(store.tasks['task-1']).toBeUndefined();
    expect(saveCurrentRuntimeStateMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces backend cleanup warnings after task deletion completes', async () => {
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
            cleanupWarnings: [
              {
                kind: 'worktree',
                message: 'Failed to clean task worktree while deleting task: remove failed',
              },
            ],
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
      expect(showNotificationMock).toHaveBeenCalledWith(
        'Task closed, but worktree cleanup did not finish. Check server logs before reusing this task branch.',
      );
      expect(warnSpy).toHaveBeenCalledWith('Task task-1 closed with cleanup warnings:', [
        {
          kind: 'worktree',
          message: 'Failed to clean task worktree while deleting task: remove failed',
        },
      ]);
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
      removeTaskState: true,
      taskId: 'task-1',
      worktreePath: '/tmp/project/task-1',
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      IPC.DeleteTask,
      expect.objectContaining({ taskId: 'task-1' }),
    );
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

  it('passes controller identity through merge-task requests', async () => {
    await mergeTask('task-1', {
      cleanup: false,
      message: 'merge commit',
      squash: true,
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.MergeTask, {
      branchName: 'feature/task-1',
      cleanup: false,
      controllerId: 'client-self',
      message: 'merge commit',
      projectRoot: '/tmp/project',
      squash: true,
      taskId: 'task-1',
      worktreePath: '/tmp/project/task-1',
    });
    expect(store.completedTaskCount).toBe(0);
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
      IPC.MergeTask,
      expect.objectContaining({
        cleanup: false,
        taskId: 'task-1',
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      IPC.CleanupTaskRuntime,
      expect.objectContaining({ taskId: 'task-1' }),
    );
  });

  it('cleans backend runtime state when merge cleanup removes the task locally', async () => {
    await mergeTask('task-1', {
      cleanup: true,
      squash: false,
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.CleanupTaskRuntime, {
      agentIds: ['agent-1', 'shell-1'],
      controllerId: 'client-self',
      removeTaskState: true,
      taskId: 'task-1',
      worktreePath: '/tmp/project/task-1',
    });
    expect(store.completedTaskCount).toBe(1);
  });

  it('does not count plain task close as merged progress', async () => {
    await closeTask('task-1');
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeUndefined();
    expect(store.completedTaskCount).toBe(0);
  });

  it('still removes the task locally when merge cleanup runtime cleanup fails', async () => {
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
        case IPC.MergeTask:
          return Promise.resolve({
            lines_added: 12,
            lines_removed: 4,
          });
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await mergeTask('task-1', {
      cleanup: true,
      squash: false,
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeUndefined();
  });

  it('keeps the task locally when merge cleanup loses task control mid-flight', async () => {
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
        case IPC.MergeTask:
          return Promise.resolve({
            lines_added: 12,
            lines_removed: 4,
          });
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(
      mergeTask('task-1', {
        cleanup: true,
        squash: false,
      }),
    ).rejects.toThrow('Task is controlled by another client');
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeDefined();
    expect(store.completedTaskCount).toBe(0);
  });

  it('allows a later close after merge cleanup loses task control mid-flight', async () => {
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
        case IPC.DeleteTask:
          return Promise.resolve({ cleanupWarnings: [] });
        case IPC.MergeTask:
          return Promise.resolve({
            lines_added: 12,
            lines_removed: 4,
          });
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(
      mergeTask('task-1', {
        cleanup: true,
        squash: false,
      }),
    ).rejects.toThrow('Task is controlled by another client');

    expect(store.tasks['task-1']).toBeDefined();

    await closeTask('task-1');
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeUndefined();
  });

  it('retries merge cleanup successfully after task control is restored', async () => {
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
        case IPC.MergeTask:
          return Promise.resolve({
            lines_added: 12,
            lines_removed: 4,
          });
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(createRenewLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(
      mergeTask('task-1', {
        cleanup: true,
        squash: false,
      }),
    ).rejects.toThrow('Task is controlled by another client');
    expect(store.tasks['task-1']).toBeDefined();

    await mergeTask('task-1', {
      cleanup: true,
      squash: false,
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(store.tasks['task-1']).toBeUndefined();
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
  });

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
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.WriteToAgent, expect.anything());
    expect(store.agentActive['agent-1'] ?? false).toBe(false);
  });

  it('returns false without recording the prompt when terminal control is lost after lease acquisition', async () => {
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

    await expect(sendPrompt('task-1', 'agent-1', 'Ship it')).resolves.toBe(false);
    expect(store.tasks['task-1']?.lastPrompt).toBe('');
    expect(store.agentActive['agent-1']).toBe(false);
  });

  it('does not leave a partial prompt write behind when dispatch fails after lease acquisition', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(createAcquireLeaseResult(args, 'send a prompt'));
        case IPC.WriteToAgent:
          return Promise.reject(new Error('agent write failed'));
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(createReleaseLeaseResult(args));
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    await expect(sendPrompt('task-1', 'agent-1', 'Ship it')).rejects.toThrow('agent write failed');

    expect(invokeMock.mock.calls.filter(([channel]) => channel === IPC.WriteToAgent)).toHaveLength(
      1,
    );
    expect(store.tasks['task-1']?.lastPrompt).toBe('');
    expect(store.agentActive['agent-1']).toBe(false);
  });

  it('clears prompt sending state when lease release fails after a successful write', async () => {
    invokeMock.mockImplementation((channel: IPC, args?: unknown) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(createAcquireLeaseResult(args, 'send a prompt'));
        case IPC.WriteToAgent:
          return Promise.resolve(undefined);
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
