import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  AGENT_SESSION_ACTIVE_RECORD_LIMIT,
  AGENT_SESSION_ACTIVE_RECORD_MAX_BYTES,
  AGENT_SESSION_IDENTITY_LIMIT,
  AGENT_SESSION_IDENTITY_MAX_BYTES,
  AGENT_SESSION_IDENTITY_TOTAL_MAX_BYTES,
  AGENT_SESSION_JOURNAL_ENVELOPE_MAX_BYTES,
  AGENT_SESSION_JOURNAL_MAX_BYTES,
  AGENT_SESSION_OPERATION_ID_MAX_LENGTH,
  AGENT_SESSION_RESPONSE_LIMIT,
  AGENT_SESSION_RESPONSE_MAX_BYTES,
  AGENT_SESSION_RESPONSE_TOTAL_MAX_BYTES,
  canTransitionAgentSessionOperationPhase,
  deriveResumeFallbackOperationId,
  isAgentSessionOperationRequest,
  isAgentSessionOperationSnapshot,
  isAgentSessionOperationTerminalPhase,
  type AgentSessionOperationRequest,
  type AgentSessionOperationSnapshot,
} from '../../src/domain/agent-session-operation.js';
import type { AgentResumeFailureClassifier } from '../../src/ipc/types.js';
import { isRecord } from '../../src/lib/type-guards.js';
import {
  canonicalJsonStringify,
  incrementCanonicalUint64,
  parseCanonicalUint64,
  type CanonicalUint64,
  type JsonObject,
  type JsonValue,
} from './workspace-state-storage.js';
import { getStateDirForEnv, type StorageEnv } from './storage-environment.js';

export const AGENT_SESSION_JOURNAL_FORMAT_VERSION = 1;
export const AGENT_SESSION_JOURNAL_FILE_NAME = 'agent-session-operations.json';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTITY_KEY_SEPARATOR = '\u0000';

export type AgentSessionJournalHealth =
  | 'healthy'
  | 'durability-repair-required'
  | 'recovery-required'
  | 'uninitialized'
  | 'closed';

export interface AgentSessionJournalOperationRecord {
  agentDefId: string;
  createdAtMs: number;
  fingerprint: string;
  request: AgentSessionOperationRequest;
  snapshot: AgentSessionOperationSnapshot;
  updatedAtMs: number;
}

export interface AgentSessionInitialLaunchMarker {
  agentDefId: string;
  agentId: string;
  committedWorkspaceRevision: number;
  creationOperationId: string;
  fingerprint: string;
  lastKnownPhase: AgentSessionOperationSnapshot['phase'];
  launchOperationId: string;
  targetGeneration: number;
  taskId: string;
  terminalPhase?: 'cancelled' | 'failed' | 'running' | 'superseded';
}

export interface AgentSessionFallbackHighWaterMarker {
  classifier: AgentResumeFailureClassifier;
  fingerprint: string;
  highestAttemptedSourceGeneration: number;
  lastKnownPhase: AgentSessionOperationSnapshot['phase'];
  operationId: string;
}

export type AgentSessionCleanRestartPhase = 'available' | 'restored' | 'restoring';

/**
 * Compact, non-executable evidence that the previous backend proved this
 * exact managed session absent after a clean stop. The restore operation ID
 * is derived from the immutable identity and generations rather than stored.
 */
export interface AgentSessionCleanRestartMarker {
  agentDefId: string;
  cols: number;
  generationHighWater: number;
  phase: AgentSessionCleanRestartPhase;
  rows: number;
  sourceGeneration: number;
  targetGeneration: number;
}

export interface AgentSessionIdentityMarker {
  agentId: string;
  cleanRestart?: AgentSessionCleanRestartMarker;
  fallbackHighWater?: AgentSessionFallbackHighWaterMarker;
  initialLaunch?: AgentSessionInitialLaunchMarker;
  taskId: string;
}

type PersistedCleanRestartMarker =
  | readonly [cols: number, phase: 0 | 1 | 2, rows: number, sourceGeneration: number]
  | readonly [
      agentDefId: string,
      cols: number,
      phase: 0 | 1 | 2,
      rows: number,
      sourceGeneration: number,
    ];

type PersistedOperationPhase = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type PersistedInitialLaunchMarker =
  | readonly [
      agentDefId: string,
      committedWorkspaceRevision: number,
      fingerprint: string,
      lastKnownPhase: PersistedOperationPhase,
      targetGeneration: number,
    ]
  | readonly [
      agentDefId: string,
      committedWorkspaceRevision: number,
      fingerprint: string,
      lastKnownPhase: PersistedOperationPhase,
      targetGeneration: number,
      creationOperationId: string,
      launchOperationId: string,
    ];

type PersistedFallbackHighWaterMarker =
  | readonly [
      fingerprint: string,
      highestAttemptedSourceGeneration: number,
      lastKnownPhase: PersistedOperationPhase,
    ]
  | readonly [
      fingerprint: string,
      highestAttemptedSourceGeneration: number,
      lastKnownPhase: PersistedOperationPhase,
      operationId: string,
    ];

export interface AgentSessionTerminalResponseRecord {
  agentDefId: string;
  fingerprint: string;
  request: AgentSessionOperationRequest;
  snapshot: AgentSessionOperationSnapshot;
  terminalAtMs: number;
}

export interface AgentSessionJournalDocument {
  activeOperations: AgentSessionJournalOperationRecord[];
  formatVersion: typeof AGENT_SESSION_JOURNAL_FORMAT_VERSION;
  identityMarkers: AgentSessionIdentityMarker[];
  payloadDigest: string;
  storageGeneration: CanonicalUint64;
  terminalResponses: AgentSessionTerminalResponseRecord[];
}

export interface SaveAgentSessionOperationOptions {
  identityMarker?: AgentSessionIdentityMarker;
}

export interface AgentSessionJournalCounts {
  activeOperations: number;
  identityMarkers: number;
  terminalResponses: number;
}

export type AgentSessionJournalOperationLookup =
  | { kind: 'active'; record: AgentSessionJournalOperationRecord }
  | { kind: 'terminal-response'; response: AgentSessionTerminalResponseRecord };

export interface AgentSessionOperationJournal {
  close(): Promise<void>;
  deleteTaskRecords(taskId: string): Promise<'already-complete' | 'complete'>;
  getCounts(): AgentSessionJournalCounts;
  getHealth(): AgentSessionJournalHealth;
  getIdentityMarker(taskId: string, agentId: string): AgentSessionIdentityMarker | null;
  getLatestTaskAgentOperation?(
    taskId: string,
    agentId: string,
  ): AgentSessionJournalOperationLookup | null;
  getOperation(operationId: string): AgentSessionJournalOperationLookup | null;
  getTaskRecordCount(taskId: string): number;
  listTaskIdentityMarkers(taskId: string): AgentSessionIdentityMarker[];
  listTaskOperations(taskId: string): AgentSessionJournalOperationRecord[];
  repairDurability(): Promise<boolean>;
  saveIdentityMarkers(markers: readonly AgentSessionIdentityMarker[]): Promise<void>;
  saveOperation(
    record: AgentSessionJournalOperationRecord,
    options?: SaveAgentSessionOperationOptions,
  ): Promise<void>;
  startup(): Promise<AgentSessionJournalHealth>;
}

export type AgentSessionJournalFaultPoint =
  | 'after-backup-fsync'
  | 'after-directory-fsync'
  | 'after-rename'
  | 'after-temporary-fsync'
  | 'after-temporary-write';

export interface FileAgentSessionOperationJournalOptions {
  backupLink?: (existingPath: string, newPath: string) => Promise<void>;
  faultInjector?: (point: AgentSessionJournalFaultPoint) => Promise<void> | void;
  fileName?: string;
}

function identityKey(taskId: string, agentId: string): string {
  return `${taskId}${IDENTITY_KEY_SEPARATOR}${agentId}`;
}

function cloneDocument(document: AgentSessionJournalDocument): AgentSessionJournalDocument {
  return structuredClone(document);
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJsonStringify(value as JsonValue), 'utf8');
}

function canonicalDocumentContents(document: AgentSessionJournalDocument): string {
  return canonicalJsonStringify({
    ...document,
    identityMarkers: document.identityMarkers.map(encodeIdentityMarkerForStorage),
  } as unknown as JsonObject);
}

