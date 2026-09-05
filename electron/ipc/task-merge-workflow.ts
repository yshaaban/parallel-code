import {
  isTerminalTaskMergePhase,
  type IssuedTaskMergeOperation,
  type TaskMergeOperationAccess,
  type TaskMergeResultEnvelope,
  type TaskMergeSemanticRequest,
} from '../../src/domain/task-merge.js';
import { COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION } from './merge-progress.js';
import {
  createTaskMergeSemanticFingerprint,
  TaskMergeOperationConflictError,
  TaskMergeOperationIssuer,
  type CanonicalTaskMergeTarget,
  type TaskMergeLegacyWriterCutover,
  type TaskMergeOperationRecord,
  type TaskMergeOperationIssuerOptions,
  type TaskMergeOwnerCapability,
} from './task-merge-operation-issuer.js';
import type { TaskRemovalMutationResult } from '../../src/domain/task-removal-owner.js';
import type { TaskMergeRemovalAuthority } from './task-removal-owner.js';
import type { TaskStructureMutationService } from './task-structure-mutations.js';
import type { WorkspaceMutationService } from './workspace-state-mutations.js';

export interface TaskMergeGitRequest {
  baseBranch?: string;
  branchName: string;
  /** The generic removal owner is the only cleanup sequencer. */
  cleanup: false;
  message?: string;
  projectRoot: string;
  squash: boolean;
  taskId: string;
  worktreePath: string;
}

export interface TaskMergeGitResult {
  linesAdded: unknown;
  linesRemoved: unknown;
}

export type TaskMergeWorkflowFaultPoint =
  | 'after-git-before-result-record'
  | 'after-removal-before-terminal-record';

export interface TaskMergeWorkflowAuthorizationRequest {
  action: 'issue' | 'start' | 'status';
  principalId: string;
  taskId: string;
}

export interface TaskMergeWorkflowDependencies {
  authorize(request: TaskMergeWorkflowAuthorizationRequest): Promise<boolean> | boolean;
  executeGit(request: TaskMergeGitRequest): Promise<TaskMergeGitResult>;
  faultInjector?: (point: TaskMergeWorkflowFaultPoint) => Promise<void> | void;
  issuer: TaskMergeOperationIssuer;
  now?: () => number;
  removal: TaskMergeRemovalAuthority;
}

export interface StartTaskMergeRequest {
  access: TaskMergeOperationAccess;
  principalId: string;
  semanticRequest: TaskMergeSemanticRequest;
}

export interface TaskMergeBackendActivationDependencies {
  authorize: TaskMergeWorkflowDependencies['authorize'];
  executeGit: TaskMergeWorkflowDependencies['executeGit'];
  faultInjector?: TaskMergeWorkflowDependencies['faultInjector'];
  issuerOptions?: TaskMergeOperationIssuerOptions;
  legacyWriterCutover: TaskMergeLegacyWriterCutover;
  now?: () => number;
  structure: TaskStructureMutationService;
  workspace: WorkspaceMutationService;
}

export interface ActiveTaskMergeBackend {
  capability: TaskMergeOwnerCapability;
  issuer: TaskMergeOperationIssuer;
  workflow: TaskMergeWorkflow;
}

export class TaskMergeWorkflowAuthorizationError extends Error {
  readonly code = 'task-merge-authorization-required';
}

function isRemovalCommitState(state: TaskRemovalMutationResult['removalState']): boolean {
  return state === 'complete' || state === 'finalizer-repair-pending';
}

/**
 * Backend operation owner for the D09 cutover. It persists intent before Git, never passes cleanup
 * to the low-level Git function, and resumes the same generic removal ID after a lost response.
 */
export class TaskMergeWorkflow {
  private readonly now: () => number;
  private readonly singleFlights = new Map<
    string,
    {
      fingerprint: string;
      promise: Promise<TaskMergeResultEnvelope<TaskRemovalMutationResult>>;
    }
  >();

  constructor(private readonly dependencies: TaskMergeWorkflowDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async issue(request: { principalId: string; taskId: string }): Promise<IssuedTaskMergeOperation> {
    await this.requireAuthorization({ ...request, action: 'issue' });
    return this.dependencies.issuer.issue(request);
  }

  async start(
    request: StartTaskMergeRequest,
  ): Promise<TaskMergeResultEnvelope<TaskRemovalMutationResult>> {
    const initialRecord = await this.dependencies.issuer.getAuthorizedRecord(
      request.principalId,
      request.access,
    );
    await this.requireAuthorization({
      action: 'start',
      principalId: request.principalId,
      taskId: initialRecord.taskId,
    });
    if (
      initialRecord.phase !== 'issued' &&
      initialRecord.phase !== 'expired-unused' &&
      initialRecord.phase !== 'superseded-unused'
    ) {
      this.dependencies.issuer.assertSemanticRequest(initialRecord, request.semanticRequest);
    }
    const fingerprint = createTaskMergeSemanticFingerprint(request.semanticRequest);
    const existing = this.singleFlights.get(request.access.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new TaskMergeOperationConflictError('Merge request changed across retry');
      }
      return existing.promise.then((result) => ({ ...result, replayed: true }));
    }
    const operation = this.runStart(request, initialRecord);
    this.singleFlights.set(request.access.operationId, { fingerprint, promise: operation });
    const clearSingleFlight = (): void => {
      if (this.singleFlights.get(request.access.operationId)?.promise === operation) {
        this.singleFlights.delete(request.access.operationId);
      }
    };
    void operation.then(clearSingleFlight, clearSingleFlight);
    return operation;
  }

