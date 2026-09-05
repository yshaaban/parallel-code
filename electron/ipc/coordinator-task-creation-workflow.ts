import { createHash } from 'node:crypto';

import type {
  CreateTaskCreationOperationResult,
  TaskCreationIntent,
} from '../../src/domain/task-creation.js';
import type {
  TaskCreationOperationId,
  TaskCreationTicketAuthenticationContext,
} from '../../src/domain/task-creation-ticket.js';
import {
  cleanupCoordinatorStateForTaskDurably,
  createCoordinatorRunForTaskDurably,
  getCoordinatorTaskLaunchMetadata,
  type CoordinatorTaskLaunchMetadata,
} from '../coordinator/service.js';
import type { StorageEnv } from './storage.js';
import {
  deriveTaskCreationConflictKey,
  type NormalizedTaskCreationSemanticRequestV1,
} from './task-creation-journal.js';
import {
  TaskCreationPreparationManualReconciliationError,
  type TaskCreationAllocatedIdentities,
  type TaskCreationCommitFailureReconciliation,
  type TaskCreationIntentResolution,
  type TaskCreationPreparationOwner,
  type TaskCreationPreparedTask,
  type TaskCreationResolvedIntent,
  type TaskCreationWorkflow,
} from './task-creation-workflow.js';

export interface TrustedCoordinatorTaskCreationWorkflow {
  bindCreationWorkflow(workflow: TaskCreationWorkflow): void;
  create(
    authentication: TaskCreationTicketAuthenticationContext,
    intent: TaskCreationIntent,
  ): Promise<CreateTaskCreationOperationResult>;
  readonly preparation: TaskCreationPreparationOwner;
}

export interface CoordinatorTaskCreationRuntimeAdapters {
  cleanup(taskId: string): Promise<void>;
  create(request: {
    agentId: string;
    projectId: string;
    projectMode: 'git' | 'non-git';
    projectRoot: string;
    taskId: string;
  }): Promise<CoordinatorTaskLaunchMetadata>;
  get(taskId: string, agentId: string): CoordinatorTaskLaunchMetadata | null;
}

export interface CreateTrustedCoordinatorTaskCreationWorkflowDependencies {
  adapters?: Partial<CoordinatorTaskCreationRuntimeAdapters>;
  basePreparation: TaskCreationPreparationOwner;
  env: StorageEnv;
}

function resourceId(operationId: string, taskId: string): string {
  return `coordinator-task:${createHash('sha256')
    .update(`${operationId}\u0000${taskId}`, 'utf8')
    .digest('base64url')}`;
}

function coordinatorCleanupAmbiguity(
  operationId: string,
  taskId: string,
): TaskCreationCommitFailureReconciliation {
  return {
    kind: 'manual-reconciliation-required',
    reconciliation: {
      kind: 'artifact-ambiguous',
      resources: [
        {
          conflictKey: deriveTaskCreationConflictKey('task', taskId),
          resourceId: resourceId(operationId, taskId),
        },
      ],
    },
  };
}

class CoordinatorTaskCreationOwner implements TrustedCoordinatorTaskCreationWorkflow {
  private readonly adapters: CoordinatorTaskCreationRuntimeAdapters;
  private creationWorkflow: TaskCreationWorkflow | null = null;
  private readonly trustedOperationDepth = new Map<string, number>();

  readonly preparation: TaskCreationPreparationOwner;

  constructor(
    private readonly dependencies: CreateTrustedCoordinatorTaskCreationWorkflowDependencies,
  ) {
    this.adapters = {
      cleanup: (taskId) => cleanupCoordinatorStateForTaskDurably(dependencies.env, taskId),
      create: async (request) => {
        const result = await createCoordinatorRunForTaskDurably(dependencies.env, {
          coordinatorAgentId: request.agentId,
          coordinatorTaskId: request.taskId,
          projectId: request.projectId,
          projectMode: request.projectMode,
          projectRoot: request.projectRoot,
        });
        return {
          credentialPath: result.credentialPath,
          runId: result.run.id,
          ...(result.toolCommand !== undefined ? { toolCommand: result.toolCommand } : {}),
        };
      },
      get: (taskId, agentId) => getCoordinatorTaskLaunchMetadata(dependencies.env, taskId, agentId),
      ...dependencies.adapters,
    };
    this.preparation = {
      getCapabilities: () => dependencies.basePreparation.getCapabilities(),
      getPickerPage: (request) => dependencies.basePreparation.getPickerPage(request),
      getWorktreeLinkCandidates: (request) =>
        dependencies.basePreparation.getWorktreeLinkCandidates(request),
      normalizeIntent: (intent) => dependencies.basePreparation.normalizeIntent(intent),
      prepare: (request) => this.prepare(request),
      reconcileFailedCommit: (request) => this.reconcileFailedCommit(request),
      resolveIntent: (intent, authentication, semanticRequest) =>
        this.resolveIntent(intent, authentication, semanticRequest),
    };
  }

