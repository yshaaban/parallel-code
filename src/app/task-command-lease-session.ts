import { getRuntimeClientId } from '../lib/runtime-client-id';
import { store } from '../store/state';
import { isTypingTaskCommandFocusedSurface } from '../domain/task-command-focus';
import { isBrowserPagehidePending } from '../lib/browser-pagehide';
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
const TASK_COMMAND_LEASE_SESSION_CLEANUP_GRACE_MS = 250;
const FOCUSED_TYPING_LEASE_TOUCH_INTERVAL_MS = 500;

const sharedTaskCommandLeaseSessions = new Map<string, SharedTaskCommandLeaseSession>();
const typingLeaseTouchCallbacksByTaskId = new Map<string, Set<() => boolean>>();

let focusedTypingLeaseTouchTimer: ReturnType<typeof globalThis.setInterval> | undefined;
let focusedTypingLeaseTaskId: string | null = null;

export const TASK_COMMAND_LEASE_SKIPPED = Symbol('task-command-lease-skipped');

export type TaskCommandLeaseResult<T> = T | typeof TASK_COMMAND_LEASE_SKIPPED;

export interface TaskCommandLeaseSession {
  acquire(): Promise<boolean>;
  cleanup(): void;
  release(): Promise<void>;
  takeOver(): Promise<boolean>;
  touch(): boolean;
}

interface SharedTaskCommandLeaseSession {
  acquire(): Promise<boolean>;
  addHandle(): void;
  cleanupHandle(): void;
  disposeForReset(): void;
  release(): Promise<void>;
  takeOver(): Promise<boolean>;
  touch(): boolean;
}

export function isTaskCommandLeaseSkipped<T>(
  value: TaskCommandLeaseResult<T>,
): value is typeof TASK_COMMAND_LEASE_SKIPPED {
  return value === TASK_COMMAND_LEASE_SKIPPED;
}

function isTypingTaskCommandAction(actionDescription: string): boolean {
  return actionDescription === 'type in the terminal';
}

function clearFocusedTypingLeaseTouchTimer(): void {
  if (focusedTypingLeaseTouchTimer === undefined) {
    return;
  }

  globalThis.clearInterval(focusedTypingLeaseTouchTimer);
  focusedTypingLeaseTouchTimer = undefined;
}

function touchTypingLeaseSessions(taskId: string | null): void {
  if (!taskId) {
    return;
  }

  const touchCallbacks = typingLeaseTouchCallbacksByTaskId.get(taskId);
  if (!touchCallbacks) {
    return;
  }

  for (const touch of touchCallbacks) {
    touch();
  }
}

function syncFocusedTypingLeaseTouchTimer(
  activeTaskId: string | null,
  focusedSurface: string | null,
): void {
  const shouldTouchFocusedTypingLease =
    activeTaskId !== null && isTypingTaskCommandFocusedSurface(focusedSurface);
  focusedTypingLeaseTaskId = shouldTouchFocusedTypingLease ? activeTaskId : null;
  clearFocusedTypingLeaseTouchTimer();

  if (!focusedTypingLeaseTaskId) {
    return;
  }

  touchTypingLeaseSessions(focusedTypingLeaseTaskId);
  focusedTypingLeaseTouchTimer = globalThis.setInterval(() => {
    touchTypingLeaseSessions(focusedTypingLeaseTaskId);
  }, FOCUSED_TYPING_LEASE_TOUCH_INTERVAL_MS);
}

function addTypingLeaseTouchCallback(taskId: string, touch: () => boolean): () => void {
  const existingCallbacks = typingLeaseTouchCallbacksByTaskId.get(taskId);
  if (existingCallbacks) {
    existingCallbacks.add(touch);
  } else {
    typingLeaseTouchCallbacksByTaskId.set(taskId, new Set([touch]));
  }

  return () => {
    const callbacks = typingLeaseTouchCallbacksByTaskId.get(taskId);
    if (!callbacks) {
      return;
    }

    callbacks.delete(touch);
    if (callbacks.size === 0) {
      typingLeaseTouchCallbacksByTaskId.delete(taskId);
      if (focusedTypingLeaseTaskId === taskId) {
        clearFocusedTypingLeaseTouchTimer();
      }
    }
  };
}

function resetFocusedTypingLeaseTouchState(): void {
  clearFocusedTypingLeaseTouchTimer();
  focusedTypingLeaseTaskId = null;
  typingLeaseTouchCallbacksByTaskId.clear();
}

function getTaskCommandLeaseSessionKey(taskId: string, actionDescription: string): string {
  return `${taskId}\u0000${actionDescription}`;
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
  const sessionKey = getTaskCommandLeaseSessionKey(taskId, actionDescription);
  let sharedSession = sharedTaskCommandLeaseSessions.get(sessionKey);
  if (!sharedSession) {
    sharedSession = createSharedTaskCommandLeaseSession(
      taskId,
      actionDescription,
      options,
      sessionKey,
    );
    sharedTaskCommandLeaseSessions.set(sessionKey, sharedSession);
  }

  sharedSession.addHandle();

  let disposed = false;

  return {
    acquire(): Promise<boolean> {
      if (disposed) {
        return Promise.resolve(false);
      }

      return sharedSession.acquire();
    },
    cleanup(): void {
      if (disposed) {
        return;
      }

      disposed = true;
      sharedSession.cleanupHandle();
    },
    release(): Promise<void> {
      if (disposed) {
        return Promise.resolve();
      }

      return sharedSession.release();
    },
    takeOver(): Promise<boolean> {
      if (disposed) {
        return Promise.resolve(false);
      }

      return sharedSession.takeOver();
    },
    touch(): boolean {
      if (disposed) {
        return false;
      }

      return sharedSession.touch();
    },
  };
}

