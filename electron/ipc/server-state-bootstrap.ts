import type { AnyServerStateBootstrapSnapshot } from '../../src/domain/server-state-bootstrap.js';
import { createServerStateBootstrapSnapshot } from '../../src/domain/server-state-bootstrap.js';
import type { RemoteAccessStatus } from '../../src/domain/server-state.js';
import {
  getAgentSupervisionStateVersion,
  listAgentSupervisionSnapshots,
} from './agent-supervision.js';
import { getGitStatusStateVersion, listGitStatusSnapshots } from './git-status-state.js';
import {
  getTaskConvergenceStateVersion,
  listTaskConvergenceSnapshots,
} from './task-convergence-state.js';
import { getTaskReviewStateVersion, listTaskReviewSnapshots } from './task-review-state.js';
import { getTaskPortsStateVersion, getTaskPortSnapshots } from './task-ports.js';

export interface ServerStateBootstrapContext {
  getRemoteStatus: () => RemoteAccessStatus;
  getRemoteStatusVersion?: () => number;
}

function getRemoteStatusVersion(context: ServerStateBootstrapContext): number {
  if (typeof context.getRemoteStatusVersion === 'function') {
    return context.getRemoteStatusVersion();
  }

  return Date.now();
}

export function getServerStateBootstrap(
  context: ServerStateBootstrapContext,
): AnyServerStateBootstrapSnapshot[] {
  return [
    createServerStateBootstrapSnapshot(
      'git-status',
      listGitStatusSnapshots(),
      getGitStatusStateVersion(),
    ),
    createServerStateBootstrapSnapshot(
      'remote-status',
      context.getRemoteStatus(),
      getRemoteStatusVersion(context),
    ),
    createServerStateBootstrapSnapshot(
      'agent-supervision',
      listAgentSupervisionSnapshots(),
      getAgentSupervisionStateVersion(),
    ),
    createServerStateBootstrapSnapshot(
      'task-convergence',
      listTaskConvergenceSnapshots(),
      getTaskConvergenceStateVersion(),
    ),
    createServerStateBootstrapSnapshot(
      'task-review',
      listTaskReviewSnapshots(),
      getTaskReviewStateVersion(),
    ),
    createServerStateBootstrapSnapshot(
      'task-ports',
      getTaskPortSnapshots(),
      getTaskPortsStateVersion(),
    ),
  ];
}
