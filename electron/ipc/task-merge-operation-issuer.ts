import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  isTerminalTaskMergePhase,
  isTaskMergeOperationSnapshot,
  normalizeMergeProgressInteger,
  type IssuedTaskMergeOperation,
  type MergeProgressSnapshot,
  type TaskMergeIssue,
  type TaskMergeOperationAccess,
  type TaskMergeOperationSnapshot,
  type TaskMergePhase,
  type TaskMergeSemanticRequest,
} from '../../src/domain/task-merge.js';
import {
  isTaskCreationOperationLink,
  isTaskCreationProvenance,
  isTaskInitialShellOwnership,
} from '../../src/domain/task-creation-provenance.js';
import {
  activateProtectedPolicies,
  changed,
  getProtectedPolicyVersions,
  unchanged,
  type WorkspacePrivateMutationAuthority,
} from './workspace-state-mutations.js';
import {
  canonicalJsonStringify,
  cloneJsonObject,
  type JsonObject,
  type JsonValue,
} from './workspace-state-storage.js';
import { readMergeProgressSnapshot } from './merge-progress.js';

const OWNER_SCHEMA_KEY = 'taskMergeOwnerSchema';
const OPERATIONS_KEY = 'taskMergeOperations';
const JOURNAL_SCHEMA_VERSION = 1 as const;
const OWNER_SCHEMA_VERSION = 1 as const;
const FIRST_ADMISSION_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_OPERATION_RECORDS = 4_096;
const MAX_NONTERMINAL_RECORDS = 256;
const MAX_RECORD_BYTES = 64 * 1_024;
const MAX_JOURNAL_BYTES = 16 * 1_024 * 1_024;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export type TaskMergeOwnerPhase = 'preparing' | 'active';

interface TaskMergeOwnerSchema {
  cutoverEpoch: string;
  legacyWritersDisabled: boolean;
  phase: TaskMergeOwnerPhase;
  schemaVersion: typeof OWNER_SCHEMA_VERSION;
}

export interface TaskMergeOwnerCutoverState {
  cutoverEpoch: string;
  legacyWritersDisabled: boolean;
  phase: TaskMergeOwnerPhase;
  schemaVersion: typeof OWNER_SCHEMA_VERSION;
}

export interface TaskMergeOperationRecord {
  capabilityHash: string;
  cleanupRequested: boolean;
  committedAt?: string;
  counted: boolean;
  fingerprint?: string;
  firstAdmissionExpiresAt: number;
  gitMerged: boolean;
  issue?: TaskMergeIssue;
  issuedAt: number;
  linesAdded?: number;
  linesRemoved?: number;
  operationId: string;
  phase: TaskMergePhase;
  principalHash: string;
  progressVersionAtOutcome?: number;
  recordVersion: number;
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  targetFingerprint?: string;
  taskId: string;
  taskReleased: boolean;
}

interface TaskMergeOperationJournalState {
  activeOperationIdByPrincipalTaskKey: Record<string, string>;
  recordsByOperationId: Record<string, TaskMergeOperationRecord>;
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
}

export interface TaskMergeLegacyWriterCutover {
  disableLegacyMergeWriters(cutoverEpoch: string): Promise<void>;
  verifyLegacyMergeWritersDisabled(cutoverEpoch: string): Promise<void>;
}

export interface TaskMergeOwnerCapability {
  cutoverEpoch: string;
  kind: 'active';
  schemaVersion: typeof OWNER_SCHEMA_VERSION;
}

export interface CanonicalTaskMergeTarget {
  baseBranch?: string;
  branchName: string;
  cleanupAllowed: boolean;
  projectRoot: string;
  targetFingerprint: string;
  worktreePath: string;
}

export interface TaskMergeOperationIssuerOptions {
  createCutoverEpoch?: () => string;
  createOperationAccess?: () => TaskMergeOperationAccess;
  now?: () => number;
}

export class TaskMergeOwnerCutoverError extends Error {
  readonly code = 'task-merge-owner-cutover-required';
}

export class TaskMergeOperationAccessError extends Error {
  readonly code = 'task-merge-operation-unavailable';
}

export class TaskMergeOperationConflictError extends Error {
  readonly code = 'task-merge-operation-conflict';
}

export class TaskMergeOperationCapacityError extends Error {
  readonly code = 'task-merge-operation-capacity';
}

