import { IPC } from '../../electron/ipc/channels';
import { confirm } from '../lib/dialog';
import { invoke } from '../lib/ipc';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { store } from '../store/core';

const TASK_COMMAND_LEASE_RENEW_MS = 5_000;
const TASK_COMMAND_LEASE_SESSION_IDLE_MS = 2_500;

export const TASK_COMMAND_LEASE_SKIPPED = Symbol('task-command-lease-skipped');

export type TaskCommandLeaseResult<T> = T | typeof TASK_COMMAND_LEASE_SKIPPED;

interface TaskCommandLeaseOptions {
  confirmTakeover?: boolean;
  takeover?: boolean;
}

interface TaskCommandLeaseAcquireResult {
  action: string | null;
  acquired: boolean;
  controllerId: string | null;
  taskId: string;
}

interface LocalTaskCommandLease {
  acquirePromise: Promise<boolean> | undefined;
  actionDescription: string;
  holdCount: number;
  renewTimer: ReturnType<typeof globalThis.setInterval> | undefined;
}

const localTaskCommandLeases = new Map<string, LocalTaskCommandLease>();

function getTaskCommandControlMessage(
  actionDescription: string,
  controllerId: string | null,
  currentAction: string | null,
): string {
  const controllerLabel = controllerId ? `client ${controllerId}` : 'another client';
  if (currentAction) {
    return `${controllerLabel} is already controlling this task to ${currentAction}. Take over to ${actionDescription}?`;
  }

  return `${controllerLabel} is already controlling this task. Take over to ${actionDescription}?`;
}

export interface TaskCommandLeaseSession {
  acquire(): Promise<boolean>;
  cleanup(): void;
  release(): Promise<void>;
  takeOver(): Promise<boolean>;
}

async function acquireTaskCommandLease(
  taskId: string,
  clientId: string,
  actionDescription: string,
  takeover: boolean,
): Promise<TaskCommandLeaseAcquireResult> {
  return invoke(IPC.AcquireTaskCommandLease, {
    action: actionDescription,
    clientId,
    taskId,
    ...(takeover ? { takeover: true } : {}),
  });
}

async function ensureTaskCommandLease(
  taskId: string,
  clientId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions = {},
): Promise<boolean> {
  let lease = await acquireTaskCommandLease(taskId, clientId, actionDescription, false);
  if (!lease.acquired && lease.controllerId !== clientId) {
    if (options.takeover === true) {
      lease = await acquireTaskCommandLease(taskId, clientId, actionDescription, true);
      if (!lease.acquired) {
        throw new Error('Task is controlled by another client');
      }
      return true;
    }

    if (options.confirmTakeover === false) {
      return false;
    }

    const shouldTakeOver = await confirm(
      getTaskCommandControlMessage(actionDescription, lease.controllerId, lease.action),
      {
        cancelLabel: 'Cancel',
        kind: 'warning',
        okLabel: 'Take Over',
        title: 'Task In Use',
      },
    ).catch(() => false);
    if (!shouldTakeOver) {
      return false;
    }

    lease = await acquireTaskCommandLease(taskId, clientId, actionDescription, true);
    if (!lease.acquired) {
      throw new Error('Task is controlled by another client');
    }
  }

  return true;
}

function startTaskCommandLeaseRenewal(
  taskId: string,
  clientId: string,
): ReturnType<typeof globalThis.setInterval> {
  return globalThis.setInterval(() => {
    void invoke(IPC.RenewTaskCommandLease, {
      clientId,
      taskId,
    }).catch(() => {});
  }, TASK_COMMAND_LEASE_RENEW_MS);
}

function clearTaskCommandLeaseRenewal(taskId: string): void {
  const lease = localTaskCommandLeases.get(taskId);
  if (!lease?.renewTimer) {
    return;
  }

  globalThis.clearInterval(lease.renewTimer);
  lease.renewTimer = undefined;
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
    return;
  }

  if (lease.holdCount > 0 || lease.acquirePromise || lease.renewTimer) {
    return;
  }

  localTaskCommandLeases.delete(taskId);
}

function decrementTaskCommandLeaseHold(lease: LocalTaskCommandLease): void {
  lease.holdCount = Math.max(lease.holdCount - 1, 0);
}

async function releaseTaskCommandLeaseToBackend(taskId: string, clientId: string): Promise<void> {
  clearTaskCommandLeaseRenewal(taskId);
  await invoke(IPC.ReleaseTaskCommandLease, {
    clientId,
    taskId,
  }).catch(() => {});
  cleanupReleasedTaskCommandLease(taskId);
}

