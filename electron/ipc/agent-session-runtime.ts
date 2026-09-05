import {
  AGENT_SESSION_OWNER_HOOK_SET_VERSION,
  isManagedAgentSessionRestoreRequest,
  transitionAgentSessionOperation,
  type AgentSessionOperationProjection,
  type AgentSessionOperationRequest,
  type AgentSessionLaunchReason,
  type GetAgentSessionOperationProjectionRequest,
  type AgentSessionOwnerAvailability,
  type ManagedAgentSessionRestoreRequest,
  type ManagedAgentSessionRestoreResult,
} from '../../src/domain/agent-session-operation.js';
import { isTaskCreationOperationLink } from '../../src/domain/task-creation-provenance.js';
import type { AgentDef } from '../../src/ipc/types.js';
import { buildAgentSpawnArgs, shouldResumeAgentOnSpawn } from '../../src/lib/agent-resume.js';
import {
  getAgentSpawnCommand,
  getAgentSpawnEnvironment,
} from '../../src/lib/agent-spawn-config.js';
import { isHydraStartupMode } from '../../src/lib/hydra.js';
import { getAgentDefsWithLastKnownAvailability } from './agents.js';
import { normalizeAgentRunnerProfileConfig } from './agent-runner-handlers.js';
import {
  AGENT_SESSION_RECOVERY_CONTROLLER_ID,
  createAgentSessionRecoveryAdapter,
  type FinalizedAgentSessionExit,
} from './agent-session-recovery.js';
import {
  createFileAgentSessionOperationJournal,
  deriveAgentSessionCleanRestartOperationId,
  deriveAgentSessionOperationFingerprint,
  deriveLegacyAgentInitialRestoreIdentity,
  type AgentSessionCleanRestartMarker,
  type AgentSessionIdentityMarker,
  type AgentSessionJournalOperationRecord,
  type AgentSessionOperationJournal,
} from './agent-session-operation-journal.js';
import { WorkspaceAgentSessionLegacyWriterCutover } from './agent-session-legacy-writer-cutover.js';
import type { AgentSessionLegacyWriterCutover } from './agent-session-removal-participant.js';
import {
  createAgentSessionWorkflow,
  type AgentSessionAdmissionInspection,
  type AgentSessionGenerationAllocationRequest,
  type AgentSessionRunnerOperationRequest,
  type AgentSessionWorkflow,
  type AgentSessionWorkflowAuthority,
} from './agent-session-workflow.js';
import type { AgentSessionWriterRuntime } from './agent-session-writer-authority.js';
import type { HandlerContext } from './handler-context.js';
import {
  getActiveAgentIds,
  getAgentCols,
  getAgentLifecycleGeneration,
  getAgentMeta,
  getAgentRows,
  hasAgentSession,
  onPtyEvent,
} from './pty.js';
import type { TaskStructureMutationService } from './task-structure-mutations.js';
import {
  spawnAllocatedTaskAgentWorkflow,
  stopTaskAgentWorkflow,
  stopTaskAgentWorkflowsForTask,
} from './task-workflows.js';
import {
  acquireTaskCommandLease,
  getTaskCommandLeaseIdentity,
  isTaskCommandLeaseGenerationHeld,
  releaseTaskCommandLease,
} from './task-command-leases.js';
import {
  changed,
  unchanged,
  type WorkspacePrivateMutationAuthority,
} from './workspace-state-mutations.js';
import { cloneJsonObject, type JsonObject, type JsonValue } from './workspace-state-storage.js';

interface CanonicalAgentTaskSnapshot {
  agentDef: AgentDef;
  project: JsonObject;
  revision: number;
  sharedState: JsonObject;
  task: JsonObject;
}

interface CanonicalAgentSpawnRequest {
  agentDef: AgentDef;
  agentId: string;
  assertSpawnAdmitted: () => void;
  canonical: CanonicalAgentTaskSnapshot;
  cols: number;
  launchReason: AgentSessionLaunchReason;
  operationId: string;
  replaceExistingSession: boolean;
  resumed: boolean;
  rows: number;
  targetGeneration: number;
  taskId: string;
}

interface CleanRestartShutdownSnapshot {
  agentId: string;
  marker: AgentSessionCleanRestartMarker;
  taskId: string;
}

export interface ProductionAgentSessionRuntimeAdapters {
  acquireRecoveryLease: typeof acquireTaskCommandLease;
  getActiveAgentIds: typeof getActiveAgentIds;
  getAgentCols: typeof getAgentCols;
  getAgentLifecycleGeneration: typeof getAgentLifecycleGeneration;
  getAgentMeta: typeof getAgentMeta;
  getAgentRows: typeof getAgentRows;
  hasAgentSession: typeof hasAgentSession;
  isLeaseGenerationHeld: typeof isTaskCommandLeaseGenerationHeld;
  onPtyEvent: typeof onPtyEvent;
  readLeaseIdentity: typeof getTaskCommandLeaseIdentity;
  releaseRecoveryLease: typeof releaseTaskCommandLease;
  spawnAllocated: typeof spawnAllocatedTaskAgentWorkflow;
  stopAgent: typeof stopTaskAgentWorkflow;
  stopTask: typeof stopTaskAgentWorkflowsForTask;
}

export interface CreateProductionAgentSessionRuntimeDependencies {
  adapters?: Partial<ProductionAgentSessionRuntimeAdapters>;
  context: HandlerContext;
  journal?: AgentSessionOperationJournal;
  privateAuthority: WorkspacePrivateMutationAuthority;
  structure: TaskStructureMutationService;
  writer: AgentSessionWriterRuntime;
}

export interface ProductionAgentSessionRuntime {
  activateAutomaticRecovery(): void;
  authority: AgentSessionWorkflowAuthority;
  classifyCanonicalSessionIdentity(
    request: Readonly<ManagedAgentSessionRestoreRequest>,
  ): Promise<'managed-agent' | 'unavailable' | 'unmanaged'>;
  close(): Promise<void>;
  completeCleanShutdown(): Promise<void>;
  getProjection(
    request: Readonly<GetAgentSessionOperationProjectionRequest>,
  ): Promise<AgentSessionOperationProjection | null>;
  journal: AgentSessionOperationJournal;
  legacyWriterCutover: AgentSessionLegacyWriterCutover;
  prepareCleanShutdown(): Promise<void>;
  restoreCanonicalSession(
    request: Readonly<ManagedAgentSessionRestoreRequest>,
  ): Promise<ManagedAgentSessionRestoreResult>;
  startup(): Promise<void>;
  subscribe(listener: (projection: AgentSessionOperationProjection) => void): () => void;
  workflow: AgentSessionWorkflow;
}

