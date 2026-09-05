import path from 'node:path';

import {
  isTaskCreationOperationLink,
  isTaskInitialShellOwnership,
  type TaskCreationOperationLink,
  type TaskCreationWriterEpoch,
  type TaskInitialShellOwnership,
} from '../../src/domain/task-creation-provenance.js';
import { resolvePersistedTaskMode } from '../../src/domain/task-mode.js';
import type {
  TaskRemovalMutationResult,
  TaskRemovalOwnerCapability,
  TaskRemovalParticipantGate,
  TaskRemovalParticipantId,
} from '../../src/domain/task-removal-owner.js';
import type { TaskNotesStructuralAuthority } from './task-notes-service.js';
import { TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES } from '../../src/domain/task-initial-prompt-delivery.js';
import { isWellFormedUnicodeScalarString } from '../../src/lib/unicode-scalar.js';
import {
  activateProtectedPolicies,
  changed,
  getProtectedPolicyVersions,
  unchanged,
  type WorkspaceMutationRequest,
  type WorkspaceMutationResult,
  type WorkspaceMutationService,
  type WorkspacePrivateMutationAuthority,
} from './workspace-state-mutations.js';
import {
  canonicalJsonStringify,
  cloneJsonObject,
  type JsonObject,
  type JsonValue,
} from './workspace-state-storage.js';
import {
  TaskRemovalOwner,
  type TaskMergeRemovalAuthority,
  type TaskRemovalLifecycleEvent,
  type TaskRemovalOwnerOptions,
  type TaskRemovalOwnerParticipant,
  type VerifyTaskRemovalPreparationRequest,
} from './task-removal-owner.js';

export type TaskStructureTaskMode = 'agent' | 'terminal';
export type TaskStructureProjectMode = 'git' | 'non-git';
export type TaskStructureGitIsolation = 'current-branch' | 'existing-worktree' | 'worktree';

export interface AddPreparedTaskRequest {
  baseBranch?: string;
  branchName: string;
  gitIsolation?: TaskStructureGitIsolation;
  githubUrl?: string;
  name: string;
  projectId: string;
  projectMode: TaskStructureProjectMode;
  projectRoot: string;
  stepsTracking?: boolean;
  taskId: string;
  taskMode: TaskStructureTaskMode;
  worktreePath: string;
}

export interface AddedTaskResult {
  task: JsonObject;
  taskId: string;
}

export interface ManagedTaskCreationAgentFields {
  agentDef: JsonObject;
  agentDefId: string;
  agentId: string;
  skipPermissions: boolean;
}

export interface ManagedTaskCreationInitialPrompt {
  deliveryId: string;
  text: string;
}

export interface ManagedTaskCreationCoordinatorFields {
  credentialPath: string;
  runId: string;
  toolCommand?: string;
}

export interface AddManagedTaskRequest extends AddPreparedTaskRequest {
  agent?: ManagedTaskCreationAgentFields;
  branchPrefixPreference?: string;
  coordinator?: ManagedTaskCreationCoordinatorFields;
  creationOperationId: string;
  expectedInitialShellGeneration: number;
  initialPrompt?: ManagedTaskCreationInitialPrompt;
  launchOperationId: string;
  sessionId: string;
}

export interface ExistingTaskCreationCutoverEvidence {
  operationLink: TaskCreationOperationLink;
  shellOwnership: TaskInitialShellOwnership;
}

export interface ManagedTaskCreationCutoverClassifier {
  classify(
    taskId: string,
    canonicalTask: Readonly<JsonObject>,
  ): Promise<ExistingTaskCreationCutoverEvidence>;
}

export interface ManagedTaskCreationWriterCapability {
  cutoverEpoch: string;
  hookSetVersions: TaskRemovalOwnerCapability['hookSetVersions'];
  kind: 'active';
  writerEpoch: 'managed-initial-shell-v1';
}

export type RemovedTaskResult = TaskRemovalMutationResult;

export type TaskRemovalDispatchResult<TResult> =
  | {
      kind: 'generic-owner';
      removal: WorkspaceMutationResult<RemovedTaskResult>;
    }
  | {
      effectResult: TResult;
      kind: 'legacy-fallback';
      removal: WorkspaceMutationResult<RemovedTaskResult>;
    };

export interface TaskStructureMutationOptions {
  privateAuthority?: WorkspacePrivateMutationAuthority;
  removalOwner?: TaskRemovalOwnerOptions;
}

const TASK_CREATION_SCHEMA_KEY = 'taskCreationSchema';
const TASK_CREATION_PROVENANCE_KEY = 'taskCreationProvenance';
const PRE_MANAGED_WRITER_EPOCH = 'pre-managed-v1' satisfies TaskCreationWriterEpoch;
const STRUCTURAL_POLICY_IDS = Object.freeze([
  'task-structure',
  'task-identity-location',
  'creation-writer-epoch',
] as const);
const MANAGED_CREATION_POLICY_IDS = Object.freeze([
  ...STRUCTURAL_POLICY_IDS,
  'creation-outcome',
  'initial-shell-ownership',
  'creation-operation-link',
] as const);

export class TaskStructureConflictError extends Error {
  readonly code = 'task-structure-conflict';
}

