import { isRecord } from '../lib/type-guards.js';

export const TASK_CREATION_OPERATION_ID_BYTES = 16;
export const TASK_CREATION_OPERATION_ID_LENGTH = 22;
export const TASK_CREATION_OPERATION_CAPABILITY_BYTES = 32;
export const TASK_CREATION_OPERATION_CAPABILITY_LENGTH = 43;
export const TASK_CREATION_AUTHENTICATION_SESSION_GENERATION_BYTES = 16;
export const TASK_CREATION_TICKET_BOOT_EPOCH_BYTES = 32;
export const TASK_CREATION_TICKET_MAC_BYTES = 32;
export const TASK_CREATION_TICKET_MAX_LENGTH = 1_024;
export const TASK_CREATION_TICKET_TTL_MS = 10 * 60 * 1_000;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CANONICAL_UINT64_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const MAX_UINT64 = 18_446_744_073_709_551_615n;

export type TaskCreationOperationId = string & {
  readonly __taskCreationOperationId: unique symbol;
};

export type TaskCreationOperationCapability = string & {
  readonly __taskCreationOperationCapability: unique symbol;
};

export type TaskCreationAuthEpoch = string & {
  readonly __taskCreationAuthEpoch: unique symbol;
};

export interface TaskCreationTicketAuthenticationContext {
  authEpoch: TaskCreationAuthEpoch;
  authenticationSessionGeneration: Readonly<Uint8Array>;
  workspacePrincipalId: string;
}

export interface IssueTaskCreationOperationTicketResult {
  expiresAt: number;
  issuedAt: number;
  operationId: TaskCreationOperationId;
  operationTicket: string;
}

export interface DecodedTaskCreationOperationTicketV1 {
  authEpoch: TaskCreationAuthEpoch;
  authenticationSessionGeneration: Uint8Array;
  bootEpoch: Uint8Array;
  expiresAtUnixMs: string;
  formatVersion: '1';
  issuedAtUnixMs: string;
  operationId: TaskCreationOperationId;
  purpose: 'task-creation-ticket';
  workspacePrincipalId: string;
}

export type TaskCreationOperationTicketVerification =
  | { decoded: DecodedTaskCreationOperationTicketV1; kind: 'valid' }
  | { kind: 'expired' }
  | { kind: 'invalid' };

export function isCanonicalTaskCreationAuthEpoch(value: unknown): value is TaskCreationAuthEpoch {
  if (typeof value !== 'string' || !CANONICAL_UINT64_PATTERN.test(value)) return false;
  return BigInt(value) <= MAX_UINT64;
}

function isCanonicalBase64UrlBytes(value: unknown, byteLength: number): value is string {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return false;
  const expectedLength = Math.ceil((byteLength * 8) / 6);
  if (value.length !== expectedLength) return false;
  const unusedBits = expectedLength * 6 - byteLength * 8;
  if (unusedBits === 0) return true;
  const finalIndex = BASE64URL_ALPHABET.indexOf(value[value.length - 1] ?? '');
  return finalIndex >= 0 && (finalIndex & ((1 << unusedBits) - 1)) === 0;
}

export function isTaskCreationOperationId(value: unknown): value is TaskCreationOperationId {
  return (
    typeof value === 'string' &&
    value.length === TASK_CREATION_OPERATION_ID_LENGTH &&
    isCanonicalBase64UrlBytes(value, TASK_CREATION_OPERATION_ID_BYTES)
  );
}

export function isTaskCreationOperationCapability(
  value: unknown,
): value is TaskCreationOperationCapability {
  return (
    typeof value === 'string' &&
    value.length === TASK_CREATION_OPERATION_CAPABILITY_LENGTH &&
    isCanonicalBase64UrlBytes(value, TASK_CREATION_OPERATION_CAPABILITY_BYTES)
  );
}

export function isTaskCreationTicketAuthenticationContext(
  value: unknown,
): value is TaskCreationTicketAuthenticationContext {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isCanonicalTaskCreationAuthEpoch(value.authEpoch) &&
    value.authenticationSessionGeneration instanceof Uint8Array &&
    value.authenticationSessionGeneration.byteLength ===
      TASK_CREATION_AUTHENTICATION_SESSION_GENERATION_BYTES &&
    typeof value.workspacePrincipalId === 'string' &&
    value.workspacePrincipalId.length >= 1 &&
    value.workspacePrincipalId.length <= 64 &&
    /^[A-Za-z0-9._:@/-]+$/u.test(value.workspacePrincipalId)
  );
}

export function createTaskCreationAuthEpoch(
  value: bigint | number | string,
): TaskCreationAuthEpoch {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Task-creation auth epoch number must be a non-negative safe integer');
  }
  const encoded = typeof value === 'bigint' ? value.toString() : String(value);
  if (!isCanonicalTaskCreationAuthEpoch(encoded)) {
    throw new Error('Task-creation auth epoch must be a canonical uint64');
  }
  return encoded;
}