export class TaskMergeOperationRecoveryError extends Error {
  readonly code = 'task-merge-operation-recovery-required';
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isIdentifier(value: unknown, maxBytes = 512): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    !value.includes('\u0000')
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function hashDomainValue(domain: string, value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return createHash('sha256')
    .update(`parallel-code:${domain}:v1\u0000`, 'utf8')
    .update(length)
    .update(bytes)
    .digest('hex');
}

function principalHash(principalId: string): string {
  if (!isIdentifier(principalId, 1_024)) {
    throw new TaskMergeOperationAccessError('Merge principal is unavailable');
  }
  return hashDomainValue('task-merge-principal', principalId);
}

function principalTaskKey(principal: string, taskId: string): string {
  return hashDomainValue('task-merge-principal-task', `${principal}\u0000${taskId}`);
}

function capabilityHash(capability: string): string {
  if (!isIdentifier(capability, 64)) {
    throw new TaskMergeOperationAccessError('Merge operation is unavailable');
  }
  return hashDomainValue('task-merge-capability', capability);
}

function constantTimeDigestEqual(left: string, right: string): boolean {
  if (!DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function createOperationAccess(): TaskMergeOperationAccess {
  return {
    operationCapability: randomBytes(32).toString('base64url'),
    operationId: `task-merge-v1:${randomBytes(16).toString('base64url')}`,
  };
}

function createEmptyJournal(): TaskMergeOperationJournalState {
  return {
    activeOperationIdByPrincipalTaskKey: {},
    recordsByOperationId: {},
    schemaVersion: JOURNAL_SCHEMA_VERSION,
  };
}

function toSnapshot(record: TaskMergeOperationRecord): TaskMergeOperationSnapshot {
  return {
    cleanupRequested: record.cleanupRequested,
    counted: record.counted,
    gitMerged: record.gitMerged,
    ...(record.issue ? { issue: structuredClone(record.issue) } : {}),
    ...(record.linesAdded !== undefined ? { linesAdded: record.linesAdded } : {}),
    ...(record.linesRemoved !== undefined ? { linesRemoved: record.linesRemoved } : {}),
    operationId: record.operationId,
    phase: record.phase,
    ...(record.progressVersionAtOutcome !== undefined
      ? { progressVersionAtOutcome: record.progressVersionAtOutcome }
      : {}),
    taskId: record.taskId,
    taskReleased: record.taskReleased,
    version: record.recordVersion,
  };
}

function isOperationRecord(value: JsonObject, operationId: string): boolean {
  if (
    !hasOnlyKeys(value, [
      'capabilityHash',
      'cleanupRequested',
      'committedAt',
      'counted',
      'fingerprint',
      'firstAdmissionExpiresAt',
      'gitMerged',
      'issue',
      'issuedAt',
      'linesAdded',
      'linesRemoved',
      'operationId',
      'phase',
      'principalHash',
      'progressVersionAtOutcome',
      'recordVersion',
      'schemaVersion',
      'targetFingerprint',
      'taskId',
      'taskReleased',
    ]) ||
    value.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    value.operationId !== operationId ||
    !isIdentifier(value.operationId, 128) ||
    !isIdentifier(value.taskId) ||
    typeof value.phase !== 'string' ||
    !DIGEST_PATTERN.test(String(value.capabilityHash)) ||
    !DIGEST_PATTERN.test(String(value.principalHash)) ||
    !isNonNegativeSafeInteger(value.issuedAt) ||
    !isNonNegativeSafeInteger(value.firstAdmissionExpiresAt) ||
    value.firstAdmissionExpiresAt < value.issuedAt ||
    !isNonNegativeSafeInteger(value.recordVersion) ||
    value.recordVersion < 1 ||
    typeof value.cleanupRequested !== 'boolean' ||
    typeof value.gitMerged !== 'boolean' ||
    typeof value.taskReleased !== 'boolean' ||
    typeof value.counted !== 'boolean' ||
    (value.fingerprint !== undefined && !DIGEST_PATTERN.test(String(value.fingerprint))) ||
    (value.targetFingerprint !== undefined &&
      !DIGEST_PATTERN.test(String(value.targetFingerprint))) ||
    (value.committedAt !== undefined && !isCanonicalTimestamp(value.committedAt)) ||
    (value.linesAdded !== undefined && !isNonNegativeSafeInteger(value.linesAdded)) ||
    (value.linesRemoved !== undefined && !isNonNegativeSafeInteger(value.linesRemoved)) ||
    (value.progressVersionAtOutcome !== undefined &&
      !isNonNegativeSafeInteger(value.progressVersionAtOutcome))
  ) {
    return false;
  }
  try {
    const snapshot = toSnapshot(value as unknown as TaskMergeOperationRecord);
    if (!isTaskMergeOperationSnapshot(snapshot)) return false;
  } catch {
    return false;
  }
  const phase = value.phase as TaskMergePhase;
  const admitted =
    phase !== 'issued' && phase !== 'expired-unused' && phase !== 'superseded-unused';
  const mergeSucceeded =
    phase === 'merged-awaiting-removal' ||
    phase === 'completed' ||
    phase === 'completed-not-counted';
  return (
    admitted ===
      (typeof value.fingerprint === 'string' && typeof value.targetFingerprint === 'string') &&
    mergeSucceeded ===
      (typeof value.committedAt === 'string' &&
        value.linesAdded !== undefined &&
        value.linesRemoved !== undefined) &&
    (phase === 'failed' || phase === 'manual-reconciliation-required') ===
      (value.issue !== undefined) &&
    (phase === 'completed') === (value.progressVersionAtOutcome !== undefined)
  );
}

function readOwnerSchema(privateState: JsonObject): TaskMergeOwnerSchema | null {
  const value = privateState[OWNER_SCHEMA_KEY];
  if (value === undefined) return null;
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ['cutoverEpoch', 'legacyWritersDisabled', 'phase', 'schemaVersion']) ||
    value.schemaVersion !== OWNER_SCHEMA_VERSION ||
    !isIdentifier(value.cutoverEpoch) ||
    (value.phase !== 'preparing' && value.phase !== 'active') ||
    typeof value.legacyWritersDisabled !== 'boolean' ||
    (value.phase === 'active') !== value.legacyWritersDisabled
  ) {
    throw new TaskMergeOperationRecoveryError('Task merge owner schema is invalid');
  }
  return {
    cutoverEpoch: value.cutoverEpoch,
    legacyWritersDisabled: value.legacyWritersDisabled,
    phase: value.phase,
    schemaVersion: OWNER_SCHEMA_VERSION,
  };
}

/**
 * Narrow read surface used by the legacy-writer gate. The merge owner keeps the
 * private schema codec; callers can only distinguish an absent cutover from a
 * validated preparing/active one.
 */
export function readTaskMergeOwnerCutoverState(
  privateState: JsonObject,
): TaskMergeOwnerCutoverState | null {
  const schema = readOwnerSchema(privateState);
  return schema ? { ...schema } : null;
}

function readJournal(privateState: JsonObject): TaskMergeOperationJournalState {
  const value = privateState[OPERATIONS_KEY];
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, [
      'activeOperationIdByPrincipalTaskKey',
      'recordsByOperationId',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    !isJsonObject(value.activeOperationIdByPrincipalTaskKey) ||
    !isJsonObject(value.recordsByOperationId)
  ) {
    throw new TaskMergeOperationRecoveryError('Task merge operation journal is invalid');
  }
  const recordsByOperationId: Record<string, TaskMergeOperationRecord> = {};
  const entries = Object.entries(value.recordsByOperationId);
  if (entries.length > MAX_OPERATION_RECORDS) {
    throw new TaskMergeOperationRecoveryError('Task merge operation journal exceeds its bound');
  }
  for (const [operationId, recordValue] of entries) {
    if (
      !isJsonObject(recordValue) ||
      !isOperationRecord(recordValue, operationId) ||
      Buffer.byteLength(canonicalJsonStringify(recordValue), 'utf8') > MAX_RECORD_BYTES
    ) {
      throw new TaskMergeOperationRecoveryError(`Task merge operation ${operationId} is invalid`);
    }
    recordsByOperationId[operationId] = structuredClone(
      recordValue,
    ) as unknown as TaskMergeOperationRecord;
  }
  const activeOperationIdByPrincipalTaskKey: Record<string, string> = {};
  for (const [key, operationIdValue] of Object.entries(value.activeOperationIdByPrincipalTaskKey)) {
    if (!DIGEST_PATTERN.test(key) || typeof operationIdValue !== 'string') {
      throw new TaskMergeOperationRecoveryError('Task merge operation index is invalid');
    }
    const record = recordsByOperationId[operationIdValue];
    if (
      !record ||
      isTerminalTaskMergePhase(record.phase) ||
      principalTaskKey(record.principalHash, record.taskId) !== key
    ) {
      throw new TaskMergeOperationRecoveryError('Task merge operation index is inconsistent');
    }
    activeOperationIdByPrincipalTaskKey[key] = operationIdValue;
  }
  for (const record of Object.values(recordsByOperationId)) {
    if (
      !isTerminalTaskMergePhase(record.phase) &&
      activeOperationIdByPrincipalTaskKey[principalTaskKey(record.principalHash, record.taskId)] !==
        record.operationId
    ) {
      throw new TaskMergeOperationRecoveryError(
        `Task merge operation ${record.operationId} is not indexed`,
      );
    }
  }
  return {
    activeOperationIdByPrincipalTaskKey,
    recordsByOperationId,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
  };
}

function validateJournalCapacity(journal: TaskMergeOperationJournalState): void {
  const records = Object.values(journal.recordsByOperationId);
  if (
    records.length > MAX_OPERATION_RECORDS ||
    records.filter((record) => !isTerminalTaskMergePhase(record.phase)).length >
      MAX_NONTERMINAL_RECORDS ||
    Buffer.byteLength(canonicalJsonStringify(journal as unknown as JsonObject), 'utf8') >
      MAX_JOURNAL_BYTES
  ) {
    throw new TaskMergeOperationCapacityError('Task merge operation capacity is exhausted');
  }
}

function validateIssueCapacityBeforeRandom(journal: TaskMergeOperationJournalState): void {
  const records = Object.values(journal.recordsByOperationId);
  const projectedNonterminal =
    records.filter((record) => !isTerminalTaskMergePhase(record.phase)).length + 1;
  if (
    records.length >= MAX_OPERATION_RECORDS ||
    projectedNonterminal > MAX_NONTERMINAL_RECORDS ||
    Buffer.byteLength(canonicalJsonStringify(journal as unknown as JsonObject), 'utf8') +
      MAX_RECORD_BYTES >
      MAX_JOURNAL_BYTES
  ) {
    throw new TaskMergeOperationCapacityError('Task merge operation capacity is exhausted');
  }
}

function withOwnerState(
  privateState: JsonObject,
  schema: TaskMergeOwnerSchema,
  journal: TaskMergeOperationJournalState,
): JsonObject {
  validateJournalCapacity(journal);
  return {
    ...cloneJsonObject(privateState),
    [OPERATIONS_KEY]: journal as unknown as JsonObject,
    [OWNER_SCHEMA_KEY]: schema as unknown as JsonObject,
  };
}

function requireTasks(sharedState: JsonObject): JsonObject {
  const tasks = sharedState.tasks;
  if (!isJsonObject(tasks)) {
    throw new TaskMergeOperationRecoveryError('Canonical tasks are invalid');
  }
  return tasks;
}

function readCanonicalTarget(sharedState: JsonObject, taskId: string): CanonicalTaskMergeTarget {
  const task = requireTasks(sharedState)[taskId];
  if (!isJsonObject(task)) {
    throw new TaskMergeOperationConflictError(`Task ${taskId} is not current`);
  }
  if (task.projectMode === 'non-git' || task.gitIsolation === 'current-branch') {
    throw new TaskMergeOperationConflictError(`Task ${taskId} is not eligible for task merge`);
  }
  if (
    !isTaskCreationProvenance(task.taskCreationProvenance) ||
    !isTaskInitialShellOwnership(task.taskInitialShellOwnership) ||
    !isTaskCreationOperationLink(task.taskCreationOperationLink)
  ) {
    throw new TaskMergeOperationRecoveryError(
      `Task ${taskId} managed creation evidence is invalid`,
    );
  }
  const historicalTask = task.taskCreationProvenance.creationWriterEpoch === 'pre-managed-v1';
  const terminalTask = task.taskMode === 'terminal';
  const agentTask = task.taskMode === 'agent';
  if (
    (!terminalTask && !agentTask) ||
    (historicalTask && task.taskCreationOperationLink.kind !== 'pre-operation-journal') ||
    (!historicalTask && task.taskCreationOperationLink.kind !== 'creation-v1') ||
    (terminalTask &&
      task.taskInitialShellOwnership.kind !==
        (historicalTask ? 'legacy-unmanaged-terminal' : 'managed-terminal-v1')) ||
    (agentTask && task.taskInitialShellOwnership.kind !== 'not-applicable-agent')
  ) {
    throw new TaskMergeOperationRecoveryError(
      `Task ${taskId} managed creation evidence is contradictory`,
    );
  }
  const projectId = task.projectId;
  const projects = sharedState.projects;
  if (
    typeof projectId !== 'string' ||
    !Array.isArray(projects) ||
    projects.some((project) => !isJsonObject(project))
  ) {
    throw new TaskMergeOperationRecoveryError('Canonical merge project state is invalid');
  }
  const project = (projects as JsonObject[]).find((candidate) => candidate.id === projectId);
  if (!project || typeof project.path !== 'string') {
    throw new TaskMergeOperationConflictError(`Task ${taskId} project is not current`);
  }
  if (
    typeof task.branchName !== 'string' ||
    typeof task.worktreePath !== 'string' ||
    task.branchName.length === 0 ||
    task.worktreePath.length === 0
  ) {
    throw new TaskMergeOperationRecoveryError('Canonical merge target is invalid');
  }
  const identity = {
    baseBranch: typeof task.baseBranch === 'string' ? task.baseBranch : null,
    branchName: task.branchName,
    cleanupAllowed:
      (task.gitIsolation === undefined || task.gitIsolation === 'worktree') &&
      task.worktreeOwnership !== 'external',
    creationOperationLink: task.taskCreationOperationLink,
    creationProvenance: task.taskCreationProvenance,
    gitIsolation: task.gitIsolation ?? 'worktree',
    projectId,
    projectRoot: project.path,
    taskId,
    taskInitialShellOwnership: task.taskInitialShellOwnership,
    worktreeOwnership: task.worktreeOwnership ?? 'managed',
    worktreePath: task.worktreePath,
  } satisfies JsonObject;
  return {
    ...(typeof task.baseBranch === 'string' ? { baseBranch: task.baseBranch } : {}),
    branchName: task.branchName,
    cleanupAllowed: identity.cleanupAllowed,
    projectRoot: project.path,
    targetFingerprint: createHash('sha256')
      .update(canonicalJsonStringify(identity), 'utf8')
      .digest('hex'),
    worktreePath: task.worktreePath,
  };
}

export function createTaskMergeSemanticFingerprint(request: TaskMergeSemanticRequest): string {
  if (
    !isIdentifier(request.taskId) ||
    typeof request.cleanup !== 'boolean' ||
    typeof request.squash !== 'boolean' ||
    (request.message !== undefined &&
      (typeof request.message !== 'string' ||
        Buffer.byteLength(request.message, 'utf8') > 64 * 1_024))
  ) {
    throw new TaskMergeOperationConflictError('Merge request is invalid');
  }
  const messageHash =
    request.message === undefined ? null : hashDomainValue('task-merge-message', request.message);
  return createHash('sha256')
    .update(
      canonicalJsonStringify({
        cleanup: request.cleanup,
        messageHash,
        squash: request.squash,
        taskId: request.taskId,
      }),
      'utf8',
    )
    .digest('hex');
}

function cloneRecord(record: TaskMergeOperationRecord): TaskMergeOperationRecord {
  return structuredClone(record);
}

function isAdmissionTransitionResult(value: unknown): value is {
  kind: 'admitted' | 'expired';
  record: TaskMergeOperationRecord;
} {
  return (
    value !== null &&
    typeof value === 'object' &&
    'record' in value &&
    'kind' in value &&
    (value.kind === 'admitted' || value.kind === 'expired')
  );
}

function incrementRecordVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER) {
    throw new TaskMergeOperationRecoveryError('Task merge operation version overflow');
  }
  return version + 1;
}

