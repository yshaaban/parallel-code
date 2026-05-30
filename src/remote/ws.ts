import { createSignal, untrack } from 'solid-js';
import {
  isServerMessage,
  type ClientMessage,
  type RemoteAgent,
  type RemoteTerminalStreamEvent,
  type ServerMessage,
} from '../../electron/remote/protocol';
import type { PresenceConnectionStatus } from '../domain/presence';
import { isRunningRemoteAgentStatus } from '../domain/server-state';
import { dispatchByType, type DispatchByTypeHandlerMap } from '../lib/dispatch-by-type';
import { hasOwnKey } from '../lib/type-guards';
import {
  createWebSocketClientCore,
  type WebSocketClientCore,
  type WebSocketConnectionState,
  type WebSocketReconnectDelayContext,
} from '../lib/websocket-client';
import {
  getWeakConnectivityReconnectDelayMs,
  WEAK_CONNECTIVITY_CLIENT_HEARTBEAT,
} from '../lib/weak-connectivity-policy';
import { tryB64Decode } from './base64';
import {
  appendRemoteAgentTail,
  deriveRemoteAgentPreview,
  truncateRemoteAgentTail,
} from './agent-presentation';
import { clearToken, getToken, redirectToRemoteAuthGate } from './auth';
import { getRemoteClientId } from './client-id';
import {
  applyRemoteIpcEvent,
  applyRemoteStateBootstrap,
  handleRemoteTakeoverResult,
  replaceRemotePeerPresences,
  upsertIncomingRemoteTakeoverRequest,
} from './remote-collaboration';
import { applyRemoteTaskPortsChanged } from './remote-task-state';
import {
  resetRemoteTerminalOrderForAgent,
  resetRemoteTerminalOrderForAllAgents,
} from './remote-terminal-order';

export type ConnectionStatus = PresenceConnectionStatus;
type ConnectStatus = Extract<ConnectionStatus, 'connecting' | 'reconnecting'>;
type RemoteIncomingServerMessage = ServerMessage | { type: string };
type RemoteHandledServerMessageType =
  | 'agent-error'
  | 'agents'
  | 'ipc-event'
  | 'output'
  | 'peer-presences'
  | 'scrollback'
  | 'state-bootstrap'
  | 'status'
  | 'task-command-takeover-request'
  | 'task-command-takeover-result'
  | 'task-ports-changed'
  | 'terminal-recovery-result'
  | 'terminal-stream';
type RemoteIgnoredServerMessageType = Exclude<
  ServerMessage['type'],
  RemoteHandledServerMessageType
>;

type ConnectionStatusListener = (nextStatus: ConnectionStatus) => void;
type OutputListener = (data: string) => void;
type ScrollbackListener = (data: string, cols: number) => void;
type TerminalRecoveryResultListener = (
  entry: Extract<ServerMessage, { type: 'terminal-recovery-result' }>['entry'],
) => void;
type TerminalStreamListener = (event: RemoteTerminalStreamEvent) => void;
type TerminalSubscriptionProtocol = NonNullable<
  Extract<ClientMessage, { type: 'subscribe' }>['terminalProtocol']
>;
type PendingPreAgentTerminalEvent =
  | {
      byteLength: number;
      kind: 'output';
      text: string;
    }
  | {
      byteLength: number;
      kind: 'scrollback';
      tail: string;
    };

const MAX_PRE_AGENT_TERMINAL_EVENT_COUNT_PER_AGENT = 64;
const MAX_PRE_AGENT_TERMINAL_TEXT_BYTES_PER_AGENT = 64 * 1024;
const MAX_PRE_AGENT_TERMINAL_AGENT_COUNT = 64;

const agentDecoders = new Map<string, TextDecoder>();
const connectionStatusListeners = new Set<ConnectionStatusListener>();

const [agents, setAgents] = createSignal<RemoteAgent[]>([]);
const [status, setStatus] = createSignal<ConnectionStatus>('disconnected');
const [authRequired, setAuthRequired] = createSignal(false);
const [agentLastActivityAt, setAgentLastActivityAt] = createSignal<Record<string, number>>({});
const [agentPreviewById, setAgentPreviewById] = createSignal<Record<string, string>>({});
const [agentTailById, setAgentTailById] = createSignal<Record<string, string>>({});
const agentTailResetPendingById = new Set<string>();
const outputListeners = new Map<string, Set<OutputListener>>();
const scrollbackListeners = new Map<string, Set<ScrollbackListener>>();
const terminalRecoveryResultListeners = new Set<TerminalRecoveryResultListener>();
const terminalStreamListeners = new Map<string, Set<TerminalStreamListener>>();
const pendingPreAgentTerminalEventsByAgent = new Map<string, PendingPreAgentTerminalEvent[]>();

