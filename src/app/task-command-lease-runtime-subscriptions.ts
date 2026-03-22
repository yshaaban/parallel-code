import type {
  TaskCommandTakeoverRequestMessage,
  TaskCommandTakeoverResultMessage as ProtocolTaskCommandTakeoverResultMessage,
} from '../../electron/remote/protocol';
import { assertNever } from '../lib/assert-never';
import { isElectronRuntime, onBrowserTransportEvent } from '../lib/ipc';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import {
  hasIncomingTaskTakeoverRequests,
  upsertIncomingTaskTakeoverRequest,
} from '../store/task-command-takeovers';
import {
  assertTaskCommandTakeoverStateCleanForTests,
  clearIncomingTaskCommandTakeoverRequestState,
  clearIncomingTaskCommandTakeoverRequestStateForAll,
  resetTaskCommandTakeoverStateForTests,
  resolveAllPendingTaskCommandTakeovers,
  resolveTaskCommandTakeoverDecision,
} from './task-command-lease-takeover';
import { subscribeTaskCommandControllerChanges } from '../store/task-command-controllers';
import {
  assertTaskCommandLeaseRuntimeStateStoreClean,
  clearAllTaskCommandLeaseRenewals,
  clearTaskCommandLeaseRenewal,
  hasLocalTaskCommandLeases,
  hasTaskCommandLeaseSessionInvalidators,
  invalidateAllTaskCommandLeaseSessions,
  invalidateTaskCommandLeaseSessions,
  resetTaskCommandLeaseRuntimeStateStore,
} from './task-command-lease-runtime-state';

const taskCommandLeaseRuntimeSubscriptions = {
  removeTaskCommandControllerSubscription: null as (() => void) | null,
  removeTaskCommandLeaseTransportSubscription: null as (() => void) | null,
  taskCommandLeaseTransportGeneration: 0,
  taskCommandLeaseTransportUnavailable: false,
};

function clearTaskCommandLeaseSubscriptions(): void {
  taskCommandLeaseRuntimeSubscriptions.removeTaskCommandControllerSubscription?.();
  taskCommandLeaseRuntimeSubscriptions.removeTaskCommandControllerSubscription = null;
  taskCommandLeaseRuntimeSubscriptions.removeTaskCommandLeaseTransportSubscription?.();
  taskCommandLeaseRuntimeSubscriptions.removeTaskCommandLeaseTransportSubscription = null;
}

function clearIncomingTaskTakeoverRequestAndCleanup(requestId: string): void {
  clearIncomingTaskCommandTakeoverRequestState(requestId);
  cleanupIdleTaskCommandLeaseSubscriptions();
}

export function handleIncomingTaskCommandTakeoverRequest(
  message: TaskCommandTakeoverRequestMessage,
): void {
  ensureTaskCommandLeaseTransportSubscription();
  upsertIncomingTaskTakeoverRequest({
    action: message.action,
    expiresAt: message.expiresAt,
    requestId: message.requestId,
    requesterClientId: message.requesterClientId,
    requesterDisplayName: message.requesterDisplayName,
    taskId: message.taskId,
  });
}

function clearIncomingTaskTakeoverRequestsAndCleanup(): void {
  clearIncomingTaskCommandTakeoverRequestStateForAll();
  cleanupIdleTaskCommandLeaseSubscriptions();
}

function handleTaskCommandControllerChanged({
  controllerId,
  taskId,
}: {
  controllerId: string | null;
  taskId: string;
}): void {
  if (controllerId === getRuntimeClientId()) {
    return;
  }

  clearTaskCommandLeaseRenewal(taskId);
  invalidateTaskCommandLeaseSessions(taskId);
}

function ensureTaskCommandControllerSubscription(): void {
  if (taskCommandLeaseRuntimeSubscriptions.removeTaskCommandControllerSubscription) {
    return;
  }

  taskCommandLeaseRuntimeSubscriptions.removeTaskCommandControllerSubscription =
    subscribeTaskCommandControllerChanges(handleTaskCommandControllerChanged);
}

function hasTaskCommandLeaseSubscriptionActivity(): boolean {
  return (
    hasLocalTaskCommandLeases() ||
    hasTaskCommandLeaseSessionInvalidators() ||
    hasIncomingTaskTakeoverRequests()
  );
}

