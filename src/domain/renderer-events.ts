import { IPC } from '../../electron/ipc/channels.js';
import type {
  AgentSupervisionEvent,
  GitStatusSyncEvent,
  RemoteAccessStatus,
  TaskPortsEvent,
} from './server-state.js';

export interface PlanContentUpdate {
  content: string | null;
  fileName: string | null;
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
  [IPC.TaskPortsChanged]: TaskPortsEvent;
}

export type RendererEventChannel = keyof RendererIpcEventPayloads;
