import {
  createHmac,
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

import {
  TASK_CREATION_AUTHENTICATION_SESSION_GENERATION_BYTES,
  TASK_CREATION_OPERATION_CAPABILITY_BYTES,
  TASK_CREATION_OPERATION_ID_BYTES,
  TASK_CREATION_TICKET_BOOT_EPOCH_BYTES,
  TASK_CREATION_TICKET_MAC_BYTES,
  TASK_CREATION_TICKET_MAX_LENGTH,
  TASK_CREATION_TICKET_TTL_MS,
  isCanonicalTaskCreationAuthEpoch,
  isTaskCreationOperationCapability,
  isTaskCreationOperationId,
  isTaskCreationTicketAuthenticationContext,
  type DecodedTaskCreationOperationTicketV1,
  type IssueTaskCreationOperationTicketResult,
  type TaskCreationOperationCapability,
  type TaskCreationOperationId,
  type TaskCreationOperationTicketVerification,
  type TaskCreationTicketAuthenticationContext,
} from '../../src/domain/task-creation-ticket.js';

const TICKET_FORMAT_VERSION = '1';
const TICKET_PURPOSE = 'task-creation-ticket';
const TICKET_FIELD_COUNT = 9;
const ISSUED_ID_LIMIT = 2_048;
const OPERATION_ID_RESAMPLE_LIMIT = 4;
const PRINCIPAL_RATE_PER_MINUTE = 12;
const PRINCIPAL_RATE_BURST = 4;
const WORKSPACE_RATE_PER_MINUTE = 120;
const WORKSPACE_RATE_BURST = 20;
const RATE_BUCKET_LIMIT = 2_048;
const U32_MAX = 0xffff_ffff;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

interface RateBucket {
  lastRefillAt: number;
  tokens: number;
}

export class TaskCreationTicketRateLimitError extends Error {
  readonly code = 'rate-limited';
}

export class TaskCreationTicketIssuerCapacityError extends Error {
  readonly code = 'ticket-issuer-capacity';
}

export interface TaskCreationOperationTicketIssuerOptions {
  bootEpoch?: Readonly<Uint8Array>;
  isOperationIdInUse?: (operationId: TaskCreationOperationId) => boolean | Promise<boolean>;
  now?: () => number;
  randomBytes?: (byteLength: number) => Uint8Array;
  secret?: Readonly<Uint8Array>;
}

export interface VerifyTaskCreationOperationTicketRequest {
  authentication: TaskCreationTicketAuthenticationContext;
  operationId: TaskCreationOperationId;
  operationTicket: string;
}

export interface TaskCreationOperationTicketIssuer {
  createOperationCapability(): TaskCreationOperationCapability;
  hashOperationCapability(capability: TaskCreationOperationCapability): string;
  issue(
    authentication: TaskCreationTicketAuthenticationContext,
  ): Promise<IssueTaskCreationOperationTicketResult>;
  /**
   * Signs a backend-owned operation identity without exposing caller-selected
   * ticket issuance to a transport. Trusted local command facades use this to
   * keep an adapter request id stable across process restarts.
   */
  issueTrustedLocal(
    authentication: TaskCreationTicketAuthenticationContext,
    operationId: TaskCreationOperationId,
  ): IssueTaskCreationOperationTicketResult;
  verify(
    request: VerifyTaskCreationOperationTicketRequest,
  ): TaskCreationOperationTicketVerification;
}

function copyExactBytes(
  value: Readonly<Uint8Array>,
  byteLength: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== byteLength) {
    throw new Error(`${label} must contain exactly ${byteLength} bytes`);
  }
  return Uint8Array.from(value);
}

function randomExactBytes(
  randomBytes: (byteLength: number) => Uint8Array,
  byteLength: number,
  label: string,
): Uint8Array {
  return copyExactBytes(randomBytes(byteLength), byteLength, label);
}

function encodeCanonicalBase64Url(value: Readonly<Uint8Array>): string {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64url');
}

function decodeCanonicalBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) return null;
    return Uint8Array.from(decoded);
  } catch {
    return null;
  }
}

function encodeLengthPrefixedFields(fields: readonly Readonly<Uint8Array>[]): Uint8Array {
  let byteLength = 0;
  for (const field of fields) {
    if (field.byteLength > U32_MAX) throw new Error('Task-creation ticket field exceeds uint32');
    byteLength += 4 + field.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength > TASK_CREATION_TICKET_MAX_LENGTH) {
      throw new Error('Task-creation ticket payload exceeds its byte limit');
    }
  }
  const encoded = new Uint8Array(byteLength);
  const view = new DataView(encoded.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.byteLength, false);
    offset += 4;
    encoded.set(field, offset);
    offset += field.byteLength;
  }
  return encoded;
}