export class TaskStructureRecoveryError extends Error {
  readonly code = 'task-structure-recovery-required';
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireTasks(sharedState: JsonObject): JsonObject {
  const tasks = sharedState.tasks;
  if (tasks === undefined) return {};
  if (!isJsonObject(tasks)) {
    throw new TaskStructureRecoveryError('Canonical tasks must be an object');
  }
  return tasks;
}

function requireOrder(
  sharedState: JsonObject,
  field: 'collapsedTaskOrder' | 'taskOrder',
): string[] {
  const value = sharedState[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TaskStructureRecoveryError(`Canonical ${field} must be a string array`);
  }
  if (new Set(value).size !== value.length) {
    throw new TaskStructureRecoveryError(`Canonical ${field} contains duplicate task IDs`);
  }
  return [...value] as string[];
}

function requireProjects(sharedState: JsonObject): JsonObject[] {
  const value = sharedState.projects;
  if (!Array.isArray(value)) {
    throw new TaskStructureRecoveryError('Canonical projects must be an array');
  }
  if (value.some((entry) => !isJsonObject(entry))) {
    throw new TaskStructureRecoveryError('Canonical projects contain an invalid project');
  }
  return value as JsonObject[];
}

function canonicalPath(value: string): string {
  return path.resolve(value);
}

function validateProject(request: AddPreparedTaskRequest, sharedState: JsonObject): void {
  const projects = requireProjects(sharedState);
  const project = projects.find((entry) => entry.id === request.projectId);
  if (!project) {
    throw new TaskStructureConflictError(`Project ${request.projectId} does not exist`);
  }
  if (typeof project.path !== 'string') {
    throw new TaskStructureRecoveryError(`Project ${request.projectId} has no canonical root`);
  }
  if (canonicalPath(project.path) !== canonicalPath(request.projectRoot)) {
    throw new TaskStructureConflictError(
      `Project ${request.projectId} root differs from canonical state`,
    );
  }

  const canonicalMode = project.projectMode === 'non-git' ? 'non-git' : 'git';
  if (canonicalMode !== request.projectMode) {
    throw new TaskStructureConflictError(
      `Project ${request.projectId} mode differs from canonical state`,
    );
  }
}

function validateAddRequest(request: AddPreparedTaskRequest): void {
  for (const [label, value] of [
    ['taskId', request.taskId],
    ['name', request.name],
    ['projectId', request.projectId],
    ['projectRoot', request.projectRoot],
    ['worktreePath', request.worktreePath],
  ] as const) {
    if (value.trim().length === 0) {
      throw new TaskStructureConflictError(`${label} must not be empty`);
    }
  }

  if (request.projectMode === 'non-git') {
    if (
      request.branchName !== '' ||
      request.gitIsolation !== undefined ||
      request.baseBranch !== undefined
    ) {
      throw new TaskStructureConflictError('Non-git tasks cannot carry Git location fields');
    }
    return;
  }
  if (request.branchName.trim().length === 0) {
    throw new TaskStructureConflictError('Git tasks require a canonical branch name');
  }
  if (request.gitIsolation === undefined) {
    throw new TaskStructureConflictError('Git tasks require a canonical isolation mode');
  }
}

function readActiveWriterEpoch(privateState: JsonObject): TaskCreationWriterEpoch {
  const schema = privateState[TASK_CREATION_SCHEMA_KEY];
  if (!isJsonObject(schema)) {
    throw new TaskStructureRecoveryError('Task creation schema is not activated');
  }
  const epoch = schema.activeWriterEpoch;
  if (epoch !== PRE_MANAGED_WRITER_EPOCH && epoch !== 'managed-initial-shell-v1') {
    throw new TaskStructureRecoveryError('Task creation writer epoch is invalid');
  }
  return epoch;
}

function createPreparedTask(
  request: AddPreparedTaskRequest,
  creationWriterEpoch: TaskCreationWriterEpoch,
): JsonObject {
  const task: JsonObject = {
    agentDef: null,
    agentId: null,
    branchName: request.branchName,
    id: request.taskId,
    lastPrompt: '',
    name: request.name,
    notes: '',
    projectId: request.projectId,
    shellAgentIds: [],
    shellCount: 0,
    taskCreationProvenance: { creationWriterEpoch },
    taskMode: request.taskMode,
    worktreePath: request.worktreePath,
  };

  if (request.projectMode === 'non-git') {
    task.projectMode = 'non-git';
  } else {
    task.gitIsolation = request.gitIsolation as TaskStructureGitIsolation;
    if (request.baseBranch !== undefined) task.baseBranch = request.baseBranch;
    if (request.gitIsolation === 'existing-worktree') task.worktreeOwnership = 'external';
  }
  if (request.githubUrl !== undefined) task.githubUrl = request.githubUrl;
  if (request.stepsTracking !== undefined) task.stepsTracking = request.stepsTracking;
  return task;
}

function requireManagedIdentifier(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    value.includes('\u0000')
  ) {
    throw new TaskStructureConflictError(`${label} is invalid`);
  }
}

function validateManagedAddRequest(request: AddManagedTaskRequest): void {
  validateAddRequest(request);
  requireManagedIdentifier(request.creationOperationId, 'creationOperationId');
  requireManagedIdentifier(request.launchOperationId, 'launchOperationId');
  requireManagedIdentifier(request.sessionId, 'sessionId');
  if (
    !Number.isSafeInteger(request.expectedInitialShellGeneration) ||
    request.expectedInitialShellGeneration < 0
  ) {
    throw new TaskStructureConflictError('expectedInitialShellGeneration is invalid');
  }
  if (
    request.branchPrefixPreference !== undefined &&
    (request.branchPrefixPreference.trim().length === 0 ||
      Buffer.byteLength(request.branchPrefixPreference, 'utf8') > 96 ||
      !isWellFormedUnicodeScalarString(request.branchPrefixPreference))
  ) {
    throw new TaskStructureConflictError('branchPrefixPreference is invalid');
  }
  if (request.taskMode === 'agent') {
    if (!request.agent) throw new TaskStructureConflictError('Agent task requires agent identity');
    requireManagedIdentifier(request.agent.agentDefId, 'agentDefId');
    requireManagedIdentifier(request.agent.agentId, 'agentId');
    if (
      request.agent.agentDef.id !== request.agent.agentDefId ||
      typeof request.agent.skipPermissions !== 'boolean'
    ) {
      throw new TaskStructureConflictError('Agent definition identity is inconsistent');
    }
    if (request.initialPrompt) {
      requireManagedIdentifier(request.initialPrompt.deliveryId, 'initialPrompt.deliveryId');
      if (
        request.initialPrompt.text.length === 0 ||
        Buffer.byteLength(request.initialPrompt.text, 'utf8') >
          TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES ||
        !isWellFormedUnicodeScalarString(request.initialPrompt.text)
      ) {
        throw new TaskStructureConflictError('Initial prompt draft is invalid');
      }
    }
    if (request.coordinator) {
      requireManagedIdentifier(request.coordinator.runId, 'coordinator.runId');
      if (
        !path.isAbsolute(request.coordinator.credentialPath) ||
        request.coordinator.credentialPath.includes('\u0000') ||
        Buffer.byteLength(request.coordinator.credentialPath, 'utf8') > 4_096 ||
        (request.coordinator.toolCommand !== undefined &&
          (request.coordinator.toolCommand.trim().length === 0 ||
            request.coordinator.toolCommand.includes('\u0000') ||
            Buffer.byteLength(request.coordinator.toolCommand, 'utf8') > 4_096))
      ) {
        throw new TaskStructureConflictError('Coordinator launch metadata is invalid');
      }
    }
  } else if (
    request.agent !== undefined ||
    request.initialPrompt !== undefined ||
    request.coordinator !== undefined
  ) {
    throw new TaskStructureConflictError('Terminal task cannot carry agent or prompt fields');
  }
}

