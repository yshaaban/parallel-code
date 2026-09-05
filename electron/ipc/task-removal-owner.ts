import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  TASK_REMOVAL_OWNER_SCHEMA_VERSION,
  TASK_REMOVAL_PARTICIPANT_IDS,
  type TaskRemovalIdentity,
  type TaskRemovalCleanupPlan,
  TASK_REMOVAL_CLEANUP_STEPS,
  type TaskRemovalCleanupStep,
  type TaskRemovalOwnerAvailability,
  type TaskRemovalOwnerCapability,
  type TaskRemovalMutationResult,
  type TaskRemovalParticipantGate,
  type TaskRemovalParticipantId,
  type TaskRemovalParticipantRequest,
} from '../../src/domain/task-removal-owner.js';
import type { TaskRemovalCurrentProjection } from '../../src/domain/task-catalog.js';
import type { TaskNotesStructuralAuthority } from './task-notes-service.js';
import {
  TaskRemovalNotesCoordination,
  type TaskRemovalNotesCoordinationOptions,
} from './task-removal-notes-coordination.js';
import {
  changed,
  getProtectedPolicyVersions,
  unchanged,
  type WorkspaceMutationRequest,
  type WorkspaceMutationResult,
  type WorkspacePrivateMutationAuthority,
} from './workspace-state-mutations.js';
import {
  canonicalJsonStringify,
  cloneJsonObject,
  type JsonObject,
  type JsonValue,
} from './workspace-state-storage.js';
import {
  isTaskCreationOperationLink,
  isTaskInitialShellOwnership,
} from '../../src/domain/task-creation-provenance.js';
import {
  COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION,
  commitCompletedMergeProgress,
} from './merge-progress.js';
import { normalizeMergeProgressInteger } from '../../src/domain/task-merge.js';
import { getManagedWorktreeRecoveryQuarantinePath } from './task-worktree-removal.js';

const OWNER_SCHEMA_KEY = 'taskRemovalOwnerSchema';
const OPERATIONS_KEY = 'taskRemovalOperations';
const PARTICIPANT_FINALIZER_ORDER = TASK_REMOVAL_PARTICIPANT_IDS;
const PARTICIPANT_CUTOVER_ORDER = Object.freeze([
  'initial-prompt',
  'agent-session',
  'task-runtime',
] as const satisfies readonly TaskRemovalParticipantId[]);
const TASK_REMOVAL_LIFECYCLE_LISTENER_LIMIT = 32;

type TaskRemovalCutoverPhase = 'preparing' | 'active';
type TaskRemovalOperationPhase =
  | 'reserved-awaiting-activation'
  | 'reserved-before-cleanup'
  | 'cleanup-complete-workspace-retry'
  | 'committed-finalizers-pending'
  | 'complete';

interface DurableMergeProgressCommitExtension {
  committedAt?: string;
  kind: typeof COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION;
  linesAdded?: number;
  linesRemoved?: number;
  progressVersionAtCommit?: number;
  state: 'awaiting-linked-proof' | 'linked-proof-ready';
}

interface TaskRemovalOwnerSchema {
  catalogVersion: number;
  cutoverEpoch: string;
  hookSetVersions: Record<TaskRemovalParticipantId, string>;
  legacyEffectsDisabled: boolean;
  phase: TaskRemovalCutoverPhase;
  schemaVersion: typeof TASK_REMOVAL_OWNER_SCHEMA_VERSION;
}

interface DurableTaskRemovalOperation {
  cleanupPlan: TaskRemovalCleanupPlan;
  cleanupStepEvidence: Partial<Record<TaskRemovalCleanupStep, JsonObject>>;
  completedCleanupSteps: TaskRemovalCleanupStep[];
  commitExtension?: DurableMergeProgressCommitExtension;
  deletionOperationId: string;
  pendingFinalizers: TaskRemovalParticipantId[];
  phase: TaskRemovalOperationPhase;
  recordVersion: number;
  cleanupComplete: boolean;
  schemaVersion: 1;
  taskClosing: boolean;
  taskId: string;
  workspaceRevision?: number;
}

interface TaskRemovalOperationState {
  deletionOperationIdByTaskId: Record<string, string>;
  recordsByDeletionOperationId: Record<string, DurableTaskRemovalOperation>;
  schemaVersion: 1;
}

export type TaskRemovalParticipantStepResult =
  | { kind: 'already-complete' | 'complete' }
  | { kind: 'retry-required'; reason?: string };

export type TaskRemovalParticipantProbeResult =
  | { hookSetVersion: string; kind: 'ready' }
  | { hookSetVersion: string; kind: 'unavailable'; reason: string };

export interface TaskRemovalCleanupStepRequest extends TaskRemovalParticipantRequest {
  completedSteps: readonly TaskRemovalCleanupStep[];
  evidence: Readonly<Partial<Record<TaskRemovalCleanupStep, JsonObject>>>;
  step: TaskRemovalCleanupStep;
}

export type TaskRemovalCleanupStepResult =
  | { evidence: JsonObject; kind: 'step-complete'; step: TaskRemovalCleanupStep }
  | { kind: 'retry-required'; reason?: string };

/**
 * Dark owner seam consumed by the cutover. The legacy-effect callbacks are
 * intentionally mandatory: journal readiness alone must never activate the
 * generic gate while an old prompt/session writer can still dispatch.
 */
export interface TaskRemovalOwnerParticipant {
  activateLegacyEffectCutover(cutoverEpoch: string): Promise<void>;
  drainTaskForRemoval(
    request: TaskRemovalParticipantRequest,
  ): Promise<TaskRemovalParticipantStepResult>;
  finalizeRemovedTaskState(
    request: TaskRemovalFinalizerRequest,
  ): Promise<TaskRemovalParticipantStepResult>;
  cleanupTaskRuntimeStep?(
    request: TaskRemovalCleanupStepRequest,
  ): Promise<TaskRemovalCleanupStepResult>;
  hookSetVersion: string;
  id: TaskRemovalParticipantId;
  probe(): Promise<TaskRemovalParticipantProbeResult>;
  verifyLegacyEffectCutover(cutoverEpoch: string): Promise<void>;
}

export interface TaskRemovalFinalizerRequest extends TaskRemovalParticipantRequest {
  removedWorkspaceRevision: number;
}

export interface VerifyTaskRemovalPreparationRequest {
  deletionOperationId: string;
  launchOperationId: string;
  preparedWorkspaceRevision: number;
  taskId: string;
  taskIdentityWitness: string;
}

export interface TaskRemovalOwnerOptions {
  createCutoverEpoch?: () => string;
  createDeletionOperationId?: () => string;
  taskNotes?: TaskRemovalNotesCoordinationOptions;
  serverInstanceId?: string;
}

export interface TaskRemovalLifecycleEvent {
  closing: boolean;
  taskId: string;
}

export interface ReserveLinkedTaskMergeRemovalRequest {
  activation: 'after-linked-merge-proof';
  commitExtensionKind: typeof COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION;
  deletionOperationId: string;
  taskId: string;
}

export interface ContinueLinkedTaskMergeRemovalRequest {
  committedAt: Date;
  deletionOperationId: string;
  linesAdded: unknown;
  linesRemoved: unknown;
  taskId: string;
}

export type ReserveLinkedTaskMergeRemovalResult =
  | { kind: 'reserved'; recordVersion: number }
  | { kind: 'already-reserved'; recordVersion: number }
  | { kind: 'operation-conflict' | 'task-not-current' };

/**
 * Narrow backend-only seam for D09. Callers select a fixed extension discriminator and supply no
 * cleanup, membership, transaction, or effect callback.
 */
export interface TaskMergeRemovalAuthority {
  abortBeforeLinkedProof(request: {
    deletionOperationId: string;
    taskId: string;
  }): Promise<'aborted' | 'already-absent'>;
  continueAfterLinkedProof(
    mutation: WorkspaceMutationRequest,
    request: ContinueLinkedTaskMergeRemovalRequest,
  ): Promise<WorkspaceMutationResult<TaskRemovalMutationResult>>;
  getStatus(request: {
    deletionOperationId: string;
    taskId: string;
  }): Promise<TaskRemovalMutationResult | null>;
  getCommittedMergeEvidence(request: {
    deletionOperationId: string;
    taskId: string;
  }): Promise<{ progressVersionAtCommit: number } | null>;
  reserve(
    request: ReserveLinkedTaskMergeRemovalRequest,
  ): Promise<ReserveLinkedTaskMergeRemovalResult>;
}

export class TaskRemovalOwnerCutoverError extends Error {
  readonly code = 'task-removal-owner-cutover-required';
}

export class TaskRemovalOwnerRecoveryError extends Error {
  readonly code = 'task-removal-owner-recovery-required';
}

export class TaskRemovalOwnerConflictError extends Error {
  readonly code = 'task-removal-operation-conflict';
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireIdentifier(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > 512) {
    throw new TaskRemovalOwnerRecoveryError(`${label} is invalid`);
  }
}

function isParticipantId(value: unknown): value is TaskRemovalParticipantId {
  return (TASK_REMOVAL_PARTICIPANT_IDS as readonly unknown[]).includes(value);
}

