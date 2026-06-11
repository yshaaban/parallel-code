import type {
  AgentSupervisionEvent,
  AgentSupervisionSnapshot,
  GitStatusSyncEvent,
  GitStatusSyncSnapshotEvent,
  PeerPresenceSnapshot,
  RemoteAccessStatus,
  RemotePresence,
  TaskCommandControllerSnapshot,
  TaskPortsEvent,
  TaskPortSnapshot,
} from './server-state.js';
import type {
  AgentAvailabilityChangedEvent,
  AgentAvailabilitySnapshot,
} from './agent-availability.js';
import {
  isAgentAvailabilityChangedEvent,
  isAgentAvailabilitySnapshot,
} from './agent-availability.js';
import type { CoordinatorBootstrapSnapshot, CoordinatorEventEnvelope } from './coordinator.js';
import {
  isAgentSupervisionEvent,
  isAgentSupervisionSnapshot,
  isGitStatusSyncEvent,
  isGitStatusSyncSnapshotEvent,
  isPeerPresenceSnapshot,
  isRemoteAccessStatus,
  isRemotePresence,
  isTaskPortSnapshot,
  isTaskPortsEvent,
} from './server-state.js';
import { isCoordinatorBootstrapSnapshot, isCoordinatorEventEnvelope } from './coordinator.js';
import type { TaskConvergenceEvent, TaskConvergenceSnapshot } from './task-convergence.js';
import { isTaskConvergenceEvent, isTaskConvergenceSnapshot } from './task-convergence.js';
import type { TaskStepsEvent, TaskStepsSummarySnapshot } from './task-steps.js';
import { isTaskStepsEvent, isTaskStepsSummarySnapshot } from './task-steps.js';
import type { TaskReviewEvent, TaskReviewSnapshot } from './task-review.js';
import { isTaskReviewEvent, isTaskReviewSnapshot } from './task-review.js';
import type { TaskReviewSignalsEvent, TaskReviewSignalsSnapshot } from './task-review-signals.js';
import { isTaskReviewSignalsEvent, isTaskReviewSignalsSnapshot } from './task-review-signals.js';
import { isTaskCommandControllerSnapshot } from './task-command-controller-projection.js';
import {
  isArrayOf,
  isNonNegativeInteger,
  isRecord,
  isStringTupleMember,
} from '../lib/type-guards.js';

export const SERVER_STATE_BOOTSTRAP_CATEGORIES = [
  'git-status',
  'remote-status',
  'peer-presence',
  'task-command-controller',
  'agent-supervision',
  'task-convergence',
  'task-review',
  'task-review-signals',
  'task-steps',
  'task-ports',
  'coordinator',
  'agent-availability',
] as const;

export type ServerStateBootstrapCategory = (typeof SERVER_STATE_BOOTSTRAP_CATEGORIES)[number];

// Shared resync version vocabulary for reconnect/version handshakes. Per-category
// entries use the per-boot server-state bootstrap versions; 'workspace' IS the
// persisted workspaceRevision (the only restart-safe version). The transport
// agent-list counter is the 'agents' version space, but it is carried
// out-of-band on the reconnect handshake (the `agentsVersion` auth field /
// query param) rather than inside this map; the key stays reserved here so no
// second version space is ever minted for it. There is exactly one version
// space per domain; consumers must never mint a second workspace version.
export type ResyncVersionMap = Partial<
  Record<ServerStateBootstrapCategory | 'workspace' | 'agents', number>
>;

const REMOTE_ACCESS_STATUS_ONLY_FIELDS = [
  'enabled',
  'port',
  'tailscaleUrl',
  'token',
  'url',
  'wifiUrl',
] as const;

