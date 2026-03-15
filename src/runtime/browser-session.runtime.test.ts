import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  browserAuthenticatedListenerRef,
  browserHttpStateListenerRef,
  browserTransportListenerRef,
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
  listenSaveAppStateMock: vi.fn(() => () => {}),
  serverMessageListeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('../lib/ipc', () => ({
  getBrowserQueueDepth: vi.fn(() => 0),
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
    const syncBrowserStateFromServer = vi.fn(() => syncDeferred.promise);
    const reconcileRunningAgents = vi.fn().mockResolvedValue(undefined);
    const clearRestoringConnectionBanner = vi.fn();

    const cleanup = registerBrowserAppRuntime({
      clearRestoringConnectionBanner,
      onAgentLifecycle: vi.fn(),
      onGitStatusChanged: vi.fn(),
      onServerStateBootstrap: vi.fn(),
      onTaskPortsChanged: vi.fn(),
      onRemoteStatus: vi.fn(),
      reconcileRunningAgents,
      scheduleBrowserStateSync: vi.fn(),
      setConnectionBanner: vi.fn(),
      showNotification: vi.fn(),
      syncAgentStatusesFromServer: vi.fn(),
      syncBrowserStateFromServer,
    });

    browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'reconnecting' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'connected' });
    browserAuthenticatedListenerRef.current?.();
    expect(syncBrowserStateFromServer).toHaveBeenCalledTimes(1);

    browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await Promise.resolve();

    expect(reconcileRunningAgents).not.toHaveBeenCalled();
    expect(clearRestoringConnectionBanner).not.toHaveBeenCalled();

    cleanup();
  });

  it('invalidates an in-flight restore when auth expires', async () => {
    const syncDeferred = createDeferred<undefined>();
    const syncBrowserStateFromServer = vi.fn(() => syncDeferred.promise);
    const reconcileRunningAgents = vi.fn().mockResolvedValue(undefined);
    const clearRestoringConnectionBanner = vi.fn();

    const cleanup = registerBrowserAppRuntime({
      clearRestoringConnectionBanner,
      onAgentLifecycle: vi.fn(),
      onGitStatusChanged: vi.fn(),
      onServerStateBootstrap: vi.fn(),
      onTaskPortsChanged: vi.fn(),
      onRemoteStatus: vi.fn(),
      reconcileRunningAgents,
      scheduleBrowserStateSync: vi.fn(),
      setConnectionBanner: vi.fn(),
      showNotification: vi.fn(),
      syncAgentStatusesFromServer: vi.fn(),
      syncBrowserStateFromServer,
    });

    browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'reconnecting' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'connected' });
    browserAuthenticatedListenerRef.current?.();
    browserHttpStateListenerRef.current?.('auth-expired');

    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await Promise.resolve();

    expect(reconcileRunningAgents).not.toHaveBeenCalled();
    expect(clearRestoringConnectionBanner).not.toHaveBeenCalled();

    cleanup();
  });

  it('forwards bootstrap and live server-owned updates while restore is in flight', async () => {
    const syncDeferred = createDeferred<undefined>();
    const syncBrowserStateFromServer = vi.fn(() => syncDeferred.promise);
    const reconcileRunningAgents = vi.fn().mockResolvedValue(undefined);
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
      reconcileRunningAgents,
      scheduleBrowserStateSync: vi.fn(),
      setConnectionBanner: vi.fn(),
      showNotification: vi.fn(),
      syncAgentStatusesFromServer,
      syncBrowserStateFromServer,
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
    await Promise.resolve();

    expect(reconcileRunningAgents).toHaveBeenCalledWith(true);
    expect(clearRestoringConnectionBanner).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('remains stable across repeated reconnect and restore cycles', async () => {
    const syncBrowserStateFromServer = vi.fn().mockResolvedValue(undefined);
    const reconcileRunningAgents = vi.fn().mockResolvedValue(undefined);
    const clearRestoringConnectionBanner = vi.fn();

    const cleanup = registerBrowserAppRuntime({
      clearRestoringConnectionBanner,
      onAgentLifecycle: vi.fn(),
      onGitStatusChanged: vi.fn(),
      onServerStateBootstrap: vi.fn(),
      onTaskPortsChanged: vi.fn(),
      onRemoteStatus: vi.fn(),
      reconcileRunningAgents,
      scheduleBrowserStateSync: vi.fn(),
      setConnectionBanner: vi.fn(),
      showNotification: vi.fn(),
      syncAgentStatusesFromServer: vi.fn(),
      syncBrowserStateFromServer,
    });

    for (let index = 0; index < 10; index += 1) {
      browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
      browserTransportListenerRef.current?.({ kind: 'connection', state: 'reconnecting' });
      browserTransportListenerRef.current?.({ kind: 'connection', state: 'connected' });
      browserAuthenticatedListenerRef.current?.();
      await Promise.resolve();
    }

    expect(syncBrowserStateFromServer).toHaveBeenCalledTimes(10);
    expect(reconcileRunningAgents).toHaveBeenCalledTimes(10);

    cleanup();
  });

  it('waits for authenticated control traffic before starting a reconnect restore', async () => {
    const syncBrowserStateFromServer = vi.fn().mockResolvedValue(undefined);
    const reconcileRunningAgents = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime({
      clearRestoringConnectionBanner: vi.fn(),
      onAgentLifecycle: vi.fn(),
      onGitStatusChanged: vi.fn(),
      onServerStateBootstrap: vi.fn(),
      onTaskPortsChanged: vi.fn(),
      onRemoteStatus: vi.fn(),
      reconcileRunningAgents,
      scheduleBrowserStateSync: vi.fn(),
      setConnectionBanner: vi.fn(),
      showNotification: vi.fn(),
      syncAgentStatusesFromServer: vi.fn(),
      syncBrowserStateFromServer,
    });

    browserTransportListenerRef.current?.({ kind: 'connection', state: 'disconnected' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'reconnecting' });
    browserTransportListenerRef.current?.({ kind: 'connection', state: 'connected' });
    await Promise.resolve();

    expect(syncBrowserStateFromServer).not.toHaveBeenCalled();
    expect(reconcileRunningAgents).not.toHaveBeenCalled();

    browserAuthenticatedListenerRef.current?.();
    await Promise.resolve();

    expect(syncBrowserStateFromServer).toHaveBeenCalledTimes(1);
    expect(reconcileRunningAgents).toHaveBeenCalledWith(true);

    cleanup();
  });
});
