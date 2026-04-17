import { IPC } from './channels.js';
import { resolveHydraAdapterLaunch } from './hydra-adapter.js';
import { removeAgentSupervision, removeTaskSupervision } from './agent-supervision.js';
import { removeGitStatusSnapshot } from './git-status-state.js';
import { startTaskGitStatusMonitoring, stopTaskGitStatusWatcher } from './git-status-workflows.js';
import { ensurePlansDirectory, startPlanWatcher, stopPlanWatcher } from './plans.js';
import { spawnAgent as spawnPtyAgent } from './pty.js';
import {
  registerTaskConvergenceTask,
  removeTaskConvergence,
  scheduleTaskConvergenceRefresh,
} from './task-convergence-state.js';
import {
  registerTaskReviewTask,
  removeTaskReview,
  scheduleTaskReviewRefresh,
} from './task-review-state.js';
import { registerTaskStepsTask, removeTaskSteps } from './task-steps.js';
import { removeTaskPorts } from './task-ports.js';
import { createCurrentBranchTask, createTask, deleteTask } from './tasks.js';
import { getMainBranch } from './git.js';

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
  resumeOnStart?: boolean;
  rows: number;
  taskId: string;
}

export interface CreateTaskWorkflowRequest {
  baseBranch?: string;
  branchPrefix: string;
  gitIsolation?: 'worktree' | 'current-branch';
  name: string;
  projectId: string;
  projectRoot: string;
  stepsTracking?: boolean;
  symlinkDirs: string[];
}

export interface DeleteTaskWorkflowRequest {
  agentIds: string[];
  branchName: string;
  deleteBranch: boolean;
  projectRoot: string;
  taskId?: string;
  worktreePath?: string;
}

export interface CleanupTaskRuntimeWorkflowRequest {
  agentIds: string[];
  removeTaskState?: boolean;
  taskId: string;
  worktreePath?: string;
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

function registerTaskGitMetadata(options: {
  branchName: string;
  projectId: string;
  projectRoot: string;
  taskId: string;
  taskName: string;
  worktreePath: string;
}): void {
  registerTaskConvergenceTask({
    taskId: options.taskId,
    taskName: options.taskName,
    projectId: options.projectId,
    projectRoot: options.projectRoot,
    branchName: options.branchName,
    worktreePath: options.worktreePath,
  });
  registerTaskReviewTask({
    taskId: options.taskId,
    projectId: options.projectId,
    projectRoot: options.projectRoot,
    branchName: options.branchName,
    worktreePath: options.worktreePath,
  });
}

function registerTaskStepsMetadata(options: {
  stepsTracking?: boolean;
  taskId: string;
  worktreePath: string;
}): void {
  if (options.stepsTracking !== true) {
    return;
  }

  registerTaskStepsTask({
    taskId: options.taskId,
    worktreePath: options.worktreePath,
  });
}

export function stopTaskWorktreeWatchers(taskId: string): void {
  stopPlanWatcher(taskId);
  stopTaskGitStatusWatcher(taskId);
}

export function cleanupTaskRuntimeWorkflow(request: CleanupTaskRuntimeWorkflowRequest): void {
  for (const agentId of request.agentIds) {
    removeAgentSupervision(agentId);
  }

  stopTaskWorktreeWatchers(request.taskId);

  if (request.removeTaskState !== true) {
    return;
  }

  removeTaskSupervision(request.taskId);
  removeTaskConvergence(request.taskId);
  removeTaskReview(request.taskId);
  removeTaskSteps(request.taskId);
  removeTaskPorts(request.taskId);
  if (typeof request.worktreePath === 'string') {
    removeGitStatusSnapshot(request.worktreePath);
  }
}

function resolveSpawnLaunch(request: SpawnTaskAgentWorkflowRequest): ResolvedSpawnLaunch {
  const env = filterStringEnvironment(request.env);
  if (request.adapter === 'hydra') {
    return resolveHydraAdapterLaunch({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env,
      resumeOnStart: request.resumeOnStart === true,
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
): boolean {
  const resolvedLaunch = resolveSpawnLaunch(request);

  const attachedExistingSession = spawnPtyAgent(context.sendToChannel, {
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
    return attachedExistingSession;
  }

  startTaskWorktreeWatchers(context, request.taskId, request.cwd);
  return attachedExistingSession;
}

export async function createTaskWorkflow(
  context: TaskWorkflowContext,
  request: CreateTaskWorkflowRequest,
): Promise<
  | (Awaited<ReturnType<typeof createTask>> & { base_branch: string })
  | Awaited<ReturnType<typeof createCurrentBranchTask>>
> {
  if (request.gitIsolation === 'current-branch') {
    const result = await createCurrentBranchTask(request.projectRoot, request.baseBranch);

    registerTaskGitMetadata({
      taskId: result.id,
      taskName: request.name,
      projectId: request.projectId,
      projectRoot: request.projectRoot,
      branchName: result.branch_name,
      worktreePath: result.worktree_path,
    });
    registerTaskStepsMetadata({
      taskId: result.id,
      worktreePath: result.worktree_path,
      ...(request.stepsTracking !== undefined ? { stepsTracking: request.stepsTracking } : {}),
    });

    startTaskGitWatcherSafely(context, result.id, result.worktree_path);
    scheduleTaskConvergenceRefresh(result.id);
    scheduleTaskReviewRefresh(result.id);

    return result;
  }

  const result = await createTask(
    request.name,
    request.projectRoot,
    request.symlinkDirs,
    request.branchPrefix,
  );
  const baseBranch = await getMainBranch(request.projectRoot, request.baseBranch);

  registerTaskGitMetadata({
    taskId: result.id,
    taskName: request.name,
    projectId: request.projectId,
    projectRoot: request.projectRoot,
    branchName: result.branch_name,
    worktreePath: result.worktree_path,
  });
  registerTaskStepsMetadata({
    taskId: result.id,
    worktreePath: result.worktree_path,
    ...(request.stepsTracking !== undefined ? { stepsTracking: request.stepsTracking } : {}),
  });

  startTaskGitWatcherSafely(context, result.id, result.worktree_path);
  scheduleTaskConvergenceRefresh(result.id);
  scheduleTaskReviewRefresh(result.id);

  return {
    ...result,
    base_branch: baseBranch,
  };
}

export async function deleteTaskWorkflow(request: DeleteTaskWorkflowRequest): Promise<void> {
  await deleteTask(request.agentIds, request.branchName, request.deleteBranch, request.projectRoot);

  if (!request.taskId) {
    for (const agentId of request.agentIds) {
      removeAgentSupervision(agentId);
    }
    return;
  }

  cleanupTaskRuntimeWorkflow({
    agentIds: request.agentIds,
    removeTaskState: true,
    taskId: request.taskId,
    ...(typeof request.worktreePath === 'string' ? { worktreePath: request.worktreePath } : {}),
  });
}
