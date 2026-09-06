import {
  AGENT_SESSION_ACK_DEADLINE_MS,
  AGENT_SESSION_OWNER_HOOK_SET_VERSION,
  isAgentSessionOperationRequest,
  transitionAgentSessionOperation,
  type AgentSessionInitialOperationRequest,
  type AgentSessionOperationProjection,
  type AgentSessionOperationRequest,
  type AgentSessionOperationResult,
  type AgentSessionOperationSnapshot,
  type AgentSessionOwnerAvailability,
  type DrainTaskAgentSessionsForRemovalRequest,
  type DrainTaskAgentSessionsForRemovalResult,
  type FinalizeRemovedTaskAgentSessionStateRequest,
  type FinalizeRemovedTaskAgentSessionStateResult,
} from '../../src/domain/agent-session-operation.js';
import {
  isTaskRemovalCurrentProjection,
  reduceTaskRemovalCurrentProjection,
  type TaskRemovalCurrentProjection,
} from '../../src/domain/task-catalog.js';
import type { AgentResumeFailureClassifier } from '../../src/ipc/types.js';
import { isRecord } from '../../src/lib/type-guards.js';
import {
  deriveAgentSessionOperationFingerprint,
  type AgentSessionIdentityMarker,
  type AgentSessionJournalOperationRecord,
  type AgentSessionOperationJournal,
} from './agent-session-operation-journal.js';
import { canonicalJsonStringify, type JsonObject } from './workspace-state-storage.js';

export const AGENT_SESSION_MARKER_FINALIZER_KIND = 'agent-session-marker-gc' as const;

export interface AgentSessionRemovalGateActiveSnapshot {
  current: TaskRemovalCurrentProjection;
  cutoverEpoch: string;
  hookSetVersion: string;
  kind: 'active';
}

export type AgentSessionRemovalGateSnapshot =
  | AgentSessionRemovalGateActiveSnapshot
  | { kind: 'unavailable' };

export interface AgentSessionInitialAdmissionMapping {
  agentDefId: string;
  agentId: string;
  committedWorkspaceRevision: number;
  creationOperationId: string;
  launchOperationId: string;
  taskId: string;
}

export type AgentSessionAdmissionInspection =
  | {
      agentDefId: string;
      currentGeneration: null;
      currentWorkspaceRevision: number;
      initialMapping: AgentSessionInitialAdmissionMapping;
      kind: 'initial';
      targetGeneration: number;
    }
  | {
      agentDefId: string;
      currentGeneration: number;
      currentLeaseGeneration: number;
      fallbackClassifier?: AgentResumeFailureClassifier;
      kind: 'replacement';
      targetGeneration: number;
    };

export interface AgentSessionGenerationAllocationRequest {
  agentId: string;
  expectedSourceGeneration: number | null;
  operationId: string;
  targetGeneration: number;
  taskId: string;
}

export interface AgentSessionRunnerOperationRequest extends AgentSessionGenerationAllocationRequest {
  agentDefId: string;
  launchReason: AgentSessionOperationRequest['launchReason'];
  mode: AgentSessionOperationRequest['mode'];
}

export interface AgentSessionWorkflowAuthority {
  admitTransition(request: AgentSessionOperationRequest): Promise<boolean>;
  allocateGeneration(
    request: AgentSessionGenerationAllocationRequest,
  ): Promise<'allocated' | 'already-allocated' | 'stale'>;
  drainTaskSessionsForRemoval(request: DrainTaskAgentSessionsForRemovalRequest): Promise<boolean>;
  inspectAdmission(
    request: AgentSessionOperationRequest,
  ): Promise<AgentSessionAdmissionInspection | null>;
  publishOperation(projection: AgentSessionOperationProjection): Promise<void>;
  releaseGeneration?(request: AgentSessionGenerationAllocationRequest): Promise<void> | void;
  spawnRunner(
    request: AgentSessionRunnerOperationRequest,
    signal: AbortSignal,
  ): Promise<'failed' | 'running'>;
  stopPreviousRunner(request: AgentSessionRunnerOperationRequest): Promise<boolean>;
  verifyCommittedTaskRemoval(
    request: FinalizeRemovedTaskAgentSessionStateRequest,
  ): Promise<boolean>;
}

export interface AgentSessionWorkflowTimer {
  clear(handle: unknown): void;
  schedule(callback: () => void, delayMs: number): unknown;
}

