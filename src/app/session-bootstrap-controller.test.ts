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
});
