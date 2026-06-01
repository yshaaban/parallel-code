import { IPC } from '../electron/ipc/channels.js';
import { getAgentMeta } from '../electron/ipc/pty.js';
import { findRegisteredTaskIdForWorktreePath } from '../electron/ipc/task-workflows.js';
import { hasOwnKey } from '../src/lib/type-guards.js';

type BrowserIpcArgs = Record<string, unknown> | undefined;
type GetAgentTaskId = (agentId: string) => string | undefined;
type GetWorktreeTaskId = (worktreePath: string) => string | null;
type BrowserIpcTaskMutationArgChannel =
  | IPC.CleanupTaskRuntime
  | IPC.DeleteTask
  | IPC.MergeTask
  | IPC.PushTask
  | IPC.RebaseTask;
type BrowserIpcTaskCommandArgChannel =
  | BrowserIpcTaskMutationArgChannel
  | IPC.AcquireTaskCommandLease
  | IPC.CommitAll
  | IPC.ContainersDestroyTask
  | IPC.ContainersStartTask
  | IPC.ContainersStopTask
  | IPC.CoordinatorUiToolCall
  | IPC.DiscardUncommitted
  | IPC.EnsureAgentSessionsBatch
  | IPC.MergeArenaWorktree
  | IPC.ReleaseTaskCommandLease
  | IPC.RenewTaskCommandLease
  | IPC.ResizeAgent
  | IPC.SpawnAgent
  | IPC.WriteToAgent;
type BrowserIpcTaskCommandArgNormalizer = (
  args: Record<string, unknown>,
  browserClientId: string,
  getAgentTaskId: GetAgentTaskId,
  getWorktreeTaskId: GetWorktreeTaskId,
) => Record<string, unknown>;

function getBackendAgentTaskId(agentId: string): string | undefined {
  return getAgentMeta(agentId)?.taskId;
}

function resolveTaskCommandTaskId(
  args: Record<string, unknown>,
  getAgentTaskId: GetAgentTaskId,
): string | undefined {
  if (typeof args.agentId !== 'string') {
    if (typeof args.taskId === 'string') {
      return args.taskId;
    }

    return undefined;
  }

  return getAgentTaskId(args.agentId);
}

function normalizeBrowserOwnedTaskArgs(
  args: Record<string, unknown>,
  browserClientId: string,
): Record<string, unknown> {
  return {
    ...args,
    controllerId: browserClientId,
  };
}

function normalizeEnsureAgentSessionsBatchArgs(
  args: Record<string, unknown>,
  browserClientId: string,
): Record<string, unknown> {
  return {
    ...args,
    clientId: browserClientId,
  };
}

function normalizeTaskCommandLeaseArgs(
  args: Record<string, unknown>,
  browserClientId: string,
): Record<string, unknown> {
  return {
    ...args,
    clientId: browserClientId,
  };
}

function normalizeTerminalCommandArgs(
  args: Record<string, unknown>,
  browserClientId: string,
  getAgentTaskId: GetAgentTaskId,
): Record<string, unknown> {
  const rest = { ...args };
  delete rest.controllerId;
  delete rest.taskId;

  const taskId = resolveTaskCommandTaskId(args, getAgentTaskId);

  return {
    ...rest,
    controllerId: browserClientId,
    ...(typeof taskId === 'string' ? { taskId } : {}),
  };
}

function normalizeRegisteredWorktreeMutationArgs(
  args: Record<string, unknown>,
  browserClientId: string,
  _getAgentTaskId: GetAgentTaskId,
  getWorktreeTaskId: GetWorktreeTaskId,
): Record<string, unknown> {
  const rest = stripTaskCommandIdentity(args);

  if (typeof args.worktreePath !== 'string') {
    return rest;
  }

  const taskId = getWorktreeTaskId(args.worktreePath);
  if (!taskId) {
    return rest;
  }

  return {
    ...rest,
    controllerId: browserClientId,
    taskId,
  };
}

