import type { StorageEnv } from './storage-environment.js';
import {
  cloneJsonObject,
  createElectronWorkspaceStateStorage,
  createStandaloneWorkspaceStateStorage,
  createWorkspaceHostRecord,
  incrementCanonicalUint64,
  type JsonObject,
  type JsonValue,
  type WorkspaceHostRecord,
  type WorkspaceHostSnapshot,
  type WorkspaceStateStorage,
  type WorkspaceStorageKind,
} from './workspace-state-storage.js';

export const PROTECTED_WORKSPACE_POLICY_IDS = Object.freeze([
  'task-structure',
  'task-identity-location',
  'creation-writer-epoch',
  'initial-shell-ownership',
  'creation-operation-link',
  'initial-prompt',
  'merge-progress',
  'creation-outcome',
  'task-notes',
] as const);

export type ProtectedWorkspacePolicyId = (typeof PROTECTED_WORKSPACE_POLICY_IDS)[number];
export type ProtectedWorkspacePolicyVersions = Record<ProtectedWorkspacePolicyId, string>;

const POLICY_STATE_KEY = 'protectedWorkspacePolicyVersions';
const INACTIVE_POLICY_VERSION = '0';
const ACTIVE_POLICY_VERSION = '1';

const TASK_IDENTITY_FIELDS = Object.freeze([
  'baseBranch',
  'branchName',
  'collapsed',
  'gitIsolation',
  'id',
  'projectId',
  'projectMode',
  'taskMode',
  'worktreeOwnership',
  'worktreePath',
] as const);
const CREATION_WRITER_EPOCH_FIELDS = Object.freeze([
  'creationWriterEpoch',
  'taskCreationProvenance',
] as const);
const INITIAL_SHELL_OWNERSHIP_FIELDS = Object.freeze([
  'initialShellOwnership',
  'taskInitialShellOwnership',
] as const);
const CREATION_OPERATION_LINK_FIELDS = Object.freeze([
  'creationOperationLink',
  'taskCreationOperationLink',
] as const);
const INITIAL_PROMPT_FIELDS = Object.freeze([
  'initialPrompt',
  'initialPromptDelivery',
  'initialPromptDeliveryId',
  'initialPromptDeliveryMode',
  'savedInitialPrompt',
] as const);
const MERGE_PROGRESS_FIELDS = Object.freeze([
  'committedMergeOperationId',
  'completedTaskCount',
  'completedTaskDate',
  'mergeOperation',
  'mergeProgress',
  'mergedLinesAdded',
  'mergedLinesRemoved',
] as const);
const CREATION_OUTCOME_FIELDS = Object.freeze([
  'coordinatorCredentialPath',
  'coordinatorRole',
  'coordinatorRunId',
  'coordinatorToolCommand',
  'creationOutcome',
  'creationRecovery',
  'creationStatus',
] as const);
const TASK_NOTES_FIELDS = Object.freeze(['notes', 'notesFiles', 'taskNotes'] as const);

export interface WorkspaceProtectedPolicyDefinition {
  readonly id: ProtectedWorkspacePolicyId;
  readonly version: typeof ACTIVE_POLICY_VERSION;
  mergeCanonical(canonical: JsonObject, proposal: JsonObject): void;
}

export interface WorkspaceMutationRequest {
  expectedSharedRevision?: number;
  operation: string;
  sourceId?: string | null;
}

export interface WorkspaceHostMutationSlices {
  localState: JsonObject;
  /** Immutable host-record digest for bounded coherent snapshot collection. */
  payloadDigest: string;
  privateState: JsonObject;
  /** Canonical revision before this queue-exclusive mutation decision. */
  sharedRevision: number;
  sharedState: JsonObject;
  /** Immutable host-record generation before this queue-exclusive mutation decision. */
  storageGeneration: string;
}

