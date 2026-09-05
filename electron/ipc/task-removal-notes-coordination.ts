import { randomBytes, randomUUID } from 'node:crypto';

import {
  isCurrentTaskLifecycleProjection,
  isTaskNotesOpaque32ByteToken,
  isTaskNotesTaskId,
  isTaskNotesText,
  type CurrentTaskLifecycleProjection,
  type TaskNotesCurrentEnvelope,
} from '../../src/domain/task-notes.js';
import type { TaskRemovalCurrentProjection } from '../../src/domain/task-catalog.js';
import {
  TASK_NOTES_OPERATIONS_PRIVATE_STATE_KEY,
  createTaskNotesContentVersion,
  deriveTaskNotesIncarnation,
  readTaskNotesOperationSegment,
  withTaskNotesOperationSegment,
} from './task-notes-operations.js';
import type {
  TaskNotesCurrentCollection,
  TaskNotesIdentityRecheck,
  TaskNotesMutationAdmission,
  TaskNotesMutationLease,
  TaskNotesStructuralAuthority,
} from './task-notes-service.js';
import {
  activateProtectedPolicies,
  changed,
  getProtectedPolicyVersions,
  unchanged,
  type WorkspaceHostMutationSlices,
  type WorkspacePrivateMutationAuthority,
} from './workspace-state-mutations.js';
import { cloneJsonObject, type JsonObject, type JsonValue } from './workspace-state-storage.js';

const TASK_NOTES_STRUCTURAL_SCHEMA_KEY = 'taskNotesStructuralAuthority';
const TASK_NOTES_STRUCTURAL_SCHEMA_VERSION = 1;
const TASK_IDENTITY_WITNESS_VERSION = 1;
const COLLECT_ATTEMPTS = 3;
const DEFAULT_RETRY_AFTER_MS = 500;

interface TaskIdentityWitnessRecord {
  value: string;
  witnessVersion: typeof TASK_IDENTITY_WITNESS_VERSION;
}

interface TaskNotesStructuralSchema {
  cutoverEpoch: string;
  phase: 'active';
  schemaVersion: typeof TASK_NOTES_STRUCTURAL_SCHEMA_VERSION;
  witnessesByTaskId: Record<string, TaskIdentityWitnessRecord>;
}

interface MutationRegistration {
  holders: Map<number, { retention: 'host' | 'retry-window' | null }>;
  operationId: string;
  taskIds: readonly string[];
}

interface ClosingIndexSnapshot {
  generation: number;
  ready: boolean;
}

interface StructuralSnapshot {
  closingIndexGeneration: number;
  projection: TaskRemovalCurrentProjection;
  snapshotEpoch: number;
}

interface HostSnapshot {
  payloadDigest: string;
  privateState: JsonObject;
  sharedRevision: number;
  sharedState: JsonObject;
  storageGeneration: string;
}

export interface TaskRemovalNotesCoordinationOptions {
  createCutoverEpoch?: () => string;
  createTaskIdentityWitness?: () => string;
}

export class TaskRemovalNotesRecoveryError extends Error {
  readonly code = 'task-notes-structural-recovery-required';
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function requireTasks(sharedState: Readonly<JsonObject>): JsonObject {
  const tasks = sharedState.tasks;
  if (!isJsonObject(tasks)) {
    throw new TaskRemovalNotesRecoveryError('Canonical tasks are unavailable');
  }
  return tasks;
}

function readWitnessRecord(
  value: JsonValue | undefined,
  taskId: string,
): TaskIdentityWitnessRecord {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ['value', 'witnessVersion']) ||
    value.witnessVersion !== TASK_IDENTITY_WITNESS_VERSION ||
    !isTaskNotesOpaque32ByteToken(value.value)
  ) {
    throw new TaskRemovalNotesRecoveryError(`Task identity witness ${taskId} is invalid`);
  }
  return {
    value: value.value,
    witnessVersion: TASK_IDENTITY_WITNESS_VERSION,
  };
}

function readStructuralSchema(
  privateState: Readonly<JsonObject>,
): TaskNotesStructuralSchema | null {
  const value = privateState[TASK_NOTES_STRUCTURAL_SCHEMA_KEY];
  if (value === undefined) return null;
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ['cutoverEpoch', 'phase', 'schemaVersion', 'witnessesByTaskId']) ||
    value.phase !== 'active' ||
    value.schemaVersion !== TASK_NOTES_STRUCTURAL_SCHEMA_VERSION ||
    typeof value.cutoverEpoch !== 'string' ||
    value.cutoverEpoch.trim().length === 0 ||
    value.cutoverEpoch.length > 512 ||
    !isJsonObject(value.witnessesByTaskId)
  ) {
    throw new TaskRemovalNotesRecoveryError('Task notes structural schema is invalid');
  }
  const witnessesByTaskId: Record<string, TaskIdentityWitnessRecord> = Object.create(
    null,
  ) as Record<string, TaskIdentityWitnessRecord>;
  const witnessValues = new Set<string>();
  for (const [taskId, witness] of Object.entries(value.witnessesByTaskId)) {
    if (!isTaskNotesTaskId(taskId)) {
      throw new TaskRemovalNotesRecoveryError(`Task identity witness key ${taskId} is invalid`);
    }
    const record = readWitnessRecord(witness, taskId);
    if (witnessValues.has(record.value)) {
      throw new TaskRemovalNotesRecoveryError('Task identity witnesses contain a collision');
    }
    witnessValues.add(record.value);
    witnessesByTaskId[taskId] = record;
  }
  return {
    cutoverEpoch: value.cutoverEpoch,
    phase: 'active',
    schemaVersion: TASK_NOTES_STRUCTURAL_SCHEMA_VERSION,
    witnessesByTaskId,
  };
}

