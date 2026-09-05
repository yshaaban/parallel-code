import type { TaskCreationOperationSnapshot } from '../../src/domain/task-creation.js';
import {
  isTaskCreationOperationId,
  type TaskCreationOperationId,
} from '../../src/domain/task-creation-ticket.js';
import { isRecord } from '../../src/lib/type-guards.js';
import {
  TASK_CREATION_JOURNAL_TOMBSTONE_RETENTION_MS,
  taskCreationConflictKeyId,
  type TaskCreationBranchDeleteState,
  type TaskCreationJournal,
  type TaskCreationJournalRecord,
  type TaskCreationJournalReconciliationState,
  type TaskCreationReconciliationResource,
} from './task-creation-journal.js';

const SAFE_ID = /^[A-Za-z0-9._:@/-]+$/u;
const OPAQUE_ID = /^[A-Za-z0-9._:@-]+$/u;
const SAFE_DESTINATION_REFERENCE = /^[A-Za-z0-9._:@~-]+$/u;
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/u;

export type TaskCreationReconciliationAction =
  | { kind: 'inspect'; operationId: TaskCreationOperationId }
  | ({ expectedRecordVersion: number; operationId: TaskCreationOperationId } & (
      | { expectedTaskId: string; kind: 'adopt-committed-mapping' }
      | { kind: 'confirm-owned-artifact-absent'; resourceId: string }
      | { kind: 'abandon-without-delete' }
      | { kind: 'reveal-recovery-quarantine'; recoveryId: string }
      | {
          destinationRef: string;
          kind: 'restore-recovery-quarantine';
          recoveryId: string;
        }
      | {
          destinationRef: string;
          kind: 'retarget-recovery-quarantine-restore';
          recoveryId: string;
        }
      | { kind: 'finalize-restored-worktree-unlock'; recoveryId: string }
      | { kind: 'confirm-recovery-quarantine-absent'; recoveryId: string }
      | {
          challengeId: string;
          confirmationVersion: number;
          kind: 'confirm-retry-owned-branch-delete';
          recoveryId: string;
        }
      | {
          challengeId: string;
          confirmationVersion: number;
          kind: 'keep-current-branch-and-abandon-owned-delete';
          recoveryId: string;
        }
    ));

export type TaskCreationReconciliationActionResult =
  | {
      kind:
        | 'inspected'
        | 'resolved'
        | 'revealed'
        | 'restore-started'
        | 'unlock-finalized'
        | 'branch-delete-retry-started'
        | 'branch-delete-abandoned-preserved'
        | 'branch-delete-already-absent';
      snapshot: TaskCreationOperationSnapshot;
    }
  | {
      kind: 'stale-version-or-issue' | 'proof-insufficient';
      snapshot: TaskCreationOperationSnapshot;
    }
  | { kind: 'absent-or-superseded' };

export type TaskCreationLocalAdminActor = 'electron-main' | 'owning-user-cli' | 'untrusted';

export interface TaskCreationReconciliationAuditEvent {
  action: TaskCreationReconciliationAction['kind'];
  actor: TaskCreationLocalAdminActor;
  occurredAtMs: number;
  outcome: TaskCreationReconciliationActionResult['kind'] | 'authorization-denied';
}

export class TaskCreationLocalAdminRequiredError extends Error {
  constructor() {
    super('Task-creation reconciliation requires trusted local-admin authority');
    this.name = 'TaskCreationLocalAdminRequiredError';
  }
}

export type TaskCreationReconciliationCommittedMappingProbe =
  | { kind: 'proof-insufficient' }
  | { kind: 'exact'; taskId: string; workspaceRevision: number };

export type TaskCreationReconciliationAbsenceProbe =
  | { kind: 'proof-insufficient' | 'present' }
  | { kind: 'exact-absent' };

export interface TaskCreationRestorePlan {
  destinationFilesystemWitness: string;
  destinationLocator: string;
  destinationParentWitness: string;
}

