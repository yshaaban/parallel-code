import electron from 'electron';
import { IPC } from './channels.js';
import { BadRequestError } from './errors.js';
import type { HandlerContext } from './handler-context.js';
import type { IpcHandlerMap } from './handlers.js';
import type { TaskNotificationRequest } from '../../src/domain/task-notification.js';

const { Notification } = electron;
const NOTIFICATION_RETENTION_TTL_MS = 5 * 60 * 1000;

type DesktopNotification = InstanceType<typeof Notification>;

const retainedNotifications = new Set<DesktopNotification>();
const notificationTimers = new WeakMap<DesktopNotification, ReturnType<typeof setTimeout>>();

function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestError(`${name} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestError(`${name} must not be blank`);
  }

  return trimmed;
}

function assertTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new BadRequestError('taskIds must be an array');
  }

  const taskIds = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
  if (taskIds.length !== value.length) {
    throw new BadRequestError('taskIds must contain only non-empty strings');
  }

  return taskIds;
}

function assertDesktopNotificationRequest(
  value: unknown,
): asserts value is TaskNotificationRequest {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestError('notification request must be an object');
  }

  const request = value as Record<string, unknown>;
  assertNonEmptyString(request.title, 'title');
  assertNonEmptyString(request.body, 'body');
  assertTaskIds(request.taskIds);
}

function releaseNotification(notification: DesktopNotification): void {
  retainedNotifications.delete(notification);

  const timer = notificationTimers.get(notification);
  if (timer !== undefined) {
    clearTimeout(timer);
    notificationTimers.delete(notification);
  }
}

function retainNotification(notification: DesktopNotification): void {
  retainedNotifications.add(notification);

  const timer = setTimeout(() => {
    releaseNotification(notification);
  }, NOTIFICATION_RETENTION_TTL_MS);
  notificationTimers.set(notification, timer);
}

export function createNotificationIpcHandlers(context: HandlerContext): IpcHandlerMap {
  return {
    [IPC.GetNotificationCapability]: () =>
      typeof Notification.isSupported !== 'function' || Notification.isSupported(),
    [IPC.ShowNotification]: (args) => {
      assertDesktopNotificationRequest(args);
      const request = args;

      if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) {
        return undefined;
      }

      const notification = new Notification({
        body: request.body,
        title: request.title,
      });
      const taskIds = [...request.taskIds];
      retainNotification(notification);
      notification.on('click', () => {
        context.window?.show?.();
        context.window?.focus?.();
        context.emitIpcEvent?.(IPC.NotificationClicked, { taskIds });
        releaseNotification(notification);
      });
      notification.on('close', () => {
        releaseNotification(notification);
      });
      try {
        notification.show();
      } catch (error) {
        releaseNotification(notification);
        throw error;
      }
      return undefined;
    },
  };
}
