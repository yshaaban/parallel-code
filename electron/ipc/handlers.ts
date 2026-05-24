import { IPC } from './channels.js';
import { createAgentIpcHandlers } from './agent-handlers.js';
import type { HandlerContext, IpcHandler } from './handler-context.js';
import { createServerStateIpcHandlers } from './server-state-handlers.js';
import { createSystemIpcHandlers } from './system-handlers.js';
import { createNotificationIpcHandlers } from './notification-handlers.js';
import { createTaskCommandLeaseIpcHandlers } from './task-command-lease-handlers.js';
import { createTaskAiIpcHandlers } from './task-ai-handlers.js';
import { createTaskConvergenceIpcHandlers } from './task-convergence-handlers.js';
import { createTaskContainerIpcHandlers } from './task-container-handlers.js';
import { createTaskReviewSignalsIpcHandlers } from './task-review-signals-handlers.js';
import { createTaskStepsIpcHandlers } from './task-steps-handlers.js';
import { createUpdateIpcHandlers } from './update-handlers.js';
import { syncConfiguredBaseBranchesFromSavedState } from './git-branch.js';
import { syncTaskConvergenceFromSavedState } from './task-convergence-state.js';
import { syncTaskReviewSignalsFromSavedState } from './task-review-signals.js';
import { syncTaskStepsFromSavedState } from './task-steps.js';
import { syncTaskWorkflowWorktreesFromSavedState } from './task-workflows.js';
import { createTaskPortIpcHandlers } from './task-port-handlers.js';
import { createTaskAndGitIpcHandlers } from './task-git-handlers.js';
import { loadTaskRegistryStateForEnv } from './storage.js';
import { createTaskNameRegistry } from '../../server/task-names.js';
export { BadRequestError } from './errors.js';
export type {
  ClipboardController,
  DialogController,
  HandlerContext,
  IpcHandler,
  ShellController,
  WindowController,
  UpdateController,
} from './handler-context.js';

export type IpcHandlerMap = Partial<Record<IPC, IpcHandler>>;

export function createIpcHandlers(context: HandlerContext): IpcHandlerMap {
  const taskRegistry = createTaskNameRegistry();
  const savedTaskRegistryState = loadTaskRegistryStateForEnv(context);

  if (savedTaskRegistryState) {
    taskRegistry.syncFromSavedState(savedTaskRegistryState);
    syncTaskWorkflowWorktreesFromSavedState(savedTaskRegistryState);
  }

  function syncTaskNamesFromJson(json: string): void {
    taskRegistry.syncFromSavedState(json);
  }

  return {
    ...createAgentIpcHandlers(context),
    ...createServerStateIpcHandlers(context),
    ...createTaskAiIpcHandlers(context),
    ...createTaskAndGitIpcHandlers(context, taskRegistry),
    ...createTaskCommandLeaseIpcHandlers(context),
    ...createTaskConvergenceIpcHandlers(),
    ...createTaskReviewSignalsIpcHandlers(),
    ...createTaskStepsIpcHandlers(),
    ...createTaskContainerIpcHandlers(context),
    ...createTaskPortIpcHandlers(),
    ...createNotificationIpcHandlers(context),
    ...createUpdateIpcHandlers(context),
    ...createSystemIpcHandlers(context, {
      getTaskName: taskRegistry.getTaskName,
      getTaskMetadata: taskRegistry.getTaskMetadata,
      syncProjectBaseBranchesFromJson: syncConfiguredBaseBranchesFromSavedState,
      syncTaskNamesFromJson,
      syncTaskConvergenceFromJson: syncTaskConvergenceFromSavedState,
      syncTaskReviewSignalsFromJson: syncTaskReviewSignalsFromSavedState,
      syncTaskStepsFromJson: syncTaskStepsFromSavedState,
      syncTaskWorkflowWorktreesFromJson: syncTaskWorkflowWorktreesFromSavedState,
    }),
  } satisfies IpcHandlerMap;
}
