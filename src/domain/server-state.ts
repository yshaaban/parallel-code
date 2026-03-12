export interface WorktreeStatus {
  has_committed_changes: boolean;
  has_uncommitted_changes: boolean;
}

export interface GitStatusSyncEvent {
  branchName?: string;
  projectRoot?: string;
  status?: WorktreeStatus;
  worktreePath?: string;
}

export type PauseReason = 'manual' | 'flow-control' | 'restore';

export type RemoteAgentStatus = 'running' | 'paused' | 'flow-controlled' | 'restoring' | 'exited';

export interface AgentStatusSnapshot {
  exitCode: number | null;
  lastLine: string;
  status: RemoteAgentStatus;
}

export interface RemoteAgent {
  agentId: string;
  taskId: string;
  taskName: string;
  status: RemoteAgentStatus;
  exitCode: number | null;
  lastLine: string;
}

export interface AgentLifecycleEvent {
  event: 'spawn' | 'exit' | 'pause' | 'resume';
  agentId: string;
  taskId: string | null;
  isShell: boolean | null;
  status?: RemoteAgentStatus;
  exitCode?: number | null;
  signal?: string | null;
}

export interface RemotePresence {
  connectedClients: number;
  peerClients: number;
}

export interface DisabledRemoteAccessStatus extends RemotePresence {
  enabled: false;
  connectedClients: 0;
  peerClients: 0;
  port: number;
  tailscaleUrl: null;
  token: null;
  url: null;
  wifiUrl: null;
}

export interface EnabledRemoteAccessStatus extends RemotePresence {
  enabled: true;
  connectedClients: number;
  peerClients: number;
  port: number;
  tailscaleUrl: string | null;
  token: string;
  url: string;
  wifiUrl: string | null;
}

export type RemoteAccessStatus = DisabledRemoteAccessStatus | EnabledRemoteAccessStatus;

export function createDisabledRemoteAccessStatus(port: number): DisabledRemoteAccessStatus {
  return {
    enabled: false,
    connectedClients: 0,
    peerClients: 0,
    port,
    tailscaleUrl: null,
    token: null,
    url: null,
    wifiUrl: null,
  };
}

export function getRemoteAgentStatus(
  pauseReason: PauseReason | null | undefined,
  fallbackStatus: RemoteAgentStatus = 'running',
): RemoteAgentStatus {
  switch (pauseReason) {
    case 'manual':
      return 'paused';
    case 'flow-control':
      return 'flow-controlled';
    case 'restore':
      return 'restoring';
    default:
      return fallbackStatus;
  }
}

export function resolveRemoteLifecycleStatus(
  status: RemoteAgentStatus | undefined,
  fallback: 'running' | 'paused',
): Exclude<RemoteAgentStatus, 'exited'> {
  if (!status || status === 'exited') {
    return fallback;
  }

  return status;
}

export function isAutomaticPauseReason(reason: PauseReason | undefined): boolean {
  return reason === 'flow-control' || reason === 'restore';
}
