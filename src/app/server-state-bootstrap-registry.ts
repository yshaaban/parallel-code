import type {
  AnyServerStateBootstrapSnapshot,
  ServerStateBootstrapCategory,
  ServerStateBootstrapPayloadMap,
  ServerStateEventPayloadMap,
} from '../domain/server-state-bootstrap';
import { SERVER_STATE_BOOTSTRAP_CATEGORIES } from '../domain/server-state-bootstrap';
import type { TaskPortsEvent } from '../domain/server-state';
import { createRemovedTaskPortsEvent, createTaskPortsSnapshotEvent } from '../domain/server-state';
import {
  listenAgentSupervisionChanged,
  listenGitStatusChanged,
  listenRemoteStatusChanged,
  listenTaskCommandControllerChanged,
  listenTaskConvergenceChanged,
  listenTaskReviewSignalsChanged,
  listenTaskStepsChanged,
  listenTaskReviewChanged,
  listenTaskPortsChanged,
} from '../lib/ipc-events';
import { listenServerMessage, type BrowserServerMessage } from '../lib/ipc';
import { assertNever } from '../lib/assert-never';
import {
  applyServerStateEvent,
  replaceServerStateSnapshot,
  type ServerStateBootstrapCategoryDescriptor,
  type ServerStateBootstrapCategoryDescriptors,
} from './server-state-bootstrap';

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

type BrowserTaskPortsServerMessage = Extract<BrowserServerMessage, { type: 'task-ports-changed' }>;

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

function createServerStateCategoryDescriptor<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
): ServerStateBootstrapCategoryDescriptor<TCategory> {
  return {
    applyEvent: (event) => applyServerStateEvent(category, event),
    applySnapshot: (payload, version) => replaceServerStateSnapshot(category, payload, version),
  };
}

function withBrowserTaskPortsStateVersion(
  event: TaskPortsEvent,
  message: BrowserTaskPortsServerMessage,
): TaskPortsEvent {
  if (typeof message.stateVersion !== 'number') {
    return event;
  }

  return {
    ...event,
    stateVersion: message.stateVersion,
  };
}

function toBrowserTaskPortsEvent(message: BrowserTaskPortsServerMessage): TaskPortsEvent {
  switch (message.kind) {
    case 'snapshot': {
      const event = createTaskPortsSnapshotEvent({
        taskId: message.taskId,
        observed: message.observed,
        exposed: message.exposed,
        updatedAt: message.updatedAt,
      });
      return withBrowserTaskPortsStateVersion(event, message);
    }
    case 'removed': {
      const event = createRemovedTaskPortsEvent(message.taskId);
      return withBrowserTaskPortsStateVersion(event, message);
    }
    default:
      return assertNever(message, 'Unhandled task ports server message');
  }
}

const SERVER_STATE_BOOTSTRAP_REGISTRY: ServerStateBootstrapRegistry = {
  'agent-supervision': {
    createDescriptor: () => createServerStateCategoryDescriptor('agent-supervision'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) => listenAgentSupervisionChanged(handle),
  },
  'git-status': {
    createDescriptor: () => createServerStateCategoryDescriptor('git-status'),
    getListenerScope: () => 'persistent',
    listenEvent: (runtime, handle) => {
      if (runtime === 'electron') {
        return listenGitStatusChanged(handle);
      }

      return listenServerMessage('git-status-changed', handle);
    },
  },
  'remote-status': {
    createDescriptor: () => createServerStateCategoryDescriptor('remote-status'),
    getListenerScope: () => 'persistent',
    listenEvent: (runtime, handle) => {
      if (runtime === 'electron') {
        return listenRemoteStatusChanged(handle);
      }

      return listenServerMessage('remote-status', handle);
    },
  },
  'peer-presence': {
    createDescriptor: () => createServerStateCategoryDescriptor('peer-presence'),
    getListenerScope: () => 'none',
    listenEvent: () => () => {},
  },
  'task-command-controller': {
    createDescriptor: () => createServerStateCategoryDescriptor('task-command-controller'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) => listenTaskCommandControllerChanged(handle),
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
  'task-review-signals': {
    createDescriptor: () => createServerStateCategoryDescriptor('task-review-signals'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) => listenTaskReviewSignalsChanged(handle),
  },
  'task-steps': {
    createDescriptor: () => createServerStateCategoryDescriptor('task-steps'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) => listenTaskStepsChanged(handle),
  },
  'task-ports': {
    createDescriptor: () => createServerStateCategoryDescriptor('task-ports'),
    getListenerScope: () => 'persistent',
    listenEvent: (runtime, handle) => {
      if (runtime === 'electron') {
        return listenTaskPortsChanged(handle);
      }

      return listenServerMessage('task-ports-changed', (message: BrowserTaskPortsServerMessage) => {
        handle(toBrowserTaskPortsEvent(message));
      });
    },
  },
};

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
    'peer-presence': getServerStateListenerScope('peer-presence', runtime),
    'task-command-controller': getServerStateListenerScope('task-command-controller', runtime),
    'agent-supervision': getServerStateListenerScope('agent-supervision', runtime),
    'task-convergence': getServerStateListenerScope('task-convergence', runtime),
    'task-review': getServerStateListenerScope('task-review', runtime),
    'task-review-signals': getServerStateListenerScope('task-review-signals', runtime),
    'task-steps': getServerStateListenerScope('task-steps', runtime),
    'task-ports': getServerStateListenerScope('task-ports', runtime),
  };
}

export function createServerStateBootstrapCategoryDescriptors(): ServerStateBootstrapCategoryDescriptors {
  return {
    'git-status': SERVER_STATE_BOOTSTRAP_REGISTRY['git-status'].createDescriptor(),
    'remote-status': SERVER_STATE_BOOTSTRAP_REGISTRY['remote-status'].createDescriptor(),
    'peer-presence': SERVER_STATE_BOOTSTRAP_REGISTRY['peer-presence'].createDescriptor(),
    'task-command-controller':
      SERVER_STATE_BOOTSTRAP_REGISTRY['task-command-controller'].createDescriptor(),
    'agent-supervision': SERVER_STATE_BOOTSTRAP_REGISTRY['agent-supervision'].createDescriptor(),
    'task-convergence': SERVER_STATE_BOOTSTRAP_REGISTRY['task-convergence'].createDescriptor(),
    'task-review': SERVER_STATE_BOOTSTRAP_REGISTRY['task-review'].createDescriptor(),
    'task-review-signals':
      SERVER_STATE_BOOTSTRAP_REGISTRY['task-review-signals'].createDescriptor(),
    'task-steps': SERVER_STATE_BOOTSTRAP_REGISTRY['task-steps'].createDescriptor(),
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
    persistentCleanups.push(
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