export interface ServerStateBootstrapPayloadMap {
  'git-status': GitStatusSyncSnapshotEvent[];
  'remote-status': RemoteAccessStatus;
  'peer-presence': PeerPresenceSnapshot[];
  'task-command-controller': TaskCommandControllerSnapshot[];
  'agent-supervision': AgentSupervisionSnapshot[];
  'task-convergence': TaskConvergenceSnapshot[];
  'task-review': TaskReviewSnapshot[];
  'task-review-signals': TaskReviewSignalsSnapshot[];
  'task-steps': TaskStepsSummarySnapshot[];
  'task-ports': TaskPortSnapshot[];
  coordinator: CoordinatorBootstrapSnapshot;
  'agent-availability': AgentAvailabilitySnapshot[];
}

export interface ServerStateEventPayloadMap {
  'git-status': GitStatusSyncEvent;
  'remote-status': RemoteAccessStatus | RemotePresence;
  'peer-presence': PeerPresenceSnapshot[];
  'task-command-controller': TaskCommandControllerSnapshot;
  'agent-supervision': AgentSupervisionEvent;
  'task-convergence': TaskConvergenceEvent;
  'task-review': TaskReviewEvent;
  'task-review-signals': TaskReviewSignalsEvent;
  'task-steps': TaskStepsEvent;
  'task-ports': TaskPortsEvent;
  coordinator: CoordinatorEventEnvelope;
  'agent-availability': AgentAvailabilityChangedEvent;
}

export interface ServerStateBootstrapSnapshot<
  TCategory extends ServerStateBootstrapCategory = ServerStateBootstrapCategory,
> {
  category: TCategory;
  mode: 'replace';
  payload: ServerStateBootstrapPayloadMap[TCategory];
  version: number;
}

export type AnyServerStateBootstrapSnapshot = {
  [TCategory in ServerStateBootstrapCategory]: ServerStateBootstrapSnapshot<TCategory>;
}[ServerStateBootstrapCategory];

/**
 * Per-category failure marker: one throwing category builder degrades only
 * that category instead of failing the whole bootstrap. Clients keep prior
 * state for the category and retry it targetedly. Carries no payload/version.
 */
export interface DegradedServerStateBootstrapSnapshot {
  category: ServerStateBootstrapCategory;
  degraded: true;
  error?: string;
}

export type ServerStateBootstrapResultSnapshot =
  | AnyServerStateBootstrapSnapshot
  | DegradedServerStateBootstrapSnapshot;

