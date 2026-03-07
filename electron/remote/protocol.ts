/** Agent summary sent in the agents list. */
export interface RemoteAgent {
  agentId: string;
  taskId: string;
  taskName: string;
  status: 'running' | 'exited';
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
  status: 'running' | 'exited';
  exitCode: number | null;
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

export interface ChannelMessage {
  type: 'channel';
  channelId: string;
  payload: unknown;
}

export interface IpcEventMessage {
  type: 'ipc-event';
  channel: string;
  payload: unknown;
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
  exitCode?: number | null;
  signal?: string | null;
}

export interface TaskEventMessage {
  type: 'task-event';
  event: 'created' | 'deleted';
  taskId: string;
  name?: string;
  branchName?: string;
  worktreePath?: string;
}

export interface GitStatusChangedMessage {
  type: 'git-status-changed';
  worktreePath?: string;
  projectRoot?: string;
  branchName?: string;
}

export type ServerMessage =
  | OutputMessage
  | StatusMessage
  | AgentsMessage
  | ScrollbackMessage
  | ChannelMessage
  | IpcEventMessage
  | ChannelBoundMessage
  | AgentLifecycleMessage
  | TaskEventMessage
  | GitStatusChangedMessage;

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

export interface PauseCommand {
  type: 'pause';
  agentId: string;
}

export interface ResumeCommand {
  type: 'resume';
  agentId: string;
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
}

export type ClientMessage =
  | AuthCommand
  | InputCommand
  | ResizeCommand
  | KillCommand
  | PauseCommand
  | ResumeCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | BindChannelCommand
  | UnbindChannelCommand;

/** Minimal validation for incoming client messages. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (typeof msg.type !== 'string') return null;

    // Auth message doesn't require agentId
    if (msg.type === 'auth') {
      if (typeof msg.token !== 'string' || msg.token.length > 200) return null;
      return { type: 'auth', token: msg.token };
    }

    switch (msg.type) {
      case 'input':
        if (typeof msg.agentId !== 'string' || msg.agentId.length > 100) return null;
        if (typeof msg.data !== 'string') return null;
        if (msg.data.length > 4096) return null;
        return { type: 'input', agentId: msg.agentId, data: msg.data };
      case 'resize':
        if (typeof msg.agentId !== 'string' || msg.agentId.length > 100) return null;
        if (typeof msg.cols !== 'number' || typeof msg.rows !== 'number') return null;
        if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows)) return null;
        if (msg.cols < 1 || msg.cols > 500 || msg.rows < 1 || msg.rows > 500) return null;
        return {
          type: 'resize',
          agentId: msg.agentId,
          cols: msg.cols,
          rows: msg.rows,
        };
      case 'kill':
        if (typeof msg.agentId !== 'string' || msg.agentId.length > 100) return null;
        return { type: 'kill', agentId: msg.agentId };
      case 'pause':
        if (typeof msg.agentId !== 'string' || msg.agentId.length > 100) return null;
        return { type: 'pause', agentId: msg.agentId };
      case 'resume':
        if (typeof msg.agentId !== 'string' || msg.agentId.length > 100) return null;
        return { type: 'resume', agentId: msg.agentId };
      case 'subscribe':
        if (typeof msg.agentId !== 'string' || msg.agentId.length > 100) return null;
        return { type: 'subscribe', agentId: msg.agentId };
      case 'unsubscribe':
        if (typeof msg.agentId !== 'string' || msg.agentId.length > 100) return null;
        return { type: 'unsubscribe', agentId: msg.agentId };
      case 'bind-channel':
        if (typeof msg.channelId !== 'string' || msg.channelId.length > 200) return null;
        return { type: 'bind-channel', channelId: msg.channelId };
      case 'unbind-channel':
        if (typeof msg.channelId !== 'string' || msg.channelId.length > 200) return null;
        return { type: 'unbind-channel', channelId: msg.channelId };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
