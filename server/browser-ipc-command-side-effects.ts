import { IPC } from '../electron/ipc/channels.js';
import type { ServerMessage } from '../electron/remote/protocol.js';
import type { CreateTaskResult } from '../src/ipc/types.js';
import {
  createGitStatusSyncRefreshEvent,
  type GitStatusSyncEvent,
} from '../src/domain/server-state.js';
import { hasOwnKey, isRecord } from '../src/lib/type-guards.js';
import type { TaskNameRegistry } from './task-names.js';

type GitStatusRefreshScope = {
  branchName?: string | undefined;
  projectRoot?: string | undefined;
  worktreePath?: string | undefined;
};

export interface BrowserIpcCommandSideEffectContext {
  broadcastControl: (message: ServerMessage) => void;
  emitGitStatusChanged: (payload: GitStatusSyncEvent) => void;
  removeGitStatus?: (worktreePath: string) => void;
  taskNames: TaskNameRegistry;
}

type BrowserIpcCommandSideEffect = (
  context: BrowserIpcCommandSideEffectContext,
  body: Record<string, unknown> | undefined,
  result: unknown,
) => void;
type BrowserIpcCommandSideEffectChannel =
  | IPC.CleanupTaskRuntime
  | IPC.CreateTask
  | IPC.DeleteTask
  | IPC.MergeArenaWorktree
  | IPC.MergeTask
  | IPC.PushTask
  | IPC.SaveAppState;
type CreateTaskGitIsolation = NonNullable<CreateTaskResult['git_isolation']>;
type CreateTaskProjectMode = NonNullable<CreateTaskResult['project_mode']>;

const CREATE_TASK_GIT_ISOLATION_VALUES = {
  'current-branch': true,
  'existing-worktree': true,
  worktree: true,
} satisfies Record<CreateTaskGitIsolation, true>;

const CREATE_TASK_PROJECT_MODE_VALUES = {
  git: true,
  'non-git': true,
} satisfies Record<CreateTaskProjectMode, true>;

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readCreateTaskGitIsolation(value: unknown): CreateTaskGitIsolation | undefined {
  return typeof value === 'string' && hasOwnKey(CREATE_TASK_GIT_ISOLATION_VALUES, value)
    ? value
    : undefined;
}

function readCreateTaskProjectMode(value: unknown): CreateTaskProjectMode | undefined {
  return typeof value === 'string' && hasOwnKey(CREATE_TASK_PROJECT_MODE_VALUES, value)
    ? value
    : undefined;
}

function getCreatedTaskWorktreeOwnership(options: {
  gitIsolation: CreateTaskGitIsolation | undefined;
  projectMode: CreateTaskProjectMode | undefined;
}): 'external' | 'managed' | null {
  if (options.projectMode === 'non-git') {
    return null;
  }

  return options.gitIsolation === 'worktree' || options.gitIsolation === undefined
    ? 'managed'
    : 'external';
}

function readOptionalRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function emitGitStatusRefresh(
  emitGitStatusChanged: BrowserIpcCommandSideEffectContext['emitGitStatusChanged'],
  scope: GitStatusRefreshScope,
): void {
  if (typeof scope.worktreePath === 'string') {
    emitGitStatusChanged(
      createGitStatusSyncRefreshEvent({
        ...(typeof scope.branchName === 'string' ? { branchName: scope.branchName } : {}),
        ...(typeof scope.projectRoot === 'string' ? { projectRoot: scope.projectRoot } : {}),
        worktreePath: scope.worktreePath,
      }),
    );
    return;
  }

  if (typeof scope.branchName === 'string' && typeof scope.projectRoot === 'string') {
    emitGitStatusChanged(
      createGitStatusSyncRefreshEvent({
        branchName: scope.branchName,
        projectRoot: scope.projectRoot,
      }),
    );
    return;
  }

  if (typeof scope.projectRoot === 'string') {
    emitGitStatusChanged(
      createGitStatusSyncRefreshEvent({
        projectRoot: scope.projectRoot,
      }),
    );
  }
}

