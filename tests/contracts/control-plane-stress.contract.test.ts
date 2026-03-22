import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from '../../electron/ipc/runtime-diagnostics.js';
import type { ServerMessage } from '../../electron/remote/protocol.js';
import {
  createBrowserControlPlaneContractHarness,
  getMessagesOfType,
  getSequencedMessages,
  type FakeWebSocketClient,
  type WebSocketContractHarness,
} from '../harness/websocket-contract-harness';

const CLIENT_COUNT = 18;
const CONTROL_MESSAGE_COUNT = 48;
const BACKPRESSURE_BYTES = 2_000_000;

function createStressControlMessages(): ServerMessage[] {
  return Array.from({ length: CONTROL_MESSAGE_COUNT }, (_, index) => {
    switch (index % 4) {
      case 0:
        return {
          type: 'remote-status',
          connectedClients: CLIENT_COUNT,
          peerClients: CLIENT_COUNT - 1,
        };
      case 1:
        return {
          type: 'git-status-changed',
          branchName: `feature/stress-${index}`,
          worktreePath: `/tmp/worktree-${index}`,
        };
      case 2:
        return {
          type: 'agent-controller',
          agentId: `agent-${index}`,
          controllerId: `client-${index % CLIENT_COUNT}`,
        };
      default:
        return {
          type: 'task-ports-changed',
          kind: 'snapshot',
          taskId: `task-${index}`,
          observed: [],
          exposed: [],
          updatedAt: index,
        };
    }
  });
}

function createAuthenticatedClients(
  harness: WebSocketContractHarness,
  count: number,
): FakeWebSocketClient[] {
  return Array.from({ length: count }, (_, index) => {
    const client = harness.createClient();
    expect(harness.authenticateConnection(client, `client-${index}`)).toBe(true);
    return client;
  });
}

describe('browser control-plane stress contract', () => {
  let harness: WebSocketContractHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    resetBackendRuntimeDiagnostics();
    harness = createBrowserControlPlaneContractHarness();
  });

  afterEach(() => {
    harness.dispose();
    vi.useRealTimers();
  });

  it('fans out a burst of sequenced control traffic consistently to many clients', async () => {
    const clients = createAuthenticatedClients(harness, CLIENT_COUNT);
    await harness.flush();
    for (const client of clients) {
      harness.clearMessages(client);
    }

    const messages = createStressControlMessages();
    for (const message of messages) {
      harness.broadcastControl(message);
    }
    await harness.flush();

    for (const client of clients) {
      const sequencedMessages = getSequencedMessages(harness, client);
      expect(sequencedMessages).toHaveLength(messages.length);
      const firstSequence = sequencedMessages[0]?.seq;
      const lastMessage = sequencedMessages[sequencedMessages.length - 1];

      expect(firstSequence).toEqual(expect.any(Number));
      if (typeof firstSequence !== 'number') {
        throw new Error('Expected first sequence number to be present');
      }
      expect(lastMessage).toMatchObject({
        type: messages[messages.length - 1]?.type,
        seq: firstSequence + messages.length - 1,
      });
      expect(
        sequencedMessages.every(
          (message, index) =>
            message.seq === firstSequence + index && message.type === messages[index]?.type,
        ),
      ).toBe(true);
    }
  });

  it('isolates a slow consumer without starving healthy peers', async () => {
    const [first, slow, second] = createAuthenticatedClients(harness, 3);
    await harness.flush();
    for (const client of [first, slow, second]) {
      harness.clearMessages(client);
    }

    slow.bufferedAmount = BACKPRESSURE_BYTES;

    harness.broadcastControl({
      type: 'remote-status',
      connectedClients: 3,
      peerClients: 2,
    });
    await harness.flush();

    expect(getBackendRuntimeDiagnosticsSnapshot().browserControl.backpressureRejects).toBe(1);
    expect(getMessagesOfType(harness, first, 'remote-status')).toContainEqual(
      expect.objectContaining({
        type: 'remote-status',
        connectedClients: 3,
      }),
    );
    expect(getMessagesOfType(harness, second, 'remote-status')).toContainEqual(
      expect.objectContaining({
        type: 'remote-status',
        connectedClients: 3,
      }),
    );

    harness.clearMessages(first);
    harness.clearMessages(second);
    slow.bufferedAmount = 0;

    harness.broadcastControl({
      type: 'agent-controller',
      agentId: 'agent-slow-consumer',
      controllerId: 'first',
    });
    await harness.flush();

    expect(getMessagesOfType(harness, first, 'agent-controller')).toContainEqual(
      expect.objectContaining({
        agentId: 'agent-slow-consumer',
        controllerId: 'first',
      }),
    );
    expect(getMessagesOfType(harness, second, 'agent-controller')).toContainEqual(
      expect.objectContaining({
        agentId: 'agent-slow-consumer',
        controllerId: 'first',
      }),
    );
    expect(getMessagesOfType(harness, slow, 'agent-controller')).toEqual([]);
  });
});
