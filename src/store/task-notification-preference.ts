import { DEFAULT_TASK_NOTIFICATIONS_ENABLED } from '../domain/task-notification';

interface PersistedTaskNotificationPreference {
  desktopNotificationsEnabled?: unknown;
  taskNotificationsEnabled?: unknown;
  taskNotificationsPreferenceInitialized?: unknown;
}

export function getPersistedTaskNotificationsEnabled(
  raw: PersistedTaskNotificationPreference,
): boolean {
  const persistedPreference = raw.taskNotificationsEnabled ?? raw.desktopNotificationsEnabled;
  if (
    raw.taskNotificationsPreferenceInitialized === true &&
    typeof persistedPreference === 'boolean'
  ) {
    return persistedPreference;
  }

  return DEFAULT_TASK_NOTIFICATIONS_ENABLED;
}
