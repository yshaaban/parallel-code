import { createHash } from 'node:crypto';

import type { TaskCreationCommittedCurrentProjection } from '../../src/domain/task-creation.js';
import {
  isTaskCreationOperationId,
  type TaskCreationOperationId,
} from '../../src/domain/task-creation-ticket.js';
import {
  isTaskCreationOperationLink,
  isTaskInitialShellOwnership,
} from '../../src/domain/task-creation-provenance.js';
import {
  isManagedTaskShellSessionRestoreRequest,
  type ManagedTaskShellSessionRestoreRequest,
  type TaskShellSessionCurrentProjection,
} from '../../src/domain/task-shell-session-operation.js';
import {
  TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
  type TaskRemovalParticipantGate,
} from '../../src/domain/task-removal-owner.js';
import type {
  CanonicalTaskShellRestoreOptions,
  CanonicalTaskShellRestoreResult,
  HandlerContext,
} from './handler-context.js';
import type { TaskCatalogState } from './task-catalog-state.js';
import type { TaskCreationJournal } from './task-creation-journal.js';
import type { TaskCreationInitialLaunchWaiter } from './task-creation-workflow.js';
import {
  createTaskShellSessionJournal,
  type TaskShellSessionIdentity,
  type TaskShellSessionJournal,
  type TaskShellSessionJournalOptions,
} from './task-shell-session-journal.js';
import {
  createTaskShellSessionWorkflow,
  type FinalizeTaskShellSessionRemovalRequest,
  type PrepareTaskShellSessionRemovalRequest,
  type ReserveTaskShellSessionOperationRequest,
  type TaskShellSessionCleanRestartCandidate,
  type TaskShellSessionCleanRestartPermitResult,
  type TaskShellCreationMappingInspection,
  type TaskShellSessionRuntimeTupleIdentity,
  type TaskShellSessionTupleAuthority,
  type TaskShellSessionWorkflow,
} from './task-shell-session-workflow.js';
import {
  getAgentCols,
  getAgentLifecycleGeneration,
  getAgentMeta,
  getAgentRows,
  killAgentAndWaitForRunnerCleanup,
} from './pty.js';
import { spawnAllocatedTaskAgentWorkflow } from './task-workflows.js';
import { unchanged, type WorkspacePrivateMutationAuthority } from './workspace-state-mutations.js';
import {
  canonicalJsonStringify,
  cloneJsonObject,
  type JsonObject,
  type JsonValue,
} from './workspace-state-storage.js';

interface ManagedShellMapping {
  baseBranch?: string;
  collapsed: boolean;
  committedWorkspaceRevision: number;
  projectMode: 'git' | 'non-git';
  worktreePath: string;
}

type ManagedShellMappingRead =
  | { kind: 'absent' }
  | { kind: 'ambiguous' }
  | { kind: 'mapped'; value: ManagedShellMapping };

type CanonicalTaskShellOwnershipRead =
  | { kind: 'managed'; creationOperationId: TaskCreationOperationId; launchOperationId: string }
  | { kind: 'unmanaged'; reason: 'compatibility-shell' | 'legacy-unmanaged'; standalone?: true }
  | { kind: 'existing-standalone'; generation: number }
  | {
      kind: 'unavailable';
      reason: 'identity-unavailable' | 'session-state-unavailable' | 'task-unavailable';
    };

export interface ProductionTaskShellSessionRuntimeAdapters {
  closeAgent: typeof killAgentAndWaitForRunnerCleanup;
  getAgentCols: typeof getAgentCols;
  getAgentGeneration: typeof getAgentLifecycleGeneration;
  getAgentMetadata: typeof getAgentMeta;
  getAgentRows: typeof getAgentRows;
  spawnAllocated: typeof spawnAllocatedTaskAgentWorkflow;
}