export type WorkspaceMutationDecision<TResult> =
  | { kind: 'unchanged'; result: TResult }
  | {
      kind: 'changed';
      nextLocalState?: JsonObject;
      nextPrivateState?: JsonObject;
      nextSharedState?: JsonObject;
      result: TResult;
    };

export interface WorkspaceMutationPublicationWarning {
  code: 'projection-repair-required';
  messages: string[];
}

export interface WorkspaceMutationResult<TResult> {
  changed: boolean;
  result: TResult;
  revision: number;
  warning?: WorkspaceMutationPublicationWarning;
}

export interface PreparedWorkspaceProjections {
  privateProjection?: unknown;
  sharedProjection?: unknown;
}

export type WorkspaceMutationFaultPoint = 'after-publication';

export interface WorkspaceMutationServiceOptions {
  emitWorkspaceStateChanged?: (payload: {
    revision: number;
    savedAt: number;
    sourceId: string | null;
  }) => Promise<void> | void;
  faultInjector?: (point: WorkspaceMutationFaultPoint) => Promise<void> | void;
  invalidateSharedStateCaches?: () => Promise<void> | void;
  markProjectionDegraded?: (messages: string[]) => Promise<void> | void;
  now?: () => number;
  prepareProjections?: (
    proposed: WorkspaceHostRecord,
    changes: { localChanged: boolean; privateChanged: boolean; sharedChanged: boolean },
  ) => PreparedWorkspaceProjections;
  publishPrivateProjection?: (
    prepared: unknown,
    committed: WorkspaceHostRecord,
  ) => Promise<void> | void;
  publishSharedProjection?: (
    prepared: unknown,
    committed: WorkspaceHostRecord,
  ) => Promise<void> | void;
}

interface PendingDurabilityPublication<TResult = unknown> {
  changes: MutationChangeFlags;
  prepared: PreparedWorkspaceProjections;
  proposed: WorkspaceHostRecord;
  request: WorkspaceMutationRequest;
  result: TResult;
}

interface MutationChangeFlags {
  localChanged: boolean;
  privateChanged: boolean;
  sharedChanged: boolean;
}

export interface WorkspacePrivateMutationAuthority {
  mutate<TResult>(
    request: WorkspaceMutationRequest,
    mutator: (slices: Readonly<WorkspaceHostMutationSlices>) => WorkspaceMutationDecision<TResult>,
  ): Promise<WorkspaceMutationResult<TResult>>;
}

/** Notes' narrow read-before-admission capability; unrelated mutation consumers do not depend on it. */
export interface WorkspacePrivateSnapshotAuthority extends WorkspacePrivateMutationAuthority {
  /**
   * Inspect one immutable host snapshot without joining the mutation queue.
   *
   * The snapshot may become stale immediately. Consumers that intend to write must acquire their
   * structural admission/fence and revalidate inside `mutate`; this seam exists for bounded
   * classification that must not queue behind, or slip past, a closing fence.
   */
  inspect<TResult>(
    request: WorkspaceMutationRequest,
    inspector: (slices: Readonly<WorkspaceHostMutationSlices>) => TResult,
  ): Promise<TResult>;
}

const mutationQueueTails = new Map<string, Promise<void>>();

interface WorkspaceMutationCoordination {
  inspectionEpoch: number;
  pendingDurabilityRevision: number | null;
}

const mutationCoordinationByIdentity = new Map<string, WorkspaceMutationCoordination>();

function getMutationCoordination(identity: string): WorkspaceMutationCoordination {
  const current = mutationCoordinationByIdentity.get(identity);
  if (current) return current;
  const created = { inspectionEpoch: 0, pendingDurabilityRevision: null };
  mutationCoordinationByIdentity.set(identity, created);
  return created;
}

export class WorkspaceRevisionConflictError extends Error {
  readonly code = 'workspace-revision-conflict';

  constructor(readonly currentRevision: number) {
    super('Workspace state revision conflict');
  }
}

export class WorkspaceProtectedFieldConflictError extends Error {
  readonly code = 'workspace-protected-field-conflict';

