export type TaskNotificationKind = 'ready' | 'waiting';
export type TaskNotificationProvider = 'electron' | 'web' | 'none';
export type TaskNotificationPermission = 'granted' | 'default' | 'denied' | 'unavailable';

export interface TaskNotificationCapability {
  checking: boolean;
  permission: TaskNotificationPermission;
  provider: TaskNotificationProvider;
  supported: boolean;
}

export interface TaskNotificationRequest {
  body: string;
  taskIds: string[];
  title: string;
}

export function createUnsupportedTaskNotificationCapability(): TaskNotificationCapability {
  return {
    checking: false,
    permission: 'unavailable',
    provider: 'none',
    supported: false,
  };
}

export function isTaskNotificationPermissionGranted(
  capability: TaskNotificationCapability,
): boolean {
  return capability.supported && capability.permission === 'granted';
}
