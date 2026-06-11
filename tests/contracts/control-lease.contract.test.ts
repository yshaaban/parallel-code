import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserControlPlaneContractHarness,
  createTransportContractHarness,
  getMessagesOfType,
  type WebSocketContractHarness,
} from '../harness/websocket-contract-harness';

type HarnessFactory = () => WebSocketContractHarness;
const leaseContractHarnesses = [
  ['shared transport', () => createTransportContractHarness({ agentControlLeaseMs: 100 })],
  [
    'browser control plane',
    () => createBrowserControlPlaneContractHarness({ agentControlLeaseMs: 100 }),
  ],
] satisfies Array<[string, HarnessFactory]>;

describe.each(leaseContractHarnesses)('%s control-lease contract', (_name, createHarness) => {
  let harness: WebSocketContractHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    harness = createHarness();
  });

  afterEach(() => {
    harness.dispose();
    vi.useRealTimers();
  });

  it('requires authentication, enforces a single controller, and releases ownership on cleanup', async () => {
    const controller = harness.createClient();
    const observer = harness.createClient();

    expect(harness.claimAgentControl(controller, 'agent-1')).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });

    expect(harness.authenticateConnection(controller, 'controller')).toBe(true);
    expect(harness.authenticateConnection(observer, 'observer')).toBe(true);
    await harness.flush();
    harness.clearMessages(controller);
    harness.clearMessages(observer);

    expect(harness.claimAgentControl(controller, 'agent-1')).toMatchObject({
      ok: true,
      controllerId: 'controller',
    });
    await harness.flush();

    expect(harness.claimAgentControl(observer, 'agent-1')).toMatchObject({
      ok: false,
      reason: 'controlled-by-peer',
      controllerId: 'controller',
    });
    await harness.flush();

    expect(getMessagesOfType(harness, observer, 'agent-controller')).toContainEqual(
      expect.objectContaining({
        agentId: 'agent-1',
        controllerId: 'controller',
      }),
    );

    harness.cleanupClient(controller);
    await harness.flush();

    const controllerEvents = getMessagesOfType(harness, observer, 'agent-controller');
    expect(controllerEvents[controllerEvents.length - 1]).toMatchObject({
      agentId: 'agent-1',
      controllerId: null,
    });
  });

  it('expires stale controller leases before granting a new controller', async () => {
    const first = harness.createClient();
    const second = harness.createClient();

    expect(harness.authenticateConnection(first, 'first')).toBe(true);
    expect(harness.authenticateConnection(second, 'second')).toBe(true);
    await harness.flush();
    harness.clearMessages(first);
    harness.clearMessages(second);

    expect(harness.claimAgentControl(first, 'agent-2')).toMatchObject({
      ok: true,
      controllerId: 'first',
    });
    await harness.flush();

    vi.advanceTimersByTime(101);

    expect(harness.claimAgentControl(second, 'agent-2')).toMatchObject({
      ok: true,
      controllerId: 'second',
    });
    await harness.flush();

    const controllerEvents = getMessagesOfType(harness, second, 'agent-controller');
    const releaseIndex = controllerEvents.findIndex((event) => event.controllerId === null);
    const takeoverIndex = controllerEvents.findIndex(
      (event, index) => index > releaseIndex && event.controllerId === 'second',
    );

    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(takeoverIndex).toBeGreaterThan(releaseIndex);
    expect(controllerEvents[releaseIndex]).toMatchObject({
      agentId: 'agent-2',
      controllerId: null,
    });
    expect(controllerEvents[takeoverIndex]).toMatchObject({
      agentId: 'agent-2',
      controllerId: 'second',
    });
  });
});

import {
  acquireTaskCommandLease,
  getTaskCommandControllerSnapshot,
  renewTaskCommandLease,
  resetTaskCommandLeasesForTest,
} from '../../electron/ipc/task-command-leases';
import { TASK_COMMAND_LEASE_RECONNECT_GRACE_MS } from '../../server/browser-control-plane';