export interface AgentSessionWorkflowDependencies {
  authority: AgentSessionWorkflowAuthority;
  getOwnerAvailability(
    taskId: string,
  ): AgentSessionOwnerAvailability | Promise<AgentSessionOwnerAvailability>;
  getRemovalGate(
    taskId: string,
  ): AgentSessionRemovalGateSnapshot | Promise<AgentSessionRemovalGateSnapshot>;
  journal: AgentSessionOperationJournal;
  now?: () => number;
  timer?: AgentSessionWorkflowTimer;
}

export type AgentSessionOwnerHookProbe =
  | {
      hookSetVersion: typeof AGENT_SESSION_OWNER_HOOK_SET_VERSION;
      kind: 'ready';
    }
  | {
      hookSetVersion: typeof AGENT_SESSION_OWNER_HOOK_SET_VERSION;
      kind: 'unavailable';
      reason: 'journal-unavailable';
    };

export interface AgentSessionRemovalOwnerHooks {
  drainTaskAgentSessionsForRemoval(
    request: DrainTaskAgentSessionsForRemovalRequest,
  ): Promise<DrainTaskAgentSessionsForRemovalResult>;
  finalizeRemovedTaskAgentSessionState(
    request: FinalizeRemovedTaskAgentSessionStateRequest,
  ): Promise<FinalizeRemovedTaskAgentSessionStateResult>;
  readonly hookSetVersion: typeof AGENT_SESSION_OWNER_HOOK_SET_VERSION;
  probe(): Promise<AgentSessionOwnerHookProbe>;
}

export interface AgentSessionWorkflow {
  drain(taskId?: string): Promise<void>;
  execute(request: AgentSessionOperationRequest): Promise<AgentSessionOperationResult>;
  getOwnerAvailability(taskId: string): Promise<AgentSessionOwnerAvailability>;
  readonly removalHooks: AgentSessionRemovalOwnerHooks;
}

export class AgentSessionOperationConflictError extends Error {
  readonly code = 'agent-session-operation-conflict';
}

type AdmissionBarrier =
  | { current: TaskRemovalCurrentProjection; kind: 'closed' }
  | { current: TaskRemovalCurrentProjection; kind: 'ready' }
  | { kind: 'unavailable' };

interface InFlightOperation {
  promise: Promise<AgentSessionOperationResult>;
  requestFingerprint: string;
}

const DEFAULT_TIMER: AgentSessionWorkflowTimer = {
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
};

function isIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !value.includes('\u0000')
  );
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isActiveOwnerAvailability(
  value: unknown,
): value is Extract<AgentSessionOwnerAvailability, { kind: 'active' }> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['current', 'cutoverEpoch', 'hookSetVersion', 'kind']) &&
    value.kind === 'active' &&
    isIdentity(value.cutoverEpoch) &&
    value.hookSetVersion === AGENT_SESSION_OWNER_HOOK_SET_VERSION &&
    isTaskRemovalCurrentProjection(value.current)
  );
}

function isActiveRemovalGate(value: unknown): value is AgentSessionRemovalGateActiveSnapshot {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['current', 'cutoverEpoch', 'hookSetVersion', 'kind']) &&
    value.kind === 'active' &&
    isIdentity(value.cutoverEpoch) &&
    value.hookSetVersion === AGENT_SESSION_OWNER_HOOK_SET_VERSION &&
    isTaskRemovalCurrentProjection(value.current)
  );
}

function unavailableResult(): AgentSessionOperationResult {
  return { failure: 'session-state-unavailable', kind: 'admission-unavailable' };
}

function operationResult(
  snapshot: AgentSessionOperationSnapshot,
  current: TaskRemovalCurrentProjection,
  replayed: boolean,
): AgentSessionOperationResult {
  return {
    kind: 'operation',
    projection: { current, operation: snapshot },
    replayed,
  };
}

function requestFingerprint(request: AgentSessionOperationRequest): string {
  return canonicalJsonStringify(request as unknown as JsonObject);
}

function sameRequest(
  left: AgentSessionOperationRequest,
  right: AgentSessionOperationRequest,
): boolean {
  return requestFingerprint(left) === requestFingerprint(right);
}

