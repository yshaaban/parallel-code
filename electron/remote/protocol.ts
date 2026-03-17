import type {
  AgentLifecycleEvent,
  GitStatusSyncEvent,
  PeerPresenceSnapshot,
  PauseReason,
  RemoteAgent,
  RemoteAgentStatus,
  RemotePresence,
  TaskPortsEvent,
} from '../../src/domain/server-state.js';
import type { AnyServerStateBootstrapSnapshot } from '../../src/domain/server-state-bootstrap.js';
import { isPauseReason } from '../../src/domain/server-state.js';

export type {
  AgentLifecycleEvent,
  GitStatusSyncEvent,
  PeerPresenceSnapshot,
  PauseReason,
  RemoteAgent,
  RemoteAgentStatus,
  RemotePresence,
  TaskPortsEvent,
} from '../../src/domain/server-state.js';
export {
  getRemoteAgentStatus,
  isAutomaticPauseReason,
  isPauseReason,
  resolveRemoteLifecycleStatus,
} from '../../src/domain/server-state.js';

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

export interface AgentLifecycleMessage extends AgentLifecycleEvent {
  type: 'agent-lifecycle';
  seq?: number;
}

export interface AgentControllerMessage {
  type: 'agent-controller';
  agentId: string;
  controllerId: string | null;
  seq?: number;
}

export interface RemoteStatusMessage extends RemotePresence {
  type: 'remote-status';
  seq?: number;
}

