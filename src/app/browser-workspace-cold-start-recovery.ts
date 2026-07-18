import type { BrowserColdBootstrapProjection } from '../domain/browser-cold-bootstrap';
import type { BrowserColdBootstrapSnapshot } from '../domain/renderer-invoke';
import { takeBrowserColdBootstrapHandoffProjection } from '../store/browser-cold-bootstrap-handoff';
import {
  applyBrowserColdBootstrapWorkspaceProjection,
  loadWorkspaceState,
} from '../store/persistence-load';
import { getLoadedWorkspaceStateJson } from '../store/persistence-session';
import { showNotification } from '../store/notification';
import { store } from '../store/state';
import { fetchBrowserColdBootstrap } from './browser-cold-bootstrap';
import { emitStartupBreadcrumb } from './startup-breadcrumbs';

const BROWSER_COLD_BOOTSTRAP_RETRY_DELAYS_MS = [75, 200] as const;
const BROWSER_COLD_BOOTSTRAP_RECOVERY_DELAYS_MS = [150, 300, 600] as const;
export const BROWSER_COLD_START_ACQUISITION_TIMEOUT_MS = 2_000;

interface BrowserColdBootstrapFetchResult {
  lastError: unknown | null;
  snapshot: BrowserColdBootstrapSnapshot | null;
}

interface BrowserWorkspaceStateLoadResult {
  didLoad: boolean;
  lastError: unknown | null;
}

interface BrowserWorkspaceColdStartRecoveryOptions {
  ensureAgentCatalogRefresh(signal: AbortSignal): Promise<void>;
  isDisposed(): boolean;
  scheduleImmediateSync(): void;
  wait(delayMs: number): Promise<boolean>;
}

interface BrowserWorkspaceColdStartRecoveryRuntimeOptions extends BrowserWorkspaceColdStartRecoveryOptions {
  signal: AbortSignal;
}

export interface BrowserWorkspaceColdStartRecoveryResult {
  coldBootstrap: BrowserColdBootstrapSnapshot | null;
  shouldSchedulePostRestoreSync: boolean;
}

export interface BrowserWorkspaceColdStartRecovery {
  cancel(): void;
  restore(): Promise<BrowserWorkspaceColdStartRecoveryResult | null>;
}

interface RetryResult<T> {
  lastError: unknown | null;
  value: T | null;
}

type BoundedAttemptResult<T> =
  | { status: 'cancelled' }
  | { error: unknown; status: 'failed' }
  | { status: 'succeeded'; value: T };

function isRecoveryStopped(options: BrowserWorkspaceColdStartRecoveryRuntimeOptions): boolean {
  return options.signal.aborted || options.isDisposed();
}

async function runBoundedAttempt<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  recoverySignal: AbortSignal,
): Promise<BoundedAttemptResult<T>> {
  if (recoverySignal.aborted) {
    return { status: 'cancelled' };
  }

  const attemptController = new AbortController();
  let settleInterruption!: (result: BoundedAttemptResult<T>) => void;
  const interruption = new Promise<BoundedAttemptResult<T>>((resolve) => {
    settleInterruption = resolve;
  });
  const cancelAttempt = () => {
    attemptController.abort(recoverySignal.reason);
    settleInterruption({ status: 'cancelled' });
  };
  recoverySignal.addEventListener('abort', cancelAttempt, { once: true });
  if (recoverySignal.aborted) {
    cancelAttempt();
  }

  const timeoutError = new Error(
    `Browser startup acquisition timed out after ${BROWSER_COLD_START_ACQUISITION_TIMEOUT_MS}ms`,
  );
  const timeout = globalThis.setTimeout(() => {
    attemptController.abort(timeoutError);
    settleInterruption({ error: timeoutError, status: 'failed' });
  }, BROWSER_COLD_START_ACQUISITION_TIMEOUT_MS);
  let attemptPromise: Promise<T>;
  try {
    attemptPromise = attempt(attemptController.signal);
  } catch (error) {
    attemptPromise = Promise.reject(error);
  }
  const result = attemptPromise.then<BoundedAttemptResult<T>, BoundedAttemptResult<T>>(
    (value) => ({ status: 'succeeded', value }),
    (error: unknown) =>
      recoverySignal.aborted ? { status: 'cancelled' } : { error, status: 'failed' },
  );

  try {
    return await Promise.race([result, interruption]);
  } finally {
    globalThis.clearTimeout(timeout);
    recoverySignal.removeEventListener('abort', cancelAttempt);
  }
}

