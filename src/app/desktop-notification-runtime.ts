import { createEffect, createRoot, onCleanup, type Accessor } from 'solid-js';

import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { listenNotificationClicked } from '../lib/ipc-events';
import { setActiveTask } from '../store/navigation';
import { store } from '../store/state';
import { getTaskDotStatus, type TaskDotStatus } from '../store/taskStatus';

const DESKTOP_NOTIFICATION_DEBOUNCE_MS = 3_000;

type DesktopNotificationKind = 'ready' | 'waiting';

interface StartDesktopNotificationRuntimeOptions {
  electronRuntime: boolean;
  isWindowFocused: Accessor<boolean>;
}

function createDesktopNotificationMessage(
  kind: DesktopNotificationKind,
  taskIds: readonly string[],
): { body: string; title: string } {
  if (kind === 'ready') {
    return {
      title: 'Task Ready',
      body:
        taskIds.length === 1
          ? `${getTaskName(taskIds[0])} is ready for review`
          : `${taskIds.length} tasks ready for review`,
    };
  }

  return {
    title: 'Task Waiting',
    body:
      taskIds.length === 1
        ? `${getTaskName(taskIds[0])} needs your attention`
        : `${taskIds.length} tasks need your attention`,
  };
}

function getTaskName(taskId: string | undefined): string {
  if (!taskId) {
    return 'Task';
  }

  return store.tasks[taskId]?.name ?? taskId;
}

function getTrackedTaskIds(): string[] {
  return [...store.taskOrder, ...store.collapsedTaskOrder];
}

function isNotificationTargetStatus(status: TaskDotStatus): status is DesktopNotificationKind {
  return status === 'ready' || status === 'waiting';
}

export function startDesktopNotificationRuntime(
  options: StartDesktopNotificationRuntimeOptions,
): () => void {
  if (!options.electronRuntime) {
    return () => {};
  }

  return createRoot((dispose) => {
    const previousStatuses = new Map<string, TaskDotStatus>();
    const pendingByTaskId = new Map<string, DesktopNotificationKind>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    function clearPendingNotifications(): void {
      pendingByTaskId.clear();
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    }

    function scheduleDesktopNotification(kind: DesktopNotificationKind, taskId: string): void {
      if (!store.desktopNotificationsEnabled) {
        return;
      }

      pendingByTaskId.set(taskId, kind);
      if (flushTimer === undefined) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void flushDesktopNotifications();
        }, DESKTOP_NOTIFICATION_DEBOUNCE_MS);
      }
    }

    async function flushDesktopNotifications(): Promise<void> {
      if (options.isWindowFocused() || pendingByTaskId.size === 0) {
        pendingByTaskId.clear();
        return;
      }

      const readyTaskIds: string[] = [];
      const waitingTaskIds: string[] = [];
      for (const [taskId, kind] of pendingByTaskId) {
        if (kind === 'ready') {
          readyTaskIds.push(taskId);
          continue;
        }

        waitingTaskIds.push(taskId);
      }

      pendingByTaskId.clear();

      for (const [kind, taskIds] of [
        ['ready', readyTaskIds],
        ['waiting', waitingTaskIds],
      ] as const) {
        if (taskIds.length === 0) {
          continue;
        }

        const message = createDesktopNotificationMessage(kind, taskIds);
        await invoke(IPC.ShowNotification, {
          body: message.body,
          taskIds,
          title: message.title,
        }).catch((error) => {
          console.warn('Failed to show desktop notification', error);
        });
      }
    }

    createEffect(() => {
      const seenTaskIds = new Set<string>();

      for (const taskId of getTrackedTaskIds()) {
        seenTaskIds.add(taskId);
        const currentStatus = getTaskDotStatus(taskId);
        const previousStatus = previousStatuses.get(taskId);
        previousStatuses.set(taskId, currentStatus);

        if (previousStatus === undefined || previousStatus === currentStatus) {
          continue;
        }

        if (currentStatus === 'ready' && previousStatus !== 'ready') {
          scheduleDesktopNotification('ready', taskId);
          continue;
        }

        if (currentStatus === 'waiting' && previousStatus === 'busy') {
          scheduleDesktopNotification('waiting', taskId);
          continue;
        }

        if (!isNotificationTargetStatus(currentStatus)) {
          pendingByTaskId.delete(taskId);
        }
      }

      for (const taskId of previousStatuses.keys()) {
        if (seenTaskIds.has(taskId)) {
          continue;
        }

        previousStatuses.delete(taskId);
        pendingByTaskId.delete(taskId);
      }
    });

    createEffect(() => {
      if (options.isWindowFocused() || !store.desktopNotificationsEnabled) {
        clearPendingNotifications();
      }
    });

    const offNotificationClicked = listenNotificationClicked((event) => {
      const taskId = event.taskIds.find((entry) => Boolean(store.tasks[entry]));
      if (taskId) {
        setActiveTask(taskId);
      }
    });

    onCleanup(() => {
      clearPendingNotifications();
      previousStatuses.clear();
      offNotificationClicked();
    });

    return dispose;
  });
}
