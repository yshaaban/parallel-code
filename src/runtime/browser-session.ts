import { IPC } from '../../electron/ipc/channels';
import { assertNever } from '../lib/assert-never';
import type { BrowserHttpIpcState } from '../lib/browser-http-ipc';
import type { BrowserReconnectSnapshot } from '../domain/renderer-invoke';
import type { WorkspaceStateChangedNotification } from '../domain/renderer-events';
import type {
  AgentLifecycleEvent,
  GitStatusSyncEvent,
  RemoteAgentStatus,
  RemotePresence,
  TaskCommandControllerSnapshot,
  TaskPortsEvent,
} from '../domain/server-state';
import type { AnyServerStateBootstrapSnapshot } from '../domain/server-state-bootstrap';
import {
  getBrowserQueueDepth,
  invoke,
  onBrowserAuthenticated,
  listenServerMessage,
  onBrowserHttpStateChange,
  onBrowserTransportEvent,
  type BrowserTransportEvent,
} from '../lib/ipc';
import { listenTaskCommandControllerChanged, listenWorkspaceStateChanged } from '../lib/ipc-events';
import { getStateSyncSourceId } from '../store/persistence';

export type ConnectionBannerState =
  | 'connecting'
  | 'reconnecting'
  | 'disconnected'
  | 'restoring'
  | 'auth-expired';

export interface ConnectionBanner {
  attempt?: number;
  state: ConnectionBannerState;
}

type BrowserControlConnectionState = Extract<
  BrowserTransportEvent,
  { kind: 'connection' }
>['state'];
type BrowserLifecycleEffect =
  | { kind: 'notify'; message: string }
  | { kind: 'start-restore'; message: string };
type BrowserRecoveryState =
  | { kind: 'idle' }
  | { kind: 'waiting-for-reconnect'; attempt: number }
  | { kind: 'restoring' };

export interface BrowserRuntimeLifecycleState {
  commandPlaneState: BrowserHttpIpcState;
  controlPlaneState: BrowserControlConnectionState | null;
  recovery: BrowserRecoveryState;
}

interface BrowserLifecycleTransition {
  effects: BrowserLifecycleEffect[];
  nextState: BrowserRuntimeLifecycleState;
}

interface BrowserRuntimeOptions {
  clearRestoringConnectionBanner: () => void;
  getTaskCommandControllerUpdateCount: () => number;
  onAgentLifecycle: (message: AgentLifecycleEvent) => void;
  onGitStatusChanged: (message: GitStatusSyncEvent) => void;
  onServerStateBootstrap: (snapshots: AnyServerStateBootstrapSnapshot[]) => void;
  onTaskPortsChanged: (event: TaskPortsEvent) => void;
  onRemoteStatus: (status: RemotePresence) => void;
  reconcileRunningAgentIds: (
    runningAgentIds: string[],
    notifyIfChanged?: boolean,
  ) => Promise<void> | void;
  replaceTaskCommandControllers: (controllers: TaskCommandControllerSnapshot[]) => void;
  scheduleBrowserStateSync: (delayMs?: number, notify?: boolean) => void;
  setConnectionBanner: (banner: ConnectionBanner | null) => void;
  showNotification: (message: string) => void;
  syncAgentStatusesFromServer: (
    agents: Array<{
      agentId: string;
      status: RemoteAgentStatus;
    }>,
  ) => void;
  onTaskCommandControllerChanged: (message: TaskCommandControllerSnapshot) => void;
  syncBrowserStateFromReconnectSnapshot: (snapshot: BrowserReconnectSnapshot) => Promise<void>;
}

export function createInitialBrowserRuntimeLifecycleState(): BrowserRuntimeLifecycleState {
  return {
    commandPlaneState: 'available',
    controlPlaneState: null,
    recovery: { kind: 'idle' },
  };
}

function createBrowserLifecycleTransition(
  nextState: BrowserRuntimeLifecycleState,
  effects: BrowserLifecycleEffect[] = [],
): BrowserLifecycleTransition {
  return {
    effects,
    nextState,
  };
}

