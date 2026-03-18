import { IPC } from '../../electron/ipc/channels.js';

export const REMOTE_LIVE_IPC_EVENT_CHANNELS = [
  IPC.AgentSupervisionChanged,
  IPC.GitStatusChanged,
  IPC.TaskCommandControllerChanged,
  IPC.TaskConvergenceChanged,
  IPC.TaskReviewChanged,
] as const;

export type RemoteLiveIpcEventChannel = (typeof REMOTE_LIVE_IPC_EVENT_CHANNELS)[number];

const REMOTE_LIVE_IPC_EVENT_CHANNEL_SET: ReadonlySet<string> = new Set(
  REMOTE_LIVE_IPC_EVENT_CHANNELS,
);

export function isRemoteLiveIpcEventChannel(channel: string): channel is RemoteLiveIpcEventChannel {
  return REMOTE_LIVE_IPC_EVENT_CHANNEL_SET.has(channel);
}
