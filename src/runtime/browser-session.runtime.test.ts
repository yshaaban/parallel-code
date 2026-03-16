import { IPC } from '../../electron/ipc/channels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  browserAuthenticatedListenerRef,
  browserHttpStateListenerRef,
  browserTransportListenerRef,
  invokeMock,
  listenSaveAppStateMock,
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
  listenSaveAppStateMock: vi.fn(() => () => {}),
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
  listenSaveAppState: listenSaveAppStateMock,
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

describe('browser runtime restore generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserAuthenticatedListenerRef.current = null;
    browserHttpStateListenerRef.current = null;
    browserTransportListenerRef.current = null;
    invokeMock.mockResolvedValue({
      appStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      runningAgentIds: ['agent-1'],
    });
    serverMessageListeners.clear();
  });

  afterEach(() => {
    browserAuthenticatedListenerRef.current = null;
    browserHttpStateListenerRef.current = null;
    browserTransportListenerRef.current = null;
    serverMessageListeners.clear();
  });

  it('ignores stale restore completion after a newer disconnect', async () => {
    const syncDeferred = createDeferred<undefined>();
    const syncBrowserStateFromReconnectSnapshot = vi.fn(() => syncDeferred.promise);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const clearRestoringConnectionBanner = vi.fn();

    const cleanup = registerBrowserAppRuntime({
      clearRestoringConnectionBanner,
      onAgentLifecycle: vi.fn(),
      onGitStatusChanged: vi.fn(),
      onServerStateBootstrap: vi.fn(),
      onTaskPortsChanged: vi.fn(),
      onRemoteStatus: vi.fn(),
      reconcileRunningAgentIds,
      scheduleBrowserStateSync: vi.fn(),
      setConnectionBanner: vi.fn(),
      showNotification: vi.fn(),
      syncAgentStatusesFromServer: vi.fn(),
      syncBrowserStateFromReconnectSnapshot,
    });

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

    const cleanup = registerBrowserAppRuntime({
      clearRestoringConnectionBanner,
      onAgentLifecycle: vi.fn(),
      onGitStatusChanged: vi.fn(),
      onServerStateBootstrap: vi.fn(),
      onTaskPortsChanged: vi.fn(),
      onRemoteStatus: vi.fn(),
      reconcileRunningAgentIds,
      scheduleBrowserStateSync: vi.fn(),
      setConnectionBanner: vi.fn(),
      showNotification: vi.fn(),
      syncAgentStatusesFromServer: vi.fn(),
      syncBrowserStateFromReconnectSnapshot,
    });

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
    const onTaskPortsChanged = vi.fn();
    const onRemoteStatus = vi.fn();
    const syncAgentStatusesFromServer = vi.fn();
    const clearRestoringConnectionBanner = vi.fn();

    const cleanup = registerBrowserAppRuntime({
      clearRestoringConnectionBanner,
      onAgentLifecycle: vi.fn(),
      onGitStatusChanged,
      onServerStateBootstrap,
      onTaskPortsChanged,
      onRemoteStatus,
      reconcileRunningAgentIds,
      scheduleBrowserStateSync: vi.fn(),
      setConnectionBanner: vi.fn(),
      showNotification: vi.fn(),
      syncAgentStatusesFromServer,
      syncBrowserStateFromReconnectSnapshot,
    });

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
    await vi.waitFor(() => {
      expect(reconcileRunningAgentIds).toHaveBeenCalledWith(['agent-1'], true);
    });

    expect(clearRestoringConnectionBanner).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('remains stable across repeated reconnect and restore cycles', async () => {
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const clearRestoringConnectionBanner = vi.fn();

    const cleanup = registerBrowserAppRuntime({
      clearRestoringConnectionBanner,
      onAgentLifecycle: vi.fn(),
      onGitStatusChanged: vi.fn(),
      onServerStateBootstrap: vi.fn(),
      onTaskPortsChanged: vi.fn(),
      onRemoteStatus: vi.fn(),
      reconcileRunningAgentIds,
      scheduleBrowserStateSync: vi.fn(),
      setConnectionBanner: vi.fn(),
      showNotification: vi.fn(),
      syncAgentStatusesFromServer: vi.fn(),
      syncBrowserStateFromReconnectSnapshot,
    });

    for (let index = 0; index < 10; index += 1) {
      browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
      browserTransportListenerRef.current?.({ kind: 'connection', state: 'reconnecting' });
      browserTransportListenerRef.current?.({ kind: 'connection', state: 'connected' });
      browserAuthenticatedListenerRef.current?.();
      await vi.waitFor(() => {
        expect(reconcileRunningAgentIds).toHaveBeenCalledTimes(index + 1);
      });
      expect(invokeMock).toHaveBeenCalledTimes(index + 1);
      expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(index + 1);
    }

    cleanup();
  });

  it('waits for authenticated control traffic before starting a reconnect restore', async () => {
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime({
      clearRestoringConnectionBanner: vi.fn(),
      onAgentLifecycle: vi.fn(),
      onGitStatusChanged: vi.fn(),
      onServerStateBootstrap: vi.fn(),
      onTaskPortsChanged: vi.fn(),
      onRemoteStatus: vi.fn(),
      reconcileRunningAgentIds,
      scheduleBrowserStateSync: vi.fn(),
      setConnectionBanner: vi.fn(),
      showNotification: vi.fn(),
      syncAgentStatusesFromServer: vi.fn(),
      syncBrowserStateFromReconnectSnapshot,
    });

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
});
