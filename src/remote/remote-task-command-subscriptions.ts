import {
  clearOptionalInterval,
  clearOptionalTimeout,
  isTaskAndTransportAttemptCurrent,
} from '../domain/task-command-lease-runtime-primitives';
import type { TaskCommandControllerSnapshot } from '../domain/server-state';
import { createRandomId } from '../lib/random-id';
import { getRemoteClientId } from './client-id';
import {
  clearIncomingRemoteTakeoverRequests,
  subscribeRemoteTaskCommandControllerChanges,
  subscribeRemoteTaskCommandTakeoverResults,
} from './remote-collaboration';
import {
  bumpTaskCommandGeneration,
  clearLocalTaskCommandLeases,
  deleteLocalTaskCommandLease,
  deletePendingTakeover,
  getLocalTaskCommandLease,
  getLocalTaskCommandLeaseEntries,
  getLocalTaskCommandLeaseValues,
  getPendingTakeover,
  getPendingTakeoverKeys,
  getTaskCommandGeneration,
  hasLocalTaskCommandLeases,
  hasPendingTakeovers,
  isRetainedRemoteTaskCommandLease,
  markRemoteTaskCommandLeaseIdle,
  setPendingTakeover,
  type RemoteTaskCommandAttempt,
  type RemoteTaskCommandLeaseState,
  type RemoteTakeoverDecision,
} from './remote-task-command-state';
import { sendWhenConnected, subscribeRemoteConnectionStatus, type ConnectionStatus } from './ws';

const TASK_COMMAND_ACTION = 'type in the terminal';
const TASK_COMMAND_TAKEOVER_TIMEOUT_MS = 10_000;
const REMOTE_TASK_COMMAND_TRANSPORT_UNAVAILABLE_STATE = {
  connected: false,
  connecting: false,
  disconnected: true,
  reconnecting: true,
} satisfies Record<ConnectionStatus, boolean>;

let removeTaskCommandControllerSubscription: (() => void) | null = null;
let removeTaskCommandTakeoverResultSubscription: (() => void) | null = null;
let removeRemoteConnectionStatusSubscription: (() => void) | null = null;
let remoteTaskCommandTransportUnavailable = true;
let remoteTaskCommandTransportGeneration = 0;

export function clearIdleTimer(lease: RemoteTaskCommandLeaseState): void {
  if (!lease.idleTimer) {
    return;
  }

  lease.idleTimer = clearOptionalTimeout(lease.idleTimer);
}

export function clearRenewTimer(lease: RemoteTaskCommandLeaseState): void {
  if (!lease.renewTimer) {
    return;
  }

  lease.renewTimer = clearOptionalInterval(lease.renewTimer);
}

export function clearTaskCommandLeaseTimers(lease: RemoteTaskCommandLeaseState): void {
  clearIdleTimer(lease);
  clearRenewTimer(lease);
}

function hasTaskCommandSubscriptionActivity(): boolean {
  return hasLocalTaskCommandLeases() || hasPendingTakeovers();
}

function clearTaskCommandSubscriptions(): void {
  removeTaskCommandControllerSubscription?.();
  removeTaskCommandControllerSubscription = null;
  removeTaskCommandTakeoverResultSubscription?.();
  removeTaskCommandTakeoverResultSubscription = null;
  removeRemoteConnectionStatusSubscription?.();
  removeRemoteConnectionStatusSubscription = null;
}

export function cleanupIdleTaskCommandSubscriptions(): void {
  if (hasTaskCommandSubscriptionActivity()) {
    return;
  }

  clearTaskCommandSubscriptions();
}

export function cleanupReleasedTaskCommandLease(taskId: string): void {
  const lease = getLocalTaskCommandLease(taskId);
  if (!lease || lease.retainingPromise || isRetainedRemoteTaskCommandLease(lease)) {
    return;
  }

  clearTaskCommandLeaseTimers(lease);
  deleteLocalTaskCommandLease(taskId);
  cleanupIdleTaskCommandSubscriptions();
}

function getTaskCommandTransportGeneration(): number {
  return remoteTaskCommandTransportGeneration;
}

export function hasRemoteTaskCommandTransportAvailability(): boolean {
  return !remoteTaskCommandTransportUnavailable;
}

export function createRemoteTaskCommandAttempt(taskId: string): RemoteTaskCommandAttempt | null {
  if (!hasRemoteTaskCommandTransportAvailability()) {
    return null;
  }

  return {
    taskGeneration: getTaskCommandGeneration(taskId),
    transportGeneration: getTaskCommandTransportGeneration(),
  };
}

export function isRemoteTaskCommandAttemptCurrent(
  taskId: string,
  attempt: RemoteTaskCommandAttempt,
): boolean {
  return isTaskAndTransportAttemptCurrent(
    getTaskCommandGeneration(taskId),
    getTaskCommandTransportGeneration(),
    attempt,
    hasRemoteTaskCommandTransportAvailability(),
  );
}

function invalidateReleasedTaskCommandLease(taskId: string): void {
  bumpTaskCommandGeneration(taskId);
  cleanupReleasedTaskCommandLease(taskId);
}

