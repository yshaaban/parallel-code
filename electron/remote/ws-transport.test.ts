import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  createWebSocketTransport,
  type CreateWebSocketTransportOptions,
  type SendTextResult,
  type WebSocketTransport,
} from './ws-transport.js';

interface FakeClient extends WebSocket {
  closeEvents: Array<{ code: number; reason: string }>;
  pingCount: number;
  sentBroadcast: string[];
  sentDirect: string[];
  terminated: boolean;
}

function getSendTextResult(client: FakeClient): SendTextResult {
  if (client.readyState === WebSocket.OPEN) {
    return { ok: true };
  }

  return { ok: false, reason: 'not-open' };
}

function getCloseReason(reason?: string | Buffer): string {
  if (typeof reason === 'string') return reason;
  return reason?.toString() ?? '';
}

function createFakeClient(): FakeClient {
  const client = {} as FakeClient;
  const mutableClient = client as FakeClient & { readyState: number };

  Object.defineProperty(client, 'readyState', {
    configurable: true,
    value: WebSocket.OPEN,
    writable: true,
  });

  Object.assign(client, {
    closeEvents: [],
    pingCount: 0,
    sentBroadcast: [],
    sentDirect: [],
    terminated: false,
    close(code?: number, reason?: string | Buffer): void {
      client.closeEvents.push({
        code: code ?? 1000,
        reason: getCloseReason(reason),
      });
      mutableClient.readyState = WebSocket.CLOSING;
    },
    ping(): void {
      client.pingCount += 1;
    },
    terminate(): void {
      client.terminated = true;
      mutableClient.readyState = WebSocket.CLOSED;
    },
  });

  return client;
}

function createTransport(
  overrides: Partial<CreateWebSocketTransportOptions<FakeClient>> = {},
): WebSocketTransport<FakeClient> {
  return createWebSocketTransport<FakeClient>({
    closeClient: (client, code, reason) => {
      client.close(code, reason);
    },
    sendBroadcastText: (client, text) => {
      client.sentBroadcast.push(text);
      return getSendTextResult(client);
    },
    sendDirectText: (client, text) => {
      client.sentDirect.push(text);
      return getSendTextResult(client);
    },
    terminateClient: (client) => {
      client.terminate();
    },
    ...overrides,
  });
}

describe('createWebSocketTransport', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('rejects authentication beyond the configured client cap', () => {
    const transport = createTransport({
      maxAuthenticatedClients: 1,
    });
    const first = createFakeClient();
    const second = createFakeClient();

    expect(transport.authenticateClient(first, 'first')).toMatchObject({
      ok: true,
      clientId: 'first',
    });
    expect(transport.authenticateClient(second, 'second')).toMatchObject({
      ok: false,
      reason: 'client-cap-reached',
    });
    expect(second.closeEvents).toEqual([{ code: 1013, reason: 'Too many authenticated sessions' }]);
  });

  it('replays only control events newer than the provided cursor', () => {
    const transport = createTransport();
    const first = createFakeClient();
    const replay = createFakeClient();

    expect(transport.authenticateClient(first, 'first').ok).toBe(true);
    expect(transport.authenticateClient(replay, 'replay').ok).toBe(true);
    replay.sentDirect = [];

    transport.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/one',
    });
    transport.broadcastControl({
      type: 'remote-status',
      connectedClients: 2,
      peerClients: 1,
    });

    transport.replayControlEvents(replay, 0);

    expect(replay.sentDirect).toHaveLength(1);
    expect(JSON.parse(replay.sentDirect[0] ?? '{}')).toMatchObject({
      type: 'remote-status',
      seq: 1,
    });
  });

  it('broadcasts controller acquisition and release through shared lease state', () => {
    const transport = createTransport();
    const controller = createFakeClient();
    const observer = createFakeClient();

    expect(transport.authenticateClient(controller, 'controller').ok).toBe(true);
    expect(transport.authenticateClient(observer, 'observer').ok).toBe(true);

    expect(transport.claimAgentControl(controller, 'agent-1')).toMatchObject({
      ok: true,
      controllerId: 'controller',
    });
    expect(transport.claimAgentControl(observer, 'agent-1')).toMatchObject({
      ok: false,
      reason: 'controlled-by-peer',
      controllerId: 'controller',
    });

    const claimed = JSON.parse(observer.sentBroadcast[0] ?? '{}');
    expect(claimed).toMatchObject({
      type: 'agent-controller',
      agentId: 'agent-1',
      controllerId: 'controller',
      seq: 0,
    });

    transport.cleanupClient(controller);

    const released = JSON.parse(observer.sentBroadcast[1] ?? '{}');
    expect(released).toMatchObject({
      type: 'agent-controller',
      agentId: 'agent-1',
      controllerId: null,
      seq: 1,
    });
  });

  it('returns an explicit unauthenticated result when claiming control before auth', () => {
    const transport = createTransport();
    const client = createFakeClient();

    expect(transport.claimAgentControl(client, 'agent-1')).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
  });

  it('terminates stale clients through the shared heartbeat loop', async () => {
    vi.useFakeTimers();
    const onAuthenticatedClientCountChanged = vi.fn();
    const transport = createTransport({
      heartbeatIntervalMs: 50,
      maxMissedPongs: 1,
      onAuthenticatedClientCountChanged,
    });
    const client = createFakeClient();

    expect(transport.authenticateClient(client, 'heartbeat').ok).toBe(true);
    expect(onAuthenticatedClientCountChanged).toHaveBeenCalledWith(1);
    transport.startHeartbeat();

    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(client.pingCount).toBe(1);
      expect(client.terminated).toBe(false);

      await vi.advanceTimersByTimeAsync(50);
      expect(client.terminated).toBe(true);
      expect(transport.getAuthenticatedClientCount()).toBe(0);
      expect(onAuthenticatedClientCountChanged).toHaveBeenLastCalledWith(0);
    } finally {
      transport.stopHeartbeat();
      vi.clearAllTimers();
    }
  });
});
