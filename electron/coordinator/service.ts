import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  type CoordinatorActivityHintRequest,
  type CoordinatorCreateRunRequest,
  type CoordinatorCreateRunResult,
} from '../../src/domain/coordinator.js';
import type { StorageEnv } from '../ipc/storage.js';
import { getStateDirForEnv, writeJsonFileAtomically } from '../ipc/storage.js';
import {
  loadCoordinatorRuntimeStateForEnv,
  saveCoordinatorRuntimeStateForEnv,
} from './persistence.js';
import {
  cancelCoordinatorPromptsForTask,
  cancelCoordinatorWorkflowLanesForTask,
  createCoordinatorRun,
  getCoordinatorRun,
  getCoordinatorRunByCoordinatorTaskId,
  getCoordinatorRuntimeState,
  listCoordinatorRuns,
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
  toolCallUrl?: string;
}

interface CoordinatorActivityHintRecord extends CoordinatorActivityHintRequest {
  expiresAt: number;
}

let loadedStateDir: string | null = null;
let runtimePersistenceCleanup: (() => void) | null = null;
let runtimePersistenceStateDir: string | null = null;
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

function resolveCoordinatorToolCallUrl(value: unknown): string | undefined {
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
  return resolveCoordinatorToolCallUrl(candidate.coordinatorToolCallUrl);
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
    ...(credential.toolCallUrl !== undefined ? { toolCallUrl: credential.toolCallUrl } : {}),
  };
}

function rememberTokenRecord(record: CoordinatorTokenRecord): void {
  tokenRecordsByToken.set(record.token, record);
  tokenRecordsByTaskId.set(record.taskId, record);
}

function credentialBelongsToRestoredRun(record: CoordinatorTokenRecord): boolean {
  const run = getCoordinatorRun(record.runId);
  if (!run) {
    return false;
  }
  if (run.coordinatorTaskId === record.taskId) {
    return true;
  }

  return run.subtasks.some((subtask) => subtask.taskId === record.taskId);
}

function restoreCoordinatorCredentials(env: StorageEnv): void {
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
        } else {
          fs.unlinkSync(credentialPath);
        }
      }
    } catch {
      // Ignore stale or partially-written credential files; the owning task can create a new run.
    }
  }
}

function persistRuntimeState(env: StorageEnv): void {
  saveCoordinatorRuntimeStateForEnv(env, getCoordinatorRuntimeState());
}

export function ensureCoordinatorServiceLoaded(env: StorageEnv): void {
  const stateDir = getStateDirForEnv(env);
  if (loadedStateDir === stateDir) {
    return;
  }

  const persisted = loadCoordinatorRuntimeStateForEnv(env);
  if (persisted) {
    restoreCoordinatorRuntimeState(persisted);
  } else {
    restoreCoordinatorRuntimeState({
      runs: [],
      stateVersion: 0,
      subtaskLaunches: [],
      toolCallResults: [],
    });
  }
  restoreCoordinatorCredentials(env);

  loadedStateDir = stateDir;
}

export function startCoordinatorRuntimePersistence(env: StorageEnv): () => void {
  ensureCoordinatorServiceLoaded(env);
  const stateDir = getStateDirForEnv(env);
  if (runtimePersistenceStateDir === stateDir && runtimePersistenceCleanup !== null) {
    return () => {};
  }

  runtimePersistenceCleanup?.();
  runtimePersistenceStateDir = stateDir;
  runtimePersistenceCleanup = subscribeCoordinatorEvents(() => {
    persistRuntimeState(env);
  });
  return () => {
    if (runtimePersistenceStateDir !== stateDir) {
      return;
    }

    runtimePersistenceCleanup?.();
    runtimePersistenceCleanup = null;
    runtimePersistenceStateDir = null;
  };
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
  const toolCallUrl = resolveCoordinatorToolCallUrl(options.toolCallUrl);
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
    ...(toolCallUrl !== undefined ? { toolCallUrl } : {}),
  };
  rememberTokenRecord(record);
  return record;
}

export function createCoordinatorRunForTask(
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
  const existingRun = getCoordinatorRunByCoordinatorTaskId(request.coordinatorTaskId);
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
  persistRuntimeState(env);

  return {
    credentialPath: credential.credentialPath,
    run,
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
  const run = getCoordinatorRunByCoordinatorTaskId(taskId);
  if (run) {
    updateCoordinatorRunStatus(run.id, 'cancelled');
    revokeCoordinatorRunCredentials(env, run.id);
    removeCoordinatorRun(run.id);
    persistRuntimeState(env);
    return;
  }

  for (const candidate of listCoordinatorRuns()) {
    if (!candidate.subtasks.some((subtask) => subtask.taskId === taskId)) {
      continue;
    }

    revokeCoordinatorTaskCredential(env, taskId);
    cancelCoordinatorPromptsForTask(candidate.id, taskId, 'task-cleaned-up');
    cancelCoordinatorWorkflowLanesForTask(candidate.id, taskId, 'task-cleaned-up');
    removeCoordinatorSubtaskLaunch(candidate.id, taskId);
    updateCoordinatorSubtaskStatus(candidate.id, taskId, 'cancelled', {
      interruptedByRestoreAt: undefined,
    });
    persistRuntimeState(env);
    return;
  }
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

export function resetCoordinatorServiceForTests(): void {
  loadedStateDir = null;
  runtimePersistenceCleanup?.();
  runtimePersistenceCleanup = null;
  runtimePersistenceStateDir = null;
  tokenRecordsByToken.clear();
  tokenRecordsByTaskId.clear();
  activityHintsByKey.clear();
}
