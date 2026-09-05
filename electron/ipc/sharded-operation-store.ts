import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../src/lib/type-guards.js';
import {
  canonicalJsonStringify,
  type JsonObject,
  type JsonValue,
} from './workspace-state-storage.js';

export const SHARDED_OPERATION_STORE_LAYOUT_VERSION = 1;
export const SHARDED_OPERATION_STORE_RECORD_FORMAT_VERSION = 1;
export const SHARDED_OPERATION_STORE_INDEX_FORMAT_VERSION = 1;
export const SHARDED_OPERATION_STORE_SHARD_COUNT = 256;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LAYOUT_FILE_NAME = 'layout-v1.json';
const LAYOUT_PENDING_FILE_NAME = `${LAYOUT_FILE_NAME}.pending`;
const INDEX_FILE_NAME = 'index-v1.json';
const INDEX_PENDING_FILE_NAME = `${INDEX_FILE_NAME}.pending`;
const FINAL_NAME_PATTERN = /^[a-f0-9]{62}$/u;
const PENDING_NAME_PATTERN = /^([a-f0-9]{62})\.pending$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CANONICAL_SHARD_NAMES = Object.freeze(
  Array.from({ length: SHARDED_OPERATION_STORE_SHARD_COUNT }, (_, index) =>
    index.toString(16).padStart(2, '0'),
  ),
);
const CANONICAL_SHARD_NAME_SET = new Set(CANONICAL_SHARD_NAMES);

export type ShardedOperationStoreHealth =
  | 'uninitialized'
  | 'activation-required'
  | 'healthy'
  | 'durability-repair-required'
  | 'recovery-required'
  | 'closed';

export type ShardedOperationStoreFaultPoint =
  | 'after-root-fsync-before-enumeration'
  | 'after-shards-created-before-root-fsync'
  | 'after-layout-pending-fsync'
  | 'after-layout-rename'
  | 'after-layout-root-fsync'
  | 'after-record-pending-open'
  | 'after-record-pending-write'
  | 'after-record-pending-fsync'
  | 'after-record-rename'
  | 'after-record-shard-fsync'
  | 'after-index-pending-fsync'
  | 'after-index-rename'
  | 'after-index-root-fsync'
  | 'after-record-unlink'
  | 'after-record-unlink-shard-fsync'
  | 'before-lock-release-read'
  | 'before-lock-release-unlink'
  | 'before-lock-release-directory-fsync';

export interface ShardedOperationRecordCodec<Payload extends object> {
  decodePayload(value: unknown): Payload;
  getCanonicalKey(payload: Payload): string;
  getChargedBytes(payload: Payload): number;
  getRecordVersion(payload: Payload): number;
}

export interface ShardedOperationStoreLimits {
  maxChargedBytes: number;
  maxIndexBytes: number;
  maxRecordCount: number;
  maxRecordEnvelopeBytes: number;
}

export interface ShardedOperationStoreOptions<Payload extends object> {
  codec: ShardedOperationRecordCodec<Payload>;
  faultInjector?: (point: ShardedOperationStoreFaultPoint) => Promise<void> | void;
  journalKind: string;
  limits: ShardedOperationStoreLimits;
  rootPath: string;
}

export interface ShardedOperationStoreCounts {
  chargedBytes: number;
  records: number;
}

export type ShardedOperationStoreCommitResult =
  | { kind: 'committed' | 'already-current' }
  | { cause: unknown; kind: 'not-committed' }
  | { cause: unknown; kind: 'durability-repair-required' }
  | { cause: unknown; kind: 'recovery-required' };

export type ShardedOperationStoreDeleteResult =
  | { kind: 'deleted' | 'already-absent' }
  | { cause: unknown; kind: 'not-deleted' }
  | { cause: unknown; kind: 'durability-repair-required' }
  | { cause: unknown; kind: 'recovery-required' };

export interface ShardedOperationStoreStartupResult {
  health: ShardedOperationStoreHealth;
  topologyEpoch?: string;
}

export interface ShardedOperationStore<Payload extends object> {
  readonly rootPath: string;
  activateFresh(): Promise<ShardedOperationStoreStartupResult>;
  activateFromLegacy(
    records: readonly Payload[],
    legacyDigest: string,
  ): Promise<ShardedOperationStoreStartupResult>;
  close(): Promise<void>;
  compact(
    predicate: (payload: Readonly<Payload>) => boolean,
  ): Promise<{ deleted: number; retained: number }>;
  delete(canonicalKey: string, expectedVersion: number): Promise<ShardedOperationStoreDeleteResult>;
  flushDerivedIndex(): Promise<boolean>;
  get(canonicalKey: string): Payload | null;
  getCounts(): ShardedOperationStoreCounts;
  getHealth(): ShardedOperationStoreHealth;
  getTopologyEpoch(): string | null;
  hasKeyDigest(keyDigest: string): boolean;
  list(): Payload[];
  repairDurability(): Promise<boolean>;
  save(
    payload: Payload,
    expectedVersion: number | null,
  ): Promise<ShardedOperationStoreCommitResult>;
  startup(): Promise<ShardedOperationStoreStartupResult>;
}

interface RecordEnvelope {
  formatVersion: typeof SHARDED_OPERATION_STORE_RECORD_FORMAT_VERSION;
  keyDigest: string;
  layoutVersion: typeof SHARDED_OPERATION_STORE_LAYOUT_VERSION;
  payload: JsonObject;
  payloadDigest: string;
  prior: RecordWitness | null;
  recordVersion: number;
}

interface RecordWitness {
  payloadDigest: string;
  recordVersion: number;
}

interface LayoutMarker {
  formatVersion: 1;
  journalKind: string;
  layoutVersion: typeof SHARDED_OPERATION_STORE_LAYOUT_VERSION;
  legacyDigest: string | null;
  payloadDigest: string;
}

interface DerivedIndexEntry extends RecordWitness {
  chargedBytes: number;
  encodedBytes: number;
  keyDigest: string;
}

interface DerivedIndexDocument {
  entries: DerivedIndexEntry[];
  formatVersion: typeof SHARDED_OPERATION_STORE_INDEX_FORMAT_VERSION;
  layoutDigest: string;
  payloadDigest: string;
}

interface LoadedRecord<Payload extends object> {
  chargedBytes: number;
  encodedBytes: number;
  envelope: RecordEnvelope;
  payload: Payload;
}

interface PendingDurability<Payload extends object> {
  kind: 'delete' | 'save';
  keyDigest: string;
  proposed?: LoadedRecord<Payload>;
}