export function isDegradedServerStateBootstrapSnapshot(
  value: unknown,
): value is DegradedServerStateBootstrapSnapshot {
  return (
    isRecord(value) &&
    isServerStateBootstrapCategory(value.category) &&
    value.degraded === true &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

export function filterDegradedServerStateBootstrapSnapshots(
  snapshots: ReadonlyArray<unknown>,
): DegradedServerStateBootstrapSnapshot[] {
  return snapshots.filter(isDegradedServerStateBootstrapSnapshot);
}

type ServerStateBootstrapPayloadGuard<TCategory extends ServerStateBootstrapCategory> = (
  payload: unknown,
) => payload is ServerStateBootstrapPayloadMap[TCategory];

type ServerStateEventPayloadGuard<TCategory extends ServerStateBootstrapCategory> = (
  payload: unknown,
) => payload is ServerStateEventPayloadMap[TCategory];

type ServerStateBootstrapPayloadNormalizer<TCategory extends ServerStateBootstrapCategory> = (
  payload: unknown,
) => ServerStateBootstrapPayloadMap[TCategory] | null;

interface ServerStateBootstrapCategoryConfig<TCategory extends ServerStateBootstrapCategory> {
  isBootstrapPayload: ServerStateBootstrapPayloadGuard<TCategory>;
  isEventPayload: ServerStateEventPayloadGuard<TCategory>;
  normalizeBootstrapPayload: ServerStateBootstrapPayloadNormalizer<TCategory>;
  normalizeSnapshot: (
    payload: unknown,
    version: number,
  ) => ServerStateBootstrapSnapshot<TCategory> | null;
}

type ServerStateBootstrapCategoryConfigMap = {
  [TCategory in ServerStateBootstrapCategory]: ServerStateBootstrapCategoryConfig<TCategory>;
};

type ArrayServerStateBootstrapCategory = {
  [TCategory in ServerStateBootstrapCategory]: ServerStateBootstrapPayloadMap[TCategory] extends unknown[]
    ? TCategory
    : never;
}[ServerStateBootstrapCategory];

type ArrayServerStateBootstrapEntry<TCategory extends ArrayServerStateBootstrapCategory> =
  ServerStateBootstrapPayloadMap[TCategory] extends Array<infer TEntry> ? TEntry : never;

export function isServerStateBootstrapCategory(
  value: unknown,
): value is ServerStateBootstrapCategory {
  return isStringTupleMember(value, SERVER_STATE_BOOTSTRAP_CATEGORIES);
}

function normalizeArrayBootstrapPayload<TValue>(
  payload: unknown,
  guard: (value: unknown) => value is TValue,
): TValue[] | null {
  if (!Array.isArray(payload)) {
    return null;
  }

  const validEntries = payload.filter(guard);
  if (payload.length > 0 && validEntries.length === 0) {
    return null;
  }

  return validEntries;
}

function isRemotePresenceEventPayload(payload: unknown): payload is RemotePresence {
  if (!isRecord(payload) || !isRemotePresence(payload)) {
    return false;
  }

  return !REMOTE_ACCESS_STATUS_ONLY_FIELDS.some((field) => field in payload);
}

function createServerStateBootstrapCategoryConfig<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
  normalizeBootstrapPayload: ServerStateBootstrapPayloadNormalizer<TCategory>,
  isBootstrapPayload: ServerStateBootstrapPayloadGuard<TCategory>,
  isEventPayload: ServerStateEventPayloadGuard<TCategory>,
): ServerStateBootstrapCategoryConfig<TCategory> {
  return {
    isBootstrapPayload,
    isEventPayload,
    normalizeBootstrapPayload,
    normalizeSnapshot: (payload, version) => {
      const normalizedPayload = normalizeBootstrapPayload(payload);
      return normalizedPayload === null
        ? null
        : createServerStateBootstrapSnapshot(category, normalizedPayload, version);
    },
  };
}

function createArrayServerStateBootstrapCategoryConfig<
  TCategory extends ArrayServerStateBootstrapCategory,
>(
  category: TCategory,
  isBootstrapEntry: (value: unknown) => value is ArrayServerStateBootstrapEntry<TCategory>,
  isEventPayload: ServerStateEventPayloadGuard<TCategory>,
): ServerStateBootstrapCategoryConfig<TCategory> {
  return createServerStateBootstrapCategoryConfig(
    category,
    (payload) =>
      normalizeArrayBootstrapPayload(payload, isBootstrapEntry) as
        | ServerStateBootstrapPayloadMap[TCategory]
        | null,
    (payload): payload is ServerStateBootstrapPayloadMap[TCategory] =>
      isArrayOf(payload, isBootstrapEntry),
    isEventPayload,
  );
}

const SERVER_STATE_BOOTSTRAP_CATEGORY_CONFIG = {
  'agent-availability': createArrayServerStateBootstrapCategoryConfig(
    'agent-availability',
    isAgentAvailabilitySnapshot,
    isAgentAvailabilityChangedEvent,
  ),
  'agent-supervision': createArrayServerStateBootstrapCategoryConfig(
    'agent-supervision',
    isAgentSupervisionSnapshot,
    isAgentSupervisionEvent,
  ),
  'git-status': createArrayServerStateBootstrapCategoryConfig(
    'git-status',
    isGitStatusSyncSnapshotEvent,
    isGitStatusSyncEvent,
  ),
  'peer-presence': createArrayServerStateBootstrapCategoryConfig(
    'peer-presence',
    isPeerPresenceSnapshot,
    (payload) => isArrayOf(payload, isPeerPresenceSnapshot),
  ),
  'remote-status': createServerStateBootstrapCategoryConfig(
    'remote-status',
    (payload) => (isRemoteAccessStatus(payload) ? payload : null),
    isRemoteAccessStatus,
    (payload) => isRemoteAccessStatus(payload) || isRemotePresenceEventPayload(payload),
  ),
  'task-command-controller': createArrayServerStateBootstrapCategoryConfig(
    'task-command-controller',
    isTaskCommandControllerSnapshot,
    isTaskCommandControllerSnapshot,
  ),
  coordinator: createServerStateBootstrapCategoryConfig(
    'coordinator',
    (payload) => (isCoordinatorBootstrapSnapshot(payload) ? payload : null),
    isCoordinatorBootstrapSnapshot,
    isCoordinatorEventEnvelope,
  ),
  'task-convergence': createArrayServerStateBootstrapCategoryConfig(
    'task-convergence',
    isTaskConvergenceSnapshot,
    isTaskConvergenceEvent,
  ),
  'task-ports': createArrayServerStateBootstrapCategoryConfig(
    'task-ports',
    isTaskPortSnapshot,
    isTaskPortsEvent,
  ),
  'task-review': createArrayServerStateBootstrapCategoryConfig(
    'task-review',
    isTaskReviewSnapshot,
    isTaskReviewEvent,
  ),
  'task-review-signals': createArrayServerStateBootstrapCategoryConfig(
    'task-review-signals',
    isTaskReviewSignalsSnapshot,
    isTaskReviewSignalsEvent,
  ),
  'task-steps': createArrayServerStateBootstrapCategoryConfig(
    'task-steps',
    isTaskStepsSummarySnapshot,
    isTaskStepsEvent,
  ),
} satisfies ServerStateBootstrapCategoryConfigMap;

function normalizeServerStateBootstrapSnapshotForKnownCategory(
  category: ServerStateBootstrapCategory,
  payload: unknown,
  version: number,
): AnyServerStateBootstrapSnapshot | null {
  return SERVER_STATE_BOOTSTRAP_CATEGORY_CONFIG[category].normalizeSnapshot(payload, version);
}

export function isServerStateBootstrapPayload<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
  payload: unknown,
): payload is ServerStateBootstrapPayloadMap[TCategory] {
  return SERVER_STATE_BOOTSTRAP_CATEGORY_CONFIG[category].isBootstrapPayload(payload);
}

