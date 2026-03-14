import { IPC } from '../../electron/ipc/channels.js';
import type {
  AgentSupervisionEvent,
  GitStatusSyncEvent,
  RemoteAccessStatus,
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

export interface RendererIpcEventPayloads {
  [IPC.AgentSupervisionChanged]: AgentSupervisionEvent;
  [IPC.GitStatusChanged]: GitStatusSyncEvent;
  [IPC.PlanContent]: PlanContentUpdate;
  [IPC.RemoteStatusChanged]: RemoteAccessStatus;
  [IPC.SaveAppState]: SaveAppStateNotification;
  [IPC.TaskConvergenceChanged]: TaskConvergenceEvent;
  [IPC.TaskReviewChanged]: TaskReviewEvent;
  [IPC.TaskPortsChanged]: TaskPortsEvent;
}

export type RendererEventChannel = keyof RendererIpcEventPayloads;