const DEFAULT_ADAPTERS: ProductionAgentSessionRuntimeAdapters = {
  acquireRecoveryLease: acquireTaskCommandLease,
  getActiveAgentIds,
  getAgentCols,
  getAgentLifecycleGeneration,
  getAgentMeta,
  getAgentRows,
  hasAgentSession,
  isLeaseGenerationHeld: isTaskCommandLeaseGenerationHeld,
  onPtyEvent,
  readLeaseIdentity: getTaskCommandLeaseIdentity,
  releaseRecoveryLease: releaseTaskCommandLease,
  spawnAllocated: spawnAllocatedTaskAgentWorkflow,
  stopAgent: stopTaskAgentWorkflow,
  stopTask: stopTaskAgentWorkflowsForTask,
};

const RECOVERY_LEASE_HANDOFF_ATTEMPTS = 80;
const RECOVERY_LEASE_HANDOFF_DELAY_MS = 25;

function waitForRecoveryLeaseHandoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RECOVERY_LEASE_HANDOFF_DELAY_MS));
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function cloneAgentDef(value: JsonValue | undefined): AgentDef | null {
  if (!isJsonObject(value)) return null;
  if (
    typeof value.id !== 'string' ||
    value.id.trim().length === 0 ||
    typeof value.name !== 'string' ||
    typeof value.command !== 'string' ||
    value.command.trim().length === 0 ||
    typeof value.description !== 'string' ||
    !isStringArray(value.args) ||
    !isStringArray(value.resume_args) ||
    !isStringArray(value.skip_permissions_args) ||
    (value.adapter !== undefined && value.adapter !== 'hydra') ||
    (value.resume_strategy !== undefined &&
      value.resume_strategy !== 'cli-args' &&
      value.resume_strategy !== 'hydra-session' &&
      value.resume_strategy !== 'none') ||
    (value.resume_failure_classifier !== undefined &&
      value.resume_failure_classifier !== 'claude-no-conversation-v1') ||
    (value.resume_failure_fallback !== undefined &&
      value.resume_failure_fallback !== 'fresh-start' &&
      value.resume_failure_fallback !== 'none')
  ) {
    return null;
  }
  let env: Record<string, string> | undefined;
  if (value.env !== undefined) {
    if (!isJsonObject(value.env)) return null;
    const entries = Object.entries(value.env);
    if (entries.some((entry) => typeof entry[1] !== 'string')) return null;
    env = Object.fromEntries(entries) as Record<string, string>;
  }
  return {
    id: value.id,
    name: value.name,
    command: value.command,
    args: [...value.args],
    resume_args: [...value.resume_args],
    skip_permissions_args: [...value.skip_permissions_args],
    description: value.description,
    ...(value.adapter === 'hydra' ? { adapter: 'hydra' as const } : {}),
    ...(env ? { env } : {}),
    ...(value.resume_strategy !== undefined ? { resume_strategy: value.resume_strategy } : {}),
    ...(value.resume_failure_classifier !== undefined
      ? { resume_failure_classifier: value.resume_failure_classifier }
      : {}),
    ...(value.resume_failure_fallback !== undefined
      ? { resume_failure_fallback: value.resume_failure_fallback }
      : {}),
  };
}

function getTaskAgentDef(task: JsonObject, agentId: string): AgentDef | null {
  if (isStringArray(task.agentIds) && Array.isArray(task.agentDefs)) {
    const index = task.agentIds.indexOf(agentId);
    if (index >= 0) return cloneAgentDef(task.agentDefs[index]);
  }
  if (
    (task.agentId === agentId || (isStringArray(task.agentIds) && task.agentIds[0] === agentId)) &&
    task.agentDef !== undefined
  ) {
    return cloneAgentDef(task.agentDef);
  }
  return null;
}

function getAvailableAgentDef(
  sharedState: Readonly<JsonObject>,
  agentDefId: string,
): AgentDef | null {
  const hydraCommand = typeof sharedState.hydraCommand === 'string' ? sharedState.hydraCommand : '';
  const custom = Array.isArray(sharedState.customAgents)
    ? sharedState.customAgents.flatMap((value) => {
        const definition = cloneAgentDef(value);
        return definition ? [definition] : [];
      })
    : [];
  const customMatch = custom.find((definition) => definition.id === agentDefId);
  if (customMatch) return customMatch;
  return (
    getAgentDefsWithLastKnownAvailability(hydraCommand).find(
      (definition) =>
        definition.id === agentDefId && !custom.some((customDef) => customDef.id === agentDefId),
    ) ?? null
  );
}

async function persistCanonicalAgentSwitch(
  authority: WorkspacePrivateMutationAuthority,
  taskId: string,
  agentId: string,
  nextAgentDefId: string,
): Promise<AgentDef | null> {
  const result = await authority.mutate(
    { operation: 'switch-agent-session-definition' },
    (slices) => {
      const tasks = slices.sharedState.tasks;
      if (!isJsonObject(tasks)) return unchanged(null);
      const task = tasks[taskId];
      if (!isJsonObject(task) || !isStringArray(task.agentIds)) return unchanged(null);
      const agentIndex = task.agentIds.indexOf(agentId);
      const nextDefinition = getAvailableAgentDef(slices.sharedState, nextAgentDefId);
      if (agentIndex < 0 || !nextDefinition) return unchanged(null);

      const definitions = task.agentIds.map((id) => getTaskAgentDef(task, id));
      if (definitions.some((definition) => definition === null)) return unchanged(null);
      definitions[agentIndex] = nextDefinition;
      const nextTask = cloneJsonObject(task);
      if (definitions.length === 1) {
        nextTask.agentDef = structuredClone(nextDefinition) as unknown as JsonObject;
        delete nextTask.agentDefs;
      } else {
        nextTask.agentDefs = definitions.map(
          (definition) => structuredClone(definition) as unknown as JsonObject,
        );
        delete nextTask.agentDef;
      }
      const nextSharedState = cloneJsonObject(slices.sharedState);
      nextSharedState.tasks = { ...tasks, [taskId]: nextTask };
      return changed({ nextSharedState }, structuredClone(nextDefinition));
    },
  );
  return result.result;
}

async function readCanonicalAgentTask(
  authority: WorkspacePrivateMutationAuthority,
  taskId: string,
  agentId: string,
): Promise<CanonicalAgentTaskSnapshot | null> {
  const result = await authority.mutate({ operation: 'read-agent-session-admission' }, (slices) => {
    const tasks = slices.sharedState.tasks;
    const projects = slices.sharedState.projects;
    if (!isJsonObject(tasks) || !Array.isArray(projects)) return unchanged(null);
    const taskValue = tasks[taskId];
    if (!isJsonObject(taskValue) || taskValue.id !== taskId || taskValue.taskMode !== 'agent') {
      return unchanged(null);
    }
    const agentDef = getTaskAgentDef(taskValue, agentId);
    if (!agentDef) return unchanged(null);
    const projectValue = projects.find(
      (value) => isJsonObject(value) && value.id === taskValue.projectId,
    );
    if (!isJsonObject(projectValue)) return unchanged(null);
    return unchanged({
      agentDef,
      project: cloneJsonObject(projectValue),
      revision: slices.sharedRevision,
      sharedState: cloneJsonObject(slices.sharedState),
      task: cloneJsonObject(taskValue),
    });
  });
  return result.result;
}