  constructor(
    readonly policyId: ProtectedWorkspacePolicyId,
    message: string,
  ) {
    super(message);
  }
}

export class WorkspaceMutationNotCommittedError extends Error {
  readonly code = 'workspace-mutation-not-committed';

  constructor(readonly cause: unknown) {
    super('Workspace mutation was proven not committed');
  }
}

export class WorkspaceMutationRecoveryError extends Error {
  readonly code = 'host-state-recovery-required';

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class WorkspaceMutationDurabilityError extends Error {
  readonly code = 'host-durability-repair-required';

  constructor(
    readonly revision: number,
    readonly cause?: unknown,
  ) {
    super('Workspace mutation is present but its directory durability requires repair');
  }
}

export function unchanged<TResult>(result: TResult): WorkspaceMutationDecision<TResult> {
  return { kind: 'unchanged', result };
}

export function changed<TResult>(
  changes: {
    nextLocalState?: JsonObject;
    nextPrivateState?: JsonObject;
    nextSharedState?: JsonObject;
  },
  result: TResult,
): WorkspaceMutationDecision<TResult> {
  return { kind: 'changed', ...changes, result };
}

function jsonValuesEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]),
    )
  );
}

function getTasks(state: JsonObject): JsonObject {
  const tasks = state.tasks;
  return tasks && typeof tasks === 'object' && !Array.isArray(tasks) ? tasks : {};
}

function taskFieldPolicy(
  id: ProtectedWorkspacePolicyId,
  fields: readonly string[],
): WorkspaceProtectedPolicyDefinition {
  return {
    id,
    version: ACTIVE_POLICY_VERSION,
    mergeCanonical(canonical, proposal) {
      const canonicalTasks = getTasks(canonical);
      const proposedTasks = getTasks(proposal);
      for (const [taskId, canonicalTaskValue] of Object.entries(canonicalTasks)) {
        if (
          !canonicalTaskValue ||
          typeof canonicalTaskValue !== 'object' ||
          Array.isArray(canonicalTaskValue)
        ) {
          continue;
        }
        const proposedTaskValue = proposedTasks[taskId];
        if (
          !proposedTaskValue ||
          typeof proposedTaskValue !== 'object' ||
          Array.isArray(proposedTaskValue)
        ) {
          throw new WorkspaceProtectedFieldConflictError(
            id,
            `Protected task ${taskId} is missing from the proposal`,
          );
        }
        const canonicalTask = canonicalTaskValue as JsonObject;
        const proposedTask = proposedTaskValue as JsonObject;
        for (const field of fields) {
          if (!jsonValuesEqual(canonicalTask[field], proposedTask[field])) {
            throw new WorkspaceProtectedFieldConflictError(
              id,
              `Protected field tasks.${taskId}.${field} differs from canonical state`,
            );
          }
          if (field in canonicalTask) proposedTask[field] = canonicalTask[field] as JsonValue;
          else Reflect.deleteProperty(proposedTask, field);
        }
      }
    },
  };
}

function topLevelFieldPolicy(
  id: ProtectedWorkspacePolicyId,
  fields: readonly string[],
): WorkspaceProtectedPolicyDefinition {
  return {
    id,
    version: ACTIVE_POLICY_VERSION,
    mergeCanonical(canonical, proposal) {
      for (const field of fields) {
        if (!jsonValuesEqual(canonical[field], proposal[field])) {
          throw new WorkspaceProtectedFieldConflictError(
            id,
            `Protected field ${field} differs from canonical state`,
          );
        }
        if (field in canonical) proposal[field] = canonical[field] as JsonValue;
        else Reflect.deleteProperty(proposal, field);
      }
    },
  };
}