function calculatePayloadDigest(
  document: Omit<AgentSessionJournalDocument, 'payloadDigest'>,
): string {
  return createHash('sha256')
    .update(canonicalJsonStringify(document as unknown as JsonObject))
    .digest('hex');
}

function withPayloadDigest(
  document: Omit<AgentSessionJournalDocument, 'payloadDigest'>,
): AgentSessionJournalDocument {
  return { ...document, payloadDigest: calculatePayloadDigest(document) };
}

function emptyDocument(): AgentSessionJournalDocument {
  return withPayloadDigest({
    activeOperations: [],
    formatVersion: AGENT_SESSION_JOURNAL_FORMAT_VERSION,
    identityMarkers: [],
    storageGeneration: '0' as CanonicalUint64,
    terminalResponses: [],
  });
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !value.includes('\u0000')
  );
}

function isOperationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= AGENT_SESSION_OPERATION_ID_MAX_LENGTH &&
    !value.includes('\u0000')
  );
}

function isTerminalDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 10_000;
}

export function deriveAgentSessionCleanRestartOperationId(args: {
  agentDefId: string;
  agentId: string;
  sourceGeneration: number;
  targetGeneration: number;
  taskId: string;
}): string {
  if (
    !isIdentity(args.agentDefId) ||
    !isIdentity(args.agentId) ||
    !isIdentity(args.taskId) ||
    !isNonNegativeInteger(args.sourceGeneration) ||
    !isNonNegativeInteger(args.targetGeneration) ||
    args.targetGeneration !== args.sourceGeneration + 1
  ) {
    throw new Error('Invalid clean-restart operation identity');
  }
  const digest = createHash('sha256')
    .update(
      canonicalJsonStringify({
        agentDefId: args.agentDefId,
        agentId: args.agentId,
        sourceGeneration: args.sourceGeneration,
        targetGeneration: args.targetGeneration,
        taskId: args.taskId,
      }),
    )
    .digest('hex');
  return `clean-restart:v1:${digest}`;
}

export function deriveLegacyAgentInitialRestoreIdentity(
  taskId: string,
  agentId: string,
  agentDefId: string,
): { creationOperationId: string; launchOperationId: string } {
  const digest = createHash('sha256')
    .update(canonicalJsonStringify({ agentDefId, agentId, taskId }), 'utf8')
    .digest('hex');
  return {
    creationOperationId: `legacy-agent-task:v1:${digest}`,
    launchOperationId: `legacy-agent-initial:v1:${digest}`,
  };
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPersistedOperationSnapshot(value: unknown): value is AgentSessionOperationSnapshot {
  return (
    isAgentSessionOperationSnapshot(value) &&
    value.phase !== 'attempted-no-replay' &&
    value.replayKind === undefined &&
    value.markerTerminalPhase === undefined
  );
}

function isOperationRecord(value: unknown): value is AgentSessionJournalOperationRecord {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      'agentDefId',
      'createdAtMs',
      'fingerprint',
      'request',
      'snapshot',
      'updatedAtMs',
    ]) ||
    !isIdentity(value.agentDefId) ||
    !isNonNegativeInteger(value.createdAtMs) ||
    !isNonNegativeInteger(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs ||
    !isFingerprint(value.fingerprint) ||
    !isAgentSessionOperationRequest(value.request) ||
    !isPersistedOperationSnapshot(value.snapshot)
  ) {
    return false;
  }
  return (
    value.request.operationId === value.snapshot.operationId &&
    value.request.taskId === value.snapshot.taskId &&
    value.request.agentId === value.snapshot.agentId &&
    value.request.expectedSourceGeneration === value.snapshot.sourceGeneration &&
    value.request.launchReason === value.snapshot.launchReason &&
    (value.request.mode === 'resume') === value.snapshot.resumed &&
    (value.request.launchReason === 'resume-fallback') ===
      (value.snapshot.fallbackClassifier !== undefined)
  );
}

function isTerminalResponse(value: unknown): value is AgentSessionTerminalResponseRecord {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['agentDefId', 'fingerprint', 'request', 'snapshot', 'terminalAtMs']) ||
    !isIdentity(value.agentDefId) ||
    !isFingerprint(value.fingerprint) ||
    !isAgentSessionOperationRequest(value.request) ||
    !isPersistedOperationSnapshot(value.snapshot) ||
    !isAgentSessionOperationTerminalPhase(value.snapshot.phase) ||
    !isNonNegativeInteger(value.terminalAtMs)
  ) {
    return false;
  }
  return isOperationRecord({
    agentDefId: value.agentDefId,
    createdAtMs: value.terminalAtMs,
    fingerprint: value.fingerprint,
    request: value.request,
    snapshot: value.snapshot,
    updatedAtMs: value.terminalAtMs,
  });
}

function isInitialLaunchMarker(value: unknown): value is AgentSessionInitialLaunchMarker {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      'agentDefId',
      'agentId',
      'committedWorkspaceRevision',
      'creationOperationId',
      'fingerprint',
      'lastKnownPhase',
      'launchOperationId',
      'targetGeneration',
      'taskId',
      'terminalPhase',
    ]) &&
    isIdentity(value.agentDefId) &&
    isIdentity(value.agentId) &&
    isNonNegativeInteger(value.committedWorkspaceRevision) &&
    isIdentity(value.creationOperationId) &&
    isFingerprint(value.fingerprint) &&
    isAgentSessionOperationSnapshot({
      agentId: value.agentId,
      launchReason: 'initial',
      operationId: value.launchOperationId,
      phase: value.lastKnownPhase,
      resumed: false,
      sourceGeneration: null,
      taskId: value.taskId,
      version: 1,
    }) &&
    isOperationId(value.launchOperationId) &&
    isNonNegativeInteger(value.targetGeneration) &&
    isIdentity(value.taskId) &&
    value.lastKnownPhase !== 'attempted-no-replay' &&
    (value.terminalPhase === undefined
      ? value.lastKnownPhase !== 'cancelled' &&
        value.lastKnownPhase !== 'failed' &&
        value.lastKnownPhase !== 'running' &&
        value.lastKnownPhase !== 'superseded'
      : value.terminalPhase === value.lastKnownPhase)
  );
}

function isFallbackHighWater(value: unknown): value is AgentSessionFallbackHighWaterMarker {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'classifier',
      'fingerprint',
      'highestAttemptedSourceGeneration',
      'lastKnownPhase',
      'operationId',
    ]) &&
    value.classifier === 'claude-no-conversation-v1' &&
    isFingerprint(value.fingerprint) &&
    isNonNegativeInteger(value.highestAttemptedSourceGeneration) &&
    isOperationId(value.operationId) &&
    value.lastKnownPhase !== 'attempted-no-replay' &&
    isAgentSessionOperationSnapshot({
      agentId: 'marker-agent',
      fallbackClassifier: value.classifier,
      launchReason: 'resume-fallback',
      operationId: value.operationId,
      phase: value.lastKnownPhase,
      resumed: false,
      sourceGeneration: value.highestAttemptedSourceGeneration,
      taskId: 'marker-task',
      version: 1,
    })
  );
}

function isCleanRestartMarker(value: unknown): value is AgentSessionCleanRestartMarker {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'agentDefId',
      'cols',
      'generationHighWater',
      'phase',
      'rows',
      'sourceGeneration',
      'targetGeneration',
    ]) ||
    !isIdentity(value.agentDefId) ||
    !isTerminalDimension(value.cols) ||
    !isNonNegativeInteger(value.generationHighWater) ||
    (value.phase !== 'available' && value.phase !== 'restored' && value.phase !== 'restoring') ||
    !isTerminalDimension(value.rows) ||
    !isNonNegativeInteger(value.sourceGeneration) ||
    !isNonNegativeInteger(value.targetGeneration) ||
    value.targetGeneration !== value.sourceGeneration + 1
  ) {
    return false;
  }
  return (
    value.generationHighWater ===
    (value.phase === 'restored' ? value.targetGeneration : value.sourceGeneration)
  );
}