export class TaskMergeOperationIssuer {
  private readonly createCutoverEpoch: () => string;
  private readonly createAccess: () => TaskMergeOperationAccess;
  private readonly now: () => number;
  private capability: TaskMergeOwnerCapability | null = null;
  private activationPromise: Promise<TaskMergeOwnerCapability> | null = null;

  constructor(
    private readonly authority: WorkspacePrivateMutationAuthority,
    options: TaskMergeOperationIssuerOptions = {},
  ) {
    this.createCutoverEpoch =
      options.createCutoverEpoch ??
      (() => `task-merge-owner-v1:${randomBytes(16).toString('base64url')}`);
    this.createAccess = options.createOperationAccess ?? createOperationAccess;
    this.now = options.now ?? Date.now;
  }

  activate(cutover: TaskMergeLegacyWriterCutover): Promise<TaskMergeOwnerCapability> {
    this.activationPromise ??= this.runActivation(cutover).catch((error: unknown) => {
      this.activationPromise = null;
      this.capability = null;
      throw error;
    });
    return this.activationPromise;
  }

  getCapability(): TaskMergeOwnerCapability | null {
    return this.capability ? { ...this.capability } : null;
  }

  async issue(request: { principalId: string; taskId: string }): Promise<IssuedTaskMergeOperation> {
    this.requireActive();
    if (!isIdentifier(request.taskId)) {
      throw new TaskMergeOperationConflictError('Task ID is invalid');
    }
    const hashedPrincipal = principalHash(request.principalId);
    const now = this.now();
    if (!isNonNegativeSafeInteger(now)) {
      throw new TaskMergeOperationRecoveryError('Task merge clock is invalid');
    }
    const result = await this.authority.mutate<IssuedTaskMergeOperation>(
      { operation: 'issue-task-merge-operation' },
      (slices) => {
        const { journal, schema } = this.requireDurablyActive(slices.privateState);
        if (requireTasks(slices.sharedState)[request.taskId] === undefined) {
          throw new TaskMergeOperationConflictError(`Task ${request.taskId} is not current`);
        }
        const key = principalTaskKey(hashedPrincipal, request.taskId);
        const previousId = journal.activeOperationIdByPrincipalTaskKey[key];
        const previous = previousId ? journal.recordsByOperationId[previousId] : undefined;
        if (previous && previous.phase !== 'issued') {
          throw new TaskMergeOperationConflictError(
            `Task ${request.taskId} already has an active merge operation`,
          );
        }
        if (previous) {
          journal.recordsByOperationId[previous.operationId] = {
            ...previous,
            phase: 'superseded-unused',
            recordVersion: incrementRecordVersion(previous.recordVersion),
          };
        }
        validateIssueCapacityBeforeRandom(journal);
        const access = this.createAccess();
        if (
          !isIdentifier(access.operationId, 128) ||
          !isIdentifier(access.operationCapability, 64) ||
          journal.recordsByOperationId[access.operationId]
        ) {
          throw new TaskMergeOperationRecoveryError('Generated merge operation access is invalid');
        }
        if (now > Number.MAX_SAFE_INTEGER - FIRST_ADMISSION_LIFETIME_MS) {
          throw new TaskMergeOperationRecoveryError('Task merge expiry overflows');
        }
        const record: TaskMergeOperationRecord = {
          capabilityHash: capabilityHash(access.operationCapability),
          cleanupRequested: false,
          counted: false,
          firstAdmissionExpiresAt: now + FIRST_ADMISSION_LIFETIME_MS,
          gitMerged: false,
          issuedAt: now,
          operationId: access.operationId,
          phase: 'issued',
          principalHash: hashedPrincipal,
          recordVersion: 1,
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          taskId: request.taskId,
          taskReleased: false,
        };
        journal.recordsByOperationId[record.operationId] = record;
        journal.activeOperationIdByPrincipalTaskKey[key] = record.operationId;
        return changed(
          { nextPrivateState: withOwnerState(slices.privateState, schema, journal) },
          {
            ...access,
            firstAdmissionExpiresAt: record.firstAdmissionExpiresAt,
            issuedAt: record.issuedAt,
          },
        );
      },
    );
    return result.result;
  }

