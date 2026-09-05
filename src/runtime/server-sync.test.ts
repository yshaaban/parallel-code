import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from '../app/runtime-diagnostics';

const {
  applyLoadedWorkspaceStateJsonMock,
  getLoadedWorkspaceRevisionMock,
  hydrateAgentGenerationMock,
  hydrateAgentSessionIdentityMock,
  isBrowserColdBootstrapPendingMock,
  invokeMock,
  loadWorkspaceStateMock,
  markAgentExitedMock,
  markAgentRunningMock,
  markAutosaveCleanMock,
  hasPendingWorkspaceAutosaveChangesMock,
  reconcileClientSessionStateMock,
  setAgentStatusMock,
  showNotificationMock,
  storeState,
  validateProjectPathsMock,
} = vi.hoisted(() => ({
  applyLoadedWorkspaceStateJsonMock: vi.fn(),
  getLoadedWorkspaceRevisionMock: vi.fn(() => 0),
  hydrateAgentGenerationMock: vi.fn(),
  hydrateAgentSessionIdentityMock: vi.fn(),
  isBrowserColdBootstrapPendingMock: vi.fn(() => false),
  invokeMock: vi.fn(),
  loadWorkspaceStateMock: vi.fn(),
  markAgentExitedMock: vi.fn(),
  markAgentRunningMock: vi.fn(),
  markAutosaveCleanMock: vi.fn(),
  hasPendingWorkspaceAutosaveChangesMock: vi.fn(() => false),
  reconcileClientSessionStateMock: vi.fn(),
  setAgentStatusMock: vi.fn(),
  showNotificationMock: vi.fn(),
  storeState: {
    agents: {} as Record<
      string,
      {
        exitCode?: number | null;
        generation?: number;
        id: string;
        signal?: string | null;
        status: string;
      }
    >,
  },
  validateProjectPathsMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../app/browser-startup', () => ({
  isBrowserColdBootstrapPending: isBrowserColdBootstrapPendingMock,
}));

vi.mock('../store/autosave', () => ({
  hasPendingWorkspaceAutosaveChanges: hasPendingWorkspaceAutosaveChangesMock,
  markAutosaveClean: markAutosaveCleanMock,
}));

vi.mock('../store/agents', () => ({
  hydrateAgentGeneration: hydrateAgentGenerationMock,
  hydrateAgentSessionIdentity: hydrateAgentSessionIdentityMock,
  markAgentExited: markAgentExitedMock,
  markAgentRunning: markAgentRunningMock,
  setAgentStatus: setAgentStatusMock,
}));

vi.mock('../store/client-session', () => ({
  reconcileClientSessionState: reconcileClientSessionStateMock,
}));

vi.mock('../store/notification', () => ({
  showNotification: showNotificationMock,
}));

vi.mock('../store/persistence-load', () => ({
  applyLoadedWorkspaceStateJson: applyLoadedWorkspaceStateJsonMock,
  loadWorkspaceState: loadWorkspaceStateMock,
}));

vi.mock('../store/persistence-session', () => ({
  getLoadedWorkspaceRevision: getLoadedWorkspaceRevisionMock,
}));

vi.mock('../store/projects', () => ({
  validateProjectPaths: validateProjectPathsMock,
}));

vi.mock('../store/state', () => ({
  store: storeState,
}));

import {
  createBrowserStateSync,
  handleAgentLifecycleMessage,
  reconcileRunningAgents,
  syncAgentStatusesFromServer,
} from './server-sync';

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

function installTimerWindow(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      setTimeout,
      clearTimeout,
    },
  });
}

function restoreWindow(originalWindow: typeof globalThis.window): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
}

function expectBrowserSyncDiagnostics(
  expected: Partial<ReturnType<typeof getRendererRuntimeDiagnosticsSnapshot>['browserSync']>,
): void {
  expect(getRendererRuntimeDiagnosticsSnapshot().browserSync).toMatchObject(expected);
}

