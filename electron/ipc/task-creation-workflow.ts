import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  REMOTE_TASK_CREATION_CAPABILITY_DARK,
  isTaskCreationIntent,
  isTaskCreationOperationSnapshot,
  type CancelTaskCreationOperationRequest,
  type CancelTaskCreationOperationResult,
  type CreateTaskCreationOperationResult,
  type GetTaskCreationPickerPageRequest,
  type GetTaskCreationOperationRequest,
  type GetTaskCreationOperationResult,
  type GetTaskWorktreeLinkCandidatesRequest,
  type GetTaskWorktreeLinkCandidatesResult,
  type TaskCreationPickerPage,
  type TaskCreationCapabilities,
  type TaskCreationCommittedCurrentProjection,
  type TaskCreationCreatePreRecordErrorCode,
  type TaskCreationIntent,
  type TaskCreationInfrastructureUnavailable,
  type TaskCreationLookupRejectedWithoutSnapshot,
  type TaskCreationManagedArtifactRecovery,
  type TaskCreationOperationSnapshot,
  type TaskCreationSnapshotIssue,
  type TaskWorktreeLinkWarning,
} from '../../src/domain/task-creation.js';
import {
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  deriveTaskInitialPromptDraftFingerprint,
  type TaskInitialPromptDeliverySnapshot,
} from '../../src/domain/task-initial-prompt-delivery.js';
import {
  isTaskCreationOperationCapability,
  isTaskCreationOperationId,
  isTaskCreationTicketAuthenticationContext,
  type IssueTaskCreationOperationTicketResult,
  type TaskCreationOperationId,
  type TaskCreationTicketAuthenticationContext,
} from '../../src/domain/task-creation-ticket.js';
import type {
  RetryTaskShellSessionOperationRequest,
  RetryTaskShellSessionOperationResult,
  TaskShellSessionOperationReplay,
} from '../../src/domain/task-shell-session-operation.js';
import type { JsonObject } from './workspace-state-storage.js';
import type { AgentSessionWorkflow } from './agent-session-workflow.js';
import {
  TASK_CREATION_JOURNAL_FORMAT_VERSION,
  TASK_CREATION_JOURNAL_MAX_CHARGED_BYTES,
  TASK_CREATION_JOURNAL_RECORD_LIMIT,
  TASK_CREATION_JOURNAL_TOMBSTONE_RETENTION_MS,
  TaskCreationConflictAdmissionError,
  createTaskCreationWarningReservation,
  decodeTaskCreationJournalWarnings,
  deriveTaskCreationConflictKey,
  deriveTaskCreationSemanticFingerprint,
  getTaskCreationReconciliationConflictKeys,
  getTaskCreationJournalRecordCharge,
  installTaskCreationJournalWarnings,
  taskCreationConflictKeyId,
  type NormalizedTaskCreationSemanticRequestV1,
  type TaskCreationConflictKey,
  type TaskCreationJournal,
  type TaskCreationJournalRecord,
  type TaskCreationJournalReconciliationState,
} from './task-creation-journal.js';
import type { TaskCreationOperationTicketIssuer } from './task-creation-operation-ticket.js';
import type { TaskCreationOwnerCapabilityBundle } from './task-creation-owner-capability.js';
import {
  TaskShellSessionCapacityError,
  TaskShellSessionJournalUnavailableError,
  type TaskShellSessionWorkflow,
} from './task-shell-session-workflow.js';
import {
  type AddPreparedTaskRequest,
  type ManagedTaskCreationAgentFields,
  type ManagedTaskCreationCoordinatorFields,
  type TaskStructureMutationService,
} from './task-structure-mutations.js';
import type { TaskInitialPromptDeliveryService } from './task-initial-prompt-delivery.js';

const MAX_PRINCIPAL_BUCKETS = 4_096;
const LOOKUP_PRINCIPAL_CAPACITY = 30;
const LOOKUP_PRINCIPAL_REFILL_MS = 500;
const LOOKUP_WORKSPACE_CAPACITY = 200;
const LOOKUP_WORKSPACE_REFILL_MS = 50;
const CREATE_PRINCIPAL_CAPACITY = 3;
const CREATE_PRINCIPAL_REFILL_MS = 6_000;
const CREATE_WORKSPACE_CAPACITY = 10;
const CREATE_WORKSPACE_REFILL_MS = 2_000;
const CREATE_PRINCIPAL_CONCURRENCY = 2;
const CREATE_WORKSPACE_CONCURRENCY = 8;
const CREATE_QUEUE_LIMIT = 32;
const OPERATION_SUBSCRIPTION_PRINCIPAL_LIMIT = 16;
const OPERATION_SUBSCRIPTION_WORKSPACE_LIMIT = 256;

export type TaskCreationWorkflowAction = 'cancel' | 'create' | 'read';

export interface TaskCreationWorkflowAuthorization {
  authorize(
    authentication: Readonly<TaskCreationTicketAuthenticationContext>,
    action: TaskCreationWorkflowAction,
  ): boolean | Promise<boolean>;
}

/**
 * Read-only admission resolution must perform no path, Git, workspace, journal, or process effect.
 * The preparation callback is the sole owner of idempotent path/Git preparation for its operation.
 */
export interface TaskCreationResolvedIntent {
  agent: {
    definition: Readonly<JsonObject>;
    definitionId: string;
  } | null;
  conflictKeys?: readonly TaskCreationConflictKey[];
  semanticRequest: NormalizedTaskCreationSemanticRequestV1;
}

export type TaskCreationIntentResolution =
  | { code: 'capability-denied' | 'invalid-request'; kind: 'rejected' }
  | { kind: 'resolved'; value: TaskCreationResolvedIntent };

export type TaskCreationIntentNormalization =
  | { code: 'capability-denied' | 'invalid-request'; kind: 'rejected' }
  | {
      kind: 'normalized';
      semanticRequest: NormalizedTaskCreationSemanticRequestV1;
    };

export interface TaskCreationPreparedTask {
  coordinator?: ManagedTaskCreationCoordinatorFields;
  task: Omit<AddPreparedTaskRequest, 'name' | 'projectId' | 'taskId' | 'taskMode'>;
  warnings: readonly TaskWorktreeLinkWarning[];
}

export interface TaskCreationPreparationOwner {
  getCapabilities(): Promise<TaskCreationCapabilities> | TaskCreationCapabilities;
  getPickerPage(
    request: Readonly<GetTaskCreationPickerPageRequest>,
  ): Promise<TaskCreationPickerPage>;
  getWorktreeLinkCandidates(
    request: Readonly<GetTaskWorktreeLinkCandidatesRequest>,
  ): Promise<GetTaskWorktreeLinkCandidatesResult>;
  prepare(request: {
    identities: Readonly<TaskCreationAllocatedIdentities>;
    operationId: TaskCreationOperationId;
    resolved: Readonly<TaskCreationResolvedIntent>;
  }): Promise<TaskCreationPreparedTask>;
  reconcileFailedCommit(request: {
    cause: unknown;
    identities: Readonly<TaskCreationAllocatedIdentities>;
    operationId: TaskCreationOperationId;
    prepared: Readonly<TaskCreationPreparedTask>;
    resolved: Readonly<TaskCreationResolvedIntent>;
  }): Promise<TaskCreationCommitFailureReconciliation>;
  /** Pure request normalization. This must not read canonical state or perform any effect. */
  normalizeIntent(intent: Readonly<TaskCreationIntent>): TaskCreationIntentNormalization;
  resolveIntent(
    intent: Readonly<TaskCreationIntent>,
    authentication: Readonly<TaskCreationTicketAuthenticationContext>,
    semanticRequest?: NormalizedTaskCreationSemanticRequestV1,
  ): Promise<TaskCreationIntentResolution>;
}

export type TaskCreationCommitFailureReconciliation =
  | { kind: 'proven-clean' }
  | {
      kind: 'manual-reconciliation-required';
      reconciliation: Exclude<TaskCreationJournalReconciliationState, { kind: 'none' }>;
    };

export interface TaskCreationAllocatedIdentities {
  agentId: string;
  deliveryId: string | null;
  launchOperationId: string;
  sessionId: string;
  taskId: string;
}

export interface TaskCreationIdentityFactory {
  allocate(args: {
    hasInitialPrompt: boolean;
    operationId: TaskCreationOperationId;
    taskMode: 'agent' | 'terminal';
  }): TaskCreationAllocatedIdentities;
}

export interface TaskCreationCurrentReader {
  read(
    taskId: string,
    taskMode: 'agent' | 'terminal',
  ): Promise<TaskCreationCommittedCurrentProjection<'agent' | 'terminal'>>;
}