function encodeCleanRestartPhase(phase: AgentSessionCleanRestartPhase): 0 | 1 | 2 {
  switch (phase) {
    case 'available':
      return 0;
    case 'restoring':
      return 1;
    case 'restored':
      return 2;
  }
}

function decodeCleanRestartPhase(value: unknown): AgentSessionCleanRestartPhase | null {
  switch (value) {
    case 0:
      return 'available';
    case 1:
      return 'restoring';
    case 2:
      return 'restored';
    default:
      return null;
  }
}

function encodeOperationPhase(
  phase: AgentSessionOperationSnapshot['phase'],
): PersistedOperationPhase {
  switch (phase) {
    case 'admitted':
      return 0;
    case 'stopping-previous':
      return 1;
    case 'spawning':
      return 2;
    case 'running':
      return 3;
    case 'failed':
      return 4;
    case 'cancelled':
      return 5;
    case 'superseded':
      return 6;
    case 'attempted-no-replay':
      throw new Error('Attempt-only phase cannot be persisted in an identity marker');
  }
}

function decodeOperationPhase(
  value: unknown,
): Exclude<AgentSessionOperationSnapshot['phase'], 'attempted-no-replay'> | null {
  switch (value) {
    case 0:
      return 'admitted';
    case 1:
      return 'stopping-previous';
    case 2:
      return 'spawning';
    case 3:
      return 'running';
    case 4:
      return 'failed';
    case 5:
      return 'cancelled';
    case 6:
      return 'superseded';
    default:
      return null;
  }
}

function encodeInitialLaunchForStorage(
  marker: AgentSessionIdentityMarker,
): PersistedInitialLaunchMarker | undefined {
  const initial = marker.initialLaunch;
  if (!initial) return undefined;
  const common = [
    initial.agentDefId,
    initial.committedWorkspaceRevision,
    initial.fingerprint,
    encodeOperationPhase(initial.lastKnownPhase),
    initial.targetGeneration,
  ] as const;
  const legacyIdentity = deriveLegacyAgentInitialRestoreIdentity(
    marker.taskId,
    marker.agentId,
    initial.agentDefId,
  );
  if (
    initial.creationOperationId === legacyIdentity.creationOperationId &&
    initial.launchOperationId === legacyIdentity.launchOperationId
  ) {
    return common;
  }
  return [...common, initial.creationOperationId, initial.launchOperationId];
}

function decodeInitialLaunchFromStorage(
  value: unknown,
  taskId: unknown,
  agentId: unknown,
): AgentSessionInitialLaunchMarker | null {
  if (!Array.isArray(value) || (value.length !== 5 && value.length !== 7)) return null;
  const [agentDefId, committedWorkspaceRevision, fingerprint, phaseCode, targetGeneration] = value;
  const lastKnownPhase = decodeOperationPhase(phaseCode);
  if (
    lastKnownPhase === null ||
    typeof agentDefId !== 'string' ||
    typeof taskId !== 'string' ||
    typeof agentId !== 'string'
  ) {
    return null;
  }
  const derivedIdentity = deriveLegacyAgentInitialRestoreIdentity(taskId, agentId, agentDefId);
  const creationOperationId = value.length === 5 ? derivedIdentity.creationOperationId : value[5];
  const launchOperationId = value.length === 5 ? derivedIdentity.launchOperationId : value[6];
  const terminalPhase =
    lastKnownPhase === 'cancelled' ||
    lastKnownPhase === 'failed' ||
    lastKnownPhase === 'running' ||
    lastKnownPhase === 'superseded'
      ? lastKnownPhase
      : undefined;
  return {
    agentDefId,
    agentId,
    committedWorkspaceRevision,
    creationOperationId,
    fingerprint,
    lastKnownPhase,
    launchOperationId,
    targetGeneration,
    taskId,
    ...(terminalPhase ? { terminalPhase } : {}),
  } as AgentSessionInitialLaunchMarker;
}

function deriveExpectedFallbackOperationId(
  taskId: string,
  agentId: string,
  sourceGeneration: number,
): string | null {
  try {
    return deriveResumeFallbackOperationId(taskId, agentId, sourceGeneration);
  } catch {
    return null;
  }
}

function encodeFallbackHighWaterForStorage(
  marker: AgentSessionIdentityMarker,
): PersistedFallbackHighWaterMarker | undefined {
  const fallback = marker.fallbackHighWater;
  if (!fallback) return undefined;
  const common = [
    fallback.fingerprint,
    fallback.highestAttemptedSourceGeneration,
    encodeOperationPhase(fallback.lastKnownPhase),
  ] as const;
  if (
    fallback.operationId ===
    deriveExpectedFallbackOperationId(
      marker.taskId,
      marker.agentId,
      fallback.highestAttemptedSourceGeneration,
    )
  ) {
    return common;
  }
  return [...common, fallback.operationId];
}

function decodeFallbackHighWaterFromStorage(
  value: unknown,
  taskId: unknown,
  agentId: unknown,
): AgentSessionFallbackHighWaterMarker | null {
  if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4)) return null;
  const [fingerprint, highestAttemptedSourceGeneration, phaseCode] = value;
  const lastKnownPhase = decodeOperationPhase(phaseCode);
  if (
    lastKnownPhase === null ||
    typeof taskId !== 'string' ||
    typeof agentId !== 'string' ||
    !isNonNegativeInteger(highestAttemptedSourceGeneration)
  ) {
    return null;
  }
  const operationId =
    value.length === 3
      ? deriveExpectedFallbackOperationId(taskId, agentId, highestAttemptedSourceGeneration)
      : value[3];
  if (operationId === null) return null;
  return {
    classifier: 'claude-no-conversation-v1',
    fingerprint,
    highestAttemptedSourceGeneration,
    lastKnownPhase,
    operationId,
  } as AgentSessionFallbackHighWaterMarker;
}

/**
 * Identity evidence is stored as compact, partly derivable tuples at the
 * journal boundary. The logical marker stays descriptive for workflow code,
 * while the persisted form preserves the original 4,096 x 512-byte capacity.
 */
function encodeIdentityMarkerForStorage(marker: AgentSessionIdentityMarker): JsonObject {
  const initial = encodeInitialLaunchForStorage(marker);
  const fallback = encodeFallbackHighWaterForStorage(marker);
  const cleanRestart = marker.cleanRestart;
  const restart: PersistedCleanRestartMarker | undefined = cleanRestart
    ? initial?.[0] === cleanRestart.agentDefId
      ? [
          cleanRestart.cols,
          encodeCleanRestartPhase(cleanRestart.phase),
          cleanRestart.rows,
          cleanRestart.sourceGeneration,
        ]
      : [
          cleanRestart.agentDefId,
          cleanRestart.cols,
          encodeCleanRestartPhase(cleanRestart.phase),
          cleanRestart.rows,
          cleanRestart.sourceGeneration,
        ]
    : undefined;
  return {
    a: marker.agentId,
    ...(fallback ? { f: fallback } : {}),
    ...(initial ? { i: initial } : {}),
    ...(restart ? { r: restart } : {}),
    t: marker.taskId,
  } as unknown as JsonObject;
}

