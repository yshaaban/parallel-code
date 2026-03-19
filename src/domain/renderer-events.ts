import { IPC } from '../../electron/ipc/channels.js';
import type {
  AgentSupervisionEvent,
  GitStatusSyncEvent,
  RemoteAccessStatus,
  TaskCommandControllerSnapshot,
  TaskPortsEvent,
} from './server-state.js';
import type { TaskConvergenceEvent } from './task-convergence.js';
import type { TaskReviewEvent } from './task-review.js';

export interface PlanContentUpdate {
  content: string | null;
  fileName: string | null;
  relativePath: string | null;
  taskId: string;
}

export interface SaveAppStateNotification {
  savedAt: number;
  sourceId: string | null;
}

export interface WorkspaceStateChangedNotification {
  revision: number;
  savedAt: number;
  sourceId: string | null;
}

export interface NotificationClickedNotification {
  taskIds: string[];
}

export interface RendererIpcEventPayloads {
  [IPC.AgentSupervisionChanged]: AgentSupervisionEvent;
  [IPC.GitStatusChanged]: GitStatusSyncEvent;
  [IPC.PlanContent]: PlanContentUpdate;
  [IPC.NotificationClicked]: NotificationClickedNotification;
  [IPC.RemoteStatusChanged]: RemoteAccessStatus;
  [IPC.SaveAppState]: SaveAppStateNotification;
  [IPC.TaskCommandControllerChanged]: TaskCommandControllerSnapshot;
  [IPC.WorkspaceStateChanged]: WorkspaceStateChangedNotification;
  [IPC.TaskConvergenceChanged]: TaskConvergenceEvent;
  [IPC.TaskReviewChanged]: TaskReviewEvent;
  [IPC.TaskPortsChanged]: TaskPortsEvent;
}

export type RendererEventChannel = keyof RendererIpcEventPayloads;