function managedShellOwnership(request: AddManagedTaskRequest): TaskInitialShellOwnership {
  return request.taskMode === 'agent'
    ? { kind: 'not-applicable-agent', migrationSchemaVersion: 1 }
    : {
        expectedGeneration: request.expectedInitialShellGeneration,
        kind: 'managed-terminal-v1',
        launchOperationId: request.launchOperationId,
        sessionId: request.sessionId,
      };
}

function managedOperationLink(request: AddManagedTaskRequest): TaskCreationOperationLink {
  return {
    creationOperationId: request.creationOperationId,
    kind: 'creation-v1',
    launchOperationId: request.launchOperationId,
  };
}

function createManagedTask(request: AddManagedTaskRequest): JsonObject {
  const task = createPreparedTask(request, 'managed-initial-shell-v1');
  task.taskCreationOperationLink = managedOperationLink(request) as unknown as JsonObject;
  task.taskInitialShellOwnership = managedShellOwnership(request) as unknown as JsonObject;
  if (request.taskMode === 'agent') {
    const agent = request.agent as ManagedTaskCreationAgentFields;
    const agentDef = cloneJsonObject(agent.agentDef);
    if (request.coordinator) {
      const existingEnv = isJsonObject(agentDef.env) ? agentDef.env : {};
      agentDef.env = {
        ...existingEnv,
        PARALLEL_CODE_COORDINATOR_CREDENTIAL: request.coordinator.credentialPath,
        PARALLEL_CODE_COORDINATOR_RUN_ID: request.coordinator.runId,
        ...(request.coordinator.toolCommand !== undefined
          ? { PARALLEL_CODE_COORDINATOR_TOOL: request.coordinator.toolCommand }
          : {}),
      };
      task.coordinatorCredentialPath = request.coordinator.credentialPath;
      task.coordinatorRole = 'coordinator';
      task.coordinatorRunId = request.coordinator.runId;
      if (request.coordinator.toolCommand !== undefined) {
        task.coordinatorToolCommand = request.coordinator.toolCommand;
      }
    }
    task.agentDef = agentDef;
    task.agentId = agent.agentId;
    task.agentIds = [agent.agentId];
    task.selectedAgentId = agent.agentId;
    task.skipPermissions = agent.skipPermissions;
    if (request.initialPrompt) {
      task.initialPrompt = request.initialPrompt.text;
      task.initialPromptDeliveryId = request.initialPrompt.deliveryId;
      task.initialPromptDeliveryMode = 'automatic';
      task.savedInitialPrompt = request.initialPrompt.text;
    }
  } else {
    task.shellAgentIds = [request.sessionId];
    task.shellCount = 1;
  }
  return task;
}

function validateCutoverEvidence(
  task: JsonObject,
  evidence: ExistingTaskCreationCutoverEvidence,
): void {
  if (
    !isTaskInitialShellOwnership(evidence.shellOwnership) ||
    !isTaskCreationOperationLink(evidence.operationLink)
  ) {
    throw new TaskStructureRecoveryError('Task creation cutover evidence is invalid');
  }
  const taskMode = resolvePersistedTaskMode(task.taskMode);
  if (taskMode === 'agent') {
    if (evidence.shellOwnership.kind !== 'not-applicable-agent') {
      throw new TaskStructureRecoveryError('Agent task has terminal shell ownership evidence');
    }
  } else if (taskMode === 'terminal') {
    if (evidence.shellOwnership.kind === 'not-applicable-agent') {
      throw new TaskStructureRecoveryError('Terminal task has agent shell ownership evidence');
    }
  } else {
    throw new TaskStructureRecoveryError('Canonical task mode is invalid during managed cutover');
  }
  if (
    evidence.shellOwnership.kind === 'managed-terminal-v1' &&
    (evidence.operationLink.kind !== 'creation-v1' ||
      evidence.operationLink.launchOperationId !== evidence.shellOwnership.launchOperationId)
  ) {
    throw new TaskStructureRecoveryError('Managed shell evidence does not match creation mapping');
  }
  if (
    evidence.shellOwnership.kind === 'legacy-unmanaged-terminal' &&
    evidence.operationLink.kind !== 'pre-operation-journal'
  ) {
    throw new TaskStructureRecoveryError('Legacy shell evidence cannot claim a creation journal');
  }
}

function updateProjectBranchPrefix(
  sharedState: JsonObject,
  projectId: string,
  branchPrefixPreference: string | undefined,
): void {
  if (branchPrefixPreference === undefined) return;
  const projects = requireProjects(sharedState);
  const index = projects.findIndex((project) => project.id === projectId);
  if (index < 0) throw new TaskStructureConflictError(`Project ${projectId} does not exist`);
  projects[index] = { ...projects[index], branchPrefix: branchPrefixPreference };
  sharedState.projects = projects;
}

function isSamePreparedTaskIdentity(existing: JsonObject, prepared: JsonObject): boolean {
  for (const field of [
    'baseBranch',
    'branchName',
    'gitIsolation',
    'id',
    'projectId',
    'projectMode',
    'taskMode',
    'worktreeOwnership',
    'worktreePath',
  ] as const) {
    if (existing[field] !== prepared[field]) return false;
  }
  const existingProvenance = existing[TASK_CREATION_PROVENANCE_KEY];
  const preparedProvenance = prepared[TASK_CREATION_PROVENANCE_KEY];
  return (
    isJsonObject(existingProvenance) &&
    isJsonObject(preparedProvenance) &&
    existingProvenance.creationWriterEpoch === preparedProvenance.creationWriterEpoch
  );
}

