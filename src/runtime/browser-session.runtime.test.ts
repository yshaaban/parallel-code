import { IPC } from '../../electron/ipc/channels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginBrowserColdBootstrap,
  getBrowserStartupState,
  resetBrowserStartupStateForTests,
} from '../app/browser-startup';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from '../app/runtime-diagnostics';

type BrowserHttpStateTest = 'available' | 'unreachable' | 'auth-expired';
type BrowserTransportEventTest =
  | {
      kind: 'connection';
      state: 'connecting' | 'reconnecting' | 'connected' | 'disconnected' | 'auth-expired';
    }
  | { kind: 'error'; message: string }
  | {
      kind: 'metrics';
      payload:
        | { connectedDurationMs: number | null; reason: 'close'; type: 'disconnect' }
        | { rttMs: number | null; type: 'pong' }
        | {
            attempt: number;
            delayMs: number;
            lastDisconnectReason: 'close' | null;
            type: 'reconnect-scheduled';
          }
        | { actualSeq: number; expectedSeq: number; type: 'sequence-gap' };
    };

const {
  browserAuthenticatedListeners,
  browserHttpStateListeners,
  browserTransportListeners,
  getBrowserReconnectContinuityMock,
  hydrateBrowserReconnectAgentGenerationsMock,
  invokeMock,
  taskCommandControllerListeners,
  listenTaskCommandControllerChangedMock,
  listenWorkspaceStateChangedMock,
  serverMessageListeners,
} = vi.hoisted(() => ({
  browserAuthenticatedListeners: new Set<() => void>(),
  browserHttpStateListeners: new Set<(state: BrowserHttpStateTest) => void>(),
  browserTransportListeners: new Set<(event: BrowserTransportEventTest) => void>(),
  getBrowserReconnectContinuityMock: vi.fn(() => ({
    disconnectedDurationMs: null as number | null,
    hasReplayTruncatedSinceDisconnect: false,
    hasSequenceGapSinceDisconnect: false,
    hasSequencedMessageSinceDisconnect: false,
  })),
  hydrateBrowserReconnectAgentGenerationsMock: vi.fn(),
  invokeMock: vi.fn(),
  taskCommandControllerListeners: new Set<(payload: unknown) => void>(),
  listenTaskCommandControllerChangedMock: vi.fn((listener: (payload: unknown) => void) => {
    taskCommandControllerListeners.add(listener);
    return () => {
      taskCommandControllerListeners.delete(listener);
    };
  }),
  listenWorkspaceStateChangedMock: vi.fn(() => () => {}),
  serverMessageListeners: new Map<string, Set<(payload: unknown) => void>>(),
}));

vi.mock('../lib/ipc', () => ({
  getBrowserQueueDepth: vi.fn(() => 0),
  getBrowserReconnectContinuity: getBrowserReconnectContinuityMock,
  invoke: invokeMock,
  listenServerMessage: vi.fn((type: string, listener: (payload: unknown) => void) => {
    const listeners = serverMessageListeners.get(type) ?? new Set<(payload: unknown) => void>();
    listeners.add(listener);
    serverMessageListeners.set(type, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        serverMessageListeners.delete(type);
      }
    };
  }),
  onBrowserAuthenticated: vi.fn((listener: () => void) => {
    browserAuthenticatedListeners.add(listener);
    return () => {
      browserAuthenticatedListeners.delete(listener);
    };
  }),
  onBrowserHttpStateChange: vi.fn((listener: (state: BrowserHttpStateTest) => void) => {
    browserHttpStateListeners.add(listener);
    return () => {
      browserHttpStateListeners.delete(listener);
    };
  }),
  onBrowserTransportEvent: vi.fn((listener: (event: BrowserTransportEventTest) => void) => {
    browserTransportListeners.add(listener);
    return () => {
      browserTransportListeners.delete(listener);
    };
  }),
}));

vi.mock('../lib/ipc-events', () => ({
  listenTaskCommandControllerChanged: listenTaskCommandControllerChangedMock,
  listenWorkspaceStateChanged: listenWorkspaceStateChangedMock,
}));

