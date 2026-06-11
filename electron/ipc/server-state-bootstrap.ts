import type {
  AnyServerStateBootstrapSnapshot,
  DegradedServerStateBootstrapSnapshot,
  ResyncVersionMap,
  ServerStateBootstrapCategory,
  ServerStateBootstrapPayloadMap,
  ServerStateBootstrapResultSnapshot,
} from '../../src/domain/server-state-bootstrap.js';
import { createServerStateBootstrapSnapshot } from '../../src/domain/server-state-bootstrap.js';
import {
  getCoordinatorBootstrapSnapshot,
  getCoordinatorStateVersion,
} from '../coordinator/runtime.js';
import type { PeerPresenceSnapshot, RemoteAccessStatus } from '../../src/domain/server-state.js';
import {
  getAgentAvailabilityStateVersion,
  listAgentAvailabilitySnapshots,
} from './agent-availability-state.js';
import {
  getAgentSupervisionStateVersion,
  listAgentSupervisionSnapshots,
} from './agent-supervision.js';
import { getGitStatusStateVersion, listGitStatusSnapshots } from './git-status-state.js';
import {
  getTaskConvergenceStateVersion,
  listTaskConvergenceSnapshots,
} from './task-convergence-state.js';
import {
  getTaskCommandControllers,
  getTaskCommandControllerStateVersion,
} from './task-command-leases.js';
import { getTaskReviewStateVersion, listTaskReviewSnapshots } from './task-review-state.js';
import {
  getTaskReviewSignalsStateVersion,
  listTaskReviewSignalsSnapshots,
} from './task-review-signals.js';
import { getTaskStepsStateVersion, listTaskStepsSummarySnapshots } from './task-steps.js';
import { getTaskPortsStateVersion, getTaskPortSnapshots } from './task-ports.js';

export interface ServerStateBootstrapContext {
  getPeerPresenceSnapshots?: () => PeerPresenceSnapshot[];
  getPeerPresenceVersion?: () => number;
  getRemoteStatus: () => RemoteAccessStatus;
  getRemoteStatusVersion?: () => number;
}

function getRemoteStatusVersion(context: ServerStateBootstrapContext): number {
  if (typeof context.getRemoteStatusVersion === 'function') {
    return context.getRemoteStatusVersion();
  }

  return Date.now();
}

interface ServerStateBootstrapSource {
  category: ServerStateBootstrapCategory;
  createSnapshot: () => AnyServerStateBootstrapSnapshot;
  getVersion: () => number;
}

function createSource<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
  getPayload: () => ServerStateBootstrapPayloadMap[TCategory],
  getVersion: () => number,
): ServerStateBootstrapSource {
  return {
    category,
    createSnapshot: () =>
      createServerStateBootstrapSnapshot(
        category,
        getPayload(),
        getVersion(),
      ) as AnyServerStateBootstrapSnapshot,
    getVersion,
  };
}

function getServerStateBootstrapSources(
  context: ServerStateBootstrapContext,
): ServerStateBootstrapSource[] {
  return [
    createSource('git-status', listGitStatusSnapshots, getGitStatusStateVersion),
    createSource(
      'remote-status',
      () => context.getRemoteStatus(),
      () => getRemoteStatusVersion(context),
    ),
    createSource(
      'peer-presence',
      () => context.getPeerPresenceSnapshots?.() ?? [],
      () => context.getPeerPresenceVersion?.() ?? Date.now(),
    ),
    createSource(
      'task-command-controller',
      getTaskCommandControllers,
      getTaskCommandControllerStateVersion,
    ),
    createSource('coordinator', getCoordinatorBootstrapSnapshot, getCoordinatorStateVersion),
    createSource(
      'agent-supervision',
      listAgentSupervisionSnapshots,
      getAgentSupervisionStateVersion,
    ),
    createSource(
      'agent-availability',
      listAgentAvailabilitySnapshots,
      getAgentAvailabilityStateVersion,
    ),
    createSource('task-convergence', listTaskConvergenceSnapshots, getTaskConvergenceStateVersion),
    createSource('task-review', listTaskReviewSnapshots, getTaskReviewStateVersion),
    createSource(
      'task-review-signals',
      listTaskReviewSignalsSnapshots,
      getTaskReviewSignalsStateVersion,
    ),
    createSource('task-steps', listTaskStepsSummarySnapshots, getTaskStepsStateVersion),
    createSource('task-ports', getTaskPortSnapshots, getTaskPortsStateVersion),
  ];
}

export interface GetServerStateBootstrapOptions {
  categories?: ReadonlyArray<ServerStateBootstrapCategory>;
}

function createDegradedSnapshot(
  category: ServerStateBootstrapCategory,
  error: unknown,
): DegradedServerStateBootstrapSnapshot {
  return {
    category,
    degraded: true,
    error: error instanceof Error ? error.message : String(error),
  };
}

// Per-category failure isolation: one throwing category builder yields a
// degraded marker for that category instead of failing the whole bootstrap.
export function getServerStateBootstrap(
  context: ServerStateBootstrapContext,
  options: GetServerStateBootstrapOptions = {},
): ServerStateBootstrapResultSnapshot[] {
  const requested = options.categories === undefined ? null : new Set(options.categories);
  const snapshots: ServerStateBootstrapResultSnapshot[] = [];
  for (const source of getServerStateBootstrapSources(context)) {
    if (requested !== null && !requested.has(source.category)) {
      continue;
    }

    try {
      snapshots.push(source.createSnapshot());
    } catch (error) {
      snapshots.push(createDegradedSnapshot(source.category, error));
    }
  }

  return snapshots;
}

// Per-category server-state versions in the shared resync vocabulary. These are
// per-boot counters; the persisted workspaceRevision ('workspace') is owned by
// the saved-state storage layer, not this map.
export function getServerStateBootstrapVersions(
  context: ServerStateBootstrapContext,
): ResyncVersionMap {
  const versions: ResyncVersionMap = {};
  for (const source of getServerStateBootstrapSources(context)) {
    try {
      versions[source.category] = source.getVersion();
    } catch {
      // A throwing version getter leaves the category out of the map, so the
      // reconnect handshake treats it as stale and rebuilds it.
    }
  }

  return versions;
}
