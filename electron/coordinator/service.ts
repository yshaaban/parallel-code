import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  type CoordinatorActivityHintRequest,
  type CoordinatorCreateRunRequest,
  type CoordinatorCreateRunResult,
  type CoordinatorPersistenceHealth,
} from '../../src/domain/coordinator.js';
import type { StorageEnv } from '../ipc/storage.js';
import { getStateDirForEnv, writeJsonFileAtomically } from '../ipc/storage.js';
import {
  loadCoordinatorRuntimeStateForEnv,
  saveCoordinatorRuntimeStateForEnv,
  saveCoordinatorRuntimeStateForEnvAsync,
} from './persistence.js';
import {
  createCoordinatorPersistenceScheduler,
  type CoordinatorPersistenceScheduler,
} from './persistence-scheduler.js';
import {
  cancelCoordinatorPromptsForTask,
  cancelCoordinatorWorkflowLanesForTask,
  createCoordinatorRun,
  getCoordinatorRunIdBySubtaskTaskId,
  getCoordinatorRunMeta,
  getCoordinatorRunMetaByCoordinatorTaskId,
  getCoordinatorRuntimeState,
  getCoordinatorSubtask,
  removeCoordinatorRun,
  removeCoordinatorSubtaskLaunch,
  restoreCoordinatorRuntimeState,
  subscribeCoordinatorEvents,
  updateCoordinatorRunStatus,
  updateCoordinatorSubtaskStatus,
} from './runtime.js';

interface CoordinatorCredentialFile {
  agentId: string;
  createdAt: number;
  runId: string;
  taskId: string;
  token: string;
  tokenId: string;
  toolCommand?: string;
  toolCallTlsCertificate?: string;
  toolCallUrl?: string;
}

interface CoordinatorTokenRecord {
  agentId: string;
  createdAt: number;
  credentialPath: string;
  runId: string;
  taskId: string;
  token: string;
  tokenId: string;
  toolCommand?: string;
  toolCallTlsCertificate?: string;
  toolCallUrl?: string;
}

interface CoordinatorActivityHintRecord extends CoordinatorActivityHintRequest {
  expiresAt: number;
}

interface CoordinatorRuntimePersistenceOwner {
  scheduler: CoordinatorPersistenceScheduler;
  stateDir: string;
  stop: () => Promise<void>;
  stopPromise: Promise<void> | null;
}

let loadedStateDir: string | null = null;
let runtimePersistenceOwner: CoordinatorRuntimePersistenceOwner | null = null;
const tokenRecordsByToken = new Map<string, CoordinatorTokenRecord>();
const tokenRecordsByTaskId = new Map<string, CoordinatorTokenRecord>();
const activityHintsByKey = new Map<string, CoordinatorActivityHintRecord>();

function getCredentialDir(env: StorageEnv): string {
  return path.join(getStateDirForEnv(env), 'coordinator-credentials');
}

function createCredentialPath(env: StorageEnv, tokenId: string): string {
  return path.join(getCredentialDir(env), `${tokenId}.json`);
}

function createToken(): string {
  return randomBytes(32).toString('base64url');
}

