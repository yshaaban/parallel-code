import { IPC } from './channels.js';
import { recordGitStatusSnapshot } from './git-status-state.js';
import {
  commitAll,
  discardUncommitted,
  getWorktreeStatus,
  invalidateWorktreeStatusCache,
  rebaseTask,
} from './git.js';
import { startGitWatcher, stopGitWatcher } from './git-watcher.js';
import type { GitStatusSyncEvent } from '../../src/domain/server-state.js';
import {
  scheduleProjectTaskConvergenceRefresh,
  scheduleTaskConvergenceRefreshForBranch,
  scheduleTaskConvergenceRefreshForWorktree,
} from './task-convergence-state.js';
import {
  scheduleProjectTaskReviewRefresh,
  scheduleTaskReviewRefreshForBranch,
  scheduleTaskReviewRefreshForWorktree,
} from './task-review-state.js';
import type { PersistedTaskLookupState } from '../../src/store/types.js';

export interface GitStatusWorkflowContext {
  emitIpcEvent?: (channel: IPC, payload: unknown) => void;
  emitGitStatusChanged?: (payload: GitStatusSyncEvent) => void;
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
  payload: GitStatusSyncEvent,
): void {
  recordGitStatusSnapshot(payload);

  if (context.emitGitStatusChanged) {
    context.emitGitStatusChanged(payload);
    return;
  }

  context.emitIpcEvent?.(IPC.GitStatusChanged, payload);
}

function getSavedTaskWatcherRequests(savedJson: string): TaskGitWatcherRequest[] {
  try {
    const parsed = JSON.parse(savedJson) as PersistedTaskLookupState;
    const requests: TaskGitWatcherRequest[] = [];

    for (const task of Object.values(parsed.tasks ?? {})) {
      if (!task.id || !task.worktreePath) {
        continue;
      }

      requests.push({
        taskId: task.id,
        worktreePath: task.worktreePath,
      });
    }

    return requests;
  } catch {
    return [];
  }
}

function restoreSavedTaskRequest(
  context: GitStatusWorkflowContext,
  request: TaskGitWatcherRequest,
): void {
  scheduleGitStatusRefresh(context, request.worktreePath);
  void Promise.resolve(startTaskGitStatusWatcher(context, request)).catch(() => {});
}

export async function loadGitStatusChangedPayload(
  worktreePath: string,
): Promise<GitStatusSyncEvent> {
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
  scheduleTaskConvergenceRefreshForWorktree(worktreePath);
  scheduleTaskReviewRefreshForWorktree(worktreePath);
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

export function restoreSavedTaskGitStatusMonitoring(
  context: GitStatusWorkflowContext,
  savedJson: string,
): void {
  for (const request of getSavedTaskWatcherRequests(savedJson)) {
    restoreSavedTaskRequest(context, request);
  }
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

export function scheduleTaskConvergenceRefreshForGitTarget(target: {
  branchName?: string;
  projectRoot?: string;
  worktreePath?: string;
}): void {
  if (typeof target.worktreePath === 'string') {
    scheduleTaskConvergenceRefreshForWorktree(target.worktreePath);
    return;
  }

  if (typeof target.projectRoot === 'string' && typeof target.branchName === 'string') {
    scheduleTaskConvergenceRefreshForBranch(target.projectRoot, target.branchName);
    return;
  }

  if (typeof target.projectRoot === 'string') {
    scheduleProjectTaskConvergenceRefresh(target.projectRoot);
  }
}

export function scheduleTaskReviewRefreshForGitTarget(target: {
  branchName?: string;
  projectRoot?: string;
  worktreePath?: string;
}): void {
  if (typeof target.worktreePath === 'string') {
    scheduleTaskReviewRefreshForWorktree(target.worktreePath);
    return;
  }

  if (typeof target.projectRoot === 'string' && typeof target.branchName === 'string') {
    scheduleTaskReviewRefreshForBranch(target.projectRoot, target.branchName);
    return;
  }

  if (typeof target.projectRoot === 'string') {
    scheduleProjectTaskReviewRefresh(target.projectRoot);
  }
}
