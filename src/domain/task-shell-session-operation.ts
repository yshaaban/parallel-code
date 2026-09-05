import { isRecord } from '../lib/type-guards.js';
import { isTaskCreationOperationCapability } from './task-creation-ticket.js';
import {
  isRemoteTaskSummary,
  isTaskCatalogIdentifier,
  type RemoteTaskSummary,
} from './task-catalog.js';

export type TaskShellSessionOperationPhase =
  | 'reserved-for-task-commit'
  | 'admitted'
  | 'spawning'
  | 'awaiting-spawn-ack'
  | 'running'
  | 'failed'
  | 'cancelled'
  | 'manual-reconciliation-required';

export interface TaskShellSessionOperationIdentity {
  committedWorkspaceRevision: number | null;
  creationOperationId: string;
  expectedGeneration: number;
  operationId: string;
  sessionId: string;
  taskId: string;
}

export interface TaskShellSessionCurrentProjection {
  catalogVersion: number;
  serverInstanceId: string;
  session: {
    generation: number;
    sessionId: string;
    state: 'running' | 'stopped' | 'failed' | 'not-found';
  } | null;
  task: RemoteTaskSummary | null;
  taskClosing: boolean;
  taskState: 'present' | 'removed' | 'not-visible';
  workspaceRevision: number;
}

/**
 * Identity-only request for reconciling the backend-owned initial shell of a
 * terminal-only task. Launch material is deliberately absent: canonical task
 * state and the durable shell-session owner are the only spawn authorities.
 */
export interface ManagedTaskShellSessionRestoreRequest {
  sessionId: string;
  taskId: string;
}

export type ManagedTaskShellSessionRestoreResult =
  | {
      cols: number;
      generation: number;
      kind: 'existing' | 'restored';
      rows: number;
      sessionId: string;
      taskId: string;
    }
  | {
      kind: 'unmanaged';
      reason: 'compatibility-shell' | 'legacy-unmanaged';
      sessionId: string;
      taskId: string;
    }
  | {
      kind: 'unavailable';
      reason:
        | 'clean-restart-permit-unavailable'
        | 'identity-unavailable'
        | 'initial-shell-reconciliation-required'
        | 'restore-failed'
        | 'session-state-unavailable'
        | 'task-unavailable';
    };

export type TaskShellSessionInProgressReason =
  | 'task-commit-pending'
  | 'spawn-admission-in-progress'
  | 'spawn-ack-pending'
  | 'task-removal-commit-pending'
  | 'task-removal-finalization-pending';

export type TaskShellSessionInProgressDisposition<
  Reason extends TaskShellSessionInProgressReason = TaskShellSessionInProgressReason,
> = {
  kind: 'in-progress';
  reason: Reason;
};

export type TaskShellSessionSameTupleRetryDisposition = {
  kind: 'same-tuple-retry';
  reason: 'not-admitted' | 'proven-safe-before-spawn';
  retryUntil: number;
};

export type TaskShellSessionAttemptedNoReplayReason =
  | 'running-at-ack'
  | 'failed-after-admission'
  | 'retry-window-expired'
  | 'cancelled'
  | 'resolved-absent-or-owned-closed'
  | 'task-removed';

export type TaskShellSessionAttemptedNoReplayDisposition<
  Reason extends TaskShellSessionAttemptedNoReplayReason = TaskShellSessionAttemptedNoReplayReason,
> = {
  kind: 'attempted-no-replay';
  reason: Reason;
};

export type TaskShellSessionLocalReviewReason =
  | 'spawn-outcome-ambiguous'
  | 'task-removal-state-inconsistent';

export type TaskShellSessionLocalReviewDisposition<
  Reason extends TaskShellSessionLocalReviewReason = TaskShellSessionLocalReviewReason,
> = {
  kind: 'local-review';
  reason: Reason;
  taskSpawnQuarantined: true;
};