function resolveOptionalString(value: unknown): string | undefined {
  if (typeof value === 'function') {
    const resolved: unknown = value();
    if (typeof resolved === 'string') {
      return resolved;
    }

    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  return undefined;
}

function getCoordinatorToolCallUrl(env: StorageEnv): string | undefined {
  const candidate = env as StorageEnv & { coordinatorToolCallUrl?: unknown };
  return resolveOptionalString(candidate.coordinatorToolCallUrl);
}

function getCoordinatorToolCallTlsCertificate(env: StorageEnv): string | undefined {
  const candidate = env as StorageEnv & { coordinatorToolCallTlsCertificate?: unknown };
  return resolveOptionalString(candidate.coordinatorToolCallTlsCertificate);
}

function quoteShellToken(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function getCoordinatorToolCommand(): string | undefined {
  const scriptPath = path.join(process.cwd(), 'scripts', 'coordinator-tool.mjs');
  if (!fs.existsSync(scriptPath)) {
    return undefined;
  }

  return `node ${quoteShellToken(scriptPath)}`;
}

function isCredentialFile(value: unknown): value is CoordinatorCredentialFile {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<CoordinatorCredentialFile>;
  return (
    typeof candidate.agentId === 'string' &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt) &&
    typeof candidate.runId === 'string' &&
    typeof candidate.taskId === 'string' &&
    typeof candidate.token === 'string' &&
    typeof candidate.tokenId === 'string' &&
    (candidate.toolCommand === undefined || typeof candidate.toolCommand === 'string') &&
    (candidate.toolCallTlsCertificate === undefined ||
      typeof candidate.toolCallTlsCertificate === 'string') &&
    (candidate.toolCallUrl === undefined || typeof candidate.toolCallUrl === 'string')
  );
}

function createTokenRecord(
  credentialPath: string,
  credential: CoordinatorCredentialFile,
): CoordinatorTokenRecord {
  return {
    agentId: credential.agentId,
    createdAt: credential.createdAt,
    credentialPath,
    runId: credential.runId,
    taskId: credential.taskId,
    token: credential.token,
    tokenId: credential.tokenId,
    ...(credential.toolCommand !== undefined ? { toolCommand: credential.toolCommand } : {}),
    ...(credential.toolCallTlsCertificate !== undefined
      ? { toolCallTlsCertificate: credential.toolCallTlsCertificate }
      : {}),
    ...(credential.toolCallUrl !== undefined ? { toolCallUrl: credential.toolCallUrl } : {}),
  };
}

function rememberTokenRecord(record: CoordinatorTokenRecord): void {
  tokenRecordsByToken.set(record.token, record);
  tokenRecordsByTaskId.set(record.taskId, record);
}

function credentialBelongsToRestoredRun(record: CoordinatorTokenRecord): boolean {
  const run = getCoordinatorRunMeta(record.runId);
  if (!run) {
    return false;
  }
  if (run.coordinatorTaskId === record.taskId) {
    return true;
  }

  return getCoordinatorSubtask(record.runId, record.taskId) !== null;
}

function restoreCoordinatorCredentials(env: StorageEnv, options: { pruneOrphans: boolean }): void {
  const credentialDir = getCredentialDir(env);
  tokenRecordsByToken.clear();
  tokenRecordsByTaskId.clear();

  let entries: string[];
  try {
    entries = fs.readdirSync(credentialDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }

    const credentialPath = path.join(credentialDir, entry);
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
      if (isCredentialFile(parsed)) {
        const record = createTokenRecord(credentialPath, parsed);
        if (credentialBelongsToRestoredRun(record)) {
          rememberTokenRecord(record);
        } else if (options.pruneOrphans) {
          // Orphan pruning is legal only when the state load legitimately
          // succeeded ('ok'). A failed or salvaged load must never delete
          // credential files for runs it could not see.
          fs.unlinkSync(credentialPath);
        }
      }
    } catch {
      // Ignore stale or partially-written credential files; the owning task can create a new run.
    }
  }
}

export function flushCoordinatorRuntimeState(env: StorageEnv): Promise<void> {
  if (runtimePersistenceOwner !== null) {
    return runtimePersistenceOwner.scheduler.flushNow();
  }

  saveCoordinatorRuntimeStateForEnv(env, getCoordinatorRuntimeState());
  return Promise.resolve();
}

export function getCoordinatorPersistenceHealth(): CoordinatorPersistenceHealth | null {
  return runtimePersistenceOwner?.scheduler.getHealth() ?? null;
}

export function ensureCoordinatorServiceLoaded(env: StorageEnv): void {
  const stateDir = getStateDirForEnv(env);
  if (loadedStateDir === stateDir) {
    return;
  }

  const loadResult = loadCoordinatorRuntimeStateForEnv(env);
  restoreCoordinatorRuntimeState(
    loadResult.state ?? {
      runs: [],
      stateVersion: 0,
      subtaskLaunches: [],
      toolCallResults: [],
    },
  );
  // 'missing' is a legitimately empty fresh boot; only 'failed'/'salvaged'
  // loads must never prune (the runs the credentials belong to may still exist).
  restoreCoordinatorCredentials(env, {
    pruneOrphans: loadResult.outcome === 'ok' || loadResult.outcome === 'missing',
  });

  loadedStateDir = stateDir;
}

