import { cleanupPanelEntries } from './core';
import { deleteRecordEntry } from '../lib/record-utils';
import { clearRemovedTaskCommandLeaseState } from '../app/task-command-lease-runtime';
import { removeTaskCommandControllerStoreState } from './task-command-controllers';
import { clearRecentTaskGitStatusPollAge } from './task-git-status';
import { clearTaskTerminalSlateCacheForAgent } from './task-terminal-slate';
import { clearTerminalStartupEntriesForTask } from './terminal-startup';
import type { AppStore, Task } from './types';

type TaskScopedCleanupSource =
  | Pick<Task, 'agentIds' | 'shellAgentIds' | 'worktreePath'>
  | null
  | undefined;

export function collectTaskAgentIds(task: TaskScopedCleanupSource): string[] {
  if (!task) {
    return [];
  }

  return Array.from(new Set([...task.agentIds, ...task.shellAgentIds]));
}

function removeTaskPermissionRequests(storeState: AppStore, taskId: string): void {
  for (const [agentId, requests] of Object.entries(storeState.permissionRequests)) {
    const remainingRequests = requests.filter((request) => request.taskId !== taskId);
    if (remainingRequests.length === 0) {
      deleteRecordEntry(storeState.permissionRequests, agentId);
      continue;
    }

    storeState.permissionRequests[agentId] = remainingRequests;
  }
}

export function removeTaskScopedStoreState(
  storeState: AppStore,
  taskId: string,
  task: TaskScopedCleanupSource = storeState.tasks[taskId],
): void {
  cleanupPanelEntries(storeState, taskId);

  if (task?.worktreePath) {
    clearRecentTaskGitStatusPollAge(task.worktreePath);
  }

  deleteRecordEntry(storeState.taskGitStatus, taskId);
  deleteRecordEntry(storeState.taskPorts, taskId);
  deleteRecordEntry(storeState.taskConvergence, taskId);
  deleteRecordEntry(storeState.taskReview, taskId);
  deleteRecordEntry(storeState.taskReviewSignals, taskId);
  deleteRecordEntry(storeState.taskSteps, taskId);
  deleteRecordEntry(storeState.taskStepSummaries, taskId);
  deleteRecordEntry(storeState.reviewComments, taskId);
  deleteRecordEntry(storeState.reviewPanelOpen, taskId);
  removeTaskCommandControllerStoreState(storeState, taskId);
  removeTaskPermissionRequests(storeState, taskId);
  storeState.permissionAutoRules = storeState.permissionAutoRules.filter(
    (rule) => rule.taskId !== taskId,
  );
  if (storeState.pendingAction?.taskId === taskId) {
    storeState.pendingAction = null;
  }
  if (storeState.sidebarFocusedTaskId === taskId) {
    storeState.sidebarFocusedTaskId = null;
  }

  for (const [requestId, request] of Object.entries(storeState.incomingTaskTakeoverRequests)) {
    if (request.taskId !== taskId) {
      continue;
    }

    deleteRecordEntry(storeState.incomingTaskTakeoverRequests, requestId);
  }
}

export function removeAgentScopedStoreState(
  storeState: AppStore,
  agentIds: Iterable<string>,
): void {
  for (const agentId of agentIds) {
    clearTaskTerminalSlateCacheForAgent(agentId);
    deleteRecordEntry(storeState.agents, agentId);
    deleteRecordEntry(storeState.agentActive, agentId);
    deleteRecordEntry(storeState.agentSupervision, agentId);
    deleteRecordEntry(storeState.permissionRequests, agentId);
  }
}

export function removeTerminalStoreState(
  storeState: AppStore,
  terminalId: string,
  options: {
    agentIdsToDelete?: Set<string>;
  } = {},
): void {
  const terminal = storeState.terminals[terminalId];
  if (!terminal) {
    return;
  }

  options.agentIdsToDelete?.add(terminal.agentId);
  cleanupPanelEntries(storeState, terminalId);
  deleteRecordEntry(storeState.terminals, terminalId);
}

export function removeTaskStoreState(storeState: AppStore, taskId: string): void {
  const task = storeState.tasks[taskId];
  deleteRecordEntry(storeState.tasks, taskId);
  removeTaskScopedStoreState(storeState, taskId, task);
}

export function clearRemovedTaskRuntimeState(taskIds: Iterable<string>): void {
  for (const taskId of taskIds) {
    void clearRemovedTaskCommandLeaseState(taskId);
    clearTerminalStartupEntriesForTask(taskId);
  }
}

export function reconcileTaskScopedStoreStateForExistingTasks(storeState: AppStore): string[] {
  const removedTaskIds = new Set<string>();

  function removeIfTaskMissing(taskId: string): void {
    if (storeState.tasks[taskId]) {
      return;
    }

    removedTaskIds.add(taskId);
    removeTaskScopedStoreState(storeState, taskId, null);
  }

  for (const taskId of Object.keys(storeState.taskGitStatus)) {
    removeIfTaskMissing(taskId);
  }
  for (const taskId of Object.keys(storeState.taskPorts)) {
    removeIfTaskMissing(taskId);
  }
  for (const taskId of Object.keys(storeState.taskConvergence)) {
    removeIfTaskMissing(taskId);
  }
  for (const taskId of Object.keys(storeState.taskReview)) {
    removeIfTaskMissing(taskId);
  }
  for (const taskId of Object.keys(storeState.taskReviewSignals)) {
    removeIfTaskMissing(taskId);
  }
  for (const taskId of Object.keys(storeState.taskSteps)) {
    removeIfTaskMissing(taskId);
  }
  for (const taskId of Object.keys(storeState.taskStepSummaries)) {
    removeIfTaskMissing(taskId);
  }
  for (const taskId of Object.keys(storeState.reviewComments)) {
    removeIfTaskMissing(taskId);
  }
  for (const taskId of Object.keys(storeState.reviewPanelOpen)) {
    removeIfTaskMissing(taskId);
  }
  for (const taskId of Object.keys(storeState.taskCommandControllers)) {
    removeIfTaskMissing(taskId);
  }
  for (const request of Object.values(storeState.incomingTaskTakeoverRequests)) {
    removeIfTaskMissing(request.taskId);
  }
  for (const requests of Object.values(storeState.permissionRequests)) {
    for (const request of requests) {
      removeIfTaskMissing(request.taskId);
    }
  }
  for (const rule of storeState.permissionAutoRules) {
    if (rule.taskId !== undefined) {
      removeIfTaskMissing(rule.taskId);
    }
  }

  return [...removedTaskIds];
}
