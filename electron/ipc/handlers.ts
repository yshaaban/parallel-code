import { IPC } from './channels.js';
import { COORDINATOR_IPC_CHANNELS } from '../coordinator/channel-list.js';
import { createAgentIpcHandlers } from './agent-handlers.js';
import type { HandlerContext, IpcHandler } from './handler-context.js';
import { createLazyIpcHandlerGroup } from './lazy-handler-group.js';
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
import type { SavedStateDocument } from './saved-state-document.js';
import { loadTaskRegistryStateDocumentForEnv } from './storage.js';
import { createTaskNameRegistry } from '../../server/task-names.js';
import {
  configurePtyContentAuthorityCoordinator,
  getAgentLifecycleGeneration,
  getAgentMeta,
  writeToAgent,
} from './pty.js';
import { createTerminalContentRootAuthority } from './terminal-root-authority.js';
import { createAgentSessionWriterRuntime } from './agent-session-writer-authority.js';
import type { TaskRemovalLifecycleEvent } from './task-removal-owner.js';
import { createTrustedLocalTaskNotesIpcHandlers } from './task-notes-handlers.js';
import { DEFAULT_TASK_NOTES_WRITER_ENTITLEMENTS } from './task-notes-writer-entitlements.js';
import { getAgentSupervisionSnapshot } from './agent-supervision.js';
import { isTaskCommandLeaseGenerationHeld } from './task-command-leases.js';
import { createTaskPromptInputAdmissionService } from './task-prompt-input-admission.js';
import { readTaskPromptInputAdmissionCurrentState } from './task-prompt-input-handler.js';
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

export interface CreateIpcHandlersOptions {
  onTaskRemovalLifecycle?: (event: TaskRemovalLifecycleEvent) => void;
  syncTaskCatalogFromJson?: (state: SavedStateDocument) => void;
}

export function createIpcHandlers(
  context: HandlerContext,
  taskRegistry = createTaskNameRegistry(),
  savedRegistryState?: SavedStateDocument | null,
  options: CreateIpcHandlersOptions = {},
): IpcHandlerMap {
  const savedTaskRegistryState =
    savedRegistryState !== undefined
      ? savedRegistryState
      : loadTaskRegistryStateDocumentForEnv(context);

  context.agentSessionWriter ??= createAgentSessionWriterRuntime({
    getCurrentGeneration: getAgentLifecycleGeneration,
  });

  const promptInputAdmission =
    context.taskPromptInputAdmission ??
    createTaskPromptInputAdmissionService({
      getCurrentState: (expectation) =>
        readTaskPromptInputAdmissionCurrentState(
          {
            getAgentGeneration: getAgentLifecycleGeneration,
            getAgentMetadata: getAgentMeta,
            getSupervisionSnapshot: getAgentSupervisionSnapshot,
          },
          expectation,
        ),
      isLeaseHeld: (expectation) =>
        isTaskCommandLeaseGenerationHeld(
          expectation.taskId,
          expectation.controllerId,
          expectation.leaseOwnerId,
          expectation.leaseGeneration,
        ),
      writeFrame: (agentId, frame) => {
        writeToAgent(agentId, frame);
      },
    });
  context.taskPromptInputAdmission = promptInputAdmission;

  taskRegistry.restoreAuthorizedTaskRoots(savedTaskRegistryState ?? '{"tasks":{}}');
  if (savedTaskRegistryState) {
    taskRegistry.syncFromSavedState(savedTaskRegistryState);
    syncTaskWorkflowWorktreesFromSavedState(savedTaskRegistryState);
    options.syncTaskCatalogFromJson?.(savedTaskRegistryState);
  }

  configurePtyContentAuthorityCoordinator(taskRegistry.taskContentAuthorityCoordinator);
  const taskContentRootAuthority = createTerminalContentRootAuthority(taskRegistry);
  // HandlerContext identity is the coordinator runtime's server-lifecycle identity. Extend that
  // same composition object so workflow dependencies cannot accidentally create a second owner.
  const runtimeContext = Object.assign(context, {
    beginTaskContentRootAdmission: taskContentRootAuthority.beginCanonicalTaskAdmission,
  });

  function syncTaskNamesFromJson(state: SavedStateDocument): void {
    taskRegistry.syncFromSavedState(state);
  }

  const coordinatorHandlers = createLazyIpcHandlerGroup(COORDINATOR_IPC_CHANNELS, async () => {
    await runtimeContext.awaitCoordinatorRuntimeReady?.();
    const { createCoordinatorIpcHandlers } = await import('../coordinator/handlers.js');
    return createCoordinatorIpcHandlers(runtimeContext, taskRegistry);
  });

  const systemHandlers = createSystemIpcHandlers(runtimeContext, {
    beginTaskContentRootAdmission: taskContentRootAuthority.beginCanonicalTaskAdmission,
    beginTerminalContentRootAdmission: taskContentRootAuthority.beginTerminalAdmission,
    getTaskName: taskRegistry.getTaskName,
    getTaskMetadata: taskRegistry.getTaskMetadata,
    syncProjectBaseBranchesFromJson: syncConfiguredBaseBranchesFromSavedState,
    syncTaskNamesFromJson,
    syncTaskConvergenceFromJson: syncTaskConvergenceFromSavedState,
    syncTaskReviewSignalsFromJson: syncTaskReviewSignalsFromSavedState,
    syncTaskStepsFromJson: syncTaskStepsFromSavedState,
    syncTaskWorkflowWorktreesFromJson: syncTaskWorkflowWorktreesFromSavedState,
    ...(options.onTaskRemovalLifecycle
      ? { onTaskRemovalLifecycle: options.onTaskRemovalLifecycle }
      : {}),
    ...(options.syncTaskCatalogFromJson
      ? { syncTaskCatalogFromJson: options.syncTaskCatalogFromJson }
      : {}),
  });
  const taskNotesHandlers = runtimeContext.getTaskNotesService
    ? createTrustedLocalTaskNotesIpcHandlers({
        getService: runtimeContext.getTaskNotesService,
        principalId: 'local-workspace-owner',
        writerEntitlement:
          runtimeContext.taskNotesWriterEntitlements?.desktop ??
          DEFAULT_TASK_NOTES_WRITER_ENTITLEMENTS.desktop,
      })
    : {};

  return {
    ...createAgentIpcHandlers(runtimeContext, {
      promptInputAdmission,
    }),
    ...createServerStateIpcHandlers(runtimeContext),
    ...coordinatorHandlers,
    ...createTaskAiIpcHandlers(runtimeContext),
    ...createTaskAndGitIpcHandlers(runtimeContext, taskRegistry),
    ...createTaskCommandLeaseIpcHandlers(runtimeContext),
    ...createTaskConvergenceIpcHandlers(),
    ...createTaskReviewSignalsIpcHandlers(),
    ...createTaskStepsIpcHandlers(),
    ...createTaskContainerIpcHandlers(runtimeContext),
    ...createTaskPortIpcHandlers(),
    ...taskNotesHandlers,
    ...createNotificationIpcHandlers(runtimeContext),
    ...createUpdateIpcHandlers(runtimeContext),
    ...systemHandlers,
  } satisfies IpcHandlerMap;
}
