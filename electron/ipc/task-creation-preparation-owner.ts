import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isTaskCatalogCursor, isTaskCatalogIdentifier } from '../../src/domain/task-catalog.js';
import type {
  GetTaskCreationPickerPageRequest,
  GetTaskWorktreeLinkCandidatesRequest,
  GetTaskWorktreeLinkCandidatesResult,
  TaskCreationCapabilities,
  TaskCreationIntent,
  TaskCreationPickerItem,
  TaskCreationPickerPage,
  TaskWorktreeLinkWarning,
} from '../../src/domain/task-creation.js';
import type { TaskCreationTicketAuthenticationContext } from '../../src/domain/task-creation-ticket.js';
import {
  isTaskCreationOperationLink,
  isTaskCreationProvenance,
  isTaskInitialShellOwnership,
} from '../../src/domain/task-creation-provenance.js';
import type { AgentDef } from '../../src/ipc/types.js';
import { getAgentDefsWithLastKnownAvailability } from './agents.js';
import { listBranches } from './git-branch.js';
import { getGitRepoRoot, listImportableWorktrees } from './git.js';
import { withRepositoryWorktreeLock } from './git-worktree-lock.js';
import {
  admitPreparedSharedRootTask,
  releasePreparedSharedRootTask,
} from './task-shared-root-admission.js';
import { listGitWorktrees } from './git-worktree.js';
import {
  encodeTaskWorktreeLinkRequestV1,
  getWorktreeSymlinkCandidates,
  type TaskWorktreeLinkRequestV1,
} from './git-worktree-symlinks.js';
import {
  createNormalizedTaskCreationSemanticRequestV1,
  deriveTaskCreationConflictKey,
  taskCreationConflictKeyId,
  type NormalizedTaskCreationSemanticRequestV1,
  type TaskCreationJournalRecord,
  type TaskCreationJournalReconciliationState,
  type TaskCreationReconciliationResource,
} from './task-creation-journal.js';
import {
  TaskCreationPreparationManualReconciliationError,
  type TaskCreationAllocatedIdentities,
  type TaskCreationCommitFailureReconciliation,
  type TaskCreationIntentNormalization,
  type TaskCreationIntentResolution,
  type TaskCreationPreparedTask,
  type TaskCreationPreparationOwner,
  type TaskCreationResolvedIntent,
} from './task-creation-workflow.js';
import {
  createCurrentBranchTask,
  createNonGitTask,
  createPlannedManagedTask,
  importExistingWorktreeTask,
  planManagedTaskLocation,
  type PlannedManagedTaskLocation,
} from './tasks.js';
import {
  claimManagedWorktreeRecoveryQuarantine,
  getManagedWorktreeRecoveryQuarantinePath,
  inspectManagedWorktreeRecoveryQuarantine,
  type ManagedWorktreeRecoveryQuarantineRequest,
  type RetainedManagedWorktreeRecoveryEvidence,
} from './task-worktree-removal.js';
import type {
  TaskCreationReconciliationAbsenceProbe,
  TaskCreationReconciliationCommittedMappingProbe,
} from './task-creation-reconciliation.js';
import {
  changed,
  unchanged,
  type WorkspacePrivateMutationAuthority,
} from './workspace-state-mutations.js';
import { cloneJsonObject, type JsonObject, type JsonValue } from './workspace-state-storage.js';

const PRIVATE_SEGMENT_KEY = 'taskCreationPreparationOwnerV1';
const PRIVATE_SEGMENT_FORMAT_VERSION = 1;
const MAX_PREPARATION_RECORDS = 4_096;
const PICKER_PAGE_SIZE = 50;
const PICKER_SNAPSHOT_LIMIT = 64;
const PICKER_SNAPSHOT_TTL_MS = 60_000;
const PICKER_ITEM_LIMIT = 2_000;
const PICKER_REFERENCE_PATTERN = /^(?:b|w)_[A-Za-z0-9_-]{43}$/u;
const PICKER_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const WORKTREE_WARNING_REASONS = new Set<TaskWorktreeLinkWarning['reason']>([
  'candidate_query_failed',
  'destination_exists',
  'exclude_update_failed',
  'ignore_postcondition_failed',
  'invalid_name',
  'link_failed',
  'not_current_candidate',
  'reserved_name',
  'source_missing',
  'source_symlink',
  'unsupported_source_kind',
]);

interface CanonicalProject {
  baseBranch?: string;
  branchPrefix?: string;
  id: string;
  mode: 'git' | 'non-git';
  root: string;
}

interface CanonicalWorkspaceSnapshot {
  project: CanonicalProject;
  sharedRevision: number;
  sharedState: JsonObject;
}

interface ManagedPreparationRecord {
  baseBranch: string | null;
  branchName: string;
  createdAtMs: number;
  operationId: string;
  projectId: string;
  projectRoot: string;
  state: 'planned' | 'prepared';
  taskId: string;
  warnings: TaskWorktreeLinkWarning[];
  worktreePath: string;
}

interface PickerSnapshot {
  catalogVersion: number;
  expiresAtMs: number;
  generation: number;
  id: string;
  items: TaskCreationPickerItem[];
  kind: GetTaskCreationPickerPageRequest['kind'];
  projectId: string;
  query: string;
  sourceTruncated: boolean;
}

export interface ProductionTaskCreationPreparationAdapters {
  claimManagedWorktreeRecoveryQuarantine(
    request: Readonly<ManagedWorktreeRecoveryQuarantineRequest>,
  ): Promise<RetainedManagedWorktreeRecoveryEvidence>;
  createCurrentBranchTask: typeof createCurrentBranchTask;
  createNonGitTask: typeof createNonGitTask;
  createPlannedManagedTask: typeof createPlannedManagedTask;
  getAgentDefinitions(sharedState: Readonly<JsonObject>): AgentDef[];
  getGitRepoRoot: typeof getGitRepoRoot;
  getWorktreeSymlinkCandidates: typeof getWorktreeSymlinkCandidates;
  importExistingWorktreeTask: typeof importExistingWorktreeTask;
  listBranches: typeof listBranches;
  listGitWorktrees: typeof listGitWorktrees;
  listImportableWorktrees: typeof listImportableWorktrees;
  now(): number;
  planManagedTaskLocation: typeof planManagedTaskLocation;
  randomBytes(length: number): Uint8Array;
}

export interface CreateProductionTaskCreationPreparationOwnerDependencies {
  adapters?: Partial<ProductionTaskCreationPreparationAdapters>;
  privateAuthority: WorkspacePrivateMutationAuthority;
  serverInstanceId: string;
}

export interface TrustedLocalTaskCreationSelectionRequest {
  baseBranch?: string;
  existingWorktreePath?: string;
  projectId: string;
  projectMode?: 'git' | 'non-git';
  projectRoot: string;
}

export interface TrustedLocalTaskCreationSelection {
  baseBranchRef?: string;
  existingWorktreeRef?: string;
  projectMode: 'git' | 'non-git';
}

/**
 * Production-only extension for trusted local adapters that still carry raw
 * branch/path selections. Remote callers continue to use opaque picker refs;
 * this method re-resolves local selections against current canonical state.
 */
export interface ProductionTaskCreationPreparationOwner extends TaskCreationPreparationOwner {
  /** Exact local recovery proofs backed by this owner's private preparation records. */
  reconciliation: ProductionTaskCreationReconciliationProofOwner;
  /** Pure trusted-adapter mapping; it does not inspect the project, Git, or workspace. */
  normalizeTrustedLocalSelection(
    request: Readonly<TrustedLocalTaskCreationSelectionRequest>,
  ): TrustedLocalTaskCreationSelection;
  resolveTrustedLocalSelection(
    request: Readonly<TrustedLocalTaskCreationSelectionRequest>,
  ): Promise<TrustedLocalTaskCreationSelection>;
}