function decodeIdentityMarkerFromStorage(value: unknown): unknown {
  if (
    isRecord(value) &&
    (Object.prototype.hasOwnProperty.call(value, 'a') ||
      Object.prototype.hasOwnProperty.call(value, 't') ||
      Object.prototype.hasOwnProperty.call(value, 'i') ||
      Object.prototype.hasOwnProperty.call(value, 'f'))
  ) {
    if (
      !hasOnlyKeys(value, ['a', 'f', 'i', 'r', 't']) ||
      !Object.prototype.hasOwnProperty.call(value, 'a') ||
      !Object.prototype.hasOwnProperty.call(value, 't')
    ) {
      return null;
    }
    const initial =
      value.i === undefined ? undefined : decodeInitialLaunchFromStorage(value.i, value.t, value.a);
    const fallback =
      value.f === undefined
        ? undefined
        : decodeFallbackHighWaterFromStorage(value.f, value.t, value.a);
    if (initial === null || fallback === null) return null;

    let cleanRestart: AgentSessionCleanRestartMarker | undefined;
    if (value.r !== undefined) {
      if (!Array.isArray(value.r) || (value.r.length !== 4 && value.r.length !== 5)) return null;
      const hasAgentDefId = value.r.length === 5;
      const agentDefId = hasAgentDefId ? value.r[0] : initial?.agentDefId;
      const offset = hasAgentDefId ? 1 : 0;
      const cols = value.r[offset];
      const phase = decodeCleanRestartPhase(value.r[offset + 1]);
      const rows = value.r[offset + 2];
      const sourceGeneration = value.r[offset + 3];
      if (agentDefId === undefined || phase === null || !isNonNegativeInteger(sourceGeneration)) {
        return null;
      }
      const targetGeneration = sourceGeneration + 1;
      if (!Number.isSafeInteger(targetGeneration)) return null;
      cleanRestart = {
        agentDefId,
        cols,
        generationHighWater: phase === 'restored' ? targetGeneration : sourceGeneration,
        phase,
        rows,
        sourceGeneration,
        targetGeneration,
      } as AgentSessionCleanRestartMarker;
    }
    return {
      agentId: value.a,
      ...(cleanRestart ? { cleanRestart } : {}),
      ...(fallback ? { fallbackHighWater: fallback } : {}),
      ...(initial ? { initialLaunch: initial } : {}),
      taskId: value.t,
    };
  }
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'r')) return value;
  if (
    Object.prototype.hasOwnProperty.call(value, 'cleanRestart') ||
    !hasOnlyKeys(value, ['agentId', 'fallbackHighWater', 'initialLaunch', 'r', 'taskId']) ||
    !Array.isArray(value.r) ||
    value.r.length !== 5
  ) {
    return null;
  }
  const [agentDefId, cols, phaseCode, rows, sourceGeneration] = value.r;
  const phase = decodeCleanRestartPhase(phaseCode);
  if (phase === null || !isNonNegativeInteger(sourceGeneration)) return null;
  const targetGeneration = sourceGeneration + 1;
  if (!Number.isSafeInteger(targetGeneration)) return null;
  const { r: _restart, ...rest } = value;
  return {
    ...rest,
    cleanRestart: {
      agentDefId,
      cols,
      generationHighWater: phase === 'restored' ? targetGeneration : sourceGeneration,
      phase,
      rows,
      sourceGeneration,
      targetGeneration,
    },
  };
}

function identityMarkerStorageByteLength(marker: AgentSessionIdentityMarker): number {
  return jsonByteLength(encodeIdentityMarkerForStorage(marker));
}

export function measureAgentSessionIdentityMarkerStorageBytes(
  marker: AgentSessionIdentityMarker,
): number {
  return identityMarkerStorageByteLength(marker) + 1;
}

function isIdentityMarker(value: unknown): value is AgentSessionIdentityMarker {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      'agentId',
      'cleanRestart',
      'fallbackHighWater',
      'initialLaunch',
      'taskId',
    ]) ||
    !isIdentity(value.agentId) ||
    !isIdentity(value.taskId) ||
    (value.initialLaunch === undefined &&
      value.fallbackHighWater === undefined &&
      value.cleanRestart === undefined) ||
    (value.cleanRestart !== undefined && !isCleanRestartMarker(value.cleanRestart)) ||
    (value.initialLaunch !== undefined && !isInitialLaunchMarker(value.initialLaunch)) ||
    (value.fallbackHighWater !== undefined && !isFallbackHighWater(value.fallbackHighWater))
  ) {
    return false;
  }
  return (
    value.initialLaunch === undefined ||
    (value.initialLaunch.taskId === value.taskId && value.initialLaunch.agentId === value.agentId)
  );
}

function assertUnique<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  const keys = new Set<string>();
  for (const value of values) {
    const currentKey = key(value);
    if (keys.has(currentKey)) throw new Error(`Duplicate ${label} ${currentKey}`);
    keys.add(currentKey);
  }
}

function segmentByteLength(values: readonly unknown[]): number {
  return values.reduce<number>((total, value) => total + jsonByteLength(value) + 1, 0);
}

function assertDocumentLimits(
  document: AgentSessionJournalDocument,
  encoding?: {
    documentBytes: number;
    identityMarkerPayloadBytes: readonly number[];
  },
): void {
  if (document.activeOperations.length > AGENT_SESSION_ACTIVE_RECORD_LIMIT) {
    throw new Error('Agent-session active operation count exceeds limit');
  }
  const activeOperationBytes = document.activeOperations.map((record) => jsonByteLength(record));
  for (const bytes of activeOperationBytes) {
    if (bytes + 1 > AGENT_SESSION_ACTIVE_RECORD_MAX_BYTES) {
      throw new Error('Agent-session active operation exceeds byte limit');
    }
  }
  if (document.terminalResponses.length > AGENT_SESSION_RESPONSE_LIMIT) {
    throw new Error('Agent-session terminal response count exceeds limit');
  }
  const terminalResponseBytes = document.terminalResponses.map((response) =>
    jsonByteLength(response),
  );
  for (const bytes of terminalResponseBytes) {
    if (bytes + 1 > AGENT_SESSION_RESPONSE_MAX_BYTES) {
      throw new Error('Agent-session terminal response exceeds byte limit');
    }
  }
  if (
    terminalResponseBytes.reduce((total, bytes) => total + bytes + 1, 0) >
    AGENT_SESSION_RESPONSE_TOTAL_MAX_BYTES
  ) {
    throw new Error('Agent-session terminal response segment exceeds byte limit');
  }
  if (document.identityMarkers.length > AGENT_SESSION_IDENTITY_LIMIT) {
    throw new Error('Agent-session identity marker count exceeds limit');
  }
  const identityMarkerBytes = document.identityMarkers.map(identityMarkerStorageByteLength);
  for (const bytes of identityMarkerBytes) {
    if (bytes + 1 > AGENT_SESSION_IDENTITY_MAX_BYTES) {
      throw new Error('Agent-session identity marker exceeds byte limit');
    }
  }
  if (
    identityMarkerBytes.reduce((total, bytes) => total + bytes + 1, 0) >
    AGENT_SESSION_IDENTITY_TOTAL_MAX_BYTES
  ) {
    throw new Error('Agent-session identity marker segment exceeds byte limit');
  }
  const documentBytes =
    encoding?.documentBytes ?? Buffer.byteLength(canonicalDocumentContents(document), 'utf8');
  const componentPayloadBytes = [
    ...activeOperationBytes,
    ...terminalResponseBytes,
    ...(encoding?.identityMarkerPayloadBytes ?? identityMarkerBytes),
  ].reduce<number>((total, bytes) => total + bytes, 0);
  if (documentBytes - componentPayloadBytes > AGENT_SESSION_JOURNAL_ENVELOPE_MAX_BYTES) {
    throw new Error('Agent-session journal envelope exceeds byte limit');
  }
  if (documentBytes > AGENT_SESSION_JOURNAL_MAX_BYTES) {
    throw new Error('Agent-session journal exceeds canonical document byte limit');
  }
}