function stripTaskCommandIdentity(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest.controllerId;
  delete rest.taskId;
  return rest;
}

function stripEnsureAgentSessionsBatchIdentity(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const rest = stripTaskCommandIdentity(args);
  delete rest.clientId;

  if (!Array.isArray(rest.requests)) {
    return rest;
  }

  return {
    ...rest,
    requests: rest.requests.map((request) => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        return request;
      }

      const sanitizedRequest = { ...(request as Record<string, unknown>) };
      delete sanitizedRequest.taskId;
      delete sanitizedRequest.controllerId;
      return sanitizedRequest;
    }),
  };
}

function stripTaskCommandLeaseIdentity(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest.clientId;
  return rest;
}

const BROWSER_IPC_TASK_MUTATION_ARG_NORMALIZERS = {
  [IPC.CleanupTaskRuntime]: normalizeBrowserOwnedTaskArgs,
  [IPC.DeleteTask]: normalizeBrowserOwnedTaskArgs,
  [IPC.MergeTask]: normalizeBrowserOwnedTaskArgs,
  [IPC.PushTask]: normalizeBrowserOwnedTaskArgs,
  [IPC.RebaseTask]: normalizeBrowserOwnedTaskArgs,
} satisfies Record<BrowserIpcTaskMutationArgChannel, BrowserIpcTaskCommandArgNormalizer>;

const BROWSER_IPC_TASK_COMMAND_ARG_NORMALIZERS = {
  ...BROWSER_IPC_TASK_MUTATION_ARG_NORMALIZERS,
  [IPC.AcquireTaskCommandLease]: normalizeTaskCommandLeaseArgs,
  [IPC.CommitAll]: normalizeRegisteredWorktreeMutationArgs,
  [IPC.ContainersDestroyTask]: normalizeBrowserOwnedTaskArgs,
  [IPC.ContainersStartTask]: normalizeBrowserOwnedTaskArgs,
  [IPC.ContainersStopTask]: normalizeBrowserOwnedTaskArgs,
  [IPC.CoordinatorUiToolCall]: normalizeBrowserOwnedTaskArgs,
  [IPC.DiscardUncommitted]: normalizeRegisteredWorktreeMutationArgs,
  [IPC.EnsureAgentSessionsBatch]: normalizeEnsureAgentSessionsBatchArgs,
  [IPC.MergeArenaWorktree]: normalizeRegisteredWorktreeMutationArgs,
  [IPC.ReleaseTaskCommandLease]: normalizeTaskCommandLeaseArgs,
  [IPC.RenewTaskCommandLease]: normalizeTaskCommandLeaseArgs,
  [IPC.ResizeAgent]: normalizeTerminalCommandArgs,
  [IPC.SpawnAgent]: normalizeBrowserOwnedTaskArgs,
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
  getWorktreeTaskId: GetWorktreeTaskId = findRegisteredTaskIdForWorktreePath,
): BrowserIpcArgs {
  if (!args) {
    return args;
  }

  if (!browserClientId) {
    if (channel === IPC.EnsureAgentSessionsBatch) {
      return stripEnsureAgentSessionsBatchIdentity(args);
    }

    if (
      channel === IPC.AcquireTaskCommandLease ||
      channel === IPC.RenewTaskCommandLease ||
      channel === IPC.ReleaseTaskCommandLease
    ) {
      return stripTaskCommandLeaseIdentity(args);
    }

    if (isBrowserIpcTaskCommandArgChannel(channel)) {
      return stripTaskCommandIdentity(args);
    }

    return args;
  }

  if (!isBrowserIpcTaskCommandArgChannel(channel)) {
    return args;
  }

  return BROWSER_IPC_TASK_COMMAND_ARG_NORMALIZERS[channel](
    args,
    browserClientId,
    getAgentTaskId,
    getWorktreeTaskId,
  );
}
