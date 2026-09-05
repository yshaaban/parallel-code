import {
  TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
  type TaskRemovalParticipantRequest,
} from '../../src/domain/task-removal-owner.js';
import type { DeleteTaskCleanupWarning } from '../../src/domain/task-cleanup.js';
import type { TaskCommandControllerSnapshot } from '../../src/domain/server-state.js';
import { cleanupTaskRuntimeWorkflow, stopTaskAgentWorkflowsForTask } from './task-workflows.js';
import { destroyManagedTaskContainersByLabels } from './task-containers.js';
import {
  quarantineManagedTaskWorktree,
  releaseQuarantinedTaskBranch,
  type ManagedTaskWorktreeRemovalRequest,
} from './task-worktree-removal.js';
import type {
  TaskRemovalCleanupStepRequest,
  TaskRemovalCleanupStepResult,
  TaskRemovalFinalizerRequest,
  TaskRemovalOwnerParticipant,
} from './task-removal-owner.js';
import type { WorkspaceTaskRemovalLegacyWriterGate } from './task-removal-legacy-writer-gate.js';
import type { JsonObject } from './workspace-state-storage.js';
import type {
  FinalizeTaskShellSessionRemovalRequest,
  PrepareTaskShellSessionRemovalRequest,
} from './task-shell-session-workflow.js';

export type TaskRuntimeRemovalParticipant = TaskRemovalOwnerParticipant & {
  cleanupTaskRuntimeStep(
    request: TaskRemovalCleanupStepRequest,
  ): Promise<TaskRemovalCleanupStepResult>;
  id: 'task-runtime';
};

export interface TaskRuntimeRemovalParticipantDependencies {
  cleanupContainers?(request: TaskRemovalParticipantRequest): Promise<void>;
  cleanupCoordinatorTaskState(taskId: string): Promise<readonly DeleteTaskCleanupWarning[]>;
  cleanupRunners?(request: TaskRemovalParticipantRequest): Promise<void>;
  cleanupRuntimeState?(
    request: TaskRemovalParticipantRequest,
  ):
    | Promise<{ releasedTaskCommandController: TaskCommandControllerSnapshot | null }>
    | { releasedTaskCommandController: TaskCommandControllerSnapshot | null };
  finalizeRemovedTaskState(request: TaskRemovalFinalizerRequest): Promise<void> | void;
  finalizeTaskShellRemoval?(request: FinalizeTaskShellSessionRemovalRequest): Promise<void>;
  legacyWriterGate: WorkspaceTaskRemovalLegacyWriterGate;
  onReleasedTaskCommandController?(snapshot: TaskCommandControllerSnapshot): void;
  prepareTaskShellRemoval?(request: PrepareTaskShellSessionRemovalRequest): Promise<JsonObject>;
  quarantineWorktree?(request: ManagedTaskWorktreeRemovalRequest): Promise<JsonObject>;
  releaseBranch?(
    request: ManagedTaskWorktreeRemovalRequest,
    quarantineEvidence: Readonly<JsonObject> | undefined,
  ): Promise<JsonObject>;
}

function summarizeWarnings(warnings: readonly DeleteTaskCleanupWarning[]): string {
  return warnings
    .map((warning) => `${warning.kind}: ${warning.message}`)
    .join('; ')
    .slice(0, 1_024);
}

/**
 * Required generic-removal participant for backend infrastructure. The durable removal owner
 * supplies the frozen plan, persists each returned evidence record, and retries the first unfinished
 * idempotent step; only after every required owner succeeds may canonical membership be removed.
 */
