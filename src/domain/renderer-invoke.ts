import { IPC } from '../../electron/ipc/channels.js';
import type { RemoteAccessStatus } from './server-state.js';

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
  [IPC.GetRemoteStatus]: undefined;
  [IPC.ListRunningAgentIds]: undefined;
  [IPC.StartRemoteServer]: { port?: number } | undefined;
  [IPC.StopRemoteServer]: undefined;
  [IPC.WindowGetPosition]: undefined;
  [IPC.WindowGetSize]: undefined;
  [IPC.WindowIsFocused]: undefined;
  [IPC.WindowIsMaximized]: undefined;
}

export interface RendererInvokeResponseMap {
  [IPC.GetRemoteStatus]: RemoteAccessStatus;
  [IPC.ListRunningAgentIds]: string[];
  [IPC.StartRemoteServer]: RemoteAccessStartResult;
  [IPC.StopRemoteServer]: undefined;
  [IPC.WindowGetPosition]: Position;
  [IPC.WindowGetSize]: Size;
  [IPC.WindowIsFocused]: boolean;
  [IPC.WindowIsMaximized]: boolean;
}

export type RendererInvokeChannel = keyof RendererInvokeResponseMap;
