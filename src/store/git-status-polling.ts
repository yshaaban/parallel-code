import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import type { WorktreeStatus } from '../ipc/types';
import { store, setStore } from './core';

const INITIAL_ALL_TASKS_REFRESH_DELAY_MS = 10_000;
const ACTIVE_TASK_POLL_INTERVAL_MS = 15_000;
const ALL_TASKS_BASE_INTERVAL_MS = 30_000;
const ALL_TASKS_EXTRA_INTERVAL_MS = 5_000;
const ALL_TASKS_INTERVAL_CAP_MS = 120_000;
const INACTIVE_TASK_REFRESH_BATCH_SIZE = 4;

type GitStatusPollingOptions = {
  isAgentActive(agentId: string): boolean;
};

export type GitStatusPollingController = {
  applyGitStatusFromPush(worktreePath: string, status: WorktreeStatus): void;
  getRecentTaskGitStatusPollAge(worktreePath: string): number | null;
  refreshAllTaskGitStatus(): Promise<void>;
  refreshTaskStatus(taskId: string): void;
  rescheduleTaskStatusPolling(): void;
  startTaskStatusPolling(): void;
  stopTaskStatusPolling(): void;
};

function normalizeWorktreePath(worktreePath: string): string {
  return worktreePath.replace(/\/+$/, '');
}

export function createGitStatusPollingController(
  options: GitStatusPollingOptions,
): GitStatusPollingController {
  const recentTaskGitStatusPollAt = new Map<string, number>();

  let isRefreshingAll = false;
  let allTasksTimer: ReturnType<typeof setInterval> | null = null;
  let activeTaskTimer: ReturnType<typeof setInterval> | null = null;
  let allTasksInitialTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPollingTaskCount = 0;

  function getRecentTaskGitStatusPollAge(worktreePath: string): number | null {
    if (!worktreePath) return null;

    const normalizedPath = normalizeWorktreePath(worktreePath);
    const polledAt = recentTaskGitStatusPollAt.get(normalizedPath);
    if (polledAt === undefined) return null;

    return Date.now() - polledAt;
  }

  async function refreshTaskGitStatus(taskId: string): Promise<void> {
    const task = store.tasks[taskId];
    if (!task) return;

    try {
      const status = await invoke(IPC.GetWorktreeStatus, {
        worktreePath: task.worktreePath,
      });
      recentTaskGitStatusPollAt.set(normalizeWorktreePath(task.worktreePath), Date.now());
      setStore('taskGitStatus', taskId, status);
    } catch {
      // Worktree may not exist yet or was removed.
    }
  }

  async function refreshAllTaskGitStatus(): Promise<void> {
    if (isRefreshingAll) return;

    isRefreshingAll = true;
    try {
      const currentTaskId = store.activeTaskId;
      const taskIdsToRefresh = store.taskOrder.filter((taskId) => {
        if (taskId === currentTaskId) return false;

        const task = store.tasks[taskId];
        if (!task) return false;

        return !task.agentIds.some((agentId) => {
          const agent = store.agents[agentId];
          return agent?.status !== 'exited' && options.isAgentActive(agentId);
        });
      });

      for (
        let index = 0;
        index < taskIdsToRefresh.length;
        index += INACTIVE_TASK_REFRESH_BATCH_SIZE
      ) {
        const batch = taskIdsToRefresh.slice(index, index + INACTIVE_TASK_REFRESH_BATCH_SIZE);
        await Promise.allSettled(batch.map((taskId) => refreshTaskGitStatus(taskId)));
      }
    } finally {
      isRefreshingAll = false;
    }
  }

  async function refreshActiveTaskGitStatus(): Promise<void> {
    const taskId = store.activeTaskId;
    if (!taskId) return;
    await refreshTaskGitStatus(taskId);
  }

  function refreshTaskStatus(taskId: string): void {
    void refreshTaskGitStatus(taskId);
  }

  function applyGitStatusFromPush(worktreePath: string, status: WorktreeStatus): void {
    for (const task of Object.values(store.tasks)) {
      if (task.worktreePath !== worktreePath) continue;

      recentTaskGitStatusPollAt.set(normalizeWorktreePath(worktreePath), Date.now());
      setStore('taskGitStatus', task.id, status);
    }
  }

  function computeAllTasksInterval(): number {
    const taskCount = store.taskOrder.length;
    return Math.min(
      ALL_TASKS_INTERVAL_CAP_MS,
      ALL_TASKS_BASE_INTERVAL_MS + Math.max(0, taskCount - 3) * ALL_TASKS_EXTRA_INTERVAL_MS,
    );
  }

  function startTaskStatusPolling(): void {
    if (allTasksTimer || activeTaskTimer || allTasksInitialTimer) return;

    activeTaskTimer = setInterval(refreshActiveTaskGitStatus, ACTIVE_TASK_POLL_INTERVAL_MS);
    lastPollingTaskCount = store.taskOrder.length;
    allTasksTimer = setInterval(refreshAllTaskGitStatus, computeAllTasksInterval());
    allTasksInitialTimer = setTimeout(() => {
      allTasksInitialTimer = null;
      void refreshAllTaskGitStatus();
    }, INITIAL_ALL_TASKS_REFRESH_DELAY_MS);
    void refreshActiveTaskGitStatus();
  }

  function rescheduleTaskStatusPolling(): void {
    if (!allTasksTimer) return;

    const currentCount = store.taskOrder.length;
    if (currentCount === lastPollingTaskCount) return;

    lastPollingTaskCount = currentCount;
    clearInterval(allTasksTimer);
    allTasksTimer = setInterval(refreshAllTaskGitStatus, computeAllTasksInterval());
  }

  function stopTaskStatusPolling(): void {
    if (allTasksTimer) {
      clearInterval(allTasksTimer);
      allTasksTimer = null;
    }

    if (allTasksInitialTimer) {
      clearTimeout(allTasksInitialTimer);
      allTasksInitialTimer = null;
    }

    if (activeTaskTimer) {
      clearInterval(activeTaskTimer);
      activeTaskTimer = null;
    }

    lastPollingTaskCount = 0;
    recentTaskGitStatusPollAt.clear();
  }

  return {
    applyGitStatusFromPush,
    getRecentTaskGitStatusPollAge,
    refreshAllTaskGitStatus,
    refreshTaskStatus,
    rescheduleTaskStatusPolling,
    startTaskStatusPolling,
    stopTaskStatusPolling,
  };
}