export function deriveConnectionBanner(
  state: BrowserRuntimeLifecycleState,
): ConnectionBanner | null {
  if (state.controlPlaneState === 'auth-expired' || state.commandPlaneState === 'auth-expired') {
    return { state: 'auth-expired' };
  }

  if (state.controlPlaneState === 'connecting') {
    return { state: 'connecting' };
  }

  if (state.controlPlaneState === 'reconnecting') {
    if (state.recovery.kind === 'waiting-for-reconnect') {
      return { state: 'reconnecting', attempt: state.recovery.attempt };
    }

    return { state: 'reconnecting', attempt: 1 };
  }

  if (state.controlPlaneState === 'disconnected' || state.commandPlaneState === 'unreachable') {
    return { state: 'disconnected' };
  }

  switch (state.recovery.kind) {
    case 'restoring':
      return { state: 'restoring' };
    case 'idle':
    case 'waiting-for-reconnect':
      return null;
    default:
      return assertNever(state.recovery, 'Unhandled browser recovery state');
  }
}

export function applyBrowserControlConnectionState(
  state: BrowserRuntimeLifecycleState,
  controlPlaneState: BrowserControlConnectionState,
): BrowserLifecycleTransition {
  switch (controlPlaneState) {
    case 'connecting':
      return createBrowserLifecycleTransition({
        ...state,
        controlPlaneState,
      });
    case 'reconnecting': {
      const attempt =
        state.recovery.kind === 'waiting-for-reconnect' ? state.recovery.attempt + 1 : 1;

      return createBrowserLifecycleTransition({
        ...state,
        controlPlaneState,
        recovery: {
          kind: 'waiting-for-reconnect',
          attempt,
        },
      });
    }
    case 'connected':
      if (state.recovery.kind === 'waiting-for-reconnect') {
        return createBrowserLifecycleTransition(
          {
            ...state,
            controlPlaneState,
            recovery: { kind: 'restoring' },
          },
          [{ kind: 'start-restore', message: 'Reconnected to the server' }],
        );
      }

      return createBrowserLifecycleTransition({
        ...state,
        controlPlaneState,
      });
    case 'disconnected':
      if (state.recovery.kind === 'waiting-for-reconnect') {
        return createBrowserLifecycleTransition({
          ...state,
          controlPlaneState,
        });
      }

      return createBrowserLifecycleTransition(
        {
          ...state,
          controlPlaneState,
          recovery: { kind: 'waiting-for-reconnect', attempt: 0 },
        },
        [{ kind: 'notify', message: 'Lost connection to the server. Reconnecting...' }],
      );
    case 'auth-expired':
      return createBrowserLifecycleTransition({
        ...state,
        controlPlaneState,
        recovery: { kind: 'idle' },
      });
    default:
      return assertNever(controlPlaneState, 'Unhandled browser control-plane state');
  }
}

export function applyBrowserHttpPlaneState(
  state: BrowserRuntimeLifecycleState,
  commandPlaneState: BrowserHttpIpcState,
): BrowserRuntimeLifecycleState {
  if (commandPlaneState === 'auth-expired') {
    return {
      ...state,
      commandPlaneState,
      recovery: { kind: 'idle' },
    };
  }

  return {
    ...state,
    commandPlaneState,
  };
}

export function completeBrowserRestore(
  state: BrowserRuntimeLifecycleState,
): BrowserRuntimeLifecycleState {
  if (state.recovery.kind !== 'restoring') {
    return state;
  }

  return {
    ...state,
    recovery: { kind: 'idle' },
  };
}

export function getConnectionBannerText(banner: ConnectionBanner): string {
  switch (banner.state) {
    case 'connecting':
      return 'Connecting...';
    case 'reconnecting':
      return `Reconnecting (attempt ${banner.attempt ?? 1})...`;
    case 'restoring':
      return 'Restoring state and terminal scrollback...';
    case 'disconnected': {
      const queuedCount = getBrowserQueueDepth();
      return `Disconnected — ${queuedCount} request${queuedCount === 1 ? '' : 's'} queued`;
    }
    case 'auth-expired':
      return 'Session expired — sign in again to reconnect';
    default:
      return assertNever(banner.state, 'Unhandled connection banner state');
  }
}

