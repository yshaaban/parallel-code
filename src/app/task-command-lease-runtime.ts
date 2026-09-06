import { IPC } from '../../electron/ipc/channels';
import { isTransportAttemptCurrent } from '../domain/task-command-lease-runtime-primitives';
import type { RendererInvokeResponseMap } from '../domain/renderer-invoke';
import { ensureBrowserPagehideTracking, isBrowserPagehidePending } from '../lib/browser-pagehide';
import { invoke, sendPagehideInvoke } from '../lib/ipc';
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
  registerSuspendedTaskCommandLeaseReclaim,
  resetTaskCommandLeaseRuntimeSubscriptionsForTests,
} from './task-command-lease-runtime-subscriptions';
import {
  addTaskCommandLeaseSessionInvalidator as addTaskCommandLeaseSessionInvalidatorState,
  cleanupReleasedTaskCommandLease as cleanupReleasedTaskCommandLeaseState,
  clearSuspendedTaskCommandLeaseMark,
  clearTaskCommandLeaseRenewal,
  decrementTaskCommandLeaseHold,
  getLocalTaskCommandLease,
  getOrCreateLocalTaskCommandLease,
  getSuspendedTaskCommandLeases,
  invalidateTaskCommandLeaseSessions,
  resumeTaskCommandLease,
  updateLocalTaskCommandLeaseGeneration,
  updateLocalTaskCommandLeaseAction,
  type LocalTaskCommandLease,
} from './task-command-lease-runtime-state';

const TASK_COMMAND_LEASE_RENEW_MS = 5_000;

// Suspend-and-reclaim: when the transport recovers, every suspended lease the
// client still believes it holds is re-acquired through the ordinary
// (non-takeover) acquire path. Success adopts the backend's NEW lease
// generation; denial means a peer legitimately took over during the blip, so
// that task's retained sessions are invalidated instead of fought over.
registerSuspendedTaskCommandLeaseReclaim(() => {
  for (const [taskId, lease] of getSuspendedTaskCommandLeases()) {
    if (lease.removed || lease.holdCount === 0) {
      clearSuspendedTaskCommandLeaseMark(taskId);
      continue;
    }

    void reclaimSuspendedTaskCommandLease(taskId, lease);
  }
});

/**
 * Returns the backend generation for a lease retained by this renderer.
 * Callers use this only inside `runWithTaskCommandLease`, after acquisition
 * and refresh have completed, so session-operation requests cannot confuse
 * the presentation controller version with the authoritative lease epoch.
 */
export function getRetainedTaskCommandLeaseGeneration(taskId: string): number | null {
  const lease = getLocalTaskCommandLease(taskId);
  return lease && !lease.removed && lease.holdCount > 0 && lease.leaseGeneration !== undefined
    ? lease.leaseGeneration
    : null;
}

async function reclaimSuspendedTaskCommandLease(
  taskId: string,
  lease: LocalTaskCommandLease,
): Promise<void> {
  const clientId = getRuntimeClientId();
  const ownerId = getRuntimeLeaseOwnerId();
  const transportGeneration = getTaskCommandLeaseTransportGeneration();
  const leaseGeneration = lease.leaseGeneration;
  const isCurrent = () =>
    getLocalTaskCommandLease(taskId) === lease &&
    !lease.removed &&
    lease.leaseGeneration === leaseGeneration &&
    getTaskCommandLeaseTransportGeneration() === transportGeneration;
  try {
    const result = await acquireTaskCommandLease(
      taskId,
      clientId,
      ownerId,
      lease.actionDescription,
      false,
    );
    if (!isCurrent()) return;
    if (result.acquired && result.controllerId === clientId) {
      resumeTaskCommandLease(taskId, result.leaseGeneration);
      if (!lease.renewTimer && !lease.removed) {
        lease.renewTimer = startTaskCommandLeaseRenewal(taskId, clientId, ownerId);
      }
      return;
    }
  } catch {
    // Re-claim failed; fall through to invalidation below.
  }

  if (!isCurrent()) return;
  clearSuspendedTaskCommandLeaseMark(taskId);
  clearTaskCommandLeaseRenewal(taskId);
  invalidateTaskCommandLeaseSessions(taskId);
}

export interface TaskCommandLeaseOptions {
  confirmTakeover?: boolean;
  takeover?: boolean;
}

