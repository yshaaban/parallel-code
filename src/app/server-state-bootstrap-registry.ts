import type {
  ServerStateBootstrapCategory,
  ServerStateBootstrapPayloadMap,
  ServerStateEventPayloadMap,
} from '../domain/server-state-bootstrap';
import {
  filterDegradedServerStateBootstrapSnapshots,
  filterServerStateBootstrapSnapshots,
  isServerStateEventPayload,
  SERVER_STATE_BOOTSTRAP_CATEGORIES,
} from '../domain/server-state-bootstrap';
import {
  clearDegradedBootstrapCategory,
  recordDegradedBootstrapCategory,
} from './runtime-diagnostics';
import { sendBrowserControlMessage } from '../lib/ipc';
import type { TaskPortsEvent } from '../domain/server-state';
import { createRemovedTaskPortsEvent, createTaskPortsSnapshotEvent } from '../domain/server-state';
import {
  listenAgentAvailabilityChanged,
  listenAgentSupervisionChanged,
  listenCoordinatorChanged,
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
import { isNonNegativeInteger, isRecord } from '../lib/type-guards';
import {
  applyServerStateEvent,
  replaceServerStateSnapshot,
  resetServerStateVersionTrackingForInstanceChange,
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
type BrowserCoordinatorServerMessage = Extract<BrowserServerMessage, { type: 'coordinator-event' }>;
type BrowserServerStateMessageTypeByCategory = {
  'git-status': 'git-status-changed';
  'remote-status': 'remote-status';
};
type BrowserServerStateEventCategory = keyof BrowserServerStateMessageTypeByCategory;

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
type ServerStateEventSource<TCategory extends ServerStateBootstrapCategory> = (
  listener: (payload: ServerStateEventPayloadMap[TCategory]) => void,
) => CleanupFn;

function createServerStateCategoryDescriptor<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
): ServerStateBootstrapCategoryDescriptor<TCategory> {
  return {
    applyEvent: (event) => applyServerStateEvent(category, event),
    applySnapshot: (payload, version) => replaceServerStateSnapshot(category, payload, version),
  };
}

function mapServerStateBootstrapCategories<TValue>(
  getValue: (category: ServerStateBootstrapCategory) => TValue,
): Record<ServerStateBootstrapCategory, TValue> {
  return Object.fromEntries(
    SERVER_STATE_BOOTSTRAP_CATEGORIES.map((category) => [category, getValue(category)]),
  ) as Record<ServerStateBootstrapCategory, TValue>;
}

function handleValidatedServerStateEvent<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
  payload: unknown,
  handle: (event: ServerStateEventPayloadMap[TCategory]) => void,
): void {
  if (isServerStateEventPayload(category, payload)) {
    handle(payload);
  }
}

function listenValidatedServerStateEvent<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
  listenEvent: ServerStateEventSource<TCategory>,
  handle: (event: ServerStateEventPayloadMap[TCategory]) => void,
): CleanupFn {
  return listenEvent((payload) => {
    handleValidatedServerStateEvent(category, payload, handle);
  });
}

function listenValidatedBrowserServerStateEvent<TCategory extends BrowserServerStateEventCategory>(
  category: TCategory,
  type: BrowserServerStateMessageTypeByCategory[TCategory],
  handle: (event: ServerStateEventPayloadMap[TCategory]) => void,
): CleanupFn {
  return listenServerMessage(type, (message) => {
    handleValidatedServerStateEvent(category, message, handle);
  });
}