function hasOnlyKeys(value: JsonObject, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function readHookSetVersions(
  value: JsonValue | undefined,
): Record<TaskRemovalParticipantId, string> {
  if (!isJsonObject(value)) {
    throw new TaskRemovalOwnerRecoveryError('Task removal hook-set registry is invalid');
  }
  const keys = Object.keys(value);
  if (
    keys.length !== TASK_REMOVAL_PARTICIPANT_IDS.length ||
    keys.some((key) => !isParticipantId(key))
  ) {
    throw new TaskRemovalOwnerRecoveryError('Task removal hook-set registry is incomplete');
  }
  const result = {} as Record<TaskRemovalParticipantId, string>;
  for (const id of TASK_REMOVAL_PARTICIPANT_IDS) {
    const version = value[id];
    if (typeof version !== 'string' || version.trim().length === 0 || version.length > 128) {
      throw new TaskRemovalOwnerRecoveryError(`Task removal hook version ${id} is invalid`);
    }
    result[id] = version;
  }
  return result;
}

function readOwnerSchema(privateState: JsonObject): TaskRemovalOwnerSchema | null {
  const value = privateState[OWNER_SCHEMA_KEY];
  if (value === undefined) return null;
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, [
      'catalogVersion',
      'cutoverEpoch',
      'hookSetVersions',
      'legacyEffectsDisabled',
      'phase',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== TASK_REMOVAL_OWNER_SCHEMA_VERSION ||
    (value.phase !== 'preparing' && value.phase !== 'active') ||
    typeof value.cutoverEpoch !== 'string' ||
    value.cutoverEpoch.trim().length === 0 ||
    value.cutoverEpoch.length > 512 ||
    typeof value.legacyEffectsDisabled !== 'boolean' ||
    (value.phase === 'active') !== value.legacyEffectsDisabled ||
    !Number.isSafeInteger(value.catalogVersion) ||
    (value.catalogVersion as number) < 0
  ) {
    throw new TaskRemovalOwnerRecoveryError('Task removal owner schema is invalid');
  }
  return {
    catalogVersion: value.catalogVersion as number,
    cutoverEpoch: value.cutoverEpoch,
    hookSetVersions: readHookSetVersions(value.hookSetVersions),
    legacyEffectsDisabled: value.legacyEffectsDisabled,
    phase: value.phase,
    schemaVersion: TASK_REMOVAL_OWNER_SCHEMA_VERSION,
  };
}

function emptyOperationState(): TaskRemovalOperationState {
  return {
    deletionOperationIdByTaskId: {},
    recordsByDeletionOperationId: {},
    schemaVersion: 1,
  };
}

function readCommitExtension(
  value: JsonValue | undefined,
): DurableMergeProgressCommitExtension | undefined {
  if (value === undefined) return undefined;
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, [
      'committedAt',
      'kind',
      'linesAdded',
      'linesRemoved',
      'progressVersionAtCommit',
      'state',
    ]) ||
    value.kind !== COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION ||
    (value.state !== 'awaiting-linked-proof' && value.state !== 'linked-proof-ready')
  ) {
    throw new TaskRemovalOwnerRecoveryError('Task removal commit extension is invalid');
  }
  if (value.state === 'awaiting-linked-proof') {
    if (
      value.committedAt !== undefined ||
      value.linesAdded !== undefined ||
      value.linesRemoved !== undefined ||
      value.progressVersionAtCommit !== undefined
    ) {
      throw new TaskRemovalOwnerRecoveryError(
        'Awaiting task removal commit extension contains merge proof',
      );
    }
    return {
      kind: COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION,
      state: 'awaiting-linked-proof',
    };
  }
  if (
    typeof value.committedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.committedAt)) ||
    new Date(value.committedAt).toISOString() !== value.committedAt ||
    !Number.isSafeInteger(value.linesAdded) ||
    (value.linesAdded as number) < 0 ||
    !Number.isSafeInteger(value.linesRemoved) ||
    (value.linesRemoved as number) < 0 ||
    (value.progressVersionAtCommit !== undefined &&
      (!Number.isSafeInteger(value.progressVersionAtCommit) ||
        (value.progressVersionAtCommit as number) < 0))
  ) {
    throw new TaskRemovalOwnerRecoveryError('Linked merge proof is invalid');
  }
  return {
    committedAt: value.committedAt,
    kind: COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION,
    linesAdded: value.linesAdded as number,
    linesRemoved: value.linesRemoved as number,
    ...(value.progressVersionAtCommit !== undefined
      ? { progressVersionAtCommit: value.progressVersionAtCommit as number }
      : {}),
    state: 'linked-proof-ready',
  };
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('\u0000') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  );
}

function isBoundedAbsolutePath(value: unknown): value is string {
  return isBoundedString(value, 4_096) && path.isAbsolute(value) && path.normalize(value) === value;
}

function isValidGitBranchName(value: unknown): value is string {
  if (!isBoundedString(value, 1_024)) return false;
  const hasInvalidAscii = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || codePoint === 0x7f;
  });
  const hasInvalidGitPunctuation = ['~', '^', ':', '?', '*', '[', '\\'].some((character) =>
    value.includes(character),
  );
  if (
    value === '@' ||
    value === 'HEAD' ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('//') ||
    value.includes('..') ||
    value.includes('@{') ||
    hasInvalidAscii ||
    hasInvalidGitPunctuation
  ) {
    return false;
  }
  return value
    .split('/')
    .every(
      (component) =>
        component.length > 0 && !component.startsWith('.') && !component.endsWith('.lock'),
    );
}

function isManagedWorktreePath(projectRoot: string, worktreePath: string): boolean {
  const container = path.resolve(projectRoot, '.worktrees');
  const relative = path.relative(container, path.resolve(worktreePath));
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep)[0] !== '.parallel-code-recovery'
  );
}

function readCleanupPlan(
  value: JsonValue | undefined,
  taskId: string,
  deletionOperationId: string,
): TaskRemovalCleanupPlan {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, [
      'agentIds',
      'branchName',
      'deleteBranch',
      'gitCleanup',
      'launchOperationId',
      'preparedWorkspaceRevision',
      'projectMode',
      'projectRoot',
      'quarantinePath',
      'taskId',
      'taskIdentityWitness',
      'taskMode',
      'worktreePath',
    ]) ||
    value.taskId !== taskId ||
    !Array.isArray(value.agentIds) ||
    value.agentIds.length > 64 ||
    value.agentIds.some((agentId) => !isBoundedString(agentId, 512)) ||
    new Set(value.agentIds).size !== value.agentIds.length ||
    typeof value.deleteBranch !== 'boolean' ||
    (value.gitCleanup !== 'managed-worktree' && value.gitCleanup !== 'preserve') ||
    (value.launchOperationId !== null && !isBoundedString(value.launchOperationId, 512)) ||
    !Number.isSafeInteger(value.preparedWorkspaceRevision) ||
    (value.preparedWorkspaceRevision as number) < 0 ||
    (value.projectMode !== 'git' && value.projectMode !== 'non-git') ||
    !isBoundedAbsolutePath(value.projectRoot) ||
    (value.quarantinePath !== null && !isBoundedAbsolutePath(value.quarantinePath)) ||
    !isBoundedAbsolutePath(value.worktreePath) ||
    typeof value.taskIdentityWitness !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.taskIdentityWitness) ||
    (value.taskMode !== 'agent' && value.taskMode !== 'terminal') ||
    (value.taskMode === 'agent' && value.launchOperationId !== null) ||
    (value.launchOperationId !== null && (value.preparedWorkspaceRevision as number) < 1) ||
    (value.projectMode === 'non-git' &&
      (value.gitCleanup !== 'preserve' ||
        value.branchName !== '' ||
        value.quarantinePath !== null)) ||
    (value.projectMode === 'git' && !isValidGitBranchName(value.branchName)) ||
    (value.gitCleanup === 'managed-worktree' &&
      (value.projectMode !== 'git' ||
        value.quarantinePath !==
          getManagedWorktreeRecoveryQuarantinePath(
            value.worktreePath as string,
            deletionOperationId,
          ) ||
        !isManagedWorktreePath(value.projectRoot as string, value.worktreePath as string))) ||
    (value.gitCleanup === 'preserve' &&
      (value.quarantinePath !== null || value.deleteBranch !== false))
  ) {
    throw new TaskRemovalOwnerRecoveryError(`Task removal cleanup plan for ${taskId} is invalid`);
  }
  return {
    agentIds: [...(value.agentIds as string[])],
    branchName: value.branchName as string,
    deleteBranch: value.deleteBranch,
    gitCleanup: value.gitCleanup,
    launchOperationId: value.launchOperationId as string | null,
    preparedWorkspaceRevision: value.preparedWorkspaceRevision as number,
    projectMode: value.projectMode,
    projectRoot: value.projectRoot,
    quarantinePath: value.quarantinePath,
    taskId,
    taskIdentityWitness: value.taskIdentityWitness,
    taskMode: value.taskMode,
    worktreePath: value.worktreePath,
  };
}

function readCleanupStepState(value: JsonObject): {
  cleanupStepEvidence: Partial<Record<TaskRemovalCleanupStep, JsonObject>>;
  completedCleanupSteps: TaskRemovalCleanupStep[];
} {
  const completed = value.completedCleanupSteps;
  const evidence = value.cleanupStepEvidence;
  if (
    !Array.isArray(completed) ||
    completed.some(
      (step) => !TASK_REMOVAL_CLEANUP_STEPS.includes(step as TaskRemovalCleanupStep),
    ) ||
    new Set(completed).size !== completed.length ||
    !isJsonObject(evidence)
  ) {
    throw new TaskRemovalOwnerRecoveryError('Task removal cleanup step state is invalid');
  }
  const ordered = TASK_REMOVAL_CLEANUP_STEPS.filter((step) => completed.includes(step));
  if (
    ordered.length !== completed.length ||
    ordered.some((step, index) => step !== completed[index])
  ) {
    throw new TaskRemovalOwnerRecoveryError('Task removal cleanup steps are out of order');
  }
  const cleanupStepEvidence: Partial<Record<TaskRemovalCleanupStep, JsonObject>> = {};
  for (const [step, stepEvidence] of Object.entries(evidence)) {
    if (
      !TASK_REMOVAL_CLEANUP_STEPS.includes(step as TaskRemovalCleanupStep) ||
      !completed.includes(step) ||
      !isJsonObject(stepEvidence)
    ) {
      throw new TaskRemovalOwnerRecoveryError('Task removal cleanup evidence is invalid');
    }
    cleanupStepEvidence[step as TaskRemovalCleanupStep] = cloneJsonObject(stepEvidence);
  }
  if (completed.some((step) => cleanupStepEvidence[step as TaskRemovalCleanupStep] === undefined)) {
    throw new TaskRemovalOwnerRecoveryError('Task removal cleanup evidence is incomplete');
  }
  return { cleanupStepEvidence, completedCleanupSteps: ordered };
}

function getRequiredCleanupSteps(plan: TaskRemovalCleanupPlan): TaskRemovalCleanupStep[] {
  const required: TaskRemovalCleanupStep[] = [
    'runners',
    'containers',
    'runtime-state',
    'coordinator',
  ];
  if (plan.gitCleanup === 'managed-worktree') {
    required.push('worktree-quarantine');
    if (plan.deleteBranch) required.push('branch-release');
  }
  required.push('shell-prepare');
  return required;
}

