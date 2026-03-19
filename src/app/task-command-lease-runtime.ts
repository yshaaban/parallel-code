import { IPC } from '../../electron/ipc/channels';
import type {
  TaskCommandTakeoverRequestMessage,
  TaskCommandTakeoverResultMessage as ProtocolTaskCommandTakeoverResultMessage,
} from '../../electron/remote/protocol';
import type { RendererInvokeResponseMap } from '../domain/renderer-invoke';
import { isTypingTaskCommandFocusedSurface } from '../domain/task-command-focus';
import { invoke, isElectronRuntime, onBrowserTransportEvent } from '../lib/ipc';
import { getRuntimeClientId, getRuntimeLeaseOwnerId } from '../lib/runtime-client-id';
import {
  applyTaskCommandControllerChanged,
  getTaskCommandController,
  subscribeTaskCommandControllerChanges,
} from '../store/task-command-controllers';
import {
  hasIncomingTaskTakeoverRequests,
  upsertIncomingTaskTakeoverRequest,
} from '../store/task-command-takeovers';
import {
  assertTaskCommandTakeoverStateCleanForTests,
  clearIncomingTaskCommandTakeoverRequestState,
  clearIncomingTaskCommandTakeoverRequestStateForAll,
  requestTaskCommandTakeoverDecision,
  resetTaskCommandTakeoverStateForTests,
  resolveAllPendingTaskCommandTakeovers,
  resolveTaskCommandTakeoverDecision,
  shouldProceedWithTaskCommandTakeover,
} from './task-command-lease-takeover';

const TASK_COMMAND_LEASE_RENEW_MS = 5_000;

export interface TaskCommandLeaseOptions {
  confirmTakeover?: boolean;
  takeover?: boolean;
}

interface LocalTaskCommandLease {
  acquirePromise: Promise<boolean> | undefined;
  actionDescription: string;
  holdCount: number;
  renewTimer: ReturnType<typeof globalThis.setInterval> | undefined;
}

type TaskCommandLeaseAcquireResult = RendererInvokeResponseMap[IPC.AcquireTaskCommandLease];

const localTaskCommandLeases = new Map<string, LocalTaskCommandLease>();
const taskCommandLeaseSessionInvalidators = new Map<string, Set<() => void>>();
let removeTaskCommandControllerSubscription: (() => void) | null = null;
let removeTaskCommandLeaseTransportSubscription: (() => void) | null = null;
let taskCommandLeaseTransportUnavailable = false;
let taskCommandLeaseTransportGeneration = 0;

function clearTaskCommandLeaseSubscriptions(): void {
  removeTaskCommandControllerSubscription?.();
  removeTaskCommandControllerSubscription = null;
  removeTaskCommandLeaseTransportSubscription?.();
  removeTaskCommandLeaseTransportSubscription = null;
}

export function addTaskCommandLeaseSessionInvalidator(
  taskId: string,
  invalidate: () => void,
): () => void {
  const invalidators = taskCommandLeaseSessionInvalidators.get(taskId) ?? new Set();
  invalidators.add(invalidate);
  taskCommandLeaseSessionInvalidators.set(taskId, invalidators);
  return () => {
    invalidators.delete(invalidate);
    if (invalidators.size === 0) {
      taskCommandLeaseSessionInvalidators.delete(taskId);
      cleanupIdleTaskCommandLeaseSubscriptions();
    }
  };
}

function invalidateTaskCommandLeaseSessions(taskId: string): void {
  const invalidators = taskCommandLeaseSessionInvalidators.get(taskId);
  if (!invalidators) {
    return;
  }

  for (const invalidate of Array.from(invalidators)) {
    invalidate();
  }
}

function invalidateAllTaskCommandLeaseSessions(): void {
  for (const taskId of taskCommandLeaseSessionInvalidators.keys()) {
    invalidateTaskCommandLeaseSessions(taskId);
  }
}