async function runRetrySequence<T>(
  attempt: (signal: AbortSignal) => Promise<T | null>,
  isSuccessful: (value: T | null) => boolean,
  options: BrowserWorkspaceColdStartRecoveryRuntimeOptions,
): Promise<RetryResult<T>> {
  let lastError: unknown = null;
  let value: T | null = null;

  for (
    let attemptIndex = 0;
    attemptIndex <= BROWSER_COLD_BOOTSTRAP_RETRY_DELAYS_MS.length;
    attemptIndex += 1
  ) {
    const attemptResult = await runBoundedAttempt(attempt, options.signal);
    if (attemptResult.status === 'cancelled') {
      break;
    }
    if (attemptResult.status === 'succeeded') {
      value = attemptResult.value;
      if (isSuccessful(value)) {
        return {
          lastError,
          value,
        };
      }
    } else {
      lastError = attemptResult.error;
      value = null;
    }

    if (
      attemptIndex >= BROWSER_COLD_BOOTSTRAP_RETRY_DELAYS_MS.length ||
      isRecoveryStopped(options)
    ) {
      break;
    }

    const retryDelayMs = BROWSER_COLD_BOOTSTRAP_RETRY_DELAYS_MS[attemptIndex];
    if (retryDelayMs === undefined || !(await options.wait(retryDelayMs))) {
      break;
    }
  }

  return {
    lastError,
    value,
  };
}

async function fetchBrowserColdBootstrapWithRetry(
  options: BrowserWorkspaceColdStartRecoveryRuntimeOptions,
): Promise<BrowserColdBootstrapFetchResult> {
  const result = await runRetrySequence(
    fetchBrowserColdBootstrap,
    (snapshot) => Boolean(snapshot),
    options,
  );
  return {
    lastError: result.lastError,
    snapshot: result.value,
  };
}

async function loadWorkspaceStateWithRetry(
  options: BrowserWorkspaceColdStartRecoveryRuntimeOptions,
): Promise<BrowserWorkspaceStateLoadResult> {
  const result = await runRetrySequence(loadWorkspaceState, (didLoad) => Boolean(didLoad), options);
  const didLoad = Boolean(result.value);
  return {
    didLoad,
    lastError: didLoad ? null : result.lastError,
  };
}

async function recoverMissingBrowserWorkspaceState(
  options: BrowserWorkspaceColdStartRecoveryRuntimeOptions,
): Promise<BrowserWorkspaceStateLoadResult> {
  let lastError: unknown = null;

  for (const delayMs of BROWSER_COLD_BOOTSTRAP_RECOVERY_DELAYS_MS) {
    if (isRecoveryStopped(options)) {
      break;
    }
    if (hasLoadedCanonicalWorkspaceSnapshot()) {
      return {
        didLoad: true,
        lastError: null,
      };
    }

    if (!(await options.wait(delayMs))) {
      break;
    }
    if (isRecoveryStopped(options)) {
      break;
    }
    if (hasLoadedCanonicalWorkspaceSnapshot()) {
      return {
        didLoad: true,
        lastError: null,
      };
    }

    const attemptResult = await runBoundedAttempt(loadWorkspaceState, options.signal);
    if (attemptResult.status === 'cancelled') {
      break;
    }
    if (attemptResult.status === 'succeeded') {
      if (attemptResult.value) {
        return {
          didLoad: true,
          lastError: null,
        };
      }
    } else {
      lastError = attemptResult.error;
    }
  }

  return {
    didLoad: hasLoadedCanonicalWorkspaceSnapshot(),
    lastError,
  };
}

function createBrowserWorkspaceStartupFailure(
  bootstrapError: unknown,
  workspaceLoadError: unknown,
): Error | null {
  const details = [bootstrapError, workspaceLoadError]
    .map(getBrowserWorkspaceStartupFailureDetail)
    .filter((detail): detail is string => detail !== null);
  if (details.length === 0) {
    return null;
  }

  return new Error(
    `Failed to restore browser workspace during cold bootstrap: ${details.join('; ')}`,
  );
}

function getBrowserWorkspaceStartupFailureDetail(error: unknown): string | null {
  if (error === null || error === undefined) {
    return null;
  }

  const detail = (error instanceof Error ? error.message : String(error)).trim();
  return detail || null;
}

function hasLoadedCanonicalWorkspaceSnapshot(): boolean {
  return getLoadedWorkspaceStateJson() !== null;
}

function applyBrowserWorkspaceProjection(
  projection: BrowserColdBootstrapProjection | null,
  workspaceRevision: number,
): boolean {
  if (!projection) {
    return false;
  }

  applyBrowserColdBootstrapWorkspaceProjection(projection, workspaceRevision);
  emitStartupBreadcrumb('desktop-startup:browser-projection-applied');
  return true;
}

