import type { AgentResumeFailureClassifier } from '../ipc/types.js';
import { isWellFormedUnicodeScalarString } from '../lib/unicode-scalar.js';
import {
  canDispatchToTask,
  isTaskRemovalCurrentProjection,
  reduceTaskRemovalCurrentProjection,
  type TaskRemovalCurrentProjection,
} from './task-catalog.js';

export const AGENT_SESSION_OWNER_HOOK_SET_VERSION = 'agent-session-owner-hooks-v1' as const;
export const AGENT_SESSION_ACK_DEADLINE_MS = 15_000;
export const AGENT_SESSION_OPERATION_ID_MAX_LENGTH = 1_024;
export const AGENT_SESSION_IDENTITY_FIELD_MAX_LENGTH = 512;
export const AGENT_SESSION_ACTIVE_RECORD_LIMIT = 256;
export const AGENT_SESSION_ACTIVE_RECORD_MAX_BYTES = 4 * 1_024;
export const AGENT_SESSION_RESPONSE_LIMIT = 256;
export const AGENT_SESSION_RESPONSE_MAX_BYTES = 16 * 1_024;
export const AGENT_SESSION_RESPONSE_TOTAL_MAX_BYTES = 4 * 1_024 * 1_024;
export const AGENT_SESSION_IDENTITY_LIMIT = 4_096;
export const AGENT_SESSION_IDENTITY_MAX_BYTES = 512;
export const AGENT_SESSION_IDENTITY_TOTAL_MAX_BYTES = 2 * 1_024 * 1_024;
export const AGENT_SESSION_JOURNAL_ENVELOPE_MAX_BYTES = 64 * 1_024;
export const AGENT_SESSION_JOURNAL_MAX_BYTES = 7_405_568;

export type AgentSessionLaunchReason =
  | 'backend-clean-restart'
  | 'initial'
  | 'manual-resume'
  | 'manual-restart'
  | 'agent-switch'
  | 'resume-fallback';

export interface AgentSessionInitialAdmission {
  committedWorkspaceRevision: number;
  creationOperationId: string;
  kind: 'task-creation';
}

export interface AgentSessionOperationRequestBase {
  agentId: string;
  operationId: string;
  taskId: string;
}

export type AgentSessionInitialOperationRequest = AgentSessionOperationRequestBase & {
  admission: AgentSessionInitialAdmission;
  expectedLeaseGeneration: null;
  expectedSourceGeneration: null;
  launchReason: 'initial';
  mode: 'initial';
  nextAgentDefId: string;
};

export type AgentSessionReplacementOperationRequest = AgentSessionOperationRequestBase & {
  admission: { kind: 'resume-fallback-system' } | { kind: 'task-command' };
  controllerId: string;
  expectedLeaseGeneration: number;
  expectedSourceGeneration: number;
  launchReason: Exclude<AgentSessionLaunchReason, 'backend-clean-restart' | 'initial'>;
  mode: 'fresh' | 'resume' | 'switch';
  nextAgentDefId?: string;
};

export type AgentSessionOperationRequest =
  | AgentSessionInitialOperationRequest
  | AgentSessionReplacementOperationRequest;

export type AgentSessionOperationPhase =
  | 'admitted'
  | 'stopping-previous'
  | 'spawning'
  | 'running'
  | 'failed'
  | 'cancelled'
  | 'superseded'
  | 'attempted-no-replay';

export type AgentSessionOperationFailure =
  | 'lease'
  | 'task-closing'
  | 'spawn'
  | 'runner-cleanup'
  | 'stale-generation'
  | 'session-state-unavailable';

export interface AgentSessionOperationSnapshot {
  agentId: string;
  failure?: AgentSessionOperationFailure;
  fallbackClassifier?: AgentResumeFailureClassifier;
  launchReason: AgentSessionLaunchReason;
  markerTerminalPhase?: 'cancelled' | 'failed' | 'running' | 'superseded';
  operationId: string;
  phase: AgentSessionOperationPhase;
  replayKind?: 'fallback-high-water-marker' | 'full' | 'initial-launch-marker';
  resumed: boolean;
  sourceGeneration: number | null;
  targetGeneration?: number;
  taskId: string;
  version: number;
}