function withBrowserTaskPortsStateVersion(
  event: TaskPortsEvent,
  message: BrowserTaskPortsServerMessage,
): TaskPortsEvent {
  if (!isNonNegativeInteger(message.stateVersion)) {
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
  'agent-availability': {
    createDescriptor: () => createServerStateCategoryDescriptor('agent-availability'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) =>
      listenValidatedServerStateEvent('agent-availability', listenAgentAvailabilityChanged, handle),
  },
  'agent-supervision': {
    createDescriptor: () => createServerStateCategoryDescriptor('agent-supervision'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) =>
      listenValidatedServerStateEvent('agent-supervision', listenAgentSupervisionChanged, handle),
  },
  'git-status': {
    createDescriptor: () => createServerStateCategoryDescriptor('git-status'),
    getListenerScope: () => 'persistent',
    listenEvent: (runtime, handle) => {
      if (runtime === 'electron') {
        return listenValidatedServerStateEvent('git-status', listenGitStatusChanged, handle);
      }

      return listenValidatedBrowserServerStateEvent('git-status', 'git-status-changed', handle);
    },
  },
  'remote-status': {
    createDescriptor: () => createServerStateCategoryDescriptor('remote-status'),
    getListenerScope: () => 'persistent',
    listenEvent: (runtime, handle) => {
      if (runtime === 'electron') {
        return listenValidatedServerStateEvent('remote-status', listenRemoteStatusChanged, handle);
      }

      return listenValidatedBrowserServerStateEvent('remote-status', 'remote-status', handle);
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
    listenEvent: (_runtime, handle) =>
      listenValidatedServerStateEvent(
        'task-command-controller',
        listenTaskCommandControllerChanged,
        handle,
      ),
  },
  coordinator: {
    createDescriptor: () => createServerStateCategoryDescriptor('coordinator'),
    getListenerScope: () => 'persistent',
    listenEvent: (runtime, handle) => {
      if (runtime === 'electron') {
        return listenValidatedServerStateEvent('coordinator', listenCoordinatorChanged, handle);
      }

      return listenServerMessage(
        'coordinator-event',
        (message: BrowserCoordinatorServerMessage) => {
          handleValidatedServerStateEvent('coordinator', message.event, handle);
        },
      );
    },
  },
  'task-convergence': {
    createDescriptor: () => createServerStateCategoryDescriptor('task-convergence'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) =>
      listenValidatedServerStateEvent('task-convergence', listenTaskConvergenceChanged, handle),
  },
  'task-review': {
    createDescriptor: () => createServerStateCategoryDescriptor('task-review'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) =>
      listenValidatedServerStateEvent('task-review', listenTaskReviewChanged, handle),
  },
  'task-review-signals': {
    createDescriptor: () => createServerStateCategoryDescriptor('task-review-signals'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) =>
      listenValidatedServerStateEvent(
        'task-review-signals',
        listenTaskReviewSignalsChanged,
        handle,
      ),
  },
  'task-steps': {
    createDescriptor: () => createServerStateCategoryDescriptor('task-steps'),
    getListenerScope: () => 'persistent',
    listenEvent: (_runtime, handle) =>
      listenValidatedServerStateEvent('task-steps', listenTaskStepsChanged, handle),
  },
  'task-ports': {
    createDescriptor: () => createServerStateCategoryDescriptor('task-ports'),
    getListenerScope: () => 'persistent',
    listenEvent: (runtime, handle) => {
      if (runtime === 'electron') {
        return listenValidatedServerStateEvent('task-ports', listenTaskPortsChanged, handle);
      }

      return listenServerMessage('task-ports-changed', (message: BrowserTaskPortsServerMessage) => {
        if (isServerStateEventPayload('task-ports', message)) {
          handle(toBrowserTaskPortsEvent(message));
        }
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
  return mapServerStateBootstrapCategories((category) =>
    getServerStateListenerScope(category, runtime),
  );
}

export function createServerStateBootstrapCategoryDescriptors(): ServerStateBootstrapCategoryDescriptors {
  return mapServerStateBootstrapCategories((category) =>
    SERVER_STATE_BOOTSTRAP_REGISTRY[category].createDescriptor(),
  ) as ServerStateBootstrapCategoryDescriptors;
}

const DEGRADED_BOOTSTRAP_CATEGORY_RETRY_DELAY_MS = 5_000;
let degradedBootstrapRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

// One targeted retry per degraded burst: the server re-sends only the named
// categories through a fresh state-bootstrap message, which flows back through
// this same handler (clearing the markers on success).
function scheduleDegradedBootstrapCategoryRetry(categories: ServerStateBootstrapCategory[]): void {
  if (degradedBootstrapRetryTimer !== null) {
    return;
  }

  degradedBootstrapRetryTimer = globalThis.setTimeout(() => {
    degradedBootstrapRetryTimer = null;
    void sendBrowserControlMessage({
      type: 'request-state-bootstrap',
      categories,
    }).catch(() => {});
  }, DEGRADED_BOOTSTRAP_CATEGORY_RETRY_DELAY_MS);
}

export function resetDegradedBootstrapCategoryRetryForTests(): void {
  if (degradedBootstrapRetryTimer !== null) {
    globalThis.clearTimeout(degradedBootstrapRetryTimer);
    degradedBootstrapRetryTimer = null;
  }
}

// Per-boot category versions are only comparable within one server instance.
// Every state-bootstrap message carries the serverInstanceId; when it changes
// (standalone-server restart under a surviving tab), the per-category version
// trackers still hold the old instance's higher versions and would silently
// reject the restarted server's full bootstrap, wedging those categories until
// a page reload. Reset the trackers before hydrating so the new instance's
// snapshots (and its subsequent live events) are accepted.
let lastHydratedServerInstanceId: string | null = null;

export function resetServerStateBootstrapInstanceTrackingForTests(): void {
  lastHydratedServerInstanceId = null;
}

function noteServerStateBootstrapInstanceId(serverInstanceId: unknown): void {
  if (typeof serverInstanceId !== 'string' || serverInstanceId.length === 0) {
    return;
  }

  if (lastHydratedServerInstanceId !== null && lastHydratedServerInstanceId !== serverInstanceId) {
    resetServerStateVersionTrackingForInstanceChange();
  }

  lastHydratedServerInstanceId = serverInstanceId;
}

function handleBrowserStateBootstrapMessage(
  startupGate: ServerStateBootstrapGate,
  message: unknown,
): void {
  if (!isRecord(message) || !Array.isArray(message.snapshots)) {
    return;
  }

  noteServerStateBootstrapInstanceId(message.serverInstanceId);

  const degradedSnapshots = filterDegradedServerStateBootstrapSnapshots(message.snapshots);
  if (degradedSnapshots.length > 0) {
    for (const snapshot of degradedSnapshots) {
      recordDegradedBootstrapCategory(snapshot.category);
    }
    scheduleDegradedBootstrapCategoryRetry(degradedSnapshots.map((snapshot) => snapshot.category));
  }

  for (const snapshot of filterServerStateBootstrapSnapshots(message.snapshots)) {
    clearDegradedBootstrapCategory(snapshot.category);
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