  async getAuthorizedRecord(
    principalId: string,
    access: TaskMergeOperationAccess,
  ): Promise<TaskMergeOperationRecord> {
    this.requireActive();
    const hashedPrincipal = principalHash(principalId);
    const hashedCapability = capabilityHash(access.operationCapability);
    if (!isIdentifier(access.operationId, 128)) {
      throw new TaskMergeOperationAccessError('Merge operation is unavailable');
    }
    const result = await this.authority.mutate<TaskMergeOperationRecord>(
      { operation: 'read-task-merge-operation' },
      (slices) => {
        const { journal } = this.requireDurablyActive(slices.privateState);
        const record = journal.recordsByOperationId[access.operationId];
        if (
          !record ||
          !constantTimeDigestEqual(record.principalHash, hashedPrincipal) ||
          !constantTimeDigestEqual(record.capabilityHash, hashedCapability)
        ) {
          throw new TaskMergeOperationAccessError('Merge operation is unavailable');
        }
        return unchanged(cloneRecord(record));
      },
    );
    return result.result;
  }

  async resolveCanonicalTarget(taskId: string): Promise<CanonicalTaskMergeTarget> {
    this.requireActive();
    const result = await this.authority.mutate<CanonicalTaskMergeTarget>(
      { operation: 'resolve-canonical-task-merge-target' },
      (slices) => {
        this.requireDurablyActive(slices.privateState);
        return unchanged(readCanonicalTarget(slices.sharedState, taskId));
      },
    );
    return result.result;
  }

