import type { AnyServerStateBootstrapSnapshot } from '../domain/server-state-bootstrap';
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
  hydrateInitialSnapshots: () => Promise<void>;
}

const EMPTY_SERVER_STATE_BOOTSTRAP_SNAPSHOTS: ReadonlyArray<AnyServerStateBootstrapSnapshot> = [];

export function createSessionBootstrapController(
  electronRuntime: boolean,
): SessionBootstrapController {
  const gate = createServerStateBootstrapGate(createServerStateBootstrapCategoryDescriptors());
  const listenerSet = createServerStateEventListeners(electronRuntime, gate);
  let cleanupStartupListeners = listenerSet.cleanupStartupListeners;
  let cleanupPersistentListeners = listenerSet.cleanupPersistentListeners;

  function runAndResetCleanup(cleanup: () => void, reset: (nextCleanup: () => void) => void): void {
    cleanup();
    reset(() => {});
  }

  function applyBootstrapSnapshots(
    snapshots: ReadonlyArray<AnyServerStateBootstrapSnapshot>,
  ): void {
    for (const snapshot of snapshots) {
      gate.hydrate(snapshot.category, snapshot.payload, snapshot.version);
    }
  }

  async function fetchInitialBootstrapSnapshots(): Promise<
    ReadonlyArray<AnyServerStateBootstrapSnapshot>
  > {
    return fetchServerStateBootstrap().catch(() => EMPTY_SERVER_STATE_BOOTSTRAP_SNAPSHOTS);
  }

  async function hydrateInitialSnapshots(): Promise<void> {
    if (!electronRuntime) {
      return;
    }

    applyBootstrapSnapshots(await fetchInitialBootstrapSnapshots());
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
      gate.complete();
      cleanupStartupOnlyListeners();
    },
    dispose: () => {
      gate.dispose();
      cleanupListeners();
    },
    hydrateInitialSnapshots,
  };
}
