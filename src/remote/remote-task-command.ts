import { isTypingTaskCommandFocusedSurface } from '../domain/task-command-focus';
import { assertNever } from '../lib/assert-never';
import {
  acquireRemoteTaskCommandLease,
  releaseRemoteTaskCommandLease,
  renewRemoteTaskCommandLease,
  resizeRemoteAgent,
  writeRemoteAgent,
} from './remote-ipc';
import { getRemoteClientId } from './client-id';
import {
  applyRemoteTaskCommandControllerChanged,
  getRemoteTaskCommandController,
  getRemoteTaskControllerOwnerStatus,
} from './remote-collaboration';
import {
  bumpTaskCommandGeneration,
  clearSendQueues,
  clearTaskCommandGenerations,
  getLocalTaskCommandLease,
  getLocalTaskCommandLeaseKeys,
  getOrCreateLocalTaskCommandLease,
  getSendQueue,
  setSendQueue,
  deleteSendQueue,
  type RemoteTaskCommandLeaseState,
} from './remote-task-command-state';
import {
  cleanupIdleTaskCommandSubscriptions,
  cleanupReleasedTaskCommandLease,
  clearIdleTimer,
  clearTaskCommandLeaseTimers,
  clearRenewTimer,
  createRemoteTaskCommandAttempt,
  ensureRemoteTaskCommandSubscriptions,
  hasRemoteTaskCommandTransportAvailability,
  isRemoteTaskCommandAttemptCurrent,
  requestTaskTakeover,
  resetRemoteTaskCommandSubscriptionsForTests,
} from './remote-task-command-subscriptions';
import { sendWhenConnected } from './ws';

const REMOTE_LEASE_OWNER_ID_KEY = 'parallel-code-remote-lease-owner-id';
const TASK_COMMAND_ACTION = 'type in the terminal';
const TASK_COMMAND_LEASE_RENEW_MS = 5_000;
const TASK_COMMAND_LEASE_IDLE_MS = 5_000;

type RemoteAcquireTaskCommandResult = Awaited<ReturnType<typeof acquireRemoteTaskCommandLease>>;
type RemoteRenewTaskCommandResult = Awaited<ReturnType<typeof renewRemoteTaskCommandLease>>;
type RemoteReleaseTaskCommandResult = Awaited<ReturnType<typeof releaseRemoteTaskCommandLease>>;

function getRemoteLeaseOwnerId(): string {
  if (typeof sessionStorage === 'undefined') {
    return 'remote-lease-owner';
  }

  const existingOwnerId = sessionStorage.getItem(REMOTE_LEASE_OWNER_ID_KEY);
  if (existingOwnerId) {
    return existingOwnerId;
  }

  const nextOwnerId = crypto.randomUUID();
  sessionStorage.setItem(REMOTE_LEASE_OWNER_ID_KEY, nextOwnerId);
  return nextOwnerId;
}

function hasRetainedTaskCommandOwnership(taskId: string): boolean {
  const controller = getRemoteTaskCommandController(taskId);
  return (
    hasRemoteTaskCommandTransportAvailability() && controller?.controllerId === getRemoteClientId()
  );
}

function didAcquireRemoteTaskCommand(result: RemoteAcquireTaskCommandResult): boolean {
  return result.acquired || result.controllerId === getRemoteClientId();
}

function scheduleIdleRelease(taskId: string, lease: RemoteTaskCommandLeaseState): void {
  clearIdleTimer(lease);
  lease.idleTimer = setTimeout(() => {
    void releaseRemoteTaskCommand(taskId);
  }, TASK_COMMAND_LEASE_IDLE_MS);
}

function markLeaseRetained(taskId: string, lease: RemoteTaskCommandLeaseState): void {
  if (!hasRemoteTaskCommandTransportAvailability()) {
    return;
  }

  lease.releaseRequested = false;
  lease.retained = true;
  startRenewal(taskId, lease);
  releaseCompetingTypingLeases(taskId);
  scheduleIdleRelease(taskId, lease);
}

