import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { browserHttpStateListenerRef, browserTransportListenerRef, listenSaveAppStateMock } =
  vi.hoisted(() => ({
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
  }));

vi.mock('../lib/ipc', () => ({
  getBrowserQueueDepth: vi.fn(() => 0),
  listenServerMessage: vi.fn(() => () => {}),
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
    browserHttpStateListenerRef.current = null;
    browserTransportListenerRef.current = null;
  });

  afterEach(() => {
    browserHttpStateListenerRef.current = null;
    browserTransportListenerRef.current = null;
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
    browserHttpStateListenerRef.current?.('auth-expired');

    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await Promise.resolve();

    expect(reconcileRunningAgents).not.toHaveBeenCalled();
    expect(clearRestoringConnectionBanner).not.toHaveBeenCalled();

    cleanup();
  });
});