async function readCanonicalSessionIdentityClassification(
  authority: WorkspacePrivateMutationAuthority,
  request: Readonly<ManagedAgentSessionRestoreRequest>,
): Promise<'managed-agent' | 'unavailable' | 'unmanaged'> {
  const result = await authority.mutate(
    { operation: 'classify-canonical-session-identity' },
    (slices) => {
      const tasks = slices.sharedState.tasks;
      if (!isJsonObject(tasks)) return unchanged('unavailable' as const);
      const task = tasks[request.taskId];
      if (task === undefined) return unchanged('unmanaged' as const);
      if (!isJsonObject(task) || task.id !== request.taskId) {
        return unchanged('unavailable' as const);
      }
      return unchanged(
        task.taskMode === 'agent' && getTaskAgentDef(task, request.agentId)
          ? ('managed-agent' as const)
          : ('unmanaged' as const),
      );
    },
  );
  return result.result;
}

function resolveRunnerProfile(project: JsonObject): unknown {
  if (project.agentRunnerConfig !== undefined) {
    return normalizeAgentRunnerProfileConfig(project.agentRunnerConfig);
  }
  const container = project.containerConfig;
  if (!isJsonObject(container) || !isJsonObject(container.runnerProfile)) return undefined;
  const legacy = container.runnerProfile;
  if (legacy.kind !== 'docker') return undefined;
  return normalizeAgentRunnerProfileConfig({
    ...(typeof legacy.dockerfile === 'string' ? { dockerfile: legacy.dockerfile } : {}),
    ...(typeof legacy.image === 'string' ? { image: legacy.image } : {}),
    provider: 'docker-container',
  });
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringRecordsEqual(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value,
    )
  );
}

export function isTrustedBuiltInResumeFallbackDefinition(
  sharedState: Readonly<JsonObject>,
  agentDef: AgentDef,
): boolean {
  const customShadowsBuiltIn =
    Array.isArray(sharedState.customAgents) &&
    sharedState.customAgents.some((value) => cloneAgentDef(value)?.id === agentDef.id);
  const builtIn = getAgentDefsWithLastKnownAvailability(
    typeof sharedState.hydraCommand === 'string' ? sharedState.hydraCommand : '',
  ).find((definition) => definition.id === agentDef.id);
  return (
    !customShadowsBuiltIn &&
    builtIn?.id === 'claude-code' &&
    builtIn.resume_failure_classifier === 'claude-no-conversation-v1' &&
    builtIn.resume_failure_fallback === 'fresh-start' &&
    agentDef.id === 'claude-code' &&
    agentDef.resume_failure_classifier === 'claude-no-conversation-v1' &&
    agentDef.resume_failure_fallback === 'fresh-start' &&
    agentDef.command === builtIn.command &&
    agentDef.adapter === builtIn.adapter &&
    agentDef.resume_strategy === builtIn.resume_strategy &&
    stringArraysEqual(agentDef.args, builtIn.args) &&
    stringArraysEqual(agentDef.resume_args, builtIn.resume_args) &&
    stringArraysEqual(agentDef.skip_permissions_args, builtIn.skip_permissions_args) &&
    stringRecordsEqual(agentDef.env, builtIn.env)
  );
}

function parseFinalizedAgentSessionExit(
  agentId: string,
  data: unknown,
): FinalizedAgentSessionExit | null {
  if (!isJsonObject(data as JsonValue)) return null;
  const value = data as JsonObject;
  if (
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    !Array.isArray(value.lastOutput) ||
    !value.lastOutput.every((line) => typeof line === 'string') ||
    typeof value.resumed !== 'boolean' ||
    typeof value.taskId !== 'string' ||
    !(
      value.exitCode === null ||
      (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode))
    ) ||
    !(value.signal === null || typeof value.signal === 'string')
  ) {
    return null;
  }
  return {
    agentId,
    exitCode: value.exitCode as number | null,
    generation: value.generation as number,
    lastOutput: value.lastOutput as string[],
    resumed: value.resumed,
    signal: value.signal,
    taskId: value.taskId,
  };
}

class WorkspaceAgentSessionWorkflowAuthority implements AgentSessionWorkflowAuthority {
  constructor(
    private readonly dependencies: CreateProductionAgentSessionRuntimeDependencies,
    private readonly adapters: ProductionAgentSessionRuntimeAdapters,
  ) {}

  private async spawnCanonicalAgent(
    request: Readonly<CanonicalAgentSpawnRequest>,
  ): Promise<'failed' | 'running'> {
    const hydraCommand =
      typeof request.canonical.sharedState.hydraCommand === 'string'
        ? request.canonical.sharedState.hydraCommand
        : '';
    const hydraStartupMode =
      typeof request.canonical.sharedState.hydraStartupMode === 'string' &&
      isHydraStartupMode(request.canonical.sharedState.hydraStartupMode)
        ? request.canonical.sharedState.hydraStartupMode
        : 'auto';
    const runnerProfile = resolveRunnerProfile(request.canonical.project);
    const disposition = await this.dependencies.writer.executeAllocated(
      request.operationId,
      (writerPermit) =>
        this.adapters.spawnAllocated(
          this.dependencies.context,
          {
            agentId: request.agentId,
            agentSessionLaunchReason: request.launchReason,
            agentSessionOperationId: request.operationId,
            agentSessionResumed: request.resumed,
            args: buildAgentSpawnArgs(request.agentDef, {
              resumed: request.resumed,
              skipPermissions: request.canonical.task.skipPermissions === true,
            }),
            assertSpawnAdmitted: request.assertSpawnAdmitted,
            ...(request.agentDef.adapter ? { adapter: request.agentDef.adapter } : {}),
            ...(typeof request.canonical.task.baseBranch === 'string'
              ? { baseBranch: request.canonical.task.baseBranch }
              : {}),
            command: getAgentSpawnCommand(request.agentDef, hydraCommand),
            cols: request.cols,
            cwd:
              typeof request.canonical.task.worktreePath === 'string'
                ? request.canonical.task.worktreePath
                : '',
            env: getAgentSpawnEnvironment(request.agentDef, hydraStartupMode),
            isShell: false,
            projectMode: request.canonical.task.projectMode === 'non-git' ? 'non-git' : 'git',
            replaceExistingSession: request.replaceExistingSession,
            resumeOnStart: shouldResumeAgentOnSpawn(request.agentDef, request.resumed),
            rows: request.rows,
            ...(runnerProfile !== undefined ? { runnerProfile } : {}),
            skipExistingSessionAttach: true,
            taskId: request.taskId,
          },
          writerPermit,
        ),
    );
    if (disposition.kind !== 'created-session' && disposition.kind !== 'attached-existing') {
      return 'failed';
    }
    const meta = this.adapters.getAgentMeta(request.agentId);
    return meta &&
      !meta.isShell &&
      meta.taskId === request.taskId &&
      meta.generation === request.targetGeneration
      ? 'running'
      : 'failed';
  }