function isSameManagedTaskIdentity(existing: JsonObject, prepared: JsonObject): boolean {
  if (!isSamePreparedTaskIdentity(existing, prepared)) return false;
  for (const field of [
    'agentId',
    'agentIds',
    'coordinatorCredentialPath',
    'coordinatorRole',
    'coordinatorRunId',
    'coordinatorToolCommand',
    'selectedAgentId',
    'skipPermissions',
    'taskCreationOperationLink',
    'taskInitialShellOwnership',
  ] as const) {
    if (
      canonicalJsonStringify((existing[field] ?? null) as JsonValue) !==
      canonicalJsonStringify((prepared[field] ?? null) as JsonValue)
    ) {
      return false;
    }
  }
  return (
    canonicalJsonStringify((existing.agentDef ?? null) as JsonValue) ===
    canonicalJsonStringify((prepared.agentDef ?? null) as JsonValue)
  );
}

function stampPreManagedTasks(sharedState: JsonObject): {
  changed: boolean;
  sharedState: JsonObject;
} {
  const nextShared = cloneJsonObject(sharedState);
  const tasks = requireTasks(nextShared);
  let changed = false;
  for (const [taskId, taskValue] of Object.entries(tasks)) {
    if (!isJsonObject(taskValue)) {
      throw new TaskStructureRecoveryError(`Canonical task ${taskId} is invalid`);
    }
    const provenance = taskValue[TASK_CREATION_PROVENANCE_KEY];
    if (provenance === undefined) {
      taskValue[TASK_CREATION_PROVENANCE_KEY] = {
        creationWriterEpoch: PRE_MANAGED_WRITER_EPOCH,
      };
      changed = true;
      continue;
    }
    if (!isJsonObject(provenance) || provenance.creationWriterEpoch !== PRE_MANAGED_WRITER_EPOCH) {
      throw new TaskStructureRecoveryError(
        `Canonical task ${taskId} has incompatible creation provenance`,
      );
    }
  }
  nextShared.tasks = tasks;
  return { changed, sharedState: nextShared };
}

function withPreManagedPrivateState(privateState: JsonObject): JsonObject {
  const nextPrivate = activateProtectedPolicies(privateState, STRUCTURAL_POLICY_IDS);
  const existingSchema = nextPrivate[TASK_CREATION_SCHEMA_KEY];
  if (existingSchema !== undefined) {
    if (
      !isJsonObject(existingSchema) ||
      existingSchema.activeWriterEpoch !== PRE_MANAGED_WRITER_EPOCH
    ) {
      throw new TaskStructureRecoveryError('Task creation schema has an incompatible writer epoch');
    }
  }
  nextPrivate[TASK_CREATION_SCHEMA_KEY] = {
    activeWriterEpoch: PRE_MANAGED_WRITER_EPOCH,
  };
  return nextPrivate;
}

function assertPreManagedCutover(sharedState: JsonObject, privateState: JsonObject): void {
  if (readActiveWriterEpoch(privateState) !== PRE_MANAGED_WRITER_EPOCH) {
    throw new TaskStructureRecoveryError('Task creation writer cutover is incomplete');
  }
  const versions = getProtectedPolicyVersions(privateState);
  for (const policyId of STRUCTURAL_POLICY_IDS) {
    if (versions[policyId] !== '1') {
      throw new TaskStructureRecoveryError(`Protected policy ${policyId} is not active`);
    }
  }
  for (const [taskId, taskValue] of Object.entries(requireTasks(sharedState))) {
    if (!isJsonObject(taskValue)) {
      throw new TaskStructureRecoveryError(`Canonical task ${taskId} is invalid`);
    }
    const provenance = taskValue[TASK_CREATION_PROVENANCE_KEY];
    if (!isJsonObject(provenance) || provenance.creationWriterEpoch !== PRE_MANAGED_WRITER_EPOCH) {
      throw new TaskStructureRecoveryError(`Canonical task ${taskId} is not migration-stamped`);
    }
  }
}

function assertManagedTaskCreationCutover(sharedState: JsonObject, privateState: JsonObject): void {
  if (readActiveWriterEpoch(privateState) !== 'managed-initial-shell-v1') {
    throw new TaskStructureRecoveryError('Managed task creation writer cutover is incomplete');
  }
  const versions = getProtectedPolicyVersions(privateState);
  for (const policyId of MANAGED_CREATION_POLICY_IDS) {
    if (versions[policyId] !== '1') {
      throw new TaskStructureRecoveryError(`Protected policy ${policyId} is not active`);
    }
  }
  if (versions['initial-prompt'] !== '1') {
    throw new TaskStructureRecoveryError('Initial-prompt protection is not active');
  }
  for (const [taskId, taskValue] of Object.entries(requireTasks(sharedState))) {
    if (!isJsonObject(taskValue)) {
      throw new TaskStructureRecoveryError(`Canonical task ${taskId} is invalid`);
    }
    if (taskValue.taskMode !== 'agent' && taskValue.taskMode !== 'terminal') {
      throw new TaskStructureRecoveryError(
        `Canonical task ${taskId} has no explicit managed execution mode`,
      );
    }
    const provenance = taskValue[TASK_CREATION_PROVENANCE_KEY];
    if (
      !isJsonObject(provenance) ||
      (provenance.creationWriterEpoch !== PRE_MANAGED_WRITER_EPOCH &&
        provenance.creationWriterEpoch !== 'managed-initial-shell-v1')
    ) {
      throw new TaskStructureRecoveryError(`Canonical task ${taskId} has invalid provenance`);
    }
    const shellOwnership = taskValue.taskInitialShellOwnership;
    const operationLink = taskValue.taskCreationOperationLink;
    if (
      !isTaskInitialShellOwnership(shellOwnership) ||
      !isTaskCreationOperationLink(operationLink)
    ) {
      throw new TaskStructureRecoveryError(
        `Canonical task ${taskId} has incomplete managed creation identity`,
      );
    }
    validateCutoverEvidence(taskValue, { operationLink, shellOwnership });
    if (
      provenance.creationWriterEpoch === 'managed-initial-shell-v1' &&
      (operationLink.kind !== 'creation-v1' ||
        (taskValue.taskMode === 'terminal' && shellOwnership.kind !== 'managed-terminal-v1') ||
        (taskValue.taskMode === 'agent' && shellOwnership.kind !== 'not-applicable-agent'))
    ) {
      throw new TaskStructureRecoveryError(
        `Managed task ${taskId} has contradictory creation identity`,
      );
    }
  }
}

