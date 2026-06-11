import { IPC } from '../../electron/ipc/channels';
import { assertNever } from '../lib/assert-never';
import type { BrowserHttpIpcState } from '../lib/browser-http-ipc';
import type { BrowserControlConnectionState } from '../lib/browser-control-client';
import type { BrowserReconnectSnapshot, BrowserReconnectStatus } from '../domain/renderer-invoke';
import type { WorkspaceStateChangedNotification } from '../domain/renderer-events';
import type {
  AgentLifecycleEvent,
  PeerPresenceSnapshot,
  RemoteAgentStatus,
  TaskCommandControllerSnapshot,
} from '../domain/server-state';
import {
  type BrowserServerMessage,
  getBrowserQueueDepth,
  getBrowserReconnectContinuity,
  invoke,
  listenServerMessage,
  onBrowserAuthenticated,
  onBrowserHttpStateChange,
  onBrowserTransportEvent,
} from '../lib/ipc';
import { reEnsureDeferredAgentSessionsAfterReconnectRestore } from '../app/agent-session-ensure';
import {
  beginBrowserReconnectRestore,
  cancelBrowserReconnectRestore,
  completeBrowserReconnectRestore,
  isBrowserColdBootstrapPending,
} from '../app/browser-startup';
import { listenTaskCommandControllerChanged, listenWorkspaceStateChanged } from '../lib/ipc-events';
import { getStateSyncSourceId } from '../store/persistence';
import {
  recordBrowserReconnectDisconnect,
  recordBrowserReconnectDisconnectedDuration,
  recordBrowserReconnectFullRestoreDeferred,
  recordBrowserReconnectPong,
  recordBrowserReconnectRestoreOutcome,
  recordBrowserReconnectScheduled,
  recordBrowserReconnectSequenceGap,
} from '../app/runtime-diagnostics';
import { hydrateBrowserReconnectAgentGenerations } from './browser-state-sync-controller';

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

const BROWSER_RESTORE_FAILURE_MESSAGE = 'Failed to restore browser state after reconnect';

type BrowserLifecycleEffect =
  | { kind: 'notify'; message: string }
  | { kind: 'start-restore'; message: string };
type BrowserRecoveryState =
  | { kind: 'idle' }
  | { kind: 'waiting-for-reconnect'; attempt: number }
  | { kind: 'awaiting-authentication'; attempt: number }
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
  getLoadedWorkspaceRevision: () => number;
  getTaskCommandControllerUpdateCount: () => number;
  getTaskCommandControllerVersion: () => number;
  onAgentLifecycle: (message: AgentLifecycleEvent) => void;
  onPeerPresence: (peers: PeerPresenceSnapshot[]) => void;
  onTaskCommandTakeoverRequest: (
    message: Extract<BrowserServerMessage, { type: 'task-command-takeover-request' }>,
  ) => void;
  onTaskCommandTakeoverResult: (
    message: Extract<BrowserServerMessage, { type: 'task-command-takeover-result' }>,
  ) => void;
  onTaskNotificationRestoreCompleted?: () => void;
  onTaskNotificationRestoreStarted?: () => void;
  reconcileRunningAgentIds: (
    runningAgentIds: string[],
    notifyIfChanged?: boolean,
  ) => Promise<void> | void;
  replaceTaskCommandControllers: (
    controllers: TaskCommandControllerSnapshot[],
    options?: {
      replaceVersion?: number;
    },
  ) => void;
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

function getReconnectTaskCommandControllerReplaceOptions(snapshot: BrowserReconnectSnapshot): {
  replaceVersion?: number;
} {
  if (snapshot.taskCommandControllerVersion === undefined) {
    return {};
  }

  return {
    replaceVersion: snapshot.taskCommandControllerVersion,
  };
}

function isReconnectWorkspaceRevisionCurrent(
  status: Pick<BrowserReconnectStatus, 'workspaceRevision'>,
  currentRevision: number,
): boolean {
  return status.workspaceRevision === undefined || status.workspaceRevision === currentRevision;
}

function isReconnectWorkspaceRevisionStale(
  status: Pick<BrowserReconnectStatus, 'workspaceRevision'>,
  currentRevision: number,
): boolean {
  return status.workspaceRevision !== undefined && status.workspaceRevision < currentRevision;
}

function isReconnectTaskCommandVersionCurrent(
  status: Pick<BrowserReconnectStatus, 'taskCommandControllerVersion'>,
  currentVersion: number,
): boolean {
  return (
    status.taskCommandControllerVersion === undefined ||
    status.taskCommandControllerVersion === currentVersion
  );
}