function assertSchemaMatchesTasks(
  schema: TaskNotesStructuralSchema,
  tasks: Readonly<JsonObject>,
): void {
  const taskIds = Object.keys(tasks).sort();
  const witnessTaskIds = Object.keys(schema.witnessesByTaskId).sort();
  if (
    taskIds.length !== witnessTaskIds.length ||
    taskIds.some((taskId, index) => taskId !== witnessTaskIds[index])
  ) {
    throw new TaskRemovalNotesRecoveryError(
      'Task identity witnesses do not match canonical task membership',
    );
  }
  for (const taskId of taskIds) {
    if (!isTaskNotesTaskId(taskId) || !isJsonObject(tasks[taskId])) {
      throw new TaskRemovalNotesRecoveryError(`Canonical task ${taskId} is invalid for notes`);
    }
  }
}

function cloneStructuralSchema(schema: TaskNotesStructuralSchema): TaskNotesStructuralSchema {
  return JSON.parse(JSON.stringify(schema)) as TaskNotesStructuralSchema;
}

function withStructuralSchema(
  privateState: Readonly<JsonObject>,
  schema: TaskNotesStructuralSchema,
): JsonObject {
  return {
    ...cloneJsonObject(privateState as JsonObject),
    [TASK_NOTES_STRUCTURAL_SCHEMA_KEY]: cloneStructuralSchema(schema) as unknown as JsonObject,
  };
}

function nextSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new TaskRemovalNotesRecoveryError(`${label} overflow`);
  }
  return value + 1;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStructuralSnapshot(left: StructuralSnapshot, right: StructuralSnapshot): boolean {
  return (
    left.snapshotEpoch === right.snapshotEpoch &&
    left.closingIndexGeneration === right.closingIndexGeneration &&
    left.projection.serverInstanceId === right.projection.serverInstanceId &&
    left.projection.catalogVersion === right.projection.catalogVersion &&
    left.projection.taskState === right.projection.taskState &&
    left.projection.taskClosing === right.projection.taskClosing
  );
}

function sameHostStamp(left: HostSnapshot, right: HostSnapshot): boolean {
  return (
    left.storageGeneration === right.storageGeneration &&
    left.payloadDigest === right.payloadDigest &&
    left.sharedRevision === right.sharedRevision
  );
}

/**
 * Process-private O(1) union of removal admission state. It has no exported
 * type or constructor: TaskRemovalOwner is its sole lifecycle owner.
 */
class TaskClosingAdmissionIndex {
  private durableClosingByTaskId = new Map<string, string>();
  private fencesByTaskId = new Map<string, string>();
  private mutationDrainingByTaskId = new Map<string, string>();
  private registrationsByOperationId = new Map<string, MutationRegistration>();
  private operationIdsByTaskId = new Map<string, Set<string>>();
  private drainWaitersByTaskId = new Map<string, Set<() => void>>();
  private generation = 0;
  private nextHolderId = 0;
  private ready = false;

  reconstruct(durableClosing: ReadonlyMap<string, string>): void {
    if (this.registrationsByOperationId.size > 0) {
      throw new TaskRemovalNotesRecoveryError(
        'Closing index cannot reconstruct over live mutation registrations',
      );
    }
    this.durableClosingByTaskId = new Map(durableClosing);
    this.fencesByTaskId.clear();
    this.mutationDrainingByTaskId.clear();
    this.operationIdsByTaskId.clear();
    this.drainWaitersByTaskId.clear();
    this.ready = true;
    this.advanceGeneration();
  }

  getSnapshot(): ClosingIndexSnapshot {
    return { generation: this.generation, ready: this.ready };
  }

  isClosing(taskId: string): boolean {
    return (
      this.mutationDrainingByTaskId.has(taskId) ||
      this.fencesByTaskId.has(taskId) ||
      this.durableClosingByTaskId.has(taskId)
    );
  }