export type TaskCreationOperationListener = (
  snapshot: TaskCreationOperationSnapshot,
) => Promise<void> | void;

export type TaskCreationOperationSubscriptionResult =
  | TaskCreationInfrastructureUnavailable
  | TaskCreationLookupRejectedWithoutSnapshot
  | {
      kind: 'subscribed';
      unsubscribe(): Promise<void>;
    };

export interface TaskCreationWorkflowDependencies {
  agentSession: Pick<AgentSessionWorkflow, 'execute'>;
  authorization: TaskCreationWorkflowAuthorization;
  current: TaskCreationCurrentReader;
  initialPrompt: Pick<TaskInitialPromptDeliveryService, 'getProjection' | 'queue'>;
  journal: TaskCreationJournal;
  now?: () => number;
  ownerCapability: TaskCreationOwnerCapabilityBundle;
  preparation: TaskCreationPreparationOwner;
  shell: TaskShellSessionWorkflow;
  structure: Pick<TaskStructureMutationService, 'addManagedTask'>;
  tickets: TaskCreationOperationTicketIssuer;
  identities?: TaskCreationIdentityFactory;
}

export interface TaskCreationWorkflow {
  cancel(
    authentication: TaskCreationTicketAuthenticationContext,
    request: CancelTaskCreationOperationRequest,
  ): Promise<CancelTaskCreationOperationResult>;
  create(
    authentication: TaskCreationTicketAuthenticationContext,
    intent: TaskCreationIntent,
  ): Promise<CreateTaskCreationOperationResult>;
  get(
    authentication: TaskCreationTicketAuthenticationContext,
    request: GetTaskCreationOperationRequest,
  ): Promise<GetTaskCreationOperationResult>;
  getCapabilities(
    authentication: TaskCreationTicketAuthenticationContext,
  ): Promise<TaskCreationCapabilities>;
  getPickerPage(
    authentication: TaskCreationTicketAuthenticationContext,
    request: GetTaskCreationPickerPageRequest,
  ): Promise<TaskCreationPickerPage>;
  getWorktreeLinkCandidates(
    authentication: TaskCreationTicketAuthenticationContext,
    request: GetTaskWorktreeLinkCandidatesRequest,
  ): Promise<GetTaskWorktreeLinkCandidatesResult>;
  issue(
    authentication: TaskCreationTicketAuthenticationContext,
  ): Promise<IssueTaskCreationOperationTicketResult>;
  /** Rebuilds and republishes one operation after catalog/current projection changes. */
  refreshOperation(operationId: TaskCreationOperationId): Promise<void>;
  retryShell(
    authentication: TaskCreationTicketAuthenticationContext,
    request: RetryTaskShellSessionOperationRequest,
  ): Promise<RetryTaskShellSessionOperationResult>;
  subscribeOperation(
    authentication: TaskCreationTicketAuthenticationContext,
    request: GetTaskCreationOperationRequest,
    listener: TaskCreationOperationListener,
  ): Promise<TaskCreationOperationSubscriptionResult>;
}

/** Internal active-owner seam; deliberately absent from transport workflow facades. */
export interface TaskCreationRecordProjector {
  projectRecord(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<TaskCreationOperationSnapshot>;
}

export interface TaskCreationInitialLaunchWaiter {
  waitForInFlightInitialLaunch(
    request: Readonly<{
      creationOperationId: TaskCreationOperationId;
      launchOperationId: string;
      sessionId: string;
      taskId: string;
    }>,
  ): Promise<void>;
}

export type ActiveTaskCreationWorkflow = TaskCreationWorkflow &
  TaskCreationRecordProjector &
  TaskCreationInitialLaunchWaiter;

interface TaskCreationOperationSubscription {
  capabilityHash: string;
  id: string;
  listener: TaskCreationOperationListener;
  operationId: TaskCreationOperationId;
  principalHash: string;
}

export class TaskCreationPreparationError extends Error {
  readonly code = 'preparation-failed';
}

export class TaskCreationPreparationManualReconciliationError extends Error {
  readonly code = 'manual-reconciliation-required';

  constructor(
    message: string,
    readonly reconciliation: Exclude<TaskCreationJournalReconciliationState, { kind: 'none' }>,
  ) {
    super(message);
  }
}

class TaskCreationJournalUnavailableError extends Error {}

class TaskCreationCurrentUnavailableError extends Error {}

interface Bucket {
  lastRefillAt: number;
  tokens: number;
}

class PrincipalTokenBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
    private readonly now: () => number,
  ) {}

  consume(principalHash: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(principalHash);
    if (!bucket) {
      if (this.buckets.size >= MAX_PRINCIPAL_BUCKETS) return false;
      bucket = { lastRefillAt: now, tokens: this.capacity };
      this.buckets.set(principalHash, bucket);
    }
    refillBucket(bucket, this.capacity, this.refillMs, now);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

interface QueuedAdmission {
  principalHash: string;
  resolve(value: (() => void) | null): void;
}

class CreationConcurrencyGate {
  private active = 0;
  private readonly activeByPrincipal = new Map<string, number>();
  private readonly queued: QueuedAdmission[] = [];

  acquire(principalHash: string): Promise<(() => void) | null> {
    if (this.canAdmit(principalHash)) return Promise.resolve(this.admit(principalHash));
    if (this.queued.length >= CREATE_QUEUE_LIMIT) return Promise.resolve(null);
    return new Promise((resolve) => this.queued.push({ principalHash, resolve }));
  }

  private canAdmit(principalHash: string): boolean {
    return (
      this.active < CREATE_WORKSPACE_CONCURRENCY &&
      (this.activeByPrincipal.get(principalHash) ?? 0) < CREATE_PRINCIPAL_CONCURRENCY
    );
  }

  private admit(principalHash: string): () => void {
    this.active += 1;
    this.activeByPrincipal.set(principalHash, (this.activeByPrincipal.get(principalHash) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const count = (this.activeByPrincipal.get(principalHash) ?? 1) - 1;
      if (count === 0) this.activeByPrincipal.delete(principalHash);
      else this.activeByPrincipal.set(principalHash, count);
      this.pump();
    };
  }

  private pump(): void {
    for (let index = 0; index < this.queued.length; ) {
      const queued = this.queued[index];
      if (!queued) break;
      if (!this.canAdmit(queued.principalHash)) {
        index += 1;
        continue;
      }
      this.queued.splice(index, 1);
      queued.resolve(this.admit(queued.principalHash));
      if (this.active >= CREATE_WORKSPACE_CONCURRENCY) break;
    }
  }
}

interface InFlightCreate {
  capabilityHash: string;
  fingerprint: string;
  promise: Promise<CreateTaskCreationOperationResult>;
}

function refillBucket(bucket: Bucket, capacity: number, refillMs: number, now: number): void {
  if (now <= bucket.lastRefillAt) return;
  const refill = Math.floor((now - bucket.lastRefillAt) / refillMs);
  if (refill <= 0) return;
  bucket.tokens = Math.min(capacity, bucket.tokens + refill);
  bucket.lastRefillAt += refill * refillMs;
}

function createWorkspaceBucket(capacity: number, now: number): Bucket {
  return { lastRefillAt: now, tokens: capacity };
}

function hashPrincipal(principalId: string): string {
  return createHash('sha256').update(principalId, 'utf8').digest('hex');
}

function fixedHashEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 64 &&
    /^[A-Za-z0-9._:@/-]+$/u.test(value)
  );
}

function defaultIdentityFactory(): TaskCreationIdentityFactory {
  return {
    allocate({ hasInitialPrompt, taskMode }) {
      const taskId = `task:${randomUUID()}`;
      const launchOperationId = `launch:${randomUUID()}`;
      const agentId = `agent:${randomUUID()}`;
      const sessionId = taskMode === 'agent' ? agentId : `shell:${randomUUID()}`;
      return {
        agentId,
        deliveryId: hasInitialPrompt ? `delivery:${randomUUID()}` : null,
        launchOperationId,
        sessionId,
        taskId,
      };
    },
  };
}

function validateIdentities(
  value: TaskCreationAllocatedIdentities,
  taskMode: 'agent' | 'terminal',
  hasPrompt: boolean,
): void {
  if (
    !isIdentifier(value.taskId) ||
    !isIdentifier(value.launchOperationId) ||
    !isIdentifier(value.agentId) ||
    !isIdentifier(value.sessionId) ||
    (value.deliveryId !== null && !isIdentifier(value.deliveryId)) ||
    hasPrompt !== (value.deliveryId !== null) ||
    (taskMode === 'agent' && value.sessionId !== value.agentId)
  ) {
    throw new Error('Task-creation identity factory returned invalid identities');
  }
}

