import type { PeerPresenceSnapshot } from '../domain/server-state';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { setStore, store } from './core';

function sortPeerPresence(
  snapshots: ReadonlyArray<PeerPresenceSnapshot>,
): ReadonlyArray<PeerPresenceSnapshot> {
  return [...snapshots].sort((left, right) => {
    const displayNameComparison = left.displayName.localeCompare(right.displayName);
    if (displayNameComparison !== 0) {
      return displayNameComparison;
    }

    return left.clientId.localeCompare(right.clientId);
  });
}

export function replacePeerSessions(snapshots: ReadonlyArray<PeerPresenceSnapshot>): void {
  const nextSessions: Record<string, PeerPresenceSnapshot> = {};
  for (const snapshot of sortPeerPresence(snapshots)) {
    nextSessions[snapshot.clientId] = snapshot;
  }

  setStore('peerSessions', nextSessions);
}

export function getPeerSession(clientId: string): PeerPresenceSnapshot | null {
  return store.peerSessions[clientId] ?? null;
}

export function getPeerDisplayName(clientId: string | null | undefined): string | null {
  if (!clientId) {
    return null;
  }

  return getPeerSession(clientId)?.displayName ?? null;
}

export function listPeerSessions(): PeerPresenceSnapshot[] {
  return Object.values(store.peerSessions);
}

export function getPeerViewerCountForTask(taskId: string): number {
  const runtimeClientId = getRuntimeClientId();
  let viewerCount = 0;

  for (const session of listPeerSessions()) {
    if (session.clientId === runtimeClientId) {
      continue;
    }

    if (session.visibility !== 'visible' || session.activeTaskId !== taskId) {
      continue;
    }

    viewerCount += 1;
  }

  return viewerCount;
}
