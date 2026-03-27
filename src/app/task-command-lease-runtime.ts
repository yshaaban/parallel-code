import { IPC } from '../../electron/ipc/channels';
import { isTransportAttemptCurrent } from '../domain/task-command-lease-runtime-primitives';
import type { RendererInvokeResponseMap } from '../domain/renderer-invoke';
import { isTypingTaskCommandFocusedSurface } from '../domain/task-command-focus';
import { invoke } from '../lib/ipc';
import { getRuntimeClientId, getRuntimeLeaseOwnerId } from '../lib/runtime-client-id';
import {
  applyTaskCommandControllerChanged,
  getTaskCommandController,
} from '../store/task-command-controllers';
import {
  requestTaskCommandTakeoverDecision,
  shouldProceedWithTaskCommandTakeover,
} from './task-command-lease-takeover';
import {
  assertTaskCommandLeaseRuntimeSubscriptionsCleanForTests,
  cleanupIdleTaskCommandLeaseSubscriptions,
  ensureTaskCommandLeaseSubscriptions,
  expireIncomingTaskCommandTakeoverRequest,
  getTaskCommandLeaseTransportGeneration,
  handleIncomingTaskCommandTakeoverRequest,
  handleTaskCommandTakeoverResult,
  hasTaskCommandLeaseTransportAvailability,
  resetTaskCommandLeaseRuntimeSubscriptionsForTests,
} from './task-command-lease-runtime-subscriptions';
import {
  addTaskCommandLeaseSessionInvalidator as addTaskCommandLeaseSessionInvalidatorState,
  cleanupReleasedTaskCommandLease as cleanupReleasedTaskCommandLeaseState,
  clearTaskCommandLeaseRenewal,
  decrementTaskCommandLeaseHold,
  getLocalTaskCommandLease,
  getLocalTaskCommandLeaseEntries,
  getOrCreateLocalTaskCommandLease,
  invalidateTaskCommandLeaseSessions,
  updateLocalTaskCommandLeaseGeneration,
  updateLocalTaskCommandLeaseAction,
  type LocalTaskCommandLease,
} from './task-command-lease-runtime-state';

const TASK_COMMAND_LEASE_RENEW_MS = 5_000;

export interface TaskCommandLeaseOptions {
  confirmTakeover?: boolean;
  takeover?: boolean;
}

type TaskCommandLeaseAcquireResult = RendererInvokeResponseMap[IPC.AcquireTaskCommandLease];
type TaskCommandLeaseReleaseResult = RendererInvokeResponseMap[IPC.ReleaseTaskCommandLease];

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
    isTransportAttemptCurrent(
      getTaskCommandLeaseTransportGeneration(),
      transportGeneration,
      hasTaskCommandLeaseTransportAvailability(),
    ) && hasLocalTaskCommandLeaseOwnership(taskId, clientId)
  );
}

async function releaseFailedTaskCommandLeaseHold(
  taskId: string,
  lease: LocalTaskCommandLease,
): Promise<false> {
  const clientId = getRuntimeClientId();
  const ownerId = getRuntimeLeaseOwnerId();
  decrementTaskCommandLeaseHold(lease);
  if (lease.holdCount > 0) {
    return false;
  }

  if (hasLocalTaskCommandLeaseOwnership(taskId, clientId)) {
    await releaseTaskCommandLeaseToBackend(taskId, clientId, ownerId, lease);
    return false;
  }

  cleanupReleasedTaskCommandLeaseForLease(taskId, lease);
  return false;
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
): Promise<TaskCommandLeaseAcquireResult | null> {
  if (!lease.controllerId) {
    return null;
  }

  if (shouldSkipTaskCommandTakeover(options)) {
    return null;
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
    return null;
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

  return takeoverLease;
}

async function ensureTaskCommandLease(
  taskId: string,
  clientId: string,
  ownerId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions = {},
): Promise<TaskCommandLeaseAcquireResult | null> {
  const lease = await acquireTaskCommandLease(taskId, clientId, ownerId, actionDescription, false);
  if (lease.acquired || lease.controllerId === clientId) {
    return lease;
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
    const lease = getLocalTaskCommandLease(taskId);
    void invoke(IPC.RenewTaskCommandLease, {
      clientId,
      ownerId,
      taskId,
      ...(lease?.leaseGeneration !== undefined ? { leaseGeneration: lease.leaseGeneration } : {}),
    })
      .then((result) => {
        applyTaskCommandControllerChanged(result);
        const refreshedLease = getLocalTaskCommandLease(taskId);
        if (refreshedLease && result.renewed) {
          updateLocalTaskCommandLeaseGeneration(refreshedLease, result.leaseGeneration);
        }
        if (!hasLocalTaskCommandLeaseOwnership(taskId, clientId)) {
          clearTaskCommandLeaseRenewalIfActive(taskId);
        }
      })
      .catch(() => {});
  }, TASK_COMMAND_LEASE_RENEW_MS);
}

function clearTaskCommandLeaseRenewalIfActive(taskId: string): void {
  clearTaskCommandLeaseRenewal(taskId);
}

