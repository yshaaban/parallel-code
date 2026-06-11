import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnyServerStateBootstrapSnapshot } from '../domain/server-state-bootstrap';

const mockedState = vi.hoisted(() => ({
  fetchServerStateBootstrap: vi.fn<() => Promise<AnyServerStateBootstrapSnapshot[]>>(),
  gate: {
    complete: vi.fn(),
    dispose: vi.fn(),
    handle: vi.fn(),
    hydrate: vi.fn(),
  },
  listeners: {
    cleanupPersistentListeners: vi.fn(),
    cleanupStartupListeners: vi.fn(),
  },
}));

vi.mock('./server-state-bootstrap', () => ({
  createServerStateBootstrapGate: vi.fn(() => mockedState.gate),
  fetchServerStateBootstrap: mockedState.fetchServerStateBootstrap,
}));

vi.mock('./server-state-bootstrap-registry', () => ({
  createServerStateBootstrapCategoryDescriptors: vi.fn(() => ({})),
  createServerStateEventListeners: vi.fn(() => mockedState.listeners),
}));

import { createSessionBootstrapController } from './session-bootstrap-controller';
import {
  getDegradedBootstrapCategories,
  resetRendererRuntimeDiagnostics,
} from './runtime-diagnostics';
import { SERVER_STATE_BOOTSTRAP_CATEGORIES } from '../domain/server-state-bootstrap';

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  reject: (error?: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

describe('createSessionBootstrapController', () => {
  beforeEach(() => {
    mockedState.gate.complete.mockReset();
    mockedState.gate.dispose.mockReset();
    mockedState.gate.handle.mockReset();
    mockedState.gate.hydrate.mockReset();
    mockedState.listeners.cleanupPersistentListeners.mockReset();
    mockedState.listeners.cleanupStartupListeners.mockReset();
    mockedState.fetchServerStateBootstrap.mockReset();
  });

  it('does not fetch bootstrap snapshots in browser runtime', async () => {
    const controller = createSessionBootstrapController(false);

    await controller.hydrateInitialSnapshots();

    expect(mockedState.fetchServerStateBootstrap).not.toHaveBeenCalled();
    expect(mockedState.gate.hydrate).not.toHaveBeenCalled();
  });

  it('hydrates provided browser bootstrap snapshots without fetching server state again', async () => {
    const controller = createSessionBootstrapController(false);

    await controller.hydrateInitialSnapshots([
      {
        category: 'task-review',
        mode: 'replace',
        payload: [],
        version: 9,
      },
    ]);

    expect(mockedState.fetchServerStateBootstrap).not.toHaveBeenCalled();
    expect(mockedState.gate.hydrate).toHaveBeenCalledWith('task-review', [], 9);
  });

  it('fetches and hydrates bootstrap snapshots in electron runtime', async () => {
    mockedState.fetchServerStateBootstrap.mockResolvedValue([
      {
        category: 'task-review',
        mode: 'replace',
        payload: [],
        version: 42,
      },
    ] satisfies AnyServerStateBootstrapSnapshot[]);

    const controller = createSessionBootstrapController(true);

    await controller.hydrateInitialSnapshots();

    expect(mockedState.fetchServerStateBootstrap).toHaveBeenCalledTimes(1);
    expect(mockedState.gate.hydrate).toHaveBeenCalledWith('task-review', [], 42);
  });

  it('treats bootstrap fetch failures as an empty snapshot set', async () => {
    mockedState.fetchServerStateBootstrap.mockRejectedValue(new Error('network down'));
    const controller = createSessionBootstrapController(true);

    await controller.hydrateInitialSnapshots();

    expect(mockedState.gate.hydrate).not.toHaveBeenCalled();
  });

  it('cleans only startup listeners on complete and all listeners on dispose', () => {
    const controller = createSessionBootstrapController(true);

    controller.complete();

    expect(mockedState.gate.complete).toHaveBeenCalledTimes(1);
    expect(mockedState.listeners.cleanupStartupListeners).toHaveBeenCalledTimes(1);
    expect(mockedState.listeners.cleanupPersistentListeners).not.toHaveBeenCalled();

    controller.dispose();

    expect(mockedState.gate.dispose).toHaveBeenCalledTimes(1);
    expect(mockedState.listeners.cleanupPersistentListeners).toHaveBeenCalledTimes(1);
  });

  it('ignores late bootstrap snapshots after disposal', async () => {
    const deferred = createDeferredPromise<AnyServerStateBootstrapSnapshot[]>();
    mockedState.fetchServerStateBootstrap.mockReturnValue(deferred.promise);
    const controller = createSessionBootstrapController(true);

    const hydratePromise = controller.hydrateInitialSnapshots();
    controller.dispose();
    deferred.resolve([
      {
        category: 'task-review',
        mode: 'replace',
        payload: [],
        version: 7,
      },
    ]);
    await hydratePromise;

    expect(mockedState.gate.hydrate).not.toHaveBeenCalled();
  });

  it('ignores late bootstrap snapshots after startup completes', async () => {
    const deferred = createDeferredPromise<AnyServerStateBootstrapSnapshot[]>();
    mockedState.fetchServerStateBootstrap.mockReturnValue(deferred.promise);
    const controller = createSessionBootstrapController(true);

    const hydratePromise = controller.hydrateInitialSnapshots();
    controller.complete();
    deferred.resolve([
      {
        category: 'task-review',
        mode: 'replace',
        payload: [],
        version: 8,
      },
    ]);
    await hydratePromise;

    expect(mockedState.gate.hydrate).not.toHaveBeenCalled();
  });
});

describe('degraded bootstrap category handling', () => {
  beforeEach(() => {
    mockedState.gate.complete.mockReset();
    mockedState.gate.dispose.mockReset();
    mockedState.gate.handle.mockReset();
    mockedState.gate.hydrate.mockReset();
    mockedState.fetchServerStateBootstrap.mockReset();
    resetRendererRuntimeDiagnostics();
    vi.useRealTimers();
  });

  it('records degraded categories, keeps prior state, and retries them targetedly', async () => {
    vi.useFakeTimers();
    const controller = createSessionBootstrapController(false);

    await controller.hydrateInitialSnapshots([
      { category: 'git-status', mode: 'replace', payload: [], version: 3 },
      { category: 'coordinator', degraded: true, error: 'builder exploded' },
    ]);

    // Healthy categories hydrate; the degraded one is skipped (prior state kept).
    expect(mockedState.gate.hydrate).toHaveBeenCalledTimes(1);
    expect(mockedState.gate.hydrate).toHaveBeenCalledWith('git-status', [], 3);
    expect(getDegradedBootstrapCategories()).toEqual(['coordinator']);

    mockedState.fetchServerStateBootstrap.mockResolvedValue([
      { category: 'git-status', mode: 'replace', payload: [], version: 4 },
      {
        category: 'coordinator',
        mode: 'replace',
        payload: { generatedAt: 1, runs: [], stateVersion: 1 },
        version: 1,
      },
    ] as AnyServerStateBootstrapSnapshot[]);

    await vi.advanceTimersByTimeAsync(5_100);
    await Promise.resolve();

    // The retry applies only the previously degraded category and clears it.
    expect(mockedState.fetchServerStateBootstrap).toHaveBeenCalledTimes(1);
    expect(mockedState.gate.hydrate).toHaveBeenCalledTimes(2);
    expect(mockedState.gate.hydrate).toHaveBeenLastCalledWith(
      'coordinator',
      { generatedAt: 1, runs: [], stateVersion: 1 },
      1,
    );
    expect(getDegradedBootstrapCategories()).toEqual([]);

    controller.dispose();
    vi.useRealTimers();
  });

  it('marks every category degraded after both initial fetch attempts fail', async () => {
    vi.useFakeTimers();
    mockedState.fetchServerStateBootstrap.mockRejectedValue(new Error('backend down'));
    const controller = createSessionBootstrapController(true);

    await controller.hydrateInitialSnapshots();

    expect(mockedState.fetchServerStateBootstrap).toHaveBeenCalledTimes(2);
    expect(getDegradedBootstrapCategories().sort()).toEqual(
      [...SERVER_STATE_BOOTSTRAP_CATEGORIES].sort(),
    );
    expect(mockedState.gate.hydrate).not.toHaveBeenCalled();

    controller.dispose();
    vi.useRealTimers();
  });
});