interface ProcessLock {
  lockPath: string;
  lockRemoved: boolean;
  releasePending: boolean;
  releasePromise: Promise<void> | null;
  token: string;
}

const PROCESS_LOCKS = new Map<string, ProcessLock>();

function canonicalDigest(value: JsonValue): string {
  return createHash('sha256').update(canonicalJsonStringify(value)).digest('hex');
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function assertCanonicalKey(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    value.includes('\u0000')
  ) {
    throw new Error('Sharded operation key must contain 1..512 UTF-8 bytes without NUL');
  }
}

export function deriveShardedOperationKeyDigest(journalKind: string, canonicalKey: string): string {
  assertCanonicalKey(canonicalKey);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(journalKind)) {
    throw new Error('Sharded journal kind is invalid');
  }
  const domain = Buffer.from(`parallel-code:${journalKind}:key:v1`, 'utf8');
  const key = Buffer.from(canonicalKey, 'utf8');
  const framing = Buffer.allocUnsafe(4);
  framing.writeUInt32BE(key.byteLength);
  return createHash('sha256').update(domain).update(framing).update(key).digest('hex');
}

function recordPath(rootPath: string, keyDigest: string): string {
  return path.join(rootPath, keyDigest.slice(0, 2), keyDigest.slice(2));
}

function pendingPath(rootPath: string, keyDigest: string): string {
  return `${recordPath(rootPath, keyDigest)}.pending`;
}

