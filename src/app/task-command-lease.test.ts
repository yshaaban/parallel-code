import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { confirmMock, invokeMock, runtimeClientIdMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  invokeMock: vi.fn(),
  runtimeClientIdMock: vi.fn(() => 'client-self'),
}));

vi.mock('../lib/dialog', () => ({
  confirm: confirmMock,
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../lib/runtime-client-id', () => ({
  getRuntimeClientId: runtimeClientIdMock,
}));

vi.mock('../store/core', () => ({
  store: {
    agents: {
      'agent-1': {
        taskId: 'task-1',
      },
    },
  },
}));

import {
  TASK_COMMAND_LEASE_SKIPPED,
  createTaskCommandLeaseSession,
  runWithAgentTaskCommandLease,
  runWithTaskCommandLease,
} from './task-command-lease';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('task command lease helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    runtimeClientIdMock.mockReturnValue('client-self');
    confirmMock.mockResolvedValue(true);
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve({
            acquired: true,
            action: 'send a prompt',
            controllerId: 'client-self',
            taskId: 'task-1',
          });
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve({
            action: null,
            controllerId: null,
            taskId: 'task-1',
          });
        case IPC.RenewTaskCommandLease:
          return Promise.resolve({
            renewed: true,
            action: 'send a prompt',
            controllerId: 'client-self',
            taskId: 'task-1',
          });
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('acquires and releases a lease around successful work', async () => {
    const run = vi.fn().mockResolvedValue('done');

    const result = await runWithTaskCommandLease('task-1', 'send a prompt', run);

    expect(result).toBe('done');
    expect(run).toHaveBeenCalledTimes(1);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.AcquireTaskCommandLease, {
      action: 'send a prompt',
      clientId: 'client-self',
      taskId: 'task-1',
    });
    expect(invokeMock).toHaveBeenLastCalledWith(IPC.ReleaseTaskCommandLease, {
      clientId: 'client-self',
      taskId: 'task-1',
    });
  });

  it('returns the skipped sentinel when the user declines a takeover', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve({
            acquired: false,
            action: 'merge this task',
            controllerId: 'peer-client',
            taskId: 'task-1',
          });
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });
    confirmMock.mockResolvedValue(false);
    const run = vi.fn().mockResolvedValue('done');

    const result = await runWithTaskCommandLease('task-1', 'send a prompt', run);

    expect(result).toBe(TASK_COMMAND_LEASE_SKIPPED);
    expect(run).not.toHaveBeenCalled();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('takes over the lease after user confirmation', async () => {
    invokeMock
      .mockImplementationOnce(() =>
        Promise.resolve({
          acquired: false,
          action: 'merge this task',
          controllerId: 'peer-client',
          taskId: 'task-1',
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          acquired: true,
          action: 'send a prompt',
          controllerId: 'client-self',
          taskId: 'task-1',
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          action: null,
          controllerId: null,
          taskId: 'task-1',
        }),
      );

    const result = await runWithTaskCommandLease('task-1', 'send a prompt', async () => 'done');

    expect(result).toBe('done');
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.AcquireTaskCommandLease, {
      action: 'send a prompt',
      clientId: 'client-self',
      takeover: true,
      taskId: 'task-1',
    });
    expect(invokeMock).toHaveBeenLastCalledWith(IPC.ReleaseTaskCommandLease, {
      clientId: 'client-self',
      taskId: 'task-1',
    });
  });

  it('renews the lease while work is still pending', async () => {
    const runDeferred = createDeferred<string>();
    const resultPromise = runWithTaskCommandLease(
      'task-1',
      'send a prompt',
      () => runDeferred.promise,
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    const renewCalls = invokeMock.mock.calls.filter(
      ([channel]) => channel === IPC.RenewTaskCommandLease,
    );
    expect(renewCalls).toHaveLength(2);

    runDeferred.resolve('done');
    await expect(resultPromise).resolves.toBe('done');

    const renewCallCountAfterCompletion = invokeMock.mock.calls.filter(
      ([channel]) => channel === IPC.RenewTaskCommandLease,
    ).length;
    await vi.advanceTimersByTimeAsync(5_000);
    const finalRenewCallCount = invokeMock.mock.calls.filter(
      ([channel]) => channel === IPC.RenewTaskCommandLease,
    ).length;
    expect(finalRenewCallCount).toBe(renewCallCountAfterCompletion);
  });

  it('releases the lease when the work throws', async () => {
    const failure = new Error('work failed');

    await expect(
      runWithTaskCommandLease('task-1', 'send a prompt', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(invokeMock).toHaveBeenLastCalledWith(IPC.ReleaseTaskCommandLease, {
      clientId: 'client-self',
      taskId: 'task-1',
    });
  });

  it('can skip takeover prompts when a peer already controls the task', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve({
            acquired: false,
            action: 'type in the terminal',
            controllerId: 'peer-client',
            taskId: 'task-1',
          });
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const result = await runWithTaskCommandLease(
      'task-1',
      'respond to a trust prompt',
      async () => 'done',
      { confirmTakeover: false },
    );

    expect(result).toBe(TASK_COMMAND_LEASE_SKIPPED);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('shares a held lease between a session and one-shot work before releasing it', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });

    await expect(session.acquire()).resolves.toBe(true);
    await expect(
      runWithTaskCommandLease('task-1', 'send a prompt', async () => 'done'),
    ).resolves.toBe('done');

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);

    await session.release();

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(1);
  });

  it('uses the agent task when running agent-scoped lease work', async () => {
    const result = await runWithAgentTaskCommandLease(
      'agent-1',
      'approve a permission request',
      async () => 'done',
    );

    expect(result).toBe('done');
    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.AcquireTaskCommandLease, {
      action: 'approve a permission request',
      clientId: 'client-self',
      taskId: 'task-1',
    });
  });
});