  admit(
    operationId: string,
    taskIds: readonly string[],
    onHostRetained: () => void,
  ): TaskNotesMutationAdmission {
    if (!this.ready) {
      return { kind: 'task-state-unavailable', retryAfterMs: DEFAULT_RETRY_AFTER_MS };
    }
    let registration = this.registrationsByOperationId.get(operationId);
    if (registration && !sameStringArray(registration.taskIds, taskIds)) {
      throw new TaskRemovalNotesRecoveryError(
        'A stable task mutation operation changed its task identity set',
      );
    }
    // A retained operation linearized before mutation-draining. Its exact
    // retry must be able to join and complete the handoff that removal is
    // already waiting for; every new operation still loses to closing.
    if (!registration && taskIds.some((taskId) => this.isClosing(taskId))) {
      return { kind: 'task-closing' };
    }
    if (!registration) {
      registration = { holders: new Map(), operationId, taskIds: [...taskIds] };
      this.registrationsByOperationId.set(operationId, registration);
      for (const taskId of taskIds) {
        const operations = this.operationIdsByTaskId.get(taskId) ?? new Set<string>();
        operations.add(operationId);
        this.operationIdsByTaskId.set(taskId, operations);
      }
    }

    this.nextHolderId = nextSafeInteger(this.nextHolderId, 'Task mutation lease holder');
    const holderId = this.nextHolderId;
    registration.holders.set(holderId, { retention: null });
    this.advanceGeneration();
    let state: 'active' | 'released' | 'retained' = 'active';
    const lease: TaskNotesMutationLease = {
      release: () => {
        if (state !== 'active') return;
        state = 'released';
        // A normally released later join proves that this stable operation has
        // reached a durability-safe terminal or retry-window handoff. Retained
        // predecessor holders for the same operation may leave with it.
        this.releaseHolder(operationId, holderId, true);
      },
      retainUntilHostDurable: () => {
        if (state !== 'active') return;
        const current = this.registrationsByOperationId.get(operationId)?.holders.get(holderId);
        if (!current) {
          throw new TaskRemovalNotesRecoveryError(
            'Task mutation lease disappeared before transfer',
          );
        }
        current.retention = 'host';
        state = 'retained';
        onHostRetained();
      },
      retainUntilRetryWindowMaterialized: () => {
        if (state !== 'active') return;
        const current = this.registrationsByOperationId.get(operationId)?.holders.get(holderId);
        if (!current) {
          throw new TaskRemovalNotesRecoveryError(
            'Task mutation lease disappeared before transfer',
          );
        }
        current.retention = 'retry-window';
        state = 'retained';
      },
    };
    return { kind: 'admitted', lease };
  }

  releaseRetained(operationId?: string, retention?: 'host' | 'retry-window'): void {
    const registrations = operationId
      ? [this.registrationsByOperationId.get(operationId)].filter(
          (entry): entry is MutationRegistration => entry !== undefined,
        )
      : [...this.registrationsByOperationId.values()];
    for (const registration of registrations) {
      for (const [holderId, holder] of [...registration.holders]) {
        if (holder.retention && (!retention || holder.retention === retention)) {
          this.releaseHolder(registration.operationId, holderId, false);
        }
      }
    }
  }

  hasRetainedRegistrations(retention?: 'host' | 'retry-window'): boolean {
    return [...this.registrationsByOperationId.values()].some((registration) =>
      [...registration.holders.values()].some(
        (holder) => holder.retention && (!retention || holder.retention === retention),
      ),
    );
  }

  beginRemovalDrain(
    taskId: string,
    proposedOperationId: string,
  ): {
    changed: boolean;
    kind: 'draining' | 'durable' | 'fence';
    operationId: string;
  } {
    if (!this.ready) {
      throw new TaskRemovalNotesRecoveryError('Closing index is not reconstructed');
    }
    const durable = this.durableClosingByTaskId.get(taskId);
    if (durable) return { changed: false, kind: 'durable', operationId: durable };
    const fence = this.fencesByTaskId.get(taskId);
    if (fence) return { changed: false, kind: 'fence', operationId: fence };
    const draining = this.mutationDrainingByTaskId.get(taskId);
    if (draining) return { changed: false, kind: 'draining', operationId: draining };
    this.mutationDrainingByTaskId.set(taskId, proposedOperationId);
    this.advanceGeneration();
    return { changed: true, kind: 'draining', operationId: proposedOperationId };
  }

  waitForRemovalDrain(taskId: string, operationId: string): Promise<void> {
    if (this.mutationDrainingByTaskId.get(taskId) !== operationId) return Promise.resolve();
    if ((this.operationIdsByTaskId.get(taskId)?.size ?? 0) === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.drainWaitersByTaskId.get(taskId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.drainWaitersByTaskId.set(taskId, waiters);
    });
  }

  swapRemovalDrainToFence(taskId: string, operationId: string): void {
    if (this.fencesByTaskId.get(taskId) === operationId) return;
    if (this.mutationDrainingByTaskId.get(taskId) !== operationId) {
      throw new TaskRemovalNotesRecoveryError('Removal mutation-draining ownership changed');
    }
    if ((this.operationIdsByTaskId.get(taskId)?.size ?? 0) !== 0) {
      throw new TaskRemovalNotesRecoveryError('Removal drain completed with live registrations');
    }
    // Both mutations are synchronous: no admission can observe an empty gap.
    this.fencesByTaskId.set(taskId, operationId);
    this.mutationDrainingByTaskId.delete(taskId);
    this.advanceGeneration();
  }

  promoteFenceToDurable(taskId: string, operationId: string): void {
    const existing = this.durableClosingByTaskId.get(taskId);
    if (existing && existing !== operationId) {
      throw new TaskRemovalNotesRecoveryError('Durable closing identity changed');
    }
    const fence = this.fencesByTaskId.get(taskId);
    if (existing === operationId && fence === undefined) return;
    if (!existing && fence !== operationId) {
      throw new TaskRemovalNotesRecoveryError('Removal fence disappeared before durable handoff');
    }
    // Publish durable first and clear the operation-keyed fence in the same synchronous turn.
    this.durableClosingByTaskId.set(taskId, operationId);
    this.fencesByTaskId.delete(taskId);
    this.mutationDrainingByTaskId.delete(taskId);
    this.advanceGeneration();
  }

