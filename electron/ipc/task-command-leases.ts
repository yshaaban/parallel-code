import type { TaskCommandControllerSnapshot } from '../../src/domain/server-state.js';

const DEFAULT_TASK_COMMAND_LEASE_MS = 15_000;

interface TaskCommandLease {
  action: string;
  clientId: string;
  expiresAt: number;
}

export interface AcquireTaskCommandLeaseResult extends TaskCommandControllerSnapshot {
  acquired: boolean;
  changed: boolean;
}

export interface ReleaseTaskCommandLeaseResult {
  changed: boolean;
  snapshot: TaskCommandControllerSnapshot;
}

export interface RenewTaskCommandLeaseResult extends TaskCommandControllerSnapshot {
  renewed: boolean;
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
  };
}

function getTaskCommandLeaseMs(): number {
  return DEFAULT_TASK_COMMAND_LEASE_MS;
}

function clearExpiredTaskCommandLease(taskId: string, now: number): TaskCommandLease | null {
  const currentLease = taskCommandLeases.get(taskId) ?? null;
  if (!currentLease) {
    return null;
  }

  if (currentLease.expiresAt > now) {
    return currentLease;
  }

  taskCommandLeases.delete(taskId);
  return null;
}

function getActiveTaskCommandLease(taskId: string, now = Date.now()): TaskCommandLease | null {
  return clearExpiredTaskCommandLease(taskId, now);
}

export function acquireTaskCommandLease(
  taskId: string,
  clientId: string,
  action: string,
  takeover = false,
  now = Date.now(),
): AcquireTaskCommandLeaseResult {
  const currentLease = getActiveTaskCommandLease(taskId, now);
  if (currentLease && currentLease.clientId !== clientId && !takeover) {
    return {
      acquired: false,
      changed: false,
      ...createTaskCommandControllerSnapshot(taskId, currentLease),
    };
  }

  const nextLease: TaskCommandLease = {
    action,
    clientId,
    expiresAt: now + getTaskCommandLeaseMs(),
  };
  taskCommandLeases.set(taskId, nextLease);

  return {
    acquired: true,
    changed:
      currentLease?.clientId !== nextLease.clientId || currentLease?.action !== nextLease.action,
    ...createTaskCommandControllerSnapshot(taskId, nextLease),
  };
}

export function renewTaskCommandLease(
  taskId: string,
  clientId: string,
  now = Date.now(),
): RenewTaskCommandLeaseResult {
  const currentLease = getActiveTaskCommandLease(taskId, now);
  if (!currentLease || currentLease.clientId !== clientId) {
    return {
      renewed: false,
      ...createTaskCommandControllerSnapshot(taskId, currentLease),
    };
  }

  currentLease.expiresAt = now + getTaskCommandLeaseMs();
  taskCommandLeases.set(taskId, currentLease);
  return {
    renewed: true,
    ...createTaskCommandControllerSnapshot(taskId, currentLease),
  };
}

export function releaseTaskCommandLease(
  taskId: string,
  clientId?: string,
  now = Date.now(),
): ReleaseTaskCommandLeaseResult {
  const currentLease = getActiveTaskCommandLease(taskId, now);
  if (!currentLease) {
    return {
      changed: false,
      snapshot: createTaskCommandControllerSnapshot(taskId, null),
    };
  }

  if (clientId && currentLease.clientId !== clientId) {
    return {
      changed: false,
      snapshot: createTaskCommandControllerSnapshot(taskId, currentLease),
    };
  }

  taskCommandLeases.delete(taskId);
  return {
    changed: true,
    snapshot: createTaskCommandControllerSnapshot(taskId, null),
  };
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

export function resetTaskCommandLeasesForTest(): void {
  taskCommandLeases.clear();
}