function createTaskStructurePolicy(): WorkspaceProtectedPolicyDefinition {
  return {
    id: 'task-structure',
    version: ACTIVE_POLICY_VERSION,
    mergeCanonical(canonical, proposal) {
      const canonicalIds = Object.keys(getTasks(canonical)).sort();
      const proposedIds = Object.keys(getTasks(proposal)).sort();
      if (
        canonicalIds.length !== proposedIds.length ||
        canonicalIds.some((taskId, index) => taskId !== proposedIds[index])
      ) {
        throw new WorkspaceProtectedFieldConflictError(
          'task-structure',
          'Task membership differs from canonical state',
        );
      }

      const canonicalSet = new Set(canonicalIds);
      const proposedTaskOrderCounts = new Map<string, number>();
      for (const orderField of ['taskOrder', 'collapsedTaskOrder'] as const) {
        const proposedOrder = proposal[orderField];
        if (proposedOrder !== undefined && !Array.isArray(proposedOrder)) {
          throw new WorkspaceProtectedFieldConflictError(
            'task-structure',
            `${orderField} must be an array`,
          );
        }
        for (const orderedId of proposedOrder ?? []) {
          if (typeof orderedId !== 'string') {
            throw new WorkspaceProtectedFieldConflictError(
              'task-structure',
              `${orderField} contains an invalid task ID`,
            );
          }
          // Electron's legacy combined order may still carry adapter-local terminal panel IDs.
          // They are not task membership; count only IDs backed by canonical task records.
          if (!canonicalSet.has(orderedId)) continue;
          const canonicalTask = getTasks(canonical)[orderedId];
          const isCollapsed =
            canonicalTask !== null &&
            typeof canonicalTask === 'object' &&
            !Array.isArray(canonicalTask) &&
            canonicalTask.collapsed === true;
          if (isCollapsed !== (orderField === 'collapsedTaskOrder')) {
            throw new WorkspaceProtectedFieldConflictError(
              'task-structure',
              `Task ${orderedId} visibility differs from canonical state`,
            );
          }
          proposedTaskOrderCounts.set(orderedId, (proposedTaskOrderCounts.get(orderedId) ?? 0) + 1);
        }
      }
      for (const taskId of canonicalIds) {
        if (proposedTaskOrderCounts.get(taskId) !== 1) {
          throw new WorkspaceProtectedFieldConflictError(
            'task-structure',
            `Task ${taskId} must appear exactly once across canonical task orders`,
          );
        }
      }
    },
  };
}

export const PROTECTED_WORKSPACE_POLICY_REGISTRY: Readonly<
  Record<ProtectedWorkspacePolicyId, WorkspaceProtectedPolicyDefinition>
> = Object.freeze({
  'creation-operation-link': taskFieldPolicy(
    'creation-operation-link',
    CREATION_OPERATION_LINK_FIELDS,
  ),
  'creation-outcome': taskFieldPolicy('creation-outcome', CREATION_OUTCOME_FIELDS),
  'creation-writer-epoch': taskFieldPolicy('creation-writer-epoch', CREATION_WRITER_EPOCH_FIELDS),
  'initial-prompt': taskFieldPolicy('initial-prompt', INITIAL_PROMPT_FIELDS),
  'initial-shell-ownership': taskFieldPolicy(
    'initial-shell-ownership',
    INITIAL_SHELL_OWNERSHIP_FIELDS,
  ),
  'merge-progress': topLevelFieldPolicy('merge-progress', MERGE_PROGRESS_FIELDS),
  'task-identity-location': taskFieldPolicy('task-identity-location', TASK_IDENTITY_FIELDS),
  'task-notes': taskFieldPolicy('task-notes', TASK_NOTES_FIELDS),
  'task-structure': createTaskStructurePolicy(),
});

export function createInactiveProtectedPolicyVersions(): ProtectedWorkspacePolicyVersions {
  return Object.fromEntries(
    PROTECTED_WORKSPACE_POLICY_IDS.map((id) => [id, INACTIVE_POLICY_VERSION]),
  ) as ProtectedWorkspacePolicyVersions;
}

