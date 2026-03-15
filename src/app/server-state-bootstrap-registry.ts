import type {
  AnyServerStateBootstrapSnapshot,
  ServerStateBootstrapCategory,
  ServerStateBootstrapPayloadMap,
  ServerStateEventPayloadMap,
} from '../domain/server-state-bootstrap';
import { SERVER_STATE_BOOTSTRAP_CATEGORIES } from '../domain/server-state-bootstrap';
import type {
  RemoteAccessStatus,
  TaskExposedPort,
  TaskObservedPort,
  TaskPortsEvent,
} from '../domain/server-state';
import {
  listenAgentSupervisionChanged,
  listenGitStatusChanged,
  listenRemoteStatusChanged,
  listenTaskConvergenceChanged,
  listenTaskReviewChanged,
  listenTaskPortsChanged,
} from '../lib/ipc-events';
import { listenServerMessage } from '../lib/ipc';
import {
  applyServerStateEvent,
  replaceServerStateSnapshot,
  type ServerStateBootstrapCategoryDescriptor,
  type ServerStateBootstrapCategoryDescriptors,
} from './server-state-bootstrap';
import { applyRemoteStatus } from './remote-access';

type CleanupFn = () => void;
type ServerStateStartupRuntime = 'browser' | 'electron';
type ServerStateListenerScope = 'none' | 'persistent' | 'startup-only';
type ServerStateBootstrapGate = {
  handle: <TCategory extends ServerStateBootstrapCategory>(
    category: TCategory,
    event: ServerStateEventPayloadMap[TCategory],
  ) => void;
  hydrate: <TCategory extends ServerStateBootstrapCategory>(
    category: TCategory,
    payload: ServerStateBootstrapPayloadMap[TCategory],
    version?: number,
  ) => void;
};

interface BrowserTaskPortsServerMessage {
  exposed?: TaskExposedPort[];
  observed?: TaskObservedPort[];
  removed?: true;
  taskId: string;
  updatedAt?: number;
}

interface ServerStateBootstrapRegistryEntry<TCategory extends ServerStateBootstrapCategory> {
  createDescriptor: () => ServerStateBootstrapCategoryDescriptor<TCategory>;
  getListenerScope: (runtime: ServerStateStartupRuntime) => ServerStateListenerScope;
  listenEvent: (
    runtime: ServerStateStartupRuntime,
    handle: (event: ServerStateEventPayloadMap[TCategory]) => void,
  ) => CleanupFn;
}

type ServerStateBootstrapRegistry = {
  [TCategory in ServerStateBootstrapCategory]: ServerStateBootstrapRegistryEntry<TCategory>;
};

function createSnapshotApplier<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
): (payload: ServerStateBootstrapPayloadMap[TCategory]) => void {
  return (payload) => {
    replaceServerStateSnapshot(category, payload);
  };
}

function createServerStateCategoryDescriptor<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
): ServerStateBootstrapCategoryDescriptor<TCategory> {
  return {
    applyEvent: (event) => applyServerStateEvent(category, event),
    applySnapshot: createSnapshotApplier(category),
  };
}

function toBrowserTaskPortsEvent(message: BrowserTaskPortsServerMessage): TaskPortsEvent {
  if (
    Array.isArray(message.observed) &&
    Array.isArray(message.exposed) &&
    typeof message.updatedAt === 'number'
  ) {
    return {
      taskId: message.taskId,
      observed: message.observed,
      exposed: message.exposed,
      updatedAt: message.updatedAt,
    };
  }

  return { taskId: message.taskId, removed: true };
}

const SERVER_STATE_BOOTSTRAP_REGISTRY = {
  'agent-supervision': {
    createDescriptor: () => createServerStateCategoryDescriptor('agent-supervision'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) => listenAgentSupervisionChanged(handle),
  },
  'git-status': {
    createDescriptor: () => createServerStateCategoryDescriptor('git-status'),
    getListenerScope: (runtime) => (runtime === 'electron' ? 'persistent' : 'startup-only'),
    listenEvent: (runtime, handle) => {
      if (runtime === 'electron') {
        return listenGitStatusChanged(handle);
      }

      return listenServerMessage('git-status-changed', handle);
    },
  },
  'remote-status': {
    createDescriptor: () => ({
      applyEvent: (event: RemoteAccessStatus) => {
        applyRemoteStatus(event);
      },
      applySnapshot: (payload) => {
        applyRemoteStatus(payload);
      },
    }),
    getListenerScope: (runtime) => (runtime === 'electron' ? 'persistent' : 'none'),
    listenEvent: (runtime, handle) => {
      if (runtime === 'electron') {
        return listenRemoteStatusChanged(handle);
      }
      return () => {};
    },
  },
  'task-convergence': {
    createDescriptor: () => createServerStateCategoryDescriptor('task-convergence'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) => listenTaskConvergenceChanged(handle),
  },
  'task-review': {
    createDescriptor: () => createServerStateCategoryDescriptor('task-review'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) => listenTaskReviewChanged(handle),
  },
  'task-ports': {
    createDescriptor: () => createServerStateCategoryDescriptor('task-ports'),
    getListenerScope: (runtime) => (runtime === 'electron' ? 'persistent' : 'startup-only'),
    listenEvent: (runtime, handle) => {
      if (runtime === 'electron') {
        return listenTaskPortsChanged(handle);
      }

      return listenServerMessage('task-ports-changed', (message: BrowserTaskPortsServerMessage) => {
        handle(toBrowserTaskPortsEvent(message));
      });
    },
  },
} satisfies ServerStateBootstrapRegistry;

