import { IPC } from '../../electron/ipc/channels';
import type { TaskNotificationRequest } from '../domain/task-notification';
import { invoke } from '../lib/ipc';
import { listenNotificationClicked } from '../lib/ipc-events';

export interface TaskNotificationSink {
  show: (request: TaskNotificationRequest) => Promise<void>;
  subscribeClicks: (listener: (taskIds: string[]) => void) => () => void;
}

function createListenerSet(): {
  addListener: (listener: (taskIds: string[]) => void) => () => void;
  emit: (taskIds: string[]) => void;
} {
  const listeners = new Set<(taskIds: string[]) => void>();

  return {
    addListener(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(taskIds) {
      for (const listener of listeners) {
        listener(taskIds);
      }
    },
  };
}

export function createElectronTaskNotificationSink(): TaskNotificationSink {
  return {
    show(request) {
      return invoke(IPC.ShowNotification, request);
    },
    subscribeClicks(listener) {
      return listenNotificationClicked((payload) => {
        listener(payload.taskIds);
      });
    },
  };
}

export function createWebTaskNotificationSink(): TaskNotificationSink {
  const listenerSet = createListenerSet();

  return {
    async show(request) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
        return;
      }

      const notification = new Notification(request.title, {
        body: request.body,
        tag: `parallel-code:${request.title}:${request.taskIds.join(',')}`,
      });

      notification.onclick = () => {
        try {
          window.focus();
        } catch {
          // Ignore focus failures from the browser runtime.
        }
        listenerSet.emit(request.taskIds);
        notification.close();
      };
    },
    subscribeClicks(listener) {
      return listenerSet.addListener(listener);
    },
  };
}
