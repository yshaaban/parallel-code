import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

import {
  TASK_NOTES_MAX_ACKNOWLEDGEMENTS,
  isAcknowledgedTaskNotesOperation,
  isTaskNotesDeadline,
  isTaskNotesOperationId,
  isTaskNotesOperationOutcome,
  isTaskNotesOpaque32ByteToken,
  isTaskNotesTaskId,
  isTaskNotesText,
  type AcknowledgedTaskNotesOperation,
  type IssuedTaskNotesOperation,
  type TaskNotesOperationOutcome,
  type UpdateTaskNotesRequest,
} from '../../src/domain/task-notes.js';
import { canonicalJsonStringify, type JsonObject } from './workspace-state-storage.js';

export const TASK_NOTES_ADMISSION_WINDOW_MS = 10 * 60 * 1_000;
export const TASK_NOTES_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const TASK_NOTES_MAX_OPERATION_RECORD_BYTES = 2_048;
export const TASK_NOTES_MAX_OPERATIONS_PER_PRINCIPAL = 256;
export const TASK_NOTES_MAX_OPERATIONS_PER_WORKSPACE = 4_096;
export const TASK_NOTES_MAX_OPERATION_SEGMENT_BYTES = 8_454_144;
export const TASK_NOTES_OPERATION_SEGMENT_VERSION = 1;
export const TASK_NOTES_OPERATIONS_PRIVATE_STATE_KEY = 'taskNotesOperations';

const TASK_NOTES_OPERATION_ID_ATTEMPTS = 4;
const TASK_NOTES_OPERATION_ID_BYTES = 16;
const TASK_NOTES_CAPABILITY_BYTES = 32;
const OPERATION_KEY_SEPARATOR = '.';
const TASK_NOTES_OPERATION_SEGMENT_PREFIX_BYTES = Buffer.byteLength(
  `{"formatVersion":${TASK_NOTES_OPERATION_SEGMENT_VERSION},"operations":{`,
  'utf8',
);
const TASK_NOTES_OPERATION_SEGMENT_SUFFIX_BYTES = Buffer.byteLength('}}', 'utf8');

interface TaskNotesOperationRecordBase {
  admitUntil: string;
  capabilityHash: string;
  operationId: string;
  principalHash: string;
  replayUntil: string;
  retireAfter: string;
  taskId: string;
  taskIdentityWitness: string;
}

export type TaskNotesOperationRecord =
  | (TaskNotesOperationRecordBase & {
      state: 'issued';
    })
  | (TaskNotesOperationRecordBase & {
      admittedAt: string;
      fingerprint: string;
      state: 'admitted';
    })
  | (TaskNotesOperationRecordBase & {
      admittedAt: string;
      completedAt: string;
      fingerprint: string;
      outcome: TaskNotesOperationOutcome;
      state: 'terminal';
    });

export interface TaskNotesOperationSegment {
  formatVersion: typeof TASK_NOTES_OPERATION_SEGMENT_VERSION;
  operations: Record<string, TaskNotesOperationRecord>;
}

export interface ReserveTaskNotesOperationRequest {
  acknowledgedOperations?: readonly AcknowledgedTaskNotesOperation[];
  now: number;
  principalHash: string;
  randomBytes?: (size: number) => Uint8Array;
  taskId: string;
  taskIdentityWitness: string;
}

export type ReserveTaskNotesOperationResult =
  | {
      kind: 'reserved';
      operation: IssuedTaskNotesOperation;
      record: Extract<TaskNotesOperationRecord, { state: 'issued' }>;
      reclaimedCount: number;
      segment: TaskNotesOperationSegment;
    }
  | { kind: 'capacity-exhausted'; reclaimedCount: number }
  | { kind: 'identity-collision'; reclaimedCount: number };

export type ClassifyTaskNotesOperationResult =
  | {
      kind: 'admit';
      fingerprint: string;
      record: Extract<TaskNotesOperationRecord, { state: 'admitted' }>;
    }
  | {
      kind: 'resume';
      record: Extract<TaskNotesOperationRecord, { state: 'admitted' }>;
    }
  | {
      kind: 'replay';
      record: Extract<TaskNotesOperationRecord, { state: 'terminal' }>;
    }
  | { kind: 'operation-expired'; expiredAt: string }
  | { kind: 'operation-identity-rejected' };

function lengthPrefix(bytes: Uint8Array): Buffer {
  if (bytes.byteLength > 0xffff_ffff) throw new RangeError('Length-prefixed value is too large');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([prefix, Buffer.from(bytes)]);
}