type TaskShellSessionFullReplayState =
  | {
      disposition: TaskShellSessionInProgressDisposition<'task-commit-pending'>;
      phase: 'reserved-for-task-commit';
    }
  | {
      disposition: TaskShellSessionInProgressDisposition<'spawn-admission-in-progress'>;
      phase: 'admitted' | 'spawning';
    }
  | {
      disposition: TaskShellSessionInProgressDisposition<'spawn-ack-pending'>;
      phase: 'awaiting-spawn-ack';
    }
  | {
      disposition: TaskShellSessionAttemptedNoReplayDisposition<'running-at-ack'>;
      phase: 'running';
    }
  | {
      disposition: TaskShellSessionAttemptedNoReplayDisposition<'cancelled'>;
      phase: 'cancelled';
    }
  | {
      disposition:
        | TaskShellSessionSameTupleRetryDisposition
        | TaskShellSessionAttemptedNoReplayDisposition<
            'failed-after-admission' | 'resolved-absent-or-owned-closed'
          >;
      phase: 'failed';
    }
  | {
      disposition: TaskShellSessionLocalReviewDisposition<'spawn-outcome-ambiguous'>;
      phase: 'manual-reconciliation-required';
    };

export type TaskShellSessionOperationReplay = {
  current: TaskShellSessionCurrentProjection;
  identity: TaskShellSessionOperationIdentity;
  recordVersion: number;
} & (
  | ({ replayKind: 'full' } & TaskShellSessionFullReplayState)
  | {
      disposition: TaskShellSessionAttemptedNoReplayDisposition<'running-at-ack'>;
      outcome: 'attempted-no-replay';
      outcomeClass: 'running-at-ack';
      replayKind: 'initial-launch-marker';
    }
  | {
      disposition: TaskShellSessionAttemptedNoReplayDisposition<
        'failed-after-admission' | 'retry-window-expired' | 'resolved-absent-or-owned-closed'
      >;
      outcome: 'attempted-no-replay';
      outcomeClass: 'failed';
      replayKind: 'initial-launch-marker';
    }
  | {
      disposition: TaskShellSessionAttemptedNoReplayDisposition<'cancelled'>;
      outcome: 'attempted-no-replay';
      outcomeClass: 'cancelled';
      replayKind: 'initial-launch-marker';
    }
  | {
      disposition: TaskShellSessionInProgressDisposition<'task-removal-commit-pending'>;
      outcome: 'task-removal-not-committed';
      replayKind: 'deletion-pending';
    }
  | {
      disposition: TaskShellSessionInProgressDisposition<'task-removal-finalization-pending'>;
      outcome: 'task-removed-finalization-pending';
      replayKind: 'deletion-pending';
    }
  | {
      disposition: TaskShellSessionAttemptedNoReplayDisposition<'task-removed'>;
      outcome: 'task-removed-no-replay';
      replayKind: 'deletion-tombstone';
    }
  | {
      disposition: TaskShellSessionAttemptedNoReplayDisposition<'cancelled'>;
      outcome: 'cancelled-before-task-commit';
      replayKind: 'deletion-tombstone';
    }
  | {
      disposition: TaskShellSessionLocalReviewDisposition<'task-removal-state-inconsistent'>;
      outcome: 'removal-state-inconsistent';
      replayKind: 'deletion-reconciliation-required';
    }
);

export interface RetryTaskShellSessionOperationRequest {
  action: 'retry-same-tuple';
  expectedRecordVersion: number;
  operationCapability: string;
  operationId: string;
}

export interface RetryTaskShellSessionOperationResult {
  outcome: 'accepted' | 'replayed' | 'version-conflict' | 'not-retryable';
  shellLaunch: TaskShellSessionOperationReplay;
}

export interface ResolveTaskShellSessionAmbiguityRequest {
  action:
    | 'adopt-if-exact-running'
    | 'resolve-if-exact-absent'
    | 'close-exact-operation-owned-process';
  expectedRecordVersion: number;
  operationId: string;
}

export interface ResolveTaskShellSessionAmbiguityResult {
  outcome:
    | 'adopted'
    | 'resolved-no-replay'
    | 'replayed'
    | 'version-conflict'
    | 'proof-insufficient';
  shellLaunch: TaskShellSessionOperationReplay;
}

