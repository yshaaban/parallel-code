import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../src/lib/type-guards.js';
import { getStateDirForEnv, type StorageEnv } from './storage-environment.js';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type WorkspaceStorageKind = 'electron' | 'standalone';
export type CanonicalUint64 = string & { readonly __canonicalUint64: unique symbol };

export const WORKSPACE_HOST_ENVELOPE_KEY = '__parallelCodeWorkspaceHost';
export const WORKSPACE_HOST_FORMAT_VERSION = 1;
export const MAX_UINT64 = 18_446_744_073_709_551_615n;

const STATE_DIRECTORY_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const STORAGE_GENERATION_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;

// These are the fields emitted by buildWorkspaceSharedState. Electron-only
// shell/window fields, including terminals, remain in the adapter-local slice.
export const ELECTRON_SHARED_STATE_KEYS = Object.freeze([
  'collapsedTaskOrder',
  'committedMergeOperationId',
  'completedTaskCount',
  'completedTaskDate',
  'customAgents',
  'hydraCommand',
  'hydraForceDispatchFromPromptPanel',
  'hydraStartupMode',
  'mergeOperation',
  'mergeProgress',
  'mergedLinesAdded',
  'mergedLinesRemoved',
  'projects',
  'taskOrder',
  'tasks',
] as const);

const ELECTRON_SHARED_STATE_KEY_SET = new Set<string>(ELECTRON_SHARED_STATE_KEYS);

export interface WorkspaceHostRecord {
  adapterKind: WorkspaceStorageKind;
  localState: JsonObject;
  payloadDigest: string;
  privateState: JsonObject;
  sharedRevision: number;
  sharedState: JsonObject;
  storageGeneration: CanonicalUint64;
}

export interface WorkspaceHostSnapshot {
  primaryExists: boolean;
  record: WorkspaceHostRecord;
  source: 'empty' | 'legacy-fallback' | 'legacy-primary' | 'primary';
}

export interface WorkspaceStorageEvidence {
  backup: WorkspaceStorageCandidateEvidence;
  temporary: WorkspaceStorageCandidateEvidence;
}

export type WorkspaceStorageCandidateEvidence =
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string }
  | {
      kind: 'valid';
      payloadDigest: string;
      storageGeneration: CanonicalUint64;
    };

export type WorkspaceStorageStartupResult =
  | {
      kind: 'ready';
      evidence: WorkspaceStorageEvidence;
      snapshot: WorkspaceHostSnapshot;
    }
  | {
      kind: 'host-state-recovery-required';
      evidence: WorkspaceStorageEvidence;
      message: string;
    };

export type WorkspaceStorageCommitResult =
  | { kind: 'committed'; snapshot: WorkspaceHostSnapshot }
  | { kind: 'not-committed'; cause: unknown; snapshot: WorkspaceHostSnapshot }
  | {
      kind: 'host-durability-repair-required';
      cause: unknown;
      snapshot: WorkspaceHostSnapshot;
    }
  | {
      kind: 'host-state-recovery-required';
      cause: unknown;
      message: string;
    };

export type WorkspaceStorageRepairResult =
  | { kind: 'repaired'; snapshot: WorkspaceHostSnapshot }
  | { kind: 'host-state-recovery-required'; cause: unknown; message: string };

export type WorkspaceStorageFaultPoint =
  | 'after-temporary-open'
  | 'after-temporary-write'
  | 'after-temporary-fsync'
  | 'after-rename'
  | 'after-directory-fsync'
  | 'before-lock-release-read'
  | 'before-lock-release-unlink'
  | 'before-lock-release-directory-fsync';

export interface WorkspaceStateStorageOptions {
  faultInjector?: (point: WorkspaceStorageFaultPoint) => Promise<void> | void;
}