  async status(request: {
    access: TaskMergeOperationAccess;
    principalId: string;
  }): Promise<TaskMergeResultEnvelope<TaskRemovalMutationResult>> {
    let record = await this.dependencies.issuer.getAuthorizedRecord(
      request.principalId,
      request.access,
    );
    await this.requireAuthorization({
      action: 'status',
      principalId: request.principalId,
      taskId: record.taskId,
    });
    // A response can be lost after the atomic removal/progress commit but before the merge journal
    // records its terminal receipt. Status is the lease-independent recovery join: it may
    // terminalize only from the generic removal owner's durable commit evidence and never reruns
    // Git or cleanup.
    if (record.phase === 'merged-awaiting-removal') {
      const commitEvidence = await this.dependencies.removal.getCommittedMergeEvidence({
        deletionOperationId: record.operationId,
        taskId: record.taskId,
      });
      if (commitEvidence) {
        record = await this.dependencies.issuer.recordRemovalCommitted(
          request.principalId,
          request.access,
          { progressVersionAtOutcome: commitEvidence.progressVersionAtCommit },
        );
      }
    }
    return this.envelope(record, true);
  }

  private async runStart(
    request: StartTaskMergeRequest,
    initialRecord: TaskMergeOperationRecord,
  ): Promise<TaskMergeResultEnvelope<TaskRemovalMutationResult>> {
    let record = initialRecord;
    const replayed = initialRecord.phase !== 'issued';
    if (record.phase === 'expired-unused' || record.phase === 'superseded-unused') {
      return this.envelope(record, true);
    }
    if (record.phase !== 'issued') {
      this.dependencies.issuer.assertSemanticRequest(record, request.semanticRequest);
    }
    if (
      isTerminalTaskMergePhase(record.phase) ||
      record.phase === 'manual-reconciliation-required'
    ) {
      return this.envelope(record, true);
    }
    if (record.phase === 'merging') {
      record = await this.dependencies.issuer.recordGitOutcomeAmbiguous(
        request.principalId,
        request.access,
      );
      return this.envelope(record, true);
    }

    if (record.phase === 'issued' || record.phase === 'admitted') {
      const target = await this.dependencies.issuer.resolveCanonicalTarget(record.taskId);
      if (record.phase === 'issued') {
        const admission = await this.dependencies.issuer.admit(
          request.principalId,
          request.access,
          request.semanticRequest,
          target.targetFingerprint,
        );
        record = admission.record;
        if (admission.kind === 'expired') return this.envelope(record, replayed);
      } else if (record.targetFingerprint !== target.targetFingerprint) {
        throw new TaskMergeOperationConflictError('Canonical merge target changed');
      }

      if (record.cleanupRequested && !target.cleanupAllowed) {
        record = await this.dependencies.issuer.recordFailure(request.principalId, request.access, {
          code: 'validation',
          recovery: { kind: 'new-operation-after-correction' },
        });
        return this.envelope(record, replayed);
      }

      if (record.cleanupRequested) {
        const reservation = await this.dependencies.removal.reserve({
          activation: 'after-linked-merge-proof',
          commitExtensionKind: COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION,
          deletionOperationId: record.operationId,
          taskId: record.taskId,
        });
        if (reservation.kind === 'operation-conflict' || reservation.kind === 'task-not-current') {
          record = await this.dependencies.issuer.recordFailure(
            request.principalId,
            request.access,
            {
              code:
                reservation.kind === 'operation-conflict'
                  ? 'removal-operation-conflict'
                  : 'task-not-current',
              recovery: { kind: 'new-operation-after-correction' },
            },
          );
          return this.envelope(record, replayed);
        }
      }

      if (
        !(await this.dependencies.authorize({
          action: 'start',
          principalId: request.principalId,
          taskId: record.taskId,
        }))
      ) {
        if (record.cleanupRequested) {
          await this.dependencies.removal.abortBeforeLinkedProof({
            deletionOperationId: record.operationId,
            taskId: record.taskId,
          });
        }
        record = await this.dependencies.issuer.recordFailure(request.principalId, request.access, {
          code: 'lease-lost-before-git',
          recovery: { kind: 'new-operation-after-correction' },
        });
        return this.envelope(record, replayed);
      }

      record = await this.dependencies.issuer.markMerging(request.principalId, request.access);
      let gitResult: TaskMergeGitResult;
      try {
        gitResult = await this.dependencies.executeGit(
          this.toGitRequest(target, request.semanticRequest),
        );
      } catch {
        if (record.cleanupRequested) {
          await this.dependencies.removal.abortBeforeLinkedProof({
            deletionOperationId: record.operationId,
            taskId: record.taskId,
          });
        }
        record = await this.dependencies.issuer.recordFailure(request.principalId, request.access, {
          code: 'git-failed',
          recovery: { kind: 'new-operation-after-correction' },
        });
        return this.envelope(record, replayed);
      }
      await this.dependencies.faultInjector?.('after-git-before-result-record');
      const committedAt = new Date(this.now());
      if (!Number.isFinite(committedAt.getTime())) {
        throw new Error('Task merge completion clock is invalid');
      }
      record = await this.dependencies.issuer.recordGitSuccess(
        request.principalId,
        request.access,
        {
          committedAt,
          linesAdded: gitResult.linesAdded,
          linesRemoved: gitResult.linesRemoved,
        },
      );
      if (!record.cleanupRequested) return this.envelope(record, replayed);
    }

    if (record.phase !== 'merged-awaiting-removal') {
      return this.envelope(record, true);
    }
    if (
      record.committedAt === undefined ||
      record.linesAdded === undefined ||
      record.linesRemoved === undefined
    ) {
      throw new Error('Persisted linked merge proof is incomplete');
    }
    const removal = await this.dependencies.removal.continueAfterLinkedProof(
      { operation: `complete-task-merge-removal:${record.operationId}` },
      {
        committedAt: new Date(record.committedAt),
        deletionOperationId: record.operationId,
        linesAdded: record.linesAdded,
        linesRemoved: record.linesRemoved,
        taskId: record.taskId,
      },
    );
    if (!isRemovalCommitState(removal.result.removalState)) {
      return this.envelope(record, replayed, removal.result);
    }
    await this.dependencies.faultInjector?.('after-removal-before-terminal-record');
    const commitEvidence = await this.dependencies.removal.getCommittedMergeEvidence({
      deletionOperationId: record.operationId,
      taskId: record.taskId,
    });
    if (!commitEvidence) {
      throw new Error('Committed task merge removal evidence is unavailable');
    }
    record = await this.dependencies.issuer.recordRemovalCommitted(
      request.principalId,
      request.access,
      { progressVersionAtOutcome: commitEvidence.progressVersionAtCommit },
    );
    return this.envelope(record, replayed, removal.result);
  }

