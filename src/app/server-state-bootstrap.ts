import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import type {
  AnyServerStateBootstrapSnapshot,
  ServerStateBootstrapSnapshot,
  ServerStateBootstrapPayloadMap,
  ServerStateBootstrapCategory,
  ServerStateEventPayloadMap,
} from '../domain/server-state-bootstrap';
import { SERVER_STATE_BOOTSTRAP_CATEGORIES } from '../domain/server-state-bootstrap';
import { assertNever } from '../lib/assert-never';
import {
  recordBootstrapCompletion,
  recordBufferedBootstrapEvent,
  recordBufferedBootstrapSnapshot,
} from './runtime-diagnostics';
import { applyRemoteStatus } from './remote-access';
import { applyTaskConvergenceEvent, replaceTaskConvergenceSnapshots } from './task-convergence';
import { applyTaskReviewEvent, replaceTaskReviewSnapshots } from './task-review-state';
import { applyTaskPortsEvent, replaceTaskPortSnapshots } from './task-ports';
import { applyAgentSupervisionEvent, replaceAgentSupervisionSnapshots } from './task-attention';
import { handleGitStatusSyncEvent, replaceGitStatusSnapshots } from './git-status-sync';

export async function fetchServerStateBootstrap(): Promise<AnyServerStateBootstrapSnapshot[]> {
  return invoke(IPC.GetServerStateBootstrap);
}

type ServerStateBootstrapPayload<TCategory extends ServerStateBootstrapCategory> =
  ServerStateBootstrapPayloadMap[TCategory];

export interface ServerStateBootstrapCategoryDescriptor<
  TCategory extends ServerStateBootstrapCategory,
> {
  applyEvent: (event: ServerStateEventPayloadMap[TCategory]) => void;
  applySnapshot: (payload: ServerStateBootstrapPayload<TCategory>) => void;
}

export type ServerStateBootstrapCategoryDescriptors = {
  [TCategory in ServerStateBootstrapCategory]: ServerStateBootstrapCategoryDescriptor<TCategory>;
};

const SERVER_STATE_EVENT_APPLIERS: {
  [TCategory in ServerStateBootstrapCategory]: (
    event: ServerStateEventPayloadMap[TCategory],
  ) => void;
} = {
  'git-status': handleGitStatusSyncEvent,
  'remote-status': applyRemoteStatus,
  'agent-supervision': applyAgentSupervisionEvent,
  'task-convergence': applyTaskConvergenceEvent,
  'task-review': applyTaskReviewEvent,
  'task-ports': applyTaskPortsEvent,
};

const SERVER_STATE_SNAPSHOT_APPLIERS: {
  [TCategory in ServerStateBootstrapCategory]: (
    payload: ServerStateBootstrapPayloadMap[TCategory],
  ) => void;
} = {
  'git-status': replaceGitStatusSnapshots,
  'remote-status': applyRemoteStatus,
  'agent-supervision': replaceAgentSupervisionSnapshots,
  'task-convergence': replaceTaskConvergenceSnapshots,
  'task-review': replaceTaskReviewSnapshots,
  'task-ports': replaceTaskPortSnapshots,
};

export function applyServerStateEvent<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
  event: ServerStateEventPayloadMap[TCategory],
): void {
  SERVER_STATE_EVENT_APPLIERS[category](event);
}

export function replaceServerStateCategory<TCategory extends ServerStateBootstrapCategory>(
  snapshot: ServerStateBootstrapSnapshot<TCategory>,
): void {
  SERVER_STATE_SNAPSHOT_APPLIERS[snapshot.category](snapshot.payload);
}

export function replaceServerStateBootstrap(
  snapshots: ReadonlyArray<AnyServerStateBootstrapSnapshot>,
): void {
  const snapshotsByCategory = new Map(
    snapshots.map((snapshot) => [snapshot.category, snapshot] as const),
  );

  for (const category of SERVER_STATE_BOOTSTRAP_CATEGORIES) {
    const snapshot = snapshotsByCategory.get(category);
    if (snapshot) {
      replaceServerStateCategory(snapshot);
    }
  }
}