export interface WorkspaceStateStorage {
  readonly backupPath: string;
  readonly canonicalIdentity: string;
  readonly kind: WorkspaceStorageKind;
  readonly primaryPath: string;
  readonly temporaryPath: string;
  close(): Promise<void>;
  commitHostRecord(
    prior: WorkspaceHostSnapshot,
    proposed: WorkspaceHostRecord,
  ): Promise<WorkspaceStorageCommitResult>;
  loadCurrent(): Promise<WorkspaceHostSnapshot>;
  repairDurability(expected: WorkspaceHostRecord): Promise<WorkspaceStorageRepairResult>;
  startup(): Promise<WorkspaceStorageStartupResult>;
}

interface WorkspaceHostEnvelope {
  adapterKind: WorkspaceStorageKind;
  formatVersion: number;
  payloadDigest: string;
  privateState: JsonObject;
  sharedKeys: string[];
  sharedRevision: number;
  storageGeneration: CanonicalUint64;
}

interface InstanceLockLease {
  count: number;
  lockPath: string;
  lockRemoved: boolean;
  releasePending: boolean;
  releasePromise: Promise<void> | null;
  token: string;
}

const instanceLocks = new Map<string, InstanceLockLease>();

export class WorkspaceStorageRecoveryError extends Error {
  readonly code = 'host-state-recovery-required';
}

export class WorkspaceStorageDurabilityError extends Error {
  readonly code = 'host-durability-repair-required';
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertJsonValue(value: unknown, ancestors: Set<object>): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Workspace host records may contain only finite JSON numbers');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error('Workspace host records must contain only JSON values');
  }
  if (ancestors.has(value)) {
    throw new Error('Workspace host records must not contain cycles');
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertJsonValue(entry, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Workspace host records must contain only plain JSON objects');
    }
    for (const entry of Object.values(value)) {
      assertJsonValue(entry, ancestors);
    }
  }
  ancestors.delete(value);
}

export function canonicalJsonStringify(value: JsonValue): string {
  assertJsonValue(value, new Set());

  function encode(entry: JsonValue): string {
    if (entry === null) return 'null';
    if (typeof entry === 'boolean' || typeof entry === 'number') {
      return JSON.stringify(Object.is(entry, -0) ? 0 : entry);
    }
    if (typeof entry === 'string') return JSON.stringify(entry);
    if (Array.isArray(entry)) return `[${entry.map(encode).join(',')}]`;

    const properties = Object.keys(entry)
      .sort(compareUtf8)
      .map((key) => `${JSON.stringify(key)}:${encode(entry[key] as JsonValue)}`);
    return `{${properties.join(',')}}`;
  }

  return encode(value);
}

export function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(canonicalJsonStringify(value)) as JsonObject;
}

function parseJsonObject(contents: string, label: string): JsonObject {
  const parsed: unknown = JSON.parse(contents);
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  assertJsonValue(parsed, new Set());
  return parsed as JsonObject;
}