export type TaskCreationRestoreMoveResult =
  | { kind: 'proof-insufficient' }
  | { kind: 'moved-or-already-moved'; restoredResourceWitness: string };

export type TaskCreationBranchDeleteResult =
  | { kind: 'complete' | 'already-absent' }
  | {
      challengeId: string;
      confirmationVersion: number;
      kind: 'outcome-ambiguous';
      observedRefFrontierWitness: string;
    }
  | { kind: 'proof-insufficient' };

export type TaskCreationKeepBranchResult =
  | { kind: 'already-absent' | 'unchanged-present' }
  | {
      challengeId: string;
      confirmationVersion: number;
      kind: 'changed-or-unavailable';
      observedRefFrontierWitness: string;
    }
  | { kind: 'proof-insufficient' };

export interface TaskCreationReconciliationDependencies {
  audit(event: Readonly<TaskCreationReconciliationAuditEvent>): Promise<void> | void;
  authorizeLocalAdmin(
    authority: unknown,
  ): Promise<TaskCreationLocalAdminActor | null> | TaskCreationLocalAdminActor | null;
  buildSnapshot(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<TaskCreationOperationSnapshot> | TaskCreationOperationSnapshot;
  finalizeRestoredWorktreeUnlock(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<TaskCreationReconciliationAbsenceProbe> | TaskCreationReconciliationAbsenceProbe;
  inspect(record: Readonly<TaskCreationJournalRecord>): Promise<void> | void;
  journal: Pick<TaskCreationJournal, 'getByOperationId' | 'save'>;
  keepCurrentBranch(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<TaskCreationKeepBranchResult> | TaskCreationKeepBranchResult;
  moveRecoveryQuarantine(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<TaskCreationRestoreMoveResult> | TaskCreationRestoreMoveResult;
  now?: () => number;
  planRecoveryRestore(
    record: Readonly<TaskCreationJournalRecord>,
    destinationRef: string,
    kind: 'restore' | 'retarget',
  ): Promise<TaskCreationRestorePlan | null> | TaskCreationRestorePlan | null;
  probeCommittedMapping(
    record: Readonly<TaskCreationJournalRecord>,
    expectedTaskId: string,
  ):
    | Promise<TaskCreationReconciliationCommittedMappingProbe>
    | TaskCreationReconciliationCommittedMappingProbe;
  probeOwnedArtifactAbsence(
    record: Readonly<TaskCreationJournalRecord>,
    resource: Readonly<TaskCreationReconciliationResource>,
  ): Promise<TaskCreationReconciliationAbsenceProbe> | TaskCreationReconciliationAbsenceProbe;
  probeRecoveryQuarantineAbsence(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<TaskCreationReconciliationAbsenceProbe> | TaskCreationReconciliationAbsenceProbe;
  retryOwnedBranchDelete(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<TaskCreationBranchDeleteResult> | TaskCreationBranchDeleteResult;
  revealRecoveryQuarantine(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<'revealed' | 'proof-insufficient'> | 'revealed' | 'proof-insufficient';
}

export interface TaskCreationReconciliationService {
  execute(
    authority: unknown,
    action: TaskCreationReconciliationAction,
  ): Promise<TaskCreationReconciliationActionResult>;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 64 &&
    SAFE_ID.test(value)
  );
}

function isDestinationReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 128 &&
    SAFE_DESTINATION_REFERENCE.test(value)
  );
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 64 &&
    OPAQUE_ID.test(value)
  );
}

function isChallengeAction(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      'challengeId',
      'confirmationVersion',
      'expectedRecordVersion',
      'kind',
      'operationId',
      'recoveryId',
    ]) &&
    isOpaqueId(value.challengeId) &&
    isPositiveSafeInteger(value.confirmationVersion) &&
    isOpaqueId(value.recoveryId)
  );
}