function cleanupReleasedTaskCommandLeaseForLease(
  taskId: string,
  lease: LocalTaskCommandLease,
): void {
  cleanupReleasedTaskCommandLeaseState(taskId, cleanupIdleTaskCommandLeaseSubscriptions, lease);
}

async function releaseTaskCommandLeaseToBackend(
  taskId: string,
  clientId: string,
  ownerId: string,
  lease: LocalTaskCommandLease,
): Promise<boolean> {
  if (getLocalTaskCommandLease(taskId) !== lease) {
    return false;
  }

  clearTaskCommandLeaseRenewalIfActive(taskId);
  const result = await invoke(IPC.ReleaseTaskCommandLease, {
    clientId,
    ownerId,
    taskId,
    ...(lease.leaseGeneration !== undefined ? { leaseGeneration: lease.leaseGeneration } : {}),
  }).catch(() => undefined as TaskCommandLeaseReleaseResult | undefined);

  if (getLocalTaskCommandLease(taskId) !== lease) {
    return false;
  }

  if (result) {
    applyTaskCommandControllerChanged(result);
  }
  if (result && result.action === null && result.controllerId === null) {
    cleanupReleasedTaskCommandLeaseForLease(taskId, lease);
    return true;
  }

  if (lease.removed) {
    cleanupReleasedTaskCommandLeaseForLease(taskId, lease);
    return false;
  }

  if (lease.holdCount === 0) {
    lease.holdCount = 1;
    if (!lease.renewTimer) {
      lease.renewTimer = startTaskCommandLeaseRenewal(taskId, clientId, ownerId);
    }
  }

  return false;
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

    const acquiredLease = await ensureTaskCommandLease(
      taskId,
      clientId,
      ownerId,
      actionDescription,
      options,
    );
    if (!isTaskCommandLeaseAttemptCurrent(taskId, clientId, transportGeneration)) {
      return false;
    }
    if (acquiredLease) {
      updateLocalTaskCommandLeaseAction(lease, actionDescription);
      updateLocalTaskCommandLeaseGeneration(lease, acquiredLease.leaseGeneration);
    }
    return acquiredLease !== null;
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
      .then((acquireResult) => {
        if (!acquireResult) {
          return false;
        }

        if (!isTaskCommandLeaseAttemptCurrent(taskId, clientId, transportGeneration)) {
          return false;
        }

        updateLocalTaskCommandLeaseGeneration(lease, acquireResult.leaseGeneration);
        lease.renewTimer = startTaskCommandLeaseRenewal(taskId, clientId, ownerId);
        return true;
      })
      .finally(() => {
        lease.acquirePromise = undefined;
        cleanupReleasedTaskCommandLeaseForLease(taskId, lease);
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
): Promise<boolean> {
  const clientId = getRuntimeClientId();
  const ownerId = getRuntimeLeaseOwnerId();
  const lease = getLocalTaskCommandLease(taskId);
  if (!lease) {
    return false;
  }

  decrementTaskCommandLeaseHold(lease);
  if (lease.holdCount > 0) {
    return true;
  }

  if (lease.acquirePromise) {
    await lease.acquirePromise.catch(() => {});
    const refreshedLease = getLocalTaskCommandLease(taskId);
    if (!refreshedLease) {
      return true;
    }
    if (refreshedLease.holdCount > 0 || refreshedLease.acquirePromise) {
      return true;
    }
  }

  if (options.notifyBackend === false) {
    clearTaskCommandLeaseRenewalIfActive(taskId);
    cleanupReleasedTaskCommandLeaseForLease(taskId, lease);
    return true;
  }

  return releaseTaskCommandLeaseToBackend(taskId, clientId, ownerId, lease);
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
  const releasePromises: Promise<unknown>[] = [];

  for (const [taskId, lease] of getLocalTaskCommandLeaseEntries()) {
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

export function addTaskCommandLeaseSessionInvalidator(
  taskId: string,
  invalidate: () => void,
): () => void {
  return addTaskCommandLeaseSessionInvalidatorState(
    taskId,
    invalidate,
    cleanupIdleTaskCommandLeaseSubscriptions,
  );
}

export function resetTaskCommandLeaseRuntimeStateForTests(): void {
  resetTaskCommandLeaseRuntimeSubscriptionsForTests();
}

export function assertTaskCommandLeaseRuntimeStateCleanForTests(): void {
  assertTaskCommandLeaseRuntimeSubscriptionsCleanForTests();
}

export async function clearRemovedTaskCommandLeaseState(taskId: string): Promise<boolean> {
  const lease = getLocalTaskCommandLease(taskId);
  if (lease) {
    lease.removed = true;
  }
  clearTaskCommandLeaseRenewalIfActive(taskId);
  // Removed tasks must attempt the backend release before local retained sessions are invalidated.
  // Session invalidation clears retained leases with notifyBackend=false, so reversing this order
  // would strand backend ownership until TTL expiry.
  const released = await releaseTaskCommandLeaseHold(taskId);
  invalidateTaskCommandLeaseSessions(taskId);
  return released;
}

export {
  ensureTaskCommandLeaseSubscriptions,
  expireIncomingTaskCommandTakeoverRequest,
  handleIncomingTaskCommandTakeoverRequest,
  handleTaskCommandTakeoverResult,
  hasTaskCommandLeaseTransportAvailability,
};