export function getProtectedPolicyVersions(
  privateState: JsonObject,
): ProtectedWorkspacePolicyVersions {
  const raw = privateState[POLICY_STATE_KEY];
  if (raw === undefined) return createInactiveProtectedPolicyVersions();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkspaceMutationRecoveryError('Protected workspace policy registry is invalid');
  }

  const versions = createInactiveProtectedPolicyVersions();
  for (const id of PROTECTED_WORKSPACE_POLICY_IDS) {
    const version = raw[id];
    if (version !== INACTIVE_POLICY_VERSION && version !== ACTIVE_POLICY_VERSION) {
      throw new WorkspaceMutationRecoveryError(`Unsupported protected workspace policy ${id}`);
    }
    versions[id] = version;
  }
  for (const key of Object.keys(raw)) {
    if (!(PROTECTED_WORKSPACE_POLICY_IDS as readonly string[]).includes(key)) {
      throw new WorkspaceMutationRecoveryError(`Unknown protected workspace policy ${key}`);
    }
  }
  return versions;
}

export function withProtectedPolicyVersions(
  privateState: JsonObject,
  versions: ProtectedWorkspacePolicyVersions,
): JsonObject {
  return {
    ...cloneJsonObject(privateState),
    [POLICY_STATE_KEY]: { ...versions },
  };
}

export function activateProtectedPolicies(
  privateState: JsonObject,
  policyIds: readonly ProtectedWorkspacePolicyId[],
): JsonObject {
  const versions = getProtectedPolicyVersions(privateState);
  for (const policyId of policyIds) {
    versions[policyId] = ACTIVE_POLICY_VERSION;
  }
  return withProtectedPolicyVersions(privateState, versions);
}

function normalizePrivateState(privateState: JsonObject): JsonObject {
  return withProtectedPolicyVersions(privateState, getProtectedPolicyVersions(privateState));
}

export function mergeProtectedWorkspaceFields(
  canonical: JsonObject,
  proposal: JsonObject,
  privateState: JsonObject,
): JsonObject {
  const merged = cloneJsonObject(proposal);
  const versions = getProtectedPolicyVersions(privateState);
  for (const id of PROTECTED_WORKSPACE_POLICY_IDS) {
    const version = versions[id];
    if (version === INACTIVE_POLICY_VERSION) continue;
    const definition = PROTECTED_WORKSPACE_POLICY_REGISTRY[id];
    if (version !== definition.version) {
      throw new WorkspaceMutationRecoveryError(
        `No implementation for protected policy ${id}@${version}`,
      );
    }
    definition.mergeCanonical(canonical, merged);
  }
  return merged;
}

function assertExpectedRevision(expected: number | undefined, current: number): void {
  if (expected === undefined) return;
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== current) {
    throw new WorkspaceRevisionConflictError(current);
  }
}

function incrementSharedRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) {
    throw new WorkspaceMutationRecoveryError('Workspace shared revision overflow');
  }
  return revision + 1;
}

async function inStorageQueue<TResult>(
  identity: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const predecessor = mutationQueueTails.get(identity) ?? Promise.resolve();
  let release: () => void = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.catch(() => {}).then(() => turn);
  mutationQueueTails.set(identity, tail);

  await predecessor.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    void tail.finally(() => {
      if (mutationQueueTails.get(identity) === tail) mutationQueueTails.delete(identity);
    });
  }
}

function requireSynchronousDecision<TResult>(
  value: WorkspaceMutationDecision<TResult> | Promise<WorkspaceMutationDecision<TResult>>,
): WorkspaceMutationDecision<TResult> {
  if (
    value instanceof Promise ||
    (value && typeof (value as { then?: unknown }).then === 'function')
  ) {
    throw new Error('Workspace mutators must be pure and synchronous');
  }
  return value;
}

export class WorkspaceMutationService {
  private readonly coordination: WorkspaceMutationCoordination;
  private pendingDurabilityPublication: PendingDurabilityPublication | null = null;