function stampManagedLegacyTaskModes(sharedState: JsonObject): {
  changed: boolean;
  sharedState: JsonObject;
} {
  const tasks = requireTasks(sharedState);
  let nextTasks: JsonObject | null = null;

  for (const [taskId, taskValue] of Object.entries(tasks)) {
    if (!isJsonObject(taskValue)) {
      throw new TaskStructureRecoveryError(`Canonical task ${taskId} is invalid`);
    }
    const taskMode = resolvePersistedTaskMode(taskValue.taskMode);
    if (!taskMode) {
      throw new TaskStructureRecoveryError(
        `Canonical task ${taskId} has an invalid execution mode`,
      );
    }
    if (taskValue.taskMode !== undefined) continue;

    nextTasks ??= cloneJsonObject(tasks);
    const nextTask = cloneJsonObject(taskValue);
    nextTask.taskMode = taskMode;
    nextTasks[taskId] = nextTask;
  }

  if (!nextTasks) return { changed: false, sharedState };
  const nextSharedState = cloneJsonObject(sharedState);
  nextSharedState.tasks = nextTasks;
  return { changed: true, sharedState: nextSharedState };
}

function hasCompletePreManagedCutover(sharedState: JsonObject, privateState: JsonObject): boolean {
  const schema = privateState[TASK_CREATION_SCHEMA_KEY];
  if (schema === undefined) return false;
  if (!isJsonObject(schema)) {
    throw new TaskStructureRecoveryError('Task creation schema has an incompatible writer epoch');
  }
  if (schema.activeWriterEpoch === 'managed-initial-shell-v1') {
    assertManagedTaskCreationCutover(sharedState, privateState);
    return true;
  }
  if (schema.activeWriterEpoch !== PRE_MANAGED_WRITER_EPOCH) {
    throw new TaskStructureRecoveryError('Task creation schema has an incompatible writer epoch');
  }

  const versions = getProtectedPolicyVersions(privateState);
  const activePolicyCount = STRUCTURAL_POLICY_IDS.filter(
    (policyId) => versions[policyId] === '1',
  ).length;
  if (activePolicyCount === 0) return false;
  if (activePolicyCount !== STRUCTURAL_POLICY_IDS.length) {
    throw new TaskStructureRecoveryError('Task structure policy activation is incomplete');
  }
  assertPreManagedCutover(sharedState, privateState);
  return true;
}

export class TaskStructureMutationService {
  private readonly privateAuthority: WorkspacePrivateMutationAuthority;
  private readonly removalOwner: TaskRemovalOwner;
  private admissionPaused = false;
  private activeStructuralMutations = 0;
  private drainWaiters: Array<() => void> = [];
  private cutoverPromise: Promise<void> | null = null;
  private managedWriterActivationPromise: Promise<ManagedTaskCreationWriterCapability> | null =
    null;
  private managedWriterCapability: ManagedTaskCreationWriterCapability | null = null;

  constructor(workspace: WorkspaceMutationService, options: TaskStructureMutationOptions = {}) {
    this.privateAuthority = options.privateAuthority ?? workspace.createPrivateMutationAuthority();
    this.removalOwner = new TaskRemovalOwner(this.privateAuthority, options.removalOwner);
  }

  ensurePreManagedWriterCutover(): Promise<void> {
    this.cutoverPromise ??= this.runPreManagedWriterCutover().catch((error: unknown) => {
      this.cutoverPromise = null;
      throw error;
    });
    return this.cutoverPromise;
  }

  async addTask(
    mutation: WorkspaceMutationRequest,
    request: AddPreparedTaskRequest,
  ): Promise<WorkspaceMutationResult<AddedTaskResult>> {
    return this.withStructuralAdmission(async () => {
      validateAddRequest(request);
      if (this.removalOwner.isTaskAdditionBlocked(request.taskId)) {
        throw new TaskStructureConflictError(
          `Task ${request.taskId} has durable removal history and cannot be reused`,
        );
      }
      const taskIdentityWitness = this.removalOwner.createTaskIdentityWitnessCandidate();
      this.removalOwner.beginCanonicalStructureWrite();
      try {
        const result = await this.privateAuthority.mutate<AddedTaskResult>(mutation, (slices) => {
          validateProject(request, slices.sharedState);
          const creationWriterEpoch = readActiveWriterEpoch(slices.privateState);
          if (creationWriterEpoch !== PRE_MANAGED_WRITER_EPOCH) {
            throw new TaskStructureConflictError(
              `Prepared task creation does not support writer epoch ${creationWriterEpoch}`,
            );
          }

          const tasks = requireTasks(slices.sharedState);
          const taskOrder = requireOrder(slices.sharedState, 'taskOrder');
          const collapsedTaskOrder = requireOrder(slices.sharedState, 'collapsedTaskOrder');
          const task = createPreparedTask(request, creationWriterEpoch);
          const existingTask = tasks[request.taskId];
          if (existingTask !== undefined) {
            const membershipCount =
              Number(taskOrder.includes(request.taskId)) +
              Number(collapsedTaskOrder.includes(request.taskId));
            if (membershipCount !== 1) {
              throw new TaskStructureRecoveryError(
                `Task ${request.taskId} has inconsistent canonical ordering`,
              );
            }
            if (!isJsonObject(existingTask) || !isSamePreparedTaskIdentity(existingTask, task)) {
              throw new TaskStructureConflictError(`Task ${request.taskId} already exists`);
            }
            this.removalOwner.withTaskIdentityAdded(
              slices.privateState,
              request.taskId,
              taskIdentityWitness,
              true,
            );
            return unchanged({ task: cloneJsonObject(existingTask), taskId: request.taskId });
          }
          if (taskOrder.includes(request.taskId) || collapsedTaskOrder.includes(request.taskId)) {
            throw new TaskStructureRecoveryError(
              `Task ${request.taskId} is ordered without canonical task state`,
            );
          }

          const nextShared = cloneJsonObject(slices.sharedState);
          nextShared.tasks = { ...tasks, [request.taskId]: task };
          nextShared.taskOrder = [...taskOrder, request.taskId];
          if (nextShared.collapsedTaskOrder === undefined) {
            nextShared.collapsedTaskOrder = collapsedTaskOrder;
          }
          const identity = this.removalOwner.withTaskIdentityAdded(
            slices.privateState,
            request.taskId,
            taskIdentityWitness,
            false,
          );
          return changed(
            {
              ...(identity.changed ? { nextPrivateState: identity.privateState } : {}),
              nextSharedState: nextShared,
            },
            { task: cloneJsonObject(task), taskId: request.taskId },
          );
        });
        if (result.changed) this.removalOwner.noteTaskAdded(request.taskId, result.revision);
        return result;
      } finally {
        this.removalOwner.endCanonicalStructureWrite();
      }
    });
  }