export function startCoordinatorRuntimePersistence(env: StorageEnv): () => Promise<void> {
  const stateDir = getStateDirForEnv(env);
  if (runtimePersistenceOwner !== null) {
    if (
      runtimePersistenceOwner.stateDir === stateDir &&
      runtimePersistenceOwner.stopPromise === null
    ) {
      return () => Promise.resolve();
    }

    throw new Error('Cannot start coordinator persistence before its previous owner has stopped');
  }

  ensureCoordinatorServiceLoaded(env);
  const scheduler = createCoordinatorPersistenceScheduler({
    save: () => saveCoordinatorRuntimeStateForEnvAsync(env, getCoordinatorRuntimeState()),
  });
  const unsubscribe = subscribeCoordinatorEvents(() => {
    scheduler.schedulePersist();
  });
  let subscribed = true;
  const owner: CoordinatorRuntimePersistenceOwner = {
    scheduler,
    stateDir,
    stopPromise: null,
    stop: () => {
      if (owner.stopPromise !== null) {
        return owner.stopPromise;
      }

      if (subscribed) {
        subscribed = false;
        unsubscribe();
      }
      const stopPromise = scheduler.stop().finally(() => {
        if (runtimePersistenceOwner === owner) {
          runtimePersistenceOwner = null;
        }
      });
      owner.stopPromise = stopPromise;
      return stopPromise;
    },
  };
  runtimePersistenceOwner = owner;
  return owner.stop;
}

export function hasCoordinatorToolCallUrl(env: StorageEnv): boolean {
  return getCoordinatorToolCallUrl(env) !== undefined;
}

export function createCoordinatorCredential(
  env: StorageEnv,
  options: {
    agentId: string;
    runId: string;
    taskId: string;
    toolCommand?: string;
    toolCallUrl?: string | (() => string);
  },
): CoordinatorTokenRecord {
  ensureCoordinatorServiceLoaded(env);
  const token = createToken();
  const tokenId = randomUUID();
  const credentialPath = createCredentialPath(env, tokenId);
  const createdAt = Date.now();
  const toolCallUrl = resolveOptionalString(options.toolCallUrl);
  const toolCallTlsCertificate = toolCallUrl?.startsWith('https:')
    ? getCoordinatorToolCallTlsCertificate(env)
    : undefined;
  const toolCommand =
    toolCallUrl === undefined ? undefined : (options.toolCommand ?? getCoordinatorToolCommand());
  const credential: CoordinatorCredentialFile = {
    agentId: options.agentId,
    createdAt,
    runId: options.runId,
    taskId: options.taskId,
    token,
    tokenId,
    ...(toolCommand !== undefined ? { toolCommand } : {}),
    ...(toolCallTlsCertificate !== undefined ? { toolCallTlsCertificate } : {}),
    ...(toolCallUrl !== undefined ? { toolCallUrl } : {}),
  };
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
  writeJsonFileAtomically(credentialPath, JSON.stringify(credential));
  try {
    fs.chmodSync(credentialPath, 0o600);
  } catch {
    // Best effort on platforms/filesystems that do not support chmod.
  }

  const record: CoordinatorTokenRecord = {
    agentId: options.agentId,
    createdAt,
    credentialPath,
    runId: options.runId,
    taskId: options.taskId,
    token,
    tokenId,
    ...(toolCommand !== undefined ? { toolCommand } : {}),
    ...(toolCallTlsCertificate !== undefined ? { toolCallTlsCertificate } : {}),
    ...(toolCallUrl !== undefined ? { toolCallUrl } : {}),
  };
  rememberTokenRecord(record);
  return record;
}

export function createCoordinatorRunForTask(
  env: StorageEnv,
  request: CoordinatorCreateRunRequest,
): CoordinatorCreateRunResult {
  const result = createCoordinatorRunForTaskInMemory(env, request);
  void flushCoordinatorRuntimeState(env).catch((error: unknown) => {
    console.error('Failed to flush coordinator state after run creation:', error);
  });
  return result;
}