export interface CreateProductionTaskShellSessionRuntimeDependencies {
  adapters?: Partial<ProductionTaskShellSessionRuntimeAdapters>;
  catalog: TaskCatalogState;
  context: HandlerContext;
  creationJournal: TaskCreationJournal;
  journal?: TaskShellSessionJournal;
  journalOptions?: TaskShellSessionJournalOptions;
  privateAuthority: WorkspacePrivateMutationAuthority;
  removalGate: TaskRemovalParticipantGate<typeof TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION>;
  waitForInFlightInitialLaunch?: TaskCreationInitialLaunchWaiter['waitForInFlightInitialLaunch'];
  verifyTaskIdentityForRemoval(
    request: Readonly<PrepareTaskShellSessionRemovalRequest>,
    identity: Readonly<TaskShellSessionIdentity>,
  ): Promise<boolean>;
}

export interface ProductionTaskShellSessionRuntime {
  abortCleanRestartDrain(): boolean;
  authority: TaskShellSessionTupleAuthority;
  beginCleanRestartDrain(): Promise<TaskShellSessionCleanRestartCandidate[]>;
  close(): Promise<void>;
  journal: TaskShellSessionJournal;
  readCreationCurrent(
    taskId: string,
    taskMode: 'agent' | 'terminal',
  ): Promise<TaskCreationCommittedCurrentProjection<'agent' | 'terminal'>>;
  readShellCurrent(
    identity: Readonly<TaskShellSessionIdentity>,
  ): Promise<TaskShellSessionCurrentProjection>;
  persistCleanRestartPermit(
    candidate: Readonly<TaskShellSessionCleanRestartCandidate>,
  ): Promise<TaskShellSessionCleanRestartPermitResult>;
  restoreCanonicalTaskShellSession(
    request: Readonly<ManagedTaskShellSessionRestoreRequest>,
    options?: Readonly<CanonicalTaskShellRestoreOptions>,
  ): Promise<CanonicalTaskShellRestoreResult>;
  startup(): Promise<void>;
  suspendTaskSessions(taskId: string, assertAdmitted?: () => void): Promise<void>;
  workflow: TaskShellSessionWorkflow;
}

const DEFAULT_ADAPTERS: ProductionTaskShellSessionRuntimeAdapters = {
  closeAgent: killAgentAndWaitForRunnerCleanup,
  getAgentCols,
  getAgentGeneration: getAgentLifecycleGeneration,
  getAgentMetadata: getAgentMeta,
  getAgentRows,
  spawnAllocated: spawnAllocatedTaskAgentWorkflow,
};

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function supervisorIdentityHash(metadata: NonNullable<ReturnType<typeof getAgentMeta>>): string {
  return createHash('sha256')
    .update('task-shell-session-supervisor:v1\0', 'utf8')
    .update(
      canonicalJsonStringify({
        agentId: metadata.agentId,
        generation: metadata.generation,
        isShell: metadata.isShell,
        taskId: metadata.taskId,
      }),
      'utf8',
    )
    .digest('hex');
}

function metadataMatches(
  metadata: ReturnType<typeof getAgentMeta>,
  identity: Readonly<TaskShellSessionIdentity>,
): metadata is NonNullable<ReturnType<typeof getAgentMeta>> {
  return (
    metadata !== null &&
    metadata.agentId === identity.sessionId &&
    metadata.generation === identity.expectedGeneration &&
    metadata.isShell &&
    metadata.taskId === identity.taskId
  );
}

function initialRuntimeTupleIdentity(
  identity: Readonly<TaskShellSessionIdentity>,
): TaskShellSessionRuntimeTupleIdentity {
  return {
    ...identity,
    admissionKind: 'initial',
    initialExpectedGeneration: identity.expectedGeneration,
    launchOperationId: identity.operationId,
  };
}