  admit(
    principalId: string,
    access: TaskMergeOperationAccess,
    request: TaskMergeSemanticRequest,
    targetFingerprint: string,
  ): Promise<{ kind: 'admitted' | 'expired'; record: TaskMergeOperationRecord }> {
    const fingerprint = createTaskMergeSemanticFingerprint(request);
    return this.mutateAuthorized(
      principalId,
      access,
      (current): { kind: 'admitted' | 'expired'; record: TaskMergeOperationRecord } => {
        if (current.taskId !== request.taskId) {
          throw new TaskMergeOperationConflictError('Merge task identity changed');
        }
        if (current.phase !== 'issued') {
          this.assertFingerprint(current, fingerprint);
          if (current.targetFingerprint !== targetFingerprint) {
            throw new TaskMergeOperationConflictError('Canonical merge target changed');
          }
          return { kind: 'admitted', record: current };
        }
        if (this.now() > current.firstAdmissionExpiresAt) {
          return {
            kind: 'expired',
            record: {
              ...current,
              phase: 'expired-unused',
              recordVersion: incrementRecordVersion(current.recordVersion),
            },
          };
        }
        return {
          kind: 'admitted',
          record: {
            ...current,
            cleanupRequested: request.cleanup,
            fingerprint,
            phase: 'admitted',
            recordVersion: incrementRecordVersion(current.recordVersion),
            targetFingerprint,
          },
        };
      },
    );
  }