function syncCreatedTask(
  context: BrowserIpcCommandSideEffectContext,
  body: Record<string, unknown> | undefined,
  result: unknown,
): void {
  const created = readOptionalRecord(result);
  const taskId = readOptionalString(created?.id);
  if (!created || !taskId) {
    return;
  }

  const gitIsolation =
    readCreateTaskGitIsolation(created.git_isolation) ??
    readCreateTaskGitIsolation(body?.gitIsolation);
  const branchName = readOptionalString(created.branch_name);
  const projectMode =
    readCreateTaskProjectMode(created.project_mode) ?? readCreateTaskProjectMode(body?.projectMode);
  const worktreePath = readOptionalString(created.worktree_path);
  const directMode = gitIsolation === 'current-branch' || body?.directMode === true;

  context.taskNames.registerCreatedTask(taskId, {
    agentDefId: readOptionalString(body?.agentDefId) ?? null,
    agentDefName: readOptionalString(body?.agentDefName) ?? null,
    branchName: branchName ?? null,
    directMode,
    gitIsolation: gitIsolation ?? null,
    projectMode: projectMode ?? null,
    taskName: readOptionalString(body?.name) ?? null,
    worktreePath: worktreePath ?? null,
    worktreeOwnership: getCreatedTaskWorktreeOwnership({ gitIsolation, projectMode }),
  });
  context.broadcastControl({
    type: 'task-event',
    event: 'created',
    taskId,
    ...(typeof body?.name === 'string' ? { name: body.name } : {}),
    ...(branchName !== undefined ? { branchName } : {}),
    ...(worktreePath !== undefined ? { worktreePath } : {}),
  });
}

function syncDeletedTask(
  context: BrowserIpcCommandSideEffectContext,
  body: Record<string, unknown> | undefined,
): void {
  const taskId = readOptionalString(body?.taskId);
  const branchName = readOptionalString(body?.branchName);
  const projectMode = readCreateTaskProjectMode(body?.projectMode);
  const projectRoot = readOptionalString(body?.projectRoot);
  const worktreePath = readOptionalString(body?.worktreePath);

  if (taskId !== undefined) {
    context.taskNames.deleteTask(taskId);
    context.broadcastControl({
      type: 'task-event',
      event: 'deleted',
      taskId,
      ...(branchName !== undefined ? { branchName } : {}),
      ...(worktreePath !== undefined ? { worktreePath } : {}),
    });
  }

  if (projectMode === 'non-git') {
    return;
  }

  if (worktreePath !== undefined) {
    emitGitStatusRefresh(context.emitGitStatusChanged, {
      branchName,
      projectRoot,
      worktreePath,
    });
    context.removeGitStatus?.(worktreePath);
    return;
  }

  emitGitStatusRefresh(context.emitGitStatusChanged, {
    branchName,
    projectRoot,
  });
}

function syncCleanedUpTaskRuntime(
  context: BrowserIpcCommandSideEffectContext,
  body: Record<string, unknown> | undefined,
): void {
  if (body?.removeTaskState !== true) {
    return;
  }

  syncDeletedTask(context, body);
}

function syncTaskNamesFromSavedState(
  context: BrowserIpcCommandSideEffectContext,
  body: Record<string, unknown> | undefined,
): void {
  if (typeof body?.json === 'string') {
    context.taskNames.syncFromSavedState(body.json);
  }
}

function refreshBranchGitStatus(
  context: BrowserIpcCommandSideEffectContext,
  body: Record<string, unknown> | undefined,
): void {
  emitGitStatusRefresh(context.emitGitStatusChanged, {
    branchName: readOptionalString(body?.branchName),
    projectRoot: readOptionalString(body?.projectRoot),
  });
}

const BROWSER_IPC_COMMAND_SIDE_EFFECTS = {
  [IPC.CleanupTaskRuntime]: syncCleanedUpTaskRuntime,
  [IPC.CreateTask]: syncCreatedTask,
  [IPC.DeleteTask]: syncDeletedTask,
  [IPC.MergeArenaWorktree]: refreshBranchGitStatus,
  [IPC.MergeTask]: refreshBranchGitStatus,
  [IPC.PushTask]: refreshBranchGitStatus,
  [IPC.SaveAppState]: syncTaskNamesFromSavedState,
} satisfies Record<BrowserIpcCommandSideEffectChannel, BrowserIpcCommandSideEffect>;

function isBrowserIpcCommandSideEffectChannel(
  channel: IPC,
): channel is BrowserIpcCommandSideEffectChannel {
  return hasOwnKey(BROWSER_IPC_COMMAND_SIDE_EFFECTS, channel);
}

export function runBrowserIpcCommandSideEffects(
  context: BrowserIpcCommandSideEffectContext,
  channel: IPC,
  body: Record<string, unknown> | undefined,
  result: unknown,
): void {
  if (!isBrowserIpcCommandSideEffectChannel(channel)) {
    return;
  }

  BROWSER_IPC_COMMAND_SIDE_EFFECTS[channel](context, body, result);
}
