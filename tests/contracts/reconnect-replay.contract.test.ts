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
    broadcastContractEvents(harness);

    const replayClient = harness.createClient();
    expect(harness.authenticateConnection(replayClient, 'replay-client')).toBe(true);
    await harness.flush();
    harness.clearMessages(replayClient);

    harness.replayControlEvents(replayClient, 1);
    await harness.flush();

    const replayed = getSequencedMessages(harness, replayClient);
    expect(replayed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'task-event',
          seq: 2,
        }),
      ]),
    );
    expect(replayed.filter((message) => message.seq <= 1)).toEqual([]);
  });

  it('does not replay anything when the client cursor is already current', async () => {
    broadcastContractEvents(harness);

    const replayClient = harness.createClient();
    expect(harness.authenticateConnection(replayClient, 'replay-client')).toBe(true);
    await harness.flush();
    harness.clearMessages(replayClient);

    harness.replayControlEvents(replayClient, 2);
    await harness.flush();

    expect(
      getSequencedMessages(harness, replayClient).filter((message) => message.seq <= 2),
    ).toEqual([]);
  });
});