  async restoreRunner(request: {
    agentDefId: string;
    agentId: string;
    assertSpawnAdmitted: () => void;
    cols: number;
    launchReason: AgentSessionLaunchReason;
    operationId: string;
    resumed: boolean;
    rows: number;
    targetGeneration: number;
    taskId: string;
  }): Promise<'failed' | 'running'> {
    try {
      const canonical = await readCanonicalAgentTask(
        this.dependencies.privateAuthority,
        request.taskId,
        request.agentId,
      );
      if (!canonical || canonical.agentDef.id !== request.agentDefId) return 'failed';
      request.assertSpawnAdmitted();
      return await this.spawnCanonicalAgent({
        agentDef: canonical.agentDef,
        agentId: request.agentId,
        assertSpawnAdmitted: request.assertSpawnAdmitted,
        canonical,
        cols: request.cols,
        launchReason: request.launchReason,
        operationId: request.operationId,
        replaceExistingSession: false,
        resumed: request.resumed,
        rows: request.rows,
        targetGeneration: request.targetGeneration,
        taskId: request.taskId,
      });
    } catch {
      return 'failed';
    } finally {
      this.dependencies.writer.release(request.operationId);
    }
  }

  async inspectAdmission(
    request: AgentSessionOperationRequest,
  ): Promise<AgentSessionAdmissionInspection | null> {
    const canonical = await readCanonicalAgentTask(
      this.dependencies.privateAuthority,
      request.taskId,
      request.agentId,
    );
    if (!canonical) return null;
    const currentGeneration = this.adapters.getAgentLifecycleGeneration(request.agentId);
    const activeMeta = this.adapters.getAgentMeta(request.agentId);
    if (
      activeMeta &&
      (activeMeta.taskId !== request.taskId ||
        activeMeta.isShell ||
        activeMeta.agentId !== request.agentId)
    ) {
      return null;
    }

    if (request.mode === 'initial') {
      const link = canonical.task.taskCreationOperationLink;
      if (
        currentGeneration !== null ||
        canonical.agentDef.id !== request.nextAgentDefId ||
        !isTaskCreationOperationLink(link) ||
        link.kind !== 'creation-v1' ||
        link.creationOperationId !== request.admission.creationOperationId ||
        link.launchOperationId !== request.operationId
      ) {
        return null;
      }
      return {
        agentDefId: canonical.agentDef.id,
        currentGeneration: null,
        currentWorkspaceRevision: canonical.revision,
        initialMapping: {
          agentDefId: canonical.agentDef.id,
          agentId: request.agentId,
          committedWorkspaceRevision: request.admission.committedWorkspaceRevision,
          creationOperationId: link.creationOperationId,
          launchOperationId: link.launchOperationId,
          taskId: request.taskId,
        },
        kind: 'initial',
        targetGeneration: 0,
      };
    }

    const lease = this.adapters.readLeaseIdentity(request.taskId, request.controllerId);
    if (
      currentGeneration === null ||
      currentGeneration !== request.expectedSourceGeneration ||
      !lease ||
      lease.leaseGeneration !== request.expectedLeaseGeneration ||
      (request.mode === 'switch' && canonical.agentDef.id !== request.nextAgentDefId)
    ) {
      return null;
    }
    const requestedAgentDef =
      request.mode === 'switch'
        ? getAvailableAgentDef(canonical.sharedState, request.nextAgentDefId ?? '')
        : canonical.agentDef;
    if (!requestedAgentDef) return null;
    const fallbackClassifier =
      request.launchReason === 'resume-fallback' &&
      isTrustedBuiltInResumeFallbackDefinition(canonical.sharedState, canonical.agentDef)
        ? canonical.agentDef.resume_failure_classifier
        : undefined;
    return {
      agentDefId: requestedAgentDef.id,
      currentGeneration,
      currentLeaseGeneration: lease.leaseGeneration,
      ...(fallbackClassifier ? { fallbackClassifier } : {}),
      kind: 'replacement',
      targetGeneration: currentGeneration + 1,
    };
  }

  async admitTransition(request: AgentSessionOperationRequest): Promise<boolean> {
    const inspected = await this.inspectAdmission(request);
    if (!inspected) return false;
    if (request.mode === 'initial') return inspected.kind === 'initial';
    const lease = this.adapters.readLeaseIdentity(request.taskId, request.controllerId);
    return (
      inspected.kind === 'replacement' &&
      lease !== null &&
      lease.leaseGeneration === request.expectedLeaseGeneration &&
      this.adapters.isLeaseGenerationHeld(
        request.taskId,
        request.controllerId,
        lease.ownerId,
        request.expectedLeaseGeneration,
      )
    );
  }

  async allocateGeneration(request: AgentSessionGenerationAllocationRequest) {
    return this.dependencies.writer.allocate({
      ...request,
      purpose: 'agent-session-operation',
    });
  }

  releaseGeneration(request: AgentSessionGenerationAllocationRequest): void {
    this.dependencies.writer.release(request.operationId);
  }

  async stopPreviousRunner(request: AgentSessionRunnerOperationRequest): Promise<boolean> {
    if (!this.adapters.hasAgentSession(request.agentId)) return true;
    await this.adapters.stopAgent(request.agentId);
    return !this.adapters.hasAgentSession(request.agentId);
  }

  async spawnRunner(
    request: AgentSessionRunnerOperationRequest,
    signal: AbortSignal,
  ): Promise<'failed' | 'running'> {
    try {
      const canonical = await readCanonicalAgentTask(
        this.dependencies.privateAuthority,
        request.taskId,
        request.agentId,
      );
      if (!canonical || signal.aborted) {
        return 'failed';
      }
      const agentDef =
        request.mode === 'switch'
          ? await persistCanonicalAgentSwitch(
              this.dependencies.privateAuthority,
              request.taskId,
              request.agentId,
              request.agentDefId,
            )
          : canonical.agentDef;
      if (!agentDef || agentDef.id !== request.agentDefId || signal.aborted) return 'failed';
      return await this.spawnCanonicalAgent({
        agentDef,
        agentId: request.agentId,
        assertSpawnAdmitted: () => {
          if (signal.aborted) throw new Error('Agent-session spawn acknowledgement expired');
        },
        canonical,
        cols: 80,
        launchReason: request.launchReason,
        operationId: request.operationId,
        replaceExistingSession: request.mode !== 'initial',
        resumed: request.mode === 'resume',
        rows: 24,
        targetGeneration: request.targetGeneration,
        taskId: request.taskId,
      });
    } catch {
      return 'failed';
    } finally {
      // `executeAllocated` releases after its effect settles. This explicit
      // release covers every earlier canonical-read/abort return as well; it
      // is intentionally idempotent and a no-op while an effect is in flight.
      this.dependencies.writer.release(request.operationId);
    }
  }