async function ensureDirectory(directoryPath: string): Promise<void> {
  await fs.promises.mkdir(directoryPath, { mode: DIRECTORY_MODE, recursive: true });
  const stat = await fs.promises.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Sharded operation path is not a real directory: ${directoryPath}`);
  }
  await fs.promises.chmod(directoryPath, DIRECTORY_MODE).catch(() => {});
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.promises.open(directoryPath, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeNewFile(filePath: string, contents: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'wx', FILE_MODE);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function acquireProcessLock(
  identity: string,
  lockPath: string,
  onAcquired: () => void,
): Promise<void> {
  const held = PROCESS_LOCKS.get(identity);
  if (held) {
    throw new Error(
      held.releasePending
        ? 'Sharded operation store lock release requires an exact retry'
        : 'Sharded operation store is already open in this process',
    );
  }
  const token = randomUUID();
  const encoded = canonicalJsonStringify({ pid: process.pid, token });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeNewFile(lockPath, encoded);
      PROCESS_LOCKS.set(identity, {
        lockPath,
        lockRemoved: false,
        releasePending: false,
        releasePromise: null,
        token,
      });
      onAcquired();
      await fsyncDirectory(path.dirname(lockPath));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const before = await fs.promises.lstat(lockPath);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error('Invalid lock kind');
        const parsed: unknown = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
        const after = await fs.promises.lstat(lockPath);
        if (before.dev !== after.dev || before.ino !== after.ino) {
          throw new Error('Sharded operation store lock changed while read');
        }
        stale = isRecord(parsed) && typeof parsed.pid === 'number' && !processAlive(parsed.pid);
        if (!stale) throw new Error('Sharded operation store is already open');
        const beforeDelete = await fs.promises.lstat(lockPath);
        if (before.dev !== beforeDelete.dev || before.ino !== beforeDelete.ino) {
          throw new Error('Sharded operation store lock changed before stale cleanup');
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw readError;
      }
      await fs.promises.unlink(lockPath);
      await fsyncDirectory(path.dirname(lockPath));
    }
  }
  throw new Error('Could not acquire sharded operation store lock');
}

async function releaseProcessLock(
  identity: string,
  injectFault: (point: ShardedOperationStoreFaultPoint) => Promise<void>,
): Promise<void> {
  const held = PROCESS_LOCKS.get(identity);
  if (!held) return;
  if (held.releasePromise) return held.releasePromise;
  held.releasePending = true;

  const releasePromise = (async () => {
    if (!held.lockRemoved) {
      await injectFault('before-lock-release-read');
      try {
        const parsed: unknown = JSON.parse(await fs.promises.readFile(held.lockPath, 'utf8'));
        if (!isRecord(parsed) || parsed.pid !== process.pid || parsed.token !== held.token) {
          throw new Error('Sharded operation store lock ownership changed');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        held.lockRemoved = true;
      }

      if (!held.lockRemoved) {
        await injectFault('before-lock-release-unlink');
        try {
          await fs.promises.unlink(held.lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        held.lockRemoved = true;
      }
    }

    await injectFault('before-lock-release-directory-fsync');
    await fsyncDirectory(path.dirname(held.lockPath));
    if (PROCESS_LOCKS.get(identity) !== held) {
      throw new Error('Sharded operation store lock ownership changed');
    }
    PROCESS_LOCKS.delete(identity);
  })();
  held.releasePromise = releasePromise;
  try {
    await releasePromise;
  } finally {
    if (PROCESS_LOCKS.get(identity) === held && held.releasePromise === releasePromise) {
      held.releasePromise = null;
    }
  }
}

function createRecordEnvelope<Payload extends object>(
  keyDigest: string,
  payload: Payload,
  codec: ShardedOperationRecordCodec<Payload>,
  prior: RecordWitness | null,
): RecordEnvelope {
  return {
    formatVersion: SHARDED_OPERATION_STORE_RECORD_FORMAT_VERSION,
    keyDigest,
    layoutVersion: SHARDED_OPERATION_STORE_LAYOUT_VERSION,
    payload: payload as JsonObject,
    payloadDigest: canonicalDigest(payload as JsonObject),
    prior,
    recordVersion: codec.getRecordVersion(payload),
  };
}

function recordWitness(envelope: RecordEnvelope): RecordWitness {
  return { payloadDigest: envelope.payloadDigest, recordVersion: envelope.recordVersion };
}

function sameWitness(left: RecordWitness, right: RecordWitness): boolean {
  return left.payloadDigest === right.payloadDigest && left.recordVersion === right.recordVersion;
}

function decodeRecordEnvelope<Payload extends object>(
  contents: string,
  expectedKeyDigest: string,
  journalKind: string,
  codec: ShardedOperationRecordCodec<Payload>,
  limits: ShardedOperationStoreLimits,
): LoadedRecord<Payload> {
  const encodedBytes = Buffer.byteLength(contents, 'utf8');
  if (encodedBytes > limits.maxRecordEnvelopeBytes) {
    throw new Error('Sharded operation record exceeds its byte limit');
  }
  const value: unknown = JSON.parse(contents);
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'formatVersion',
      'keyDigest',
      'layoutVersion',
      'payload',
      'payloadDigest',
      'prior',
      'recordVersion',
    ]) ||
    value.formatVersion !== SHARDED_OPERATION_STORE_RECORD_FORMAT_VERSION ||
    value.keyDigest !== expectedKeyDigest ||
    value.layoutVersion !== SHARDED_OPERATION_STORE_LAYOUT_VERSION ||
    !isRecord(value.payload) ||
    !isDigest(value.payloadDigest) ||
    (value.prior !== null &&
      (!isRecord(value.prior) ||
        !hasOnlyKeys(value.prior, ['payloadDigest', 'recordVersion']) ||
        !isDigest(value.prior.payloadDigest) ||
        !isSafePositiveInteger(value.prior.recordVersion))) ||
    !isSafePositiveInteger(value.recordVersion)
  ) {
    throw new Error('Invalid sharded operation record envelope');
  }
  const envelope = value as unknown as RecordEnvelope;
  if (envelope.prior && envelope.prior.recordVersion + 1 !== envelope.recordVersion) {
    throw new Error('Sharded operation record prior version is not adjacent');
  }
  const payload = codec.decodePayload(envelope.payload);
  const canonicalKey = codec.getCanonicalKey(payload);
  if (
    deriveShardedOperationKeyDigest(journalKind, canonicalKey) !== expectedKeyDigest ||
    codec.getRecordVersion(payload) !== envelope.recordVersion ||
    canonicalDigest(payload as JsonObject) !== envelope.payloadDigest
  ) {
    throw new Error('Sharded operation record payload witness mismatch');
  }
  if (canonicalJsonStringify(envelope as unknown as JsonObject) !== contents) {
    throw new Error('Sharded operation record is not canonically encoded');
  }
  const chargedBytes = codec.getChargedBytes(payload);
  if (!isSafeNonNegativeInteger(chargedBytes)) {
    throw new Error('Sharded operation record charge is invalid');
  }
  return { chargedBytes, encodedBytes, envelope, payload };
}

function decodePendingEnvelope<Payload extends object>(
  contents: string,
  expectedKeyDigest: string,
  journalKind: string,
  codec: ShardedOperationRecordCodec<Payload>,
  limits: ShardedOperationStoreLimits,
): LoadedRecord<Payload> {
  return decodeRecordEnvelope(contents, expectedKeyDigest, journalKind, codec, limits);
}

function createLayoutMarker(journalKind: string, legacyDigest: string | null): LayoutMarker {
  const base: Omit<LayoutMarker, 'payloadDigest'> = {
    formatVersion: 1 as const,
    journalKind,
    layoutVersion: SHARDED_OPERATION_STORE_LAYOUT_VERSION,
    legacyDigest,
  };
  return { ...base, payloadDigest: canonicalDigest(base) };
}

function decodeLayoutMarker(contents: string, journalKind: string): LayoutMarker {
  if (Buffer.byteLength(contents, 'utf8') > 4_096) {
    throw new Error('Sharded operation layout marker exceeds its byte limit');
  }
  const value: unknown = JSON.parse(contents);
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'formatVersion',
      'journalKind',
      'layoutVersion',
      'legacyDigest',
      'payloadDigest',
    ]) ||
    value.formatVersion !== 1 ||
    value.journalKind !== journalKind ||
    value.layoutVersion !== SHARDED_OPERATION_STORE_LAYOUT_VERSION ||
    (value.legacyDigest !== null && !isDigest(value.legacyDigest)) ||
    !isDigest(value.payloadDigest)
  ) {
    throw new Error('Invalid sharded operation layout marker');
  }
  const marker = value as unknown as LayoutMarker;
  const expected = createLayoutMarker(journalKind, marker.legacyDigest);
  if (
    marker.payloadDigest !== expected.payloadDigest ||
    contents !== canonicalJsonStringify(marker as unknown as JsonObject)
  ) {
    throw new Error('Sharded operation layout marker digest or encoding mismatch');
  }
  return marker;
}

async function readUtf8Bounded(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error(`Invalid or oversized sharded operation file ${path.basename(filePath)}`);
  }
  return fs.promises.readFile(filePath, 'utf8');
}

async function mapBatched<T>(
  values: readonly T[],
  batchSize: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < values.length; offset += batchSize) {
    await Promise.all(values.slice(offset, offset + batchSize).map(operation));
  }
}

class FileShardedOperationStore<Payload extends object> implements ShardedOperationStore<Payload> {
  readonly rootPath: string;

  private readonly codec: ShardedOperationRecordCodec<Payload>;
  private readonly faultInjector: ShardedOperationStoreOptions<Payload>['faultInjector'];
  private readonly indexPath: string;
  private readonly indexPendingPath: string;
  private readonly journalKind: string;
  private readonly layoutPath: string;
  private readonly layoutPendingPath: string;
  private readonly limits: ShardedOperationStoreLimits;
  private readonly lockPath: string;
  private readonly parentPath: string;
  private canonicalIdentity: string | null = null;
  private chargedBytes = 0;
  private closePromise: Promise<void> | null = null;
  private closeRequested = false;
  private health: ShardedOperationStoreHealth = 'uninitialized';
  private indexDirty = false;
  private lockAcquired = false;
  private pendingDurability: PendingDurability<Payload> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly recordsByDigest = new Map<string, LoadedRecord<Payload>>();
  private readonly digestByCanonicalKey = new Map<string, string>();
  private topologyEpoch: string | null = null;

  constructor(options: ShardedOperationStoreOptions<Payload>) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(options.journalKind)) {
      throw new Error('Sharded journal kind is invalid');
    }
    for (const value of Object.values(options.limits)) {
      if (!isSafePositiveInteger(value)) throw new Error('Sharded journal limit is invalid');
    }
    this.rootPath = path.resolve(options.rootPath);
    this.parentPath = path.dirname(this.rootPath);
    this.lockPath = `${this.rootPath}.lock`;
    this.layoutPath = path.join(this.rootPath, LAYOUT_FILE_NAME);
    this.layoutPendingPath = path.join(this.rootPath, LAYOUT_PENDING_FILE_NAME);
    this.indexPath = path.join(this.rootPath, INDEX_FILE_NAME);
    this.indexPendingPath = path.join(this.rootPath, INDEX_PENDING_FILE_NAME);
    this.codec = options.codec;
    this.faultInjector = options.faultInjector;
    this.journalKind = options.journalKind;
    this.limits = options.limits;
  }

  activateFresh(): Promise<ShardedOperationStoreStartupResult> {
    return this.enqueueAdmitted(() => this.activate(null, []));
  }

  activateFromLegacy(
    records: readonly Payload[],
    legacyDigest: string,
  ): Promise<ShardedOperationStoreStartupResult> {
    if (!isDigest(legacyDigest)) {
      return Promise.reject(new Error('Legacy journal digest must be canonical SHA-256'));
    }
    return this.enqueueAdmitted(() => this.activate(legacyDigest, records));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    const closePromise = (async () => {
      await this.queue.catch(() => undefined);
      if (this.health === 'healthy' && this.indexDirty) {
        await this.flushDerivedIndexDirect().catch(() => false);
      }
      this.health = 'closed';
      this.topologyEpoch = null;
      if (this.lockAcquired && this.canonicalIdentity) {
        await releaseProcessLock(this.canonicalIdentity, (point) => this.inject(point));
        this.lockAcquired = false;
      }
    })().catch((error: unknown) => {
      if (this.closePromise === closePromise) this.closePromise = null;
      throw error;
    });
    this.closePromise = closePromise;
    return closePromise;
  }

  compact(
    predicate: (payload: Readonly<Payload>) => boolean,
  ): Promise<{ deleted: number; retained: number }> {
    return this.enqueueAdmitted(async () => {
      this.assertHealthy();
      let deleted = 0;
      const candidates = [...this.recordsByDigest.values()].filter((entry) =>
        predicate(structuredClone(entry.payload)),
      );
      for (const candidate of candidates) {
        const result = await this.deleteDirect(
          this.codec.getCanonicalKey(candidate.payload),
          candidate.envelope.recordVersion,
        );
        if (result.kind === 'deleted') deleted += 1;
        else if (result.kind !== 'already-absent') break;
      }
      return { deleted, retained: this.recordsByDigest.size };
    });
  }

  delete(
    canonicalKey: string,
    expectedVersion: number,
  ): Promise<ShardedOperationStoreDeleteResult> {
    return this.enqueueAdmitted(() => this.deleteDirect(canonicalKey, expectedVersion));
  }

  flushDerivedIndex(): Promise<boolean> {
    return this.enqueueAdmitted(() => this.flushDerivedIndexDirect());
  }

  get(canonicalKey: string): Payload | null {
    assertCanonicalKey(canonicalKey);
    const digest = this.digestByCanonicalKey.get(canonicalKey);
    const payload = digest ? this.recordsByDigest.get(digest)?.payload : undefined;
    return payload ? structuredClone(payload) : null;
  }

  getCounts(): ShardedOperationStoreCounts {
    return { chargedBytes: this.chargedBytes, records: this.recordsByDigest.size };
  }

  getHealth(): ShardedOperationStoreHealth {
    return this.health;
  }

  getTopologyEpoch(): string | null {
    return this.topologyEpoch;
  }

  hasKeyDigest(keyDigest: string): boolean {
    return isDigest(keyDigest) && this.recordsByDigest.has(keyDigest);
  }

  list(): Payload[] {
    return [...this.recordsByDigest.values()]
      .sort((left, right) => left.envelope.keyDigest.localeCompare(right.envelope.keyDigest))
      .map((entry) => structuredClone(entry.payload));
  }

  repairDurability(): Promise<boolean> {
    return this.enqueueAdmitted(async () => {
      if (this.health !== 'durability-repair-required' || !this.pendingDurability) return false;
      const pending = this.pendingDurability;
      try {
        const shardPath = path.join(this.rootPath, pending.keyDigest.slice(0, 2));
        await fsyncDirectory(shardPath);
        if (pending.kind === 'save' && pending.proposed) {
          const observed = await this.readFinal(pending.keyDigest);
          if (!observed || !sameWitness(observed.envelope, pending.proposed.envelope)) {
            throw new Error('Proposed record changed before durability repair');
          }
          this.installLoaded(observed);
        } else if (await this.readFinal(pending.keyDigest)) {
          throw new Error('Deleted record reappeared before durability repair');
        } else {
          this.removeLoaded(pending.keyDigest);
        }
        await this.removePendingIfPresent(pending.keyDigest, true);
        this.pendingDurability = null;
        this.health = 'healthy';
        return true;
      } catch {
        this.health = 'recovery-required';
        this.topologyEpoch = null;
        return false;
      }
    });
  }

  save(
    payload: Payload,
    expectedVersion: number | null,
  ): Promise<ShardedOperationStoreCommitResult> {
    return this.enqueueAdmitted(() => this.saveDirect(payload, expectedVersion));
  }

  startup(): Promise<ShardedOperationStoreStartupResult> {
    return this.enqueueAdmitted(() => this.startupDirect());
  }

  private async activate(
    legacyDigest: string | null,
    records: readonly Payload[],
  ): Promise<ShardedOperationStoreStartupResult> {
    if (this.health === 'closed') throw new Error('Sharded operation store is closed');
    await this.ensureLock();
    await ensureDirectory(this.rootPath);

    try {
      const marker = await this.readLayoutMarkerIfPresent();
      if (marker) {
        if (marker.legacyDigest !== legacyDigest) {
          throw new Error('Activated sharded layout has a different migration witness');
        }
        return this.startupDirect();
      }

      await this.cleanPreActivationLayout(legacyDigest !== null);
      const existing = new Set(await fs.promises.readdir(this.rootPath));
      for (const shardName of CANONICAL_SHARD_NAMES) {
        if (existing.has(shardName)) continue;
        await fs.promises.mkdir(path.join(this.rootPath, shardName), { mode: DIRECTORY_MODE });
      }
      await this.inject('after-shards-created-before-root-fsync');
      await fsyncDirectory(this.rootPath);
      await this.assertExactRootEntries(false);
      await mapBatched(CANONICAL_SHARD_NAMES, 32, (shardName) =>
        fsyncDirectory(path.join(this.rootPath, shardName)),
      );

      this.clearMemoryIndex();
      if (records.length > 0) {
        const loaded = records.map((payload) => this.prepareLoaded(payload));
        this.assertAggregateLimits(loaded);
        for (const entry of loaded) {
          const finalPath = recordPath(this.rootPath, entry.envelope.keyDigest);
          await writeNewFile(
            finalPath,
            canonicalJsonStringify(entry.envelope as unknown as JsonObject),
          );
        }
        await mapBatched(CANONICAL_SHARD_NAMES, 32, (shardName) =>
          fsyncDirectory(path.join(this.rootPath, shardName)),
        );
        for (const entry of loaded) {
          const observed = await this.readFinal(entry.envelope.keyDigest);
          if (!observed || !sameWitness(observed.envelope, entry.envelope)) {
            throw new Error('Migrated sharded operation final failed verification');
          }
          this.installLoaded(observed);
        }
      }

      const layout = createLayoutMarker(this.journalKind, legacyDigest);
      await this.removeFileIfPresent(this.layoutPendingPath);
      await writeNewFile(
        this.layoutPendingPath,
        canonicalJsonStringify(layout as unknown as JsonObject),
      );
      await this.inject('after-layout-pending-fsync');
      await fs.promises.rename(this.layoutPendingPath, this.layoutPath);
      await this.inject('after-layout-rename');
      await fsyncDirectory(this.rootPath);
      await this.inject('after-layout-root-fsync');
      const observed = await this.readLayoutMarkerIfPresent();
      if (!observed || observed.payloadDigest !== layout.payloadDigest) {
        throw new Error('Sharded operation layout marker changed during activation');
      }
      await this.assertExactRootEntries(true);
      this.health = 'healthy';
      this.topologyEpoch = randomUUID();
      this.indexDirty = records.length > 0;
      return { health: this.health, topologyEpoch: this.topologyEpoch };
    } catch (error) {
      this.health = 'recovery-required';
      this.topologyEpoch = null;
      throw error;
    }
  }

  private assertAggregateLimits(entries: readonly LoadedRecord<Payload>[]): void {
    if (entries.length > this.limits.maxRecordCount) {
      throw new Error('Sharded operation record count exceeds capacity');
    }
    const chargedBytes = entries.reduce((total, entry) => total + entry.chargedBytes, 0);
    if (!Number.isSafeInteger(chargedBytes) || chargedBytes > this.limits.maxChargedBytes) {
      throw new Error('Sharded operation charged bytes exceed capacity');
    }
    const keys = new Set<string>();
    const digests = new Set<string>();
    for (const entry of entries) {
      const key = this.codec.getCanonicalKey(entry.payload);
      if (keys.has(key) || digests.has(entry.envelope.keyDigest)) {
        throw new Error('Duplicate sharded operation key');
      }
      keys.add(key);
      digests.add(entry.envelope.keyDigest);
    }
  }

  private assertHealthy(): void {
    if (this.health !== 'healthy' || !this.topologyEpoch) {
      throw new Error(`Sharded operation store is not healthy (${this.health})`);
    }
  }

  private async assertExactRootEntries(activated: boolean): Promise<void> {
    const entries = await fs.promises.readdir(this.rootPath, { withFileTypes: true });
    const observedShards = new Set<string>();
    for (const entry of entries) {
      if (CANONICAL_SHARD_NAME_SET.has(entry.name)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error(`Sharded operation shard ${entry.name} is not a directory`);
        }
        observedShards.add(entry.name);
        continue;
      }
      const allowedFile = activated
        ? entry.name === LAYOUT_FILE_NAME ||
          entry.name === INDEX_FILE_NAME ||
          entry.name === INDEX_PENDING_FILE_NAME
        : false;
      if (!allowedFile || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Unexpected sharded operation root entry ${entry.name}`);
      }
    }
    if (
      observedShards.size !== SHARDED_OPERATION_STORE_SHARD_COUNT ||
      CANONICAL_SHARD_NAMES.some((name) => !observedShards.has(name))
    ) {
      throw new Error('Sharded operation layout does not contain the exact 00..ff topology');
    }
    if (activated && !entries.some((entry) => entry.name === LAYOUT_FILE_NAME)) {
      throw new Error('Activated sharded operation layout marker is missing');
    }
  }

  private async cleanPreActivationLayout(migrating: boolean): Promise<void> {
    await this.removeFileIfPresent(this.layoutPendingPath);
    await this.removeFileIfPresent(this.indexPath);
    await this.removeFileIfPresent(this.indexPendingPath);
    const entries = await fs.promises.readdir(this.rootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!CANONICAL_SHARD_NAME_SET.has(entry.name)) {
        throw new Error(`Unexpected pre-activation journal entry ${entry.name}`);
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Pre-activation shard ${entry.name} is invalid`);
      }
      const shardPath = path.join(this.rootPath, entry.name);
      const shardEntries = await fs.promises.readdir(shardPath, { withFileTypes: true });
      if (!migrating && shardEntries.length > 0) {
        throw new Error('Fresh activation cannot adopt preexisting record files');
      }
      for (const shardEntry of shardEntries) {
        if (
          !shardEntry.isFile() ||
          shardEntry.isSymbolicLink() ||
          (!FINAL_NAME_PATTERN.test(shardEntry.name) && !PENDING_NAME_PATTERN.test(shardEntry.name))
        ) {
          throw new Error(`Unexpected staged journal entry ${shardEntry.name}`);
        }
        await fs.promises.unlink(path.join(shardPath, shardEntry.name));
      }
      if (shardEntries.length > 0) await fsyncDirectory(shardPath);
    }
  }

  private clearMemoryIndex(): void {
    this.recordsByDigest.clear();
    this.digestByCanonicalKey.clear();
    this.chargedBytes = 0;
  }

  private async deleteDirect(
    canonicalKey: string,
    expectedVersion: number,
  ): Promise<ShardedOperationStoreDeleteResult> {
    this.assertHealthy();
    assertCanonicalKey(canonicalKey);
    if (!isSafePositiveInteger(expectedVersion)) throw new Error('Expected version is invalid');
    const keyDigest = deriveShardedOperationKeyDigest(this.journalKind, canonicalKey);
    const existing = this.recordsByDigest.get(keyDigest);
    if (!existing) return { kind: 'already-absent' };
    if (
      this.codec.getCanonicalKey(existing.payload) !== canonicalKey ||
      existing.envelope.recordVersion !== expectedVersion
    ) {
      throw new Error('Sharded operation delete version conflict');
    }
    const finalPath = recordPath(this.rootPath, keyDigest);
    const shardPath = path.dirname(finalPath);
    let directorySyncAcknowledged = false;
    try {
      await fs.promises.unlink(finalPath);
      await this.inject('after-record-unlink');
      await fsyncDirectory(shardPath);
      directorySyncAcknowledged = true;
      await this.inject('after-record-unlink-shard-fsync');
      if (await this.readFinal(keyDigest)) throw new Error('Deleted record reappeared');
      this.removeLoaded(keyDigest);
      return { kind: 'deleted' };
    } catch (cause) {
      let observed: LoadedRecord<Payload> | null = null;
      try {
        observed = await this.readFinal(keyDigest);
      } catch {
        this.health = 'recovery-required';
        this.topologyEpoch = null;
        return { cause, kind: 'recovery-required' };
      }
      if (observed && sameWitness(observed.envelope, existing.envelope)) {
        return { cause, kind: 'not-deleted' };
      }
      if (!observed) {
        if (directorySyncAcknowledged) {
          this.removeLoaded(keyDigest);
          return { kind: 'deleted' };
        }
        this.pendingDurability = { keyDigest, kind: 'delete' };
        this.health = 'durability-repair-required';
        return { cause, kind: 'durability-repair-required' };
      }
      this.health = 'recovery-required';
      this.topologyEpoch = null;
      return { cause, kind: 'recovery-required' };
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private enqueueAdmitted<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closeRequested) {
      return Promise.reject(new Error('Sharded operation store is closed'));
    }
    return this.enqueue(operation);
  }

  private async ensureLock(): Promise<void> {
    if (this.lockAcquired) return;
    await ensureDirectory(this.parentPath);
    const canonicalParent = await fs.promises.realpath(this.parentPath);
    this.canonicalIdentity = path.join(canonicalParent, path.basename(this.rootPath));
    await acquireProcessLock(this.canonicalIdentity, this.lockPath, () => {
      this.lockAcquired = true;
    });
  }

  private async flushDerivedIndexDirect(): Promise<boolean> {
    this.assertHealthy();
    if (!this.indexDirty) return true;
    const layout = await this.readLayoutMarkerIfPresent();
    if (!layout) throw new Error('Cannot checkpoint an unactivated sharded operation store');
    const entries = [...this.recordsByDigest.values()]
      .map<DerivedIndexEntry>((entry) => ({
        chargedBytes: entry.chargedBytes,
        encodedBytes: entry.encodedBytes,
        keyDigest: entry.envelope.keyDigest,
        payloadDigest: entry.envelope.payloadDigest,
        recordVersion: entry.envelope.recordVersion,
      }))
      .sort((left, right) => left.keyDigest.localeCompare(right.keyDigest));
    const base: Omit<DerivedIndexDocument, 'payloadDigest'> = {
      entries,
      formatVersion: SHARDED_OPERATION_STORE_INDEX_FORMAT_VERSION,
      layoutDigest: layout.payloadDigest,
    };
    const document: DerivedIndexDocument = {
      ...base,
      payloadDigest: canonicalDigest(base as unknown as JsonObject),
    };
    const encoded = canonicalJsonStringify(document as unknown as JsonObject);
    if (Buffer.byteLength(encoded, 'utf8') > this.limits.maxIndexBytes) {
      throw new Error('Derived sharded operation index exceeds its byte limit');
    }
    try {
      await this.removeFileIfPresent(this.indexPendingPath);
      await writeNewFile(this.indexPendingPath, encoded);
      await this.inject('after-index-pending-fsync');
      await fs.promises.rename(this.indexPendingPath, this.indexPath);
      await this.inject('after-index-rename');
      await fsyncDirectory(this.rootPath);
      await this.inject('after-index-root-fsync');
      this.indexDirty = false;
      return true;
    } catch {
      try {
        await this.removeFileIfPresent(this.indexPendingPath);
        await fsyncDirectory(this.rootPath);
      } catch {
        this.health = 'recovery-required';
        this.topologyEpoch = null;
      }
      return false;
    }
  }

  private async inject(point: ShardedOperationStoreFaultPoint): Promise<void> {
    await this.faultInjector?.(point);
  }

  private installLoaded(entry: LoadedRecord<Payload>): void {
    const key = this.codec.getCanonicalKey(entry.payload);
    const existingDigest = this.digestByCanonicalKey.get(key);
    if (existingDigest && existingDigest !== entry.envelope.keyDigest) {
      throw new Error('Sharded operation logical key digest collision');
    }
    const existing = this.recordsByDigest.get(entry.envelope.keyDigest);
    if (existing) this.chargedBytes -= existing.chargedBytes;
    this.recordsByDigest.set(entry.envelope.keyDigest, entry);
    this.digestByCanonicalKey.set(key, entry.envelope.keyDigest);
    this.chargedBytes += entry.chargedBytes;
    this.indexDirty = true;
  }

  private prepareLoaded(
    payload: Payload,
    prior: RecordWitness | null = null,
  ): LoadedRecord<Payload> {
    const stable = this.codec.decodePayload(structuredClone(payload));
    const canonicalKey = this.codec.getCanonicalKey(stable);
    const keyDigest = deriveShardedOperationKeyDigest(this.journalKind, canonicalKey);
    const envelope = createRecordEnvelope(keyDigest, stable, this.codec, prior);
    const encoded = canonicalJsonStringify(envelope as unknown as JsonObject);
    return decodeRecordEnvelope(encoded, keyDigest, this.journalKind, this.codec, this.limits);
  }

  private async readDerivedIndexIfValid(
    layoutDigest: string,
    indexPath = this.indexPath,
  ): Promise<boolean> {
    try {
      const contents = await readUtf8Bounded(indexPath, this.limits.maxIndexBytes);
      const value: unknown = JSON.parse(contents);
      if (
        !isRecord(value) ||
        !hasOnlyKeys(value, ['entries', 'formatVersion', 'layoutDigest', 'payloadDigest']) ||
        value.formatVersion !== SHARDED_OPERATION_STORE_INDEX_FORMAT_VERSION ||
        value.layoutDigest !== layoutDigest ||
        !isDigest(value.payloadDigest) ||
        !Array.isArray(value.entries)
      ) {
        return false;
      }
      const document = value as unknown as DerivedIndexDocument;
      if (
        contents !== canonicalJsonStringify(document as unknown as JsonObject) ||
        canonicalDigest({
          entries: document.entries as unknown as JsonValue,
          formatVersion: document.formatVersion,
          layoutDigest: document.layoutDigest,
        }) !== document.payloadDigest ||
        document.entries.length !== this.recordsByDigest.size
      ) {
        return false;
      }
      const seen = new Set<string>();
      let previousDigest: string | null = null;
      for (const indexEntry of document.entries) {
        if (
          !isRecord(indexEntry) ||
          !hasOnlyKeys(indexEntry, [
            'chargedBytes',
            'encodedBytes',
            'keyDigest',
            'payloadDigest',
            'recordVersion',
          ]) ||
          !isSafeNonNegativeInteger(indexEntry.chargedBytes) ||
          !isSafePositiveInteger(indexEntry.encodedBytes) ||
          !isDigest(indexEntry.keyDigest) ||
          !isDigest(indexEntry.payloadDigest) ||
          !isSafePositiveInteger(indexEntry.recordVersion)
        ) {
          return false;
        }
        if (
          seen.has(indexEntry.keyDigest) ||
          (previousDigest !== null && previousDigest.localeCompare(indexEntry.keyDigest) >= 0)
        ) {
          return false;
        }
        seen.add(indexEntry.keyDigest);
        previousDigest = indexEntry.keyDigest;
        const current = this.recordsByDigest.get(indexEntry.keyDigest);
        if (
          !current ||
          current.chargedBytes !== indexEntry.chargedBytes ||
          current.encodedBytes !== indexEntry.encodedBytes ||
          !sameWitness(current.envelope, indexEntry)
        ) {
          return false;
        }
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return false;
    }
  }

  private async readFinal(keyDigest: string): Promise<LoadedRecord<Payload> | null> {
    const finalPath = recordPath(this.rootPath, keyDigest);
    try {
      const contents = await readUtf8Bounded(finalPath, this.limits.maxRecordEnvelopeBytes);
      return decodeRecordEnvelope(contents, keyDigest, this.journalKind, this.codec, this.limits);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async readLayoutMarkerIfPresent(): Promise<LayoutMarker | null> {
    try {
      return decodeLayoutMarker(await readUtf8Bounded(this.layoutPath, 4_096), this.journalKind);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async removeFileIfPresent(filePath: string): Promise<boolean> {
    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private removeLoaded(keyDigest: string): void {
    const existing = this.recordsByDigest.get(keyDigest);
    if (!existing) return;
    this.recordsByDigest.delete(keyDigest);
    this.digestByCanonicalKey.delete(this.codec.getCanonicalKey(existing.payload));
    this.chargedBytes -= existing.chargedBytes;
    this.indexDirty = true;
  }

  private async removePendingIfPresent(keyDigest: string, fsyncAfter: boolean): Promise<void> {
    const removed = await this.removeFileIfPresent(pendingPath(this.rootPath, keyDigest));
    if (removed && fsyncAfter) {
      const shardPath = path.join(this.rootPath, keyDigest.slice(0, 2));
      await fsyncDirectory(shardPath);
      try {
        await fs.promises.access(pendingPath(this.rootPath, keyDigest));
        throw new Error('Sharded operation pending file survived cleanup');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private async saveDirect(
    payload: Payload,
    expectedVersion: number | null,
  ): Promise<ShardedOperationStoreCommitResult> {
    this.assertHealthy();
    if (expectedVersion !== null && !isSafePositiveInteger(expectedVersion)) {
      throw new Error('Expected sharded operation version is invalid');
    }
    let proposed = this.prepareLoaded(payload);
    const canonicalKey = this.codec.getCanonicalKey(proposed.payload);
    const keyDigest = proposed.envelope.keyDigest;
    const existing = this.recordsByDigest.get(keyDigest);
    if (existing && this.codec.getCanonicalKey(existing.payload) !== canonicalKey) {
      throw new Error('Sharded operation key digest collision');
    }
    if (existing) {
      if (expectedVersion !== existing.envelope.recordVersion) {
        throw new Error('Sharded operation version conflict');
      }
      if (sameWitness(existing.envelope, proposed.envelope)) return { kind: 'already-current' };
      if (proposed.envelope.recordVersion !== existing.envelope.recordVersion + 1) {
        throw new Error('Sharded operation record version must advance exactly once');
      }
      proposed = this.prepareLoaded(payload, recordWitness(existing.envelope));
    } else if (expectedVersion !== null || proposed.envelope.recordVersion !== 1) {
      throw new Error('First sharded operation record must use version 1');
    }

    const proposedCount = this.recordsByDigest.size + (existing ? 0 : 1);
    const proposedCharge =
      this.chargedBytes - (existing?.chargedBytes ?? 0) + proposed.chargedBytes;
    if (proposedCount > this.limits.maxRecordCount) {
      throw new Error('Sharded operation record count exceeds capacity');
    }
    if (proposedCharge > this.limits.maxChargedBytes) {
      throw new Error('Sharded operation charged bytes exceed capacity');
    }

    const pendingContents = canonicalJsonStringify(proposed.envelope as unknown as JsonObject);
    const currentPendingPath = pendingPath(this.rootPath, keyDigest);
    const finalPath = recordPath(this.rootPath, keyDigest);
    const shardPath = path.dirname(finalPath);
    let directorySyncAcknowledged = false;
    try {
      await this.assertNoPendingFiles();
      const handle = await fs.promises.open(currentPendingPath, 'wx', FILE_MODE);
      try {
        await this.inject('after-record-pending-open');
        await handle.writeFile(pendingContents, 'utf8');
        await this.inject('after-record-pending-write');
        await handle.sync();
        await this.inject('after-record-pending-fsync');
      } finally {
        await handle.close();
      }
      await fs.promises.rename(currentPendingPath, finalPath);
      await this.inject('after-record-rename');
      await fsyncDirectory(shardPath);
      directorySyncAcknowledged = true;
      await this.inject('after-record-shard-fsync');
      const observed = await this.readFinal(keyDigest);
      if (!observed || !sameWitness(observed.envelope, proposed.envelope)) {
        throw new Error('Sharded operation final does not match its proposed record');
      }
      this.installLoaded(observed);
      return { kind: 'committed' };
    } catch (cause) {
      return this.classifyFailedSave(existing ?? null, proposed, directorySyncAcknowledged, cause);
    }
  }

  private async classifyFailedSave(
    prior: LoadedRecord<Payload> | null,
    proposed: LoadedRecord<Payload>,
    directorySyncAcknowledged: boolean,
    cause: unknown,
  ): Promise<ShardedOperationStoreCommitResult> {
    let observed: LoadedRecord<Payload> | null = null;
    try {
      observed = await this.readFinal(proposed.envelope.keyDigest);
    } catch {
      this.health = 'recovery-required';
      this.topologyEpoch = null;
      return { cause, kind: 'recovery-required' };
    }
    const exactPrior = prior
      ? observed !== null && sameWitness(observed.envelope, prior.envelope)
      : observed === null;
    if (exactPrior) {
      try {
        await this.removePendingIfPresent(proposed.envelope.keyDigest, true);
      } catch {
        this.health = 'recovery-required';
        this.topologyEpoch = null;
        return { cause, kind: 'recovery-required' };
      }
      return { cause, kind: 'not-committed' };
    }
    if (observed && sameWitness(observed.envelope, proposed.envelope)) {
      if (!directorySyncAcknowledged) {
        this.pendingDurability = {
          keyDigest: proposed.envelope.keyDigest,
          kind: 'save',
          proposed,
        };
        this.health = 'durability-repair-required';
        return { cause, kind: 'durability-repair-required' };
      }
      try {
        await this.removePendingIfPresent(proposed.envelope.keyDigest, true);
        this.installLoaded(observed);
        return { kind: 'committed' };
      } catch {
        this.health = 'recovery-required';
        this.topologyEpoch = null;
        return { cause, kind: 'recovery-required' };
      }
    }
    this.health = 'recovery-required';
    this.topologyEpoch = null;
    return { cause, kind: 'recovery-required' };
  }

  private async assertNoPendingFiles(): Promise<void> {
    try {
      await fs.promises.access(this.indexPendingPath);
      throw new Error('Healthy sharded operation store contains a pending index');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async startupDirect(): Promise<ShardedOperationStoreStartupResult> {
    if (this.health === 'closed') throw new Error('Sharded operation store is closed');
    if (this.health === 'healthy') {
      if (!this.topologyEpoch)
        throw new Error('Healthy sharded operation store lost topology epoch');
      return { health: this.health, topologyEpoch: this.topologyEpoch };
    }
    await this.ensureLock();
    let layoutObserved = false;
    try {
      await fsyncDirectory(this.rootPath);
      await this.inject('after-root-fsync-before-enumeration');
      const layout = await this.readLayoutMarkerIfPresent();
      if (!layout) {
        this.health = 'activation-required';
        this.topologyEpoch = null;
        return { health: this.health };
      }
      layoutObserved = true;
      await this.assertExactRootEntries(true);
      await mapBatched(CANONICAL_SHARD_NAMES, 32, (shardName) =>
        fsyncDirectory(path.join(this.rootPath, shardName)),
      );
      await this.assertExactRootEntries(true);
      await this.loadAllFinalsAndCleanPending();
      const indexValid = await this.readDerivedIndexIfValid(layout.payloadDigest);
      await this.cleanIndexPending(layout.payloadDigest);
      this.indexDirty = !indexValid;
      this.health = 'healthy';
      this.topologyEpoch = randomUUID();
      return { health: this.health, topologyEpoch: this.topologyEpoch };
    } catch (error) {
      if (!layoutObserved && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.health = 'activation-required';
        this.topologyEpoch = null;
        return { health: this.health };
      }
      this.health = 'recovery-required';
      this.topologyEpoch = null;
      return { health: this.health };
    }
  }

  private async cleanIndexPending(layoutDigest: string): Promise<void> {
    let pendingExists = false;
    try {
      await fs.promises.access(this.indexPendingPath);
      pendingExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      pendingExists &&
      !(await this.readDerivedIndexIfValid(layoutDigest, this.indexPendingPath))
    ) {
      throw new Error('Derived sharded operation index pending file cannot be classified');
    }
    const removed = pendingExists && (await this.removeFileIfPresent(this.indexPendingPath));
    if (removed) {
      await fsyncDirectory(this.rootPath);
      await this.assertExactRootEntries(true);
    }
  }

  private async loadAllFinalsAndCleanPending(): Promise<void> {
    this.clearMemoryIndex();
    const pendingEntries: Array<{ keyDigest: string; shardPath: string }> = [];
    for (const shardName of CANONICAL_SHARD_NAMES) {
      const shardPath = path.join(this.rootPath, shardName);
      const entries = await fs.promises.readdir(shardPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error(`Unexpected non-file entry in shard ${shardName}`);
        }
        const pendingMatch = PENDING_NAME_PATTERN.exec(entry.name);
        if (pendingMatch) {
          const suffix = pendingMatch[1];
          if (!suffix) throw new Error('Invalid pending filename');
          pendingEntries.push({ keyDigest: `${shardName}${suffix}`, shardPath });
          continue;
        }
        if (!FINAL_NAME_PATTERN.test(entry.name)) {
          throw new Error(`Unexpected record filename ${entry.name}`);
        }
        const keyDigest = `${shardName}${entry.name}`;
        const loaded = await this.readFinal(keyDigest);
        if (!loaded) throw new Error('Enumerated sharded operation final disappeared');
        this.installLoaded(loaded);
      }
    }
    if (pendingEntries.length > 1) {
      throw new Error('Sharded operation journal contains multiple pending records');
    }
    if (pendingEntries[0]) await this.classifyStartupPending(pendingEntries[0]);
    this.assertAggregateLimits([...this.recordsByDigest.values()]);
  }

  private async classifyStartupPending(pendingEntry: {
    keyDigest: string;
    shardPath: string;
  }): Promise<void> {
    const currentPendingPath = pendingPath(this.rootPath, pendingEntry.keyDigest);
    const pendingContents = await readUtf8Bounded(
      currentPendingPath,
      this.limits.maxRecordEnvelopeBytes + 256,
    );
    const proposed = decodePendingEnvelope(
      pendingContents,
      pendingEntry.keyDigest,
      this.journalKind,
      this.codec,
      this.limits,
    );
    const current = this.recordsByDigest.get(pendingEntry.keyDigest) ?? null;
    const exactPrior = proposed.envelope.prior
      ? current !== null && sameWitness(current.envelope, proposed.envelope.prior)
      : current === null;
    const exactProposed = current !== null && sameWitness(current.envelope, proposed.envelope);
    if (!exactPrior && !exactProposed) {
      throw new Error('Sharded operation pending record cannot be classified');
    }
    await fs.promises.unlink(currentPendingPath);
    await fsyncDirectory(pendingEntry.shardPath);
    try {
      await fs.promises.access(currentPendingPath);
      throw new Error('Sharded operation pending record survived startup cleanup');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function createShardedOperationStore<Payload extends object>(
  options: ShardedOperationStoreOptions<Payload>,
): ShardedOperationStore<Payload> {
  return new FileShardedOperationStore(options);
}

export const SHARDED_OPERATION_STORE_LAYOUT_FILE_NAME = LAYOUT_FILE_NAME;
export const SHARDED_OPERATION_STORE_INDEX_FILE_NAME = INDEX_FILE_NAME;
export const SHARDED_OPERATION_STORE_SHARD_NAMES = CANONICAL_SHARD_NAMES;
