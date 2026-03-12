import { IPC } from '../../electron/ipc/channels';
import type { RendererIpcEventPayloads } from '../domain/renderer-events';
import { listen } from './ipc';

export function listenRendererEvent<TChannel extends keyof RendererIpcEventPayloads>(
  channel: TChannel,
  listener: (payload: RendererIpcEventPayloads[TChannel]) => void,
): () => void {
  return listen(channel, (payload: unknown) => {
    listener(payload as RendererIpcEventPayloads[TChannel]);
  });
}

export function listenRemoteStatusChanged(
  listener: (payload: RendererIpcEventPayloads[IPC.RemoteStatusChanged]) => void,
): () => void {
  return listenRendererEvent(IPC.RemoteStatusChanged, listener);
}

export function listenGitStatusChanged(
  listener: (payload: RendererIpcEventPayloads[IPC.GitStatusChanged]) => void,
): () => void {
  return listenRendererEvent(IPC.GitStatusChanged, listener);
}

export function listenPlanContent(
  listener: (payload: RendererIpcEventPayloads[IPC.PlanContent]) => void,
): () => void {
  return listenRendererEvent(IPC.PlanContent, listener);
}

export function listenSaveAppState(
  listener: (payload: RendererIpcEventPayloads[IPC.SaveAppState]) => void,
): () => void {
  return listenRendererEvent(IPC.SaveAppState, listener);
}
