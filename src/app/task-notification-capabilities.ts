import { createSignal } from 'solid-js';

import { IPC } from '../../electron/ipc/channels';
import {
  createUnsupportedTaskNotificationCapability,
  type TaskNotificationCapability,
  type TaskNotificationPermission,
} from '../domain/task-notification';
import { invoke } from '../lib/ipc';

function createElectronTaskNotificationCapability(
  checking: boolean,
  supported: boolean,
): TaskNotificationCapability {
  return {
    checking,
    permission: supported ? 'granted' : 'unavailable',
    provider: 'electron',
    supported,
  };
}

function createWebTaskNotificationCapability(
  permission: TaskNotificationPermission,
): TaskNotificationCapability {
  if (permission === 'unavailable') {
    return createUnsupportedTaskNotificationCapability();
  }

  return {
    checking: false,
    permission,
    provider: 'web',
    supported: true,
  };
}

function normalizeBrowserNotificationPermission(permission: unknown): TaskNotificationPermission {
  switch (permission) {
    case 'default':
    case 'denied':
    case 'granted':
      return permission;
    default:
      return 'unavailable';
  }
}

function getBrowserNotificationPermission(): TaskNotificationPermission {
  if (typeof Notification === 'undefined') {
    return 'unavailable';
  }

  return normalizeBrowserNotificationPermission(Notification.permission);
}

function getWebTaskNotificationCapability(): TaskNotificationCapability {
  return createWebTaskNotificationCapability(getBrowserNotificationPermission());
}

function getInitialTaskNotificationCapability(): TaskNotificationCapability {
  if (typeof window === 'undefined') {
    return createUnsupportedTaskNotificationCapability();
  }

  if (window.electron?.ipcRenderer) {
    return createElectronTaskNotificationCapability(true, false);
  }

  return getWebTaskNotificationCapability();
}

const [taskNotificationCapability, setTaskNotificationCapability] =
  createSignal<TaskNotificationCapability>(getInitialTaskNotificationCapability());

export function getTaskNotificationCapability(): TaskNotificationCapability {
  return taskNotificationCapability();
}

export async function initializeTaskNotificationCapabilityRuntime(
  electronRuntime: boolean,
): Promise<void> {
  await refreshTaskNotificationCapability(electronRuntime);
}

export async function refreshTaskNotificationCapability(
  electronRuntime: boolean,
): Promise<TaskNotificationCapability> {
  if (!electronRuntime) {
    const nextCapability = getWebTaskNotificationCapability();
    setTaskNotificationCapability(nextCapability);
    return nextCapability;
  }

  setTaskNotificationCapability(createElectronTaskNotificationCapability(true, false));

  const supported = await invoke(IPC.GetNotificationCapability).catch(() => false);
  const nextCapability = createElectronTaskNotificationCapability(false, supported);
  setTaskNotificationCapability(nextCapability);
  return nextCapability;
}

export async function requestTaskNotificationPermission(): Promise<TaskNotificationCapability> {
  const currentCapability = taskNotificationCapability();
  if (currentCapability.provider !== 'web' || typeof Notification === 'undefined') {
    return currentCapability;
  }

  const permission = normalizeBrowserNotificationPermission(
    await Notification.requestPermission().catch(() => 'denied'),
  );
  const nextCapability = createWebTaskNotificationCapability(permission);
  setTaskNotificationCapability(nextCapability);
  return nextCapability;
}

export function resetTaskNotificationCapabilityStateForTests(): void {
  setTaskNotificationCapability(getInitialTaskNotificationCapability());
}