async function retainTaskCommandLease(
  taskId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions = {},
): Promise<boolean> {
  const clientId = getRuntimeClientId();
  const lease = getOrCreateLocalTaskCommandLease(taskId, actionDescription);
  lease.holdCount += 1;

  async function refreshHeldLease(): Promise<boolean> {
    if (lease.actionDescription === actionDescription) {
      return true;
    }

    const acquired = await ensureTaskCommandLease(taskId, clientId, actionDescription, options);
    if (acquired) {
      lease.actionDescription = actionDescription;
    }
    return acquired;
  }

  if (lease.renewTimer) {
    const acquired = await refreshHeldLease();
    if (!acquired) {
      decrementTaskCommandLeaseHold(lease);
      cleanupReleasedTaskCommandLease(taskId);
      return false;
    }
    return true;
  }

  if (!lease.acquirePromise) {
    lease.actionDescription = actionDescription;
    lease.acquirePromise = ensureTaskCommandLease(taskId, clientId, actionDescription, options)
      .then((acquired) => {
        if (!acquired) {
          return false;
        }

        lease.renewTimer = startTaskCommandLeaseRenewal(taskId, clientId);
        return true;
      })
      .finally(() => {
        lease.acquirePromise = undefined;
        cleanupReleasedTaskCommandLease(taskId);
      });
  }

  const acquired = await lease.acquirePromise;
  if (!acquired) {
    decrementTaskCommandLeaseHold(lease);
    cleanupReleasedTaskCommandLease(taskId);
    return false;
  }

  return refreshHeldLease();
}

async function releaseTaskCommandLeaseHold(taskId: string): Promise<void> {
  const clientId = getRuntimeClientId();
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

  await releaseTaskCommandLeaseToBackend(taskId, clientId);
}

export function isTaskCommandLeaseSkipped<T>(
  value: TaskCommandLeaseResult<T>,
): value is typeof TASK_COMMAND_LEASE_SKIPPED {
  return value === TASK_COMMAND_LEASE_SKIPPED;
}

export async function runWithTaskCommandLease<T>(
  taskId: string,
  actionDescription: string,
  run: () => Promise<T>,
  options: TaskCommandLeaseOptions = {},
): Promise<TaskCommandLeaseResult<T>> {
  const acquired = await retainTaskCommandLease(taskId, actionDescription, options);
  if (!acquired) {
    return TASK_COMMAND_LEASE_SKIPPED;
  }

  try {
    return await run();
  } finally {
    await releaseTaskCommandLeaseHold(taskId);
  }
}

export async function runWithAgentTaskCommandLease<T>(
  agentId: string,
  actionDescription: string,
  run: () => Promise<T>,
  options: TaskCommandLeaseOptions = {},
): Promise<TaskCommandLeaseResult<T>> {
  const taskId = store.agents[agentId]?.taskId;
  if (!taskId) {
    return run();
  }

  return runWithTaskCommandLease(taskId, actionDescription, run, options);
}

export function createTaskCommandLeaseSession(
  taskId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions & {
    idleReleaseMs?: number;
  } = {},
): TaskCommandLeaseSession {
  const idleReleaseMs = options.idleReleaseMs ?? TASK_COMMAND_LEASE_SESSION_IDLE_MS;
  let releaseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let disposed = false;
  let retained = false;

  function clearReleaseTimer(): void {
    if (releaseTimer !== undefined) {
      globalThis.clearTimeout(releaseTimer);
      releaseTimer = undefined;
    }
  }

  function scheduleRelease(): void {
    clearReleaseTimer();
    releaseTimer = globalThis.setTimeout(() => {
      void release();
    }, idleReleaseMs);
  }

  async function release(): Promise<void> {
    clearReleaseTimer();
    if (!retained) {
      return;
    }

    retained = false;
    await releaseTaskCommandLeaseHold(taskId);
  }

  async function acquire(): Promise<boolean> {
    if (disposed) {
      return false;
    }

    if (retained) {
      scheduleRelease();
      return true;
    }

    const acquired = await retainTaskCommandLease(taskId, actionDescription, options);
    if (!acquired || disposed) {
      if (acquired) {
        await releaseTaskCommandLeaseHold(taskId);
      }
      return false;
    }

    retained = true;
    scheduleRelease();
    return true;
  }

  async function takeOver(): Promise<boolean> {
    if (disposed) {
      return false;
    }

    if (retained) {
      scheduleRelease();
      return true;
    }

    const acquired = await retainTaskCommandLease(taskId, actionDescription, {
      ...options,
      confirmTakeover: false,
      takeover: true,
    });
    if (!acquired || disposed) {
      if (acquired) {
        await releaseTaskCommandLeaseHold(taskId);
      }
      return false;
    }

    retained = true;
    scheduleRelease();
    return true;
  }

  function cleanup(): void {
    disposed = true;
    clearReleaseTimer();
    void release();
  }

  return {
    acquire,
    cleanup,
    release,
    takeOver,
  };
}