export function parseAgentSessionJournalDocument(contents: string): AgentSessionJournalDocument {
  if (Buffer.byteLength(contents, 'utf8') > AGENT_SESSION_JOURNAL_MAX_BYTES) {
    throw new Error('Agent-session journal exceeds canonical document byte limit');
  }
  const value: unknown = JSON.parse(contents);
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'activeOperations',
      'formatVersion',
      'identityMarkers',
      'payloadDigest',
      'storageGeneration',
      'terminalResponses',
    ]) ||
    value.formatVersion !== AGENT_SESSION_JOURNAL_FORMAT_VERSION ||
    !Array.isArray(value.activeOperations) ||
    !Array.isArray(value.identityMarkers) ||
    !Array.isArray(value.terminalResponses) ||
    !isFingerprint(value.payloadDigest)
  ) {
    throw new Error('Invalid agent-session journal document');
  }
  const storageGeneration = parseCanonicalUint64(
    value.storageGeneration,
    'agent-session storageGeneration',
  );
  const document: AgentSessionJournalDocument = {
    activeOperations: value.activeOperations as AgentSessionJournalOperationRecord[],
    formatVersion: AGENT_SESSION_JOURNAL_FORMAT_VERSION,
    identityMarkers: value.identityMarkers.map(
      decodeIdentityMarkerFromStorage,
    ) as AgentSessionIdentityMarker[],
    payloadDigest: value.payloadDigest,
    storageGeneration,
    terminalResponses: value.terminalResponses as AgentSessionTerminalResponseRecord[],
  };
  for (const record of document.activeOperations) validateRecord(record);
  for (const response of document.terminalResponses) validateTerminalResponse(response);
  if (!document.identityMarkers.every(isIdentityMarker)) {
    throw new Error('Invalid agent-session journal document');
  }
  assertUnique(document.activeOperations, (record) => record.request.operationId, 'operation');
  assertUnique(document.terminalResponses, (record) => record.snapshot.operationId, 'response');
  const activeOperationIds = new Set(
    document.activeOperations.map((record) => record.request.operationId),
  );
  if (
    document.terminalResponses.some((record) => activeOperationIds.has(record.snapshot.operationId))
  ) {
    throw new Error('Agent-session operation cannot be both active and terminal');
  }
  assertUnique(
    document.identityMarkers,
    (marker) => identityKey(marker.taskId, marker.agentId),
    'identity marker',
  );
  const expectedDigest = calculatePayloadDigest({
    activeOperations: document.activeOperations,
    formatVersion: document.formatVersion,
    identityMarkers: document.identityMarkers,
    storageGeneration: document.storageGeneration,
    terminalResponses: document.terminalResponses,
  });
  if (document.payloadDigest !== expectedDigest) {
    throw new Error('Agent-session journal payload digest mismatch');
  }
  assertDocumentLimits(document, {
    documentBytes: Buffer.byteLength(contents, 'utf8'),
    // Envelope accounting must use the bytes actually present on disk. Marker
    // capacity still uses the compact logical encoding above, allowing a
    // canonical verbose v1 file to be read and upgraded on its next write.
    identityMarkerPayloadBytes: value.identityMarkers.map(jsonByteLength),
  });
  const legacyCanonicalContents = canonicalJsonStringify(document as unknown as JsonObject);
  if (contents !== canonicalDocumentContents(document) && contents !== legacyCanonicalContents) {
    throw new Error('Agent-session journal document is not canonically encoded');
  }
  return document;
}

function serializeDocument(document: AgentSessionJournalDocument): string {
  const contents = canonicalDocumentContents(document);
  assertDocumentLimits(document);
  return contents;
}

export function deriveAgentSessionOperationFingerprint(args: {
  agentDefId: string;
  fallbackClassifier?: AgentResumeFailureClassifier;
  request: AgentSessionOperationRequest;
}): string {
  if (!isIdentity(args.agentDefId) || !isAgentSessionOperationRequest(args.request)) {
    throw new Error('Invalid agent-session operation fingerprint input');
  }
  return createHash('sha256')
    .update(
      canonicalJsonStringify({
        agentDefId: args.agentDefId,
        ...(args.fallbackClassifier ? { fallbackClassifier: args.fallbackClassifier } : {}),
        request: args.request as unknown as JsonObject,
      }),
    )
    .digest('hex');
}

function validateRecord(record: AgentSessionJournalOperationRecord): void {
  if (!isOperationRecord(record)) throw new Error('Invalid agent-session operation record');
  const expectedFingerprint = deriveAgentSessionOperationFingerprint({
    agentDefId: record.agentDefId,
    ...(record.snapshot.fallbackClassifier
      ? { fallbackClassifier: record.snapshot.fallbackClassifier }
      : {}),
    request: record.request,
  });
  if (record.fingerprint !== expectedFingerprint) {
    throw new Error('Agent-session operation fingerprint does not match its immutable request');
  }
  if (jsonByteLength(record) + 1 > AGENT_SESSION_ACTIVE_RECORD_MAX_BYTES) {
    throw new Error('Agent-session active operation exceeds byte limit');
  }
}

function validateTerminalResponse(response: AgentSessionTerminalResponseRecord): void {
  if (!isTerminalResponse(response)) {
    throw new Error('Invalid agent-session terminal response');
  }
  const expectedFingerprint = deriveAgentSessionOperationFingerprint({
    agentDefId: response.agentDefId,
    ...(response.snapshot.fallbackClassifier
      ? { fallbackClassifier: response.snapshot.fallbackClassifier }
      : {}),
    request: response.request,
  });
  if (response.fingerprint !== expectedFingerprint) {
    throw new Error('Agent-session terminal response fingerprint mismatch');
  }
}

function initialLaunchImmutableIdentity(marker: AgentSessionInitialLaunchMarker): JsonObject {
  return {
    agentDefId: marker.agentDefId,
    agentId: marker.agentId,
    committedWorkspaceRevision: marker.committedWorkspaceRevision,
    creationOperationId: marker.creationOperationId,
    fingerprint: marker.fingerprint,
    launchOperationId: marker.launchOperationId,
    targetGeneration: marker.targetGeneration,
    taskId: marker.taskId,
  };
}

function cleanRestartImmutableCycle(marker: AgentSessionCleanRestartMarker): JsonObject {
  return {
    agentDefId: marker.agentDefId,
    cols: marker.cols,
    rows: marker.rows,
    sourceGeneration: marker.sourceGeneration,
    targetGeneration: marker.targetGeneration,
  };
}

function assertCleanRestartProgress(
  existing: AgentSessionCleanRestartMarker,
  incoming: AgentSessionCleanRestartMarker,
): void {
  if (incoming.generationHighWater < existing.generationHighWater) {
    throw new Error('Clean-restart generation high-water cannot regress');
  }
  const sameCycle =
    canonicalJsonStringify(cleanRestartImmutableCycle(existing)) ===
    canonicalJsonStringify(cleanRestartImmutableCycle(incoming));
  if (sameCycle) {
    const transitions: Readonly<
      Record<AgentSessionCleanRestartPhase, ReadonlySet<AgentSessionCleanRestartPhase>>
    > = {
      available: new Set(['available', 'restoring']),
      restored: new Set(['restored']),
      restoring: new Set(['restored', 'restoring']),
    };
    if (!transitions[existing.phase].has(incoming.phase)) {
      throw new Error('Clean-restart permit phase cannot regress or be reused');
    }
    return;
  }
  if (
    incoming.phase !== 'available' ||
    incoming.sourceGeneration < existing.targetGeneration ||
    incoming.generationHighWater !== incoming.sourceGeneration
  ) {
    throw new Error('Clean-restart permit cycle cannot regress or be reused');
  }
}

function mergeIdentityMarker(
  existing: AgentSessionIdentityMarker | undefined,
  incoming: AgentSessionIdentityMarker,
): AgentSessionIdentityMarker {
  if (!isIdentityMarker(incoming)) throw new Error('Invalid agent-session identity marker');
  if (!existing) return structuredClone(incoming);
  if (incoming.initialLaunch && existing.initialLaunch) {
    if (
      canonicalJsonStringify(initialLaunchImmutableIdentity(existing.initialLaunch)) !==
      canonicalJsonStringify(initialLaunchImmutableIdentity(incoming.initialLaunch))
    ) {
      throw new Error('Initial-launch marker identity is immutable');
    }
    if (
      !canTransitionAgentSessionOperationPhase(
        existing.initialLaunch.lastKnownPhase,
        incoming.initialLaunch.lastKnownPhase,
      )
    ) {
      throw new Error('Initial-launch marker phase cannot regress');
    }
    if (
      existing.initialLaunch.terminalPhase !== undefined &&
      incoming.initialLaunch.terminalPhase !== existing.initialLaunch.terminalPhase
    ) {
      throw new Error('Initial-launch marker terminal phase is immutable');
    }
  }
  if (
    incoming.fallbackHighWater &&
    existing.fallbackHighWater &&
    incoming.fallbackHighWater.highestAttemptedSourceGeneration <
      existing.fallbackHighWater.highestAttemptedSourceGeneration
  ) {
    throw new Error('Fallback high-water cannot regress');
  }
  if (
    incoming.fallbackHighWater &&
    existing.fallbackHighWater &&
    incoming.fallbackHighWater.highestAttemptedSourceGeneration ===
      existing.fallbackHighWater.highestAttemptedSourceGeneration &&
    (incoming.fallbackHighWater.operationId !== existing.fallbackHighWater.operationId ||
      incoming.fallbackHighWater.fingerprint !== existing.fallbackHighWater.fingerprint)
  ) {
    throw new Error('Fallback high-water identity conflicts');
  }
  if (
    incoming.fallbackHighWater &&
    existing.fallbackHighWater &&
    incoming.fallbackHighWater.highestAttemptedSourceGeneration ===
      existing.fallbackHighWater.highestAttemptedSourceGeneration &&
    !canTransitionAgentSessionOperationPhase(
      existing.fallbackHighWater.lastKnownPhase,
      incoming.fallbackHighWater.lastKnownPhase,
    )
  ) {
    throw new Error('Fallback high-water phase cannot regress');
  }
  if (incoming.cleanRestart && existing.cleanRestart) {
    assertCleanRestartProgress(existing.cleanRestart, incoming.cleanRestart);
  }
  return {
    agentId: existing.agentId,
    taskId: existing.taskId,
    ...(existing.cleanRestart || incoming.cleanRestart
      ? { cleanRestart: structuredClone(incoming.cleanRestart ?? existing.cleanRestart) }
      : {}),
    ...(existing.initialLaunch || incoming.initialLaunch
      ? { initialLaunch: structuredClone(incoming.initialLaunch ?? existing.initialLaunch) }
      : {}),
    ...(existing.fallbackHighWater || incoming.fallbackHighWater
      ? {
          fallbackHighWater: structuredClone(
            incoming.fallbackHighWater ?? existing.fallbackHighWater,
          ),
        }
      : {}),
  };
}