export interface AgentSessionOperationProjection {
  current: TaskRemovalCurrentProjection;
  operation: AgentSessionOperationSnapshot;
}

export interface FinalizeRemovedTaskAgentSessionStateRequest {
  deletionOperationId: string;
  taskId: string;
}

export type FinalizeRemovedTaskAgentSessionStateResult =
  | { kind: 'already-complete' | 'complete' }
  | {
      kind: 'retry-required';
      reason: 'journal-unavailable' | 'removal-witness-mismatch';
    };

export interface DrainTaskAgentSessionsForRemovalRequest {
  deletionOperationId: string;
  taskId: string;
}

export interface DrainTaskAgentSessionsForRemovalResult {
  kind: 'already-complete' | 'complete' | 'retry-required';
  retainedIdentityCount: number;
  retainedOperationCount: number;
}

export type AgentSessionOwnerUnavailableReason =
  | 'journal-unavailable'
  | 'session-owner-dark'
  | 'task-removal-cutover-epoch-mismatch'
  | 'task-removal-gate-unavailable';

export type AgentSessionOwnerAvailability =
  | { kind: 'dark'; reason: 'session-owner-dark' }
  | {
      current: TaskRemovalCurrentProjection;
      cutoverEpoch: string;
      hookSetVersion: typeof AGENT_SESSION_OWNER_HOOK_SET_VERSION;
      kind: 'active';
    }
  | {
      kind: 'unavailable';
      reason: Exclude<AgentSessionOwnerUnavailableReason, 'session-owner-dark'>;
    };

export type AgentSessionOperationResult =
  | {
      kind: 'operation';
      projection: AgentSessionOperationProjection;
      replayed: boolean;
    }
  | {
      failure: 'session-state-unavailable';
      kind: 'admission-unavailable';
    };

/**
 * The only replacement request an ordinary renderer may submit. Initial
 * launches and resume-fallback admission remain backend-owned even though
 * they share the same operation workflow.
 */
export type RendererAgentSessionOperationRequest = AgentSessionReplacementOperationRequest & {
  admission: { kind: 'task-command' };
  launchReason: 'agent-switch' | 'manual-restart' | 'manual-resume';
};

export interface GetAgentSessionOperationProjectionRequest {
  agentId: string;
  taskId: string;
}

/**
 * Identity-only request for reconciling a session that was deliberately
 * stopped by the previous backend during a clean shutdown. Launch material
 * remains backend-owned and is never accepted from a transport client.
 */
export interface ManagedAgentSessionRestoreRequest {
  agentId: string;
  taskId: string;
}

export type ManagedAgentSessionRestoreResult =
  | {
      agentId: string;
      cols: number;
      generation: number;
      kind: 'existing' | 'restored';
      rows: number;
      taskId: string;
    }
  | {
      kind: 'unavailable';
      reason:
        | 'identity-unavailable'
        | 'restore-failed'
        | 'session-state-unavailable'
        | 'task-unavailable';
    };

const TERMINAL_PHASES = new Set<AgentSessionOperationPhase>([
  'attempted-no-replay',
  'cancelled',
  'failed',
  'running',
  'superseded',
]);

const OPERATION_PHASES = new Set<AgentSessionOperationPhase>([
  'admitted',
  'attempted-no-replay',
  'cancelled',
  'failed',
  'running',
  'spawning',
  'stopping-previous',
  'superseded',
]);
const LAUNCH_REASONS = new Set<AgentSessionLaunchReason>([
  'agent-switch',
  'backend-clean-restart',
  'initial',
  'manual-restart',
  'manual-resume',
  'resume-fallback',
]);

