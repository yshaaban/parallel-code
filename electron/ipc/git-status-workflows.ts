import { IPC } from './channels.js';
import { recordGitStatusSnapshot } from './git-status-state.js';
import {
  commitAll,
  discardUncommitted,
  getWorktreeStatus,
  invalidateGitQueryCacheForPath,
  invalidateWorktreeStatusCache,
  rebaseTask,
} from './git.js';
import { startGitWatcher, stopGitWatcher } from './git-watcher.js';
import {
  classifyGitStatusSyncEvent,
  createGitStatusSyncRefreshEvent,
  createGitStatusSyncSnapshotEvent,
  type GitStatusSyncEvent,
} from '../../src/domain/server-state.js';
import { assertNever } from '../../src/lib/assert-never.js';
import { enqueueBackendWork, type BackendWorkPriorityClass } from './backend-work-queue.js';
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
import { scheduleTaskReviewSignalsRefreshForWorktree } from './task-review-signals.js';
import { toSavedStateDocument, type SavedStateDocument } from './saved-state-document.js';
import { warn as logWarn } from '../log.js';

export interface GitStatusWorkflowContext {
  emitIpcEvent?: (channel: IPC, payload: unknown) => void;
  emitGitStatusChanged?: (payload: GitStatusSyncEvent) => void;
}

export interface TaskGitWatcherRequest {
  baseBranch?: string;
  taskId: string;
  worktreePath: string;
}

export interface CommitAllWorkflowRequest {
  message: string;
  worktreePath: string;
}

export interface WorktreeWorkflowRequest {
  baseBranch?: string;
  worktreePath: string;
}

const watcherRequestsByTaskId = new Map<string, TaskGitWatcherRequest>();
const taskIdByWatchedWorktreePath = new Map<string, string>();

function removeTaskWatcherRequest(taskId: string): void {
  const request = watcherRequestsByTaskId.get(taskId);
  watcherRequestsByTaskId.delete(taskId);
  if (!request || taskIdByWatchedWorktreePath.get(request.worktreePath) !== taskId) return;
  const remaining = [...watcherRequestsByTaskId.values()].find(
    (candidate) => candidate.worktreePath === request.worktreePath,
  );
  if (remaining) taskIdByWatchedWorktreePath.set(request.worktreePath, remaining.taskId);
  else taskIdByWatchedWorktreePath.delete(request.worktreePath);
}

function emitGitStatusChanged(
  context: GitStatusWorkflowContext,
  payload: GitStatusSyncEvent,
): void {
  const classification = classifyGitStatusSyncEvent(payload);
  let versionedPayload = payload;
  switch (classification.kind) {
    case 'snapshot':
      versionedPayload = {
        ...classification.event,
        stateVersion: recordGitStatusSnapshot(classification.event),
      };
      break;
    case 'refresh':
      break;
    default:
      assertNever(classification, 'Unhandled git status sync event kind');
  }

  if (context.emitGitStatusChanged) {
    context.emitGitStatusChanged(versionedPayload);
    return;
  }

  context.emitIpcEvent?.(IPC.GitStatusChanged, versionedPayload);
}

export function getSavedTaskWatcherRequests(
  savedState: string | SavedStateDocument,
): TaskGitWatcherRequest[] {
  const parsed = toSavedStateDocument(savedState).taskLookup;
  const requests: TaskGitWatcherRequest[] = [];
  for (const task of Object.values(parsed.tasks)) {
    if (!task.id || !task.worktreePath || task.projectMode === 'non-git') {
      continue;
    }

    requests.push({
      ...(task.baseBranch !== undefined ? { baseBranch: task.baseBranch } : {}),
      taskId: task.id,
      worktreePath: task.worktreePath,
    });
  }

  return requests;
}

export function findRegisteredGitWatcherRequestForTask(
  taskId: string,
): TaskGitWatcherRequest | undefined {
  return watcherRequestsByTaskId.get(taskId);
}

export function findRegisteredGitWatcherTaskIdForWorktree(worktreePath: string): string | null {
  return taskIdByWatchedWorktreePath.get(worktreePath) ?? null;
}

