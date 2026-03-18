import { IPC } from '../../electron/ipc/channels';
import type {
  RendererInvokeRequestMap,
  RendererInvokeResponseMap,
} from '../domain/renderer-invoke';
import { BROWSER_CLIENT_ID_HEADER } from '../domain/browser-ipc';
import { getToken } from './auth';
import { getRemoteClientId } from './client-id';

type RemoteIpcChannel =
  | IPC.AcquireTaskCommandLease
  | IPC.ReleaseTaskCommandLease
  | IPC.RenewTaskCommandLease
  | IPC.ResizeAgent
  | IPC.WriteToAgent;

function allowsEmptyResult(channel: RemoteIpcChannel): boolean {
  switch (channel) {
    case IPC.ResizeAgent:
    case IPC.WriteToAgent:
      return true;
    default:
      return false;
  }
}

async function invokeRemoteIpc<TChannel extends RemoteIpcChannel>(
  channel: TChannel,
  args: RendererInvokeRequestMap[TChannel],
): Promise<RendererInvokeResponseMap[TChannel]> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [BROWSER_CLIENT_ID_HEADER]: getRemoteClientId(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`/api/ipc/${encodeURIComponent(channel)}`, {
    body: JSON.stringify(args),
    credentials: 'same-origin',
    headers,
    method: 'POST',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    result?: RendererInvokeResponseMap[TChannel];
  };

  if (!response.ok) {
    throw new Error(payload.error ?? `IPC request failed (${response.status})`);
  }

  if (!('result' in payload)) {
    if (allowsEmptyResult(channel)) {
      return undefined as RendererInvokeResponseMap[TChannel];
    }

    throw new Error(`IPC response for ${channel} did not include a result`);
  }

  return payload.result as RendererInvokeResponseMap[TChannel];
}

export function acquireRemoteTaskCommandLease(
  args: RendererInvokeRequestMap[IPC.AcquireTaskCommandLease],
): Promise<RendererInvokeResponseMap[IPC.AcquireTaskCommandLease]> {
  return invokeRemoteIpc(IPC.AcquireTaskCommandLease, args);
}

export function renewRemoteTaskCommandLease(
  args: RendererInvokeRequestMap[IPC.RenewTaskCommandLease],
): Promise<RendererInvokeResponseMap[IPC.RenewTaskCommandLease]> {
  return invokeRemoteIpc(IPC.RenewTaskCommandLease, args);
}

export function releaseRemoteTaskCommandLease(
  args: RendererInvokeRequestMap[IPC.ReleaseTaskCommandLease],
): Promise<RendererInvokeResponseMap[IPC.ReleaseTaskCommandLease]> {
  return invokeRemoteIpc(IPC.ReleaseTaskCommandLease, args);
}

export function writeRemoteAgent(
  args: RendererInvokeRequestMap[IPC.WriteToAgent],
): Promise<RendererInvokeResponseMap[IPC.WriteToAgent]> {
  return invokeRemoteIpc(IPC.WriteToAgent, args);
}

export function resizeRemoteAgent(
  args: RendererInvokeRequestMap[IPC.ResizeAgent],
): Promise<RendererInvokeResponseMap[IPC.ResizeAgent]> {
  return invokeRemoteIpc(IPC.ResizeAgent, args);
}