function utf8(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function encodeLengthPrefixedFields(fields: readonly Uint8Array[]): Buffer {
  return Buffer.concat(fields.map(lengthPrefix));
}

function sha256LengthPrefixed(domain: string, payload: Uint8Array): Buffer {
  return createHash('sha256')
    .update(encodeLengthPrefixedFields([utf8(domain), payload]))
    .digest();
}

function toCanonicalBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decodeCanonicalBase64Url(value: string, expectedBytes: number): Buffer | null {
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.byteLength === expectedBytes && toCanonicalBase64Url(bytes) === value
      ? bytes
      : null;
  } catch {
    return null;
  }
}

function constantTimeTokenEqual(left: string, right: string): boolean {
  const leftBytes = utf8(left);
  const rightBytes = utf8(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function checkedIsoTimestamp(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp)) throw new RangeError('Task notes timestamp must be safe');
  const value = new Date(timestamp).toISOString();
  if (!isTaskNotesDeadline(value)) throw new RangeError('Task notes timestamp is out of range');
  return value;
}

function checkedDeadline(now: number, offsetMs: number): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - offsetMs) {
    throw new RangeError('Task notes clock is out of range');
  }
  return checkedIsoTimestamp(now + offsetMs);
}

function maxDeadline(left: string, right: string): string {
  return left >= right ? left : right;
}

function operationKey(principalHash: string, operationId: string): string {
  return `${principalHash}${OPERATION_KEY_SEPARATOR}${operationId}`;
}

function cloneRecord(record: TaskNotesOperationRecord): TaskNotesOperationRecord {
  return JSON.parse(JSON.stringify(record)) as TaskNotesOperationRecord;
}

export function createEmptyTaskNotesOperationSegment(): TaskNotesOperationSegment {
  return { formatVersion: TASK_NOTES_OPERATION_SEGMENT_VERSION, operations: {} };
}

export function readTaskNotesOperationSegment(
  privateState: Readonly<JsonObject>,
  options: { allowMissing?: boolean } = {},
): TaskNotesOperationSegment {
  const value = privateState[TASK_NOTES_OPERATIONS_PRIVATE_STATE_KEY];
  if (value === undefined && options.allowMissing) return createEmptyTaskNotesOperationSegment();
  assertTaskNotesOperationSegment(value);
  // Workspace authorities already hand consumers a detached host snapshot. Operation transforms
  // are immutable and the write helper clones canonically, so another multi-megabyte read clone is
  // both redundant and outside this codec owner's parse/guard responsibility.
  return value;
}

export function withTaskNotesOperationSegment(
  privateState: Readonly<JsonObject>,
  segment: TaskNotesOperationSegment,
): JsonObject {
  assertTaskNotesOperationSegment(segment);
  return {
    ...JSON.parse(canonicalJsonStringify(privateState as JsonObject)),
    [TASK_NOTES_OPERATIONS_PRIVATE_STATE_KEY]: JSON.parse(
      canonicalJsonStringify(segment as unknown as JsonObject),
    ),
  } as JsonObject;
}

export function hashTaskNotesPrincipal(principal: string): string {
  return toCanonicalBase64Url(sha256LengthPrefixed('task-notes-principal:v1', utf8(principal)));
}

export function deriveTaskNotesIncarnation(taskIdentityWitness: string): string {
  if (!isTaskNotesOpaque32ByteToken(taskIdentityWitness)) {
    throw new TypeError('Invalid task identity witness');
  }
  return toCanonicalBase64Url(
    sha256LengthPrefixed('task-notes-incarnation:v1', utf8(taskIdentityWitness)),
  );
}

export function createTaskNotesContentVersion(notes: string): string {
  if (!isTaskNotesText(notes)) throw new TypeError('Invalid task notes');
  return toCanonicalBase64Url(sha256LengthPrefixed('task-notes-content:v1', utf8(notes)));
}

export function hashTaskNotesCapability(operationCapability: string): string {
  const rawCapability = decodeCanonicalBase64Url(operationCapability, TASK_NOTES_CAPABILITY_BYTES);
  if (!rawCapability) throw new TypeError('Invalid task notes operation capability');
  return toCanonicalBase64Url(sha256LengthPrefixed('task-notes-capability:v1', rawCapability));
}

