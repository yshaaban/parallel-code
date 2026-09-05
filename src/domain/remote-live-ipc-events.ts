import { IPC } from '../../electron/ipc/channels.js';
import { isStringTupleMember } from '../lib/type-guards.js';

export const REMOTE_LIVE_IPC_EVENT_CHANNELS = [
  IPC.AgentSupervisionChanged,
  IPC.GitStatusChanged,
  IPC.TaskCommandControllerChanged,
  IPC.TaskConvergenceChanged,
  IPC.TaskReviewChanged,
  IPC.TaskReviewSignalsChanged,
  IPC.TaskStepsChanged,
  IPC.TaskNotesChanged,
] as const;

export type RemoteLiveIpcEventChannel = (typeof REMOTE_LIVE_IPC_EVENT_CHANNELS)[number];

export function isRemoteLiveIpcEventChannel(channel: string): channel is RemoteLiveIpcEventChannel {
  return isStringTupleMember(channel, REMOTE_LIVE_IPC_EVENT_CHANNELS);
}