function clearAllTaskCommandLeaseRenewals(): void {
  for (const taskId of localTaskCommandLeases.keys()) {
    clearTaskCommandLeaseRenewal(taskId);
  }
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

function clearTaskCommandLeaseRenewal(taskId: string): void {
  const lease = localTaskCommandLeases.get(taskId);
  if (!lease?.renewTimer) {
    return;
  }

  globalThis.clearInterval(lease.renewTimer);
  lease.renewTimer = undefined;
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
  if (removeTaskCommandControllerSubscription) {
    return;
  }

  removeTaskCommandControllerSubscription = subscribeTaskCommandControllerChanges(
    handleTaskCommandControllerChanged,
  );
}

function hasTaskCommandLeaseSubscriptionActivity(): boolean {
  return (
    localTaskCommandLeases.size > 0 ||
    taskCommandLeaseSessionInvalidators.size > 0 ||
    hasIncomingTaskTakeoverRequests()
  );
}

function cleanupIdleTaskCommandLeaseSubscriptions(): void {
  if (hasTaskCommandLeaseSubscriptionActivity()) {
    return;
  }

  clearTaskCommandLeaseSubscriptions();
}

export function ensureTaskCommandLeaseSubscriptions(): void {
  ensureTaskCommandControllerSubscription();
  ensureTaskCommandLeaseTransportSubscription();
}

export function hasLocalTaskCommandLeaseOwnership(taskId: string, clientId: string): boolean {
  const controller = getTaskCommandController(taskId);
  return controller?.controllerId === clientId;
}

function isTaskCommandLeaseAttemptCurrent(
  taskId: string,
  clientId: string,
  transportGeneration: number,
): boolean {
  return (
    transportGeneration === getTaskCommandLeaseTransportGeneration() &&
    hasTaskCommandLeaseTransportAvailability() &&
    hasLocalTaskCommandLeaseOwnership(taskId, clientId)
  );
}

function decrementTaskCommandLeaseHold(lease: LocalTaskCommandLease): void {
  lease.holdCount = Math.max(lease.holdCount - 1, 0);
}

function releaseFailedTaskCommandLeaseHold(taskId: string, lease: LocalTaskCommandLease): false {
  decrementTaskCommandLeaseHold(lease);
  cleanupReleasedTaskCommandLease(taskId);
  return false;
}

function updateLocalTaskCommandLeaseAction(
  lease: LocalTaskCommandLease,
  actionDescription: string,
): void {
  lease.actionDescription = actionDescription;
}

async function acquireTaskCommandLease(
  taskId: string,
  clientId: string,
  ownerId: string,
  actionDescription: string,
  takeover: boolean,
): Promise<TaskCommandLeaseAcquireResult> {
  const result = await invoke(IPC.AcquireTaskCommandLease, {
    action: actionDescription,
    clientId,
    ownerId,
    taskId,
    ...(takeover ? { takeover: true } : {}),
  });
  applyTaskCommandControllerChanged(result);
  return result;
}

function shouldSkipTaskCommandTakeover(options: TaskCommandLeaseOptions): boolean {
  return options.confirmTakeover === false && options.takeover !== true;
}

async function resolveTaskCommandLeaseConflict(
  taskId: string,
  clientId: string,
  ownerId: string,
  actionDescription: string,
  lease: TaskCommandLeaseAcquireResult,
  options: TaskCommandLeaseOptions,
): Promise<boolean> {
  if (!lease.controllerId) {
    return false;
  }

  if (shouldSkipTaskCommandTakeover(options)) {
    return false;
  }

  const decision = await requestTaskCommandTakeoverDecision(
    taskId,
    actionDescription,
    lease.controllerId,
  ).catch(() => 'force-required' as const);

  const shouldProceed = await shouldProceedWithTaskCommandTakeover(
    actionDescription,
    decision,
    lease,
  );
  if (!shouldProceed) {
    return false;
  }

  const takeoverLease = await acquireTaskCommandLease(
    taskId,
    clientId,
    ownerId,
    actionDescription,
    true,
  );
  if (!takeoverLease.acquired) {
    throw new Error('Task is controlled by another client');
  }

  return true;
}

async function ensureTaskCommandLease(
  taskId: string,
  clientId: string,
  ownerId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions = {},
): Promise<boolean> {
  const lease = await acquireTaskCommandLease(taskId, clientId, ownerId, actionDescription, false);
  if (lease.acquired || lease.controllerId === clientId) {
    return true;
  }

  return resolveTaskCommandLeaseConflict(
    taskId,
    clientId,
    ownerId,
    actionDescription,
    lease,
    options,
  );
}

function startTaskCommandLeaseRenewal(
  taskId: string,
  clientId: string,
  ownerId: string,
): ReturnType<typeof globalThis.setInterval> {
  return globalThis.setInterval(() => {
    void invoke(IPC.RenewTaskCommandLease, {
      clientId,
      ownerId,
      taskId,
    })
      .then((result) => {
        applyTaskCommandControllerChanged(result);
        if (!hasLocalTaskCommandLeaseOwnership(taskId, clientId)) {
          clearTaskCommandLeaseRenewal(taskId);
        }
      })
      .catch(() => {});
  }, TASK_COMMAND_LEASE_RENEW_MS);
}

function clearTaskCommandLeaseRenewalIfActive(taskId: string): void {
  clearTaskCommandLeaseRenewal(taskId);
}

function handleTaskCommandLeaseTransportUnavailable(): void {
  taskCommandLeaseTransportUnavailable = true;
  taskCommandLeaseTransportGeneration += 1;
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
}

function getTaskCommandLeaseTransportGeneration(): number {
  if (isElectronRuntime()) {
    return 0;
  }

  return taskCommandLeaseTransportGeneration;
}

export function hasTaskCommandLeaseTransportAvailability(): boolean {
  return isElectronRuntime() || !taskCommandLeaseTransportUnavailable;
}

function ensureTaskCommandLeaseTransportSubscription(): void {
  if (isElectronRuntime() || removeTaskCommandLeaseTransportSubscription) {
    return;
  }

  removeTaskCommandLeaseTransportSubscription = onBrowserTransportEvent((event) => {
    if (event.kind !== 'connection') {
      return;
    }

    if (isTaskCommandLeaseTransportUnavailableState(event.state)) {
      handleTaskCommandLeaseTransportUnavailable();
      return;
    }

    if (event.state === 'connected') {
      taskCommandLeaseTransportUnavailable = false;
    }
  });
}

function getOrCreateLocalTaskCommandLease(
  taskId: string,
  actionDescription: string,
): LocalTaskCommandLease {
  const existingLease = localTaskCommandLeases.get(taskId);
  if (existingLease) {
    return existingLease;
  }

  const nextLease: LocalTaskCommandLease = {
    actionDescription,
    acquirePromise: undefined,
    holdCount: 0,
    renewTimer: undefined,
  };
  localTaskCommandLeases.set(taskId, nextLease);
  return nextLease;
}

function cleanupReleasedTaskCommandLease(taskId: string): void {
  const lease = localTaskCommandLeases.get(taskId);
  if (!lease) {
    cleanupIdleTaskCommandLeaseSubscriptions();
    return;
  }

  if (lease.holdCount > 0 || lease.acquirePromise || lease.renewTimer) {
    return;
  }

  localTaskCommandLeases.delete(taskId);
  cleanupIdleTaskCommandLeaseSubscriptions();
}

async function releaseTaskCommandLeaseToBackend(
  taskId: string,
  clientId: string,
  ownerId: string,
): Promise<void> {
  clearTaskCommandLeaseRenewalIfActive(taskId);
  const result = await invoke(IPC.ReleaseTaskCommandLease, {
    clientId,
    ownerId,
    taskId,
  }).catch(() => {});
  if (result) {
    applyTaskCommandControllerChanged(result);
  }
  cleanupReleasedTaskCommandLease(taskId);
}

export async function retainTaskCommandLease(
  taskId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions = {},
): Promise<boolean> {
  ensureTaskCommandLeaseSubscriptions();
  const clientId = getRuntimeClientId();
  const ownerId = getRuntimeLeaseOwnerId();
  const lease = getOrCreateLocalTaskCommandLease(taskId, actionDescription);
  lease.holdCount += 1;

  async function refreshHeldLease(): Promise<boolean> {
    const transportGeneration = getTaskCommandLeaseTransportGeneration();
    const ownsLease = hasLocalTaskCommandLeaseOwnership(taskId, clientId);
    if (!ownsLease) {
      clearTaskCommandLeaseRenewalIfActive(taskId);
    }

    if (ownsLease && lease.actionDescription === actionDescription) {
      return true;
    }

    const acquired = await ensureTaskCommandLease(
      taskId,
      clientId,
      ownerId,
      actionDescription,
      options,
    );
    if (!isTaskCommandLeaseAttemptCurrent(taskId, clientId, transportGeneration)) {
      return false;
    }
    if (acquired) {
      updateLocalTaskCommandLeaseAction(lease, actionDescription);
    }
    return acquired;
  }

  if (lease.renewTimer) {
    const acquired = await refreshHeldLease();
    if (!acquired) {
      return releaseFailedTaskCommandLeaseHold(taskId, lease);
    }
    return true;
  }

  if (!lease.acquirePromise) {
    const transportGeneration = getTaskCommandLeaseTransportGeneration();
    updateLocalTaskCommandLeaseAction(lease, actionDescription);
    lease.acquirePromise = ensureTaskCommandLease(
      taskId,
      clientId,
      ownerId,
      actionDescription,
      options,
    )
      .then((acquired) => {
        if (!acquired) {
          return false;
        }

        if (!isTaskCommandLeaseAttemptCurrent(taskId, clientId, transportGeneration)) {
          return false;
        }

        lease.renewTimer = startTaskCommandLeaseRenewal(taskId, clientId, ownerId);
        return true;
      })
      .finally(() => {
        lease.acquirePromise = undefined;
        cleanupReleasedTaskCommandLease(taskId);
      });
  }

  const acquired = await lease.acquirePromise;
  if (!acquired) {
    return releaseFailedTaskCommandLeaseHold(taskId, lease);
  }

  return refreshHeldLease();
}

export async function releaseTaskCommandLeaseHold(
  taskId: string,
  options: {
    notifyBackend?: boolean;
  } = {},
): Promise<void> {
  const clientId = getRuntimeClientId();
  const ownerId = getRuntimeLeaseOwnerId();
  const lease = localTaskCommandLeases.get(taskId);
  if (!lease) {
    return;
  }

  decrementTaskCommandLeaseHold(lease);
  if (lease.holdCount > 0) {
    return;
  }

  if (lease.acquirePromise) {
    await lease.acquirePromise.catch(() => {});
    const refreshedLease = localTaskCommandLeases.get(taskId);
    if (!refreshedLease) {
      return;
    }
    if (refreshedLease.holdCount > 0 || refreshedLease.acquirePromise) {
      return;
    }
  }

  if (options.notifyBackend === false) {
    clearTaskCommandLeaseRenewalIfActive(taskId);
    cleanupReleasedTaskCommandLease(taskId);
    return;
  }

  await releaseTaskCommandLeaseToBackend(taskId, clientId, ownerId);
}

function isTypingTaskCommandAction(actionDescription: string): boolean {
  return actionDescription === 'type in the terminal';
}

async function releaseInactiveTypingTaskCommandLeases(
  activeTaskId: string | null,
  focusedSurface: string | null,
): Promise<void> {
  const keepActiveTypingLease =
    activeTaskId !== null && isTypingTaskCommandFocusedSurface(focusedSurface);
  const releasePromises: Promise<void>[] = [];

  for (const [taskId, lease] of localTaskCommandLeases) {
    if (!isTypingTaskCommandAction(lease.actionDescription)) {
      continue;
    }

    if (keepActiveTypingLease && taskId === activeTaskId) {
      continue;
    }

    releasePromises.push(releaseTaskCommandLeaseHold(taskId));
  }

  if (releasePromises.length === 0) {
    return;
  }

  await Promise.allSettled(releasePromises);
}

export function syncFocusedTypingTaskCommandLease(
  activeTaskId: string | null,
  focusedSurface: string | null,
): void {
  void releaseInactiveTypingTaskCommandLeases(activeTaskId, focusedSurface);
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

export function resetTaskCommandLeaseRuntimeStateForTests(): void {
  clearTaskCommandLeaseSubscriptions();
  resetTaskCommandTakeoverStateForTests();
  for (const lease of localTaskCommandLeases.values()) {
    if (lease.renewTimer) {
      clearInterval(lease.renewTimer);
    }
  }
  localTaskCommandLeases.clear();
  taskCommandLeaseSessionInvalidators.clear();
  taskCommandLeaseTransportUnavailable = false;
  taskCommandLeaseTransportGeneration = 0;
}

export function assertTaskCommandLeaseRuntimeStateCleanForTests(): void {
  assertTaskCommandTakeoverStateCleanForTests();

  if (localTaskCommandLeases.size !== 0) {
    throw new Error(`Expected no local task-command leases, found ${localTaskCommandLeases.size}`);
  }

  if (taskCommandLeaseSessionInvalidators.size !== 0) {
    throw new Error(
      `Expected no task-command lease invalidators, found ${taskCommandLeaseSessionInvalidators.size}`,
    );
  }

  if (removeTaskCommandControllerSubscription) {
    throw new Error('Expected no task-command-controller subscription to remain registered');
  }

  if (removeTaskCommandLeaseTransportSubscription) {
    throw new Error('Expected no task-command-lease transport subscription to remain registered');
  }
}
