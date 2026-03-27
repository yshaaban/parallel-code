import type { TaskCommandControllerSnapshot } from '../../src/domain/server-state.js';

const DEFAULT_TASK_COMMAND_LEASE_MS = 15_000;
let taskCommandControllerStateVersion = 0;
const taskCommandLeaseGenerationByTaskId = new Map<string, number>();

interface TaskCommandLease {
  action: string;
  clientId: string;
  expiresAt: number;
  leaseGeneration: number;
  ownerId: string;
}

export interface AcquireTaskCommandLeaseResult extends TaskCommandControllerSnapshot {
  acquired: boolean;
  changed: boolean;
  leaseGeneration: number;
}

export interface ReleaseTaskCommandLeaseResult {
  changed: boolean;
  snapshot: TaskCommandControllerSnapshot;
}

export interface RenewTaskCommandLeaseResult extends TaskCommandControllerSnapshot {
  renewed: boolean;
  leaseGeneration: number;
}

const taskCommandLeases = new Map<string, TaskCommandLease>();

function createTaskCommandControllerSnapshot(
  taskId: string,
  lease: TaskCommandLease | null,
): TaskCommandControllerSnapshot {
  return {
    action: lease?.action ?? null,
    controllerId: lease?.clientId ?? null,
    taskId,
    version: taskCommandControllerStateVersion,
  };
}

function getNextTaskCommandLeaseGeneration(taskId: string): number {
  const nextGeneration = (taskCommandLeaseGenerationByTaskId.get(taskId) ?? 0) + 1;
  taskCommandLeaseGenerationByTaskId.set(taskId, nextGeneration);
  return nextGeneration;
}

function getTaskCommandLeaseMs(): number {
  return DEFAULT_TASK_COMMAND_LEASE_MS;
}

function deleteTaskCommandLease(taskId: string): void {
  taskCommandLeases.delete(taskId);
  taskCommandControllerStateVersion += 1;
}

function clearExpiredTaskCommandLease(taskId: string, now: number): TaskCommandLease | null {
  const currentLease = taskCommandLeases.get(taskId) ?? null;
  if (!currentLease) {
    return null;
  }

  if (currentLease.expiresAt > now) {
    return currentLease;
  }

  deleteTaskCommandLease(taskId);
  return null;
}

function getActiveTaskCommandLease(taskId: string, now = Date.now()): TaskCommandLease | null {
  return clearExpiredTaskCommandLease(taskId, now);
}

export function getTaskCommandControllerSnapshot(
  taskId: string,
  now = Date.now(),
): TaskCommandControllerSnapshot {
  return createTaskCommandControllerSnapshot(taskId, getActiveTaskCommandLease(taskId, now));
}

export function canResizeTaskTerminal(taskId: string, clientId: string, now = Date.now()): boolean {
  const currentLease = getActiveTaskCommandLease(taskId, now);
  if (!currentLease) {
    return true;
  }

  return currentLease.clientId === clientId;
}

export function acquireTaskCommandLease(
  taskId: string,
  clientId: string,
  ownerId: string,
  action: string,
  takeover = false,
  now = Date.now(),
): AcquireTaskCommandLeaseResult {
  const currentLease = getActiveTaskCommandLease(taskId, now);
  if (currentLease && currentLease.clientId !== clientId && !takeover) {
    return {
      acquired: false,
      changed: false,
      leaseGeneration: currentLease.leaseGeneration,
      ...createTaskCommandControllerSnapshot(taskId, currentLease),
    };
  }

  const nextLease: TaskCommandLease = {
    action,
    clientId,
    expiresAt: now + getTaskCommandLeaseMs(),
    leaseGeneration: getNextTaskCommandLeaseGeneration(taskId),
    ownerId,
  };
  taskCommandLeases.set(taskId, nextLease);
  if (currentLease?.clientId !== nextLease.clientId || currentLease?.action !== nextLease.action) {
    taskCommandControllerStateVersion += 1;
  }

  return {
    acquired: true,
    changed:
      currentLease?.clientId !== nextLease.clientId || currentLease?.action !== nextLease.action,
    leaseGeneration: nextLease.leaseGeneration,
    ...createTaskCommandControllerSnapshot(taskId, nextLease),
  };
}