export function isTaskCreationReconciliationAction(
  value: unknown,
): value is TaskCreationReconciliationAction {
  if (!isRecord(value) || !isTaskCreationOperationId(value.operationId)) return false;
  if (value.kind === 'inspect') return hasOnlyKeys(value, ['kind', 'operationId']);
  if (!isPositiveSafeInteger(value.expectedRecordVersion)) return false;
  switch (value.kind) {
    case 'adopt-committed-mapping':
      return (
        hasOnlyKeys(value, ['expectedRecordVersion', 'expectedTaskId', 'kind', 'operationId']) &&
        isSafeId(value.expectedTaskId)
      );
    case 'confirm-owned-artifact-absent':
      return (
        hasOnlyKeys(value, ['expectedRecordVersion', 'kind', 'operationId', 'resourceId']) &&
        isOpaqueId(value.resourceId)
      );
    case 'abandon-without-delete':
      return hasOnlyKeys(value, ['expectedRecordVersion', 'kind', 'operationId']);
    case 'reveal-recovery-quarantine':
    case 'finalize-restored-worktree-unlock':
    case 'confirm-recovery-quarantine-absent':
      return (
        hasOnlyKeys(value, ['expectedRecordVersion', 'kind', 'operationId', 'recoveryId']) &&
        isOpaqueId(value.recoveryId)
      );
    case 'restore-recovery-quarantine':
    case 'retarget-recovery-quarantine-restore':
      return (
        hasOnlyKeys(value, [
          'destinationRef',
          'expectedRecordVersion',
          'kind',
          'operationId',
          'recoveryId',
        ]) &&
        isOpaqueId(value.recoveryId) &&
        isDestinationReference(value.destinationRef)
      );
    case 'confirm-retry-owned-branch-delete':
    case 'keep-current-branch-and-abandon-owned-delete':
      return isChallengeAction(value);
    default:
      return false;
  }
}

function isRecoveryRecord(
  record: TaskCreationJournalRecord,
): record is TaskCreationJournalRecord & {
  reconciliation: Extract<TaskCreationJournalReconciliationState, { kind: 'retained-quarantine' }>;
} {
  return (
    (record.phase === 'manual-reconciliation-required' ||
      record.phase === 'failed-before-commit') &&
    record.commit.kind === 'not-committed' &&
    record.retention.kind === 'retained-artifact' &&
    record.reconciliation.kind === 'retained-quarantine'
  );
}

function isTerminalBranchState(state: TaskCreationBranchDeleteState): boolean {
  return (
    state.state === 'not-applicable' ||
    state.state === 'complete' ||
    state.state === 'abandoned-preserved'
  );
}

function sortResources(
  resources: readonly TaskCreationReconciliationResource[],
): TaskCreationReconciliationResource[] {
  return [...resources].sort(
    (left, right) =>
      left.conflictKey.kind.localeCompare(right.conflictKey.kind) ||
      left.conflictKey.digest.localeCompare(right.conflictKey.digest) ||
      Buffer.compare(Buffer.from(left.resourceId, 'utf8'), Buffer.from(right.resourceId, 'utf8')),
  );
}

class TaskCreationReconciliationServiceImpl implements TaskCreationReconciliationService {
  private readonly queues = new Map<TaskCreationOperationId, Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly dependencies: TaskCreationReconciliationDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async execute(
    authority: unknown,
    action: TaskCreationReconciliationAction,
  ): Promise<TaskCreationReconciliationActionResult> {
    if (!isTaskCreationReconciliationAction(action)) {
      throw new Error('Invalid task-creation reconciliation action');
    }
    const actor = await this.dependencies.authorizeLocalAdmin(authority);
    if (actor !== 'electron-main' && actor !== 'owning-user-cli') {
      this.audit(action.kind, 'untrusted', 'authorization-denied');
      throw new TaskCreationLocalAdminRequiredError();
    }
    return this.enqueue(action.operationId, async () => {
      let result: TaskCreationReconciliationActionResult;
      try {
        result = await this.executeAuthorized(action);
      } catch (error) {
        this.audit(action.kind, actor, 'proof-insufficient');
        throw error;
      }
      this.audit(action.kind, actor, result.kind);
      return result;
    });
  }

