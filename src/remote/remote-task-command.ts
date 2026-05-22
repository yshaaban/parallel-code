import { isTypingTaskCommandFocusedSurface } from '../domain/task-command-focus';
import { assertNever } from '../lib/assert-never';
import {
  getSafeSessionStorage,
  getSafeStorageItem,
  setSafeStorageItem,
} from '../lib/browser-storage';
import { createRandomId } from '../lib/random-id';
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
  getRetainedRemoteTaskCommandLeaseGeneration,
  getLocalTaskCommandLease,
  getLocalTaskCommandLeaseKeys,
  getOrCreateLocalTaskCommandLease,
  getSendQueue,
  isRetainedRemoteTaskCommandLease,
  markRemoteTaskCommandLeaseIdle,
  markRemoteTaskCommandLeaseRetained,
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
import {
  nextRemoteInputOrder,
  nextRemoteResizeOrder,
  resetRemoteTerminalOrderForTests,
  rotateRemoteInputOrder,
  rotateRemoteResizeOrder,
} from './remote-terminal-order';
import { send } from './ws';

const REMOTE_LEASE_OWNER_ID_KEY = 'parallel-code-remote-lease-owner-id';
const TASK_COMMAND_ACTION = 'type in the terminal';
const TASK_COMMAND_LEASE_RENEW_MS = 5_000;
const TASK_COMMAND_LEASE_IDLE_MS = 5_000;
let runtimeRemoteLeaseOwnerId: string | null = null;

type RemoteAcquireTaskCommandResult = Awaited<ReturnType<typeof acquireRemoteTaskCommandLease>>;
type RemoteRenewTaskCommandResult = Awaited<ReturnType<typeof renewRemoteTaskCommandLease>>;
type RemoteReleaseTaskCommandResult = Awaited<ReturnType<typeof releaseRemoteTaskCommandLease>>;

function getRuntimeRemoteLeaseOwnerId(): string {
  runtimeRemoteLeaseOwnerId ??= createRandomId();
  return runtimeRemoteLeaseOwnerId;
}

function getRemoteLeaseOwnerId(): string {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return getRuntimeRemoteLeaseOwnerId();
  }

  const existingOwnerId = getSafeStorageItem(storage, REMOTE_LEASE_OWNER_ID_KEY);
  if (existingOwnerId) {
    runtimeRemoteLeaseOwnerId = existingOwnerId;
    return existingOwnerId;
  }

  const nextOwnerId = getRuntimeRemoteLeaseOwnerId();
  setSafeStorageItem(storage, REMOTE_LEASE_OWNER_ID_KEY, nextOwnerId);
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

function markLeaseRetained(
  taskId: string,
  lease: RemoteTaskCommandLeaseState,
  leaseGeneration: number,
): void {
  if (!hasRemoteTaskCommandTransportAvailability()) {
    return;
  }

  lease.releaseRequested = false;
  markRemoteTaskCommandLeaseRetained(lease, leaseGeneration);
  startRenewal(taskId, lease);
  releaseCompetingTypingLeases(taskId);
  scheduleIdleRelease(taskId, lease);
}

