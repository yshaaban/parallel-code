import { cleanupPanelEntries } from './core';
import { deleteRecordEntry } from '../lib/record-utils';
import { removeTaskCommandControllerStoreState } from './task-command-controllers';
import { clearRecentTaskGitStatusPollAge } from './task-git-status';
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

export function removeTaskScopedStoreState(
  storeState: AppStore,
  taskId: string,
  task: TaskScopedCleanupSource = storeState.tasks[taskId],
): void {
  if (task?.worktreePath) {
    clearRecentTaskGitStatusPollAge(task.worktreePath);
  }

  deleteRecordEntry(storeState.taskGitStatus, taskId);
  deleteRecordEntry(storeState.taskPorts, taskId);
  deleteRecordEntry(storeState.taskConvergence, taskId);
  deleteRecordEntry(storeState.taskReview, taskId);
  removeTaskCommandControllerStoreState(storeState, taskId);
}

export function removeAgentScopedStoreState(
  storeState: AppStore,
  agentIds: Iterable<string>,
): void {
  for (const agentId of agentIds) {
    deleteRecordEntry(storeState.agents, agentId);
    deleteRecordEntry(storeState.agentActive, agentId);
    deleteRecordEntry(storeState.agentSupervision, agentId);
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
  cleanupPanelEntries(storeState, taskId);
  deleteRecordEntry(storeState.tasks, taskId);
  removeTaskScopedStoreState(storeState, taskId, task);
}