  async addManagedTask(
    mutation: WorkspaceMutationRequest,
    request: AddManagedTaskRequest,
  ): Promise<WorkspaceMutationResult<AddedTaskResult>> {
    return this.withStructuralAdmission(async () => {
      validateManagedAddRequest(request);
      if (!this.managedWriterCapability) {
        throw new TaskStructureConflictError('Managed task creation writer is not active');
      }
      if (this.removalOwner.isTaskAdditionBlocked(request.taskId)) {
        throw new TaskStructureConflictError(
          `Task ${request.taskId} has durable removal history and cannot be reused`,
        );
      }
      const taskIdentityWitness = this.removalOwner.createTaskIdentityWitnessCandidate();
      this.removalOwner.beginCanonicalStructureWrite();
      try {
        const result = await this.privateAuthority.mutate<AddedTaskResult>(mutation, (slices) => {
          validateProject(request, slices.sharedState);
          if (readActiveWriterEpoch(slices.privateState) !== 'managed-initial-shell-v1') {
            throw new TaskStructureConflictError('Managed task creation writer epoch changed');
          }
          const versions = getProtectedPolicyVersions(slices.privateState);
          for (const policyId of [...MANAGED_CREATION_POLICY_IDS, 'initial-prompt'] as const) {
            if (versions[policyId] !== '1') {
              throw new TaskStructureRecoveryError(
                `Managed task creation policy ${policyId} is unavailable`,
              );
            }
          }

          const tasks = requireTasks(slices.sharedState);
          const taskOrder = requireOrder(slices.sharedState, 'taskOrder');
          const collapsedTaskOrder = requireOrder(slices.sharedState, 'collapsedTaskOrder');
          const task = createManagedTask(request);
          const existingTask = tasks[request.taskId];
          if (existingTask !== undefined) {
            const membershipCount =
              Number(taskOrder.includes(request.taskId)) +
              Number(collapsedTaskOrder.includes(request.taskId));
            if (
              membershipCount !== 1 ||
              !isJsonObject(existingTask) ||
              !isSameManagedTaskIdentity(existingTask, task)
            ) {
              throw new TaskStructureConflictError(`Task ${request.taskId} already exists`);
            }
            this.removalOwner.withTaskIdentityAdded(
              slices.privateState,
              request.taskId,
              taskIdentityWitness,
              true,
            );
            return unchanged({ task: cloneJsonObject(existingTask), taskId: request.taskId });
          }
          if (taskOrder.includes(request.taskId) || collapsedTaskOrder.includes(request.taskId)) {
            throw new TaskStructureRecoveryError(
              `Task ${request.taskId} is ordered without canonical task state`,
            );
          }

          const nextShared = cloneJsonObject(slices.sharedState);
          const nextTasks = cloneJsonObject(tasks);
          nextTasks[request.taskId] = task;
          nextShared.tasks = nextTasks;
          nextShared.taskOrder = [...taskOrder, request.taskId];
          if (nextShared.collapsedTaskOrder === undefined) {
            nextShared.collapsedTaskOrder = collapsedTaskOrder;
          }
          updateProjectBranchPrefix(nextShared, request.projectId, request.branchPrefixPreference);
          const taskIdentity = this.removalOwner.withTaskIdentityAdded(
            slices.privateState,
            request.taskId,
            taskIdentityWitness,
            false,
          );
          return changed(
            {
              ...(taskIdentity.changed ? { nextPrivateState: taskIdentity.privateState } : {}),
              nextSharedState: nextShared,
            },
            { task: cloneJsonObject(task), taskId: request.taskId },
          );
        });
        if (result.changed) this.removalOwner.noteTaskAdded(request.taskId, result.revision);
        return result;
      } finally {
        this.removalOwner.endCanonicalStructureWrite();
      }
    });
  }

  async removeTask(
    mutation: WorkspaceMutationRequest,
    taskId: string,
  ): Promise<WorkspaceMutationResult<RemovedTaskResult>> {
    return this.withStructuralAdmission(async () => {
      this.assertTaskRemovalId(taskId);
      if (this.removalOwner.getAvailability().kind === 'active') {
        return this.removalOwner.removeTask(mutation, taskId);
      }
      return this.removeLegacyTaskMembership(mutation, taskId);
    });
  }

  /**
   * Ordinary removal cutover seam. Selection of the generic owner or the legacy effect happens
   * while one structural admission is held, so activation cannot pause a request after it has
   * already started destructive legacy cleanup.
   */
  async removeTaskWithLegacyFallback<TResult>(
    mutation: WorkspaceMutationRequest,
    taskId: string,
    legacyEffect: () => Promise<TResult>,
  ): Promise<TaskRemovalDispatchResult<TResult>> {
    return this.withStructuralAdmission(async () => {
      this.assertTaskRemovalId(taskId);
      if (this.removalOwner.getAvailability().kind === 'active') {
        return {
          kind: 'generic-owner',
          removal: await this.removalOwner.removeTask(mutation, taskId),
        };
      }
      const effectResult = await legacyEffect();
      return {
        effectResult,
        kind: 'legacy-fallback',
        removal: await this.removeLegacyTaskMembership(mutation, taskId),
      };
    });
  }

  /**
   * Commit 5's only activation path. A failed attempt deliberately leaves
   * structural admission paused; retrying this method may resume the same
   * persisted preparing epoch, but ordinary add/remove cannot bypass it.
   */
  async activateTaskRemovalOwner(
    participants: readonly TaskRemovalOwnerParticipant[],
  ): Promise<TaskRemovalOwnerCapability> {
    await this.ensurePreManagedWriterCutover();
    this.admissionPaused = true;
    await this.waitForStructuralDrain();
    const capability = await this.removalOwner.activate(participants);
    this.admissionPaused = false;
    return capability;
  }

  createTaskRemovalParticipantGate<THookSetVersion extends string>(
    participantId: TaskRemovalParticipantId,
    expectedHookSetVersion: THookSetVersion,
  ): TaskRemovalParticipantGate<THookSetVersion> {
    return this.removalOwner.createParticipantGate(participantId, expectedHookSetVersion);
  }

