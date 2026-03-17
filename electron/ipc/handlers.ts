import { IPC } from './channels.js';
import { createAgentIpcHandlers } from './agent-handlers.js';
import type { HandlerContext, IpcHandler } from './handler-context.js';
import { createServerStateIpcHandlers } from './server-state-handlers.js';
import { createSystemIpcHandlers } from './system-handlers.js';
import { createTaskCommandLeaseIpcHandlers } from './task-command-lease-handlers.js';
import { createTaskAiIpcHandlers } from './task-ai-handlers.js';
import { createTaskConvergenceIpcHandlers } from './task-convergence-handlers.js';
import { syncConfiguredBaseBranchesFromSavedState } from './git-branch.js';
import { syncTaskConvergenceFromSavedState } from './task-convergence-state.js';
import { createTaskPortIpcHandlers } from './task-port-handlers.js';
import { createTaskAndGitIpcHandlers } from './task-git-handlers.js';
export { BadRequestError } from './errors.js';
export type {
  DialogController,
  HandlerContext,
  IpcHandler,
  ShellController,
  WindowController,
} from './handler-context.js';

export type IpcHandlerMap = Partial<Record<IPC, IpcHandler>>;

export function createIpcHandlers(context: HandlerContext): IpcHandlerMap {
  const taskNames = new Map<string, string>();

  function syncTaskNamesFromJson(json: string): void {
    try {
      const state = JSON.parse(json) as { tasks?: Record<string, { id: string; name: string }> };
      const nextTaskNames = new Map<string, string>();
      if (!state.tasks) {
        taskNames.clear();
        return;
      }
      for (const task of Object.values(state.tasks)) {
        if (task.id && task.name) {
          nextTaskNames.set(task.id, task.name);
        }
      }
      taskNames.clear();
      for (const [taskId, taskName] of nextTaskNames) {
        taskNames.set(taskId, taskName);
      }
    } catch (error) {
      console.warn('Ignoring malformed saved state:', error);
    }
  }

  return {
    ...createAgentIpcHandlers(context),
    ...createServerStateIpcHandlers(context),
    ...createTaskAiIpcHandlers(context),
    ...createTaskAndGitIpcHandlers(context, taskNames),
    ...createTaskCommandLeaseIpcHandlers(context),
    ...createTaskConvergenceIpcHandlers(),
    ...createTaskPortIpcHandlers(),
    ...createSystemIpcHandlers(context, {
      getTaskName: (taskId: string) => taskNames.get(taskId) ?? taskId,
      syncProjectBaseBranchesFromJson: syncConfiguredBaseBranchesFromSavedState,
      syncTaskNamesFromJson,
      syncTaskConvergenceFromJson: syncTaskConvergenceFromSavedState,
    }),
  } satisfies IpcHandlerMap;
}
