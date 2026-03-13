import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import type {
  AnyServerStateBootstrapSnapshot,
  ServerStateBootstrapPayloadMap,
  ServerStateBootstrapCategory,
  ServerStateEventPayloadMap,
} from '../domain/server-state-bootstrap';
import {
  createServerStateBootstrapSnapshot,
  SERVER_STATE_BOOTSTRAP_CATEGORIES,
} from '../domain/server-state-bootstrap';
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

function applyServerStateEventByCategory(
  category: ServerStateBootstrapCategory,
  event: ServerStateEventPayloadMap[ServerStateBootstrapCategory],
): void {
  switch (category) {
    case 'git-status':
      handleGitStatusSyncEvent(event as ServerStateEventPayloadMap['git-status']);
      return;
    case 'remote-status':
      applyRemoteStatus(event as ServerStateEventPayloadMap['remote-status']);
      return;
    case 'agent-supervision':
      applyAgentSupervisionEvent(event as ServerStateEventPayloadMap['agent-supervision']);
      return;
    case 'task-convergence':
      applyTaskConvergenceEvent(event as ServerStateEventPayloadMap['task-convergence']);
      return;
    case 'task-review':
      applyTaskReviewEvent(event as ServerStateEventPayloadMap['task-review']);
      return;
    case 'task-ports':
      applyTaskPortsEvent(event as ServerStateEventPayloadMap['task-ports']);
      return;
    default:
      return assertNever(category, 'Unhandled server state bootstrap category');
  }
}

export function applyServerStateEvent<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
  event: ServerStateEventPayloadMap[TCategory],
): void {
  applyServerStateEventByCategory(category, event);
}

export function replaceServerStateCategory(snapshot: AnyServerStateBootstrapSnapshot): void {
  switch (snapshot.category) {
    case 'git-status':
      replaceGitStatusSnapshots(snapshot.payload);
      return;
    case 'remote-status':
      applyRemoteStatus(snapshot.payload);
      return;
    case 'agent-supervision':
      replaceAgentSupervisionSnapshots(snapshot.payload);
      return;
    case 'task-convergence':
      replaceTaskConvergenceSnapshots(snapshot.payload);
      return;
    case 'task-review':
      replaceTaskReviewSnapshots(snapshot.payload);
      return;
    case 'task-ports':
      replaceTaskPortSnapshots(snapshot.payload);
      return;
    default:
      return assertNever(snapshot, 'Unhandled server state bootstrap snapshot');
  }
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
  version = 0,
): void {
  replaceServerStateCategory(
    createServerStateBootstrapSnapshot(
      category,
      payload,
      version,
    ) as AnyServerStateBootstrapSnapshot,
  );
}

type ServerStateBootstrapGateState =
  | {
      kind: 'booting';
      pendingEvents: PendingEventQueue;
      pendingSnapshots: Partial<{
        [TCategory in ServerStateBootstrapCategory]: AnyServerStateBootstrapSnapshot;
      }>;
    }
  | { kind: 'ready' }
  | { kind: 'disposed' };

type PendingEventQueue = {
  [TCategory in ServerStateBootstrapCategory]: ServerStateEventPayloadMap[TCategory][];
};

function createPendingEventQueue(): PendingEventQueue {
  return Object.fromEntries(
    SERVER_STATE_BOOTSTRAP_CATEGORIES.map((category) => [category, []]),
  ) as unknown as PendingEventQueue;
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

  function flushPendingSnapshots(
    pendingSnapshots: Partial<{
      [TCategory in ServerStateBootstrapCategory]: AnyServerStateBootstrapSnapshot;
    }>,
  ): void {
    for (const category of SERVER_STATE_BOOTSTRAP_CATEGORIES) {
      const snapshot = pendingSnapshots[category];
      if (snapshot) {
        descriptors[category].applySnapshot(snapshot.payload as never);
      }
    }
  }

  function flushPendingEvents(pendingEvents: PendingEventQueue): void {
    for (const category of SERVER_STATE_BOOTSTRAP_CATEGORIES) {
      for (const event of pendingEvents[category]) {
        descriptors[category].applyEvent(event as never);
      }
    }
  }

  return {
    handle<TCategory extends ServerStateBootstrapCategory>(
      category: TCategory,
      event: ServerStateEventPayloadMap[TCategory],
    ): void {
      if (state.kind === 'booting') {
        recordBufferedBootstrapEvent(category);
        state.pendingEvents[category].push(event);
        return;
      }

      if (state.kind === 'ready') {
        descriptors[category].applyEvent(event);
        return;
      }

      if (state.kind === 'disposed') {
        return;
      }

      return assertNever(state, 'Unhandled server state bootstrap gate state');
    },
    hydrate<TCategory extends ServerStateBootstrapCategory>(
      category: TCategory,
      payload: ServerStateBootstrapPayload<TCategory>,
      version = Date.now(),
    ): void {
      if (state.kind === 'booting') {
        recordBufferedBootstrapSnapshot(category);
        state.pendingSnapshots[category] = createServerStateBootstrapSnapshot(
          category,
          payload,
          version,
        ) as AnyServerStateBootstrapSnapshot;
        return;
      }

      if (state.kind === 'ready') {
        descriptors[category].applySnapshot(payload);
        return;
      }

      if (state.kind === 'disposed') {
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

      flushPendingSnapshots(pendingSnapshots);
      flushPendingEvents(pendingEvents);

      recordBootstrapCompletion(Date.now() - createdAt);
    },
    dispose(): void {
      state = { kind: 'disposed' };
    },
  };
}