  private async executeAuthorized(
    action: TaskCreationReconciliationAction,
  ): Promise<TaskCreationReconciliationActionResult> {
    const record = this.dependencies.journal.getByOperationId(action.operationId);
    if (!record) return { kind: 'absent-or-superseded' };
    if (action.kind === 'inspect') {
      await this.dependencies.inspect(record);
      return this.withSnapshot('inspected', record);
    }
    if (
      record.recordVersion !== action.expectedRecordVersion ||
      (record.phase !== 'manual-reconciliation-required' &&
        record.phase !== 'failed-before-commit') ||
      record.reconciliation.kind === 'none'
    ) {
      return this.withSnapshot('stale-version-or-issue', record);
    }

    switch (action.kind) {
      case 'adopt-committed-mapping':
        return this.adoptCommittedMapping(record, action.expectedTaskId);
      case 'confirm-owned-artifact-absent':
        return this.confirmOwnedArtifactAbsent(record, action.resourceId);
      case 'abandon-without-delete':
        return this.abandonWithoutDelete(record);
      case 'reveal-recovery-quarantine':
        return this.revealRecovery(record, action.recoveryId);
      case 'restore-recovery-quarantine':
        return this.restoreRecovery(record, action.recoveryId, action.destinationRef, 'restore');
      case 'retarget-recovery-quarantine-restore':
        return this.restoreRecovery(record, action.recoveryId, action.destinationRef, 'retarget');
      case 'finalize-restored-worktree-unlock':
        return this.finalizeUnlock(record, action.recoveryId);
      case 'confirm-recovery-quarantine-absent':
        return this.confirmRecoveryAbsent(record, action.recoveryId);
      case 'confirm-retry-owned-branch-delete':
        return this.retryBranchDelete(record, action);
      case 'keep-current-branch-and-abandon-owned-delete':
        return this.keepCurrentBranch(record, action);
    }
  }

  private async adoptCommittedMapping(
    record: TaskCreationJournalRecord,
    expectedTaskId: string,
  ): Promise<TaskCreationReconciliationActionResult> {
    if (
      record.reconciliation.kind !== 'mapping-ambiguous' ||
      record.reconciliation.expectedTaskId !== expectedTaskId ||
      record.identities.taskId !== expectedTaskId
    ) {
      return this.withSnapshot('stale-version-or-issue', record);
    }
    const proof = await this.dependencies.probeCommittedMapping(record, expectedTaskId);
    if (
      proof.kind !== 'exact' ||
      proof.taskId !== expectedTaskId ||
      !isPositiveSafeInteger(proof.workspaceRevision)
    ) {
      return this.withSnapshot('proof-insufficient', record);
    }
    const proposed = this.nextRecord(record, {
      activeConflictKeys: [],
      commit: {
        kind: 'committed',
        taskId: expectedTaskId,
        workspaceRevision: proof.workspaceRevision,
      },
      // The original launch outcome was never proven. Re-enter an honest,
      // actionable recovery phase instead of stranding an adopted commit in
      // `starting`, which the creation workflow intentionally does not replay.
      issueCode: record.taskMode === 'agent' ? 'launch-failed' : 'projection-repair-required',
      phase: 'created-needs-attention',
      reconciliation: { kind: 'none' },
      retention: { kind: 'live-task' },
    });
    return this.saveAndSnapshot(record, proposed, 'resolved');
  }