  cancelUnreservedRemoval(taskId: string, operationId: string): void {
    if (this.durableClosingByTaskId.has(taskId)) return;
    let changed = false;
    if (this.fencesByTaskId.get(taskId) === operationId) {
      this.fencesByTaskId.delete(taskId);
      changed = true;
    }
    if (this.mutationDrainingByTaskId.get(taskId) === operationId) {
      this.mutationDrainingByTaskId.delete(taskId);
      changed = true;
    }
    if (changed) this.advanceGeneration();
  }

  private releaseHolder(
    operationId: string,
    holderId: number,
    releaseRetainedPredecessors: boolean,
  ): void {
    const registration = this.registrationsByOperationId.get(operationId);
    if (!registration || !registration.holders.delete(holderId)) return;
    if (releaseRetainedPredecessors) {
      for (const [retainedHolderId, holder] of [...registration.holders]) {
        if (holder.retention) registration.holders.delete(retainedHolderId);
      }
    }
    if (registration.holders.size === 0) {
      this.registrationsByOperationId.delete(operationId);
      for (const taskId of registration.taskIds) {
        const operations = this.operationIdsByTaskId.get(taskId);
        operations?.delete(operationId);
        if (operations?.size === 0) {
          this.operationIdsByTaskId.delete(taskId);
          for (const resolve of this.drainWaitersByTaskId.get(taskId) ?? []) resolve();
          this.drainWaitersByTaskId.delete(taskId);
        }
      }
    }
    this.advanceGeneration();
  }

  private advanceGeneration(): void {
    this.generation = nextSafeInteger(this.generation, 'Task closing index generation');
  }
}

/**
 * Notes-specific capabilities subordinate to TaskRemovalOwner. This class is
 * constructed only by that owner; consumers receive the narrow service view.
 */
export class TaskRemovalNotesCoordination {
  private readonly closingIndex = new TaskClosingAdmissionIndex();
  private readonly createCutoverEpoch: () => string;
  private readonly createTaskIdentityWitness: () => string;
  private readonly structuralAuthority: TaskNotesStructuralAuthority;
  private barrierGeneration = 0;
  private barrierState: 'degraded' | 'not-cut-over' | 'ready' = 'not-cut-over';
  private structuralSnapshotEpoch = 0;
  private structuralWriteDepth = 0;

  constructor(
    private readonly privateAuthority: WorkspacePrivateMutationAuthority,
    private readonly serverInstanceId: string,
    private readonly getCurrentProjection: (taskId: string) => TaskRemovalCurrentProjection,
    options: TaskRemovalNotesCoordinationOptions = {},
  ) {
    this.createCutoverEpoch =
      options.createCutoverEpoch ?? (() => `task-notes-structural-v1:${randomUUID()}`);
    this.createTaskIdentityWitness =
      options.createTaskIdentityWitness ?? (() => randomBytes(32).toString('base64url'));
    this.structuralAuthority = {
      admitTaskMutationSet: (args) => this.admitTaskMutationSet(args),
      collectTaskNotesCurrentEnvelope: (args) => this.collectTaskNotesCurrentEnvelope(args),
      getTaskNotesCommonReadiness: () => this.getTaskNotesCommonReadiness(),
      reportTaskNotesCanonicalStateFailure: (error) => this.reportCanonicalStateFailure(error),
      recheckTaskIdentityWitness: (slices, taskId, expectedTaskIdentityWitness) =>
        this.recheckTaskIdentityWitness(slices, taskId, expectedTaskIdentityWitness),
    };
  }

  getAuthority(): TaskNotesStructuralAuthority {
    return this.structuralAuthority;
  }

  getCatalogVersion(baseCatalogVersion: number): number {
    const publicationCount = Math.floor(this.structuralSnapshotEpoch / 2);
    if (
      !Number.isSafeInteger(baseCatalogVersion) ||
      baseCatalogVersion < 0 ||
      baseCatalogVersion > Number.MAX_SAFE_INTEGER - publicationCount
    ) {
      throw new TaskRemovalNotesRecoveryError('Task catalog version overflow');
    }
    return baseCatalogVersion + publicationCount;
  }

  isTaskClosing(taskId: string): boolean {
    return this.closingIndex.isClosing(taskId);
  }

  beginCanonicalStructureWrite(): void {
    if (this.structuralWriteDepth === 0) {
      this.structuralSnapshotEpoch = nextSafeInteger(
        this.structuralSnapshotEpoch,
        'Structural snapshot epoch',
      );
    }
    this.structuralWriteDepth += 1;
  }

  endCanonicalStructureWrite(): void {
    if (this.structuralWriteDepth < 1) {
      throw new TaskRemovalNotesRecoveryError('Structural write publication is unbalanced');
    }
    this.structuralWriteDepth -= 1;
    if (this.structuralWriteDepth === 0) {
      this.structuralSnapshotEpoch = nextSafeInteger(
        this.structuralSnapshotEpoch,
        'Structural snapshot epoch',
      );
    }
  }

  publishStructuralChange(): void {
    if (this.structuralWriteDepth > 0) return;
    this.beginCanonicalStructureWrite();
    this.endCanonicalStructureWrite();
  }

