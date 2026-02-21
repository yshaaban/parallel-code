import { createSignal } from "solid-js";
import { getToken, clearToken } from "./auth";
import type { ServerMessage, RemoteAgent } from "../../electron/remote/protocol";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

const [agents, setAgents] = createSignal<RemoteAgent[]>([]);
const [status, setStatus] = createSignal<ConnectionStatus>("disconnected");

type OutputListener = (data: string) => void;
type ScrollbackListener = (data: string, cols: number) => void;
const outputListeners = new Map<string, Set<OutputListener>>();
const scrollbackListeners = new Map<string, Set<ScrollbackListener>>();

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export { agents, status };

export function connect(): void {
  // Allow reconnect when existing socket is closing (not just null)
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws = null;
  }

  const token = getToken();
  if (!token) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws?token=${token}`;

  setStatus("connecting");
  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus("connected");
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Re-subscribe to agents with active listeners (lost on disconnect)
    for (const [agentId, set] of outputListeners) {
      if (set.size > 0) send({ type: "subscribe", agentId });
    }
  };

  ws.onmessage = (event) => {
    let msg: ServerMessage;
    try { msg = JSON.parse(String(event.data)); } catch { return; }

    switch (msg.type) {
      case "agents":
        setAgents(msg.list);
        break;

      case "output": {
        const listeners = outputListeners.get(msg.agentId);
        listeners?.forEach((fn) => fn(msg.data));
        break;
      }

      case "scrollback": {
        const listeners = scrollbackListeners.get(msg.agentId);
        listeners?.forEach((fn) => fn(msg.data, msg.cols));
        break;
      }

      case "status":
        setAgents((prev) =>
          prev.map((a) =>
            a.agentId === msg.agentId
              ? { ...a, status: msg.status, exitCode: msg.exitCode }
              : a
          )
        );
        break;
    }
  };

  ws.onclose = (event) => {
    ws = null;
    setStatus("disconnected");
    // 4001 = server rejected auth — token is stale, reload to re-auth
    if (event.code === 4001) {
      clearToken();
      window.location.reload();
      return;
    }
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  ws?.close();
  ws = null;
  setStatus("disconnected");
}

export function send(msg: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function subscribeAgent(agentId: string): void {
  send({ type: "subscribe", agentId });
}

export function unsubscribeAgent(agentId: string): void {
  send({ type: "unsubscribe", agentId });
}

export function onOutput(agentId: string, fn: OutputListener): () => void {
  if (!outputListeners.has(agentId)) outputListeners.set(agentId, new Set());
  outputListeners.get(agentId)!.add(fn);
  return () => {
    const set = outputListeners.get(agentId);
    set?.delete(fn);
    if (set?.size === 0) outputListeners.delete(agentId);
  };
}

export function onScrollback(agentId: string, fn: ScrollbackListener): () => void {
  if (!scrollbackListeners.has(agentId)) scrollbackListeners.set(agentId, new Set());
  scrollbackListeners.get(agentId)!.add(fn);
  return () => {
    const set = scrollbackListeners.get(agentId);
    set?.delete(fn);
    if (set?.size === 0) scrollbackListeners.delete(agentId);
  };
}

export function sendInput(agentId: string, data: string): void {
  send({ type: "input", agentId, data });
}

export function sendKill(agentId: string): void {
  send({ type: "kill", agentId });
}
