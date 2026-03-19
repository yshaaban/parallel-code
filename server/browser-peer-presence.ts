import type { PeerPresenceSnapshot } from '../src/domain/server-state.js';
import type { ServerMessage, UpdatePresenceCommand } from '../electron/remote/protocol.js';

interface CreateBrowserPeerPresenceOptions {
  broadcastControl: (message: ServerMessage) => void;
}

export interface BrowserPeerPresence {
  ensurePeerPresence: (clientId: string) => void;
  getPeerPresence: (clientId: string) => PeerPresenceSnapshot;
  getPeerPresenceSnapshots: () => PeerPresenceSnapshot[];
  getPeerPresenceVersion: () => number;
  removePeerPresence: (clientId: string) => boolean;
  updatePeerPresence: (clientId: string, presence: UpdatePresenceCommand) => void;
}

function createFallbackPeerPresence(clientId: string): PeerPresenceSnapshot {
  return {
    activeTaskId: null,
    clientId,
    controllingAgentIds: [],
    controllingTaskIds: [],
    displayName: `Session ${clientId.slice(0, 6)}`,
    focusedSurface: null,
    lastSeenAt: Date.now(),
    visibility: 'visible',
  };
}

export function createBrowserPeerPresence(
  options: CreateBrowserPeerPresenceOptions,
): BrowserPeerPresence {
  const peerSessions = new Map<string, PeerPresenceSnapshot>();
  let peerPresenceVersion = 0;

  function bumpPeerPresenceVersion(): void {
    peerPresenceVersion += 1;
  }

  function getPeerPresenceSnapshots(): PeerPresenceSnapshot[] {
    return [...peerSessions.values()].sort((left, right) => {
      const displayNameComparison = left.displayName.localeCompare(right.displayName);
      if (displayNameComparison !== 0) {
        return displayNameComparison;
      }

      return left.clientId.localeCompare(right.clientId);
    });
  }

  function broadcastPeerPresences(): void {
    bumpPeerPresenceVersion();
    options.broadcastControl({
      type: 'peer-presences',
      list: getPeerPresenceSnapshots(),
    });
  }

  function ensurePeerPresence(clientId: string): void {
    if (peerSessions.has(clientId)) {
      return;
    }

    peerSessions.set(clientId, createFallbackPeerPresence(clientId));
    bumpPeerPresenceVersion();
  }

  function getPeerPresence(clientId: string): PeerPresenceSnapshot {
    return peerSessions.get(clientId) ?? createFallbackPeerPresence(clientId);
  }

  function removePeerPresence(clientId: string): boolean {
    const removed = peerSessions.delete(clientId);
    if (removed) {
      broadcastPeerPresences();
    }
    return removed;
  }

  function updatePeerPresence(clientId: string, presence: UpdatePresenceCommand): void {
    const nextPresence: PeerPresenceSnapshot = {
      ...(peerSessions.get(clientId) ?? createFallbackPeerPresence(clientId)),
      activeTaskId: presence.activeTaskId,
      clientId,
      controllingAgentIds: presence.controllingAgentIds,
      controllingTaskIds: presence.controllingTaskIds,
      displayName: presence.displayName,
      focusedSurface: presence.focusedSurface,
      lastSeenAt: Date.now(),
      visibility: presence.visibility,
    };
    peerSessions.set(clientId, nextPresence);
    broadcastPeerPresences();
  }

  return {
    ensurePeerPresence,
    getPeerPresence,
    getPeerPresenceSnapshots,
    getPeerPresenceVersion: () => peerPresenceVersion,
    removePeerPresence,
    updatePeerPresence,
  };
}