function hasReconnectAgentGenerations<
  T extends Partial<Pick<BrowserReconnectStatus, 'agentGenerations'>>,
>(status: T): status is T & { agentGenerations: Record<string, number> } {
  return status.agentGenerations !== undefined;
}

function canSkipFullReconnectRestore(
  status: BrowserReconnectStatus,
  currentWorkspaceRevision: number,
  currentTaskCommandControllerVersion: number,
): boolean {
  return (
    hasReconnectAgentGenerations(status) &&
    isReconnectWorkspaceRevisionCurrent(status, currentWorkspaceRevision) &&
    isReconnectTaskCommandVersionCurrent(status, currentTaskCommandControllerVersion)
  );
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
    if (
      state.recovery.kind === 'waiting-for-reconnect' ||
      state.recovery.kind === 'awaiting-authentication'
    ) {
      return { state: 'reconnecting', attempt: state.recovery.attempt };
    }

    return { state: 'reconnecting', attempt: 1 };
  }

  if (
    state.controlPlaneState === 'connected' &&
    state.recovery.kind === 'awaiting-authentication'
  ) {
    return { state: 'reconnecting', attempt: state.recovery.attempt };
  }

  if (state.controlPlaneState === 'disconnected' || state.commandPlaneState === 'unreachable') {
    return { state: 'disconnected' };
  }

  switch (state.recovery.kind) {
    case 'restoring':
      return { state: 'restoring' };
    case 'idle':
    case 'awaiting-authentication':
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
        return createBrowserLifecycleTransition({
          ...state,
          controlPlaneState,
          recovery: {
            kind: 'awaiting-authentication',
            attempt: state.recovery.attempt,
          },
        });
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
  switch (commandPlaneState) {
    case 'auth-expired':
      return {
        ...state,
        commandPlaneState,
        recovery: { kind: 'idle' },
      };
    case 'available':
    case 'unreachable':
      return {
        ...state,
        commandPlaneState,
      };
    default:
      return assertNever(commandPlaneState, 'Unhandled browser HTTP IPC state');
  }
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

export function beginBrowserRestoreAfterAuthentication(
  state: BrowserRuntimeLifecycleState,
): BrowserLifecycleTransition {
  if (state.recovery.kind !== 'awaiting-authentication') {
    return createBrowserLifecycleTransition(state);
  }

  return createBrowserLifecycleTransition(
    {
      ...state,
      recovery: { kind: 'restoring' },
    },
    [{ kind: 'start-restore', message: 'Reconnected to the server' }],
  );
}

export function getConnectionBannerText(banner: ConnectionBanner): string {
  switch (banner.state) {
    case 'connecting':
      return 'Connecting...';
    case 'reconnecting':
      return `Reconnecting (attempt ${banner.attempt ?? 1})...`;
    case 'restoring':
      return 'Refreshing server state...';
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
  let reconnectFullRestoreRequired = false;
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

  const offPeerPresences = listenServerMessage('peer-presences', (message) => {
    options.onPeerPresence(message.list);
  });
  const offTaskCommandTakeoverRequest = listenServerMessage(
    'task-command-takeover-request',
    (message) => {
      options.onTaskCommandTakeoverRequest(message);
    },
  );
  const offTaskCommandTakeoverResult = listenServerMessage(
    'task-command-takeover-result',
    (message) => {
      options.onTaskCommandTakeoverResult(message);
    },
  );

  let lifecycleState = createInitialBrowserRuntimeLifecycleState();

  function updateConnectionBanner(): void {
    options.setConnectionBanner(deriveConnectionBanner(lifecycleState));
  }

  // Only a mid-stream sequence gap forces a full restore. replay-truncated is
  // no longer fatal: stale categories arrive through the version-gated
  // reconnect handshake, and the status-check mismatch path below stays the
  // recovery backstop.
  function hasReconnectReplayDiscontinuity(
    continuity: ReturnType<typeof getBrowserReconnectContinuity>,
  ): boolean {
    return continuity.hasSequenceGapSinceDisconnect;
  }

  function invalidateRestoreGeneration(
    reason: 'auth-expired' | 'cleanup' | 'transport-lost' = 'transport-lost',
  ): void {
    restoreGeneration += 1;
    restoreAwaitingAuthentication = false;
    cancelBrowserReconnectRestore(reason);
  }

  function applyLifecycleEffects(effects: readonly BrowserLifecycleEffect[]): void {
    for (const effect of effects) {
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
  }

  function startRestore(): void {
    if (isBrowserColdBootstrapPending()) {
      restoreAwaitingAuthentication = false;
      reconnectFullRestoreRequired = false;
      lifecycleState = completeBrowserRestore(lifecycleState);
      updateConnectionBanner();
      options.clearRestoringConnectionBanner();
      return;
    }

    restoreAwaitingAuthentication = false;
    const generation = ++restoreGeneration;
    const restoreStartedAt = Date.now();
    const initialTaskCommandControllerUpdateCount = options.getTaskCommandControllerUpdateCount();
    let restoreCompleted = false;
    let fullRestoreStarted = false;
    let restoreOutcome: 'full-restore' | 'short-disconnect-skip' | 'stale-snapshot-skip' | null =
      null;

    void (async () => {
      let shouldRunFullRestore = true;
      const continuity = getBrowserReconnectContinuity();
      if (hasReconnectReplayDiscontinuity(continuity)) {
        reconnectFullRestoreRequired = true;
      }

      recordBrowserReconnectDisconnectedDuration(continuity.disconnectedDurationMs);
      // Content-based skip: the cheap status check compares revisions and
      // generations whenever sequenced traffic confirmed the reconnect, with
      // no wall-clock gate — a long laptop sleep with no server-side changes
      // resolves without a full restore.
      if (continuity.hasSequencedMessageSinceDisconnect && !reconnectFullRestoreRequired) {
        try {
          const reconnectStatus = await invoke(IPC.GetBrowserReconnectStatus);
          if (generation !== restoreGeneration) {
            return;
          }
          const postStatusContinuity = getBrowserReconnectContinuity();
          if (hasReconnectReplayDiscontinuity(postStatusContinuity)) {
            reconnectFullRestoreRequired = true;
          }
          const canStillSkipFullRestore = !reconnectFullRestoreRequired;

          const currentWorkspaceRevision = options.getLoadedWorkspaceRevision();
          if (
            canStillSkipFullRestore &&
            hasReconnectAgentGenerations(reconnectStatus) &&
            isReconnectWorkspaceRevisionStale(reconnectStatus, currentWorkspaceRevision) &&
            isReconnectTaskCommandVersionCurrent(
              reconnectStatus,
              options.getTaskCommandControllerVersion(),
            )
          ) {
            hydrateBrowserReconnectAgentGenerations(reconnectStatus.agentGenerations);
            await options.reconcileRunningAgentIds(reconnectStatus.runningAgentIds, true);
            if (generation !== restoreGeneration) {
              return;
            }
            restoreCompleted = true;
            restoreOutcome = 'stale-snapshot-skip';
            shouldRunFullRestore = false;
          }

          if (
            shouldRunFullRestore &&
            canStillSkipFullRestore &&
            canSkipFullReconnectRestore(
              reconnectStatus,
              currentWorkspaceRevision,
              options.getTaskCommandControllerVersion(),
            )
          ) {
            hydrateBrowserReconnectAgentGenerations(reconnectStatus.agentGenerations);
            await options.reconcileRunningAgentIds(reconnectStatus.runningAgentIds, true);
            if (generation !== restoreGeneration) {
              return;
            }
            restoreCompleted = true;
            restoreOutcome = 'short-disconnect-skip';
            shouldRunFullRestore = false;
          }
        } catch (error) {
          if (generation !== restoreGeneration) {
            return;
          }
          console.warn('Failed to inspect reconnect continuity before full restore:', error);
        }
      }

      try {
        if (shouldRunFullRestore) {
          fullRestoreStarted = true;
          reconnectFullRestoreRequired = true;
          recordBrowserReconnectFullRestoreDeferred(Date.now() - restoreStartedAt);
          beginBrowserReconnectRestore();
          options.onTaskNotificationRestoreStarted?.();
          // The server omits the saved-state JSON payloads when the loaded
          // workspace revision is already current (revision-keyed reconnect).
          // Revision 0 means this tab loaded unversioned legacy state (no
          // workspace-state file), which mutates without revision bumps, so it
          // is never claimed as a known revision.
          const loadedWorkspaceRevision = options.getLoadedWorkspaceRevision();
          const reconnectSnapshot = await invoke(
            IPC.GetBrowserReconnectSnapshot,
            loadedWorkspaceRevision > 0
              ? { knownWorkspaceRevision: loadedWorkspaceRevision }
              : undefined,
          );
          if (generation !== restoreGeneration) {
            return;
          }
          await options.syncBrowserStateFromReconnectSnapshot(reconnectSnapshot);
          if (generation !== restoreGeneration) {
            return;
          }
          if (
            options.getTaskCommandControllerUpdateCount() ===
            initialTaskCommandControllerUpdateCount
          ) {
            options.replaceTaskCommandControllers(
              reconnectSnapshot.taskCommandControllers ?? [],
              getReconnectTaskCommandControllerReplaceOptions(reconnectSnapshot),
            );
          }
          if (generation !== restoreGeneration) {
            return;
          }
          await options.reconcileRunningAgentIds(reconnectSnapshot.runningAgentIds, true);
          if (generation !== restoreGeneration) {
            return;
          }
          // A full restore can follow backend session loss (server restart),
          // so deferred cold-hidden terminals must re-issue their backend
          // session ensure instead of trusting the pre-disconnect dedupe.
          reEnsureDeferredAgentSessionsAfterReconnectRestore();
          restoreCompleted = true;
          restoreOutcome = 'full-restore';
          reconnectFullRestoreRequired = false;
        }
      } catch (error) {
        if (!fullRestoreStarted) {
          recordBrowserReconnectRestoreOutcome(
            'status-check-failed',
            Date.now() - restoreStartedAt,
          );
          console.warn('Failed to inspect reconnect continuity before full restore:', error);
          return;
        }

        console.warn('Failed to restore browser state after reconnect:', error);
        if (generation === restoreGeneration) {
          options.showNotification(BROWSER_RESTORE_FAILURE_MESSAGE);
          options.scheduleBrowserStateSync(0, false);
        }
      } finally {
        if (generation === restoreGeneration) {
          lifecycleState = completeBrowserRestore(lifecycleState);
          if (restoreOutcome) {
            recordBrowserReconnectRestoreOutcome(restoreOutcome, Date.now() - restoreStartedAt);
          }
          if (restoreCompleted && fullRestoreStarted) {
            completeBrowserReconnectRestore();
          } else if (fullRestoreStarted) {
            cancelBrowserReconnectRestore('restore-failed');
          }
          updateConnectionBanner();
          options.clearRestoringConnectionBanner();
          if (restoreCompleted && fullRestoreStarted) {
            options.onTaskNotificationRestoreCompleted?.();
          }
        }
      }
    })();
  }

  const offBrowserTransport = onBrowserTransportEvent((event) => {
    if (event.kind === 'error') {
      options.showNotification(event.message);
      return;
    }

    if (event.kind === 'metrics') {
      switch (event.payload.type) {
        case 'disconnect':
          recordBrowserReconnectDisconnect(event.payload.reason);
          return;
        case 'pong':
          recordBrowserReconnectPong(event.payload.rttMs);
          return;
        case 'reconnect-scheduled':
          recordBrowserReconnectScheduled(event.payload.delayMs);
          return;
        case 'sequence-gap':
          reconnectFullRestoreRequired = true;
          recordBrowserReconnectSequenceGap();
          return;
        default:
          assertNever(event.payload, 'Unhandled browser transport metric event');
      }
    }

    if (event.state !== 'connected') {
      invalidateRestoreGeneration(
        event.state === 'auth-expired' ? 'auth-expired' : 'transport-lost',
      );
    }

    const transition = applyBrowserControlConnectionState(lifecycleState, event.state);
    lifecycleState = transition.nextState;
    if (lifecycleState.recovery.kind === 'awaiting-authentication') {
      restoreAwaitingAuthentication = true;
    }
    updateConnectionBanner();
    applyLifecycleEffects(transition.effects);
  });

  const offBrowserAuthenticated = onBrowserAuthenticated(() => {
    if (!restoreAwaitingAuthentication) {
      return;
    }

    const transition = beginBrowserRestoreAfterAuthentication(lifecycleState);
    lifecycleState = transition.nextState;
    applyLifecycleEffects(transition.effects);

    startRestore();
    updateConnectionBanner();
  });

  const offBrowserHttpState = onBrowserHttpStateChange((state) => {
    if (state === 'auth-expired') {
      invalidateRestoreGeneration('auth-expired');
    }
    lifecycleState = applyBrowserHttpPlaneState(lifecycleState, state);
    updateConnectionBanner();
  });

  return () => {
    invalidateRestoreGeneration('cleanup');
    offWorkspaceStateChanged();
    offTaskCommandControllerChanged();
    offAgents();
    offAgentLifecycle();
    offPeerPresences();
    offTaskCommandTakeoverRequest();
    offTaskCommandTakeoverResult();
    offBrowserTransport();
    offBrowserAuthenticated();
    offBrowserHttpState();
  };
}