function assertOperationProgress(
  existing: AgentSessionJournalOperationRecord | AgentSessionTerminalResponseRecord,
  incoming: AgentSessionJournalOperationRecord,
): void {
  const existingSnapshot = existing.snapshot;
  if (
    existing.agentDefId !== incoming.agentDefId ||
    canonicalJsonStringify(existing.request as unknown as JsonObject) !==
      canonicalJsonStringify(incoming.request as unknown as JsonObject)
  ) {
    throw new Error('Agent-session operation immutable fields changed');
  }
  if ('updatedAtMs' in existing) {
    if (existing.createdAtMs !== incoming.createdAtMs) {
      throw new Error('Agent-session operation immutable fields changed');
    }
    if (incoming.updatedAtMs < existing.updatedAtMs) {
      throw new Error('Agent-session operation timestamp cannot regress');
    }
  }
  if (existingSnapshot.version > incoming.snapshot.version) {
    throw new Error('Agent-session operation version cannot regress');
  }
  if (existingSnapshot.version === incoming.snapshot.version) {
    if (
      canonicalJsonStringify(existingSnapshot as unknown as JsonObject) !==
      canonicalJsonStringify(incoming.snapshot as unknown as JsonObject)
    ) {
      throw new Error('Agent-session operation version has conflicting state');
    }
    return;
  }
  if (
    existingSnapshot.phase === incoming.snapshot.phase ||
    incoming.snapshot.version !== existingSnapshot.version + 1 ||
    !canTransitionAgentSessionOperationPhase(existingSnapshot.phase, incoming.snapshot.phase)
  ) {
    throw new Error('Invalid agent-session operation phase progression');
  }
}

function applySaveOperation(
  prior: AgentSessionJournalDocument,
  record: AgentSessionJournalOperationRecord,
  options: SaveAgentSessionOperationOptions,
): AgentSessionJournalDocument {
  // The serialized owner validated and cloned the incoming mutation before entering this function.
  // Existing document entries are immutable, so copy the three arrays that are structurally edited
  // instead of cloning every unchanged record twice before the commit installs its own deep copy.
  const next: AgentSessionJournalDocument = {
    ...prior,
    activeOperations: [...prior.activeOperations],
    identityMarkers: [...prior.identityMarkers],
    terminalResponses: [...prior.terminalResponses],
  };
  const activeIndex = next.activeOperations.findIndex(
    (entry) => entry.request.operationId === record.request.operationId,
  );
  const responseIndex = next.terminalResponses.findIndex(
    (entry) => entry.snapshot.operationId === record.request.operationId,
  );
  const existing =
    activeIndex >= 0
      ? next.activeOperations[activeIndex]
      : responseIndex >= 0
        ? next.terminalResponses[responseIndex]
        : undefined;
  if (existing && existing.fingerprint !== record.fingerprint) {
    throw new Error('Agent-session operation ID fingerprint conflict');
  }
  if (existing) assertOperationProgress(existing, record);

  if (isAgentSessionOperationTerminalPhase(record.snapshot.phase)) {
    if (activeIndex >= 0) next.activeOperations.splice(activeIndex, 1);
    const response: AgentSessionTerminalResponseRecord = {
      agentDefId: record.agentDefId,
      fingerprint: record.fingerprint,
      request: structuredClone(record.request),
      snapshot: structuredClone(record.snapshot),
      terminalAtMs: record.updatedAtMs,
    };
    if (responseIndex >= 0) next.terminalResponses.splice(responseIndex, 1);
    next.terminalResponses.push(response);
    while (
      next.terminalResponses.length > AGENT_SESSION_RESPONSE_LIMIT ||
      segmentByteLength(next.terminalResponses) > AGENT_SESSION_RESPONSE_TOTAL_MAX_BYTES
    ) {
      next.terminalResponses.shift();
    }
  } else if (activeIndex >= 0) {
    next.activeOperations[activeIndex] = structuredClone(record);
  } else {
    next.activeOperations.push(structuredClone(record));
  }

  if (options.identityMarker) {
    if (
      options.identityMarker.taskId !== record.request.taskId ||
      options.identityMarker.agentId !== record.request.agentId
    ) {
      throw new Error('Agent-session identity marker does not match its operation identity');
    }
    if (
      options.identityMarker.initialLaunch &&
      (record.request.mode !== 'initial' ||
        options.identityMarker.initialLaunch.launchOperationId !== record.request.operationId ||
        options.identityMarker.initialLaunch.fingerprint !== record.fingerprint)
    ) {
      throw new Error('Initial-launch marker does not match its operation');
    }
    if (
      options.identityMarker.fallbackHighWater &&
      (record.request.launchReason !== 'resume-fallback' ||
        options.identityMarker.fallbackHighWater.operationId !== record.request.operationId ||
        options.identityMarker.fallbackHighWater.fingerprint !== record.fingerprint ||
        options.identityMarker.fallbackHighWater.highestAttemptedSourceGeneration !==
          record.request.expectedSourceGeneration)
    ) {
      throw new Error('Fallback high-water marker does not match its operation');
    }
    const markerIndex = next.identityMarkers.findIndex(
      (marker) =>
        marker.taskId === options.identityMarker?.taskId &&
        marker.agentId === options.identityMarker.agentId,
    );
    const merged = mergeIdentityMarker(
      markerIndex >= 0 ? next.identityMarkers[markerIndex] : undefined,
      options.identityMarker,
    );
    if (markerIndex >= 0) next.identityMarkers[markerIndex] = merged;
    else next.identityMarkers.push(merged);
  }

  next.activeOperations.sort((left, right) =>
    left.request.operationId.localeCompare(right.request.operationId),
  );
  next.identityMarkers.sort((left, right) =>
    identityKey(left.taskId, left.agentId).localeCompare(identityKey(right.taskId, right.agentId)),
  );
  const proposed = withPayloadDigest({
    activeOperations: next.activeOperations,
    formatVersion: AGENT_SESSION_JOURNAL_FORMAT_VERSION,
    identityMarkers: next.identityMarkers,
    storageGeneration: incrementCanonicalUint64(prior.storageGeneration),
    terminalResponses: next.terminalResponses,
  });
  return proposed;
}

