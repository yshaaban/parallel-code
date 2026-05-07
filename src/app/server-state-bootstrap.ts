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
import { emitStartupBreadcrumb } from './startup-breadcrumbs';
import { applyRemoteStatus } from './remote-access';
import { replacePeerSessions } from '../store/peer-presence';
import { applyTaskConvergenceEvent, replaceTaskConvergenceSnapshots } from './task-convergence';
import { applyTaskReviewEvent, replaceTaskReviewSnapshots } from './task-review-state';
import { applyTaskPortsEvent, replaceTaskPortSnapshots } from './task-ports';
import { applyAgentSupervisionEvent, replaceAgentSupervisionSnapshots } from './task-attention';
import { applyTaskStepsEvent, replaceTaskStepsSummarySnapshots } from '../store/task-steps';
import { handleGitStatusSyncEvent, replaceGitStatusSnapshots } from '../store/task-git-status';
import {
  applyTaskCommandControllerChanged,
  replaceTaskCommandControllers,
} from '../store/task-command-controllers';

export async function fetchServerStateBootstrap(): Promise<AnyServerStateBootstrapSnapshot[]> {
  return invoke(IPC.GetServerStateBootstrap);
}

type ServerStateBootstrapPayload<TCategory extends ServerStateBootstrapCategory> =
  ServerStateBootstrapPayloadMap[TCategory];

export interface ServerStateBootstrapCategoryDescriptor<
  TCategory extends ServerStateBootstrapCategory,
> {
  applyEvent: (event: ServerStateEventPayloadMap[TCategory]) => void;
  applySnapshot: (payload: ServerStateBootstrapPayload<TCategory>, version?: number) => void;
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
  'peer-presence': replacePeerSessions,
  'task-command-controller': applyTaskCommandControllerChanged,
  'agent-supervision': applyAgentSupervisionEvent,
  'task-convergence': applyTaskConvergenceEvent,
  'task-review': applyTaskReviewEvent,
  'task-steps': applyTaskStepsEvent,
  'task-ports': applyTaskPortsEvent,
};

function createReplaceVersionOptions(version: number | undefined): { replaceVersion?: number } {
  if (version === undefined) {
    return {};
  }

  return { replaceVersion: version };
}

const SERVER_STATE_SNAPSHOT_APPLIERS: {
  [TCategory in ServerStateBootstrapCategory]: (
    payload: ServerStateBootstrapPayloadMap[TCategory],
    version?: number,
  ) => void;
} = {
  'git-status': (payload, version) =>
    replaceGitStatusSnapshots(payload, createReplaceVersionOptions(version)),
  'remote-status': (payload) => applyRemoteStatus(payload),
  'peer-presence': (payload) => replacePeerSessions(payload),
  'task-command-controller': (payload, version) =>
    replaceTaskCommandControllers(payload, createReplaceVersionOptions(version)),
  'agent-supervision': (payload, version) =>
    replaceAgentSupervisionSnapshots(payload, createReplaceVersionOptions(version)),
  'task-convergence': (payload, version) =>
    replaceTaskConvergenceSnapshots(payload, createReplaceVersionOptions(version)),
  'task-review': (payload, version) =>
    replaceTaskReviewSnapshots(payload, createReplaceVersionOptions(version)),
  'task-steps': (payload, version) =>
    replaceTaskStepsSummarySnapshots(payload, createReplaceVersionOptions(version)),
  'task-ports': (payload, version) =>
    replaceTaskPortSnapshots(payload, createReplaceVersionOptions(version)),
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
  SERVER_STATE_SNAPSHOT_APPLIERS[snapshot.category](snapshot.payload, snapshot.version);
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
  version?: number,
): void {
  SERVER_STATE_SNAPSHOT_APPLIERS[category](payload, version);
}

type ServerStateBootstrapGateState =
  | {
      kind: 'booting';
      pendingEvents: PendingEventQueue;
      pendingSnapshots: PendingSnapshotQueue;
    }
  | { kind: 'ready' }
  | { kind: 'disposed' };

interface PendingSnapshot {
  payload: unknown;
  version?: number;
}

type PendingSnapshotQueue = Map<ServerStateBootstrapCategory, PendingSnapshot>;

type PendingEventQueue = {
  [TCategory in ServerStateBootstrapCategory]: ServerStateEventPayloadMap[TCategory][];
};

function createPendingEventQueue(): PendingEventQueue {
  return {
    'git-status': [],
    'remote-status': [],
    'peer-presence': [],
    'task-command-controller': [],
    'agent-supervision': [],
    'task-convergence': [],
    'task-review': [],
    'task-steps': [],
    'task-ports': [],
  };
}

function applyDescriptorSnapshot<TCategory extends ServerStateBootstrapCategory>(
  descriptor: ServerStateBootstrapCategoryDescriptor<TCategory>,
  payload: ServerStateBootstrapPayload<TCategory>,
  version: number | undefined,
): void {
  if (version === undefined) {
    descriptor.applySnapshot(payload);
    return;
  }

  descriptor.applySnapshot(payload, version);
}

function createPendingSnapshot(payload: unknown, version: number | undefined): PendingSnapshot {
  if (version === undefined) {
    return { payload };
  }

  return { payload, version };
}

function shouldKeepPendingSnapshot(
  currentSnapshot: PendingSnapshot | undefined,
  nextVersion: number | undefined,
): boolean {
  if (!currentSnapshot) {
    return false;
  }

  if (nextVersion === undefined) {
    return currentSnapshot.version !== undefined;
  }

  return (currentSnapshot.version ?? -1) > nextVersion;
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
    pendingSnapshots: new Map(),
  };

  function flushPendingSnapshots<TCategory extends ServerStateBootstrapCategory>(
    pendingSnapshots: PendingSnapshotQueue,
    category: TCategory,
  ): void {
    const snapshot = pendingSnapshots.get(category);
    if (snapshot !== undefined) {
      applyDescriptorSnapshot(
        descriptors[category],
        snapshot.payload as ServerStateBootstrapPayload<TCategory>,
        snapshot.version,
      );
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
    pendingSnapshots: PendingSnapshotQueue,
    pendingEvents: PendingEventQueue,
  ): void {
    for (const category of SERVER_STATE_BOOTSTRAP_CATEGORIES) {
      emitStartupBreadcrumb(`bootstrap-gate:drain:${category}:start`);
      flushPendingSnapshots(pendingSnapshots, category);
      flushPendingEvents(pendingEvents, category);
      emitStartupBreadcrumb(`bootstrap-gate:drain:${category}:complete`);
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
      version?: number,
    ): void {
      switch (state.kind) {
        case 'booting': {
          const currentSnapshot = state.pendingSnapshots.get(category);
          if (shouldKeepPendingSnapshot(currentSnapshot, version)) {
            return;
          }

          recordBufferedBootstrapSnapshot(category);
          state.pendingSnapshots.set(category, createPendingSnapshot(payload, version));
          return;
        }
        case 'ready':
          applyDescriptorSnapshot(descriptors[category], payload, version);
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

      emitStartupBreadcrumb('bootstrap-gate:complete:start');
      const pendingSnapshots = state.pendingSnapshots;
      const pendingEvents = state.pendingEvents;
      state = { kind: 'ready' };

      drainPendingState(pendingSnapshots, pendingEvents);

      recordBootstrapCompletion(Date.now() - createdAt);
      emitStartupBreadcrumb('bootstrap-gate:complete:done');
    },
    dispose(): void {
      state = { kind: 'disposed' };
    },
  };
}