export function createTaskRuntimeRemovalParticipant(
  dependencies: TaskRuntimeRemovalParticipantDependencies,
): TaskRuntimeRemovalParticipant {
  const cleanupRunners =
    dependencies.cleanupRunners ??
    ((request: TaskRemovalParticipantRequest) =>
      stopTaskAgentWorkflowsForTask(request.taskId, request.cleanupPlan.agentIds));
  const cleanupContainers =
    dependencies.cleanupContainers ??
    ((request: TaskRemovalParticipantRequest) =>
      destroyManagedTaskContainersByLabels({
        projectPath: request.cleanupPlan.projectRoot,
        taskId: request.taskId,
        worktreePath: request.cleanupPlan.worktreePath,
      }));
  const cleanupRuntimeState =
    dependencies.cleanupRuntimeState ??
    ((request: TaskRemovalParticipantRequest) =>
      cleanupTaskRuntimeWorkflow({
        agentIds: [...request.cleanupPlan.agentIds],
        projectMode: request.cleanupPlan.projectMode,
        removeTaskState: true,
        taskId: request.taskId,
        worktreePath: request.cleanupPlan.worktreePath,
      }));
  const quarantineWorktree = dependencies.quarantineWorktree ?? quarantineManagedTaskWorktree;
  const releaseBranch = dependencies.releaseBranch ?? releaseQuarantinedTaskBranch;

  async function cleanupTaskRuntimeStep(
    request: TaskRemovalCleanupStepRequest,
  ): Promise<
    | { evidence: JsonObject; kind: 'step-complete'; step: TaskRemovalCleanupStepRequest['step'] }
    | { kind: 'retry-required'; reason?: string }
  > {
    const participantRequest: TaskRemovalParticipantRequest = {
      cleanupPlan: request.cleanupPlan,
      deletionOperationId: request.deletionOperationId,
      taskId: request.taskId,
    };
    switch (request.step) {
      case 'runners':
        await cleanupRunners(participantRequest);
        return { evidence: { state: 'complete' }, kind: 'step-complete', step: request.step };
      case 'containers':
        await cleanupContainers(participantRequest);
        return { evidence: { state: 'complete' }, kind: 'step-complete', step: request.step };
      case 'runtime-state': {
        const result = await cleanupRuntimeState(participantRequest);
        if (result.releasedTaskCommandController) {
          dependencies.onReleasedTaskCommandController?.(result.releasedTaskCommandController);
        }
        return { evidence: { state: 'complete' }, kind: 'step-complete', step: request.step };
      }
      case 'coordinator': {
        const warnings = await dependencies.cleanupCoordinatorTaskState(request.taskId);
        return warnings.length === 0
          ? { evidence: { state: 'complete' }, kind: 'step-complete', step: request.step }
          : { kind: 'retry-required', reason: summarizeWarnings(warnings) };
      }
      case 'worktree-quarantine':
        return {
          evidence: await quarantineWorktree({
            cleanupPlan: request.cleanupPlan,
            deletionOperationId: request.deletionOperationId,
          }),
          kind: 'step-complete',
          step: request.step,
        };
      case 'branch-release':
        return {
          evidence: await releaseBranch(
            {
              cleanupPlan: request.cleanupPlan,
              deletionOperationId: request.deletionOperationId,
            },
            request.evidence['worktree-quarantine'],
          ),
          kind: 'step-complete',
          step: request.step,
        };
      case 'shell-prepare': {
        const launchOperationId = request.cleanupPlan.launchOperationId;
        if (launchOperationId === null) {
          return {
            evidence: { state: 'not-required' },
            kind: 'step-complete',
            step: request.step,
          };
        }
        if (!dependencies.prepareTaskShellRemoval) {
          throw new Error('Managed terminal removal has no shell preparation owner');
        }
        return {
          evidence: await dependencies.prepareTaskShellRemoval({
            deletionOperationId: request.deletionOperationId,
            launchOperationId,
            preparedWorkspaceRevision: request.cleanupPlan.preparedWorkspaceRevision,
            taskId: request.taskId,
            taskIdentityWitness: request.cleanupPlan.taskIdentityWitness,
          }),
          kind: 'step-complete',
          step: request.step,
        };
      }
    }
  }

  return {
    activateLegacyEffectCutover: (cutoverEpoch) =>
      dependencies.legacyWriterGate.disableLegacyRemovalWriters(cutoverEpoch),
    cleanupTaskRuntimeStep,
    async drainTaskForRemoval() {
      return {
        kind: 'retry-required',
        reason: 'Task runtime cleanup requires the durable cleanup-step owner',
      };
    },
    async finalizeRemovedTaskState(request) {
      const launchOperationId = request.cleanupPlan.launchOperationId;
      if (launchOperationId !== null) {
        if (!dependencies.finalizeTaskShellRemoval) {
          throw new Error('Managed terminal removal has no shell finalization owner');
        }
        await dependencies.finalizeTaskShellRemoval({
          deletionOperationId: request.deletionOperationId,
          launchOperationId,
          removedWorkspaceRevision: request.removedWorkspaceRevision,
          taskId: request.taskId,
        });
      }
      await dependencies.finalizeRemovedTaskState(request);
      return { kind: 'complete' };
    },
    hookSetVersion: TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
    id: 'task-runtime',
    probe: async () => ({
      hookSetVersion: TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
      kind: 'ready',
    }),
    verifyLegacyEffectCutover: (cutoverEpoch) =>
      dependencies.legacyWriterGate.verifyLegacyRemovalWritersDisabled(cutoverEpoch),
  };
}