export function createTaskNotesOperationFingerprint(request: UpdateTaskNotesRequest): string {
  if (
    !isTaskNotesTaskId(request.taskId) ||
    !isTaskNotesOpaque32ByteToken(request.taskIncarnation) ||
    !isTaskNotesText(request.notes) ||
    !isTaskNotesOpaque32ByteToken(request.baseContentVersion) ||
    !isTaskNotesOperationId(request.operationId)
  ) {
    throw new TypeError('Invalid task notes update fingerprint input');
  }
  const rawCapability = decodeCanonicalBase64Url(
    request.operationCapability,
    TASK_NOTES_CAPABILITY_BYTES,
  );
  if (!rawCapability) throw new TypeError('Invalid task notes operation capability');
  const payload = encodeLengthPrefixedFields([
    utf8('task-notes:v1'),
    utf8(request.taskId),
    utf8(request.taskIncarnation),
    utf8(request.notes),
    utf8(request.baseContentVersion),
    utf8(request.operationId),
  ]);
  return toCanonicalBase64Url(createHmac('sha256', rawCapability).update(payload).digest());
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => {
      if (typeof key !== 'string' || !keys.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
    })
  );
}

function isTaskNotesOperationRecordBase(
  value: Record<string, unknown>,
): value is Record<string, unknown> & TaskNotesOperationRecordBase {
  return (
    isTaskNotesDeadline(value.admitUntil) &&
    isTaskNotesOpaque32ByteToken(value.capabilityHash) &&
    isTaskNotesOperationId(value.operationId) &&
    isTaskNotesOpaque32ByteToken(value.principalHash) &&
    isTaskNotesDeadline(value.replayUntil) &&
    isTaskNotesDeadline(value.retireAfter) &&
    isTaskNotesTaskId(value.taskId) &&
    isTaskNotesOpaque32ByteToken(value.taskIdentityWitness) &&
    value.admitUntil < value.replayUntil &&
    value.replayUntil <= value.retireAfter
  );
}

export function isTaskNotesOperationRecord(value: unknown): value is TaskNotesOperationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = (value as { state?: unknown }).state;
  const baseKeys = [
    'admitUntil',
    'capabilityHash',
    'operationId',
    'principalHash',
    'replayUntil',
    'retireAfter',
    'state',
    'taskId',
    'taskIdentityWitness',
  ];
  const keys =
    state === 'issued'
      ? baseKeys
      : state === 'admitted'
        ? [...baseKeys, 'admittedAt', 'fingerprint']
        : state === 'terminal'
          ? [...baseKeys, 'admittedAt', 'completedAt', 'fingerprint', 'outcome']
          : [];
  if (!isExactRecord(value, keys) || !isTaskNotesOperationRecordBase(value)) return false;
  if (state === 'issued') return true;
  if (
    !isTaskNotesDeadline(value.admittedAt) ||
    !isTaskNotesOpaque32ByteToken(value.fingerprint) ||
    value.admittedAt >= value.admitUntil ||
    value.admittedAt > value.retireAfter
  ) {
    return false;
  }
  return (
    state === 'admitted' ||
    (state === 'terminal' &&
      isTaskNotesDeadline(value.completedAt) &&
      value.admittedAt <= value.completedAt &&
      value.completedAt <= value.retireAfter &&
      isTaskNotesOperationOutcome(value.outcome))
  );
}

export function getTaskNotesOperationRecordBytes(record: TaskNotesOperationRecord): number {
  // Key order does not affect compact JSON byte length. Record guards run before this size check,
  // so the native serializer is an equivalent, substantially leaner byte-count seam.
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}

export function assertTaskNotesOperationRecord(
  record: unknown,
): asserts record is TaskNotesOperationRecord {
  validateTaskNotesOperationRecord(record);
}

function validateTaskNotesOperationRecord(record: unknown): number {
  if (!isTaskNotesOperationRecord(record))
    throw new TypeError('Invalid task notes operation record');
  const bytes = getTaskNotesOperationRecordBytes(record);
  if (bytes > TASK_NOTES_MAX_OPERATION_RECORD_BYTES) {
    throw new RangeError('Task notes operation record exceeds its byte limit');
  }
  return bytes;
}

export function getTaskNotesOperationSegmentBytes(segment: TaskNotesOperationSegment): number {
  let bytes = TASK_NOTES_OPERATION_SEGMENT_PREFIX_BYTES + TASK_NOTES_OPERATION_SEGMENT_SUFFIX_BYTES;
  let index = 0;
  for (const [key, record] of Object.entries(segment.operations)) {
    bytes +=
      (index > 0 ? 1 : 0) +
      Buffer.byteLength(JSON.stringify(key), 'utf8') +
      1 +
      getTaskNotesOperationRecordBytes(record);
    index += 1;
  }
  return bytes;
}

