import { assertNever } from '../lib/assert-never';
import type { BrowserReconnectSnapshot } from '../domain/renderer-invoke';
import {
  recordBrowserSyncCompleted,
  recordBrowserSyncFailed,
  recordBrowserSyncScheduled,
  recordBrowserSyncStarted,
  recordBrowserSyncSuperseded,
} from '../app/runtime-diagnostics';
import { markAutosaveClean } from '../store/autosave';
import {
  applyLoadedStateJson,
  loadState,
  showNotification,
  validateProjectPaths,
} from '../store/store';

type BrowserStateSyncStatus =
  | { kind: 'idle' }
  | { kind: 'scheduled'; notify: boolean; timer: number }
  | { kind: 'syncing'; notifyCurrentRun: boolean; pendingNotify: boolean | null }
  | { kind: 'disposed' };

const BROWSER_SYNC_FAILURE_MESSAGE = 'Failed to sync browser state from server';

function mergeSyncNotify(current: boolean | null, notify: boolean): boolean {
  return (current ?? false) || notify;
}

function isBrowserStateSyncDisposed(state: BrowserStateSyncStatus): boolean {
  return state.kind === 'disposed';
}

function finalizeBrowserStateSync(state: BrowserStateSyncStatus): {
  nextNotify: boolean | null;
  nextState: BrowserStateSyncStatus;
} {
  switch (state.kind) {
    case 'syncing':
      return {
        nextNotify: state.pendingNotify,
        nextState: { kind: 'idle' },
      };
    case 'idle':
    case 'scheduled':
    case 'disposed':
      return {
        nextNotify: null,
        nextState: state,
      };
    default:
      return assertNever(state, 'Unhandled browser state sync status');
  }
}

