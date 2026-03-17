import { randomBytes } from 'crypto';
import { WebSocket } from 'ws';
import { assertNever } from '../../src/lib/assert-never.js';
import type { ServerMessage } from './protocol.js';

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_AUTHENTICATED_CLIENTS = 100;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_MISSED_PONGS = 2;
const DEFAULT_CONTROL_EVENT_BUFFER_SIZE = 200;
const DEFAULT_AGENT_CONTROL_LEASE_MS = 5_000;

interface AgentControllerLease {
  clientId: string;
  touchedAt: number;
}

function createDefaultClientId(): string {
  return randomBytes(12).toString('hex');
}

export interface CreateWebSocketTransportOptions<Client extends WebSocket> {
  closeClient: (client: Client, code: number, reason: string) => void;
  sendBroadcastText: (client: Client, text: string) => SendTextResult;
  sendDirectText: (client: Client, text: string) => SendTextResult;
  terminateClient: (client: Client) => void;
  authTimeoutMs?: number;
  createClientId?: () => string;
  controlEventBufferSize?: number;
  heartbeatIntervalMs?: number;
  maxAuthenticatedClients?: number;
  maxMissedPongs?: number;
  agentControlLeaseMs?: number;
  onAuthenticatedClientCountChanged?: (count: number) => void;
}

export type SendTextResult =
  | { ok: true }
  | { ok: false; reason: 'not-open' | 'backpressure' }
  | { ok: false; reason: 'send-error'; error: unknown };

export type AuthenticateClientResult =
  | { ok: true; clientId: string }
  | { ok: false; reason: 'client-cap-reached' };

export type ClaimAgentControlResult =
  | { ok: true; controllerId: string }
  | { ok: false; reason: 'controlled-by-peer'; controllerId: string }
  | { ok: false; reason: 'unauthenticated' };

export type ClaimAgentControlFailure = Extract<ClaimAgentControlResult, { ok: false }>;

export function getClaimAgentControlErrorMessage(result: ClaimAgentControlFailure): string {
  switch (result.reason) {
    case 'controlled-by-peer':
      return 'Agent is controlled by another client.';
    case 'unauthenticated':
      return 'Agent is no longer authenticated.';
    default:
      return assertNever(result, 'Unhandled agent-control claim failure');
  }
}

export interface WebSocketTransport<Client extends WebSocket> {
  authenticateClient: (client: Client, clientId?: string) => AuthenticateClientResult;
  broadcast: (message: ServerMessage) => void;
  broadcastControl: (message: ServerMessage) => void;
  cleanupClient: (client: Client) => void;
  claimAgentControl: (client: Client, agentId: string) => ClaimAgentControlResult;
  getClientId: (client: Client) => string | null;
  getAuthenticatedClientCount: () => number;
  hasClientId: (clientId: string) => boolean;
  isAuthenticated: (client: Client) => boolean;
  notePong: (client: Client) => void;
  releaseAgentControl: (agentId: string, clientId?: string) => void;
  replayControlEvents: (client: Client, lastSeq?: number) => void;
  scheduleAuthTimeout: (client: Client) => void;
  sendToClientId: (clientId: string, message: ServerMessage) => boolean;
  sendAgentControllers: (client: Client) => void;
  sendMessage: (client: Client, message: ServerMessage) => SendTextResult;
  startHeartbeat: () => void;
  stopHeartbeat: () => void;
}