export function assertTaskNotesOperationSegment(
  value: unknown,
): asserts value is TaskNotesOperationSegment {
  if (!isExactRecord(value, ['formatVersion', 'operations'])) {
    throw new TypeError('Invalid task notes operation segment');
  }
  if (value.formatVersion !== TASK_NOTES_OPERATION_SEGMENT_VERSION) {
    throw new TypeError('Unsupported task notes operation segment version');
  }
  if (
    !value.operations ||
    typeof value.operations !== 'object' ||
    Array.isArray(value.operations)
  ) {
    throw new TypeError('Invalid task notes operation map');
  }
  const operationsPrototype = Object.getPrototypeOf(value.operations);
  if (operationsPrototype !== Object.prototype && operationsPrototype !== null) {
    throw new TypeError('Task notes operation map must be a plain record');
  }
  for (const key of Reflect.ownKeys(value.operations)) {
    const descriptor = Object.getOwnPropertyDescriptor(value.operations, key);
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new TypeError('Task notes operation map must contain only own data properties');
    }
  }
  const operations = value.operations as unknown as Record<string, unknown>;
  const entries = Object.entries(operations);
  if (entries.length > TASK_NOTES_MAX_OPERATIONS_PER_WORKSPACE) {
    throw new RangeError('Task notes operation count exceeds its workspace limit');
  }
  const principalCounts = new Map<string, number>();
  let segmentBytes =
    TASK_NOTES_OPERATION_SEGMENT_PREFIX_BYTES + TASK_NOTES_OPERATION_SEGMENT_SUFFIX_BYTES;
  for (const [index, [key, rawRecord]] of entries.entries()) {
    const recordBytes = validateTaskNotesOperationRecord(rawRecord);
    const record = rawRecord as TaskNotesOperationRecord;
    if (key !== operationKey(record.principalHash, record.operationId)) {
      throw new TypeError('Task notes operation key does not match its record');
    }
    const count = (principalCounts.get(record.principalHash) ?? 0) + 1;
    if (count > TASK_NOTES_MAX_OPERATIONS_PER_PRINCIPAL) {
      throw new RangeError('Task notes operation count exceeds its principal limit');
    }
    principalCounts.set(record.principalHash, count);
    segmentBytes +=
      (index > 0 ? 1 : 0) + Buffer.byteLength(JSON.stringify(key), 'utf8') + 1 + recordBytes;
  }
  if (segmentBytes > TASK_NOTES_MAX_OPERATION_SEGMENT_BYTES) {
    throw new RangeError('Task notes operation segment exceeds its byte limit');
  }
}

function isExpired(record: TaskNotesOperationRecord, nowIso: string): boolean {
  return nowIso >= (record.state === 'issued' ? record.admitUntil : record.retireAfter);
}

export function compactExpiredTaskNotesOperations(
  segment: TaskNotesOperationSegment,
  now: number,
  heldOperationKeys: ReadonlySet<string> = new Set(),
): TaskNotesOperationSegment {
  const nowIso = checkedIsoTimestamp(now);
  const operations = Object.fromEntries(
    Object.entries(segment.operations)
      .filter(([key, record]) => heldOperationKeys.has(key) || !isExpired(record, nowIso))
      .map(([key, record]) => [key, cloneRecord(record)]),
  );
  return { formatVersion: TASK_NOTES_OPERATION_SEGMENT_VERSION, operations };
}

function reclaimAcknowledgedOperations(
  segment: TaskNotesOperationSegment,
  principalHash: string,
  acknowledgements: readonly AcknowledgedTaskNotesOperation[],
  heldOperationKeys: ReadonlySet<string>,
): { reclaimedCount: number; segment: TaskNotesOperationSegment } {
  const unique = new Set<string>();
  const operations = { ...segment.operations };
  let reclaimedCount = 0;
  for (const acknowledgement of acknowledgements.slice(0, TASK_NOTES_MAX_ACKNOWLEDGEMENTS)) {
    if (unique.has(acknowledgement.operationId)) continue;
    unique.add(acknowledgement.operationId);
    const key = operationKey(principalHash, acknowledgement.operationId);
    const record = operations[key];
    if (!record || record.state !== 'terminal' || heldOperationKeys.has(key)) continue;
    let capabilityHash: string;
    try {
      capabilityHash = hashTaskNotesCapability(acknowledgement.operationCapability);
    } catch {
      continue;
    }
    if (!constantTimeTokenEqual(record.capabilityHash, capabilityHash)) continue;
    Reflect.deleteProperty(operations, key);
    reclaimedCount += 1;
  }
  return {
    reclaimedCount,
    segment: { formatVersion: TASK_NOTES_OPERATION_SEGMENT_VERSION, operations },
  };
}

