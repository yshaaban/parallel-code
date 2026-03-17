import { IPC } from '../../electron/ipc/channels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  browserAuthenticatedListenerRef,
  browserHttpStateListenerRef,
  browserTransportListenerRef,
  invokeMock,
  taskCommandControllerListenerRef,
  listenTaskCommandControllerChangedMock,
  listenWorkspaceStateChangedMock,
  serverMessageListeners,
} = vi.hoisted(() => ({
  browserAuthenticatedListenerRef: {
    current: null as (() => void) | null,
  },
  browserHttpStateListenerRef: {
    current: null as ((state: 'available' | 'unreachable' | 'auth-expired') => void) | null,
  },
  browserTransportListenerRef: {
    current: null as
      | ((
          event:
            | {
                kind: 'connection';
                state:
                  | 'connecting'
                  | 'reconnecting'
                  | 'connected'
                  | 'disconnected'
                  | 'auth-expired';
              }
            | { kind: 'error'; message: string },
        ) => void)
      | null,
  },
  invokeMock: vi.fn(),
  taskCommandControllerListenerRef: {
    current: null as ((payload: unknown) => void) | null,
  },
  listenTaskCommandControllerChangedMock: vi.fn((listener: (payload: unknown) => void) => {
    taskCommandControllerListenerRef.current = listener;
    return () => {
      if (taskCommandControllerListenerRef.current === listener) {
        taskCommandControllerListenerRef.current = null;
      }
    };
  }),
  listenWorkspaceStateChangedMock: vi.fn(() => () => {}),
  serverMessageListeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('../lib/ipc', () => ({
  getBrowserQueueDepth: vi.fn(() => 0),
  invoke: invokeMock,
  listenServerMessage: vi.fn((type: string, listener: (payload: unknown) => void) => {
    serverMessageListeners.set(type, listener);
    return () => {
      serverMessageListeners.delete(type);
    };
  }),
  onBrowserAuthenticated: vi.fn((listener: () => void) => {
    browserAuthenticatedListenerRef.current = listener;
    return () => {
      browserAuthenticatedListenerRef.current = null;
    };
  }),
  onBrowserHttpStateChange: vi.fn(
    (listener: (state: 'available' | 'unreachable' | 'auth-expired') => void) => {
      browserHttpStateListenerRef.current = listener;
      return () => {
        browserHttpStateListenerRef.current = null;
      };
    },
  ),
  onBrowserTransportEvent: vi.fn(
    (
      listener: (
        event:
          | {
              kind: 'connection';
              state: 'connecting' | 'reconnecting' | 'connected' | 'disconnected' | 'auth-expired';
            }
          | { kind: 'error'; message: string },
      ) => void,
    ) => {
      browserTransportListenerRef.current = listener;
      return () => {
        browserTransportListenerRef.current = null;
      };
    },
  ),
}));

vi.mock('../lib/ipc-events', () => ({
  listenTaskCommandControllerChanged: listenTaskCommandControllerChangedMock,
  listenWorkspaceStateChanged: listenWorkspaceStateChangedMock,
}));

import { registerBrowserAppRuntime } from './browser-session';

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

async function flushResolvedPromises(iterations = 12): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function createBrowserRuntimeOptions(
  overrides: Partial<Parameters<typeof registerBrowserAppRuntime>[0]> = {},
): Parameters<typeof registerBrowserAppRuntime>[0] {
  return {
    clearRestoringConnectionBanner: vi.fn(),
    getTaskCommandControllerUpdateCount: vi.fn(() => 0),
    onAgentLifecycle: vi.fn(),
    onGitStatusChanged: vi.fn(),
    onPeerPresence: vi.fn(),
    onRemoteStatus: vi.fn(),
    onServerStateBootstrap: vi.fn(),
    onTaskCommandControllerChanged: vi.fn(),
    onTaskCommandTakeoverRequest: vi.fn(),
    onTaskCommandTakeoverResult: vi.fn(),
    onTaskPortsChanged: vi.fn(),
    reconcileRunningAgentIds: vi.fn().mockResolvedValue(undefined),
    replaceTaskCommandControllers: vi.fn(),
    scheduleBrowserStateSync: vi.fn(),
    setConnectionBanner: vi.fn(),
    showNotification: vi.fn(),
    syncAgentStatusesFromServer: vi.fn(),
    syncBrowserStateFromReconnectSnapshot: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('browser runtime restore generation', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    browserAuthenticatedListenerRef.current = null;
    browserHttpStateListenerRef.current = null;
    browserTransportListenerRef.current = null;
    taskCommandControllerListenerRef.current = null;
    invokeMock.mockResolvedValue({
      appStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      workspaceRevision: 0,
      workspaceStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      runningAgentIds: ['agent-1'],
    });
    serverMessageListeners.clear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    browserAuthenticatedListenerRef.current = null;
    browserHttpStateListenerRef.current = null;
    browserTransportListenerRef.current = null;
    taskCommandControllerListenerRef.current = null;
    serverMessageListeners.clear();
  });

  it('ignores stale restore completion after a newer disconnect', async () => {
    const syncDeferred = createDeferred<undefined>();
    const syncBrowserStateFromReconnectSnapshot = vi.fn(() => syncDeferred.promise);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const clearRestoringConnectionBanner = vi.fn();

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        clearRestoringConnectionBanner,
        reconcileRunningAgentIds,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'reconnecting' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'connected' });
    browserAuthenticatedListenerRef.current?.();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot);
    expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(1);

    browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await Promise.resolve();

    expect(reconcileRunningAgentIds).not.toHaveBeenCalled();
    expect(clearRestoringConnectionBanner).not.toHaveBeenCalled();

    cleanup();
  });

  it('invalidates an in-flight restore when auth expires', async () => {
    const syncDeferred = createDeferred<undefined>();
    const syncBrowserStateFromReconnectSnapshot = vi.fn(() => syncDeferred.promise);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const clearRestoringConnectionBanner = vi.fn();

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        clearRestoringConnectionBanner,
        reconcileRunningAgentIds,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'reconnecting' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'connected' });
    browserAuthenticatedListenerRef.current?.();
    browserHttpStateListenerRef.current?.('auth-expired');

    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await Promise.resolve();

    expect(reconcileRunningAgentIds).not.toHaveBeenCalled();
    expect(clearRestoringConnectionBanner).not.toHaveBeenCalled();

    cleanup();
  });

  it('forwards bootstrap and live server-owned updates while restore is in flight', async () => {
    const syncDeferred = createDeferred<undefined>();
    const syncBrowserStateFromReconnectSnapshot = vi.fn(() => syncDeferred.promise);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const onServerStateBootstrap = vi.fn();
    const onGitStatusChanged = vi.fn();
    const onTaskCommandControllerChanged = vi.fn();
    const onTaskPortsChanged = vi.fn();
    const onRemoteStatus = vi.fn();
    const replaceTaskCommandControllers = vi.fn();
    const syncAgentStatusesFromServer = vi.fn();
    const clearRestoringConnectionBanner = vi.fn();

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        clearRestoringConnectionBanner,
        onGitStatusChanged,
        onRemoteStatus,
        onServerStateBootstrap,
        onTaskCommandControllerChanged,
        onTaskPortsChanged,
        reconcileRunningAgentIds,
        replaceTaskCommandControllers,
        syncAgentStatusesFromServer,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'reconnecting' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'connected' });
    browserAuthenticatedListenerRef.current?.();

    serverMessageListeners.get('state-bootstrap')?.({
      snapshots: [
        {
          category: 'task-ports',
          mode: 'replace',
          payload: [],
          version: 1,
        },
        {
          category: 'task-review',
          mode: 'replace',
          payload: [],
          version: 1,
        },
      ],
    });
    serverMessageListeners.get('git-status-changed')?.({
      branchName: 'feature/task-1',
      worktreePath: '/tmp/task-1',
    });
    serverMessageListeners.get('task-ports-changed')?.({
      taskId: 'task-1',
      observed: [],
      exposed: [],
      updatedAt: 123,
    });
    serverMessageListeners.get('remote-status')?.({
      connectedClients: 2,
      peerClients: 1,
    });
    serverMessageListeners.get('agents')?.({
      list: [{ agentId: 'agent-1', status: 'running' }],
    });

    expect(onServerStateBootstrap).toHaveBeenCalledTimes(1);
    expect(onGitStatusChanged).toHaveBeenCalledWith({
      branchName: 'feature/task-1',
      worktreePath: '/tmp/task-1',
    });
    expect(onTaskPortsChanged).toHaveBeenCalledWith({
      taskId: 'task-1',
      observed: [],
      exposed: [],
      updatedAt: 123,
    });
    expect(onRemoteStatus).toHaveBeenCalledWith({
      connectedClients: 2,
      peerClients: 1,
    });
    expect(syncAgentStatusesFromServer).toHaveBeenCalledWith([
      { agentId: 'agent-1', status: 'running' },
    ]);

    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await flushResolvedPromises();

    expect(reconcileRunningAgentIds).toHaveBeenCalledWith(['agent-1'], true);

    expect(clearRestoringConnectionBanner).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('replaces task command controllers from the reconnect snapshot and forwards live controller changes', async () => {
    const onTaskCommandControllerChanged = vi.fn();
    const replaceTaskCommandControllers = vi.fn();
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);

    invokeMock.mockResolvedValueOnce({
      appStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      runningAgentIds: ['agent-1'],
      taskCommandControllers: [
        {
          action: 'merge this task',
          controllerId: 'client-a',
          taskId: 'task-1',
        },
      ],
      workspaceRevision: 2,
      workspaceStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
    });

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        onTaskCommandControllerChanged,
        reconcileRunningAgentIds,
        replaceTaskCommandControllers,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'reconnecting' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'connected' });
    browserAuthenticatedListenerRef.current?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(replaceTaskCommandControllers).toHaveBeenCalledWith([
      {
        action: 'merge this task',
        controllerId: 'client-a',
        taskId: 'task-1',
      },
    ]);

    taskCommandControllerListenerRef.current?.({
      action: 'push this task',
      controllerId: 'client-b',
      taskId: 'task-2',
    });

    expect(onTaskCommandControllerChanged).toHaveBeenCalledWith({
      action: 'push this task',
      controllerId: 'client-b',
      taskId: 'task-2',
    });

    cleanup();
  });

  it('does not overwrite live controller changes with a stale reconnect snapshot', async () => {
    const updateCountRef = { value: 0 };
    const syncDeferred = createDeferred<undefined>();
    const replaceTaskCommandControllers = vi.fn();

    invokeMock.mockResolvedValueOnce({
      appStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      runningAgentIds: ['agent-1'],
      taskCommandControllers: [
        {
          action: 'merge this task',
          controllerId: 'client-a',
          taskId: 'task-1',
        },
      ],
      workspaceRevision: 2,
      workspaceStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
    });

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        getTaskCommandControllerUpdateCount: vi.fn(() => updateCountRef.value),
        onTaskCommandControllerChanged: vi.fn(() => {
          updateCountRef.value += 1;
        }),
        replaceTaskCommandControllers,
        syncBrowserStateFromReconnectSnapshot: vi.fn(() => syncDeferred.promise),
      }),
    );

    browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'reconnecting' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'connected' });
    browserAuthenticatedListenerRef.current?.();
    await Promise.resolve();

    taskCommandControllerListenerRef.current?.({
      action: 'push this task',
      controllerId: 'client-b',
      taskId: 'task-2',
    });

    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await flushResolvedPromises();

    expect(replaceTaskCommandControllers).not.toHaveBeenCalled();

    cleanup();
  });

  it('remains stable across repeated reconnect and restore cycles', async () => {
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const clearRestoringConnectionBanner = vi.fn();

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        clearRestoringConnectionBanner,
        reconcileRunningAgentIds,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    for (let index = 0; index < 10; index += 1) {
      browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
      browserTransportListenerRef.current?.({ kind: 'connection', state: 'reconnecting' });
      browserTransportListenerRef.current?.({ kind: 'connection', state: 'connected' });
      browserAuthenticatedListenerRef.current?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(invokeMock).toHaveBeenCalledTimes(index + 1);
      expect(reconcileRunningAgentIds).toHaveBeenCalledTimes(index + 1);
      expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(index + 1);
    }

    cleanup();
  });

  it('waits for authenticated control traffic before starting a reconnect restore', async () => {
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        reconcileRunningAgentIds,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'reconnecting' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'connected' });
    await Promise.resolve();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(syncBrowserStateFromReconnectSnapshot).not.toHaveBeenCalled();
    expect(reconcileRunningAgentIds).not.toHaveBeenCalled();

    browserAuthenticatedListenerRef.current?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot);
    expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(1);
    expect(reconcileRunningAgentIds).toHaveBeenCalledWith(['agent-1'], true);

    cleanup();
  });

  it('forwards peer presence snapshots from the browser control plane', () => {
    const onPeerPresence = vi.fn();

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        onPeerPresence,
      }),
    );

    serverMessageListeners.get('peer-presences')?.({
      list: [
        {
          activeTaskId: 'task-1',
          clientId: 'client-a',
          controllingAgentIds: [],
          controllingTaskIds: ['task-1'],
          displayName: 'Ivan',
          focusedSurface: 'ai-terminal',
          lastSeenAt: 123,
          visibility: 'visible',
        },
      ],
    });

    expect(onPeerPresence).toHaveBeenCalledWith([
      {
        activeTaskId: 'task-1',
        clientId: 'client-a',
        controllingAgentIds: [],
        controllingTaskIds: ['task-1'],
        displayName: 'Ivan',
        focusedSurface: 'ai-terminal',
        lastSeenAt: 123,
        visibility: 'visible',
      },
    ]);

    cleanup();
  });

  it('forwards takeover request and result control messages', () => {
    const onTaskCommandTakeoverRequest = vi.fn();
    const onTaskCommandTakeoverResult = vi.fn();

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        onTaskCommandTakeoverRequest,
        onTaskCommandTakeoverResult,
      }),
    );

    serverMessageListeners.get('task-command-takeover-request')?.({
      action: 'type in the terminal',
      expiresAt: 456,
      requestId: 'request-1',
      requesterClientId: 'client-b',
      requesterDisplayName: 'Sara',
      taskId: 'task-1',
    });
    serverMessageListeners.get('task-command-takeover-result')?.({
      decision: 'approved',
      requestId: 'request-1',
      taskId: 'task-1',
    });

    expect(onTaskCommandTakeoverRequest).toHaveBeenCalledWith({
      action: 'type in the terminal',
      expiresAt: 456,
      requestId: 'request-1',
      requesterClientId: 'client-b',
      requesterDisplayName: 'Sara',
      taskId: 'task-1',
    });
    expect(onTaskCommandTakeoverResult).toHaveBeenCalledWith({
      decision: 'approved',
      requestId: 'request-1',
      taskId: 'task-1',
    });

    cleanup();
  });
});
