import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SERVER_STATE_BOOTSTRAP_CATEGORIES,
  type ServerStateBootstrapCategory,
} from '../domain/server-state-bootstrap';

const listenerState = vi.hoisted(() => {
  function createListenerRegistry<TPayload>(): Map<string, Set<(payload: TPayload) => void>> {
    return new Map<string, Set<(payload: TPayload) => void>>();
  }

  function registerListener<TPayload>(
    listeners: Map<string, Set<(payload: TPayload) => void>>,
    channel: string,
    listener: (payload: TPayload) => void,
  ): () => void {
    const channelListeners = listeners.get(channel) ?? new Set<(payload: TPayload) => void>();
    channelListeners.add(listener);
    listeners.set(channel, channelListeners);
    return () => {
      channelListeners.delete(listener);
      if (channelListeners.size === 0) {
        listeners.delete(channel);
      }
    };
  }

  return {
    ipcEventListeners: createListenerRegistry<unknown>(),
    registerListener,
    serverMessageListeners: createListenerRegistry<unknown>(),
  };
});

vi.mock('../lib/ipc', () => ({
  listenServerMessage: vi.fn((type: string, listener: (payload: unknown) => void) =>
    listenerState.registerListener(listenerState.serverMessageListeners, type, listener),
  ),
}));

vi.mock('../lib/ipc-events', () => {
  function listenIpcEvent(channel: string, listener: (payload: unknown) => void): () => void {
    return listenerState.registerListener(listenerState.ipcEventListeners, channel, listener);
  }

  return {
    listenAgentSupervisionChanged: vi.fn((listener: (payload: unknown) => void) =>
      listenIpcEvent('agent-supervision-changed', listener),
    ),
    listenCoordinatorChanged: vi.fn((listener: (payload: unknown) => void) =>
      listenIpcEvent('coordinator-changed', listener),
    ),
    listenGitStatusChanged: vi.fn((listener: (payload: unknown) => void) =>
      listenIpcEvent('git-status-changed', listener),
    ),
    listenRemoteStatusChanged: vi.fn((listener: (payload: unknown) => void) =>
      listenIpcEvent('remote-status', listener),
    ),
    listenTaskCommandControllerChanged: vi.fn((listener: (payload: unknown) => void) =>
      listenIpcEvent('task-command-controller-changed', listener),
    ),
    listenTaskConvergenceChanged: vi.fn((listener: (payload: unknown) => void) =>
      listenIpcEvent('task-convergence-changed', listener),
    ),
    listenTaskPortsChanged: vi.fn((listener: (payload: unknown) => void) =>
      listenIpcEvent('task-ports-changed', listener),
    ),
    listenTaskReviewChanged: vi.fn((listener: (payload: unknown) => void) =>
      listenIpcEvent('task-review-changed', listener),
    ),
    listenTaskReviewSignalsChanged: vi.fn((listener: (payload: unknown) => void) =>
      listenIpcEvent('task-review-signals-changed', listener),
    ),
    listenTaskStepsChanged: vi.fn((listener: (payload: unknown) => void) =>
      listenIpcEvent('task-steps-changed', listener),
    ),
  };
});

import {
  createServerStateBootstrapCategoryDescriptors,
  createServerStateEventListeners,
  getServerStateBootstrapRegistryCategories,
  getServerStateListenerScope,
} from './server-state-bootstrap-registry';

function sortCategories(
  categories: ReadonlyArray<ServerStateBootstrapCategory>,
): ServerStateBootstrapCategory[] {
  return [...categories].sort();
}