  private async confirmOwnedArtifactAbsent(
    record: TaskCreationJournalRecord,
    resourceId: string,
  ): Promise<TaskCreationReconciliationActionResult> {
    const reconciliation = record.reconciliation;
    if (
      reconciliation.kind !== 'artifact-ambiguous' &&
      reconciliation.kind !== 'abandoned-conflicts'
    ) {
      return this.withSnapshot('stale-version-or-issue', record);
    }
    const resource = reconciliation.resources.find((entry) => entry.resourceId === resourceId);
    if (!resource) return this.withSnapshot('stale-version-or-issue', record);
    const proof = await this.dependencies.probeOwnedArtifactAbsence(record, resource);
    if (proof.kind !== 'exact-absent') {
      return this.withSnapshot('proof-insufficient', record);
    }
    const releasedKey = taskCreationConflictKeyId(resource.conflictKey);
    const remainingKeys = record.activeConflictKeys.filter(
      (key) => taskCreationConflictKeyId(key) !== releasedKey,
    );
    const remainingResources = reconciliation.resources.filter(
      (entry) => entry.resourceId !== resourceId,
    );
    const proposed =
      remainingKeys.length === 0
        ? this.terminalizeFailed(record)
        : this.nextRecord(record, {
            activeConflictKeys: remainingKeys,
            reconciliation: {
              kind: reconciliation.kind,
              resources: sortResources(remainingResources),
            },
          });
    return this.saveAndSnapshot(record, proposed, 'resolved');
  }

  private async abandonWithoutDelete(
    record: TaskCreationJournalRecord,
  ): Promise<TaskCreationReconciliationActionResult> {
    if (record.reconciliation.kind === 'retained-quarantine') {
      const proposed = this.nextRecord(record, {
        issueCode: 'preparation-failed',
        phase: 'failed-before-commit',
        retention: { kind: 'retained-artifact' },
      });
      return this.saveAndSnapshot(record, proposed, 'resolved');
    }
    const resources =
      record.reconciliation.kind === 'mapping-ambiguous'
        ? [record.reconciliation.resource]
        : record.reconciliation.kind === 'artifact-ambiguous' ||
            record.reconciliation.kind === 'abandoned-conflicts'
          ? record.reconciliation.resources
          : null;
    if (!resources) return this.withSnapshot('stale-version-or-issue', record);
    const proposed = this.nextRecord(record, {
      issueCode: 'preparation-failed',
      phase: 'failed-before-commit',
      reconciliation: {
        kind: 'abandoned-conflicts',
        resources: sortResources(resources),
      },
      retention: { kind: 'retained-artifact' },
    });
    return this.saveAndSnapshot(record, proposed, 'resolved');
  }

  private async revealRecovery(
    record: TaskCreationJournalRecord,
    recoveryId: string,
  ): Promise<TaskCreationReconciliationActionResult> {
    if (!this.matchesRecovery(record, recoveryId)) {
      return this.withSnapshot('stale-version-or-issue', record);
    }
    const outcome = await this.dependencies.revealRecoveryQuarantine(record);
    return this.withSnapshot(outcome === 'revealed' ? 'revealed' : 'proof-insufficient', record);
  }

