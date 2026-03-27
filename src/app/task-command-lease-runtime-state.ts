import { clearOptionalInterval } from '../domain/task-command-lease-runtime-primitives';

export interface LocalTaskCommandLease {
  acquirePromise: Promise<boolean> | undefined;
  actionDescription: string;
  holdCount: number;
  leaseGeneration: number | undefined;
  removed: boolean;
  renewTimer: ReturnType<typeof globalThis.setInterval> | undefined;
}

const localTaskCommandLeases = new Map<string, LocalTaskCommandLease>();
const taskCommandLeaseSessionInvalidators = new Map<string, Set<() => void>>();

export function addTaskCommandLeaseSessionInvalidator(
  taskId: string,
  invalidate: () => void,
  onMaybeIdle: () => void,
): () => void {
  const invalidators = taskCommandLeaseSessionInvalidators.get(taskId) ?? new Set();
  invalidators.add(invalidate);
  taskCommandLeaseSessionInvalidators.set(taskId, invalidators);
  return () => {
    invalidators.delete(invalidate);
    if (invalidators.size === 0) {
      taskCommandLeaseSessionInvalidators.delete(taskId);
      onMaybeIdle();
    }
  };
}

export function invalidateTaskCommandLeaseSessions(taskId: string): void {
  const invalidators = taskCommandLeaseSessionInvalidators.get(taskId);
  if (!invalidators) {
    return;
  }

  for (const invalidate of Array.from(invalidators)) {
    invalidate();
  }
}

export function invalidateAllTaskCommandLeaseSessions(): void {
  for (const taskId of taskCommandLeaseSessionInvalidators.keys()) {
    invalidateTaskCommandLeaseSessions(taskId);
  }
}

export function getLocalTaskCommandLease(taskId: string): LocalTaskCommandLease | undefined {
  return localTaskCommandLeases.get(taskId);
}

export function getLocalTaskCommandLeaseEntries(): IterableIterator<
  [string, LocalTaskCommandLease]
> {
  return localTaskCommandLeases.entries();
}

export function hasLocalTaskCommandLeases(): boolean {
  return localTaskCommandLeases.size > 0;
}

export function hasTaskCommandLeaseSessionInvalidators(): boolean {
  return taskCommandLeaseSessionInvalidators.size > 0;
}

export function getOrCreateLocalTaskCommandLease(
  taskId: string,
  actionDescription: string,
): LocalTaskCommandLease {
  const existingLease = localTaskCommandLeases.get(taskId);
  if (existingLease && !existingLease.removed) {
    return existingLease;
  }

  if (existingLease?.removed) {
    clearTaskCommandLeaseRenewal(taskId);
    localTaskCommandLeases.delete(taskId);
  }

  const nextLease: LocalTaskCommandLease = {
    actionDescription,
    acquirePromise: undefined,
    holdCount: 0,
    leaseGeneration: undefined,
    removed: false,
    renewTimer: undefined,
  };
  localTaskCommandLeases.set(taskId, nextLease);
  return nextLease;
}

export function clearTaskCommandLeaseRenewal(taskId: string): void {
  const lease = localTaskCommandLeases.get(taskId);
  if (!lease?.renewTimer) {
    return;
  }

  lease.renewTimer = clearOptionalInterval(lease.renewTimer);
}

export function clearAllTaskCommandLeaseRenewals(): void {
  for (const taskId of localTaskCommandLeases.keys()) {
    clearTaskCommandLeaseRenewal(taskId);
  }
}

export function decrementTaskCommandLeaseHold(lease: LocalTaskCommandLease): void {
  lease.holdCount = Math.max(lease.holdCount - 1, 0);
}

export function updateLocalTaskCommandLeaseAction(
  lease: LocalTaskCommandLease,
  actionDescription: string,
): void {
  lease.actionDescription = actionDescription;
}

export function updateLocalTaskCommandLeaseGeneration(
  lease: LocalTaskCommandLease,
  leaseGeneration: number | undefined,
): void {
  lease.leaseGeneration = leaseGeneration;
}

export function cleanupReleasedTaskCommandLease(
  taskId: string,
  onMaybeIdle: () => void,
  expectedLease?: LocalTaskCommandLease,
): void {
  const lease = localTaskCommandLeases.get(taskId);
  if (expectedLease && lease !== expectedLease) {
    return;
  }

  if (!lease) {
    onMaybeIdle();
    return;
  }

  if (lease.holdCount > 0 || lease.acquirePromise || lease.renewTimer) {
    return;
  }

  localTaskCommandLeases.delete(taskId);
  onMaybeIdle();
}

export function resetTaskCommandLeaseRuntimeStateStore(): void {
  clearAllTaskCommandLeaseRenewals();
  localTaskCommandLeases.clear();
  taskCommandLeaseSessionInvalidators.clear();
}

export function assertTaskCommandLeaseRuntimeStateStoreClean(): void {
  if (localTaskCommandLeases.size !== 0) {
    throw new Error(`Expected no local task-command leases, found ${localTaskCommandLeases.size}`);
  }

  if (taskCommandLeaseSessionInvalidators.size !== 0) {
    throw new Error(
      `Expected no task-command lease invalidators, found ${taskCommandLeaseSessionInvalidators.size}`,
    );
  }
}
