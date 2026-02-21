/** Agent summary sent in the agents list. */
export interface RemoteAgent {
  agentId: string;
  taskId: string;
  taskName: string;
  status: "running" | "exited";
  exitCode: number | null;
  lastLine: string;
}

// --- Server -> Client messages ---

export interface OutputMessage {
  type: "output";
  agentId: string;
  data: string; // base64
}

export interface StatusMessage {
  type: "status";
  agentId: string;
  status: "running" | "exited";
  exitCode: number | null;
}

export interface AgentsMessage {
  type: "agents";
  list: RemoteAgent[];
}

export interface ScrollbackMessage {
  type: "scrollback";
  agentId: string;
  data: string; // base64
  cols: number;
}

export type ServerMessage =
  | OutputMessage
  | StatusMessage
  | AgentsMessage
  | ScrollbackMessage;

// --- Client -> Server messages ---

export interface InputCommand {
  type: "input";
  agentId: string;
  data: string;
}

export interface ResizeCommand {
  type: "resize";
  agentId: string;
  cols: number;
  rows: number;
}

export interface KillCommand {
  type: "kill";
  agentId: string;
}

export interface SubscribeCommand {
  type: "subscribe";
  agentId: string;
}

export interface UnsubscribeCommand {
  type: "unsubscribe";
  agentId: string;
}

export type ClientMessage =
  | InputCommand
  | ResizeCommand
  | KillCommand
  | SubscribeCommand
  | UnsubscribeCommand;

/** Minimal validation for incoming client messages. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (typeof msg.type !== "string") return null;
    if (typeof msg.agentId !== "string" || msg.agentId.length > 100) return null;

    switch (msg.type) {
      case "input":
        if (typeof msg.data !== "string") return null;
        if (msg.data.length > 4096) return null;
        return { type: "input", agentId: msg.agentId, data: msg.data };
      case "resize":
        if (typeof msg.cols !== "number" || typeof msg.rows !== "number")
          return null;
        if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows)) return null;
        if (msg.cols < 1 || msg.cols > 500 || msg.rows < 1 || msg.rows > 500) return null;
        return {
          type: "resize",
          agentId: msg.agentId,
          cols: msg.cols,
          rows: msg.rows,
        };
      case "kill":
        return { type: "kill", agentId: msg.agentId };
      case "subscribe":
        return { type: "subscribe", agentId: msg.agentId };
      case "unsubscribe":
        return { type: "unsubscribe", agentId: msg.agentId };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