export function replaceServerStateSnapshot<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
  payload: ServerStateBootstrapPayloadMap[TCategory],
): void {
  SERVER_STATE_SNAPSHOT_APPLIERS[category](payload);
}

type ServerStateBootstrapGateState =
  | {
      kind: 'booting';
      pendingEvents: PendingEventQueue;
      pendingSnapshots: Partial<ServerStateBootstrapPayloadMap>;
    }
  | { kind: 'ready' }
  | { kind: 'disposed' };

type PendingEventQueue = {
  [TCategory in ServerStateBootstrapCategory]: ServerStateEventPayloadMap[TCategory][];
};

function createPendingEventQueue(): PendingEventQueue {
  return {
    'git-status': [],
    'remote-status': [],
    'agent-supervision': [],
    'task-convergence': [],
    'task-review': [],
    'task-ports': [],
  };
}

export function createServerStateBootstrapGate(
  descriptors: ServerStateBootstrapCategoryDescriptors,
): {
  complete: () => void;
  dispose: () => void;
  handle: <TCategory extends ServerStateBootstrapCategory>(
    category: TCategory,
    event: ServerStateEventPayloadMap[TCategory],
  ) => void;
  hydrate: <TCategory extends ServerStateBootstrapCategory>(
    category: TCategory,
    payload: ServerStateBootstrapPayload<TCategory>,
    version?: number,
  ) => void;
} {
  const createdAt = Date.now();
  let state: ServerStateBootstrapGateState = {
    kind: 'booting',
    pendingEvents: createPendingEventQueue(),
    pendingSnapshots: {},
  };

  function flushPendingSnapshots<TCategory extends ServerStateBootstrapCategory>(
    pendingSnapshots: Partial<ServerStateBootstrapPayloadMap>,
    category: TCategory,
  ): void {
    const payload = pendingSnapshots[category];
    if (payload !== undefined) {
      descriptors[category].applySnapshot(payload);
    }
  }

  function flushPendingEvents<TCategory extends ServerStateBootstrapCategory>(
    pendingEvents: PendingEventQueue,
    category: TCategory,
  ): void {
    for (const event of pendingEvents[category]) {
      descriptors[category].applyEvent(event);
    }
  }

  function drainPendingState(
    pendingSnapshots: Partial<ServerStateBootstrapPayloadMap>,
    pendingEvents: PendingEventQueue,
  ): void {
    for (const category of SERVER_STATE_BOOTSTRAP_CATEGORIES) {
      flushPendingSnapshots(pendingSnapshots, category);
      flushPendingEvents(pendingEvents, category);
    }
  }

  return {
    handle<TCategory extends ServerStateBootstrapCategory>(
      category: TCategory,
      event: ServerStateEventPayloadMap[TCategory],
    ): void {
      switch (state.kind) {
        case 'booting':
          recordBufferedBootstrapEvent(category);
          state.pendingEvents[category].push(event);
          return;
        case 'ready':
          descriptors[category].applyEvent(event);
          return;
        case 'disposed':
          return;
      }

      return assertNever(state, 'Unhandled server state bootstrap gate state');
    },
    hydrate<TCategory extends ServerStateBootstrapCategory>(
      category: TCategory,
      payload: ServerStateBootstrapPayload<TCategory>,
      _version = Date.now(),
    ): void {
      switch (state.kind) {
        case 'booting':
          recordBufferedBootstrapSnapshot(category);
          state.pendingSnapshots[category] = payload;
          return;
        case 'ready':
          descriptors[category].applySnapshot(payload);
          return;
        case 'disposed':
          return;
      }

      return assertNever(state, 'Unhandled server state bootstrap gate state');
    },
    complete(): void {
      if (state.kind !== 'booting') {
        return;
      }

      const pendingSnapshots = state.pendingSnapshots;
      const pendingEvents = state.pendingEvents;
      state = { kind: 'ready' };

      drainPendingState(pendingSnapshots, pendingEvents);

      recordBootstrapCompletion(Date.now() - createdAt);
    },
    dispose(): void {
      state = { kind: 'disposed' };
    },
  };
}