export function registerBrowserAppRuntime(options: BrowserRuntimeOptions): () => void {
  let restoreGeneration = 0;
  let restoreAwaitingAuthentication = false;
  const offWorkspaceStateChanged = listenWorkspaceStateChanged(
    (message: WorkspaceStateChangedNotification) => {
      if (message.sourceId === getStateSyncSourceId()) return;
      options.scheduleBrowserStateSync(0, true);
    },
  );
  const offTaskCommandControllerChanged = listenTaskCommandControllerChanged((message) => {
    options.onTaskCommandControllerChanged(message);
  });

  const offAgents = listenServerMessage('agents', (message) => {
    options.syncAgentStatusesFromServer(message.list);
  });

  const offAgentLifecycle = listenServerMessage('agent-lifecycle', (message) => {
    options.onAgentLifecycle(message);
  });

  const offGitStatusChanged = listenServerMessage('git-status-changed', (message) => {
    options.onGitStatusChanged(message);
  });

  const offTaskPortsChanged = listenServerMessage('task-ports-changed', (message) => {
    let event: TaskPortsEvent;
    if ('observed' in message && 'exposed' in message) {
      event = {
        taskId: message.taskId,
        observed: message.observed,
        exposed: message.exposed,
        updatedAt: message.updatedAt,
      };
    } else {
      event = { taskId: message.taskId, removed: true };
    }
    options.onTaskPortsChanged(event);
  });

  const offStateBootstrap = listenServerMessage('state-bootstrap', (message) => {
    options.onServerStateBootstrap(message.snapshots);
  });

  const offRemoteStatus = listenServerMessage('remote-status', (message) => {
    options.onRemoteStatus(message);
  });

  let lifecycleState = createInitialBrowserRuntimeLifecycleState();

  function updateConnectionBanner(): void {
    options.setConnectionBanner(deriveConnectionBanner(lifecycleState));
  }

  function invalidateRestoreGeneration(): void {
    restoreGeneration += 1;
    restoreAwaitingAuthentication = false;
  }

  function startRestore(): void {
    restoreAwaitingAuthentication = false;
    const generation = ++restoreGeneration;
    const initialTaskCommandControllerUpdateCount = options.getTaskCommandControllerUpdateCount();

    void (async () => {
      try {
        const reconnectSnapshot = await invoke(IPC.GetBrowserReconnectSnapshot);
        if (generation !== restoreGeneration) {
          return;
        }
        await options.syncBrowserStateFromReconnectSnapshot(reconnectSnapshot);
        if (generation !== restoreGeneration) {
          return;
        }
        if (
          options.getTaskCommandControllerUpdateCount() === initialTaskCommandControllerUpdateCount
        ) {
          options.replaceTaskCommandControllers(reconnectSnapshot.taskCommandControllers ?? []);
        }
        if (generation !== restoreGeneration) {
          return;
        }
        await options.reconcileRunningAgentIds(reconnectSnapshot.runningAgentIds, true);
      } finally {
        if (generation === restoreGeneration) {
          lifecycleState = completeBrowserRestore(lifecycleState);
          updateConnectionBanner();
          options.clearRestoringConnectionBanner();
        }
      }
    })();
  }

  const offBrowserTransport = onBrowserTransportEvent((event) => {
    if (event.kind === 'error') {
      options.showNotification(event.message);
      return;
    }

    if (event.state !== 'connected') {
      invalidateRestoreGeneration();
    }

    const transition = applyBrowserControlConnectionState(lifecycleState, event.state);
    lifecycleState = transition.nextState;
    updateConnectionBanner();

    for (const effect of transition.effects) {
      switch (effect.kind) {
        case 'notify':
          options.showNotification(effect.message);
          break;
        case 'start-restore':
          options.showNotification(effect.message);
          restoreAwaitingAuthentication = true;
          updateConnectionBanner();
          break;
        default:
          assertNever(effect, 'Unhandled browser lifecycle effect');
      }
    }
  });

  const offBrowserAuthenticated = onBrowserAuthenticated(() => {
    if (!restoreAwaitingAuthentication) {
      return;
    }

    startRestore();
    updateConnectionBanner();
  });

  const offBrowserHttpState = onBrowserHttpStateChange((state) => {
    if (state === 'auth-expired') {
      invalidateRestoreGeneration();
    }
    lifecycleState = applyBrowserHttpPlaneState(lifecycleState, state);
    updateConnectionBanner();
  });

  return () => {
    invalidateRestoreGeneration();
    offWorkspaceStateChanged();
    offTaskCommandControllerChanged();
    offAgents();
    offAgentLifecycle();
    offGitStatusChanged();
    offTaskPortsChanged();
    offStateBootstrap();
    offRemoteStatus();
    offBrowserTransport();
    offBrowserAuthenticated();
    offBrowserHttpState();
  };
}