  constructor(
    readonly storage: WorkspaceStateStorage,
    private readonly options: WorkspaceMutationServiceOptions = {},
  ) {
    this.coordination = getMutationCoordination(storage.canonicalIdentity);
  }

  close(): Promise<void> {
    return inStorageQueue(this.storage.canonicalIdentity, () =>
      this.withInspectionEpoch(() => this.storage.close()),
    );
  }

  async mutateWorkspaceState<TResult>(
    request: WorkspaceMutationRequest,
    mutator: (sharedState: Readonly<JsonObject>) => WorkspaceMutationDecision<TResult>,
  ): Promise<WorkspaceMutationResult<TResult>> {
    return this.mutateHostRecord(request, (slices) => {
      const decision = requireSynchronousDecision(mutator(cloneJsonObject(slices.sharedState)));
      if (decision.kind === 'unchanged') return decision;
      if (decision.nextLocalState !== undefined || decision.nextPrivateState !== undefined) {
        throw new Error(
          'Shared workspace mutators cannot change host-private or adapter-local state',
        );
      }
      return decision;
    });
  }

  async replaceSharedState<TResult>(
    request: WorkspaceMutationRequest,
    proposal: JsonObject,
    result: TResult,
  ): Promise<WorkspaceMutationResult<TResult>> {
    return this.mutateHostRecord(request, (slices) =>
      changed(
        {
          nextSharedState: mergeProtectedWorkspaceFields(
            slices.sharedState,
            proposal,
            slices.privateState,
          ),
        },
        result,
      ),
    );
  }

  async replaceElectronState<TResult>(
    request: WorkspaceMutationRequest,
    proposal: { localState: JsonObject; sharedState: JsonObject },
    result: TResult,
  ): Promise<WorkspaceMutationResult<TResult>> {
    if (this.storage.kind !== 'electron') {
      throw new Error('Electron state replacement requires the Electron storage adapter');
    }
    return this.mutateHostRecord(request, (slices) =>
      changed(
        {
          nextLocalState: proposal.localState,
          nextSharedState: mergeProtectedWorkspaceFields(
            slices.sharedState,
            proposal.sharedState,
            slices.privateState,
          ),
        },
        result,
      ),
    );
  }

  async repairPendingDurability(): Promise<WorkspaceMutationResult<unknown> | null> {
    return inStorageQueue(this.storage.canonicalIdentity, () =>
      this.withInspectionEpoch(async () => {
        const pending = this.pendingDurabilityPublication;
        if (!pending) {
          if (this.coordination.pendingDurabilityRevision !== null) {
            throw new WorkspaceMutationDurabilityError(this.coordination.pendingDurabilityRevision);
          }
          return null;
        }
        const repaired = await this.storage.repairDurability(pending.proposed);
        if (repaired.kind !== 'repaired') {
          throw new WorkspaceMutationRecoveryError(repaired.message, repaired.cause);
        }
        const warning = await this.publishCommitted(pending);
        this.pendingDurabilityPublication = null;
        this.coordination.pendingDurabilityRevision = null;
        return {
          changed: true,
          result: pending.result,
          revision: pending.proposed.sharedRevision,
          ...(warning ? { warning } : {}),
        };
      }),
    );
  }

  createPrivateMutationAuthority(): WorkspacePrivateSnapshotAuthority {
    return {
      inspect: (request, inspector) => this.inspectHostRecord(request, inspector),
      mutate: (request, mutator) => this.mutateHostRecord(request, mutator),
    };
  }