function createCoordinatorRunForTaskInMemory(
  env: StorageEnv,
  request: CoordinatorCreateRunRequest,
): CoordinatorCreateRunResult {
  ensureCoordinatorServiceLoaded(env);
  const toolCallUrl = getCoordinatorToolCallUrl(env);
  if (toolCallUrl === undefined) {
    throw new Error('Coordinator mode requires the browser server tool-call gateway.');
  }

  const existingCredential = tokenRecordsByTaskId.get(request.coordinatorTaskId);
  if (existingCredential) {
    throw new Error(`Coordinator task already has a run: ${request.coordinatorTaskId}`);
  }
  const existingRun = getCoordinatorRunMetaByCoordinatorTaskId(request.coordinatorTaskId);
  if (existingRun) {
    throw new Error(`Coordinator task already has a run: ${request.coordinatorTaskId}`);
  }

  const run = createCoordinatorRun({
    coordinatorTaskId: request.coordinatorTaskId,
    projectId: request.projectId,
    projectMode: request.projectMode,
    projectRoot: request.projectRoot,
  });
  const toolCommand = getCoordinatorToolCommand();
  let credential: ReturnType<typeof createCoordinatorCredential>;
  try {
    credential = createCoordinatorCredential(env, {
      agentId: request.coordinatorAgentId,
      runId: run.id,
      taskId: request.coordinatorTaskId,
      ...(toolCommand !== undefined ? { toolCommand } : {}),
      ...(toolCallUrl !== undefined ? { toolCallUrl } : {}),
    });
  } catch (error) {
    removeCoordinatorRun(run.id);
    throw error;
  }
  return {
    credentialPath: credential.credentialPath,
    run,
    ...(credential.toolCommand !== undefined ? { toolCommand: credential.toolCommand } : {}),
  };
}

/** Creates the coordinator run and credential before reporting preparation complete. */
export async function createCoordinatorRunForTaskDurably(
  env: StorageEnv,
  request: CoordinatorCreateRunRequest,
): Promise<CoordinatorCreateRunResult> {
  const result = createCoordinatorRunForTaskInMemory(env, request);
  try {
    await flushCoordinatorRuntimeState(env);
    return result;
  } catch (error) {
    revokeCoordinatorTaskCredential(env, request.coordinatorTaskId);
    removeCoordinatorRun(result.run.id);
    await flushCoordinatorRuntimeState(env).catch(() => undefined);
    throw error;
  }
}

export interface CoordinatorTaskLaunchMetadata {
  credentialPath: string;
  runId: string;
  toolCommand?: string;
}

/** Exact restart-safe lookup used only by the trusted desktop creation workflow. */
export function getCoordinatorTaskLaunchMetadata(
  env: StorageEnv,
  taskId: string,
  agentId: string,
): CoordinatorTaskLaunchMetadata | null {
  ensureCoordinatorServiceLoaded(env);
  const run = getCoordinatorRunMetaByCoordinatorTaskId(taskId);
  const credential = tokenRecordsByTaskId.get(taskId);
  if (!run && !credential) return null;
  if (
    !run ||
    !credential ||
    credential.runId !== run.id ||
    credential.taskId !== taskId ||
    credential.agentId !== agentId
  ) {
    throw new Error('Coordinator task launch metadata requires recovery');
  }
  return {
    credentialPath: credential.credentialPath,
    runId: run.id,
    ...(credential.toolCommand !== undefined ? { toolCommand: credential.toolCommand } : {}),
  };
}

export function resolveCoordinatorToken(token: string): CoordinatorTokenRecord | null {
  return tokenRecordsByToken.get(token) ?? null;
}

export function revokeCoordinatorTaskCredential(env: StorageEnv, taskId: string): void {
  ensureCoordinatorServiceLoaded(env);
  const record = tokenRecordsByTaskId.get(taskId);
  if (!record) {
    return;
  }

  tokenRecordsByTaskId.delete(taskId);
  tokenRecordsByToken.delete(record.token);
  try {
    fs.unlinkSync(record.credentialPath);
  } catch {
    // Best effort; removed token indexes are authoritative for current runtime.
  }
}