  private async restoreRecovery(
    record: TaskCreationJournalRecord,
    recoveryId: string,
    destinationRef: string,
    kind: 'restore' | 'retarget',
  ): Promise<TaskCreationReconciliationActionResult> {
    if (!this.matchesRecovery(record, recoveryId)) {
      return this.withSnapshot('stale-version-or-issue', record);
    }
    if (
      kind === 'restore'
        ? record.reconciliation.restore.kind !== 'retained'
        : record.reconciliation.restore.kind !== 'restore-pending'
    ) {
      return this.withSnapshot('stale-version-or-issue', record);
    }
    const plan = await this.dependencies.planRecoveryRestore(record, destinationRef, kind);
    if (!plan) return this.withSnapshot('proof-insufficient', record);
    const intent = this.withRecovery(record, {
      destinationFilesystemWitness: plan.destinationFilesystemWitness,
      destinationLocator: plan.destinationLocator,
      destinationParentWitness: plan.destinationParentWitness,
      kind: 'restore-pending',
    });
    const intentResult = await this.saveExact(record, intent);
    if (!intentResult) return this.currentProofResult(record.operationId);

    const move = await this.dependencies.moveRecoveryQuarantine(intent);
    if (
      move.kind !== 'moved-or-already-moved' ||
      !BASE64URL_SHA256.test(move.restoredResourceWitness)
    ) {
      return this.withSnapshot('proof-insufficient', intent);
    }
    const unlockIntent = this.withRecovery(intent, {
      destinationFilesystemWitness: plan.destinationFilesystemWitness,
      destinationLocator: plan.destinationLocator,
      destinationParentWitness: plan.destinationParentWitness,
      kind: 'unlock-pending',
      restoredResourceWitness: move.restoredResourceWitness,
    });
    return this.saveAndSnapshot(intent, unlockIntent, 'restore-started');
  }

  private async finalizeUnlock(
    record: TaskCreationJournalRecord,
    recoveryId: string,
  ): Promise<TaskCreationReconciliationActionResult> {
    if (!this.matchesRecovery(record, recoveryId)) {
      return this.withSnapshot('stale-version-or-issue', record);
    }
    if (record.reconciliation.restore.kind !== 'unlock-pending') {
      return this.withSnapshot('stale-version-or-issue', record);
    }
    const proof = await this.dependencies.finalizeRestoredWorktreeUnlock(record);
    if (proof.kind !== 'exact-absent') {
      return this.withSnapshot('proof-insufficient', record);
    }
    const proposed = this.releaseRecoveryArtifact(record);
    return this.saveAndSnapshot(record, proposed, 'unlock-finalized');
  }

  private async confirmRecoveryAbsent(
    record: TaskCreationJournalRecord,
    recoveryId: string,
  ): Promise<TaskCreationReconciliationActionResult> {
    if (!this.matchesRecovery(record, recoveryId)) {
      return this.withSnapshot('stale-version-or-issue', record);
    }
    const proof = await this.dependencies.probeRecoveryQuarantineAbsence(record);
    if (proof.kind !== 'exact-absent') {
      return this.withSnapshot('proof-insufficient', record);
    }
    const proposed = this.releaseRecoveryArtifact(record);
    return this.saveAndSnapshot(record, proposed, 'resolved');
  }

  private async retryBranchDelete(
    record: TaskCreationJournalRecord,
    action: Extract<
      TaskCreationReconciliationAction,
      { kind: 'confirm-retry-owned-branch-delete' }
    >,
  ): Promise<TaskCreationReconciliationActionResult> {
    if (!this.matchesBranchChallenge(record, action)) {
      return this.withSnapshot('stale-version-or-issue', record);
    }
    const attempt = this.withBranchDelete(record, {
      attempt:
        record.reconciliation.branchDelete.state === 'in-progress'
          ? record.reconciliation.branchDelete.attempt + 1
          : 1,
      state: 'in-progress',
    });
    if (!(await this.saveExact(record, attempt))) {
      return this.currentProofResult(record.operationId);
    }
    const result = await this.dependencies.retryOwnedBranchDelete(attempt);
    if (result.kind === 'proof-insufficient') {
      return this.withSnapshot('proof-insufficient', attempt);
    }
    const nextBranch: TaskCreationBranchDeleteState =
      result.kind === 'outcome-ambiguous'
        ? {
            challengeId: result.challengeId,
            confirmationVersion: result.confirmationVersion,
            observedRefFrontierWitness: result.observedRefFrontierWitness,
            state: 'confirmation-required',
          }
        : { state: 'complete' };
    const proposed = this.finishBranchState(attempt, nextBranch);
    const kind =
      result.kind === 'already-absent'
        ? 'branch-delete-already-absent'
        : 'branch-delete-retry-started';
    return this.saveAndSnapshot(attempt, proposed, kind);
  }

