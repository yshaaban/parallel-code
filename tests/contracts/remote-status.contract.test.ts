import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserControlPlaneContractHarness,
  type FakeWebSocketClient,
  getMessagesOfType,
  type WebSocketContractHarness,
} from '../harness/websocket-contract-harness';

function getRemoteStatusMessages(
  harness: WebSocketContractHarness,
  client: FakeWebSocketClient,
): Array<Record<string, unknown> & { type: 'remote-status' }> {
  return getMessagesOfType(harness, client, 'remote-status');
}

function getRemoteStatus(harness: WebSocketContractHarness) {
  if (!harness.remoteStatus) {
    throw new Error('Browser remote-status contract requires a remote-status provider');
  }

  return harness.remoteStatus();
}

let harness: WebSocketContractHarness = createBrowserControlPlaneContractHarness();

describe('browser remote-status contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness = createBrowserControlPlaneContractHarness();
  });

  afterEach(() => {
    harness.dispose();
    vi.useRealTimers();
  });

  it('exposes current browser remote status from authenticated client counts', async () => {
    expect(getRemoteStatus(harness)).toMatchObject({
      enabled: true,
      connectedClients: 0,
      peerClients: 0,
    });

    const first = harness.createClient();
    expect(harness.authenticateConnection(first, 'first')).toBe(true);
    await harness.flush();

    expect(getRemoteStatus(harness)).toMatchObject({
      enabled: true,
      connectedClients: 1,
      peerClients: 0,
    });

    const second = harness.createClient();
    expect(harness.authenticateConnection(second, 'second')).toBe(true);
    await harness.flush();

    expect(getRemoteStatus(harness)).toMatchObject({
      enabled: true,
      connectedClients: 2,
      peerClients: 1,
    });
  });

  it('broadcasts current remote status whenever authenticated client counts change', async () => {
    const first = harness.createClient();
    expect(harness.authenticateConnection(first, 'first')).toBe(true);
    await harness.flush();
    harness.clearMessages(first);

    const second = harness.createClient();
    expect(harness.authenticateConnection(second, 'second')).toBe(true);
    await harness.flush();

    expect(getRemoteStatusMessages(harness, first)).toContainEqual(
      expect.objectContaining({
        type: 'remote-status',
        connectedClients: 2,
        peerClients: 1,
      }),
    );

    harness.cleanupClient(second);
    await harness.flush();

    const remoteStatusMessages = getRemoteStatusMessages(harness, first);
    expect(remoteStatusMessages[remoteStatusMessages.length - 1]).toMatchObject({
      type: 'remote-status',
      connectedClients: 1,
      peerClients: 0,
    });
  });
});
