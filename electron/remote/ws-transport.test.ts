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

    const coverage = transport.replayControlEvents(replay, 0);

    expect(coverage).toEqual({
      lastSeq: 0,
      latestSeq: 1,
      oldestAvailableSeq: 0,
      replayTruncated: false,
    });
    expect(replay.sentDirect).toHaveLength(1);
    expect(JSON.parse(replay.sentDirect[0] ?? '{}')).toMatchObject({
      type: 'remote-status',
      seq: 1,
    });
  });

  it('caps replay at the provided control-event high-water mark', () => {
    const transport = createTransport();
    const replay = createFakeClient();

    expect(transport.getLatestControlEventSeq()).toBe(-1);
    expect(transport.authenticateClient(replay, 'replay').ok).toBe(true);

    transport.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/before-auth',
    });
    const replayHighWaterSeq = transport.getLatestControlEventSeq();
    transport.broadcastControl({
      type: 'remote-status',
      connectedClients: 1,
      peerClients: 0,
    });
    replay.sentDirect = [];

    transport.replayControlEvents(replay, -1, replayHighWaterSeq);

    expect(replay.sentDirect.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({
        seq: 0,
        type: 'git-status-changed',
      }),
    ]);
    expect(transport.getLatestControlEventSeq()).toBe(1);
  });

  it('signals replay truncation when the cursor predates the retained control ring', () => {
    const transport = createTransport({
      controlEventBufferSize: 2,
    });
    const replay = createFakeClient();

    expect(transport.authenticateClient(replay, 'replay').ok).toBe(true);
    transport.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/one',
    });
    transport.broadcastControl({
      type: 'remote-status',
      connectedClients: 1,
      peerClients: 0,
    });
    transport.broadcastControl({
      type: 'task-event',
      event: 'created',
      taskId: 'task-1',
    });
    replay.sentDirect = [];

    const coverage = transport.replayControlEvents(replay, -1);
    const decodedMessages = replay.sentDirect.map((message) => JSON.parse(message));

    expect(coverage).toEqual({
      lastSeq: -1,
      latestSeq: 2,
      oldestAvailableSeq: 1,
      replayTruncated: true,
    });
    // An evicted window is non-contiguous, so no per-event replay follows the
    // truncation signal: gap-detecting legacy clients would misfire on the
    // seq jump (and the remote shell would hard-reconnect in a loop). Old
    // clients answer the signal with a full restore; the current client core
    // adopts latestSeq from it and lets the handshake bootstrap repair state.
    expect(decodedMessages).toEqual([
      {
        type: 'replay-truncated',
        lastSeq: -1,
        latestSeq: 2,
        oldestAvailableSeq: 1,
      },
    ]);
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

