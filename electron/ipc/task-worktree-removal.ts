import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { TaskRemovalCleanupPlan } from '../../src/domain/task-removal-owner.js';
import { invalidateGitQueryCacheForPath } from './git-cache.js';
import { execGit } from './git-exec.js';
import { listGitWorktrees, type GitWorktreeListEntry } from './git-worktree.js';
import type { JsonObject } from './workspace-state-storage.js';

const QUARANTINE_EVIDENCE_VERSION = 1 as const;
const OID_PATTERN = /^[0-9a-f]{40,64}$/u;

type PathEntryKind = 'directory' | 'missing' | 'other' | 'symlink';

export interface ManagedTaskWorktreeRemovalRequest {
  cleanupPlan: Readonly<TaskRemovalCleanupPlan>;
  deletionOperationId: string;
}

export interface ManagedWorktreeRecoveryQuarantineRequest {
  branchName: string;
  operationId: string;
  projectRoot: string;
  worktreePath: string;
}

export interface RetainedManagedWorktreeRecoveryEvidence {
  branchName: string;
  headOid: string;
  operationLockOwnershipWitness: string;
  operationLockResourceId: string;
  quarantineLocator: string;
  recoveryId: string;
  resourceId: string;
}

/**
 * Bounded identity copied into the creation journal after the worktree owner
 * has claimed a failed preparation. It intentionally omits paths other than
 * the private quarantine locator and never acts as branch-delete proof.
 */
export interface ManagedWorktreeRecoveryIdentity {
  operationLockOwnershipWitness: string;
  operationLockResourceId: string;
  quarantineLocator: string;
  recoveryId: string;
  resourceId: string;
}

export type ManagedWorktreeRecoveryInspection =
  | { kind: 'exact-absent' }
  | { headOid: string; kind: 'exact-present' }
  | { kind: 'proof-insufficient' };

interface WorktreeQuarantineEvidence {
  branchName: string;
  headOid: string;
  lockReason: string;
  originalWorktreePath: string;
  quarantinePath: string;
  state: 'quarantined-attached' | 'quarantined-detached';
  version: typeof QUARANTINE_EVIDENCE_VERSION;
}

function requireManagedPlan(
  request: ManagedTaskWorktreeRemovalRequest,
): Readonly<TaskRemovalCleanupPlan> & { quarantinePath: string } {
  const plan = request.cleanupPlan;
  if (
    plan.gitCleanup !== 'managed-worktree' ||
    plan.projectMode !== 'git' ||
    typeof plan.quarantinePath !== 'string' ||
    plan.quarantinePath.length === 0
  ) {
    throw new Error('Managed worktree cleanup requires one frozen quarantine target');
  }
  const managedContainer = path.resolve(plan.projectRoot, '.worktrees');
  const relativeWorktreePath = path.relative(managedContainer, path.resolve(plan.worktreePath));
  if (
    relativeWorktreePath.length === 0 ||
    relativeWorktreePath === '..' ||
    relativeWorktreePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeWorktreePath) ||
    relativeWorktreePath.split(path.sep)[0] === '.parallel-code-recovery'
  ) {
    throw new Error('Managed worktree cleanup source is outside its owned location');
  }
  if (
    path.dirname(path.dirname(plan.quarantinePath)) !==
    path.join(path.dirname(plan.worktreePath), '.parallel-code-recovery')
  ) {
    throw new Error('Managed worktree cleanup quarantine is outside its recovery root');
  }
  return plan as Readonly<TaskRemovalCleanupPlan> & { quarantinePath: string };
}