function decodeLengthPrefixedFields(payload: Readonly<Uint8Array>): Uint8Array[] | null {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const fields: Uint8Array[] = [];
  let offset = 0;
  for (let index = 0; index < TICKET_FIELD_COUNT; index += 1) {
    if (offset + 4 > payload.byteLength) return null;
    const fieldLength = view.getUint32(offset, false);
    offset += 4;
    if (offset + fieldLength > payload.byteLength) return null;
    fields.push(payload.slice(offset, offset + fieldLength));
    offset += fieldLength;
  }
  return offset === payload.byteLength ? fields : null;
}

function utf8(value: string): Uint8Array {
  return UTF8_ENCODER.encode(value);
}

function decodeUtf8(value: Readonly<Uint8Array>): string | null {
  try {
    const decoded = UTF8_DECODER.decode(value);
    return Buffer.from(utf8(decoded)).equals(
      Buffer.from(value.buffer, value.byteOffset, value.byteLength),
    )
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function canonicalTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Task-creation ticket timestamps must be non-negative safe integers');
  }
  return String(value);
}

function parseCanonicalTimestamp(value: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === value ? parsed : null;
}

function fixedTimeEqual(left: Readonly<Uint8Array>, right: Readonly<Uint8Array>): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function assertAuthenticationContext(
  authentication: TaskCreationTicketAuthenticationContext,
): void {
  if (!isTaskCreationTicketAuthenticationContext(authentication)) {
    throw new Error('Invalid task-creation ticket authentication context');
  }
}

function decodePayload(payload: Readonly<Uint8Array>): DecodedTaskCreationOperationTicketV1 | null {
  const fields = decodeLengthPrefixedFields(payload);
  if (!fields) return null;
  const strings = fields.slice(0, 7).map(decodeUtf8);
  if (strings.some((value) => value === null)) return null;
  const [
    formatVersion,
    purpose,
    workspacePrincipalId,
    operationId,
    issuedAt,
    expiresAt,
    authEpoch,
  ] = strings as [string, string, string, string, string, string, string];
  const authenticationSessionGeneration = fields[7];
  const bootEpoch = fields[8];
  if (
    formatVersion !== TICKET_FORMAT_VERSION ||
    purpose !== TICKET_PURPOSE ||
    !isTaskCreationOperationId(operationId) ||
    parseCanonicalTimestamp(issuedAt) === null ||
    parseCanonicalTimestamp(expiresAt) === null ||
    !isCanonicalTaskCreationAuthEpoch(authEpoch) ||
    authenticationSessionGeneration?.byteLength !==
      TASK_CREATION_AUTHENTICATION_SESSION_GENERATION_BYTES ||
    bootEpoch?.byteLength !== TASK_CREATION_TICKET_BOOT_EPOCH_BYTES
  ) {
    return null;
  }
  const authentication: TaskCreationTicketAuthenticationContext = {
    authEpoch,
    authenticationSessionGeneration,
    workspacePrincipalId,
  };
  if (!isTaskCreationTicketAuthenticationContext(authentication)) return null;
  return {
    ...authentication,
    bootEpoch,
    expiresAtUnixMs: expiresAt,
    formatVersion: TICKET_FORMAT_VERSION,
    issuedAtUnixMs: issuedAt,
    operationId,
    purpose: TICKET_PURPOSE,
  };
}

function refillBucket(bucket: RateBucket, now: number, ratePerMinute: number, burst: number): void {
  if (now <= bucket.lastRefillAt) return;
  const elapsed = Math.max(0, now - bucket.lastRefillAt);
  bucket.tokens = Math.min(burst, bucket.tokens + (elapsed * ratePerMinute) / 60_000);
  bucket.lastRefillAt = now;
}

class TicketIssueLimiter {
  private readonly principalBuckets = new Map<string, RateBucket>();
  private readonly workspaceBucket: RateBucket = {
    lastRefillAt: 0,
    tokens: WORKSPACE_RATE_BURST,
  };

