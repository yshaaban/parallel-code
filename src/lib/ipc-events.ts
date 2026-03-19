import { IPC } from '../../electron/ipc/channels';
import type { RendererEventChannel, RendererIpcEventPayloads } from '../domain/renderer-events';
import { listen } from './ipc';

export function listenRendererEvent<TChannel extends RendererEventChannel>(
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

export function listenNotificationClicked(
  listener: (payload: RendererIpcEventPayloads[IPC.NotificationClicked]) => void,
): () => void {
  return listenRendererEvent(IPC.NotificationClicked, listener);
}

export function listenAgentSupervisionChanged(
  listener: (payload: RendererIpcEventPayloads[IPC.AgentSupervisionChanged]) => void,
): () => void {
  return listenRendererEvent(IPC.AgentSupervisionChanged, listener);
}

export function listenGitStatusChanged(
  listener: (payload: RendererIpcEventPayloads[IPC.GitStatusChanged]) => void,
): () => void {
  return listenRendererEvent(IPC.GitStatusChanged, listener);
}

export function listenTaskPortsChanged(
  listener: (payload: RendererIpcEventPayloads[IPC.TaskPortsChanged]) => void,
): () => void {
  return listenRendererEvent(IPC.TaskPortsChanged, listener);
}

export function listenTaskConvergenceChanged(
  listener: (payload: RendererIpcEventPayloads[IPC.TaskConvergenceChanged]) => void,
): () => void {
  return listenRendererEvent(IPC.TaskConvergenceChanged, listener);
}

export function listenTaskReviewChanged(
  listener: (payload: RendererIpcEventPayloads[IPC.TaskReviewChanged]) => void,
): () => void {
  return listenRendererEvent(IPC.TaskReviewChanged, listener);
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

export function listenWorkspaceStateChanged(
  listener: (payload: RendererIpcEventPayloads[IPC.WorkspaceStateChanged]) => void,
): () => void {
  return listenRendererEvent(IPC.WorkspaceStateChanged, listener);
}

export function listenTaskCommandControllerChanged(
  listener: (payload: RendererIpcEventPayloads[IPC.TaskCommandControllerChanged]) => void,
): () => void {
  return listenRendererEvent(IPC.TaskCommandControllerChanged, listener);
}