export function isRetryTaskShellSessionOperationRequest(
  value: unknown,
): value is RetryTaskShellSessionOperationRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'action',
      'expectedRecordVersion',
      'operationCapability',
      'operationId',
    ]) &&
    value.action === 'retry-same-tuple' &&
    isPositiveSafeInteger(value.expectedRecordVersion) &&
    isTaskCreationOperationCapability(value.operationCapability) &&
    isTaskCatalogIdentifier(value.operationId)
  );
}

export function isResolveTaskShellSessionAmbiguityRequest(
  value: unknown,
): value is ResolveTaskShellSessionAmbiguityRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['action', 'expectedRecordVersion', 'operationId']) &&
    (value.action === 'adopt-if-exact-running' ||
      value.action === 'resolve-if-exact-absent' ||
      value.action === 'close-exact-operation-owned-process') &&
    isPositiveSafeInteger(value.expectedRecordVersion) &&
    isTaskCatalogIdentifier(value.operationId)
  );
}

export function isManagedTaskShellSessionRestoreRequest(
  value: unknown,
): value is ManagedTaskShellSessionRestoreRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['sessionId', 'taskId']) &&
    isTaskCatalogIdentifier(value.sessionId) &&
    isTaskCatalogIdentifier(value.taskId)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isIdentity(value: unknown): value is TaskShellSessionOperationIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'committedWorkspaceRevision',
      'creationOperationId',
      'expectedGeneration',
      'operationId',
      'sessionId',
      'taskId',
    ]) &&
    isTaskCatalogIdentifier(value.operationId) &&
    isTaskCatalogIdentifier(value.creationOperationId) &&
    isTaskCatalogIdentifier(value.taskId) &&
    isTaskCatalogIdentifier(value.sessionId) &&
    isNonNegativeSafeInteger(value.expectedGeneration) &&
    (value.committedWorkspaceRevision === null ||
      isPositiveSafeInteger(value.committedWorkspaceRevision))
  );
}

export function isTaskShellSessionCurrentProjection(
  value: unknown,
): value is TaskShellSessionCurrentProjection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'catalogVersion',
      'serverInstanceId',
      'session',
      'task',
      'taskClosing',
      'taskState',
      'workspaceRevision',
    ]) ||
    !isTaskCatalogIdentifier(value.serverInstanceId) ||
    !isNonNegativeSafeInteger(value.catalogVersion) ||
    !isNonNegativeSafeInteger(value.workspaceRevision) ||
    !(
      value.taskState === 'present' ||
      value.taskState === 'removed' ||
      value.taskState === 'not-visible'
    ) ||
    typeof value.taskClosing !== 'boolean'
  ) {
    return false;
  }

  if (value.taskState === 'present') {
    if (!isRemoteTaskSummary(value.task) || value.task.taskMode !== 'terminal') return false;
  } else if (value.task !== null || value.taskClosing) {
    return false;
  }

  return (
    value.session === null ||
    (isRecord(value.session) &&
      hasExactKeys(value.session, ['generation', 'sessionId', 'state']) &&
      isTaskCatalogIdentifier(value.session.sessionId) &&
      isNonNegativeSafeInteger(value.session.generation) &&
      (value.session.state === 'running' ||
        value.session.state === 'stopped' ||
        value.session.state === 'failed' ||
        value.session.state === 'not-found'))
  );
}

