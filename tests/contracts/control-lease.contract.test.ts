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
    expect(controllerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'agent-2', controllerId: null }),
        expect.objectContaining({ agentId: 'agent-2', controllerId: 'second' }),
      ]),
    );
  });
});