  markMerging(
    principalId: string,
    access: TaskMergeOperationAccess,
  ): Promise<TaskMergeOperationRecord> {
    return this.mutateAuthorized(principalId, access, (current) => {
      if (current.phase === 'merging') return current;
      if (current.phase !== 'admitted') {
        throw new TaskMergeOperationConflictError('Merge operation cannot begin Git');
      }
      return {
        ...current,
        phase: 'merging',
        recordVersion: incrementRecordVersion(current.recordVersion),
      };
    });
  }

  recordGitSuccess(
    principalId: string,
    access: TaskMergeOperationAccess,
    result: { committedAt: Date; linesAdded: unknown; linesRemoved: unknown },
  ): Promise<TaskMergeOperationRecord> {
    if (!Number.isFinite(result.committedAt.getTime())) {
      throw new TaskMergeOperationRecoveryError('Merge completion time is invalid');
    }
    const committedAt = result.committedAt.toISOString();
    const linesAdded = normalizeMergeProgressInteger(result.linesAdded);
    const linesRemoved = normalizeMergeProgressInteger(result.linesRemoved);
    return this.mutateAuthorized(principalId, access, (current) => {
      if (
        current.phase === 'merged-awaiting-removal' ||
        current.phase === 'completed-not-counted'
      ) {
        if (
          current.committedAt !== committedAt ||
          current.linesAdded !== linesAdded ||
          current.linesRemoved !== linesRemoved
        ) {
          throw new TaskMergeOperationRecoveryError('Git merge result changed across retry');
        }
        return current;
      }
      if (current.phase !== 'merging') {
        throw new TaskMergeOperationConflictError('Merge operation is not executing Git');
      }
      return {
        ...current,
        committedAt,
        gitMerged: true,
        linesAdded,
        linesRemoved,
        phase: current.cleanupRequested ? 'merged-awaiting-removal' : 'completed-not-counted',
        recordVersion: incrementRecordVersion(current.recordVersion),
      };
    });
  }

  recordFailure(
    principalId: string,
    access: TaskMergeOperationAccess,
    issue: Exclude<TaskMergeIssue, { code: 'git-outcome-ambiguous' }>,
  ): Promise<TaskMergeOperationRecord> {
    return this.mutateAuthorized(principalId, access, (current) => {
      if (current.phase === 'failed') return current;
      if (current.gitMerged || (current.phase !== 'admitted' && current.phase !== 'merging')) {
        throw new TaskMergeOperationConflictError('Merge operation cannot transition to failed');
      }
      return {
        ...current,
        issue,
        phase: 'failed',
        recordVersion: incrementRecordVersion(current.recordVersion),
      };
    });
  }

  recordGitOutcomeAmbiguous(
    principalId: string,
    access: TaskMergeOperationAccess,
  ): Promise<TaskMergeOperationRecord> {
    return this.mutateAuthorized(principalId, access, (current) => {
      if (current.phase === 'manual-reconciliation-required') return current;
      if (current.phase !== 'merging') {
        throw new TaskMergeOperationConflictError('Merge operation has no ambiguous Git attempt');
      }
      return {
        ...current,
        issue: {
          code: 'git-outcome-ambiguous',
          recovery: {
            allowedActions: ['recheck-evidence'],
            kind: 'local-operator-reconciliation',
          },
        },
        phase: 'manual-reconciliation-required',
        recordVersion: incrementRecordVersion(current.recordVersion),
      };
    });
  }

