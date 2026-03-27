import { getRuntimeClientId } from '../lib/runtime-client-id';
import { store } from '../store/state';
import {
  addTaskCommandLeaseSessionInvalidator,
  assertTaskCommandLeaseRuntimeStateCleanForTests,
  ensureTaskCommandLeaseSubscriptions,
  expireIncomingTaskCommandTakeoverRequest,
  handleIncomingTaskCommandTakeoverRequest,
  handleTaskCommandTakeoverResult,
  hasLocalTaskCommandLeaseOwnership,
  hasTaskCommandLeaseTransportAvailability,
  releaseTaskCommandLeaseHold,
  resetTaskCommandLeaseRuntimeStateForTests,
  retainTaskCommandLease,
  syncFocusedTypingTaskCommandLease as syncFocusedTypingTaskCommandLeaseRuntime,
  type TaskCommandLeaseOptions,
} from './task-command-lease-runtime';

const TASK_COMMAND_LEASE_SESSION_IDLE_MS = 5_000;

export const TASK_COMMAND_LEASE_SKIPPED = Symbol('task-command-lease-skipped');

export type TaskCommandLeaseResult<T> = T | typeof TASK_COMMAND_LEASE_SKIPPED;

export interface TaskCommandLeaseSession {
  acquire(): Promise<boolean>;
  cleanup(): void;
  release(): Promise<void>;
  takeOver(): Promise<boolean>;
  touch(): boolean;
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

  let runSucceeded = false;
  let result: T | undefined;
  let runFailed = false;
  let runFailure: unknown;
  try {
    result = await run();
    runSucceeded = true;
  } catch (error) {
    runFailed = true;
    runFailure = error;
  }

  const released = await releaseTaskCommandLeaseHold(taskId);
  if (runFailed) {
    throw runFailure;
  }
  if (!released && runSucceeded) {
    throw new Error(`Failed to release task command lease for ${taskId}`);
  }

  return result as T;
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
  ensureTaskCommandLeaseSubscriptions();
  const idleReleaseMs = options.idleReleaseMs ?? TASK_COMMAND_LEASE_SESSION_IDLE_MS;
  let releaseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let disposed = false;
  let retained = false;
  const clientId = getRuntimeClientId();
  const removeSessionInvalidator = addTaskCommandLeaseSessionInvalidator(taskId, () => {
    if (!retained) {
      return;
    }

    void clearRetainedSessionLease({ notifyBackend: false });
  });

  function clearReleaseTimer(): void {
    if (releaseTimer !== undefined) {
      globalThis.clearTimeout(releaseTimer);
      releaseTimer = undefined;
    }
  }

  function hasRetainedSessionLeaseOwnership(): boolean {
    return (
      retained &&
      hasTaskCommandLeaseTransportAvailability() &&
      hasLocalTaskCommandLeaseOwnership(taskId, clientId)
    );
  }

  function scheduleRelease(): void {
    clearReleaseTimer();
    releaseTimer = globalThis.setTimeout(() => {
      void release();
    }, idleReleaseMs);
  }

  async function clearRetainedSessionLease(nextOptions: { notifyBackend: boolean }): Promise<void> {
    if (!retained) {
      return;
    }

    retained = false;
    clearReleaseTimer();
    await releaseTaskCommandLeaseHold(taskId, {
      notifyBackend: nextOptions.notifyBackend,
    });
  }

  async function release(): Promise<void> {
    await clearRetainedSessionLease({ notifyBackend: true });
  }

  async function invalidateRetainedLeaseIfStale(): Promise<void> {
    if (!retained || hasRetainedSessionLeaseOwnership()) {
      return;
    }

    await clearRetainedSessionLease({ notifyBackend: false });
  }

  async function retainSessionLease(nextOptions: TaskCommandLeaseOptions): Promise<boolean> {
    if (disposed) {
      return false;
    }

    await invalidateRetainedLeaseIfStale();

    if (retained) {
      scheduleRelease();
      return true;
    }

    const acquired = await retainTaskCommandLease(taskId, actionDescription, nextOptions);
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

  async function acquire(): Promise<boolean> {
    return retainSessionLease({
      ...options,
      confirmTakeover: false,
      takeover: false,
    });
  }

  async function takeOver(): Promise<boolean> {
    return retainSessionLease({
      ...options,
      confirmTakeover: false,
      takeover: true,
    });
  }

  function touch(): boolean {
    if (disposed || !hasRetainedSessionLeaseOwnership()) {
      return false;
    }

    scheduleRelease();
    return true;
  }

  function cleanup(): void {
    disposed = true;
    removeSessionInvalidator();
    clearReleaseTimer();
    void release();
  }

  return {
    acquire,
    cleanup,
    release,
    takeOver,
    touch,
  };
}

export function syncFocusedTypingTaskCommandLease(
  activeTaskId: string | null,
  focusedSurface: string | null,
): void {
  syncFocusedTypingTaskCommandLeaseRuntime(activeTaskId, focusedSurface);
}

export function resetTaskCommandLeaseStateForTests(): void {
  resetTaskCommandLeaseRuntimeStateForTests();
}

export function assertTaskCommandLeaseStateCleanForTests(): void {
  assertTaskCommandLeaseRuntimeStateCleanForTests();
}

export {
  expireIncomingTaskCommandTakeoverRequest,
  hasTaskCommandLeaseTransportAvailability,
  handleIncomingTaskCommandTakeoverRequest,
  handleTaskCommandTakeoverResult,
};