export interface RetainedTaskCommandLeaseHold {
  isCurrent(): boolean;
  release(options?: { notifyBackend?: boolean }): Promise<boolean>;
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
    const leaseGeneration = lease?.leaseGeneration;
    const transportGeneration = getTaskCommandLeaseTransportGeneration();
    void invoke(IPC.RenewTaskCommandLease, {
      clientId,
      ownerId,
      taskId,
      ...(lease?.leaseGeneration !== undefined ? { leaseGeneration: lease.leaseGeneration } : {}),
    })
      .then((result) => {
        if (
          !lease ||
          lease.removed ||
          getLocalTaskCommandLease(taskId) !== lease ||
          lease.leaseGeneration !== leaseGeneration ||
          getTaskCommandLeaseTransportGeneration() !== transportGeneration
        )
          return;
        applyTaskCommandControllerChanged(result);
        if (result.renewed) {
          updateLocalTaskCommandLeaseGeneration(lease, result.leaseGeneration);
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

function canReusePendingTaskCommandAcquire(
  lease: LocalTaskCommandLease,
  options: TaskCommandLeaseOptions,
): boolean {
  if (!lease.acquirePromise) {
    return false;
  }

  if (options.takeover === true && !lease.acquirePromiseTakeover) {
    return false;
  }

  return true;
}

function startTaskCommandLeaseAcquire(
  taskId: string,
  clientId: string,
  ownerId: string,
  actionDescription: string,
  lease: LocalTaskCommandLease,
  options: TaskCommandLeaseOptions,
): Promise<boolean> {
  const transportGeneration = getTaskCommandLeaseTransportGeneration();
  updateLocalTaskCommandLeaseAction(lease, actionDescription);

  const acquirePromise = ensureTaskCommandLease(
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

      if (acquireResult.controllerId === clientId) {
        updateLocalTaskCommandLeaseGeneration(lease, acquireResult.leaseGeneration);
      }

      if (!isTaskCommandLeaseAttemptCurrent(taskId, clientId, transportGeneration)) {
        return false;
      }

      if (!lease.removed && getLocalTaskCommandLease(taskId) === lease) {
        lease.renewTimer = startTaskCommandLeaseRenewal(taskId, clientId, ownerId);
      }
      return true;
    })
    .finally(() => {
      if (lease.acquirePromise === acquirePromise) {
        lease.acquirePromise = undefined;
        lease.acquirePromiseTakeover = false;
      }
      cleanupReleasedTaskCommandLeaseForLease(taskId, lease);
    });

  lease.acquirePromise = acquirePromise;
  lease.acquirePromiseTakeover = options.takeover === true;
  return acquirePromise;
}

async function releaseTaskCommandLeaseToBackend(
  taskId: string,
  clientId: string,
  ownerId: string,
  lease: LocalTaskCommandLease,
): Promise<boolean> {
  if (
    getLocalTaskCommandLease(taskId) !== lease &&
    (!lease.removed || lease.leaseGeneration === undefined)
  ) {
    return false;
  }

  if (getLocalTaskCommandLease(taskId) === lease) clearTaskCommandLeaseRenewalIfActive(taskId);
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

function releaseTaskCommandLeaseOnPagehide(
  taskId: string,
  clientId: string,
  ownerId: string,
  lease: LocalTaskCommandLease,
): void {
  clearTaskCommandLeaseRenewalIfActive(taskId);
  if (hasLocalTaskCommandLeaseOwnership(taskId, clientId)) {
    sendPagehideInvoke(IPC.ReleaseTaskCommandLease, {
      clientId,
      ownerId,
      taskId,
      ...(lease.leaseGeneration !== undefined ? { leaseGeneration: lease.leaseGeneration } : {}),
    });
  }

  cleanupReleasedTaskCommandLeaseForLease(taskId, lease);
}

async function retainLocalTaskCommandLease(
  taskId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions = {},
): Promise<LocalTaskCommandLease | null> {
  ensureBrowserPagehideTracking();
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

    // Overlapping local holders share one admitted epoch. Acquiring again merely to
    // change its action label would invalidate work already using that generation.
    if (ownsLease && lease.leaseGeneration !== undefined && lease.suspendedAt === undefined) {
      return true;
    }

    const acquiredLease = await ensureTaskCommandLease(
      taskId,
      clientId,
      ownerId,
      actionDescription,
      options,
    );
    if (acquiredLease?.controllerId === clientId) {
      updateLocalTaskCommandLeaseGeneration(lease, acquiredLease.leaseGeneration);
    }
    if (!isTaskCommandLeaseAttemptCurrent(taskId, clientId, transportGeneration)) {
      return false;
    }
    if (acquiredLease) {
      updateLocalTaskCommandLeaseAction(lease, actionDescription);
    }
    return acquiredLease !== null;
  }

  if (lease.renewTimer) {
    const acquired = await refreshHeldLease();
    if (!acquired) {
      await releaseFailedTaskCommandLeaseHold(taskId, lease);
      return null;
    }
    return !lease.removed && getLocalTaskCommandLease(taskId) === lease ? lease : null;
  }

  const shouldEscalatePendingAcquire =
    lease.acquirePromise !== undefined && !canReusePendingTaskCommandAcquire(lease, options);

  if (!lease.acquirePromise) {
    startTaskCommandLeaseAcquire(taskId, clientId, ownerId, actionDescription, lease, options);
  }

  let acquired = await lease.acquirePromise;
  if (lease.removed || getLocalTaskCommandLease(taskId) !== lease) return null;
  if (
    !acquired &&
    shouldEscalatePendingAcquire &&
    !lease.acquirePromise &&
    !lease.renewTimer &&
    !lease.removed
  ) {
    acquired = await startTaskCommandLeaseAcquire(
      taskId,
      clientId,
      ownerId,
      actionDescription,
      lease,
      options,
    );
  }

  if (!acquired) {
    await releaseFailedTaskCommandLeaseHold(taskId, lease);
    return null;
  }

  return (await refreshHeldLease()) && !lease.removed && getLocalTaskCommandLease(taskId) === lease
    ? lease
    : null;
}

/** Each caller releases only the local lease it retained, even after removal and ID reuse. */
export async function retainTaskCommandLeaseHold(
  taskId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions = {},
): Promise<RetainedTaskCommandLeaseHold | null> {
  const lease = await retainLocalTaskCommandLease(taskId, actionDescription, options);
  if (!lease) return null;
  let released = false;
  return {
    isCurrent: () => !released && !lease.removed && getLocalTaskCommandLease(taskId) === lease,
    release(releaseOptions = {}) {
      if (released) return Promise.resolve(true);
      released = true;
      return releaseTaskCommandLeaseHold(taskId, { ...releaseOptions, expectedLease: lease });
    },
  };
}

export async function retainTaskCommandLease(
  taskId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions = {},
): Promise<boolean> {
  return (await retainLocalTaskCommandLease(taskId, actionDescription, options)) !== null;
}

export async function releaseTaskCommandLeaseHold(
  taskId: string,
  options: {
    notifyBackend?: boolean;
    expectedLease?: LocalTaskCommandLease;
  } = {},
): Promise<boolean> {
  const clientId = getRuntimeClientId();
  const ownerId = getRuntimeLeaseOwnerId();
  const lease = getLocalTaskCommandLease(taskId);
  if (options.expectedLease && lease !== options.expectedLease) return true;
  if (!lease) {
    return false;
  }
  // Final owner removal, not individual holders, releases this retired epoch.
  if (lease.removed) return true;

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

  if (isBrowserPagehidePending()) {
    releaseTaskCommandLeaseOnPagehide(taskId, clientId, ownerId, lease);
    return true;
  }

  return releaseTaskCommandLeaseToBackend(taskId, clientId, ownerId, lease);
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
  // Invalidate the old holders synchronously: a replacement may arrive during release.
  // Their individual releases cannot consume or clear this retired epoch.
  invalidateTaskCommandLeaseSessions(taskId);
  // Removal retires every holder, including a command still preparing a process.
  // Wait for an already-issued acquire, then revoke that exact lease epoch once.
  if (lease?.acquirePromise) await lease.acquirePromise.catch(() => undefined);
  if (!lease) return false;
  lease.holdCount = 0;
  if (isBrowserPagehidePending() && getLocalTaskCommandLease(taskId) === lease) {
    releaseTaskCommandLeaseOnPagehide(
      taskId,
      getRuntimeClientId(),
      getRuntimeLeaseOwnerId(),
      lease,
    );
    return true;
  }
  return releaseTaskCommandLeaseToBackend(
    taskId,
    getRuntimeClientId(),
    getRuntimeLeaseOwnerId(),
    lease,
  );
}

export {
  ensureTaskCommandLeaseSubscriptions,
  expireIncomingTaskCommandTakeoverRequest,
  handleIncomingTaskCommandTakeoverRequest,
  handleTaskCommandTakeoverResult,
  hasTaskCommandLeaseTransportAvailability,
};
