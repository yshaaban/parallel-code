import type { CoordinatorPersistenceHealth } from '../../src/domain/coordinator.js';

// Debounced coordinator persistence: coordinator mutations no longer pay a
// synchronous whole-world save per event. Saves are coalesced on a trailing
// debounce with a max-interval bound so sustained bursts still persist, saves
// are strictly serialized (never two concurrent writes to the same path),
// failures surface as degraded health with backoff retries, and critical
// transitions/shutdown flush explicitly.

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_MAX_INTERVAL_MS = 2_000;
const DEFAULT_RETRY_BACKOFF_MS = [1_000, 5_000, 30_000] as const;

export interface CoordinatorPersistenceScheduler {
  flushNow: () => Promise<void>;
  getHealth: () => CoordinatorPersistenceHealth;
  schedulePersist: () => void;
  stop: () => Promise<void>;
}

export interface CreateCoordinatorPersistenceSchedulerOptions {
  save: () => Promise<void> | void;
  debounceMs?: number;
  maxIntervalMs?: number;
  retryBackoffMs?: readonly number[];
}

export function createCoordinatorPersistenceScheduler(
  options: CreateCoordinatorPersistenceSchedulerOptions,
): CoordinatorPersistenceScheduler {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let burstStartedAt: number | null = null;
  let dirty = false;
  let stopped = false;
  let retryAttempt = 0;
  let pendingSaveCount = 0;
  let saveChain: Promise<void> = Promise.resolve();
  let stopPromise: Promise<void> | null = null;
  let degraded = false;
  let lastSuccessAt: number | null = null;
  let lastErrorAt: number | undefined;
  let lastError: string | undefined;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function recordSaveSuccess(): void {
    degraded = false;
    lastSuccessAt = Date.now();
    retryAttempt = 0;
  }

  function recordSaveFailure(error: unknown): void {
    degraded = true;
    lastErrorAt = Date.now();
    lastError = error instanceof Error ? error.message : String(error);
    if (stopped) {
      return;
    }

    dirty = true;
    const delay =
      retryBackoffMs[Math.min(retryAttempt, retryBackoffMs.length - 1)] ??
      DEFAULT_RETRY_BACKOFF_MS[0];
    retryAttempt += 1;
    armTimer(delay);
  }

  // Serialized save: each save waits for the previous one, so two writes to
  // the same state file can never interleave or land out of order.
  function runSave(): Promise<void> {
    dirty = false;
    pendingSaveCount += 1;
    const run = saveChain.then(async () => {
      try {
        await options.save();
        recordSaveSuccess();
      } catch (error) {
        recordSaveFailure(error);
        throw error;
      }
    });
    saveChain = run.then(
      () => {
        pendingSaveCount -= 1;
      },
      () => {
        pendingSaveCount -= 1;
      },
    );
    return run;
  }

  function armTimer(delayMs: number): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      burstStartedAt = null;
      if (dirty) {
        void runSave().catch(() => {});
      }
    }, delayMs);
  }

  function schedulePersist(): void {
    if (stopped) {
      return;
    }

    dirty = true;
    const now = Date.now();
    if (burstStartedAt === null) {
      burstStartedAt = now;
    }

    const dueAt = Math.min(now + debounceMs, burstStartedAt + maxIntervalMs);
    armTimer(Math.max(0, dueAt - now));
  }

  function flushNow(): Promise<void> {
    // Once stop has queued the authoritative final snapshot, every later flush
    // joins that same lifecycle instead of appending a write behind it.
    if (stopPromise !== null) {
      return stopPromise;
    }

    clearTimer();
    burstStartedAt = null;
    return runSave();
  }

  function stop(): Promise<void> {
    if (stopPromise !== null) {
      return stopPromise;
    }

    stopped = true;
    clearTimer();
    burstStartedAt = null;
    // Always enqueue one final save after the existing chain. The save callback
    // materializes its snapshot only when this turn starts, so every older
    // queued write has settled and can never land after the shutdown snapshot.
    // Keep the rejecting promise: a failed final durability boundary must be
    // visible to the runtime owner and every repeated stop/flush caller.
    stopPromise = runSave();
    return stopPromise;
  }

  function getHealth(): CoordinatorPersistenceHealth {
    return {
      degraded,
      lastSuccessAt,
      ...(lastErrorAt !== undefined ? { lastErrorAt } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      pendingFlush: dirty || timer !== null || pendingSaveCount > 0,
    };
  }

  return {
    flushNow,
    getHealth,
    schedulePersist,
    stop,
  };
}
