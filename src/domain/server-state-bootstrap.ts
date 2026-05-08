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
import type { TaskConvergenceEvent, TaskConvergenceSnapshot } from './task-convergence.js';
import type { TaskStepsEvent, TaskStepsSummarySnapshot } from './task-steps.js';
import type { TaskReviewEvent, TaskReviewSnapshot } from './task-review.js';
import type { TaskReviewSignalsEvent, TaskReviewSignalsSnapshot } from './task-review-signals.js';

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
] as const;

export type ServerStateBootstrapCategory = (typeof SERVER_STATE_BOOTSTRAP_CATEGORIES)[number];

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