export function isAgentSessionLaunchReason(value: unknown): value is AgentSessionLaunchReason {
  return typeof value === 'string' && LAUNCH_REASONS.has(value as AgentSessionLaunchReason);
}
const OPERATION_FAILURES = new Set<AgentSessionOperationFailure>([
  'lease',
  'runner-cleanup',
  'session-state-unavailable',
  'spawn',
  'stale-generation',
  'task-closing',
]);

const ALLOWED_PHASE_TRANSITIONS: Readonly<
  Record<AgentSessionOperationPhase, ReadonlySet<AgentSessionOperationPhase>>
> = {
  admitted: new Set([
    'cancelled',
    'failed',
    'running',
    'spawning',
    'stopping-previous',
    'superseded',
  ]),
  'attempted-no-replay': new Set(),
  cancelled: new Set(),
  failed: new Set(),
  running: new Set(),
  spawning: new Set(['cancelled', 'failed', 'running', 'superseded']),
  'stopping-previous': new Set(['cancelled', 'failed', 'spawning', 'superseded']),
  superseded: new Set(),
};

function isBoundedIdentity(value: unknown, maxLength = AGENT_SESSION_IDENTITY_FIELD_MAX_LENGTH) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/\p{Cc}/u.test(value) &&
    isWellFormedUnicodeScalarString(value)
  );
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasExactJsonKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).every((key) => expected.has(key)) &&
    Object.values(value).every((entry) => entry !== undefined)
  );
}

export function isAgentSessionOperationRequest(
  value: unknown,
): value is AgentSessionOperationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const requestRecord = value as Record<string, unknown>;
  const request = requestRecord as Partial<AgentSessionOperationRequest>;
  if (
    !isBoundedIdentity(request.operationId, AGENT_SESSION_OPERATION_ID_MAX_LENGTH) ||
    !isBoundedIdentity(request.taskId) ||
    !isBoundedIdentity(request.agentId)
  ) {
    return false;
  }
  if (request.mode === 'initial') {
    const admission = request.admission as
      | (Partial<AgentSessionInitialAdmission> & Record<string, unknown>)
      | undefined;
    return (
      hasExactJsonKeys(requestRecord, [
        'admission',
        'agentId',
        'expectedLeaseGeneration',
        'expectedSourceGeneration',
        'launchReason',
        'mode',
        'nextAgentDefId',
        'operationId',
        'taskId',
      ]) &&
      request.launchReason === 'initial' &&
      request.expectedSourceGeneration === null &&
      request.expectedLeaseGeneration === null &&
      isBoundedIdentity(request.nextAgentDefId) &&
      admission?.kind === 'task-creation' &&
      hasExactJsonKeys(admission, ['committedWorkspaceRevision', 'creationOperationId', 'kind']) &&
      isBoundedIdentity(admission.creationOperationId) &&
      isGeneration(admission.committedWorkspaceRevision)
    );
  }
  if (request.mode !== 'resume' && request.mode !== 'fresh' && request.mode !== 'switch') {
    return false;
  }
  const admission = request.admission as { kind?: unknown } | undefined;
  if (
    !hasExactJsonKeys(requestRecord, [
      'admission',
      'agentId',
      'controllerId',
      'expectedLeaseGeneration',
      'expectedSourceGeneration',
      'launchReason',
      'mode',
      ...(request.mode === 'switch' ? ['nextAgentDefId'] : []),
      'operationId',
      'taskId',
    ]) ||
    !admission ||
    !hasExactJsonKeys(admission as Record<string, unknown>, ['kind']) ||
    !isBoundedIdentity(request.controllerId) ||
    !isGeneration(request.expectedSourceGeneration) ||
    !isGeneration(request.expectedLeaseGeneration) ||
    (admission?.kind !== 'task-command' && admission?.kind !== 'resume-fallback-system')
  ) {
    return false;
  }
  if (request.mode === 'resume' && request.launchReason !== 'manual-resume') return false;
  if (
    request.mode === 'fresh' &&
    request.launchReason !== 'manual-restart' &&
    request.launchReason !== 'resume-fallback'
  ) {
    return false;
  }
  if (
    request.mode === 'switch' &&
    (request.launchReason !== 'agent-switch' || !isBoundedIdentity(request.nextAgentDefId))
  ) {
    return false;
  }
  if (
    admission.kind === 'resume-fallback-system' &&
    (request.mode !== 'fresh' || request.launchReason !== 'resume-fallback')
  ) {
    return false;
  }
  return admission.kind !== 'task-command' || request.launchReason !== 'resume-fallback';
}