function normalizeConflictKeys(
  projectId: string,
  keys: readonly TaskCreationConflictKey[] | undefined,
): TaskCreationConflictKey[] {
  const byId = new Map<string, TaskCreationConflictKey>();
  for (const key of [deriveTaskCreationConflictKey('project', projectId), ...(keys ?? [])]) {
    byId.set(taskCreationConflictKeyId(key), { ...key });
  }
  const result = [...byId.values()].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.digest.localeCompare(right.digest),
  );
  if (result.length === 0 || result.length > 8) {
    throw new Error('Task-creation conflict scope exceeds its bounded contract');
  }
  return result;
}

function isJournalReady(journal: TaskCreationJournal): boolean {
  return journal.getHealth() === 'healthy' && journal.getTopologyEpoch() !== null;
}

function journalUnavailable(): TaskCreationInfrastructureUnavailable {
  return { code: 'operation-journal-repair-required', kind: 'operation-journal-unavailable' };
}

function createRejected(
  code: TaskCreationCreatePreRecordErrorCode,
): CreateTaskCreationOperationResult {
  return { code, kind: 'create-rejected-without-snapshot' };
}

function lookupRejected(
  code: 'capability-denied' | 'invalid-request' | 'rate-limited',
): TaskCreationLookupRejectedWithoutSnapshot {
  return { code, kind: 'lookup-rejected-without-snapshot' };
}

function warningMessage(reason: string): string {
  return `A requested reusable entry was skipped (${reason.replace(/_/gu, ' ')}).`;
}

function allocatedIdentities(record: TaskCreationJournalRecord): TaskCreationAllocatedIdentities {
  return {
    agentId: record.identities.sessionId,
    deliveryId: record.identities.deliveryId,
    launchOperationId: record.identities.launchOperationId,
    sessionId: record.identities.sessionId,
    taskId: record.identities.taskId,
  };
}

function decodeWarnings(record: TaskCreationJournalRecord): TaskWorktreeLinkWarning[] {
  const encoded = record.warning.symlinkWarningsV1;
  if (!encoded) return [];
  return decodeTaskCreationJournalWarnings(encoded).map((warning) => ({
    message: warningMessage(warning.reason),
    name: warning.name,
    reason: warning.reason,
  }));
}

function issueFor(
  code: NonNullable<TaskCreationJournalRecord['issueCode']>,
): TaskCreationSnapshotIssue {
  const definitions: Record<
    NonNullable<TaskCreationJournalRecord['issueCode']>,
    { message: string; retryable: boolean }
  > = {
    'launch-failed': {
      message: 'The task was saved, but its initial session did not start.',
      retryable: true,
    },
    'manual-reconciliation-required': {
      message: 'Local review is required before this task creation can continue.',
      retryable: false,
    },
    'operation-journal-repair-required': {
      message: 'Task creation state needs local journal repair.',
      retryable: true,
    },
    'preparation-failed': { message: 'Task workspace preparation failed safely.', retryable: true },
    'projection-repair-required': {
      message: 'The task was saved, but its current projection needs repair.',
      retryable: true,
    },
    'prompt-enqueue-rejected': {
      message: 'The task was saved, but its initial prompt could not be queued.',
      retryable: true,
    },
    'reservation-conflict': {
      message: 'Another task creation currently owns the selected location.',
      retryable: true,
    },
    'terminal-launch-capacity': {
      message: 'Terminal launch capacity is currently full.',
      retryable: true,
    },
    'workspace-conflict': {
      message: 'The canonical workspace changed before this task could be saved.',
      retryable: true,
    },
  };
  return { code, ...definitions[code] };
}

function recoveryFromRecord(
  record: TaskCreationJournalRecord,
): TaskCreationManagedArtifactRecovery {
  if (record.reconciliation.kind === 'none') return { kind: 'none' };
  if (record.reconciliation.kind === 'retained-quarantine') {
    const branchDelete = record.reconciliation.branchDelete;
    return {
      branchDelete:
        branchDelete.state === 'confirmation-required'
          ? {
              challengeId: branchDelete.challengeId,
              confirmationVersion: branchDelete.confirmationVersion,
              kind: 'confirmation-required',
            }
          : { kind: 'not-applicable' },
      kind:
        record.reconciliation.restore.kind === 'restore-pending'
          ? 'restore-pending'
          : record.reconciliation.restore.kind === 'unlock-pending'
            ? 'unlock-pending'
            : 'retained-quarantine',
      recoveryId: record.reconciliation.recoveryId,
    };
  }
  return {
    branchDelete: { kind: 'not-applicable' },
    kind: 'manual-reconciliation-required',
    recoveryId: record.operationId,
  };
}

function hasPrompt(resolved: TaskCreationResolvedIntent): boolean {
  return (
    resolved.semanticRequest.launch.kind === 'agent' &&
    Boolean(resolved.semanticRequest.launch.initialPrompt)
  );
}

function assertResolvedIntentMatches(
  intent: TaskCreationIntent,
  resolved: TaskCreationResolvedIntent,
  normalized?: NormalizedTaskCreationSemanticRequestV1,
): void {
  const request = resolved.semanticRequest;
  if (
    (normalized !== undefined && request !== normalized) ||
    request.projectId !== intent.projectId ||
    request.name !== intent.name.trim() ||
    request.launch.kind !== intent.launch.kind ||
    request.location.kind !== intent.location.kind ||
    (request.launch.kind === 'agent' &&
      (!resolved.agent || resolved.agent.definitionId !== request.launch.agentDefId)) ||
    (request.launch.kind === 'terminal' && resolved.agent !== null)
  ) {
    throw new Error('Task-creation admission owner returned inconsistent resolved intent');
  }
}

function assertNormalizedIntentMatches(
  intent: TaskCreationIntent,
  request: NormalizedTaskCreationSemanticRequestV1,
): void {
  if (
    request.projectId !== intent.projectId ||
    request.name !== intent.name.trim() ||
    request.launch.kind !== intent.launch.kind ||
    request.location.kind !== intent.location.kind
  ) {
    throw new Error('Task-creation admission owner returned inconsistent normalized intent');
  }
}

function assertPreparedTaskMatches(
  resolved: TaskCreationResolvedIntent,
  prepared: TaskCreationPreparedTask,
): void {
  const location = resolved.semanticRequest.location.kind;
  const expectedIsolation =
    location === 'managed-worktree'
      ? 'worktree'
      : location === 'existing-worktree'
        ? 'existing-worktree'
        : 'current-branch';
  const nonGitLocationMatches =
    prepared.task.projectMode === 'non-git' &&
    location === 'project-root' &&
    prepared.task.branchName === '' &&
    prepared.task.gitIsolation === undefined &&
    prepared.task.baseBranch === undefined;
  const gitLocationMatches =
    prepared.task.projectMode === 'git' &&
    prepared.task.branchName.trim().length > 0 &&
    prepared.task.gitIsolation === expectedIsolation;
  if ((!nonGitLocationMatches && !gitLocationMatches) || !Array.isArray(prepared.warnings)) {
    throw new TaskCreationPreparationError('Prepared task does not match its admitted location');
  }
}

class TaskCreationWorkflowImpl implements ActiveTaskCreationWorkflow {
  private readonly identities: TaskCreationIdentityFactory;
  private readonly now: () => number;
  private readonly lookupPrincipal: PrincipalTokenBuckets;
  private readonly createPrincipal: PrincipalTokenBuckets;
  private lookupWorkspace: Bucket;
  private createWorkspace: Bucket;
  private readonly concurrency = new CreationConcurrencyGate();
  private readonly inFlight = new Map<string, InFlightCreate>();
  private readonly operationPublicationTails = new Map<string, Promise<void>>();
  private readonly operationSubscriptions = new Map<
    string,
    Map<string, TaskCreationOperationSubscription>
  >();
  private readonly subscriptionCountsByPrincipal = new Map<string, number>();
  private subscriptionCount = 0;

  constructor(private readonly dependencies: TaskCreationWorkflowDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.identities = dependencies.identities ?? defaultIdentityFactory();
    const initialNow = this.readNow();
    this.lookupPrincipal = new PrincipalTokenBuckets(
      LOOKUP_PRINCIPAL_CAPACITY,
      LOOKUP_PRINCIPAL_REFILL_MS,
      this.readNow.bind(this),
    );
    this.createPrincipal = new PrincipalTokenBuckets(
      CREATE_PRINCIPAL_CAPACITY,
      CREATE_PRINCIPAL_REFILL_MS,
      this.readNow.bind(this),
    );
    this.lookupWorkspace = createWorkspaceBucket(LOOKUP_WORKSPACE_CAPACITY, initialNow);
    this.createWorkspace = createWorkspaceBucket(CREATE_WORKSPACE_CAPACITY, initialNow);
  }

