import { IPC } from './channels.js';
import {
  commitAll,
  discardUncommitted,
  getWorktreeStatus,
  invalidateWorktreeStatusCache,
  rebaseTask,
} from './git.js';
import { startGitWatcher, stopGitWatcher } from './git-watcher.js';
import type { WorktreeStatus } from '../../src/ipc/types.js';

export interface GitStatusWorkflowContext {
  emitIpcEvent?: (channel: IPC, payload: unknown) => void;
}

export interface TaskGitWatcherRequest {
  taskId: string;
  worktreePath: string;
}

export interface CommitAllWorkflowRequest {
  message: string;
  worktreePath: string;
}

export interface WorktreeWorkflowRequest {
  worktreePath: string;
}

export interface GitStatusChangedPayload {
  worktreePath: string;
  status?: WorktreeStatus;
}

function emitGitStatusChanged(
  context: GitStatusWorkflowContext,
  payload: GitStatusChangedPayload,
): void {
  context.emitIpcEvent?.(IPC.GitStatusChanged, payload);
}

export async function loadGitStatusChangedPayload(
  worktreePath: string,
): Promise<GitStatusChangedPayload> {
  invalidateWorktreeStatusCache(worktreePath);

  try {
    return {
      worktreePath,
      status: await getWorktreeStatus(worktreePath),
    };
  } catch {
    return { worktreePath };
  }
}

export async function refreshGitStatusWorkflow(
  context: GitStatusWorkflowContext,
  worktreePath: string,
): Promise<void> {
  emitGitStatusChanged(context, await loadGitStatusChangedPayload(worktreePath));
}

export function scheduleGitStatusRefresh(
  context: GitStatusWorkflowContext,
  worktreePath: string,
): void {
  void refreshGitStatusWorkflow(context, worktreePath);
}

export function startTaskGitStatusWatcher(
  context: GitStatusWorkflowContext,
  request: TaskGitWatcherRequest,
): Promise<void> {
  return startGitWatcher(request.taskId, request.worktreePath, () => {
    scheduleGitStatusRefresh(context, request.worktreePath);
  });
}

export async function startTaskGitStatusMonitoring(
  context: GitStatusWorkflowContext,
  request: TaskGitWatcherRequest,
): Promise<void> {
  await startTaskGitStatusWatcher(context, request);
  scheduleGitStatusRefresh(context, request.worktreePath);
}

export function stopTaskGitStatusWatcher(taskId: string): void {
  stopGitWatcher(taskId);
}

async function runGitMutationWorkflow<TResult>(
  context: GitStatusWorkflowContext,
  worktreePath: string,
  runMutation: () => Promise<TResult>,
): Promise<TResult> {
  const result = await runMutation();
  scheduleGitStatusRefresh(context, worktreePath);
  return result;
}

export async function commitAllWorkflow(
  context: GitStatusWorkflowContext,
  request: CommitAllWorkflowRequest,
): Promise<Awaited<ReturnType<typeof commitAll>>> {
  return runGitMutationWorkflow(context, request.worktreePath, () =>
    commitAll(request.worktreePath, request.message),
  );
}

export async function discardUncommittedWorkflow(
  context: GitStatusWorkflowContext,
  request: WorktreeWorkflowRequest,
): Promise<Awaited<ReturnType<typeof discardUncommitted>>> {
  return runGitMutationWorkflow(context, request.worktreePath, () =>
    discardUncommitted(request.worktreePath),
  );
}

export async function rebaseTaskWorkflow(
  context: GitStatusWorkflowContext,
  request: WorktreeWorkflowRequest,
): Promise<Awaited<ReturnType<typeof rebaseTask>>> {
  return runGitMutationWorkflow(context, request.worktreePath, () =>
    rebaseTask(request.worktreePath),
  );
}