describe('control-event ring compaction and batch replay', () => {
  function createCompactingTransport(): WebSocketTransport<FakeClient> {
    return createTransport({
      getControlEventCompactionKey: (message) =>
        message.type === 'coordinator-event'
          ? `coordinator:${(message.event as { entityKey: string }).entityKey}`
          : null,
    });
  }

  function coordinatorEvent(
    entityKey: string,
    payload: unknown,
  ): Parameters<WebSocketTransport<FakeClient>['broadcastControl']>[0] {
    return {
      type: 'coordinator-event',
      event: {
        categorySeq: 1,
        createdAt: 1,
        entityKey,
        entityVersion: 1,
        eventType: 'subtask-upserted',
        payload,
        runId: 'run-1',
      },
    } as Parameters<WebSocketTransport<FakeClient>['broadcastControl']>[0];
  }

  it('keeps only the latest ring entry per compaction key (latest-wins)', () => {
    const transport = createCompactingTransport();
    const client = createFakeClient();
    expect(transport.authenticateClient(client).ok).toBe(true);

    transport.broadcastControl(coordinatorEvent('subtask:t1', { rev: 1 }));
    transport.broadcastControl(coordinatorEvent('subtask:t2', { rev: 1 }));
    transport.broadcastControl(coordinatorEvent('subtask:t1', { rev: 2 }));

    // Ring content is inspected through the batch path: a compacted window is
    // legitimately non-contiguous, so only batch consumers (wholesale toSeq
    // adoption) may replay it event-by-event.
    const replayClient = createFakeClient();
    expect(transport.authenticateClient(replayClient).ok).toBe(true);
    transport.replayControlEvents(replayClient, -1, Number.POSITIVE_INFINITY, { batch: true });

    const frame = JSON.parse(replayClient.sentDirect[replayClient.sentDirect.length - 1] ?? '') as {
      events: Array<{ event?: { entityKey: string; payload: { rev: number } }; type: string }>;
      type: string;
    };
    expect(frame.type).toBe('control-replay-batch');
    const replayedEvents = frame.events.filter((message) => message.type === 'coordinator-event');
    expect(
      replayedEvents.map((message) => [message.event?.entityKey, message.event?.payload.rev]),
    ).toEqual([
      ['subtask:t2', 1],
      ['subtask:t1', 2],
    ]);
  });

  // Legacy clients run per-event gap detection, so a compacted (non-contiguous)
  // window must never be per-event replayed: the remote shell answers a
  // sequence gap with a hard reconnect, and its own reconnect churn keeps
  // re-compacting the window — an infinite reconnect loop. The window degrades
  // to the replay-truncated signal instead.
  it('degrades per-event replay of a compacted window to replay-truncated', () => {
    const transport = createCompactingTransport();
    transport.broadcastControl(coordinatorEvent('subtask:t1', { rev: 1 }));
    transport.broadcastControl(coordinatorEvent('subtask:t2', { rev: 1 }));
    transport.broadcastControl(coordinatorEvent('subtask:t1', { rev: 2 }));

    const replayClient = createFakeClient();
    expect(transport.authenticateClient(replayClient).ok).toBe(true);
    transport.replayControlEvents(replayClient, -1);

    const sent = replayClient.sentDirect.map(
      (json) => JSON.parse(json) as { latestSeq?: number; type: string },
    );
    expect(sent.map((message) => message.type)).toEqual(['replay-truncated']);
    expect(sent[0]?.latestSeq).toBe(transport.getLatestControlEventSeq());
  });

  it('still per-event replays a contiguous window for legacy clients', () => {
    const transport = createCompactingTransport();
    const observer = createFakeClient();
    expect(transport.authenticateClient(observer).ok).toBe(true);
    transport.broadcastControl(coordinatorEvent('subtask:t1', { rev: 1 }));
    const lastSeq = transport.getLatestControlEventSeq();

    // Window after lastSeq: two distinct keys, no compaction inside it.
    transport.broadcastControl(coordinatorEvent('subtask:t2', { rev: 1 }));
    transport.broadcastControl(coordinatorEvent('subtask:t3', { rev: 1 }));

    const replayClient = createFakeClient();
    expect(transport.authenticateClient(replayClient).ok).toBe(true);
    transport.replayControlEvents(replayClient, lastSeq);

    const sent = replayClient.sentDirect.map(
      (json) => JSON.parse(json) as { seq?: number; type: string },
    );
    expect(sent.map((message) => message.type)).toEqual(['coordinator-event', 'coordinator-event']);
    expect(sent.map((message) => message.seq)).toEqual([lastSeq + 1, lastSeq + 2]);
  });

  it('lets a tombstone with the same key supersede the earlier upsert', () => {
    const transport = createTransport({
      getControlEventCompactionKey: (message) =>
        message.type === 'coordinator-event'
          ? `coordinator:${(message.event as { entityKey: string }).entityKey}`
          : null,
    });
    transport.broadcastControl(coordinatorEvent('run:r1', { created: true }));
    transport.broadcastControl({
      type: 'coordinator-event',
      event: {
        categorySeq: 2,
        createdAt: 2,
        entityKey: 'run:r1',
        entityVersion: 2,
        eventType: 'run-removed',
        payload: null,
        runId: 'r1',
        tombstone: true,
      },
    } as Parameters<WebSocketTransport<FakeClient>['broadcastControl']>[0]);

    const replayClient = createFakeClient();
    expect(transport.authenticateClient(replayClient).ok).toBe(true);
    transport.replayControlEvents(replayClient, -1, Number.POSITIVE_INFINITY, { batch: true });

    const frame = JSON.parse(replayClient.sentDirect[replayClient.sentDirect.length - 1] ?? '') as {
      events: Array<{ event?: { eventType: string }; type: string }>;
    };
    const replayed = frame.events.filter((message) => message.type === 'coordinator-event');
    expect(replayed.map((message) => message.event?.eventType)).toEqual(['run-removed']);
  });

  it('never compacts null-key messages', () => {
    const transport = createCompactingTransport();
    transport.broadcastControl({ type: 'task-event', event: 'created', taskId: 'task-1' });
    transport.broadcastControl({ type: 'task-event', event: 'created', taskId: 'task-1' });

    const replayClient = createFakeClient();
    expect(transport.authenticateClient(replayClient).ok).toBe(true);
    transport.replayControlEvents(replayClient, -1);
    expect(replayClient.sentDirect).toHaveLength(2);
  });

  it('sends batched replay as one frame whose inner events are byte-identical to per-event replay', () => {
    const transport = createCompactingTransport();
    transport.broadcastControl(coordinatorEvent('subtask:t1', { rev: 1 }));
    transport.broadcastControl({ type: 'task-event', event: 'created', taskId: 'task-9' });

    const perEventClient = createFakeClient();
    expect(transport.authenticateClient(perEventClient).ok).toBe(true);
    transport.replayControlEvents(perEventClient, -1);

    const batchClient = createFakeClient();
    expect(transport.authenticateClient(batchClient).ok).toBe(true);
    transport.replayControlEvents(batchClient, -1, Number.POSITIVE_INFINITY, { batch: true });

    expect(batchClient.sentDirect).toHaveLength(1);
    const frame = JSON.parse(batchClient.sentDirect[0] ?? '') as {
      events: unknown[];
      toSeq: number;
      type: string;
    };
    expect(frame.type).toBe('control-replay-batch');
    expect(frame.toSeq).toBe(transport.getLatestControlEventSeq());
    expect(frame.events.map((event) => JSON.stringify(event))).toEqual(perEventClient.sentDirect);
  });

  it('sends an empty batch frame adopting the latest seq when nothing was missed', () => {
    const transport = createCompactingTransport();
    transport.broadcastControl(coordinatorEvent('subtask:t1', { rev: 1 }));
    const latestSeq = transport.getLatestControlEventSeq();

    const batchClient = createFakeClient();
    expect(transport.authenticateClient(batchClient).ok).toBe(true);
    transport.replayControlEvents(batchClient, latestSeq, latestSeq, { batch: true });

    expect(batchClient.sentDirect).toHaveLength(1);
    expect(JSON.parse(batchClient.sentDirect[0] ?? '')).toEqual({
      events: [],
      toSeq: latestSeq,
      type: 'control-replay-batch',
    });
  });

  it('caps the batched replay at the provided high-water mark and orders truncation first', () => {
    const transport = createTransport({
      controlEventBufferSize: 2,
      getControlEventCompactionKey: () => null,
    });
    for (let index = 0; index < 5; index += 1) {
      transport.broadcastControl({ type: 'task-event', event: 'created', taskId: `task-${index}` });
    }

    const batchClient = createFakeClient();
    expect(transport.authenticateClient(batchClient).ok).toBe(true);
    transport.replayControlEvents(batchClient, 0, 3, { batch: true });

    expect(batchClient.sentDirect).toHaveLength(2);
    const truncated = JSON.parse(batchClient.sentDirect[0] ?? '') as { type: string };
    expect(truncated.type).toBe('replay-truncated');
    const frame = JSON.parse(batchClient.sentDirect[1] ?? '') as {
      events: Array<{ seq: number }>;
      toSeq: number;
      type: string;
    };
    expect(frame.type).toBe('control-replay-batch');
    expect(frame.toSeq).toBe(3);
    expect(frame.events.map((event) => event.seq)).toEqual([3]);
  });
});
