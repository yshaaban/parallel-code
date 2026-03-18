import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { confirmMock, invokeMock, runtimeClientIdMock, runtimeLeaseOwnerIdMock } = vi.hoisted(
  () => ({
    confirmMock: vi.fn(),
    invokeMock: vi.fn(),
    runtimeClientIdMock: vi.fn(() => 'client-self'),
    runtimeLeaseOwnerIdMock: vi.fn(() => 'runtime-owner-self'),
  }),
);

const {
  browserTransportListeners,
  isElectronRuntimeMock,
  onBrowserTransportEventMock,
  sendBrowserControlMessageMock,
  setStoreMock,
  storeState,
} = vi.hoisted(() => ({
  browserTransportListeners: new Set<
    (event: {
      kind: 'connection';
      state: 'auth-expired' | 'connected' | 'connecting' | 'disconnected' | 'reconnecting';
    }) => void
  >(),
  isElectronRuntimeMock: vi.fn(() => false),
  onBrowserTransportEventMock: vi.fn((listener) => {
    browserTransportListeners.add(listener);
    return () => {
      browserTransportListeners.delete(listener);
    };
  }),
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
  onBrowserTransportEvent: onBrowserTransportEventMock,
  sendImmediateBrowserControlMessage: sendBrowserControlMessageMock,
}));

vi.mock('../lib/runtime-client-id', () => ({
  getRuntimeClientId: runtimeClientIdMock,
  getRuntimeLeaseOwnerId: runtimeLeaseOwnerIdMock,
}));

vi.mock('../store/core', () => ({
  setStore: setStoreMock,
  store: storeState,
}));

type TaskCommandControllersModule = typeof import('../store/task-command-controllers');
type TaskCommandLeaseModule = typeof import('./task-command-lease');

let applyTaskCommandControllerChanged: TaskCommandControllersModule['applyTaskCommandControllerChanged'];
let assertTaskCommandControllerStateCleanForTests: TaskCommandControllersModule['assertTaskCommandControllerStateCleanForTests'];
let replaceTaskCommandControllers: TaskCommandControllersModule['replaceTaskCommandControllers'];
let resetTaskCommandControllerStateForTests: TaskCommandControllersModule['resetTaskCommandControllerStateForTests'];
let assertTaskCommandLeaseStateCleanForTests: TaskCommandLeaseModule['assertTaskCommandLeaseStateCleanForTests'];
let TASK_COMMAND_LEASE_SKIPPED: TaskCommandLeaseModule['TASK_COMMAND_LEASE_SKIPPED'];
let createTaskCommandLeaseSession: TaskCommandLeaseModule['createTaskCommandLeaseSession'];
let handleIncomingTaskCommandTakeoverRequest: TaskCommandLeaseModule['handleIncomingTaskCommandTakeoverRequest'];
let handleTaskCommandTakeoverResult: TaskCommandLeaseModule['handleTaskCommandTakeoverResult'];
let resetTaskCommandLeaseStateForTests: TaskCommandLeaseModule['resetTaskCommandLeaseStateForTests'];
let respondToIncomingTaskCommandTakeover: TaskCommandLeaseModule['respondToIncomingTaskCommandTakeover'];
let runWithAgentTaskCommandLease: TaskCommandLeaseModule['runWithAgentTaskCommandLease'];
let runWithTaskCommandLease: TaskCommandLeaseModule['runWithTaskCommandLease'];

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

function emitBrowserTransportState(
  state: 'auth-expired' | 'connected' | 'connecting' | 'disconnected' | 'reconnecting',
): void {
  for (const listener of browserTransportListeners) {
    listener({ kind: 'connection', state });
  }
}

let taskCommandControllerVersion = 0;

function withControllerVersion<T extends { taskId: string }>(value: T): T & { version: number } {
  taskCommandControllerVersion += 1;
  return {
    ...value,
    version: taskCommandControllerVersion,
  };
}

