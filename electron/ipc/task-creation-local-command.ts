import { createHash } from 'node:crypto';

import { buildCoordinatorInitialPrompt } from '../../src/domain/coordinator-instructions.js';
import type {
  CreateTaskCreationOperationResult,
  TaskCreationIntent,
  TaskCreationOperationSnapshot,
} from '../../src/domain/task-creation.js';
import {
  createTaskCreationAuthEpoch,
  isTaskCreationOperationCapability,
  isTaskCreationOperationId,
  type TaskCreationOperationCapability,
  type TaskCreationOperationId,
  type TaskCreationTicketAuthenticationContext,
} from '../../src/domain/task-creation-ticket.js';
import {
  isTaskCreationOperationLink,
  isTaskCreationProvenance,
  isTaskInitialShellOwnership,
} from '../../src/domain/task-creation-provenance.js';
import type { CreateTaskResult } from '../../src/ipc/types.js';
import type { ProjectMode, TaskGitIsolationMode } from '../../src/store/types.js';
import type { TrustedCoordinatorTaskCreationWorkflow } from './coordinator-task-creation-workflow.js';
import type { TaskCreationJournal } from './task-creation-journal.js';
import type { TaskCreationOperationTicketIssuer } from './task-creation-operation-ticket.js';
import type { ProductionTaskCreationPreparationOwner } from './task-creation-preparation-owner.js';
import type { TaskCreationWorkflow } from './task-creation-workflow.js';
import { unchanged, type WorkspacePrivateMutationAuthority } from './workspace-state-mutations.js';
import { cloneJsonObject, type JsonObject, type JsonValue } from './workspace-state-storage.js';

const TRUSTED_LOCAL_PRINCIPAL_ID = 'trusted-local-ui';
const OPERATION_ID_DOMAIN = 'parallel-code:trusted-local-task-creation:operation:v1';
const CAPABILITY_DOMAIN = 'parallel-code:trusted-local-task-creation:capability:v1';

const TRUSTED_LOCAL_AUTHENTICATION: TaskCreationTicketAuthenticationContext = Object.freeze({
  authEpoch: createTaskCreationAuthEpoch(0),
  authenticationSessionGeneration: new Uint8Array(16),
  workspacePrincipalId: TRUSTED_LOCAL_PRINCIPAL_ID,
});

export interface TrustedLocalTaskCreationRequest {
  /** Renderer-adapter idempotency identity; private operation access is derived backend-side. */
  adapterOperationId: string;
  agentDefId?: string;
  baseBranch?: string;
  branchPrefix?: string;
  coordinatorMode?: boolean;
  existingWorktreePath?: string;
  gitIsolation?: TaskGitIsolationMode;
  githubUrl?: string;
  initialPrompt?: string;
  name: string;
  projectId: string;
  projectMode?: ProjectMode;
  projectRoot: string;
  skipPermissions?: boolean;
  stepsTracking?: boolean;
  symlinkDirs: string[];
}

export interface TrustedLocalTaskCreationCommand {
  create(request: Readonly<TrustedLocalTaskCreationRequest>): Promise<CreateTaskResult>;
}

export interface CreateTrustedLocalTaskCreationCommandDependencies {
  coordinator: Pick<TrustedCoordinatorTaskCreationWorkflow, 'create'>;
  journal: Pick<TaskCreationJournal, 'getByOperationId'>;
  preparation: ProductionTaskCreationPreparationOwner;
  privateAuthority: WorkspacePrivateMutationAuthority;
  tickets: Pick<TaskCreationOperationTicketIssuer, 'issueTrustedLocal'>;
  workflow: Pick<TaskCreationWorkflow, 'create'>;
}

function deriveOperationId(adapterOperationId: string): TaskCreationOperationId {
  const digest = createHash('sha256')
    .update(OPERATION_ID_DOMAIN, 'utf8')
    .update('\u0000', 'utf8')
    .update(adapterOperationId, 'utf8')
    .digest()
    .subarray(0, 16)
    .toString('base64url');
  if (!isTaskCreationOperationId(digest)) {
    throw new Error('Trusted-local task-creation operation identity is invalid');
  }
  return digest;
}