export interface PeerPresencesMessage {
  type: 'peer-presences';
  list: PeerPresenceSnapshot[];
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

export interface GitStatusChangedMessage extends GitStatusSyncEvent {
  type: 'git-status-changed';
  seq?: number;
}

export type TaskPortsChangedMessage = TaskPortsEvent & {
  type: 'task-ports-changed';
  seq?: number;
};

export interface StateBootstrapMessage {
  type: 'state-bootstrap';
  snapshots: AnyServerStateBootstrapSnapshot[];
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

export interface AgentCommandResultMessage {
  type: 'agent-command-result';
  accepted: boolean;
  agentId: string;
  command: 'input' | 'resize';
  message?: string;
  requestId: string;
}

export interface TaskCommandTakeoverRequestMessage {
  type: 'task-command-takeover-request';
  action: string;
  expiresAt: number;
  requestId: string;
  requesterClientId: string;
  requesterDisplayName: string;
  taskId: string;
}

export interface TaskCommandTakeoverResultMessage {
  type: 'task-command-takeover-result';
  decision: 'approved' | 'denied' | 'force-required' | 'owner-missing';
  requestId: string;
  taskId: string;
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
  | PeerPresencesMessage
  | TaskEventMessage
  | GitStatusChangedMessage
  | TaskPortsChangedMessage
  | StateBootstrapMessage
  | PermissionRequestMessage
  | AgentErrorMessage
  | AgentCommandResultMessage
  | TaskCommandTakeoverRequestMessage
  | TaskCommandTakeoverResultMessage;

// --- Client -> Server messages ---

export interface InputCommand {
  type: 'input';
  agentId: string;
  controllerId?: string;
  data: string;
  requestId?: string;
  taskId?: string;
}

export interface ResizeCommand {
  type: 'resize';
  agentId: string;
  cols: number;
  controllerId?: string;
  requestId?: string;
  rows: number;
  taskId?: string;
}

export interface KillCommand {
  type: 'kill';
  agentId: string;
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

export interface UpdatePresenceCommand {
  type: 'update-presence';
  activeTaskId?: string | null;
  controllingAgentIds?: string[];
  controllingTaskIds?: string[];
  displayName: string;
  focusedSurface?: string | null;
  visibility: 'visible' | 'hidden';
}

export interface RequestTaskCommandTakeoverCommand {
  type: 'request-task-command-takeover';
  action: string;
  requestId: string;
  targetControllerId: string;
  taskId: string;
}

export interface RespondTaskCommandTakeoverCommand {
  type: 'respond-task-command-takeover';
  approved: boolean;
  requestId: string;
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
  | PermissionResponseCommand
  | UpdatePresenceCommand
  | RequestTaskCommandTakeoverCommand
  | RespondTaskCommandTakeoverCommand;

export const MAX_CLIENT_INPUT_DATA_LENGTH = 64 * 1024;

/** Validation helper: check string with max length. */
function isStringWithMaxLength(val: unknown, maxLen: number): val is string {
  return typeof val === 'string' && val.length <= maxLen;
}

/** Minimal validation for incoming client messages. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (!isStringWithMaxLength(msg.type, 50)) return null;
    if (
      msg.reason !== undefined &&
      (typeof msg.reason !== 'string' || !isPauseReason(msg.reason))
    ) {
      return null;
    }

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
      const authMessage: AuthCommand = {
        type: 'auth',
        token: msg.token,
      };
      if (msg.lastSeq !== undefined) {
        authMessage.lastSeq = msg.lastSeq;
      }
      if (msg.clientId !== undefined) {
        authMessage.clientId = msg.clientId;
      }
      return authMessage;
    }

    if (msg.type === 'ping') {
      return { type: 'ping' };
    }

    switch (msg.type) {
      case 'input':
        if (
          !isStringWithMaxLength(msg.agentId, 100) ||
          !isStringWithMaxLength(msg.data, MAX_CLIENT_INPUT_DATA_LENGTH)
        )
          return null;
        if (
          (msg.controllerId !== undefined && !isStringWithMaxLength(msg.controllerId, 100)) ||
          (msg.requestId !== undefined && !isStringWithMaxLength(msg.requestId, 120)) ||
          (msg.taskId !== undefined && !isStringWithMaxLength(msg.taskId, 100))
        ) {
          return null;
        }
        if (
          (msg.controllerId !== undefined && msg.taskId === undefined) ||
          (msg.taskId !== undefined && msg.controllerId === undefined)
        ) {
          return null;
        }
        return {
          type: 'input',
          agentId: msg.agentId,
          data: msg.data,
          ...(msg.controllerId !== undefined ? { controllerId: msg.controllerId } : {}),
          ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
          ...(msg.taskId !== undefined ? { taskId: msg.taskId } : {}),
        };

      case 'resize':
        if (!isStringWithMaxLength(msg.agentId, 100)) return null;
        if (typeof msg.cols !== 'number' || typeof msg.rows !== 'number') return null;
        if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows)) return null;
        if (msg.cols < 1 || msg.cols > 500 || msg.rows < 1 || msg.rows > 500) return null;
        if (
          (msg.controllerId !== undefined && !isStringWithMaxLength(msg.controllerId, 100)) ||
          (msg.requestId !== undefined && !isStringWithMaxLength(msg.requestId, 120)) ||
          (msg.taskId !== undefined && !isStringWithMaxLength(msg.taskId, 100))
        ) {
          return null;
        }
        if (
          (msg.controllerId !== undefined && msg.taskId === undefined) ||
          (msg.taskId !== undefined && msg.controllerId === undefined)
        ) {
          return null;
        }
        return {
          type: 'resize',
          agentId: msg.agentId,
          cols: msg.cols,
          rows: msg.rows,
          ...(msg.controllerId !== undefined ? { controllerId: msg.controllerId } : {}),
          ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
          ...(msg.taskId !== undefined ? { taskId: msg.taskId } : {}),
        };

      case 'kill':
        if (!isStringWithMaxLength(msg.agentId, 100)) return null;
        return { type: 'kill', agentId: msg.agentId };

      case 'pause':
        if (!isStringWithMaxLength(msg.agentId, 100)) return null;
        if (msg.channelId !== undefined && !isStringWithMaxLength(msg.channelId, 200)) return null;
        return {
          type: 'pause',
          agentId: msg.agentId,
          ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
          ...(msg.channelId !== undefined ? { channelId: msg.channelId } : {}),
        };

      case 'resume':
        if (!isStringWithMaxLength(msg.agentId, 100)) return null;
        if (msg.channelId !== undefined && !isStringWithMaxLength(msg.channelId, 200)) return null;
        return {
          type: 'resume',
          agentId: msg.agentId,
          ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
          ...(msg.channelId !== undefined ? { channelId: msg.channelId } : {}),
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

      case 'update-presence':
        if (!isStringWithMaxLength(msg.displayName, 80)) return null;
        if (msg.activeTaskId !== undefined && msg.activeTaskId !== null) {
          if (!isStringWithMaxLength(msg.activeTaskId, 100)) return null;
        }
        if (msg.focusedSurface !== undefined && msg.focusedSurface !== null) {
          if (!isStringWithMaxLength(msg.focusedSurface, 100)) return null;
        }
        if (msg.visibility !== 'visible' && msg.visibility !== 'hidden') return null;
        if (
          msg.controllingTaskIds !== undefined &&
          (!Array.isArray(msg.controllingTaskIds) ||
            !msg.controllingTaskIds.every((value) => isStringWithMaxLength(value, 100)))
        ) {
          return null;
        }
        if (
          msg.controllingAgentIds !== undefined &&
          (!Array.isArray(msg.controllingAgentIds) ||
            !msg.controllingAgentIds.every((value) => isStringWithMaxLength(value, 100)))
        ) {
          return null;
        }
        return {
          type: 'update-presence',
          displayName: msg.displayName,
          visibility: msg.visibility,
          ...(msg.activeTaskId !== undefined ? { activeTaskId: msg.activeTaskId } : {}),
          ...(msg.focusedSurface !== undefined ? { focusedSurface: msg.focusedSurface } : {}),
          ...(msg.controllingTaskIds !== undefined
            ? { controllingTaskIds: msg.controllingTaskIds }
            : {}),
          ...(msg.controllingAgentIds !== undefined
            ? { controllingAgentIds: msg.controllingAgentIds }
            : {}),
        };

      case 'request-task-command-takeover':
        if (
          !isStringWithMaxLength(msg.action, 100) ||
          !isStringWithMaxLength(msg.requestId, 100) ||
          !isStringWithMaxLength(msg.targetControllerId, 100) ||
          !isStringWithMaxLength(msg.taskId, 100)
        ) {
          return null;
        }
        return {
          type: 'request-task-command-takeover',
          action: msg.action,
          requestId: msg.requestId,
          targetControllerId: msg.targetControllerId,
          taskId: msg.taskId,
        };

      case 'respond-task-command-takeover':
        if (!isStringWithMaxLength(msg.requestId, 100) || typeof msg.approved !== 'boolean') {
          return null;
        }
        return {
          type: 'respond-task-command-takeover',
          approved: msg.approved,
          requestId: msg.requestId,
        };

      default:
        return null;
    }
  } catch {
    return null;
  }
}