function applySaveIdentityMarkers(
  prior: AgentSessionJournalDocument,
  markers: readonly AgentSessionIdentityMarker[],
): AgentSessionJournalDocument | null {
  assertUnique(markers, (marker) => identityKey(marker.taskId, marker.agentId), 'identity marker');
  const identityMarkers = [...prior.identityMarkers];
  let changed = false;
  for (const marker of markers) {
    if (!isIdentityMarker(marker)) throw new Error('Invalid agent-session identity marker');
    const index = identityMarkers.findIndex(
      (existing) => existing.taskId === marker.taskId && existing.agentId === marker.agentId,
    );
    const merged = mergeIdentityMarker(index >= 0 ? identityMarkers[index] : undefined, marker);
    if (
      index >= 0 &&
      canonicalJsonStringify(identityMarkers[index] as unknown as JsonObject) ===
        canonicalJsonStringify(merged as unknown as JsonObject)
    ) {
      continue;
    }
    changed = true;
    if (index >= 0) identityMarkers[index] = merged;
    else identityMarkers.push(merged);
  }
  if (!changed) return null;
  identityMarkers.sort((left, right) =>
    identityKey(left.taskId, left.agentId).localeCompare(identityKey(right.taskId, right.agentId)),
  );
  return withPayloadDigest({
    activeOperations: prior.activeOperations,
    formatVersion: AGENT_SESSION_JOURNAL_FORMAT_VERSION,
    identityMarkers,
    storageGeneration: incrementCanonicalUint64(prior.storageGeneration),
    terminalResponses: prior.terminalResponses,
  });
}

function applyDeleteTask(
  prior: AgentSessionJournalDocument,
  taskId: string,
): AgentSessionJournalDocument | null {
  const activeOperations = prior.activeOperations.filter(
    (record) => record.request.taskId !== taskId,
  );
  const terminalResponses = prior.terminalResponses.filter(
    (record) => record.snapshot.taskId !== taskId,
  );
  const identityMarkers = prior.identityMarkers.filter((marker) => marker.taskId !== taskId);
  if (
    activeOperations.length === prior.activeOperations.length &&
    terminalResponses.length === prior.terminalResponses.length &&
    identityMarkers.length === prior.identityMarkers.length
  ) {
    return null;
  }
  return withPayloadDigest({
    activeOperations,
    formatVersion: AGENT_SESSION_JOURNAL_FORMAT_VERSION,
    identityMarkers,
    storageGeneration: incrementCanonicalUint64(prior.storageGeneration),
    terminalResponses,
  });
}

abstract class BaseAgentSessionOperationJournal implements AgentSessionOperationJournal {
  protected document = emptyDocument();
  protected health: AgentSessionJournalHealth = 'uninitialized';
  private readonly identityIndex = new Map<string, AgentSessionIdentityMarker>();
  private readonly operationIndex = new Map<string, AgentSessionJournalOperationLookup>();
  private queue: Promise<void> = Promise.resolve();

  abstract close(): Promise<void>;
  abstract repairDurability(): Promise<boolean>;
  abstract startup(): Promise<AgentSessionJournalHealth>;

  protected abstract commit(proposed: AgentSessionJournalDocument): Promise<void>;

  getCounts(): AgentSessionJournalCounts {
    return {
      activeOperations: this.document.activeOperations.length,
      identityMarkers: this.document.identityMarkers.length,
      terminalResponses: this.document.terminalResponses.length,
    };
  }

  getHealth(): AgentSessionJournalHealth {
    return this.health;
  }

  getIdentityMarker(taskId: string, agentId: string): AgentSessionIdentityMarker | null {
    const marker = this.identityIndex.get(identityKey(taskId, agentId));
    return marker ? structuredClone(marker) : null;
  }

  getLatestTaskAgentOperation(
    taskId: string,
    agentId: string,
  ): AgentSessionJournalOperationLookup | null {
    const candidates: Array<{
      lookup: AgentSessionJournalOperationLookup;
      observedAtMs: number;
      operationId: string;
      version: number;
    }> = [];
    for (const record of this.document.activeOperations) {
      if (record.request.taskId !== taskId || record.request.agentId !== agentId) continue;
      candidates.push({
        lookup: { kind: 'active', record },
        observedAtMs: record.updatedAtMs,
        operationId: record.request.operationId,
        version: record.snapshot.version,
      });
    }
    for (const response of this.document.terminalResponses) {
      if (response.request.taskId !== taskId || response.request.agentId !== agentId) continue;
      candidates.push({
        lookup: { kind: 'terminal-response', response },
        observedAtMs: response.terminalAtMs,
        operationId: response.request.operationId,
        version: response.snapshot.version,
      });
    }
    const latest = candidates.sort(
      (left, right) =>
        right.observedAtMs - left.observedAtMs ||
        right.version - left.version ||
        right.operationId.localeCompare(left.operationId),
    )[0];
    return latest ? structuredClone(latest.lookup) : null;
  }

  getOperation(operationId: string): AgentSessionJournalOperationLookup | null {
    const operation = this.operationIndex.get(operationId);
    return operation ? structuredClone(operation) : null;
  }

  getTaskRecordCount(taskId: string): number {
    return (
      this.document.activeOperations.filter((record) => record.request.taskId === taskId).length +
      this.document.terminalResponses.filter((record) => record.request.taskId === taskId).length
    );
  }

  listTaskIdentityMarkers(taskId: string): AgentSessionIdentityMarker[] {
    return this.document.identityMarkers
      .filter((marker) => marker.taskId === taskId)
      .map((marker) => structuredClone(marker));
  }

  listTaskOperations(taskId: string): AgentSessionJournalOperationRecord[] {
    return this.document.activeOperations
      .filter((record) => record.request.taskId === taskId)
      .map((record) => structuredClone(record));
  }

  async saveOperation(
    record: AgentSessionJournalOperationRecord,
    options: SaveAgentSessionOperationOptions = {},
  ): Promise<void> {
    validateRecord(record);
    const stableRecord = structuredClone(record);
    const stableOptions = structuredClone(options);
    await this.serialized(async () => {
      this.assertHealthy();
      await this.commit(applySaveOperation(this.document, stableRecord, stableOptions));
    });
  }

  async saveIdentityMarkers(markers: readonly AgentSessionIdentityMarker[]): Promise<void> {
    const stableMarkers = structuredClone(markers);
    await this.serialized(async () => {
      this.assertHealthy();
      const proposed = applySaveIdentityMarkers(this.document, stableMarkers);
      if (proposed) await this.commit(proposed);
    });
  }

  async deleteTaskRecords(taskId: string): Promise<'already-complete' | 'complete'> {
    if (!isIdentity(taskId)) throw new Error('Invalid task identity');
    return this.serialized(async () => {
      this.assertHealthy();
      const proposed = applyDeleteTask(this.document, taskId);
      if (!proposed) return 'already-complete';
      await this.commit(proposed);
      return 'complete';
    });
  }

  protected assertHealthy(): void {
    if (this.health !== 'healthy') {
      throw new Error(`Agent-session journal is ${this.health}`);
    }
  }

  protected installDocument(document: AgentSessionJournalDocument): void {
    this.document = cloneDocument(document);
    this.identityIndex.clear();
    this.operationIndex.clear();
    for (const marker of this.document.identityMarkers) {
      this.identityIndex.set(identityKey(marker.taskId, marker.agentId), marker);
    }
    for (const record of this.document.activeOperations) {
      this.operationIndex.set(record.request.operationId, { kind: 'active', record });
    }
    for (const response of this.document.terminalResponses) {
      this.operationIndex.set(response.snapshot.operationId, {
        kind: 'terminal-response',
        response,
      });
    }
  }