  private async inspectHostRecord<TResult>(
    _request: WorkspaceMutationRequest,
    inspector: (slices: Readonly<WorkspaceHostMutationSlices>) => TResult,
  ): Promise<TResult> {
    const epoch = this.coordination.inspectionEpoch;
    if (epoch % 2 !== 0) {
      throw new WorkspaceMutationRecoveryError('Workspace mutation is in flight');
    }
    const pendingRevisionBeforeLoad = this.getPendingDurabilityRevision();
    if (pendingRevisionBeforeLoad !== null) {
      throw new WorkspaceMutationDurabilityError(pendingRevisionBeforeLoad);
    }
    const startup = await this.storage.startup();
    if (startup.kind !== 'ready') {
      throw new WorkspaceMutationRecoveryError(startup.message);
    }
    const snapshot = await this.storage.loadCurrent();
    const pendingRevisionAfterLoad = this.getPendingDurabilityRevision();
    if (
      this.coordination.inspectionEpoch !== epoch ||
      this.coordination.inspectionEpoch % 2 !== 0 ||
      pendingRevisionAfterLoad !== null
    ) {
      if (pendingRevisionAfterLoad !== null) {
        throw new WorkspaceMutationDurabilityError(pendingRevisionAfterLoad);
      }
      throw new WorkspaceMutationRecoveryError('Workspace changed during inspection');
    }
    const privateState = normalizePrivateState(snapshot.record.privateState);
    return inspector({
      localState: cloneJsonObject(snapshot.record.localState),
      payloadDigest: snapshot.record.payloadDigest,
      privateState: cloneJsonObject(privateState),
      sharedRevision: snapshot.record.sharedRevision,
      sharedState: cloneJsonObject(snapshot.record.sharedState),
      storageGeneration: snapshot.record.storageGeneration,
    });
  }

  private async mutateHostRecord<TResult>(
    request: WorkspaceMutationRequest,
    mutator: (slices: Readonly<WorkspaceHostMutationSlices>) => WorkspaceMutationDecision<TResult>,
  ): Promise<WorkspaceMutationResult<TResult>> {
    return inStorageQueue(this.storage.canonicalIdentity, () =>
      this.withInspectionEpoch(async () => {
        const pendingRevision = this.getPendingDurabilityRevision();
        if (pendingRevision !== null) {
          throw new WorkspaceMutationDurabilityError(pendingRevision);
        }

        const startup = await this.storage.startup();
        if (startup.kind !== 'ready') {
          throw new WorkspaceMutationRecoveryError(startup.message);
        }
        const prior = await this.storage.loadCurrent();
        assertExpectedRevision(request.expectedSharedRevision, prior.record.sharedRevision);

        const privateState = normalizePrivateState(prior.record.privateState);
        const slices: WorkspaceHostMutationSlices = {
          localState: cloneJsonObject(prior.record.localState),
          payloadDigest: prior.record.payloadDigest,
          privateState: cloneJsonObject(privateState),
          sharedRevision: prior.record.sharedRevision,
          sharedState: cloneJsonObject(prior.record.sharedState),
          storageGeneration: prior.record.storageGeneration,
        };
        const decision = requireSynchronousDecision(mutator(slices));
        if (decision.kind === 'unchanged') {
          return {
            changed: false,
            result: decision.result,
            revision: prior.record.sharedRevision,
          };
        }

        const changes: MutationChangeFlags = {
          localChanged: decision.nextLocalState !== undefined,
          privateChanged:
            decision.nextPrivateState !== undefined ||
            !jsonValuesEqual(prior.record.privateState, privateState),
          sharedChanged: decision.nextSharedState !== undefined,
        };
        if (!changes.localChanged && !changes.privateChanged && !changes.sharedChanged) {
          throw new Error('A changed workspace mutation must replace at least one owned slice');
        }
        const proposed = createWorkspaceHostRecord({
          adapterKind: prior.record.adapterKind,
          localState: decision.nextLocalState ?? prior.record.localState,
          privateState: decision.nextPrivateState
            ? normalizePrivateState(decision.nextPrivateState)
            : privateState,
          sharedRevision: changes.sharedChanged
            ? incrementSharedRevision(prior.record.sharedRevision)
            : prior.record.sharedRevision,
          sharedState: decision.nextSharedState ?? prior.record.sharedState,
          storageGeneration: incrementCanonicalUint64(prior.record.storageGeneration),
        });
        const prepared = this.options.prepareProjections?.(proposed, changes) ?? {};
        const publication: PendingDurabilityPublication<TResult> = {
          changes,
          prepared,
          proposed,
          request,
          result: decision.result,
        };

        const commit = await this.storage.commitHostRecord(prior, proposed);
        if (commit.kind === 'not-committed') {
          throw new WorkspaceMutationNotCommittedError(commit.cause);
        }
        if (commit.kind === 'host-state-recovery-required') {
          throw new WorkspaceMutationRecoveryError(commit.message, commit.cause);
        }
        if (commit.kind === 'host-durability-repair-required') {
          this.pendingDurabilityPublication = publication;
          this.coordination.pendingDurabilityRevision = proposed.sharedRevision;
          throw new WorkspaceMutationDurabilityError(proposed.sharedRevision, commit.cause);
        }

        const warning = await this.publishCommitted(publication);
        await this.options.faultInjector?.('after-publication');
        return {
          changed: true,
          result: decision.result,
          revision: proposed.sharedRevision,
          ...(warning ? { warning } : {}),
        };
      }),
    );
  }

