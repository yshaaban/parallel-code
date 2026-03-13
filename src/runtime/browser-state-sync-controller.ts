import { assertNever } from '../lib/assert-never';
import {
  recordBrowserSyncCompleted,
  recordBrowserSyncFailed,
  recordBrowserSyncScheduled,
  recordBrowserSyncStarted,
  recordBrowserSyncSuperseded,
} from '../app/runtime-diagnostics';
import { markAutosaveClean } from '../store/autosave';
import { loadState, showNotification, validateProjectPaths } from '../store/store';

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
  syncBrowserStateFromServer: (notify?: boolean) => Promise<void>;
} {
  let state: BrowserStateSyncStatus = { kind: 'idle' };
  let currentSyncPromise: Promise<void> | null = null;

  async function runBrowserStateSync(notify: boolean): Promise<void> {
    if (isBrowserStateSyncDisposed(state)) {
      return;
    }

    let nextNotify: boolean | null = notify;
    while (nextNotify !== null) {
      const currentNotify = nextNotify;
      nextNotify = null;
      const startedAt = Date.now();
      recordBrowserSyncStarted();
      state = {
        kind: 'syncing',
        notifyCurrentRun: currentNotify,
        pendingNotify: null,
      };

      try {
        await loadState();
        if (isBrowserStateSyncDisposed(state)) {
          return;
        }

        markAutosaveClean();
        await validateProjectPaths();
        if (isBrowserStateSyncDisposed(state)) {
          return;
        }

        if (state.kind === 'syncing' && state.notifyCurrentRun) {
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
        return;
      }

      const finalized = finalizeBrowserStateSync(state);
      state = finalized.nextState;
      nextNotify = finalized.nextNotify;
    }
  }

  async function syncBrowserStateFromServer(notify = false): Promise<void> {
    if (isBrowserStateSyncDisposed(state)) {
      return;
    }

    switch (state.kind) {
      case 'disposed':
        return;
      case 'scheduled':
        notify = mergeSyncNotify(state.notify, notify);
        clearTimeout(state.timer);
        state = { kind: 'idle' };
        break;
      case 'syncing':
        state = {
          kind: 'syncing',
          notifyCurrentRun: mergeSyncNotify(state.notifyCurrentRun, notify),
          pendingNotify: state.pendingNotify,
        };
        recordBrowserSyncSuperseded();
        await currentSyncPromise;
        return;
      case 'idle':
        break;
      default:
        assertNever(state, 'Unhandled browser state sync status');
    }

    const syncPromise = runBrowserStateSync(notify);
    currentSyncPromise = syncPromise;
    try {
      await syncPromise;
    } finally {
      if (currentSyncPromise === syncPromise) {
        currentSyncPromise = null;
      }
    }
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
    syncBrowserStateFromServer,
  };
}