  bindCreationWorkflow(workflow: TaskCreationWorkflow): void {
    if (this.creationWorkflow && this.creationWorkflow !== workflow) {
      throw new Error('Coordinator task-creation workflow is already bound');
    }
    this.creationWorkflow = workflow;
  }

  async create(
    authentication: TaskCreationTicketAuthenticationContext,
    intent: TaskCreationIntent,
  ): Promise<CreateTaskCreationOperationResult> {
    if (intent.launch.kind !== 'agent') {
      throw new TypeError('Coordinator creation requires an agent launch');
    }
    if (!this.creationWorkflow) {
      throw new Error('Coordinator task-creation workflow is not active');
    }
    this.enterTrustedOperation(intent.operationId);
    try {
      return await this.creationWorkflow.create(authentication, intent);
    } finally {
      this.leaveTrustedOperation(intent.operationId);
    }
  }

  private isTrustedOperation(operationId: string): boolean {
    return (this.trustedOperationDepth.get(operationId) ?? 0) > 0;
  }

  private enterTrustedOperation(operationId: string): void {
    this.trustedOperationDepth.set(
      operationId,
      (this.trustedOperationDepth.get(operationId) ?? 0) + 1,
    );
  }

  private leaveTrustedOperation(operationId: string): void {
    const next = (this.trustedOperationDepth.get(operationId) ?? 1) - 1;
    if (next === 0) this.trustedOperationDepth.delete(operationId);
    else this.trustedOperationDepth.set(operationId, next);
  }

  private async resolveIntent(
    intent: Readonly<TaskCreationIntent>,
    authentication: Readonly<TaskCreationTicketAuthenticationContext>,
    semanticRequest?: NormalizedTaskCreationSemanticRequestV1,
  ): Promise<TaskCreationIntentResolution> {
    const resolved = await this.dependencies.basePreparation.resolveIntent(
      intent,
      authentication,
      semanticRequest,
    );
    if (
      this.isTrustedOperation(intent.operationId) &&
      resolved.kind === 'resolved' &&
      (resolved.value.semanticRequest.launch.kind !== 'agent' || !resolved.value.agent)
    ) {
      return { code: 'invalid-request', kind: 'rejected' };
    }
    return resolved;
  }

  private async prepare(request: {
    identities: Readonly<TaskCreationAllocatedIdentities>;
    operationId: TaskCreationOperationId;
    resolved: Readonly<TaskCreationResolvedIntent>;
  }): Promise<TaskCreationPreparedTask> {
    const prepared = await this.dependencies.basePreparation.prepare(request);
    if (!this.isTrustedOperation(request.operationId)) return prepared;
    if (request.resolved.semanticRequest.launch.kind !== 'agent' || !request.resolved.agent) {
      throw new TypeError('Coordinator creation requires a resolved agent');
    }
    if (prepared.coordinator) {
      throw new Error('Base preparation cannot supply coordinator launch authority');
    }
    try {
      const existing = this.adapters.get(request.identities.taskId, request.identities.sessionId);
      const coordinator =
        existing ??
        (await this.adapters.create({
          agentId: request.identities.sessionId,
          projectId: request.resolved.semanticRequest.projectId,
          projectMode: prepared.task.projectMode,
          projectRoot: prepared.task.projectRoot,
          taskId: request.identities.taskId,
        }));
      return { ...prepared, coordinator };
    } catch (error) {
      const reconciled = await this.dependencies.basePreparation.reconcileFailedCommit({
        cause: error,
        identities: request.identities,
        operationId: request.operationId,
        prepared,
        resolved: request.resolved,
      });
      if (reconciled.kind === 'manual-reconciliation-required') {
        throw new TaskCreationPreparationManualReconciliationError(
          'Coordinator preparation failed after task resources were prepared',
          reconciled.reconciliation,
        );
      }
      throw error;
    }
  }

  private async reconcileFailedCommit(request: {
    cause: unknown;
    identities: Readonly<TaskCreationAllocatedIdentities>;
    operationId: TaskCreationOperationId;
    prepared: Readonly<TaskCreationPreparedTask>;
    resolved: Readonly<TaskCreationResolvedIntent>;
  }): Promise<TaskCreationCommitFailureReconciliation> {
    const reconciled = await this.dependencies.basePreparation.reconcileFailedCommit(request);
    if (!this.isTrustedOperation(request.operationId) || !request.prepared.coordinator) {
      return reconciled;
    }
    if (
      reconciled.kind === 'manual-reconciliation-required' &&
      reconciled.reconciliation.kind === 'mapping-ambiguous'
    ) {
      return reconciled;
    }
    try {
      await this.adapters.cleanup(request.identities.taskId);
      return reconciled;
    } catch {
      return coordinatorCleanupAmbiguity(request.operationId, request.identities.taskId);
    }
  }
}

export function createTrustedCoordinatorTaskCreationWorkflow(
  dependencies: CreateTrustedCoordinatorTaskCreationWorkflowDependencies,
): TrustedCoordinatorTaskCreationWorkflow {
  return new CoordinatorTaskCreationOwner(dependencies);
}