function isDisposition(value: unknown): value is TaskShellSessionOperationReplay['disposition'] {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.reason !== 'string') {
    return false;
  }
  switch (value.kind) {
    case 'in-progress':
      return (
        hasExactKeys(value, ['kind', 'reason']) &&
        (value.reason === 'task-commit-pending' ||
          value.reason === 'spawn-admission-in-progress' ||
          value.reason === 'spawn-ack-pending' ||
          value.reason === 'task-removal-commit-pending' ||
          value.reason === 'task-removal-finalization-pending')
      );
    case 'same-tuple-retry':
      return (
        hasExactKeys(value, ['kind', 'reason', 'retryUntil']) &&
        (value.reason === 'not-admitted' || value.reason === 'proven-safe-before-spawn') &&
        isPositiveSafeInteger(value.retryUntil)
      );
    case 'attempted-no-replay':
      return (
        hasExactKeys(value, ['kind', 'reason']) &&
        (value.reason === 'running-at-ack' ||
          value.reason === 'failed-after-admission' ||
          value.reason === 'retry-window-expired' ||
          value.reason === 'cancelled' ||
          value.reason === 'resolved-absent-or-owned-closed' ||
          value.reason === 'task-removed')
      );
    case 'local-review':
      return (
        hasExactKeys(value, ['kind', 'reason', 'taskSpawnQuarantined']) &&
        value.taskSpawnQuarantined === true &&
        (value.reason === 'spawn-outcome-ambiguous' ||
          value.reason === 'task-removal-state-inconsistent')
      );
    default:
      return false;
  }
}

function isFullReplayState(value: Record<string, unknown>): boolean {
  if (typeof value.phase !== 'string' || !isDisposition(value.disposition)) return false;
  const disposition = value.disposition;
  switch (value.phase) {
    case 'reserved-for-task-commit':
      return disposition.kind === 'in-progress' && disposition.reason === 'task-commit-pending';
    case 'admitted':
    case 'spawning':
      return (
        disposition.kind === 'in-progress' && disposition.reason === 'spawn-admission-in-progress'
      );
    case 'awaiting-spawn-ack':
      return disposition.kind === 'in-progress' && disposition.reason === 'spawn-ack-pending';
    case 'running':
      return disposition.kind === 'attempted-no-replay' && disposition.reason === 'running-at-ack';
    case 'cancelled':
      return disposition.kind === 'attempted-no-replay' && disposition.reason === 'cancelled';
    case 'failed':
      return (
        disposition.kind === 'same-tuple-retry' ||
        (disposition.kind === 'attempted-no-replay' &&
          (disposition.reason === 'failed-after-admission' ||
            disposition.reason === 'resolved-absent-or-owned-closed'))
      );
    case 'manual-reconciliation-required':
      return (
        disposition.kind === 'local-review' && disposition.reason === 'spawn-outcome-ambiguous'
      );
    default:
      return false;
  }
}

function isNonFullReplayState(value: Record<string, unknown>): boolean {
  if (!isDisposition(value.disposition)) return false;
  const disposition = value.disposition;
  switch (value.replayKind) {
    case 'initial-launch-marker':
      return (
        hasOnlyKeys(value, [
          'current',
          'disposition',
          'identity',
          'outcome',
          'outcomeClass',
          'recordVersion',
          'replayKind',
        ]) &&
        value.outcome === 'attempted-no-replay' &&
        disposition.kind === 'attempted-no-replay' &&
        ((value.outcomeClass === 'running-at-ack' && disposition.reason === 'running-at-ack') ||
          (value.outcomeClass === 'cancelled' && disposition.reason === 'cancelled') ||
          (value.outcomeClass === 'failed' &&
            (disposition.reason === 'failed-after-admission' ||
              disposition.reason === 'retry-window-expired' ||
              disposition.reason === 'resolved-absent-or-owned-closed')))
      );
    case 'deletion-pending':
      return (
        hasOnlyKeys(value, [
          'current',
          'disposition',
          'identity',
          'outcome',
          'recordVersion',
          'replayKind',
        ]) &&
        disposition.kind === 'in-progress' &&
        ((value.outcome === 'task-removal-not-committed' &&
          disposition.reason === 'task-removal-commit-pending') ||
          (value.outcome === 'task-removed-finalization-pending' &&
            disposition.reason === 'task-removal-finalization-pending'))
      );
    case 'deletion-tombstone':
      return (
        hasOnlyKeys(value, [
          'current',
          'disposition',
          'identity',
          'outcome',
          'recordVersion',
          'replayKind',
        ]) &&
        disposition.kind === 'attempted-no-replay' &&
        ((value.outcome === 'task-removed-no-replay' && disposition.reason === 'task-removed') ||
          (value.outcome === 'cancelled-before-task-commit' && disposition.reason === 'cancelled'))
      );
    case 'deletion-reconciliation-required':
      return (
        hasOnlyKeys(value, [
          'current',
          'disposition',
          'identity',
          'outcome',
          'recordVersion',
          'replayKind',
        ]) &&
        value.outcome === 'removal-state-inconsistent' &&
        disposition.kind === 'local-review' &&
        disposition.reason === 'task-removal-state-inconsistent'
      );
    default:
      return false;
  }
}