export function createWebSocketTransport<Client extends WebSocket>(
  options: CreateWebSocketTransportOptions<Client>,
): WebSocketTransport<Client> {
  const authenticatedClients = new Set<Client>();
  const authTimers = new WeakMap<Client, ReturnType<typeof setTimeout>>();
  const clientIds = new WeakMap<Client, string>();
  const clientsByClientId = new Map<string, Set<Client>>();
  const clientMissedPongs = new WeakMap<Client, number>();
  const agentControllers = new Map<string, AgentControllerLease>();
  const controlEventRingBuffer: Array<{ seq: number; json: string }> = [];

  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const maxAuthenticatedClients =
    options.maxAuthenticatedClients ?? DEFAULT_MAX_AUTHENTICATED_CLIENTS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxMissedPongs = options.maxMissedPongs ?? DEFAULT_MAX_MISSED_PONGS;
  const controlEventBufferSize =
    options.controlEventBufferSize ?? DEFAULT_CONTROL_EVENT_BUFFER_SIZE;
  const agentControlLeaseMs = options.agentControlLeaseMs ?? DEFAULT_AGENT_CONTROL_LEASE_MS;
  const createClientId = options.createClientId ?? createDefaultClientId;

  let controlEventSeq = 0;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  function notifyAuthenticatedClientCountChanged(): void {
    options.onAuthenticatedClientCountChanged?.(authenticatedClients.size);
  }

  function clearAuthTimer(client: Client): void {
    const timer = authTimers.get(client);
    if (!timer) return;
    clearTimeout(timer);
    authTimers.delete(client);
  }

  function sendSerializedDirect(client: Client, json: string): boolean {
    return options.sendDirectText(client, json).ok;
  }

  function serializeJson(value: unknown): string {
    return JSON.stringify(value);
  }

  function broadcastSerialized(json: string): void {
    for (const client of authenticatedClients) {
      options.sendBroadcastText(client, json);
    }
  }

  function terminateTransportClient(client: Client): void {
    cleanupClient(client);
    options.terminateClient(client);
  }

  function broadcastAgentController(agentId: string, controllerId: string | null): void {
    broadcastControl({
      type: 'agent-controller',
      agentId,
      controllerId,
    });
  }

  function getAgentController(agentId: string): AgentControllerLease | null {
    const controller = agentControllers.get(agentId);
    if (!controller) return null;
    if (Date.now() - controller.touchedAt <= agentControlLeaseMs) {
      return controller;
    }

    agentControllers.delete(agentId);
    broadcastAgentController(agentId, null);
    return null;
  }

  function releaseAgentControl(agentId: string, clientId?: string): void {
    const controller = agentControllers.get(agentId);
    if (!controller) return;
    if (clientId && controller.clientId !== clientId) return;

    agentControllers.delete(agentId);
    broadcastAgentController(agentId, null);
  }

  function releaseClientControlsByClientId(clientId: string): void {
    for (const [agentId, controller] of agentControllers) {
      if (controller.clientId === clientId) {
        releaseAgentControl(agentId, clientId);
      }
    }
  }

  function addControlEvent(seq: number, json: string): void {
    controlEventRingBuffer.push({ seq, json });
    while (controlEventRingBuffer.length > controlEventBufferSize) {
      controlEventRingBuffer.shift();
    }
  }

  function sendMessage(client: Client, message: ServerMessage): SendTextResult {
    return options.sendDirectText(client, serializeJson(message));
  }

  function broadcast(message: ServerMessage): void {
    broadcastSerialized(serializeJson(message));
  }

  function broadcastControl(message: ServerMessage): void {
    const seq = controlEventSeq++;
    const json = serializeJson({ ...message, seq });

    addControlEvent(seq, json);
    broadcastSerialized(json);
  }

  function replayControlEvents(client: Client, lastSeq = -1): void {
    for (const event of controlEventRingBuffer) {
      if (event.seq > lastSeq && !sendSerializedDirect(client, event.json)) {
        return;
      }
    }
  }

  function sendAgentControllers(client: Client): void {
    for (const [agentId] of agentControllers) {
      const controller = getAgentController(agentId);
      if (!controller) continue;

      sendMessage(client, {
        type: 'agent-controller',
        agentId,
        controllerId: controller.clientId,
      });
    }
  }

  function authenticateClient(client: Client, clientId?: string): AuthenticateClientResult {
    if (!authenticatedClients.has(client) && authenticatedClients.size >= maxAuthenticatedClients) {
      options.closeClient(client, 1013, 'Too many authenticated sessions');
      return { ok: false, reason: 'client-cap-reached' };
    }

    const wasAuthenticated = authenticatedClients.has(client);
    authenticatedClients.add(client);
    clearAuthTimer(client);
    clientMissedPongs.set(client, 0);

    const resolvedClientId = clientIds.get(client) ?? clientId ?? createClientId();
    clientIds.set(client, resolvedClientId);
    let clients = clientsByClientId.get(resolvedClientId);
    if (!clients) {
      clients = new Set();
      clientsByClientId.set(resolvedClientId, clients);
    }
    clients.add(client);

    if (!wasAuthenticated) {
      notifyAuthenticatedClientCountChanged();
    }

    return { ok: true, clientId: resolvedClientId };
  }

  function cleanupClient(client: Client): void {
    const wasAuthenticated = authenticatedClients.delete(client);
    clearAuthTimer(client);
    clientMissedPongs.delete(client);
    const clientId = clientIds.get(client);
    if (clientId) {
      const clients = clientsByClientId.get(clientId);
      clients?.delete(client);
      if (clients && clients.size === 0) {
        clientsByClientId.delete(clientId);
        releaseClientControlsByClientId(clientId);
      }
    }
    clientIds.delete(client);
    if (wasAuthenticated) {
      notifyAuthenticatedClientCountChanged();
    }
  }

  function scheduleAuthTimeout(client: Client): void {
    clearAuthTimer(client);
    authTimers.set(
      client,
      setTimeout(() => {
        if (!authenticatedClients.has(client)) {
          options.closeClient(client, 4001, 'Auth timeout');
        }
      }, authTimeoutMs),
    );
  }

  function claimAgentControl(client: Client, agentId: string): ClaimAgentControlResult {
    const clientId = clientIds.get(client);
    if (!clientId) {
      return { ok: false, reason: 'unauthenticated' };
    }

    const current = getAgentController(agentId);
    if (current && current.clientId !== clientId) {
      return { ok: false, reason: 'controlled-by-peer', controllerId: current.clientId };
    }

    agentControllers.set(agentId, { clientId, touchedAt: Date.now() });
    if (!current || current.clientId !== clientId) {
      broadcastAgentController(agentId, clientId);
    }
    return { ok: true, controllerId: clientId };
  }

  function notePong(client: Client): void {
    clientMissedPongs.set(client, 0);
  }

  function getAuthenticatedClientCount(): number {
    return authenticatedClients.size;
  }

  function hasClientId(clientId: string): boolean {
    return (clientsByClientId.get(clientId)?.size ?? 0) > 0;
  }

  function isAuthenticated(client: Client): boolean {
    return authenticatedClients.has(client);
  }

  function getClientId(client: Client): string | null {
    return clientIds.get(client) ?? null;
  }

  function sendToClientId(clientId: string, message: ServerMessage): boolean {
    const clients = clientsByClientId.get(clientId);
    if (!clients || clients.size === 0) {
      return false;
    }

    let sent = false;
    for (const client of clients) {
      if (sendMessage(client, message).ok) {
        sent = true;
      }
    }
    return sent;
  }

  function startHeartbeat(): void {
    if (heartbeatTimer) return;

    heartbeatTimer = setInterval(() => {
      for (const client of authenticatedClients) {
        if (client.readyState !== WebSocket.OPEN) continue;

        const missedPongs = clientMissedPongs.get(client) ?? 0;
        if (missedPongs >= maxMissedPongs) {
          terminateTransportClient(client);
          continue;
        }

        clientMissedPongs.set(client, missedPongs + 1);
        try {
          client.ping();
        } catch {
          terminateTransportClient(client);
        }
      }
    }, heartbeatIntervalMs);
  }

  function stopHeartbeat(): void {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  return {
    authenticateClient,
    broadcast,
    broadcastControl,
    cleanupClient,
    claimAgentControl,
    getClientId,
    getAuthenticatedClientCount,
    hasClientId,
    isAuthenticated,
    notePong,
    releaseAgentControl,
    replayControlEvents,
    scheduleAuthTimeout,
    sendToClientId,
    sendAgentControllers,
    sendMessage,
    startHeartbeat,
    stopHeartbeat,
  };
}
