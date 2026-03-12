import { IPC } from './channels.js';
import { resolveHydraAdapterLaunch } from './hydra-adapter.js';
import { startTaskGitStatusMonitoring, stopTaskGitStatusWatcher } from './git-status-workflows.js';
import { ensurePlansDirectory, startPlanWatcher, stopPlanWatcher } from './plans.js';
import { spawnAgent as spawnPtyAgent } from './pty.js';
import { createTask, deleteTask } from './tasks.js';

export interface TaskWorkflowContext {
  emitIpcEvent?: (channel: IPC, payload: unknown) => void;
  sendToChannel: (channelId: string, msg: unknown) => void;
}

export interface SpawnTaskAgentWorkflowRequest {
  adapter?: 'hydra';
  agentId: string;
  args: string[];
  cols: number;
  command: string;
  cwd: string;
  env: unknown;
  isShell?: boolean;
  onOutput: { __CHANNEL_ID__: string };
  rows: number;
  taskId: string;
}

export interface CreateTaskWorkflowRequest {
  branchPrefix: string;
  name: string;
  projectRoot: string;
  symlinkDirs: string[];
}

export interface DeleteTaskWorkflowRequest {
  agentIds: string[];
  branchName: string;
  deleteBranch: boolean;
  projectRoot: string;
  taskId?: string;
}

interface ResolvedSpawnLaunch {
  args: string[];
  command: string;
  env: Record<string, string>;
  isInternalNodeProcess: boolean;
}

function filterStringEnvironment(envValue: unknown): Record<string, string> {
  if (!envValue || typeof envValue !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(envValue).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function logWorkflowWarning(message: string, error: unknown): void {
  console.warn(message, error);
}

function runWorkflowStep(step: () => void, warningMessage: string): void {
  try {
    step();
  } catch (error) {
    logWorkflowWarning(warningMessage, error);
  }
}

function startPlanWatcherSafely(
  context: TaskWorkflowContext,
  taskId: string,
  worktreePath: string,
): void {
  runWorkflowStep(() => {
    startPlanWatcher(taskId, worktreePath, (message) => {
      context.emitIpcEvent?.(IPC.PlanContent, message);
    });
  }, 'Failed to start plan watcher:');
}

function ensurePlansDirectorySafely(worktreePath: string): void {
  runWorkflowStep(() => {
    ensurePlansDirectory(worktreePath);
  }, 'Failed to set up plans directory:');
}

function startTaskGitWatcherSafely(
  context: TaskWorkflowContext,
  taskId: string,
  worktreePath: string,
): void {
  void startTaskGitStatusMonitoring(context, {
    taskId,
    worktreePath,
  }).catch((error) => {
    logWorkflowWarning('Failed to start git watcher:', error);
  });
}

function startTaskWorktreeWatchers(
  context: TaskWorkflowContext,
  taskId: string,
  worktreePath: string,
): void {
  ensurePlansDirectorySafely(worktreePath);
  startPlanWatcherSafely(context, taskId, worktreePath);
  startTaskGitWatcherSafely(context, taskId, worktreePath);
}

function resolveSpawnLaunch(request: SpawnTaskAgentWorkflowRequest): ResolvedSpawnLaunch {
  const env = filterStringEnvironment(request.env);
  if (request.adapter === 'hydra') {
    return resolveHydraAdapterLaunch({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env,
    });
  }

  return {
    command: request.command,
    args: request.args,
    env,
    isInternalNodeProcess: false,
  };
}

export function spawnTaskAgentWorkflow(
  context: TaskWorkflowContext,
  request: SpawnTaskAgentWorkflowRequest,
): void {
  const resolvedLaunch = resolveSpawnLaunch(request);

  spawnPtyAgent(context.sendToChannel, {
    taskId: request.taskId,
    agentId: request.agentId,
    command: resolvedLaunch.command,
    args: resolvedLaunch.args,
    cwd: request.cwd,
    env: resolvedLaunch.env,
    cols: request.cols,
    rows: request.rows,
    isShell: request.isShell === true,
    isInternalNodeProcess: resolvedLaunch.isInternalNodeProcess,
    onOutput: request.onOutput,
  });

  if (request.isShell || !request.cwd) {
    return;
  }

  startTaskWorktreeWatchers(context, request.taskId, request.cwd);
}

export async function createTaskWorkflow(
  context: TaskWorkflowContext,
  request: CreateTaskWorkflowRequest,
): Promise<Awaited<ReturnType<typeof createTask>>> {
  const result = await createTask(
    request.name,
    request.projectRoot,
    request.symlinkDirs,
    request.branchPrefix,
  );

  startTaskGitWatcherSafely(context, result.id, result.worktree_path);

  return result;
}

export async function deleteTaskWorkflow(request: DeleteTaskWorkflowRequest): Promise<void> {
  await deleteTask(request.agentIds, request.branchName, request.deleteBranch, request.projectRoot);

  if (!request.taskId) {
    return;
  }

  stopPlanWatcher(request.taskId);
  stopTaskGitStatusWatcher(request.taskId);
}