  private async keepCurrentBranch(
    record: TaskCreationJournalRecord,
    action: Extract<
      TaskCreationReconciliationAction,
      { kind: 'keep-current-branch-and-abandon-owned-delete' }
    >,
  ): Promise<TaskCreationReconciliationActionResult> {
    if (record.phase !== 'failed-before-commit' || !this.matchesBranchChallenge(record, action)) {
      return this.withSnapshot('stale-version-or-issue', record);
    }
    const result = await this.dependencies.keepCurrentBranch(record);
    if (result.kind === 'proof-insufficient') {
      return this.withSnapshot('proof-insufficient', record);
    }
    if (result.kind === 'changed-or-unavailable') {
      const proposed = this.withBranchDelete(record, {
        challengeId: result.challengeId,
        confirmationVersion: result.confirmationVersion,
        observedRefFrontierWitness: result.observedRefFrontierWitness,
        state: 'confirmation-required',
      });
      return this.saveAndSnapshot(record, proposed, 'proof-insufficient');
    }
    const branchState: TaskCreationBranchDeleteState = {
      state: result.kind === 'already-absent' ? 'complete' : 'abandoned-preserved',
    };
    const proposed = this.finishBranchState(record, branchState);
    return this.saveAndSnapshot(
      record,
      proposed,
      result.kind === 'already-absent'
        ? 'branch-delete-already-absent'
        : 'branch-delete-abandoned-preserved',
    );
  }

  private finishBranchState(
    record: TaskCreationJournalRecord,
    branchDelete: TaskCreationBranchDeleteState,
  ): TaskCreationJournalRecord {
    const proposed = this.withBranchDelete(record, branchDelete);
    return proposed.reconciliation.kind === 'retained-quarantine' &&
      proposed.reconciliation.restore.kind === 'released' &&
      isTerminalBranchState(branchDelete)
      ? this.terminalizeFailed(record, proposed.recordVersion)
      : proposed;
  }

  private releaseRecoveryArtifact(record: TaskCreationJournalRecord): TaskCreationJournalRecord {
    if (!isRecoveryRecord(record)) throw new Error('Recovery record changed unexpectedly');
    if (isTerminalBranchState(record.reconciliation.branchDelete)) {
      return this.terminalizeFailed(record);
    }
    return this.withRecovery(record, { kind: 'released' });
  }

  private terminalizeFailed(
    record: TaskCreationJournalRecord,
    recordVersion = record.recordVersion + 1,
  ): TaskCreationJournalRecord {
    const now = this.safeNow(record.updatedAtMs);
    return {
      ...record,
      activeConflictKeys: [],
      issueCode: 'preparation-failed',
      phase: 'failed-before-commit',
      reconciliation: { kind: 'none' },
      recordVersion,
      retention: {
        expiresAtMs: Math.min(
          Number.MAX_SAFE_INTEGER,
          now + TASK_CREATION_JOURNAL_TOMBSTONE_RETENTION_MS,
        ),
        kind: 'tombstone',
      },
      updatedAtMs: now,
    };
  }

  private withRecovery(
    record: TaskCreationJournalRecord,
    restore: Extract<
      TaskCreationJournalReconciliationState,
      { kind: 'retained-quarantine' }
    >['restore'],
  ): TaskCreationJournalRecord {
    if (!isRecoveryRecord(record)) throw new Error('Recovery record changed unexpectedly');
    return this.nextRecord(record, {
      reconciliation: { ...record.reconciliation, restore },
    });
  }

  private withBranchDelete(
    record: TaskCreationJournalRecord,
    branchDelete: TaskCreationBranchDeleteState,
  ): TaskCreationJournalRecord {
    if (!isRecoveryRecord(record)) throw new Error('Recovery record changed unexpectedly');
    return this.nextRecord(record, {
      reconciliation: { ...record.reconciliation, branchDelete },
    });
  }

