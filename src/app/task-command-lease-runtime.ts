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
  updateLocalTaskCommandLeaseAction,
  type LocalTaskCommandLease,
} from './task-command-lease-runtime-state';

const TASK_COMMAND_LEASE_RENEW_MS = 5_000;

export interface TaskCommandLeaseOptions {
  confirmTakeover?: boolean;
  takeover?: boolean;
}

type TaskCommandLeaseAcquireResult = RendererInvokeResponseMap[IPC.AcquireTaskCommandLease];

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

function releaseFailedTaskCommandLeaseHold(taskId: string, lease: LocalTaskCommandLease): false {
  decrementTaskCommandLeaseHold(lease);
  cleanupReleasedTaskCommandLease(taskId);
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
          clearTaskCommandLeaseRenewalIfActive(taskId);
        }
      })
      .catch(() => {});
  }, TASK_COMMAND_LEASE_RENEW_MS);
}

function clearTaskCommandLeaseRenewalIfActive(taskId: string): void {
  clearTaskCommandLeaseRenewal(taskId);
}

function cleanupReleasedTaskCommandLease(taskId: string): void {
  cleanupReleasedTaskCommandLeaseState(taskId, cleanupIdleTaskCommandLeaseSubscriptions);
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
  const lease = getLocalTaskCommandLease(taskId);
  if (!lease) {
    return;
  }

  decrementTaskCommandLeaseHold(lease);
  if (lease.holdCount > 0) {
    return;
  }

  if (lease.acquirePromise) {
    await lease.acquirePromise.catch(() => {});
    const refreshedLease = getLocalTaskCommandLease(taskId);
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

export {
  ensureTaskCommandLeaseSubscriptions,
  expireIncomingTaskCommandTakeoverRequest,
  handleIncomingTaskCommandTakeoverRequest,
  handleTaskCommandTakeoverResult,
  hasTaskCommandLeaseTransportAvailability,
};