function markerTerminalPhase(
  phase: AgentSessionOperationSnapshot['phase'],
): 'cancelled' | 'failed' | 'running' | 'superseded' | undefined {
  return phase === 'cancelled' ||
    phase === 'failed' ||
    phase === 'running' ||
    phase === 'superseded'
    ? phase
    : undefined;
}

function identityMarkerForRecord(
  record: AgentSessionJournalOperationRecord,
): AgentSessionIdentityMarker | undefined {
  if (record.request.mode === 'initial') {
    if (record.snapshot.targetGeneration === undefined) return undefined;
    const terminalPhase = markerTerminalPhase(record.snapshot.phase);
    return {
      agentId: record.request.agentId,
      initialLaunch: {
        agentDefId: record.agentDefId,
        agentId: record.request.agentId,
        committedWorkspaceRevision: record.request.admission.committedWorkspaceRevision,
        creationOperationId: record.request.admission.creationOperationId,
        fingerprint: record.fingerprint,
        lastKnownPhase: record.snapshot.phase,
        launchOperationId: record.request.operationId,
        targetGeneration: record.snapshot.targetGeneration,
        taskId: record.request.taskId,
        ...(terminalPhase ? { terminalPhase } : {}),
      },
      taskId: record.request.taskId,
    };
  }
  if (
    record.request.launchReason === 'resume-fallback' &&
    record.snapshot.fallbackClassifier !== undefined
  ) {
    return {
      agentId: record.request.agentId,
      fallbackHighWater: {
        classifier: record.snapshot.fallbackClassifier,
        fingerprint: record.fingerprint,
        highestAttemptedSourceGeneration: record.request.expectedSourceGeneration,
        lastKnownPhase: record.snapshot.phase,
        operationId: record.request.operationId,
      },
      taskId: record.request.taskId,
    };
  }
  return undefined;
}

function runnerRequest(
  record: AgentSessionJournalOperationRecord,
): AgentSessionRunnerOperationRequest {
  if (record.snapshot.targetGeneration === undefined) {
    throw new Error('Agent-session operation has no allocated target generation');
  }
  return {
    agentDefId: record.agentDefId,
    agentId: record.request.agentId,
    expectedSourceGeneration: record.request.expectedSourceGeneration,
    launchReason: record.request.launchReason,
    mode: record.request.mode,
    operationId: record.request.operationId,
    targetGeneration: record.snapshot.targetGeneration,
    taskId: record.request.taskId,
  };
}

function isValidInspection(
  request: AgentSessionOperationRequest,
  inspection: AgentSessionAdmissionInspection,
): boolean {
  if (
    !isIdentity(inspection.agentDefId) ||
    !isGeneration(inspection.targetGeneration) ||
    (request.expectedSourceGeneration === null
      ? inspection.targetGeneration < 0
      : inspection.targetGeneration !== request.expectedSourceGeneration + 1)
  ) {
    return false;
  }
  if (request.mode === 'initial') {
    if (inspection.kind !== 'initial' || inspection.currentGeneration !== null) return false;
    const mapping = inspection.initialMapping;
    return (
      mapping.agentDefId === request.nextAgentDefId &&
      inspection.agentDefId === request.nextAgentDefId &&
      mapping.agentId === request.agentId &&
      mapping.committedWorkspaceRevision === request.admission.committedWorkspaceRevision &&
      mapping.creationOperationId === request.admission.creationOperationId &&
      mapping.launchOperationId === request.operationId &&
      mapping.taskId === request.taskId &&
      inspection.currentWorkspaceRevision >= request.admission.committedWorkspaceRevision
    );
  }
  return (
    inspection.kind === 'replacement' &&
    inspection.currentGeneration === request.expectedSourceGeneration &&
    inspection.currentLeaseGeneration === request.expectedLeaseGeneration &&
    (request.mode !== 'switch' || inspection.agentDefId === request.nextAgentDefId) &&
    (request.launchReason === 'resume-fallback'
      ? inspection.fallbackClassifier === 'claude-no-conversation-v1'
      : inspection.fallbackClassifier === undefined)
  );
}

class AgentSessionWorkflowImpl implements AgentSessionWorkflow {
  readonly removalHooks: AgentSessionRemovalOwnerHooks;
  private readonly agentQueues = new Map<string, Promise<void>>();
  private readonly drainReceipts = new Set<string>();
  private readonly draining = new Map<string, Promise<DrainTaskAgentSessionsForRemovalResult>>();
  private readonly inFlightByOperation = new Map<string, InFlightOperation>();
  private readonly inFlightByTask = new Map<string, Set<Promise<AgentSessionOperationResult>>>();
  private probePromise: Promise<AgentSessionOwnerHookProbe> | null = null;