  async waitForInFlightInitialLaunch(
    request: Readonly<{
      creationOperationId: TaskCreationOperationId;
      launchOperationId: string;
      sessionId: string;
      taskId: string;
    }>,
  ): Promise<void> {
    const record = this.dependencies.journal.getByOperationId(request.creationOperationId);
    if (
      !record ||
      record.identities.taskId !== request.taskId ||
      record.identities.launchOperationId !== request.launchOperationId ||
      record.identities.sessionId !== request.sessionId
    )
      return;
    const pending = this.inFlight.get(`${record.workspacePrincipalHash}:${record.operationId}`);
    if (pending) await pending.promise;
  }

  async getCapabilities(
    authentication: TaskCreationTicketAuthenticationContext,
  ): Promise<TaskCreationCapabilities> {
    if (
      !isTaskCreationTicketAuthenticationContext(authentication) ||
      !(await this.dependencies.authorization.authorize(authentication, 'create'))
    ) {
      return {
        ...REMOTE_TASK_CREATION_CAPABILITY_DARK,
        locations: {
          'existing-worktree': { enabled: false, reason: 'not-authorized' },
          'managed-worktree': { enabled: false, reason: 'not-authorized' },
          'project-root': { enabled: false, reason: 'not-authorized' },
        },
        modes: {
          agent: { enabled: false, reason: 'not-authorized' },
          terminal: { enabled: false, reason: 'not-authorized' },
        },
        permissionBypass: { enabled: false, reason: 'not-authorized' },
        reason: 'not-authorized',
      };
    }
    const owners = await this.dependencies.ownerCapability.getDeploymentCapability();
    if (owners.kind !== 'active') {
      const reason =
        owners.reason === 'owner-epoch-mismatch' || owners.reason === 'owner-hook-set-mismatch'
          ? 'owner-epoch-mismatch'
          : owners.reason === 'shell-journal-unavailable'
            ? 'journal-unavailable'
            : 'backend-not-ready';
      return {
        ...REMOTE_TASK_CREATION_CAPABILITY_DARK,
        locations: {
          'existing-worktree': { enabled: false, reason },
          'managed-worktree': { enabled: false, reason },
          'project-root': { enabled: false, reason },
        },
        modes: {
          agent: { enabled: false, reason },
          terminal: { enabled: false, reason },
        },
        permissionBypass: { enabled: false, reason },
        reason,
      };
    }
    return structuredClone(await this.dependencies.preparation.getCapabilities());
  }

  async issue(
    authentication: TaskCreationTicketAuthenticationContext,
  ): Promise<IssueTaskCreationOperationTicketResult> {
    await this.requireSupportingCommandAdmission(authentication, 'create', false);
    return this.dependencies.tickets.issue(authentication);
  }

  async getPickerPage(
    authentication: TaskCreationTicketAuthenticationContext,
    request: GetTaskCreationPickerPageRequest,
  ): Promise<TaskCreationPickerPage> {
    await this.requireSupportingCommandAdmission(authentication, 'read', true);
    return structuredClone(await this.dependencies.preparation.getPickerPage(request));
  }

  async getWorktreeLinkCandidates(
    authentication: TaskCreationTicketAuthenticationContext,
    request: GetTaskWorktreeLinkCandidatesRequest,
  ): Promise<GetTaskWorktreeLinkCandidatesResult> {
    await this.requireSupportingCommandAdmission(authentication, 'read', true);
    return structuredClone(await this.dependencies.preparation.getWorktreeLinkCandidates(request));
  }

  async retryShell(
    authentication: TaskCreationTicketAuthenticationContext,
    request: RetryTaskShellSessionOperationRequest,
  ): Promise<RetryTaskShellSessionOperationResult> {
    const principalHash = await this.requireSupportingCommandAdmission(
      authentication,
      'create',
      true,
    );
    if (
      request.action !== 'retry-same-tuple' ||
      !Number.isSafeInteger(request.expectedRecordVersion) ||
      request.expectedRecordVersion < 1 ||
      !isTaskCreationOperationCapability(request.operationCapability)
    ) {
      throw new TypeError('Invalid initial-shell retry request');
    }
    const shell = await this.dependencies.shell.get(request.operationId);
    if (!shell || !isTaskCreationOperationId(shell.identity.creationOperationId)) {
      throw new Error('Initial-shell operation is unavailable');
    }
    const creation = this.dependencies.journal.get(
      principalHash,
      shell.identity.creationOperationId,
    );
    const capabilityHash = this.dependencies.tickets.hashOperationCapability(
      request.operationCapability,
    );
    if (
      !creation ||
      creation.taskMode !== 'terminal' ||
      creation.identities.launchOperationId !== request.operationId ||
      !fixedHashEqual(creation.capabilityHash, capabilityHash)
    ) {
      throw new Error('Initial-shell operation capability denied');
    }
    const result = await this.dependencies.shell.retrySameTuple(request);
    await this.refreshOperation(shell.identity.creationOperationId);
    return result;
  }

  async create(
    authentication: TaskCreationTicketAuthenticationContext,
    intent: TaskCreationIntent,
  ): Promise<CreateTaskCreationOperationResult> {
    if (
      !isTaskCreationTicketAuthenticationContext(authentication) ||
      !isTaskCreationIntent(intent)
    ) {
      return createRejected('invalid-request');
    }
    if (!(await this.dependencies.authorization.authorize(authentication, 'create'))) {
      return createRejected('capability-denied');
    }
    const principalHash = hashPrincipal(authentication.workspacePrincipalId);
    if (!this.consumeLookup(principalHash)) return createRejected('rate-limited');
    if (!isJournalReady(this.dependencies.journal)) return journalUnavailable();

    let normalization: TaskCreationIntentNormalization;
    try {
      normalization = this.dependencies.preparation.normalizeIntent(intent);
    } catch {
      return createRejected('invalid-request');
    }
    if (normalization.kind === 'rejected') return createRejected(normalization.code);
    try {
      assertNormalizedIntentMatches(intent, normalization.semanticRequest);
    } catch {
      return createRejected('capability-denied');
    }

    const capabilityHash = this.dependencies.tickets.hashOperationCapability(
      intent.operationCapability,
    );
    const fingerprint = deriveTaskCreationSemanticFingerprint(
      intent.operationCapability,
      normalization.semanticRequest,
    );
    const operationKey = `${principalHash}:${intent.operationId}`;
    const existingFlight = this.inFlight.get(operationKey);
    if (existingFlight) {
      if (
        !fixedHashEqual(existingFlight.capabilityHash, capabilityHash) ||
        !fixedHashEqual(existingFlight.fingerprint, fingerprint)
      ) {
        return createRejected('operation-conflict');
      }
      return this.asJoined(await existingFlight.promise);
    }

    const known = this.dependencies.journal.get(principalHash, intent.operationId);
    if (known) {
      if (!this.matchesKnown(known, capabilityHash, fingerprint)) {
        return createRejected('operation-conflict');
      }
      if (known.phase !== 'validating') {
        return this.snapshotCreateResult('replayed', known);
      }
      return this.runInFlight(operationKey, capabilityHash, fingerprint, () =>
        this.resolveAndContinueKnown(authentication, intent, normalization.semanticRequest, known),
      );
    }

    return this.runInFlight(operationKey, capabilityHash, fingerprint, () =>
      this.admitFresh(
        authentication,
        intent,
        normalization.semanticRequest,
        principalHash,
        capabilityHash,
        fingerprint,
      ),
    );
  }

  private async admitFresh(
    authentication: TaskCreationTicketAuthenticationContext,
    intent: TaskCreationIntent,
    semanticRequest: NormalizedTaskCreationSemanticRequestV1,
    principalHash: string,
    capabilityHash: string,
    fingerprint: string,
  ): Promise<CreateTaskCreationOperationResult> {
    const ticket = this.dependencies.tickets.verify({
      authentication,
      operationId: intent.operationId,
      operationTicket: intent.operationTicket,
    });
    if (ticket.kind === 'expired') return createRejected('operation-ticket-expired');
    if (ticket.kind !== 'valid') return createRejected('operation-ticket-invalid');
    const ownerCapability = await this.dependencies.ownerCapability.getDeploymentCapability();
    if (ownerCapability.kind !== 'active') return createRejected('capability-denied');
    if (!this.consumeCreateAdmission(principalHash)) return createRejected('rate-limited');

    const resolution = await this.dependencies.preparation.resolveIntent(
      intent,
      authentication,
      semanticRequest,
    );
    if (resolution.kind === 'rejected') return createRejected(resolution.code);
    try {
      assertResolvedIntentMatches(intent, resolution.value, semanticRequest);
    } catch {
      return createRejected('capability-denied');
    }
    return this.admitAndRunFresh(
      authentication,
      intent,
      resolution.value,
      principalHash,
      capabilityHash,
      fingerprint,
    );
  }