async function getPathEntryKind(candidatePath: string): Promise<PathEntryKind> {
  try {
    const stat = await fs.promises.lstat(candidatePath);
    if (stat.isSymbolicLink()) return 'symlink';
    return stat.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

function findWorktree(
  worktrees: readonly GitWorktreeListEntry[],
  candidatePath: string,
): GitWorktreeListEntry | null {
  const normalize = (value: string): string => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const normalized = normalize(candidatePath);
  return worktrees.find((entry) => normalize(entry.path) === normalized) ?? null;
}

function getLockReason(deletionOperationId: string): string {
  return `parallel-code-removal:${deletionOperationId}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function base64urlDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function matchesManagedWorktreeRecoveryIdentity(
  request: Readonly<ManagedWorktreeRecoveryQuarantineRequest>,
  identity: Readonly<ManagedWorktreeRecoveryIdentity>,
  plan: Readonly<TaskRemovalCleanupPlan> & { quarantinePath: string },
): boolean {
  const operationDigest = base64urlDigest(request.operationId);
  return (
    identity.quarantineLocator === plan.quarantinePath &&
    identity.operationLockOwnershipWitness ===
      base64urlDigest(getLockReason(request.operationId)) &&
    identity.operationLockResourceId === `worktree-lock:${operationDigest}` &&
    identity.recoveryId === `worktree-recovery:${operationDigest}` &&
    identity.resourceId ===
      `managed-worktree:${base64urlDigest(`${plan.projectRoot}\u0000${plan.worktreePath}`)}`
  );
}

export function getManagedWorktreeRecoveryQuarantinePath(
  worktreePath: string,
  operationId: string,
): string {
  if (
    !path.isAbsolute(worktreePath) ||
    operationId.trim().length === 0 ||
    operationId.length > 512 ||
    operationId.includes('\u0000')
  ) {
    throw new Error('Managed worktree recovery identity is invalid');
  }
  return path.join(
    path.dirname(path.normalize(worktreePath)),
    '.parallel-code-recovery',
    digest(operationId),
    'worktree',
  );
}

function recoveryPlan(
  request: Readonly<ManagedWorktreeRecoveryQuarantineRequest>,
): TaskRemovalCleanupPlan & { quarantinePath: string } {
  const quarantinePath = getManagedWorktreeRecoveryQuarantinePath(
    request.worktreePath,
    request.operationId,
  );
  return {
    agentIds: [],
    branchName: request.branchName,
    deleteBranch: true,
    gitCleanup: 'managed-worktree',
    launchOperationId: null,
    preparedWorkspaceRevision: 0,
    projectMode: 'git',
    projectRoot: path.normalize(request.projectRoot),
    quarantinePath,
    taskId: `creation-recovery:${digest(request.operationId)}`,
    taskIdentityWitness: digest(`creation-recovery:${request.operationId}`),
    taskMode: 'agent',
    worktreePath: path.normalize(request.worktreePath),
  };
}

async function readHeadOid(worktreePath: string): Promise<string> {
  const { stdout } = await execGit(['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath });
  const headOid = stdout.trim().toLowerCase();
  if (!OID_PATTERN.test(headOid)) {
    throw new Error('Managed worktree HEAD evidence is invalid');
  }
  return headOid;
}

async function assertPrivateDirectory(candidatePath: string): Promise<void> {
  const kind = await getPathEntryKind(candidatePath);
  if (kind !== 'directory') {
    throw new Error(`Recovery directory is not a private directory: ${candidatePath}`);
  }
  await fs.promises.chmod(candidatePath, 0o700);
}

async function prepareQuarantineParent(plan: {
  quarantinePath: string;
  worktreePath: string;
}): Promise<void> {
  const worktreeContainer = path.dirname(plan.worktreePath);
  const recoveryRoot = path.join(worktreeContainer, '.parallel-code-recovery');
  const operationDirectory = path.dirname(plan.quarantinePath);
  const containerKind = await getPathEntryKind(worktreeContainer);
  if (containerKind !== 'directory') {
    throw new Error('Managed worktree container is not a directory');
  }
  for (const candidate of [recoveryRoot, operationDirectory]) {
    const kind = await getPathEntryKind(candidate);
    if (kind === 'symlink' || kind === 'other') {
      throw new Error(`Recovery path is not an owned directory: ${candidate}`);
    }
  }
  await fs.promises.mkdir(recoveryRoot, { mode: 0o700, recursive: true });
  await assertPrivateDirectory(recoveryRoot);
  await fs.promises.mkdir(operationDirectory, { mode: 0o700, recursive: true });
  await assertPrivateDirectory(operationDirectory);
}

async function lockQuarantinedWorktree(
  plan: { projectRoot: string; quarantinePath: string },
  deletionOperationId: string,
): Promise<void> {
  const expectedReason = getLockReason(deletionOperationId);
  let entry = findWorktree(await listGitWorktrees(plan.projectRoot), plan.quarantinePath);
  if (!entry) throw new Error('Quarantined worktree registration disappeared');
  if (entry.lockedReason !== undefined && entry.lockedReason !== expectedReason) {
    throw new Error('Quarantined worktree is held by another recovery owner');
  }
  if (entry.lockedReason === undefined) {
    await execGit(['worktree', 'lock', '--reason', expectedReason, plan.quarantinePath], {
      cwd: plan.projectRoot,
    });
    entry = findWorktree(await listGitWorktrees(plan.projectRoot), plan.quarantinePath);
    if (entry?.lockedReason !== expectedReason) {
      throw new Error('Quarantined worktree lock was not durably observed');
    }
  }
}

function encodeQuarantineEvidence(evidence: WorktreeQuarantineEvidence): JsonObject {
  return { ...evidence };
}

function decodeQuarantineEvidence(
  value: Readonly<JsonObject> | undefined,
  plan: Readonly<TaskRemovalCleanupPlan> & { quarantinePath: string },
  deletionOperationId: string,
): WorktreeQuarantineEvidence {
  const expectedReason = getLockReason(deletionOperationId);
  if (
    value?.version !== QUARANTINE_EVIDENCE_VERSION ||
    (value.state !== 'quarantined-attached' && value.state !== 'quarantined-detached') ||
    value.branchName !== plan.branchName ||
    value.originalWorktreePath !== plan.worktreePath ||
    value.quarantinePath !== plan.quarantinePath ||
    value.lockReason !== expectedReason ||
    typeof value.headOid !== 'string' ||
    !OID_PATTERN.test(value.headOid) ||
    (plan.deleteBranch && value.state !== 'quarantined-detached') ||
    (!plan.deleteBranch && value.state !== 'quarantined-attached')
  ) {
    throw new Error('Managed worktree quarantine evidence is invalid');
  }
  return {
    branchName: plan.branchName,
    headOid: value.headOid,
    lockReason: expectedReason,
    originalWorktreePath: plan.worktreePath,
    quarantinePath: plan.quarantinePath,
    state: value.state,
    version: QUARANTINE_EVIDENCE_VERSION,
  };
}

async function verifyQuarantinedWorktree(
  plan: Readonly<TaskRemovalCleanupPlan> & { quarantinePath: string },
  deletionOperationId: string,
): Promise<{ entry: GitWorktreeListEntry; headOid: string }> {
  const [sourceKind, quarantineKind, worktrees] = await Promise.all([
    getPathEntryKind(plan.worktreePath),
    getPathEntryKind(plan.quarantinePath),
    listGitWorktrees(plan.projectRoot),
  ]);
  const sourceEntry = findWorktree(worktrees, plan.worktreePath);
  const quarantineEntry = findWorktree(worktrees, plan.quarantinePath);
  if (
    sourceKind !== 'missing' ||
    sourceEntry !== null ||
    quarantineKind !== 'directory' ||
    quarantineEntry === null
  ) {
    throw new Error('Managed worktree quarantine ownership is inconsistent');
  }
  const expectedReason = getLockReason(deletionOperationId);
  if (quarantineEntry.lockedReason !== expectedReason) {
    throw new Error('Managed worktree quarantine lock is inconsistent');
  }
  const headOid = await readHeadOid(plan.quarantinePath);
  return { entry: quarantineEntry, headOid };
}

/**
 * Claims a managed worktree into an operation-specific, retained recovery location. The source is
 * never force-removed and the destination is never overwritten. A crash after Git moves the
 * registration is replayed from the exact quarantine registration.
 */
export async function quarantineManagedTaskWorktree(
  request: ManagedTaskWorktreeRemovalRequest,
): Promise<JsonObject> {
  const plan = requireManagedPlan(request);
  const [sourceKind, quarantineKind, worktrees] = await Promise.all([
    getPathEntryKind(plan.worktreePath),
    getPathEntryKind(plan.quarantinePath),
    listGitWorktrees(plan.projectRoot),
  ]);
  const sourceEntry = findWorktree(worktrees, plan.worktreePath);
  const quarantineEntry = findWorktree(worktrees, plan.quarantinePath);

  if (
    sourceKind === 'directory' &&
    sourceEntry &&
    quarantineKind === 'missing' &&
    !quarantineEntry
  ) {
    if (sourceEntry.detached || sourceEntry.branchName !== plan.branchName) {
      throw new Error('Managed worktree branch ownership changed before quarantine');
    }
    await prepareQuarantineParent(plan);
    if ((await getPathEntryKind(plan.quarantinePath)) !== 'missing') {
      throw new Error('Managed worktree recovery target appeared before claim');
    }
    await execGit(['worktree', 'move', plan.worktreePath, plan.quarantinePath], {
      cwd: plan.projectRoot,
    });
    invalidateGitQueryCacheForPath(plan.worktreePath);
    invalidateGitQueryCacheForPath(plan.quarantinePath);
    await lockQuarantinedWorktree(plan, request.deletionOperationId);
  } else if (
    sourceKind !== 'missing' ||
    sourceEntry !== null ||
    quarantineKind !== 'directory' ||
    quarantineEntry === null
  ) {
    throw new Error(
      `Managed worktree source/quarantine state requires recovery ` +
        `(source=${sourceKind}/${sourceEntry ? 'registered' : 'unregistered'}, ` +
        `quarantine=${quarantineKind}/${quarantineEntry ? 'registered' : 'unregistered'})`,
    );
  }
  await lockQuarantinedWorktree(plan, request.deletionOperationId);
  let observed = await verifyQuarantinedWorktree(plan, request.deletionOperationId);
  if (plan.deleteBranch) {
    if (!observed.entry.detached) {
      if (observed.entry.branchName !== plan.branchName) {
        throw new Error('Quarantined worktree branch changed before detach');
      }
      await execGit(['switch', '--detach', observed.headOid], { cwd: plan.quarantinePath });
      observed = await verifyQuarantinedWorktree(plan, request.deletionOperationId);
    }
    if (!observed.entry.detached || observed.entry.branchName !== null) {
      throw new Error('Quarantined worktree did not detach from its owned branch');
    }
  } else if (observed.entry.detached || observed.entry.branchName !== plan.branchName) {
    throw new Error('Preserved branch is not attached to its quarantined worktree');
  }

  return encodeQuarantineEvidence({
    branchName: plan.branchName,
    headOid: observed.headOid,
    lockReason: getLockReason(request.deletionOperationId),
    originalWorktreePath: plan.worktreePath,
    quarantinePath: plan.quarantinePath,
    state: plan.deleteBranch ? 'quarantined-detached' : 'quarantined-attached',
    version: QUARANTINE_EVIDENCE_VERSION,
  });
}

async function readBranchOid(projectRoot: string, branchName: string): Promise<string | null> {
  const refName = `refs/heads/${branchName}`;
  const { stdout } = await execGit(
    ['for-each-ref', '--count=1', '--format=%(objectname)', refName],
    { cwd: projectRoot },
  );
  const oid = stdout.trim().toLowerCase();
  if (oid.length === 0) return null;
  if (!OID_PATTERN.test(oid)) throw new Error('Owned branch ref evidence is invalid');
  return oid;
}

/** Deletes only the exact detached branch frontier proven by the retained quarantine evidence. */
export async function releaseQuarantinedTaskBranch(
  request: ManagedTaskWorktreeRemovalRequest,
  quarantineEvidence: Readonly<JsonObject> | undefined,
): Promise<JsonObject> {
  const plan = requireManagedPlan(request);
  if (!plan.deleteBranch) throw new Error('Preserved branches cannot enter branch release');
  const evidence = decodeQuarantineEvidence(quarantineEvidence, plan, request.deletionOperationId);
  const observed = await verifyQuarantinedWorktree(plan, request.deletionOperationId);
  if (!observed.entry.detached || observed.headOid !== evidence.headOid) {
    throw new Error('Quarantined worktree HEAD changed before branch release');
  }
  const branchOid = await readBranchOid(plan.projectRoot, plan.branchName);
  if (branchOid === null) {
    return {
      branchName: plan.branchName,
      headOid: evidence.headOid,
      state: 'already-released',
      version: QUARANTINE_EVIDENCE_VERSION,
    };
  }
  if (branchOid !== evidence.headOid) {
    throw new Error('Owned branch changed after worktree quarantine');
  }
  const refName = `refs/heads/${plan.branchName}`;
  await execGit(['update-ref', '-d', refName, evidence.headOid], { cwd: plan.projectRoot });
  if ((await readBranchOid(plan.projectRoot, plan.branchName)) !== null) {
    throw new Error('Owned branch release could not be verified');
  }
  return {
    branchName: plan.branchName,
    headOid: evidence.headOid,
    state: 'released',
    version: QUARANTINE_EVIDENCE_VERSION,
  };
}

/**
 * Creation-compensation adapter. It retains, detaches, and locks prepared bytes but deliberately
 * does not delete the branch. The returned bounded witnesses can be copied into the creation
 * journal before a later exact-OID branch CAS is admitted.
 */
export async function claimManagedWorktreeRecoveryQuarantine(
  request: Readonly<ManagedWorktreeRecoveryQuarantineRequest>,
): Promise<RetainedManagedWorktreeRecoveryEvidence> {
  const plan = recoveryPlan(request);
  const encoded = await quarantineManagedTaskWorktree({
    cleanupPlan: plan,
    deletionOperationId: request.operationId,
  });
  const evidence = decodeQuarantineEvidence(encoded, plan, request.operationId);
  const operationDigest = base64urlDigest(request.operationId);
  return {
    branchName: evidence.branchName,
    headOid: evidence.headOid,
    operationLockOwnershipWitness: base64urlDigest(evidence.lockReason),
    operationLockResourceId: `worktree-lock:${operationDigest}`,
    quarantineLocator: evidence.quarantinePath,
    recoveryId: `worktree-recovery:${operationDigest}`,
    resourceId: `managed-worktree:${base64urlDigest(`${plan.projectRoot}\u0000${plan.worktreePath}`)}`,
  };
}

/**
 * Rechecks the exact source/quarantine/registration/lock tuple created by the
 * failed-creation compensation owner. Partial or contradictory filesystem/Git
 * state is never collapsed into absence.
 */
export async function inspectManagedWorktreeRecoveryQuarantine(
  request: Readonly<ManagedWorktreeRecoveryQuarantineRequest>,
  identity: Readonly<ManagedWorktreeRecoveryIdentity>,
): Promise<ManagedWorktreeRecoveryInspection> {
  const plan = recoveryPlan(request);
  if (!matchesManagedWorktreeRecoveryIdentity(request, identity, plan)) {
    return { kind: 'proof-insufficient' };
  }
  try {
    const [sourceKind, quarantineKind, worktrees] = await Promise.all([
      getPathEntryKind(plan.worktreePath),
      getPathEntryKind(plan.quarantinePath),
      listGitWorktrees(plan.projectRoot),
    ]);
    const sourceEntry = findWorktree(worktrees, plan.worktreePath);
    const quarantineEntry = findWorktree(worktrees, plan.quarantinePath);
    if (quarantineKind === 'missing' && quarantineEntry === null) {
      return { kind: 'exact-absent' };
    }
    if (
      sourceKind !== 'missing' ||
      sourceEntry !== null ||
      quarantineKind !== 'directory' ||
      quarantineEntry === null ||
      quarantineEntry.detached !== true ||
      quarantineEntry.branchName !== null ||
      quarantineEntry.lockedReason !== getLockReason(request.operationId)
    ) {
      return { kind: 'proof-insufficient' };
    }
    return { headOid: await readHeadOid(plan.quarantinePath), kind: 'exact-present' };
  } catch {
    return { kind: 'proof-insufficient' };
  }
}

/** Exact branch CAS paired with `claimManagedWorktreeRecoveryQuarantine`. */
export async function releaseManagedWorktreeRecoveryBranch(
  request: Readonly<ManagedWorktreeRecoveryQuarantineRequest>,
  retained: Readonly<RetainedManagedWorktreeRecoveryEvidence>,
): Promise<JsonObject> {
  const plan = recoveryPlan(request);
  if (
    retained.branchName !== plan.branchName ||
    retained.quarantineLocator !== plan.quarantinePath ||
    retained.operationLockOwnershipWitness !==
      base64urlDigest(getLockReason(request.operationId)) ||
    !OID_PATTERN.test(retained.headOid)
  ) {
    throw new Error('Retained worktree recovery evidence does not match the requested operation');
  }
  return releaseQuarantinedTaskBranch(
    { cleanupPlan: plan, deletionOperationId: request.operationId },
    encodeQuarantineEvidence({
      branchName: plan.branchName,
      headOid: retained.headOid,
      lockReason: getLockReason(request.operationId),
      originalWorktreePath: plan.worktreePath,
      quarantinePath: plan.quarantinePath,
      state: 'quarantined-detached',
      version: QUARANTINE_EVIDENCE_VERSION,
    }),
  );
}
