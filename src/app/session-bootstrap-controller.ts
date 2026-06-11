import type { ServerStateBootstrapResultSnapshot } from '../domain/server-state-bootstrap';
import {
  isDegradedServerStateBootstrapSnapshot,
  SERVER_STATE_BOOTSTRAP_CATEGORIES,
} from '../domain/server-state-bootstrap';
import {
  clearDegradedBootstrapCategory,
  getDegradedBootstrapCategories,
  recordDegradedBootstrapCategory,
} from './runtime-diagnostics';
import {
  createServerStateBootstrapGate,
  fetchServerStateBootstrap,
} from './server-state-bootstrap';
import {
  createServerStateBootstrapCategoryDescriptors,
  createServerStateEventListeners,
} from './server-state-bootstrap-registry';

export interface SessionBootstrapController {
  cleanupStartupListeners: () => void;
  complete: () => void;
  dispose: () => void;
  hydrateInitialSnapshots: (
    snapshots?: ReadonlyArray<ServerStateBootstrapResultSnapshot>,
  ) => Promise<void>;
}

const EMPTY_SERVER_STATE_BOOTSTRAP_SNAPSHOTS: ReadonlyArray<ServerStateBootstrapResultSnapshot> =
  [];
const DEGRADED_BOOTSTRAP_RETRY_DELAY_MS = 5_000;

export function createSessionBootstrapController(
  electronRuntime: boolean,
): SessionBootstrapController {
  const gate = createServerStateBootstrapGate(createServerStateBootstrapCategoryDescriptors());
  const listenerSet = createServerStateEventListeners(electronRuntime, gate);
  let cleanupStartupListeners = listenerSet.cleanupStartupListeners;
  let cleanupPersistentListeners = listenerSet.cleanupPersistentListeners;
  let bootstrapPhaseOpen = true;
  let disposed = false;
  let degradedRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  function runAndResetCleanup(cleanup: () => void, reset: (nextCleanup: () => void) => void): void {
    cleanup();
    reset(() => {});
  }

  function clearDegradedRetryTimer(): void {
    if (degradedRetryTimer !== null) {
      globalThis.clearTimeout(degradedRetryTimer);
      degradedRetryTimer = null;
    }
  }

  // One targeted retry per degraded burst: refetch and apply only the
  // categories that were marked degraded, keeping prior state in the meantime.
  function scheduleDegradedCategoryRetry(): void {
    if (degradedRetryTimer !== null || disposed) {
      return;
    }

    degradedRetryTimer = globalThis.setTimeout(() => {
      degradedRetryTimer = null;
      const degradedCategories = new Set(getDegradedBootstrapCategories());
      if (degradedCategories.size === 0 || disposed) {
        return;
      }

      void fetchServerStateBootstrap()
        .then((snapshots) => {
          if (disposed) {
            return;
          }

          applyBootstrapSnapshots(
            snapshots.filter((snapshot) => degradedCategories.has(snapshot.category)),
            { scheduleRetryOnDegraded: false },
          );
        })
        .catch(() => {
          // Degraded markers stay recorded; diagnostics keep the failure visible.
        });
    }, DEGRADED_BOOTSTRAP_RETRY_DELAY_MS);
  }

  function applyBootstrapSnapshots(
    snapshots: ReadonlyArray<ServerStateBootstrapResultSnapshot>,
    options: { scheduleRetryOnDegraded: boolean } = { scheduleRetryOnDegraded: true },
  ): void {
    for (const snapshot of snapshots) {
      if (isDegradedServerStateBootstrapSnapshot(snapshot)) {
        recordDegradedBootstrapCategory(snapshot.category);
        if (options.scheduleRetryOnDegraded) {
          scheduleDegradedCategoryRetry();
        }
        continue;
      }

      clearDegradedBootstrapCategory(snapshot.category);
      gate.hydrate(snapshot.category, snapshot.payload, snapshot.version);
    }
  }

  async function fetchInitialBootstrapSnapshots(): Promise<
    ReadonlyArray<ServerStateBootstrapResultSnapshot>
  > {
    // One visible retry instead of a silent empty bootstrap: a failed fetch
    // marks every category degraded so it stays diagnosable and retryable.
    try {
      return await fetchServerStateBootstrap();
    } catch {
      try {
        return await fetchServerStateBootstrap();
      } catch {
        for (const category of SERVER_STATE_BOOTSTRAP_CATEGORIES) {
          recordDegradedBootstrapCategory(category);
        }
        scheduleDegradedCategoryRetry();
        return EMPTY_SERVER_STATE_BOOTSTRAP_SNAPSHOTS;
      }
    }
  }

  async function hydrateInitialSnapshots(
    snapshots?: ReadonlyArray<ServerStateBootstrapResultSnapshot>,
  ): Promise<void> {
    const initialSnapshots =
      snapshots ??
      (electronRuntime
        ? await fetchInitialBootstrapSnapshots()
        : EMPTY_SERVER_STATE_BOOTSTRAP_SNAPSHOTS);
    if (!bootstrapPhaseOpen) {
      return;
    }

    applyBootstrapSnapshots(initialSnapshots);
  }

  function cleanupListeners(): void {
    runAndResetCleanup(cleanupStartupListeners, (nextCleanup) => {
      cleanupStartupListeners = nextCleanup;
    });
    runAndResetCleanup(cleanupPersistentListeners, (nextCleanup) => {
      cleanupPersistentListeners = nextCleanup;
    });
  }

  function cleanupStartupOnlyListeners(): void {
    runAndResetCleanup(cleanupStartupListeners, (nextCleanup) => {
      cleanupStartupListeners = nextCleanup;
    });
  }

  return {
    cleanupStartupListeners: cleanupStartupOnlyListeners,
    complete: () => {
      bootstrapPhaseOpen = false;
      gate.complete();
      cleanupStartupOnlyListeners();
    },
    dispose: () => {
      bootstrapPhaseOpen = false;
      disposed = true;
      clearDegradedRetryTimer();
      gate.dispose();
      cleanupListeners();
    },
    hydrateInitialSnapshots,
  };
}