function hasOperationCapacity(segment: TaskNotesOperationSegment, principalHash: string): boolean {
  const records = Object.values(segment.operations);
  return (
    records.length < TASK_NOTES_MAX_OPERATIONS_PER_WORKSPACE &&
    records.filter((record) => record.principalHash === principalHash).length <
      TASK_NOTES_MAX_OPERATIONS_PER_PRINCIPAL
  );
}

export function reserveTaskNotesOperation(
  current: TaskNotesOperationSegment,
  request: ReserveTaskNotesOperationRequest,
  heldOperationKeys: ReadonlySet<string> = new Set(),
): ReserveTaskNotesOperationResult {
  assertTaskNotesOperationSegment(current);
  const acknowledgements = request.acknowledgedOperations ?? [];
  const acknowledgementIds = new Set(acknowledgements.map(({ operationId }) => operationId));
  if (
    !isTaskNotesOpaque32ByteToken(request.principalHash) ||
    !isTaskNotesTaskId(request.taskId) ||
    !isTaskNotesOpaque32ByteToken(request.taskIdentityWitness) ||
    acknowledgements.length > TASK_NOTES_MAX_ACKNOWLEDGEMENTS ||
    !acknowledgements.every(isAcknowledgedTaskNotesOperation) ||
    acknowledgementIds.size !== acknowledgements.length
  ) {
    throw new TypeError('Invalid task notes operation reservation');
  }
  let segment = compactExpiredTaskNotesOperations(current, request.now, heldOperationKeys);
  const reclaimed = reclaimAcknowledgedOperations(
    segment,
    request.principalHash,
    acknowledgements,
    heldOperationKeys,
  );
  segment = reclaimed.segment;
  if (!hasOperationCapacity(segment, request.principalHash)) {
    return { kind: 'capacity-exhausted', reclaimedCount: reclaimed.reclaimedCount };
  }

  const randomBytes = request.randomBytes ?? nodeRandomBytes;
  let operationId: string | null = null;
  for (let attempt = 0; attempt < TASK_NOTES_OPERATION_ID_ATTEMPTS; attempt += 1) {
    const bytes = randomBytes(TASK_NOTES_OPERATION_ID_BYTES);
    if (bytes.byteLength !== TASK_NOTES_OPERATION_ID_BYTES) {
      throw new Error('Task notes random source returned the wrong operation ID length');
    }
    const candidate = toCanonicalBase64Url(bytes);
    if (!Object.values(segment.operations).some((record) => record.operationId === candidate)) {
      operationId = candidate;
      break;
    }
  }
  if (!operationId) {
    return { kind: 'identity-collision', reclaimedCount: reclaimed.reclaimedCount };
  }
  const capabilityBytes = randomBytes(TASK_NOTES_CAPABILITY_BYTES);
  if (capabilityBytes.byteLength !== TASK_NOTES_CAPABILITY_BYTES) {
    throw new Error('Task notes random source returned the wrong capability length');
  }
  const operationCapability = toCanonicalBase64Url(capabilityBytes);
  const admitUntil = checkedDeadline(request.now, TASK_NOTES_ADMISSION_WINDOW_MS);
  const replayUntil = checkedDeadline(request.now, TASK_NOTES_REPLAY_WINDOW_MS);
  const record: Extract<TaskNotesOperationRecord, { state: 'issued' }> = {
    admitUntil,
    capabilityHash: hashTaskNotesCapability(operationCapability),
    operationId,
    principalHash: request.principalHash,
    replayUntil,
    retireAfter: replayUntil,
    state: 'issued',
    taskId: request.taskId,
    taskIdentityWitness: request.taskIdentityWitness,
  };
  assertTaskNotesOperationRecord(record);
  const nextSegment: TaskNotesOperationSegment = {
    formatVersion: TASK_NOTES_OPERATION_SEGMENT_VERSION,
    operations: {
      ...segment.operations,
      [operationKey(request.principalHash, operationId)]: record,
    },
  };
  if (getTaskNotesOperationSegmentBytes(nextSegment) > TASK_NOTES_MAX_OPERATION_SEGMENT_BYTES) {
    return { kind: 'capacity-exhausted', reclaimedCount: reclaimed.reclaimedCount };
  }
  assertTaskNotesOperationSegment(nextSegment);
  return {
    kind: 'reserved',
    operation: { operationId, operationCapability, admitUntil, replayUntil },
    record,
    reclaimedCount: reclaimed.reclaimedCount,
    segment: nextSegment,
  };
}

