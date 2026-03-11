import { createSignal } from 'solid-js';
import { getToken, clearToken } from './auth';
import type { ServerMessage, RemoteAgent } from '../../electron/remote/protocol';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
const CLIENT_ID_KEY = 'parallel-code-remote-client-id';

const [agents, setAgents] = createSignal<RemoteAgent[]>([]);
const [status, setStatus] = createSignal<ConnectionStatus>('disconnected');

type OutputListener = (data: string) => void;
type ScrollbackListener = (data: string, cols: number) => void;
const outputListeners = new Map<string, Set<OutputListener>>();
const scrollbackListeners = new Map<string, Set<ScrollbackListener>>();

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let pongTimer: ReturnType<typeof setTimeout> | null = null;
let shouldReconnect = true;
let lastServerSeq = -1;

export { agents, status };

function getClientStorage(): Storage | null {
  if (typeof sessionStorage !== 'undefined') return sessionStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

function getClientId(): string {
  const storage = getClientStorage();
  if (!storage) return 'remote-client';
  const existing = storage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const clientId = crypto.randomUUID();
  storage.setItem(CLIENT_ID_KEY, clientId);
  return clientId;
}

function clearHeartbeat(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  if (pongTimer) {
    clearTimeout(pongTimer);
    pongTimer = null;
  }
}

function schedulePongTimeout(): void {
  if (pongTimer) clearTimeout(pongTimer);
  pongTimer = setTimeout(() => {
    ws?.close();
  }, 10_000);
}

function startHeartbeat(): void {
  clearHeartbeat();
  pingInterval = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    send({ type: 'ping' });
    schedulePongTimeout();
  }, 30_000);
}

function activeSubscriptionAgentIds(): Set<string> {
  const agentIds = new Set<string>();
  for (const [agentId, listeners] of outputListeners) {
    if (listeners.size > 0) agentIds.add(agentId);
  }
  for (const [agentId, listeners] of scrollbackListeners) {
    if (listeners.size > 0) agentIds.add(agentId);
  }
  return agentIds;
}

function scheduleReconnect(): void {
  if (!shouldReconnect || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect('reconnecting');
  }, 3000);
}

export function connect(nextStatus: ConnectionStatus = 'connecting'): void {
  // Allow reconnect when existing socket is closing (not just null)
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws = null;
  }

  const token = getToken();
  if (!token) return;
  shouldReconnect = true;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws`;

  setStatus(nextStatus);
  ws = new WebSocket(url);

  ws.onopen = () => {
    // Authenticate via first message instead of URL query to avoid
    // token leaking in proxy logs or browser history.
    send({ type: 'auth', token, lastSeq: lastServerSeq, clientId: getClientId() });
    setStatus('connected');
    startHeartbeat();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Re-subscribe to agents with active listeners (lost on disconnect)
    for (const agentId of activeSubscriptionAgentIds()) {
      send({ type: 'subscribe', agentId });
    }
  };

  ws.onmessage = (event) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }

    const seq = (msg as { seq?: unknown }).seq;
    if (typeof seq === 'number' && Number.isInteger(seq)) {
      if (seq <= lastServerSeq) return;
      lastServerSeq = seq;
    }

    switch (msg.type) {
      case 'agents':
        setAgents(msg.list);
        break;

      case 'output': {
        const listeners = outputListeners.get(msg.agentId);
        listeners?.forEach((fn) => fn(msg.data));
        break;
      }

      case 'scrollback': {
        const listeners = scrollbackListeners.get(msg.agentId);
        listeners?.forEach((fn) => fn(msg.data, msg.cols));
        break;
      }

      case 'pong':
        if (pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
        break;

      case 'status':
        setAgents((prev) =>
          prev.map((a) =>
            a.agentId === msg.agentId ? { ...a, status: msg.status, exitCode: msg.exitCode } : a,
          ),
        );
        break;
    }
  };

  ws.onclose = (event) => {
    ws = null;
    clearHeartbeat();
    setStatus('disconnected');
    // 4001 = server rejected auth — token is stale, reload to re-auth
    if (event.code === 4001) {
      clearToken();
      window.location.reload();
      return;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

export function disconnect(): void {
  shouldReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearHeartbeat();
  ws?.close();
  ws = null;
  setStatus('disconnected');
}

export function send(msg: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function subscribeAgent(agentId: string): void {
  send({ type: 'subscribe', agentId });
}

export function unsubscribeAgent(agentId: string): void {
  send({ type: 'unsubscribe', agentId });
}

export function onOutput(agentId: string, fn: OutputListener): () => void {
  let listeners = outputListeners.get(agentId);
  if (!listeners) {
    listeners = new Set();
    outputListeners.set(agentId, listeners);
  }
  listeners.add(fn);
  return () => {
    const set = outputListeners.get(agentId);
    set?.delete(fn);
    if (set?.size === 0) outputListeners.delete(agentId);
  };
}

export function onScrollback(agentId: string, fn: ScrollbackListener): () => void {
  let listeners = scrollbackListeners.get(agentId);
  if (!listeners) {
    listeners = new Set();
    scrollbackListeners.set(agentId, listeners);
  }
  listeners.add(fn);
  return () => {
    const set = scrollbackListeners.get(agentId);
    set?.delete(fn);
    if (set?.size === 0) scrollbackListeners.delete(agentId);
  };
}

export function sendInput(agentId: string, data: string): void {
  send({ type: 'input', agentId, data });
}

export function sendKill(agentId: string): void {
  send({ type: 'kill', agentId });
}
