import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { RendererInvokeResponseMap } from '../domain/renderer-invoke';
import { setStore, store } from '../store/core';
import { resetTaskCommandControllerStateForTests } from '../store/task-command-controllers';
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
  closeShell,
  closeTask,
  mergeTask,
  runBookmarkInTask,
  sendAgentEnter,
  sendPrompt,
  spawnShellForTask,
} from './task-workflows';
import { resetTaskCommandLeaseStateForTests } from './task-command-lease';

let taskCommandControllerVersion = 0;

function withControllerVersion<T extends { taskId: string }>(value: T): T & { version: number } {
  taskCommandControllerVersion += 1;
  return {
    ...value,
    version: taskCommandControllerVersion,
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

describe('task workflow control leases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    taskCommandControllerVersion = 0;
    resetTaskCommandControllerStateForTests();
    resetTaskCommandLeaseStateForTests();
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
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('sends prompts under a task command lease and records the last prompt', async () => {
    const promise = sendPrompt('task-1', 'agent-1', 'Ship it');

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
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
      data: 'Ship it',
      taskId: 'task-1',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, IPC.WriteToAgent, {
      agentId: 'agent-1',
      controllerId: 'client-self',
      data: '\r',
      taskId: 'task-1',
    });
    expect(invokeMock).toHaveBeenLastCalledWith(IPC.ReleaseTaskCommandLease, {
      clientId: 'client-self',
      ownerId: 'runtime-owner-self',
      taskId: 'task-1',
    });
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
    expect(invokeMock).toHaveBeenLastCalledWith(IPC.ReleaseTaskCommandLease, {
      clientId: 'client-self',
      ownerId: 'runtime-owner-self',
      taskId: 'task-1',
    });
  });

  it('persists browser workspace state when opening a shell terminal', async () => {
    const shellId = spawnShellForTask('task-1');

    expect(store.tasks['task-1']?.shellAgentIds).toContain(shellId);
    expect(saveBrowserWorkspaceStateMock).toHaveBeenCalledTimes(1);
  });

  it('persists browser workspace state when closing a shell terminal', async () => {
    await closeShell('task-1', 'shell-1');

    expect(store.tasks['task-1']?.shellAgentIds).not.toContain('shell-1');
    expect(saveBrowserWorkspaceStateMock).toHaveBeenCalledTimes(1);
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
  });

  it('runs shell bookmarks under a task command lease', async () => {
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
    expect(invokeMock).toHaveBeenLastCalledWith(IPC.ReleaseTaskCommandLease, {
      clientId: 'client-self',
      ownerId: 'runtime-owner-self',
      taskId: 'task-1',
    });
  });
});