describe('server state bootstrap registry guardrails', () => {
  function emitServerMessage(type: string, payload: unknown): void {
    for (const listener of listenerState.serverMessageListeners.get(type) ?? []) {
      listener(payload);
    }
  }

  function createStartupGate() {
    return {
      handle: vi.fn(),
      hydrate: vi.fn(),
    };
  }

  function clearListenerState(): void {
    listenerState.ipcEventListeners.clear();
    listenerState.serverMessageListeners.clear();
  }

  afterEach(() => {
    clearListenerState();
  });

  it('registers every bootstrap category exactly once', () => {
    expect(sortCategories(getServerStateBootstrapRegistryCategories())).toEqual(
      sortCategories(SERVER_STATE_BOOTSTRAP_CATEGORIES),
    );
  });

  it('creates descriptors for every bootstrap category', () => {
    const descriptors = createServerStateBootstrapCategoryDescriptors();

    for (const category of SERVER_STATE_BOOTSTRAP_CATEGORIES) {
      expect(descriptors[category]).toBeDefined();
    }

    expect(Object.keys(descriptors)).toHaveLength(SERVER_STATE_BOOTSTRAP_CATEGORIES.length);
  });

  it('defines explicit listener scopes for browser and electron runtimes', () => {
    const expectedScopes = {
      'agent-supervision': { browser: 'persistent', electron: 'persistent' },
      coordinator: { browser: 'persistent', electron: 'persistent' },
      'git-status': { browser: 'persistent', electron: 'persistent' },
      'peer-presence': { browser: 'none', electron: 'none' },
      'remote-status': { browser: 'persistent', electron: 'persistent' },
      'task-command-controller': { browser: 'persistent', electron: 'persistent' },
      'task-convergence': { browser: 'persistent', electron: 'persistent' },
      'task-review': { browser: 'persistent', electron: 'persistent' },
      'task-review-signals': { browser: 'persistent', electron: 'persistent' },
      'task-steps': { browser: 'persistent', electron: 'persistent' },
      'task-ports': { browser: 'persistent', electron: 'persistent' },
    } as const satisfies Record<
      ServerStateBootstrapCategory,
      { browser: string; electron: string }
    >;

    for (const category of SERVER_STATE_BOOTSTRAP_CATEGORIES) {
      expect(getServerStateListenerScope(category, 'browser')).toBe(
        expectedScopes[category].browser,
      );
      expect(getServerStateListenerScope(category, 'electron')).toBe(
        expectedScopes[category].electron,
      );
    }
  });

  it('does not introduce browser registry listener categories without an Electron listener path', () => {
    for (const category of SERVER_STATE_BOOTSTRAP_CATEGORIES) {
      const browserScope = getServerStateListenerScope(category, 'browser');
      const electronScope = getServerStateListenerScope(category, 'electron');

      if (browserScope !== 'none') {
        expect(electronScope, `${category} electron listener scope`).not.toBe('none');
      }
    }
  });

  it('routes browser bootstrap-owned state messages through the startup gate persistently', () => {
    const startupGate = createStartupGate();
    const listeners = createServerStateEventListeners(false, startupGate);

    emitServerMessage('git-status-changed', {
      branchName: 'feature/task-1',
      worktreePath: '/tmp/task-1',
    });
    expect(startupGate.handle).toHaveBeenCalledWith('git-status', {
      branchName: 'feature/task-1',
      worktreePath: '/tmp/task-1',
    });

    emitServerMessage('remote-status', {
      connectedClients: 2,
      peerClients: 1,
    });
    expect(startupGate.handle).toHaveBeenCalledWith('remote-status', {
      connectedClients: 2,
      peerClients: 1,
    });

    emitServerMessage('coordinator-event', {
      event: {
        categorySeq: 1,
        createdAt: 1_000,
        entityKey: 'run:run-1',
        entityVersion: 1,
        eventType: 'run-removed',
        payload: null,
        runId: 'run-1',
        tombstone: true,
      },
    });
    expect(startupGate.handle).toHaveBeenCalledWith('coordinator', {
      categorySeq: 1,
      createdAt: 1_000,
      entityKey: 'run:run-1',
      entityVersion: 1,
      eventType: 'run-removed',
      payload: null,
      runId: 'run-1',
      tombstone: true,
    });

    emitServerMessage('task-ports-changed', {
      kind: 'snapshot',
      taskId: 'task-1',
      observed: [],
      exposed: [],
      stateVersion: 7,
      updatedAt: 1_000,
    });
    expect(startupGate.handle).toHaveBeenCalledWith('task-ports', {
      kind: 'snapshot',
      taskId: 'task-1',
      observed: [],
      exposed: [],
      stateVersion: 7,
      updatedAt: 1_000,
    });

    emitServerMessage('task-ports-changed', {
      kind: 'removed',
      removed: true,
      stateVersion: 8,
      taskId: 'task-1',
    });
    expect(startupGate.handle).toHaveBeenCalledWith('task-ports', {
      kind: 'removed',
      removed: true,
      stateVersion: 8,
      taskId: 'task-1',
    });

    emitServerMessage('state-bootstrap', {
      snapshots: [
        {
          category: 'task-review',
          mode: 'replace',
          payload: [],
          version: 9,
        },
      ],
    });
    expect(startupGate.hydrate).toHaveBeenCalledWith('task-review', [], 9);

    listeners.cleanupStartupListeners();
    startupGate.handle.mockClear();
    startupGate.hydrate.mockClear();

    emitServerMessage('task-ports-changed', {
      kind: 'snapshot',
      taskId: 'task-2',
      observed: [],
      exposed: [],
      updatedAt: 2_000,
    });
    expect(startupGate.handle).toHaveBeenCalledWith('task-ports', {
      kind: 'snapshot',
      taskId: 'task-2',
      observed: [],
      exposed: [],
      updatedAt: 2_000,
    });

    listeners.cleanupPersistentListeners();
    startupGate.handle.mockClear();

    emitServerMessage('git-status-changed', {
      worktreePath: '/tmp/task-2',
    });
    expect(startupGate.handle).not.toHaveBeenCalled();
  });

  it('drops malformed browser server-state messages before the startup gate', () => {
    const startupGate = createStartupGate();
    const listeners = createServerStateEventListeners(false, startupGate);

    emitServerMessage('task-ports-changed', {
      kind: 'removed',
      removed: false,
      taskId: 'task-1',
    });
    emitServerMessage('git-status-changed', {
      status: {
        has_committed_changes: true,
      },
      worktreePath: '/tmp/task-1',
    });
    emitServerMessage('state-bootstrap', {
      snapshots: [
        {
          category: 'task-review',
          mode: 'replace',
          payload: [
            {
              branchName: 'feature/task-1',
              files: [],
              projectId: 'project-1',
              revisionId: 'rev-1',
              source: 'cache',
              taskId: 'task-1',
              totalAdded: 0,
              totalRemoved: 0,
              updatedAt: 10,
              worktreePath: '/tmp/task-1',
            },
          ],
          version: 1,
        },
      ],
    });
    emitServerMessage('state-bootstrap', {
      snapshots: 'not-an-array',
    });
    emitServerMessage('coordinator-event', {
      event: {
        categorySeq: 1,
        createdAt: 1_000,
        entityKey: 'run:run-1',
        entityVersion: 1,
        eventType: 'run-upserted',
        payload: { id: 'run-1' },
        runId: 'run-1',
      },
    });

    expect(startupGate.handle).not.toHaveBeenCalled();
    expect(startupGate.hydrate).not.toHaveBeenCalled();

    listeners.cleanupPersistentListeners();
  });

  it('keeps valid browser bootstrap entries when sibling entries are malformed', () => {
    const startupGate = createStartupGate();
    const listeners = createServerStateEventListeners(false, startupGate);
    const validTaskReview = {
      branchName: 'feature/task-1',
      files: [],
      projectId: 'project-1',
      revisionId: 'rev-1',
      source: 'worktree',
      taskId: 'task-1',
      totalAdded: 0,
      totalRemoved: 0,
      updatedAt: 10,
      worktreePath: '/tmp/task-1',
    };

    emitServerMessage('state-bootstrap', {
      snapshots: [
        {
          category: 'task-review',
          mode: 'replace',
          payload: [
            validTaskReview,
            {
              ...validTaskReview,
              source: 'cache',
              taskId: 'task-invalid',
            },
          ],
          version: 2,
        },
      ],
    });

    expect(startupGate.hydrate).toHaveBeenCalledWith('task-review', [validTaskReview], 2);

    listeners.cleanupPersistentListeners();
  });
});
