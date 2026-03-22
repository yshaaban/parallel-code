import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels.js';
import {
  acquireTaskCommandLease,
  resetTaskCommandLeasesForTest,
} from '../../electron/ipc/task-command-leases.js';
import {
  createBrowserControlPlaneContractHarness,
  getMessagesOfType,
  type WebSocketContractHarness,
} from '../harness/websocket-contract-harness';

function createPresenceUpdate(
  displayName: string,
  visibility: 'hidden' | 'visible' = 'visible',
): {
  activeTaskId: string | null;
  controllingAgentIds: string[];
  controllingTaskIds: string[];
  displayName: string;
  focusedSurface: string | null;
  type: 'update-presence';
  visibility: 'hidden' | 'visible';
} {
  return {
    activeTaskId: null,
    controllingAgentIds: [],
    controllingTaskIds: [],
    displayName,
    focusedSurface: null,
    type: 'update-presence',
    visibility,
  };
}

function createHarness(): WebSocketContractHarness {
  return createBrowserControlPlaneContractHarness();
}

describe('browser control plane task-command takeover contract', () => {
  let harness: WebSocketContractHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    resetTaskCommandLeasesForTest();
    harness = createHarness();
  });

  afterEach(() => {
    harness.dispose();
    resetTaskCommandLeasesForTest();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('approves a takeover when the current controller responds positively', async () => {
    const owner = harness.createClient();
    const requester = harness.createClient();

    expect(harness.authenticateConnection(owner, 'client-a')).toBe(true);
    expect(harness.authenticateConnection(requester, 'client-b')).toBe(true);
    harness.updatePeerPresence(owner, createPresenceUpdate('Ivan'));
    harness.updatePeerPresence(requester, createPresenceUpdate('Sara'));
    acquireTaskCommandLease('task-1', 'client-a', 'owner:client-a', 'type in the terminal');

    harness.requestTaskCommandTakeover(requester, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-approve',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });
    await harness.flush();

    expect(getMessagesOfType(harness, owner, 'task-command-takeover-request')).toContainEqual(
      expect.objectContaining({
        action: 'type in the terminal',
        requestId: 'request-approve',
        requesterClientId: 'client-b',
        requesterDisplayName: 'Sara',
        taskId: 'task-1',
      }),
    );

    harness.respondTaskCommandTakeover(owner, {
      type: 'respond-task-command-takeover',
      approved: true,
      requestId: 'request-approve',
    });
    await harness.flush();

    expect(getMessagesOfType(harness, requester, 'task-command-takeover-result')).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'approved',
      requestId: 'request-approve',
      taskId: 'task-1',
    });
  });

  it('denies a takeover when the current controller rejects it', async () => {
    const owner = harness.createClient();
    const requester = harness.createClient();

    expect(harness.authenticateConnection(owner, 'client-a')).toBe(true);
    expect(harness.authenticateConnection(requester, 'client-b')).toBe(true);
    harness.updatePeerPresence(owner, createPresenceUpdate('Ivan'));
    harness.updatePeerPresence(requester, createPresenceUpdate('Sara'));
    acquireTaskCommandLease('task-1', 'client-a', 'owner:client-a', 'type in the terminal');

    harness.requestTaskCommandTakeover(requester, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-deny',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });
    await harness.flush();

    harness.respondTaskCommandTakeover(owner, {
      type: 'respond-task-command-takeover',
      approved: false,
      requestId: 'request-deny',
    });
    await harness.flush();

    expect(getMessagesOfType(harness, requester, 'task-command-takeover-result')).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'denied',
      requestId: 'request-deny',
      taskId: 'task-1',
    });
  });

  it('returns owner-missing when the controller disconnects while the takeover is pending', async () => {
    const owner = harness.createClient();
    const requester = harness.createClient();

    expect(harness.authenticateConnection(owner, 'client-a')).toBe(true);
    expect(harness.authenticateConnection(requester, 'client-b')).toBe(true);
    harness.updatePeerPresence(owner, createPresenceUpdate('Ivan'));
    harness.updatePeerPresence(requester, createPresenceUpdate('Sara'));
    acquireTaskCommandLease('task-1', 'client-a', 'owner:client-a', 'type in the terminal');

    harness.requestTaskCommandTakeover(requester, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-owner-missing',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });
    await harness.flush();

    harness.cleanupClient(owner);
    await harness.flush();

    expect(getMessagesOfType(harness, requester, 'task-command-takeover-result')).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'owner-missing',
      requestId: 'request-owner-missing',
      taskId: 'task-1',
    });
  });

  it('marks a takeover force-required after timeout when the owner stays active', async () => {
    const owner = harness.createClient();
    const requester = harness.createClient();

    expect(harness.authenticateConnection(owner, 'client-a')).toBe(true);
    expect(harness.authenticateConnection(requester, 'client-b')).toBe(true);
    harness.updatePeerPresence(owner, createPresenceUpdate('Ivan', 'visible'));
    harness.updatePeerPresence(requester, createPresenceUpdate('Sara', 'visible'));
    acquireTaskCommandLease('task-1', 'client-a', 'owner:client-a', 'type in the terminal');

    harness.requestTaskCommandTakeover(requester, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-force',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });

    await vi.advanceTimersByTimeAsync(8_000);
    await harness.flush();

    expect(getMessagesOfType(harness, requester, 'task-command-takeover-result')).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'force-required',
      requestId: 'request-force',
      taskId: 'task-1',
    });
  });

  it('denies a pending takeover when ownership changes to another client', async () => {
    const owner = harness.createClient();
    const requester = harness.createClient();
    const replacementOwner = harness.createClient();

    expect(harness.authenticateConnection(owner, 'client-a')).toBe(true);
    expect(harness.authenticateConnection(requester, 'client-b')).toBe(true);
    expect(harness.authenticateConnection(replacementOwner, 'client-c')).toBe(true);
    harness.updatePeerPresence(owner, createPresenceUpdate('Ivan'));
    harness.updatePeerPresence(requester, createPresenceUpdate('Sara'));
    harness.updatePeerPresence(replacementOwner, createPresenceUpdate('Mina'));
    acquireTaskCommandLease('task-1', 'client-a', 'owner:client-a', 'type in the terminal');

    harness.requestTaskCommandTakeover(requester, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-controller-changed',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });
    await harness.flush();

    const takeover = acquireTaskCommandLease(
      'task-1',
      'client-c',
      'owner:client-c',
      'type in the terminal',
      true,
    );
    harness.emitIpcEvent(IPC.TaskCommandControllerChanged, takeover);
    await harness.flush();

    expect(getMessagesOfType(harness, requester, 'task-command-takeover-result')).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'denied',
      requestId: 'request-controller-changed',
      taskId: 'task-1',
    });
    expect(getMessagesOfType(harness, owner, 'task-command-takeover-result')).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'denied',
      requestId: 'request-controller-changed',
      taskId: 'task-1',
    });
  });

  it('cleans up a pending takeover when the requester disconnects', async () => {
    const owner = harness.createClient();
    const requester = harness.createClient();

    expect(harness.authenticateConnection(owner, 'client-a')).toBe(true);
    expect(harness.authenticateConnection(requester, 'client-b')).toBe(true);
    acquireTaskCommandLease('task-1', 'client-a', 'owner:client-a', 'type in the terminal');

    harness.requestTaskCommandTakeover(requester, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-requester-gone',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });
    await harness.flush();

    harness.cleanupClient(requester);
    await harness.flush();

    expect(getMessagesOfType(harness, owner, 'task-command-takeover-result')).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'denied',
      requestId: 'request-requester-gone',
      taskId: 'task-1',
    });
  });

  it('keeps a pending takeover alive across a requester reconnect and delivers the result to the replacement socket', async () => {
    const owner = harness.createClient();
    const firstRequester = harness.createClient();
    const replacementRequester = harness.createClient();

    expect(harness.authenticateConnection(owner, 'client-a')).toBe(true);
    expect(harness.authenticateConnection(firstRequester, 'client-b')).toBe(true);
    acquireTaskCommandLease('task-1', 'client-a', 'owner:client-a', 'type in the terminal');

    harness.requestTaskCommandTakeover(firstRequester, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-reconnect',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });
    await harness.flush();

    expect(harness.authenticateConnection(replacementRequester, 'client-b')).toBe(true);
    harness.cleanupClient(firstRequester);

    harness.respondTaskCommandTakeover(owner, {
      type: 'respond-task-command-takeover',
      approved: true,
      requestId: 'request-reconnect',
    });
    await harness.flush();

    expect(
      getMessagesOfType(harness, replacementRequester, 'task-command-takeover-result'),
    ).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'approved',
      requestId: 'request-reconnect',
      taskId: 'task-1',
    });
    expect(getMessagesOfType(harness, firstRequester, 'task-command-takeover-result')).toEqual([]);
  });

  it('returns owner-missing when the target owner disconnects before the takeover resolves', async () => {
    const owner = harness.createClient();
    const requester = harness.createClient();

    expect(harness.authenticateConnection(owner, 'client-a')).toBe(true);
    expect(harness.authenticateConnection(requester, 'client-b')).toBe(true);
    acquireTaskCommandLease('task-1', 'client-a', 'owner:client-a', 'type in the terminal');

    harness.requestTaskCommandTakeover(requester, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-owner-disconnect',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });
    await harness.flush();

    harness.cleanupClient(owner);
    await harness.flush();

    expect(getMessagesOfType(harness, requester, 'task-command-takeover-result')).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'owner-missing',
      requestId: 'request-owner-disconnect',
      taskId: 'task-1',
    });
  });

  it('falls back to owner-missing when a takeover target does not exist', async () => {
    const requester = harness.createClient();

    expect(harness.authenticateConnection(requester, 'client-b')).toBe(true);
    harness.updatePeerPresence(requester, createPresenceUpdate('Sara'));

    harness.requestTaskCommandTakeover(requester, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-no-owner',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });
    await harness.flush();

    expect(getMessagesOfType(harness, requester, 'task-command-takeover-result')).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'owner-missing',
      requestId: 'request-no-owner',
      taskId: 'task-1',
    });
  });
});