function readOperationRecord(
  value: JsonObject,
  deletionOperationId: string,
): DurableTaskRemovalOperation {
  const pending = value.pendingFinalizers;
  if (
    !hasOnlyKeys(value, [
      'cleanupPlan',
      'cleanupStepEvidence',
      'completedCleanupSteps',
      'commitExtension',
      'deletionOperationId',
      'pendingFinalizers',
      'phase',
      'recordVersion',
      'cleanupComplete',
      'schemaVersion',
      'taskClosing',
      'taskId',
      'workspaceRevision',
    ]) ||
    value.schemaVersion !== 1 ||
    value.deletionOperationId !== deletionOperationId ||
    typeof value.taskId !== 'string' ||
    value.taskId.trim().length === 0 ||
    !Number.isSafeInteger(value.recordVersion) ||
    (value.recordVersion as number) < 1 ||
    (value.phase !== 'reserved-awaiting-activation' &&
      value.phase !== 'reserved-before-cleanup' &&
      value.phase !== 'cleanup-complete-workspace-retry' &&
      value.phase !== 'committed-finalizers-pending' &&
      value.phase !== 'complete') ||
    typeof value.cleanupComplete !== 'boolean' ||
    typeof value.taskClosing !== 'boolean' ||
    !Array.isArray(pending) ||
    pending.some((id) => !isParticipantId(id)) ||
    new Set(pending).size !== pending.length ||
    (value.workspaceRevision !== undefined &&
      (!Number.isSafeInteger(value.workspaceRevision) || (value.workspaceRevision as number) < 0))
  ) {
    throw new TaskRemovalOwnerRecoveryError(
      `Task removal operation ${deletionOperationId} is invalid`,
    );
  }
  const commitExtension = readCommitExtension(value.commitExtension);
  const cleanupPlan = readCleanupPlan(value.cleanupPlan, value.taskId, deletionOperationId);
  const cleanupSteps = readCleanupStepState(value);
  const requiredCleanupSteps = getRequiredCleanupSteps(cleanupPlan);
  const pendingFinalizers = PARTICIPANT_FINALIZER_ORDER.filter((id) => pending.includes(id));
  if (
    pendingFinalizers.length !== pending.length ||
    pendingFinalizers.some((id, index) => pending[index] !== id) ||
    cleanupSteps.completedCleanupSteps.some(
      (step, index) => requiredCleanupSteps[index] !== step,
    ) ||
    (value.cleanupComplete &&
      cleanupSteps.completedCleanupSteps.length !== requiredCleanupSteps.length) ||
    (value.phase === 'reserved-awaiting-activation' &&
      (value.cleanupComplete ||
        cleanupSteps.completedCleanupSteps.length !== 0 ||
        value.taskClosing ||
        value.workspaceRevision !== undefined ||
        commitExtension?.state !== 'awaiting-linked-proof')) ||
    (value.phase === 'reserved-before-cleanup' &&
      (value.cleanupComplete || value.workspaceRevision !== undefined)) ||
    (value.phase === 'cleanup-complete-workspace-retry' &&
      (!value.cleanupComplete || value.workspaceRevision !== undefined)) ||
    (value.phase === 'committed-finalizers-pending' &&
      (!value.cleanupComplete || value.workspaceRevision === undefined)) ||
    (value.phase === 'complete' &&
      (!value.cleanupComplete || value.workspaceRevision === undefined || pending.length !== 0)) ||
    (value.phase === 'complete' && value.taskClosing !== false) ||
    (value.phase !== 'complete' &&
      value.phase !== 'reserved-awaiting-activation' &&
      value.taskClosing !== true) ||
    (commitExtension !== undefined &&
      value.phase !== 'reserved-awaiting-activation' &&
      commitExtension.state !== 'linked-proof-ready') ||
    (commitExtension !== undefined &&
      (value.phase === 'committed-finalizers-pending' || value.phase === 'complete') !==
        (commitExtension.progressVersionAtCommit !== undefined))
  ) {
    throw new TaskRemovalOwnerRecoveryError(
      `Task removal operation ${deletionOperationId} is contradictory`,
    );
  }
  return {
    cleanupPlan,
    cleanupStepEvidence: cleanupSteps.cleanupStepEvidence,
    completedCleanupSteps: cleanupSteps.completedCleanupSteps,
    ...(commitExtension ? { commitExtension } : {}),
    deletionOperationId,
    pendingFinalizers,
    phase: value.phase,
    recordVersion: value.recordVersion as number,
    cleanupComplete: value.cleanupComplete,
    schemaVersion: 1,
    taskClosing: value.taskClosing,
    taskId: value.taskId,
    ...(value.workspaceRevision !== undefined
      ? { workspaceRevision: value.workspaceRevision as number }
      : {}),
  };
}

function readOperationState(privateState: JsonObject): TaskRemovalOperationState {
  const value = privateState[OPERATIONS_KEY];
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, [
      'deletionOperationIdByTaskId',
      'recordsByDeletionOperationId',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw new TaskRemovalOwnerRecoveryError('Task removal operation state is invalid');
  }
  if (
    !isJsonObject(value.deletionOperationIdByTaskId) ||
    !isJsonObject(value.recordsByDeletionOperationId)
  ) {
    throw new TaskRemovalOwnerRecoveryError('Task removal operation indexes are invalid');
  }
  const state = emptyOperationState();
  for (const [operationId, recordValue] of Object.entries(value.recordsByDeletionOperationId)) {
    if (!isJsonObject(recordValue)) {
      throw new TaskRemovalOwnerRecoveryError(`Task removal operation ${operationId} is invalid`);
    }
    const record = readOperationRecord(recordValue, operationId);
    state.recordsByDeletionOperationId[operationId] = record;
  }
  for (const [taskId, operationId] of Object.entries(value.deletionOperationIdByTaskId)) {
    if (typeof operationId !== 'string') {
      throw new TaskRemovalOwnerRecoveryError(`Task removal index ${taskId} is invalid`);
    }
    const record = state.recordsByDeletionOperationId[operationId];
    if (!record || record.taskId !== taskId) {
      throw new TaskRemovalOwnerRecoveryError(`Task removal index ${taskId} is inconsistent`);
    }
    state.deletionOperationIdByTaskId[taskId] = operationId;
  }
  for (const record of Object.values(state.recordsByDeletionOperationId)) {
    if (state.deletionOperationIdByTaskId[record.taskId] !== record.deletionOperationId) {
      throw new TaskRemovalOwnerRecoveryError(
        `Task removal operation ${record.deletionOperationId} is not indexed`,
      );
    }
  }
  return state;
}

function withRemovalState(
  privateState: JsonObject,
  schema: TaskRemovalOwnerSchema,
  operations: TaskRemovalOperationState,
): JsonObject {
  return {
    ...cloneJsonObject(privateState),
    [OPERATIONS_KEY]: operations as unknown as JsonObject,
    [OWNER_SCHEMA_KEY]: schema as unknown as JsonObject,
  };
}

function requireTasks(sharedState: JsonObject): JsonObject {
  const tasks = sharedState.tasks;
  if (!isJsonObject(tasks)) {
    throw new TaskRemovalOwnerRecoveryError('Canonical tasks are invalid');
  }
  return tasks;
}

function collectCleanupAgentIds(task: JsonObject): string[] {
  const result = new Set<string>();
  const add = (value: unknown): void => {
    if (isBoundedString(value, 512)) result.add(value);
  };
  add(task.agentId);
  for (const field of ['agentIds', 'shellAgentIds'] as const) {
    const values = task[field];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.some((value) => !isBoundedString(value, 512))) {
      throw new TaskRemovalOwnerRecoveryError(
        `Canonical task ${String(task.id)} agent IDs are invalid`,
      );
    }
    values.forEach(add);
  }
  if (result.size > 64) {
    throw new TaskRemovalOwnerRecoveryError(
      `Canonical task ${String(task.id)} has too many agents`,
    );
  }
  return [...result].sort();
}

function getManagedShellLaunchOperationId(
  task: JsonObject,
  taskMode: 'agent' | 'terminal',
): string | null {
  const shellOwnership = task.taskInitialShellOwnership;
  const operationLink = task.taskCreationOperationLink;
  if (shellOwnership === undefined && operationLink === undefined) return null;
  if (!isTaskInitialShellOwnership(shellOwnership) || !isTaskCreationOperationLink(operationLink)) {
    throw new TaskRemovalOwnerRecoveryError('Canonical task shell ownership is invalid');
  }
  if (taskMode === 'agent') {
    if (shellOwnership.kind !== 'not-applicable-agent') {
      throw new TaskRemovalOwnerRecoveryError('Agent task has terminal shell ownership');
    }
    return null;
  }
  if (shellOwnership.kind === 'legacy-unmanaged-terminal') {
    if (operationLink.kind !== 'pre-operation-journal') {
      throw new TaskRemovalOwnerRecoveryError('Legacy terminal has a managed operation link');
    }
    return null;
  }
  if (
    shellOwnership.kind !== 'managed-terminal-v1' ||
    operationLink.kind !== 'creation-v1' ||
    operationLink.launchOperationId !== shellOwnership.launchOperationId
  ) {
    throw new TaskRemovalOwnerRecoveryError('Managed terminal shell mapping is inconsistent');
  }
  return shellOwnership.launchOperationId;
}

function deriveTaskRemovalIdentityWitness(task: JsonObject): string {
  const identity: JsonObject = {
    branchName: task.branchName ?? null,
    id: task.id ?? null,
    projectId: task.projectId ?? null,
    taskCreationOperationLink: task.taskCreationOperationLink ?? null,
    taskInitialShellOwnership: task.taskInitialShellOwnership ?? null,
    taskMode: task.taskMode ?? null,
    worktreePath: task.worktreePath ?? null,
  };
  return createHash('sha256').update(canonicalJsonStringify(identity), 'utf8').digest('hex');
}

function createCleanupPlan(
  sharedState: JsonObject,
  taskId: string,
  deletionOperationId: string,
  preparedWorkspaceRevision: number,
): TaskRemovalCleanupPlan {
  const task = requireTasks(sharedState)[taskId];
  if (!isJsonObject(task) || task.id !== taskId) {
    throw new TaskRemovalOwnerRecoveryError(`Canonical task ${taskId} is invalid`);
  }
  const projects = sharedState.projects;
  if (!Array.isArray(projects) || projects.some((project) => !isJsonObject(project))) {
    throw new TaskRemovalOwnerRecoveryError('Canonical projects are invalid');
  }
  const project = (projects as JsonObject[]).find((candidate) => candidate.id === task.projectId);
  if (!project || !isBoundedString(project.path, 4_096) || !path.isAbsolute(project.path)) {
    throw new TaskRemovalOwnerRecoveryError(`Canonical task ${taskId} project is invalid`);
  }
  const projectMode =
    task.projectMode === 'non-git' || project.projectMode === 'non-git' ? 'non-git' : 'git';
  if (task.taskMode !== 'agent' && task.taskMode !== 'terminal') {
    throw new TaskRemovalOwnerRecoveryError(`Canonical task ${taskId} mode is invalid`);
  }
  if (!Number.isSafeInteger(preparedWorkspaceRevision) || preparedWorkspaceRevision < 0) {
    throw new TaskRemovalOwnerRecoveryError('Task removal workspace revision is invalid');
  }
  if (
    !isBoundedString(task.worktreePath, 4_096) ||
    !path.isAbsolute(task.worktreePath) ||
    (projectMode === 'git' && !isValidGitBranchName(task.branchName)) ||
    (projectMode === 'non-git' && task.branchName !== '')
  ) {
    throw new TaskRemovalOwnerRecoveryError(`Canonical task ${taskId} Git location is invalid`);
  }
  const gitIsolation = task.gitIsolation;
  const worktreeOwnership = task.worktreeOwnership;
  if (
    (gitIsolation !== undefined &&
      gitIsolation !== 'worktree' &&
      gitIsolation !== 'current-branch' &&
      gitIsolation !== 'existing-worktree') ||
    (worktreeOwnership !== undefined &&
      worktreeOwnership !== 'managed' &&
      worktreeOwnership !== 'external') ||
    (projectMode === 'git' && gitIsolation === undefined)
  ) {
    throw new TaskRemovalOwnerRecoveryError(`Canonical task ${taskId} Git isolation is invalid`);
  }
  const rootBackedOrExternal =
    gitIsolation === 'current-branch' ||
    gitIsolation === 'existing-worktree' ||
    worktreeOwnership === 'external';
  const managedWorktree = projectMode === 'git' && !rootBackedOrExternal;
  if (
    managedWorktree &&
    !isManagedWorktreePath(project.path as string, task.worktreePath as string)
  ) {
    throw new TaskRemovalOwnerRecoveryError(
      `Canonical task ${taskId} does not own its managed worktree location`,
    );
  }
  const deleteBranch = managedWorktree && project.deleteBranchOnClose !== false;
  const projectRoot = path.normalize(project.path as string);
  const worktreePath = path.normalize(task.worktreePath as string);
  const launchOperationId = getManagedShellLaunchOperationId(task, task.taskMode);
  if (launchOperationId !== null && preparedWorkspaceRevision < 1) {
    throw new TaskRemovalOwnerRecoveryError('Managed shell removal has no workspace revision');
  }
  return {
    agentIds: collectCleanupAgentIds(task),
    branchName: task.branchName as string,
    deleteBranch,
    gitCleanup: managedWorktree ? 'managed-worktree' : 'preserve',
    launchOperationId,
    preparedWorkspaceRevision,
    projectMode,
    projectRoot,
    quarantinePath: managedWorktree
      ? getManagedWorktreeRecoveryQuarantinePath(worktreePath, deletionOperationId)
      : null,
    taskId,
    taskIdentityWitness: deriveTaskRemovalIdentityWitness(task),
    taskMode: task.taskMode,
    worktreePath,
  };
}