function startRenewal(taskId: string, lease: RemoteTaskCommandLeaseState): void {
  clearRenewTimer(lease);
  lease.renewTimer = setInterval(() => {
    if (!lease.retained || lease.releaseRequested || !hasRetainedTaskCommandOwnership(taskId)) {
      clearRenewTimer(lease);
      return;
    }

    void renewRemoteTaskCommandLease({
      clientId: getRemoteClientId(),
      ownerId: getRemoteLeaseOwnerId(),
      taskId,
    })
      .then((result: RemoteRenewTaskCommandResult) => {
        applyRemoteTaskCommandControllerChanged(result);
        if (!result.renewed || !hasRetainedTaskCommandOwnership(taskId)) {
          clearRenewTimer(lease);
        }
      })
      .catch(() => {
        clearRenewTimer(lease);
      });
  }, TASK_COMMAND_LEASE_RENEW_MS);
}

function releaseCompetingTypingLeases(activeTaskId: string): void {
  for (const taskId of getLocalTaskCommandLeaseKeys()) {
    if (taskId === activeTaskId) {
      continue;
    }

    void releaseRemoteTaskCommand(taskId);
  }
}

async function acquireRemoteTaskCommand(
  taskId: string,
  takeover: boolean,
): Promise<RemoteAcquireTaskCommandResult> {
  ensureRemoteTaskCommandSubscriptions();
  const result = await acquireRemoteTaskCommandLease({
    action: TASK_COMMAND_ACTION,
    clientId: getRemoteClientId(),
    ownerId: getRemoteLeaseOwnerId(),
    ...(takeover ? { takeover: true } : {}),
    taskId,
  });
  applyRemoteTaskCommandControllerChanged(result);
  return result;
}

async function retainRemoteTaskCommandLease(taskId: string): Promise<boolean> {
  ensureRemoteTaskCommandSubscriptions();
  const attempt = createRemoteTaskCommandAttempt(taskId);
  if (!attempt) {
    return false;
  }

  const lease = getOrCreateLocalTaskCommandLease(taskId);

  if (lease.retained && !lease.releaseRequested && hasRetainedTaskCommandOwnership(taskId)) {
    scheduleIdleRelease(taskId, lease);
    return true;
  }

  if (!lease.retainingPromise) {
    lease.releaseRequested = false;
    lease.retainingPromise = acquireRemoteTaskCommand(taskId, false)
      .then((result) => {
        if (
          !didAcquireRemoteTaskCommand(result) ||
          lease.releaseRequested ||
          !isRemoteTaskCommandAttemptCurrent(taskId, attempt)
        ) {
          return false;
        }

        markLeaseRetained(taskId, lease);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        lease.retainingPromise = undefined;
        cleanupReleasedTaskCommandLease(taskId);
      });
  }

  const acquired = await lease.retainingPromise;
  if (!acquired || lease.releaseRequested || !lease.retained) {
    return false;
  }

  scheduleIdleRelease(taskId, lease);
  return true;
}

function enqueueAgentWrite(agentId: string, write: () => Promise<boolean>): Promise<boolean> {
  const previous = getSendQueue(agentId) ?? Promise.resolve(true);
  const next = previous.catch(() => false).then(write);
  setSendQueue(
    agentId,
    next.finally(() => {
      if (getSendQueue(agentId) === next) {
        deleteSendQueue(agentId);
      }
    }),
  );
  return next;
}

export async function sendRemoteAgentInput(
  agentId: string,
  taskId: string,
  data: string,
): Promise<boolean> {
  ensureRemoteTaskCommandSubscriptions();
  const attempt = createRemoteTaskCommandAttempt(taskId);
  if (!attempt) {
    return false;
  }

  const ownerStatus = getRemoteTaskControllerOwnerStatus(taskId);
  if (ownerStatus && !ownerStatus.isSelf) {
    return false;
  }

  return enqueueAgentWrite(agentId, async () => {
    if (!isRemoteTaskCommandAttemptCurrent(taskId, attempt)) {
      return false;
    }

    const acquired = await retainRemoteTaskCommandLease(taskId);
    if (!acquired || !isRemoteTaskCommandAttemptCurrent(taskId, attempt)) {
      return false;
    }

    try {
      await writeRemoteAgent({
        agentId,
        data,
        taskId,
      });
    } catch {
      return false;
    }

    return isRemoteTaskCommandAttemptCurrent(taskId, attempt);
  });
}

export function sendRemoteAgentResize(
  agentId: string,
  taskId: string,
  cols: number,
  rows: number,
): void {
  if (!hasRetainedTaskCommandOwnership(taskId)) {
    return;
  }

  void resizeRemoteAgent({
    agentId,
    cols,
    rows,
    taskId,
  }).catch(() => {});
}