  private nextRecord(
    record: TaskCreationJournalRecord,
    changes: Partial<TaskCreationJournalRecord>,
  ): TaskCreationJournalRecord {
    return {
      ...record,
      ...changes,
      recordVersion: record.recordVersion + 1,
      updatedAtMs: this.safeNow(record.updatedAtMs),
    };
  }

  private matchesRecovery(
    record: TaskCreationJournalRecord,
    recoveryId: string,
  ): record is TaskCreationJournalRecord & {
    reconciliation: Extract<
      TaskCreationJournalReconciliationState,
      { kind: 'retained-quarantine' }
    >;
  } {
    return isRecoveryRecord(record) && record.reconciliation.recoveryId === recoveryId;
  }

  private matchesBranchChallenge(
    record: TaskCreationJournalRecord,
    action: { challengeId: string; confirmationVersion: number; recoveryId: string },
  ): record is TaskCreationJournalRecord & {
    reconciliation: Extract<
      TaskCreationJournalReconciliationState,
      { kind: 'retained-quarantine' }
    >;
  } {
    if (!this.matchesRecovery(record, action.recoveryId)) return false;
    const branchDelete = record.reconciliation.branchDelete;
    return (
      branchDelete.state === 'confirmation-required' &&
      branchDelete.challengeId === action.challengeId &&
      branchDelete.confirmationVersion === action.confirmationVersion
    );
  }

  private async saveExact(
    prior: TaskCreationJournalRecord,
    proposed: TaskCreationJournalRecord,
  ): Promise<boolean> {
    const result = await this.dependencies.journal.save(proposed, prior.recordVersion);
    return result.kind === 'committed' || result.kind === 'already-current';
  }

  private async saveAndSnapshot(
    prior: TaskCreationJournalRecord,
    proposed: TaskCreationJournalRecord,
    kind: Exclude<TaskCreationReconciliationActionResult['kind'], 'absent-or-superseded'>,
  ): Promise<TaskCreationReconciliationActionResult> {
    if (!(await this.saveExact(prior, proposed))) {
      return this.currentProofResult(prior.operationId);
    }
    return this.withSnapshot(kind, proposed);
  }

  private async currentProofResult(
    operationId: TaskCreationOperationId,
  ): Promise<TaskCreationReconciliationActionResult> {
    const current = this.dependencies.journal.getByOperationId(operationId);
    return current
      ? this.withSnapshot('proof-insufficient', current)
      : { kind: 'absent-or-superseded' };
  }

  private async withSnapshot(
    kind: Exclude<TaskCreationReconciliationActionResult['kind'], 'absent-or-superseded'>,
    record: TaskCreationJournalRecord,
  ): Promise<TaskCreationReconciliationActionResult> {
    return { kind, snapshot: await this.dependencies.buildSnapshot(record) };
  }

  private safeNow(minimum: number): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid reconciliation clock');
    return Math.max(now, minimum);
  }

  private audit(
    action: TaskCreationReconciliationAction['kind'],
    actor: TaskCreationLocalAdminActor,
    outcome: TaskCreationReconciliationAuditEvent['outcome'],
  ): void {
    const occurredAtMs = this.safeNow(0);
    void Promise.resolve(this.dependencies.audit({ action, actor, occurredAtMs, outcome })).catch(
      () => {},
    );
  }

  private enqueue<T>(
    operationId: TaskCreationOperationId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.queues.get(operationId) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(operationId, settled);
    void settled.finally(() => {
      if (this.queues.get(operationId) === settled) this.queues.delete(operationId);
    });
    return result;
  }
}

export function createTaskCreationReconciliationService(
  dependencies: TaskCreationReconciliationDependencies,
): TaskCreationReconciliationService {
  return new TaskCreationReconciliationServiceImpl(dependencies);
}
