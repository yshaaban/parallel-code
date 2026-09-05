import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserColdBootstrapProjection } from '../domain/browser-cold-bootstrap';
import type { BrowserColdBootstrapSnapshot } from '../domain/renderer-invoke';

const {
  applyBrowserColdBootstrapWorkspaceProjectionMock,
  emitStartupBreadcrumbMock,
  fetchBrowserColdBootstrapMock,
  loadedWorkspaceState,
  loadWorkspaceStateMock,
  showNotificationMock,
  storeState,
  takeBrowserColdBootstrapHandoffProjectionMock,
} = vi.hoisted(() => ({
  applyBrowserColdBootstrapWorkspaceProjectionMock: vi.fn(),
  emitStartupBreadcrumbMock: vi.fn(),
  fetchBrowserColdBootstrapMock: vi.fn(),
  loadedWorkspaceState: { json: null as string | null },
  loadWorkspaceStateMock: vi.fn(),
  showNotificationMock: vi.fn(),
  storeState: {
    availableAgents: [{ id: 'available-agent' }],
    collapsedTaskOrder: [] as string[],
    customAgents: [{ id: 'custom-agent' }],
    projects: [] as unknown[],
    taskOrder: [] as string[],
    tasks: {} as Record<string, unknown>,
    terminals: {} as Record<string, unknown>,
  },
  takeBrowserColdBootstrapHandoffProjectionMock: vi.fn(),
}));

vi.mock('./browser-cold-bootstrap', () => ({
  fetchBrowserColdBootstrap: fetchBrowserColdBootstrapMock,
}));

vi.mock('../store/browser-cold-bootstrap-handoff', () => ({
  takeBrowserColdBootstrapHandoffProjection: takeBrowserColdBootstrapHandoffProjectionMock,
}));

vi.mock('../store/persistence-load', () => ({
  applyBrowserColdBootstrapWorkspaceProjection: applyBrowserColdBootstrapWorkspaceProjectionMock,
  loadWorkspaceState: loadWorkspaceStateMock,
}));

vi.mock('../store/notification', () => ({
  showNotification: showNotificationMock,
}));

vi.mock('../store/persistence-session', () => ({
  getLoadedWorkspaceStateJson: () => loadedWorkspaceState.json,
}));

vi.mock('../store/state', () => ({
  store: storeState,
}));

vi.mock('./startup-breadcrumbs', () => ({
  emitStartupBreadcrumb: emitStartupBreadcrumbMock,
}));

import {
  BROWSER_COLD_START_ACQUISITION_TIMEOUT_MS,
  startBrowserWorkspaceColdStartRecovery,
} from './browser-workspace-cold-start-recovery';

function createEmptyProjection(): BrowserColdBootstrapProjection {
  return {
    availableAgents: [],
    collapsedTaskOrder: [],
    completedTaskCount: 0,
    completedTaskDate: '2026-07-17',
    customAgents: [],
    hydraCommand: '',
    hydraForceDispatchFromPromptPanel: true,
    hydraStartupMode: 'auto',
    lastProjectId: null,
    mergedLinesAdded: 0,
    mergedLinesRemoved: 0,
    mergeProgress: null,
    projects: [],
    taskOrder: [],
    tasks: {},
    terminals: {},
  };
}

function createSnapshot(
  workspaceProjection: BrowserColdBootstrapProjection,
  workspaceRevision = 0,
): BrowserColdBootstrapSnapshot {
  return {
    serverStateBootstrap: [],
    workspaceProjection,
    workspaceRevision,
  };
}

function createRecoveryOptions() {
  return {
    ensureAgentCatalogRefresh: vi.fn().mockResolvedValue(undefined),
    isDisposed: vi.fn(() => false),
    scheduleImmediateSync: vi.fn(),
    wait: vi.fn().mockResolvedValue(true),
  };
}

