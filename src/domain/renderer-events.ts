import { IPC } from '../../electron/ipc/channels.js';
import type {
  AgentSupervisionEvent,
  GitStatusSyncEvent,
  RemoteAccessStatus,
  TaskCommandControllerSnapshot,
  TaskPortsEvent,
} from './server-state.js';
import type { TaskConvergenceEvent } from './task-convergence.js';
import type { TaskStepsEvent } from './task-steps.js';
import type { TaskReviewEvent } from './task-review.js';
import type { TaskReviewSignalsEvent } from './task-review-signals.js';
import type { AgentAvailabilityChangedEvent } from './agent-availability.js';
import type { CoordinatorEventEnvelope } from './coordinator.js';
import type { TaskNotesChangedNotification } from './task-notes.js';
import type { TaskReliabilityRuntimeEvent } from './task-reliability-runtime.js';

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
  [IPC.AgentAvailabilityChanged]: AgentAvailabilityChangedEvent;
  [IPC.AgentSupervisionChanged]: AgentSupervisionEvent;
  [IPC.CoordinatorChanged]: CoordinatorEventEnvelope;
  [IPC.GitStatusChanged]: GitStatusSyncEvent;
  [IPC.PlanContent]: PlanContentUpdate;
  [IPC.NotificationClicked]: NotificationClickedNotification;
  [IPC.RemoteStatusChanged]: RemoteAccessStatus;
  [IPC.SaveAppState]: SaveAppStateNotification;
  [IPC.TaskCommandControllerChanged]: TaskCommandControllerSnapshot;
  [IPC.WorkspaceStateChanged]: WorkspaceStateChangedNotification;
  [IPC.TaskConvergenceChanged]: TaskConvergenceEvent;
  [IPC.TaskReviewChanged]: TaskReviewEvent;
  [IPC.TaskReviewSignalsChanged]: TaskReviewSignalsEvent;
  [IPC.TaskPortsChanged]: TaskPortsEvent;
  [IPC.TaskStepsChanged]: TaskStepsEvent;
  [IPC.TaskNotesChanged]: TaskNotesChangedNotification;
  [IPC.TaskReliabilityChanged]: TaskReliabilityRuntimeEvent;
}

export type RendererEventChannel = keyof RendererIpcEventPayloads;