  async get(
    authentication: TaskCreationTicketAuthenticationContext,
    request: GetTaskCreationOperationRequest,
  ): Promise<GetTaskCreationOperationResult> {
    const validation = await this.validateLookup(authentication, request, 'read');
    if (validation.kind !== 'ready') return validation.result;
    const record = this.dependencies.journal.get(validation.principalHash, request.operationId);
    if (!record) return { kind: 'operation-state-unavailable' };
    const capabilityHash = this.dependencies.tickets.hashOperationCapability(
      request.operationCapability,
    );
    if (!fixedHashEqual(record.capabilityHash, capabilityHash)) {
      return lookupRejected('capability-denied');
    }
    try {
      const snapshot = await this.projectRecord(record);
      return snapshot.taskMode === 'agent'
        ? { kind: 'snapshot', outcome: 'found', snapshot }
        : { kind: 'snapshot', outcome: 'found', snapshot };
    } catch {
      return { code: 'host-state-recovery-required', kind: 'canonical-host-unavailable' };
    }
  }

  async subscribeOperation(
    authentication: TaskCreationTicketAuthenticationContext,
    request: GetTaskCreationOperationRequest,
    listener: TaskCreationOperationListener,
  ): Promise<TaskCreationOperationSubscriptionResult> {
    if (typeof listener !== 'function') return lookupRejected('invalid-request');
    const validation = await this.validateLookup(authentication, request, 'read');
    if (validation.kind !== 'ready') return validation.result;
    const principalCount = this.subscriptionCountsByPrincipal.get(validation.principalHash) ?? 0;
    if (
      this.subscriptionCount >= OPERATION_SUBSCRIPTION_WORKSPACE_LIMIT ||
      principalCount >= OPERATION_SUBSCRIPTION_PRINCIPAL_LIMIT
    ) {
      return lookupRejected('rate-limited');
    }

    const capabilityHash = this.dependencies.tickets.hashOperationCapability(
      request.operationCapability,
    );
    const operationKey = `${validation.principalHash}:${request.operationId}`;
    const id = randomUUID();
    const subscription: TaskCreationOperationSubscription = {
      capabilityHash,
      id,
      listener,
      operationId: request.operationId,
      principalHash: validation.principalHash,
    };
    let subscriptions = this.operationSubscriptions.get(operationKey);
    if (!subscriptions) {
      subscriptions = new Map();
      this.operationSubscriptions.set(operationKey, subscriptions);
    }
    subscriptions.set(id, subscription);
    this.subscriptionCount += 1;
    this.subscriptionCountsByPrincipal.set(validation.principalHash, principalCount + 1);

    queueMicrotask(() => {
      void this.refreshSubscribedOperation(subscription).catch(() => undefined);
    });
    return {
      kind: 'subscribed',
      unsubscribe: async () => {
        this.removeOperationSubscription(operationKey, subscription);
      },
    };
  }

  async refreshOperation(operationId: TaskCreationOperationId): Promise<void> {
    if (!isTaskCreationOperationId(operationId) || !isJournalReady(this.dependencies.journal)) {
      return;
    }
    const record = this.dependencies.journal.getByOperationId(operationId);
    if (!record) return;
    await this.enqueueOperationSnapshot(record);
  }

