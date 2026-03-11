import { randomBytes } from 'crypto';
import { WebSocket } from 'ws';
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
  sendBroadcastText: (client: Client, text: string) => boolean;
  sendDirectText: (client: Client, text: string) => boolean;
  terminateClient: (client: Client) => void;
  authTimeoutMs?: number;
  createClientId?: () => string;
  controlEventBufferSize?: number;
  heartbeatIntervalMs?: number;
  maxAuthenticatedClients?: number;
  maxMissedPongs?: number;
  agentControlLeaseMs?: number;
}

export interface WebSocketTransport<Client extends WebSocket> {
  authenticateClient: (client: Client, clientId?: string) => boolean;
  broadcast: (message: ServerMessage) => void;
  broadcastControl: (message: ServerMessage) => void;
  cleanupClient: (client: Client) => void;
  claimAgentControl: (client: Client, agentId: string) => boolean;
  getAuthenticatedClientCount: () => number;
  isAuthenticated: (client: Client) => boolean;
  notePong: (client: Client) => void;
  releaseAgentControl: (agentId: string, clientId?: string) => void;
  replayControlEvents: (client: Client, lastSeq?: number) => void;
  scheduleAuthTimeout: (client: Client) => void;
  sendAgentControllers: (client: Client) => void;
  sendMessage: (client: Client, message: ServerMessage) => boolean;
  startHeartbeat: () => void;
  stopHeartbeat: () => void;
}

export function createWebSocketTransport<Client extends WebSocket>(
  options: CreateWebSocketTransportOptions<Client>,
): WebSocketTransport<Client> {
  const authenticatedClients = new Set<Client>();
  const authTimers = new WeakMap<Client, ReturnType<typeof setTimeout>>();
  const clientIds = new WeakMap<Client, string>();
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

  function clearAuthTimer(client: Client): void {
    const timer = authTimers.get(client);
    if (!timer) return;
    clearTimeout(timer);
    authTimers.delete(client);
  }

  function sendSerializedDirect(client: Client, json: string): boolean {
    return options.sendDirectText(client, json);
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

  function releaseClientControls(client: Client): void {
    const clientId = clientIds.get(client);
    if (!clientId) return;

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

  function sendMessage(client: Client, message: ServerMessage): boolean {
    return sendSerializedDirect(client, serializeJson(message));
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

  function authenticateClient(client: Client, clientId?: string): boolean {
    if (!authenticatedClients.has(client) && authenticatedClients.size >= maxAuthenticatedClients) {
      options.closeClient(client, 1013, 'Too many authenticated sessions');
      return false;
    }

    authenticatedClients.add(client);
    clearAuthTimer(client);
    clientMissedPongs.set(client, 0);

    if (!clientIds.get(client)) {
      clientIds.set(client, clientId ?? createClientId());
    }

    return true;
  }

  function cleanupClient(client: Client): void {
    clearAuthTimer(client);
    authenticatedClients.delete(client);
    releaseClientControls(client);
    clientMissedPongs.delete(client);
    clientIds.delete(client);
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

  function claimAgentControl(client: Client, agentId: string): boolean {
    const clientId = clientIds.get(client);
    if (!clientId) return true;

    const current = getAgentController(agentId);
    if (current && current.clientId !== clientId) {
      return false;
    }

    agentControllers.set(agentId, { clientId, touchedAt: Date.now() });
    if (!current || current.clientId !== clientId) {
      broadcastAgentController(agentId, clientId);
    }
    return true;
  }

  function notePong(client: Client): void {
    clientMissedPongs.set(client, 0);
  }

  function getAuthenticatedClientCount(): number {
    return authenticatedClients.size;
  }

  function isAuthenticated(client: Client): boolean {
    return authenticatedClients.has(client);
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
    getAuthenticatedClientCount,
    isAuthenticated,
    notePong,
    releaseAgentControl,
    replayControlEvents,
    scheduleAuthTimeout,
    sendAgentControllers,
    sendMessage,
    startHeartbeat,
    stopHeartbeat,
  };
}
