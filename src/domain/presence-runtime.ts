import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import type { PeerPresenceVisibility } from './server-state';
import type { PresenceConnectionStatus, PresencePayload } from './presence';

interface CreatePresenceRuntimeOptions {
  createReactiveEffect?: (effect: () => void) => void;
  getActiveTaskId: Accessor<string | null>;
  getConnectionStatus?: Accessor<PresenceConnectionStatus>;
  getControllingTaskIds: Accessor<ReadonlyArray<string>>;
  getDisplayName: Accessor<string>;
  getFocusedSurface: Accessor<string | null>;
  publishPresence: (payload: PresencePayload) => boolean | Promise<boolean | undefined> | undefined;
  subscribeForcedRepublish?: (publishPresence: () => void) => () => void;
  syncFocusedTypingLease?: (activeTaskId: string | null, focusedSurface: string | null) => void;
}

const PRESENCE_HEARTBEAT_MS = 5_000;

export function getPresenceVisibility(): PeerPresenceVisibility {
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
    return 'visible';
  }

  return 'hidden';
}

export function getTrimmedPresenceDisplayName(getDisplayName: Accessor<string>): string {
  return getDisplayName().trim();
}

function createPresencePayload(
  options: CreatePresenceRuntimeOptions,
  displayName: string,
): PresencePayload {
  const visibility = getPresenceVisibility();
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

function canPublishPresence(
  displayName: string,
  connectionStatus: PresenceConnectionStatus | undefined,
): boolean {
  return (
    displayName.length > 0 && (connectionStatus === undefined || connectionStatus === 'connected')
  );
}

function getPresenceFocusedSurface(options: CreatePresenceRuntimeOptions): string | null {
  return getPresenceVisibility() === 'hidden' ? 'hidden' : options.getFocusedSurface();
}

function isPresencePublishPromise(
  value: boolean | Promise<boolean | undefined> | undefined,
): value is Promise<boolean | undefined> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

export function createPresenceRuntime(options: CreatePresenceRuntimeOptions): void {
  const createReactiveEffect = options.createReactiveEffect ?? createEffect;
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

  function clearPublishedPresenceCache(): void {
    lastPayloadKey = '';
  }

  function publishPresence(
    force = false,
    displayName = getTrimmedPresenceDisplayName(options.getDisplayName),
  ): void {
    const connectionStatus = options.getConnectionStatus?.();
    if (!canPublishPresence(displayName, connectionStatus)) {
      return;
    }

    const payload = createPresencePayload(options, displayName);
    const payloadKey = JSON.stringify(payload);
    if (!force && payloadKey === lastPayloadKey) {
      return;
    }

    const publishResult = options.publishPresence(payload);
    if (publishResult === false) {
      return;
    }

    if (isPresencePublishPromise(publishResult)) {
      lastPayloadKey = payloadKey;
      void publishResult
        .then((result) => {
          if (result === false && lastPayloadKey === payloadKey) {
            clearPublishedPresenceCache();
          }
        })
        .catch(() => {
          if (lastPayloadKey === payloadKey) {
            clearPublishedPresenceCache();
          }
        });
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
    clearPublishedPresenceCache();
    publishPresence(true);
    bumpVisibilityVersion();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    onCleanup(() => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    });
  }

  createReactiveEffect(() => {
    const displayName = getTrimmedPresenceDisplayName(options.getDisplayName);
    const activeTaskId = options.getActiveTaskId();
    const connectionStatus = options.getConnectionStatus?.();
    const focusedSurface = getPresenceFocusedSurface(options);

    visibilityVersion();
    options.getControllingTaskIds();

    options.syncFocusedTypingLease?.(activeTaskId, focusedSurface);

    clearHeartbeatTimer();
    if (!canPublishPresence(displayName, connectionStatus)) {
      lastPayloadKey = '';
      return;
    }

    publishPresence(false, displayName);
    if (getPresenceVisibility() === 'hidden') {
      return;
    }

    startHeartbeat(displayName);

    onCleanup(() => {
      clearHeartbeatTimer();
    });
  });

  const removeForcedRepublishSubscription = options.subscribeForcedRepublish?.(() => {
    clearPublishedPresenceCache();
    bumpVisibilityVersion();
    publishPresence(true);
  });

  onCleanup(() => {
    clearHeartbeatTimer();
    removeForcedRepublishSubscription?.();
  });
}