vi.mock('./browser-state-sync-controller', () => ({
  hydrateBrowserReconnectAgentGenerations: hydrateBrowserReconnectAgentGenerationsMock,
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

function emitBrowserAuthenticated(): void {
  for (const listener of [...browserAuthenticatedListeners]) {
    listener();
  }
}

function emitBrowserHttpState(state: BrowserHttpStateTest): void {
  for (const listener of [...browserHttpStateListeners]) {
    listener(state);
  }
}

function emitBrowserTransportEvent(event: BrowserTransportEventTest): void {
  for (const listener of [...browserTransportListeners]) {
    listener(event);
  }
}

function emitBrowserReconnectTransport(): void {
  emitBrowserTransportEvent({ kind: 'connection', state: 'disconnected' });
  emitBrowserTransportEvent({ kind: 'connection', state: 'reconnecting' });
  emitBrowserTransportEvent({ kind: 'connection', state: 'connected' });
}

function emitBrowserReconnectAndAuthenticate(): void {
  emitBrowserReconnectTransport();
  emitBrowserAuthenticated();
}

function emitServerMessage(type: string, payload: unknown): void {
  for (const listener of [...(serverMessageListeners.get(type) ?? [])]) {
    listener(payload);
  }
}

function emitTaskCommandControllerChanged(payload: unknown): void {
  for (const listener of [...taskCommandControllerListeners]) {
    listener(payload);
  }
}

function createBrowserRuntimeOptions(
  overrides: Partial<Parameters<typeof registerBrowserAppRuntime>[0]> = {},
): Parameters<typeof registerBrowserAppRuntime>[0] {
  const defaults: Parameters<typeof registerBrowserAppRuntime>[0] = {
    clearRestoringConnectionBanner: vi.fn(),
    getLoadedWorkspaceRevision: vi.fn(() => 0),
    getTaskCommandControllerUpdateCount: vi.fn(() => 0),
    getTaskCommandControllerVersion: vi.fn(() => 0),
    onAgentLifecycle: vi.fn(),
    onPeerPresence: vi.fn(),
    onTaskCommandControllerChanged: vi.fn(),
    onTaskCommandTakeoverRequest: vi.fn(),
    onTaskCommandTakeoverResult: vi.fn(),
    reconcileRunningAgentIds: vi.fn().mockResolvedValue(undefined),
    replaceTaskCommandControllers: vi.fn(),
    scheduleBrowserStateSync: vi.fn(),
    setConnectionBanner: vi.fn(),
    showNotification: vi.fn(),
    syncAgentStatusesFromServer: vi.fn(),
    syncBrowserStateFromReconnectSnapshot: vi.fn().mockResolvedValue(undefined),
  };
  return {
    ...defaults,
    ...overrides,
  };
}

describe('browser runtime restore generation', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    browserAuthenticatedListeners.clear();
    browserHttpStateListeners.clear();
    browserTransportListeners.clear();
    taskCommandControllerListeners.clear();
    getBrowserReconnectContinuityMock.mockReturnValue({
      disconnectedDurationMs: null as number | null,
      hasReplayTruncatedSinceDisconnect: false,
      hasSequenceGapSinceDisconnect: false,
      hasSequencedMessageSinceDisconnect: false,
    });
    invokeMock.mockResolvedValue({
      appStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      workspaceRevision: 0,
      workspaceStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      runningAgentIds: ['agent-1'],
    });
    serverMessageListeners.clear();
    resetBrowserStartupStateForTests();
    resetRendererRuntimeDiagnostics();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    browserAuthenticatedListeners.clear();
    browserHttpStateListeners.clear();
    browserTransportListeners.clear();
    taskCommandControllerListeners.clear();
    serverMessageListeners.clear();
    resetBrowserStartupStateForTests();
    resetRendererRuntimeDiagnostics();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
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

    emitBrowserReconnectAndAuthenticate();
    await Promise.resolve();

    // The default loaded workspace revision is the unversioned legacy 0, so
    // the client must not claim it as a known revision.
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot, undefined);
    expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(1);

    emitBrowserTransportEvent({ kind: 'connection', state: 'disconnected' });
    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await Promise.resolve();

    expect(reconcileRunningAgentIds).not.toHaveBeenCalled();
    expect(clearRestoringConnectionBanner).not.toHaveBeenCalled();

    cleanup();
  });

  it('skips full reconnect snapshot restore for a warm gap-free reconnect with current versions', async () => {
    getBrowserReconnectContinuityMock.mockReturnValue({
      disconnectedDurationMs: 1_000,
      hasReplayTruncatedSinceDisconnect: false,
      hasSequenceGapSinceDisconnect: false,
      hasSequencedMessageSinceDisconnect: true,
    });
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.GetBrowserReconnectStatus) {
        return {
          agentGenerations: { 'agent-1': 9 },
          runningAgentIds: ['agent-1'],
          taskCommandControllerVersion: 0,
          workspaceRevision: 0,
        };
      }
      throw new Error(`Unexpected invoke: ${channel}`);
    });
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const onTaskNotificationRestoreCompleted = vi.fn();
    const onTaskNotificationRestoreStarted = vi.fn();

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        onTaskNotificationRestoreCompleted,
        onTaskNotificationRestoreStarted,
        reconcileRunningAgentIds,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();

    await vi.waitFor(() => {
      expect(reconcileRunningAgentIds).toHaveBeenCalledWith(['agent-1'], true);
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectStatus);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot);
    expect(hydrateBrowserReconnectAgentGenerationsMock).toHaveBeenCalledWith({ 'agent-1': 9 });
    expect(syncBrowserStateFromReconnectSnapshot).not.toHaveBeenCalled();
    expect(onTaskNotificationRestoreStarted).not.toHaveBeenCalled();
    expect(onTaskNotificationRestoreCompleted).not.toHaveBeenCalled();
    expect(
      getRendererRuntimeDiagnosticsSnapshot().browserStartup.modeStartCounts['reconnect-restore'],
    ).toBe(0);
    cleanup();
  });

  it('does not start reconnect restore while cold bootstrap is still pending', async () => {
    beginBrowserColdBootstrap();
    const clearRestoringConnectionBanner = vi.fn();
    const setConnectionBanner = vi.fn();
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        clearRestoringConnectionBanner,
        reconcileRunningAgentIds,
        setConnectionBanner,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();
    await flushResolvedPromises();

    expect(invokeMock).not.toHaveBeenCalledWith(IPC.GetBrowserReconnectStatus);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot);
    expect(syncBrowserStateFromReconnectSnapshot).not.toHaveBeenCalled();
    expect(reconcileRunningAgentIds).not.toHaveBeenCalled();
    expect(clearRestoringConnectionBanner).toHaveBeenCalledTimes(1);
    expect(setConnectionBanner).toHaveBeenLastCalledWith(null);
    expect(getBrowserStartupState()).toMatchObject({
      coldBootstrapPending: true,
      currentMode: 'cold-bootstrap',
    });

    cleanup();
  });

  it('uses a full reconnect snapshot when warm status lacks agent generations', async () => {
    getBrowserReconnectContinuityMock.mockReturnValue({
      disconnectedDurationMs: 1_000,
      hasReplayTruncatedSinceDisconnect: false,
      hasSequenceGapSinceDisconnect: false,
      hasSequencedMessageSinceDisconnect: true,
    });
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.GetBrowserReconnectStatus) {
        return {
          runningAgentIds: ['agent-status'],
          taskCommandControllerVersion: 0,
          workspaceRevision: 0,
        };
      }
      if (channel === IPC.GetBrowserReconnectSnapshot) {
        return {
          agentGenerations: { 'agent-snapshot': 4 },
          appStateJson:
            '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
          runningAgentIds: ['agent-snapshot'],
          workspaceRevision: 0,
          workspaceStateJson:
            '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
        };
      }
      throw new Error(`Unexpected invoke: ${channel}`);
    });
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        reconcileRunningAgentIds,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();

    await vi.waitFor(() => {
      expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(1);
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectStatus);
    // The default loaded workspace revision is the unversioned legacy 0, so
    // the client must not claim it as a known revision.
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot, undefined);
    expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        agentGenerations: { 'agent-snapshot': 4 },
      }),
    );
    expect(reconcileRunningAgentIds).toHaveBeenCalledWith(['agent-snapshot'], true);
    expect(hydrateBrowserReconnectAgentGenerationsMock).not.toHaveBeenCalled();

    cleanup();
  });

  it('hydrates generations before stale-workspace warm reconnect skips the full snapshot', async () => {
    getBrowserReconnectContinuityMock.mockReturnValue({
      disconnectedDurationMs: 1_000,
      hasReplayTruncatedSinceDisconnect: false,
      hasSequenceGapSinceDisconnect: false,
      hasSequencedMessageSinceDisconnect: true,
    });
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.GetBrowserReconnectStatus) {
        return {
          agentGenerations: { 'agent-status': 6 },
          runningAgentIds: ['agent-status'],
          taskCommandControllerVersion: 2,
          workspaceRevision: 4,
        };
      }
      throw new Error(`Unexpected invoke: ${channel}`);
    });
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        getLoadedWorkspaceRevision: vi.fn(() => 5),
        getTaskCommandControllerVersion: vi.fn(() => 2),
        reconcileRunningAgentIds,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();

    await vi.waitFor(() => {
      expect(reconcileRunningAgentIds).toHaveBeenCalledWith(['agent-status'], true);
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectStatus);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot);
    expect(hydrateBrowserReconnectAgentGenerationsMock).toHaveBeenCalledWith({
      'agent-status': 6,
    });
    expect(syncBrowserStateFromReconnectSnapshot).not.toHaveBeenCalled();

    cleanup();
  });

  it('uses a full reconnect snapshot when no sequenced replay message has arrived yet', async () => {
    getBrowserReconnectContinuityMock.mockReturnValue({
      disconnectedDurationMs: 1_000,
      hasReplayTruncatedSinceDisconnect: false,
      hasSequenceGapSinceDisconnect: false,
      hasSequencedMessageSinceDisconnect: false,
    });
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();

    await flushResolvedPromises();

    expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.GetBrowserReconnectStatus);
    // The default loaded workspace revision is the unversioned legacy 0, so
    // the client must not claim it as a known revision.
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot, undefined);

    cleanup();
  });

  it('passes the loaded workspace revision into the full reconnect snapshot request', async () => {
    getBrowserReconnectContinuityMock.mockReturnValue({
      disconnectedDurationMs: 1_000,
      hasReplayTruncatedSinceDisconnect: true,
      hasSequenceGapSinceDisconnect: false,
      hasSequencedMessageSinceDisconnect: true,
    });
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        getLoadedWorkspaceRevision: vi.fn(() => 12),
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();

    await flushResolvedPromises();

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot, {
      knownWorkspaceRevision: 12,
    });

    cleanup();
  });

  it('omits knownWorkspaceRevision when the loaded revision is the unversioned legacy 0', async () => {
    getBrowserReconnectContinuityMock.mockReturnValue({
      disconnectedDurationMs: 1_000,
      hasReplayTruncatedSinceDisconnect: true,
      hasSequenceGapSinceDisconnect: false,
      hasSequencedMessageSinceDisconnect: true,
    });
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        getLoadedWorkspaceRevision: vi.fn(() => 0),
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();

    await flushResolvedPromises();

    // Revision 0 means this tab loaded unversioned legacy state that mutates
    // without revision bumps, so the server must keep shipping the full
    // payload instead of treating 0 === 0 as verified no-change.
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot, undefined);

    cleanup();
  });

  it('uses a full reconnect snapshot when the warm reconnect has a replay gap', async () => {
    getBrowserReconnectContinuityMock.mockReturnValue({
      disconnectedDurationMs: 1_000,
      hasReplayTruncatedSinceDisconnect: false,
      hasSequenceGapSinceDisconnect: true,
      hasSequencedMessageSinceDisconnect: true,
    });
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();

    await vi.waitFor(() => {
      expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(1);
    });

    expect(invokeMock).not.toHaveBeenCalledWith(IPC.GetBrowserReconnectStatus);
    // The default loaded workspace revision is the unversioned legacy 0, so
    // the client must not claim it as a known revision.
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot, undefined);

    cleanup();
  });

  it('no longer forces a full restore on replay truncation alone (versions current)', async () => {
    // replay-truncated is downgraded: stale categories arrive through the
    // version-gated reconnect handshake, so a truncated replay with current
    // status versions resolves through the status check only.
    getBrowserReconnectContinuityMock.mockReturnValue({
      disconnectedDurationMs: 1_000,
      hasReplayTruncatedSinceDisconnect: true,
      hasSequenceGapSinceDisconnect: false,
      hasSequencedMessageSinceDisconnect: true,
    });
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.GetBrowserReconnectStatus) {
        return {
          agentGenerations: { 'agent-1': 9 },
          runningAgentIds: ['agent-1'],
          taskCommandControllerVersion: 0,
          workspaceRevision: 0,
        };
      }
      throw new Error(`Unexpected invoke: ${channel}`);
    });
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        reconcileRunningAgentIds,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();

    await vi.waitFor(() => {
      expect(reconcileRunningAgentIds).toHaveBeenCalledWith(['agent-1'], true);
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectStatus);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot, undefined);
    expect(syncBrowserStateFromReconnectSnapshot).not.toHaveBeenCalled();

    cleanup();
  });

  it('resolves a long no-change disconnect with the status check only (no wall-clock gate)', async () => {
    // A 2-minute laptop-sleep style disconnect with zero server-side changes:
    // content checks decide, not the old 30s warm window.
    getBrowserReconnectContinuityMock.mockReturnValue({
      disconnectedDurationMs: 120_000,
      hasReplayTruncatedSinceDisconnect: false,
      hasSequenceGapSinceDisconnect: false,
      hasSequencedMessageSinceDisconnect: true,
    });
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.GetBrowserReconnectStatus) {
        return {
          agentGenerations: { 'agent-1': 9 },
          runningAgentIds: ['agent-1'],
          taskCommandControllerVersion: 0,
          workspaceRevision: 0,
        };
      }
      throw new Error(`Unexpected invoke: ${channel}`);
    });
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        reconcileRunningAgentIds,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();

    await vi.waitFor(() => {
      expect(reconcileRunningAgentIds).toHaveBeenCalledWith(['agent-1'], true);
    });

    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === IPC.GetBrowserReconnectStatus),
    ).toHaveLength(1);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot, undefined);
    expect(syncBrowserStateFromReconnectSnapshot).not.toHaveBeenCalled();
    expect(
      getRendererRuntimeDiagnosticsSnapshot().browserStartup.modeStartCounts['reconnect-restore'],
    ).toBe(0);

    cleanup();
  });

  it('falls back to one full restore outcome when warm reconnect status inspection fails', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });
    resetRendererRuntimeDiagnostics();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getBrowserReconnectContinuityMock.mockReturnValue({
      disconnectedDurationMs: 1_000,
      hasReplayTruncatedSinceDisconnect: false,
      hasSequenceGapSinceDisconnect: false,
      hasSequencedMessageSinceDisconnect: true,
    });
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.GetBrowserReconnectStatus) {
        throw new Error('status unavailable');
      }
      if (channel === IPC.GetBrowserReconnectSnapshot) {
        return {
          appStateJson:
            '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
          runningAgentIds: ['agent-snapshot'],
          workspaceRevision: 0,
          workspaceStateJson:
            '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
        };
      }
      throw new Error(`Unexpected invoke: ${channel}`);
    });
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();

    await vi.waitFor(() => {
      expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect(
        getRendererRuntimeDiagnosticsSnapshot().browserReconnect.restoreOutcomeCounts,
      ).toMatchObject({
        'full-restore': 1,
        'status-check-failed': 0,
      });
    });
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectStatus);
    // The default loaded workspace revision is the unversioned legacy 0, so
    // the client must not claim it as a known revision.
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot, undefined);

    warnSpy.mockRestore();
    cleanup();
  });

  it('uses a full reconnect snapshot when warm status has stale workspace but newer task control', async () => {
    getBrowserReconnectContinuityMock.mockReturnValue({
      disconnectedDurationMs: 1_000,
      hasReplayTruncatedSinceDisconnect: false,
      hasSequenceGapSinceDisconnect: false,
      hasSequencedMessageSinceDisconnect: true,
    });
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.GetBrowserReconnectStatus) {
        return {
          agentGenerations: { 'agent-status': 5 },
          runningAgentIds: ['agent-status'],
          taskCommandControllerVersion: 3,
          workspaceRevision: 1,
        };
      }
      if (channel === IPC.GetBrowserReconnectSnapshot) {
        return {
          appStateJson:
            '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
          runningAgentIds: ['agent-snapshot'],
          taskCommandControllers: [
            {
              action: 'merge this task',
              controllerId: 'client-a',
              taskId: 'task-1',
              version: 3,
            },
          ],
          taskCommandControllerVersion: 3,
          workspaceRevision: 1,
          workspaceStateJson:
            '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
        };
      }
      throw new Error(`Unexpected invoke: ${channel}`);
    });
    const replaceTaskCommandControllers = vi.fn();
    const syncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        getLoadedWorkspaceRevision: vi.fn(() => 2),
        getTaskCommandControllerVersion: vi.fn(() => 2),
        replaceTaskCommandControllers,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();

    await vi.waitFor(() => {
      expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(1);
    });

    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectStatus);
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot, {
      knownWorkspaceRevision: 2,
    });
    expect(replaceTaskCommandControllers).toHaveBeenCalledWith(
      [
        {
          action: 'merge this task',
          controllerId: 'client-a',
          taskId: 'task-1',
          version: 3,
        },
      ],
      {
        replaceVersion: 3,
      },
    );

    cleanup();
  });

  it('clears reconnect startup mode when transport churn cancels restore', async () => {
    const syncDeferred = createDeferred<undefined>();
    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        syncBrowserStateFromReconnectSnapshot: vi.fn(() => syncDeferred.promise),
      }),
    );

    emitBrowserReconnectAndAuthenticate();
    await Promise.resolve();

    expect(getBrowserStartupState()).toMatchObject({
      currentMode: 'reconnect-restore',
    });

    emitBrowserTransportEvent({ kind: 'connection', state: 'disconnected' });

    expect(getBrowserStartupState()).toMatchObject({
      currentMode: null,
    });

    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await Promise.resolve();

    cleanup();
  });

  it('keeps full reconnect restore required after a replay gap restore is interrupted', async () => {
    const firstSyncDeferred = createDeferred<undefined>();
    const syncBrowserStateFromReconnectSnapshot = vi
      .fn()
      .mockImplementationOnce(() => firstSyncDeferred.promise)
      .mockResolvedValue(undefined);
    getBrowserReconnectContinuityMock
      .mockReturnValueOnce({
        disconnectedDurationMs: 100,
        hasReplayTruncatedSinceDisconnect: false,
        hasSequenceGapSinceDisconnect: true,
        hasSequencedMessageSinceDisconnect: true,
      })
      .mockReturnValue({
        disconnectedDurationMs: 100,
        hasReplayTruncatedSinceDisconnect: false,
        hasSequenceGapSinceDisconnect: false,
        hasSequencedMessageSinceDisconnect: true,
      });
    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();
    await vi.waitFor(() => {
      expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(1);
    });

    emitBrowserTransportEvent({ kind: 'connection', state: 'disconnected' });
    firstSyncDeferred.resolve(undefined);
    await firstSyncDeferred.promise;
    await flushResolvedPromises();

    emitBrowserReconnectAndAuthenticate();
    await vi.waitFor(() => {
      expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(2);
    });

    expect(invokeMock).not.toHaveBeenCalledWith(IPC.GetBrowserReconnectStatus);

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

    emitBrowserReconnectAndAuthenticate();
    emitBrowserHttpState('auth-expired');

    expect(getBrowserStartupState()).toMatchObject({
      currentMode: null,
    });

    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await Promise.resolve();

    expect(reconcileRunningAgentIds).not.toHaveBeenCalled();
    expect(clearRestoringConnectionBanner).not.toHaveBeenCalled();

    cleanup();
  });

  it('leaves bootstrap-owned browser state categories to the session bootstrap registry', () => {
    const cleanup = registerBrowserAppRuntime(createBrowserRuntimeOptions());

    expect(serverMessageListeners.has('state-bootstrap')).toBe(false);
    expect(serverMessageListeners.has('git-status-changed')).toBe(false);
    expect(serverMessageListeners.has('task-ports-changed')).toBe(false);
    expect(serverMessageListeners.has('remote-status')).toBe(false);

    cleanup();
  });

  it('continues processing agent snapshots while restore is in flight', async () => {
    const syncDeferred = createDeferred<undefined>();
    const syncBrowserStateFromReconnectSnapshot = vi.fn(() => syncDeferred.promise);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const onTaskCommandControllerChanged = vi.fn();
    const replaceTaskCommandControllers = vi.fn();
    const syncAgentStatusesFromServer = vi.fn();
    const clearRestoringConnectionBanner = vi.fn();

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        clearRestoringConnectionBanner,
        onTaskCommandControllerChanged,
        reconcileRunningAgentIds,
        replaceTaskCommandControllers,
        syncAgentStatusesFromServer,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();

    emitServerMessage('agents', {
      list: [{ agentId: 'agent-1', status: 'running' }],
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

  it('emits task-notification restore lifecycle callbacks around reconnect restoration', async () => {
    const onTaskNotificationRestoreStarted = vi.fn();
    const onTaskNotificationRestoreCompleted = vi.fn();
    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        onTaskNotificationRestoreCompleted,
        onTaskNotificationRestoreStarted,
      }),
    );

    emitBrowserReconnectAndAuthenticate();
    await flushResolvedPromises();

    expect(onTaskNotificationRestoreStarted).toHaveBeenCalledTimes(1);
    expect(onTaskNotificationRestoreCompleted).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('reports reconnect restore failures without treating them as completed restoration', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });
    resetRendererRuntimeDiagnostics();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scheduleBrowserStateSync = vi.fn();
    const showNotification = vi.fn();
    const clearRestoringConnectionBanner = vi.fn();
    const onTaskNotificationRestoreCompleted = vi.fn();
    const syncBrowserStateFromReconnectSnapshot = vi
      .fn()
      .mockRejectedValue(new Error('restore failed'));

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        clearRestoringConnectionBanner,
        onTaskNotificationRestoreCompleted,
        scheduleBrowserStateSync,
        showNotification,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();
    await flushResolvedPromises();

    expect(showNotification).toHaveBeenCalledWith(
      'Failed to restore browser state after reconnect',
    );
    expect(scheduleBrowserStateSync).toHaveBeenCalledWith(0, false);
    expect(onTaskNotificationRestoreCompleted).not.toHaveBeenCalled();
    expect(clearRestoringConnectionBanner).toHaveBeenCalledTimes(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().browserStartup).toMatchObject({
      modeCancelCounts: {
        'reconnect-restore': 1,
      },
      modeCancelReasonCounts: {
        'reconnect-restore': expect.objectContaining({
          'restore-failed': 1,
        }),
      },
      modeCompleteCounts: {
        'reconnect-restore': 0,
      },
    });

    warnSpy.mockRestore();
    cleanup();
  });

  it('does not cancel reconnect restore on notify-only transport errors', async () => {
    const syncDeferred = createDeferred<undefined>();
    const syncBrowserStateFromReconnectSnapshot = vi.fn(() => syncDeferred.promise);
    const reconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const showNotification = vi.fn();
    const clearRestoringConnectionBanner = vi.fn();

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        clearRestoringConnectionBanner,
        reconcileRunningAgentIds,
        showNotification,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();
    await Promise.resolve();

    emitBrowserTransportEvent({ kind: 'error', message: 'Agent agent-1: warning' });
    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await flushResolvedPromises();

    expect(showNotification).toHaveBeenCalledWith('Agent agent-1: warning');
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
          version: 2,
        },
      ],
      taskCommandControllerVersion: 2,
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

    emitBrowserReconnectAndAuthenticate();
    await Promise.resolve();
    await Promise.resolve();

    expect(replaceTaskCommandControllers).toHaveBeenCalledWith(
      [
        {
          action: 'merge this task',
          controllerId: 'client-a',
          taskId: 'task-1',
          version: 2,
        },
      ],
      {
        replaceVersion: 2,
      },
    );

    emitTaskCommandControllerChanged({
      action: 'push this task',
      controllerId: 'client-b',
      taskId: 'task-2',
      version: 3,
    });

    expect(onTaskCommandControllerChanged).toHaveBeenCalledWith({
      action: 'push this task',
      controllerId: 'client-b',
      taskId: 'task-2',
      version: 3,
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
          version: 2,
        },
      ],
      taskCommandControllerVersion: 2,
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

    emitBrowserReconnectAndAuthenticate();
    await Promise.resolve();

    emitTaskCommandControllerChanged({
      action: 'push this task',
      controllerId: 'client-b',
      taskId: 'task-2',
      version: 3,
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
      emitBrowserReconnectAndAuthenticate();
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
    const setConnectionBanner = vi.fn();
    const showNotification = vi.fn();

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        reconcileRunningAgentIds,
        setConnectionBanner,
        showNotification,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectTransport();
    await Promise.resolve();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(syncBrowserStateFromReconnectSnapshot).not.toHaveBeenCalled();
    expect(reconcileRunningAgentIds).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalledWith('Reconnected to the server');
    expect(setConnectionBanner).not.toHaveBeenCalledWith({ state: 'restoring' });

    emitBrowserAuthenticated();
    await Promise.resolve();
    await Promise.resolve();

    expect(showNotification).toHaveBeenCalledWith('Reconnected to the server');
    // The default loaded workspace revision is the unversioned legacy 0, so
    // the client must not claim it as a known revision.
    expect(invokeMock).toHaveBeenCalledWith(IPC.GetBrowserReconnectSnapshot, undefined);
    expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(1);
    expect(reconcileRunningAgentIds).toHaveBeenCalledWith(['agent-1'], true);

    cleanup();
  });

  it('does not complete restore side effects after cleanup invalidates an in-flight restore', async () => {
    const syncDeferred = createDeferred<undefined>();
    const syncBrowserStateFromReconnectSnapshot = vi.fn(() => syncDeferred.promise);
    const clearRestoringConnectionBanner = vi.fn();
    const onTaskNotificationRestoreCompleted = vi.fn();

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        clearRestoringConnectionBanner,
        onTaskNotificationRestoreCompleted,
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();
    await Promise.resolve();

    cleanup();
    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await flushResolvedPromises();

    expect(clearRestoringConnectionBanner).not.toHaveBeenCalled();
    expect(onTaskNotificationRestoreCompleted).not.toHaveBeenCalled();
  });

  it('removes only the listeners registered by the cleaned up runtime', async () => {
    const firstRuntime = createBrowserRuntimeOptions();
    const secondSyncBrowserStateFromReconnectSnapshot = vi.fn().mockResolvedValue(undefined);
    const secondReconcileRunningAgentIds = vi.fn().mockResolvedValue(undefined);
    const secondRuntime = createBrowserRuntimeOptions({
      reconcileRunningAgentIds: secondReconcileRunningAgentIds,
      syncBrowserStateFromReconnectSnapshot: secondSyncBrowserStateFromReconnectSnapshot,
    });
    const peerPresence = [
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
    ];

    const cleanupFirst = registerBrowserAppRuntime(firstRuntime);
    const cleanupSecond = registerBrowserAppRuntime(secondRuntime);

    cleanupFirst();

    emitBrowserReconnectAndAuthenticate();
    emitServerMessage('peer-presences', { list: peerPresence });
    await flushResolvedPromises();

    expect(firstRuntime.showNotification).not.toHaveBeenCalled();
    expect(firstRuntime.onPeerPresence).not.toHaveBeenCalled();
    expect(secondRuntime.showNotification).toHaveBeenCalledWith(
      'Lost connection to the server. Reconnecting...',
    );
    expect(secondRuntime.showNotification).toHaveBeenCalledWith('Reconnected to the server');
    expect(secondSyncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(1);
    expect(secondReconcileRunningAgentIds).toHaveBeenCalledWith(['agent-1'], true);
    expect(secondRuntime.onPeerPresence).toHaveBeenCalledWith(peerPresence);

    cleanupSecond();
  });

  it('ignores repeated authenticated callbacks while the same reconnect restore is already in flight', async () => {
    const syncDeferred = createDeferred<undefined>();
    const syncBrowserStateFromReconnectSnapshot = vi.fn(() => syncDeferred.promise);

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        syncBrowserStateFromReconnectSnapshot,
      }),
    );

    emitBrowserReconnectAndAuthenticate();
    emitBrowserAuthenticated();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(syncBrowserStateFromReconnectSnapshot).toHaveBeenCalledTimes(1);

    syncDeferred.resolve(undefined);
    await syncDeferred.promise;
    await flushResolvedPromises();

    cleanup();
  });

  it('forwards peer presence snapshots from the browser control plane', () => {
    const onPeerPresence = vi.fn();

    const cleanup = registerBrowserAppRuntime(
      createBrowserRuntimeOptions({
        onPeerPresence,
      }),
    );

    emitServerMessage('peer-presences', {
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

    emitServerMessage('task-command-takeover-request', {
      action: 'type in the terminal',
      expiresAt: 456,
      requestId: 'request-1',
      requesterClientId: 'client-b',
      requesterDisplayName: 'Sara',
      taskId: 'task-1',
    });
    emitServerMessage('task-command-takeover-result', {
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
