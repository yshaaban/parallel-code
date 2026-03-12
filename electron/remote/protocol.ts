/** Agent summary sent in the agents list. */
export type RemoteAgentStatus = 'running' | 'paused' | 'flow-controlled' | 'restoring' | 'exited';

export interface RemoteAgent {
  agentId: string;
  taskId: string;
  taskName: string;
  status: RemoteAgentStatus;
  exitCode: number | null;
  lastLine: string;
}

// --- Server -> Client messages ---

export interface OutputMessage {
  type: 'output';
  agentId: string;
  data: string; // base64
}

export interface StatusMessage {
  type: 'status';
  agentId: string;
  status: RemoteAgentStatus;
  exitCode: number | null;
  seq?: number;
}

export interface AgentsMessage {
  type: 'agents';
  list: RemoteAgent[];
}

export interface ScrollbackMessage {
  type: 'scrollback';
  agentId: string;
  data: string; // base64
  cols: number;
}

export interface PongMessage {
  type: 'pong';
}

export interface ChannelMessage {
  type: 'channel';
  channelId: string;
  payload: unknown;
}

export interface IpcEventMessage {
  type: 'ipc-event';
  channel: string;
  payload: unknown;
  seq?: number;
}

export interface ChannelBoundMessage {
  type: 'channel-bound';
  channelId: string;
}

export interface AgentLifecycleMessage {
  type: 'agent-lifecycle';
  event: 'spawn' | 'exit' | 'pause' | 'resume';
  agentId: string;
  taskId: string | null;
  isShell: boolean | null;
  status?: RemoteAgentStatus;
  exitCode?: number | null;
  signal?: string | null;
  seq?: number;
}

export interface AgentControllerMessage {
  type: 'agent-controller';
  agentId: string;
  controllerId: string | null;
  seq?: number;
}

export interface RemoteStatusMessage {
  type: 'remote-status';
  connectedClients: number;
  peerClients: number;
  seq?: number;
}

export interface TaskEventMessage {
  type: 'task-event';
  event: 'created' | 'deleted';
  taskId: string;
  name?: string;
  branchName?: string;
  worktreePath?: string;
  seq?: number;
}

export interface GitStatusChangedMessage {
  type: 'git-status-changed';
  worktreePath?: string;
  projectRoot?: string;
  branchName?: string;
  status?: {
    has_committed_changes: boolean;
    has_uncommitted_changes: boolean;
  };
  seq?: number;
}

export interface PermissionRequestMessage {
  type: 'permission-request';
  agentId: string;
  requestId: string;
  tool: string;
  description: string;
  arguments: string;
}

export interface AgentErrorMessage {
  type: 'agent-error';
  agentId: string;
  message: string;
}

export type ServerMessage =
  | OutputMessage
  | StatusMessage
  | AgentsMessage
  | ScrollbackMessage
  | PongMessage
  | ChannelMessage
  | IpcEventMessage
  | ChannelBoundMessage
  | AgentLifecycleMessage
  | AgentControllerMessage
  | RemoteStatusMessage
  | TaskEventMessage
  | GitStatusChangedMessage
  | PermissionRequestMessage
  | AgentErrorMessage;

// --- Client -> Server messages ---

export interface InputCommand {
  type: 'input';
  agentId: string;
  data: string;
}

export interface ResizeCommand {
  type: 'resize';
  agentId: string;
  cols: number;
  rows: number;
}

export interface KillCommand {
  type: 'kill';
  agentId: string;
}

export type PauseReason = 'manual' | 'flow-control' | 'restore';

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

export function isAutomaticPauseReason(reason: PauseReason | undefined): boolean {
  return reason === 'flow-control' || reason === 'restore';
}

export interface PauseCommand {
  type: 'pause';
  agentId: string;
  reason?: PauseReason;
  channelId?: string;
}

export interface ResumeCommand {
  type: 'resume';
  agentId: string;
  reason?: PauseReason;
  channelId?: string;
}

export interface SubscribeCommand {
  type: 'subscribe';
  agentId: string;
}

export interface UnsubscribeCommand {
  type: 'unsubscribe';
  agentId: string;
}

export interface BindChannelCommand {
  type: 'bind-channel';
  channelId: string;
}

export interface UnbindChannelCommand {
  type: 'unbind-channel';
  channelId: string;
}

export interface AuthCommand {
  type: 'auth';
  token: string;
  lastSeq?: number;
  clientId?: string;
}

export interface PingCommand {
  type: 'ping';
}

export interface PermissionResponseCommand {
  type: 'permission-response';
  agentId: string;
  requestId: string;
  action: 'approve' | 'deny';
}