  protected serialized<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function createMemoryAgentSessionOperationJournal(
  options: { health?: AgentSessionJournalHealth } = {},
): AgentSessionOperationJournal {
  return new (class extends BaseAgentSessionOperationJournal {
    constructor() {
      super();
      this.health = options.health ?? 'healthy';
    }

    async close(): Promise<void> {
      await this.serialized(async () => {
        this.health = 'closed';
      });
    }

    protected async commit(proposed: AgentSessionJournalDocument): Promise<void> {
      assertDocumentLimits(proposed);
      this.installDocument(proposed);
    }

    async repairDurability(): Promise<boolean> {
      return this.serialized(async () => this.health === 'healthy');
    }

    async startup(): Promise<AgentSessionJournalHealth> {
      return this.serialized(async () => this.health);
    }
  })();
}

async function readDocumentContents(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.size > AGENT_SESSION_JOURNAL_MAX_BYTES) {
      throw new Error('Agent-session journal file exceeds byte limit');
    }
    return fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readDocument(filePath: string): Promise<AgentSessionJournalDocument | null> {
  const contents = await readDocumentContents(filePath);
  return contents === null ? null : parseAgentSessionJournalDocument(contents);
}

type ObservedJournalDocument =
  | { kind: 'invalid' }
  | { kind: 'missing' }
  | { document: AgentSessionJournalDocument; kind: 'valid' };

async function observeDocument(filePath: string): Promise<ObservedJournalDocument> {
  try {
    const document = await readDocument(filePath);
    return document ? { document, kind: 'valid' } : { kind: 'missing' };
  } catch {
    return { kind: 'invalid' };
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const BACKUP_LINK_FALLBACK_ERROR_CODES = new Set([
  'EACCES',
  'EMLINK',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
]);

async function createDurablePriorBackup(
  primaryPath: string,
  backupPath: string,
  link: (existingPath: string, newPath: string) => Promise<void>,
): Promise<void> {
  await fs.promises.rm(backupPath, { force: true });
  try {
    // The primary inode was file-fsynced and its directory entry was fsynced by the prior commit.
    // A same-directory hard link preserves that exact inode as backup evidence without copying and
    // rewriting the full canonical document before every replacement.
    await link(primaryPath, backupPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !BACKUP_LINK_FALLBACK_ERROR_CODES.has(code)) throw error;
    await fs.promises.copyFile(primaryPath, backupPath, fs.constants.COPYFILE_EXCL);
  }
  const backupHandle = await fs.promises.open(backupPath, 'r');
  try {
    await backupHandle.sync();
  } finally {
    await backupHandle.close();
  }
}

export function createFileAgentSessionOperationJournal(
  env: StorageEnv,
  options: FileAgentSessionOperationJournalOptions = {},
): AgentSessionOperationJournal {
  const stateDirectory = getStateDirForEnv(env);
  const primaryPath = path.join(
    stateDirectory,
    options.fileName ?? AGENT_SESSION_JOURNAL_FILE_NAME,
  );
  const backupPath = `${primaryPath}.backup`;
  const temporaryPath = `${primaryPath}.tmp`;

  return new (class extends BaseAgentSessionOperationJournal {
    private directoryDurabilityProposal: AgentSessionJournalDocument | null = null;
    private primaryContents = canonicalDocumentContents(emptyDocument());

    async close(): Promise<void> {
      await this.serialized(async () => {
        this.health = 'closed';
      });
    }

    protected async commit(proposed: AgentSessionJournalDocument): Promise<void> {
      this.assertHealthy();
      const prior = this.document;
      const proposedContents = serializeDocument(proposed);
      let renamed = false;
      let directorySynced = false;
      try {
        await fs.promises.mkdir(stateDirectory, { mode: 0o700, recursive: true });
        const currentContents = await readDocumentContents(primaryPath);
        if (
          (currentContents === null && prior.storageGeneration !== '0') ||
          (currentContents !== null && currentContents !== this.primaryContents)
        ) {
          throw new Error('Agent-session journal prior state changed unexpectedly');
        }
        if (currentContents !== null) {
          await createDurablePriorBackup(
            primaryPath,
            backupPath,
            options.backupLink ?? fs.promises.link,
          );
          await options.faultInjector?.('after-backup-fsync');
        }
        await fs.promises.rm(temporaryPath, { force: true });
        const temporaryHandle = await fs.promises.open(temporaryPath, 'wx', 0o600);
        try {
          await temporaryHandle.writeFile(proposedContents, 'utf8');
          await options.faultInjector?.('after-temporary-write');
          await temporaryHandle.sync();
          await options.faultInjector?.('after-temporary-fsync');
        } finally {
          await temporaryHandle.close();
        }
        await fs.promises.rename(temporaryPath, primaryPath);
        renamed = true;
        await options.faultInjector?.('after-rename');
        await fsyncDirectory(stateDirectory);
        directorySynced = true;
        await options.faultInjector?.('after-directory-fsync');
        this.installDocument(proposed);
        this.primaryContents = proposedContents;
      } catch (error) {
        const observed = await observeDocument(primaryPath);
        const isExactPrior =
          (observed.kind === 'valid' &&
            observed.document.storageGeneration === prior.storageGeneration &&
            observed.document.payloadDigest === prior.payloadDigest) ||
          (observed.kind === 'missing' &&
            prior.storageGeneration === '0' &&
            prior.payloadDigest === emptyDocument().payloadDigest);
        const isExactProposed =
          observed.kind === 'valid' &&
          observed.document.storageGeneration === proposed.storageGeneration &&
          observed.document.payloadDigest === proposed.payloadDigest;
        if (isExactPrior && !renamed) {
          await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
          throw error;
        }
        if (isExactProposed && directorySynced) {
          this.installDocument(proposed);
          this.primaryContents = proposedContents;
          return;
        }
        if (isExactProposed) {
          this.installDocument(proposed);
          this.primaryContents = proposedContents;
          this.directoryDurabilityProposal = cloneDocument(proposed);
          this.health = 'durability-repair-required';
          throw error;
        }
        this.health = 'recovery-required';
        throw error;
      }
    }

    async repairDurability(): Promise<boolean> {
      return this.serialized(async () => {
        if (this.health === 'healthy') return true;
        if (this.health !== 'durability-repair-required' || !this.directoryDurabilityProposal) {
          return false;
        }
        try {
          await fsyncDirectory(stateDirectory);
          const observed = await readDocument(primaryPath);
          if (
            !observed ||
            observed.storageGeneration !== this.directoryDurabilityProposal.storageGeneration ||
            observed.payloadDigest !== this.directoryDurabilityProposal.payloadDigest
          ) {
            this.health = 'recovery-required';
            return false;
          }
          this.installDocument(observed);
          this.primaryContents = canonicalDocumentContents(observed);
          this.directoryDurabilityProposal = null;
          this.health = 'healthy';
          return true;
        } catch {
          return false;
        }
      });
    }

    async startup(): Promise<AgentSessionJournalHealth> {
      return this.serialized(async () => {
        if (this.health === 'closed') return this.health;
        try {
          await fs.promises.mkdir(stateDirectory, { mode: 0o700, recursive: true });
          const primaryExists = await fs.promises
            .access(primaryPath)
            .then(() => true)
            .catch(() => false);
          const backupExists = await fs.promises
            .access(backupPath)
            .then(() => true)
            .catch(() => false);
          if (!primaryExists) {
            if (backupExists) {
              this.health = 'recovery-required';
              return this.health;
            }
            await fsyncDirectory(stateDirectory);
            const primaryAfterFsync = await observeDocument(primaryPath);
            const backupAfterFsync = await observeDocument(backupPath);
            if (primaryAfterFsync.kind !== 'missing' || backupAfterFsync.kind !== 'missing') {
              throw new Error('Agent-session journal appeared during empty startup reconciliation');
            }
            this.installDocument(emptyDocument());
            this.primaryContents = canonicalDocumentContents(this.document);
            this.health = 'healthy';
            return this.health;
          }
          const primary = await readDocument(primaryPath);
          if (!primary) throw new Error('Agent-session journal primary disappeared');
          if (backupExists) {
            const backup = await readDocument(backupPath);
            if (!backup || BigInt(backup.storageGeneration) > BigInt(primary.storageGeneration)) {
              throw new Error('Agent-session journal backup is not valid prior-state evidence');
            }
          }
          await fsyncDirectory(stateDirectory);
          const revalidatedContents = await readDocumentContents(primaryPath);
          if (revalidatedContents === null) {
            throw new Error('Agent-session journal changed during startup reconciliation');
          }
          const revalidated = parseAgentSessionJournalDocument(revalidatedContents);
          if (
            revalidated.storageGeneration !== primary.storageGeneration ||
            revalidated.payloadDigest !== primary.payloadDigest
          ) {
            throw new Error('Agent-session journal changed during startup reconciliation');
          }
          this.installDocument(revalidated);
          // Keep the exact accepted disk encoding as the compare-and-swap
          // baseline. A legacy verbose v1 document is logically canonical but
          // byte-distinct from the compact encoding written on its next commit.
          this.primaryContents = revalidatedContents;
          this.health = 'healthy';
          return this.health;
        } catch {
          this.health = 'recovery-required';
          return this.health;
        }
      });
    }
  })();
}
