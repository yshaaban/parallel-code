import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attachReconnectHandshakeByteCounter } from '../harness/reconnect-byte-counter';
import {
  createBrowserControlPlaneContractHarness,
  getSequencedMessages,
  type WebSocketContractHarness,
} from '../harness/websocket-contract-harness';

function broadcastBlipWindowEvents(harness: WebSocketContractHarness): void {
  harness.broadcastControl({
    type: 'agent-controller',
    agentId: 'agent-1',
    controllerId: 'alpha',
  });
  harness.broadcastControl({
    type: 'task-event',
    event: 'created',
    taskId: 'task-1',
    name: 'Delta resync task',
  });
}

describe('delta-resync reconnect byte-counting harness', () => {
  let harness: WebSocketContractHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = createBrowserControlPlaneContractHarness();
  });

  afterEach(() => {
    harness.dispose();
    vi.useRealTimers();
  });

  it('counts socket bytes between re-auth and handshake-complete for a blip reconnect', async () => {
    const firstConnection = harness.createClient();
    expect(harness.authenticateConnection(firstConnection, 'blip-client', -1)).toBe(true);
    await harness.flush();

    const lastSeq = getSequencedMessages(harness, firstConnection).reduce(
      (highest, message) => Math.max(highest, message.seq),
      -1,
    );
    broadcastBlipWindowEvents(harness);
    await harness.flush();
    harness.cleanupClient(firstConnection);

    const reconnectConnection = harness.createClient();
    const byteCounter = attachReconnectHandshakeByteCounter(reconnectConnection);
    expect(byteCounter.getTotalBytes()).toBe(0);

    byteCounter.begin();
    expect(harness.authenticateConnection(reconnectConnection, 'blip-client', lastSeq)).toBe(true);
    await harness.flush();

    expect(byteCounter.isHandshakeComplete()).toBe(true);
    expect(byteCounter.isCounting()).toBe(false);
    expect(byteCounter.getTotalBytes()).toBeGreaterThan(0);
    expect(byteCounter.getMessageCount()).toBeGreaterThan(0);

    const bytesByMessageType = byteCounter.getBytesByMessageType();
    expect(bytesByMessageType['state-bootstrap']).toBeGreaterThan(0);
    expect(bytesByMessageType['agent-controller']).toBeGreaterThan(0);
    expect(bytesByMessageType['task-event']).toBeGreaterThan(0);

    const handshakeBytes = byteCounter.getTotalBytes();
    broadcastBlipWindowEvents(harness);
    await harness.flush();
    expect(byteCounter.getTotalBytes()).toBe(handshakeBytes);

    process.stdout.write(
      `[delta-resync] blip-reconnect handshake bytes=${handshakeBytes} messages=${byteCounter.getMessageCount()} byType=${JSON.stringify(bytesByMessageType)}\n`,
    );
    byteCounter.detach();
  });

  it('keeps pre-window and detached sends out of the counted handshake bytes', async () => {
    const connection = harness.createClient();
    const byteCounter = attachReconnectHandshakeByteCounter(connection);

    expect(harness.authenticateConnection(connection, 'idle-client', -1)).toBe(true);
    await harness.flush();
    expect(byteCounter.getTotalBytes()).toBe(0);
    expect(byteCounter.isHandshakeComplete()).toBe(false);

    byteCounter.detach();
    byteCounter.begin();
    broadcastBlipWindowEvents(harness);
    await harness.flush();
    expect(byteCounter.getTotalBytes()).toBe(0);
  });
});

import {
  addCoordinatorSubtask,
  createCoordinatorRun,
  getCoordinatorStateVersion,
  resetCoordinatorRuntimeForTests,
  updateCoordinatorSubtaskStatus,
} from '../../electron/coordinator/runtime';
import { getServerInstanceId } from '../../electron/ipc/server-instance';
import {
  SERVER_STATE_BOOTSTRAP_CATEGORIES,
  type ServerStateBootstrapCategory,
} from '../../src/domain/server-state-bootstrap';
import { getMessagesOfType, type FakeWebSocketClient } from '../harness/websocket-contract-harness';

