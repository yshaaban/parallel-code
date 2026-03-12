import { IPC } from '../../electron/ipc/channels';
import {
  getBrowserQueueDepth,
  listen,
  listenServerMessage,
  onBrowserTransportEvent,
} from '../lib/ipc';
import { getStateSyncSourceId } from '../store/persistence';

export type ConnectionBannerState =
  | 'connecting'
  | 'reconnecting'
  | 'disconnected'
  | 'connected'
  | 'restoring'
  | 'auth-expired';

export interface ConnectionBanner {
  attempt?: number;
  state: ConnectionBannerState;
}

interface BrowserRuntimeOptions {
  clearRestoringConnectionBanner: () => void;
  onAgentLifecycle: (message: {
    agentId: string;
    event: 'spawn' | 'exit' | 'pause' | 'resume';
    exitCode?: number | null;
    signal?: string | null;
    status?: 'running' | 'paused' | 'flow-controlled' | 'restoring' | 'exited';
  }) => void;
  onGitStatusChanged: (message: {
    branchName?: string;
    projectRoot?: string;
    status?: {
      has_committed_changes: boolean;
      has_uncommitted_changes: boolean;
    };
    worktreePath?: string;
  }) => void;
  onRemoteStatus: (connectedClients: number, peerClients: number) => void;
  reconcileRunningAgents: (notifyIfChanged?: boolean) => Promise<void>;
  refreshRemoteStatus: () => Promise<void>;
  scheduleBrowserStateSync: (delayMs?: number, notify?: boolean) => void;
  setConnectionBanner: (banner: ConnectionBanner | null) => void;
  showNotification: (message: string) => void;
  syncAgentStatusesFromServer: (
    agents: Array<{
      agentId: string;
      status: 'running' | 'paused' | 'flow-controlled' | 'restoring' | 'exited';
    }>,
  ) => void;
  syncBrowserStateFromServer: () => Promise<void>;
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
      return 'Session expired — reload page to reconnect';
    case 'connected':
      return '';
  }
}

export function registerBrowserAppRuntime(options: BrowserRuntimeOptions): () => void {
  const offSaveAppState = listen(IPC.SaveAppState, (data: unknown) => {
    const message = data as { sourceId?: string | null };
    if (message.sourceId === getStateSyncSourceId()) return;
    options.scheduleBrowserStateSync(0, true);
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

  const offRemoteStatus = listenServerMessage('remote-status', (message) => {
    options.onRemoteStatus(message.connectedClients, message.peerClients);
  });

  let sawDisconnect = false;
  let reconnectAttempt = 0;
  const offBrowserTransport = onBrowserTransportEvent((event) => {
    if (event.kind === 'error') {
      options.showNotification(event.message);
      return;
    }

    switch (event.state) {
      case 'connected':
        options.setConnectionBanner(null);
        reconnectAttempt = 0;
        break;
      case 'connecting':
        options.setConnectionBanner({ state: 'connecting' });
        break;
      case 'reconnecting':
        reconnectAttempt += 1;
        options.setConnectionBanner({ state: 'reconnecting', attempt: reconnectAttempt });
        break;
      case 'disconnected':
        options.setConnectionBanner({ state: 'disconnected' });
        break;
      case 'auth-expired':
        options.setConnectionBanner({ state: 'auth-expired' });
        break;
    }

    if (event.state === 'disconnected') {
      sawDisconnect = true;
      options.showNotification('Lost connection to the server. Reconnecting...');
      return;
    }

    if (event.state === 'connected' && sawDisconnect) {
      sawDisconnect = false;
      options.showNotification('Reconnected to the server');
      options.setConnectionBanner({ state: 'restoring' });
      void (async () => {
        try {
          await options.syncBrowserStateFromServer();
          await options.refreshRemoteStatus().catch(() => {});
          await options.reconcileRunningAgents(true);
        } finally {
          options.clearRestoringConnectionBanner();
        }
      })();
    }
  });

  return () => {
    offSaveAppState();
    offAgents();
    offAgentLifecycle();
    offGitStatusChanged();
    offRemoteStatus();
    offBrowserTransport();
  };
}
