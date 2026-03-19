import { createEffect, createRoot, createSignal, onCleanup, type Accessor } from 'solid-js';

import {
  isTaskNotificationPermissionGranted,
  type TaskNotificationCapability,
  type TaskNotificationKind,
  type TaskNotificationRequest,
} from '../domain/task-notification';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { setActiveTask } from '../store/navigation';
import { listPeerSessions } from '../store/peer-presence';
import { store } from '../store/state';
import { getTaskDotStatus, type TaskDotStatus } from '../store/taskStatus';
import { createTaskNotificationClaimCoordinator } from './task-notification-claims';
import type { TaskNotificationSink } from './task-notification-sinks';

const TASK_NOTIFICATION_DEBOUNCE_MS = 3_000;

interface StartTaskNotificationRuntimeOptions {
  capability: Accessor<TaskNotificationCapability>;
  isNotificationsArmed: Accessor<boolean>;
  isWindowFocused: Accessor<boolean>;
  sink: TaskNotificationSink;
}

function createTaskNotificationMessage(
  kind: TaskNotificationKind,
  taskIds: readonly string[],
): TaskNotificationRequest {
  if (kind === 'ready') {
    return {
      title: 'Task Ready',
      body:
        taskIds.length === 1
          ? `${getTaskName(taskIds[0])} is ready for review`
          : `${taskIds.length} tasks ready for review`,
      taskIds: [...taskIds],
    };
  }

  return {
    title: 'Task Waiting',
    body:
      taskIds.length === 1
        ? `${getTaskName(taskIds[0])} needs your attention`
        : `${taskIds.length} tasks need your attention`,
    taskIds: [...taskIds],
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

function isNotificationTargetStatus(status: TaskDotStatus): status is TaskNotificationKind {
  return status === 'ready' || status === 'waiting';
}

function getDocumentVisibilityState(): 'hidden' | 'visible' {
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
    return 'visible';
  }

  return 'hidden';
}

function isClientEngaged(
  capability: TaskNotificationCapability,
  isWindowFocused: boolean,
  documentVisibilityState: 'hidden' | 'visible',
): boolean {
  if (capability.provider === 'electron') {
    return isWindowFocused;
  }

  if (capability.provider === 'web') {
    return isWindowFocused || documentVisibilityState === 'visible';
  }

  return true;
}

function shouldClearPendingNotifications(
  capability: TaskNotificationCapability,
  options: StartTaskNotificationRuntimeOptions,
  documentVisibilityState: 'hidden' | 'visible',
): boolean {
  return (
    !options.isNotificationsArmed() ||
    !store.taskNotificationsEnabled ||
    !isTaskNotificationPermissionGranted(capability) ||
    isClientEngaged(capability, options.isWindowFocused(), documentVisibilityState)
  );
}

function shouldSuppressForVisiblePeer(taskId: string): boolean {
  const runtimeClientId = getRuntimeClientId();

  for (const session of listPeerSessions()) {
    if (session.clientId === runtimeClientId) {
      continue;
    }

    if (
      session.visibility === 'visible' &&
      session.activeTaskId === taskId &&
      session.focusedSurface !== null
    ) {
      return true;
    }
  }

  return false;
}

function createNotificationClaimKey(
  kind: TaskNotificationKind,
  taskIds: readonly string[],
): string {
  return `${kind}:${[...taskIds].sort().join(',')}`;
}

export function startTaskNotificationRuntime(
  options: StartTaskNotificationRuntimeOptions,
): () => void {
  return createRoot((dispose) => {
    const previousStatuses = new Map<string, TaskDotStatus>();
    const pendingByTaskId = new Map<string, TaskNotificationKind>();
    const claimCoordinator = createTaskNotificationClaimCoordinator();
    const [documentVisibilityState, setDocumentVisibilityState] = createSignal(
      getDocumentVisibilityState(),
    );
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    function clearPendingNotifications(): void {
      pendingByTaskId.clear();
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    }

    function scheduleTaskNotification(kind: TaskNotificationKind, taskId: string): void {
      if (!store.taskNotificationsEnabled) {
        return;
      }

      if (!isTaskNotificationPermissionGranted(options.capability())) {
        return;
      }

      pendingByTaskId.set(taskId, kind);
      if (flushTimer !== undefined) {
        return;
      }

      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushTaskNotifications();
      }, TASK_NOTIFICATION_DEBOUNCE_MS);
    }

    async function flushTaskNotifications(): Promise<void> {
      const capability = options.capability();
      if (
        pendingByTaskId.size === 0 ||
        shouldClearPendingNotifications(capability, options, documentVisibilityState())
      ) {
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
        const deliverableTaskIds = taskIds.filter((taskId) => {
          if (!store.tasks[taskId]) {
            return false;
          }

          return !shouldSuppressForVisiblePeer(taskId);
        });
        if (deliverableTaskIds.length === 0) {
          continue;
        }

        if (
          capability.provider === 'web' &&
          !claimCoordinator.claim(createNotificationClaimKey(kind, deliverableTaskIds))
        ) {
          continue;
        }

        await options.sink
          .show(createTaskNotificationMessage(kind, deliverableTaskIds))
          .catch((error) => {
            console.warn('Failed to show task notification', error);
          });
      }
    }

    createEffect(() => {
      const armed = options.isNotificationsArmed();
      const seenTaskIds = new Set<string>();

      for (const taskId of getTrackedTaskIds()) {
        seenTaskIds.add(taskId);
        const currentStatus = getTaskDotStatus(taskId);
        const previousStatus = previousStatuses.get(taskId);
        previousStatuses.set(taskId, currentStatus);

        if (!armed || previousStatus === undefined || previousStatus === currentStatus) {
          continue;
        }

        if (currentStatus === 'ready' && previousStatus !== 'ready') {
          scheduleTaskNotification('ready', taskId);
          continue;
        }

        if (currentStatus === 'waiting' && previousStatus === 'busy') {
          scheduleTaskNotification('waiting', taskId);
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
      const capability = options.capability();
      if (shouldClearPendingNotifications(capability, options, documentVisibilityState())) {
        clearPendingNotifications();
      }
    });

    const offNotificationClicked = options.sink.subscribeClicks((taskIds) => {
      clearPendingNotifications();
      const taskId = taskIds.find((entry) => Boolean(store.tasks[entry]));
      if (taskId) {
        setActiveTask(taskId);
      }
    });

    function handleVisibilityChange(): void {
      setDocumentVisibilityState(getDocumentVisibilityState());
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    onCleanup(() => {
      clearPendingNotifications();
      previousStatuses.clear();
      claimCoordinator.dispose();
      offNotificationClicked();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    });

    return dispose;
  });
}