describe('browser workspace cold-start recovery', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    storeState.projects = [];
    storeState.taskOrder = [];
    storeState.collapsedTaskOrder = [];
    storeState.tasks = {};
    storeState.terminals = {};
    loadedWorkspaceState.json = null;
    fetchBrowserColdBootstrapMock.mockResolvedValue(createSnapshot(createEmptyProjection(), 7));
    loadWorkspaceStateMock.mockResolvedValue(false);
    takeBrowserColdBootstrapHandoffProjectionMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts the fetch immediately and treats an empty projection as complete state', async () => {
    const options = createRecoveryOptions();
    const recovery = startBrowserWorkspaceColdStartRecovery(options);

    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);

    const result = await recovery.restore();

    expect(result).toEqual({
      coldBootstrap: createSnapshot(createEmptyProjection(), 7),
      shouldSchedulePostRestoreSync: false,
    });
    expect(applyBrowserColdBootstrapWorkspaceProjectionMock).toHaveBeenCalledWith(
      createEmptyProjection(),
      7,
    );
    expect(emitStartupBreadcrumbMock).toHaveBeenCalledWith(
      'desktop-startup:browser-projection-applied',
    );
    expect(options.ensureAgentCatalogRefresh).not.toHaveBeenCalled();
    expect(takeBrowserColdBootstrapHandoffProjectionMock).not.toHaveBeenCalled();
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
    expect(options.wait).not.toHaveBeenCalled();
  });

  it('retries a transient bootstrap failure with the exact bounded delay policy', async () => {
    const options = createRecoveryOptions();
    const snapshot = createSnapshot(createEmptyProjection(), 11);
    fetchBrowserColdBootstrapMock
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce(snapshot);

    const result = await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(result?.coldBootstrap).toBe(snapshot);
    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(2);
    expect(options.wait).toHaveBeenCalledTimes(1);
    expect(options.wait).toHaveBeenCalledWith(75);
    expect(applyBrowserColdBootstrapWorkspaceProjectionMock).toHaveBeenCalledWith(
      snapshot.workspaceProjection,
      11,
    );
  });

  it('refreshes the catalog before consuming the one-shot handoff projection', async () => {
    const options = createRecoveryOptions();
    const handoffProjection = createEmptyProjection();
    fetchBrowserColdBootstrapMock.mockRejectedValue(new Error('bootstrap unavailable'));
    takeBrowserColdBootstrapHandoffProjectionMock.mockReturnValue(handoffProjection);

    const result = await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(result).toEqual({
      coldBootstrap: null,
      shouldSchedulePostRestoreSync: true,
    });
    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(3);
    expect(options.wait.mock.calls).toEqual([[75], [200]]);
    expect(options.ensureAgentCatalogRefresh).toHaveBeenCalledTimes(1);
    expect(takeBrowserColdBootstrapHandoffProjectionMock).toHaveBeenCalledWith({
      currentAvailableAgents: storeState.availableAgents,
      currentCustomAgents: storeState.customAgents,
    });
    expect(options.ensureAgentCatalogRefresh.mock.invocationCallOrder[0]).toBeLessThan(
      takeBrowserColdBootstrapHandoffProjectionMock.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(applyBrowserColdBootstrapWorkspaceProjectionMock).toHaveBeenCalledWith(
      handoffProjection,
      0,
    );
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
    expect(showNotificationMock).not.toHaveBeenCalled();
    expect(options.scheduleImmediateSync).not.toHaveBeenCalled();
  });

  it('falls back to canonical workspace state after three null bootstrap attempts', async () => {
    const options = createRecoveryOptions();
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);
    loadWorkspaceStateMock.mockResolvedValue(true);

    const result = await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(result).toEqual({
      coldBootstrap: null,
      shouldSchedulePostRestoreSync: false,
    });
    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(3);
    expect(options.wait.mock.calls).toEqual([[75], [200]]);
    expect(options.ensureAgentCatalogRefresh).toHaveBeenCalledTimes(1);
    expect(takeBrowserColdBootstrapHandoffProjectionMock).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(1);
    expect(showNotificationMock).not.toHaveBeenCalled();
  });

  it('uses the same bounded retry policy for transient canonical-load failures', async () => {
    const options = createRecoveryOptions();
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);
    loadWorkspaceStateMock
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('transient load failure'))
      .mockResolvedValueOnce(true);

    const result = await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(result?.shouldSchedulePostRestoreSync).toBe(false);
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(3);
    expect(options.wait.mock.calls).toEqual([[75], [200], [75], [200]]);
    expect(showNotificationMock).not.toHaveBeenCalled();
    expect(options.scheduleImmediateSync).not.toHaveBeenCalled();
  });

  it('does not let local panel shape masquerade as a loaded shared workspace snapshot', async () => {
    const options = createRecoveryOptions();
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);
    loadWorkspaceStateMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        storeState.terminals = { 'terminal-1': { id: 'terminal-1' } };
        return false;
      });

    const result = await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(result?.shouldSchedulePostRestoreSync).toBe(false);
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(6);
    expect(options.wait.mock.calls).toEqual([[75], [200], [75], [200], [150], [300], [600]]);
    expect(showNotificationMock).toHaveBeenCalledWith(
      'Browser cold bootstrap did not restore shared workspace state after retries.',
      { kind: 'error' },
    );
    expect(options.scheduleImmediateSync).toHaveBeenCalledTimes(1);
  });

  it('accepts an explicit empty canonical snapshot as shared workspace authority', async () => {
    const options = createRecoveryOptions();
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);
    loadWorkspaceStateMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        loadedWorkspaceState.json = '{}';
        return false;
      });

    const result = await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(result?.shouldSchedulePostRestoreSync).toBe(false);
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(3);
    expect(options.wait.mock.calls).toEqual([[75], [200], [75], [200]]);
    expect(showNotificationMock).not.toHaveBeenCalled();
    expect(options.scheduleImmediateSync).not.toHaveBeenCalled();
  });

  it('does not reload after canonical authority arrives during a recovery delay', async () => {
    const options = createRecoveryOptions();
    options.wait.mockImplementation(async (delayMs: number) => {
      if (delayMs === 150) {
        loadedWorkspaceState.json = '{}';
      }
      return true;
    });
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);
    loadWorkspaceStateMock.mockResolvedValue(false);

    await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(3);
    expect(options.wait.mock.calls).toEqual([[75], [200], [75], [200], [150]]);
    expect(showNotificationMock).not.toHaveBeenCalled();
    expect(options.scheduleImmediateSync).not.toHaveBeenCalled();
  });

  it('keeps a recovered bootstrap error in the final visible failure message', async () => {
    const options = createRecoveryOptions();
    const bootstrapError = new Error('bootstrap temporarily unavailable');
    const workspaceError = new Error('workspace unavailable');
    fetchBrowserColdBootstrapMock.mockRejectedValueOnce(bootstrapError).mockResolvedValue(null);
    loadWorkspaceStateMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockRejectedValue(workspaceError);

    const result = await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(result?.coldBootstrap).toBeNull();
    expect(options.wait.mock.calls).toEqual([[75], [200], [75], [200], [150], [300], [600]]);
    expect(showNotificationMock).toHaveBeenCalledWith(
      'Failed to restore browser workspace during cold bootstrap: bootstrap temporarily unavailable; workspace unavailable',
      { kind: 'error' },
    );
    expect(options.scheduleImmediateSync).toHaveBeenCalledTimes(1);
  });

  it('retains an initial canonical-load error when delayed recovery only returns false', async () => {
    const options = createRecoveryOptions();
    const workspaceError = new Error('initial workspace load failed');
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);
    loadWorkspaceStateMock.mockRejectedValueOnce(workspaceError).mockResolvedValue(false);

    await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(showNotificationMock).toHaveBeenCalledWith(
      'Failed to restore browser workspace during cold bootstrap: initial workspace load failed',
      { kind: 'error' },
    );
    expect(options.scheduleImmediateSync).toHaveBeenCalledTimes(1);
  });

  it('uses the generic visible failure when every attempt returns empty state', async () => {
    const options = createRecoveryOptions();
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);
    loadWorkspaceStateMock.mockResolvedValue(false);

    const result = await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(result).toEqual({
      coldBootstrap: null,
      shouldSchedulePostRestoreSync: false,
    });
    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(3);
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(6);
    expect(options.wait.mock.calls).toEqual([[75], [200], [75], [200], [150], [300], [600]]);
    expect(showNotificationMock).toHaveBeenCalledWith(
      'Browser cold bootstrap did not restore shared workspace state after retries.',
      { kind: 'error' },
    );
    expect(options.scheduleImmediateSync).toHaveBeenCalledTimes(1);
  });

  it('normalizes undefined and blank rejections into the generic visible failure', async () => {
    const options = createRecoveryOptions();
    fetchBrowserColdBootstrapMock.mockRejectedValue(undefined);
    loadWorkspaceStateMock.mockRejectedValue(new Error('   '));

    await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(showNotificationMock).toHaveBeenCalledWith(
      'Browser cold bootstrap did not restore shared workspace state after retries.',
      { kind: 'error' },
    );
    expect(showNotificationMock).not.toHaveBeenCalledWith(
      expect.stringContaining('undefined'),
      expect.anything(),
    );
  });

  it('aborts a timed-out bootstrap acquisition before retrying', async () => {
    vi.useFakeTimers();
    const options = createRecoveryOptions();
    const snapshot = createSnapshot(createEmptyProjection(), 13);
    const firstAttempt = { signal: null as AbortSignal | null };
    fetchBrowserColdBootstrapMock
      .mockImplementationOnce((signal: AbortSignal) => {
        firstAttempt.signal = signal;
        return new Promise(() => undefined);
      })
      .mockResolvedValueOnce(snapshot);

    const restore = startBrowserWorkspaceColdStartRecovery(options).restore();
    await vi.advanceTimersByTimeAsync(BROWSER_COLD_START_ACQUISITION_TIMEOUT_MS);

    await expect(restore).resolves.toEqual({
      coldBootstrap: snapshot,
      shouldSchedulePostRestoreSync: false,
    });
    expect(firstAttempt.signal?.aborted).toBe(true);
    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(2);
    expect(options.wait).toHaveBeenCalledWith(75);
  });

  it('bounds a hung catalog refresh and continues with canonical workspace recovery', async () => {
    vi.useFakeTimers();
    const options = createRecoveryOptions();
    const catalog = { signal: null as AbortSignal | null };
    options.ensureAgentCatalogRefresh.mockImplementation((signal: AbortSignal) => {
      catalog.signal = signal;
      return new Promise(() => undefined);
    });
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);
    loadWorkspaceStateMock.mockResolvedValue(true);

    const restore = startBrowserWorkspaceColdStartRecovery(options).restore();
    await vi.advanceTimersByTimeAsync(BROWSER_COLD_START_ACQUISITION_TIMEOUT_MS);

    await expect(restore).resolves.toEqual({
      coldBootstrap: null,
      shouldSchedulePostRestoreSync: false,
    });
    expect(catalog.signal?.aborted).toBe(true);
    expect(loadWorkspaceStateMock).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight acquisition and settles restore without fallback effects', async () => {
    const options = createRecoveryOptions();
    const acquisition = { signal: null as AbortSignal | null };
    fetchBrowserColdBootstrapMock.mockImplementation((signal: AbortSignal) => {
      acquisition.signal = signal;
      return new Promise(() => undefined);
    });
    const recovery = startBrowserWorkspaceColdStartRecovery(options);
    const restore = recovery.restore();

    recovery.cancel();

    expect(acquisition.signal?.aborted).toBe(true);
    await expect(restore).resolves.toBeNull();
    expect(options.ensureAgentCatalogRefresh).not.toHaveBeenCalled();
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
    expect(showNotificationMock).not.toHaveBeenCalled();
    expect(options.scheduleImmediateSync).not.toHaveBeenCalled();
  });

  it('stops before fallback effects when session cleanup cancels a retry wait', async () => {
    let disposed = false;
    const options = {
      ...createRecoveryOptions(),
      isDisposed: vi.fn(() => disposed),
      wait: vi.fn(async () => {
        disposed = true;
        return false;
      }),
    };
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);

    const result = await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(result).toBeNull();
    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);
    expect(options.ensureAgentCatalogRefresh).not.toHaveBeenCalled();
    expect(takeBrowserColdBootstrapHandoffProjectionMock).not.toHaveBeenCalled();
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
    expect(showNotificationMock).not.toHaveBeenCalled();
    expect(options.scheduleImmediateSync).not.toHaveBeenCalled();
  });

  it('stops after catalog refresh when the session is disposed', async () => {
    let disposed = false;
    const options = {
      ...createRecoveryOptions(),
      ensureAgentCatalogRefresh: vi.fn(async () => {
        disposed = true;
      }),
      isDisposed: vi.fn(() => disposed),
    };
    fetchBrowserColdBootstrapMock.mockResolvedValue(null);

    const result = await startBrowserWorkspaceColdStartRecovery(options).restore();

    expect(result).toBeNull();
    expect(options.ensureAgentCatalogRefresh).toHaveBeenCalledTimes(1);
    expect(takeBrowserColdBootstrapHandoffProjectionMock).not.toHaveBeenCalled();
    expect(loadWorkspaceStateMock).not.toHaveBeenCalled();
  });

  it('memoizes restore so destructive fallback effects can only run once', async () => {
    const options = createRecoveryOptions();
    const recovery = startBrowserWorkspaceColdStartRecovery(options);

    const [firstResult, secondResult] = await Promise.all([recovery.restore(), recovery.restore()]);

    expect(secondResult).toBe(firstResult);
    expect(fetchBrowserColdBootstrapMock).toHaveBeenCalledTimes(1);
    expect(applyBrowserColdBootstrapWorkspaceProjectionMock).toHaveBeenCalledTimes(1);
  });
});