  verifyTaskIdentityWitnessForRemoval(
    request: Readonly<VerifyTaskRemovalPreparationRequest>,
  ): Promise<boolean> {
    return this.removalOwner.verifyTaskIdentityWitnessForRemoval(request);
  }

  getTaskRemovalOwnerCapability(): TaskRemovalOwnerCapability | null {
    const availability = this.removalOwner.getAvailability();
    return availability.kind === 'active' ? availability : null;
  }

  /** Canonical fail-closed projection for byte/effect admission during task removal. */
  isTaskMutationAdmissionClosed(taskId: string): boolean {
    return this.removalOwner.isTaskMutationAdmissionClosed(taskId);
  }

  subscribeTaskRemovalLifecycle(listener: (event: TaskRemovalLifecycleEvent) => void): () => void {
    return this.removalOwner.subscribeLifecycle(listener);
  }

  getManagedTaskCreationWriterCapability(): ManagedTaskCreationWriterCapability | null {
    return this.managedWriterCapability
      ? {
          ...this.managedWriterCapability,
          hookSetVersions: { ...this.managedWriterCapability.hookSetVersions },
        }
      : null;
  }

  activateManagedTaskCreationWriter(
    classifier: ManagedTaskCreationCutoverClassifier,
  ): Promise<ManagedTaskCreationWriterCapability> {
    this.managedWriterActivationPromise ??= this.runManagedTaskCreationWriterCutover(
      classifier,
    ).catch((error: unknown) => {
      this.managedWriterActivationPromise = null;
      throw error;
    });
    return this.managedWriterActivationPromise;
  }

  /** Backend-only D09 adapter; unavailable until the generic owner is actually active. */
  getTaskMergeRemovalAuthority(): TaskMergeRemovalAuthority {
    return this.removalOwner.getTaskMergeRemovalAuthority();
  }

  /** Active structural authority shared by the local and scoped-remote notes writers. */
  getTaskNotesStructuralAuthority(): TaskNotesStructuralAuthority {
    return this.removalOwner.getTaskNotesStructuralAuthority();
  }

  async activateTaskNotesStructuralAuthority(): Promise<TaskNotesStructuralAuthority> {
    await this.ensurePreManagedWriterCutover();
    if (this.removalOwner.getAvailability().kind !== 'active') {
      throw new TaskStructureConflictError(
        'Task notes structural cutover requires the generic removal owner',
      );
    }
    this.admissionPaused = true;
    await this.waitForStructuralDrain();
    const authority = await this.removalOwner.activateTaskNotesStructuralAuthority();
    this.admissionPaused = false;
    return authority;
  }

  async recoverTaskNotesStructuralAuthority(operationId?: string): Promise<void> {
    await this.removalOwner.recoverTaskNotesStructuralAuthority(operationId);
  }

  repairTaskRemoval(taskId: string): Promise<TaskRemovalMutationResult | null> {
    return this.removalOwner.repairTaskRemoval(taskId);
  }

  private async runManagedTaskCreationWriterCutover(
    classifier: ManagedTaskCreationCutoverClassifier,
  ): Promise<ManagedTaskCreationWriterCapability> {
    if (!classifier || typeof classifier.classify !== 'function') {
      throw new TaskStructureConflictError('Managed task creation classifier is unavailable');
    }
    await this.ensurePreManagedWriterCutover();
    const removal = this.getTaskRemovalOwnerCapability();
    if (!removal) {
      throw new TaskStructureConflictError(
        'Managed task creation requires the active generic removal owner',
      );
    }
    this.admissionPaused = true;
    await this.waitForStructuralDrain();

    const observed = await this.privateAuthority.mutate(
      { operation: 'inspect-managed-task-creation-writer-cutover' },
      (slices) =>
        unchanged({
          privateState: cloneJsonObject(slices.privateState),
          revision: slices.sharedRevision,
          sharedState: cloneJsonObject(slices.sharedState),
        }),
    );
    const observedEpoch = readActiveWriterEpoch(observed.result.privateState);
    if (observedEpoch === PRE_MANAGED_WRITER_EPOCH) {
      const tasks = requireTasks(observed.result.sharedState);
      const evidenceByTaskId = new Map<string, ExistingTaskCreationCutoverEvidence>();
      const entries = Object.entries(tasks).sort(([left], [right]) => left.localeCompare(right));
      for (let offset = 0; offset < entries.length; offset += 16) {
        await Promise.all(
          entries.slice(offset, offset + 16).map(async ([taskId, taskValue]) => {
            if (!isJsonObject(taskValue)) {
              throw new TaskStructureRecoveryError(`Canonical task ${taskId} is invalid`);
            }
            const provenance = taskValue[TASK_CREATION_PROVENANCE_KEY];
            if (
              !isJsonObject(provenance) ||
              provenance.creationWriterEpoch !== PRE_MANAGED_WRITER_EPOCH
            ) {
              throw new TaskStructureRecoveryError(
                `Canonical task ${taskId} is not pre-managed migration input`,
              );
            }
            const evidence = await classifier.classify(taskId, cloneJsonObject(taskValue));
            validateCutoverEvidence(taskValue, evidence);
            evidenceByTaskId.set(taskId, structuredClone(evidence));
          }),
        );
      }

      await this.privateAuthority.mutate(
        {
          expectedSharedRevision: observed.result.revision,
          operation: 'activate-managed-task-creation-writer',
        },
        (slices) => {
          if (readActiveWriterEpoch(slices.privateState) !== PRE_MANAGED_WRITER_EPOCH) {
            throw new TaskStructureRecoveryError(
              'Task creation writer epoch changed during cutover',
            );
          }
          const currentTasks = requireTasks(slices.sharedState);
          const currentIds = Object.keys(currentTasks).sort();
          const observedIds = Object.keys(tasks).sort();
          if (
            currentIds.length !== observedIds.length ||
            currentIds.some((taskId, index) => taskId !== observedIds[index])
          ) {
            throw new TaskStructureRecoveryError('Task membership changed during managed cutover');
          }
          const nextShared = cloneJsonObject(slices.sharedState);
          const nextTasks = cloneJsonObject(currentTasks);
          for (const taskId of currentIds) {
            const currentTask = currentTasks[taskId];
            const observedTask = tasks[taskId];
            const evidence = evidenceByTaskId.get(taskId);
            if (
              !isJsonObject(currentTask) ||
              !isJsonObject(observedTask) ||
              canonicalJsonStringify(currentTask) !== canonicalJsonStringify(observedTask) ||
              !evidence
            ) {
              throw new TaskStructureRecoveryError(
                `Canonical task ${taskId} changed during managed cutover`,
              );
            }
            const taskMode = resolvePersistedTaskMode(currentTask.taskMode);
            if (!taskMode) {
              throw new TaskStructureRecoveryError(
                `Canonical task ${taskId} has an invalid execution mode`,
              );
            }
            const nextTask = cloneJsonObject(currentTask);
            nextTask.taskMode = taskMode;
            nextTask.taskInitialShellOwnership = evidence.shellOwnership as unknown as JsonObject;
            nextTask.taskCreationOperationLink = evidence.operationLink as unknown as JsonObject;
            nextTasks[taskId] = nextTask;
          }
          nextShared.tasks = nextTasks;
          const nextPrivate = activateProtectedPolicies(
            slices.privateState,
            MANAGED_CREATION_POLICY_IDS,
          );
          nextPrivate[TASK_CREATION_SCHEMA_KEY] = {
            activeWriterEpoch: 'managed-initial-shell-v1',
          };
          return changed({ nextPrivateState: nextPrivate, nextSharedState: nextShared }, undefined);
        },
      );
    }

    await this.privateAuthority.mutate(
      { operation: 'verify-managed-task-creation-writer' },
      (slices) => {
        assertManagedTaskCreationCutover(slices.sharedState, slices.privateState);
        return unchanged(undefined);
      },
    );
    const latestRemoval = this.getTaskRemovalOwnerCapability();
    if (
      !latestRemoval ||
      latestRemoval.cutoverEpoch !== removal.cutoverEpoch ||
      canonicalJsonStringify(latestRemoval.hookSetVersions as JsonValue) !==
        canonicalJsonStringify(removal.hookSetVersions as JsonValue)
    ) {
      throw new TaskStructureRecoveryError('Generic removal capability changed during cutover');
    }
    const capability: ManagedTaskCreationWriterCapability = {
      cutoverEpoch: removal.cutoverEpoch,
      hookSetVersions: { ...removal.hookSetVersions },
      kind: 'active',
      writerEpoch: 'managed-initial-shell-v1',
    };
    this.managedWriterCapability = capability;
    this.admissionPaused = false;
    return capability;
  }

