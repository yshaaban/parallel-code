import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '../electron/remote/protocol.js';
import type { PeerPresenceSnapshot } from '../src/domain/server-state.js';
import { createBrowserTaskCommandTakeovers } from './browser-task-command-takeovers.js';

function createPeerPresenceSnapshot(clientId: string, displayName: string): PeerPresenceSnapshot {
  return {
    activeTaskId: null,
    clientId,
    controllingAgentIds: [],
    controllingTaskIds: [],
    displayName,
    focusedSurface: null,
    lastSeenAt: Date.now(),
    visibility: 'visible',
  };
}

describe('browser-task-command-takeovers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('downgrades an approved response when takeover application does not transfer control', () => {
    vi.useFakeTimers();

    const messagesByClientId = new Map<string, ServerMessage[]>();
    const peerPresenceByClientId = new Map<string, PeerPresenceSnapshot>([
      ['client-owner', createPeerPresenceSnapshot('client-owner', 'Owner')],
      ['client-requester', createPeerPresenceSnapshot('client-requester', 'Requester')],
    ]);

    function pushMessage(clientId: string, message: ServerMessage): void {
      const existingMessages = messagesByClientId.get(clientId) ?? [];
      existingMessages.push(message);
      messagesByClientId.set(clientId, existingMessages);
    }

    const takeovers = createBrowserTaskCommandTakeovers({
      applyApprovedTakeover: () => false,
      getCurrentControllerId: () => 'client-owner',
      getPeerPresence: (clientId) => peerPresenceByClientId.get(clientId) ?? null,
      hasClientId: (clientId) => peerPresenceByClientId.has(clientId),
      idleMs: 5_000,
      sendToClientId: pushMessage,
      timeoutMs: 5_000,
    });

    takeovers.requestTakeover('client-requester', {
      action: 'type in the terminal',
      requestId: 'request-1',
      requesterOwnerId: 'requester-owner',
      targetControllerId: 'client-owner',
      taskId: 'task-1',
      type: 'request-task-command-takeover',
    });
    takeovers.respondTakeover('client-owner', {
      approved: true,
      requestId: 'request-1',
      type: 'respond-task-command-takeover',
    });

    expect(messagesByClientId.get('client-requester')).toContainEqual({
      decision: 'denied',
      requestId: 'request-1',
      taskId: 'task-1',
      type: 'task-command-takeover-result',
    });
    expect(messagesByClientId.get('client-owner')).toContainEqual({
      decision: 'denied',
      requestId: 'request-1',
      taskId: 'task-1',
      type: 'task-command-takeover-result',
    });

    takeovers.cleanup();
  });
});
