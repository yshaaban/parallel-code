import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { confirmMock, invokeMock, runtimeClientIdMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  invokeMock: vi.fn(),
  runtimeClientIdMock: vi.fn(() => 'client-self'),
}));

const { isElectronRuntimeMock, sendBrowserControlMessageMock, setStoreMock, storeState } =
  vi.hoisted(() => ({
    isElectronRuntimeMock: vi.fn(() => false),
    sendBrowserControlMessageMock: vi.fn(),
    setStoreMock: vi.fn((...args: unknown[]) => {
      if (args.length === 1 && typeof args[0] === 'function') {
        args[0](storeState);
        return;
      }

      if (args.length === 2 && typeof args[0] === 'string') {
        if (typeof args[1] === 'function') {
          const key = args[0] as keyof typeof storeState;
          storeState[key] = args[1](storeState[key]) as never;
          return;
        }

        storeState[args[0] as keyof typeof storeState] = args[1] as never;
        return;
      }

      if (args.length === 3 && typeof args[0] === 'string' && typeof args[1] === 'string') {
        const storeKey = args[0] as keyof typeof storeState;
        const record = storeState[storeKey] as Record<string, unknown>;
        record[args[1]] = args[2];
        return;
      }

      throw new Error(`Unexpected setStore arguments: ${JSON.stringify(args)}`);
    }),
    storeState: {
      agents: {
        'agent-1': {
          taskId: 'task-1',
        },
      },
      incomingTaskTakeoverRequests: {},
      peerSessions: {},
      taskCommandControllers: {},
    },
  }));

vi.mock('../lib/dialog', () => ({
  confirm: confirmMock,
}));

vi.mock('../lib/ipc', () => ({
  isElectronRuntime: isElectronRuntimeMock,
  invoke: invokeMock,
  sendBrowserControlMessage: sendBrowserControlMessageMock,
}));

vi.mock('../lib/runtime-client-id', () => ({
  getRuntimeClientId: runtimeClientIdMock,
}));

vi.mock('../store/core', () => ({
  setStore: setStoreMock,
  store: storeState,
}));

import {
  TASK_COMMAND_LEASE_SKIPPED,
  createTaskCommandLeaseSession,
  handleIncomingTaskCommandTakeoverRequest,
  handleTaskCommandTakeoverResult,
  respondToIncomingTaskCommandTakeover,
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
    isElectronRuntimeMock.mockReturnValue(false);
    confirmMock.mockResolvedValue(true);
    sendBrowserControlMessageMock.mockReset();
    sendBrowserControlMessageMock.mockResolvedValue(undefined);
    storeState.incomingTaskTakeoverRequests = {};
    storeState.peerSessions = {};
    storeState.taskCommandControllers = {};
    setStoreMock.mockClear();
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

  it('returns the skipped sentinel when the owner denies a takeover request', async () => {
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
    sendBrowserControlMessageMock.mockImplementationOnce(async (message) => {
      if (message.type === 'request-task-command-takeover') {
        queueMicrotask(() => {
          handleTaskCommandTakeoverResult({
            decision: 'denied',
            requestId: message.requestId,
            taskId: message.taskId,
            type: 'task-command-takeover-result',
          });
        });
      }
    });
    const run = vi.fn().mockResolvedValue('done');

    const result = await runWithTaskCommandLease('task-1', 'send a prompt', run);

    expect(result).toBe(TASK_COMMAND_LEASE_SKIPPED);
    expect(run).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(sendBrowserControlMessageMock).toHaveBeenCalledWith({
      action: 'send a prompt',
      requestId: expect.any(String),
      targetControllerId: 'peer-client',
      taskId: 'task-1',
      type: 'request-task-command-takeover',
    });
  });

  it('takes over the lease after owner approval', async () => {
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
    sendBrowserControlMessageMock.mockImplementationOnce(async (message) => {
      if (message.type === 'request-task-command-takeover') {
        queueMicrotask(() => {
          handleTaskCommandTakeoverResult({
            decision: 'approved',
            requestId: message.requestId,
            taskId: message.taskId,
            type: 'task-command-takeover-result',
          });
        });
      }
    });

    const result = await runWithTaskCommandLease('task-1', 'send a prompt', async () => 'done');

    expect(result).toBe('done');
    expect(confirmMock).not.toHaveBeenCalled();
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

  it('lets a session take over without opening a confirm dialog', async () => {
    invokeMock
      .mockImplementationOnce(() =>
        Promise.resolve({
          acquired: false,
          action: 'type in the terminal',
          controllerId: 'peer-client',
          taskId: 'task-1',
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          acquired: true,
          action: 'type in the terminal',
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
    sendBrowserControlMessageMock.mockImplementationOnce(async (message) => {
      if (message.type === 'request-task-command-takeover') {
        queueMicrotask(() => {
          handleTaskCommandTakeoverResult({
            decision: 'approved',
            requestId: message.requestId,
            taskId: message.taskId,
            type: 'task-command-takeover-result',
          });
        });
      }
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      confirmTakeover: false,
    });

    await expect(session.takeOver()).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.AcquireTaskCommandLease, {
      action: 'type in the terminal',
      clientId: 'client-self',
      takeover: true,
      taskId: 'task-1',
    });

    await session.release();
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

  it('tracks and responds to multiple takeover requests for the same task by request id', async () => {
    handleIncomingTaskCommandTakeoverRequest({
      action: 'send a prompt',
      expiresAt: 10_000,
      requestId: 'request-1',
      requesterClientId: 'peer-a',
      requesterDisplayName: 'Peer A',
      taskId: 'task-1',
      type: 'task-command-takeover-request',
    });
    handleIncomingTaskCommandTakeoverRequest({
      action: 'type in the terminal',
      expiresAt: 11_000,
      requestId: 'request-2',
      requesterClientId: 'peer-b',
      requesterDisplayName: 'Peer B',
      taskId: 'task-1',
      type: 'task-command-takeover-request',
    });

    expect(Object.keys(storeState.incomingTaskTakeoverRequests)).toEqual([
      'request-1',
      'request-2',
    ]);

    await respondToIncomingTaskCommandTakeover('request-1', true);

    expect(sendBrowserControlMessageMock).toHaveBeenCalledWith({
      approved: true,
      requestId: 'request-1',
      type: 'respond-task-command-takeover',
    });
    expect(storeState.incomingTaskTakeoverRequests).toEqual({
      'request-2': expect.objectContaining({
        requestId: 'request-2',
        taskId: 'task-1',
      }),
    });
  });
});
