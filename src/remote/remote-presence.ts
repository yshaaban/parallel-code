import type { Accessor } from 'solid-js';
import { createPresenceRuntime } from '../domain/presence-runtime';
import { syncFocusedTypingRemoteTaskCommandLease } from './remote-task-command';
import type { ConnectionStatus } from './ws';
import { send } from './ws';

interface RemotePresenceRuntimeOptions {
  getActiveTaskId: Accessor<string | null>;
  getConnectionStatus: Accessor<ConnectionStatus>;
  getControllingTaskIds: Accessor<ReadonlyArray<string>>;
  getDisplayName: Accessor<string>;
  getFocusedSurface: Accessor<string | null>;
}

export function getDefaultRemoteSessionName(clientId: string): string {
  return `Mobile ${clientId.slice(-4).toUpperCase()}`;
}

export function createRemotePresenceRuntime(options: RemotePresenceRuntimeOptions): void {
  createPresenceRuntime({
    getActiveTaskId: options.getActiveTaskId,
    getConnectionStatus: options.getConnectionStatus,
    getControllingTaskIds: options.getControllingTaskIds,
    getDisplayName: options.getDisplayName,
    getFocusedSurface: options.getFocusedSurface,
    publishPresence: (payload) => send(payload),
    syncFocusedTypingLease: syncFocusedTypingRemoteTaskCommandLease,
  });
}
