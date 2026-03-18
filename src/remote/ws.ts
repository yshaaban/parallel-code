import { createSignal } from 'solid-js';
import type { ClientMessage, RemoteAgent, ServerMessage } from '../../electron/remote/protocol';
import { isRunningRemoteAgentStatus } from '../domain/server-state';
import { getPersistentClientId } from '../lib/client-id';
import { splitTerminalInputChunks } from '../lib/terminal-input-batching';
import { createWebSocketClientCore, type WebSocketConnectionState } from '../lib/websocket-client';
import { b64decode } from './base64';
import {
  appendRemoteAgentTail,
  deriveRemoteAgentPreview,
  truncateRemoteAgentTail,
} from './agent-presentation';
import { clearToken, getToken, redirectToRemoteAuthGate } from './auth';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
type ConnectStatus = Extract<ConnectionStatus, 'connecting' | 'reconnecting'>;

type OutputListener = (data: string) => void;
type ScrollbackListener = (data: string, cols: number) => void;

const CLIENT_ID_KEY = 'parallel-code-remote-client-id';
const agentDecoders = new Map<string, TextDecoder>();

const [agents, setAgents] = createSignal<RemoteAgent[]>([]);
const [status, setStatus] = createSignal<ConnectionStatus>('disconnected');
const [authRequired, setAuthRequired] = createSignal(false);
const [agentLastActivityAt, setAgentLastActivityAt] = createSignal<Record<string, number>>({});
const [agentPreviewById, setAgentPreviewById] = createSignal<Record<string, string>>({});
const [agentTailById, setAgentTailById] = createSignal<Record<string, string>>({});
const outputListeners = new Map<string, Set<OutputListener>>();
const scrollbackListeners = new Map<string, Set<ScrollbackListener>>();

let shouldReconnect = true;

export { agents, authRequired, status };

function getSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export function getRemoteClientId(): string {
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

function pruneAgentProjection<T>(
  previous: Record<string, T>,
  nextAgentIds: ReadonlySet<string>,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [agentId, value] of Object.entries(previous)) {
    if (nextAgentIds.has(agentId)) {
      next[agentId] = value;
    }
  }

  return next;
}

function getAgentDecoder(agentId: string): TextDecoder {
  let decoder = agentDecoders.get(agentId);
  if (!decoder) {
    decoder = new TextDecoder();
    agentDecoders.set(agentId, decoder);
  }

  return decoder;
}

function decodeOutputChunk(agentId: string, data: string, stream: boolean): string {
  return getAgentDecoder(agentId).decode(b64decode(data), { stream });
}

function decodeScrollbackSnapshot(data: string): string {
  return new TextDecoder().decode(b64decode(data));
}

function updateAgentActivity(agentId: string): void {
  setAgentLastActivityAt((previous) => ({
    ...previous,
    [agentId]: Date.now(),
  }));
}

function setAgentPreview(agentId: string, preview: string, nextTail: string): void {
  setAgentTailById((previous) => ({
    ...previous,
    [agentId]: nextTail,
  }));
  setAgentPreviewById((previous) => ({
    ...previous,
    [agentId]: preview,
  }));
}

function updateAgentPreviewFromTail(agent: RemoteAgent, nextTail: string): void {
  setAgentPreview(agent.agentId, deriveRemoteAgentPreview(nextTail, agent.status), nextTail);
}

function handleAgentsMessage(message: Extract<ServerMessage, { type: 'agents' }>): void {
  setAgents(message.list);
  const nextAgentIds = new Set(message.list.map((agent) => agent.agentId));
  const subscribedAgentIds = activeSubscriptionAgentIds();

  setAgentLastActivityAt((previous) => pruneAgentProjection(previous, nextAgentIds));
  setAgentPreviewById((previous) => {
    const next = pruneAgentProjection(previous, nextAgentIds);
    for (const agent of message.list) {
      if (subscribedAgentIds.has(agent.agentId) && next[agent.agentId]) {
        continue;
      }

      next[agent.agentId] = deriveRemoteAgentPreview(agent.lastLine, agent.status);
    }
    return next;
  });
  setAgentTailById((previous) => {
    const next = pruneAgentProjection(previous, nextAgentIds);
    for (const agent of message.list) {
      if (subscribedAgentIds.has(agent.agentId) && next[agent.agentId] !== undefined) {
        continue;
      }

      next[agent.agentId] = agent.lastLine;
    }
    return next;
  });

  for (const agentId of Array.from(agentDecoders.keys())) {
    if (!nextAgentIds.has(agentId)) {
      agentDecoders.delete(agentId);
    }
  }
}

function handleOutputMessage(message: Extract<ServerMessage, { type: 'output' }>): void {
  outputListeners.get(message.agentId)?.forEach((listener) => listener(message.data));
  const agent = agents().find((item) => item.agentId === message.agentId);
  if (!agent) {
    return;
  }

  const decodedChunk = decodeOutputChunk(message.agentId, message.data, true);
  const previousTail = agentTailById()[message.agentId] ?? agent.lastLine;
  const nextTail = appendRemoteAgentTail(previousTail, decodedChunk);
  updateAgentPreviewFromTail(agent, nextTail);
  updateAgentActivity(message.agentId);
}

function handleScrollbackMessage(message: Extract<ServerMessage, { type: 'scrollback' }>): void {
  scrollbackListeners
    .get(message.agentId)
    ?.forEach((listener) => listener(message.data, message.cols));

  const agent = agents().find((item) => item.agentId === message.agentId);
  if (!agent) {
    return;
  }

  const decodedScrollback = decodeScrollbackSnapshot(message.data);
  updateAgentPreviewFromTail(agent, truncateRemoteAgentTail(decodedScrollback));
  updateAgentActivity(message.agentId);
}

function handleStatusMessage(message: Extract<ServerMessage, { type: 'status' }>): void {
  setAgents((previous) =>
    previous.map((agent) =>
      agent.agentId === message.agentId
        ? { ...agent, status: message.status, exitCode: message.exitCode }
        : agent,
    ),
  );

  const currentAgent = agents().find((agent) => agent.agentId === message.agentId);
  if (!currentAgent) {
    return;
  }

  const previewTail = agentTailById()[message.agentId] ?? currentAgent.lastLine;
  updateAgentPreviewFromTail(currentAgent, previewTail);
  if (isRunningRemoteAgentStatus(message.status)) {
    updateAgentActivity(message.agentId);
  }
}

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'agents':
      handleAgentsMessage(message);
      break;

    case 'output':
      handleOutputMessage(message);
      break;

    case 'scrollback':
      handleScrollbackMessage(message);
      break;

    case 'status':
      handleStatusMessage(message);
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
  for (const chunk of splitTerminalInputChunks(data)) {
    send({ type: 'input', agentId, data: chunk.data });
  }
}

export function sendKill(agentId: string): void {
  send({ type: 'kill', agentId });
}

export function getAgentPreview(agentId: string): string {
  return agentPreviewById()[agentId] ?? '';
}

export function getAgentLastActivityAt(agentId: string): number | null {
  return agentLastActivityAt()[agentId] ?? null;
}
