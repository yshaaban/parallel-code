import { randomUUID } from 'node:crypto';

// Per-process server instance identity for the resync version handshake.
// Every server-state category version (and the control-event seq counter) is a
// per-boot counter; only the persisted workspaceRevision survives restarts. A
// client may present cached versions only against the same server instance —
// when the instance id changes, presented versions are meaningless and the
// server serves the full bootstrap path.

let serverInstanceId: string | null = null;

export function getServerInstanceId(): string {
  serverInstanceId ??= randomUUID();
  return serverInstanceId;
}

export function resetServerInstanceIdForTests(): void {
  serverInstanceId = null;
}