function shellMappingFromTask(
  task: Readonly<JsonObject>,
  identity: Readonly<TaskShellSessionRuntimeTupleIdentity>,
  revision: number,
): ManagedShellMapping | null {
  const operationLink = task.taskCreationOperationLink;
  const shellOwnership = task.taskInitialShellOwnership;
  if (
    task.id !== identity.taskId ||
    task.taskMode !== 'terminal' ||
    typeof task.worktreePath !== 'string' ||
    task.worktreePath.trim().length === 0 ||
    !isTaskCreationOperationLink(operationLink) ||
    operationLink.kind !== 'creation-v1' ||
    operationLink.creationOperationId !== identity.creationOperationId ||
    operationLink.launchOperationId !== identity.launchOperationId ||
    !isTaskInitialShellOwnership(shellOwnership) ||
    shellOwnership.kind !== 'managed-terminal-v1' ||
    shellOwnership.launchOperationId !== identity.launchOperationId ||
    shellOwnership.sessionId !== identity.sessionId ||
    shellOwnership.expectedGeneration !== identity.initialExpectedGeneration
  ) {
    return null;
  }
  if (task.projectMode === 'non-git') {
    if (task.baseBranch !== undefined || task.gitIsolation !== undefined) return null;
    return {
      collapsed: task.collapsed === true,
      committedWorkspaceRevision: revision,
      projectMode: 'non-git',
      worktreePath: task.worktreePath,
    };
  }
  if (task.projectMode !== undefined && task.projectMode !== 'git') {
    return null;
  }
  if (
    task.baseBranch !== undefined &&
    (typeof task.baseBranch !== 'string' || task.baseBranch.trim().length === 0)
  ) {
    return null;
  }
  return {
    ...(typeof task.baseBranch === 'string' ? { baseBranch: task.baseBranch } : {}),
    collapsed: task.collapsed === true,
    committedWorkspaceRevision: revision,
    projectMode: 'git',
    worktreePath: task.worktreePath,
  };
}

/**
 * Production adapter for D13's durable initial-shell owner. Every PTY effect
 * is preceded by one atomic canonical mapping read, the exact task-runtime
 * removal gate, and D11's generation writer permit.
 */
