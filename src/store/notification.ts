import { setStore } from './core';
import type { AppNotification } from './types';

const INFO_NOTIFICATION_AUTO_CLEAR_MS = 3_000;

let notificationTimer: ReturnType<typeof setTimeout> | null = null;

function clearNotificationTimer(): void {
  if (notificationTimer) {
    clearTimeout(notificationTimer);
    notificationTimer = null;
  }
}

export function showNotification(
  message: string,
  options: { kind?: AppNotification['kind']; persistent?: true } = {},
): void {
  const kind = options.kind ?? 'info';
  clearNotificationTimer();
  setStore('notification', {
    kind,
    message,
    ...(options.persistent ? { persistent: true as const } : {}),
  });
  if (kind === 'error' || options.persistent) {
    return;
  }

  notificationTimer = setTimeout(() => {
    notificationTimer = null;
    setStore('notification', null);
  }, INFO_NOTIFICATION_AUTO_CLEAR_MS);
}

export function clearNotification(): void {
  clearNotificationTimer();
  setStore('notification', null);
}
