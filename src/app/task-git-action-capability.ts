import { isTaskCloseInProgress } from '../domain/task-closing';
import { setPendingAction } from '../store/focus';
import { showNotification } from '../store/notification';
import { getProject, isProjectMissing } from '../store/projects';
import { isNonGitProject } from '../store/project-mode';
import { store } from '../store/state';
import { isCurrentBranchTask } from '../store/task-git-isolation';
import type { Task } from '../store/types';

export type TaskGitAction = 'merge' | 'push';

export type TaskGitActionDenialReason =
  | 'task_missing'
  | 'task_closing'
  | 'task_collapsed'
  | 'project_missing'
  | 'non_git_task'
  | 'project_root_task';

export type TaskGitActionDecision =
  | { allowed: true }
  | {
      allowed: false;
      message: string;
      reason: TaskGitActionDenialReason;
    };

export type TaskGitActionIntentSource = 'shortcut' | 'title-bar';

const ALLOWED_DECISION = { allowed: true } as const satisfies TaskGitActionDecision;

const DENIAL_MESSAGES = {
  merge: {
    task_missing: 'This task is no longer available to merge.',
    task_closing: 'Wait for the task to finish closing before merging.',
    task_collapsed: 'Restore this task before merging it.',
    project_missing: 'Reconnect the project folder before merging this task.',
    non_git_task: "Merge isn't available for non-Git tasks.",
    project_root_task:
      'This task already uses the project branch; there is no task worktree to merge.',
  },
  push: {
    task_missing: 'This task is no longer available to push.',
    task_closing: 'Wait for the task to finish closing before pushing.',
    task_collapsed: 'Restore this task before pushing it.',
    project_missing: 'Reconnect the project folder before pushing this task.',
    non_git_task: "Push isn't available for non-Git tasks.",
    project_root_task:
      "Push from project-root tasks isn't supported yet. Use the terminal or your Git client.",
  },
} as const satisfies Record<TaskGitAction, Record<TaskGitActionDenialReason, string>>;

function deny(action: TaskGitAction, reason: TaskGitActionDenialReason): TaskGitActionDecision {
  return { allowed: false, message: DENIAL_MESSAGES[action][reason], reason };
}

export function getTaskGitActionDecision(
  action: TaskGitAction,
  task: Task | undefined,
  context: { projectPathAvailable: boolean },
): TaskGitActionDecision {
  if (!task) {
    return deny(action, 'task_missing');
  }
  if (isTaskCloseInProgress(task)) {
    return deny(action, 'task_closing');
  }
  if (task.collapsed === true) {
    return deny(action, 'task_collapsed');
  }
  if (!context.projectPathAvailable) {
    return deny(action, 'project_missing');
  }
  if (isNonGitProject(task)) {
    return deny(action, 'non_git_task');
  }
  if (isCurrentBranchTask(task)) {
    return deny(action, 'project_root_task');
  }

  return ALLOWED_DECISION;
}

export function getCurrentTaskGitActionDecision(
  action: TaskGitAction,
  taskId: string,
): TaskGitActionDecision {
  const task = store.tasks[taskId];
  const project = task ? getProject(task.projectId) : undefined;
  return getTaskGitActionDecision(action, task, {
    projectPathAvailable:
      project !== undefined && project.path.trim().length > 0 && !isProjectMissing(project.id),
  });
}

export function notifyTaskGitActionDenial(
  decision: Extract<TaskGitActionDecision, { allowed: false }>,
): void {
  showNotification(decision.message, { kind: 'warning' });
}

export function requestTaskGitAction(
  action: TaskGitAction,
  taskId: string,
  _source: TaskGitActionIntentSource,
): TaskGitActionDecision {
  const decision = getCurrentTaskGitActionDecision(action, taskId);
  if (!decision.allowed) {
    notifyTaskGitActionDenial(decision);
    return decision;
  }

  const pendingAction = store.pendingAction;
  if (pendingAction?.type !== action || pendingAction.taskId !== taskId) {
    setPendingAction({ taskId, type: action });
  }
  return decision;
}