export function parseCanonicalUint64(value: unknown, label = 'storageGeneration'): CanonicalUint64 {
  if (typeof value !== 'string' || !STORAGE_GENERATION_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical unsigned decimal uint64 string`);
  }

  const parsed = BigInt(value);
  if (parsed > MAX_UINT64) {
    throw new Error(`${label} exceeds uint64`);
  }
  return value as CanonicalUint64;
}

export function incrementCanonicalUint64(value: CanonicalUint64): CanonicalUint64 {
  const next = BigInt(value) + 1n;
  if (next > MAX_UINT64) {
    throw new Error('storageGeneration overflow');
  }
  return next.toString() as CanonicalUint64;
}

function assertSharedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('sharedRevision must be a non-negative safe integer');
  }
  return value as number;
}

function normalizeLegacyRevision(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function createDigestPayload(record: Omit<WorkspaceHostRecord, 'payloadDigest'>): JsonObject {
  return {
    adapterKind: record.adapterKind,
    formatVersion: WORKSPACE_HOST_FORMAT_VERSION,
    localState: record.localState,
    privateState: record.privateState,
    sharedRevision: record.sharedRevision,
    sharedState: record.sharedState,
    storageGeneration: record.storageGeneration,
  };
}

export function computeWorkspaceHostPayloadDigest(
  record: Omit<WorkspaceHostRecord, 'payloadDigest'>,
): string {
  return createHash('sha256')
    .update(canonicalJsonStringify(createDigestPayload(record)))
    .digest('hex');
}

export function createWorkspaceHostRecord(args: {
  adapterKind: WorkspaceStorageKind;
  localState?: JsonObject;
  privateState?: JsonObject;
  sharedRevision: number;
  sharedState: JsonObject;
  storageGeneration: CanonicalUint64;
}): WorkspaceHostRecord {
  const recordWithoutDigest = {
    adapterKind: args.adapterKind,
    localState: cloneJsonObject(args.localState ?? {}),
    privateState: cloneJsonObject(args.privateState ?? {}),
    sharedRevision: assertSharedRevision(args.sharedRevision),
    sharedState: cloneJsonObject(args.sharedState),
    storageGeneration: parseCanonicalUint64(args.storageGeneration),
  };
  return {
    ...recordWithoutDigest,
    payloadDigest: computeWorkspaceHostPayloadDigest(recordWithoutDigest),
  };
}

export function recordsHaveSameWitness(
  left: WorkspaceHostRecord,
  right: WorkspaceHostRecord,
): boolean {
  return (
    left.storageGeneration === right.storageGeneration && left.payloadDigest === right.payloadDigest
  );
}

function sortedKeys(object: JsonObject): string[] {
  return Object.keys(object).sort(compareUtf8);
}

function createEnvelope(record: WorkspaceHostRecord): WorkspaceHostEnvelope {
  return {
    adapterKind: record.adapterKind,
    formatVersion: WORKSPACE_HOST_FORMAT_VERSION,
    payloadDigest: record.payloadDigest,
    privateState: record.privateState,
    sharedKeys: sortedKeys(record.sharedState),
    sharedRevision: record.sharedRevision,
    storageGeneration: record.storageGeneration,
  };
}

export function encodeWorkspaceHostRecord(record: WorkspaceHostRecord): string {
  const canonical = createWorkspaceHostRecord(record);
  if (!recordsHaveSameWitness(canonical, record)) {
    throw new Error('Workspace host record payloadDigest does not match its canonical payload');
  }

  const envelope = createEnvelope(canonical) as unknown as JsonObject;
  if (record.adapterKind === 'standalone') {
    return canonicalJsonStringify({
      [WORKSPACE_HOST_ENVELOPE_KEY]: envelope,
      revision: record.sharedRevision,
      state: record.sharedState,
    });
  }

  const overlappingKeys = Object.keys(record.localState).filter((key) => key in record.sharedState);
  if (overlappingKeys.length > 0) {
    throw new Error(`Electron local/shared fields overlap: ${overlappingKeys.join(', ')}`);
  }
  return canonicalJsonStringify({
    ...record.localState,
    ...record.sharedState,
    [WORKSPACE_HOST_ENVELOPE_KEY]: envelope,
  });
}

function parseEnvelope(value: unknown, expectedKind: WorkspaceStorageKind): WorkspaceHostEnvelope {
  if (!isRecord(value)) throw new Error('Workspace host envelope must be an object');
  if (value.formatVersion !== WORKSPACE_HOST_FORMAT_VERSION) {
    throw new Error('Unsupported workspace host formatVersion');
  }
  if (value.adapterKind !== expectedKind) {
    throw new Error('Workspace host adapter kind does not match this storage adapter');
  }
  if (typeof value.payloadDigest !== 'string' || !SHA_256_PATTERN.test(value.payloadDigest)) {
    throw new Error('Workspace host payloadDigest must be lowercase SHA-256 hex');
  }
  if (!isRecord(value.privateState)) {
    throw new Error('Workspace host privateState must be an object');
  }
  assertJsonValue(value.privateState, new Set());
  if (
    !Array.isArray(value.sharedKeys) ||
    !value.sharedKeys.every((key) => typeof key === 'string')
  ) {
    throw new Error('Workspace host sharedKeys must be a string array');
  }
  const sharedKeys = [...value.sharedKeys] as string[];
  const canonicalSharedKeys = [...new Set(sharedKeys)].sort(compareUtf8);
  if (
    canonicalSharedKeys.length !== sharedKeys.length ||
    canonicalSharedKeys.some((key, index) => key !== sharedKeys[index])
  ) {
    throw new Error('Workspace host sharedKeys must be unique and canonically sorted');
  }
  if (
    expectedKind === 'electron' &&
    sharedKeys.some((key) => !ELECTRON_SHARED_STATE_KEY_SET.has(key))
  ) {
    throw new Error('Workspace host envelope contains an unsupported Electron shared field');
  }

  return {
    adapterKind: expectedKind,
    formatVersion: WORKSPACE_HOST_FORMAT_VERSION,
    payloadDigest: value.payloadDigest,
    privateState: cloneJsonObject(value.privateState as JsonObject),
    sharedKeys,
    sharedRevision: assertSharedRevision(value.sharedRevision),
    storageGeneration: parseCanonicalUint64(value.storageGeneration),
  };
}

function splitBySharedKeys(
  root: JsonObject,
  sharedKeys: readonly string[],
): { localState: JsonObject; sharedState: JsonObject } {
  const sharedKeySet = new Set(sharedKeys);
  const localState: JsonObject = {};
  const sharedState: JsonObject = {};

  for (const [key, value] of Object.entries(root)) {
    if (key === WORKSPACE_HOST_ENVELOPE_KEY) continue;
    if (sharedKeySet.has(key)) sharedState[key] = value;
    else localState[key] = value;
  }
  for (const key of sharedKeys) {
    if (!(key in sharedState)) {
      throw new Error(`Workspace host shared field is missing: ${key}`);
    }
  }
  return { localState, sharedState };
}

export function splitElectronPersistedState(root: JsonObject): {
  localState: JsonObject;
  sharedState: JsonObject;
} {
  return splitBySharedKeys(
    root,
    ELECTRON_SHARED_STATE_KEYS.filter((key) => key in root),
  );
}

function decodeActiveRecord(root: JsonObject, kind: WorkspaceStorageKind): WorkspaceHostRecord {
  const envelope = parseEnvelope(root[WORKSPACE_HOST_ENVELOPE_KEY], kind);
  let localState: JsonObject;
  let sharedState: JsonObject;

  if (kind === 'standalone') {
    if (root.revision !== envelope.sharedRevision || !isRecord(root.state)) {
      throw new Error('Standalone workspace state revision/state does not match its host envelope');
    }
    assertJsonValue(root.state, new Set());
    localState = {};
    sharedState = cloneJsonObject(root.state as JsonObject);
    const expectedKeys = sortedKeys(sharedState);
    if (
      expectedKeys.length !== envelope.sharedKeys.length ||
      expectedKeys.some((key, index) => key !== envelope.sharedKeys[index])
    ) {
      throw new Error('Standalone workspace host sharedKeys do not match state');
    }
  } else {
    ({ localState, sharedState } = splitBySharedKeys(root, envelope.sharedKeys));
  }

  const record = createWorkspaceHostRecord({
    adapterKind: kind,
    localState,
    privateState: envelope.privateState,
    sharedRevision: envelope.sharedRevision,
    sharedState,
    storageGeneration: envelope.storageGeneration,
  });
  if (record.payloadDigest !== envelope.payloadDigest) {
    throw new Error('Workspace host payloadDigest does not match the canonical payload');
  }
  return record;
}

function decodeLegacyRecord(root: JsonObject, kind: WorkspaceStorageKind): WorkspaceHostRecord {
  if (kind === 'standalone') {
    if (!isRecord(root.state)) {
      throw new Error('Legacy standalone workspace state must contain an object state');
    }
    assertJsonValue(root.state, new Set());
    return createWorkspaceHostRecord({
      adapterKind: kind,
      sharedRevision: normalizeLegacyRevision(root.revision),
      sharedState: root.state as JsonObject,
      storageGeneration: '0' as CanonicalUint64,
    });
  }

  const split = splitElectronPersistedState(root);
  return createWorkspaceHostRecord({
    adapterKind: kind,
    localState: split.localState,
    sharedRevision: 0,
    sharedState: split.sharedState,
    storageGeneration: '0' as CanonicalUint64,
  });
}

export function decodeWorkspaceHostRecord(
  contents: string,
  kind: WorkspaceStorageKind,
): { legacy: boolean; record: WorkspaceHostRecord } {
  const root = parseJsonObject(contents, 'Workspace host record');
  if (WORKSPACE_HOST_ENVELOPE_KEY in root) {
    return { legacy: false, record: decodeActiveRecord(root, kind) };
  }
  return { legacy: true, record: decodeLegacyRecord(root, kind) };
}

function createEmptySnapshot(kind: WorkspaceStorageKind): WorkspaceHostSnapshot {
  return {
    primaryExists: false,
    record: createWorkspaceHostRecord({
      adapterKind: kind,
      sharedRevision: 0,
      sharedState: {
        collapsedTaskOrder: [],
        projects: [],
        taskOrder: [],
        tasks: {},
      },
      storageGeneration: '0' as CanonicalUint64,
    }),
    source: 'empty',
  };
}

async function ensureStateDirectory(directoryPath: string): Promise<void> {
  await fs.promises.mkdir(directoryPath, { mode: STATE_DIRECTORY_MODE, recursive: true });
  await fs.promises.chmod(directoryPath, STATE_DIRECTORY_MODE).catch(() => {});
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.promises.open(directoryPath, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function canonicalStorageIdentity(primaryPath: string): Promise<string> {
  const directoryPath = path.dirname(primaryPath);
  await ensureStateDirectory(directoryPath);
  const canonicalDirectory = await fs.promises.realpath(directoryPath);
  return path.join(canonicalDirectory, path.basename(primaryPath));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function acquireInstanceLock(
  identity: string,
  lockPath: string,
  onAcquired: () => void,
): Promise<void> {
  for (;;) {
    const held = instanceLocks.get(identity);
    if (!held) break;
    if (!held.releasePending) {
      held.count += 1;
      onAcquired();
      return;
    }
    if (!held.releasePromise) {
      throw new WorkspaceStorageRecoveryError(
        'Workspace instance lock release requires an exact retry',
      );
    }
    await held.releasePromise.catch(() => undefined);
  }

  const token = randomUUID();
  const contents = JSON.stringify({ pid: process.pid, token });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx', STATE_FILE_MODE);
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      instanceLocks.set(identity, {
        count: 1,
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
        const statBeforeRead = await fs.promises.lstat(lockPath);
        if (!statBeforeRead.isFile() || statBeforeRead.isSymbolicLink()) {
          throw new Error('Workspace instance lock is not a regular file');
        }
        const parsed: unknown = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
        const statAfterRead = await fs.promises.lstat(lockPath);
        if (statBeforeRead.dev !== statAfterRead.dev || statBeforeRead.ino !== statAfterRead.ino) {
          throw new WorkspaceStorageRecoveryError('Workspace instance lock changed while read');
        }
        stale = isRecord(parsed) && typeof parsed.pid === 'number' && !isProcessAlive(parsed.pid);
        if (stale) {
          const statBeforeUnlink = await fs.promises.lstat(lockPath);
          if (
            statBeforeRead.dev !== statBeforeUnlink.dev ||
            statBeforeRead.ino !== statBeforeUnlink.ino
          ) {
            throw new WorkspaceStorageRecoveryError(
              'Workspace instance lock changed before stale cleanup',
            );
          }
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new WorkspaceStorageRecoveryError('Workspace instance lock is invalid or unreadable');
      }
      if (!stale) {
        throw new WorkspaceStorageRecoveryError(
          'Workspace storage is already open in another process',
        );
      }
      await fs.promises.unlink(lockPath);
      await fsyncDirectory(path.dirname(lockPath));
    }
  }
  throw new WorkspaceStorageRecoveryError('Could not acquire workspace instance lock');
}

async function releaseInstanceLock(
  identity: string,
  injectFault: (point: WorkspaceStorageFaultPoint) => Promise<void>,
): Promise<void> {
  const held = instanceLocks.get(identity);
  if (!held) return;
  if (held.count > 1) {
    held.count -= 1;
    return;
  }
  if (held.releasePromise) return held.releasePromise;
  held.releasePending = true;

  const releasePromise = (async () => {
    if (!held.lockRemoved) {
      await injectFault('before-lock-release-read');
      try {
        const parsed: unknown = JSON.parse(await fs.promises.readFile(held.lockPath, 'utf8'));
        if (!isRecord(parsed) || parsed.token !== held.token || parsed.pid !== process.pid) {
          throw new WorkspaceStorageRecoveryError('Workspace instance lock ownership changed');
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
    if (instanceLocks.get(identity) !== held || held.count !== 1) {
      throw new WorkspaceStorageRecoveryError('Workspace instance lock ownership changed');
    }
    instanceLocks.delete(identity);
  })();
  held.releasePromise = releasePromise;
  try {
    await releasePromise;
  } finally {
    if (instanceLocks.get(identity) === held && held.releasePromise === releasePromise) {
      held.releasePromise = null;
    }
  }
}

async function readCandidate(
  candidatePath: string,
  kind: WorkspaceStorageKind,
): Promise<WorkspaceStorageCandidateEvidence> {
  try {
    const decoded = decodeWorkspaceHostRecord(
      await fs.promises.readFile(candidatePath, 'utf8'),
      kind,
    );
    return {
      kind: 'valid',
      payloadDigest: decoded.record.payloadDigest,
      storageGeneration: decoded.record.storageGeneration,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
}

class FileWorkspaceStateStorage implements WorkspaceStateStorage {
  readonly backupPath: string;
  readonly canonicalIdentity: string;
  readonly primaryPath: string;
  readonly temporaryPath: string;
  readonly kind: WorkspaceStorageKind;

  private readonly directoryPath: string;
  private readonly faultInjector: WorkspaceStateStorageOptions['faultInjector'];
  private readonly legacyFallbackPath: string | null;
  private readonly lockPath: string;
  private health: 'uninitialized' | 'healthy' | 'durability-pending' | 'recovery' = 'uninitialized';
  private lockAcquired = false;
  private closePromise: Promise<void> | null = null;
  private startupPromise: Promise<WorkspaceStorageStartupResult> | null = null;

  constructor(args: {
    canonicalIdentity: string;
    faultInjector?: WorkspaceStateStorageOptions['faultInjector'];
    kind: WorkspaceStorageKind;
    legacyFallbackPath?: string;
    primaryPath: string;
  }) {
    this.kind = args.kind;
    this.primaryPath = args.primaryPath;
    this.temporaryPath = `${args.primaryPath}.tmp`;
    this.backupPath = `${args.primaryPath}.bak`;
    this.lockPath = `${args.primaryPath}.lock`;
    this.directoryPath = path.dirname(args.primaryPath);
    this.canonicalIdentity = args.canonicalIdentity;
    this.faultInjector = args.faultInjector;
    this.legacyFallbackPath = args.legacyFallbackPath ?? null;
  }

  close(): Promise<void> {
    if (!this.lockAcquired) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    const closePromise = releaseInstanceLock(this.canonicalIdentity, (point) =>
      this.injectFault(point),
    )
      .then(() => {
        this.lockAcquired = false;
      })
      .catch((error: unknown) => {
        if (this.closePromise === closePromise) this.closePromise = null;
        throw error;
      });
    this.closePromise = closePromise;
    return closePromise;
  }

  async startup(): Promise<WorkspaceStorageStartupResult> {
    this.startupPromise ??= this.performStartup();
    return this.startupPromise;
  }

  async loadCurrent(): Promise<WorkspaceHostSnapshot> {
    const startup = await this.startup();
    if (startup.kind !== 'ready' || this.health !== 'healthy') {
      throw new WorkspaceStorageRecoveryError(
        this.health === 'durability-pending'
          ? 'Workspace host durability repair is required'
          : 'Workspace host state recovery is required',
      );
    }

    try {
      return await this.readAuthoritativeSnapshot();
    } catch (error) {
      this.health = 'recovery';
      throw new WorkspaceStorageRecoveryError(
        `Workspace primary became unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async commitHostRecord(
    prior: WorkspaceHostSnapshot,
    proposed: WorkspaceHostRecord,
  ): Promise<WorkspaceStorageCommitResult> {
    await this.startup();
    if (this.health !== 'healthy') {
      return {
        kind: 'host-state-recovery-required',
        cause: new WorkspaceStorageRecoveryError('Workspace storage is not healthy'),
        message: 'Workspace storage is not healthy',
      };
    }
    if (proposed.adapterKind !== this.kind) {
      throw new Error('Proposed workspace host record uses the wrong adapter kind');
    }

    const contents = encodeWorkspaceHostRecord(proposed);
    let directorySyncAcknowledged = false;
    try {
      await fs.promises.unlink(this.temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      const handle = await fs.promises.open(this.temporaryPath, 'wx', STATE_FILE_MODE);
      try {
        await this.injectFault('after-temporary-open');
        await handle.writeFile(contents, 'utf8');
        await this.injectFault('after-temporary-write');
        await handle.sync();
        await this.injectFault('after-temporary-fsync');
      } finally {
        await handle.close();
      }
      await fs.promises.rename(this.temporaryPath, this.primaryPath);
      await this.injectFault('after-rename');
      await fsyncDirectory(this.directoryPath);
      directorySyncAcknowledged = true;
      await this.injectFault('after-directory-fsync');
      this.health = 'healthy';
      return {
        kind: 'committed',
        snapshot: { primaryExists: true, record: proposed, source: 'primary' },
      };
    } catch (cause) {
      return this.classifyFailedCommit(prior, proposed, directorySyncAcknowledged, cause);
    }
  }

  async repairDurability(expected: WorkspaceHostRecord): Promise<WorkspaceStorageRepairResult> {
    if (this.health !== 'durability-pending') {
      return {
        kind: 'host-state-recovery-required',
        cause: new WorkspaceStorageRecoveryError('No workspace durability repair is pending'),
        message: 'No workspace durability repair is pending',
      };
    }

    try {
      await fsyncDirectory(this.directoryPath);
      const current = await this.readPrimarySnapshot();
      if (!recordsHaveSameWitness(current.record, expected)) {
        throw new Error('Workspace primary changed before durability repair');
      }
      this.health = 'healthy';
      return { kind: 'repaired', snapshot: current };
    } catch (cause) {
      this.health = 'recovery';
      return {
        kind: 'host-state-recovery-required',
        cause,
        message: 'Workspace durability repair could not validate the exact proposed record',
      };
    }
  }

  private async performStartup(): Promise<WorkspaceStorageStartupResult> {
    await ensureStateDirectory(this.directoryPath);
    try {
      await acquireInstanceLock(this.canonicalIdentity, this.lockPath, () => {
        this.lockAcquired = true;
      });
      // This is intentionally unconditional and precedes candidate enumeration.
      await fsyncDirectory(this.directoryPath);
      const evidence = await this.readEvidence();
      let snapshot: WorkspaceHostSnapshot;
      try {
        snapshot = await this.readAuthoritativeSnapshot(evidence);
      } catch (error) {
        this.health = 'recovery';
        return {
          kind: 'host-state-recovery-required',
          evidence,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      this.health = 'healthy';
      return { kind: 'ready', evidence, snapshot };
    } catch (error) {
      this.health = 'recovery';
      return {
        kind: 'host-state-recovery-required',
        evidence: await this.readEvidence(),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readEvidence(): Promise<WorkspaceStorageEvidence> {
    const [backup, temporary] = await Promise.all([
      readCandidate(this.backupPath, this.kind),
      readCandidate(this.temporaryPath, this.kind),
    ]);
    return { backup, temporary };
  }

  private async readAuthoritativeSnapshot(
    knownEvidence?: WorkspaceStorageEvidence,
  ): Promise<WorkspaceHostSnapshot> {
    try {
      return await this.readPrimarySnapshot();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const evidence = knownEvidence ?? (await this.readEvidence());
    if (evidence.backup.kind !== 'missing' || evidence.temporary.kind !== 'missing') {
      throw new Error('Workspace primary is missing while recovery evidence exists');
    }
    if (this.legacyFallbackPath) {
      try {
        const root = parseJsonObject(
          await fs.promises.readFile(this.legacyFallbackPath, 'utf8'),
          'Legacy app state',
        );
        return {
          primaryExists: false,
          record: createWorkspaceHostRecord({
            adapterKind: this.kind,
            sharedRevision: 0,
            sharedState: root,
            storageGeneration: '0' as CanonicalUint64,
          }),
          source: 'legacy-fallback',
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return createEmptySnapshot(this.kind);
  }

  private async readPrimarySnapshot(): Promise<WorkspaceHostSnapshot> {
    const decoded = decodeWorkspaceHostRecord(
      await fs.promises.readFile(this.primaryPath, 'utf8'),
      this.kind,
    );
    return {
      primaryExists: true,
      record: decoded.record,
      source: decoded.legacy ? 'legacy-primary' : 'primary',
    };
  }

  private async classifyFailedCommit(
    prior: WorkspaceHostSnapshot,
    proposed: WorkspaceHostRecord,
    directorySyncAcknowledged: boolean,
    cause: unknown,
  ): Promise<WorkspaceStorageCommitResult> {
    let current: WorkspaceHostSnapshot | null = null;
    let primaryReadError: unknown = null;
    try {
      current = await this.readPrimarySnapshot();
    } catch (error) {
      primaryReadError = error;
    }

    if (current && recordsHaveSameWitness(current.record, proposed)) {
      if (directorySyncAcknowledged) {
        this.health = 'healthy';
        return { kind: 'committed', snapshot: current };
      }
      this.health = 'durability-pending';
      return { kind: 'host-durability-repair-required', cause, snapshot: current };
    }

    const exactPrior = current
      ? prior.primaryExists && recordsHaveSameWitness(current.record, prior.record)
      : !prior.primaryExists &&
        (primaryReadError as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    if (exactPrior) {
      await fs.promises.unlink(this.temporaryPath).catch(() => {});
      this.health = 'healthy';
      return { kind: 'not-committed', cause, snapshot: prior };
    }

    this.health = 'recovery';
    return {
      kind: 'host-state-recovery-required',
      cause,
      message: 'Workspace commit failed and the primary matches neither exact prior nor proposal',
    };
  }

  private async injectFault(point: WorkspaceStorageFaultPoint): Promise<void> {
    await this.faultInjector?.(point);
  }
}

async function createStorage(
  kind: WorkspaceStorageKind,
  env: StorageEnv,
  options: WorkspaceStateStorageOptions,
): Promise<WorkspaceStateStorage> {
  const directoryPath = getStateDirForEnv(env);
  const filename = kind === 'standalone' ? 'workspace-state.json' : 'state.json';
  const primaryPath = path.join(directoryPath, filename);
  return new FileWorkspaceStateStorage({
    canonicalIdentity: await canonicalStorageIdentity(primaryPath),
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
    kind,
    ...(kind === 'standalone'
      ? { legacyFallbackPath: path.join(directoryPath, 'state.json') }
      : {}),
    primaryPath,
  });
}

export function createStandaloneWorkspaceStateStorage(
  env: StorageEnv,
  options: WorkspaceStateStorageOptions = {},
): Promise<WorkspaceStateStorage> {
  return createStorage('standalone', env, options);
}

export function createElectronWorkspaceStateStorage(
  env: StorageEnv,
  options: WorkspaceStateStorageOptions = {},
): Promise<WorkspaceStateStorage> {
  return createStorage('electron', env, options);
}