export interface ProductionTaskCreationReconciliationProofOwner {
  inspect(record: Readonly<TaskCreationJournalRecord>): Promise<void>;
  probeCommittedMapping(
    record: Readonly<TaskCreationJournalRecord>,
    expectedTaskId: string,
  ): Promise<TaskCreationReconciliationCommittedMappingProbe>;
  probeOwnedArtifactAbsence(
    record: Readonly<TaskCreationJournalRecord>,
    resource: Readonly<TaskCreationReconciliationResource>,
  ): Promise<TaskCreationReconciliationAbsenceProbe>;
  probeRecoveryQuarantineAbsence(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<TaskCreationReconciliationAbsenceProbe>;
  revealRecoveryQuarantine(
    record: Readonly<TaskCreationJournalRecord>,
    reveal: (quarantinePath: string) => void,
  ): Promise<'proof-insufficient' | 'revealed'>;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function cloneAgentDefinition(value: JsonValue | undefined): AgentDef | null {
  if (!isJsonObject(value)) return null;
  if (
    typeof value.id !== 'string' ||
    !isTaskCatalogIdentifier(value.id) ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    typeof value.command !== 'string' ||
    value.command.trim().length === 0 ||
    typeof value.description !== 'string' ||
    !isStringArray(value.args) ||
    !isStringArray(value.resume_args) ||
    !isStringArray(value.skip_permissions_args) ||
    (value.adapter !== undefined && value.adapter !== 'hydra')
  ) {
    return null;
  }
  let env: Record<string, string> | undefined;
  if (value.env !== undefined) {
    if (
      !isJsonObject(value.env) ||
      Object.values(value.env).some((entry) => typeof entry !== 'string')
    ) {
      return null;
    }
    env = Object.fromEntries(Object.entries(value.env)) as Record<string, string>;
  }
  return {
    args: [...value.args],
    command: value.command,
    description: value.description,
    id: value.id,
    name: value.name,
    resume_args: [...value.resume_args],
    skip_permissions_args: [...value.skip_permissions_args],
    ...(value.adapter === 'hydra' ? { adapter: 'hydra' as const } : {}),
    ...(env ? { env } : {}),
    ...(value.resume_strategy === 'cli-args' ||
    value.resume_strategy === 'hydra-session' ||
    value.resume_strategy === 'none'
      ? { resume_strategy: value.resume_strategy }
      : {}),
  };
}

function getCanonicalAgentDefinitions(sharedState: Readonly<JsonObject>): AgentDef[] {
  const hydraCommand = typeof sharedState.hydraCommand === 'string' ? sharedState.hydraCommand : '';
  const custom = Array.isArray(sharedState.customAgents)
    ? sharedState.customAgents.flatMap((entry) => {
        const definition = cloneAgentDefinition(entry);
        return definition ? [definition] : [];
      })
    : [];
  const customIds = new Set(custom.map((definition) => definition.id));
  return [
    ...getAgentDefsWithLastKnownAvailability(hydraCommand).filter(
      (definition) => !customIds.has(definition.id),
    ),
    ...custom,
  ];
}

const DEFAULT_ADAPTERS: ProductionTaskCreationPreparationAdapters = {
  claimManagedWorktreeRecoveryQuarantine,
  createCurrentBranchTask,
  createNonGitTask,
  createPlannedManagedTask,
  getAgentDefinitions: getCanonicalAgentDefinitions,
  getGitRepoRoot,
  getWorktreeSymlinkCandidates,
  importExistingWorktreeTask,
  listBranches,
  listGitWorktrees,
  listImportableWorktrees,
  now: Date.now,
  planManagedTaskLocation,
  randomBytes,
};

function requireProject(sharedState: Readonly<JsonObject>, projectId: string): CanonicalProject {
  if (!Array.isArray(sharedState.projects)) throw new Error('Canonical projects are unavailable');
  const value = sharedState.projects.find((entry) => isJsonObject(entry) && entry.id === projectId);
  if (!isJsonObject(value) || typeof value.path !== 'string' || value.path.trim().length === 0) {
    throw new Error('Selected project is unavailable');
  }
  return {
    ...(typeof value.baseBranch === 'string' && value.baseBranch.trim()
      ? { baseBranch: value.baseBranch.trim() }
      : {}),
    ...(typeof value.branchPrefix === 'string' && value.branchPrefix.trim()
      ? { branchPrefix: value.branchPrefix.trim() }
      : {}),
    id: projectId,
    mode: value.projectMode === 'non-git' ? 'non-git' : 'git',
    root: path.resolve(value.path),
  };
}

function taskTracksProjectRootSteps(
  sharedState: Readonly<JsonObject>,
  project: CanonicalProject,
  exceptCreationOperationId?: string,
): boolean {
  if (!isJsonObject(sharedState.tasks)) return false;
  return Object.values(sharedState.tasks).some(
    (task) =>
      isJsonObject(task) &&
      task.stepsTracking === true &&
      typeof task.worktreePath === 'string' &&
      path.resolve(task.worktreePath) === project.root &&
      (!isJsonObject(task.taskCreationOperationLink) ||
        task.taskCreationOperationLink.creationOperationId !== exceptCreationOperationId),
  );
}

function registeredWorktreePaths(sharedState: Readonly<JsonObject>, projectId: string): string[] {
  if (!isJsonObject(sharedState.tasks)) return [];
  return Object.values(sharedState.tasks).flatMap((task) =>
    isJsonObject(task) && task.projectId === projectId && typeof task.worktreePath === 'string'
      ? [task.worktreePath]
      : [],
  );
}

function truncateUtf8(value: string, maxBytes = 256): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '…';
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character + suffix, 'utf8') > maxBytes) break;
    result += character;
  }
  return `${result}${suffix}`;
}

function isManagedPreparationRecord(value: JsonValue | undefined): value is JsonObject {
  if (!isJsonObject(value)) return false;
  return (
    (value.state === 'planned' || value.state === 'prepared') &&
    typeof value.operationId === 'string' &&
    typeof value.taskId === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.projectRoot === 'string' &&
    typeof value.branchName === 'string' &&
    typeof value.worktreePath === 'string' &&
    (value.baseBranch === null || typeof value.baseBranch === 'string') &&
    typeof value.createdAtMs === 'number' &&
    Number.isFinite(value.createdAtMs) &&
    Array.isArray(value.warnings)
  );
}

function decodeManagedPreparationRecord(
  value: JsonValue | undefined,
): ManagedPreparationRecord | null {
  if (!isManagedPreparationRecord(value)) return null;
  const rawWarnings = value.warnings as JsonValue[];
  const warnings = rawWarnings.flatMap((warning) => {
    if (
      !isJsonObject(warning) ||
      typeof warning.name !== 'string' ||
      typeof warning.reason !== 'string' ||
      !WORKTREE_WARNING_REASONS.has(warning.reason as TaskWorktreeLinkWarning['reason']) ||
      typeof warning.message !== 'string'
    ) {
      return [];
    }
    return [
      {
        message: warning.message,
        name: warning.name,
        reason: warning.reason,
      } as TaskWorktreeLinkWarning,
    ];
  });
  if (warnings.length !== rawWarnings.length) return null;
  return {
    baseBranch: value.baseBranch as string | null,
    branchName: value.branchName as string,
    createdAtMs: value.createdAtMs as number,
    operationId: value.operationId as string,
    projectId: value.projectId as string,
    projectRoot: value.projectRoot as string,
    state: value.state as 'planned' | 'prepared',
    taskId: value.taskId as string,
    warnings,
    worktreePath: value.worktreePath as string,
  };
}