export async function requestRemoteTaskTakeover(
  taskId: string,
  force = false,
): Promise<'acquired' | 'denied' | 'force-required' | 'transport-unavailable'> {
  ensureRemoteTaskCommandSubscriptions();
  if (!hasRemoteTaskCommandTransportAvailability()) {
    return 'transport-unavailable';
  }

  const ownerStatus = getRemoteTaskControllerOwnerStatus(taskId);
  if (!ownerStatus || ownerStatus.isSelf) {
    const acquired = await retainRemoteTaskCommandLease(taskId).catch(() => false);
    return acquired ? 'acquired' : 'transport-unavailable';
  }

  if (force) {
    const acquired = await acquireRemoteTaskCommand(taskId, true)
      .then((result) => didAcquireRemoteTaskCommand(result))
      .catch(() => false);
    if (!acquired) {
      return 'transport-unavailable';
    }

    markLeaseRetained(taskId, getOrCreateLocalTaskCommandLease(taskId));
    return 'acquired';
  }

  const decision = await requestTaskTakeover(taskId, ownerStatus.controllerId).catch(
    () => 'transport-unavailable' as const,
  );
  switch (decision) {
    case 'approved':
    case 'owner-missing': {
      const acquired = await acquireRemoteTaskCommand(taskId, true)
        .then((result) => didAcquireRemoteTaskCommand(result))
        .catch(() => false);
      if (!acquired) {
        return 'transport-unavailable';
      }

      markLeaseRetained(taskId, getOrCreateLocalTaskCommandLease(taskId));
      return 'acquired';
    }
    case 'force-required':
      return 'force-required';
    case 'denied':
      return 'denied';
    case 'transport-unavailable':
      return 'transport-unavailable';
  }

  return assertNever(decision, 'Unhandled remote task-command takeover decision');
}

export async function releaseRemoteTaskCommand(taskId: string): Promise<void> {
  bumpTaskCommandGeneration(taskId);
  const lease = getLocalTaskCommandLease(taskId);
  if (!lease) {
    cleanupIdleTaskCommandSubscriptions();
    return;
  }

  lease.releaseRequested = true;
  clearTaskCommandLeaseTimers(lease);

  if (lease.retainingPromise) {
    await lease.retainingPromise.catch(() => false);
  }

  const refreshedLease = getLocalTaskCommandLease(taskId);
  if (!refreshedLease) {
    cleanupIdleTaskCommandSubscriptions();
    return;
  }

  if (!refreshedLease.retained) {
    cleanupReleasedTaskCommandLease(taskId);
    return;
  }

  refreshedLease.retained = false;
  if (!hasRemoteTaskCommandTransportAvailability()) {
    cleanupReleasedTaskCommandLease(taskId);
    return;
  }

  await releaseRemoteTaskCommandLease({
    clientId: getRemoteClientId(),
    ownerId: getRemoteLeaseOwnerId(),
    taskId,
  })
    .then((result: RemoteReleaseTaskCommandResult) => {
      applyRemoteTaskCommandControllerChanged(result);
    })
    .catch(() => {});
  cleanupReleasedTaskCommandLease(taskId);
}

export async function respondToRemoteTaskCommandTakeover(
  requestId: string,
  approved: boolean,
): Promise<boolean> {
  return sendWhenConnected({
    type: 'respond-task-command-takeover',
    approved,
    requestId,
  });
}

async function releaseInactiveTypingRemoteTaskCommandLeases(
  activeTaskId: string | null,
  focusedSurface: string | null,
): Promise<void> {
  const keepActiveTypingLease =
    activeTaskId !== null && isTypingTaskCommandFocusedSurface(focusedSurface);
  const releasePromises: Promise<void>[] = [];

  for (const taskId of getLocalTaskCommandLeaseKeys()) {
    if (keepActiveTypingLease && taskId === activeTaskId) {
      continue;
    }

    releasePromises.push(releaseRemoteTaskCommand(taskId));
  }

  if (releasePromises.length === 0) {
    return;
  }

  await Promise.allSettled(releasePromises);
}

export function syncFocusedTypingRemoteTaskCommandLease(
  activeTaskId: string | null,
  focusedSurface: string | null,
): void {
  void releaseInactiveTypingRemoteTaskCommandLeases(activeTaskId, focusedSurface);
}

export function resetRemoteTaskCommandStateForTests(): void {
  resetRemoteTaskCommandSubscriptionsForTests();
  clearSendQueues();
  clearTaskCommandGenerations();
}