let shouldReconnect = true;
let lifecycleBound = false;
let reconnectLifecycleListener: (() => void) | null = null;
let visibilityChangeListener: (() => void) | null = null;

export { agents, authRequired, status };

function logRemoteWsWarning(context: string, error: unknown): void {
  console.warn(`[remote-ws] ${context}`, error);
}

const REMOTE_IGNORED_SERVER_MESSAGE_TYPES = {
  'agent-command-result': true,
  'agent-controller': true,
  'agent-lifecycle': true,
  channel: true,
  'channel-bound': true,
  'git-status-changed': true,
  'permission-request': true,
  pong: true,
  'replay-truncated': true,
  'remote-status': true,
  'task-command-lease-result': true,
  'task-event': true,
  'terminal-input-trace-clock-sync': true,
} satisfies Record<RemoteIgnoredServerMessageType, true>;

const CONNECTION_STATUS_BY_WEBSOCKET_STATE = {
  'auth-expired': 'disconnected',
  connected: 'connected',
  connecting: 'connecting',
  disconnected: 'disconnected',
  reconnecting: 'reconnecting',
} satisfies Record<WebSocketConnectionState, ConnectionStatus>;

type RemoteHandledServerMessage = Extract<ServerMessage, { type: RemoteHandledServerMessageType }>;

const REMOTE_SERVER_MESSAGE_HANDLERS = {
  'agent-error': handleAgentErrorMessage,
  agents: handleAgentsMessage,
  output: handleOutputMessage,
  scrollback: handleScrollbackMessage,
  status: handleStatusMessage,
  'peer-presences': (message) => replaceRemotePeerPresences(message.list),
  'state-bootstrap': (message) => applyRemoteStateBootstrap(message.snapshots),
  'task-command-takeover-request': upsertIncomingRemoteTakeoverRequest,
  'task-command-takeover-result': handleRemoteTakeoverResult,
  'ipc-event': (message) => applyRemoteIpcEvent(message.channel, message.payload),
  'task-ports-changed': applyRemoteTaskPortsChanged,
  'terminal-recovery-result': handleTerminalRecoveryResultMessage,
  'terminal-stream': handleTerminalStreamMessage,
} satisfies DispatchByTypeHandlerMap<RemoteHandledServerMessage>;

function handleAgentErrorMessage(message: Extract<ServerMessage, { type: 'agent-error' }>): void {
  logRemoteWsWarning(`Agent ${message.agentId} command rejected`, new Error(message.message));
}

function updateStatus(nextStatus: ConnectionStatus): void {
  setStatus(nextStatus);
  for (const listener of connectionStatusListeners) {
    listener(nextStatus);
  }
}

function getSocketUrl(context: { clientId: string; lastSeq: number }): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${protocol}//${window.location.host}/ws`);
  url.searchParams.set('clientId', context.clientId);
  url.searchParams.set('lastSeq', String(context.lastSeq));
  return url.toString();
}

function activeSubscriptionAgentProtocols(): Map<string, TerminalSubscriptionProtocol> {
  const agentProtocols = new Map<string, TerminalSubscriptionProtocol>();

  for (const [agentId, listeners] of outputListeners) {
    if (listeners.size > 0) {
      agentProtocols.set(agentId, 'legacy');
    }
  }

  for (const [agentId, listeners] of scrollbackListeners) {
    if (listeners.size > 0) {
      agentProtocols.set(agentId, 'legacy');
    }
  }

  for (const [agentId, listeners] of terminalStreamListeners) {
    if (listeners.size > 0) {
      agentProtocols.set(agentId, 'structured');
    }
  }

  return agentProtocols;
}

function createSubscribeMessage(
  agentId: string,
  terminalProtocol?: TerminalSubscriptionProtocol,
): Extract<ClientMessage, { type: 'subscribe' }> {
  return {
    type: 'subscribe',
    agentId,
    ...(terminalProtocol === 'structured' ? { terminalProtocol } : {}),
  };
}

function sendSubscriptionMessage(
  agentId: string,
  terminalProtocol?: TerminalSubscriptionProtocol,
): boolean {
  return client.sendIfOpen(createSubscribeMessage(agentId, terminalProtocol));
}