  admit(principalId: string, now: number): void {
    let principal = this.principalBuckets.get(principalId);
    if (!principal) {
      if (this.principalBuckets.size >= RATE_BUCKET_LIMIT) {
        this.compact(now);
      }
      if (this.principalBuckets.size >= RATE_BUCKET_LIMIT) {
        throw new TaskCreationTicketRateLimitError('Task-creation ticket issuer is rate limited');
      }
      principal = { lastRefillAt: now, tokens: PRINCIPAL_RATE_BURST };
      this.principalBuckets.set(principalId, principal);
    }
    refillBucket(principal, now, PRINCIPAL_RATE_PER_MINUTE, PRINCIPAL_RATE_BURST);
    refillBucket(this.workspaceBucket, now, WORKSPACE_RATE_PER_MINUTE, WORKSPACE_RATE_BURST);
    if (principal.tokens < 1 || this.workspaceBucket.tokens < 1) {
      throw new TaskCreationTicketRateLimitError('Task-creation ticket issuer is rate limited');
    }
    principal.tokens -= 1;
    this.workspaceBucket.tokens -= 1;
  }

  private compact(now: number): void {
    for (const [principalId, bucket] of this.principalBuckets) {
      const idleSince = bucket.lastRefillAt;
      refillBucket(bucket, now, PRINCIPAL_RATE_PER_MINUTE, PRINCIPAL_RATE_BURST);
      if (bucket.tokens === PRINCIPAL_RATE_BURST && now - idleSince >= 60_000) {
        this.principalBuckets.delete(principalId);
      }
    }
  }
}

export function createTaskCreationAuthenticationSessionGeneration(
  randomBytes: (byteLength: number) => Uint8Array = nodeRandomBytes,
): Uint8Array {
  return randomExactBytes(
    randomBytes,
    TASK_CREATION_AUTHENTICATION_SESSION_GENERATION_BYTES,
    'authentication session generation',
  );
}

