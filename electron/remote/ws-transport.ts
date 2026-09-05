import { randomBytes } from 'crypto';
import { WebSocket } from 'ws';
import { assertNever } from '../../src/lib/assert-never.js';
import type { ReplayTruncatedMessage, ServerMessage } from './protocol.js';

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
  /**
   * Replay-ring compaction key. Only legal for message classes whose events
   * are full-replace snapshots per key: a newer event with the same key
   * supersedes the older ring entry (latest-wins), so replay never ships dead
   * intermediate snapshots. Return null (the default) to never compact.
   */
  getControlEventCompactionKey?: (message: ServerMessage) => string | null;
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

export interface AuthenticateClientOptions {
  /**
   * Grants this socket access to the transport's sequenced control stream.
   * Scoped remote transports use that stream only for terminal-read events;
   * full browser and legacy transports retain the default access.
   */
  receiveControlEvents?: boolean;
}

export interface ControlReplayCoverage {
  lastSeq: number;
  latestSeq: number;
  oldestAvailableSeq: number | null;
  replayTruncated: boolean;
}

export interface ReplayControlEventsOptions {
  /**
   * Send the replay as one control-replay-batch frame whose toSeq the client
   * adopts wholesale (compaction makes inner seqs non-contiguous). The inner
   * event ordering is byte-identical to the unbatched per-event path.
   */
  batch?: boolean;
}

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
  authenticateClient: (
    client: Client,
    clientId?: string,
    options?: AuthenticateClientOptions,
  ) => AuthenticateClientResult;
  broadcast: (message: ServerMessage) => void;
  broadcastControl: (message: ServerMessage) => void;
  cleanupClient: (client: Client) => void;
  claimAgentControl: (client: Client, agentId: string) => ClaimAgentControlResult;
  getAgentControllerId: (agentId: string) => string | null;
  getClientId: (client: Client) => string | null;
  getClientsById: (clientId: string) => Client[];
  getAuthenticatedClientCount: () => number;
  getLatestControlEventSeq: () => number;
  hasClientId: (clientId: string) => boolean;
  isAuthenticated: (client: Client) => boolean;
  notePong: (client: Client) => void;
  releaseAgentControl: (agentId: string, clientId?: string) => void;
  replayControlEvents: (
    client: Client,
    lastSeq?: number,
    maxSeq?: number,
    options?: ReplayControlEventsOptions,
  ) => ControlReplayCoverage;
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
  const controlEventAccess = new WeakMap<Client, boolean>();
  const clientsByClientId = new Map<string, Set<Client>>();
  const clientMissedPongs = new WeakMap<Client, number>();
  const agentControllers = new Map<string, AgentControllerLease>();
  const controlEventRingBuffer: Array<{ seq: number; json: string; key: string | null }> = [];

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

  function addControlEvent(seq: number, json: string, key: string | null): void {
    if (key !== null) {
      const supersededIndex = controlEventRingBuffer.findIndex((entry) => entry.key === key);
      if (supersededIndex !== -1) {
        controlEventRingBuffer.splice(supersededIndex, 1);
      }
    }

    controlEventRingBuffer.push({ seq, json, key });
    while (controlEventRingBuffer.length > controlEventBufferSize) {
      controlEventRingBuffer.shift();
    }
  }

  function getOldestAvailableControlEventSeq(): number | null {
    return controlEventRingBuffer[0]?.seq ?? null;
  }

  function getReplayCoverage(lastSeq: number, maxSeq: number): ControlReplayCoverage {
    const latestSeq = getLatestControlEventSeq();
    const latestReplayableSeq = Math.min(latestSeq, maxSeq);
    const oldestAvailableSeq = getOldestAvailableControlEventSeq();
    const replayTruncated =
      oldestAvailableSeq !== null &&
      latestReplayableSeq > lastSeq &&
      lastSeq < oldestAvailableSeq - 1;

    return {
      lastSeq,
      latestSeq,
      oldestAvailableSeq,
      replayTruncated,
    };
  }

  function createReplayTruncatedMessage(
    coverage: ControlReplayCoverage,
  ): ReplayTruncatedMessage | null {
    if (!coverage.replayTruncated || coverage.oldestAvailableSeq === null) {
      return null;
    }

    return {
      type: 'replay-truncated',
      lastSeq: coverage.lastSeq,
      latestSeq: coverage.latestSeq,
      oldestAvailableSeq: coverage.oldestAvailableSeq,
    };
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

    addControlEvent(seq, json, options.getControlEventCompactionKey?.(message) ?? null);
    for (const client of authenticatedClients) {
      if (controlEventAccess.get(client) === true) {
        options.sendBroadcastText(client, json);
      }
    }
  }

  function replayControlEventsBatched(
    client: Client,
    lastSeq: number,
    maxSeq: number,
    coverage: ControlReplayCoverage,
  ): void {
    const replayedJsons: string[] = [];
    for (const event of controlEventRingBuffer) {
      if (event.seq > maxSeq) {
        break;
      }

      if (event.seq > lastSeq) {
        replayedJsons.push(event.json);
      }
    }

    const toSeq = Math.min(coverage.latestSeq, maxSeq);
    // The stored raw json strings are embedded as-is, so inner-event bytes and
    // ordering are identical to the unbatched per-event replay path.
    sendSerializedDirect(
      client,
      `{"type":"control-replay-batch","toSeq":${toSeq},"events":[${replayedJsons.join(',')}]}`,
    );
  }

  // Per-event replay is only legal for a gap-free window: legacy clients run
  // per-event sequence-gap detection, so replaying a window with holes (ring
  // eviction or latest-wins compaction) would misfire it on every reconnect —
  // the remote shell turns that into a hard reconnect and its own churn keeps
  // re-compacting the window, which loops forever. Batch frames are exempt:
  // their consumers adopt toSeq wholesale.
  function isWindowPerEventReplayable(lastSeq: number, latestReplayableSeq: number): boolean {
    if (latestReplayableSeq <= lastSeq) {
      return true;
    }

    let windowEventCount = 0;
    for (const event of controlEventRingBuffer) {
      if (event.seq > latestReplayableSeq) {
        break;
      }

      if (event.seq > lastSeq) {
        windowEventCount += 1;
      }
    }

    return windowEventCount === latestReplayableSeq - lastSeq;
  }

  function createCompactedWindowTruncatedMessage(
    coverage: ControlReplayCoverage,
  ): ReplayTruncatedMessage | null {
    if (coverage.oldestAvailableSeq === null) {
      return null;
    }

    return {
      type: 'replay-truncated',
      lastSeq: coverage.lastSeq,
      latestSeq: coverage.latestSeq,
      oldestAvailableSeq: coverage.oldestAvailableSeq,
    };
  }

  function replayControlEvents(
    client: Client,
    lastSeq = -1,
    maxSeq = Number.POSITIVE_INFINITY,
    replayOptions: ReplayControlEventsOptions = {},
  ): ControlReplayCoverage {
    const coverage = getReplayCoverage(lastSeq, maxSeq);
    if (controlEventAccess.get(client) !== true) {
      return coverage;
    }
    const replayTruncatedMessage = createReplayTruncatedMessage(coverage);
    if (
      replayTruncatedMessage &&
      !sendSerializedDirect(client, serializeJson(replayTruncatedMessage))
    ) {
      return coverage;
    }

    if (replayOptions.batch === true) {
      replayControlEventsBatched(client, lastSeq, maxSeq, coverage);
      return coverage;
    }

    const latestReplayableSeq = Math.min(coverage.latestSeq, maxSeq);
    if (!isWindowPerEventReplayable(lastSeq, latestReplayableSeq)) {
      // A compacted window cannot be replayed per-event without tripping the
      // client's gap detection. Degrade to the replay-truncated signal (if
      // eviction did not already send it): old clients answer it with a full
      // restore, and the current client core adopts latestSeq from it so live
      // traffic continues gap-free while the handshake bootstrap repairs
      // state.
      if (!replayTruncatedMessage) {
        const compactedWindowMessage = createCompactedWindowTruncatedMessage(coverage);
        if (compactedWindowMessage) {
          sendSerializedDirect(client, serializeJson(compactedWindowMessage));
        }
      }

      return coverage;
    }

    for (const event of controlEventRingBuffer) {
      if (event.seq > maxSeq) {
        return coverage;
      }

      if (event.seq > lastSeq && !sendSerializedDirect(client, event.json)) {
        return coverage;
      }
    }

    return coverage;
  }

  function sendAgentControllers(client: Client): void {
    if (controlEventAccess.get(client) !== true) return;
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

  function authenticateClient(
    client: Client,
    clientId?: string,
    authenticationOptions: AuthenticateClientOptions = {},
  ): AuthenticateClientResult {
    if (!authenticatedClients.has(client) && authenticatedClients.size >= maxAuthenticatedClients) {
      options.closeClient(client, 1013, 'Too many authenticated sessions');
      return { ok: false, reason: 'client-cap-reached' };
    }

    const wasAuthenticated = authenticatedClients.has(client);
    controlEventAccess.set(client, authenticationOptions.receiveControlEvents !== false);
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
    controlEventAccess.delete(client);
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

  function getAgentControllerId(agentId: string): string | null {
    return getAgentController(agentId)?.clientId ?? null;
  }

  function notePong(client: Client): void {
    clientMissedPongs.set(client, 0);
  }

  function getAuthenticatedClientCount(): number {
    return authenticatedClients.size;
  }

  function getLatestControlEventSeq(): number {
    return controlEventSeq - 1;
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

  function getClientsById(clientId: string): Client[] {
    return [...(clientsByClientId.get(clientId) ?? [])];
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
    getAgentControllerId,
    getClientId,
    getClientsById,
    getAuthenticatedClientCount,
    getLatestControlEventSeq,
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