  rebuild(
    privateState: Readonly<JsonObject>,
    sharedState: Readonly<JsonObject>,
    durableClosingByTaskId: ReadonlyMap<string, string>,
  ): void {
    this.closeBarrier('not-cut-over');
    this.closingIndex.reconstruct(durableClosingByTaskId);
    const tasks = requireTasks(sharedState);
    const schema = readStructuralSchema(privateState);
    const notesPolicyActive = getProtectedPolicyVersions(privateState)['task-notes'] === '1';
    if (!schema) {
      if (notesPolicyActive) {
        throw new TaskRemovalNotesRecoveryError(
          'Task notes protected policy is active without structural authority',
        );
      }
      this.publishStructuralChange();
      return;
    }
    if (!notesPolicyActive) {
      throw new TaskRemovalNotesRecoveryError(
        'Task notes structural authority is active without protected policy',
      );
    }
    this.assertNotesServerInstanceId();
    assertSchemaMatchesTasks(schema, tasks);
    readTaskNotesOperationSegment(privateState);
    this.publishStructuralChange();
    this.openBarrier();
  }

  async activate(): Promise<TaskNotesStructuralAuthority> {
    this.closeBarrier('degraded');
    const inspected = await this.privateAuthority.mutate(
      { operation: 'inspect-task-notes-structural-cutover' },
      (slices) => {
        const tasks = requireTasks(slices.sharedState);
        const existing = readStructuralSchema(slices.privateState);
        if (existing) assertSchemaMatchesTasks(existing, tasks);
        return unchanged({ existing, taskIds: Object.keys(tasks).sort() });
      },
    );
    const proposedWitnesses: Record<string, TaskIdentityWitnessRecord> = Object.create(
      null,
    ) as Record<string, TaskIdentityWitnessRecord>;
    const usedWitnesses = new Set<string>();
    if (!inspected.result.existing) {
      for (const taskId of inspected.result.taskIds) {
        let witness = '';
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const candidate = this.createTaskIdentityWitness();
          if (!isTaskNotesOpaque32ByteToken(candidate)) {
            throw new TaskRemovalNotesRecoveryError(
              'Task identity witness source returned an invalid token',
            );
          }
          if (!usedWitnesses.has(candidate)) {
            witness = candidate;
            break;
          }
        }
        if (!witness) {
          throw new TaskRemovalNotesRecoveryError('Task identity witness collision limit reached');
        }
        usedWitnesses.add(witness);
        proposedWitnesses[taskId] = {
          value: witness,
          witnessVersion: TASK_IDENTITY_WITNESS_VERSION,
        };
      }
    }
    const proposedCutoverEpoch = this.createCutoverEpoch();
    if (proposedCutoverEpoch.trim().length === 0 || proposedCutoverEpoch.length > 512) {
      throw new TaskRemovalNotesRecoveryError('Task notes cutover epoch is invalid');
    }

    await this.privateAuthority.mutate(
      { operation: 'activate-task-notes-structural-cutover' },
      (slices) => {
        const tasks = requireTasks(slices.sharedState);
        const taskIds = Object.keys(tasks).sort();
        if (!sameStringArray(taskIds, inspected.result.taskIds)) {
          throw new TaskRemovalNotesRecoveryError(
            'Canonical task membership changed during notes cutover',
          );
        }
        const existing = readStructuralSchema(slices.privateState);
        let schema: TaskNotesStructuralSchema;
        if (existing) {
          assertSchemaMatchesTasks(existing, tasks);
          schema = existing;
        } else {
          schema = {
            cutoverEpoch: proposedCutoverEpoch,
            phase: 'active',
            schemaVersion: TASK_NOTES_STRUCTURAL_SCHEMA_VERSION,
            witnessesByTaskId: proposedWitnesses,
          };
          assertSchemaMatchesTasks(schema, tasks);
        }
        const segment = readTaskNotesOperationSegment(slices.privateState, { allowMissing: true });
        if (
          existing &&
          slices.privateState[TASK_NOTES_OPERATIONS_PRIVATE_STATE_KEY] !== undefined &&
          getProtectedPolicyVersions(slices.privateState)['task-notes'] === '1'
        ) {
          return unchanged(undefined);
        }
        let nextPrivate = withTaskNotesOperationSegment(slices.privateState, segment);
        nextPrivate = withStructuralSchema(nextPrivate, schema);
        nextPrivate = activateProtectedPolicies(nextPrivate, ['task-notes']);
        return changed({ nextPrivateState: nextPrivate }, undefined);
      },
    );

