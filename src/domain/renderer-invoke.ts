import { IPC } from '../../electron/ipc/channels.js';
import type { AnyServerStateBootstrapSnapshot } from './server-state-bootstrap.js';
import type {
  AgentSupervisionSnapshot,
  RemoteAccessStatus,
  TaskPortExposureCandidate,
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
  [IPC.ReadPlanContent]:
    | {
        relativePath?: string;
        worktreePath: string;
      }
    | undefined;
  [IPC.GetAgentSupervision]: undefined;
  [IPC.GetRemoteStatus]: undefined;
  [IPC.GetTaskConvergence]: undefined;
  [IPC.GetServerStateBootstrap]: undefined;
  [IPC.GetTaskPorts]: undefined;
  [IPC.GetTaskPortExposureCandidates]:
    | {
        taskId: string;
        worktreePath: string;
      }
    | undefined;
  [IPC.ListRunningAgentIds]: undefined;
  [IPC.ExposePort]:
    | {
        label?: string;
        port: number;
        taskId: string;
      }
    | undefined;
  [IPC.RefreshTaskPortPreview]:
    | {
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
  [IPC.ReadPlanContent]: { content: string; fileName: string; relativePath: string } | null;
  [IPC.GetAgentSupervision]: AgentSupervisionSnapshot[];
  [IPC.GetRemoteStatus]: RemoteAccessStatus;
  [IPC.GetTaskConvergence]: TaskConvergenceSnapshot[];
  [IPC.GetServerStateBootstrap]: AnyServerStateBootstrapSnapshot[];
  [IPC.GetTaskPorts]: TaskPortSnapshot[];
  [IPC.GetTaskPortExposureCandidates]: TaskPortExposureCandidate[];
  [IPC.ListRunningAgentIds]: string[];
  [IPC.ExposePort]: TaskPortSnapshot;
  [IPC.RefreshTaskPortPreview]: TaskPortSnapshot | undefined;
  [IPC.StartRemoteServer]: RemoteAccessStartResult;
  [IPC.StopRemoteServer]: undefined;
  [IPC.UnexposePort]: TaskPortSnapshot | undefined;
  [IPC.WindowGetPosition]: Position;
  [IPC.WindowGetSize]: Size;
  [IPC.WindowIsFocused]: boolean;
  [IPC.WindowIsMaximized]: boolean;
}

export type RendererInvokeChannel = keyof RendererInvokeResponseMap;