export function createBrowserStateSync(electronRuntime: boolean): {
  cleanupBrowserStateSyncTimer: () => void;
  scheduleBrowserStateSync: (delayMs?: number, notify?: boolean) => void;
  syncBrowserStateFromReconnectSnapshot: (
    snapshot: BrowserReconnectSnapshot,
    notify?: boolean,
  ) => Promise<void>;
  syncBrowserStateFromServer: (notify?: boolean) => Promise<void>;
} {
  let state: BrowserStateSyncStatus = { kind: 'idle' };
  let currentSyncPromise: Promise<void> | null = null;

  async function runTrackedBrowserStateSync(syncOperation: () => Promise<void>): Promise<void> {
    const syncPromise = syncOperation();
    currentSyncPromise = syncPromise;
    try {
      await syncPromise;
    } finally {
      if (currentSyncPromise === syncPromise) {
        currentSyncPromise = null;
      }
    }
  }

  function prepareImmediateBrowserStateSync(notify: boolean): {
    kind: 'run' | 'skip' | 'wait';
    notify: boolean;
  } {
    switch (state.kind) {
      case 'disposed':
        return { kind: 'skip', notify };
      case 'scheduled':
        notify = mergeSyncNotify(state.notify, notify);
        clearTimeout(state.timer);
        state = { kind: 'idle' };
        return { kind: 'run', notify };
      case 'syncing':
        state = {
          kind: 'syncing',
          notifyCurrentRun: mergeSyncNotify(state.notifyCurrentRun, notify),
          pendingNotify: state.pendingNotify,
        };
        recordBrowserSyncSuperseded();
        return { kind: 'wait', notify };
      case 'idle':
        return { kind: 'run', notify };
      default:
        return assertNever(state, 'Unhandled browser state sync status');
    }
  }

  async function runBrowserStateSyncAttempt(
    notify: boolean,
    readStateChange: () => Promise<boolean>,
  ): Promise<boolean | null> {
    if (isBrowserStateSyncDisposed(state)) {
      return null;
    }

    const startedAt = Date.now();
    recordBrowserSyncStarted();
    state = {
      kind: 'syncing',
      notifyCurrentRun: notify,
      pendingNotify: null,
    };

    try {
      const stateChanged = await readStateChange();
      if (isBrowserStateSyncDisposed(state)) {
        return null;
      }

      if (stateChanged) {
        markAutosaveClean();
      }

      await validateProjectPaths();
      if (isBrowserStateSyncDisposed(state)) {
        return null;
      }

      if (stateChanged && state.kind === 'syncing' && state.notifyCurrentRun) {
        showNotification('State updated in another browser tab');
      }
      recordBrowserSyncCompleted(Date.now() - startedAt);
    } catch (error) {
      console.warn('Failed to sync browser state from server:', error);
      if (!isBrowserStateSyncDisposed(state)) {
        showNotification(BROWSER_SYNC_FAILURE_MESSAGE);
      }
      recordBrowserSyncFailed(Date.now() - startedAt);
    }

    if (isBrowserStateSyncDisposed(state)) {
      return null;
    }

    const finalized = finalizeBrowserStateSync(state);
    state = finalized.nextState;
    return finalized.nextNotify;
  }

  async function runBrowserStateSync(notify: boolean): Promise<void> {
    if (isBrowserStateSyncDisposed(state)) {
      return;
    }

    let nextNotify: boolean | null = notify;
    while (nextNotify !== null) {
      nextNotify = await runBrowserStateSyncAttempt(nextNotify, loadState);
    }
  }

  async function syncBrowserStateFromServer(notify = false): Promise<void> {
    const prepared = prepareImmediateBrowserStateSync(notify);
    switch (prepared.kind) {
      case 'skip':
        return;
      case 'wait':
        if (currentSyncPromise) {
          await currentSyncPromise;
        }
        return;
      case 'run':
        await runTrackedBrowserStateSync(() => runBrowserStateSync(prepared.notify));
        return;
      default:
        return assertNever(prepared.kind, 'Unhandled browser state sync preparation');
    }
  }

  async function syncBrowserStateFromReconnectSnapshot(
    snapshot: BrowserReconnectSnapshot,
    notify = false,
  ): Promise<void> {
    const prepared = prepareImmediateBrowserStateSync(notify);
    switch (prepared.kind) {
      case 'skip':
        return;
      case 'wait':
        if (currentSyncPromise) {
          await currentSyncPromise;
        }
        if (isBrowserStateSyncDisposed(state)) {
          return;
        }
        break;
      case 'run':
        break;
      default:
        return assertNever(prepared.kind, 'Unhandled browser state sync preparation');
    }

    await runTrackedBrowserStateSync(async () => {
      const nextNotify = await runBrowserStateSyncAttempt(prepared.notify, async () => {
        if (!snapshot.appStateJson) {
          return false;
        }

        return applyLoadedStateJson(snapshot.appStateJson);
      });

      if (nextNotify !== null) {
        await syncBrowserStateFromServer(nextNotify);
      }
    });
  }

  function scheduleBrowserStateSync(delayMs = 0, notify = false): void {
    if (electronRuntime) return;

    switch (state.kind) {
      case 'disposed':
        return;
      case 'syncing':
        state = {
          kind: 'syncing',
          notifyCurrentRun: state.notifyCurrentRun,
          pendingNotify: mergeSyncNotify(state.pendingNotify, notify),
        };
        recordBrowserSyncSuperseded();
        return;
      case 'scheduled':
        notify = mergeSyncNotify(state.notify, notify);
        clearTimeout(state.timer);
        recordBrowserSyncSuperseded();
        break;
      case 'idle':
        break;
      default:
        assertNever(state, 'Unhandled browser state sync status');
    }

    const timer = window.setTimeout(() => {
      if (state.kind !== 'scheduled' || state.timer !== timer) {
        return;
      }

      void syncBrowserStateFromServer(state.notify);
    }, delayMs);

    state = {
      kind: 'scheduled',
      notify,
      timer,
    };
    recordBrowserSyncScheduled();
  }

  function cleanupBrowserStateSyncTimer(): void {
    switch (state.kind) {
      case 'scheduled':
        clearTimeout(state.timer);
        break;
      case 'idle':
      case 'syncing':
      case 'disposed':
        break;
      default:
        assertNever(state, 'Unhandled browser state sync status');
    }

    state = { kind: 'disposed' };
  }

  return {
    cleanupBrowserStateSyncTimer,
    scheduleBrowserStateSync,
    syncBrowserStateFromReconnectSnapshot,
    syncBrowserStateFromServer,
  };
}