  async drainTaskSessionsForRemoval(request: { taskId: string }): Promise<boolean> {
    const agentIds = this.adapters.getActiveAgentIds().filter((agentId) => {
      const meta = this.adapters.getAgentMeta(agentId);
      return meta?.taskId === request.taskId;
    });
    await this.adapters.stopTask(request.taskId, agentIds);
    return !this.adapters
      .getActiveAgentIds()
      .some((agentId) => this.adapters.getAgentMeta(agentId)?.taskId === request.taskId);
  }

  async verifyCommittedTaskRemoval(request: {
    deletionOperationId: string;
    taskId: string;
  }): Promise<boolean> {
    return this.dependencies.structure
      .createTaskRemovalParticipantGate('agent-session', AGENT_SESSION_OWNER_HOOK_SET_VERSION)
      .verifyCommittedRemoval(request);
  }

  async publishOperation(): Promise<void> {
    // PTY supervision and catalog subscriptions publish canonical runtime truth.
  }
}

export function createProductionAgentSessionRuntime(
  dependencies: CreateProductionAgentSessionRuntimeDependencies,
): ProductionAgentSessionRuntime {
  const adapters = { ...DEFAULT_ADAPTERS, ...dependencies.adapters };
  const journal =
    dependencies.journal ?? createFileAgentSessionOperationJournal(dependencies.context);
  const removalGate = dependencies.structure.createTaskRemovalParticipantGate(
    'agent-session',
    AGENT_SESSION_OWNER_HOOK_SET_VERSION,
  );
  const authority = new WorkspaceAgentSessionWorkflowAuthority(dependencies, adapters);
  const projectionListeners = new Set<(projection: AgentSessionOperationProjection) => void>();
  let lifecycleState: 'closed' | 'closing' | 'ready' | 'starting' | 'uninitialized' =
    'uninitialized';

  function getOwnerAvailability(taskId: string): AgentSessionOwnerAvailability {
    if (lifecycleState === 'closing' || lifecycleState === 'closed') {
      return { kind: 'unavailable', reason: 'journal-unavailable' };
    }
    const removal = dependencies.structure.getTaskRemovalOwnerCapability();
    const gate = removalGate.getTaskSnapshot(taskId);
    if (!removal) return { kind: 'dark', reason: 'session-owner-dark' };
    if (
      gate.kind !== 'active' ||
      gate.cutoverEpoch !== removal.cutoverEpoch ||
      gate.hookSetVersion !== AGENT_SESSION_OWNER_HOOK_SET_VERSION ||
      dependencies.writer.getCutoverEpoch() !== removal.cutoverEpoch
    ) {
      return { kind: 'unavailable', reason: 'task-removal-gate-unavailable' };
    }
    return {
      current: gate.current,
      cutoverEpoch: removal.cutoverEpoch,
      hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
      kind: 'active',
    };
  }

  const coreWorkflow = createAgentSessionWorkflow({
    authority,
    getOwnerAvailability,
    getRemovalGate: (taskId) => removalGate.getTaskSnapshot(taskId),
    journal,
  });
  function publishProjection(projection: AgentSessionOperationProjection): void {
    for (const listener of projectionListeners) {
      try {
        listener(structuredClone(projection));
      } catch {
        // Publication is observational. A broken event sink cannot roll back
        // or reject an otherwise committed session operation.
      }
    }
  }
  const workflow: AgentSessionWorkflow = {
    drain: () => coreWorkflow.drain(),
    async execute(request) {
      const result = await coreWorkflow.execute(request);
      if (result.kind === 'operation') publishProjection(result.projection);
      return result;
    },
    getOwnerAvailability: (taskId) => coreWorkflow.getOwnerAvailability(taskId),
    removalHooks: coreWorkflow.removalHooks,
  };
  const recovery = createAgentSessionRecoveryAdapter({
    async acquireSystemLease(exit) {
      for (let attempt = 0; attempt < RECOVERY_LEASE_HANDOFF_ATTEMPTS; attempt += 1) {
        if (adapters.getAgentLifecycleGeneration(exit.agentId) !== exit.generation) return null;
        const lease = adapters.acquireRecoveryLease(
          exit.taskId,
          AGENT_SESSION_RECOVERY_CONTROLLER_ID,
          AGENT_SESSION_RECOVERY_CONTROLLER_ID,
          'recover an agent resume failure',
        );
        if (lease.acquired && lease.controllerId === AGENT_SESSION_RECOVERY_CONTROLLER_ID) {
          let released = false;
          return {
            leaseGeneration: lease.leaseGeneration,
            release: () => {
              if (released) return;
              released = true;
              adapters.releaseRecoveryLease(
                exit.taskId,
                AGENT_SESSION_RECOVERY_CONTROLLER_ID,
                AGENT_SESSION_RECOVERY_CONTROLLER_ID,
                undefined,
                lease.leaseGeneration,
              );
            },
          };
        }
        await waitForRecoveryLeaseHandoff();
      }
      return null;
    },
    async resolveAuthoritativeExit(exit) {
      if (!exit.resumed || adapters.getAgentLifecycleGeneration(exit.agentId) !== exit.generation) {
        return null;
      }
      const canonical = await readCanonicalAgentTask(
        dependencies.privateAuthority,
        exit.taskId,
        exit.agentId,
      );
      if (
        !canonical ||
        !isTrustedBuiltInResumeFallbackDefinition(canonical.sharedState, canonical.agentDef)
      ) {
        return null;
      }
      return {
        agentDef: canonical.agentDef,
        currentGeneration: exit.generation,
        trust: 'built-in-catalog',
      };
    },
    workflow,
  });
  let stopAutomaticRecovery: (() => void) | null = null;
  const pendingRecoveries = new Set<Promise<void>>();
  const pendingRecoveryKeys = new Set<string>();
  const pendingRestores = new Map<string, Promise<ManagedAgentSessionRestoreResult>>();
  let cleanRestartShutdownSnapshot: CleanRestartShutdownSnapshot[] | null = null;
  let cleanShutdownNeedsPermitPersistence = false;
  let cleanShutdownPreparation: Promise<void> | null = null;

  function cleanRestartIdentityMarker(
    taskId: string,
    agentId: string,
    marker: AgentSessionCleanRestartMarker,
  ): AgentSessionIdentityMarker {
    return { agentId, cleanRestart: marker, taskId };
  }

  function restoreAdmissionOpen(request: Readonly<ManagedAgentSessionRestoreRequest>): boolean {
    return (
      lifecycleState === 'ready' &&
      journal.getHealth() === 'healthy' &&
      !dependencies.structure.isTaskMutationAdmissionClosed(request.taskId) &&
      getOwnerAvailability(request.taskId).kind === 'active'
    );
  }

  function restoredSessionResult(
    request: Readonly<ManagedAgentSessionRestoreRequest>,
    kind: 'existing' | 'restored',
  ): ManagedAgentSessionRestoreResult {
    const metadata = adapters.getAgentMeta(request.agentId);
    if (!metadata || metadata.taskId !== request.taskId || metadata.isShell) {
      return { kind: 'unavailable', reason: 'identity-unavailable' };
    }
    return {
      agentId: request.agentId,
      cols: adapters.getAgentCols(request.agentId),
      generation: metadata.generation,
      kind,
      rows: adapters.getAgentRows(request.agentId),
      taskId: request.taskId,
    };
  }

  async function reconcileExistingRestore(
    request: Readonly<ManagedAgentSessionRestoreRequest>,
    cleanRestart: AgentSessionCleanRestartMarker | undefined,
  ): Promise<ManagedAgentSessionRestoreResult> {
    const metadata = adapters.getAgentMeta(request.agentId);
    if (!metadata || metadata.taskId !== request.taskId || metadata.isShell) {
      return { kind: 'unavailable', reason: 'identity-unavailable' };
    }
    if (
      cleanRestart?.phase === 'restoring' &&
      cleanRestart.targetGeneration === metadata.generation
    ) {
      await journal.saveIdentityMarkers([
        cleanRestartIdentityMarker(request.taskId, request.agentId, {
          ...cleanRestart,
          generationHighWater: cleanRestart.targetGeneration,
          phase: 'restored',
        }),
      ]);
    }
    return restoredSessionResult(request, 'existing');
  }

  function legacyInitialMarkerFor(
    record: AgentSessionJournalOperationRecord,
    committedWorkspaceRevision: number,
    creationOperationId: string,
  ): AgentSessionIdentityMarker {
    const terminalPhase =
      record.snapshot.phase === 'cancelled' ||
      record.snapshot.phase === 'failed' ||
      record.snapshot.phase === 'running' ||
      record.snapshot.phase === 'superseded'
        ? record.snapshot.phase
        : undefined;
    return {
      agentId: record.request.agentId,
      initialLaunch: {
        agentDefId: record.agentDefId,
        agentId: record.request.agentId,
        committedWorkspaceRevision,
        creationOperationId,
        fingerprint: record.fingerprint,
        lastKnownPhase: record.snapshot.phase,
        launchOperationId: record.request.operationId,
        targetGeneration: 0,
        taskId: record.request.taskId,
        ...(terminalPhase ? { terminalPhase } : {}),
      },
      taskId: record.request.taskId,
    };
  }

  async function restoreLegacyInitialSession(
    request: Readonly<ManagedAgentSessionRestoreRequest>,
    canonical: CanonicalAgentTaskSnapshot,
  ): Promise<ManagedAgentSessionRestoreResult> {
    const link = canonical.task.taskCreationOperationLink;
    if (!isTaskCreationOperationLink(link) || link.kind !== 'pre-operation-journal') {
      return { kind: 'unavailable', reason: 'restore-failed' };
    }
    const identity = deriveLegacyAgentInitialRestoreIdentity(
      request.taskId,
      request.agentId,
      canonical.agentDef.id,
    );
    const existingMarker = journal.getIdentityMarker(request.taskId, request.agentId);
    let committedWorkspaceRevision: number;
    let record: AgentSessionJournalOperationRecord;
    if (existingMarker) {
      const initial = existingMarker.initialLaunch;
      const existingOperation = journal.getOperation(identity.launchOperationId);
      const existingRecord =
        existingOperation?.kind === 'active' ? existingOperation.record : undefined;
      if (
        !initial ||
        initial.agentDefId !== canonical.agentDef.id ||
        initial.creationOperationId !== identity.creationOperationId ||
        initial.launchOperationId !== identity.launchOperationId ||
        initial.lastKnownPhase !== 'admitted' ||
        initial.targetGeneration !== 0 ||
        canonical.revision < initial.committedWorkspaceRevision ||
        !existingRecord ||
        existingRecord.snapshot.phase !== 'admitted' ||
        existingRecord.snapshot.sourceGeneration !== null ||
        existingRecord.snapshot.targetGeneration !== 0 ||
        existingRecord.fingerprint !== initial.fingerprint ||
        existingRecord.request.mode !== 'initial' ||
        existingRecord.request.taskId !== request.taskId ||
        existingRecord.request.agentId !== request.agentId ||
        existingRecord.request.nextAgentDefId !== canonical.agentDef.id ||
        existingRecord.request.admission.creationOperationId !== identity.creationOperationId ||
        existingRecord.request.admission.committedWorkspaceRevision !==
          initial.committedWorkspaceRevision
      ) {
        return { kind: 'unavailable', reason: 'restore-failed' };
      }
      record = existingRecord;
      committedWorkspaceRevision = initial.committedWorkspaceRevision;
    } else {
      const operationRequest: AgentSessionOperationRequest = {
        admission: {
          committedWorkspaceRevision: canonical.revision,
          creationOperationId: identity.creationOperationId,
          kind: 'task-creation',
        },
        agentId: request.agentId,
        expectedLeaseGeneration: null,
        expectedSourceGeneration: null,
        launchReason: 'initial',
        mode: 'initial',
        nextAgentDefId: canonical.agentDef.id,
        operationId: identity.launchOperationId,
        taskId: request.taskId,
      };
      const now = Date.now();
      const fingerprint = deriveAgentSessionOperationFingerprint({
        agentDefId: canonical.agentDef.id,
        request: operationRequest,
      });
      record = {
        agentDefId: canonical.agentDef.id,
        createdAtMs: now,
        fingerprint,
        request: operationRequest,
        snapshot: {
          agentId: request.agentId,
          launchReason: 'initial',
          operationId: identity.launchOperationId,
          phase: 'admitted',
          resumed: false,
          sourceGeneration: null,
          targetGeneration: 0,
          taskId: request.taskId,
          version: 1,
        },
        updatedAtMs: now,
      };
      committedWorkspaceRevision = canonical.revision;
      await journal.saveOperation(record, {
        identityMarker: legacyInitialMarkerFor(
          record,
          committedWorkspaceRevision,
          identity.creationOperationId,
        ),
      });
    }
    const allocation = dependencies.writer.allocate({
      agentId: request.agentId,
      expectedSourceGeneration: null,
      operationId: identity.launchOperationId,
      purpose: 'agent-session-operation',
      targetGeneration: 0,
      taskId: request.taskId,
    });
    if (allocation === 'stale') {
      return { kind: 'unavailable', reason: 'restore-failed' };
    }
    try {
      record = {
        ...record,
        snapshot: transitionAgentSessionOperation(record.snapshot, {
          phase: 'spawning',
          targetGeneration: 0,
        }),
        updatedAtMs: Math.max(record.updatedAtMs, Date.now()),
      };
      await journal.saveOperation(record, {
        identityMarker: legacyInitialMarkerFor(
          record,
          committedWorkspaceRevision,
          identity.creationOperationId,
        ),
      });
      const outcome = await authority.restoreRunner({
        agentDefId: canonical.agentDef.id,
        agentId: request.agentId,
        assertSpawnAdmitted: () => {
          if (
            !restoreAdmissionOpen(request) ||
            adapters.getAgentLifecycleGeneration(request.agentId) !== null
          ) {
            throw new Error('Legacy initial-session admission changed before spawn');
          }
        },
        cols: 80,
        launchReason: 'initial',
        operationId: identity.launchOperationId,
        resumed: false,
        rows: 24,
        targetGeneration: 0,
        taskId: request.taskId,
      });
      record = {
        ...record,
        snapshot: transitionAgentSessionOperation(record.snapshot, {
          ...(outcome === 'running' ? {} : { failure: 'spawn' as const }),
          phase: outcome === 'running' ? 'running' : 'failed',
        }),
        updatedAtMs: Math.max(record.updatedAtMs, Date.now()),
      };
      await journal.saveOperation(record, {
        identityMarker: legacyInitialMarkerFor(
          record,
          committedWorkspaceRevision,
          identity.creationOperationId,
        ),
      });
      return outcome === 'running'
        ? restoredSessionResult(request, 'restored')
        : { kind: 'unavailable', reason: 'restore-failed' };
    } finally {
      dependencies.writer.release(identity.launchOperationId);
    }
  }

  async function runCanonicalSessionRestore(
    request: Readonly<ManagedAgentSessionRestoreRequest>,
  ): Promise<ManagedAgentSessionRestoreResult> {
    if (!isManagedAgentSessionRestoreRequest(request)) {
      return { kind: 'unavailable', reason: 'identity-unavailable' };
    }
    if (!restoreAdmissionOpen(request)) {
      return {
        kind: 'unavailable',
        reason: lifecycleState === 'ready' ? 'task-unavailable' : 'session-state-unavailable',
      };
    }
    const canonical = await readCanonicalAgentTask(
      dependencies.privateAuthority,
      request.taskId,
      request.agentId,
    );
    if (!canonical) return { kind: 'unavailable', reason: 'task-unavailable' };
    const marker = journal.getIdentityMarker(request.taskId, request.agentId);
    const metadata = adapters.getAgentMeta(request.agentId);
    if (metadata) {
      return reconcileExistingRestore(request, marker?.cleanRestart);
    }
    if (adapters.getAgentLifecycleGeneration(request.agentId) !== null) {
      return { kind: 'unavailable', reason: 'restore-failed' };
    }
    const cleanRestart = marker?.cleanRestart;
    if (!cleanRestart) {
      return restoreLegacyInitialSession(request, canonical);
    }
    if (cleanRestart.phase !== 'available') {
      return { kind: 'unavailable', reason: 'restore-failed' };
    }
    if (cleanRestart.agentDefId !== canonical.agentDef.id) {
      return { kind: 'unavailable', reason: 'identity-unavailable' };
    }
    const operationId = deriveAgentSessionCleanRestartOperationId({
      agentDefId: cleanRestart.agentDefId,
      agentId: request.agentId,
      sourceGeneration: cleanRestart.sourceGeneration,
      targetGeneration: cleanRestart.targetGeneration,
      taskId: request.taskId,
    });
    try {
      await journal.saveIdentityMarkers([
        cleanRestartIdentityMarker(request.taskId, request.agentId, {
          ...cleanRestart,
          phase: 'restoring',
        }),
      ]);
      if (
        !restoreAdmissionOpen(request) ||
        adapters.getAgentLifecycleGeneration(request.agentId) !== null
      ) {
        return { kind: 'unavailable', reason: 'restore-failed' };
      }
      const allocation = dependencies.writer.allocate({
        agentId: request.agentId,
        durableSourceGeneration: cleanRestart.sourceGeneration,
        expectedSourceGeneration: null,
        operationId,
        purpose: 'startup-restore',
        targetGeneration: cleanRestart.targetGeneration,
        taskId: request.taskId,
      });
      if (allocation === 'stale') {
        return { kind: 'unavailable', reason: 'restore-failed' };
      }
      const outcome = await authority.restoreRunner({
        agentDefId: cleanRestart.agentDefId,
        agentId: request.agentId,
        assertSpawnAdmitted: () => {
          if (
            !restoreAdmissionOpen(request) ||
            adapters.getAgentLifecycleGeneration(request.agentId) !== null
          ) {
            throw new Error('Clean-restart admission changed before spawn');
          }
        },
        cols: cleanRestart.cols,
        launchReason: 'backend-clean-restart',
        operationId,
        resumed: true,
        rows: cleanRestart.rows,
        targetGeneration: cleanRestart.targetGeneration,
        taskId: request.taskId,
      });
      if (outcome !== 'running') {
        return { kind: 'unavailable', reason: 'restore-failed' };
      }
      await journal.saveIdentityMarkers([
        cleanRestartIdentityMarker(request.taskId, request.agentId, {
          ...cleanRestart,
          generationHighWater: cleanRestart.targetGeneration,
          phase: 'restored',
        }),
      ]);
      return restoredSessionResult(request, 'restored');
    } catch {
      return {
        kind: 'unavailable',
        reason: journal.getHealth() === 'healthy' ? 'restore-failed' : 'session-state-unavailable',
      };
    } finally {
      dependencies.writer.release(operationId);
    }
  }

  async function snapshotCleanRestartSessions(): Promise<CleanRestartShutdownSnapshot[]> {
    const snapshots: CleanRestartShutdownSnapshot[] = [];
    for (const agentId of adapters.getActiveAgentIds()) {
      const metadata = adapters.getAgentMeta(agentId);
      if (!metadata || metadata.isShell) continue;
      const canonical = await readCanonicalAgentTask(
        dependencies.privateAuthority,
        metadata.taskId,
        metadata.agentId,
      );
      if (!canonical) continue;
      const targetGeneration = metadata.generation + 1;
      if (!Number.isSafeInteger(targetGeneration)) {
        throw new Error('Clean-restart target generation exceeds the safe integer range');
      }
      snapshots.push({
        agentId: metadata.agentId,
        marker: {
          agentDefId: canonical.agentDef.id,
          cols: adapters.getAgentCols(agentId),
          generationHighWater: metadata.generation,
          phase: 'available',
          rows: adapters.getAgentRows(agentId),
          sourceGeneration: metadata.generation,
          targetGeneration,
        },
        taskId: metadata.taskId,
      });
    }
    return snapshots;
  }

  async function stopCleanRestartSessions(): Promise<void> {
    await Promise.all(
      (cleanRestartShutdownSnapshot ?? []).map(async (snapshot) => {
        const metadata = adapters.getAgentMeta(snapshot.agentId);
        if (
          metadata &&
          (metadata.taskId !== snapshot.taskId ||
            metadata.isShell ||
            metadata.generation !== snapshot.marker.sourceGeneration)
        ) {
          throw new Error('Managed session identity changed after clean-shutdown snapshot');
        }
        if (metadata) await adapters.stopAgent(snapshot.agentId);
      }),
    );
  }

  async function persistCleanRestartSessions(): Promise<void> {
    const snapshots = cleanRestartShutdownSnapshot ?? [];
    if (snapshots.some((snapshot) => adapters.hasAgentSession(snapshot.agentId))) {
      throw new Error('Managed session remained live after clean-shutdown stop');
    }
    for (const snapshot of snapshots) {
      const canonical = await readCanonicalAgentTask(
        dependencies.privateAuthority,
        snapshot.taskId,
        snapshot.agentId,
      );
      if (!canonical || canonical.agentDef.id !== snapshot.marker.agentDefId) {
        throw new Error('Managed session identity changed before clean-shutdown persistence');
      }
    }
    await journal.saveIdentityMarkers(
      snapshots.map((snapshot) =>
        cleanRestartIdentityMarker(snapshot.taskId, snapshot.agentId, snapshot.marker),
      ),
    );
  }

  async function prepareCleanShutdown(): Promise<void> {
    if (lifecycleState === 'closed') return;
    if (cleanShutdownPreparation) return cleanShutdownPreparation;
    const attempt = (async () => {
      cleanShutdownNeedsPermitPersistence ||= lifecycleState === 'ready';
      lifecycleState = 'closing';
      stopAutomaticRecovery?.();
      stopAutomaticRecovery = null;
      await workflow.drain();
      await Promise.allSettled([...pendingRecoveries, ...pendingRestores.values()]);
      if (cleanShutdownNeedsPermitPersistence) {
        cleanRestartShutdownSnapshot ??= await snapshotCleanRestartSessions();
      }
    })();
    cleanShutdownPreparation = attempt;
    try {
      await attempt;
    } catch (error) {
      if (cleanShutdownPreparation === attempt) cleanShutdownPreparation = null;
      throw error;
    }
  }

  async function completeCleanShutdown(): Promise<void> {
    if (lifecycleState === 'closed') return;
    await prepareCleanShutdown();
    if (cleanShutdownNeedsPermitPersistence) await persistCleanRestartSessions();
    projectionListeners.clear();
    await journal.close();
    lifecycleState = 'closed';
  }
  return {
    activateAutomaticRecovery() {
      if (stopAutomaticRecovery) return;
      stopAutomaticRecovery = adapters.onPtyEvent('exit', (agentId, data) => {
        const exit = parseFinalizedAgentSessionExit(agentId, data);
        if (!exit) return;
        const recoveryKey = `${exit.taskId}\u0000${exit.agentId}\u0000${exit.generation}`;
        if (pendingRecoveryKeys.has(recoveryKey)) return;
        pendingRecoveryKeys.add(recoveryKey);
        const pending = recovery.handleFinalizedExit(exit).then(
          () => undefined,
          () => undefined,
        );
        pendingRecoveries.add(pending);
        void pending.finally(() => {
          pendingRecoveries.delete(pending);
          pendingRecoveryKeys.delete(recoveryKey);
        });
      });
    },
    authority,
    async classifyCanonicalSessionIdentity(request) {
      if (!isManagedAgentSessionRestoreRequest(request) || lifecycleState !== 'ready') {
        return 'unavailable';
      }
      return readCanonicalSessionIdentityClassification(dependencies.privateAuthority, request);
    },
    async close() {
      await prepareCleanShutdown();
      if (cleanShutdownNeedsPermitPersistence) await stopCleanRestartSessions();
      await completeCleanShutdown();
    },
    completeCleanShutdown,
    async getProjection(request) {
      const availability = getOwnerAvailability(request.taskId);
      if (availability.kind !== 'active') return null;
      const latest = journal.getLatestTaskAgentOperation?.(request.taskId, request.agentId);
      if (!latest) return null;
      const operation =
        latest.kind === 'active' ? latest.record.snapshot : latest.response.snapshot;
      return { current: availability.current, operation };
    },
    journal,
    legacyWriterCutover: new WorkspaceAgentSessionLegacyWriterCutover(
      dependencies.privateAuthority,
      dependencies.writer,
    ),
    prepareCleanShutdown,
    restoreCanonicalSession(request) {
      if (!isManagedAgentSessionRestoreRequest(request)) {
        return Promise.resolve({ kind: 'unavailable', reason: 'identity-unavailable' });
      }
      const key = `${request.taskId}\u0000${request.agentId}`;
      const existing = pendingRestores.get(key);
      if (existing) return existing;
      const pending = runCanonicalSessionRestore(structuredClone(request))
        .catch(
          (): ManagedAgentSessionRestoreResult => ({
            kind: 'unavailable',
            reason:
              journal.getHealth() === 'healthy' ? 'restore-failed' : 'session-state-unavailable',
          }),
        )
        .finally(() => {
          if (pendingRestores.get(key) === pending) pendingRestores.delete(key);
        });
      pendingRestores.set(key, pending);
      return pending;
    },
    async startup() {
      if (lifecycleState === 'ready') return;
      if (lifecycleState === 'closing' || lifecycleState === 'closed') {
        throw new Error('Agent-session runtime is closing');
      }
      lifecycleState = 'starting';
      try {
        let health = await journal.startup();
        if (health === 'durability-repair-required' && (await journal.repairDurability())) {
          health = journal.getHealth();
        }
        if (health !== 'healthy' || journal.getHealth() !== 'healthy') {
          throw new Error(`Agent-session journal is unavailable (${health})`);
        }
        lifecycleState = 'ready';
      } catch (error) {
        lifecycleState = 'uninitialized';
        throw error;
      }
    },
    subscribe(listener) {
      const removal = dependencies.structure.getTaskRemovalOwnerCapability();
      if (
        !removal ||
        removal.hookSetVersions['agent-session'] !== AGENT_SESSION_OWNER_HOOK_SET_VERSION ||
        dependencies.writer.getCutoverEpoch() !== removal.cutoverEpoch
      ) {
        throw new Error('Agent-session subscriptions require the active session owner');
      }
      projectionListeners.add(listener);
      return () => projectionListeners.delete(listener);
    },
    workflow,
  };
}
