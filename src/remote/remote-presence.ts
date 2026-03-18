import { createEffect, onCleanup, type Accessor } from 'solid-js';
import type { ConnectionStatus } from './ws';
import { send } from './ws';

const PRESENCE_HEARTBEAT_MS = 5_000;

interface RemotePresenceRuntimeOptions {
  getActiveTaskId: Accessor<string | null>;
  getConnectionStatus: Accessor<ConnectionStatus>;
  getDisplayName: Accessor<string>;
  getFocusedSurface: Accessor<string | null>;
}

function getTrimmedDisplayName(options: RemotePresenceRuntimeOptions): string {
  return options.getDisplayName().trim();
}

function getRemoteVisibility(): 'hidden' | 'visible' {
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
    return 'visible';
  }

  return 'hidden';
}

function createPresencePayload(options: RemotePresenceRuntimeOptions, displayName: string) {
  const visibility = getRemoteVisibility();
  return {
    type: 'update-presence' as const,
    activeTaskId: options.getActiveTaskId(),
    controllingAgentIds: [] as string[],
    controllingTaskIds: [] as string[],
    displayName,
    focusedSurface: visibility === 'hidden' ? 'hidden' : options.getFocusedSurface(),
    visibility,
  };
}

function canPublishPresence(displayName: string, connectionStatus: ConnectionStatus): boolean {
  return displayName.length > 0 && connectionStatus === 'connected';
}

export function getDefaultRemoteSessionName(clientId: string): string {
  return `Mobile ${clientId.slice(-4).toUpperCase()}`;
}

export function createRemotePresenceRuntime(options: RemotePresenceRuntimeOptions): void {
  let heartbeatTimer: number | undefined;
  let lastPayloadKey = '';

  function clearHeartbeatTimer(): void {
    if (heartbeatTimer === undefined) {
      return;
    }

    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function publishPresence(force = false, displayName = getTrimmedDisplayName(options)): void {
    if (!canPublishPresence(displayName, options.getConnectionStatus())) {
      return;
    }

    const payload = createPresencePayload(options, displayName);
    const payloadKey = JSON.stringify(payload);
    if (!force && payloadKey === lastPayloadKey) {
      return;
    }

    lastPayloadKey = payloadKey;
    send(payload);
  }

  function startHeartbeat(displayName: string): void {
    heartbeatTimer = window.setInterval(() => {
      publishPresence(true, displayName);
    }, PRESENCE_HEARTBEAT_MS);
  }

  function handleVisibilityChange(): void {
    clearHeartbeatTimer();
    lastPayloadKey = '';
    publishPresence(true);
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    onCleanup(() => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    });
  }

  createEffect(() => {
    const displayName = getTrimmedDisplayName(options);
    const connectionStatus = options.getConnectionStatus();
    options.getActiveTaskId();
    options.getFocusedSurface();

    clearHeartbeatTimer();
    if (!canPublishPresence(displayName, connectionStatus)) {
      return;
    }

    publishPresence(true, displayName);
    if (getRemoteVisibility() === 'hidden') {
      return;
    }

    startHeartbeat(displayName);

    onCleanup(() => {
      clearHeartbeatTimer();
    });
  });

  onCleanup(() => {
    clearHeartbeatTimer();
  });
}
