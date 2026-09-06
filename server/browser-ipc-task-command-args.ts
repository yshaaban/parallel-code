import { IPC } from '../electron/ipc/channels.js';
import { BadRequestError } from '../electron/ipc/errors.js';
import { getAgentSupervisionSnapshot } from '../electron/ipc/agent-supervision.js';
import { getAgentMeta } from '../electron/ipc/pty.js';
import { findRegisteredTaskIdForWorktreePath } from '../electron/ipc/task-workflows.js';
import { hasOwnKey } from '../src/lib/type-guards.js';

type BrowserIpcArgs = Record<string, unknown> | undefined;
type GetAgentTaskId = (agentId: string) => string | undefined;
type GetWorktreeTaskId = (worktreePath: string, preferredTaskId?: string) => string | null;
type BrowserIpcTaskMutationArgChannel =
  | IPC.SetTaskCollapsed
  | IPC.CleanupTaskRuntime
  | IPC.DeleteTask
  | IPC.GetTaskMergeOperationStatus
  | IPC.IssueTaskMergeOperation
  | IPC.MergeTask
  | IPC.PushTask
  | IPC.RebaseTask
  | IPC.StartTaskMergeOperation;
type BrowserIpcTaskCommandArgChannel =
  | BrowserIpcTaskMutationArgChannel
  | IPC.AcquireTaskCommandLease
  | IPC.AttachTerminalSession
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
  | IPC.ReportClientTaskFocus
  | IPC.ResizeAgent
  | IPC.SendTaskPromptInput
  | IPC.SpawnAgent
  | IPC.WriteToAgent;
type BrowserIpcTaskCommandArgNormalizer = (
  args: Record<string, unknown>,
  browserClientId: string,
  getAgentTaskId: GetAgentTaskId,
  getWorktreeTaskId: GetWorktreeTaskId,
) => Record<string, unknown>;

function getBackendAgentTaskId(agentId: string): string | undefined {
  return getAgentMeta(agentId)?.taskId ?? getAgentSupervisionSnapshot(agentId)?.taskId;
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

function normalizeAttachTerminalSessionArgs(
  args: Record<string, unknown>,
  browserClientId: string,
): Record<string, unknown> {
  // Managed restore is identity-only and never borrows task-command authority.
  // Compatibility launches still receive both authenticated identities.
  const normalized: Record<string, unknown> = {
    ...args,
    clientId: browserClientId,
  };
  if (args.sessionOwner === 'managed-agent' || args.sessionOwner === 'managed-task-shell') {
    delete normalized.controllerId;
    return normalized;
  }
  return { ...normalized, controllerId: browserClientId };
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

  const taskId = getWorktreeTaskId(
    args.worktreePath,
    typeof args.taskId === 'string' ? args.taskId : undefined,
  );
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

function stripTaskCommandLeaseIdentity(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest.clientId;
  return rest;
}

const BROWSER_IPC_TASK_MUTATION_ARG_NORMALIZERS = {
  [IPC.SetTaskCollapsed]: normalizeBrowserOwnedTaskArgs,
  [IPC.CleanupTaskRuntime]: normalizeBrowserOwnedTaskArgs,
  [IPC.DeleteTask]: normalizeBrowserOwnedTaskArgs,
  [IPC.GetTaskMergeOperationStatus]: normalizeBrowserOwnedTaskArgs,
  [IPC.IssueTaskMergeOperation]: normalizeBrowserOwnedTaskArgs,
  [IPC.MergeTask]: normalizeBrowserOwnedTaskArgs,
  [IPC.PushTask]: normalizeBrowserOwnedTaskArgs,
  [IPC.RebaseTask]: normalizeBrowserOwnedTaskArgs,
  [IPC.StartTaskMergeOperation]: normalizeBrowserOwnedTaskArgs,
} satisfies Record<BrowserIpcTaskMutationArgChannel, BrowserIpcTaskCommandArgNormalizer>;

const BROWSER_IPC_TASK_COMMAND_ARG_NORMALIZERS = {
  ...BROWSER_IPC_TASK_MUTATION_ARG_NORMALIZERS,
  [IPC.AcquireTaskCommandLease]: normalizeTaskCommandLeaseArgs,
  [IPC.AttachTerminalSession]: normalizeAttachTerminalSessionArgs,
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
  [IPC.ReportClientTaskFocus]: normalizeTaskCommandLeaseArgs,
  [IPC.ResizeAgent]: normalizeTerminalCommandArgs,
  [IPC.SendTaskPromptInput]: normalizeTerminalCommandArgs,
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
    if (
      channel === IPC.SpawnAgent ||
      channel === IPC.AttachTerminalSession ||
      channel === IPC.EnsureAgentSessionsBatch
    ) {
      throw new BadRequestError(
        'Browser client identity is required for terminal session admission',
      );
    }
    if (
      channel === IPC.AcquireTaskCommandLease ||
      channel === IPC.RenewTaskCommandLease ||
      channel === IPC.ReleaseTaskCommandLease ||
      channel === IPC.ReportClientTaskFocus
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
