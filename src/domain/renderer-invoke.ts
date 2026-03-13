import { IPC } from '../../electron/ipc/channels.js';
import type {
  AgentSupervisionSnapshot,
  RemoteAccessStatus,
  TaskPortSnapshot,
} from './server-state.js';
import type { TaskConvergenceSnapshot } from './task-convergence.js';

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  height: number;
  width: number;
}

export interface RemoteAccessStartResult {
  port: number;
  tailscaleUrl: string | null;
  token: string;
  url: string;
  wifiUrl: string | null;
}

export interface RendererInvokeRequestMap {
  [IPC.GetAgentSupervision]: undefined;
  [IPC.GetRemoteStatus]: undefined;
  [IPC.GetTaskConvergence]: undefined;
  [IPC.GetTaskPorts]: undefined;
  [IPC.ListRunningAgentIds]: undefined;
  [IPC.ExposePort]:
    | {
        label?: string;
        port: number;
        taskId: string;
      }
    | undefined;
  [IPC.StartRemoteServer]: { port?: number } | undefined;
  [IPC.StopRemoteServer]: undefined;
  [IPC.UnexposePort]:
    | {
        port: number;
        taskId: string;
      }
    | undefined;
  [IPC.WindowGetPosition]: undefined;
  [IPC.WindowGetSize]: undefined;
  [IPC.WindowIsFocused]: undefined;
  [IPC.WindowIsMaximized]: undefined;
}

export interface RendererInvokeResponseMap {
  [IPC.GetAgentSupervision]: AgentSupervisionSnapshot[];
  [IPC.GetRemoteStatus]: RemoteAccessStatus;
  [IPC.GetTaskConvergence]: TaskConvergenceSnapshot[];
  [IPC.GetTaskPorts]: TaskPortSnapshot[];
  [IPC.ListRunningAgentIds]: string[];
  [IPC.ExposePort]: TaskPortSnapshot;
  [IPC.StartRemoteServer]: RemoteAccessStartResult;
  [IPC.StopRemoteServer]: undefined;
  [IPC.UnexposePort]: TaskPortSnapshot | undefined;
  [IPC.WindowGetPosition]: Position;
  [IPC.WindowGetSize]: Size;
  [IPC.WindowIsFocused]: boolean;
  [IPC.WindowIsMaximized]: boolean;
}

export type RendererInvokeChannel = keyof RendererInvokeResponseMap;
