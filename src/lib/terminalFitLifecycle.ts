interface MeasuredTerminalSize {
  height: number;
  width: number;
}

interface TerminalGridSize {
  cols: number;
  rows: number;
}

interface CreateTerminalFitLifecycleOptions {
  fit: () => void;
  getMeasuredSize: () => MeasuredTerminalSize;
  getTerminalSize: () => TerminalGridSize;
  maxWaitMs?: number;
  onReady?: () => void;
  retryIntervalMs?: number;
}

export interface TerminalFitLifecycle {
  cleanup: () => void;
  ensureReady: () => Promise<boolean>;
  scheduleStabilize: () => void;
}

const DEFAULT_MAX_WAIT_MS = 750;
const DEFAULT_RETRY_INTERVAL_MS = 50;
const INITIAL_RAF_ATTEMPTS = 2;

function createReadyPromise(): {
  promise: Promise<boolean>;
  resolve: (ready: boolean) => void;
} {
  let resolve!: (ready: boolean) => void;
  const promise = new Promise<boolean>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function getFontsReadyPromise(): Promise<void> | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const ready = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
  if (!ready) {
    return null;
  }

  return Promise.resolve(ready).then(() => {});
}

function hasValidTerminalSize(
  measuredSize: MeasuredTerminalSize,
  terminalSize: TerminalGridSize,
): boolean {
  return (
    measuredSize.width > 0 &&
    measuredSize.height > 0 &&
    terminalSize.cols > 0 &&
    terminalSize.rows > 0
  );
}

export function createTerminalFitLifecycle(
  options: CreateTerminalFitLifecycleOptions,
): TerminalFitLifecycle {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  let disposed = false;
  let isReady = false;
  let fallbackTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let fontsReadyPending = false;
  const rafIds = new Set<number>();
  let pendingReadyState:
    | {
        promise: Promise<boolean>;
        resolve: (ready: boolean) => void;
      }
    | undefined;

  function clearScheduledAttempts(): void {
    if (fallbackTimer !== undefined) {
      clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
    }
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    for (const rafId of rafIds) {
      cancelAnimationFrame(rafId);
    }
    rafIds.clear();
  }

  function resolvePendingReadyState(ready: boolean): void {
    if (!pendingReadyState) {
      return;
    }

    const { resolve } = pendingReadyState;
    pendingReadyState = undefined;
    resolve(ready);
  }

  function finalizeReady(notify: boolean): void {
    if (isReady) {
      return;
    }

    isReady = true;
    clearScheduledAttempts();
    resolvePendingReadyState(notify);
    if (notify) {
      options.onReady?.();
    }
  }

  function resolveNotReady(): void {
    resolvePendingReadyState(false);
  }

  function attemptFit(): boolean {
    if (disposed) {
      return false;
    }

    options.fit();
    const measuredSize = options.getMeasuredSize();
    const terminalSize = options.getTerminalSize();
    if (!hasValidTerminalSize(measuredSize, terminalSize)) {
      return false;
    }

    finalizeReady(true);
    return true;
  }

  function scheduleRetryLoop(): void {
    if (disposed || isReady || retryTimer !== undefined) {
      return;
    }

    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (attemptFit()) {
        return;
      }

      scheduleRetryLoop();
    }, retryIntervalMs);
  }

  function scheduleFallback(): void {
    if (disposed || isReady || fallbackTimer !== undefined || !pendingReadyState) {
      return;
    }

    fallbackTimer = setTimeout(() => {
      fallbackTimer = undefined;
      attemptFit();
      if (!isReady) {
        resolveNotReady();
      }
    }, maxWaitMs);
  }

  function scheduleAnimationFrameFits(attemptsRemaining = INITIAL_RAF_ATTEMPTS): void {
    if (disposed || isReady || attemptsRemaining <= 0) {
      return;
    }

    const rafId = requestAnimationFrame(() => {
      rafIds.delete(rafId);
      if (attemptFit()) {
        return;
      }

      scheduleAnimationFrameFits(attemptsRemaining - 1);
    });
    rafIds.add(rafId);
  }

  function scheduleFontsReadyFit(): void {
    if (disposed || isReady || fontsReadyPending) {
      return;
    }

    const fontsReadyPromise = getFontsReadyPromise();
    if (!fontsReadyPromise) {
      return;
    }

    fontsReadyPending = true;
    void fontsReadyPromise.finally(() => {
      fontsReadyPending = false;
      if (disposed || isReady) {
        return;
      }

      attemptFit();
    });
  }

  function scheduleStabilize(): void {
    if (disposed || isReady) {
      return;
    }

    if (attemptFit()) {
      return;
    }

    scheduleAnimationFrameFits();
    scheduleRetryLoop();
    scheduleFallback();
    scheduleFontsReadyFit();
  }

  return {
    cleanup(): void {
      disposed = true;
      clearScheduledAttempts();
      resolvePendingReadyState(false);
    },
    ensureReady(): Promise<boolean> {
      if (isReady) {
        return Promise.resolve(true);
      }

      if (!pendingReadyState) {
        pendingReadyState = createReadyPromise();
        scheduleFallback();
      }

      const pendingPromise = pendingReadyState.promise;
      scheduleStabilize();
      return pendingPromise;
    },
    scheduleStabilize,
  };
}