  async recordRemovalCommitted(
    principalId: string,
    access: TaskMergeOperationAccess,
    evidence: { progressVersionAtOutcome: number },
  ): Promise<TaskMergeOperationRecord> {
    this.requireActive();
    if (!isNonNegativeSafeInteger(evidence.progressVersionAtOutcome)) {
      throw new TaskMergeOperationRecoveryError('Merge removal evidence is invalid');
    }
    const hashedPrincipal = principalHash(principalId);
    const hashedCapability = capabilityHash(access.operationCapability);
    if (!isIdentifier(access.operationId, 128)) {
      throw new TaskMergeOperationAccessError('Merge operation is unavailable');
    }
    const result = await this.authority.mutate<TaskMergeOperationRecord>(
      { operation: 'complete-task-merge-operation' },
      (slices) => {
        const { journal, schema } = this.requireDurablyActive(slices.privateState);
        const current = this.requireAuthorizedRecord(
          journal,
          access.operationId,
          hashedPrincipal,
          hashedCapability,
        );
        if (current.phase === 'completed') {
          if (current.progressVersionAtOutcome !== evidence.progressVersionAtOutcome) {
            throw new TaskMergeOperationRecoveryError('Merge removal evidence changed');
          }
          return unchanged(cloneRecord(current));
        }
        if (current.phase !== 'merged-awaiting-removal') {
          throw new TaskMergeOperationConflictError('Merge removal is not awaiting commit');
        }
        if (requireTasks(slices.sharedState)[current.taskId] !== undefined) {
          throw new TaskMergeOperationRecoveryError('Canonical merged task is still present');
        }
        const progress = readMergeProgressSnapshot(slices.sharedState, new Date(this.now()));
        if (progress.version < evidence.progressVersionAtOutcome) {
          throw new TaskMergeOperationRecoveryError('Canonical merge progress regressed');
        }
        const next: TaskMergeOperationRecord = {
          ...current,
          counted: true,
          phase: 'completed',
          progressVersionAtOutcome: evidence.progressVersionAtOutcome,
          recordVersion: incrementRecordVersion(current.recordVersion),
          taskReleased: true,
        };
        journal.recordsByOperationId[next.operationId] = next;
        Reflect.deleteProperty(
          journal.activeOperationIdByPrincipalTaskKey,
          principalTaskKey(next.principalHash, next.taskId),
        );
        return changed(
          { nextPrivateState: withOwnerState(slices.privateState, schema, journal) },
          cloneRecord(next),
        );
      },
    );
    return result.result;
  }

  readCurrentProgress(): Promise<MergeProgressSnapshot> {
    this.requireActive();
    return this.authority
      .mutate<MergeProgressSnapshot>({ operation: 'read-current-merge-progress' }, (slices) => {
        this.requireDurablyActive(slices.privateState);
        return unchanged(readMergeProgressSnapshot(slices.sharedState, new Date(this.now())));
      })
      .then((result) => result.result);
  }

  snapshot(record: TaskMergeOperationRecord): TaskMergeOperationSnapshot {
    return toSnapshot(record);
  }

  assertSemanticRequest(record: TaskMergeOperationRecord, request: TaskMergeSemanticRequest): void {
    if (record.taskId !== request.taskId) {
      throw new TaskMergeOperationConflictError('Merge task identity changed');
    }
    this.assertFingerprint(record, createTaskMergeSemanticFingerprint(request));
  }

  private async runActivation(
    cutover: TaskMergeLegacyWriterCutover,
  ): Promise<TaskMergeOwnerCapability> {
    const proposedEpoch = this.createCutoverEpoch();
    if (!isIdentifier(proposedEpoch)) {
      throw new TaskMergeOwnerCutoverError('Task merge cutover epoch is invalid');
    }
    const prepared = await this.authority.mutate<TaskMergeOwnerSchema>(
      { operation: 'prepare-task-merge-owner-cutover' },
      (slices) => {
        const existing = readOwnerSchema(slices.privateState);
        if (existing) {
          readJournal(slices.privateState);
          return unchanged(existing);
        }
        const schema: TaskMergeOwnerSchema = {
          cutoverEpoch: proposedEpoch,
          legacyWritersDisabled: false,
          phase: 'preparing',
          schemaVersion: OWNER_SCHEMA_VERSION,
        };
        return changed(
          {
            nextPrivateState: withOwnerState(slices.privateState, schema, createEmptyJournal()),
          },
          schema,
        );
      },
    );
    const epoch = prepared.result.cutoverEpoch;
    if (prepared.result.phase === 'preparing') {
      await cutover.disableLegacyMergeWriters(epoch);
    }
    await cutover.verifyLegacyMergeWritersDisabled(epoch);

    const activated = await this.authority.mutate<TaskMergeOwnerCapability>(
      { operation: 'activate-task-merge-owner-cutover' },
      (slices) => {
        const schema = readOwnerSchema(slices.privateState);
        if (!schema || schema.cutoverEpoch !== epoch) {
          throw new TaskMergeOperationRecoveryError('Task merge cutover epoch changed');
        }
        const journal = readJournal(slices.privateState);
        const policies = getProtectedPolicyVersions(slices.privateState);
        if (schema.phase === 'active') {
          if (policies['merge-progress'] !== '1') {
            throw new TaskMergeOperationRecoveryError(
              'Task merge owner is active without progress protection',
            );
          }
          readMergeProgressSnapshot(slices.sharedState, new Date(this.now()));
          return unchanged({
            cutoverEpoch: epoch,
            kind: 'active' as const,
            schemaVersion: OWNER_SCHEMA_VERSION,
          });
        }
        const progress = readMergeProgressSnapshot(slices.sharedState, new Date(this.now()));
        const nextShared = cloneJsonObject(slices.sharedState);
        nextShared.mergeProgress = progress as unknown as JsonObject;
        const nextSchema: TaskMergeOwnerSchema = {
          ...schema,
          legacyWritersDisabled: true,
          phase: 'active',
        };
        const nextPrivate = activateProtectedPolicies(
          withOwnerState(slices.privateState, nextSchema, journal),
          ['merge-progress'],
        );
        return changed(
          { nextPrivateState: nextPrivate, nextSharedState: nextShared },
          {
            cutoverEpoch: epoch,
            kind: 'active' as const,
            schemaVersion: OWNER_SCHEMA_VERSION,
          },
        );
      },
    );
    this.capability = activated.result;
    await this.recoverInterruptedMerges();
    return { ...activated.result };
  }

