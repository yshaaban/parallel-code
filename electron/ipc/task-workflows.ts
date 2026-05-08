import fs from 'fs';
import path from 'path';

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
import {
  registerTaskReviewSignalsTask,
  removeTaskReviewSignals,
  scheduleTaskReviewSignalsRefresh,
} from './task-review-signals.js';
import { registerTaskStepsTask, removeTaskSteps } from './task-steps.js';
import { removeTaskPorts } from './task-ports.js';
import { removeTaskContainerPreviewTargets } from './task-containers.js';
import { clearTaskCommandLeaseForTask } from './task-command-leases.js';
import { parsePersistedTaskLookupState } from './persisted-task-lookup-state.js';
import {
  createCurrentBranchTask,
  createTask,
  deleteTask,
  importExistingWorktreeTask,
} from './tasks.js';
import { getMainBranch } from './git.js';
import type { TaskCommandControllerSnapshot } from '../../src/domain/server-state.js';
import type { TaskGitIsolationMode } from '../../src/store/types.js';

export interface TaskWorkflowContext {
  emitIpcEvent?: (channel: IPC, payload: unknown) => void;
  sendToChannel: (channelId: string, msg: unknown) => void;
}

export interface SpawnTaskAgentWorkflowRequest {
  adapter?: 'hydra';
  agentId: string;
  args: string[];
  baseBranch?: string;
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
  existingWorktreePath?: string;
  gitIsolation?: TaskGitIsolationMode;
  githubUrl?: string;
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

export interface CleanupTaskRuntimeWorkflowResult {
  releasedTaskCommandController: TaskCommandControllerSnapshot | null;
}

interface ResolvedSpawnLaunch {
  args: string[];
  command: string;
  env: Record<string, string>;
  isInternalNodeProcess: boolean;
}

interface CreatedTaskRuntimeMetadata {
  branch_name: string;
  id: string;
  worktree_path: string;
}

const taskIdByWorktreeIdentity = new Map<string, string>();
const worktreeIdentityByTaskId = new Map<string, string>();

function getWorktreeIdentity(worktreePath: string): string {
  try {
    return fs.realpathSync(worktreePath);
  } catch {
    return path.resolve(worktreePath);
  }
}

function assertWorktreeIdentityAvailable(taskId: string | undefined, worktreePath: string): void {
  const identity = getWorktreeIdentity(worktreePath);
  const existingTaskId = taskIdByWorktreeIdentity.get(identity);
  if (existingTaskId !== undefined && existingTaskId !== taskId) {
    throw new Error(`Worktree is already registered for task ${existingTaskId}: ${worktreePath}`);
  }
}

function registerTaskWorktreeIdentity(taskId: string, worktreePath: string): void {
  const previousIdentity = worktreeIdentityByTaskId.get(taskId);
  if (previousIdentity !== undefined) {
    taskIdByWorktreeIdentity.delete(previousIdentity);
  }

  const identity = getWorktreeIdentity(worktreePath);
  const existingTaskId = taskIdByWorktreeIdentity.get(identity);
  if (existingTaskId !== undefined && existingTaskId !== taskId) {
    throw new Error(`Worktree is already registered for task ${existingTaskId}: ${worktreePath}`);
  }

  worktreeIdentityByTaskId.set(taskId, identity);
  taskIdByWorktreeIdentity.set(identity, taskId);
}

function removeTaskWorktreeIdentity(taskId: string): void {
  const identity = worktreeIdentityByTaskId.get(taskId);
  if (identity === undefined) {
    return;
  }

  worktreeIdentityByTaskId.delete(taskId);
  taskIdByWorktreeIdentity.delete(identity);
}

export function clearTaskWorkflowWorktreeRegistryForTests(): void {
  taskIdByWorktreeIdentity.clear();
  worktreeIdentityByTaskId.clear();
}

export function syncTaskWorkflowWorktreesFromSavedState(savedJson: string): void {
  taskIdByWorktreeIdentity.clear();
  worktreeIdentityByTaskId.clear();

  const parsed = parsePersistedTaskLookupState(savedJson);
  for (const task of Object.values(parsed.tasks)) {
    if (!task.id || !task.worktreePath) {
      continue;
    }

    const identity = getWorktreeIdentity(task.worktreePath);
    if (taskIdByWorktreeIdentity.has(identity)) {
      continue;
    }

    taskIdByWorktreeIdentity.set(identity, task.id);
    worktreeIdentityByTaskId.set(task.id, identity);
  }
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
  baseBranch: string | undefined,
  taskId: string,
  worktreePath: string,
): void {
  void startTaskGitStatusMonitoring(context, {
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    taskId,
    worktreePath,
  }).catch((error) => {
    logWorkflowWarning('Failed to start git watcher:', error);
  });
}

function startTaskWorktreeWatchers(
  context: TaskWorkflowContext,
  baseBranch: string | undefined,
  taskId: string,
  worktreePath: string,
): void {
  ensurePlansDirectorySafely(worktreePath);
  startPlanWatcherSafely(context, taskId, worktreePath);
  startTaskGitWatcherSafely(context, baseBranch, taskId, worktreePath);
}

function registerTaskGitMetadata(options: {
  baseBranch?: string;
  branchName: string;
  projectId: string;
  projectRoot: string;
  githubUrl?: string;
  taskId: string;
  taskName: string;
  worktreePath: string;
}): void {
  registerTaskConvergenceTask({
    ...(options.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
    taskId: options.taskId,
    taskName: options.taskName,
    projectId: options.projectId,
    projectRoot: options.projectRoot,
    branchName: options.branchName,
    worktreePath: options.worktreePath,
  });
  registerTaskReviewTask({
    ...(options.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
    taskId: options.taskId,
    projectId: options.projectId,
    projectRoot: options.projectRoot,
    branchName: options.branchName,
    worktreePath: options.worktreePath,
  });
  registerTaskReviewSignalsTask({
    ...(options.githubUrl !== undefined ? { githubUrl: options.githubUrl } : {}),
    taskId: options.taskId,
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

function registerCreatedTaskRuntime(
  context: TaskWorkflowContext,
  request: CreateTaskWorkflowRequest,
  result: CreatedTaskRuntimeMetadata,
  baseBranch: string | undefined,
): void {
  registerTaskWorktreeIdentity(result.id, result.worktree_path);

  registerTaskGitMetadata({
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    taskId: result.id,
    taskName: request.name,
    ...(request.githubUrl !== undefined ? { githubUrl: request.githubUrl } : {}),
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

  startTaskGitWatcherSafely(context, baseBranch, result.id, result.worktree_path);
  scheduleTaskConvergenceRefresh(result.id);
  scheduleTaskReviewRefresh(result.id);
  scheduleTaskReviewSignalsRefresh(result.id);
}

export function stopTaskWorktreeWatchers(taskId: string): void {
  stopPlanWatcher(taskId);
  stopTaskGitStatusWatcher(taskId);
}

export function cleanupTaskRuntimeWorkflow(
  request: CleanupTaskRuntimeWorkflowRequest,
): CleanupTaskRuntimeWorkflowResult {
  for (const agentId of request.agentIds) {
    removeAgentSupervision(agentId);
  }

  stopTaskWorktreeWatchers(request.taskId);

  if (request.removeTaskState !== true) {
    return {
      releasedTaskCommandController: null,
    };
  }

  const releasedTaskCommandController = clearTaskCommandLeaseForTask(request.taskId);
  removeTaskSupervision(request.taskId);
  removeTaskConvergence(request.taskId);
  removeTaskReview(request.taskId);
  removeTaskReviewSignals(request.taskId);
  removeTaskSteps(request.taskId);
  removeTaskPorts(request.taskId);
  removeTaskContainerPreviewTargets(request.taskId);
  removeTaskWorktreeIdentity(request.taskId);
  if (typeof request.worktreePath === 'string') {
    removeGitStatusSnapshot(request.worktreePath);
  }

  return {
    releasedTaskCommandController: releasedTaskCommandController.changed
      ? releasedTaskCommandController.snapshot
      : null,
  };
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

  startTaskWorktreeWatchers(context, request.baseBranch, request.taskId, request.cwd);
  return attachedExistingSession;
}

export async function createTaskWorkflow(
  context: TaskWorkflowContext,
  request: CreateTaskWorkflowRequest,
): Promise<
  | (Awaited<ReturnType<typeof createTask>> & { base_branch: string })
  | Awaited<ReturnType<typeof createCurrentBranchTask>>
  | Awaited<ReturnType<typeof importExistingWorktreeTask>>
> {
  if (request.gitIsolation === 'current-branch') {
    assertWorktreeIdentityAvailable(undefined, request.projectRoot);
    const result = await createCurrentBranchTask(request.projectRoot, request.baseBranch);
    const baseBranch = result.base_branch ?? request.baseBranch;
    registerCreatedTaskRuntime(context, request, result, baseBranch);

    return result;
  }

  if (request.gitIsolation === 'existing-worktree') {
    if (!request.existingWorktreePath) {
      throw new Error('existingWorktreePath is required for existing-worktree tasks');
    }

    assertWorktreeIdentityAvailable(undefined, request.existingWorktreePath);
    const result = await importExistingWorktreeTask(
      request.projectRoot,
      request.existingWorktreePath,
      request.baseBranch,
    );
    const baseBranch = result.base_branch ?? request.baseBranch;
    registerCreatedTaskRuntime(context, request, result, baseBranch);

    return result;
  }

  const result = await createTask(
    request.name,
    request.projectRoot,
    request.symlinkDirs,
    request.branchPrefix,
  );
  const baseBranch = await getMainBranch(request.projectRoot, request.baseBranch);
  registerCreatedTaskRuntime(context, request, result, baseBranch);

  return {
    ...result,
    base_branch: baseBranch,
  };
}

export async function deleteTaskWorkflow(
  request: DeleteTaskWorkflowRequest,
): Promise<CleanupTaskRuntimeWorkflowResult> {
  await deleteTask(request.agentIds, request.branchName, request.deleteBranch, request.projectRoot);

  if (!request.taskId) {
    for (const agentId of request.agentIds) {
      removeAgentSupervision(agentId);
    }
    return {
      releasedTaskCommandController: null,
    };
  }

  return cleanupTaskRuntimeWorkflow({
    agentIds: request.agentIds,
    removeTaskState: true,
    taskId: request.taskId,
    ...(typeof request.worktreePath === 'string' ? { worktreePath: request.worktreePath } : {}),
  });
}
