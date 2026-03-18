import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import type { ConnectionStatus } from './ws';
import { send } from './ws';

const PRESENCE_HEARTBEAT_MS = 5_000;

interface RemotePresenceRuntimeOptions {
  getActiveTaskId: Accessor<string | null>;
  getConnectionStatus: Accessor<ConnectionStatus>;
  getControllingTaskIds: Accessor<ReadonlyArray<string>>;
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

function createPresencePayload(
  options: RemotePresenceRuntimeOptions,
  displayName: string,
): {
  activeTaskId: string | null;
  controllingAgentIds: string[];
  controllingTaskIds: string[];
  displayName: string;
  focusedSurface: string | null;
  type: 'update-presence';
  visibility: 'hidden' | 'visible';
} {
  const visibility = getRemoteVisibility();
  return {
    type: 'update-presence',
    activeTaskId: options.getActiveTaskId(),
    controllingAgentIds: [],
    controllingTaskIds: [...options.getControllingTaskIds()],
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
  const [visibilityVersion, setVisibilityVersion] = createSignal(0);
  let heartbeatTimer: number | undefined;
  let lastPayloadKey = '';

  function bumpVisibilityVersion(): void {
    setVisibilityVersion((currentVersion) => currentVersion + 1);
  }

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

    if (!send(payload)) {
      return;
    }

    lastPayloadKey = payloadKey;
  }

  function startHeartbeat(displayName: string): void {
    heartbeatTimer = window.setInterval(() => {
      publishPresence(true, displayName);
    }, PRESENCE_HEARTBEAT_MS);
  }

  function handleVisibilityChange(): void {
    clearHeartbeatTimer();
    lastPayloadKey = '';
    bumpVisibilityVersion();
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
    visibilityVersion();
    options.getActiveTaskId();
    options.getFocusedSurface();
    options.getControllingTaskIds();

    clearHeartbeatTimer();
    lastPayloadKey = '';
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
