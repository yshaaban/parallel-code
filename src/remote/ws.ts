import { createSignal } from 'solid-js';
import type { ClientMessage, RemoteAgent, ServerMessage } from '../../electron/remote/protocol';
import { getPersistentClientId } from '../lib/client-id';
import { createWebSocketClientCore, type WebSocketConnectionState } from '../lib/websocket-client';
import { clearToken, getToken, redirectToRemoteAuthGate } from './auth';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
type ConnectStatus = Extract<ConnectionStatus, 'connecting' | 'reconnecting'>;

const CLIENT_ID_KEY = 'parallel-code-remote-client-id';

type OutputListener = (data: string) => void;
type ScrollbackListener = (data: string, cols: number) => void;

const [agents, setAgents] = createSignal<RemoteAgent[]>([]);
const [status, setStatus] = createSignal<ConnectionStatus>('disconnected');
const [authRequired, setAuthRequired] = createSignal(false);
const outputListeners = new Map<string, Set<OutputListener>>();
const scrollbackListeners = new Map<string, Set<ScrollbackListener>>();

let shouldReconnect = true;

export { agents, authRequired, status };

function getSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function getRemoteClientId(): string {
  return getPersistentClientId(CLIENT_ID_KEY, 'remote-client');
}

function activeSubscriptionAgentIds(): Set<string> {
  const agentIds = new Set<string>();

  for (const [agentId, listeners] of outputListeners) {
    if (listeners.size > 0) {
      agentIds.add(agentId);
    }
  }

  for (const [agentId, listeners] of scrollbackListeners) {
    if (listeners.size > 0) {
      agentIds.add(agentId);
    }
  }

  return agentIds;
}

function toConnectionStatus(state: WebSocketConnectionState): ConnectionStatus {
  switch (state) {
    case 'auth-expired':
      return 'disconnected';
    default:
      return state;
  }
}

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'agents':
      setAgents(message.list);
      break;

    case 'output':
      outputListeners.get(message.agentId)?.forEach((listener) => listener(message.data));
      break;

    case 'scrollback':
      scrollbackListeners
        .get(message.agentId)
        ?.forEach((listener) => listener(message.data, message.cols));
      break;

    case 'status':
      setAgents((previous) =>
        previous.map((agent) =>
          agent.agentId === message.agentId
            ? { ...agent, status: message.status, exitCode: message.exitCode }
            : agent,
        ),
      );
      break;

    default:
      break;
  }
}

function onAuthenticated(): void {
  for (const agentId of activeSubscriptionAgentIds()) {
    client.sendIfOpen({ type: 'subscribe', agentId });
  }
}

function onAuthExpired(): void {
  if (getToken()) {
    clearToken();
    shouldReconnect = false;
    client.disconnect();
    setStatus('disconnected');
    setAuthRequired(true);
    return;
  }

  shouldReconnect = false;
  client.disconnect();
  setStatus('disconnected');
  void redirectToRemoteAuthGate('/remote').then((redirected) => {
    if (!redirected) {
      setAuthRequired(true);
    }
  });
}

const baseClientOptions = {
  createPingMessage: () => ({ type: 'ping' }),
  getClientId: getRemoteClientId,
  getSocketUrl,
  isPongMessage: (message: ServerMessage) => message.type === 'pong',
  onAuthenticated,
  onAuthExpired,
  onMessage: handleServerMessage,
  onStateChange: (nextState: WebSocketConnectionState) => {
    setStatus(toConnectionStatus(nextState));
  },
  reconnectDelayMs: () => 3_000,
  shouldReconnect: () => shouldReconnect,
} satisfies Omit<
  Parameters<typeof createWebSocketClientCore<ServerMessage, ClientMessage>>[0],
  'createAuthMessage' | 'getToken'
>;

function createRemoteWebSocketClient() {
  if (!getToken()) {
    return createWebSocketClientCore<ServerMessage, ClientMessage>(baseClientOptions);
  }

  return createWebSocketClientCore<ServerMessage, ClientMessage>({
    ...baseClientOptions,
    createAuthMessage: ({ clientId, lastSeq, token }) => ({
      type: 'auth',
      clientId,
      lastSeq,
      token,
    }),
    getToken,
  });
}

const client = createRemoteWebSocketClient();

export function connect(nextStatus: ConnectStatus = 'connecting'): void {
  shouldReconnect = true;
  setAuthRequired(false);
  setStatus(nextStatus);
  void client.ensureConnected(nextStatus).catch(() => {});
}

export function disconnect(): void {
  shouldReconnect = false;
  client.disconnect();
  setStatus('disconnected');
}

export function send(message: ClientMessage): void {
  client.sendIfOpen(message);
}

export function subscribeAgent(agentId: string): void {
  send({ type: 'subscribe', agentId });
}

export function unsubscribeAgent(agentId: string): void {
  send({ type: 'unsubscribe', agentId });
}

export function onOutput(agentId: string, listener: OutputListener): () => void {
  let listeners = outputListeners.get(agentId);
  if (!listeners) {
    listeners = new Set();
    outputListeners.set(agentId, listeners);
  }

  listeners.add(listener);

  return () => {
    const current = outputListeners.get(agentId);
    current?.delete(listener);
    if (current?.size === 0) {
      outputListeners.delete(agentId);
    }
  };
}

export function onScrollback(agentId: string, listener: ScrollbackListener): () => void {
  let listeners = scrollbackListeners.get(agentId);
  if (!listeners) {
    listeners = new Set();
    scrollbackListeners.set(agentId, listeners);
  }

  listeners.add(listener);

  return () => {
    const current = scrollbackListeners.get(agentId);
    current?.delete(listener);
    if (current?.size === 0) {
      scrollbackListeners.delete(agentId);
    }
  };
}

export function sendInput(agentId: string, data: string): void {
  send({ type: 'input', agentId, data });
}

export function sendKill(agentId: string): void {
  send({ type: 'kill', agentId });
}