function requirePrivateSegment(privateState: Readonly<JsonObject>): JsonObject {
  const segment = privateState[PRIVATE_SEGMENT_KEY];
  if (
    !isJsonObject(segment) ||
    segment.formatVersion !== PRIVATE_SEGMENT_FORMAT_VERSION ||
    typeof segment.pickerReferenceKey !== 'string' ||
    !PICKER_KEY_PATTERN.test(segment.pickerReferenceKey) ||
    !isJsonObject(segment.preparations)
  ) {
    throw new Error('Task-creation preparation owner is not activated');
  }
  for (const [operationId, value] of Object.entries(segment.preparations)) {
    const record = decodeManagedPreparationRecord(value);
    if (!record || record.operationId !== operationId) {
      throw new Error('Task-creation preparation state requires recovery');
    }
  }
  return segment;
}

function operationResourceId(operationId: string, resource: string): string {
  return `p_${createHmac('sha256', operationId).update(resource, 'utf8').digest('base64url').slice(0, 32)}`;
}

function sameConflictKey(
  left: Readonly<TaskCreationReconciliationResource['conflictKey']>,
  right: Readonly<TaskCreationReconciliationResource['conflictKey']>,
): boolean {
  return left.kind === right.kind && left.digest === right.digest;
}

function artifactAmbiguity(
  operationId: string,
  kind: 'managed-worktree' | 'task',
  identity: string,
): Exclude<TaskCreationJournalReconciliationState, { kind: 'none' }> {
  return {
    kind: 'artifact-ambiguous',
    resources: [
      {
        conflictKey: deriveTaskCreationConflictKey(kind, identity),
        resourceId: operationResourceId(operationId, identity),
      },
    ],
  };
}

class ProductionTaskCreationPreparationOwnerImpl implements ProductionTaskCreationPreparationOwner {
  private readonly adapters: ProductionTaskCreationPreparationAdapters;
  private readonly pickerSnapshots = new Map<string, PickerSnapshot>();
  private pickerGeneration = 0;
  readonly reconciliation: ProductionTaskCreationReconciliationProofOwner;

  constructor(
    private readonly dependencies: CreateProductionTaskCreationPreparationOwnerDependencies,
    private readonly pickerReferenceKey: string,
  ) {
    this.adapters = { ...DEFAULT_ADAPTERS, ...dependencies.adapters };
    if (!isTaskCatalogIdentifier(dependencies.serverInstanceId)) {
      throw new Error('Task-creation preparation server identity is invalid');
    }
    const reconciliation: ProductionTaskCreationReconciliationProofOwner = {
      inspect: (record) => this.inspectReconciliationRecord(record),
      probeCommittedMapping: (record, expectedTaskId) =>
        this.probeCommittedMapping(record, expectedTaskId),
      probeOwnedArtifactAbsence: (record, resource) =>
        this.probeOwnedArtifactAbsence(record, resource),
      probeRecoveryQuarantineAbsence: (record) => this.probeRecoveryQuarantineAbsence(record),
      revealRecoveryQuarantine: (record, reveal) => this.revealRecoveryQuarantine(record, reveal),
    };
    this.reconciliation = Object.freeze(reconciliation);
  }

  getCapabilities(): TaskCreationCapabilities {
    const enabled = { enabled: true } as const;
    return {
      coordinator: { reason: 'coordinator-not-supported', supported: false },
      enabled: true,
      locations: {
        'existing-worktree': enabled,
        'managed-worktree': enabled,
        'project-root': enabled,
      },
      modes: { agent: enabled, terminal: enabled },
      permissionBypass: enabled,
    };
  }

  async getPickerPage(
    request: Readonly<GetTaskCreationPickerPageRequest>,
  ): Promise<TaskCreationPickerPage> {
    const query = request.query?.trim().toLowerCase() ?? '';
    let snapshot: PickerSnapshot;
    let offset = 0;
    if (request.cursor) {
      const parsed = this.parseCursor(request.cursor);
      const retained = parsed ? this.pickerSnapshots.get(parsed.snapshotId) : undefined;
      if (
        !retained ||
        retained.expiresAtMs <= this.adapters.now() ||
        retained.projectId !== request.projectId ||
        retained.kind !== request.kind ||
        retained.query !== query
      ) {
        throw new Error('Task-creation picker snapshot is stale');
      }
      snapshot = retained;
      offset = parsed?.offset ?? 0;
    } else {
      snapshot = await this.createPickerSnapshot(request.projectId, request.kind, query);
    }
    if (offset > snapshot.items.length) throw new Error('Task-creation picker cursor is stale');
    const items = snapshot.items.slice(offset, offset + PICKER_PAGE_SIZE);
    const nextOffset = offset + items.length;
    const nextCursor =
      nextOffset < snapshot.items.length ? this.createCursor(snapshot.id, nextOffset) : null;
    return {
      catalogVersion: snapshot.catalogVersion,
      generation: snapshot.generation,
      items: structuredClone(items),
      kind: snapshot.kind,
      nextCursor,
      serverInstanceId: this.dependencies.serverInstanceId,
      truncated: snapshot.sourceTruncated || nextCursor !== null,
    };
  }