function requireOrder(
  sharedState: JsonObject,
  field: 'collapsedTaskOrder' | 'taskOrder',
): string[] {
  const order = sharedState[field];
  if (!Array.isArray(order) || order.some((entry) => typeof entry !== 'string')) {
    throw new TaskRemovalOwnerRecoveryError(`Canonical ${field} is invalid`);
  }
  if (new Set(order).size !== order.length) {
    throw new TaskRemovalOwnerRecoveryError(`Canonical ${field} contains duplicates`);
  }
  return [...order] as string[];
}

function nextCatalogVersion(schema: TaskRemovalOwnerSchema, sharedRevision: number): number {
  const current = Math.max(schema.catalogVersion, sharedRevision);
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
    throw new TaskRemovalOwnerRecoveryError('Task removal catalog version overflow');
  }
  return current + 1;
}

function createParticipantMap(
  participants: readonly TaskRemovalOwnerParticipant[],
): Map<TaskRemovalParticipantId, TaskRemovalOwnerParticipant> {
  const result = new Map<TaskRemovalParticipantId, TaskRemovalOwnerParticipant>();
  for (const participant of participants) {
    if (result.has(participant.id)) {
      throw new TaskRemovalOwnerCutoverError(`Duplicate removal participant ${participant.id}`);
    }
    requireIdentifier(participant.hookSetVersion, `${participant.id} hookSetVersion`);
    result.set(participant.id, participant);
  }
  for (const id of TASK_REMOVAL_PARTICIPANT_IDS) {
    if (!result.has(id)) {
      throw new TaskRemovalOwnerCutoverError(`Missing dark removal participant ${id}`);
    }
  }
  if (typeof result.get('task-runtime')?.cleanupTaskRuntimeStep !== 'function') {
    throw new TaskRemovalOwnerCutoverError(
      'Task runtime removal participant has no durable cleanup-step owner',
    );
  }
  return result;
}

export class TaskRemovalOwner {
  private readonly createCutoverEpoch: () => string;
  private readonly createDeletionOperationId: () => string;
  private readonly serverInstanceId: string;
  private readonly notesCoordination: TaskRemovalNotesCoordination;
  private activationPromise: Promise<TaskRemovalOwnerCapability> | null = null;
  private availability: TaskRemovalOwnerAvailability = {
    kind: 'unavailable',
    reason: 'not-cut-over',
  };
  private catalogVersion = 0;
  private participants = new Map<TaskRemovalParticipantId, TaskRemovalOwnerParticipant>();
  private recordsByTaskId = new Map<string, DurableTaskRemovalOperation>();
  private taskStates = new Map<string, 'present' | 'removed'>();
  private readonly lifecycleListeners = new Set<(event: TaskRemovalLifecycleEvent) => void>();

  constructor(
    private readonly privateAuthority: WorkspacePrivateMutationAuthority,
    options: TaskRemovalOwnerOptions = {},
  ) {
    this.createCutoverEpoch =
      options.createCutoverEpoch ?? (() => `task-removal-v1:${randomUUID()}`);
    this.createDeletionOperationId =
      options.createDeletionOperationId ?? (() => `task-delete-v1:${randomUUID()}`);
    this.serverInstanceId = options.serverInstanceId ?? randomUUID();
    this.notesCoordination = new TaskRemovalNotesCoordination(
      this.privateAuthority,
      this.serverInstanceId,
      (taskId) => this.getCurrentProjection(taskId),
      options.taskNotes,
    );
  }

  activate(
    participants: readonly TaskRemovalOwnerParticipant[],
  ): Promise<TaskRemovalOwnerCapability> {
    this.activationPromise ??= this.runActivation(participants).catch((error: unknown) => {
      this.availability = { kind: 'unavailable', reason: 'recovery-required' };
      this.activationPromise = null;
      throw error;
    });
    return this.activationPromise;
  }

  createParticipantGate<THookSetVersion extends string>(
    participantId: TaskRemovalParticipantId,
    expectedHookSetVersion: THookSetVersion,
  ): TaskRemovalParticipantGate<THookSetVersion> {
    return {
      getTaskSnapshot: (taskId) => {
        const capability = this.getAvailability();
        const participant = this.participants.get(participantId);
        if (
          capability.kind !== 'active' ||
          !participant ||
          participant.hookSetVersion !== expectedHookSetVersion ||
          capability.hookSetVersions[participantId] !== expectedHookSetVersion
        ) {
          return { kind: 'unavailable' };
        }
        return {
          current: this.getCurrentProjection(taskId),
          cutoverEpoch: capability.cutoverEpoch,
          hookSetVersion: expectedHookSetVersion,
          kind: 'active',
        };
      },
      verifyCommittedRemoval: (request) =>
        this.verifyCommittedRemoval(participantId, expectedHookSetVersion, request),
    };
  }

  async verifyTaskIdentityWitnessForRemoval(
    request: Readonly<VerifyTaskRemovalPreparationRequest>,
  ): Promise<boolean> {
    if (
      this.availability.kind !== 'active' ||
      !isBoundedString(request.taskId, 512) ||
      !isBoundedString(request.deletionOperationId, 512) ||
      !isBoundedString(request.launchOperationId, 512) ||
      !Number.isSafeInteger(request.preparedWorkspaceRevision) ||
      request.preparedWorkspaceRevision < 1 ||
      !/^[0-9a-f]{64}$/u.test(request.taskIdentityWitness)
    ) {
      return false;
    }
    const result = await this.privateAuthority.mutate(
      { operation: 'verify-task-removal-shell-preparation' },
      (slices) => {
        const operations = readOperationState(slices.privateState);
        const record = operations.recordsByDeletionOperationId[request.deletionOperationId];
        const task = requireTasks(slices.sharedState)[request.taskId];
        if (
          !record ||
          record.taskId !== request.taskId ||
          record.phase !== 'reserved-before-cleanup' ||
          record.cleanupComplete ||
          record.cleanupPlan.launchOperationId !== request.launchOperationId ||
          record.cleanupPlan.preparedWorkspaceRevision !== request.preparedWorkspaceRevision ||
          record.cleanupPlan.taskIdentityWitness !== request.taskIdentityWitness ||
          slices.sharedRevision < request.preparedWorkspaceRevision ||
          !isJsonObject(task) ||
          deriveTaskRemovalIdentityWitness(task) !== request.taskIdentityWitness
        ) {
          return unchanged(false);
        }
        const requiredSteps = getRequiredCleanupSteps(record.cleanupPlan);
        return unchanged(requiredSteps[record.completedCleanupSteps.length] === 'shell-prepare');
      },
    );
    return result.result;
  }

  getAvailability(): TaskRemovalOwnerAvailability {
    return this.availability.kind === 'active'
      ? {
          ...this.availability,
          hookSetVersions: { ...this.availability.hookSetVersions },
        }
      : this.availability;
  }