  private async recoverInterruptedMerges(): Promise<void> {
    await this.authority.mutate<undefined>(
      { operation: 'recover-interrupted-task-merge-operations' },
      (slices) => {
        const { journal, schema } = this.requireDurablyActive(slices.privateState);
        let changedJournal = false;
        for (const [operationId, record] of Object.entries(journal.recordsByOperationId)) {
          if (record.phase !== 'merging') continue;
          journal.recordsByOperationId[operationId] = {
            ...record,
            issue: {
              code: 'git-outcome-ambiguous',
              recovery: {
                allowedActions: ['recheck-evidence'],
                kind: 'local-operator-reconciliation',
              },
            },
            phase: 'manual-reconciliation-required',
            recordVersion: incrementRecordVersion(record.recordVersion),
          };
          changedJournal = true;
        }
        return changedJournal
          ? changed(
              { nextPrivateState: withOwnerState(slices.privateState, schema, journal) },
              undefined,
            )
          : unchanged(undefined);
      },
    );
  }

  private mutateAuthorized<
    TResult extends
      | TaskMergeOperationRecord
      | {
          kind: 'admitted' | 'expired';
          record: TaskMergeOperationRecord;
        },
  >(
    principalId: string,
    access: TaskMergeOperationAccess,
    transition: (current: TaskMergeOperationRecord) => TResult,
  ): Promise<TResult> {
    this.requireActive();
    const hashedPrincipal = principalHash(principalId);
    const hashedCapability = capabilityHash(access.operationCapability);
    if (!isIdentifier(access.operationId, 128)) {
      throw new TaskMergeOperationAccessError('Merge operation is unavailable');
    }
    return this.authority
      .mutate<TResult>({ operation: 'advance-task-merge-operation' }, (slices) => {
        const { journal, schema } = this.requireDurablyActive(slices.privateState);
        const current = this.requireAuthorizedRecord(
          journal,
          access.operationId,
          hashedPrincipal,
          hashedCapability,
        );
        const result = transition(cloneRecord(current));
        const next: TaskMergeOperationRecord = isAdmissionTransitionResult(result)
          ? result.record
          : (result as TaskMergeOperationRecord);
        if (next.operationId !== current.operationId || next.taskId !== current.taskId) {
          throw new TaskMergeOperationRecoveryError('Task merge operation identity changed');
        }
        if (next.recordVersion === current.recordVersion) return unchanged(result);
        if (next.recordVersion !== incrementRecordVersion(current.recordVersion)) {
          throw new TaskMergeOperationRecoveryError('Task merge operation version skipped');
        }
        const encoded = JSON.parse(JSON.stringify(next)) as JsonValue;
        if (!isJsonObject(encoded) || !isOperationRecord(encoded, next.operationId)) {
          throw new TaskMergeOperationRecoveryError('Task merge operation transition is invalid');
        }
        journal.recordsByOperationId[next.operationId] = cloneRecord(next);
        if (isTerminalTaskMergePhase(next.phase)) {
          Reflect.deleteProperty(
            journal.activeOperationIdByPrincipalTaskKey,
            principalTaskKey(next.principalHash, next.taskId),
          );
        }
        return changed(
          { nextPrivateState: withOwnerState(slices.privateState, schema, journal) },
          result,
        );
      })
      .then((result) => result.result);
  }

  private requireAuthorizedRecord(
    journal: TaskMergeOperationJournalState,
    operationId: string,
    hashedPrincipal: string,
    hashedCapability: string,
  ): TaskMergeOperationRecord {
    const record = journal.recordsByOperationId[operationId];
    if (
      !record ||
      !constantTimeDigestEqual(record.principalHash, hashedPrincipal) ||
      !constantTimeDigestEqual(record.capabilityHash, hashedCapability)
    ) {
      throw new TaskMergeOperationAccessError('Merge operation is unavailable');
    }
    return record;
  }

  private requireDurablyActive(privateState: JsonObject): {
    journal: TaskMergeOperationJournalState;
    schema: TaskMergeOwnerSchema;
  } {
    const schema = readOwnerSchema(privateState);
    if (
      !schema ||
      schema.phase !== 'active' ||
      !schema.legacyWritersDisabled ||
      getProtectedPolicyVersions(privateState)['merge-progress'] !== '1'
    ) {
      throw new TaskMergeOwnerCutoverError('Task merge owner is not durably active');
    }
    return { journal: readJournal(privateState), schema };
  }

  private requireActive(): void {
    if (!this.capability) {
      throw new TaskMergeOwnerCutoverError('Task merge owner is not active');
    }
  }

  private assertFingerprint(record: TaskMergeOperationRecord, fingerprint: string): void {
    if (!record.fingerprint || !constantTimeDigestEqual(record.fingerprint, fingerprint)) {
      throw new TaskMergeOperationConflictError('Merge request changed across retry');
    }
  }
}
