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

const browserPagehideState = vi.hoisted(() => ({
  pending: false,
}));

const {
  browserTransportListeners,
  isElectronRuntimeMock,
  onBrowserTransportEventMock,
  sendConnectedBrowserControlMessageMock,
  sendPagehideInvokeMock,
  sendImmediateBrowserControlMessageMock,
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
  sendConnectedBrowserControlMessageMock: vi.fn(),
  sendPagehideInvokeMock: vi.fn(),
  sendImmediateBrowserControlMessageMock: vi.fn(),
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

    if (
      args.length === 4 &&
      typeof args[0] === 'string' &&
      typeof args[1] === 'string' &&
      typeof args[2] === 'string'
    ) {
      const storeKey = args[0] as keyof typeof storeState;
      const record = storeState[storeKey] as Record<string, Record<string, unknown>>;
      const entry = record[args[1]];
      if (!entry) {
        throw new Error(`Missing nested setStore entry: ${JSON.stringify(args)}`);
      }

      entry[args[2]] = args[3];
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
  sendBrowserControlMessage: sendConnectedBrowserControlMessageMock,
  sendPagehideInvoke: sendPagehideInvokeMock,
  sendImmediateBrowserControlMessage: sendImmediateBrowserControlMessageMock,
}));

vi.mock('../lib/browser-pagehide', () => ({
  isBrowserPagehidePending: () => browserPagehideState.pending,
  ensureBrowserPagehideTracking: vi.fn(),
  resetBrowserPagehideStateForTests: () => {
    browserPagehideState.pending = false;
  },
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
type TaskCommandLeaseRuntimeModule = typeof import('./task-command-lease-runtime');
type TaskCommandLeaseModule = typeof import('./task-command-lease');

let applyTaskCommandControllerChanged: TaskCommandControllersModule['applyTaskCommandControllerChanged'];
let assertTaskCommandControllerStateCleanForTests: TaskCommandControllersModule['assertTaskCommandControllerStateCleanForTests'];
let replaceTaskCommandControllers: TaskCommandControllersModule['replaceTaskCommandControllers'];
let resetTaskCommandControllerStateForTests: TaskCommandControllersModule['resetTaskCommandControllerStateForTests'];
let releaseTaskCommandLeaseHold: TaskCommandLeaseRuntimeModule['releaseTaskCommandLeaseHold'];
let retainTaskCommandLease: TaskCommandLeaseRuntimeModule['retainTaskCommandLease'];
let clearRemovedTaskCommandLeaseState: TaskCommandLeaseRuntimeModule['clearRemovedTaskCommandLeaseState'];
let assertTaskCommandLeaseStateCleanForTests: TaskCommandLeaseModule['assertTaskCommandLeaseStateCleanForTests'];
let TASK_COMMAND_LEASE_SKIPPED: TaskCommandLeaseModule['TASK_COMMAND_LEASE_SKIPPED'];
let createTaskCommandLeaseSession: TaskCommandLeaseModule['createTaskCommandLeaseSession'];
let expireIncomingTaskCommandTakeoverRequest: TaskCommandLeaseModule['expireIncomingTaskCommandTakeoverRequest'];
let handleIncomingTaskCommandTakeoverRequest: TaskCommandLeaseModule['handleIncomingTaskCommandTakeoverRequest'];
let handleTaskCommandTakeoverResult: TaskCommandLeaseModule['handleTaskCommandTakeoverResult'];
let resetTaskCommandLeaseStateForTests: TaskCommandLeaseModule['resetTaskCommandLeaseStateForTests'];
let respondToIncomingTaskCommandTakeover: TaskCommandLeaseModule['respondToIncomingTaskCommandTakeover'];
let runWithAgentTaskCommandLease: TaskCommandLeaseModule['runWithAgentTaskCommandLease'];
let runWithTaskCommandLease: TaskCommandLeaseModule['runWithTaskCommandLease'];
let syncFocusedTypingTaskCommandLease: TaskCommandLeaseModule['syncFocusedTypingTaskCommandLease'];

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

function emitBrowserPagehide(): void {
  browserPagehideState.pending = true;
}

function resetBrowserPagehideState(): void {
  browserPagehideState.pending = false;
}

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

describe('task command lease helper', () => {
  beforeEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.resetModules();
    resetBrowserPagehideState();
    taskCommandControllerVersion = 0;
    taskCommandLeaseGeneration = 0;
    const taskCommandControllersModule = await import('../store/task-command-controllers');
    const taskCommandLeaseRuntimeModule = await import('./task-command-lease-runtime');
    const taskCommandLeaseModule = await import('./task-command-lease');
    applyTaskCommandControllerChanged =
      taskCommandControllersModule.applyTaskCommandControllerChanged;
    assertTaskCommandControllerStateCleanForTests =
      taskCommandControllersModule.assertTaskCommandControllerStateCleanForTests;
    replaceTaskCommandControllers = taskCommandControllersModule.replaceTaskCommandControllers;
    resetTaskCommandControllerStateForTests =
      taskCommandControllersModule.resetTaskCommandControllerStateForTests;
    releaseTaskCommandLeaseHold = taskCommandLeaseRuntimeModule.releaseTaskCommandLeaseHold;
    retainTaskCommandLease = taskCommandLeaseRuntimeModule.retainTaskCommandLease;
    clearRemovedTaskCommandLeaseState =
      taskCommandLeaseRuntimeModule.clearRemovedTaskCommandLeaseState;
    assertTaskCommandLeaseStateCleanForTests =
      taskCommandLeaseModule.assertTaskCommandLeaseStateCleanForTests;
    TASK_COMMAND_LEASE_SKIPPED = taskCommandLeaseModule.TASK_COMMAND_LEASE_SKIPPED;
    createTaskCommandLeaseSession = taskCommandLeaseModule.createTaskCommandLeaseSession;
    expireIncomingTaskCommandTakeoverRequest =
      taskCommandLeaseModule.expireIncomingTaskCommandTakeoverRequest;
    handleIncomingTaskCommandTakeoverRequest =
      taskCommandLeaseModule.handleIncomingTaskCommandTakeoverRequest;
    handleTaskCommandTakeoverResult = taskCommandLeaseModule.handleTaskCommandTakeoverResult;
    resetTaskCommandLeaseStateForTests = taskCommandLeaseModule.resetTaskCommandLeaseStateForTests;
    respondToIncomingTaskCommandTakeover =
      taskCommandLeaseModule.respondToIncomingTaskCommandTakeover;
    runWithAgentTaskCommandLease = taskCommandLeaseModule.runWithAgentTaskCommandLease;
    runWithTaskCommandLease = taskCommandLeaseModule.runWithTaskCommandLease;
    syncFocusedTypingTaskCommandLease = taskCommandLeaseModule.syncFocusedTypingTaskCommandLease;
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
    sendConnectedBrowserControlMessageMock.mockReset();
    sendConnectedBrowserControlMessageMock.mockResolvedValue(undefined);
    sendImmediateBrowserControlMessageMock.mockReset();
    sendImmediateBrowserControlMessageMock.mockResolvedValue(undefined);
    sendPagehideInvokeMock.mockReset();
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
      resetBrowserPagehideState();
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

  it('does not spend a pending command hold twice when typing focus leaves and its view unmounts', async () => {
    const refresh = createDeferred<undefined>();
    const work = createDeferred<string>();
    invokeMock.mockImplementation(
      async (channel: IPC, args: { taskId: string; action?: string }) => {
        if (channel === IPC.AcquireTaskCommandLease) {
          if (args.action === 'collapse this task') await refresh.promise;
          return withControllerVersion({
            acquired: true,
            action: args.action ?? '',
            controllerId: 'client-self',
            taskId: args.taskId,
          });
        }
        if (channel === IPC.ReleaseTaskCommandLease)
          return withControllerVersion({ action: null, controllerId: null, taskId: args.taskId });
        throw new Error(`Unexpected IPC channel: ${channel}`);
      },
    );
    const typing = createTaskCommandLeaseSession('task-1', 'type in the terminal');
    await typing.acquire();
    const run = vi.fn(() => work.promise);
    const command = runWithTaskCommandLease('task-1', 'collapse this task', run);
    await Promise.resolve();
    syncFocusedTypingTaskCommandLease('task-2', 'ai-terminal');
    typing.cleanup();
    await vi.advanceTimersByTimeAsync(250);
    const earlyReleases = invokeMock.mock.calls.filter(
      ([channel]) => channel === IPC.ReleaseTaskCommandLease,
    ).length;
    refresh.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    work.resolve('done');
    await expect(command).resolves.toBe('done');
    expect(earlyReleases).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    'shares one command and typing epoch (typing acquire pending first: %s)',
    async (typingFirst) => {
      const backend = await import('../../electron/ipc/task-command-leases');
      const runtime = await import('./task-command-lease-runtime');
      backend.resetTaskCommandLeasesForTest();
      const started = createDeferred<undefined>();
      const acquireStarted = createDeferred<undefined>();
      const acquireGate = createDeferred<undefined>();
      const work = createDeferred<boolean>();
      invokeMock.mockImplementation(
        async (
          channel: IPC,
          args: {
            taskId: string;
            clientId: string;
            ownerId: string;
            action: string;
            leaseGeneration?: number;
          },
        ) => {
          if (channel === IPC.AcquireTaskCommandLease) {
            if (typingFirst && args.action === 'type in the terminal') {
              acquireStarted.resolve(undefined);
              await acquireGate.promise;
            }
            return backend.acquireTaskCommandLease(
              args.taskId,
              args.clientId,
              args.ownerId,
              args.action,
            );
          }
          if (channel === IPC.ReleaseTaskCommandLease) {
            return backend.releaseTaskCommandLease(
              args.taskId,
              args.clientId,
              args.ownerId,
              Date.now(),
              args.leaseGeneration,
            ).snapshot;
          }
          throw new Error(`Unexpected IPC channel: ${channel}`);
        },
      );
      const typing = createTaskCommandLeaseSession('task-1', 'type in the terminal');
      const pendingTypingAcquire = typingFirst ? typing.acquire() : null;
      if (typingFirst) {
        await acquireStarted.promise;
      }
      let commandGeneration: number | null = null;
      const command = runWithTaskCommandLease('task-1', 'collapse this task', async () => {
        commandGeneration = runtime.getRetainedTaskCommandLeaseGeneration('task-1');
        started.resolve(undefined);
        return work.promise;
      });
      if (!typingFirst) {
        await started.promise;
      }
      const typingAcquire = pendingTypingAcquire ?? typing.acquire();
      acquireGate.resolve(undefined);
      await started.promise;
      await expect(typingAcquire).resolves.toBe(true);
      work.resolve(
        commandGeneration !== null &&
          backend.isTaskCommandLeaseGenerationHeld(
            'task-1',
            'client-self',
            'runtime-owner-self',
            commandGeneration,
          ),
      );
      const stillAdmitted = await command;
      expect(
        invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
      ).toHaveLength(0);
      await typing.release();
      typing.cleanup();
      await Promise.resolve();
      backend.resetTaskCommandLeasesForTest();
      expect(stillAdmitted).toBe(true);
      expect(
        invokeMock.mock.calls.filter(([channel]) => channel === IPC.AcquireTaskCommandLease),
      ).toHaveLength(1);
      expect(
        invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
      ).toHaveLength(1);
    },
  );

  it('keeps a new command generation when an older typing release reaches the backend late', async () => {
    const backend = await import('../../electron/ipc/task-command-leases');
    const runtime = await import('./task-command-lease-runtime');
    backend.resetTaskCommandLeasesForTest();
    const releaseGate = createDeferred<undefined>();
    const started = createDeferred<undefined>();
    const work = createDeferred<boolean>();
    let releaseCount = 0;
    invokeMock.mockImplementation(
      async (
        channel: IPC,
        args: {
          taskId: string;
          clientId: string;
          ownerId: string;
          action: string;
          leaseGeneration?: number;
        },
      ) => {
        if (channel === IPC.AcquireTaskCommandLease) {
          return backend.acquireTaskCommandLease(
            args.taskId,
            args.clientId,
            args.ownerId,
            args.action,
          );
        }
        if (channel === IPC.ReleaseTaskCommandLease) {
          if (++releaseCount === 1) await releaseGate.promise;
          return backend.releaseTaskCommandLease(
            args.taskId,
            args.clientId,
            args.ownerId,
            Date.now(),
            args.leaseGeneration,
          ).snapshot;
        }
        throw new Error(`Unexpected IPC channel: ${channel}`);
      },
    );
    const typing = createTaskCommandLeaseSession('task-1', 'type in the terminal');
    await typing.acquire();
    const released = typing.release();
    let commandGeneration: number | null = null;
    const command = runWithTaskCommandLease('task-1', 'collapse this task', async () => {
      commandGeneration = runtime.getRetainedTaskCommandLeaseGeneration('task-1');
      started.resolve(undefined);
      return work.promise;
    });
    await started.promise;
    releaseGate.resolve(undefined);
    await released;
    work.resolve(
      commandGeneration !== null &&
        backend.isTaskCommandLeaseGenerationHeld(
          'task-1',
          'client-self',
          'runtime-owner-self',
          commandGeneration,
        ),
    );
    await expect(command).resolves.toBe(true);
    typing.cleanup();
    await Promise.resolve();
    backend.resetTaskCommandLeasesForTest();
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
    sendImmediateBrowserControlMessageMock.mockImplementationOnce(async (message) => {
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
    expect(sendImmediateBrowserControlMessageMock).toHaveBeenCalledWith({
      action: 'send a prompt',
      requestId: expect.any(String),
      requesterOwnerId: 'runtime-owner-self',
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
    sendImmediateBrowserControlMessageMock.mockImplementationOnce(async (message) => {
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

  it('keeps local lease ownership when backend release fails and retries without reacquiring', async () => {
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
          return Promise.reject(new Error('release failed'));
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

    await expect(retainTaskCommandLease('task-1', 'send a prompt')).resolves.toBe(true);
    await expect(releaseTaskCommandLeaseHold('task-1')).resolves.toBe(false);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.AcquireTaskCommandLease),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls[1]?.[1] as {
        clientId?: string;
        leaseGeneration?: number;
        ownerId?: string;
        taskId?: string;
      },
    ).toMatchObject({
      clientId: 'client-self',
      leaseGeneration: expect.any(Number),
      ownerId: 'runtime-owner-self',
      taskId: 'task-1',
    });

    await expect(retainTaskCommandLease('task-1', 'send a prompt')).resolves.toBe(true);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.AcquireTaskCommandLease),
    ).toHaveLength(1);

    resetTaskCommandLeaseStateForTests();
    resetTaskCommandControllerStateForTests();
  });

  it('does not resurrect a removed task lease when backend release fails after cleanup starts', async () => {
    let releaseCount = 0;
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
          releaseCount += 1;
          if (releaseCount === 1) {
            return Promise.reject(new Error('release failed'));
          }

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

    await expect(retainTaskCommandLease('task-1', 'send a prompt')).resolves.toBe(true);
    await clearRemovedTaskCommandLeaseState('task-1');

    await vi.advanceTimersByTimeAsync(5_000);

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.RenewTaskCommandLease),
    ).toHaveLength(0);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(1);

    await expect(retainTaskCommandLease('task-1', 'send a prompt')).resolves.toBe(true);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.AcquireTaskCommandLease),
    ).toHaveLength(2);
    await expect(releaseTaskCommandLeaseHold('task-1')).resolves.toBe(true);
  });

  it('surfaces backend release failures from one-shot lease work', async () => {
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
          return Promise.reject(new Error('release failed'));
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

    await expect(
      runWithTaskCommandLease('task-1', 'send a prompt', async () => 'done'),
    ).rejects.toThrow('Failed to release task command lease for task-1');
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.AcquireTaskCommandLease),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(1);

    resetTaskCommandLeaseStateForTests();
    resetTaskCommandControllerStateForTests();
  });

  it('keeps the newer lease epoch when a stale release settles after task-id reuse', async () => {
    const staleRelease = createDeferred<{
      action: string | null;
      controllerId: string | null;
      leaseGeneration: number;
      taskId: string;
      version: number;
    }>();
    let releaseCount = 0;

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
          releaseCount += 1;
          if (releaseCount === 1) {
            return staleRelease.promise;
          }

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

    await expect(retainTaskCommandLease('task-1', 'send a prompt')).resolves.toBe(true);

    const staleReleasePromise = releaseTaskCommandLeaseHold('task-1');
    await Promise.resolve();

    await expect(retainTaskCommandLease('task-1', 'send a prompt')).resolves.toBe(true);
    staleRelease.resolve(
      withControllerVersion({
        action: 'send a prompt',
        controllerId: 'client-self',
        taskId: 'task-1',
      }),
    );

    await expect(staleReleasePromise).resolves.toBe(false);
    await expect(releaseTaskCommandLeaseHold('task-1')).resolves.toBe(true);

    const releaseCalls = invokeMock.mock.calls.filter(
      ([channel]) => channel === IPC.ReleaseTaskCommandLease,
    );
    expect(releaseCalls).toHaveLength(2);
    expect(releaseCalls[0]?.[1]).toMatchObject({
      leaseGeneration: 1,
      taskId: 'task-1',
    });
    expect(releaseCalls[1]?.[1]).toMatchObject({
      leaseGeneration: 2,
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

  it('preserves a retained session lease across a transient session remount cleanup', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });

    await expect(session.acquire()).resolves.toBe(true);
    session.cleanup();

    await vi.advanceTimersByTimeAsync(200);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);

    const remountedSession = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });

    await expect(remountedSession.acquire()).resolves.toBe(true);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.AcquireTaskCommandLease),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);

    await remountedSession.release();
    remountedSession.cleanup();
  });

  it('keeps focused typing lease touch callbacks active when a session remount races shared-session finalization', async () => {
    const releaseDeferred = createDeferred<boolean>();
    invokeMock.mockImplementation((channel: IPC, args?: { taskId?: string }) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args?.taskId ?? 'task-1',
            }),
          );
        case IPC.ReleaseTaskCommandLease:
          return releaseDeferred.promise.then(() =>
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: args?.taskId ?? 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              renewed: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args?.taskId ?? 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });
    await expect(session.acquire()).resolves.toBe(true);
    session.cleanup();

    await vi.advanceTimersByTimeAsync(250);

    const remountedSession = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });
    await expect(remountedSession.acquire()).resolves.toBe(true);

    invokeMock.mockClear();
    syncFocusedTypingTaskCommandLease('task-1', 'terminal');
    await vi.advanceTimersByTimeAsync(1_100);

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);

    releaseDeferred.resolve(true);
    await Promise.resolve();
    await remountedSession.release();
    remountedSession.cleanup();
  });

  it('releases a retained session after the last handle cleanup grace elapses', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 60_000,
    });

    await expect(session.acquire()).resolves.toBe(true);
    session.cleanup();

    await vi.advanceTimersByTimeAsync(249);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(1);
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
    expect(sendImmediateBrowserControlMessageMock).not.toHaveBeenCalled();

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

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);

    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-client',
      taskId: 'task-1',
      version: 2,
    });
    await Promise.resolve();

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);
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

  it('recovers retained session ownership cleanly across repeated reconnect churn', async () => {
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });

    for (const _cycle of [1, 2, 3]) {
      await expect(session.acquire()).resolves.toBe(true);
      emitBrowserTransportState('reconnecting');
      await Promise.resolve();

      expect(session.touch()).toBe(false);
      expect(
        invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
      ).toHaveLength(0);

      emitBrowserTransportState('connected');
      await Promise.resolve();

      await expect(session.acquire()).resolves.toBe(true);
      expect(session.touch()).toBe(true);
    }

    await session.release();
    session.cleanup();
  });

  it('releases the exact backend lease generation if the control plane disconnects before acquire resolves', async () => {
    const acquireDeferred = createDeferred<{
      acquired: boolean;
      action: string;
      controllerId: string;
      leaseGeneration: number;
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
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.find(([channel]) => channel === IPC.ReleaseTaskCommandLease)?.[1],
    ).toMatchObject({
      clientId: 'client-self',
      leaseGeneration: 1,
      ownerId: 'runtime-owner-self',
      taskId: 'task-1',
    });
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
    sendImmediateBrowserControlMessageMock.mockImplementationOnce(async () => {
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
    sendImmediateBrowserControlMessageMock.mockImplementationOnce(async (message) => {
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

  it('escalates an explicit takeover above a weaker in-flight acquire attempt', async () => {
    const initialAcquireDeferred = createDeferred<{
      acquired: boolean;
      action: string;
      controllerId: string;
      leaseGeneration: number;
      taskId: string;
      version: number;
    }>();

    invokeMock
      .mockImplementationOnce(() => initialAcquireDeferred.promise)
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
    sendImmediateBrowserControlMessageMock.mockImplementationOnce(async (message) => {
      if (message.type !== 'request-task-command-takeover') {
        return;
      }

      queueMicrotask(() => {
        handleTaskCommandTakeoverResult({
          decision: 'approved',
          requestId: message.requestId,
          taskId: message.taskId,
          type: 'task-command-takeover-result',
        });
      });
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      confirmTakeover: false,
    });

    const acquirePromise = session.acquire();
    const takeOverPromise = session.takeOver();

    initialAcquireDeferred.resolve(
      withControllerVersion({
        acquired: false,
        action: 'type in the terminal',
        controllerId: 'peer-client',
        taskId: 'task-1',
      }),
    );

    await expect(acquirePromise).resolves.toBe(false);
    await expect(takeOverPromise).resolves.toBe(true);
    expect(sendImmediateBrowserControlMessageMock).toHaveBeenCalledTimes(1);
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.AcquireTaskCommandLease),
    ).toHaveLength(3);
    expect(invokeMock).toHaveBeenNthCalledWith(3, IPC.AcquireTaskCommandLease, {
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

    await expect(respondToIncomingTaskCommandTakeover('request-1', true)).resolves.toBe(true);

    expect(sendConnectedBrowserControlMessageMock).toHaveBeenCalledWith({
      approved: true,
      requestId: 'request-1',
      type: 'respond-task-command-takeover',
    });
    expect(Object.keys(storeState.incomingTaskTakeoverRequests)).toEqual(['request-2']);

    handleTaskCommandTakeoverResult({
      decision: 'approved',
      requestId: 'request-1',
      taskId: 'task-1',
      type: 'task-command-takeover-result',
    });

    expect(storeState.incomingTaskTakeoverRequests).toEqual({
      'request-2': expect.objectContaining({
        requestId: 'request-2',
        taskId: 'task-1',
      }),
    });

    await expect(respondToIncomingTaskCommandTakeover('request-2', false)).resolves.toBe(true);
    expect(storeState.incomingTaskTakeoverRequests).toEqual({});

    handleTaskCommandTakeoverResult({
      decision: 'denied',
      requestId: 'request-2',
      taskId: 'task-1',
      type: 'task-command-takeover-result',
    });
  });

  it('sends takeover responses through the connected browser control path', async () => {
    handleIncomingTaskCommandTakeoverRequest({
      action: 'type in the terminal',
      expiresAt: 10_000,
      requestId: 'request-connected',
      requesterClientId: 'peer-a',
      requesterDisplayName: 'Peer A',
      taskId: 'task-1',
      type: 'task-command-takeover-request',
    });

    await expect(respondToIncomingTaskCommandTakeover('request-connected', true)).resolves.toBe(
      true,
    );

    expect(sendConnectedBrowserControlMessageMock).toHaveBeenCalledWith({
      approved: true,
      requestId: 'request-connected',
      type: 'respond-task-command-takeover',
    });
    expect(sendImmediateBrowserControlMessageMock).not.toHaveBeenCalled();
    expect(storeState.incomingTaskTakeoverRequests).toEqual({});

    handleTaskCommandTakeoverResult({
      decision: 'approved',
      requestId: 'request-connected',
      taskId: 'task-1',
      type: 'task-command-takeover-result',
    });
  });

  it('cancels a queued controller refresh when task-command lease state resets', async () => {
    invokeMock.mockClear();

    handleTaskCommandTakeoverResult({
      decision: 'approved',
      requestId: 'request-reset',
      taskId: 'task-1',
      type: 'task-command-takeover-result',
    });
    resetTaskCommandLeaseStateForTests();

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.GetTaskCommandControllers),
    ).toHaveLength(0);
  });

  it('keeps an incoming takeover request visible when sending a response fails', async () => {
    handleIncomingTaskCommandTakeoverRequest({
      action: 'type in the terminal',
      expiresAt: 10_000,
      requestId: 'request-1',
      requesterClientId: 'peer-a',
      requesterDisplayName: 'Peer A',
      taskId: 'task-1',
      type: 'task-command-takeover-request',
    });
    sendConnectedBrowserControlMessageMock.mockRejectedValueOnce(new Error('offline'));

    await expect(respondToIncomingTaskCommandTakeover('request-1', true)).resolves.toBe(false);

    expect(storeState.incomingTaskTakeoverRequests).toEqual({
      'request-1': expect.objectContaining({
        requestId: 'request-1',
        taskId: 'task-1',
      }),
    });

    expireIncomingTaskCommandTakeoverRequest('request-1');
  });

  it('clears incoming takeover requests through the lease cleanup path on expiry', () => {
    handleIncomingTaskCommandTakeoverRequest({
      action: 'type in the terminal',
      expiresAt: 10_000,
      requestId: 'request-1',
      requesterClientId: 'peer-a',
      requesterDisplayName: 'Peer A',
      taskId: 'task-1',
      type: 'task-command-takeover-request',
    });

    expireIncomingTaskCommandTakeoverRequest('request-1');

    expect(storeState.incomingTaskTakeoverRequests).toEqual({});
    expect(browserTransportListeners.size).toBe(0);
  });

  it('releases stale typing control immediately when focus leaves the terminal surface', async () => {
    invokeMock.mockImplementation((channel: IPC, args: { taskId?: string }) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args.taskId ?? 'task-1',
            }),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: args.taskId ?? 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              renewed: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args.taskId ?? 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal');
    await expect(session.acquire()).resolves.toBe(true);

    syncFocusedTypingTaskCommandLease('task-1', 'prompt');
    await Promise.resolve();
    await Promise.resolve();
    session.cleanup();
    await Promise.resolve();

    expect(
      invokeMock.mock.calls.filter(([channel, args]) => {
        return channel === IPC.ReleaseTaskCommandLease && args.taskId === 'task-1';
      }).length,
    ).toBe(1);
  });

  it('uses pagehide-safe backend release once unload has started', async () => {
    invokeMock.mockImplementation((channel: IPC, args: { taskId?: string }) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args.taskId ?? 'task-1',
            }),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: args.taskId ?? 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              renewed: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args.taskId ?? 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal');
    await expect(session.acquire()).resolves.toBe(true);
    invokeMock.mockClear();

    emitBrowserPagehide();
    session.cleanup();
    await Promise.resolve();

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(0);
    expect(sendPagehideInvokeMock).toHaveBeenCalledTimes(1);
    expect(sendPagehideInvokeMock).toHaveBeenCalledWith(IPC.ReleaseTaskCommandLease, {
      clientId: 'client-self',
      leaseGeneration: 1,
      ownerId: 'runtime-owner-self',
      taskId: 'task-1',
    });
  });

  it('keeps retained typing control when the focused surface is the main terminal panel', async () => {
    invokeMock.mockImplementation((channel: IPC, args: { taskId?: string }) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args.taskId ?? 'task-1',
            }),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: args.taskId ?? 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              renewed: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args.taskId ?? 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal');
    await expect(session.acquire()).resolves.toBe(true);

    syncFocusedTypingTaskCommandLease('task-1', 'terminal');
    await Promise.resolve();
    await Promise.resolve();

    expect(
      invokeMock.mock.calls.filter(([channel, args]) => {
        return channel === IPC.ReleaseTaskCommandLease && args.taskId === 'task-1';
      }).length,
    ).toBe(0);

    await session.release();
    session.cleanup();
    await Promise.resolve();
  });

  it('keeps retained typing control alive while the same terminal stays focused across idle windows', async () => {
    invokeMock.mockImplementation((channel: IPC, args: { taskId?: string }) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args.taskId ?? 'task-1',
            }),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: args.taskId ?? 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              renewed: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args.taskId ?? 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 1_000,
    });
    await expect(session.acquire()).resolves.toBe(true);
    invokeMock.mockClear();

    syncFocusedTypingTaskCommandLease('task-1', 'terminal');
    await vi.advanceTimersByTimeAsync(3_500);
    await Promise.resolve();
    await Promise.resolve();

    expect(
      invokeMock.mock.calls.filter(([channel, args]) => {
        return channel === IPC.ReleaseTaskCommandLease && args.taskId === 'task-1';
      }).length,
    ).toBe(0);

    await session.release();
    session.cleanup();
    await Promise.resolve();
  });

  it('releases retained typing control when focus moves to another task terminal', async () => {
    invokeMock.mockImplementation((channel: IPC, args: { taskId?: string }) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args.taskId ?? 'task-1',
            }),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: args.taskId ?? 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              renewed: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args.taskId ?? 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal');
    await expect(session.acquire()).resolves.toBe(true);

    syncFocusedTypingTaskCommandLease('task-2', 'ai-terminal');
    await Promise.resolve();
    await Promise.resolve();
    session.cleanup();
    await Promise.resolve();

    expect(
      invokeMock.mock.calls.filter(([channel, args]) => {
        return channel === IPC.ReleaseTaskCommandLease && args.taskId === 'task-1';
      }).length,
    ).toBe(1);
  });

  it('releases a retained session lease to the backend before invalidating the local session', async () => {
    invokeMock.mockImplementation((channel: IPC, args: { taskId?: string }) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args.taskId ?? 'task-1',
            }),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: args.taskId ?? 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              renewed: true,
              action: 'type in the terminal',
              controllerId: 'client-self',
              taskId: args.taskId ?? 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 60_000,
    });

    await expect(session.acquire()).resolves.toBe(true);
    expect(session.touch()).toBe(true);
    await expect(clearRemovedTaskCommandLeaseState('task-1')).resolves.toBe(true);
    expect(session.touch()).toBe(false);

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.ReleaseTaskCommandLease,
      expect.objectContaining({ taskId: 'task-1' }),
    );

    session.cleanup();
  });

  it('retires overlapping removed holds without spending a replacement or sibling lease', async () => {
    const backend = await import('../../electron/ipc/task-command-leases');
    const runtime = await import('./task-command-lease-runtime');
    backend.resetTaskCommandLeasesForTest();
    const started = createDeferred<undefined>();
    const work = createDeferred<string>();
    const releaseStarted = createDeferred<undefined>();
    const releaseGate = createDeferred<undefined>();
    let releases = 0;
    invokeMock.mockImplementation(async (channel, args) => {
      if (channel === IPC.AcquireTaskCommandLease) {
        return backend.acquireTaskCommandLease(
          args.taskId,
          args.clientId,
          args.ownerId,
          args.action,
        );
      }
      if (channel === IPC.ReleaseTaskCommandLease) {
        if (++releases === 1) {
          releaseStarted.resolve(undefined);
          await releaseGate.promise;
        }
        return backend.releaseTaskCommandLease(
          args.taskId,
          args.clientId,
          args.ownerId,
          Date.now(),
          args.leaseGeneration,
        ).snapshot;
      }
      throw new Error(`Unexpected IPC channel: ${channel}`);
    });
    const command = runWithTaskCommandLease('task-1', 'open a terminal', async () => {
      started.resolve(undefined);
      return work.promise;
    });
    await started.promise;
    const typing = createTaskCommandLeaseSession('task-1', 'type in the terminal');
    const sibling = createTaskCommandLeaseSession('task-2', 'type in the terminal');
    await expect(typing.acquire()).resolves.toBe(true);
    await expect(sibling.acquire()).resolves.toBe(true);
    const removal = clearRemovedTaskCommandLeaseState('task-1');
    await releaseStarted.promise;
    expect(typing.touch()).toBe(false);
    await expect(typing.acquire()).resolves.toBe(true);
    const replacementGeneration = runtime.getRetainedTaskCommandLeaseGeneration('task-1');
    work.resolve('done');
    await expect(command).resolves.toBe('done');
    releaseGate.resolve(undefined);
    await removal;
    expect(typing.touch()).toBe(true);
    expect(sibling.touch()).toBe(true);
    expect(
      backend.isTaskCommandLeaseGenerationHeld(
        'task-1',
        'client-self',
        'runtime-owner-self',
        replacementGeneration ?? -1,
      ),
    ).toBe(true);
    expect(releases).toBe(1);
    await typing.release();
    await sibling.release();
    typing.cleanup();
    sibling.cleanup();
    expect(releases).toBe(3);
    backend.resetTaskCommandLeasesForTest();
  });

  it('releases a removed pending acquisition without running work or retaining renewal state', async () => {
    const backend = await import('../../electron/ipc/task-command-leases');
    const state = await import('./task-command-lease-runtime-state');
    backend.resetTaskCommandLeasesForTest();
    const acquireStarted = createDeferred<undefined>();
    const acquireGate = createDeferred<undefined>();
    invokeMock.mockImplementation(async (channel, args) => {
      if (channel === IPC.AcquireTaskCommandLease) {
        acquireStarted.resolve(undefined);
        await acquireGate.promise;
        return backend.acquireTaskCommandLease(
          args.taskId,
          args.clientId,
          args.ownerId,
          args.action,
        );
      }
      if (channel === IPC.ReleaseTaskCommandLease) {
        return backend.releaseTaskCommandLease(
          args.taskId,
          args.clientId,
          args.ownerId,
          Date.now(),
          args.leaseGeneration,
        ).snapshot;
      }
      throw new Error(`Unexpected IPC channel: ${channel}`);
    });
    const run = vi.fn().mockResolvedValue('must not run');
    const command = runWithTaskCommandLease('task-1', 'open a terminal', run);
    await acquireStarted.promise;
    const removal = clearRemovedTaskCommandLeaseState('task-1');
    acquireGate.resolve(undefined);
    await expect(command).resolves.toBe(TASK_COMMAND_LEASE_SKIPPED);
    await expect(removal).resolves.toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(backend.isTaskCommandLeaseHeld('task-1', 'client-self')).toBe(false);
    expect([...state.getLocalTaskCommandLeaseEntries()]).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(invokeMock.mock.calls.map(([channel]) => channel)).toEqual([
      IPC.AcquireTaskCommandLease,
      IPC.ReleaseTaskCommandLease,
    ]);
    backend.resetTaskCommandLeasesForTest();
  });

  it('revokes all overlapping holds when a removed task is not replaced', async () => {
    const state = await import('./task-command-lease-runtime-state');
    const started = createDeferred<undefined>();
    const work = createDeferred<string>();
    const command = runWithTaskCommandLease('task-1', 'open a terminal', async () => {
      started.resolve(undefined);
      return work.promise;
    });
    await started.promise;
    const typing = createTaskCommandLeaseSession('task-1', 'type in the terminal');
    await expect(typing.acquire()).resolves.toBe(true);
    await expect(clearRemovedTaskCommandLeaseState('task-1')).resolves.toBe(true);
    expect(typing.touch()).toBe(false);
    expect([...state.getLocalTaskCommandLeaseEntries()]).toEqual([]);
    work.resolve('done');
    await expect(command).resolves.toBe('done');
    await typing.release();
    typing.cleanup();
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.ReleaseTaskCommandLease),
    ).toHaveLength(1);
  });

  it.each(['renew', 'reclaim'] as const)(
    'ignores a delayed old %s result after removal and same-ID acquisition',
    async (kind) => {
      const runtime = await import('./task-command-lease-runtime');
      const oldResponse = createDeferred<ReturnType<typeof withControllerVersion>>();
      const old = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
        idleReleaseMs: 60_000,
      });
      await expect(old.acquire()).resolves.toBe(true);
      const oldGeneration = runtime.getRetainedTaskCommandLeaseGeneration('task-1');
      const response = withControllerVersion({
        acquired: true,
        renewed: true,
        action: 'type in the terminal',
        controllerId: 'client-self',
        taskId: 'task-1',
      });
      response.leaseGeneration = oldGeneration ?? -1;
      invokeMock.mockImplementationOnce(() => oldResponse.promise);
      if (kind === 'renew') await vi.advanceTimersByTimeAsync(5_000);
      else {
        emitBrowserTransportState('disconnected');
        emitBrowserTransportState('connected');
      }
      await expect(clearRemovedTaskCommandLeaseState('task-1')).resolves.toBe(true);
      await expect(old.acquire()).resolves.toBe(true);
      const replacementGeneration = runtime.getRetainedTaskCommandLeaseGeneration('task-1');
      expect(replacementGeneration).not.toBe(oldGeneration);
      oldResponse.resolve(response);
      await Promise.resolve();
      await Promise.resolve();
      expect(runtime.getRetainedTaskCommandLeaseGeneration('task-1')).toBe(replacementGeneration);
      expect(old.touch()).toBe(true);
      await old.release();
      old.cleanup();
    },
  );

  it('releases an acquisition completed after its last session handle was disposed', async () => {
    const acquireGate = createDeferred<ReturnType<typeof withControllerVersion>>();
    invokeMock.mockImplementationOnce(() => acquireGate.promise);
    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal');
    const acquire = session.acquire();
    await Promise.resolve();
    session.cleanup();
    acquireGate.resolve(
      withControllerVersion({
        acquired: true,
        action: 'type in the terminal',
        controllerId: 'client-self',
        taskId: 'task-1',
      }),
    );
    await expect(acquire).resolves.toBe(false);
    expect(invokeMock.mock.calls.map(([channel]) => channel)).toEqual([
      IPC.AcquireTaskCommandLease,
      IPC.ReleaseTaskCommandLease,
    ]);
  });
});