  async cancel(
    authentication: TaskCreationTicketAuthenticationContext,
    request: CancelTaskCreationOperationRequest,
  ): Promise<CancelTaskCreationOperationResult> {
    const validation = await this.validateLookup(authentication, request, 'cancel');
    if (validation.kind !== 'ready') return validation.result;
    if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1) {
      return lookupRejected('invalid-request');
    }
    const record = this.dependencies.journal.get(validation.principalHash, request.operationId);
    if (!record) return { kind: 'operation-state-unavailable' };
    const capabilityHash = this.dependencies.tickets.hashOperationCapability(
      request.operationCapability,
    );
    if (!fixedHashEqual(record.capabilityHash, capabilityHash)) {
      return lookupRejected('capability-denied');
    }
    if (record.recordVersion !== request.expectedVersion) {
      return this.snapshotCancelResult('version-conflict', record);
    }
    if (record.phase !== 'validating') {
      const terminal =
        record.phase === 'active' ||
        record.phase === 'created-needs-attention' ||
        record.phase === 'failed-before-commit' ||
        record.phase === 'cancelled-before-preparation' ||
        record.phase === 'removed-tombstone';
      return this.snapshotCancelResult(terminal ? 'already-terminal' : 'too-late', record);
    }
    const cancelled = this.nextRecord(record, {
      activeConflictKeys: [],
      phase: 'cancelled-before-preparation',
      retention: {
        expiresAtMs: this.readNow() + TASK_CREATION_JOURNAL_TOMBSTONE_RETENTION_MS,
        kind: 'tombstone',
      },
    });
    try {
      await this.persist(cancelled, record.recordVersion);
      if (record.taskMode === 'terminal') {
        try {
          const shell = await this.dependencies.shell.get(record.identities.launchOperationId);
          if (shell) {
            await this.dependencies.shell.cancelBeforeTaskCommit(
              record.identities.launchOperationId,
            );
          }
        } catch {
          // The durable creation cancellation remains authoritative; shell startup repair closes it.
        }
      }
      return this.snapshotCancelResult('cancelled', cancelled);
    } catch {
      return journalUnavailable();
    }
  }

  private async admitAndRunFresh(
    authentication: TaskCreationTicketAuthenticationContext,
    intent: TaskCreationIntent,
    resolved: TaskCreationResolvedIntent,
    principalHash: string,
    capabilityHash: string,
    fingerprint: string,
  ): Promise<CreateTaskCreationOperationResult> {
    const release = await this.concurrency.acquire(principalHash);
    if (!release) return createRejected('rate-limited');
    try {
      const raced = this.dependencies.journal.get(principalHash, intent.operationId);
      if (raced) {
        return this.matchesKnown(raced, capabilityHash, fingerprint)
          ? this.snapshotCreateResult('joined', raced)
          : createRejected('operation-conflict');
      }
      const taskMode = resolved.semanticRequest.launch.kind;
      const identities = this.identities.allocate({
        hasInitialPrompt: hasPrompt(resolved),
        operationId: intent.operationId,
        taskMode,
      });
      validateIdentities(identities, taskMode, hasPrompt(resolved));
      const taskCapability = await this.dependencies.ownerCapability.getTaskAdmissionCapability(
        identities.taskId,
      );
      if (taskCapability.kind !== 'active') {
        return createRejected('capability-denied');
      }

      const conflictKeys = normalizeConflictKeys(resolved.semanticRequest.projectId, [
        ...(resolved.conflictKeys ?? []),
        deriveTaskCreationConflictKey('task', identities.taskId),
        deriveTaskCreationConflictKey('launch-operation', identities.launchOperationId),
      ]);
      const warning =
        resolved.semanticRequest.location.kind === 'managed-worktree'
          ? createTaskCreationWarningReservation(
              resolved.semanticRequest.location.worktreeLinkRequest,
            )
          : { warningReservationBytes: 0 };
      const now = this.readNow();
      const record: TaskCreationJournalRecord = {
        activeConflictKeys: conflictKeys,
        capabilityHash,
        commit: { kind: 'not-committed' },
        conflictKeys,
        createdAtMs: now,
        formatVersion: TASK_CREATION_JOURNAL_FORMAT_VERSION,
        identities: {
          deliveryId: identities.deliveryId,
          launchOperationId: identities.launchOperationId,
          sessionId: identities.sessionId,
          taskId: identities.taskId,
        },
        issueCode: null,
        operationId: intent.operationId,
        phase: 'validating',
        reconciliation: { kind: 'none' },
        recordVersion: 1,
        retention: { kind: 'nonterminal' },
        semanticFingerprint: fingerprint,
        taskMode,
        updatedAtMs: now,
        warning,
        workspacePrincipalHash: principalHash,
      };
      if (this.wouldExceedJournalCapacity(record)) return createRejected('creation-capacity');
      try {
        await this.persist(record, null);
      } catch (error) {
        if (error instanceof TaskCreationConflictAdmissionError) {
          return createRejected('operation-conflict');
        }
        return this.isCapacityError(error)
          ? createRejected('creation-capacity')
          : journalUnavailable();
      }
      return this.runAdmitted(authentication, intent, resolved, record);
    } finally {
      release();
    }
  }

  private async continueKnown(
    authentication: TaskCreationTicketAuthenticationContext,
    intent: TaskCreationIntent,
    resolved: TaskCreationResolvedIntent,
    record: TaskCreationJournalRecord,
  ): Promise<CreateTaskCreationOperationResult> {
    const release = await this.concurrency.acquire(record.workspacePrincipalHash);
    if (!release) return createRejected('rate-limited');
    try {
      const current = this.dependencies.journal.get(
        record.workspacePrincipalHash,
        record.operationId,
      );
      if (!current) return journalUnavailable();
      if (current.phase !== 'validating') return this.snapshotCreateResult('replayed', current);
      if (this.hasForeignConflictOwner(current)) {
        return createRejected('operation-conflict');
      }
      const capability = await this.dependencies.ownerCapability.getTaskAdmissionCapability(
        current.identities.taskId,
      );
      if (capability.kind !== 'active') return createRejected('capability-denied');
      return this.runAdmitted(authentication, intent, resolved, current);
    } finally {
      release();
    }
  }

  private async resolveAndContinueKnown(
    authentication: TaskCreationTicketAuthenticationContext,
    intent: TaskCreationIntent,
    semanticRequest: NormalizedTaskCreationSemanticRequestV1,
    record: TaskCreationJournalRecord,
  ): Promise<CreateTaskCreationOperationResult> {
    const resolution = await this.dependencies.preparation.resolveIntent(
      intent,
      authentication,
      semanticRequest,
    );
    if (resolution.kind === 'rejected') return createRejected(resolution.code);
    try {
      assertResolvedIntentMatches(intent, resolution.value, semanticRequest);
    } catch {
      return createRejected('capability-denied');
    }
    return this.continueKnown(authentication, intent, resolution.value, record);
  }

  private async runAdmitted(
    _authentication: TaskCreationTicketAuthenticationContext,
    _intent: TaskCreationIntent,
    resolved: TaskCreationResolvedIntent,
    initial: TaskCreationJournalRecord,
  ): Promise<CreateTaskCreationOperationResult> {
    let record = initial;
    if (record.taskMode === 'terminal') {
      try {
        await this.dependencies.shell.reserveForTaskCommit({
          capabilityHash: record.capabilityHash,
          creationOperationId: record.operationId,
          expectedGeneration: 0,
          operationId: record.identities.launchOperationId,
          sessionId: record.identities.sessionId,
          taskId: record.identities.taskId,
          workspacePrincipalHash: record.workspacePrincipalHash,
        });
      } catch (error) {
        const issue =
          error instanceof TaskShellSessionCapacityError
            ? 'terminal-launch-capacity'
            : error instanceof TaskShellSessionJournalUnavailableError
              ? 'preparation-failed'
              : 'reservation-conflict';
        record = await this.failBeforeCommit(record, issue);
        return this.snapshotCreateResult('accepted', record);
      }
    }

    record = this.nextRecord(record, { phase: 'preparing' });
    try {
      await this.persist(record, initial.recordVersion);
    } catch {
      return journalUnavailable();
    }

    let prepared: TaskCreationPreparedTask;
    try {
      prepared = await this.dependencies.preparation.prepare({
        identities: allocatedIdentities(record),
        operationId: record.operationId,
        resolved,
      });
      assertPreparedTaskMatches(resolved, prepared);
    } catch (error) {
      if (record.taskMode === 'terminal') await this.cancelShellReservation(record);
      if (error instanceof TaskCreationPreparationManualReconciliationError) {
        record = await this.manualBeforeCommit(record, error.reconciliation);
      } else {
        record = await this.failBeforeCommit(record, 'preparation-failed');
      }
      return this.snapshotCreateResult('accepted', record);
    }

    let warning = record.warning;
    try {
      if (resolved.semanticRequest.location.kind === 'managed-worktree') {
        warning = installTaskCreationJournalWarnings(
          resolved.semanticRequest.location.worktreeLinkRequest,
          prepared.warnings,
          record.warning,
        );
      } else if (prepared.warnings.length > 0) {
        throw new TaskCreationPreparationError(
          'Non-managed preparation returned managed-link warnings',
        );
      }
    } catch {
      if (record.taskMode === 'terminal') await this.cancelShellReservation(record);
      record = await this.failBeforeCommit(record, 'preparation-failed');
      return this.snapshotCreateResult('accepted', record);
    }

    const committing = this.nextRecord(record, { phase: 'committing', warning });
    try {
      await this.persist(committing, record.recordVersion);
      record = committing;
    } catch {
      return journalUnavailable();
    }

    let committedRevision: number;
    try {
      const semantic = resolved.semanticRequest;
      const agent: ManagedTaskCreationAgentFields | undefined =
        semantic.launch.kind === 'agent' && resolved.agent
          ? {
              agentDef: structuredClone(resolved.agent.definition),
              agentDefId: resolved.agent.definitionId,
              agentId: record.identities.sessionId,
              skipPermissions: semantic.launch.skipPermissions,
            }
          : undefined;
      const commit = await this.dependencies.structure.addManagedTask(
        { operation: 'create-task-v1', sourceId: record.workspacePrincipalHash },
        {
          ...prepared.task,
          ...(agent ? { agent } : {}),
          ...(prepared.coordinator ? { coordinator: prepared.coordinator } : {}),
          ...(semantic.branchPrefixPreference !== undefined
            ? { branchPrefixPreference: semantic.branchPrefixPreference }
            : {}),
          creationOperationId: record.operationId,
          expectedInitialShellGeneration: 0,
          ...(record.identities.deliveryId &&
          semantic.launch.kind === 'agent' &&
          semantic.launch.initialPrompt
            ? {
                initialPrompt: {
                  deliveryId: record.identities.deliveryId,
                  text: semantic.launch.initialPrompt,
                },
              }
            : {}),
          launchOperationId: record.identities.launchOperationId,
          name: semantic.name,
          projectId: semantic.projectId,
          sessionId: record.identities.sessionId,
          taskId: record.identities.taskId,
          taskMode: record.taskMode,
          stepsTracking: semantic.stepsTracking,
          ...(semantic.githubUrl !== undefined ? { githubUrl: semantic.githubUrl } : {}),
        },
      );
      committedRevision = commit.revision;
    } catch (error) {
      const reconciled = await this.dependencies.preparation.reconcileFailedCommit({
        cause: error,
        identities: allocatedIdentities(record),
        operationId: record.operationId,
        prepared,
        resolved,
      });
      if (record.taskMode === 'terminal') await this.cancelShellReservation(record);
      record =
        reconciled.kind === 'manual-reconciliation-required'
          ? await this.manualBeforeCommit(record, reconciled.reconciliation)
          : await this.failBeforeCommit(record, 'workspace-conflict');
      return this.snapshotCreateResult('accepted', record);
    }

    const starting = this.nextRecord(record, {
      activeConflictKeys: [],
      commit: {
        kind: 'committed',
        taskId: record.identities.taskId,
        workspaceRevision: committedRevision,
      },
      phase: 'starting',
      retention: { kind: 'live-task' },
    });
    try {
      await this.persist(starting, record.recordVersion);
      record = starting;
    } catch {
      return journalUnavailable();
    }

    return record.taskMode === 'terminal'
      ? this.startTerminal(record)
      : this.startAgent(record, resolved);
  }

  private async startTerminal(
    initial: TaskCreationJournalRecord,
  ): Promise<CreateTaskCreationOperationResult> {
    let record = initial;
    try {
      await this.dependencies.shell.admitAfterTaskCommit({
        committedWorkspaceRevision: this.committedRevision(record),
        creationOperationId: record.operationId,
        operationId: record.identities.launchOperationId,
        taskId: record.identities.taskId,
      });
      const replay = await this.dependencies.shell.start({
        creationOperationId: record.operationId,
        operationId: record.identities.launchOperationId,
        taskId: record.identities.taskId,
      });
      const launched =
        replay.disposition.kind === 'attempted-no-replay' &&
        replay.disposition.reason === 'running-at-ack';
      record = this.nextRecord(record, {
        issueCode: launched ? null : 'launch-failed',
        phase: launched ? 'active' : 'created-needs-attention',
      });
      await this.persist(record, initial.recordVersion);
    } catch {
      record = this.nextRecord(record, {
        issueCode: 'launch-failed',
        phase: 'created-needs-attention',
      });
      try {
        await this.persist(record, initial.recordVersion);
      } catch {
        return journalUnavailable();
      }
    }
    return this.snapshotCreateResult('accepted', record);
  }

  private async startAgent(
    initial: TaskCreationJournalRecord,
    resolved: TaskCreationResolvedIntent,
  ): Promise<CreateTaskCreationOperationResult> {
    let record = initial;
    if (resolved.semanticRequest.launch.kind !== 'agent' || !resolved.agent) {
      record = this.nextRecord(record, {
        issueCode: 'projection-repair-required',
        phase: 'created-needs-attention',
      });
      await this.persist(record, initial.recordVersion);
      return this.snapshotCreateResult('accepted', record);
    }
    const launch = await this.dependencies.agentSession.execute({
      admission: {
        committedWorkspaceRevision: this.committedRevision(record),
        creationOperationId: record.operationId,
        kind: 'task-creation',
      },
      agentId: record.identities.sessionId,
      expectedLeaseGeneration: null,
      expectedSourceGeneration: null,
      launchReason: 'initial',
      mode: 'initial',
      nextAgentDefId: resolved.agent.definitionId,
      operationId: record.identities.launchOperationId,
      taskId: record.identities.taskId,
    });
    if (launch.kind !== 'operation' || launch.projection.operation.phase !== 'running') {
      record = this.nextRecord(record, {
        issueCode: 'launch-failed',
        phase: 'created-needs-attention',
      });
      await this.persist(record, initial.recordVersion);
      return this.snapshotCreateResult('accepted', record);
    }
    const prompt = resolved.semanticRequest.launch.initialPrompt;
    const deliveryId = record.identities.deliveryId;
    if (!prompt || !deliveryId) {
      record = this.nextRecord(record, { phase: 'active' });
      await this.persist(record, initial.recordVersion);
      return this.snapshotCreateResult('accepted', record);
    }
    const delivering = this.nextRecord(record, { phase: 'delivering-prompt' });
    await this.persist(delivering, record.recordVersion);
    record = delivering;
    const queued = await this.dependencies.initialPrompt.queue({
      agentId: record.identities.sessionId,
      deliveryId,
      expectedDraftFingerprint: deriveTaskInitialPromptDraftFingerprint({
        agentId: record.identities.sessionId,
        readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
        taskId: record.identities.taskId,
        text: prompt,
      }),
      readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
      taskId: record.identities.taskId,
    });
    record = this.nextRecord(record, {
      issueCode: queued.kind === 'accepted' ? null : 'projection-repair-required',
      phase: queued.kind === 'accepted' ? 'active' : 'created-needs-attention',
    });
    await this.persist(record, delivering.recordVersion);
    return this.snapshotCreateResult('accepted', record);
  }

  async projectRecord(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<TaskCreationOperationSnapshot> {
    const observed = await this.dependencies.current.read(
      record.identities.taskId,
      record.taskMode,
    );
    const current =
      record.commit.kind === 'not-committed'
        ? {
            catalogVersion: observed.catalogVersion,
            serverInstanceId: observed.serverInstanceId,
            task: null,
            taskClosing: false as const,
            taskState: 'not-visible' as const,
            workspaceRevision: observed.workspaceRevision,
          }
        : observed;
    let shellLaunch: TaskShellSessionOperationReplay | undefined;
    let promptDelivery: TaskInitialPromptDeliverySnapshot | undefined;
    if (record.commit.kind === 'committed' && record.taskMode === 'terminal') {
      shellLaunch =
        (await this.dependencies.shell.get(record.identities.launchOperationId)) ?? undefined;
    }
    if (
      record.commit.kind === 'committed' &&
      record.taskMode === 'agent' &&
      record.identities.deliveryId
    ) {
      promptDelivery = (
        await this.dependencies.initialPrompt.getProjection(record.identities.deliveryId)
      )?.delivery;
    }
    const candidate: unknown = {
      commit: record.commit.kind,
      committedTaskId: record.commit.kind === 'committed' ? record.commit.taskId : null,
      committedWorkspaceRevision:
        record.commit.kind === 'committed' ? record.commit.workspaceRevision : null,
      current,
      ...(record.issueCode ? { issue: issueFor(record.issueCode) } : {}),
      managedArtifactRecovery: recoveryFromRecord(record),
      operationId: record.operationId,
      phase: record.phase,
      ...(promptDelivery ? { promptDelivery } : {}),
      ...(record.taskMode === 'agent' &&
      record.issueCode === 'launch-failed' &&
      record.commit.kind === 'committed'
        ? {
            recovery: {
              committedWorkspaceRevision: record.commit.workspaceRevision,
              kind: 'retry-agent-launch',
              launchOperationId: record.identities.launchOperationId,
            },
          }
        : {}),
      ...(record.taskMode === 'agent' &&
      record.issueCode === 'prompt-enqueue-rejected' &&
      record.identities.deliveryId
        ? {
            recovery: {
              deliveryId: record.identities.deliveryId,
              kind: 'review-initial-prompt',
            },
          }
        : {}),
      serverInstanceId: current.serverInstanceId,
      ...(shellLaunch ? { shellLaunch } : {}),
      symlinkWarnings: decodeWarnings(record),
      taskMode: record.taskMode,
      version: record.recordVersion,
    };
    if (!isTaskCreationOperationSnapshot(candidate)) {
      throw new TaskCreationCurrentUnavailableError('Task creation snapshot cannot be projected');
    }
    return candidate;
  }

  private nextRecord(
    record: TaskCreationJournalRecord,
    changes: Partial<
      Pick<
        TaskCreationJournalRecord,
        | 'activeConflictKeys'
        | 'commit'
        | 'issueCode'
        | 'phase'
        | 'reconciliation'
        | 'retention'
        | 'warning'
      >
    >,
  ): TaskCreationJournalRecord {
    return {
      ...record,
      ...changes,
      recordVersion: record.recordVersion + 1,
      updatedAtMs: Math.max(record.updatedAtMs, this.readNow()),
    };
  }

  private async failBeforeCommit(
    record: TaskCreationJournalRecord,
    issueCode:
      | 'preparation-failed'
      | 'reservation-conflict'
      | 'terminal-launch-capacity'
      | 'workspace-conflict',
  ): Promise<TaskCreationJournalRecord> {
    const failed = this.nextRecord(record, {
      activeConflictKeys: [],
      issueCode,
      phase: 'failed-before-commit',
      retention: {
        expiresAtMs: this.readNow() + TASK_CREATION_JOURNAL_TOMBSTONE_RETENTION_MS,
        kind: 'tombstone',
      },
    });
    await this.persist(failed, record.recordVersion);
    return failed;
  }

  private async manualBeforeCommit(
    record: TaskCreationJournalRecord,
    reconciliation: Exclude<TaskCreationJournalReconciliationState, { kind: 'none' }>,
  ): Promise<TaskCreationJournalRecord> {
    const reconciliationKeys = new Set(
      getTaskCreationReconciliationConflictKeys(reconciliation).map(taskCreationConflictKeyId),
    );
    const activeConflictKeys = record.activeConflictKeys.filter((key) =>
      reconciliationKeys.has(taskCreationConflictKeyId(key)),
    );
    if (activeConflictKeys.length !== reconciliationKeys.size) {
      throw new TaskCreationJournalUnavailableError(
        'Task-creation reconciliation referenced an undeclared conflict key',
      );
    }
    const manual = this.nextRecord(record, {
      activeConflictKeys,
      issueCode: 'manual-reconciliation-required',
      phase: 'manual-reconciliation-required',
      reconciliation,
      retention:
        reconciliation.kind === 'retained-quarantine'
          ? { kind: 'retained-artifact' }
          : { kind: 'nonterminal' },
    });
    await this.persist(manual, record.recordVersion);
    return manual;
  }

  private async cancelShellReservation(record: TaskCreationJournalRecord): Promise<void> {
    try {
      await this.dependencies.shell.cancelBeforeTaskCommit(record.identities.launchOperationId);
    } catch {
      // Startup repair classifies the exact operation mapping before any later spawn admission.
    }
  }

  private async refreshSubscribedOperation(
    subscription: TaskCreationOperationSubscription,
  ): Promise<void> {
    const operationKey = `${subscription.principalHash}:${subscription.operationId}`;
    if (this.operationSubscriptions.get(operationKey)?.get(subscription.id) !== subscription) {
      return;
    }
    const record = this.dependencies.journal.get(
      subscription.principalHash,
      subscription.operationId,
    );
    if (!record || !fixedHashEqual(record.capabilityHash, subscription.capabilityHash)) {
      return;
    }
    await this.enqueueOperationSnapshot(record);
  }

  private removeOperationSubscription(
    operationKey: string,
    subscription: TaskCreationOperationSubscription,
  ): void {
    const subscriptions = this.operationSubscriptions.get(operationKey);
    if (subscriptions?.get(subscription.id) !== subscription) return;
    subscriptions.delete(subscription.id);
    if (subscriptions.size === 0) this.operationSubscriptions.delete(operationKey);
    this.subscriptionCount -= 1;
    const principalCount = this.subscriptionCountsByPrincipal.get(subscription.principalHash) ?? 0;
    if (principalCount <= 1) this.subscriptionCountsByPrincipal.delete(subscription.principalHash);
    else this.subscriptionCountsByPrincipal.set(subscription.principalHash, principalCount - 1);
  }

  private enqueueOperationSnapshot(record: TaskCreationJournalRecord): Promise<void> {
    const operationKey = `${record.workspacePrincipalHash}:${record.operationId}`;
    const previous = this.operationPublicationTails.get(operationKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.publishOperationSnapshot(operationKey, record));
    this.operationPublicationTails.set(operationKey, next);
    const clearTail = () => {
      if (this.operationPublicationTails.get(operationKey) === next) {
        this.operationPublicationTails.delete(operationKey);
      }
    };
    void next.then(clearTail, clearTail);
    return next;
  }

  private async publishOperationSnapshot(
    operationKey: string,
    record: TaskCreationJournalRecord,
  ): Promise<void> {
    const subscriptions = this.operationSubscriptions.get(operationKey);
    if (!subscriptions) return;
    const authorized = [...subscriptions.values()].filter(
      (subscription) =>
        subscription.principalHash === record.workspacePrincipalHash &&
        subscription.operationId === record.operationId &&
        fixedHashEqual(subscription.capabilityHash, record.capabilityHash),
    );
    if (authorized.length === 0) return;

    let snapshot: TaskCreationOperationSnapshot;
    try {
      snapshot = await this.projectRecord(record);
    } catch {
      return;
    }
    for (const subscription of authorized) {
      if (subscriptions.get(subscription.id) !== subscription) continue;
      try {
        const result = subscription.listener(structuredClone(snapshot));
        if (result && typeof result.then === 'function') void result.catch(() => undefined);
      } catch {
        // Operation events are observational and cannot roll back a durable transition.
      }
    }
  }

  private async persist(
    record: TaskCreationJournalRecord,
    expectedVersion: number | null,
  ): Promise<void> {
    const result = await this.dependencies.journal.save(record, expectedVersion);
    if (result.kind !== 'committed' && result.kind !== 'already-current') {
      throw new TaskCreationJournalUnavailableError('Task-creation journal write is unavailable');
    }
    void this.enqueueOperationSnapshot(record);
  }

  private matchesKnown(
    record: TaskCreationJournalRecord,
    capabilityHash: string,
    fingerprint: string,
  ): boolean {
    return (
      fixedHashEqual(record.capabilityHash, capabilityHash) &&
      fixedHashEqual(record.semanticFingerprint, fingerprint)
    );
  }

  private hasForeignConflictOwner(record: TaskCreationJournalRecord): boolean {
    return record.activeConflictKeys.some((key) =>
      this.dependencies.journal
        .findConflict(key)
        .some((candidate) => candidate.operationId !== record.operationId),
    );
  }

  private async snapshotCreateResult(
    outcome: 'accepted' | 'joined' | 'replayed',
    record: TaskCreationJournalRecord,
  ): Promise<CreateTaskCreationOperationResult> {
    try {
      const snapshot = await this.projectRecord(record);
      return snapshot.taskMode === 'agent'
        ? { kind: 'snapshot', outcome, snapshot }
        : { kind: 'snapshot', outcome, snapshot };
    } catch {
      return { code: 'host-state-recovery-required', kind: 'canonical-host-unavailable' };
    }
  }

  private async snapshotCancelResult(
    outcome: 'already-terminal' | 'cancelled' | 'too-late' | 'version-conflict',
    record: TaskCreationJournalRecord,
  ): Promise<CancelTaskCreationOperationResult> {
    try {
      const snapshot = await this.projectRecord(record);
      return snapshot.taskMode === 'agent'
        ? { kind: 'snapshot', outcome, snapshot }
        : { kind: 'snapshot', outcome, snapshot };
    } catch {
      return { code: 'host-state-recovery-required', kind: 'canonical-host-unavailable' };
    }
  }

  private runInFlight(
    operationKey: string,
    capabilityHash: string,
    fingerprint: string,
    operation: () => Promise<CreateTaskCreationOperationResult>,
  ): Promise<CreateTaskCreationOperationResult> {
    const promise = operation();
    this.inFlight.set(operationKey, { capabilityHash, fingerprint, promise });
    void promise.finally(() => {
      if (this.inFlight.get(operationKey)?.promise === promise) this.inFlight.delete(operationKey);
    });
    return promise;
  }

  private asJoined(result: CreateTaskCreationOperationResult): CreateTaskCreationOperationResult {
    return result.kind === 'snapshot' ? { ...result, outcome: 'joined' } : result;
  }

  private async validateLookup(
    authentication: TaskCreationTicketAuthenticationContext,
    request: GetTaskCreationOperationRequest,
    action: 'cancel' | 'read',
  ): Promise<
    | { kind: 'ready'; principalHash: string }
    | {
        kind: 'rejected';
        result: TaskCreationInfrastructureUnavailable | TaskCreationLookupRejectedWithoutSnapshot;
      }
  > {
    if (
      !isTaskCreationTicketAuthenticationContext(authentication) ||
      !request ||
      !isTaskCreationOperationId(request.operationId) ||
      !isTaskCreationOperationCapability(request.operationCapability)
    ) {
      return { kind: 'rejected', result: lookupRejected('invalid-request') };
    }
    if (!(await this.dependencies.authorization.authorize(authentication, action))) {
      return { kind: 'rejected', result: lookupRejected('capability-denied') };
    }
    const principalHash = hashPrincipal(authentication.workspacePrincipalId);
    if (!this.consumeLookup(principalHash)) {
      return { kind: 'rejected', result: lookupRejected('rate-limited') };
    }
    if (!isJournalReady(this.dependencies.journal)) {
      return { kind: 'rejected', result: journalUnavailable() };
    }
    return { kind: 'ready', principalHash };
  }

  private consumeLookup(principalHash: string): boolean {
    const now = this.readNow();
    refillBucket(this.lookupWorkspace, LOOKUP_WORKSPACE_CAPACITY, LOOKUP_WORKSPACE_REFILL_MS, now);
    if (this.lookupWorkspace.tokens < 1 || !this.lookupPrincipal.consume(principalHash)) {
      return false;
    }
    this.lookupWorkspace.tokens -= 1;
    return true;
  }

  private consumeCreateAdmission(principalHash: string): boolean {
    const now = this.readNow();
    refillBucket(this.createWorkspace, CREATE_WORKSPACE_CAPACITY, CREATE_WORKSPACE_REFILL_MS, now);
    if (this.createWorkspace.tokens < 1 || !this.createPrincipal.consume(principalHash)) {
      return false;
    }
    this.createWorkspace.tokens -= 1;
    return true;
  }

  private async requireSupportingCommandAdmission(
    authentication: TaskCreationTicketAuthenticationContext,
    action: TaskCreationWorkflowAction,
    consumeLookup: boolean,
  ): Promise<string> {
    if (
      !isTaskCreationTicketAuthenticationContext(authentication) ||
      !(await this.dependencies.authorization.authorize(authentication, action))
    ) {
      throw new Error('Task-creation command capability denied');
    }
    const owners = await this.dependencies.ownerCapability.getDeploymentCapability();
    if (owners.kind !== 'active') {
      throw new Error('Task-creation owner is unavailable');
    }
    const principalHash = hashPrincipal(authentication.workspacePrincipalId);
    if (consumeLookup && !this.consumeLookup(principalHash)) {
      throw new Error('Task-creation command is rate limited');
    }
    if (!isJournalReady(this.dependencies.journal)) {
      throw new TaskCreationJournalUnavailableError(
        'Task-creation operation journal is unavailable',
      );
    }
    return principalHash;
  }

  private committedRevision(record: TaskCreationJournalRecord): number {
    if (record.commit.kind !== 'committed') {
      throw new TaskCreationCurrentUnavailableError('Task creation is not committed');
    }
    return record.commit.workspaceRevision;
  }

  private wouldExceedJournalCapacity(record: TaskCreationJournalRecord): boolean {
    const counts = this.dependencies.journal.getCounts();
    return (
      counts.records >= TASK_CREATION_JOURNAL_RECORD_LIMIT ||
      counts.chargedBytes + getTaskCreationJournalRecordCharge(record) >
        TASK_CREATION_JOURNAL_MAX_CHARGED_BYTES
    );
  }

  private isCapacityError(error: unknown): boolean {
    return error instanceof Error && /capacity|record count|charged bytes/iu.test(error.message);
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Task-creation clock is invalid');
    return now;
  }
}

export function createTaskCreationWorkflow(
  dependencies: TaskCreationWorkflowDependencies,
): ActiveTaskCreationWorkflow {
  return new TaskCreationWorkflowImpl(dependencies);
}