export function renewTaskCommandLease(
  taskId: string,
  clientId: string,
  ownerId: string,
  now = Date.now(),
  leaseGeneration: number | undefined = undefined,
): RenewTaskCommandLeaseResult {
  const currentLease = getActiveTaskCommandLease(taskId, now);
  if (
    !currentLease ||
    currentLease.clientId !== clientId ||
    currentLease.ownerId !== ownerId ||
    (leaseGeneration !== undefined && currentLease.leaseGeneration !== leaseGeneration)
  ) {
    return {
      renewed: false,
      leaseGeneration: currentLease?.leaseGeneration ?? leaseGeneration ?? 0,
      ...createTaskCommandControllerSnapshot(taskId, currentLease),
    };
  }

  currentLease.expiresAt = now + getTaskCommandLeaseMs();
  taskCommandLeases.set(taskId, currentLease);
  return {
    renewed: true,
    leaseGeneration: currentLease.leaseGeneration,
    ...createTaskCommandControllerSnapshot(taskId, currentLease),
  };
}

export function releaseTaskCommandLease(
  taskId: string,
  clientId?: string,
  ownerId?: string,
  now = Date.now(),
  leaseGeneration?: number,
): ReleaseTaskCommandLeaseResult {
  const currentLease = getActiveTaskCommandLease(taskId, now);
  if (!currentLease) {
    return {
      changed: false,
      snapshot: createTaskCommandControllerSnapshot(taskId, null),
    };
  }

  if (
    (clientId && currentLease.clientId !== clientId) ||
    (ownerId && currentLease.ownerId !== ownerId) ||
    (leaseGeneration !== undefined && currentLease.leaseGeneration !== leaseGeneration)
  ) {
    return {
      changed: false,
      snapshot: createTaskCommandControllerSnapshot(taskId, currentLease),
    };
  }

  deleteTaskCommandLease(taskId);
  return {
    changed: true,
    snapshot: createTaskCommandControllerSnapshot(taskId, null),
  };
}

export function getTaskCommandControllerStateVersion(): number {
  return taskCommandControllerStateVersion;
}

export function pruneExpiredTaskCommandLeases(now = Date.now()): TaskCommandControllerSnapshot[] {
  const releasedSnapshots: TaskCommandControllerSnapshot[] = [];

  for (const taskId of [...taskCommandLeases.keys()]) {
    const hadLease = taskCommandLeases.has(taskId);
    const lease = getActiveTaskCommandLease(taskId, now);
    if (hadLease && !lease) {
      releasedSnapshots.push(createTaskCommandControllerSnapshot(taskId, null));
    }
  }

  return releasedSnapshots;
}

export function getTaskCommandControllers(now = Date.now()): TaskCommandControllerSnapshot[] {
  const snapshots: TaskCommandControllerSnapshot[] = [];
  for (const taskId of taskCommandLeases.keys()) {
    const lease = getActiveTaskCommandLease(taskId, now);
    if (!lease) {
      continue;
    }

    snapshots.push(createTaskCommandControllerSnapshot(taskId, lease));
  }

  return snapshots;
}

export function isTaskCommandLeaseHeld(
  taskId: string,
  clientId: string,
  now = Date.now(),
): boolean {
  const currentLease = getActiveTaskCommandLease(taskId, now);
  return currentLease?.clientId === clientId;
}

export function releaseTaskCommandLeasesForClient(
  clientId: string,
  now = Date.now(),
): TaskCommandControllerSnapshot[] {
  const releasedSnapshots: TaskCommandControllerSnapshot[] = [];

  for (const [taskId, lease] of [...taskCommandLeases.entries()]) {
    const activeLease = getActiveTaskCommandLease(taskId, now);
    if (!activeLease) {
      releasedSnapshots.push(createTaskCommandControllerSnapshot(taskId, null));
      continue;
    }

    if (lease.clientId !== clientId) {
      continue;
    }

    deleteTaskCommandLease(taskId);
    releasedSnapshots.push(createTaskCommandControllerSnapshot(taskId, null));
  }

  return releasedSnapshots;
}

export function resetTaskCommandLeasesForTest(): void {
  taskCommandLeases.clear();
  taskCommandControllerStateVersion = 0;
  taskCommandLeaseGenerationByTaskId.clear();
}