  private async runPreManagedWriterCutover(): Promise<void> {
    this.admissionPaused = true;
    await this.waitForStructuralDrain();
    try {
      await this.privateAuthority.mutate(
        { operation: 'activate-pre-managed-task-writer' },
        (slices) => {
          const existingSchema = slices.privateState[TASK_CREATION_SCHEMA_KEY];
          if (
            isJsonObject(existingSchema) &&
            existingSchema.activeWriterEpoch === 'managed-initial-shell-v1'
          ) {
            const stamped = stampManagedLegacyTaskModes(slices.sharedState);
            assertManagedTaskCreationCutover(stamped.sharedState, slices.privateState);
            return stamped.changed
              ? changed({ nextSharedState: stamped.sharedState }, undefined)
              : unchanged(undefined);
          }
          if (hasCompletePreManagedCutover(slices.sharedState, slices.privateState)) {
            return unchanged(undefined);
          }
          const stamped = stampPreManagedTasks(slices.sharedState);
          const nextPrivate = withPreManagedPrivateState(slices.privateState);
          return changed(
            {
              nextPrivateState: nextPrivate,
              ...(stamped.changed ? { nextSharedState: stamped.sharedState } : {}),
            },
            undefined,
          );
        },
      );
      await this.privateAuthority.mutate(
        { operation: 'verify-pre-managed-task-writer' },
        (slices) => {
          if (readActiveWriterEpoch(slices.privateState) === 'managed-initial-shell-v1') {
            assertManagedTaskCreationCutover(slices.sharedState, slices.privateState);
          } else {
            assertPreManagedCutover(slices.sharedState, slices.privateState);
          }
          return unchanged(undefined);
        },
      );
    } finally {
      this.admissionPaused = false;
    }
  }

  private assertTaskRemovalId(taskId: string): void {
    if (taskId.trim().length === 0) {
      throw new TaskStructureConflictError('taskId must not be empty');
    }
  }

  private removeLegacyTaskMembership(
    mutation: WorkspaceMutationRequest,
    taskId: string,
  ): Promise<WorkspaceMutationResult<RemovedTaskResult>> {
    return this.privateAuthority.mutate<RemovedTaskResult>(mutation, (slices) => {
      readActiveWriterEpoch(slices.privateState);
      const tasks = requireTasks(slices.sharedState);
      const taskOrder = requireOrder(slices.sharedState, 'taskOrder');
      const collapsedTaskOrder = requireOrder(slices.sharedState, 'collapsedTaskOrder');
      if (tasks[taskId] === undefined) {
        if (taskOrder.includes(taskId) || collapsedTaskOrder.includes(taskId)) {
          throw new TaskStructureRecoveryError(
            `Task ${taskId} is ordered without canonical task state`,
          );
        }
        return unchanged({ removed: false, taskId });
      }

      const nextTasks = cloneJsonObject(tasks);
      Reflect.deleteProperty(nextTasks, taskId);
      const nextShared = cloneJsonObject(slices.sharedState);
      nextShared.tasks = nextTasks;
      nextShared.taskOrder = taskOrder.filter((id) => id !== taskId);
      nextShared.collapsedTaskOrder = collapsedTaskOrder.filter((id) => id !== taskId);
      return changed({ nextSharedState: nextShared }, { removed: true, taskId });
    });
  }

  private async withStructuralAdmission<TResult>(
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    await this.ensurePreManagedWriterCutover();
    if (this.admissionPaused) {
      throw new TaskStructureConflictError('Task structure admission is paused');
    }
    this.activeStructuralMutations += 1;
    try {
      return await operation();
    } finally {
      this.activeStructuralMutations -= 1;
      if (this.activeStructuralMutations === 0) {
        for (const resolve of this.drainWaiters.splice(0)) resolve();
      }
    }
  }

  private waitForStructuralDrain(): Promise<void> {
    if (this.activeStructuralMutations === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }
}