function deriveOperationCapability(adapterOperationId: string): TaskCreationOperationCapability {
  const capability = createHash('sha256')
    .update(CAPABILITY_DOMAIN, 'utf8')
    .update('\u0000', 'utf8')
    .update(adapterOperationId, 'utf8')
    .digest('base64url');
  if (!isTaskCreationOperationCapability(capability)) {
    throw new Error('Trusted-local task-creation capability is invalid');
  }
  return capability;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function creationFailureMessage(result: CreateTaskCreationOperationResult): string {
  if (result.kind === 'create-rejected-without-snapshot') {
    return `Task creation was rejected (${result.code})`;
  }
  if (result.kind !== 'snapshot') {
    return `Task creation is unavailable (${result.code})`;
  }
  return result.snapshot.issue?.message ?? `Task creation stopped in ${result.snapshot.phase}`;
}

function requireCommittedSnapshot(
  result: CreateTaskCreationOperationResult,
): TaskCreationOperationSnapshot & { commit: 'committed'; committedTaskId: string } {
  if (
    result.kind !== 'snapshot' ||
    result.snapshot.commit !== 'committed' ||
    result.snapshot.committedTaskId === null
  ) {
    throw new Error(creationFailureMessage(result));
  }
  return result.snapshot as TaskCreationOperationSnapshot & {
    commit: 'committed';
    committedTaskId: string;
  };
}

function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') throw new Error(`Canonical task ${label} is unavailable`);
  return value;
}

function requireStringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Canonical task ${label} is unavailable`);
  }
  return [...value] as string[];
}

function toLocation(
  request: Readonly<TrustedLocalTaskCreationRequest>,
  selection: Awaited<
    ReturnType<ProductionTaskCreationPreparationOwner['resolveTrustedLocalSelection']>
  >,
): TaskCreationIntent['location'] {
  if (selection.projectMode === 'non-git' || request.gitIsolation === 'current-branch') {
    return { kind: 'project-root' };
  }
  if (request.gitIsolation === 'existing-worktree') {
    if (!selection.existingWorktreeRef) {
      throw new Error('Selected existing worktree is unavailable');
    }
    return { kind: 'existing-worktree', worktreeRef: selection.existingWorktreeRef };
  }
  return { kind: 'managed-worktree', requestedLinkNames: [...request.symlinkDirs] };
}

function toLaunch(
  request: Readonly<TrustedLocalTaskCreationRequest>,
): TaskCreationIntent['launch'] {
  if (!request.agentDefId) {
    if (
      request.coordinatorMode === true ||
      request.initialPrompt !== undefined ||
      request.skipPermissions !== undefined
    ) {
      throw new Error('Agent-only task creation fields require an agent definition');
    }
    return { kind: 'terminal' };
  }
  const initialPrompt =
    request.coordinatorMode === true
      ? buildCoordinatorInitialPrompt(request.initialPrompt)
      : request.initialPrompt;
  return {
    agentDefId: request.agentDefId,
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
    kind: 'agent',
    skipPermissions: request.skipPermissions === true,
  };
}

class TrustedLocalTaskCreationCommandImpl implements TrustedLocalTaskCreationCommand {
  constructor(private readonly dependencies: CreateTrustedLocalTaskCreationCommandDependencies) {}

  async create(request: Readonly<TrustedLocalTaskCreationRequest>): Promise<CreateTaskResult> {
    const operationId = deriveOperationId(request.adapterOperationId);
    const operationCapability = deriveOperationCapability(request.adapterOperationId);
    const knownRecord = this.dependencies.journal.getByOperationId(operationId);
    const selection = this.dependencies.preparation.normalizeTrustedLocalSelection({
      ...(request.baseBranch !== undefined ? { baseBranch: request.baseBranch } : {}),
      ...(request.existingWorktreePath !== undefined
        ? { existingWorktreePath: request.existingWorktreePath }
        : {}),
      projectId: request.projectId,
      ...(request.projectMode !== undefined ? { projectMode: request.projectMode } : {}),
      projectRoot: request.projectRoot,
    });
    const operationTicket = knownRecord
      ? 'known-operation-replay'
      : this.dependencies.tickets.issueTrustedLocal(TRUSTED_LOCAL_AUTHENTICATION, operationId)
          .operationTicket;
    const intent: TaskCreationIntent = {
      ...(selection.baseBranchRef ? { baseBranchRef: selection.baseBranchRef } : {}),
      ...(selection.projectMode === 'git' && request.branchPrefix !== undefined
        ? { branchPrefixPreference: request.branchPrefix }
        : {}),
      ...(request.githubUrl !== undefined ? { githubUrl: request.githubUrl } : {}),
      launch: toLaunch(request),
      location: toLocation(request, selection),
      name: request.name,
      operationCapability,
      operationId,
      operationTicket,
      projectId: request.projectId,
      stepsTracking: request.stepsTracking === true,
    };
    const result =
      request.coordinatorMode === true
        ? await this.dependencies.coordinator.create(TRUSTED_LOCAL_AUTHENTICATION, intent)
        : await this.dependencies.workflow.create(TRUSTED_LOCAL_AUTHENTICATION, intent);
    const snapshot = requireCommittedSnapshot(result);
    const record = this.dependencies.journal.getByOperationId(operationId);
    if (
      !record ||
      record.commit.kind !== 'committed' ||
      record.commit.taskId !== snapshot.committedTaskId
    ) {
      throw new Error('Committed task creation journal identity is unavailable');
    }
    const task = await this.readCanonicalTask(snapshot.committedTaskId);
    return this.toCompatibilityResult(
      request,
      operationId,
      record.identities.sessionId,
      task,
      snapshot,
    );
  }

  private async readCanonicalTask(taskId: string): Promise<JsonObject> {
    const read = await this.dependencies.privateAuthority.mutate(
      { operation: 'read-trusted-local-task-creation-result' },
      (slices) => {
        const tasks = slices.sharedState.tasks;
        const task = isJsonObject(tasks) ? tasks[taskId] : undefined;
        if (!isJsonObject(task)) throw new Error('Committed task is absent from canonical state');
        return unchanged(cloneJsonObject(task));
      },
    );
    return read.result;
  }

  private toCompatibilityResult(
    request: Readonly<TrustedLocalTaskCreationRequest>,
    operationId: TaskCreationOperationId,
    sessionId: string,
    task: Readonly<JsonObject>,
    snapshot: TaskCreationOperationSnapshot & { commit: 'committed'; committedTaskId: string },
  ): CreateTaskResult {
    const taskId = requireString(task.id, 'id');
    const taskMode = task.taskMode;
    const operationLink = task.taskCreationOperationLink;
    const provenance = task.taskCreationProvenance;
    const shellOwnership = task.taskInitialShellOwnership;
    const canonicalAgentDef = isJsonObject(task.agentDef) ? task.agentDef : null;
    if (
      taskId !== snapshot.committedTaskId ||
      (taskMode !== 'agent' && taskMode !== 'terminal') ||
      !isTaskCreationOperationLink(operationLink) ||
      operationLink.kind !== 'creation-v1' ||
      operationLink.creationOperationId !== operationId ||
      !isTaskCreationProvenance(provenance) ||
      provenance.creationWriterEpoch !== 'managed-initial-shell-v1' ||
      !isTaskInitialShellOwnership(shellOwnership)
    ) {
      throw new Error('Canonical task creation identity is inconsistent');
    }
    if (taskMode === 'agent') {
      if (
        !canonicalAgentDef ||
        canonicalAgentDef.id !== request.agentDefId ||
        typeof canonicalAgentDef.name !== 'string' ||
        canonicalAgentDef.name.length === 0 ||
        task.agentId !== sessionId ||
        !requireStringArray(task.agentIds, 'agentIds').includes(sessionId) ||
        shellOwnership.kind !== 'not-applicable-agent'
      ) {
        throw new Error('Canonical agent creation identity is inconsistent');
      }
    } else if (
      !requireStringArray(task.shellAgentIds, 'shellAgentIds').includes(sessionId) ||
      shellOwnership.kind !== 'managed-terminal-v1' ||
      shellOwnership.sessionId !== sessionId
    ) {
      throw new Error('Canonical terminal creation identity is inconsistent');
    }

    const projectMode = task.projectMode === 'non-git' ? 'non-git' : 'git';
    const gitIsolation =
      task.gitIsolation === 'worktree' ||
      task.gitIsolation === 'current-branch' ||
      task.gitIsolation === 'existing-worktree'
        ? task.gitIsolation
        : undefined;
    if (projectMode === 'git' && gitIsolation === undefined) {
      throw new Error('Canonical task Git isolation is unavailable');
    }
    const coordinatorRunId =
      typeof task.coordinatorRunId === 'string' ? task.coordinatorRunId : undefined;
    const coordinatorCredentialPath =
      typeof task.coordinatorCredentialPath === 'string'
        ? task.coordinatorCredentialPath
        : undefined;
    if (
      request.coordinatorMode === true &&
      (!coordinatorRunId || !coordinatorCredentialPath || task.coordinatorRole !== 'coordinator')
    ) {
      throw new Error('Canonical coordinator creation metadata is unavailable');
    }

    return {
      ...(canonicalAgentDef
        ? {
            agent_def_id: requireString(canonicalAgentDef.id, 'agent definition id'),
            agent_def_name: requireString(canonicalAgentDef.name, 'agent definition name'),
          }
        : {}),
      ...(typeof task.baseBranch === 'string' ? { base_branch: task.baseBranch } : {}),
      branch_name: requireString(task.branchName, 'branchName'),
      ...(coordinatorCredentialPath
        ? { coordinator_credential_path: coordinatorCredentialPath }
        : {}),
      ...(coordinatorRunId ? { coordinator_run_id: coordinatorRunId } : {}),
      ...(typeof task.coordinatorToolCommand === 'string'
        ? { coordinator_tool_command: task.coordinatorToolCommand }
        : {}),
      creation_operation_id: operationLink.creationOperationId,
      creation_phase: snapshot.phase,
      ...(snapshot.issue ? { creation_issue: structuredClone(snapshot.issue) } : {}),
      creation_writer_epoch: provenance.creationWriterEpoch,
      ...(gitIsolation ? { git_isolation: gitIsolation } : {}),
      id: taskId,
      ...(typeof task.initialPrompt === 'string' ? { initial_prompt: task.initialPrompt } : {}),
      ...(typeof task.initialPromptDeliveryId === 'string'
        ? { initial_prompt_delivery_id: task.initialPromptDeliveryId }
        : {}),
      launch_operation_id: operationLink.launchOperationId,
      project_mode: projectMode,
      session_id: sessionId,
      symlink_warnings: structuredClone(snapshot.symlinkWarnings),
      task_creation_operation_link: structuredClone(operationLink),
      task_creation_provenance: structuredClone(provenance),
      task_initial_shell_ownership: structuredClone(shellOwnership),
      task_name: requireString(task.name, 'name'),
      workspace_revision: snapshot.committedWorkspaceRevision,
      worktree_path: requireString(task.worktreePath, 'worktreePath'),
    };
  }
}

export function createTrustedLocalTaskCreationCommand(
  dependencies: CreateTrustedLocalTaskCreationCommandDependencies,
): TrustedLocalTaskCreationCommand {
  return new TrustedLocalTaskCreationCommandImpl(dependencies);
}
