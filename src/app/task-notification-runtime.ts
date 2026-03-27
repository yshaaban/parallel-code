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
import { getTaskAttentionEntry } from './task-presentation-status';

const TASK_NOTIFICATION_DEBOUNCE_MS = 3_000;
const TASK_NOTIFICATION_NAME_LIST_LIMIT = 2;
const TASK_NOTIFICATION_PREVIEW_MAX_CHARS = 120;

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
  const singleTaskId = taskIds.length === 1 ? taskIds[0] : null;
  if (singleTaskId) {
    return createSingleTaskNotificationMessage(kind, singleTaskId);
  }

  const taskSummary = formatTaskNameSummary(taskIds);
  const verb = getPluralVerb(taskIds.length);
  if (kind === 'ready') {
    return {
      title: 'Tasks Ready',
      body: `${taskSummary} ${verb} ready for review`,
      taskIds: [...taskIds],
    };
  }

  return {
    title: 'Tasks Waiting for Input',
    body: `${taskSummary} ${verb} waiting for input`,
    taskIds: [...taskIds],
  };
}

function createSingleTaskNotificationMessage(
  kind: TaskNotificationKind,
  taskId: string,
): TaskNotificationRequest {
  const taskName = getTaskName(taskId);
  const attention = getTaskAttentionEntry(taskId);
  const preview = formatNotificationPreview(attention?.preview ?? null);

  if (kind === 'ready') {
    return {
      title: `${taskName} is ready`,
      body: preview ?? getDefaultReadyNotificationBody(attention?.focusPanel),
      taskIds: [taskId],
    };
  }

  return {
    title: `${taskName} is waiting for input`,
    body: preview ?? getDefaultWaitingNotificationBody(attention?.focusPanel),
    taskIds: [taskId],
  };
}

function getTaskName(taskId: string | undefined): string {
  if (!taskId) {
    return 'Task';
  }

  return store.tasks[taskId]?.name ?? taskId;
}

function formatTaskNameSummary(taskIds: readonly string[]): string {
  const uniqueNames = [...new Set(taskIds.map((taskId) => getTaskName(taskId)))];
  const listedNames = uniqueNames.slice(0, TASK_NOTIFICATION_NAME_LIST_LIMIT);
  const remainingCount = uniqueNames.length - listedNames.length;

  if (listedNames.length === 0) {
    return `${taskIds.length} tasks`;
  }

  if (remainingCount <= 0) {
    if (listedNames.length === 1) {
      return listedNames[0] ?? 'Task';
    }

    return `${listedNames.slice(0, -1).join(', ')} and ${listedNames[listedNames.length - 1]}`;
  }

  return `${listedNames.join(', ')}, and ${remainingCount} more`;
}

function getPluralVerb(count: number): 'are' | 'is' {
  return count === 1 ? 'is' : 'are';
}

function formatNotificationPreview(preview: string | null): string | null {
  if (!preview) {
    return null;
  }

  const normalizedPreview = preview.replace(/\s+/g, ' ').trim();
  if (normalizedPreview.length === 0) {
    return null;
  }

  switch (normalizedPreview) {
    case 'Ready':
    case 'Waiting':
    case 'Quiet':
    case 'Failed':
      return null;
  }

  if (normalizedPreview.length <= TASK_NOTIFICATION_PREVIEW_MAX_CHARS) {
    return normalizedPreview;
  }

  return `${normalizedPreview.slice(0, TASK_NOTIFICATION_PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

function getPanelNoun(focusPanel: string | undefined): string {
  if (!focusPanel) {
    return 'terminal';
  }

  if (focusPanel === 'prompt') {
    return 'prompt';
  }

  if (focusPanel.startsWith('shell:')) {
    return 'shell';
  }

  return 'terminal';
}

function getDefaultReadyNotificationBody(focusPanel: string | undefined): string {
  const panelNoun = getPanelNoun(focusPanel);
  if (panelNoun === 'prompt') {
    return 'Ready for your next prompt';
  }

  if (panelNoun === 'shell') {
    return 'Shell is ready for the next command';
  }

  return 'Ready for the next step';
}

function getDefaultWaitingNotificationBody(focusPanel: string | undefined): string {
  const panelNoun = getPanelNoun(focusPanel);
  if (panelNoun === 'prompt') {
    return 'Prompt panel is waiting for your response';
  }

  if (panelNoun === 'shell') {
    return 'Shell is waiting for your response';
  }

  return 'Terminal is waiting for your response';
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
        const deliverableTaskIds = taskIds.filter(
          (taskId) => Boolean(store.tasks[taskId]) && !shouldSuppressForVisiblePeer(taskId),
        );
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