const BLIP_RECONNECT_BYTE_BUDGET = 5 * 1024;

interface BootstrapSnapshotLike {
  category: ServerStateBootstrapCategory;
  version: number;
}

function getBootstrapMessages(
  harness: WebSocketContractHarness,
  client: FakeWebSocketClient,
): Array<{ serverInstanceId?: string; snapshots: BootstrapSnapshotLike[] }> {
  return getMessagesOfType(harness, client, 'state-bootstrap').map((message) => ({
    ...(typeof message.serverInstanceId === 'string'
      ? { serverInstanceId: message.serverInstanceId }
      : {}),
    snapshots: (message.snapshots as BootstrapSnapshotLike[] | undefined) ?? [],
  }));
}

function seedTwelveTaskCoordinatorFixture(harness: WebSocketContractHarness): { runId: string } {
  const run = createCoordinatorRun({
    coordinatorTaskId: 'task-coordinator',
    projectId: 'project-1',
    projectMode: 'git',
    projectRoot: '/repo',
  });
  const assignment = `Implement the feature end to end. ${'Detail. '.repeat(400)}`;
  for (let index = 0; index < 12; index += 1) {
    const subtask = addCoordinatorSubtask({
      agentId: `agent-${index}`,
      assignment,
      parentCoordinatorTaskId: 'task-coordinator',
      runId: run.id,
      status: 'running',
      taskId: `task-${index}`,
      toolTokenId: `token-${index}`,
      worktreePath: `/repo/task-${index}`,
    });
    harness.broadcastControl({
      type: 'coordinator-event',
      event: {
        categorySeq: getCoordinatorStateVersion(),
        createdAt: Date.now(),
        entityKey: `subtask:${subtask.taskId}`,
        entityVersion: getCoordinatorStateVersion(),
        eventType: 'subtask-upserted',
        payload: subtask,
        runId: run.id,
      },
    });
  }
  return { runId: run.id };
}

interface ObservedClientResyncState {
  agentsVersion: number | undefined;
  categoryVersions: Record<string, number>;
  lastSeq: number;
  serverInstanceId: string | undefined;
}

// Builds the resync state a real client would have tracked: per-category
// versions from the bootstrap snapshots, the agents version from the agents
// message, the serverInstanceId from the bootstrap, and the highest seq seen.
function observeClientResyncState(
  harness: WebSocketContractHarness,
  client: FakeWebSocketClient,
): ObservedClientResyncState {
  const bootstrap = getBootstrapMessages(harness, client)[0];
  if (!bootstrap) {
    throw new Error('Expected an initial state-bootstrap message');
  }

  const categoryVersions: Record<string, number> = {};
  for (const snapshot of bootstrap.snapshots) {
    if (typeof snapshot.version === 'number') {
      categoryVersions[snapshot.category] = snapshot.version;
    }
  }

  const agentsMessage = getMessagesOfType(harness, client, 'agents')[0];
  const lastSeq = getSequencedMessages(harness, client).reduce(
    (highest, message) => Math.max(highest, message.seq),
    -1,
  );

  return {
    agentsVersion: typeof agentsMessage?.version === 'number' ? agentsMessage.version : undefined,
    categoryVersions,
    lastSeq,
    serverInstanceId: bootstrap.serverInstanceId,
  };
}

