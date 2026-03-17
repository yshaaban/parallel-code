import { createRenderEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import { onBrowserAuthenticated, sendBrowserControlMessage } from '../lib/ipc';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { store } from '../store/store';
import { getTaskCommandControllerUpdateCount } from '../store/task-command-controllers';

interface BrowserPresenceRuntimeOptions {
  getDisplayName: Accessor<string>;
}

const PRESENCE_HEARTBEAT_MS = 5_000;

function getTrimmedDisplayName(options: BrowserPresenceRuntimeOptions): string {
  return options.getDisplayName().trim();
}

function getBrowserVisibility(): 'hidden' | 'visible' {
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
    return 'visible';
  }

  return 'hidden';
}

function getFocusedSurface(): string | null {
  if (getBrowserVisibility() === 'hidden') {
    return 'hidden';
  }

  if (store.sidebarFocused) {
    return 'sidebar';
  }

  const activeTaskId = store.activeTaskId;
  if (!activeTaskId) {
    return null;
  }

  return store.focusedPanel[activeTaskId] ?? null;
}

function getControllingTaskIds(clientId: string): string[] {
  const controllingTaskIds: string[] = [];

  for (const [taskId, controller] of Object.entries(store.taskCommandControllers)) {
    if (controller.controllerId === clientId) {
      controllingTaskIds.push(taskId);
    }
  }

  return controllingTaskIds.sort();
}

function createPresencePayload(displayName: string, clientId: string) {
  return {
    type: 'update-presence' as const,
    activeTaskId: store.activeTaskId,
    controllingAgentIds: [] as string[],
    controllingTaskIds: getControllingTaskIds(clientId),
    displayName,
    focusedSurface: getFocusedSurface(),
    visibility: getBrowserVisibility(),
  };
}

export function createBrowserPresenceRuntime(options: BrowserPresenceRuntimeOptions): void {
  const clientId = getRuntimeClientId();
  const [visibilityVersion, setVisibilityVersion] = createSignal(0);
  let lastPayloadKey = '';
  let heartbeatTimer: number | undefined;

  function bumpVisibilityVersion(): void {
    setVisibilityVersion((currentVersion) => currentVersion + 1);
  }

  function publishPresence(force = false, displayName = getTrimmedDisplayName(options)): void {
    if (!displayName) {
      return;
    }

    const payload = createPresencePayload(displayName, clientId);
    const payloadKey = JSON.stringify(payload);
    if (!force && payloadKey === lastPayloadKey) {
      return;
    }

    lastPayloadKey = payloadKey;
    void sendBrowserControlMessage(payload).catch(() => {});
  }

  function handleVisibilityChange(): void {
    clearHeartbeatTimer();
    bumpVisibilityVersion();
    publishPresence(true);
  }

  function clearHeartbeatTimer(): void {
    if (heartbeatTimer === undefined) {
      return;
    }

    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    onCleanup(() => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    });
  }

  createRenderEffect(() => {
    const displayName = getTrimmedDisplayName(options);
    visibilityVersion();
    getTaskCommandControllerUpdateCount();

    clearHeartbeatTimer();
    publishPresence(false, displayName);
    if (!displayName || getBrowserVisibility() === 'hidden') {
      return;
    }

    heartbeatTimer = window.setInterval(() => {
      publishPresence(true, displayName);
    }, PRESENCE_HEARTBEAT_MS);

    onCleanup(() => {
      clearHeartbeatTimer();
    });
  });

  const removeAuthenticatedListener = onBrowserAuthenticated(() => {
    lastPayloadKey = '';
    bumpVisibilityVersion();
    publishPresence(true);
  });
  onCleanup(() => {
    clearHeartbeatTimer();
    removeAuthenticatedListener();
  });
}
