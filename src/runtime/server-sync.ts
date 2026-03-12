import { IPC } from '../../electron/ipc/channels';
import { assertNever } from '../lib/assert-never';
import {
  resolveRemoteLifecycleStatus,
  type AgentLifecycleEvent,
  type GitStatusSyncEvent,
  type RemoteAgentStatus,
} from '../domain/server-state';
import { handleGitStatusSyncEvent } from '../app/git-status-sync';
import { invoke } from '../lib/ipc';
import { markAutosaveClean } from '../store/autosave';
import {
  loadState,
  markAgentExited,
  markAgentRunning,
  setAgentStatus,
  showNotification,
  store,
  validateProjectPaths,
} from '../store/store';

export type RuntimeAgentStatus = RemoteAgentStatus;

export interface AgentStatusMessage {
  agentId: string;
  status: RuntimeAgentStatus;
}

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

function getMissingAgentSessionsMessage(missingCount: number): string {
  if (missingCount === 1) {
    return '1 agent session ended while the server was unavailable';
  }
  return `${missingCount} agent sessions ended while the server was unavailable`;
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
      } catch (error) {
        console.warn('Failed to sync browser state from server:', error);
        if (!isBrowserStateSyncDisposed(state)) {
          showNotification(BROWSER_SYNC_FAILURE_MESSAGE);
        }
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
        return;
      case 'scheduled':
        notify = mergeSyncNotify(state.notify, notify);
        clearTimeout(state.timer);
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

export function handleAgentLifecycleMessage(message: AgentLifecycleEvent): void {
  switch (message.event) {
    case 'exit':
      markAgentExited(message.agentId, {
        exit_code: message.exitCode ?? null,
        signal: message.signal ?? null,
        last_output: [],
      });
      return;
    case 'pause':
      setAgentStatus(message.agentId, resolveRemoteLifecycleStatus(message.status, 'paused'));
      return;
    case 'spawn':
    case 'resume':
      setAgentStatus(message.agentId, resolveRemoteLifecycleStatus(message.status, 'running'));
      return;
    default:
      return assertNever(message.event, 'Unhandled agent lifecycle event');
  }
}

export async function reconcileRunningAgents(notifyIfChanged = false): Promise<void> {
  const activeAgentIds = await invoke(IPC.ListRunningAgentIds).catch(() => null);
  if (!activeAgentIds) return;

  const activeSet = new Set(activeAgentIds);
  let missingCount = 0;
  for (const agent of Object.values(store.agents)) {
    if (activeSet.has(agent.id)) {
      if (agent.status === 'exited') {
        markAgentRunning(agent.id);
      }
      continue;
    }

    if (agent.status !== 'exited') {
      missingCount += 1;
      markAgentExited(agent.id, {
        exit_code: null,
        signal: 'server_unavailable',
        last_output: [],
      });
    }
  }

  if (notifyIfChanged && missingCount > 0) {
    showNotification(getMissingAgentSessionsMessage(missingCount));
  }
}

export function syncAgentStatusesFromServer(agents: AgentStatusMessage[]): void {
  for (const agent of agents) {
    if (!store.agents[agent.agentId] || agent.status === 'exited') continue;
    setAgentStatus(agent.agentId, agent.status);
  }
}

export function handleGitStatusChanged(message: GitStatusSyncEvent): void {
  handleGitStatusSyncEvent(message);
}