export function createProductionTaskShellSessionRuntime(
  dependencies: CreateProductionTaskShellSessionRuntimeDependencies,
): ProductionTaskShellSessionRuntime {
  const adapters = { ...DEFAULT_ADAPTERS, ...dependencies.adapters };
  const writer = dependencies.context.agentSessionWriter;
  if (!writer) throw new Error('Task-shell-session runtime requires the managed session writer');
  const journal =
    dependencies.journal ??
    createTaskShellSessionJournal(dependencies.context, dependencies.journalOptions);
  let startupPromise: Promise<void> | null = null;

  async function startup(): Promise<void> {
    startupPromise ??= (async () => {
      const observed = await journal.startup();
      const active =
        observed.health === 'activation-required' ? await journal.activateFresh() : observed;
      if (active.health !== 'healthy' || journal.getHealth() !== 'healthy') {
        throw new Error(`Task-shell-session journal is unavailable (${active.health})`);
      }
    })().catch((error: unknown) => {
      startupPromise = null;
      throw error;
    });
    return startupPromise;
  }

  async function readManagedShellMapping(
    identity: Readonly<TaskShellSessionRuntimeTupleIdentity>,
  ): Promise<ManagedShellMappingRead> {
    const result = await dependencies.privateAuthority.mutate<ManagedShellMappingRead>(
      { operation: 'read-managed-initial-shell-mapping' },
      (slices) => {
        const tasks = slices.sharedState.tasks;
        if (!isJsonObject(tasks)) return unchanged({ kind: 'ambiguous' as const });
        const taskValue = tasks[identity.taskId];
        if (taskValue === undefined) return unchanged({ kind: 'absent' as const });
        if (!isJsonObject(taskValue)) return unchanged({ kind: 'ambiguous' as const });
        const mapping = shellMappingFromTask(
          cloneJsonObject(taskValue),
          identity,
          slices.sharedRevision,
        );
        return unchanged(
          mapping ? { kind: 'mapped' as const, value: mapping } : { kind: 'ambiguous' as const },
        );
      },
    );
    return result.result;
  }

  async function inspectCreationMapping(
    identity: Readonly<TaskShellSessionIdentity>,
  ): Promise<TaskShellCreationMappingInspection> {
    const mapping = await readManagedShellMapping(initialRuntimeTupleIdentity(identity));
    if (mapping.kind !== 'mapped') return mapping;
    if (
      identity.committedWorkspaceRevision !== null &&
      mapping.value.committedWorkspaceRevision < identity.committedWorkspaceRevision
    ) {
      return { kind: 'ambiguous' };
    }
    return {
      committedWorkspaceRevision: mapping.value.committedWorkspaceRevision,
      kind: 'committed',
    };
  }

  function removalAdmitsTask(taskId: string): boolean {
    const snapshot = dependencies.removalGate.getTaskSnapshot(taskId);
    return (
      snapshot.kind === 'active' &&
      snapshot.hookSetVersion === TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION &&
      snapshot.current.taskState === 'present' &&
      !snapshot.current.taskClosing
    );
  }

  async function readCanonicalTaskShellOwnership(
    request: Readonly<ManagedTaskShellSessionRestoreRequest>,
    options: Readonly<CanonicalTaskShellRestoreOptions> | undefined,
  ): Promise<CanonicalTaskShellOwnershipRead> {
    const removalSnapshot = dependencies.removalGate.getTaskSnapshot(request.taskId);
    const removalAdmitted =
      removalSnapshot.kind === 'active' &&
      removalSnapshot.hookSetVersion === TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION &&
      removalSnapshot.current.taskState === 'present' &&
      !removalSnapshot.current.taskClosing;
    const explicitCreationAdmitted =
      options?.compatibilityIntent === 'create' &&
      removalSnapshot.kind === 'active' &&
      removalSnapshot.hookSetVersion === TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION &&
      removalSnapshot.current.taskState === 'not-visible';
    const result = await dependencies.privateAuthority.mutate<CanonicalTaskShellOwnershipRead>(
      { operation: 'read-canonical-task-shell-ownership' },
      (slices) => {
        const tasks = slices.sharedState.tasks;
        if (!isJsonObject(tasks)) {
          return unchanged({ kind: 'unavailable', reason: 'session-state-unavailable' } as const);
        }
        const task = tasks[request.taskId];
        if (task === undefined) {
          const metadata = adapters.getAgentMetadata(request.sessionId);
          if (metadata?.compatibilityCreatorClientId !== undefined) {
            // Creator provenance proves initial admission, not private output ownership.
            // Authenticated browser observers may attach; input/resize still need task control.
            return unchanged(
              removalSnapshot.kind === 'active' &&
                removalSnapshot.hookSetVersion === TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION &&
                removalSnapshot.current.taskState === 'not-visible' &&
                typeof options?.clientId === 'string' &&
                options.clientId.trim().length > 0 &&
                metadata.agentId === request.sessionId &&
                metadata.taskId === request.taskId &&
                metadata.isShell
                ? ({ kind: 'existing-standalone', generation: metadata.generation } as const)
                : ({ kind: 'unavailable', reason: 'identity-unavailable' } as const),
            );
          }
          const terminals = slices.localState.terminals;
          const terminal = isJsonObject(terminals) ? terminals[request.taskId] : undefined;
          return unchanged(
            removalSnapshot.kind !== 'active'
              ? ({ kind: 'unavailable', reason: 'session-state-unavailable' } as const)
              : removalSnapshot.current.taskState === 'removed'
                ? ({ kind: 'unavailable', reason: 'task-unavailable' } as const)
                : (isJsonObject(terminal) &&
                      terminal.id === request.taskId &&
                      terminal.agentId === request.sessionId) ||
                    (explicitCreationAdmitted && metadata === null)
                  ? ({
                      kind: 'unmanaged',
                      reason: 'compatibility-shell',
                      standalone: true,
                    } as const)
                  : ({ kind: 'unavailable', reason: 'task-unavailable' } as const),
          );
        }
        if (!isJsonObject(task) || task.id !== request.taskId) {
          return unchanged({ kind: 'unavailable', reason: 'identity-unavailable' } as const);
        }
        if (!removalAdmitted || task.collapsed === true) {
          return unchanged({ kind: 'unavailable', reason: 'task-unavailable' } as const);
        }
        const shellAgentIds = task.shellAgentIds;
        if (!isStringArray(shellAgentIds)) {
          return unchanged({ kind: 'unavailable', reason: 'session-state-unavailable' } as const);
        }
        if (task.taskMode === 'agent') {
          const agentIds = task.agentIds;
          if (
            task.agentId === request.sessionId ||
            (isStringArray(agentIds) && agentIds.includes(request.sessionId))
          ) {
            return unchanged({ kind: 'unavailable', reason: 'identity-unavailable' } as const);
          }
          return unchanged(
            shellAgentIds.includes(request.sessionId) || options?.compatibilityIntent === 'create'
              ? ({ kind: 'unmanaged', reason: 'compatibility-shell' } as const)
              : ({ kind: 'unavailable', reason: 'identity-unavailable' } as const),
          );
        }
        if (task.taskMode !== 'terminal') {
          return unchanged({ kind: 'unavailable', reason: 'identity-unavailable' } as const);
        }
        const ownership = task.taskInitialShellOwnership;
        if (!isTaskInitialShellOwnership(ownership)) {
          return unchanged({ kind: 'unavailable', reason: 'session-state-unavailable' } as const);
        }
        if (ownership.kind === 'legacy-unmanaged-terminal') {
          return unchanged(
            shellAgentIds.includes(request.sessionId) || options?.compatibilityIntent === 'create'
              ? ({
                  kind: 'unmanaged',
                  reason: shellAgentIds.includes(request.sessionId)
                    ? 'legacy-unmanaged'
                    : 'compatibility-shell',
                } as const)
              : ({ kind: 'unavailable', reason: 'identity-unavailable' } as const),
          );
        }
        if (ownership.kind !== 'managed-terminal-v1') {
          return unchanged({ kind: 'unavailable', reason: 'identity-unavailable' } as const);
        }
        if (ownership.sessionId !== request.sessionId) {
          return unchanged(
            shellAgentIds.includes(request.sessionId) || options?.compatibilityIntent === 'create'
              ? ({ kind: 'unmanaged', reason: 'compatibility-shell' } as const)
              : ({ kind: 'unavailable', reason: 'identity-unavailable' } as const),
          );
        }
        const operationLink = task.taskCreationOperationLink;
        if (
          !isTaskCreationOperationLink(operationLink) ||
          operationLink.kind !== 'creation-v1' ||
          !isTaskCreationOperationId(operationLink.creationOperationId) ||
          operationLink.launchOperationId !== ownership.launchOperationId
        ) {
          return unchanged({ kind: 'unavailable', reason: 'identity-unavailable' } as const);
        }
        return unchanged({
          creationOperationId: operationLink.creationOperationId,
          kind: 'managed',
          launchOperationId: ownership.launchOperationId,
        } as const);
      },
    );
    return result.result;
  }

  const authority: TaskShellSessionTupleAuthority = {
    async closeExactOperationOwnedTuple(identity) {
      const [mapping, metadata] = await Promise.all([
        readManagedShellMapping(identity),
        Promise.resolve(adapters.getAgentMetadata(identity.sessionId)),
      ]);
      if (mapping.kind === 'ambiguous') return 'proof-insufficient';
      if (mapping.kind === 'absent')
        return metadata === null ? 'already-absent' : 'proof-insufficient';
      if (metadata === null) return 'already-absent';
      if (!metadataMatches(metadata, identity)) return 'proof-insufficient';
      await adapters.closeAgent(identity.sessionId);
      const after = adapters.getAgentMetadata(identity.sessionId);
      return metadataMatches(after, identity) ? 'proof-insufficient' : 'closed';
    },

    async inspectExactTuple(identity) {
      const metadata = adapters.getAgentMetadata(identity.sessionId);
      if (metadata) {
        return metadataMatches(metadata, identity)
          ? { kind: 'running', supervisorIdentityHash: supervisorIdentityHash(metadata) }
          : {
              kind: 'ambiguous',
              supervisorIdentityHash: supervisorIdentityHash(metadata),
            };
      }
      const generation = adapters.getAgentGeneration(identity.sessionId);
      if (identity.admissionKind === 'clean-restart' && generation === null) {
        return { kind: 'not-admitted' };
      }
      const expectedSource =
        identity.expectedGeneration === 0 ? null : identity.expectedGeneration - 1;
      if (generation === expectedSource) return { kind: 'not-admitted' };
      if (generation === identity.expectedGeneration) return { kind: 'failed' };
      return { kind: 'ambiguous', supervisorIdentityHash: null };
    },

    async spawnExactTuple(identity) {
      if (identity.admissionKind === 'unclean-recovery') {
        return { kind: 'ambiguous', supervisorIdentityHash: null };
      }
      const mapping = await readManagedShellMapping(identity);
      if (mapping.kind !== 'mapped' || !removalAdmitsTask(identity.taskId)) {
        return { kind: 'ambiguous', supervisorIdentityHash: null };
      }
      if (mapping.value.collapsed) {
        const inspection = await authority.inspectExactTuple(identity);
        return inspection.kind === 'not-admitted'
          ? { kind: 'deferred-before-process' }
          : { kind: 'ambiguous', supervisorIdentityHash: null };
      }
      if (
        identity.committedWorkspaceRevision === null ||
        mapping.value.committedWorkspaceRevision < identity.committedWorkspaceRevision
      ) {
        return { kind: 'ambiguous', supervisorIdentityHash: null };
      }
      const expectedSourceGeneration =
        identity.expectedGeneration === 0 ? null : identity.expectedGeneration - 1;
      const isCleanRestart = identity.admissionKind === 'clean-restart';
      const processSourceGeneration = adapters.getAgentGeneration(identity.sessionId);
      let allocation;
      if (isCleanRestart && processSourceGeneration === null) {
        if (expectedSourceGeneration === null) {
          return { kind: 'ambiguous', supervisorIdentityHash: null };
        }
        allocation = writer.allocate({
          agentId: identity.sessionId,
          durableSourceGeneration: expectedSourceGeneration,
          expectedSourceGeneration: null,
          operationId: identity.operationId,
          purpose: 'startup-restore',
          targetGeneration: identity.expectedGeneration,
          taskId: identity.taskId,
        });
      } else {
        allocation = writer.allocate({
          agentId: identity.sessionId,
          expectedSourceGeneration,
          operationId: identity.operationId,
          purpose: 'task-shell-session',
          targetGeneration: identity.expectedGeneration,
          taskId: identity.taskId,
        });
      }
      if (allocation === 'stale') {
        const inspected = await authority.inspectExactTuple(identity);
        return inspected.kind === 'running'
          ? { kind: 'ambiguous', supervisorIdentityHash: inspected.supervisorIdentityHash }
          : { kind: 'ambiguous', supervisorIdentityHash: null };
      }
      try {
        const disposition = await writer.executeAllocated(identity.operationId, (permit) =>
          adapters.spawnAllocated(
            dependencies.context,
            {
              agentId: identity.sessionId,
              args: [],
              ...(mapping.value.baseBranch ? { baseBranch: mapping.value.baseBranch } : {}),
              cols: 80,
              command: '',
              cwd: mapping.value.worktreePath,
              env: {},
              isShell: true,
              projectMode: mapping.value.projectMode,
              rows: 24,
              startsTaskWatchers: true,
              taskId: identity.taskId,
            },
            permit,
          ),
        );
        const metadata = adapters.getAgentMetadata(identity.sessionId);
        if (disposition.kind !== 'created-session' || !metadataMatches(metadata, identity)) {
          return {
            kind: 'ambiguous',
            supervisorIdentityHash: metadata ? supervisorIdentityHash(metadata) : null,
          };
        }
        return { kind: 'accepted', supervisorIdentityHash: supervisorIdentityHash(metadata) };
      } catch {
        const metadata = adapters.getAgentMetadata(identity.sessionId);
        if (metadata) {
          return {
            kind: 'ambiguous',
            supervisorIdentityHash: supervisorIdentityHash(metadata),
          };
        }
        const provenPreProcessGeneration =
          isCleanRestart && processSourceGeneration === null ? null : expectedSourceGeneration;
        if (adapters.getAgentGeneration(identity.sessionId) !== provenPreProcessGeneration) {
          return { kind: 'ambiguous', supervisorIdentityHash: null };
        }
        const currentMapping = await readManagedShellMapping(identity);
        if (
          adapters.getAgentMetadata(identity.sessionId) !== null ||
          adapters.getAgentGeneration(identity.sessionId) !== provenPreProcessGeneration
        ) {
          return { kind: 'ambiguous', supervisorIdentityHash: null };
        }
        return currentMapping.kind === 'mapped' && currentMapping.value.collapsed
          ? { kind: 'deferred-before-process' }
          : { kind: 'failed-before-process' };
      } finally {
        writer.release(identity.operationId);
      }
    },
  };

  async function readWorkspaceRevision(): Promise<number> {
    const result = await dependencies.privateAuthority.mutate(
      { operation: 'read-task-experience-workspace-revision' },
      (slices) => unchanged(slices.sharedRevision),
    );
    return result.result;
  }

  async function readCreationCurrent(
    taskId: string,
    taskMode: 'agent' | 'terminal',
  ): Promise<TaskCreationCommittedCurrentProjection<'agent' | 'terminal'>> {
    const [current, task, workspaceRevision] = await Promise.all([
      Promise.resolve(dependencies.catalog.getCurrentTaskProjection(taskId)),
      Promise.resolve(dependencies.catalog.getCurrentTaskSummary(taskId)),
      readWorkspaceRevision(),
    ]);
    const modeMatches = task?.taskMode === taskMode;
    return {
      catalogVersion: current.catalogVersion,
      serverInstanceId: current.serverInstanceId,
      task: current.taskState === 'present' && modeMatches ? task : null,
      taskClosing: current.taskState === 'present' && modeMatches && current.taskClosing,
      taskState:
        current.taskState === 'present' && !modeMatches ? 'not-visible' : current.taskState,
      workspaceRevision,
    } as TaskCreationCommittedCurrentProjection<'agent' | 'terminal'>;
  }

  async function readShellCurrent(
    identity: Readonly<TaskShellSessionIdentity>,
  ): Promise<TaskShellSessionCurrentProjection> {
    const [current, task, session, workspaceRevision] = await Promise.all([
      Promise.resolve(dependencies.catalog.getCurrentTaskProjection(identity.taskId)),
      Promise.resolve(dependencies.catalog.getCurrentTaskSummary(identity.taskId)),
      Promise.resolve(dependencies.catalog.getCurrentSessionSummary(identity.sessionId)),
      readWorkspaceRevision(),
    ]);
    const terminalTask = task?.taskMode === 'terminal' ? task : null;
    const exactSession =
      session?.taskId === identity.taskId &&
      session.kind === 'shell' &&
      session.generation === identity.expectedGeneration
        ? session
        : null;
    return {
      catalogVersion: current.catalogVersion,
      serverInstanceId: current.serverInstanceId,
      session: exactSession
        ? {
            generation: exactSession.generation,
            sessionId: exactSession.sessionId,
            state: exactSession.state === 'not-started' ? 'not-found' : exactSession.state,
          }
        : null,
      task: current.taskState === 'present' ? terminalTask : null,
      taskClosing: current.taskState === 'present' && terminalTask !== null && current.taskClosing,
      taskState:
        current.taskState === 'present' && terminalTask === null
          ? 'not-visible'
          : current.taskState,
      workspaceRevision,
    };
  }

  async function verifyCreationReservation(
    request: Readonly<ReserveTaskShellSessionOperationRequest>,
  ): Promise<boolean> {
    if (!isTaskCreationOperationId(request.creationOperationId)) return false;
    const record = dependencies.creationJournal.getByOperationId(request.creationOperationId);
    return Boolean(
      record &&
      record.phase === 'validating' &&
      record.commit.kind === 'not-committed' &&
      record.taskMode === 'terminal' &&
      record.operationId === request.creationOperationId &&
      record.identities.launchOperationId === request.operationId &&
      record.identities.sessionId === request.sessionId &&
      record.identities.taskId === request.taskId &&
      request.expectedGeneration === 0 &&
      record.capabilityHash === request.capabilityHash &&
      record.workspacePrincipalHash === request.workspacePrincipalHash,
    );
  }

  async function verifyRemovalCommit(
    request: Readonly<FinalizeTaskShellSessionRemovalRequest>,
  ): Promise<boolean> {
    return dependencies.removalGate.verifyCommittedRemoval({
      deletionOperationId: request.deletionOperationId,
      taskId: request.taskId,
    });
  }

  const workflow = createTaskShellSessionWorkflow({
    authority,
    inspectCreationMapping,
    journal,
    readCurrent: readShellCurrent,
    verifyCreationReservation,
    verifyRemovalCommit,
    verifyTaskIdentityForRemoval: dependencies.verifyTaskIdentityForRemoval,
  });

  async function restoreCanonicalTaskShellSession(
    request: Readonly<ManagedTaskShellSessionRestoreRequest>,
    options?: Readonly<CanonicalTaskShellRestoreOptions>,
  ): Promise<CanonicalTaskShellRestoreResult> {
    if (!isManagedTaskShellSessionRestoreRequest(request)) {
      return { kind: 'unavailable', reason: 'identity-unavailable' };
    }
    try {
      await startup();
      const ownership = await readCanonicalTaskShellOwnership(request, options);
      if (ownership.kind === 'unavailable') return ownership;
      if (ownership.kind === 'unmanaged') {
        return { ...request, ...ownership };
      }
      if (ownership.kind === 'existing-standalone') {
        const metadata = adapters.getAgentMetadata(request.sessionId);
        if (
          !metadata ||
          metadata.agentId !== request.sessionId ||
          metadata.taskId !== request.taskId ||
          !metadata.isShell ||
          metadata.generation !== ownership.generation ||
          metadata.compatibilityCreatorClientId === undefined
        ) {
          return { kind: 'unavailable', reason: 'identity-unavailable' };
        }
        return {
          ...request,
          kind: 'existing',
          generation: ownership.generation,
          cols: adapters.getAgentCols(request.sessionId),
          rows: adapters.getAgentRows(request.sessionId),
        };
      }
      // Canonical task publication can precede its initial shell admission. Join only
      // the exact live creation owner, outside the shell queue that it must enter.
      await dependencies.waitForInFlightInitialLaunch?.({
        creationOperationId: ownership.creationOperationId,
        launchOperationId: ownership.launchOperationId,
        sessionId: request.sessionId,
        taskId: request.taskId,
      });
      const latestOwnership = await readCanonicalTaskShellOwnership(request, undefined);
      if (latestOwnership.kind === 'unavailable') return latestOwnership;
      if (
        latestOwnership.kind !== 'managed' ||
        latestOwnership.creationOperationId !== ownership.creationOperationId ||
        latestOwnership.launchOperationId !== ownership.launchOperationId
      )
        return { kind: 'unavailable', reason: 'identity-unavailable' };
      const restored = await workflow.restoreManagedSession({
        launchOperationId: ownership.launchOperationId,
        sessionId: request.sessionId,
        taskId: request.taskId,
      });
      if (restored.kind === 'unavailable') return restored;
      const metadata = adapters.getAgentMetadata(request.sessionId);
      if (
        !metadata ||
        metadata.agentId !== request.sessionId ||
        metadata.taskId !== request.taskId ||
        !metadata.isShell ||
        metadata.generation !== restored.generation
      ) {
        return { kind: 'unavailable', reason: 'session-state-unavailable' };
      }
      return {
        ...restored,
        cols: adapters.getAgentCols(request.sessionId),
        rows: adapters.getAgentRows(request.sessionId),
      };
    } catch {
      return { kind: 'unavailable', reason: 'session-state-unavailable' };
    }
  }

  return {
    abortCleanRestartDrain: () => workflow.abortCleanRestartDrain(),
    authority,
    beginCleanRestartDrain: () => workflow.beginCleanRestartDrain(),
    close: () => journal.close(),
    journal,
    persistCleanRestartPermit: (candidate) => workflow.persistCleanRestartPermit(candidate),
    readCreationCurrent,
    readShellCurrent,
    restoreCanonicalTaskShellSession,
    async suspendTaskSessions(taskId, assertAdmitted = () => {}) {
      assertAdmitted();
      const candidates = await workflow.beginTaskSuspension(taskId);
      const results = await Promise.allSettled(
        candidates.map(async (candidate) => {
          assertAdmitted();
          const metadata = adapters.getAgentMetadata(candidate.sessionId);
          if (
            metadata &&
            (metadata.taskId !== taskId ||
              !metadata.isShell ||
              metadata.generation !== candidate.sourceGeneration)
          ) {
            throw new Error('Task shell identity changed before suspension');
          }
          if (metadata) await adapters.closeAgent(candidate.sessionId);
          assertAdmitted();
          const result = await workflow.persistCleanRestartPermit(candidate);
          if (result.kind !== 'prepared')
            throw new Error(`Task shell suspension failed: ${result.reason}`);
        }),
      );
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length)
        throw Object.assign(new Error('Task shell suspension failed'), { failures });
    },
    startup,
    workflow,
  };
}