  /**
   * Narrow projection seam for the one canonical TaskCatalogState. Events follow durable removal
   * truth; final task absence remains owned by the catalog's structural replace/tombstone path.
   */
  subscribeLifecycle(listener: (event: TaskRemovalLifecycleEvent) => void): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('Task removal lifecycle listener is invalid');
    }
    if (
      !this.lifecycleListeners.has(listener) &&
      this.lifecycleListeners.size >= TASK_REMOVAL_LIFECYCLE_LISTENER_LIMIT
    ) {
      throw new TaskRemovalOwnerConflictError('Task removal lifecycle listener capacity exceeded');
    }
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  getTaskNotesStructuralAuthority(): TaskNotesStructuralAuthority {
    return this.notesCoordination.getAuthority();
  }

  getTaskMergeRemovalAuthority(): TaskMergeRemovalAuthority {
    if (this.availability.kind !== 'active') {
      throw new TaskRemovalOwnerCutoverError(
        'Task merge removal authority requires the generic removal owner',
      );
    }
    return {
      abortBeforeLinkedProof: (request) => this.abortLinkedRemovalBeforeProof(request),
      continueAfterLinkedProof: (mutation, request) =>
        this.continueLinkedRemovalAfterProof(mutation, request),
      getCommittedMergeEvidence: (request) => this.getCommittedLinkedMergeEvidence(request),
      getStatus: (request) => this.getLinkedRemovalStatus(request),
      reserve: (request) => this.reserveLinkedRemoval(request),
    };
  }

  activateTaskNotesStructuralAuthority(): Promise<TaskNotesStructuralAuthority> {
    if (this.availability.kind !== 'active') {
      throw new TaskRemovalOwnerCutoverError(
        'Task notes structural authority requires the generic removal owner',
      );
    }
    return this.notesCoordination.activate();
  }

  recoverTaskNotesStructuralAuthority(operationId?: string): Promise<void> {
    if (this.availability.kind !== 'active') {
      throw new TaskRemovalOwnerCutoverError(
        'Task notes structural authority requires the generic removal owner',
      );
    }
    return this.notesCoordination.recoverAfterHostDurability(operationId);
  }

  createTaskIdentityWitnessCandidate(): string {
    return this.notesCoordination.createWitnessCandidate();
  }

  withTaskIdentityAdded(
    privateState: Readonly<JsonObject>,
    taskId: string,
    witness: string,
    taskAlreadyExists: boolean,
  ): { changed: boolean; privateState: JsonObject } {
    return this.notesCoordination.withTaskIdentityAdded(
      privateState,
      taskId,
      witness,
      taskAlreadyExists,
    );
  }

  beginCanonicalStructureWrite(): void {
    this.notesCoordination.beginCanonicalStructureWrite();
  }

  endCanonicalStructureWrite(): void {
    this.notesCoordination.endCanonicalStructureWrite();
  }

  noteTaskAdded(taskId: string, sharedRevision: number): void {
    if (this.availability.kind !== 'active') return;
    this.taskStates.set(taskId, 'present');
    this.catalogVersion = Math.max(this.catalogVersion + 1, sharedRevision);
    this.notesCoordination.publishStructuralChange();
  }

  isTaskAdditionBlocked(taskId: string): boolean {
    return this.availability.kind === 'active' && this.recordsByTaskId.has(taskId);
  }

  /**
   * Fail-closed O(1) admission projection for task-scoped mutation effects. It includes the
   * process-private mutation-drain/fence window as well as durable closing records, so consumers
   * cannot lag behind the lifecycle event projection.
   */
  isTaskMutationAdmissionClosed(taskId: string): boolean {
    if (this.availability.kind !== 'active') return true;
    if (this.taskStates.get(taskId) !== 'present') return true;
    return (
      this.recordsByTaskId.get(taskId)?.taskClosing === true ||
      this.notesCoordination.isTaskClosing(taskId)
    );
  }

  async removeTask(
    mutation: WorkspaceMutationRequest,
    taskId: string,
  ): Promise<WorkspaceMutationResult<TaskRemovalMutationResult>> {
    requireIdentifier(taskId, 'taskId');
    if (this.availability.kind !== 'active') {
      throw new TaskRemovalOwnerCutoverError('Generic task removal is not active');
    }

    const proposedDeletionOperationId = this.createDeletionOperationId();
    requireIdentifier(proposedDeletionOperationId, 'deletionOperationId');
    const drain = this.notesCoordination.beginRemovalDrain(taskId, proposedDeletionOperationId);
    if (drain.kind !== 'durable') {
      await this.notesCoordination.drainAndFenceRemoval(taskId, drain.operationId);
    }

    let reservation: Awaited<ReturnType<TaskRemovalOwner['reserveRemoval']>>;
    try {
      reservation = await this.reserveRemoval(taskId, drain.operationId);
    } catch (error) {
      this.notesCoordination.cancelUnreservedRemoval(taskId, drain.operationId);
      if (!(error instanceof TaskRemovalOwnerConflictError)) {
        this.notesCoordination.reportCanonicalStateFailure(error);
      }
      throw error;
    }
    if (!reservation) {
      this.notesCoordination.cancelUnreservedRemoval(taskId, drain.operationId);
      return {
        changed: false,
        result: { removed: false, taskId },
        revision: await this.readSharedRevision(),
      };
    }
    const record = reservation.record;
    this.notesCoordination.promoteRemovalFenceToDurable(taskId, record.deletionOperationId);
    this.publishRecord(record, reservation.taskPresent);
    return this.continueRemovalOperation(mutation, record, {
      changed: reservation.changed,
      revision: reservation.revision,
    });
  }

  private async reserveLinkedRemoval(
    request: ReserveLinkedTaskMergeRemovalRequest,
  ): Promise<ReserveLinkedTaskMergeRemovalResult> {
    requireIdentifier(request.taskId, 'taskId');
    requireIdentifier(request.deletionOperationId, 'deletionOperationId');
    if (
      request.activation !== 'after-linked-merge-proof' ||
      request.commitExtensionKind !== COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION
    ) {
      throw new TaskRemovalOwnerRecoveryError('Linked task removal specification is invalid');
    }
    if (this.availability.kind !== 'active') {
      throw new TaskRemovalOwnerCutoverError('Generic task removal is not active');
    }

    const result = await this.privateAuthority.mutate<ReserveLinkedTaskMergeRemovalResult>(
      { operation: 'reserve-linked-task-merge-removal' },
      (slices) => {
        const schema = readOwnerSchema(slices.privateState);
        if (!schema || schema.phase !== 'active' || !schema.legacyEffectsDisabled) {
          throw new TaskRemovalOwnerCutoverError('Generic task removal is not durably active');
        }
        if (getProtectedPolicyVersions(slices.privateState)['merge-progress'] !== '1') {
          throw new TaskRemovalOwnerCutoverError('Merge progress protection is not active');
        }
        const operations = readOperationState(slices.privateState);
        const tasks = requireTasks(slices.sharedState);
        if (tasks[request.taskId] === undefined) {
          return unchanged({ kind: 'task-not-current' as const });
        }
        const indexedId = operations.deletionOperationIdByTaskId[request.taskId];
        if (indexedId) {
          const indexed = operations.recordsByDeletionOperationId[indexedId];
          if (
            indexed?.deletionOperationId === request.deletionOperationId &&
            indexed.taskId === request.taskId &&
            indexed.commitExtension?.kind === request.commitExtensionKind
          ) {
            return unchanged({
              kind: 'already-reserved' as const,
              recordVersion: indexed.recordVersion,
            });
          }
          return unchanged({ kind: 'operation-conflict' as const });
        }
        if (operations.recordsByDeletionOperationId[request.deletionOperationId]) {
          return unchanged({ kind: 'operation-conflict' as const });
        }
        const record: DurableTaskRemovalOperation = {
          cleanupPlan: createCleanupPlan(
            slices.sharedState,
            request.taskId,
            request.deletionOperationId,
            slices.sharedRevision,
          ),
          cleanupStepEvidence: {},
          completedCleanupSteps: [],
          commitExtension: {
            kind: COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION,
            state: 'awaiting-linked-proof',
          },
          deletionOperationId: request.deletionOperationId,
          pendingFinalizers: [...PARTICIPANT_FINALIZER_ORDER],
          phase: 'reserved-awaiting-activation',
          recordVersion: 1,
          cleanupComplete: false,
          schemaVersion: 1,
          taskClosing: false,
          taskId: request.taskId,
        };
        operations.deletionOperationIdByTaskId[request.taskId] = request.deletionOperationId;
        operations.recordsByDeletionOperationId[request.deletionOperationId] = record;
        return changed(
          {
            nextPrivateState: withRemovalState(slices.privateState, schema, operations),
          },
          { kind: 'reserved' as const, recordVersion: record.recordVersion },
        );
      },
    );
    if (result.result.kind === 'reserved') {
      const loaded = await this.loadIndexedRecord(request.taskId);
      if (!loaded || loaded.record.deletionOperationId !== request.deletionOperationId) {
        throw new TaskRemovalOwnerRecoveryError('Linked task removal reservation disappeared');
      }
      this.publishRecord(loaded.record, true);
    }
    return result.result;
  }

  private async getLinkedRemovalStatus(request: {
    deletionOperationId: string;
    taskId: string;
  }): Promise<TaskRemovalMutationResult | null> {
    requireIdentifier(request.taskId, 'taskId');
    requireIdentifier(request.deletionOperationId, 'deletionOperationId');
    const loaded = await this.loadIndexedRecord(request.taskId);
    if (!loaded || loaded.record.deletionOperationId !== request.deletionOperationId) return null;
    const record = loaded.record;
    const removalState =
      record.phase === 'reserved-awaiting-activation'
        ? ('awaiting-linked-proof' as const)
        : record.phase === 'reserved-before-cleanup' ||
            record.phase === 'cleanup-complete-workspace-retry'
          ? ('cleanup-pending' as const)
          : record.phase === 'complete'
            ? ('complete' as const)
            : ('finalizer-repair-pending' as const);
    return {
      deletionOperationId: record.deletionOperationId,
      ...(record.pendingFinalizers.length > 0
        ? { pendingFinalizers: [...record.pendingFinalizers] }
        : {}),
      removed: !loaded.taskPresent,
      removalState,
      taskId: record.taskId,
    };
  }

  private async getCommittedLinkedMergeEvidence(request: {
    deletionOperationId: string;
    taskId: string;
  }): Promise<{ progressVersionAtCommit: number } | null> {
    requireIdentifier(request.taskId, 'taskId');
    requireIdentifier(request.deletionOperationId, 'deletionOperationId');
    const loaded = await this.loadIndexedRecord(request.taskId);
    if (!loaded || loaded.record.deletionOperationId !== request.deletionOperationId) return null;
    const record = loaded.record;
    if (
      loaded.taskPresent ||
      (record.phase !== 'committed-finalizers-pending' && record.phase !== 'complete') ||
      record.commitExtension?.progressVersionAtCommit === undefined
    ) {
      return null;
    }
    return { progressVersionAtCommit: record.commitExtension.progressVersionAtCommit };
  }

  private async abortLinkedRemovalBeforeProof(request: {
    deletionOperationId: string;
    taskId: string;
  }): Promise<'aborted' | 'already-absent'> {
    requireIdentifier(request.taskId, 'taskId');
    requireIdentifier(request.deletionOperationId, 'deletionOperationId');
    const result = await this.privateAuthority.mutate(
      { operation: 'abort-linked-task-merge-removal-before-proof' },
      (slices) => {
        const schema = readOwnerSchema(slices.privateState);
        if (!schema || schema.phase !== 'active') {
          throw new TaskRemovalOwnerCutoverError('Generic task removal is unavailable');
        }
        const operations = readOperationState(slices.privateState);
        const current = operations.recordsByDeletionOperationId[request.deletionOperationId];
        if (!current) return unchanged('already-absent' as const);
        if (
          current.taskId !== request.taskId ||
          current.phase !== 'reserved-awaiting-activation' ||
          current.commitExtension?.state !== 'awaiting-linked-proof'
        ) {
          throw new TaskRemovalOwnerRecoveryError(
            'Linked task removal can no longer be aborted before proof',
          );
        }
        Reflect.deleteProperty(
          operations.recordsByDeletionOperationId,
          request.deletionOperationId,
        );
        Reflect.deleteProperty(operations.deletionOperationIdByTaskId, request.taskId);
        return changed(
          { nextPrivateState: withRemovalState(slices.privateState, schema, operations) },
          'aborted' as const,
        );
      },
    );
    if (result.result === 'aborted') this.recordsByTaskId.delete(request.taskId);
    return result.result;
  }

  private async continueLinkedRemovalAfterProof(
    mutation: WorkspaceMutationRequest,
    request: ContinueLinkedTaskMergeRemovalRequest,
  ): Promise<WorkspaceMutationResult<TaskRemovalMutationResult>> {
    requireIdentifier(request.taskId, 'taskId');
    requireIdentifier(request.deletionOperationId, 'deletionOperationId');
    if (!Number.isFinite(request.committedAt.getTime())) {
      throw new TaskRemovalOwnerRecoveryError('Linked merge commit time is invalid');
    }
    if (this.availability.kind !== 'active') {
      throw new TaskRemovalOwnerCutoverError('Generic task removal is not active');
    }

    const drain = this.notesCoordination.beginRemovalDrain(
      request.taskId,
      request.deletionOperationId,
    );
    if (drain.operationId !== request.deletionOperationId) {
      throw new TaskRemovalOwnerRecoveryError('Task removal closing identity changed');
    }
    if (drain.kind !== 'durable') {
      await this.notesCoordination.drainAndFenceRemoval(request.taskId, drain.operationId);
    }

    let activated: {
      changed: boolean;
      record: DurableTaskRemovalOperation;
      revision: number;
      taskPresent: boolean;
    };
    try {
      activated = await this.activateLinkedRemovalProof(request);
    } catch (error) {
      this.notesCoordination.reportCanonicalStateFailure(error);
      throw error;
    }
    this.notesCoordination.promoteRemovalFenceToDurable(
      request.taskId,
      request.deletionOperationId,
    );
    this.publishRecord(activated.record, activated.taskPresent);
    return this.continueRemovalOperation(mutation, activated.record, {
      changed: activated.changed,
      revision: activated.revision,
    });
  }

  private async activateLinkedRemovalProof(
    request: ContinueLinkedTaskMergeRemovalRequest,
  ): Promise<{
    changed: boolean;
    record: DurableTaskRemovalOperation;
    revision: number;
    taskPresent: boolean;
  }> {
    const proof: DurableMergeProgressCommitExtension = {
      committedAt: request.committedAt.toISOString(),
      kind: COMMIT_COMPLETED_MERGE_PROGRESS_EXTENSION,
      linesAdded: normalizeMergeProgressInteger(request.linesAdded),
      linesRemoved: normalizeMergeProgressInteger(request.linesRemoved),
      state: 'linked-proof-ready',
    };
    const result = await this.privateAuthority.mutate(
      { operation: 'activate-linked-task-merge-removal' },
      (slices) => {
        const schema = readOwnerSchema(slices.privateState);
        if (!schema || schema.phase !== 'active') {
          throw new TaskRemovalOwnerCutoverError('Generic task removal is unavailable');
        }
        if (getProtectedPolicyVersions(slices.privateState)['merge-progress'] !== '1') {
          throw new TaskRemovalOwnerCutoverError('Merge progress protection is not active');
        }
        const operations = readOperationState(slices.privateState);
        const current = operations.recordsByDeletionOperationId[request.deletionOperationId];
        if (!current || current.taskId !== request.taskId || !current.commitExtension) {
          throw new TaskRemovalOwnerRecoveryError('Linked task removal reservation disappeared');
        }
        const taskPresent = requireTasks(slices.sharedState)[request.taskId] !== undefined;
        if (current.phase !== 'reserved-awaiting-activation') {
          const stored = current.commitExtension;
          if (
            stored.state !== 'linked-proof-ready' ||
            stored.committedAt !== proof.committedAt ||
            stored.linesAdded !== proof.linesAdded ||
            stored.linesRemoved !== proof.linesRemoved
          ) {
            throw new TaskRemovalOwnerRecoveryError('Linked merge proof changed across retry');
          }
          return unchanged({ record: current, taskPresent });
        }
        if (!taskPresent) {
          throw new TaskRemovalOwnerRecoveryError(
            'Task disappeared before linked removal activation',
          );
        }
        const next: DurableTaskRemovalOperation = {
          ...current,
          commitExtension: proof,
          phase: 'reserved-before-cleanup',
          recordVersion: current.recordVersion + 1,
          taskClosing: true,
        };
        operations.recordsByDeletionOperationId[next.deletionOperationId] = next;
        return changed(
          { nextPrivateState: withRemovalState(slices.privateState, schema, operations) },
          { record: next, taskPresent: true },
        );
      },
    );
    return {
      changed: result.changed,
      record: result.result.record,
      revision: result.revision,
      taskPresent: result.result.taskPresent,
    };
  }

  private async continueRemovalOperation(
    mutation: WorkspaceMutationRequest,
    initial: DurableTaskRemovalOperation,
    prior: { changed: boolean; revision: number },
  ): Promise<WorkspaceMutationResult<TaskRemovalMutationResult>> {
    let record = initial;
    if (record.phase === 'reserved-awaiting-activation') {
      return {
        changed: prior.changed,
        result: {
          deletionOperationId: record.deletionOperationId,
          removed: false,
          removalState: 'awaiting-linked-proof',
          taskId: record.taskId,
        },
        revision: prior.revision,
      };
    }
    if (record.phase === 'reserved-before-cleanup' && !record.cleanupComplete) {
      const drained = await this.drainParticipants(record);
      if (!drained) {
        return {
          changed: prior.changed,
          result: {
            deletionOperationId: record.deletionOperationId,
            removed: false,
            removalState: 'cleanup-pending',
            taskId: record.taskId,
          },
          revision: prior.revision,
        };
      }
      record = await this.markCleanupComplete(record);
      this.publishRecord(record, true);
    }

    let committedNow = false;
    let revision = prior.revision;
    if (record.phase === 'cleanup-complete-workspace-retry') {
      const committed = await this.commitCanonicalRemoval(mutation, record);
      record = committed.record;
      committedNow = committed.removed;
      revision = committed.revision;
      this.publishRecord(record, false);
    }

    if (record.phase === 'committed-finalizers-pending') {
      record = await this.runPendingFinalizers(record);
      this.publishRecord(record, false);
    }
    return {
      changed: committedNow,
      result: {
        deletionOperationId: record.deletionOperationId,
        ...(record.pendingFinalizers.length > 0
          ? { pendingFinalizers: [...record.pendingFinalizers] }
          : {}),
        removed: committedNow,
        removalState: record.phase === 'complete' ? 'complete' : 'finalizer-repair-pending',
        taskId: record.taskId,
      },
      revision,
    };
  }

  async repairTaskRemoval(taskId: string): Promise<TaskRemovalMutationResult | null> {
    requireIdentifier(taskId, 'taskId');
    if (this.availability.kind !== 'active') {
      throw new TaskRemovalOwnerCutoverError('Generic task removal is not active');
    }
    const loaded = await this.loadIndexedRecord(taskId);
    if (!loaded) return null;
    let record = loaded.record;
    this.publishRecord(record, loaded.taskPresent);
    if (record.phase === 'reserved-awaiting-activation') {
      return {
        deletionOperationId: record.deletionOperationId,
        removed: false,
        removalState: 'awaiting-linked-proof',
        taskId,
      };
    }
    if (
      record.phase === 'reserved-before-cleanup' ||
      record.phase === 'cleanup-complete-workspace-retry'
    ) {
      return {
        deletionOperationId: record.deletionOperationId,
        removed: false,
        removalState: 'cleanup-pending',
        taskId,
      };
    }
    if (record.phase === 'committed-finalizers-pending') {
      record = await this.runPendingFinalizers(record);
      this.publishRecord(record, false);
    }
    return {
      deletionOperationId: record.deletionOperationId,
      ...(record.pendingFinalizers.length > 0
        ? { pendingFinalizers: [...record.pendingFinalizers] }
        : {}),
      removed: false,
      removalState: record.phase === 'complete' ? 'complete' : 'finalizer-repair-pending',
      taskId,
    };
  }

  private async runActivation(
    participants: readonly TaskRemovalOwnerParticipant[],
  ): Promise<TaskRemovalOwnerCapability> {
    const candidates = createParticipantMap(participants);
    for (const id of TASK_REMOVAL_PARTICIPANT_IDS) {
      const participant = candidates.get(id) as TaskRemovalOwnerParticipant;
      const probe = await participant.probe();
      if (probe.kind !== 'ready' || probe.hookSetVersion !== participant.hookSetVersion) {
        throw new TaskRemovalOwnerCutoverError(
          `Dark removal participant ${id} is unavailable or mismatched`,
        );
      }
    }

    const hookSetVersions = Object.fromEntries(
      TASK_REMOVAL_PARTICIPANT_IDS.map((id) => [
        id,
        (candidates.get(id) as TaskRemovalOwnerParticipant).hookSetVersion,
      ]),
    ) as Record<TaskRemovalParticipantId, string>;
    const proposedEpoch = this.createCutoverEpoch();
    requireIdentifier(proposedEpoch, 'cutoverEpoch');
    const prepared = await this.privateAuthority.mutate(
      { operation: 'prepare-task-removal-owner-cutover' },
      (slices) => {
        const existing = readOwnerSchema(slices.privateState);
        if (existing) {
          for (const id of TASK_REMOVAL_PARTICIPANT_IDS) {
            if (existing.hookSetVersions[id] !== hookSetVersions[id]) {
              throw new TaskRemovalOwnerCutoverError(
                `Persisted removal hook version ${id} does not match`,
              );
            }
          }
          if (slices.privateState[OPERATIONS_KEY] === undefined) {
            throw new TaskRemovalOwnerRecoveryError('Task removal operation state is missing');
          }
          readOperationState(slices.privateState);
          return unchanged(existing);
        }
        const schema: TaskRemovalOwnerSchema = {
          catalogVersion: slices.sharedRevision,
          cutoverEpoch: proposedEpoch,
          hookSetVersions,
          legacyEffectsDisabled: false,
          phase: 'preparing',
          schemaVersion: TASK_REMOVAL_OWNER_SCHEMA_VERSION,
        };
        return changed(
          {
            nextPrivateState: withRemovalState(slices.privateState, schema, emptyOperationState()),
          },
          schema,
        );
      },
    );
    const epoch = prepared.result.cutoverEpoch;

    for (const id of PARTICIPANT_CUTOVER_ORDER) {
      await (candidates.get(id) as TaskRemovalOwnerParticipant).activateLegacyEffectCutover(epoch);
    }
    for (const id of PARTICIPANT_CUTOVER_ORDER) {
      await (candidates.get(id) as TaskRemovalOwnerParticipant).verifyLegacyEffectCutover(epoch);
    }

    await this.privateAuthority.mutate(
      { operation: 'activate-task-removal-owner-cutover' },
      (slices) => {
        const schema = readOwnerSchema(slices.privateState);
        if (!schema || schema.cutoverEpoch !== epoch) {
          throw new TaskRemovalOwnerRecoveryError('Task removal cutover epoch changed');
        }
        readOperationState(slices.privateState);
        for (const id of TASK_REMOVAL_PARTICIPANT_IDS) {
          if (schema.hookSetVersions[id] !== hookSetVersions[id]) {
            throw new TaskRemovalOwnerRecoveryError('Task removal hook registration changed');
          }
        }
        if (schema.phase === 'active' && schema.legacyEffectsDisabled) {
          return unchanged(undefined);
        }
        return changed(
          {
            nextPrivateState: withRemovalState(
              slices.privateState,
              { ...schema, legacyEffectsDisabled: true, phase: 'active' },
              readOperationState(slices.privateState),
            ),
          },
          undefined,
        );
      },
    );

    const verified = await this.privateAuthority.mutate(
      { operation: 'verify-task-removal-owner-cutover' },
      (slices) => {
        const schema = readOwnerSchema(slices.privateState);
        if (
          !schema ||
          schema.phase !== 'active' ||
          !schema.legacyEffectsDisabled ||
          schema.cutoverEpoch !== epoch
        ) {
          throw new TaskRemovalOwnerRecoveryError('Task removal owner cutover is incomplete');
        }
        const operations = readOperationState(slices.privateState);
        const tasks = requireTasks(slices.sharedState);
        for (const record of Object.values(operations.recordsByDeletionOperationId)) {
          const present = tasks[record.taskId] !== undefined;
          if (
            ((record.phase === 'reserved-awaiting-activation' ||
              record.phase === 'reserved-before-cleanup' ||
              record.phase === 'cleanup-complete-workspace-retry') &&
              !present) ||
            (record.phase !== 'reserved-awaiting-activation' &&
              record.phase !== 'reserved-before-cleanup' &&
              record.phase !== 'cleanup-complete-workspace-retry' &&
              present)
          ) {
            throw new TaskRemovalOwnerRecoveryError(
              `Task removal operation ${record.deletionOperationId} contradicts canonical membership`,
            );
          }
        }
        return unchanged({
          operations,
          privateState: slices.privateState,
          schema,
          sharedRevision: slices.sharedRevision,
          sharedState: slices.sharedState,
          taskIds: Object.keys(tasks),
        });
      },
    );

    this.participants = candidates;
    this.catalogVersion = Math.max(
      verified.result.schema.catalogVersion,
      verified.result.sharedRevision,
    );
    this.taskStates.clear();
    for (const taskId of verified.result.taskIds) this.taskStates.set(taskId, 'present');
    this.recordsByTaskId.clear();
    for (const record of Object.values(verified.result.operations.recordsByDeletionOperationId)) {
      this.recordsByTaskId.set(record.taskId, record);
      if (
        record.phase !== 'reserved-awaiting-activation' &&
        record.phase !== 'reserved-before-cleanup' &&
        record.phase !== 'cleanup-complete-workspace-retry'
      ) {
        this.taskStates.set(record.taskId, 'removed');
      }
    }
    this.notesCoordination.rebuild(
      verified.result.privateState,
      verified.result.sharedState,
      new Map(
        Object.values(verified.result.operations.recordsByDeletionOperationId)
          .filter((record) => record.phase !== 'reserved-awaiting-activation')
          .map((record) => [record.taskId, record.deletionOperationId]),
      ),
    );
    for (const record of this.recordsByTaskId.values()) {
      if (this.taskStates.get(record.taskId) === 'present' && record.taskClosing) {
        this.publishLifecycle({ closing: true, taskId: record.taskId });
      }
    }
    const capability: TaskRemovalOwnerCapability = {
      cutoverEpoch: epoch,
      hookSetVersions: { ...hookSetVersions },
      kind: 'active',
      schemaVersion: TASK_REMOVAL_OWNER_SCHEMA_VERSION,
    };
    this.availability = capability;
    return capability;
  }

  private getCurrentProjection(taskId: string): TaskRemovalCurrentProjection {
    const state = this.taskStates.get(taskId) ?? 'not-visible';
    const record = this.recordsByTaskId.get(taskId);
    return {
      catalogVersion: this.notesCoordination.getCatalogVersion(this.catalogVersion),
      serverInstanceId: this.serverInstanceId,
      taskClosing:
        state === 'present' &&
        (record?.taskClosing === true || this.notesCoordination.isTaskClosing(taskId)),
      taskState: state,
    };
  }

  private verifyCommittedRemoval<THookSetVersion extends string>(
    participantId: TaskRemovalParticipantId,
    expectedHookSetVersion: THookSetVersion,
    request: TaskRemovalIdentity,
  ): boolean {
    if (this.availability.kind !== 'active') return false;
    if (this.availability.hookSetVersions[participantId] !== expectedHookSetVersion) return false;
    const participant = this.participants.get(participantId);
    if (!participant || participant.hookSetVersion !== expectedHookSetVersion) return false;
    const record = this.recordsByTaskId.get(request.taskId);
    return (
      record?.deletionOperationId === request.deletionOperationId &&
      record.phase !== 'reserved-before-cleanup' &&
      record.phase !== 'cleanup-complete-workspace-retry' &&
      this.taskStates.get(request.taskId) === 'removed'
    );
  }

  private async readSharedRevision(): Promise<number> {
    const read = await this.privateAuthority.mutate(
      { operation: 'read-task-removal-shared-revision' },
      (slices) => unchanged(slices.sharedRevision),
    );
    return read.result;
  }

  private async reserveRemoval(
    taskId: string,
    deletionOperationId: string,
  ): Promise<{
    changed: boolean;
    record: DurableTaskRemovalOperation;
    revision: number;
    taskPresent: boolean;
  } | null> {
    requireIdentifier(deletionOperationId, 'deletionOperationId');
    const result = await this.privateAuthority.mutate(
      { operation: 'reserve-task-removal-operation' },
      (slices) => {
        const schema = readOwnerSchema(slices.privateState);
        if (!schema || schema.phase !== 'active' || !schema.legacyEffectsDisabled) {
          throw new TaskRemovalOwnerCutoverError('Generic task removal is not durably active');
        }
        const operations = readOperationState(slices.privateState);
        const existingId = operations.deletionOperationIdByTaskId[taskId];
        const existing = existingId
          ? operations.recordsByDeletionOperationId[existingId]
          : undefined;
        const present = requireTasks(slices.sharedState)[taskId] !== undefined;
        if (existing) {
          if (existing.phase === 'reserved-awaiting-activation') {
            throw new TaskRemovalOwnerConflictError(
              `Task ${taskId} has a merge-owned dormant removal`,
            );
          }
          if (
            (existing.phase === 'reserved-before-cleanup' ||
              existing.phase === 'cleanup-complete-workspace-retry') !== present
          ) {
            throw new TaskRemovalOwnerRecoveryError(
              `Task removal operation ${existing.deletionOperationId} contradicts task presence`,
            );
          }
          return unchanged({ record: existing, taskPresent: present });
        }
        if (!present) return unchanged(null);
        const collidingRecord = operations.recordsByDeletionOperationId[deletionOperationId];
        if (collidingRecord) {
          throw new TaskRemovalOwnerRecoveryError(
            `Deletion operation ${deletionOperationId} is already bound to another task`,
          );
        }
        const record: DurableTaskRemovalOperation = {
          cleanupPlan: createCleanupPlan(
            slices.sharedState,
            taskId,
            deletionOperationId,
            slices.sharedRevision,
          ),
          cleanupStepEvidence: {},
          completedCleanupSteps: [],
          deletionOperationId,
          pendingFinalizers: [...PARTICIPANT_FINALIZER_ORDER],
          phase: 'reserved-before-cleanup',
          recordVersion: 1,
          cleanupComplete: false,
          schemaVersion: 1,
          taskClosing: true,
          taskId,
        };
        operations.deletionOperationIdByTaskId[taskId] = deletionOperationId;
        operations.recordsByDeletionOperationId[deletionOperationId] = record;
        return changed(
          {
            nextPrivateState: withRemovalState(
              slices.privateState,
              {
                ...schema,
                catalogVersion: nextCatalogVersion(schema, slices.sharedRevision),
              },
              operations,
            ),
          },
          { record, taskPresent: true },
        );
      },
    );
    if (!result.result) return null;
    if (result.changed) this.catalogVersion += 1;
    return {
      changed: result.changed,
      record: result.result.record,
      revision: result.revision,
      taskPresent: result.result.taskPresent,
    };
  }

  private async loadIndexedRecord(taskId: string): Promise<{
    record: DurableTaskRemovalOperation;
    taskPresent: boolean;
  } | null> {
    const result = await this.privateAuthority.mutate(
      { operation: 'read-task-removal-operation' },
      (slices) => {
        const operations = readOperationState(slices.privateState);
        const operationId = operations.deletionOperationIdByTaskId[taskId];
        const record = operationId
          ? operations.recordsByDeletionOperationId[operationId]
          : undefined;
        return unchanged(
          record
            ? {
                record,
                taskPresent: requireTasks(slices.sharedState)[taskId] !== undefined,
              }
            : null,
        );
      },
    );
    return result.result;
  }

  private async drainParticipants(record: DurableTaskRemovalOperation): Promise<boolean> {
    for (const id of PARTICIPANT_FINALIZER_ORDER) {
      const participant = this.participants.get(id);
      if (!participant) return false;
      if (id === 'task-runtime') {
        let current = record;
        const requiredSteps = getRequiredCleanupSteps(current.cleanupPlan);
        while (current.completedCleanupSteps.length < requiredSteps.length) {
          const step = requiredSteps[current.completedCleanupSteps.length];
          if (!step || !participant.cleanupTaskRuntimeStep) return false;
          let result: TaskRemovalCleanupStepResult;
          try {
            result = await participant.cleanupTaskRuntimeStep({
              cleanupPlan: structuredClone(current.cleanupPlan),
              completedSteps: [...current.completedCleanupSteps],
              deletionOperationId: current.deletionOperationId,
              evidence: structuredClone(current.cleanupStepEvidence),
              step,
              taskId: current.taskId,
            });
          } catch {
            return false;
          }
          if (result.kind === 'retry-required') return false;
          if (result.step !== step) {
            throw new TaskRemovalOwnerRecoveryError(
              `Task runtime cleanup completed unexpected step ${result.step}`,
            );
          }
          current = await this.markCleanupStepComplete(current, step, result.evidence);
          this.publishRecord(current, true);
        }
        continue;
      }
      try {
        const result = await participant.drainTaskForRemoval({
          cleanupPlan: structuredClone(record.cleanupPlan),
          deletionOperationId: record.deletionOperationId,
          taskId: record.taskId,
        });
        if (result.kind === 'retry-required') return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async markCleanupStepComplete(
    expected: DurableTaskRemovalOperation,
    step: TaskRemovalCleanupStep,
    evidence: JsonObject,
  ): Promise<DurableTaskRemovalOperation> {
    if (Buffer.byteLength(canonicalJsonStringify(evidence), 'utf8') > 4_096) {
      throw new TaskRemovalOwnerRecoveryError(`Task removal ${step} evidence is too large`);
    }
    const result = await this.privateAuthority.mutate(
      { operation: `complete-task-removal-cleanup-${step}` },
      (slices) => {
        const schema = readOwnerSchema(slices.privateState);
        if (!schema || schema.phase !== 'active') {
          throw new TaskRemovalOwnerCutoverError('Generic task removal is unavailable');
        }
        const operations = readOperationState(slices.privateState);
        const current = operations.recordsByDeletionOperationId[expected.deletionOperationId];
        if (!current || current.taskId !== expected.taskId) {
          throw new TaskRemovalOwnerRecoveryError('Task removal operation disappeared');
        }
        if (current.completedCleanupSteps.includes(step)) return unchanged(current);
        const requiredSteps = getRequiredCleanupSteps(current.cleanupPlan);
        if (
          current.phase !== 'reserved-before-cleanup' ||
          current.cleanupComplete ||
          requiredSteps[current.completedCleanupSteps.length] !== step
        ) {
          throw new TaskRemovalOwnerRecoveryError('Task removal cleanup step is out of order');
        }
        const next: DurableTaskRemovalOperation = {
          ...current,
          cleanupStepEvidence: {
            ...current.cleanupStepEvidence,
            [step]: cloneJsonObject(evidence),
          },
          completedCleanupSteps: [...current.completedCleanupSteps, step],
          recordVersion: current.recordVersion + 1,
        };
        operations.recordsByDeletionOperationId[current.deletionOperationId] = next;
        return changed(
          { nextPrivateState: withRemovalState(slices.privateState, schema, operations) },
          next,
        );
      },
    );
    return result.result;
  }

  private async markCleanupComplete(
    expected: DurableTaskRemovalOperation,
  ): Promise<DurableTaskRemovalOperation> {
    const result = await this.privateAuthority.mutate(
      { operation: 'complete-task-removal-runners-drain' },
      (slices) => {
        const schema = readOwnerSchema(slices.privateState);
        if (!schema || schema.phase !== 'active') {
          throw new TaskRemovalOwnerCutoverError('Generic task removal is unavailable');
        }
        const operations = readOperationState(slices.privateState);
        const current = operations.recordsByDeletionOperationId[expected.deletionOperationId];
        if (!current || current.taskId !== expected.taskId) {
          throw new TaskRemovalOwnerRecoveryError('Task removal operation disappeared');
        }
        if (current.cleanupComplete) return unchanged(current);
        if (current.phase !== 'reserved-before-cleanup') {
          throw new TaskRemovalOwnerRecoveryError('Task removal drain phase is invalid');
        }
        const next = {
          ...current,
          phase: 'cleanup-complete-workspace-retry' as const,
          recordVersion: current.recordVersion + 1,
          cleanupComplete: true,
        };
        operations.recordsByDeletionOperationId[current.deletionOperationId] = next;
        return changed(
          { nextPrivateState: withRemovalState(slices.privateState, schema, operations) },
          next,
        );
      },
    );
    return result.result;
  }

  private async commitCanonicalRemoval(
    mutation: WorkspaceMutationRequest,
    expected: DurableTaskRemovalOperation,
  ): Promise<{
    record: DurableTaskRemovalOperation;
    removed: boolean;
    revision: number;
  }> {
    this.notesCoordination.beginCanonicalStructureWrite();
    try {
      const result = await this.privateAuthority.mutate(mutation, (slices) => {
        const schema = readOwnerSchema(slices.privateState);
        if (!schema || schema.phase !== 'active') {
          throw new TaskRemovalOwnerCutoverError('Generic task removal is unavailable');
        }
        const operations = readOperationState(slices.privateState);
        const current = operations.recordsByDeletionOperationId[expected.deletionOperationId];
        if (!current || current.taskId !== expected.taskId) {
          throw new TaskRemovalOwnerRecoveryError('Task removal operation disappeared');
        }
        const tasks = requireTasks(slices.sharedState);
        if (current.phase !== 'cleanup-complete-workspace-retry') {
          if (tasks[current.taskId] !== undefined) {
            throw new TaskRemovalOwnerRecoveryError(
              'Committed removal still has canonical task state',
            );
          }
          return unchanged({ record: current, removed: false });
        }
        if (!current.cleanupComplete) {
          throw new TaskRemovalOwnerRecoveryError('Task removal cleanup is incomplete');
        }
        if (tasks[current.taskId] === undefined) {
          throw new TaskRemovalOwnerRecoveryError('Task disappeared before its removal commit');
        }
        const removedTask = tasks[current.taskId];
        if (!isJsonObject(removedTask)) {
          throw new TaskRemovalOwnerRecoveryError('Canonical removed task is invalid');
        }
        const taskOrder = requireOrder(slices.sharedState, 'taskOrder');
        const collapsedTaskOrder = requireOrder(slices.sharedState, 'collapsedTaskOrder');
        const nextTasks = cloneJsonObject(tasks);
        Reflect.deleteProperty(nextTasks, current.taskId);
        let nextShared = cloneJsonObject(slices.sharedState);
        nextShared.tasks = nextTasks;
        nextShared.taskOrder = taskOrder.filter((id) => id !== current.taskId);
        nextShared.collapsedTaskOrder = collapsedTaskOrder.filter((id) => id !== current.taskId);
        let committedProgressVersion: number | undefined;
        if (current.commitExtension) {
          if (
            current.commitExtension.state !== 'linked-proof-ready' ||
            current.commitExtension.committedAt === undefined ||
            current.commitExtension.linesAdded === undefined ||
            current.commitExtension.linesRemoved === undefined ||
            getProtectedPolicyVersions(slices.privateState)['merge-progress'] !== '1'
          ) {
            throw new TaskRemovalOwnerRecoveryError('Linked merge commit extension is not ready');
          }
          const committedProgress = commitCompletedMergeProgress({
            committedAt: new Date(current.commitExtension.committedAt),
            linesAdded: current.commitExtension.linesAdded,
            linesRemoved: current.commitExtension.linesRemoved,
            operationId: current.deletionOperationId,
            removedTask,
            stateAfterRemoval: nextShared,
          });
          nextShared = committedProgress.nextSharedState;
          committedProgressVersion = committedProgress.progress.version;
        }
        const next: DurableTaskRemovalOperation = {
          ...current,
          ...(current.commitExtension && committedProgressVersion !== undefined
            ? {
                commitExtension: {
                  ...current.commitExtension,
                  progressVersionAtCommit: committedProgressVersion,
                },
              }
            : {}),
          phase: 'committed-finalizers-pending',
          recordVersion: current.recordVersion + 1,
          taskClosing: true,
          workspaceRevision: slices.sharedRevision + 1,
        };
        operations.recordsByDeletionOperationId[current.deletionOperationId] = next;
        const removalPrivateState = withRemovalState(
          slices.privateState,
          {
            ...schema,
            catalogVersion: nextCatalogVersion(schema, slices.sharedRevision),
          },
          operations,
        );
        return changed(
          {
            nextPrivateState: this.notesCoordination.withoutTaskIdentity(
              removalPrivateState,
              current.taskId,
            ),
            nextSharedState: nextShared,
          },
          { record: next, removed: true },
        );
      });
      if (result.result.removed) {
        this.catalogVersion += 1;
        this.publishRecord(result.result.record, false);
      }
      return { ...result.result, revision: result.revision };
    } finally {
      this.notesCoordination.endCanonicalStructureWrite();
    }
  }

  private async runPendingFinalizers(
    initial: DurableTaskRemovalOperation,
  ): Promise<DurableTaskRemovalOperation> {
    let record = initial;
    for (const id of PARTICIPANT_FINALIZER_ORDER) {
      if (!record.pendingFinalizers.includes(id)) continue;
      const participant = this.participants.get(id);
      if (!participant) return record;
      if (record.workspaceRevision === undefined) {
        throw new TaskRemovalOwnerRecoveryError('Task removal finalizer has no commit revision');
      }
      let result: TaskRemovalParticipantStepResult;
      try {
        result = await participant.finalizeRemovedTaskState({
          cleanupPlan: structuredClone(record.cleanupPlan),
          deletionOperationId: record.deletionOperationId,
          removedWorkspaceRevision: record.workspaceRevision,
          taskId: record.taskId,
        });
      } catch {
        return record;
      }
      if (result.kind === 'retry-required') return record;
      try {
        record = await this.markFinalizerComplete(record, id);
      } catch {
        return record;
      }
    }
    return record;
  }

  private async markFinalizerComplete(
    expected: DurableTaskRemovalOperation,
    participantId: TaskRemovalParticipantId,
  ): Promise<DurableTaskRemovalOperation> {
    const result = await this.privateAuthority.mutate(
      { operation: `complete-task-removal-finalizer-${participantId}` },
      (slices) => {
        const schema = readOwnerSchema(slices.privateState);
        if (!schema || schema.phase !== 'active') {
          throw new TaskRemovalOwnerCutoverError('Generic task removal is unavailable');
        }
        const operations = readOperationState(slices.privateState);
        const current = operations.recordsByDeletionOperationId[expected.deletionOperationId];
        if (!current || current.taskId !== expected.taskId) {
          throw new TaskRemovalOwnerRecoveryError('Task removal operation disappeared');
        }
        if (current.phase === 'complete') return unchanged(current);
        if (current.phase !== 'committed-finalizers-pending') {
          throw new TaskRemovalOwnerRecoveryError('Task removal finalizer phase is invalid');
        }
        if (!current.pendingFinalizers.includes(participantId)) return unchanged(current);
        const pendingFinalizers = current.pendingFinalizers.filter((id) => id !== participantId);
        const next: DurableTaskRemovalOperation = {
          ...current,
          pendingFinalizers,
          phase: pendingFinalizers.length === 0 ? 'complete' : 'committed-finalizers-pending',
          recordVersion: current.recordVersion + 1,
          taskClosing: pendingFinalizers.length > 0,
        };
        operations.recordsByDeletionOperationId[current.deletionOperationId] = next;
        return changed(
          { nextPrivateState: withRemovalState(slices.privateState, schema, operations) },
          next,
        );
      },
    );
    return result.result;
  }

  private publishRecord(record: DurableTaskRemovalOperation, taskPresent: boolean): void {
    const prior = this.recordsByTaskId.get(record.taskId);
    const wasPresent = this.taskStates.get(record.taskId) === 'present';
    const wasClosing = wasPresent && prior?.taskClosing === true;
    this.recordsByTaskId.set(record.taskId, record);
    this.taskStates.set(record.taskId, taskPresent ? 'present' : 'removed');
    if (taskPresent && wasClosing !== record.taskClosing) {
      this.publishLifecycle({ closing: record.taskClosing, taskId: record.taskId });
    }
  }

  private publishLifecycle(event: TaskRemovalLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener({ ...event });
      } catch {
        // Catalog replacement remains the convergence path for a failed projection listener.
      }
    }
  }
}
