import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../../electron/remote/protocol.js';
import {
  createBrowserControlPlaneContractHarness,
  createTransportContractHarness,
  getSequencedMessages,
  type WebSocketContractHarness,
} from '../harness/websocket-contract-harness';

type HarnessFactory = () => WebSocketContractHarness;
const replayContractHarnesses = [
  ['shared transport', () => createTransportContractHarness()],
  ['browser control plane', () => createBrowserControlPlaneContractHarness()],
] satisfies Array<[string, HarnessFactory]>;

function getHighestAcknowledgedSeq(
  harness: WebSocketContractHarness,
  client: ReturnType<WebSocketContractHarness['createClient']>,
): number {
  return getSequencedMessages(harness, client).reduce(
    (highest, message) => Math.max(highest, message.seq),
    -1,
  );
}

async function setupReplayWindow(
  harness: WebSocketContractHarness,
): Promise<ReturnType<WebSocketContractHarness['createClient']>> {
  const replayClient = harness.createClient();
  expect(harness.authenticateConnection(replayClient, 'replay-client')).toBe(true);
  await harness.flush();

  const baselineSeq = getHighestAcknowledgedSeq(harness, replayClient);
  harness.clearMessages(replayClient);
  broadcastContractEvents(harness);
  await harness.flush();
  harness.clearMessages(replayClient);

  harness.replayControlEvents(replayClient, baselineSeq + 1);
  await harness.flush();
  return replayClient;
}

function broadcastContractEvents(harness: WebSocketContractHarness): void {
  const messages: ServerMessage[] = [
    {
      type: 'remote-status',
      connectedClients: 1,
      peerClients: 0,
    },
    {
      type: 'agent-controller',
      agentId: 'agent-1',
      controllerId: 'alpha',
    },
    {
      type: 'task-event',
      event: 'created',
      taskId: 'task-1',
      name: 'Replay task',
    },
  ];

  for (const message of messages) {
    harness.broadcastControl(message);
  }
}

describe.each(replayContractHarnesses)('%s replay contract', (_name, createHarness) => {
  let harness: WebSocketContractHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = createHarness();
  });

  afterEach(() => {
    harness.dispose();
    vi.useRealTimers();
  });

  it('replays only control events newer than the last acknowledged sequence', async () => {
    const replayClient = await setupReplayWindow(harness);
    const replayed = getSequencedMessages(harness, replayClient);
    expect(replayed.map((message) => message.type)).toEqual(['agent-controller', 'task-event']);
    expect(replayed.every((message) => message.type !== 'remote-status')).toBe(true);
  });

  it('does not replay anything when the client cursor is already current', async () => {
    const replayClient = harness.createClient();
    expect(harness.authenticateConnection(replayClient, 'replay-client')).toBe(true);
    await harness.flush();

    const baselineSeq = getHighestAcknowledgedSeq(harness, replayClient);
    harness.clearMessages(replayClient);
    broadcastContractEvents(harness);
    await harness.flush();
    harness.clearMessages(replayClient);

    harness.replayControlEvents(replayClient, baselineSeq + 3);
    await harness.flush();

    expect(getSequencedMessages(harness, replayClient)).toEqual([]);
  });
});
