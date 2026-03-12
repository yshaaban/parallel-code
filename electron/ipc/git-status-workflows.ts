import { IPC } from './channels.js';
import {
  commitAll,
  discardUncommitted,
  getWorktreeStatus,
  invalidateWorktreeStatusCache,
  rebaseTask,
} from './git.js';
import { startGitWatcher, stopGitWatcher } from './git-watcher.js';

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

function emitGitStatusChanged(
  context: GitStatusWorkflowContext,
  worktreePath: string,
  status?: Awaited<ReturnType<typeof getWorktreeStatus>>,
): void {
  context.emitIpcEvent?.(IPC.GitStatusChanged, {
    worktreePath,
    ...(status ? { status } : {}),
  });
}

export async function refreshGitStatusWorkflow(
  context: GitStatusWorkflowContext,
  worktreePath: string,
): Promise<void> {
  invalidateWorktreeStatusCache(worktreePath);

  try {
    const status = await getWorktreeStatus(worktreePath);
    emitGitStatusChanged(context, worktreePath, status);
  } catch {
    emitGitStatusChanged(context, worktreePath);
  }
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