function startRenewal(taskId: string, lease: RemoteTaskCommandLeaseState): void {
  clearRenewTimer(lease);
  lease.renewTimer = setInterval(() => {
    if (
      !isRetainedRemoteTaskCommandLease(lease) ||
      lease.releaseRequested ||
      !hasRetainedTaskCommandOwnership(taskId)
    ) {
      clearRenewTimer(lease);
      return;
    }

    void renewRemoteTaskCommandLease({
      clientId: getRemoteClientId(),
      leaseGeneration: lease.ownership.leaseGeneration,
      ownerId: getRemoteLeaseOwnerId(),
      taskId,
    })
      .then((result: RemoteRenewTaskCommandResult) => {
        applyRemoteTaskCommandControllerChanged(result);
        if (result.renewed) {
          markRemoteTaskCommandLeaseRetained(lease, result.leaseGeneration);
        }
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
  return result;
}

async function releaseAcquiredRemoteTaskCommandLease(
  taskId: string,
  leaseGeneration: number,
): Promise<void> {
  if (!hasRemoteTaskCommandTransportAvailability()) {
    return;
  }

  await releaseRemoteTaskCommandLease({
    clientId: getRemoteClientId(),
    leaseGeneration,
    ownerId: getRemoteLeaseOwnerId(),
    taskId,
  })
    .then((result: RemoteReleaseTaskCommandResult) => {
      applyRemoteTaskCommandControllerChanged(result);
    })
    .catch(() => {});
}

async function cleanupUnretainedRemoteTaskCommandAcquire(
  taskId: string,
  attempt: ReturnType<typeof createRemoteTaskCommandAttempt>,
  result: RemoteAcquireTaskCommandResult,
): Promise<void> {
  if (didAcquireRemoteTaskCommand(result)) {
    await releaseAcquiredRemoteTaskCommandLease(taskId, result.leaseGeneration);
  } else if (attempt && isRemoteTaskCommandAttemptCurrent(taskId, attempt)) {
    applyRemoteTaskCommandControllerChanged(result);
  }

  cleanupReleasedTaskCommandLease(taskId);
}

async function acquireAndRetainTakeoverLease(taskId: string): Promise<boolean> {
  const attempt = createRemoteTaskCommandAttempt(taskId);
  if (!attempt) {
    return false;
  }

  const lease = getOrCreateLocalTaskCommandLease(taskId);
  lease.releaseRequested = false;

  const result = await acquireRemoteTaskCommand(taskId, true);

  const canRetainAcquiredLease =
    didAcquireRemoteTaskCommand(result) &&
    !lease.releaseRequested &&
    getLocalTaskCommandLease(taskId) === lease &&
    isRemoteTaskCommandAttemptCurrent(taskId, attempt);

  if (!canRetainAcquiredLease) {
    await cleanupUnretainedRemoteTaskCommandAcquire(taskId, attempt, result);
    return false;
  }

  applyRemoteTaskCommandControllerChanged(result);
  markLeaseRetained(taskId, lease, result.leaseGeneration);
  return true;
}

async function retainRemoteTaskCommandLease(taskId: string): Promise<boolean> {
  ensureRemoteTaskCommandSubscriptions();
  const attempt = createRemoteTaskCommandAttempt(taskId);
  if (!attempt) {
    return false;
  }

  const lease = getOrCreateLocalTaskCommandLease(taskId);

  if (
    isRetainedRemoteTaskCommandLease(lease) &&
    !lease.releaseRequested &&
    hasRetainedTaskCommandOwnership(taskId)
  ) {
    scheduleIdleRelease(taskId, lease);
    return true;
  }

  if (!lease.retainingPromise) {
    lease.releaseRequested = false;
    lease.retainingPromise = acquireRemoteTaskCommand(taskId, false)
      .then(async (result) => {
        if (
          !didAcquireRemoteTaskCommand(result) ||
          lease.releaseRequested ||
          !isRemoteTaskCommandAttemptCurrent(taskId, attempt)
        ) {
          await cleanupUnretainedRemoteTaskCommandAcquire(
            taskId,
            lease.releaseRequested ? null : attempt,
            result,
          );
          return false;
        }

        applyRemoteTaskCommandControllerChanged(result);
        markLeaseRetained(taskId, lease, result.leaseGeneration);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        lease.retainingPromise = undefined;
        cleanupReleasedTaskCommandLease(taskId);
      });
  }

  const acquired = await lease.retainingPromise;
  if (!acquired || lease.releaseRequested || !isRetainedRemoteTaskCommandLease(lease)) {
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
      const order = nextRemoteInputOrder(agentId);
      await writeRemoteAgent({
        agentId,
        data,
        inputEpoch: order.epoch,
        inputSeq: order.seq,
        taskId,
      });
    } catch {
      rotateRemoteInputOrder(agentId);
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

  const order = nextRemoteResizeOrder(agentId);
  void resizeRemoteAgent({
    agentId,
    cols,
    resizeEpoch: order.epoch,
    resizeSeq: order.seq,
    rows,
    taskId,
  }).catch(() => {
    rotateRemoteResizeOrder(agentId);
  });
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
    const acquired = await acquireAndRetainTakeoverLease(taskId).catch(() => false);
    if (!acquired) {
      return 'transport-unavailable';
    }

    return 'acquired';
  }

  const decision = await requestTaskTakeover(
    taskId,
    ownerStatus.controllerId,
    getRemoteLeaseOwnerId(),
  ).catch(() => 'transport-unavailable' as const);
  switch (decision) {
    case 'approved':
    case 'owner-missing': {
      const acquired = await acquireAndRetainTakeoverLease(taskId).catch(() => false);
      if (!acquired) {
        return 'transport-unavailable';
      }

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
  if (!refreshedLease || refreshedLease !== lease) {
    cleanupIdleTaskCommandSubscriptions();
    return;
  }

  const leaseGeneration = getRetainedRemoteTaskCommandLeaseGeneration(refreshedLease);
  if (leaseGeneration === undefined) {
    cleanupReleasedTaskCommandLease(taskId);
    return;
  }

  markRemoteTaskCommandLeaseIdle(refreshedLease);
  if (!hasRemoteTaskCommandTransportAvailability()) {
    cleanupReleasedTaskCommandLease(taskId);
    return;
  }

  await releaseRemoteTaskCommandLease({
    clientId: getRemoteClientId(),
    leaseGeneration,
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
  ensureRemoteTaskCommandSubscriptions();
  if (!hasRemoteTaskCommandTransportAvailability()) {
    return false;
  }

  return send({
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
  resetRemoteTerminalOrderForTests();
  runtimeRemoteLeaseOwnerId = null;
}
