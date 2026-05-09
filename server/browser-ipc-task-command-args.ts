import { IPC } from '../electron/ipc/channels.js';
import { getAgentMeta } from '../electron/ipc/pty.js';
import { hasOwnKey } from '../src/lib/type-guards.js';

type BrowserIpcArgs = Record<string, unknown> | undefined;
type GetAgentTaskId = (agentId: string) => string | undefined;
type BrowserIpcTaskCommandArgChannel = IPC.ResizeAgent | IPC.SpawnAgent | IPC.WriteToAgent;
type BrowserIpcTaskCommandArgNormalizer = (
  args: Record<string, unknown>,
  browserClientId: string,
  getAgentTaskId: GetAgentTaskId,
) => Record<string, unknown>;

function getBackendAgentTaskId(agentId: string): string | undefined {
  return getAgentMeta(agentId)?.taskId;
}

function resolveTaskCommandTaskId(
  args: Record<string, unknown>,
  getAgentTaskId: GetAgentTaskId,
): string | undefined {
  if (typeof args.taskId === 'string') {
    return args.taskId;
  }

  if (typeof args.agentId !== 'string') {
    return undefined;
  }

  return getAgentTaskId(args.agentId);
}

function normalizeSpawnAgentArgs(
  args: Record<string, unknown>,
  browserClientId: string,
): Record<string, unknown> {
  return {
    ...args,
    controllerId: browserClientId,
  };
}

function normalizeTerminalCommandArgs(
  args: Record<string, unknown>,
  browserClientId: string,
  getAgentTaskId: GetAgentTaskId,
): Record<string, unknown> {
  const taskId = resolveTaskCommandTaskId(args, getAgentTaskId);

  return {
    ...args,
    controllerId: browserClientId,
    ...(typeof taskId === 'string' ? { taskId } : {}),
  };
}

const BROWSER_IPC_TASK_COMMAND_ARG_NORMALIZERS = {
  [IPC.ResizeAgent]: normalizeTerminalCommandArgs,
  [IPC.SpawnAgent]: normalizeSpawnAgentArgs,
  [IPC.WriteToAgent]: normalizeTerminalCommandArgs,
} satisfies Record<BrowserIpcTaskCommandArgChannel, BrowserIpcTaskCommandArgNormalizer>;

function isBrowserIpcTaskCommandArgChannel(
  channel: IPC,
): channel is BrowserIpcTaskCommandArgChannel {
  return hasOwnKey(BROWSER_IPC_TASK_COMMAND_ARG_NORMALIZERS, channel);
}

export function normalizeBrowserIpcTaskCommandArgs(
  channel: IPC,
  args: BrowserIpcArgs,
  browserClientId: string | null,
  getAgentTaskId: GetAgentTaskId = getBackendAgentTaskId,
): BrowserIpcArgs {
  if (!args || !browserClientId) {
    return args;
  }

  if (!isBrowserIpcTaskCommandArgChannel(channel)) {
    return args;
  }

  return BROWSER_IPC_TASK_COMMAND_ARG_NORMALIZERS[channel](args, browserClientId, getAgentTaskId);
}