export function isTaskShellSessionOperationReplay(
  value: unknown,
): value is TaskShellSessionOperationReplay {
  if (
    !isRecord(value) ||
    !isPositiveSafeInteger(value.recordVersion) ||
    !isIdentity(value.identity) ||
    !isTaskShellSessionCurrentProjection(value.current) ||
    value.current.serverInstanceId.length === 0
  ) {
    return false;
  }

  if (
    value.current.task?.taskId !== undefined &&
    value.current.task.taskId !== value.identity.taskId
  ) {
    return false;
  }
  if (
    value.current.session !== null &&
    (value.current.session.sessionId !== value.identity.sessionId ||
      value.current.session.generation !== value.identity.expectedGeneration)
  ) {
    return false;
  }

  if (value.replayKind === 'full') {
    return (
      hasOnlyKeys(value, [
        'current',
        'disposition',
        'identity',
        'phase',
        'recordVersion',
        'replayKind',
      ]) && isFullReplayState(value)
    );
  }
  return isNonFullReplayState(value);
}

export function isRetryTaskShellSessionOperationResult(
  value: unknown,
): value is RetryTaskShellSessionOperationResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['outcome', 'shellLaunch']) &&
    (value.outcome === 'accepted' ||
      value.outcome === 'replayed' ||
      value.outcome === 'version-conflict' ||
      value.outcome === 'not-retryable') &&
    isTaskShellSessionOperationReplay(value.shellLaunch)
  );
}

export function isResolveTaskShellSessionAmbiguityResult(
  value: unknown,
): value is ResolveTaskShellSessionAmbiguityResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['outcome', 'shellLaunch']) &&
    (value.outcome === 'adopted' ||
      value.outcome === 'resolved-no-replay' ||
      value.outcome === 'replayed' ||
      value.outcome === 'version-conflict' ||
      value.outcome === 'proof-insufficient') &&
    isTaskShellSessionOperationReplay(value.shellLaunch)
  );
}

function selectCurrentProjection(
  current: TaskShellSessionCurrentProjection,
  incoming: TaskShellSessionCurrentProjection,
): TaskShellSessionCurrentProjection {
  if (current.serverInstanceId !== incoming.serverInstanceId) return incoming;
  return incoming.catalogVersion >= current.catalogVersion ? incoming : current;
}

export function reduceTaskShellSessionOperationReplay(
  current: TaskShellSessionOperationReplay | null,
  incoming: TaskShellSessionOperationReplay,
): TaskShellSessionOperationReplay {
  if (!isTaskShellSessionOperationReplay(incoming)) {
    throw new Error('Invalid task shell session replay');
  }
  if (!current || current.current.serverInstanceId !== incoming.current.serverInstanceId) {
    return incoming;
  }
  if (
    current.identity.operationId !== incoming.identity.operationId ||
    current.identity.sessionId !== incoming.identity.sessionId ||
    current.identity.expectedGeneration !== incoming.identity.expectedGeneration
  ) {
    throw new Error('Task shell replay identity changed');
  }

  const latestShell = incoming.recordVersion >= current.recordVersion ? incoming : current;
  const latestCurrent = selectCurrentProjection(current.current, incoming.current);
  return latestShell.current === latestCurrent
    ? latestShell
    : ({ ...latestShell, current: latestCurrent } as TaskShellSessionOperationReplay);
}