export function isAgentSessionOperationSnapshot(
  value: unknown,
): value is AgentSessionOperationSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshotRecord = value as Record<string, unknown>;
  const snapshot = snapshotRecord as Partial<AgentSessionOperationSnapshot>;
  return (
    hasExactJsonKeys(snapshotRecord, [
      'agentId',
      ...(snapshot.failure === undefined ? [] : ['failure']),
      ...(snapshot.fallbackClassifier === undefined ? [] : ['fallbackClassifier']),
      'launchReason',
      ...(snapshot.markerTerminalPhase === undefined ? [] : ['markerTerminalPhase']),
      'operationId',
      'phase',
      ...(snapshot.replayKind === undefined ? [] : ['replayKind']),
      'resumed',
      'sourceGeneration',
      ...(snapshot.targetGeneration === undefined ? [] : ['targetGeneration']),
      'taskId',
      'version',
    ]) &&
    isBoundedIdentity(snapshot.operationId, AGENT_SESSION_OPERATION_ID_MAX_LENGTH) &&
    isBoundedIdentity(snapshot.taskId) &&
    isBoundedIdentity(snapshot.agentId) &&
    isGeneration(snapshot.version) &&
    snapshot.version > 0 &&
    typeof snapshot.phase === 'string' &&
    OPERATION_PHASES.has(snapshot.phase as AgentSessionOperationPhase) &&
    typeof snapshot.launchReason === 'string' &&
    isAgentSessionLaunchReason(snapshot.launchReason) &&
    typeof snapshot.resumed === 'boolean' &&
    (snapshot.sourceGeneration === null || isGeneration(snapshot.sourceGeneration)) &&
    (snapshot.targetGeneration === undefined || isGeneration(snapshot.targetGeneration)) &&
    (snapshot.failure === undefined ||
      (typeof snapshot.failure === 'string' &&
        OPERATION_FAILURES.has(snapshot.failure as AgentSessionOperationFailure))) &&
    (snapshot.fallbackClassifier === undefined ||
      snapshot.fallbackClassifier === 'claude-no-conversation-v1') &&
    (snapshot.replayKind === undefined ||
      snapshot.replayKind === 'full' ||
      snapshot.replayKind === 'initial-launch-marker' ||
      snapshot.replayKind === 'fallback-high-water-marker') &&
    (snapshot.markerTerminalPhase === undefined ||
      snapshot.markerTerminalPhase === 'running' ||
      snapshot.markerTerminalPhase === 'failed' ||
      snapshot.markerTerminalPhase === 'cancelled' ||
      snapshot.markerTerminalPhase === 'superseded')
  );
}

export function isRendererAgentSessionOperationRequest(
  value: unknown,
): value is RendererAgentSessionOperationRequest {
  return (
    isAgentSessionOperationRequest(value) &&
    value.mode !== 'initial' &&
    value.admission.kind === 'task-command' &&
    value.launchReason !== 'resume-fallback'
  );
}

export function isGetAgentSessionOperationProjectionRequest(
  value: unknown,
): value is GetAgentSessionOperationProjectionRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    hasExactJsonKeys(value as Record<string, unknown>, ['agentId', 'taskId']) &&
    isBoundedIdentity((value as Partial<GetAgentSessionOperationProjectionRequest>).agentId) &&
    isBoundedIdentity((value as Partial<GetAgentSessionOperationProjectionRequest>).taskId)
  );
}

export function isManagedAgentSessionRestoreRequest(
  value: unknown,
): value is ManagedAgentSessionRestoreRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    hasExactJsonKeys(value as Record<string, unknown>, ['agentId', 'taskId']) &&
    isBoundedIdentity((value as Partial<ManagedAgentSessionRestoreRequest>).agentId) &&
    isBoundedIdentity((value as Partial<ManagedAgentSessionRestoreRequest>).taskId)
  );
}