  constructor(private readonly dependencies: AgentSessionWorkflowDependencies) {
    this.removalHooks = {
      drainTaskAgentSessionsForRemoval: (request) => this.drainForRemoval(request),
      finalizeRemovedTaskAgentSessionState: (request) => this.finalizeRemovedState(request),
      hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
      probe: () => this.probeRemovalHooks(),
    };
  }

  async getOwnerAvailability(taskId: string): Promise<AgentSessionOwnerAvailability> {
    return this.dependencies.getOwnerAvailability(taskId);
  }

  async drain(taskId?: string): Promise<void> {
    if (taskId !== undefined) return this.waitForTaskOperations(taskId);
    while (this.inFlightByOperation.size > 0 || this.agentQueues.size > 0) {
      await Promise.allSettled([
        ...[...this.inFlightByOperation.values()].map((operation) => operation.promise),
        ...this.agentQueues.values(),
      ]);
    }
  }

  execute(request: AgentSessionOperationRequest): Promise<AgentSessionOperationResult> {
    if (!isAgentSessionOperationRequest(request)) return Promise.resolve(unavailableResult());
    const stableRequest = structuredClone(request);
    const stableRequestFingerprint = requestFingerprint(stableRequest);
    const existing = this.inFlightByOperation.get(stableRequest.operationId);
    if (existing) {
      if (existing.requestFingerprint !== stableRequestFingerprint) {
        return Promise.reject(
          new AgentSessionOperationConflictError(
            `Operation ${stableRequest.operationId} was reused with different input`,
          ),
        );
      }
      return existing.promise;
    }

    const promise = this.runAgentExclusive(stableRequest, () => this.runOperation(stableRequest));
    this.inFlightByOperation.set(stableRequest.operationId, {
      promise,
      requestFingerprint: stableRequestFingerprint,
    });
    const taskOperations = this.inFlightByTask.get(stableRequest.taskId) ?? new Set();
    taskOperations.add(promise);
    this.inFlightByTask.set(stableRequest.taskId, taskOperations);
    const cleanup = () => {
      if (this.inFlightByOperation.get(stableRequest.operationId)?.promise === promise) {
        this.inFlightByOperation.delete(stableRequest.operationId);
      }
      const currentTaskOperations = this.inFlightByTask.get(stableRequest.taskId);
      currentTaskOperations?.delete(promise);
      if (currentTaskOperations?.size === 0) this.inFlightByTask.delete(stableRequest.taskId);
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }

  private async checkBarrier(taskId: string): Promise<AdmissionBarrier> {
    try {
      const owner = await this.dependencies.getOwnerAvailability(taskId);
      if (!isActiveOwnerAvailability(owner)) return { kind: 'unavailable' };
      const gate = await this.dependencies.getRemovalGate(taskId);
      if (
        !isActiveRemovalGate(gate) ||
        gate.cutoverEpoch !== owner.cutoverEpoch ||
        this.dependencies.journal.getHealth() !== 'healthy'
      ) {
        return { kind: 'unavailable' };
      }
      const current = reduceTaskRemovalCurrentProjection(owner.current, gate.current);
      return current.taskState === 'present' && !current.taskClosing
        ? { current, kind: 'ready' }
        : { current, kind: 'closed' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  private async runOperation(
    request: AgentSessionOperationRequest,
  ): Promise<AgentSessionOperationResult> {
    const admissionBarrier = await this.checkBarrier(request.taskId);
    if (admissionBarrier.kind !== 'ready') return unavailableResult();

    const existing = this.dependencies.journal.getOperation(request.operationId);
    if (existing?.kind === 'active') {
      if (!sameRequest(existing.record.request, request)) {
        throw new AgentSessionOperationConflictError(
          `Operation ${request.operationId} conflicts with its durable request`,
        );
      }
      return this.continueOperation(existing.record, admissionBarrier.current);
    }
    if (existing?.kind === 'terminal-response') {
      if (!sameRequest(existing.response.request, request)) {
        throw new AgentSessionOperationConflictError(
          `Operation ${request.operationId} conflicts with its durable response`,
        );
      }
      return operationResult(existing.response.snapshot, admissionBarrier.current, true);
    }

    if (request.mode === 'initial') {
      const markerReplay = this.replayInitialMarker(request, admissionBarrier.current);
      if (markerReplay) return markerReplay;
    }

    let inspection: AgentSessionAdmissionInspection | null;
    try {
      inspection = await this.dependencies.authority.inspectAdmission(request);
    } catch {
      return unavailableResult();
    }
    if (!inspection) return unavailableResult();
    const fallbackClassifier =
      inspection.kind === 'replacement' ? inspection.fallbackClassifier : undefined;
    let fingerprint: string;
    try {
      fingerprint = deriveAgentSessionOperationFingerprint({
        agentDefId: inspection.agentDefId,
        ...(fallbackClassifier ? { fallbackClassifier } : {}),
        request,
      });
    } catch {
      return unavailableResult();
    }

    const markerReplay = this.replayFallbackMarker(
      request,
      fingerprint,
      fallbackClassifier,
      admissionBarrier.current,
    );
    if (markerReplay) return markerReplay;

    if (!isValidInspection(request, inspection)) {
      return operationResult(
        this.ephemeralSnapshot(request, 'superseded', 'stale-generation'),
        admissionBarrier.current,
        false,
      );
    }
    try {
      if (!(await this.dependencies.authority.admitTransition(request))) {
        return operationResult(
          this.ephemeralSnapshot(request, 'superseded', 'lease'),
          admissionBarrier.current,
          false,
        );
      }
    } catch {
      return unavailableResult();
    }

    const preJournalBarrier = await this.checkBarrier(request.taskId);
    if (preJournalBarrier.kind !== 'ready') return unavailableResult();
    const now = this.now();
    const admitted: AgentSessionJournalOperationRecord = {
      agentDefId: inspection.agentDefId,
      createdAtMs: now,
      fingerprint,
      request,
      snapshot: {
        agentId: request.agentId,
        ...(fallbackClassifier ? { fallbackClassifier } : {}),
        launchReason: request.launchReason,
        operationId: request.operationId,
        phase: 'admitted',
        resumed: request.mode === 'resume',
        sourceGeneration: request.expectedSourceGeneration,
        targetGeneration: inspection.targetGeneration,
        taskId: request.taskId,
        version: 1,
      },
      updatedAtMs: now,
    };
    if (!(await this.saveRecord(admitted))) return unavailableResult();
    return this.continueOperation(admitted, preJournalBarrier.current);
  }

  private async continueOperation(
    initialRecord: AgentSessionJournalOperationRecord,
    initialCurrent: TaskRemovalCurrentProjection,
  ): Promise<AgentSessionOperationResult> {
    let record = initialRecord;
    let current = initialCurrent;
    if (record.snapshot.targetGeneration === undefined) return unavailableResult();

    if (record.snapshot.phase === 'admitted') {
      const allocationBarrier = await this.checkBarrier(record.request.taskId);
      if (allocationBarrier.kind === 'unavailable') return unavailableResult();
      current = allocationBarrier.current;
      if (allocationBarrier.kind === 'closed') {
        const cancelled = await this.transition(record, 'cancelled', 'task-closing');
        return cancelled
          ? operationResult(cancelled.snapshot, current, false)
          : unavailableResult();
      }
      let allocation: Awaited<ReturnType<AgentSessionWorkflowAuthority['allocateGeneration']>>;
      try {
        allocation = await this.dependencies.authority.allocateGeneration({
          agentId: record.request.agentId,
          expectedSourceGeneration: record.request.expectedSourceGeneration,
          operationId: record.request.operationId,
          targetGeneration: record.snapshot.targetGeneration,
          taskId: record.request.taskId,
        });
      } catch {
        return unavailableResult();
      }
      if (allocation === 'stale') {
        const superseded = await this.transition(record, 'superseded', 'stale-generation');
        return superseded
          ? operationResult(superseded.snapshot, current, false)
          : unavailableResult();
      }
      if (record.request.mode !== 'initial') {
        const stopping = await this.transition(record, 'stopping-previous');
        if (!stopping) {
          await this.releaseGeneration(record);
          return unavailableResult();
        }
        record = stopping;
      } else {
        const spawning = await this.transition(record, 'spawning');
        if (!spawning) {
          await this.releaseGeneration(record);
          return unavailableResult();
        }
        record = spawning;
      }
    }

    if (record.snapshot.phase === 'stopping-previous') {
      try {
        if (!(await this.dependencies.authority.stopPreviousRunner(runnerRequest(record)))) {
          await this.releaseGeneration(record);
          const failed = await this.transition(record, 'failed', 'runner-cleanup');
          return failed ? operationResult(failed.snapshot, current, false) : unavailableResult();
        }
      } catch {
        await this.releaseGeneration(record);
        const failed = await this.transition(record, 'failed', 'runner-cleanup');
        return failed ? operationResult(failed.snapshot, current, false) : unavailableResult();
      }
      const spawning = await this.transition(record, 'spawning');
      if (!spawning) {
        await this.releaseGeneration(record);
        return unavailableResult();
      }
      record = spawning;
    }

    if (record.snapshot.phase === 'spawning') {
      const spawnBarrier = await this.checkBarrier(record.request.taskId);
      if (spawnBarrier.kind === 'unavailable') {
        await this.releaseGeneration(record);
        return unavailableResult();
      }
      current = spawnBarrier.current;
      if (spawnBarrier.kind === 'closed') {
        await this.releaseGeneration(record);
        const cancelled = await this.transition(record, 'cancelled', 'task-closing');
        return cancelled
          ? operationResult(cancelled.snapshot, current, false)
          : unavailableResult();
      }
      const spawnResult = await this.spawnWithDeadline(runnerRequest(record));
      if (spawnResult !== 'running') {
        await this.releaseGeneration(record);
        const failed = await this.transition(record, 'failed', 'spawn');
        return failed ? operationResult(failed.snapshot, current, false) : unavailableResult();
      }
      const running = await this.transition(record, 'running');
      if (!running) return unavailableResult();
      const projection = { current, operation: running.snapshot };
      try {
        await this.dependencies.authority.publishOperation(projection);
      } catch {
        // Durable process truth remains authoritative; normal lifecycle sync can replay it.
      }
      return { kind: 'operation', projection, replayed: false };
    }

    return operationResult(record.snapshot, current, true);
  }

  private replayInitialMarker(
    request: AgentSessionInitialOperationRequest,
    current: TaskRemovalCurrentProjection,
  ): AgentSessionOperationResult | null {
    const marker = this.dependencies.journal.getIdentityMarker(
      request.taskId,
      request.agentId,
    )?.initialLaunch;
    if (!marker || marker.launchOperationId !== request.operationId) return null;
    const fingerprint = deriveAgentSessionOperationFingerprint({
      agentDefId: marker.agentDefId,
      request,
    });
    if (
      marker.fingerprint !== fingerprint ||
      marker.agentDefId !== request.nextAgentDefId ||
      marker.committedWorkspaceRevision !== request.admission.committedWorkspaceRevision ||
      marker.creationOperationId !== request.admission.creationOperationId
    ) {
      throw new AgentSessionOperationConflictError(
        `Initial operation ${request.operationId} conflicts with its durable marker`,
      );
    }
    return operationResult(
      {
        agentId: request.agentId,
        launchReason: 'initial',
        ...(marker.terminalPhase ? { markerTerminalPhase: marker.terminalPhase } : {}),
        operationId: request.operationId,
        phase: 'attempted-no-replay',
        replayKind: 'initial-launch-marker',
        resumed: false,
        sourceGeneration: null,
        targetGeneration: marker.targetGeneration,
        taskId: request.taskId,
        version: 1,
      },
      current,
      true,
    );
  }

  private replayFallbackMarker(
    request: AgentSessionOperationRequest,
    fingerprint: string,
    classifier: AgentResumeFailureClassifier | undefined,
    current: TaskRemovalCurrentProjection,
  ): AgentSessionOperationResult | null {
    if (
      request.mode === 'initial' ||
      request.launchReason !== 'resume-fallback' ||
      classifier === undefined
    ) {
      return null;
    }
    const marker = this.dependencies.journal.getIdentityMarker(
      request.taskId,
      request.agentId,
    )?.fallbackHighWater;
    if (!marker) return null;
    if (request.expectedSourceGeneration < marker.highestAttemptedSourceGeneration) {
      return operationResult(
        this.ephemeralSnapshot(request, 'superseded', 'stale-generation'),
        current,
        true,
      );
    }
    if (request.expectedSourceGeneration !== marker.highestAttemptedSourceGeneration) return null;
    if (marker.operationId === request.operationId && marker.fingerprint !== fingerprint) {
      throw new AgentSessionOperationConflictError(
        `Fallback operation ${request.operationId} conflicts with its durable marker`,
      );
    }
    if (marker.operationId !== request.operationId) {
      return operationResult(
        this.ephemeralSnapshot(request, 'superseded', 'stale-generation'),
        current,
        true,
      );
    }
    return operationResult(
      {
        agentId: request.agentId,
        fallbackClassifier: classifier,
        launchReason: 'resume-fallback',
        operationId: request.operationId,
        phase: 'attempted-no-replay',
        replayKind: 'fallback-high-water-marker',
        resumed: false,
        sourceGeneration: request.expectedSourceGeneration,
        taskId: request.taskId,
        version: 1,
      },
      current,
      true,
    );
  }

  private ephemeralSnapshot(
    request: AgentSessionOperationRequest,
    phase: 'superseded',
    failure: 'lease' | 'stale-generation',
  ): AgentSessionOperationSnapshot {
    return {
      agentId: request.agentId,
      failure,
      launchReason: request.launchReason,
      operationId: request.operationId,
      phase,
      resumed: request.mode === 'resume',
      sourceGeneration: request.expectedSourceGeneration,
      taskId: request.taskId,
      version: 1,
    };
  }

  private async transition(
    record: AgentSessionJournalOperationRecord,
    phase: AgentSessionOperationSnapshot['phase'],
    failure?: AgentSessionOperationSnapshot['failure'],
  ): Promise<AgentSessionJournalOperationRecord | null> {
    const snapshot = transitionAgentSessionOperation(record.snapshot, {
      ...(failure ? { failure } : {}),
      phase,
    });
    const next: AgentSessionJournalOperationRecord = {
      ...record,
      snapshot,
      updatedAtMs: Math.max(record.updatedAtMs, this.now()),
    };
    return (await this.saveRecord(next)) ? next : null;
  }

  private async releaseGeneration(record: AgentSessionJournalOperationRecord): Promise<void> {
    try {
      await this.dependencies.authority.releaseGeneration?.({
        agentId: record.request.agentId,
        expectedSourceGeneration: record.request.expectedSourceGeneration,
        operationId: record.request.operationId,
        targetGeneration: record.snapshot.targetGeneration as number,
        taskId: record.request.taskId,
      });
    } catch {
      // The operation remains terminal/unavailable; the writer owner may repair
      // a retained reservation on restart without weakening process admission.
    }
  }

  private async saveRecord(record: AgentSessionJournalOperationRecord): Promise<boolean> {
    try {
      const identityMarker = identityMarkerForRecord(record);
      await this.dependencies.journal.saveOperation(record, {
        ...(identityMarker ? { identityMarker } : {}),
      });
      return this.dependencies.journal.getHealth() === 'healthy';
    } catch {
      return false;
    }
  }

  private spawnWithDeadline(
    request: AgentSessionRunnerOperationRequest,
  ): Promise<'failed' | 'running'> {
    const timer = this.dependencies.timer ?? DEFAULT_TIMER;
    const abortController = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const timerState: { handle?: unknown } = {};
      const settle = (result: 'failed' | 'running') => {
        if (settled) return;
        settled = true;
        if (timerState.handle !== undefined) timer.clear(timerState.handle);
        resolve(result);
      };
      timerState.handle = timer.schedule(() => {
        abortController.abort();
        settle('failed');
      }, AGENT_SESSION_ACK_DEADLINE_MS);
      if (settled) {
        timer.clear(timerState.handle);
        return;
      }
      void this.dependencies.authority
        .spawnRunner(request, abortController.signal)
        .then(settle, () => settle('failed'));
    });
  }

  private probeRemovalHooks(): Promise<AgentSessionOwnerHookProbe> {
    const unavailable = (): AgentSessionOwnerHookProbe => ({
      hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
      kind: 'unavailable',
      reason: 'journal-unavailable',
    });
    const probe =
      this.probePromise ??
      this.dependencies.journal
        .startup()
        .then(
          (health): AgentSessionOwnerHookProbe =>
            health === 'healthy'
              ? { hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION, kind: 'ready' }
              : unavailable(),
        )
        .catch(unavailable);
    this.probePromise = probe;
    void probe.then((result) => {
      if (result.kind === 'unavailable' && this.probePromise === probe) {
        this.probePromise = null;
      }
    });
    return probe;
  }

  private drainForRemoval(
    request: DrainTaskAgentSessionsForRemovalRequest,
  ): Promise<DrainTaskAgentSessionsForRemovalResult> {
    if (!isIdentity(request.deletionOperationId) || !isIdentity(request.taskId)) {
      return Promise.resolve({
        kind: 'retry-required',
        retainedIdentityCount: 0,
        retainedOperationCount: 0,
      });
    }
    const key = `${request.deletionOperationId}\u0000${request.taskId}`;
    if (this.drainReceipts.has(key)) {
      return Promise.resolve({
        kind: 'already-complete',
        retainedIdentityCount: this.dependencies.journal.listTaskIdentityMarkers(request.taskId)
          .length,
        retainedOperationCount: this.dependencies.journal.getTaskRecordCount(request.taskId),
      });
    }
    const existing = this.draining.get(key);
    if (existing) return existing;
    const promise = this.runDrain(request, key).finally(() => this.draining.delete(key));
    this.draining.set(key, promise);
    return promise;
  }

  private async runDrain(
    request: DrainTaskAgentSessionsForRemovalRequest,
    receiptKey: string,
  ): Promise<DrainTaskAgentSessionsForRemovalResult> {
    await this.waitForTaskOperations(request.taskId);
    const active = this.dependencies.journal.listTaskOperations(request.taskId);
    const retainedIdentityCount = this.dependencies.journal.listTaskIdentityMarkers(
      request.taskId,
    ).length;
    const retainedOperationCount = this.dependencies.journal.getTaskRecordCount(request.taskId);
    if (this.dependencies.journal.getHealth() !== 'healthy') {
      return {
        kind: 'retry-required',
        retainedIdentityCount,
        retainedOperationCount,
      };
    }
    for (const current of active) {
      const cancelled = await this.transition(current, 'cancelled', 'task-closing');
      if (!cancelled) {
        return {
          kind: 'retry-required',
          retainedIdentityCount,
          retainedOperationCount,
        };
      }
    }
    try {
      if (!(await this.dependencies.authority.drainTaskSessionsForRemoval(request))) {
        return {
          kind: 'retry-required',
          retainedIdentityCount,
          retainedOperationCount,
        };
      }
    } catch {
      return {
        kind: 'retry-required',
        retainedIdentityCount,
        retainedOperationCount,
      };
    }
    this.drainReceipts.add(receiptKey);
    return {
      kind: 'complete',
      retainedIdentityCount,
      retainedOperationCount,
    };
  }

  private async finalizeRemovedState(
    request: FinalizeRemovedTaskAgentSessionStateRequest,
  ): Promise<FinalizeRemovedTaskAgentSessionStateResult> {
    if (
      !isIdentity(request.deletionOperationId) ||
      !isIdentity(request.taskId) ||
      this.dependencies.journal.getHealth() !== 'healthy'
    ) {
      return { kind: 'retry-required', reason: 'journal-unavailable' };
    }
    try {
      if (!(await this.dependencies.authority.verifyCommittedTaskRemoval(request))) {
        return { kind: 'retry-required', reason: 'removal-witness-mismatch' };
      }
      return { kind: await this.dependencies.journal.deleteTaskRecords(request.taskId) };
    } catch {
      return { kind: 'retry-required', reason: 'journal-unavailable' };
    }
  }

  private runAgentExclusive<TResult>(
    request: AgentSessionOperationRequest,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const key = `${request.taskId}\u0000${request.agentId}`;
    const prior = this.agentQueues.get(key) ?? Promise.resolve();
    const run = prior.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.agentQueues.set(key, tail);
    void tail.finally(() => {
      if (this.agentQueues.get(key) === tail) this.agentQueues.delete(key);
    });
    return run;
  }

  private async waitForTaskOperations(taskId: string): Promise<void> {
    while (true) {
      const operations = [...(this.inFlightByTask.get(taskId) ?? [])];
      if (operations.length === 0) return;
      await Promise.allSettled(operations);
    }
  }

  private now(): number {
    const value = this.dependencies.now?.() ?? Date.now();
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
  }
}

export function createAgentSessionWorkflow(
  dependencies: AgentSessionWorkflowDependencies,
): AgentSessionWorkflow {
  return new AgentSessionWorkflowImpl(dependencies);
}
