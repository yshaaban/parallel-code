import type { Accessor, Setter } from 'solid-js';

import type {
  AgentLifecycleEvent,
  GitStatusSyncEvent,
  PeerPresenceSnapshot,
  RemotePresence,
  RemoteAgentStatus,
  TaskCommandControllerSnapshot,
  TaskPortsEvent,
} from '../domain/server-state';
import type { AnyServerStateBootstrapSnapshot } from '../domain/server-state-bootstrap';
import type { BrowserReconnectSnapshot } from '../domain/renderer-invoke';
import type {
  TaskCommandTakeoverRequestMessage,
  TaskCommandTakeoverResultMessage,
} from '../../electron/remote/protocol';
import type { ConnectionBanner } from '../runtime/browser-session';

export type CleanupFn = () => void;

export interface StartDesktopAppSessionOptions {
  electronRuntime: boolean;
  mainElement: HTMLDivElement;
  setConnectionBanner: Setter<ConnectionBanner | null>;
  setPathInputDialog: (next: { open: boolean; directory: boolean }) => void;
  windowFocused?: Accessor<boolean>;
  setWindowFocused: (focused: boolean) => void;
  setWindowMaximized: (maximized: boolean) => void;
}

export interface DesktopSessionResources {
  cleanupBrowserRuntime: () => void;
  cleanupShortcuts: () => void;
  offPlanContent: () => void;
  unlistenCloseRequested: (() => void) | null;
}

export interface BrowserStateSyncApi {
  scheduleBrowserStateSync: (delayMs?: number, notify?: boolean) => void;
  syncBrowserStateFromReconnectSnapshot: (
    snapshot: BrowserReconnectSnapshot,
    notify?: boolean,
  ) => Promise<void>;
}

export interface BrowserRuntimeCleanupOptions {
  getTaskCommandControllerUpdateCount: () => number;
  onAgentLifecycle: (message: AgentLifecycleEvent) => void;
  onGitStatusChanged: (message: GitStatusSyncEvent) => void;
  onPeerPresence: (message: PeerPresenceSnapshot[]) => void;
  onRemoteStatus: (message: RemotePresence) => void;
  onServerStateBootstrap: (message: AnyServerStateBootstrapSnapshot[]) => void;
  onTaskCommandControllerChanged: (message: TaskCommandControllerSnapshot) => void;
  onTaskNotificationRestoreCompleted?: () => void;
  onTaskNotificationRestoreStarted?: () => void;
  onTaskCommandTakeoverRequest: (message: TaskCommandTakeoverRequestMessage) => void;
  onTaskCommandTakeoverResult: (message: TaskCommandTakeoverResultMessage) => void;
  onTaskPortsChanged: (event: TaskPortsEvent) => void;
  replaceTaskCommandControllers: (
    snapshots: ReadonlyArray<TaskCommandControllerSnapshot>,
    options?: {
      replaceVersion?: number;
    },
  ) => void;
  reconcileRunningAgentIds: (agentIds: string[]) => void;
  scheduleBrowserStateSync: (delayMs?: number, notify?: boolean) => void;
  setConnectionBanner: Setter<ConnectionBanner | null>;
  showNotification: (message: string) => void;
  syncAgentStatusesFromServer: (
    message: Array<{ agentId: string; status: RemoteAgentStatus }>,
  ) => void;
  syncBrowserStateFromReconnectSnapshot: BrowserStateSyncApi['syncBrowserStateFromReconnectSnapshot'];
}

export interface DesktopSessionRuntime {
  captureWindowState: () => Promise<void>;
  cleanupWindowEventListeners: () => void;
  registerCloseRequestedHandler: () => Promise<() => void>;
  registerWindowEventListeners: () => void;
  restoreWindowState: () => Promise<void>;
  setupWindowChrome: () => Promise<void>;
  syncWindowFocused: () => Promise<void>;
  syncWindowMaximized: () => Promise<void>;
}