export function getServerStateBootstrapRegistryCategories(): ServerStateBootstrapCategory[] {
  return [...SERVER_STATE_BOOTSTRAP_CATEGORIES];
}

export function getServerStateListenerScope(
  category: ServerStateBootstrapCategory,
  runtime: ServerStateStartupRuntime,
): ServerStateListenerScope {
  return SERVER_STATE_BOOTSTRAP_REGISTRY[category].getListenerScope(runtime);
}

export function getServerStateListenerScopes(
  runtime: ServerStateStartupRuntime,
): Record<ServerStateBootstrapCategory, ServerStateListenerScope> {
  return {
    'git-status': getServerStateListenerScope('git-status', runtime),
    'remote-status': getServerStateListenerScope('remote-status', runtime),
    'agent-supervision': getServerStateListenerScope('agent-supervision', runtime),
    'task-convergence': getServerStateListenerScope('task-convergence', runtime),
    'task-review': getServerStateListenerScope('task-review', runtime),
    'task-ports': getServerStateListenerScope('task-ports', runtime),
  };
}

export function createServerStateBootstrapCategoryDescriptors(): ServerStateBootstrapCategoryDescriptors {
  return {
    'git-status': SERVER_STATE_BOOTSTRAP_REGISTRY['git-status'].createDescriptor(),
    'remote-status': SERVER_STATE_BOOTSTRAP_REGISTRY['remote-status'].createDescriptor(),
    'agent-supervision': SERVER_STATE_BOOTSTRAP_REGISTRY['agent-supervision'].createDescriptor(),
    'task-convergence': SERVER_STATE_BOOTSTRAP_REGISTRY['task-convergence'].createDescriptor(),
    'task-review': SERVER_STATE_BOOTSTRAP_REGISTRY['task-review'].createDescriptor(),
    'task-ports': SERVER_STATE_BOOTSTRAP_REGISTRY['task-ports'].createDescriptor(),
  };
}

function handleBrowserStateBootstrapMessage(
  startupGate: ServerStateBootstrapGate,
  message: {
    snapshots: ReadonlyArray<AnyServerStateBootstrapSnapshot>;
  },
): void {
  for (const snapshot of message.snapshots) {
    startupGate.hydrate(snapshot.category, snapshot.payload, snapshot.version);
  }
}

export function createServerStateEventListeners(
  electronRuntime: boolean,
  startupGate: ServerStateBootstrapGate,
): {
  cleanupPersistentListeners: CleanupFn;
  cleanupStartupListeners: CleanupFn;
} {
  const runtime: ServerStateStartupRuntime = electronRuntime ? 'electron' : 'browser';
  const persistentCleanups: CleanupFn[] = [];
  const startupCleanups: CleanupFn[] = [];

  for (const category of SERVER_STATE_BOOTSTRAP_CATEGORIES) {
    const entry = SERVER_STATE_BOOTSTRAP_REGISTRY[category];
    const scope = entry.getListenerScope(runtime);
    if (scope === 'none') {
      continue;
    }

    const cleanup = entry.listenEvent(runtime, (event) => {
      startupGate.handle(category, event);
    });

    if (scope === 'persistent') {
      persistentCleanups.push(cleanup);
    } else {
      startupCleanups.push(cleanup);
    }
  }

  if (!electronRuntime) {
    startupCleanups.push(
      listenServerMessage('state-bootstrap', (message) => {
        handleBrowserStateBootstrapMessage(startupGate, message);
      }),
    );
  }

  function cleanup(cleanups: CleanupFn[]): void {
    for (const listenerCleanup of cleanups) {
      listenerCleanup();
    }
  }

  return {
    cleanupPersistentListeners: () => {
      cleanup(persistentCleanups);
    },
    cleanupStartupListeners: () => {
      cleanup(startupCleanups);
    },
  };
}