describe('task-command lease reconnect grace contract', () => {
  let harness: WebSocketContractHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    resetTaskCommandLeasesForTest();
    harness = createBrowserControlPlaneContractHarness();
    harness.startHeartbeat?.();
  });

  afterEach(() => {
    harness.dispose();
    resetTaskCommandLeasesForTest();
    vi.useRealTimers();
  });

  async function renewHeldLease(taskId: string, clientId: string, ownerId: string): Promise<void> {
    renewTaskCommandLease(taskId, clientId, ownerId);
    await vi.advanceTimersByTimeAsync(5_000);
  }

  it('retains the lease through a blip for the same clientId without a controller-null snapshot', async () => {
    const holder = harness.createClient();
    const observer = harness.createClient();
    expect(harness.authenticateConnection(holder, 'holder-client')).toBe(true);
    expect(harness.authenticateConnection(observer, 'observer-client')).toBe(true);
    await harness.flush();

    expect(
      acquireTaskCommandLease('task-1', 'holder-client', 'owner-a', 'type in the terminal')
        .acquired,
    ).toBe(true);
    harness.clearMessages(observer);

    harness.cleanupClient(holder);
    await vi.advanceTimersByTimeAsync(2_000);

    // The lease is still held through the blip and no controller-null
    // snapshot was broadcast to the observer.
    expect(getTaskCommandControllerSnapshot('task-1').controllerId).toBe('holder-client');
    const controllerEvents = harness
      .getMessages(observer)
      .filter(
        (message): message is { channel: string; payload: { controllerId: unknown } } =>
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'ipc-event' &&
          (message as { channel?: unknown }).channel === 'task_command_controller_changed',
      );
    expect(controllerEvents.filter((event) => event.payload.controllerId === null)).toHaveLength(0);

    // Same clientId reconnects within the grace window and keeps renewing.
    const reconnected = harness.createClient();
    expect(harness.authenticateConnection(reconnected, 'holder-client', -1)).toBe(true);
    for (
      let elapsed = 0;
      elapsed < TASK_COMMAND_LEASE_RECONNECT_GRACE_MS + 5_000;
      elapsed += 5_000
    ) {
      await renewHeldLease('task-1', 'holder-client', 'owner-a');
    }
    expect(getTaskCommandControllerSnapshot('task-1').controllerId).toBe('holder-client');
  });

  it('still releases a non-renewing disconnected holder through natural lease expiry', async () => {
    const holder = harness.createClient();
    expect(harness.authenticateConnection(holder, 'holder-client')).toBe(true);
    await harness.flush();
    acquireTaskCommandLease('task-1', 'holder-client', 'owner-a', 'type in the terminal');

    harness.cleanupClient(holder);
    // 16s > the 15s natural lease TTL but < the 30s reconnect grace.
    await vi.advanceTimersByTimeAsync(16_000);

    expect(getTaskCommandControllerSnapshot('task-1').controllerId).toBeNull();
  });

  it('lets a peer takeover during the grace window win and never resurrects the old holder', async () => {
    const holder = harness.createClient();
    const peer = harness.createClient();
    expect(harness.authenticateConnection(holder, 'holder-client')).toBe(true);
    expect(harness.authenticateConnection(peer, 'peer-client')).toBe(true);
    await harness.flush();
    acquireTaskCommandLease('task-1', 'holder-client', 'owner-a', 'type in the terminal');

    harness.cleanupClient(holder);
    await vi.advanceTimersByTimeAsync(1_000);

    const takeover = acquireTaskCommandLease(
      'task-1',
      'peer-client',
      'owner-b',
      'type in the terminal',
      true,
    );
    expect(takeover.acquired).toBe(true);
    expect(takeover.controllerId).toBe('peer-client');

    // The old holder's grace expiry must not release the peer's lease, and a
    // late non-takeover re-claim by the old holder is denied.
    for (
      let elapsed = 0;
      elapsed < TASK_COMMAND_LEASE_RECONNECT_GRACE_MS + 2_000;
      elapsed += 5_000
    ) {
      await renewHeldLease('task-1', 'peer-client', 'owner-b');
    }
    expect(getTaskCommandControllerSnapshot('task-1').controllerId).toBe('peer-client');

    const reconnected = harness.createClient();
    expect(harness.authenticateConnection(reconnected, 'holder-client', -1)).toBe(true);
    const reclaim = acquireTaskCommandLease(
      'task-1',
      'holder-client',
      'owner-a',
      'type in the terminal',
    );
    expect(reclaim.acquired).toBe(false);
    expect(reclaim.controllerId).toBe('peer-client');
  });

  it('keeps immediate prune semantics for never-connected automation clientIds', async () => {
    acquireTaskCommandLease(
      'task-1',
      'coordinator:run-1',
      'coordinator-prompt-delivery',
      'send a coordinator prompt',
    );
    expect(getTaskCommandControllerSnapshot('task-1').controllerId).toBe('coordinator:run-1');

    // The automation clientId never had a socket: the 1s prune sweep releases
    // it immediately instead of granting reconnect grace.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(getTaskCommandControllerSnapshot('task-1').controllerId).toBeNull();
  });
});