async function restoreBrowserWorkspace(
  coldBootstrapResult: BrowserColdBootstrapFetchResult,
  options: BrowserWorkspaceColdStartRecoveryRuntimeOptions,
): Promise<BrowserWorkspaceColdStartRecoveryResult | null> {
  if (isRecoveryStopped(options)) {
    return null;
  }

  const coldBootstrap = coldBootstrapResult.snapshot;
  const workspaceRevision = coldBootstrap?.workspaceRevision ?? 0;
  let appliedWorkspaceProjection = applyBrowserWorkspaceProjection(
    coldBootstrap?.workspaceProjection ?? null,
    workspaceRevision,
  );
  let shouldSchedulePostRestoreSync = false;

  if (!appliedWorkspaceProjection) {
    const catalogRefreshResult = await runBoundedAttempt(
      options.ensureAgentCatalogRefresh,
      options.signal,
    );
    if (isRecoveryStopped(options)) {
      return null;
    }
    if (catalogRefreshResult.status === 'failed') {
      console.warn(
        'Failed to refresh browser agent catalog during cold bootstrap:',
        catalogRefreshResult.error,
      );
    }

    const handoffProjection = takeBrowserColdBootstrapHandoffProjection({
      currentAvailableAgents: store.availableAgents,
      currentCustomAgents: store.customAgents,
    });
    if (applyBrowserWorkspaceProjection(handoffProjection, workspaceRevision)) {
      appliedWorkspaceProjection = true;
      shouldSchedulePostRestoreSync = true;
    } else {
      const initialWorkspaceStateLoad = await loadWorkspaceStateWithRetry(options);
      if (isRecoveryStopped(options)) {
        return null;
      }
      const recoveredWorkspaceState = initialWorkspaceStateLoad.didLoad
        ? initialWorkspaceStateLoad
        : await recoverMissingBrowserWorkspaceState(options);
      if (isRecoveryStopped(options)) {
        return null;
      }
      if (!recoveredWorkspaceState.didLoad) {
        const workspaceLoadError =
          getBrowserWorkspaceStartupFailureDetail(recoveredWorkspaceState.lastError) !== null
            ? recoveredWorkspaceState.lastError
            : initialWorkspaceStateLoad.lastError;
        if (getBrowserWorkspaceStartupFailureDetail(coldBootstrapResult.lastError) !== null) {
          console.warn('Failed to fetch browser cold bootstrap:', coldBootstrapResult.lastError);
        }
        if (getBrowserWorkspaceStartupFailureDetail(workspaceLoadError) !== null) {
          console.warn(
            'Failed to load browser workspace state during cold bootstrap:',
            workspaceLoadError,
          );
        }
        const startupFailure = createBrowserWorkspaceStartupFailure(
          coldBootstrapResult.lastError,
          workspaceLoadError,
        );
        const startupFailureMessage =
          startupFailure?.message ??
          'Browser cold bootstrap did not restore shared workspace state after retries.';
        console.warn(startupFailureMessage);
        showNotification(startupFailureMessage, { kind: 'error' });
        options.scheduleImmediateSync();
      }
    }
  }

  if (!appliedWorkspaceProjection && !hasLoadedCanonicalWorkspaceSnapshot()) {
    console.warn(
      'Browser startup completed without an authoritative shared workspace snapshot; continuing with the current workspace state.',
    );
  }

  return {
    coldBootstrap,
    shouldSchedulePostRestoreSync,
  };
}

export function startBrowserWorkspaceColdStartRecovery(
  options: BrowserWorkspaceColdStartRecoveryOptions,
): BrowserWorkspaceColdStartRecovery {
  const recoveryController = new AbortController();
  const runtimeOptions = {
    ...options,
    signal: recoveryController.signal,
  } satisfies BrowserWorkspaceColdStartRecoveryRuntimeOptions;
  const coldBootstrapFetch = fetchBrowserColdBootstrapWithRetry(runtimeOptions);
  let restorePromise: Promise<BrowserWorkspaceColdStartRecoveryResult | null> | null = null;

  return {
    cancel(): void {
      if (!recoveryController.signal.aborted) {
        recoveryController.abort(new Error('Browser workspace cold-start recovery cancelled'));
      }
    },
    restore(): Promise<BrowserWorkspaceColdStartRecoveryResult | null> {
      restorePromise ??= coldBootstrapFetch.then((result) =>
        restoreBrowserWorkspace(result, runtimeOptions),
      );
      return restorePromise;
    },
  };
}