export type ClientMessage =
  | AuthCommand
  | PingCommand
  | InputCommand
  | ResizeCommand
  | KillCommand
  | PauseCommand
  | ResumeCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | BindChannelCommand
  | UnbindChannelCommand
  | PermissionResponseCommand;

/** Validation helper: check string with max length. */
function isStringWithMaxLength(val: unknown, maxLen: number): val is string {
  return typeof val === 'string' && val.length <= maxLen;
}

/** Validation helper: check valid pause/resume reason. */
function isValidReason(val: unknown): val is PauseReason | undefined {
  return val === undefined || val === 'manual' || val === 'flow-control' || val === 'restore';
}

/** Minimal validation for incoming client messages. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (!isStringWithMaxLength(msg.type, 50)) return null;
    if (!isValidReason(msg.reason)) return null;

    // Auth message doesn't require agentId
    if (msg.type === 'auth') {
      if (!isStringWithMaxLength(msg.token, 200)) return null;
      if (
        msg.lastSeq !== undefined &&
        (typeof msg.lastSeq !== 'number' || !Number.isInteger(msg.lastSeq) || msg.lastSeq < -1)
      ) {
        return null;
      }
      if (msg.clientId !== undefined && !isStringWithMaxLength(msg.clientId, 100)) {
        return null;
      }
      return {
        type: 'auth',
        token: msg.token,
        ...(msg.lastSeq !== undefined ? { lastSeq: msg.lastSeq as number } : {}),
        ...(msg.clientId !== undefined ? { clientId: msg.clientId as string } : {}),
      };
    }

    if (msg.type === 'ping') {
      return { type: 'ping' };
    }

    switch (msg.type) {
      case 'input':
        if (!isStringWithMaxLength(msg.agentId, 100) || !isStringWithMaxLength(msg.data, 4096))
          return null;
        return { type: 'input', agentId: msg.agentId, data: msg.data };

      case 'resize':
        if (!isStringWithMaxLength(msg.agentId, 100)) return null;
        if (typeof msg.cols !== 'number' || typeof msg.rows !== 'number') return null;
        if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows)) return null;
        if (msg.cols < 1 || msg.cols > 500 || msg.rows < 1 || msg.rows > 500) return null;
        return { type: 'resize', agentId: msg.agentId, cols: msg.cols, rows: msg.rows };

      case 'kill':
        if (!isStringWithMaxLength(msg.agentId, 100)) return null;
        return { type: 'kill', agentId: msg.agentId };

      case 'pause':
        if (!isStringWithMaxLength(msg.agentId, 100)) return null;
        if (msg.channelId !== undefined && !isStringWithMaxLength(msg.channelId, 200)) return null;
        return {
          type: 'pause',
          agentId: msg.agentId,
          ...(msg.reason !== undefined ? { reason: msg.reason as PauseReason } : {}),
          ...(msg.channelId !== undefined ? { channelId: msg.channelId as string } : {}),
        };

      case 'resume':
        if (!isStringWithMaxLength(msg.agentId, 100)) return null;
        if (msg.channelId !== undefined && !isStringWithMaxLength(msg.channelId, 200)) return null;
        return {
          type: 'resume',
          agentId: msg.agentId,
          ...(msg.reason !== undefined ? { reason: msg.reason as PauseReason } : {}),
          ...(msg.channelId !== undefined ? { channelId: msg.channelId as string } : {}),
        };

      case 'subscribe':
        if (!isStringWithMaxLength(msg.agentId, 100)) return null;
        return { type: 'subscribe', agentId: msg.agentId };

      case 'unsubscribe':
        if (!isStringWithMaxLength(msg.agentId, 100)) return null;
        return { type: 'unsubscribe', agentId: msg.agentId };

      case 'bind-channel':
        if (!isStringWithMaxLength(msg.channelId, 200)) return null;
        return { type: 'bind-channel', channelId: msg.channelId };

      case 'unbind-channel':
        if (!isStringWithMaxLength(msg.channelId, 200)) return null;
        return { type: 'unbind-channel', channelId: msg.channelId };

      case 'permission-response':
        if (!isStringWithMaxLength(msg.agentId, 100) || !isStringWithMaxLength(msg.requestId, 100))
          return null;
        if (msg.action !== 'approve' && msg.action !== 'deny') return null;
        return {
          type: 'permission-response',
          agentId: msg.agentId,
          requestId: msg.requestId,
          action: msg.action,
        };

      default:
        return null;
    }
  } catch {
    return null;
  }
}