export function cleanupIdleTaskCommandLeaseSubscriptions(): void {
  if (hasTaskCommandLeaseSubscriptionActivity()) {
    return;
  }

  clearTaskCommandLeaseSubscriptions();
}

export function ensureTaskCommandLeaseSubscriptions(): void {
  ensureTaskCommandControllerSubscription();
  ensureTaskCommandLeaseTransportSubscription();
}

function handleTaskCommandLeaseTransportUnavailable(): void {
  taskCommandLeaseRuntimeSubscriptions.taskCommandLeaseTransportUnavailable = true;
  taskCommandLeaseRuntimeSubscriptions.taskCommandLeaseTransportGeneration += 1;
  resolveAllPendingTaskCommandTakeovers('transport-unavailable');
  clearIncomingTaskTakeoverRequestsAndCleanup();
  clearAllTaskCommandLeaseRenewals();
  invalidateAllTaskCommandLeaseSessions();
}

function isTaskCommandLeaseTransportUnavailableState(
  state: 'auth-expired' | 'connected' | 'connecting' | 'disconnected' | 'reconnecting',
): boolean {
  switch (state) {
    case 'auth-expired':
    case 'disconnected':
    case 'reconnecting':
      return true;
    case 'connected':
    case 'connecting':
      return false;
  }

  return assertNever(state, 'Unhandled task-command lease transport state');
}

export function getTaskCommandLeaseTransportGeneration(): number {
  if (isElectronRuntime()) {
    return 0;
  }

  return taskCommandLeaseRuntimeSubscriptions.taskCommandLeaseTransportGeneration;
}

export function hasTaskCommandLeaseTransportAvailability(): boolean {
  return (
    isElectronRuntime() ||
    !taskCommandLeaseRuntimeSubscriptions.taskCommandLeaseTransportUnavailable
  );
}

function ensureTaskCommandLeaseTransportSubscription(): void {
  if (
    isElectronRuntime() ||
    taskCommandLeaseRuntimeSubscriptions.removeTaskCommandLeaseTransportSubscription
  ) {
    return;
  }

  taskCommandLeaseRuntimeSubscriptions.removeTaskCommandLeaseTransportSubscription =
    onBrowserTransportEvent((event) => {
      if (event.kind !== 'connection') {
        return;
      }

      if (isTaskCommandLeaseTransportUnavailableState(event.state)) {
        handleTaskCommandLeaseTransportUnavailable();
        return;
      }

      if (event.state === 'connected') {
        taskCommandLeaseRuntimeSubscriptions.taskCommandLeaseTransportUnavailable = false;
      }
    });
}

export function handleTaskCommandTakeoverResult(
  message: ProtocolTaskCommandTakeoverResultMessage,
): void {
  resolveTaskCommandTakeoverDecision(message.requestId, message.decision);
  clearIncomingTaskTakeoverRequestAndCleanup(message.requestId);
}

export function expireIncomingTaskCommandTakeoverRequest(requestId: string): void {
  clearIncomingTaskTakeoverRequestAndCleanup(requestId);
}

export function resetTaskCommandLeaseRuntimeSubscriptionsForTests(): void {
  clearTaskCommandLeaseSubscriptions();
  resetTaskCommandLeaseRuntimeStateStore();
  resetTaskCommandTakeoverStateForTests();
  taskCommandLeaseRuntimeSubscriptions.taskCommandLeaseTransportUnavailable = false;
  taskCommandLeaseRuntimeSubscriptions.taskCommandLeaseTransportGeneration = 0;
}

export function assertTaskCommandLeaseRuntimeSubscriptionsCleanForTests(): void {
  assertTaskCommandTakeoverStateCleanForTests();
  assertTaskCommandLeaseRuntimeStateStoreClean();

  if (taskCommandLeaseRuntimeSubscriptions.removeTaskCommandControllerSubscription) {
    throw new Error('Expected no task-command-controller subscription to remain registered');
  }

  if (taskCommandLeaseRuntimeSubscriptions.removeTaskCommandLeaseTransportSubscription) {
    throw new Error('Expected no task-command-lease transport subscription to remain registered');
  }
}