    await this.privateAuthority.mutate(
      { operation: 'verify-task-notes-structural-cutover' },
      (slices) => {
        const tasks = requireTasks(slices.sharedState);
        const schema = readStructuralSchema(slices.privateState);
        if (!schema) {
          throw new TaskRemovalNotesRecoveryError('Task notes structural cutover disappeared');
        }
        assertSchemaMatchesTasks(schema, tasks);
        readTaskNotesOperationSegment(slices.privateState);
        if (getProtectedPolicyVersions(slices.privateState)['task-notes'] !== '1') {
          throw new TaskRemovalNotesRecoveryError('Task notes protection did not activate');
        }
        return unchanged(undefined);
      },
    );
    this.assertNotesServerInstanceId();
    this.publishStructuralChange();
    this.openBarrier();
    return this.structuralAuthority;
  }

  createWitnessCandidate(): string {
    const witness = this.createTaskIdentityWitness();
    if (!isTaskNotesOpaque32ByteToken(witness)) {
      throw new TaskRemovalNotesRecoveryError(
        'Task identity witness source returned an invalid token',
      );
    }
    return witness;
  }

  withTaskIdentityAdded(
    privateState: Readonly<JsonObject>,
    taskId: string,
    witness: string,
    taskAlreadyExists: boolean,
  ): { changed: boolean; privateState: JsonObject } {
    const schema = readStructuralSchema(privateState);
    if (!schema) {
      if (getProtectedPolicyVersions(privateState)['task-notes'] === '1') {
        throw new TaskRemovalNotesRecoveryError(
          'Task notes protected policy is active without identity authority',
        );
      }
      return { changed: false, privateState: privateState as JsonObject };
    }
    readTaskNotesOperationSegment(privateState);
    if (getProtectedPolicyVersions(privateState)['task-notes'] !== '1') {
      throw new TaskRemovalNotesRecoveryError('Task notes protected policy is inactive');
    }
    const existing = schema.witnessesByTaskId[taskId];
    if (taskAlreadyExists) {
      if (!existing) {
        throw new TaskRemovalNotesRecoveryError(`Task identity witness ${taskId} is missing`);
      }
      return { changed: false, privateState: privateState as JsonObject };
    }
    if (existing) {
      throw new TaskRemovalNotesRecoveryError(`Task identity witness ${taskId} already exists`);
    }
    if (!isTaskNotesTaskId(taskId) || !isTaskNotesOpaque32ByteToken(witness)) {
      throw new TaskRemovalNotesRecoveryError('New task identity witness is invalid');
    }
    if (
      Object.values(schema.witnessesByTaskId).some(
        (existingWitness) => existingWitness.value === witness,
      )
    ) {
      throw new TaskRemovalNotesRecoveryError('New task identity witness collides');
    }
    const next = cloneStructuralSchema(schema);
    next.witnessesByTaskId[taskId] = {
      value: witness,
      witnessVersion: TASK_IDENTITY_WITNESS_VERSION,
    };
    return { changed: true, privateState: withStructuralSchema(privateState, next) };
  }

  withoutTaskIdentity(privateState: Readonly<JsonObject>, taskId: string): JsonObject {
    const schema = readStructuralSchema(privateState);
    if (!schema) return privateState as JsonObject;
    if (!schema.witnessesByTaskId[taskId]) {
      throw new TaskRemovalNotesRecoveryError(`Removed task identity witness ${taskId} is missing`);
    }
    const next = cloneStructuralSchema(schema);
    Reflect.deleteProperty(next.witnessesByTaskId, taskId);
    return withStructuralSchema(privateState, next);
  }

  beginRemovalDrain(
    taskId: string,
    proposedOperationId: string,
  ): {
    kind: 'draining' | 'durable' | 'fence';
    operationId: string;
  } {
    const result = this.closingIndex.beginRemovalDrain(taskId, proposedOperationId);
    if (result.changed) this.publishStructuralChange();
    return { kind: result.kind, operationId: result.operationId };
  }

  async drainAndFenceRemoval(taskId: string, operationId: string): Promise<void> {
    await this.closingIndex.waitForRemovalDrain(taskId, operationId);
    this.closingIndex.swapRemovalDrainToFence(taskId, operationId);
    this.publishStructuralChange();
  }

  promoteRemovalFenceToDurable(taskId: string, operationId: string): void {
    this.closingIndex.promoteFenceToDurable(taskId, operationId);
    this.publishStructuralChange();
  }

  cancelUnreservedRemoval(taskId: string, operationId: string): void {
    this.closingIndex.cancelUnreservedRemoval(taskId, operationId);
    this.publishStructuralChange();
  }

  async recoverAfterHostDurability(operationId?: string): Promise<void> {
    this.closeBarrier('degraded');
    await this.privateAuthority.mutate(
      { operation: 'recover-task-notes-structural-readiness' },
      (slices) => {
        const tasks = requireTasks(slices.sharedState);
        const schema = readStructuralSchema(slices.privateState);
        if (!schema) {
          throw new TaskRemovalNotesRecoveryError('Task notes structural cutover is unavailable');
        }
        assertSchemaMatchesTasks(schema, tasks);
        readTaskNotesOperationSegment(slices.privateState);
        if (getProtectedPolicyVersions(slices.privateState)['task-notes'] !== '1') {
          throw new TaskRemovalNotesRecoveryError('Task notes protected policy is inactive');
        }
        return unchanged(undefined);
      },
    );
    this.closingIndex.releaseRetained(operationId, 'host');
    if (this.closingIndex.hasRetainedRegistrations('host')) {
      throw new TaskRemovalNotesRecoveryError('Task notes durability registrations remain held');
    }
    this.publishStructuralChange();
    this.openBarrier();
  }

  reportCanonicalStateFailure(_error: unknown): void {
    this.closeBarrier('degraded');
  }

  private getTaskNotesCommonReadiness() {
    if (
      this.barrierState !== 'ready' ||
      this.structuralWriteDepth !== 0 ||
      this.structuralSnapshotEpoch % 2 !== 0 ||
      !this.closingIndex.getSnapshot().ready ||
      this.closingIndex.hasRetainedRegistrations('host')
    ) {
      return { kind: 'unavailable' as const, retryAfterMs: DEFAULT_RETRY_AFTER_MS };
    }
    return {
      generation: this.currentReadinessGeneration(),
      kind: 'ready' as const,
      writable: true,
    };
  }

  private async admitTaskMutationSet(args: {
    operationId: string;
    readinessGeneration: string;
    taskIds: readonly string[];
  }): Promise<TaskNotesMutationAdmission> {
    const readiness = this.getTaskNotesCommonReadiness();
    if (readiness.kind !== 'ready' || readiness.generation !== args.readinessGeneration) {
      return { kind: 'task-state-unavailable', retryAfterMs: DEFAULT_RETRY_AFTER_MS };
    }
    if (args.operationId.trim().length === 0 || args.operationId.length > 512) {
      throw new TaskRemovalNotesRecoveryError('Task mutation operation identity is invalid');
    }
    const taskIds = [...new Set(args.taskIds)].sort();
    if (
      taskIds.length === 0 ||
      taskIds.length !== args.taskIds.length ||
      taskIds.some((taskId) => !isTaskNotesTaskId(taskId))
    ) {
      throw new TaskRemovalNotesRecoveryError('Task mutation identity set is invalid');
    }
    return this.closingIndex.admit(args.operationId, taskIds, () => {
      this.closeBarrier('degraded');
    });
  }

  private async collectTaskNotesCurrentEnvelope(args: {
    expectedTaskIdentityWitness?: string;
    readinessGeneration: string;
    taskId: string;
  }): Promise<TaskNotesCurrentCollection> {
    if (
      !isTaskNotesTaskId(args.taskId) ||
      (args.expectedTaskIdentityWitness !== undefined &&
        !isTaskNotesOpaque32ByteToken(args.expectedTaskIdentityWitness))
    ) {
      throw new TaskRemovalNotesRecoveryError('Task notes collection identity is invalid');
    }
    const initialReadiness = this.getTaskNotesCommonReadiness();
    if (
      initialReadiness.kind !== 'ready' ||
      initialReadiness.generation !== args.readinessGeneration
    ) {
      return { kind: 'unavailable', retryAfterMs: DEFAULT_RETRY_AFTER_MS };
    }

    for (let attempt = 0; attempt < COLLECT_ATTEMPTS; attempt += 1) {
      try {
        const host1 = await this.captureHostSnapshot('h1');
        const structural1 = this.captureStructuralSnapshot(args.taskId);
        if (!structural1) continue;
        const current = this.buildCurrentEnvelope(
          host1,
          structural1.projection,
          args.taskId,
          args.expectedTaskIdentityWitness,
        );
        const structural2 = this.captureStructuralSnapshot(args.taskId);
        if (!structural2) continue;
        const host2 = await this.captureHostSnapshot('h2');
        const currentReadiness = this.getTaskNotesCommonReadiness();
        if (
          currentReadiness.kind !== 'ready' ||
          currentReadiness.generation !== args.readinessGeneration ||
          !sameHostStamp(host1, host2) ||
          !sameStructuralSnapshot(structural1, structural2)
        ) {
          continue;
        }
        return current;
      } catch (error) {
        this.reportCanonicalStateFailure(error);
        return { kind: 'unavailable', retryAfterMs: DEFAULT_RETRY_AFTER_MS };
      }
    }
    return { kind: 'unavailable', retryAfterMs: DEFAULT_RETRY_AFTER_MS };
  }

  private recheckTaskIdentityWitness(
    slices: Readonly<WorkspaceHostMutationSlices>,
    taskId: string,
    expectedTaskIdentityWitness: string,
  ): TaskNotesIdentityRecheck {
    if (
      this.getTaskNotesCommonReadiness().kind !== 'ready' ||
      !isTaskNotesTaskId(taskId) ||
      !isTaskNotesOpaque32ByteToken(expectedTaskIdentityWitness)
    ) {
      return { kind: 'task-state-unavailable' };
    }
    try {
      const tasks = requireTasks(slices.sharedState);
      const task = Object.prototype.hasOwnProperty.call(tasks, taskId) ? tasks[taskId] : undefined;
      const schema = readStructuralSchema(slices.privateState);
      if (!schema || !isJsonObject(task)) {
        this.reportCanonicalStateFailure(
          new TaskRemovalNotesRecoveryError('Admitted canonical task identity disappeared'),
        );
        return { kind: 'task-state-unavailable' };
      }
      const witness = schema.witnessesByTaskId[taskId];
      if (!witness) {
        this.reportCanonicalStateFailure(
          new TaskRemovalNotesRecoveryError('Admitted task identity witness disappeared'),
        );
        return { kind: 'task-state-unavailable' };
      }
      return witness.value === expectedTaskIdentityWitness
        ? { kind: 'same-incarnation' }
        : { kind: 'task-incarnation-changed' };
    } catch (error) {
      this.reportCanonicalStateFailure(error);
      return { kind: 'task-state-unavailable' };
    }
  }

  private captureStructuralSnapshot(taskId: string): StructuralSnapshot | null {
    const index = this.closingIndex.getSnapshot();
    if (this.structuralWriteDepth !== 0 || this.structuralSnapshotEpoch % 2 !== 0 || !index.ready) {
      return null;
    }
    return {
      closingIndexGeneration: index.generation,
      projection: this.getCurrentProjection(taskId),
      snapshotEpoch: this.structuralSnapshotEpoch,
    };
  }

  private async captureHostSnapshot(label: 'h1' | 'h2'): Promise<HostSnapshot> {
    const capture = await this.privateAuthority.mutate(
      { operation: `collect-task-notes-current-${label}` },
      (slices) =>
        unchanged({
          payloadDigest: slices.payloadDigest,
          privateState: slices.privateState,
          sharedRevision: slices.sharedRevision,
          sharedState: slices.sharedState,
          storageGeneration: slices.storageGeneration,
        }),
    );
    return capture.result;
  }

  private buildCurrentEnvelope(
    host: HostSnapshot,
    projection: TaskRemovalCurrentProjection,
    taskId: string,
    expectedTaskIdentityWitness?: string,
  ): { kind: 'collected'; current: TaskNotesCurrentEnvelope; taskIdentityWitness?: string } {
    const tasks = requireTasks(host.sharedState);
    const task = Object.prototype.hasOwnProperty.call(tasks, taskId) ? tasks[taskId] : undefined;
    const schema = readStructuralSchema(host.privateState);
    if (!schema) {
      throw new TaskRemovalNotesRecoveryError('Task notes structural schema is unavailable');
    }
    const witness = schema.witnessesByTaskId[taskId];

    if (projection.taskState === 'present') {
      if (!isJsonObject(task) || !witness || !isTaskNotesText(task.notes)) {
        throw new TaskRemovalNotesRecoveryError(
          'Canonical task, notes, lifecycle, and identity witness disagree',
        );
      }
      const taskIncarnation = deriveTaskNotesIncarnation(witness.value);
      const currentTask: CurrentTaskLifecycleProjection = {
        catalogVersion: projection.catalogVersion,
        serverInstanceId: projection.serverInstanceId,
        taskClosing: projection.taskClosing,
        taskIncarnation,
        taskState: 'present',
      };
      if (!isCurrentTaskLifecycleProjection(currentTask)) {
        throw new TaskRemovalNotesRecoveryError('Current task lifecycle projection is invalid');
      }
      if (
        expectedTaskIdentityWitness !== undefined &&
        expectedTaskIdentityWitness !== witness.value
      ) {
        return {
          current: {
            currentNotes: {
              kind: 'unavailable',
              reason: 'task-replaced',
              workspaceRevision: host.sharedRevision,
            },
            currentTask,
            relation: 'task-replaced',
          },
          kind: 'collected',
        };
      }
      return {
        current: {
          currentNotes: {
            kind: 'present',
            snapshot: {
              contentVersion: createTaskNotesContentVersion(task.notes),
              notes: task.notes,
              taskId,
              taskIncarnation,
              workspaceRevision: host.sharedRevision,
            },
          },
          currentTask,
          relation: 'same-incarnation',
        },
        kind: 'collected',
        taskIdentityWitness: witness.value,
      };
    }

    if (task !== undefined || witness !== undefined || projection.taskClosing) {
      throw new TaskRemovalNotesRecoveryError(
        'Absent task lifecycle contradicts canonical membership or identity',
      );
    }
    if (projection.taskState === 'removed') {
      return {
        current: {
          currentNotes: {
            kind: 'unavailable',
            reason: 'task-removed',
            workspaceRevision: host.sharedRevision,
          },
          currentTask: {
            catalogVersion: projection.catalogVersion,
            serverInstanceId: projection.serverInstanceId,
            taskClosing: false,
            taskState: 'removed',
          },
          relation: 'task-removed',
        },
        kind: 'collected',
      };
    }
    return {
      current: {
        currentNotes: {
          kind: 'unavailable',
          reason: 'task-not-visible',
          workspaceRevision: host.sharedRevision,
        },
        currentTask: {
          catalogVersion: projection.catalogVersion,
          serverInstanceId: projection.serverInstanceId,
          taskClosing: false,
          taskState: 'not-visible',
        },
        relation: 'task-not-visible',
      },
      kind: 'collected',
    };
  }

  private currentReadinessGeneration(): string {
    return `task-notes-common-v1:${this.serverInstanceId}:${this.barrierGeneration}`;
  }

  private assertNotesServerInstanceId(): void {
    if (
      !isCurrentTaskLifecycleProjection({
        catalogVersion: 0,
        serverInstanceId: this.serverInstanceId,
        taskClosing: false,
        taskState: 'not-visible',
      })
    ) {
      throw new TaskRemovalNotesRecoveryError('Task notes server instance identity is invalid');
    }
  }

  private closeBarrier(state: 'degraded' | 'not-cut-over'): void {
    if (this.barrierState === state) return;
    this.barrierState = state;
    this.barrierGeneration = nextSafeInteger(
      this.barrierGeneration,
      'Task notes readiness generation',
    );
  }

  private openBarrier(): void {
    this.barrierState = 'ready';
    this.barrierGeneration = nextSafeInteger(
      this.barrierGeneration,
      'Task notes readiness generation',
    );
  }
}