export function revokeCoordinatorRunCredentials(env: StorageEnv, runId: string): void {
  ensureCoordinatorServiceLoaded(env);
  const taskIds = [...tokenRecordsByTaskId.values()]
    .filter((record) => record.runId === runId)
    .map((record) => record.taskId);
  for (const taskId of taskIds) {
    revokeCoordinatorTaskCredential(env, taskId);
  }
}

export function cleanupCoordinatorStateForTask(env: StorageEnv, taskId: string): void {
  ensureCoordinatorServiceLoaded(env);
  const run = getCoordinatorRunMetaByCoordinatorTaskId(taskId);
  if (run) {
    if (run.status !== 'cancelled') {
      updateCoordinatorRunStatus(run.id, 'cancelled');
    }
    revokeCoordinatorRunCredentials(env, run.id);
    removeCoordinatorRun(run.id);
    void flushCoordinatorRuntimeState(env).catch((error: unknown) => {
      console.error('Failed to flush coordinator state after task cleanup:', error);
    });
    return;
  }

  const candidateRunId = getCoordinatorRunIdBySubtaskTaskId(taskId);
  if (candidateRunId) {
    revokeCoordinatorTaskCredential(env, taskId);
    cancelCoordinatorPromptsForTask(candidateRunId, taskId, 'task-cleaned-up');
    cancelCoordinatorWorkflowLanesForTask(candidateRunId, taskId, 'task-cleaned-up');
    removeCoordinatorSubtaskLaunch(candidateRunId, taskId);
    updateCoordinatorSubtaskStatus(candidateRunId, taskId, 'cancelled', {
      interruptedByRestoreAt: undefined,
    });
    void flushCoordinatorRuntimeState(env).catch((error: unknown) => {
      console.error('Failed to flush coordinator state after subtask cleanup:', error);
    });
    return;
  }
}

export async function cleanupCoordinatorStateForTaskDurably(
  env: StorageEnv,
  taskId: string,
): Promise<void> {
  cleanupCoordinatorStateForTask(env, taskId);
  await flushCoordinatorRuntimeState(env);
}

export function getCoordinatorTaskCredentialPath(taskId: string): string | null {
  return tokenRecordsByTaskId.get(taskId)?.credentialPath ?? null;
}

function getActivityHintKey(
  request: Pick<CoordinatorActivityHintRequest, 'clientId' | 'kind' | 'taskId'>,
): string {
  return `${request.clientId}:${request.taskId}:${request.kind}`;
}

export function applyCoordinatorActivityHint(request: CoordinatorActivityHintRequest): void {
  const key = getActivityHintKey(request);
  const current = activityHintsByKey.get(key);
  if (current && current.seq > request.seq) {
    return;
  }

  if (!request.blocked) {
    activityHintsByKey.delete(key);
    return;
  }

  activityHintsByKey.set(key, {
    ...request,
    expiresAt: Date.now() + (request.ttlMs ?? 3_000),
  });
}

export function getCoordinatorBlockingActivityHints(
  taskId: string,
  now = Date.now(),
): CoordinatorActivityHintRequest[] {
  const active: CoordinatorActivityHintRequest[] = [];
  for (const [key, hint] of activityHintsByKey) {
    if (hint.expiresAt <= now) {
      activityHintsByKey.delete(key);
      continue;
    }
    if (hint.taskId === taskId) {
      active.push({
        agentGeneration: hint.agentGeneration,
        blocked: hint.blocked,
        clientId: hint.clientId,
        kind: hint.kind,
        seq: hint.seq,
        taskId: hint.taskId,
        ...(hint.ttlMs !== undefined ? { ttlMs: hint.ttlMs } : {}),
      });
    }
  }

  return active;
}

// Returns a promise that settles once the scheduler's authoritative final
// snapshot has landed, so teardown can deterministically remove temp state
// dirs without a wall-clock sleep.
export function resetCoordinatorServiceForTests(): Promise<void> {
  loadedStateDir = null;
  const owner = runtimePersistenceOwner;
  tokenRecordsByToken.clear();
  tokenRecordsByTaskId.clear();
  activityHintsByKey.clear();
  return owner?.stop() ?? Promise.resolve();
}