export function isAgentSessionOperationProjection(
  value: unknown,
): value is AgentSessionOperationProjection {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    hasExactJsonKeys(value as Record<string, unknown>, ['current', 'operation']) &&
    isTaskRemovalCurrentProjection((value as Partial<AgentSessionOperationProjection>).current) &&
    isAgentSessionOperationSnapshot((value as Partial<AgentSessionOperationProjection>).operation)
  );
}

export function isAgentSessionOperationResult(
  value: unknown,
): value is AgentSessionOperationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.kind === 'admission-unavailable') {
    return (
      hasExactJsonKeys(result, ['failure', 'kind']) &&
      result.failure === 'session-state-unavailable'
    );
  }
  return (
    result.kind === 'operation' &&
    hasExactJsonKeys(result, ['kind', 'projection', 'replayed']) &&
    isAgentSessionOperationProjection(result.projection) &&
    typeof result.replayed === 'boolean'
  );
}

export function operationRequestResumesSession(request: AgentSessionOperationRequest): boolean {
  return request.mode === 'resume';
}

export function deriveResumeFallbackOperationId(
  taskId: string,
  agentId: string,
  sourceGeneration: number,
): string {
  if (
    !isBoundedIdentity(taskId) ||
    !isBoundedIdentity(agentId) ||
    !isGeneration(sourceGeneration)
  ) {
    throw new Error('Invalid resume fallback operation identity');
  }
  const operationId = `resume-fallback:v1:${encodeURIComponent(taskId)}:${encodeURIComponent(agentId)}:${sourceGeneration}`;
  if (!isBoundedIdentity(operationId, AGENT_SESSION_OPERATION_ID_MAX_LENGTH)) {
    throw new Error('Resume fallback operation identity exceeds the encoded length limit');
  }
  return operationId;
}

export function isAgentSessionOperationTerminalPhase(phase: AgentSessionOperationPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function canTransitionAgentSessionOperationPhase(
  current: AgentSessionOperationPhase,
  next: AgentSessionOperationPhase,
): boolean {
  return current === next || ALLOWED_PHASE_TRANSITIONS[current].has(next);
}

export function transitionAgentSessionOperation(
  snapshot: AgentSessionOperationSnapshot,
  next: {
    failure?: AgentSessionOperationFailure;
    phase: AgentSessionOperationPhase;
    targetGeneration?: number;
  },
): AgentSessionOperationSnapshot {
  if (next.phase === snapshot.phase) return snapshot;
  if (!canTransitionAgentSessionOperationPhase(snapshot.phase, next.phase)) {
    throw new Error(`Invalid agent-session transition ${snapshot.phase} -> ${next.phase}`);
  }
  if (next.targetGeneration !== undefined && !isGeneration(next.targetGeneration)) {
    throw new Error('Invalid target agent-session generation');
  }
  return {
    ...snapshot,
    ...(next.failure !== undefined ? { failure: next.failure } : {}),
    ...(next.targetGeneration !== undefined ? { targetGeneration: next.targetGeneration } : {}),
    phase: next.phase,
    version: snapshot.version + 1,
  };
}

export function reduceAgentSessionOperationProjection(
  current: AgentSessionOperationProjection | null,
  incoming: AgentSessionOperationProjection,
): AgentSessionOperationProjection {
  const currentTask = reduceTaskRemovalCurrentProjection(
    current?.current ?? null,
    incoming.current,
  );
  const operation =
    current?.operation.operationId === incoming.operation.operationId &&
    current.operation.version > incoming.operation.version
      ? current.operation
      : incoming.operation;
  return { current: currentTask, operation };
}

export function canRunAgentSessionAction(projection: AgentSessionOperationProjection): boolean {
  return (
    canDispatchToTask(projection.current) &&
    isAgentSessionOperationTerminalPhase(projection.operation.phase)
  );
}