export function invalidateLocalTaskCommandLease(
  taskId: string,
  lease: RemoteTaskCommandLeaseState,
): void {
  markRemoteTaskCommandLeaseIdle(lease);
  lease.releaseRequested = false;
  clearTaskCommandLeaseTimers(lease);
  invalidateReleasedTaskCommandLease(taskId);
}

export function resolvePendingTakeoverRequest(
  requestId: string,
  decision: RemoteTakeoverDecision,
): void {
  const pendingTakeover = getPendingTakeover(requestId);
  if (!pendingTakeover) {
    return;
  }

  clearTimeout(pendingTakeover.timer);
  deletePendingTakeover(requestId);
  pendingTakeover.resolve(decision);
  cleanupIdleTaskCommandSubscriptions();
}

function resolveAllPendingTakeovers(decision: RemoteTakeoverDecision): void {
  for (const requestId of Array.from(getPendingTakeoverKeys())) {
    resolvePendingTakeoverRequest(requestId, decision);
  }
}

function invalidateAllTaskCommandLeases(): void {
  for (const [taskId, lease] of getLocalTaskCommandLeaseEntries()) {
    invalidateLocalTaskCommandLease(taskId, lease);
  }
}

function handleRemoteTaskCommandTransportUnavailable(): void {
  if (remoteTaskCommandTransportUnavailable) {
    return;
  }

  remoteTaskCommandTransportUnavailable = true;
  remoteTaskCommandTransportGeneration += 1;
  resolveAllPendingTakeovers('transport-unavailable');
  clearIncomingRemoteTakeoverRequests();
  invalidateAllTaskCommandLeases();
  cleanupIdleTaskCommandSubscriptions();
}

function handleRemoteTaskCommandTransportConnected(): void {
  remoteTaskCommandTransportUnavailable = false;
}

function isRemoteTaskCommandTransportUnavailableState(nextStatus: ConnectionStatus): boolean {
  return REMOTE_TASK_COMMAND_TRANSPORT_UNAVAILABLE_STATE[nextStatus];
}

function handleTaskCommandControllerChanged(snapshot: TaskCommandControllerSnapshot): void {
  if (snapshot.controllerId === getRemoteClientId()) {
    return;
  }

  const lease = getLocalTaskCommandLease(snapshot.taskId);
  if (!lease) {
    return;
  }

  invalidateLocalTaskCommandLease(snapshot.taskId, lease);
}

function handleRemoteConnectionStatusChanged(nextStatus: ConnectionStatus): void {
  if (isRemoteTaskCommandTransportUnavailableState(nextStatus)) {
    handleRemoteTaskCommandTransportUnavailable();
    return;
  }

  handleRemoteTaskCommandTransportConnected();
}

export function ensureRemoteTaskCommandSubscriptions(): void {
  if (!removeTaskCommandControllerSubscription) {
    removeTaskCommandControllerSubscription = subscribeRemoteTaskCommandControllerChanges(
      handleTaskCommandControllerChanged,
    );
  }

  if (!removeTaskCommandTakeoverResultSubscription) {
    removeTaskCommandTakeoverResultSubscription = subscribeRemoteTaskCommandTakeoverResults(
      (message) => {
        resolvePendingTakeoverRequest(message.requestId, message.decision);
      },
    );
  }

  if (!removeRemoteConnectionStatusSubscription) {
    removeRemoteConnectionStatusSubscription = subscribeRemoteConnectionStatus(
      handleRemoteConnectionStatusChanged,
    );
  }
}

export function createPendingTakeover(requestId: string): Promise<RemoteTakeoverDecision> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      deletePendingTakeover(requestId);
      cleanupIdleTaskCommandSubscriptions();
      resolve('force-required');
    }, TASK_COMMAND_TAKEOVER_TIMEOUT_MS);

    setPendingTakeover(requestId, { resolve, timer });
  });
}

export async function requestTaskTakeover(
  taskId: string,
  targetControllerId: string,
  requesterOwnerId?: string,
): Promise<RemoteTakeoverDecision> {
  const requestId = createRandomId();
  const resultPromise = createPendingTakeover(requestId);
  const sent = await sendWhenConnected({
    type: 'request-task-command-takeover',
    action: TASK_COMMAND_ACTION,
    requestId,
    ...(requesterOwnerId ? { requesterOwnerId } : {}),
    targetControllerId,
    taskId,
  });
  if (!sent) {
    resolvePendingTakeoverRequest(requestId, 'transport-unavailable');
    return 'transport-unavailable';
  }
  return resultPromise;
}

export function resetRemoteTaskCommandSubscriptionsForTests(): void {
  for (const lease of getLocalTaskCommandLeaseValues()) {
    clearTaskCommandLeaseTimers(lease);
  }

  clearLocalTaskCommandLeases();
  resolveAllPendingTakeovers('transport-unavailable');
  clearIncomingRemoteTakeoverRequests();
  clearTaskCommandSubscriptions();
  remoteTaskCommandTransportUnavailable = true;
  remoteTaskCommandTransportGeneration = 0;
}
