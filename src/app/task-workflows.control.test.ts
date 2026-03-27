import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { RendererInvokeResponseMap } from '../domain/renderer-invoke';
import { consumePendingShellCommand } from '../lib/bookmarks';
import { setStore, store } from '../store/core';
import { resetTaskCommandControllerStateForTests } from '../store/task-command-controllers';
import { clearAgentBusyState, markAgentOutput } from '../store/taskStatus';
import {
  createTestAgent,
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
} = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  invokeMock: vi.fn(),
  runtimeClientIdMock: vi.fn(() => 'client-self'),
  runtimeLeaseOwnerIdMock: vi.fn(() => 'runtime-owner-self'),
  saveBrowserWorkspaceStateMock: vi.fn(() => Promise.resolve()),
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
  };
});

import {
  collapseTask,
  closeShell,
  closeTask,
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

    await Promise.resolve();
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
    });
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
          return Promise.resolve(undefined);
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
    const deleteDeferred = createDeferredPromise<undefined>();
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

    deleteDeferred.resolve(undefined);
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

    await expect(sendPrompt('task-1', 'agent-1', 'Ship it')).rejects.toThrow(
      'Failed to release task command lease for task-1',
    );

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