function toConnectionStatus(state: WebSocketConnectionState): ConnectionStatus {
  return CONNECTION_STATUS_BY_WEBSOCKET_STATE[state];
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

function decodeOutputChunk(agentId: string, bytes: Uint8Array, stream: boolean): string {
  return getAgentDecoder(agentId).decode(bytes, { stream });
}

function decodeScrollbackSnapshot(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function decodeRemoteBase64Payload(data: string, context: string): Uint8Array | null {
  const decoded = tryB64Decode(data);
  if (decoded === null) {
    logRemoteWsWarning(
      `Ignoring malformed ${context} payload`,
      new Error('Invalid base64 payload'),
    );
    return null;
  }

  return decoded;
}

function resetAgentDecoder(agentId: string): void {
  agentDecoders.delete(agentId);
}

function resetAllAgentDecoders(): void {
  agentDecoders.clear();
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

function getPendingPreAgentEventTotalBytes(events: PendingPreAgentTerminalEvent[]): number {
  return events.reduce((total, event) => total + event.byteLength, 0);
}

function trimPendingPreAgentEvents(events: PendingPreAgentTerminalEvent[]): void {
  while (
    events.length > MAX_PRE_AGENT_TERMINAL_EVENT_COUNT_PER_AGENT ||
    getPendingPreAgentEventTotalBytes(events) > MAX_PRE_AGENT_TERMINAL_TEXT_BYTES_PER_AGENT
  ) {
    events.shift();
  }
}

function bufferPreAgentTerminalEvent(agentId: string, event: PendingPreAgentTerminalEvent): void {
  if (
    !pendingPreAgentTerminalEventsByAgent.has(agentId) &&
    pendingPreAgentTerminalEventsByAgent.size >= MAX_PRE_AGENT_TERMINAL_AGENT_COUNT
  ) {
    const oldestAgentId = pendingPreAgentTerminalEventsByAgent.keys().next().value;
    if (typeof oldestAgentId === 'string') {
      pendingPreAgentTerminalEventsByAgent.delete(oldestAgentId);
    }
  }

  const events = pendingPreAgentTerminalEventsByAgent.get(agentId) ?? [];
  events.push(event);
  trimPendingPreAgentEvents(events);

  if (events.length > 0) {
    pendingPreAgentTerminalEventsByAgent.set(agentId, events);
  } else {
    pendingPreAgentTerminalEventsByAgent.delete(agentId);
  }
}

function applyPendingPreAgentTerminalEvents(agent: RemoteAgent): void {
  const events = pendingPreAgentTerminalEventsByAgent.get(agent.agentId);
  if (!events || events.length === 0) {
    return;
  }

  pendingPreAgentTerminalEventsByAgent.delete(agent.agentId);
  let nextTail = agentTailById()[agent.agentId] ?? agent.lastLine;
  for (const event of events) {
    if (event.kind === 'output') {
      nextTail = appendRemoteAgentTail(nextTail, event.text);
    } else {
      nextTail = event.tail;
    }
  }

  updateAgentPreviewFromTail(agent, nextTail);
  updateAgentActivity(agent.agentId);
}

function notifyTerminalStreamListeners(agentId: string, event: RemoteTerminalStreamEvent): void {
  const listeners = terminalStreamListeners.get(agentId);
  if (!listeners) {
    return;
  }

  for (const listener of listeners) {
    listener(event);
  }
}

function handleAgentsMessage(message: Extract<ServerMessage, { type: 'agents' }>): void {
  setAgents(message.list);
  const nextAgentIds = new Set(message.list.map((agent) => agent.agentId));
  const activeAgentProtocols = activeSubscriptionAgentProtocols();
  const subscribedAgentIds = new Set(activeAgentProtocols.keys());
  const snapshotSeedAgentIds = new Set<string>();

  for (const agent of message.list) {
    if (agentTailResetPendingById.has(agent.agentId) && isRunningRemoteAgentStatus(agent.status)) {
      snapshotSeedAgentIds.add(agent.agentId);
    }
  }

  setAgentLastActivityAt((previous) => pruneAgentProjection(previous, nextAgentIds));
  setAgentPreviewById((previous) => {
    const next = pruneAgentProjection(previous, nextAgentIds);
    for (const agent of message.list) {
      if (
        !snapshotSeedAgentIds.has(agent.agentId) &&
        subscribedAgentIds.has(agent.agentId) &&
        next[agent.agentId]
      ) {
        continue;
      }

      next[agent.agentId] = deriveRemoteAgentPreview(agent.lastLine, agent.status);
    }
    return next;
  });
  setAgentTailById((previous) => {
    const next = pruneAgentProjection(previous, nextAgentIds);
    for (const agent of message.list) {
      if (
        !snapshotSeedAgentIds.has(agent.agentId) &&
        subscribedAgentIds.has(agent.agentId) &&
        next[agent.agentId] !== undefined
      ) {
        continue;
      }

      next[agent.agentId] = agent.lastLine;
    }
    return next;
  });

  for (const agentId of Array.from(agentDecoders.keys())) {
    if (!nextAgentIds.has(agentId)) {
      resetAgentDecoder(agentId);
    }
  }

  for (const agentId of Array.from(agentTailResetPendingById)) {
    if (!nextAgentIds.has(agentId) || snapshotSeedAgentIds.has(agentId)) {
      agentTailResetPendingById.delete(agentId);
    }
  }

  for (const agentId of snapshotSeedAgentIds) {
    const terminalProtocol = activeAgentProtocols.get(agentId);
    if (!terminalProtocol) {
      continue;
    }

    sendSubscriptionMessage(agentId, terminalProtocol);
  }

  for (const agent of message.list) {
    applyPendingPreAgentTerminalEvents(agent);
  }
}

function applyRemoteOutputData(agentId: string, data: string, context: string): void {
  const bytes = decodeRemoteBase64Payload(data, context);
  if (bytes === null) {
    return;
  }

  const listeners = outputListeners.get(agentId);
  if (listeners) {
    for (const listener of listeners) {
      listener(data);
    }
  }

  const decodedChunk = decodeOutputChunk(agentId, bytes, true);
  const agent = agents().find((item) => item.agentId === agentId);
  if (!agent) {
    bufferPreAgentTerminalEvent(agentId, {
      byteLength: bytes.byteLength,
      kind: 'output',
      text: decodedChunk,
    });
    return;
  }

  const shouldStartFreshTail = agentTailResetPendingById.delete(agentId);
  const previousTail = shouldStartFreshTail ? '' : (agentTailById()[agentId] ?? agent.lastLine);
  const nextTail = appendRemoteAgentTail(previousTail, decodedChunk);
  updateAgentPreviewFromTail(agent, nextTail);
  updateAgentActivity(agentId);
}

function handleOutputMessage(message: Extract<ServerMessage, { type: 'output' }>): void {
  applyRemoteOutputData(message.agentId, message.data, 'output');
}

function handleScrollbackMessage(message: Extract<ServerMessage, { type: 'scrollback' }>): void {
  const bytes = decodeRemoteBase64Payload(message.data, 'scrollback');
  if (bytes === null) {
    return;
  }

  const listeners = scrollbackListeners.get(message.agentId);
  if (listeners) {
    for (const listener of listeners) {
      listener(message.data, message.cols);
    }
  }

  const agent = agents().find((item) => item.agentId === message.agentId);
  const decodedScrollback = decodeScrollbackSnapshot(bytes);
  const nextTail = truncateRemoteAgentTail(decodedScrollback);
  if (!agent) {
    bufferPreAgentTerminalEvent(message.agentId, {
      byteLength: bytes.byteLength,
      kind: 'scrollback',
      tail: nextTail,
    });
    return;
  }

  updateAgentPreviewFromTail(agent, nextTail);
  updateAgentActivity(message.agentId);
}

function handleStatusMessage(message: Extract<ServerMessage, { type: 'status' }>): void {
  if (message.status === 'exited') {
    resetAgentDecoder(message.agentId);
    resetRemoteTerminalOrderForAgent(message.agentId);
    agentTailResetPendingById.add(message.agentId);
  }

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

function handleTerminalStreamMessage(
  message: Extract<ServerMessage, { type: 'terminal-stream' }>,
): void {
  switch (message.event.type) {
    case 'Data':
      applyRemoteOutputData(message.agentId, message.event.data, 'terminal stream');
      notifyTerminalStreamListeners(message.agentId, message.event);
      return;
    case 'Exit': {
      const exitEvent = message.event;
      resetAgentDecoder(message.agentId);
      resetRemoteTerminalOrderForAgent(message.agentId);
      setAgents((previous) =>
        previous.map((agent) =>
          agent.agentId === message.agentId
            ? { ...agent, status: 'exited', exitCode: exitEvent.data.exit_code }
            : agent,
        ),
      );
      const currentAgent = agents().find((agent) => agent.agentId === message.agentId);
      agentTailResetPendingById.add(message.agentId);
      if (currentAgent) {
        updateAgentPreviewFromTail(
          currentAgent,
          truncateRemoteAgentTail(exitEvent.data.last_output.join('\n')),
        );
      }
      notifyTerminalStreamListeners(message.agentId, exitEvent);
      return;
    }
    case 'RecoveryRequired':
      notifyTerminalStreamListeners(message.agentId, message.event);
      return;
  }
}

function handleTerminalRecoveryResultMessage(
  message: Extract<ServerMessage, { type: 'terminal-recovery-result' }>,
): void {
  for (const listener of terminalRecoveryResultListeners) {
    listener(message.entry);
  }
}

function shouldHandleRemoteServerMessage(
  message: RemoteIncomingServerMessage,
): message is RemoteHandledServerMessage {
  if (!isServerMessage(message)) {
    return false;
  }

  if (hasOwnKey(REMOTE_SERVER_MESSAGE_HANDLERS, message.type)) {
    return true;
  }

  if (hasOwnKey(REMOTE_IGNORED_SERVER_MESSAGE_TYPES, message.type)) {
    return false;
  }

  return false;
}

function handleServerMessage(message: RemoteIncomingServerMessage): void {
  if (!shouldHandleRemoteServerMessage(message)) {
    return;
  }

  return dispatchByType(REMOTE_SERVER_MESSAGE_HANDLERS, message);
}

function onAuthenticated(): void {
  setAuthRequired(false);
  resetRemoteTerminalOrderForAllAgents();
  for (const [agentId, terminalProtocol] of activeSubscriptionAgentProtocols()) {
    sendSubscriptionMessage(agentId, terminalProtocol);
  }
}

function onAuthExpired(): void {
  if (getToken()) {
    clearToken();
    shouldReconnect = false;
    client.disconnect();
    updateStatus('disconnected');
    setAuthRequired(true);
    return;
  }

  shouldReconnect = false;
  client.disconnect();
  updateStatus('disconnected');
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
  isPongMessage: (message: RemoteIncomingServerMessage): boolean => message.type === 'pong',
  onAuthenticated,
  onAuthExpired,
  onMessage: handleServerMessage,
  onSequenceGap: (event) => {
    logRemoteWsWarning('Sequence gap detected; reconnecting remote websocket session', event);
    client.disconnect();
    connect('reconnecting');
  },
  onStateChange: (nextState: WebSocketConnectionState) => {
    if (nextState !== 'connected') {
      resetAllAgentDecoders();
    }
    updateStatus(toConnectionStatus(nextState));
  },
  pingIntervalMs: WEAK_CONNECTIVITY_CLIENT_HEARTBEAT.pingIntervalMs,
  pongTimeoutMs: WEAK_CONNECTIVITY_CLIENT_HEARTBEAT.pongTimeoutMs,
  maxMissedPongs: WEAK_CONNECTIVITY_CLIENT_HEARTBEAT.maxMissedPongs,
  reconnectDelayMs: (attempt: number, context: WebSocketReconnectDelayContext): number =>
    getWeakConnectivityReconnectDelayMs(attempt, context),
  shouldReconnect: () => shouldReconnect,
} satisfies Omit<
  Parameters<typeof createWebSocketClientCore<RemoteIncomingServerMessage, ClientMessage>>[0],
  'createAuthMessage' | 'getToken'
>;

function createRemoteWebSocketClient(): WebSocketClientCore<ClientMessage> {
  return createWebSocketClientCore<RemoteIncomingServerMessage, ClientMessage>({
    ...baseClientOptions,
    createAuthMessage: ({ clientId, lastSeq, token }) => ({
      type: 'auth',
      clientId,
      lastSeq,
      token,
    }),
    getToken,
    shouldSendAuthMessage: ({ token }) => token !== null,
  });
}

const client = createRemoteWebSocketClient();

function bindLifecycle(): void {
  if (lifecycleBound || typeof window === 'undefined') {
    return;
  }

  lifecycleBound = true;

  const reconnect = () => {
    if (!shouldReconnect) {
      return;
    }
    if (client.isOpen() || client.hasPendingConnection()) {
      return;
    }

    void client.ensureConnected('reconnecting').catch((error) => {
      logRemoteWsWarning('Failed to reconnect websocket session', error);
    });
  };

  reconnectLifecycleListener = reconnect;
  visibilityChangeListener = () => {
    if (!document.hidden) {
      reconnect();
    }
  };

  window.addEventListener('online', reconnectLifecycleListener);
  window.addEventListener('pageshow', reconnectLifecycleListener);
  document.addEventListener('visibilitychange', visibilityChangeListener);
}

export function connect(nextStatus: ConnectStatus = 'connecting'): void {
  bindLifecycle();
  shouldReconnect = true;
  setAuthRequired(false);
  updateStatus(nextStatus);
  void client.ensureConnected(nextStatus).catch((error) => {
    logRemoteWsWarning(`Failed to establish websocket session (${nextStatus})`, error);
    if (untrack(status) === nextStatus && !client.isOpen() && !client.hasPendingConnection()) {
      updateStatus('disconnected');
    }
  });
}

export function disconnect(): void {
  shouldReconnect = false;
  client.disconnect();
  updateStatus('disconnected');
}

export function subscribeRemoteConnectionStatus(listener: ConnectionStatusListener): () => void {
  connectionStatusListeners.add(listener);
  listener(status());
  return () => {
    connectionStatusListeners.delete(listener);
  };
}

export function send(message: ClientMessage): boolean {
  return client.sendIfOpen(message);
}

export async function sendWhenConnected(message: ClientMessage): Promise<boolean> {
  try {
    await client.send(message);
    return true;
  } catch (error) {
    logRemoteWsWarning('Failed to send websocket message after waiting for connection', error);
    return false;
  }
}

export function resetRemoteWsRuntimeStateForTests(): void {
  if (typeof window !== 'undefined' && reconnectLifecycleListener) {
    window.removeEventListener('online', reconnectLifecycleListener);
    window.removeEventListener('pageshow', reconnectLifecycleListener);
  }
  if (typeof document !== 'undefined' && visibilityChangeListener) {
    document.removeEventListener('visibilitychange', visibilityChangeListener);
  }

  reconnectLifecycleListener = null;
  visibilityChangeListener = null;
  lifecycleBound = false;
  shouldReconnect = true;
  connectionStatusListeners.clear();
  resetAllAgentDecoders();
  agentTailResetPendingById.clear();
  outputListeners.clear();
  scrollbackListeners.clear();
  terminalRecoveryResultListeners.clear();
  terminalStreamListeners.clear();
  pendingPreAgentTerminalEventsByAgent.clear();
  client.resetForTests();
  setAgents([]);
  setStatus('disconnected');
  setAuthRequired(false);
  setAgentLastActivityAt({});
  setAgentPreviewById({});
  setAgentTailById({});
  resetRemoteTerminalOrderForAllAgents();
}

export function subscribeAgent(
  agentId: string,
  options?: {
    terminalProtocol?: Extract<ClientMessage, { type: 'subscribe' }>['terminalProtocol'];
  },
): boolean {
  const terminalProtocol = options?.terminalProtocol;
  return sendSubscriptionMessage(agentId, terminalProtocol);
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

export function onTerminalStream(agentId: string, listener: TerminalStreamListener): () => void {
  let listeners = terminalStreamListeners.get(agentId);
  if (!listeners) {
    listeners = new Set();
    terminalStreamListeners.set(agentId, listeners);
  }

  listeners.add(listener);

  return () => {
    const current = terminalStreamListeners.get(agentId);
    current?.delete(listener);
    if (current?.size === 0) {
      terminalStreamListeners.delete(agentId);
    }
  };
}

export function onTerminalRecoveryResult(listener: TerminalRecoveryResultListener): () => void {
  terminalRecoveryResultListeners.add(listener);
  return () => {
    terminalRecoveryResultListeners.delete(listener);
  };
}

export function requestRemoteTerminalRecovery(
  request: Omit<Extract<ClientMessage, { type: 'terminal-recovery-request' }>, 'type'>,
): boolean {
  return send({
    type: 'terminal-recovery-request',
    ...request,
  });
}

export function requestRemoteTerminalStartupRecovery(
  request: Omit<Extract<ClientMessage, { type: 'terminal-startup-recovery-request' }>, 'type'>,
): boolean {
  return send({
    type: 'terminal-startup-recovery-request',
    ...request,
  });
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