  private async withInspectionEpoch<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    if (
      this.coordination.inspectionEpoch % 2 !== 0 ||
      this.coordination.inspectionEpoch >= Number.MAX_SAFE_INTEGER - 1
    ) {
      throw new WorkspaceMutationRecoveryError('Workspace inspection epoch is unavailable');
    }
    this.coordination.inspectionEpoch += 1;
    try {
      return await operation();
    } finally {
      this.coordination.inspectionEpoch += 1;
    }
  }

  private getPendingDurabilityRevision(): number | null {
    return this.coordination.pendingDurabilityRevision;
  }

  private async publishCommitted(
    publication: PendingDurabilityPublication,
  ): Promise<WorkspaceMutationPublicationWarning | undefined> {
    const messages: string[] = [];
    const capture = async (label: string, action: (() => Promise<void> | void) | undefined) => {
      if (!action) return;
      try {
        await action();
      } catch (error) {
        messages.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    if (
      publication.changes.privateChanged &&
      publication.prepared.privateProjection !== undefined
    ) {
      await capture('private projection', () =>
        this.options.publishPrivateProjection?.(
          publication.prepared.privateProjection,
          publication.proposed,
        ),
      );
    }
    if (publication.changes.sharedChanged) {
      if (publication.prepared.sharedProjection !== undefined) {
        await capture('shared projection', () =>
          this.options.publishSharedProjection?.(
            publication.prepared.sharedProjection,
            publication.proposed,
          ),
        );
      }
      await capture('shared cache invalidation', this.options.invalidateSharedStateCaches);
      await capture('workspace event', () =>
        this.options.emitWorkspaceStateChanged?.({
          revision: publication.proposed.sharedRevision,
          savedAt: (this.options.now ?? Date.now)(),
          sourceId: publication.request.sourceId ?? null,
        }),
      );
    }

    if (messages.length === 0) return undefined;
    await Promise.resolve(this.options.markProjectionDegraded?.(messages)).catch(() => {});
    return { code: 'projection-repair-required', messages };
  }
}

export async function createWorkspaceMutationService(
  env: StorageEnv,
  kind: WorkspaceStorageKind,
  options: WorkspaceMutationServiceOptions = {},
): Promise<WorkspaceMutationService> {
  const storage =
    kind === 'electron'
      ? await createElectronWorkspaceStateStorage(env)
      : await createStandaloneWorkspaceStateStorage(env);
  return new WorkspaceMutationService(storage, options);
}

export function activateProtectedPolicyForTest(
  privateState: JsonObject,
  policyId: ProtectedWorkspacePolicyId,
): JsonObject {
  return activateProtectedPolicies(privateState, [policyId]);
}

export function snapshotToWorkspaceJson(snapshot: WorkspaceHostSnapshot): string {
  return JSON.stringify(snapshot.record.sharedState);
}
