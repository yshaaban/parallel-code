import type { Accessor, Setter } from 'solid-js';

import type {
  AgentLifecycleEvent,
  PeerPresenceSnapshot,
  RemoteAgentStatus,
  TaskCommandControllerSnapshot,
} from '../domain/server-state';
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
  setPathInputDialog: (next: {
    open: boolean;
    directory: boolean;
    allowSshClone?: boolean;
  }) => void;
  windowFocused?: Accessor<boolean>;
  setWindowFocused: (focused: boolean) => void;
  setWindowMaximized: (maximized: boolean) => void;
}

export interface DesktopSessionResources {
  cleanupBrowserRuntime: () => void;
  cleanupShortcuts: () => void;
  cleanupStartupTimers: () => void;
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
  onPeerPresence: (message: PeerPresenceSnapshot[]) => void;
  onTaskCommandControllerChanged: (message: TaskCommandControllerSnapshot) => void;
  onTaskNotificationRestoreCompleted?: () => void;
  onTaskNotificationRestoreStarted?: () => void;
  onTaskCommandTakeoverRequest: (message: TaskCommandTakeoverRequestMessage) => void;
  onTaskCommandTakeoverResult: (message: TaskCommandTakeoverResultMessage) => void;
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