  private async envelope(
    record: TaskMergeOperationRecord,
    replayed: boolean,
    knownRemoval?: TaskRemovalMutationResult,
  ): Promise<TaskMergeResultEnvelope<TaskRemovalMutationResult>> {
    const [currentProgress, currentRemoval] = await Promise.all([
      this.dependencies.issuer.readCurrentProgress(),
      record.cleanupRequested
        ? knownRemoval
          ? Promise.resolve(knownRemoval)
          : this.dependencies.removal.getStatus({
              deletionOperationId: record.operationId,
              taskId: record.taskId,
            })
        : Promise.resolve(null),
    ]);
    return {
      currentProgress,
      currentRemoval,
      originalOutcome: this.dependencies.issuer.snapshot(record),
      replayed,
    };
  }

  private async requireAuthorization(
    request: TaskMergeWorkflowAuthorizationRequest,
  ): Promise<void> {
    if (!(await this.dependencies.authorize(request))) {
      throw new TaskMergeWorkflowAuthorizationError('Task merge authorization is unavailable');
    }
  }

  private toGitRequest(
    target: CanonicalTaskMergeTarget,
    request: TaskMergeSemanticRequest,
  ): TaskMergeGitRequest {
    return {
      ...(target.baseBranch !== undefined ? { baseBranch: target.baseBranch } : {}),
      branchName: target.branchName,
      cleanup: false,
      ...(request.message !== undefined ? { message: request.message } : {}),
      projectRoot: target.projectRoot,
      squash: request.squash,
      taskId: request.taskId,
      worktreePath: target.worktreePath,
    };
  }
}

/**
 * Sole production activation for D09. The generic owner and managed creation writer must already
 * be live, and a mandatory real legacy-writer cutover is verified before capability publication.
 */
export async function activateTaskMergeBackend(
  dependencies: TaskMergeBackendActivationDependencies,
): Promise<ActiveTaskMergeBackend> {
  const removalCapability = dependencies.structure.getTaskRemovalOwnerCapability();
  if (!removalCapability) {
    throw new Error('Task merge backend requires the active generic removal owner');
  }
  const creationCapability = dependencies.structure.getManagedTaskCreationWriterCapability();
  if (!creationCapability || creationCapability.cutoverEpoch !== removalCapability.cutoverEpoch) {
    throw new Error('Task merge backend requires the active managed task creation writer');
  }
  const removal = dependencies.structure.getTaskMergeRemovalAuthority();
  const issuer = new TaskMergeOperationIssuer(
    dependencies.workspace.createPrivateMutationAuthority(),
    dependencies.issuerOptions,
  );
  const capability = await issuer.activate(dependencies.legacyWriterCutover);
  const workflow = new TaskMergeWorkflow({
    authorize: dependencies.authorize,
    executeGit: dependencies.executeGit,
    issuer,
    removal,
    ...(dependencies.faultInjector ? { faultInjector: dependencies.faultInjector } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  return { capability, issuer, workflow };
}