export function normalizeServerStateBootstrapSnapshot(
  value: unknown,
): AnyServerStateBootstrapSnapshot | null {
  if (
    !isRecord(value) ||
    !isServerStateBootstrapCategory(value.category) ||
    value.mode !== 'replace' ||
    !isNonNegativeInteger(value.version)
  ) {
    return null;
  }

  return normalizeServerStateBootstrapSnapshotForKnownCategory(
    value.category,
    value.payload,
    value.version,
  );
}

export function isServerStateEventPayload<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
  payload: unknown,
): payload is ServerStateEventPayloadMap[TCategory] {
  return SERVER_STATE_BOOTSTRAP_CATEGORY_CONFIG[category].isEventPayload(payload);
}

export function isServerStateBootstrapSnapshot(
  value: unknown,
): value is AnyServerStateBootstrapSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isServerStateBootstrapCategory(value.category) &&
    value.mode === 'replace' &&
    isServerStateBootstrapPayload(value.category, value.payload) &&
    isNonNegativeInteger(value.version)
  );
}

export function filterServerStateBootstrapSnapshots(
  snapshots: ReadonlyArray<unknown>,
): AnyServerStateBootstrapSnapshot[] {
  return snapshots
    .map((snapshot) => normalizeServerStateBootstrapSnapshot(snapshot))
    .filter((snapshot): snapshot is AnyServerStateBootstrapSnapshot => snapshot !== null);
}

export function createServerStateBootstrapSnapshot<TCategory extends ServerStateBootstrapCategory>(
  category: TCategory,
  payload: ServerStateBootstrapPayloadMap[TCategory],
  version: number,
): ServerStateBootstrapSnapshot<TCategory> {
  return {
    category,
    mode: 'replace',
    payload,
    version,
  };
}