export function classifyTaskNotesOperation(
  record: TaskNotesOperationRecord | undefined,
  args: {
    allowExpiredExactJoin?: boolean;
    now: number;
    principalHash: string;
    request: UpdateTaskNotesRequest;
  },
): ClassifyTaskNotesOperationResult {
  if (!record || record.principalHash !== args.principalHash) {
    return { kind: 'operation-identity-rejected' };
  }
  let capabilityHash: string;
  let fingerprint: string;
  try {
    capabilityHash = hashTaskNotesCapability(args.request.operationCapability);
    fingerprint = createTaskNotesOperationFingerprint(args.request);
  } catch {
    return { kind: 'operation-identity-rejected' };
  }
  if (
    record.operationId !== args.request.operationId ||
    record.taskId !== args.request.taskId ||
    deriveTaskNotesIncarnation(record.taskIdentityWitness) !== args.request.taskIncarnation ||
    !constantTimeTokenEqual(record.capabilityHash, capabilityHash)
  ) {
    return { kind: 'operation-identity-rejected' };
  }
  const nowIso = checkedIsoTimestamp(args.now);
  if (record.state === 'issued') {
    if (nowIso >= record.admitUntil) {
      return { kind: 'operation-expired', expiredAt: record.admitUntil };
    }
    return {
      kind: 'admit',
      fingerprint,
      record: { ...record, admittedAt: nowIso, fingerprint, state: 'admitted' },
    };
  }
  if (!constantTimeTokenEqual(record.fingerprint, fingerprint)) {
    return { kind: 'operation-identity-rejected' };
  }
  if (!args.allowExpiredExactJoin && nowIso >= record.retireAfter) {
    return { kind: 'operation-expired', expiredAt: record.retireAfter };
  }
  return record.state === 'terminal' ? { kind: 'replay', record } : { kind: 'resume', record };
}

export function terminalizeTaskNotesOperation(
  record: Extract<TaskNotesOperationRecord, { state: 'admitted' }>,
  outcome: TaskNotesOperationOutcome,
  now: number,
): Extract<TaskNotesOperationRecord, { state: 'terminal' }> {
  if (!isTaskNotesOperationOutcome(outcome)) throw new TypeError('Invalid task notes outcome');
  const completedAt = checkedIsoTimestamp(now);
  const terminal = {
    ...record,
    completedAt,
    outcome,
    retireAfter: maxDeadline(record.retireAfter, checkedDeadline(now, TASK_NOTES_REPLAY_WINDOW_MS)),
    state: 'terminal' as const,
  };
  assertTaskNotesOperationRecord(terminal);
  return terminal;
}

export function materializeTaskNotesRecoveryWindow(
  record: Exclude<TaskNotesOperationRecord, { state: 'issued' }>,
  repairedAt: number,
): typeof record {
  const repaired = {
    ...record,
    retireAfter: maxDeadline(
      record.retireAfter,
      checkedDeadline(repairedAt, TASK_NOTES_REPLAY_WINDOW_MS),
    ),
  };
  assertTaskNotesOperationRecord(repaired);
  return repaired;
}

export function replaceTaskNotesOperationRecord(
  segment: TaskNotesOperationSegment,
  record: TaskNotesOperationRecord,
): TaskNotesOperationSegment {
  assertTaskNotesOperationRecord(record);
  const key = operationKey(record.principalHash, record.operationId);
  if (!segment.operations[key]) throw new Error('Task notes operation record does not exist');
  const next = {
    formatVersion: TASK_NOTES_OPERATION_SEGMENT_VERSION,
    operations: { ...segment.operations, [key]: record },
  } satisfies TaskNotesOperationSegment;
  assertTaskNotesOperationSegment(next);
  return next;
}

export function findTaskNotesOperationRecord(
  segment: TaskNotesOperationSegment,
  principalHash: string,
  operationId: string,
): TaskNotesOperationRecord | undefined {
  return segment.operations[operationKey(principalHash, operationId)];
}