describe('task command lease helper', () => {
  beforeEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.resetModules();
    taskCommandControllerVersion = 0;
    const taskCommandControllersModule = await import('../store/task-command-controllers');
    const taskCommandLeaseModule = await import('./task-command-lease');
    applyTaskCommandControllerChanged =
      taskCommandControllersModule.applyTaskCommandControllerChanged;
    assertTaskCommandControllerStateCleanForTests =
      taskCommandControllersModule.assertTaskCommandControllerStateCleanForTests;
    replaceTaskCommandControllers = taskCommandControllersModule.replaceTaskCommandControllers;
    resetTaskCommandControllerStateForTests =
      taskCommandControllersModule.resetTaskCommandControllerStateForTests;
    assertTaskCommandLeaseStateCleanForTests =
      taskCommandLeaseModule.assertTaskCommandLeaseStateCleanForTests;
    TASK_COMMAND_LEASE_SKIPPED = taskCommandLeaseModule.TASK_COMMAND_LEASE_SKIPPED;
    createTaskCommandLeaseSession = taskCommandLeaseModule.createTaskCommandLeaseSession;
    handleIncomingTaskCommandTakeoverRequest =
      taskCommandLeaseModule.handleIncomingTaskCommandTakeoverRequest;
    handleTaskCommandTakeoverResult = taskCommandLeaseModule.handleTaskCommandTakeoverResult;
    resetTaskCommandLeaseStateForTests = taskCommandLeaseModule.resetTaskCommandLeaseStateForTests;
    respondToIncomingTaskCommandTakeover =
      taskCommandLeaseModule.respondToIncomingTaskCommandTakeover;
    runWithAgentTaskCommandLease = taskCommandLeaseModule.runWithAgentTaskCommandLease;
    runWithTaskCommandLease = taskCommandLeaseModule.runWithTaskCommandLease;
    resetTaskCommandControllerStateForTests();
    resetTaskCommandLeaseStateForTests();
    confirmMock.mockReset();
    invokeMock.mockReset();
    isElectronRuntimeMock.mockReset();
    runtimeClientIdMock.mockReset();
    runtimeLeaseOwnerIdMock.mockReset();
    runtimeClientIdMock.mockReturnValue('client-self');
    runtimeLeaseOwnerIdMock.mockReturnValue('runtime-owner-self');
    isElectronRuntimeMock.mockReturnValue(false);
    confirmMock.mockResolvedValue(true);
    sendBrowserControlMessageMock.mockReset();
    sendBrowserControlMessageMock.mockResolvedValue(undefined);
    browserTransportListeners.clear();
    storeState.incomingTaskTakeoverRequests = {};
    storeState.peerSessions = {};
    storeState.taskCommandControllers = {};
    setStoreMock.mockClear();
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: true,
              action: 'send a prompt',
              controllerId: 'client-self',
              taskId: 'task-1',
            }),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              renewed: true,
              action: 'send a prompt',
              controllerId: 'client-self',
              taskId: 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });
  });

  afterEach(() => {
    try {
      assertTaskCommandLeaseStateCleanForTests();
      assertTaskCommandControllerStateCleanForTests();
    } finally {
      resetTaskCommandLeaseStateForTests();
      resetTaskCommandControllerStateForTests();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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
      ownerId: 'runtime-owner-self',
      taskId: 'task-1',
    });
    expect(invokeMock).toHaveBeenLastCalledWith(IPC.ReleaseTaskCommandLease, {
      clientId: 'client-self',
      ownerId: 'runtime-owner-self',
      taskId: 'task-1',
    });
  });

  it('returns the skipped sentinel when the owner denies a takeover request', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: false,
              action: 'merge this task',
              controllerId: 'peer-client',
              taskId: 'task-1',
            }),
          );
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
        Promise.resolve(
          withControllerVersion({
            acquired: false,
            action: 'merge this task',
            controllerId: 'peer-client',
            taskId: 'task-1',
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          withControllerVersion({
            acquired: true,
            action: 'send a prompt',
            controllerId: 'client-self',
            taskId: 'task-1',
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          withControllerVersion({
            action: null,
            controllerId: null,
            taskId: 'task-1',
          }),
        ),
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
      ownerId: 'runtime-owner-self',
      takeover: true,
      taskId: 'task-1',
    });
    expect(invokeMock).toHaveBeenLastCalledWith(IPC.ReleaseTaskCommandLease, {
      clientId: 'client-self',
      ownerId: 'runtime-owner-self',
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
      ownerId: 'runtime-owner-self',
      taskId: 'task-1',
    });
  });

  it('can skip takeover prompts when a peer already controls the task', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: false,
              action: 'type in the terminal',
              controllerId: 'peer-client',
              taskId: 'task-1',
            }),
          );
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
    session.cleanup();
  });

  it('touches a retained session lease without reacquiring it', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });

    await expect(session.acquire()).resolves.toBe(true);
    expect(session.touch()).toBe(true);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.AcquireTaskCommandLease),
    ).toHaveLength(1);

    await session.release();
    session.cleanup();
  });

  it('extends the retained session idle timeout when touched', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });

    await expect(session.acquire()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(session.touch()).toBe(true);

    await vi.advanceTimersByTimeAsync(750);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(1);
    session.cleanup();
  });

  it('releases a retained session after the idle timeout elapses', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });

    await expect(session.acquire()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(session.touch()).toBe(false);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(1);
    session.cleanup();
  });

  it('drops a stale retained session lease before attempting to reacquire it', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      confirmTakeover: false,
      idleReleaseMs: 1_000,
    });

    await expect(session.acquire()).resolves.toBe(true);
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-client',
      taskId: 'task-1',
      version: 1,
    });
    await Promise.resolve();
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: false,
              action: 'type in the terminal',
              controllerId: 'peer-client',
              taskId: 'task-1',
            }),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              renewed: false,
              action: 'type in the terminal',
              controllerId: 'peer-client',
              taskId: 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    expect(session.touch()).toBe(false);
    await expect(session.acquire()).resolves.toBe(false);
    expect(sendBrowserControlMessageMock).not.toHaveBeenCalled();

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.AcquireTaskCommandLease),
    ).toHaveLength(2);
    session.cleanup();
  });

  it('stops renewing after another client takes control', async () => {
    const runDeferred = createDeferred<string>();
    const run = vi.fn(() => runDeferred.promise);
    const resultPromise = runWithTaskCommandLease('task-1', 'send a prompt', run);

    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    applyTaskCommandControllerChanged({
      action: 'send a prompt',
      controllerId: 'peer-client',
      taskId: 'task-1',
      version: 1,
    });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.RenewTaskCommandLease),
    ).toHaveLength(0);

    runDeferred.resolve('done');
    await expect(resultPromise).resolves.toBe('done');
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(1);
  });

  it('invalidates retained sessions when controllers are replaced from a reconnect snapshot', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      confirmTakeover: false,
      idleReleaseMs: 1_000,
    });

    await expect(session.acquire()).resolves.toBe(true);
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: false,
              action: 'type in the terminal',
              controllerId: 'peer-client',
              taskId: 'task-1',
            }),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              renewed: false,
              action: 'type in the terminal',
              controllerId: 'peer-client',
              taskId: 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });
    replaceTaskCommandControllers([
      {
        action: 'type in the terminal',
        controllerId: 'peer-client',
        taskId: 'task-1',
        version: 1,
      },
    ]);
    await Promise.resolve();

    expect(session.touch()).toBe(false);
    await expect(session.acquire()).resolves.toBe(false);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);
    session.cleanup();
  });

  it('invalidates retained sessions when a reconnect snapshot clears the controller', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      confirmTakeover: false,
      idleReleaseMs: 1_000,
    });

    await expect(session.acquire()).resolves.toBe(true);
    replaceTaskCommandControllers([], {
      replaceVersion: 3,
    });
    await Promise.resolve();

    expect(session.touch()).toBe(false);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);
    session.cleanup();
  });

  it('does not double-release after session cleanup unregisters its invalidation listener', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });

    await expect(session.acquire()).resolves.toBe(true);
    session.cleanup();
    await Promise.resolve();

    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-client',
      taskId: 'task-1',
      version: 2,
    });
    await Promise.resolve();

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(1);
  });

  it('invalidates retained sessions when the browser control plane disconnects', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });

    await expect(session.acquire()).resolves.toBe(true);

    emitBrowserTransportState('disconnected');
    await Promise.resolve();

    expect(session.touch()).toBe(false);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);
    session.cleanup();
  });

  it('invalidates retained sessions when the browser control plane starts reconnecting', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });

    await expect(session.acquire()).resolves.toBe(true);

    emitBrowserTransportState('reconnecting');
    await Promise.resolve();

    expect(session.touch()).toBe(false);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);
    session.cleanup();
  });

  it('does not retain a session lease when the control plane disconnects before acquire resolves', async () => {
    const acquireDeferred = createDeferred<{
      acquired: boolean;
      action: string;
      controllerId: string;
      taskId: string;
      version: number;
    }>();
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return acquireDeferred.promise;
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              renewed: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });
    const acquirePromise = session.acquire();

    emitBrowserTransportState('disconnected');
    acquireDeferred.resolve(
      withControllerVersion({
        acquired: true,
        action: 'type in the terminal',
        controllerId: 'client-self',
        taskId: 'task-1',
      }),
    );

    await expect(acquirePromise).resolves.toBe(false);
    expect(session.touch()).toBe(false);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.RenewTaskCommandLease),
    ).toHaveLength(0);
    session.cleanup();
  });

  it('fails takeover requests fast when the browser control plane disconnects mid-request', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: false,
              action: 'type in the terminal',
              controllerId: 'peer-client',
              taskId: 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });
    sendBrowserControlMessageMock.mockImplementationOnce(async () => {
      emitBrowserTransportState('disconnected');
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      confirmTakeover: false,
    });

    await expect(session.takeOver()).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
    session.cleanup();
  });

  it('clears incoming takeover requests when the browser control plane disconnects', async () => {
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

    emitBrowserTransportState('reconnecting');

    expect(storeState.incomingTaskTakeoverRequests).toEqual({});
  });

  it('ignores stale controller snapshots that arrive after a newer owner update', () => {
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'client-self',
      taskId: 'task-1',
      version: 2,
    });

    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-client',
      taskId: 'task-1',
      version: 1,
    });

    expect(storeState.taskCommandControllers).toMatchObject({
      'task-1': {
        action: 'type in the terminal',
        controllerId: 'client-self',
        version: 2,
      },
    });
  });

  it('lets a session take over without opening a confirm dialog', async () => {
    invokeMock
      .mockImplementationOnce(() =>
        Promise.resolve(
          withControllerVersion({
            acquired: false,
            action: 'type in the terminal',
            controllerId: 'peer-client',
            taskId: 'task-1',
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          withControllerVersion({
            acquired: true,
            action: 'type in the terminal',
            controllerId: 'client-self',
            taskId: 'task-1',
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          withControllerVersion({
            action: null,
            controllerId: null,
            taskId: 'task-1',
          }),
        ),
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
      ownerId: 'runtime-owner-self',
      takeover: true,
      taskId: 'task-1',
    });

    await session.release();
    session.cleanup();
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
      ownerId: 'runtime-owner-self',
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

    await respondToIncomingTaskCommandTakeover('request-2', false);
  });
});