describe('version-gated delta resync contract', () => {
  let harness: WebSocketContractHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    resetCoordinatorRuntimeForTests();
    harness = createBrowserControlPlaneContractHarness();
  });

  afterEach(() => {
    harness.dispose();
    resetCoordinatorRuntimeForTests();
    vi.useRealTimers();
  });

  async function connectAndObserve(clientId: string): Promise<ObservedClientResyncState> {
    const connection = harness.createClient();
    expect(harness.authenticateConnection(connection, clientId, -1)).toBe(true);
    await harness.flush();
    const observed = observeClientResyncState(harness, connection);
    harness.cleanupClient(connection);
    return observed;
  }

  it('keeps a 2s-blip reconnect with no changes under the 5KB byte budget', async () => {
    seedTwelveTaskCoordinatorFixture(harness);
    const observed = await connectAndObserve('blip-client');
    expect(observed.serverInstanceId).toBe(getServerInstanceId());

    const reconnect = harness.createClient();
    const byteCounter = attachReconnectHandshakeByteCounter(reconnect);
    byteCounter.begin();
    expect(
      harness.authenticateConnection(reconnect, 'blip-client', observed.lastSeq, {
        ...(observed.agentsVersion !== undefined ? { agentsVersion: observed.agentsVersion } : {}),
        categoryVersions: observed.categoryVersions,
        ...(observed.serverInstanceId !== undefined
          ? { serverInstanceId: observed.serverInstanceId }
          : {}),
      }),
    ).toBe(true);
    await harness.flush();

    expect(byteCounter.isHandshakeComplete()).toBe(true);
    const totalBytes = byteCounter.getTotalBytes();
    expect(totalBytes).toBeLessThan(BLIP_RECONNECT_BYTE_BUDGET);

    // Only the ephemeral connection-scoped categories ride along; no agents
    // list and no per-boot category payloads are resent.
    const bootstrap = getBootstrapMessages(harness, reconnect)[0];
    const resentCategories = (bootstrap?.snapshots ?? []).map((snapshot) => snapshot.category);
    expect(resentCategories.sort()).toEqual(['peer-presence', 'remote-status']);
    expect(getMessagesOfType(harness, reconnect, 'agents')).toHaveLength(0);

    process.stdout.write(
      `[delta-resync] no-change blip reconnect bytes=${totalBytes} byType=${JSON.stringify(byteCounter.getBytesByMessageType())}\n`,
    );
    byteCounter.detach();
  });

  it('resends only the stale coordinator category after a disconnected-window mutation', async () => {
    const { runId } = seedTwelveTaskCoordinatorFixture(harness);
    const observed = await connectAndObserve('stale-category-client');

    // Coordinator mutation while the client is disconnected bumps only the
    // coordinator category version.
    const mutated = updateCoordinatorSubtaskStatus(runId, 'task-3', 'ready-for-review');
    harness.broadcastControl({
      type: 'coordinator-event',
      event: {
        categorySeq: getCoordinatorStateVersion(),
        createdAt: Date.now(),
        entityKey: 'subtask:task-3',
        entityVersion: getCoordinatorStateVersion(),
        eventType: 'subtask-upserted',
        payload: mutated,
        runId,
      },
    });
    await harness.flush();

    const reconnect = harness.createClient();
    expect(
      harness.authenticateConnection(reconnect, 'stale-category-client', observed.lastSeq, {
        ...(observed.agentsVersion !== undefined ? { agentsVersion: observed.agentsVersion } : {}),
        categoryVersions: observed.categoryVersions,
        ...(observed.serverInstanceId !== undefined
          ? { serverInstanceId: observed.serverInstanceId }
          : {}),
      }),
    ).toBe(true);
    await harness.flush();

    const bootstrap = getBootstrapMessages(harness, reconnect)[0];
    const resentCategories = (bootstrap?.snapshots ?? []).map((snapshot) => snapshot.category);
    expect(resentCategories.sort()).toEqual(['coordinator', 'peer-presence', 'remote-status']);
  });

  it('replays the blip window as one control-replay-batch frame for resync clients', async () => {
    const { runId } = seedTwelveTaskCoordinatorFixture(harness);
    const observed = await connectAndObserve('batch-client');

    const mutated = updateCoordinatorSubtaskStatus(runId, 'task-5', 'ready-for-review');
    harness.broadcastControl({
      type: 'coordinator-event',
      event: {
        categorySeq: getCoordinatorStateVersion(),
        createdAt: Date.now(),
        entityKey: 'subtask:task-5',
        entityVersion: getCoordinatorStateVersion(),
        eventType: 'subtask-upserted',
        payload: mutated,
        runId,
      },
    });
    await harness.flush();

    const reconnect = harness.createClient();
    expect(
      harness.authenticateConnection(reconnect, 'batch-client', observed.lastSeq, {
        categoryVersions: observed.categoryVersions,
        ...(observed.serverInstanceId !== undefined
          ? { serverInstanceId: observed.serverInstanceId }
          : {}),
      }),
    ).toBe(true);
    await harness.flush();

    const batchFrames = getMessagesOfType(harness, reconnect, 'control-replay-batch');
    expect(batchFrames).toHaveLength(1);
    const frame = batchFrames[0] as unknown as { events: unknown[]; toSeq: number };
    expect(frame.events.length).toBeGreaterThanOrEqual(1);
    expect(frame.toSeq).toBeGreaterThan(observed.lastSeq);
    // No per-event sequenced replay rides alongside the batch frame before the
    // bootstrap: the frame is the entire replay.
    const sequencedBeforeBootstrap = getSequencedMessages(harness, reconnect).filter(
      (message) => message.seq <= frame.toSeq && message.type === 'coordinator-event',
    );
    expect(sequencedBeforeBootstrap).toHaveLength(0);
  });

  it('falls back to the full bootstrap path when the server instance id changed', async () => {
    seedTwelveTaskCoordinatorFixture(harness);
    const observed = await connectAndObserve('restart-client');

    const reconnect = harness.createClient();
    expect(
      harness.authenticateConnection(reconnect, 'restart-client', observed.lastSeq, {
        categoryVersions: observed.categoryVersions,
        serverInstanceId: 'a-previous-server-process',
      }),
    ).toBe(true);
    await harness.flush();

    const bootstrap = getBootstrapMessages(harness, reconnect)[0];
    expect(bootstrap?.snapshots).toHaveLength(SERVER_STATE_BOOTSTRAP_CATEGORIES.length);
    expect(getMessagesOfType(harness, reconnect, 'agents')).toHaveLength(1);
    expect(getMessagesOfType(harness, reconnect, 'control-replay-batch')).toHaveLength(0);
  });

  // A compacted window is legitimately non-contiguous, and legacy clients run
  // per-event gap detection (the remote shell answers a gap with a hard
  // reconnect whose own churn re-compacts the window — an infinite loop). The
  // server must degrade a non-contiguous window to the replay-truncated
  // signal instead of per-event replaying it.
  it('never per-event replays a compacted window to a legacy client', async () => {
    const { runId } = seedTwelveTaskCoordinatorFixture(harness);
    const observed = await connectAndObserve('legacy-compacted-client');

    // Two mutations of the same subtask during the blip: latest-wins
    // compaction leaves a hole in the legacy replay window.
    for (const status of ['ready-for-review', 'running'] as const) {
      const mutated = updateCoordinatorSubtaskStatus(runId, 'task-4', status);
      harness.broadcastControl({
        type: 'coordinator-event',
        event: {
          categorySeq: getCoordinatorStateVersion(),
          createdAt: Date.now(),
          entityKey: 'subtask:task-4',
          entityVersion: getCoordinatorStateVersion(),
          eventType: 'subtask-upserted',
          payload: mutated,
          runId,
        },
      });
    }
    await harness.flush();

    const reconnect = harness.createClient();
    expect(
      harness.authenticateConnection(reconnect, 'legacy-compacted-client', observed.lastSeq),
    ).toBe(true);
    await harness.flush();

    const truncated = getMessagesOfType(harness, reconnect, 'replay-truncated');
    expect(truncated).toHaveLength(1);
    expect((truncated[0] as unknown as { latestSeq: number }).latestSeq).toBeGreaterThan(
      observed.lastSeq,
    );
    // No holey per-event replay rides along; the full bootstrap repairs state.
    const replayedCoordinatorEvents = getMessagesOfType(
      harness,
      reconnect,
      'coordinator-event',
    ).filter(
      (message) =>
        typeof (message as { seq?: unknown }).seq === 'number' &&
        (message as { seq: number }).seq > observed.lastSeq &&
        (message as { seq: number }).seq <=
          (truncated[0] as unknown as { latestSeq: number }).latestSeq,
    );
    expect(replayedCoordinatorEvents).toHaveLength(0);
    const bootstrap = getBootstrapMessages(harness, reconnect)[0];
    expect(bootstrap?.snapshots).toHaveLength(SERVER_STATE_BOOTSTRAP_CATEGORIES.length);
  });

  it('keeps the legacy client contract: full bootstrap and per-event replay', async () => {
    const { runId } = seedTwelveTaskCoordinatorFixture(harness);
    const observed = await connectAndObserve('legacy-client');

    const mutated = updateCoordinatorSubtaskStatus(runId, 'task-7', 'ready-for-review');
    harness.broadcastControl({
      type: 'coordinator-event',
      event: {
        categorySeq: getCoordinatorStateVersion(),
        createdAt: Date.now(),
        entityKey: 'subtask:task-7',
        entityVersion: getCoordinatorStateVersion(),
        eventType: 'subtask-upserted',
        payload: mutated,
        runId,
      },
    });
    await harness.flush();

    const reconnect = harness.createClient();
    const byteCounter = attachReconnectHandshakeByteCounter(reconnect);
    byteCounter.begin();
    expect(harness.authenticateConnection(reconnect, 'legacy-client', observed.lastSeq)).toBe(true);
    await harness.flush();
    process.stdout.write(
      `[delta-resync] legacy full-bootstrap reconnect bytes=${byteCounter.getTotalBytes()} (same 12-subtask fixture)\n`,
    );
    byteCounter.detach();

    const bootstrap = getBootstrapMessages(harness, reconnect)[0];
    expect(bootstrap?.snapshots).toHaveLength(SERVER_STATE_BOOTSTRAP_CATEGORIES.length);
    expect(getMessagesOfType(harness, reconnect, 'control-replay-batch')).toHaveLength(0);
    const replayedCoordinatorEvents = getMessagesOfType(
      harness,
      reconnect,
      'coordinator-event',
    ).filter(
      (message) =>
        typeof (message as { seq?: unknown }).seq === 'number' &&
        ((message as { seq: number }).seq as number) > observed.lastSeq,
    );
    expect(replayedCoordinatorEvents.length).toBeGreaterThanOrEqual(1);
  });

  // Lesson 28 proof for the coordinator run keys: run-meta-upserted is a
  // partial payload (run scalars only), so it must never supersede the
  // run-upserted creation snapshot in the ring. It compacts on its own per-run
  // slot; a client whose lastSeq predates the run's creation still replays the
  // full creation event before the meta, so the replayed run keeps its
  // collections without leaning on the bootstrap repair.
  it('keeps the run creation snapshot in the replay ring when run meta mutates during the blip', async () => {
    seedTwelveTaskCoordinatorFixture(harness);
    const observed = await connectAndObserve('run-meta-client');

    // Run created AND meta-mutated entirely inside the blip window.
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator-2',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    harness.broadcastControl({
      type: 'coordinator-event',
      event: {
        categorySeq: getCoordinatorStateVersion(),
        createdAt: Date.now(),
        entityKey: `run:${run.id}`,
        entityVersion: getCoordinatorStateVersion(),
        eventType: 'run-upserted',
        payload: run,
        runId: run.id,
      },
    });
    const subtask = addCoordinatorSubtask({
      agentId: 'agent-blip',
      assignment: 'Created during the blip',
      parentCoordinatorTaskId: 'task-coordinator-2',
      runId: run.id,
      status: 'running',
      taskId: 'task-blip',
      toolTokenId: 'token-blip',
      worktreePath: '/repo/task-blip',
    });
    harness.broadcastControl({
      type: 'coordinator-event',
      event: {
        categorySeq: getCoordinatorStateVersion(),
        createdAt: Date.now(),
        entityKey: `subtask:${subtask.taskId}`,
        entityVersion: getCoordinatorStateVersion(),
        eventType: 'subtask-upserted',
        payload: subtask,
        runId: run.id,
      },
    });
    for (const status of ['paused-by-user', 'running'] as const) {
      harness.broadcastControl({
        type: 'coordinator-event',
        event: {
          categorySeq: getCoordinatorStateVersion(),
          createdAt: Date.now(),
          entityKey: `run:${run.id}`,
          entityVersion: getCoordinatorStateVersion(),
          eventType: 'run-meta-upserted',
          payload: { id: run.id, status },
          runId: run.id,
        },
      });
    }
    await harness.flush();

    const reconnect = harness.createClient();
    expect(
      harness.authenticateConnection(reconnect, 'run-meta-client', observed.lastSeq, {
        categoryVersions: observed.categoryVersions,
        ...(observed.serverInstanceId !== undefined
          ? { serverInstanceId: observed.serverInstanceId }
          : {}),
      }),
    ).toBe(true);
    await harness.flush();

    const frame = getMessagesOfType(harness, reconnect, 'control-replay-batch')[0] as unknown as {
      events: Array<{ event?: { eventType?: string; runId?: string } }>;
    };
    const replayedRunEventTypes = frame.events
      .filter((message) => message.event?.runId === run.id)
      .map((message) => message.event?.eventType);
    // The creation snapshot survives the meta mutations...
    expect(replayedRunEventTypes).toContain('run-upserted');
    expect(replayedRunEventTypes).toContain('subtask-upserted');
    // ...and the metas still compact among themselves (latest-wins).
    expect(
      replayedRunEventTypes.filter((eventType) => eventType === 'run-meta-upserted'),
    ).toHaveLength(1);
    // Replay order keeps the creation before the meta merge.
    expect(replayedRunEventTypes.indexOf('run-upserted')).toBeLessThan(
      replayedRunEventTypes.indexOf('run-meta-upserted'),
    );
  });

  it('compacts replay-ring occupancy to one slot per coordinator entity', async () => {
    const { runId } = seedTwelveTaskCoordinatorFixture(harness);
    const observed = await connectAndObserve('compaction-client');

    // 30 mutations of the SAME subtask while disconnected occupy one ring
    // slot, so the replayed batch carries exactly one (latest) event.
    for (let index = 0; index < 30; index += 1) {
      const mutated = updateCoordinatorSubtaskStatus(
        runId,
        'task-2',
        index % 2 === 0 ? 'ready-for-review' : 'running',
      );
      harness.broadcastControl({
        type: 'coordinator-event',
        event: {
          categorySeq: getCoordinatorStateVersion(),
          createdAt: Date.now(),
          entityKey: 'subtask:task-2',
          entityVersion: getCoordinatorStateVersion(),
          eventType: 'subtask-upserted',
          payload: mutated,
          runId,
        },
      });
    }
    await harness.flush();

    const reconnect = harness.createClient();
    expect(
      harness.authenticateConnection(reconnect, 'compaction-client', observed.lastSeq, {
        categoryVersions: observed.categoryVersions,
        ...(observed.serverInstanceId !== undefined
          ? { serverInstanceId: observed.serverInstanceId }
          : {}),
      }),
    ).toBe(true);
    await harness.flush();

    const frame = getMessagesOfType(harness, reconnect, 'control-replay-batch')[0] as unknown as {
      events: Array<{ event?: { entityKey?: string } }>;
    };
    const replayedTask2Events = frame.events.filter(
      (event) => event.event?.entityKey === 'subtask:task-2',
    );
    expect(replayedTask2Events).toHaveLength(1);
  });
});