function createSharedTaskCommandLeaseSession(
  taskId: string,
  actionDescription: string,
  options: TaskCommandLeaseOptions & {
    idleReleaseMs?: number;
  },
  sessionKey: string,
): SharedTaskCommandLeaseSession {
  ensureTaskCommandLeaseSubscriptions();
  const idleReleaseMs = options.idleReleaseMs ?? TASK_COMMAND_LEASE_SESSION_IDLE_MS;
  const clientId = getRuntimeClientId();
  let releaseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let cleanupGraceTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let retained = false;
  let subscriberCount = 0;
  let finalizeGeneration = 0;
  let finalizing = false;
  const removeTypingLeaseTouchCallback = isTypingTaskCommandAction(actionDescription)
    ? addTypingLeaseTouchCallback(taskId, () => touch())
    : () => undefined;
  const removeSessionInvalidator = addTaskCommandLeaseSessionInvalidator(taskId, () => {
    if (!retained) {
      return;
    }

    void clearRetainedSessionLease({ notifyBackend: false });
  });

  function clearCleanupGraceTimer(): void {
    if (cleanupGraceTimer === undefined) {
      return;
    }

    globalThis.clearTimeout(cleanupGraceTimer);
    cleanupGraceTimer = undefined;
  }

  function clearReleaseTimer(): void {
    if (releaseTimer === undefined) {
      return;
    }

    globalThis.clearTimeout(releaseTimer);
    releaseTimer = undefined;
  }

  function removeSharedSessionIfCurrent(): void {
    if (sharedTaskCommandLeaseSessions.get(sessionKey) === sharedSession) {
      sharedTaskCommandLeaseSessions.delete(sessionKey);
    }
  }

  function disposeSharedSessionResources(): void {
    removeTypingLeaseTouchCallback();
    removeSessionInvalidator();
    clearCleanupGraceTimer();
    clearReleaseTimer();
    removeSharedSessionIfCurrent();
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
    await invalidateRetainedLeaseIfStale();

    if (retained) {
      scheduleRelease();
      return true;
    }

    const acquired = await retainTaskCommandLease(taskId, actionDescription, nextOptions);
    if (!acquired) {
      return false;
    }

    retained = true;
    scheduleRelease();
    return true;
  }

  function touch(): boolean {
    if (subscriberCount === 0 || !hasRetainedSessionLeaseOwnership()) {
      return false;
    }

    scheduleRelease();
    return true;
  }

  async function finalizeIfUnused(): Promise<void> {
    if (subscriberCount !== 0 || finalizing) {
      return;
    }

    finalizing = true;
    const currentFinalizeGeneration = ++finalizeGeneration;
    clearCleanupGraceTimer();
    clearReleaseTimer();
    await release();
    finalizing = false;
    if (subscriberCount !== 0 || finalizeGeneration !== currentFinalizeGeneration) {
      return;
    }

    disposeSharedSessionResources();
  }

  function scheduleCleanupGrace(): void {
    clearCleanupGraceTimer();
    cleanupGraceTimer = globalThis.setTimeout(() => {
      cleanupGraceTimer = undefined;
      void finalizeIfUnused();
    }, TASK_COMMAND_LEASE_SESSION_CLEANUP_GRACE_MS);
  }

  const sharedSession: SharedTaskCommandLeaseSession = {
    acquire(): Promise<boolean> {
      return retainSessionLease({
        ...options,
        confirmTakeover: false,
        takeover: false,
      });
    },
    addHandle(): void {
      subscriberCount += 1;
      finalizeGeneration += 1;
      clearCleanupGraceTimer();
    },
    cleanupHandle(): void {
      subscriberCount = Math.max(0, subscriberCount - 1);
      if (subscriberCount !== 0) {
        return;
      }

      if (!retained || !hasRetainedSessionLeaseOwnership() || isBrowserPagehidePending()) {
        void finalizeIfUnused();
        return;
      }

      scheduleCleanupGrace();
    },
    disposeForReset(): void {
      subscriberCount = 0;
      retained = false;
      clearCleanupGraceTimer();
      clearReleaseTimer();
      removeTypingLeaseTouchCallback();
      removeSessionInvalidator();
    },
    release(): Promise<void> {
      return release();
    },
    takeOver(): Promise<boolean> {
      return retainSessionLease({
        ...options,
        confirmTakeover: false,
        takeover: true,
      });
    },
    touch(): boolean {
      return touch();
    },
  };

  return sharedSession;
}

export function syncFocusedTypingTaskCommandLease(
  activeTaskId: string | null,
  focusedSurface: string | null,
): void {
  syncFocusedTypingLeaseTouchTimer(activeTaskId, focusedSurface);
  syncFocusedTypingTaskCommandLeaseRuntime(activeTaskId, focusedSurface);
}

export function resetTaskCommandLeaseStateForTests(): void {
  for (const sharedSession of sharedTaskCommandLeaseSessions.values()) {
    sharedSession.disposeForReset();
  }
  sharedTaskCommandLeaseSessions.clear();
  resetFocusedTypingLeaseTouchState();
  resetTaskCommandLeaseRuntimeStateForTests();
}

export function assertTaskCommandLeaseStateCleanForTests(): void {
  if (sharedTaskCommandLeaseSessions.size !== 0) {
    throw new Error(
      `Expected no shared task-command lease sessions, found ${sharedTaskCommandLeaseSessions.size}`,
    );
  }

  assertTaskCommandLeaseRuntimeStateCleanForTests();
}

export {
  expireIncomingTaskCommandTakeoverRequest,
  hasTaskCommandLeaseTransportAvailability,
  handleIncomingTaskCommandTakeoverRequest,
  handleTaskCommandTakeoverResult,
};