describe('server-sync reliability contracts', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.clearAllMocks();
    hydrateAgentGenerationMock.mockReset();
    vi.useFakeTimers();
    resetRendererRuntimeDiagnostics();
    storeState.agents = {};
    loadWorkspaceStateMock.mockResolvedValue(true);
    applyLoadedWorkspaceStateJsonMock.mockReturnValue(true);
    getLoadedWorkspaceRevisionMock.mockReturnValue(0);
    isBrowserColdBootstrapPendingMock.mockReturnValue(false);
    hasPendingWorkspaceAutosaveChangesMock.mockReturnValue(false);
    validateProjectPathsMock.mockResolvedValue(undefined);
    invokeMock.mockResolvedValue([]);
    installTimerWindow();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    restoreWindow(originalWindow);
  });

  it('maps lifecycle messages onto canonical client-visible agent states', () => {
    handleAgentLifecycleMessage({
      agentId: 'agent-1',
      event: 'pause',
      isShell: false,
      status: 'flow-controlled',
      taskId: 'task-1',
    });
    handleAgentLifecycleMessage({
      agentId: 'agent-2',
      event: 'pause',
      isShell: false,
      taskId: 'task-2',
    });
    handleAgentLifecycleMessage({
      agentId: 'agent-3',
      event: 'resume',
      isShell: false,
      taskId: 'task-3',
    });
    handleAgentLifecycleMessage({
      agentId: 'agent-4',
      event: 'exit',
      exitCode: 17,
      isShell: false,
      signal: 'SIGTERM',
      taskId: 'task-4',
    });

    expect(setAgentStatusMock).toHaveBeenNthCalledWith(1, 'agent-1', 'flow-controlled');
    expect(setAgentStatusMock).toHaveBeenNthCalledWith(2, 'agent-2', 'paused');
    expect(setAgentStatusMock).toHaveBeenNthCalledWith(3, 'agent-3', 'running');
    expect(markAgentExitedMock).toHaveBeenCalledWith(
      'agent-4',
      {
        exit_code: 17,
        signal: 'SIGTERM',
        last_output: [],
      },
      undefined,
    );
  });

  it('ignores stale lifecycle exits from an older generation', () => {
    storeState.agents = {
      'agent-4': { generation: 2, id: 'agent-4', status: 'running' },
    };

    handleAgentLifecycleMessage({
      agentId: 'agent-4',
      event: 'exit',
      exitCode: 17,
      generation: 1,
      isShell: false,
      signal: 'SIGTERM',
      taskId: 'task-4',
    });

    expect(markAgentExitedMock).not.toHaveBeenCalled();
  });

  it('hydrates newer live spawn generations before applying lifecycle status', () => {
    storeState.agents = {
      'agent-1': { generation: 1, id: 'agent-1', status: 'running' },
    };
    hydrateAgentGenerationMock.mockImplementation((agentId: string, generation: number) => {
      const agent = storeState.agents[agentId];
      if (agent) {
        agent.generation = generation;
      }
    });

    handleAgentLifecycleMessage({
      agentId: 'agent-1',
      event: 'spawn',
      generation: 2,
      isShell: false,
      status: 'running',
      taskId: 'task-1',
    });

    expect(hydrateAgentGenerationMock).toHaveBeenCalledWith('agent-1', 2);
    expect(setAgentStatusMock).toHaveBeenCalledWith('agent-1', 'running');
  });

  it('ignores stale live spawn generations without hydrating them', () => {
    storeState.agents = {
      'agent-1': { generation: 2, id: 'agent-1', status: 'running' },
    };

    handleAgentLifecycleMessage({
      agentId: 'agent-1',
      event: 'spawn',
      generation: 1,
      isShell: false,
      status: 'running',
      taskId: 'task-1',
    });

    expect(hydrateAgentGenerationMock).not.toHaveBeenCalled();
    expect(setAgentStatusMock).not.toHaveBeenCalled();
  });

  it('updates known agents from live active-agent snapshots and only revives uncertain exited agents', () => {
    storeState.agents = {
      'agent-1': { id: 'agent-1', status: 'running' },
      'agent-2': { id: 'agent-2', status: 'running' },
      'agent-3': { id: 'agent-3', signal: 'server_unavailable', status: 'exited' },
      'agent-4': { id: 'agent-4', signal: 'SIGTERM', status: 'exited' },
    };

    syncAgentStatusesFromServer([
      { agentId: 'agent-1', status: 'paused' },
      { agentId: 'agent-2', status: 'flow-controlled' },
      { agentId: 'agent-3', status: 'running' },
      { agentId: 'agent-4', status: 'running' },
      { agentId: 'agent-missing', status: 'running' },
    ]);

    expect(setAgentStatusMock).toHaveBeenCalledTimes(3);
    expect(setAgentStatusMock).toHaveBeenCalledWith('agent-1', 'paused');
    expect(setAgentStatusMock).toHaveBeenCalledWith('agent-2', 'flow-controlled');
    expect(setAgentStatusMock).toHaveBeenCalledWith('agent-3', 'running');
    expect(setAgentStatusMock).not.toHaveBeenCalledWith('agent-4', 'running');
  });

  it('reconciles stale persisted agents against the live backend snapshot', async () => {
    storeState.agents = {
      'agent-running': { id: 'agent-running', status: 'running' },
      'agent-missing': { id: 'agent-missing', status: 'running' },
      'agent-revive': { id: 'agent-revive', status: 'exited' },
    };
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.ListRunningAgentIds) {
        return Promise.resolve(['agent-running', 'agent-revive']);
      }
      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    await reconcileRunningAgents(true);

    expect(markAgentRunningMock).toHaveBeenCalledWith('agent-revive');
    expect(markAgentExitedMock).toHaveBeenCalledWith('agent-missing', {
      exit_code: null,
      signal: 'server_unavailable',
      last_output: [],
    });
    expect(showNotificationMock).toHaveBeenCalledWith(
      '1 agent session ended while the server was unavailable',
    );
  });

  it('deduplicates scheduled browser state sync and applies the latest notify policy', async () => {
    const { cleanupBrowserStateSyncTimer, scheduleBrowserStateSync } =
      createBrowserStateSync(false);

    scheduleBrowserStateSync(100, false);
    scheduleBrowserStateSync(25, true);
    scheduleBrowserStateSync(10, true);

    await vi.advanceTimersByTimeAsync(10);

    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(1);
    expect(markAutosaveCleanMock).toHaveBeenCalledTimes(1);
    expect(reconcileClientSessionStateMock).toHaveBeenCalledTimes(1);
    expect(validateProjectPathsMock).toHaveBeenCalledTimes(1);
    expect(showNotificationMock).toHaveBeenCalledWith('State updated in another browser tab');
    expectBrowserSyncDiagnostics({
      completed: 1,
      failed: 0,
      scheduled: 3,
      started: 1,
      superseded: 2,
    });

    cleanupBrowserStateSyncTimer();
  });

  it('surfaces sync failures with one explicit browser-state notification', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadWorkspaceStateMock.mockRejectedValue(new Error('load failed'));
    const { syncBrowserStateFromServer } = createBrowserStateSync(false);

    await syncBrowserStateFromServer();

    expect(showNotificationMock).toHaveBeenCalledWith('Failed to sync browser state from server');
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to sync browser state from server:',
      expect.any(Error),
    );
    expectBrowserSyncDiagnostics({
      completed: 0,
      failed: 1,
      scheduled: 0,
      started: 1,
      superseded: 0,
    });

    warnSpy.mockRestore();
  });

  it('revalidates project paths but skips notifications when persisted browser state is unchanged', async () => {
    loadWorkspaceStateMock.mockResolvedValue(false);
    const { syncBrowserStateFromServer } = createBrowserStateSync(false);

    await syncBrowserStateFromServer(true);

    expect(markAutosaveCleanMock).not.toHaveBeenCalled();
    expect(validateProjectPathsMock).toHaveBeenCalledTimes(1);
    expect(showNotificationMock).not.toHaveBeenCalled();
    expectBrowserSyncDiagnostics({
      completed: 1,
      failed: 0,
      scheduled: 0,
      started: 1,
      superseded: 0,
    });
  });

  it('defers browser workspace sync until cold bootstrap completes', async () => {
    isBrowserColdBootstrapPendingMock.mockReturnValue(true);
    const { scheduleBrowserStateSync } = createBrowserStateSync(false);

    scheduleBrowserStateSync(0, true);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();

    isBrowserColdBootstrapPendingMock.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(1);
    expect(markAutosaveCleanMock).toHaveBeenCalledTimes(1);
    expect(reconcileClientSessionStateMock).toHaveBeenCalledTimes(1);
  });

  it('queues one follow-up browser sync while a sync is already in flight', async () => {
    const firstLoad = createDeferred<boolean>();
    loadWorkspaceStateMock.mockReturnValueOnce(firstLoad.promise);
    loadWorkspaceStateMock.mockResolvedValueOnce(true);

    const { scheduleBrowserStateSync } = createBrowserStateSync(false);

    scheduleBrowserStateSync(0, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(1);

    scheduleBrowserStateSync(25, true);
    firstLoad.resolve(true);
    await firstLoad.promise;
    await vi.advanceTimersByTimeAsync(0);

    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(2);
    expect(showNotificationMock).toHaveBeenCalledWith('State updated in another browser tab');
    expectBrowserSyncDiagnostics({
      completed: 2,
      failed: 0,
      scheduled: 1,
      started: 2,
      superseded: 1,
    });
  });

  it('preserves notify=true for a queued sync while a sync is already in flight', async () => {
    const firstLoad = createDeferred<boolean>();
    loadWorkspaceStateMock.mockReturnValueOnce(firstLoad.promise);
    loadWorkspaceStateMock.mockResolvedValueOnce(true);

    const { scheduleBrowserStateSync } = createBrowserStateSync(false);

    scheduleBrowserStateSync(0, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(1);

    scheduleBrowserStateSync(25, true);
    scheduleBrowserStateSync(25, false);

    firstLoad.resolve(true);
    await firstLoad.promise;
    await vi.advanceTimersByTimeAsync(0);

    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(2);
    expect(showNotificationMock).toHaveBeenCalledWith('State updated in another browser tab');
    expectBrowserSyncDiagnostics({
      completed: 2,
      failed: 0,
      scheduled: 1,
      started: 2,
      superseded: 2,
    });
  });

  it('preserves notify=true when rescheduling a browser sync before the timer fires', async () => {
    const { scheduleBrowserStateSync } = createBrowserStateSync(false);

    scheduleBrowserStateSync(50, true);
    scheduleBrowserStateSync(10, false);

    await vi.advanceTimersByTimeAsync(10);

    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(1);
    expect(showNotificationMock).toHaveBeenCalledWith('State updated in another browser tab');
    expectBrowserSyncDiagnostics({
      completed: 1,
      failed: 0,
      scheduled: 2,
      started: 1,
      superseded: 1,
    });
  });

  it('reuses an in-flight direct browser sync instead of starting a second load immediately', async () => {
    const firstLoad = createDeferred<boolean>();
    loadWorkspaceStateMock.mockReturnValueOnce(firstLoad.promise);

    const { syncBrowserStateFromServer } = createBrowserStateSync(false);

    const firstSync = syncBrowserStateFromServer(false);
    const secondSync = syncBrowserStateFromServer(true);

    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(1);

    firstLoad.resolve(true);
    await Promise.all([firstSync, secondSync]);

    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(1);
    expect(showNotificationMock).toHaveBeenCalledWith('State updated in another browser tab');
    expect(getRendererRuntimeDiagnosticsSnapshot().browserSync).toMatchObject({
      completed: 1,
      failed: 0,
      scheduled: 0,
      started: 1,
      superseded: 1,
    });
  });

  it('hydrates reconnect metadata after reading workspace state so regenerated agents get the backend generation', async () => {
    const { syncBrowserStateFromReconnectSnapshot } = createBrowserStateSync(false);
    let appliedWorkspaceState = false;
    applyLoadedWorkspaceStateJsonMock.mockImplementation(() => {
      appliedWorkspaceState = true;
      return false;
    });

    await syncBrowserStateFromReconnectSnapshot({
      agentGenerations: { 'agent-1': 7 },
      appStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      workspaceRevision: 0,
      workspaceStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      runningAgentIds: ['agent-1'],
    });

    expect(applyLoadedWorkspaceStateJsonMock).toHaveBeenCalledWith(
      '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      0,
    );
    expect(appliedWorkspaceState).toBe(true);
    expect(hydrateAgentGenerationMock).toHaveBeenCalledWith('agent-1', 7);
    expect(applyLoadedWorkspaceStateJsonMock.mock.invocationCallOrder[0]).toBeLessThan(
      hydrateAgentGenerationMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
    expect(validateProjectPathsMock).toHaveBeenCalledTimes(1);
    expect(markAutosaveCleanMock).not.toHaveBeenCalled();
    expect(reconcileClientSessionStateMock).toHaveBeenCalledTimes(1);
  });

  it('hydrates backend agent generations from reconnect snapshots before later lifecycle gating', async () => {
    const { syncBrowserStateFromReconnectSnapshot } = createBrowserStateSync(false);

    await syncBrowserStateFromReconnectSnapshot({
      agentGenerations: { 'agent-1': 3, 'agent-2': 1 },
      appStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      workspaceRevision: 0,
      workspaceStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      runningAgentIds: ['agent-1', 'agent-2'],
    });

    expect(hydrateAgentGenerationMock).toHaveBeenNthCalledWith(1, 'agent-1', 3);
    expect(hydrateAgentGenerationMock).toHaveBeenNthCalledWith(2, 'agent-2', 1);
  });

  it('skips stale reconnect workspace snapshots while still hydrating agent generations', async () => {
    getLoadedWorkspaceRevisionMock.mockReturnValue(9);
    const { syncBrowserStateFromReconnectSnapshot } = createBrowserStateSync(false);

    await syncBrowserStateFromReconnectSnapshot({
      agentGenerations: { 'agent-1': 3 },
      appStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      workspaceRevision: 7,
      workspaceStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      runningAgentIds: ['agent-1'],
    });

    expect(applyLoadedWorkspaceStateJsonMock).not.toHaveBeenCalled();
    expect(hydrateAgentGenerationMock).toHaveBeenCalledWith('agent-1', 3);
    expect(reconcileClientSessionStateMock).toHaveBeenCalledTimes(1);
    expect(validateProjectPathsMock).toHaveBeenCalledTimes(1);
  });

  it('hydrates reconnect agent generations even when the snapshot does not include workspace JSON', async () => {
    const { syncBrowserStateFromReconnectSnapshot } = createBrowserStateSync(false);

    await syncBrowserStateFromReconnectSnapshot({
      agentGenerations: { 'agent-1': 4 },
      appStateJson: null,
      runningAgentIds: ['agent-1'],
      workspaceRevision: 0,
      workspaceStateJson: undefined,
    });

    expect(applyLoadedWorkspaceStateJsonMock).not.toHaveBeenCalled();
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
    expect(hydrateAgentGenerationMock).toHaveBeenCalledWith('agent-1', 4);
    expect(reconcileClientSessionStateMock).toHaveBeenCalledTimes(1);
    expect(validateProjectPathsMock).toHaveBeenCalledTimes(1);
  });

  it('treats a payload-free reconnect snapshot with a matching revision as verified no-change with side effects intact', async () => {
    getLoadedWorkspaceRevisionMock.mockReturnValue(5);
    const { syncBrowserStateFromReconnectSnapshot } = createBrowserStateSync(false);

    await syncBrowserStateFromReconnectSnapshot({
      agentGenerations: { 'agent-1': 2 },
      runningAgentIds: ['agent-1'],
      workspaceRevision: 5,
    });

    expect(applyLoadedWorkspaceStateJsonMock).not.toHaveBeenCalled();
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
    // Review-rule-2 invariant: the no-change fast path keeps reconciliation
    // side effects running.
    expect(hydrateAgentGenerationMock).toHaveBeenCalledWith('agent-1', 2);
    expect(reconcileClientSessionStateMock).toHaveBeenCalledTimes(1);
    expect(validateProjectPathsMock).toHaveBeenCalledTimes(1);
    expect(markAutosaveCleanMock).not.toHaveBeenCalled();
  });

  it('falls back to an explicit workspace load when the payload is absent but the revision differs', async () => {
    getLoadedWorkspaceRevisionMock.mockReturnValue(5);
    const { syncBrowserStateFromReconnectSnapshot } = createBrowserStateSync(false);

    await syncBrowserStateFromReconnectSnapshot({
      agentGenerations: {},
      runningAgentIds: [],
      workspaceRevision: 9,
    });

    expect(applyLoadedWorkspaceStateJsonMock).not.toHaveBeenCalled();
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(1);
    expect(reconcileClientSessionStateMock).toHaveBeenCalledTimes(1);
    expect(validateProjectPathsMock).toHaveBeenCalledTimes(1);
  });

  it('preserves reconnect generation and session reconciliation when autosave blocks workspace apply', async () => {
    hasPendingWorkspaceAutosaveChangesMock.mockReturnValue(true);
    const { syncBrowserStateFromReconnectSnapshot } = createBrowserStateSync(false);

    await syncBrowserStateFromReconnectSnapshot({
      agentGenerations: { 'agent-1': 8 },
      appStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      workspaceRevision: 1,
      workspaceStateJson:
        '{"projects":[],"taskOrder":[],"tasks":{},"activeTaskId":null,"sidebarVisible":true}',
      runningAgentIds: ['agent-1'],
    });

    expect(applyLoadedWorkspaceStateJsonMock).not.toHaveBeenCalled();
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
    expect(hydrateAgentGenerationMock).toHaveBeenCalledWith('agent-1', 8);
    expect(reconcileClientSessionStateMock).toHaveBeenCalledTimes(1);
    expect(showNotificationMock).toHaveBeenCalledWith(
      'Another browser updated the shared workspace while this tab has unsaved changes.',
    );
    expect(validateProjectPathsMock).not.toHaveBeenCalled();
  });

  it('does not overwrite local unsaved workspace changes during browser sync', async () => {
    hasPendingWorkspaceAutosaveChangesMock.mockReturnValue(true);
    const { syncBrowserStateFromServer } = createBrowserStateSync(false);

    await syncBrowserStateFromServer(true);

    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
    expect(markAutosaveCleanMock).not.toHaveBeenCalled();
    expect(showNotificationMock).toHaveBeenCalledWith(
      'Another browser updated the shared workspace while this tab has unsaved changes.',
    );
  });

  it('stays stable across repeated scheduled sync churn', async () => {
    const { cleanupBrowserStateSyncTimer, scheduleBrowserStateSync } =
      createBrowserStateSync(false);

    for (let index = 0; index < 20; index += 1) {
      scheduleBrowserStateSync(0, index % 2 === 0);
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(20);
    expect(markAutosaveCleanMock).toHaveBeenCalledTimes(20);
    expect(reconcileClientSessionStateMock).toHaveBeenCalledTimes(20);
    expect(validateProjectPathsMock).toHaveBeenCalledTimes(20);
    expectBrowserSyncDiagnostics({
      completed: 20,
      failed: 0,
      scheduled: 20,
      started: 20,
      superseded: 0,
    });

    cleanupBrowserStateSyncTimer();
  });
});