function restoreSavedTaskRequest(
  context: GitStatusWorkflowContext,
  request: TaskGitWatcherRequest,
): void {
  void Promise.resolve(startTaskGitStatusWatcher(context, request)).catch((error) => {
    logWarn('git.status', 'failed to restore saved task watcher', {
      error: String(error),
      taskId: request.taskId,
      worktreePath: request.worktreePath,
    });
  });
}

export async function loadGitStatusChangedPayload(
  worktreePath: string,
  baseBranch?: string,
): Promise<GitStatusSyncEvent> {
  invalidateGitQueryCacheForPath(worktreePath);
  invalidateWorktreeStatusCache(worktreePath);

  try {
    const status =
      baseBranch === undefined
        ? await getWorktreeStatus(worktreePath)
        : await getWorktreeStatus(worktreePath, baseBranch);
    return createGitStatusSyncSnapshotEvent({
      worktreePath,
      status,
    });
  } catch {
    return createGitStatusSyncRefreshEvent({ worktreePath });
  }
}

export async function refreshGitStatusWorkflow(
  context: GitStatusWorkflowContext,
  worktreePath: string,
  baseBranch?: string,
  priority?: BackendWorkPriorityClass,
): Promise<void> {
  emitGitStatusChanged(context, await loadGitStatusChangedPayload(worktreePath, baseBranch));
  scheduleTaskConvergenceRefreshForWorktree(worktreePath, priority);
  scheduleTaskReviewRefreshForWorktree(worktreePath, priority);
  scheduleTaskReviewSignalsRefreshForWorktree(worktreePath, priority);
}

export function scheduleGitStatusRefresh(
  context: GitStatusWorkflowContext,
  worktreePath: string,
  baseBranch?: string,
  priority?: BackendWorkPriorityClass,
): void {
  const taskId = taskIdByWatchedWorktreePath.get(worktreePath);
  void enqueueBackendWork(
    {
      key: `git-status:${worktreePath}`,
      ...(priority !== undefined ? { priority } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
    },
    () => refreshGitStatusWorkflow(context, worktreePath, baseBranch, priority),
  ).catch(() => {});
}

export function startTaskGitStatusWatcher(
  context: GitStatusWorkflowContext,
  request: TaskGitWatcherRequest,
): Promise<void> {
  removeTaskWatcherRequest(request.taskId);
  watcherRequestsByTaskId.set(request.taskId, request);
  taskIdByWatchedWorktreePath.set(request.worktreePath, request.taskId);
  return startGitWatcher(request.taskId, request.worktreePath, () => {
    scheduleGitStatusRefresh(context, request.worktreePath, request.baseBranch);
  });
}

export async function startTaskGitStatusMonitoring(
  context: GitStatusWorkflowContext,
  request: TaskGitWatcherRequest,
): Promise<void> {
  await startTaskGitStatusWatcher(context, request);
  if (watcherRequestsByTaskId.get(request.taskId) !== request) {
    return;
  }
  scheduleGitStatusRefresh(context, request.worktreePath, request.baseBranch);
}

export function restoreSavedTaskGitStatusMonitoring(
  context: GitStatusWorkflowContext,
  savedState: string | SavedStateDocument,
): void {
  for (const request of getSavedTaskWatcherRequests(savedState)) {
    restoreSavedTaskRequest(context, request);
  }
}

export function stopTaskGitStatusWatcher(taskId: string): void {
  removeTaskWatcherRequest(taskId);
  stopGitWatcher(taskId);
}

async function runGitMutationWorkflow<TResult>(
  context: GitStatusWorkflowContext,
  worktreePath: string,
  runMutation: () => Promise<TResult>,
): Promise<TResult> {
  const result = await runMutation();
  scheduleGitStatusRefresh(context, worktreePath, undefined, 'interactive');
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
    request.baseBranch === undefined
      ? rebaseTask(request.worktreePath)
      : rebaseTask(request.worktreePath, request.baseBranch),
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

export function resetGitStatusWorkflowRegistryForTests(): void {
  watcherRequestsByTaskId.clear();
  taskIdByWatchedWorktreePath.clear();
}