  async getWorktreeLinkCandidates(
    request: Readonly<GetTaskWorktreeLinkCandidatesRequest>,
  ): Promise<GetTaskWorktreeLinkCandidatesResult> {
    const canonical = await this.readProject(request.projectId, 'read-link-candidates');
    if (canonical.project.mode !== 'git') return { kind: 'unavailable' };
    try {
      const result = await this.adapters.getWorktreeSymlinkCandidates(canonical.project.root);
      return { candidates: result.candidates, kind: 'found', truncated: result.truncated };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  normalizeTrustedLocalSelection(
    request: Readonly<TrustedLocalTaskCreationSelectionRequest>,
  ): TrustedLocalTaskCreationSelection {
    const projectMode = request.projectMode ?? 'git';
    if (
      projectMode === 'non-git' &&
      (request.baseBranch !== undefined || request.existingWorktreePath !== undefined)
    ) {
      throw new Error('Git selections are unavailable for this project');
    }
    return {
      ...(request.baseBranch !== undefined
        ? { baseBranchRef: this.reference('base-branch', request.projectId, request.baseBranch) }
        : {}),
      ...(request.existingWorktreePath !== undefined
        ? {
            existingWorktreeRef: this.reference(
              'existing-worktree',
              request.projectId,
              path.resolve(request.existingWorktreePath),
            ),
          }
        : {}),
      projectMode,
    };
  }

  async resolveTrustedLocalSelection(
    request: Readonly<TrustedLocalTaskCreationSelectionRequest>,
  ): Promise<TrustedLocalTaskCreationSelection> {
    const normalized = this.normalizeTrustedLocalSelection(request);
    const canonical = await this.readProject(request.projectId, 'resolve-trusted-local-selection');
    const { project } = canonical;
    if (
      path.resolve(request.projectRoot) !== project.root ||
      (request.projectMode !== undefined && request.projectMode !== project.mode)
    ) {
      throw new Error('Selected project changed before task creation');
    }
    if (
      project.mode === 'non-git' &&
      (request.baseBranch !== undefined || request.existingWorktreePath !== undefined)
    ) {
      throw new Error('Git selections are unavailable for this project');
    }

    let resolvedBaseBranch: string | undefined;
    let baseBranchRef: string | undefined;
    if (request.baseBranch !== undefined) {
      const branches = await this.adapters.listBranches(project.root);
      const match = branches.branches.find((branch) => branch.name === request.baseBranch);
      if (!match) throw new Error('Selected base branch is no longer available');
      resolvedBaseBranch = match.name;
      baseBranchRef = this.reference('base-branch', project.id, match.name);
    }

    let existingWorktreeRef: string | undefined;
    if (request.existingWorktreePath !== undefined) {
      const effectiveBaseBranch = resolvedBaseBranch ?? project.baseBranch;
      const worktrees = await this.adapters.listImportableWorktrees(project.root, {
        ...(effectiveBaseBranch ? { baseBranch: effectiveBaseBranch } : {}),
        registeredWorktreePaths: registeredWorktreePaths(canonical.sharedState, project.id),
      });
      const selectedPath = path.resolve(request.existingWorktreePath);
      const match = worktrees.find((worktree) => path.resolve(worktree.path) === selectedPath);
      if (!match) throw new Error('Selected existing worktree is no longer available');
      existingWorktreeRef = this.reference('existing-worktree', project.id, selectedPath);
    }

    return {
      ...(baseBranchRef ? { baseBranchRef: normalized.baseBranchRef } : {}),
      ...(existingWorktreeRef ? { existingWorktreeRef: normalized.existingWorktreeRef } : {}),
      projectMode: project.mode,
    };
  }

  normalizeIntent(intent: Readonly<TaskCreationIntent>): TaskCreationIntentNormalization {
    if (
      (intent.baseBranchRef !== undefined &&
        !this.isReference(intent.baseBranchRef, 'base-branch')) ||
      (intent.location.kind === 'existing-worktree' &&
        !this.isReference(intent.location.worktreeRef, 'existing-worktree'))
    ) {
      return { code: 'capability-denied', kind: 'rejected' };
    }
    try {
      const location =
        intent.location.kind === 'managed-worktree'
          ? {
              kind: 'managed-worktree' as const,
              worktreeLinkRequest: encodeTaskWorktreeLinkRequestV1(
                intent.location.requestedLinkNames,
              ),
            }
          : intent.location.kind === 'existing-worktree'
            ? { kind: 'existing-worktree' as const, worktreeRef: intent.location.worktreeRef }
            : { kind: 'project-root' as const };
      const semanticRequest = createNormalizedTaskCreationSemanticRequestV1({
        ...(intent.baseBranchRef !== undefined ? { baseBranchRef: intent.baseBranchRef } : {}),
        ...(intent.branchPrefixPreference !== undefined
          ? { branchPrefixPreference: intent.branchPrefixPreference.trim() }
          : {}),
        ...(intent.githubUrl !== undefined ? { githubUrl: intent.githubUrl.trim() } : {}),
        launch:
          intent.launch.kind === 'agent'
            ? {
                agentDefId: intent.launch.agentDefId,
                ...(intent.launch.initialPrompt !== undefined
                  ? { initialPrompt: intent.launch.initialPrompt }
                  : {}),
                kind: 'agent' as const,
                skipPermissions: intent.launch.skipPermissions,
              }
            : { kind: 'terminal' as const },
        location,
        name: intent.name.trim(),
        projectId: intent.projectId,
        stepsTracking: intent.stepsTracking,
      });
      return { kind: 'normalized', semanticRequest };
    } catch {
      return { code: 'invalid-request', kind: 'rejected' };
    }
  }

  async resolveIntent(
    intent: Readonly<TaskCreationIntent>,
    _authentication: Readonly<TaskCreationTicketAuthenticationContext>,
    normalizedRequest?: NormalizedTaskCreationSemanticRequestV1,
  ): Promise<TaskCreationIntentResolution> {
    const normalization = normalizedRequest
      ? ({ kind: 'normalized', semanticRequest: normalizedRequest } as const)
      : this.normalizeIntent(intent);
    if (normalization.kind === 'rejected') return normalization;
    const semanticRequest = normalization.semanticRequest;

    let canonical: CanonicalWorkspaceSnapshot;
    try {
      canonical = await this.readProject(intent.projectId, 'resolve-intent');
    } catch {
      return { code: 'invalid-request', kind: 'rejected' };
    }
    const { project, sharedState } = canonical;
    if (
      (project.mode === 'non-git' && semanticRequest.location.kind !== 'project-root') ||
      (project.mode === 'non-git' && semanticRequest.baseBranchRef !== undefined) ||
      (semanticRequest.location.kind === 'project-root' &&
        semanticRequest.stepsTracking &&
        taskTracksProjectRootSteps(sharedState, project, intent.operationId))
    ) {
      return { code: 'capability-denied', kind: 'rejected' };
    }
    let agent: TaskCreationResolvedIntent['agent'] = null;
    if (semanticRequest.launch.kind === 'agent') {
      const agentDefId = semanticRequest.launch.agentDefId;
      const definition = this.adapters
        .getAgentDefinitions(sharedState)
        .find((candidate) => candidate.id === agentDefId);
      if (
        !definition ||
        (semanticRequest.launch.skipPermissions && definition.skip_permissions_args.length === 0)
      ) {
        return { code: 'capability-denied', kind: 'rejected' };
      }
      agent = {
        definition: structuredClone(definition) as unknown as JsonObject,
        definitionId: definition.id,
      };
    }
    try {
      await this.assertProjectAvailable(project);
      const baseBranch = semanticRequest.baseBranchRef
        ? await this.resolveBaseBranch(project, semanticRequest.baseBranchRef)
        : project.baseBranch;
      if (semanticRequest.location.kind === 'existing-worktree') {
        await this.resolveExistingWorktree(
          canonical,
          semanticRequest.location.worktreeRef,
          baseBranch,
        );
      }
      const managedLocation =
        semanticRequest.location.kind === 'managed-worktree'
          ? this.planManagedLocation(intent.operationId, project, semanticRequest)
          : null;
      const conflictKeys = [
        ...(semanticRequest.location.kind === 'project-root'
          ? [deriveTaskCreationConflictKey('project-root', project.root)]
          : []),
        ...(semanticRequest.location.kind === 'existing-worktree'
          ? [
              deriveTaskCreationConflictKey(
                'existing-worktree',
                semanticRequest.location.worktreeRef,
              ),
            ]
          : []),
        ...(managedLocation
          ? [
              deriveTaskCreationConflictKey('managed-worktree', managedLocation.worktreePath),
              deriveTaskCreationConflictKey('branch', managedLocation.branchName),
            ]
          : []),
        ...(semanticRequest.baseBranchRef
          ? [deriveTaskCreationConflictKey('branch', semanticRequest.baseBranchRef)]
          : []),
      ];
      return { kind: 'resolved', value: { agent, conflictKeys, semanticRequest } };
    } catch {
      return { code: 'capability-denied', kind: 'rejected' };
    }
  }

  async prepare(request: {
    identities: Readonly<TaskCreationAllocatedIdentities>;
    operationId: string;
    resolved: Readonly<TaskCreationResolvedIntent>;
  }): Promise<TaskCreationPreparedTask> {
    const semantic = request.resolved.semanticRequest;
    const canonical = await this.readProject(semantic.projectId, 'prepare');
    const project = canonical.project;
    if (
      (project.mode === 'non-git' && semantic.location.kind !== 'project-root') ||
      (semantic.location.kind === 'project-root' &&
        semantic.stepsTracking &&
        taskTracksProjectRootSteps(canonical.sharedState, project))
    ) {
      throw new Error('Task location or shared task steps are no longer available');
    }
    this.recheckAgent(request.resolved, canonical.sharedState);
    const baseBranch = semantic.baseBranchRef
      ? await this.resolveBaseBranch(project, semantic.baseBranchRef)
      : project.baseBranch;

    if (project.mode === 'non-git') {
      const result = this.adapters.createNonGitTask(project.root);
      return {
        task: {
          branchName: result.branch_name,
          projectMode: 'non-git',
          projectRoot: project.root,
          worktreePath: result.worktree_path,
        },
        warnings: [],
      };
    }
    const canonicalGitRoot = await this.adapters.getGitRepoRoot(project.root);
    if (!canonicalGitRoot || path.resolve(canonicalGitRoot) !== project.root) {
      throw new Error('Canonical project root is not a Git repository');
    }
    if (semantic.location.kind === 'project-root') {
      return withRepositoryWorktreeLock(project.root, async () => {
        const result = await this.adapters.createCurrentBranchTask(project.root, baseBranch);
        admitPreparedSharedRootTask(request.identities.taskId, project.root);
        return {
          task: {
            baseBranch: result.base_branch,
            branchName: result.branch_name,
            gitIsolation: 'current-branch',
            projectMode: 'git',
            projectRoot: project.root,
            worktreePath: result.worktree_path,
          },
          warnings: [],
        };
      });
    }
    if (semantic.location.kind === 'existing-worktree') {
      const worktreePath = await this.resolveExistingWorktree(
        canonical,
        semantic.location.worktreeRef,
        baseBranch,
      );
      const result = await this.adapters.importExistingWorktreeTask(
        project.root,
        worktreePath,
        baseBranch,
      );
      return {
        task: {
          baseBranch: result.base_branch,
          branchName: result.branch_name,
          gitIsolation: 'existing-worktree',
          projectMode: 'git',
          projectRoot: project.root,
          worktreePath: result.worktree_path,
        },
        warnings: [],
      };
    }
    const location = this.planManagedLocation(request.operationId, project, semantic);
    this.assertManagedLocationReserved(request.resolved, location);
    return this.prepareManagedWorktree(
      request.operationId,
      request.identities.taskId,
      canonical,
      location,
      semantic.location.worktreeLinkRequest,
      baseBranch,
    );
  }

  async reconcileFailedCommit(request: {
    identities: Readonly<TaskCreationAllocatedIdentities>;
    operationId: string;
    prepared: Readonly<TaskCreationPreparedTask>;
  }): Promise<TaskCreationCommitFailureReconciliation> {
    const current = await this.readSharedState('reconcile-failed-commit');
    const tasks = current.sharedState.tasks;
    const task = isJsonObject(tasks) ? tasks[request.identities.taskId] : undefined;
    if (isJsonObject(task)) {
      const link = task.taskCreationOperationLink;
      if (
        isJsonObject(link) &&
        link.kind === 'creation-v1' &&
        link.creationOperationId === request.operationId
      ) {
        return {
          kind: 'manual-reconciliation-required',
          reconciliation: {
            expectedTaskId: request.identities.taskId,
            kind: 'mapping-ambiguous',
            resource: {
              conflictKey: deriveTaskCreationConflictKey('task', request.identities.taskId),
              resourceId: operationResourceId(request.operationId, request.identities.taskId),
            },
          },
        };
      }
      return {
        kind: 'manual-reconciliation-required',
        reconciliation: artifactAmbiguity(request.operationId, 'task', request.identities.taskId),
      };
    }
    if (request.prepared.task.gitIsolation !== 'worktree') {
      if (request.prepared.task.gitIsolation === 'current-branch') {
        releasePreparedSharedRootTask(request.identities.taskId);
      }
      return { kind: 'proven-clean' };
    }
    try {
      const retained = await this.adapters.claimManagedWorktreeRecoveryQuarantine({
        branchName: request.prepared.task.branchName,
        operationId: request.operationId,
        projectRoot: request.prepared.task.projectRoot,
        worktreePath: request.prepared.task.worktreePath,
      });
      return {
        kind: 'manual-reconciliation-required',
        reconciliation: {
          // Failed creation compensation intentionally preserves the detached
          // branch. No later branch mutation is owed by this recovery record.
          branchDelete: { state: 'not-applicable' },
          conflictKey: deriveTaskCreationConflictKey(
            'managed-worktree',
            request.prepared.task.worktreePath,
          ),
          kind: 'retained-quarantine',
          operationLockOwnershipWitness: retained.operationLockOwnershipWitness,
          operationLockResourceId: retained.operationLockResourceId,
          quarantineLocator: retained.quarantineLocator,
          recoveryId: retained.recoveryId,
          resourceId: retained.resourceId,
          restore: { kind: 'retained' },
        },
      };
    } catch {
      return {
        kind: 'manual-reconciliation-required',
        reconciliation: artifactAmbiguity(
          request.operationId,
          'managed-worktree',
          request.prepared.task.worktreePath,
        ),
      };
    }
  }

  private async inspectReconciliationRecord(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<void> {
    const reconciliation = record.reconciliation;
    if (reconciliation.kind === 'mapping-ambiguous') {
      await this.probeCommittedMapping(record, reconciliation.expectedTaskId);
      return;
    }
    if (
      reconciliation.kind === 'artifact-ambiguous' ||
      reconciliation.kind === 'abandoned-conflicts'
    ) {
      await Promise.all(
        reconciliation.resources.map((resource) =>
          this.probeOwnedArtifactAbsence(record, resource),
        ),
      );
      return;
    }
    if (reconciliation.kind === 'retained-quarantine') {
      await this.inspectRecoveryQuarantine(record);
      return;
    }
    await this.readSharedState('inspect-reconciliation-record');
  }

  private async probeCommittedMapping(
    record: Readonly<TaskCreationJournalRecord>,
    expectedTaskId: string,
  ): Promise<TaskCreationReconciliationCommittedMappingProbe> {
    if (
      expectedTaskId !== record.identities.taskId ||
      record.reconciliation.kind !== 'mapping-ambiguous' ||
      record.reconciliation.expectedTaskId !== expectedTaskId
    ) {
      return { kind: 'proof-insufficient' };
    }
    const current = await this.readSharedState('probe-committed-creation-mapping').catch(
      () => null,
    );
    if (!current || !isJsonObject(current.sharedState.tasks)) {
      return { kind: 'proof-insufficient' };
    }
    const task = current.sharedState.tasks[expectedTaskId];
    if (!isJsonObject(task)) return { kind: 'proof-insufficient' };
    const link = task.taskCreationOperationLink;
    const provenance = task.taskCreationProvenance;
    const shellOwnership = task.taskInitialShellOwnership;
    if (
      task.id !== expectedTaskId ||
      task.taskMode !== record.taskMode ||
      !isTaskCreationOperationLink(link) ||
      link.kind !== 'creation-v1' ||
      link.creationOperationId !== record.operationId ||
      link.launchOperationId !== record.identities.launchOperationId ||
      !isTaskCreationProvenance(provenance) ||
      provenance.creationWriterEpoch !== 'managed-initial-shell-v1' ||
      !isTaskInitialShellOwnership(shellOwnership)
    ) {
      return { kind: 'proof-insufficient' };
    }
    if (
      record.taskMode === 'agent'
        ? shellOwnership.kind !== 'not-applicable-agent' ||
          task.agentId !== record.identities.sessionId ||
          !Array.isArray(task.agentIds) ||
          !task.agentIds.includes(record.identities.sessionId)
        : shellOwnership.kind !== 'managed-terminal-v1' ||
          shellOwnership.launchOperationId !== record.identities.launchOperationId ||
          shellOwnership.sessionId !== record.identities.sessionId ||
          !Array.isArray(task.shellAgentIds) ||
          !task.shellAgentIds.includes(record.identities.sessionId)
    ) {
      return { kind: 'proof-insufficient' };
    }
    return {
      kind: 'exact',
      taskId: expectedTaskId,
      workspaceRevision: current.sharedRevision,
    };
  }

  private async probeOwnedArtifactAbsence(
    record: Readonly<TaskCreationJournalRecord>,
    resource: Readonly<TaskCreationReconciliationResource>,
  ): Promise<TaskCreationReconciliationAbsenceProbe> {
    if (resource.conflictKey.kind === 'task') {
      const taskId = record.identities.taskId;
      if (
        resource.resourceId !== operationResourceId(record.operationId, taskId) ||
        !sameConflictKey(resource.conflictKey, deriveTaskCreationConflictKey('task', taskId))
      ) {
        return { kind: 'proof-insufficient' };
      }
      const current = await this.readSharedState('probe-creation-task-absence').catch(() => null);
      if (!current || !isJsonObject(current.sharedState.tasks)) {
        return { kind: 'proof-insufficient' };
      }
      return current.sharedState.tasks[taskId] === undefined
        ? { kind: 'exact-absent' }
        : { kind: 'present' };
    }
    if (resource.conflictKey.kind !== 'managed-worktree') {
      return { kind: 'proof-insufficient' };
    }
    const preparation = await this.getReconciliationPreparation(record.operationId);
    if (
      !preparation ||
      resource.resourceId !== operationResourceId(record.operationId, preparation.worktreePath) ||
      !sameConflictKey(
        resource.conflictKey,
        deriveTaskCreationConflictKey('managed-worktree', preparation.worktreePath),
      )
    ) {
      return { kind: 'proof-insufficient' };
    }
    return this.probeManagedPreparationArtifactAbsence(preparation);
  }

  private async probeManagedPreparationArtifactAbsence(
    preparation: Readonly<ManagedPreparationRecord>,
  ): Promise<TaskCreationReconciliationAbsenceProbe> {
    try {
      const quarantinePath = getManagedWorktreeRecoveryQuarantinePath(
        preparation.worktreePath,
        preparation.operationId,
      );
      const [sourceKind, quarantineKind, worktrees] = await Promise.all([
        this.pathEntryKind(preparation.worktreePath),
        this.pathEntryKind(quarantinePath),
        this.adapters.listGitWorktrees(preparation.projectRoot),
      ]);
      const matches = (candidatePath: string): boolean =>
        worktrees.some((entry) => path.resolve(entry.path) === path.resolve(candidatePath));
      if (
        sourceKind === 'missing' &&
        quarantineKind === 'missing' &&
        !matches(preparation.worktreePath) &&
        !matches(quarantinePath)
      ) {
        return { kind: 'exact-absent' };
      }
      return { kind: 'present' };
    } catch {
      return { kind: 'proof-insufficient' };
    }
  }

  private async probeRecoveryQuarantineAbsence(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<TaskCreationReconciliationAbsenceProbe> {
    const inspection = await this.inspectRecoveryQuarantine(record);
    return inspection === 'exact-absent'
      ? { kind: 'exact-absent' }
      : inspection === 'exact-present'
        ? { kind: 'present' }
        : { kind: 'proof-insufficient' };
  }

  private async revealRecoveryQuarantine(
    record: Readonly<TaskCreationJournalRecord>,
    reveal: (quarantinePath: string) => void,
  ): Promise<'proof-insufficient' | 'revealed'> {
    const inspection = await this.inspectRecoveryQuarantine(record);
    if (inspection !== 'exact-present' || record.reconciliation.kind !== 'retained-quarantine') {
      return 'proof-insufficient';
    }
    reveal(record.reconciliation.quarantineLocator);
    return 'revealed';
  }

  private async inspectRecoveryQuarantine(
    record: Readonly<TaskCreationJournalRecord>,
  ): Promise<'exact-absent' | 'exact-present' | 'proof-insufficient'> {
    if (record.reconciliation.kind !== 'retained-quarantine') {
      return 'proof-insufficient';
    }
    const preparation = await this.getReconciliationPreparation(record.operationId);
    if (!preparation) return 'proof-insufficient';
    const result = await inspectManagedWorktreeRecoveryQuarantine(
      {
        branchName: preparation.branchName,
        operationId: record.operationId,
        projectRoot: preparation.projectRoot,
        worktreePath: preparation.worktreePath,
      },
      record.reconciliation,
    );
    return result.kind;
  }

  private async getReconciliationPreparation(
    operationId: string,
  ): Promise<ManagedPreparationRecord | null> {
    const result = await this.dependencies.privateAuthority.mutate(
      { operation: 'read-task-creation-reconciliation-preparation' },
      (slices) => {
        const segment = requirePrivateSegment(slices.privateState);
        const preparation = decodeManagedPreparationRecord(
          (segment.preparations as JsonObject)[operationId],
        );
        return unchanged(preparation ? structuredClone(preparation) : null);
      },
    );
    return result.result;
  }

  private async pathEntryKind(
    candidatePath: string,
  ): Promise<'directory' | 'missing' | 'other' | 'symlink'> {
    try {
      const stat = await fs.promises.lstat(candidatePath);
      if (stat.isSymbolicLink()) return 'symlink';
      return stat.isDirectory() ? 'directory' : 'other';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  private async createPickerSnapshot(
    projectId: string,
    kind: GetTaskCreationPickerPageRequest['kind'],
    query: string,
  ): Promise<PickerSnapshot> {
    const canonical = await this.readProject(projectId, 'picker-page');
    if (canonical.project.mode !== 'git') throw new Error('Git picker is unavailable');
    let items: TaskCreationPickerItem[];
    if (kind === 'base-branch') {
      const branches = await this.adapters.listBranches(canonical.project.root);
      items = branches.branches.map((branch) => ({
        branchLabel: branch.current
          ? 'Current branch'
          : branch.local
            ? 'Local branch'
            : 'Remote branch',
        kind: 'base-branch' as const,
        label: truncateUtf8(branch.name),
        ref: this.reference('base-branch', projectId, branch.name),
      }));
    } else {
      const worktrees = await this.adapters.listImportableWorktrees(canonical.project.root, {
        ...(canonical.project.baseBranch ? { baseBranch: canonical.project.baseBranch } : {}),
        registeredWorktreePaths: registeredWorktreePaths(canonical.sharedState, projectId),
      });
      items = worktrees.map((worktree) => ({
        branchLabel: truncateUtf8(worktree.branchName),
        kind: 'existing-worktree' as const,
        label: truncateUtf8(path.basename(worktree.path) || worktree.branchName),
        ownershipLabel: 'External worktree',
        ref: this.reference('existing-worktree', projectId, path.resolve(worktree.path)),
      }));
    }
    if (query) {
      items = items.filter((item) =>
        `${item.label} ${item.branchLabel ?? ''}`.toLowerCase().includes(query),
      );
    }
    const sourceTruncated = items.length > PICKER_ITEM_LIMIT;
    items = items.slice(0, PICKER_ITEM_LIMIT);
    const id = this.newSnapshotId();
    const snapshot: PickerSnapshot = {
      catalogVersion: canonical.sharedRevision,
      expiresAtMs: this.adapters.now() + PICKER_SNAPSHOT_TTL_MS,
      generation: ++this.pickerGeneration,
      id,
      items,
      kind,
      projectId,
      query,
      sourceTruncated,
    };
    this.pickerSnapshots.set(id, snapshot);
    this.trimPickerSnapshots();
    return snapshot;
  }

  private async prepareManagedWorktree(
    operationId: string,
    taskId: string,
    canonical: CanonicalWorkspaceSnapshot,
    location: Readonly<PlannedManagedTaskLocation>,
    worktreeLinkRequest: TaskWorktreeLinkRequestV1,
    baseBranch: string | undefined,
  ): Promise<TaskCreationPreparedTask> {
    let record = await this.installPreparationPlan({
      baseBranch: baseBranch ?? null,
      branchName: location.branchName,
      createdAtMs: this.adapters.now(),
      operationId,
      projectId: canonical.project.id,
      projectRoot: canonical.project.root,
      state: 'planned',
      taskId,
      warnings: [],
      worktreePath: location.worktreePath,
    });
    if (record.state === 'prepared') {
      await this.verifyPreparedWorktree(record);
      return this.toPreparedManagedTask(record);
    }
    try {
      const replay = await this.inspectPlannedWorktree(record);
      if (replay === 'present-exact') {
        record = await this.markPreparationReady(record, []);
        return this.toPreparedManagedTask(record);
      }
      if (replay === 'present-conflict') {
        throw new TaskCreationPreparationManualReconciliationError(
          'Managed task preparation location is occupied by unproven state',
          artifactAmbiguity(operationId, 'managed-worktree', record.worktreePath),
        );
      }
      const created = await this.adapters.createPlannedManagedTask(
        record.projectRoot,
        { branchName: record.branchName, worktreePath: record.worktreePath },
        worktreeLinkRequest,
        record.baseBranch ?? undefined,
      );
      record = await this.markPreparationReady(record, created.symlink_warnings ?? []);
      return this.toPreparedManagedTask(record);
    } catch (error) {
      if (error instanceof TaskCreationPreparationManualReconciliationError) throw error;
      const state = await this.inspectPlannedWorktree(record).catch(
        () => 'present-conflict' as const,
      );
      if (state !== 'absent') {
        throw new TaskCreationPreparationManualReconciliationError(
          'Managed task preparation outcome requires local reconciliation',
          artifactAmbiguity(operationId, 'managed-worktree', record.worktreePath),
        );
      }
      throw error;
    }
  }

  private planManagedLocation(
    operationId: string,
    project: Readonly<CanonicalProject>,
    semantic: Readonly<NormalizedTaskCreationSemanticRequestV1>,
  ): PlannedManagedTaskLocation {
    if (semantic.location.kind !== 'managed-worktree') {
      throw new Error('Managed task location planning requires a managed-worktree intent');
    }
    return this.adapters.planManagedTaskLocation(
      semantic.name,
      project.root,
      semantic.branchPrefixPreference ?? project.branchPrefix ?? 'task',
      operationId,
    );
  }

  private assertManagedLocationReserved(
    resolved: Readonly<TaskCreationResolvedIntent>,
    location: Readonly<PlannedManagedTaskLocation>,
  ): void {
    const declared = new Set((resolved.conflictKeys ?? []).map(taskCreationConflictKeyId));
    const required = [
      deriveTaskCreationConflictKey('managed-worktree', location.worktreePath),
      deriveTaskCreationConflictKey('branch', location.branchName),
    ];
    if (required.some((key) => !declared.has(taskCreationConflictKeyId(key)))) {
      throw new Error('Managed task location changed after conflict admission');
    }
  }

  private async installPreparationPlan(
    plan: ManagedPreparationRecord,
  ): Promise<ManagedPreparationRecord> {
    const result = await this.dependencies.privateAuthority.mutate(
      { operation: 'plan-managed-task-preparation' },
      (slices) => {
        const segment = requirePrivateSegment(slices.privateState);
        const preparations = segment.preparations as JsonObject;
        const rawExisting = preparations[plan.operationId];
        const existing = decodeManagedPreparationRecord(rawExisting);
        if (rawExisting !== undefined && !existing) {
          throw new Error('Task-creation preparation state requires recovery');
        }
        if (existing) {
          if (
            existing.taskId !== plan.taskId ||
            existing.projectId !== plan.projectId ||
            existing.projectRoot !== plan.projectRoot ||
            existing.branchName !== plan.branchName ||
            existing.worktreePath !== plan.worktreePath ||
            existing.baseBranch !== plan.baseBranch
          ) {
            throw new Error('Task-creation operation preparation identity changed');
          }
          return unchanged(existing);
        }
        const retained = this.pruneCommittedPreparations(preparations, slices.sharedState);
        if (Object.keys(retained).length >= MAX_PREPARATION_RECORDS) {
          throw new Error('Task-creation preparation capacity is exhausted');
        }
        const nextPrivate = cloneJsonObject(slices.privateState);
        nextPrivate[PRIVATE_SEGMENT_KEY] = {
          ...segment,
          preparations: { ...retained, [plan.operationId]: plan as unknown as JsonObject },
        };
        return changed({ nextPrivateState: nextPrivate }, plan);
      },
    );
    return result.result;
  }

  private async markPreparationReady(
    expected: ManagedPreparationRecord,
    warnings: TaskWorktreeLinkWarning[],
  ): Promise<ManagedPreparationRecord> {
    const result = await this.dependencies.privateAuthority.mutate(
      { operation: 'complete-managed-task-preparation' },
      (slices) => {
        const segment = requirePrivateSegment(slices.privateState);
        const preparations = segment.preparations as JsonObject;
        const current = decodeManagedPreparationRecord(preparations[expected.operationId]);
        if (!current || current.taskId !== expected.taskId || current.state !== 'planned') {
          if (current?.state === 'prepared') return unchanged(current);
          throw new Error('Task-creation preparation plan changed before completion');
        }
        const prepared: ManagedPreparationRecord = { ...current, state: 'prepared', warnings };
        const nextPrivate = cloneJsonObject(slices.privateState);
        nextPrivate[PRIVATE_SEGMENT_KEY] = {
          ...segment,
          preparations: {
            ...preparations,
            [expected.operationId]: prepared as unknown as JsonObject,
          },
        };
        return changed({ nextPrivateState: nextPrivate }, prepared);
      },
    );
    return result.result;
  }

  private pruneCommittedPreparations(
    preparations: Readonly<JsonObject>,
    sharedState: Readonly<JsonObject>,
  ): JsonObject {
    const tasks = isJsonObject(sharedState.tasks) ? sharedState.tasks : {};
    const committedOperationIds = new Set(
      Object.values(tasks).flatMap((task) => {
        if (!isJsonObject(task) || !isJsonObject(task.taskCreationOperationLink)) return [];
        const operationId = task.taskCreationOperationLink.creationOperationId;
        return typeof operationId === 'string' ? [operationId] : [];
      }),
    );
    return Object.fromEntries(
      Object.entries(preparations).filter(
        ([operationId]) => !committedOperationIds.has(operationId),
      ),
    ) as JsonObject;
  }

  private async inspectPlannedWorktree(
    record: ManagedPreparationRecord,
  ): Promise<'absent' | 'present-conflict' | 'present-exact'> {
    const [entryKind, worktrees] = await Promise.all([
      fs.promises
        .lstat(record.worktreePath)
        .then((stat) => (stat.isDirectory() && !stat.isSymbolicLink() ? 'directory' : 'other'))
        .catch((error: NodeJS.ErrnoException) =>
          error.code === 'ENOENT' ? 'missing' : Promise.reject(error),
        ),
      this.adapters.listGitWorktrees(record.projectRoot),
    ]);
    const registered = worktrees.find(
      (worktree) => path.resolve(worktree.path) === path.resolve(record.worktreePath),
    );
    if (entryKind === 'missing' && !registered) return 'absent';
    return entryKind === 'directory' &&
      registered?.branchName === record.branchName &&
      registered.detached === false
      ? 'present-exact'
      : 'present-conflict';
  }

  private async verifyPreparedWorktree(record: ManagedPreparationRecord): Promise<void> {
    if ((await this.inspectPlannedWorktree(record)) !== 'present-exact') {
      throw new TaskCreationPreparationManualReconciliationError(
        'Prepared worktree evidence changed before canonical commit',
        artifactAmbiguity(record.operationId, 'managed-worktree', record.worktreePath),
      );
    }
  }

  private toPreparedManagedTask(record: ManagedPreparationRecord): TaskCreationPreparedTask {
    return {
      task: {
        ...(record.baseBranch ? { baseBranch: record.baseBranch } : {}),
        branchName: record.branchName,
        gitIsolation: 'worktree',
        projectMode: 'git',
        projectRoot: record.projectRoot,
        worktreePath: record.worktreePath,
      },
      warnings: structuredClone(record.warnings),
    };
  }

  private recheckAgent(
    resolved: Readonly<TaskCreationResolvedIntent>,
    sharedState: Readonly<JsonObject>,
  ): void {
    if (resolved.semanticRequest.launch.kind === 'terminal') return;
    const agentDefId = resolved.semanticRequest.launch.agentDefId;
    const current = this.adapters
      .getAgentDefinitions(sharedState)
      .find((definition) => definition.id === agentDefId);
    if (!current || current.id !== resolved.agent?.definitionId) {
      throw new Error('Selected agent definition is no longer available');
    }
  }

  private async resolveBaseBranch(project: CanonicalProject, reference: string): Promise<string> {
    const branches = await this.adapters.listBranches(project.root);
    const match = branches.branches.find(
      (branch) => this.reference('base-branch', project.id, branch.name) === reference,
    );
    if (!match) throw new Error('Selected base branch reference is stale');
    return match.name;
  }

  private async assertProjectAvailable(project: CanonicalProject): Promise<void> {
    if (project.mode === 'git') {
      const root = await this.adapters.getGitRepoRoot(project.root);
      if (!root || path.resolve(root) !== project.root) {
        throw new Error('Selected project repository is no longer available');
      }
      return;
    }
    const stat = await fs.promises.stat(project.root);
    if (!stat.isDirectory()) throw new Error('Selected project folder is no longer available');
  }

  private async resolveExistingWorktree(
    canonical: CanonicalWorkspaceSnapshot,
    reference: string,
    baseBranch: string | undefined,
  ): Promise<string> {
    const worktrees = await this.adapters.listImportableWorktrees(canonical.project.root, {
      ...(baseBranch ? { baseBranch } : {}),
      registeredWorktreePaths: registeredWorktreePaths(canonical.sharedState, canonical.project.id),
    });
    const match = worktrees.find(
      (worktree) =>
        this.reference('existing-worktree', canonical.project.id, path.resolve(worktree.path)) ===
        reference,
    );
    if (!match) throw new Error('Selected existing worktree reference is stale');
    return path.resolve(match.path);
  }

  private reference(
    kind: 'base-branch' | 'existing-worktree',
    projectId: string,
    canonicalValue: string,
  ): string {
    const prefix = kind === 'base-branch' ? 'b' : 'w';
    return `${prefix}_${createHmac('sha256', Buffer.from(this.pickerReferenceKey, 'base64url'))
      .update(`parallel-code:task-creation-picker:${kind}:v1\0`, 'utf8')
      .update(projectId, 'utf8')
      .update('\0', 'utf8')
      .update(canonicalValue, 'utf8')
      .digest('base64url')}`;
  }

  private isReference(value: string, kind: 'base-branch' | 'existing-worktree'): boolean {
    return (
      PICKER_REFERENCE_PATTERN.test(value) && value.startsWith(kind === 'base-branch' ? 'b_' : 'w_')
    );
  }

  private async readProject(
    projectId: string,
    operation: string,
  ): Promise<CanonicalWorkspaceSnapshot> {
    const current = await this.readSharedState(operation);
    return { ...current, project: requireProject(current.sharedState, projectId) };
  }

  private async readSharedState(
    operation: string,
  ): Promise<{ sharedRevision: number; sharedState: JsonObject }> {
    const result = await this.dependencies.privateAuthority.mutate(
      { operation: `task-creation-preparation:${operation}` },
      (slices) =>
        unchanged({
          sharedRevision: slices.sharedRevision,
          sharedState: cloneJsonObject(slices.sharedState),
        }),
    );
    return result.result;
  }

  private newSnapshotId(): string {
    return Buffer.from(this.adapters.randomBytes(12)).toString('base64url');
  }

  private createCursor(snapshotId: string, offset: number): string {
    const cursor = `${snapshotId}~${offset.toString(36)}`;
    if (!isTaskCatalogCursor(cursor)) throw new Error('Task-creation picker cursor overflow');
    return cursor;
  }

  private parseCursor(cursor: string): { offset: number; snapshotId: string } | null {
    if (!isTaskCatalogCursor(cursor)) return null;
    const [snapshotId, offsetText, extra] = cursor.split('~');
    const offset = Number.parseInt(offsetText ?? '', 36);
    return snapshotId && extra === undefined && Number.isSafeInteger(offset) && offset >= 0
      ? { offset, snapshotId }
      : null;
  }

  private trimPickerSnapshots(): void {
    const now = this.adapters.now();
    for (const [id, snapshot] of this.pickerSnapshots) {
      if (snapshot.expiresAtMs <= now) this.pickerSnapshots.delete(id);
    }
    while (this.pickerSnapshots.size > PICKER_SNAPSHOT_LIMIT) {
      const oldest = this.pickerSnapshots.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pickerSnapshots.delete(oldest);
    }
  }
}

async function activatePrivateSegment(
  authority: WorkspacePrivateMutationAuthority,
  adapters: ProductionTaskCreationPreparationAdapters,
): Promise<string> {
  const result = await authority.mutate(
    { operation: 'activate-task-creation-preparation-owner' },
    (slices) => {
      const existing = slices.privateState[PRIVATE_SEGMENT_KEY];
      if (existing !== undefined) {
        const segment = requirePrivateSegment(slices.privateState);
        return unchanged(segment.pickerReferenceKey as string);
      }
      const pickerReferenceKey = Buffer.from(adapters.randomBytes(32)).toString('base64url');
      if (!PICKER_KEY_PATTERN.test(pickerReferenceKey)) {
        throw new Error('Task-creation picker key source returned invalid entropy');
      }
      const nextPrivate = cloneJsonObject(slices.privateState);
      nextPrivate[PRIVATE_SEGMENT_KEY] = {
        formatVersion: PRIVATE_SEGMENT_FORMAT_VERSION,
        pickerReferenceKey,
        preparations: {},
      };
      return changed({ nextPrivateState: nextPrivate }, pickerReferenceKey);
    },
  );
  return result.result;
}

export async function createProductionTaskCreationPreparationOwner(
  dependencies: CreateProductionTaskCreationPreparationOwnerDependencies,
): Promise<ProductionTaskCreationPreparationOwner> {
  const adapters = { ...DEFAULT_ADAPTERS, ...dependencies.adapters };
  const pickerReferenceKey = await activatePrivateSegment(dependencies.privateAuthority, adapters);
  return new ProductionTaskCreationPreparationOwnerImpl(dependencies, pickerReferenceKey);
}