export function createTaskCreationOperationTicketIssuer(
  options: TaskCreationOperationTicketIssuerOptions = {},
): TaskCreationOperationTicketIssuer {
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const now = options.now ?? Date.now;
  const secret = options.secret
    ? copyExactBytes(options.secret, TASK_CREATION_TICKET_MAC_BYTES, 'ticket secret')
    : randomExactBytes(randomBytes, TASK_CREATION_TICKET_MAC_BYTES, 'ticket secret');
  const bootEpoch = options.bootEpoch
    ? copyExactBytes(options.bootEpoch, TASK_CREATION_TICKET_BOOT_EPOCH_BYTES, 'ticket boot epoch')
    : randomExactBytes(randomBytes, TASK_CREATION_TICKET_BOOT_EPOCH_BYTES, 'ticket boot epoch');
  const issuedIds = new Map<TaskCreationOperationId, number>();
  const limiter = new TicketIssueLimiter();

  function pruneIssuedIds(currentTime: number): void {
    for (const [operationId, expiresAt] of issuedIds) {
      if (currentTime >= expiresAt) issuedIds.delete(operationId);
    }
  }

  function signOperationTicket(
    authentication: TaskCreationTicketAuthenticationContext,
    operationId: TaskCreationOperationId,
    issuedAt: number,
  ): IssueTaskCreationOperationTicketResult {
    const expiresAt = issuedAt + TASK_CREATION_TICKET_TTL_MS;
    canonicalTimestamp(expiresAt);
    const fields = [
      utf8(TICKET_FORMAT_VERSION),
      utf8(TICKET_PURPOSE),
      utf8(authentication.workspacePrincipalId),
      utf8(operationId),
      utf8(String(issuedAt)),
      utf8(String(expiresAt)),
      utf8(authentication.authEpoch),
      authentication.authenticationSessionGeneration,
      bootEpoch,
    ];
    const payload = encodeLengthPrefixedFields(fields);
    const mac = createHmac('sha256', secret).update(payload).digest();
    const operationTicket = `${encodeCanonicalBase64Url(payload)}.${mac.toString('base64url')}`;
    if (operationTicket.length > TASK_CREATION_TICKET_MAX_LENGTH) {
      throw new Error('Task-creation ticket exceeds its encoded length limit');
    }
    issuedIds.set(operationId, expiresAt);
    return { expiresAt, issuedAt, operationId, operationTicket };
  }

  async function issue(
    authentication: TaskCreationTicketAuthenticationContext,
  ): Promise<IssueTaskCreationOperationTicketResult> {
    assertAuthenticationContext(authentication);
    const issuedAt = now();
    canonicalTimestamp(issuedAt);
    limiter.admit(authentication.workspacePrincipalId, issuedAt);
    pruneIssuedIds(issuedAt);
    if (issuedIds.size >= ISSUED_ID_LIMIT) {
      throw new TaskCreationTicketIssuerCapacityError(
        'Task-creation ticket issuer has reached its live ID capacity',
      );
    }

    let operationId: TaskCreationOperationId | null = null;
    for (let attempt = 0; attempt < OPERATION_ID_RESAMPLE_LIMIT; attempt += 1) {
      const candidate = encodeCanonicalBase64Url(
        randomExactBytes(randomBytes, TASK_CREATION_OPERATION_ID_BYTES, 'operation ID'),
      ) as TaskCreationOperationId;
      if (!isTaskCreationOperationId(candidate) || issuedIds.has(candidate)) continue;
      if (await options.isOperationIdInUse?.(candidate)) continue;
      operationId = candidate;
      break;
    }
    if (operationId === null) {
      throw new TaskCreationTicketIssuerCapacityError(
        'Task-creation ticket issuer could not allocate a unique operation ID',
      );
    }

    return signOperationTicket(authentication, operationId, issuedAt);
  }

  function verify(
    request: VerifyTaskCreationOperationTicketRequest,
  ): TaskCreationOperationTicketVerification {
    const currentTime = now();
    if (
      !Number.isSafeInteger(currentTime) ||
      currentTime < 0 ||
      !isTaskCreationOperationId(request.operationId) ||
      !isTaskCreationTicketAuthenticationContext(request.authentication) ||
      typeof request.operationTicket !== 'string' ||
      request.operationTicket.length > TASK_CREATION_TICKET_MAX_LENGTH
    ) {
      return { kind: 'invalid' };
    }
    const segments = request.operationTicket.split('.');
    if (segments.length !== 2) return { kind: 'invalid' };
    const payload = decodeCanonicalBase64Url(segments[0] ?? '');
    const receivedMac = decodeCanonicalBase64Url(segments[1] ?? '');
    if (!payload || receivedMac?.byteLength !== TASK_CREATION_TICKET_MAC_BYTES) {
      return { kind: 'invalid' };
    }
    const decoded = decodePayload(payload);
    if (!decoded) return { kind: 'invalid' };
    const issuedAt = parseCanonicalTimestamp(decoded.issuedAtUnixMs);
    const expiresAt = parseCanonicalTimestamp(decoded.expiresAtUnixMs);
    if (
      issuedAt === null ||
      expiresAt === null ||
      expiresAt - issuedAt !== TASK_CREATION_TICKET_TTL_MS
    ) {
      return { kind: 'invalid' };
    }
    const expectedMac = createHmac('sha256', secret).update(payload).digest();
    if (!fixedTimeEqual(receivedMac, expectedMac)) return { kind: 'invalid' };
    if (
      decoded.workspacePrincipalId !== request.authentication.workspacePrincipalId ||
      decoded.operationId !== request.operationId ||
      decoded.authEpoch !== request.authentication.authEpoch ||
      !fixedTimeEqual(
        decoded.authenticationSessionGeneration,
        request.authentication.authenticationSessionGeneration,
      ) ||
      !fixedTimeEqual(decoded.bootEpoch, bootEpoch) ||
      currentTime < issuedAt
    ) {
      return { kind: 'invalid' };
    }
    return currentTime >= expiresAt ? { kind: 'expired' } : { decoded, kind: 'valid' };
  }

  return {
    createOperationCapability(): TaskCreationOperationCapability {
      return encodeCanonicalBase64Url(
        randomExactBytes(
          randomBytes,
          TASK_CREATION_OPERATION_CAPABILITY_BYTES,
          'operation capability',
        ),
      ) as TaskCreationOperationCapability;
    },
    hashOperationCapability(capability): string {
      if (!isTaskCreationOperationCapability(capability)) {
        throw new Error('Invalid task-creation operation capability');
      }
      const bytes = decodeCanonicalBase64Url(capability);
      if (!bytes) throw new Error('Invalid task-creation operation capability');
      return createHash('sha256').update(bytes).digest('hex');
    },
    issue,
    issueTrustedLocal(authentication, operationId) {
      assertAuthenticationContext(authentication);
      if (!isTaskCreationOperationId(operationId)) {
        throw new Error('Invalid trusted-local task-creation operation ID');
      }
      const issuedAt = now();
      canonicalTimestamp(issuedAt);
      pruneIssuedIds(issuedAt);
      if (!issuedIds.has(operationId) && issuedIds.size >= ISSUED_ID_LIMIT) {
        throw new TaskCreationTicketIssuerCapacityError(
          'Task-creation ticket issuer has reached its live ID capacity',
        );
      }
      return signOperationTicket(authentication, operationId, issuedAt);
    },
    verify,
  };
}
