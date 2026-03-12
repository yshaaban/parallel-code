import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const {
  invokeMock,
  loadStateMock,
  markAgentExitedMock,
  markAgentRunningMock,
  markAutosaveCleanMock,
  setAgentStatusMock,
  showNotificationMock,
  storeState,
  validateProjectPathsMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  loadStateMock: vi.fn(),
  markAgentExitedMock: vi.fn(),
  markAgentRunningMock: vi.fn(),
  markAutosaveCleanMock: vi.fn(),
  setAgentStatusMock: vi.fn(),
  showNotificationMock: vi.fn(),
  storeState: {
    agents: {} as Record<string, { id: string; status: string }>,
  },
  validateProjectPathsMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../store/autosave', () => ({
  markAutosaveClean: markAutosaveCleanMock,
}));

vi.mock('../store/store', () => ({
  loadState: loadStateMock,
  markAgentExited: markAgentExitedMock,
  markAgentRunning: markAgentRunningMock,
  setAgentStatus: setAgentStatusMock,
  showNotification: showNotificationMock,
  store: storeState,
  validateProjectPaths: validateProjectPathsMock,
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

describe('server-sync reliability contracts', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    storeState.agents = {};
    loadStateMock.mockResolvedValue(undefined);
    validateProjectPathsMock.mockResolvedValue(undefined);
    invokeMock.mockResolvedValue([]);
    installTimerWindow();
  });

  afterEach(() => {
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
    expect(markAgentExitedMock).toHaveBeenCalledWith('agent-4', {
      exit_code: 17,
      signal: 'SIGTERM',
      last_output: [],
    });
  });

  it('updates known non-exited agents from server snapshots and ignores unknown or exited entries', () => {
    storeState.agents = {
      'agent-1': { id: 'agent-1', status: 'running' },
      'agent-2': { id: 'agent-2', status: 'running' },
    };

    syncAgentStatusesFromServer([
      { agentId: 'agent-1', status: 'paused' },
      { agentId: 'agent-2', status: 'exited' },
      { agentId: 'agent-missing', status: 'running' },
    ]);

    expect(setAgentStatusMock).toHaveBeenCalledTimes(1);
    expect(setAgentStatusMock).toHaveBeenCalledWith('agent-1', 'paused');
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

    expect(loadStateMock).toHaveBeenCalledTimes(1);
    expect(markAutosaveCleanMock).toHaveBeenCalledTimes(1);
    expect(validateProjectPathsMock).toHaveBeenCalledTimes(1);
    expect(showNotificationMock).toHaveBeenCalledWith('State updated in another browser tab');

    cleanupBrowserStateSyncTimer();
  });

  it('surfaces sync failures with one explicit browser-state notification', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadStateMock.mockRejectedValue(new Error('load failed'));
    const { syncBrowserStateFromServer } = createBrowserStateSync(false);

    await syncBrowserStateFromServer();

    expect(showNotificationMock).toHaveBeenCalledWith('Failed to sync browser state from server');
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to sync browser state from server:',
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it('queues one follow-up browser sync while a sync is already in flight', async () => {
    const firstLoad = createDeferred<undefined>();
    loadStateMock.mockReturnValueOnce(firstLoad.promise);
    loadStateMock.mockResolvedValueOnce(undefined);

    const { scheduleBrowserStateSync } = createBrowserStateSync(false);

    scheduleBrowserStateSync(0, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadStateMock).toHaveBeenCalledTimes(1);

    scheduleBrowserStateSync(25, true);
    firstLoad.resolve(undefined);
    await firstLoad.promise;
    await vi.advanceTimersByTimeAsync(0);

    expect(loadStateMock).toHaveBeenCalledTimes(2);
    expect(showNotificationMock).toHaveBeenCalledWith('State updated in another browser tab');
  });

  it('preserves notify=true for a queued sync while a sync is already in flight', async () => {
    const firstLoad = createDeferred<undefined>();
    loadStateMock.mockReturnValueOnce(firstLoad.promise);
    loadStateMock.mockResolvedValueOnce(undefined);

    const { scheduleBrowserStateSync } = createBrowserStateSync(false);

    scheduleBrowserStateSync(0, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadStateMock).toHaveBeenCalledTimes(1);

    scheduleBrowserStateSync(25, true);
    scheduleBrowserStateSync(25, false);

    firstLoad.resolve(undefined);
    await firstLoad.promise;
    await vi.advanceTimersByTimeAsync(0);

    expect(loadStateMock).toHaveBeenCalledTimes(2);
    expect(showNotificationMock).toHaveBeenCalledWith('State updated in another browser tab');
  });

  it('preserves notify=true when rescheduling a browser sync before the timer fires', async () => {
    const { scheduleBrowserStateSync } = createBrowserStateSync(false);

    scheduleBrowserStateSync(50, true);
    scheduleBrowserStateSync(10, false);

    await vi.advanceTimersByTimeAsync(10);

    expect(loadStateMock).toHaveBeenCalledTimes(1);
    expect(showNotificationMock).toHaveBeenCalledWith('State updated in another browser tab');
  });

  it('reuses an in-flight direct browser sync instead of starting a second load immediately', async () => {
    const firstLoad = createDeferred<undefined>();
    loadStateMock.mockReturnValueOnce(firstLoad.promise);

    const { syncBrowserStateFromServer } = createBrowserStateSync(false);

    const firstSync = syncBrowserStateFromServer(false);
    const secondSync = syncBrowserStateFromServer(true);

    expect(loadStateMock).toHaveBeenCalledTimes(1);

    firstLoad.resolve(undefined);
    await Promise.all([firstSync, secondSync]);

    expect(loadStateMock).toHaveBeenCalledTimes(1);
    expect(showNotificationMock).toHaveBeenCalledWith('State updated in another browser tab');
  });
});
