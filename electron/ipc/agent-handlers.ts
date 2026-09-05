import { IPC } from './channels.js';
import { createHash } from 'node:crypto';
import { getAgentSupervisionSnapshot, listAgentSupervisionSnapshots } from './agent-supervision.js';
import { listAgents, requestAgentCatalogAvailabilityRevalidation } from './agents.js';
import {
  assertOptionalPauseReason,
  type HandlerContext,
  type IpcHandler,
} from './handler-context.js';
import {
  attachExistingAgentSessionExact,
  detachAgentOutput,
  getActiveAgentIds,
  getAgentCols,
  getAgentLifecycleGeneration,
  getAgentMeta,
  getAgentRows,
  getAgentScrollback,
  getAgentTerminalRecovery,
  getAgentTerminalStartupRecovery,
  hasAgentSession,
  pauseAgent,
  resizeAgent,
  resumeAgent,
  type AgentSpawnDisposition,
  writeToAgent,
} from './pty.js';
import type {
  AttachTerminalSessionRequest,
  AttachTerminalSessionResult,
  EnsureAgentSessionResult,
  TerminalSessionOwner,
} from '../../src/domain/renderer-invoke.js';
import { decodeTerminalRenderedTail, serializeTerminalRecoveryEntry } from './terminal-recovery.js';
import {
  getTaskCommandControllerSnapshot,
  getTaskCommandLeaseIdentity,
  isTaskCommandLeaseHeld,
} from './task-command-leases.js';
import {
  countRunningAndPendingTaskAgents,
  spawnOwnedTaskAgentWorkflow,
  stopAllTaskAgentWorkflows,
  stopTaskAgentWorkflow,
} from './task-workflows.js';
import { BadRequestError } from './errors.js';
import { consumeArenaTerminalLaunch } from './arena-terminal-launches.js';
import {
  recordTerminalRecoveryBatch,
  recordAgentSessionEnsureBatch,
  recordAgentSessionEnsureResult,
  recordScrollbackReplay,
  recordScrollbackReplayCacheHit,
  recordScrollbackReplayCacheMiss,
} from './runtime-diagnostics.js';
import { defineIpcHandler } from './typed-handler.js';
import { validateOptionalBranchName } from './path-utils.js';
import {
  assertInt,
  assertOptionalInt,
  assertOptionalString,
  assertString,
  assertStringArray,
} from './validate.js';
import { getRequiredChannelId } from './channel-id.js';
import { isValidBase64 } from '../../src/lib/base64.js';
import type {
  TerminalRecoveryBatchEntry,
  TerminalRecoveryRequestEntry,
  TerminalStartupRecoveryRequestEntry,
} from '../../src/ipc/types.js';
import type { ProjectMode } from '../../src/store/types.js';
import { createOrdinaryTaskPromptInputHandler } from './task-prompt-input-handler.js';
import type { TaskPromptInputAdmissionService } from './task-prompt-input-admission.js';

interface ScrollbackBatchEntrySnapshot {
  agentId: string;
  cols: number;
  scrollback: string | null;
}

interface CachedScrollbackBatch {
  expiresAt: number;
  promise: Promise<Map<string, ScrollbackBatchEntrySnapshot>>;
  resolved: boolean;
}

const SCROLLBACK_BATCH_CACHE_TTL_MS = 200;
const MAX_TERMINAL_ORDER_EPOCH_LENGTH = 100;
const pendingScrollbackBatchByKey = new Map<string, CachedScrollbackBatch>();

function clearExpiredScrollbackBatchEntries(now: number): void {
  for (const [cacheKey, entry] of pendingScrollbackBatchByKey) {
    if (!entry.resolved || entry.expiresAt > now) {
      continue;
    }

    pendingScrollbackBatchByKey.delete(cacheKey);
  }
}

function cacheResolvedScrollbackBatch(
  cacheKey: string,
  batchPromise: Promise<Map<string, ScrollbackBatchEntrySnapshot>>,
  result: Map<string, ScrollbackBatchEntrySnapshot>,
): void {
  const current = pendingScrollbackBatchByKey.get(cacheKey);
  if (current?.promise !== batchPromise) {
    return;
  }

  pendingScrollbackBatchByKey.set(cacheKey, {
    expiresAt: Date.now() + SCROLLBACK_BATCH_CACHE_TTL_MS,
    promise: Promise.resolve(result),
    resolved: true,
  });
}

function clearScrollbackBatchIfCurrent(
  cacheKey: string,
  batchPromise: Promise<Map<string, ScrollbackBatchEntrySnapshot>>,
): void {
  const current = pendingScrollbackBatchByKey.get(cacheKey);
  if (current?.promise === batchPromise) {
    pendingScrollbackBatchByKey.delete(cacheKey);
  }
}

function getScrollbackReplayReturnedBytes(entries: Array<{ scrollback: string | null }>): number {
  return entries.reduce(
    (total, entry) => total + Buffer.byteLength(entry.scrollback ?? '', 'base64'),
    0,
  );
}

function getUniqueAgentIds(agentIds: string[]): string[] {
  return Array.from(new Set(agentIds));
}

function getScrollbackBatchCacheKey(agentIds: string[]): string {
  return [...agentIds].sort().join('\n');
}

function assertBase64String(value: string, label: string): void {
  if (!isValidBase64(value)) {
    throw new BadRequestError(`${label} must be valid base64`);
  }
}

function assertTerminalOrderToken(
  epoch: string | undefined,
  seq: number | undefined,
  epochLabel: string,
  seqLabel: string,
): void {
  if ((epoch === undefined) !== (seq === undefined)) {
    throw new BadRequestError(`${epochLabel} and ${seqLabel} must both be provided`);
  }

  if (
    epoch !== undefined &&
    (epoch.length === 0 || epoch.length > MAX_TERMINAL_ORDER_EPOCH_LENGTH)
  ) {
    throw new BadRequestError(
      `${epochLabel} must be a non-empty string no longer than ${MAX_TERMINAL_ORDER_EPOCH_LENGTH} characters`,
    );
  }

  if (seq !== undefined && seq < 0) {
    throw new BadRequestError(`${seqLabel} must be a non-negative integer`);
  }
}

function createInputOrderToken(request: {
  inputEpoch?: string;
  inputSeq?: number;
}): Parameters<typeof writeToAgent>[3] {
  if (request.inputEpoch === undefined || request.inputSeq === undefined) {
    return undefined;
  }

  return {
    inputEpoch: request.inputEpoch,
    inputSeq: request.inputSeq,
  };
}

function createResizeOrderToken(request: {
  resizeEpoch?: string;
  resizeSeq?: number;
}): Parameters<typeof resizeAgent>[3] {
  if (request.resizeEpoch === undefined || request.resizeSeq === undefined) {
    return undefined;
  }

  return {
    resizeEpoch: request.resizeEpoch,
    resizeSeq: request.resizeSeq,
  };
}

function getRequiredRequestEntries(args: unknown): unknown[] {
  if (!args || typeof args !== 'object') {
    throw new BadRequestError('requests are required');
  }

  const request = args as { requests?: unknown };
  if (!Array.isArray(request.requests)) {
    throw new BadRequestError('requests are required');
  }

  return request.requests;
}

function assertRestoreLeaseIdMatchesReason(
  reason: unknown,
  restoreLeaseId: string | undefined,
): void {
  if (restoreLeaseId === '') {
    throw new BadRequestError('restoreLeaseId must be non-empty');
  }
  if (restoreLeaseId !== undefined && reason !== 'restore') {
    throw new BadRequestError('restoreLeaseId is only valid for restore pauses');
  }
}

function resumeRestorePausedAgents(pausedIds: string[]): void {
  for (const agentId of pausedIds.reverse()) {
    try {
      resumeAgent(agentId, 'restore');
    } catch {
      // best-effort cleanup
    }
  }
}

// Server-owned recovery batch pauses: the batch fetch keeps the 'restore'
// pause alive after responding so live Data frames cannot race the client's
// apply. The client releases the pause (ReleaseTerminalRecoveryPause) after
// applying the entry; the timer auto-resumes as a safety net if the release
// message is lost.
const RECOVERY_BATCH_PAUSE_TTL_MS = 5_000;
const heldRecoveryBatchPauses = new Map<
  string,
  { agentId: string; timer: ReturnType<typeof setTimeout> }
>();
let recoveryBatchPauseSequence = 0;

function releaseHeldTerminalRecoveryBatchPause(batchPauseId: string): void {
  const held = heldRecoveryBatchPauses.get(batchPauseId);
  if (!held) {
    return;
  }

  heldRecoveryBatchPauses.delete(batchPauseId);
  clearTimeout(held.timer);
  try {
    resumeAgent(held.agentId, 'restore');
  } catch {
    // best-effort cleanup
  }
}

function holdTerminalRecoveryBatchPause(agentId: string): string {
  recoveryBatchPauseSequence += 1;
  const batchPauseId = `recovery-pause-${recoveryBatchPauseSequence}`;
  const timer = setTimeout(() => {
    releaseHeldTerminalRecoveryBatchPause(batchPauseId);
  }, RECOVERY_BATCH_PAUSE_TTL_MS);
  timer.unref?.();
  heldRecoveryBatchPauses.set(batchPauseId, { agentId, timer });
  return batchPauseId;
}

export function releaseAllHeldTerminalRecoveryBatchPausesForTests(): void {
  for (const batchPauseId of [...heldRecoveryBatchPauses.keys()]) {
    releaseHeldTerminalRecoveryBatchPause(batchPauseId);
  }
}

function normalizeStartupVisibleTerminalCount(
  value: unknown,
  fallbackCount: number,
  label: string,
): number {
  if (value === undefined) {
    return fallbackCount;
  }

  assertInt(value, label);
  if (value <= 0) {
    throw new BadRequestError(`${label} must be a positive integer`);
  }

  return value;
}

function normalizeTerminalDimension(value: unknown, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }

  assertInt(value, label);
  if (value <= 0) {
    throw new BadRequestError(`${label} must be a positive integer`);
  }

  return value;
}

function assertTerminalDimension(value: unknown, label: string): asserts value is number {
  assertInt(value, label);
  if (value <= 0) {
    throw new BadRequestError(`${label} must be a positive integer`);
  }
}

async function fetchScrollbackBatch(
  agentIds: string[],
): Promise<Map<string, ScrollbackBatchEntrySnapshot>> {
  const pausedIds: string[] = [];
  const startedAt = performance.now();

  try {
    for (const agentId of agentIds) {
      if (!hasAgentSession(agentId)) {
        continue;
      }

      pauseAgent(agentId, 'restore');
      pausedIds.push(agentId);
    }

    const results = agentIds.map((agentId) => ({
      agentId,
      scrollback: getAgentScrollback(agentId),
      cols: getAgentCols(agentId),
    }));
    const returnedBytes = getScrollbackReplayReturnedBytes(results);
    recordScrollbackReplay(agentIds.length, returnedBytes, performance.now() - startedAt);
    return new Map(results.map((entry) => [entry.agentId, entry] as const));
  } finally {
    resumeRestorePausedAgents(pausedIds);
  }
}

async function fetchTerminalRecoveryBatch(
  requests: TerminalRecoveryRequestEntry[],
): Promise<TerminalRecoveryBatchEntry[]> {
  const uniqueAgentIds = getUniqueAgentIds(requests.map((request) => request.agentId));
  const pauseIdByAgentId = new Map<string, string>();
  const startedAt = performance.now();

  try {
    for (const agentId of uniqueAgentIds) {
      if (!hasAgentSession(agentId)) {
        continue;
      }

      // Always hold a request-scoped pause, even when the agent is already
      // paused: restore pause leases stack, so this request's pre-apply
      // window stays covered when a concurrent client's pause is released
      // (or its auto-resume timer fires) first.
      pauseAgent(agentId, 'restore');
      pauseIdByAgentId.set(agentId, holdTerminalRecoveryBatchPause(agentId));
    }

    const results: TerminalRecoveryBatchEntry[] = requests.map((request) => {
      const recovery = getAgentTerminalRecovery(
        request.agentId,
        decodeTerminalRenderedTail(request.renderedTail),
        request.outputCursor ?? null,
        request.snapshotByteLimit ?? null,
      );
      const entry = serializeTerminalRecoveryEntry(request.agentId, request.requestId, recovery);
      const batchPauseId = pauseIdByAgentId.get(request.agentId);
      return batchPauseId === undefined ? entry : { ...entry, batchPauseId };
    });
    recordTerminalRecoveryBatch(results, performance.now() - startedAt);
    return results;
  } catch (error) {
    for (const batchPauseId of pauseIdByAgentId.values()) {
      releaseHeldTerminalRecoveryBatchPause(batchPauseId);
    }
    throw error;
  }
}

async function fetchTerminalStartupRecoveryBatch(
  requests: TerminalStartupRecoveryRequestEntry[],
): Promise<TerminalRecoveryBatchEntry[]> {
  const startedAt = performance.now();
  const requestsByAgent = new Map<
    string,
    Array<{ index: number; request: TerminalStartupRecoveryRequestEntry }>
  >();
  const results: TerminalRecoveryBatchEntry[] = new Array(requests.length);

  for (const [index, request] of requests.entries()) {
    const entries = requestsByAgent.get(request.agentId) ?? [];
    entries.push({ index, request });
    requestsByAgent.set(request.agentId, entries);
  }

  for (const [agentId, entries] of requestsByAgent) {
    // Always hold a request-scoped pause for live sessions (leases stack);
    // see fetchTerminalRecoveryBatch for the concurrent-client rationale.
    const shouldPause = hasAgentSession(agentId);
    let batchPauseId: string | undefined;
    if (shouldPause) {
      pauseAgent(agentId, 'restore');
      batchPauseId = holdTerminalRecoveryBatchPause(agentId);
    }

    try {
      await Promise.all(
        entries.map(async ({ index, request }) => {
          const recovery = await getAgentTerminalStartupRecovery(
            request.agentId,
            null,
            null,
            request.role,
            request.visibleTerminalCount,
          );
          const entry = serializeTerminalRecoveryEntry(
            request.agentId,
            request.requestId,
            recovery,
          );
          results[index] = batchPauseId === undefined ? entry : { ...entry, batchPauseId };
        }),
      );
    } catch (error) {
      if (batchPauseId !== undefined) {
        releaseHeldTerminalRecoveryBatchPause(batchPauseId);
      }
      throw error;
    }
  }

  recordTerminalRecoveryBatch(results, performance.now() - startedAt);
  return results;
}

function getSharedScrollbackBatch(
  agentIds: string[],
): Promise<Map<string, ScrollbackBatchEntrySnapshot>> {
  const cacheKey = getScrollbackBatchCacheKey(agentIds);
  const now = Date.now();
  clearExpiredScrollbackBatchEntries(now);
  const existing = pendingScrollbackBatchByKey.get(cacheKey);
  if (existing && (!existing.resolved || existing.expiresAt > now)) {
    recordScrollbackReplayCacheHit();
    return existing.promise;
  }

  recordScrollbackReplayCacheMiss();
  const batchPromise = Promise.resolve().then(() => fetchScrollbackBatch(agentIds));
  pendingScrollbackBatchByKey.set(cacheKey, {
    expiresAt: now + SCROLLBACK_BATCH_CACHE_TTL_MS,
    promise: batchPromise,
    resolved: false,
  });

  void batchPromise.then(
    (result) => {
      cacheResolvedScrollbackBatch(cacheKey, batchPromise, result);
    },
    () => {
      clearScrollbackBatchIfCurrent(cacheKey, batchPromise);
    },
  );

  return batchPromise;
}

function getAgentTaskCommandTaskId(agentId: string, taskId?: string): string | null {
  const agentTaskId = getAgentMeta(agentId)?.taskId ?? null;
  if (taskId !== undefined && taskId !== agentTaskId) {
    throw new BadRequestError('taskId must match the agent task');
  }

  return agentTaskId;
}

function assertCanApplyTaskCommandMutation(request: {
  agentId: string;
  controllerId?: string;
  taskId?: string;
}): string | null {
  const taskId = getAgentTaskCommandTaskId(request.agentId, request.taskId);
  if (!taskId) {
    return null;
  }

  if (request.controllerId === undefined) {
    throw new BadRequestError('controllerId is required for task terminal mutations');
  }

  if (!isTaskCommandLeaseHeld(taskId, request.controllerId)) {
    const snapshot = getTaskCommandControllerSnapshot(taskId);
    throw new BadRequestError(
      snapshot.controllerId
        ? `Task is controlled by another client (${snapshot.controllerId})`
        : 'Task is controlled by another client',
    );
  }

  return taskId;
}

function assertExistingSessionTaskIdentity(request: { agentId: string; taskId: string }): boolean {
  if (!hasAgentSession(request.agentId)) return false;
  if (getAgentMeta(request.agentId)?.taskId !== request.taskId) {
    throw new BadRequestError('taskId must match the agent task');
  }
  return true;
}

function assertTaskSessionProcessAdmission(request: {
  agentId: string;
  arenaLaunchToken?: string;
  controllerId?: string;
  replaceExistingSession: boolean;
  taskId: string;
}): void {
  if (!request.replaceExistingSession && assertExistingSessionTaskIdentity(request)) {
    return;
  }
  // A backend-issued, one-shot Arena token is independently bound to the
  // exact task/agent/root and is consumed before any transient PTY effect.
  if (request.arenaLaunchToken !== undefined) {
    return;
  }

  // An absent controller identity is reserved for the trusted Electron host.
  // Browser transport rejects missing identities before reaching this handler.
  if (request.controllerId === undefined) {
    return;
  }

  if (!isTaskCommandLeaseHeld(request.taskId, request.controllerId)) {
    const snapshot = getTaskCommandControllerSnapshot(request.taskId);
    throw new BadRequestError(
      snapshot.controllerId
        ? `Task is controlled by another client (${snapshot.controllerId})`
        : 'Task is controlled by another client',
    );
  }
}

function assertOptionalProjectMode(value: unknown): asserts value is ProjectMode | undefined {
  if (value === undefined || value === 'git' || value === 'non-git') {
    return;
  }

  throw new BadRequestError('projectMode must be one of: git, non-git');
}

function assertEnsureAgentSessionsBatchReason(
  value: unknown,
): asserts value is 'dispatch-storm' | 'startup-restore' | 'user-action' {
  if (value === 'dispatch-storm' || value === 'startup-restore' || value === 'user-action') {
    return;
  }

  throw new BadRequestError('reason must be one of: startup-restore, dispatch-storm, user-action');
}

const TERMINAL_SESSION_OWNERS = new Set<TerminalSessionOwner>([
  'arena-transient',
  'compatibility-shell',
  'managed-agent',
  'managed-task-shell',
]);

function assertTerminalSessionOwner(value: unknown): asserts value is TerminalSessionOwner {
  if (typeof value !== 'string' || !TERMINAL_SESSION_OWNERS.has(value as TerminalSessionOwner)) {
    throw new BadRequestError('sessionOwner must identify a supported terminal-session owner');
  }
}

function assertManagedAttachRequestIsIdentityOnly(
  request: Extract<
    AttachTerminalSessionRequest,
    { sessionOwner: 'managed-agent' | 'managed-task-shell' }
  >,
): void {
  const allowedKeys = new Set([
    'agentId',
    'clientId',
    'initialRecovery',
    'onOutput',
    'sessionOwner',
    'taskId',
  ]);
  for (const key of Object.keys(request)) {
    if (!allowedKeys.has(key)) {
      throw new BadRequestError(`Managed terminal attach does not accept ${key}`);
    }
  }
}

function unavailableAttachResult(
  reason: Extract<AttachTerminalSessionResult, { kind: 'unavailable' }>['reason'],
): Extract<AttachTerminalSessionResult, { kind: 'unavailable' }> {
  return { channelBound: false, kind: 'unavailable', reason, recovery: null };
}

interface AgentSpawnRequestFields {
  adapter?: 'hydra';
  agentId: string;
  arenaLaunchToken?: string;
  args: string[];
  baseBranch?: string;
  cols?: number;
  command?: string;
  compatibilityIntent?: 'create';
  controllerId?: string;
  cwd?: string;
  env?: Record<string, string>;
  isShell?: boolean;
  onOutput: unknown;
  projectMode?: ProjectMode;
  replaceExistingSession?: boolean;
  resumeOnStart?: boolean;
  runnerProfile?: unknown;
  rows?: number;
  startsTaskWatchers?: boolean;
  taskId: string;
}

interface NormalizedAgentSpawnRequest {
  channelId: string;
  replaceExistingSession: boolean;
  requestedCols: number;
  requestedRows: number;
}

function compatibilitySpawnOperationId(
  purpose: 'desktop' | 'restore',
  taskId: string,
  agentId: string,
  replaceExistingSession: boolean,
): string {
  const sourceGeneration = getAgentLifecycleGeneration(agentId);
  const digest = createHash('sha256')
    .update(
      JSON.stringify([purpose, taskId, agentId, sourceGeneration, replaceExistingSession]),
      'utf8',
    )
    .digest('base64url');
  return `agent-session-compat:v1:${digest}`;
}

function assertAgentSpawnRequestFields(
  request: AgentSpawnRequestFields,
): NormalizedAgentSpawnRequest {
  assertString(request.taskId, 'taskId');
  assertString(request.agentId, 'agentId');
  assertOptionalString(request.arenaLaunchToken, 'arenaLaunchToken');
  assertStringArray(request.args, 'args');
  if (request.adapter !== undefined && request.adapter !== 'hydra') {
    throw new BadRequestError('adapter must be hydra when provided');
  }
  if (request.cwd !== undefined) {
    assertString(request.cwd, 'cwd');
  }
  if (request.isShell !== undefined && typeof request.isShell !== 'boolean') {
    throw new BadRequestError('isShell must be a boolean when provided');
  }
  if (request.startsTaskWatchers !== undefined && typeof request.startsTaskWatchers !== 'boolean') {
    throw new BadRequestError('startsTaskWatchers must be a boolean when provided');
  }
  if (request.startsTaskWatchers === true) {
    if (request.isShell !== true) {
      throw new BadRequestError('startsTaskWatchers requires a shell session');
    }
    if (!request.cwd?.trim()) {
      throw new BadRequestError('startsTaskWatchers requires a non-empty cwd');
    }
  }
  if (request.resumeOnStart !== undefined && typeof request.resumeOnStart !== 'boolean') {
    throw new BadRequestError('resumeOnStart must be a boolean when provided');
  }
  if (
    request.replaceExistingSession !== undefined &&
    typeof request.replaceExistingSession !== 'boolean'
  ) {
    throw new BadRequestError('replaceExistingSession must be a boolean when provided');
  }
  validateOptionalBranchName(request.baseBranch, 'baseBranch');
  assertOptionalProjectMode(request.projectMode);
  assertOptionalString(request.controllerId, 'controllerId');

  return {
    channelId: getRequiredChannelId(request.onOutput),
    replaceExistingSession: request.replaceExistingSession === true,
    requestedCols: normalizeTerminalDimension(request.cols, 80, 'cols'),
    requestedRows: normalizeTerminalDimension(request.rows, 24, 'rows'),
  };
}

async function runAgentSpawnRequest(
  context: HandlerContext,
  request: AgentSpawnRequestFields,
  normalized: NormalizedAgentSpawnRequest,
  bindOutputChannel?: () => boolean,
): Promise<AgentSpawnDisposition> {
  const { channelId, replaceExistingSession, requestedCols, requestedRows } = normalized;
  const assertProcessAdmission = (): void =>
    assertTaskSessionProcessAdmission({
      agentId: request.agentId,
      ...(request.arenaLaunchToken !== undefined
        ? { arenaLaunchToken: request.arenaLaunchToken }
        : {}),
      ...(request.controllerId !== undefined ? { controllerId: request.controllerId } : {}),
      replaceExistingSession,
      taskId: request.taskId,
    });
  assertProcessAdmission();

  if (
    context.agentSessionWriter?.isActive() === true &&
    request.isShell !== true &&
    (replaceExistingSession || !hasAgentSession(request.agentId))
  ) {
    throw new BadRequestError(
      'Managed agent sessions must be created or replaced through the session-operation owner',
    );
  }

  function spawnWorkflow(): Promise<AgentSpawnDisposition> {
    const hasSessionAtSpawn = hasAgentSession(request.agentId);
    const shouldAttachExistingSession = hasSessionAtSpawn && !replaceExistingSession;
    if (shouldAttachExistingSession && request.arenaLaunchToken !== undefined) {
      throw new BadRequestError('Arena terminal launch is unavailable');
    }
    // Attach-to-existing never resizes: the backend session geometry stays
    // authoritative regardless of the optimistic geometry on the request.
    const cols = shouldAttachExistingSession ? getAgentCols(request.agentId) : requestedCols;
    const rows = shouldAttachExistingSession ? getAgentRows(request.agentId) : requestedRows;
    let contentAuthorityClass: 'explicit-transient' | undefined;
    let contentAuthorityRoot: string | undefined;
    if (!shouldAttachExistingSession && request.arenaLaunchToken !== undefined) {
      const arenaLaunch = request.cwd
        ? consumeArenaTerminalLaunch({
            agentId: request.agentId,
            cwd: request.cwd,
            taskId: request.taskId,
            token: request.arenaLaunchToken,
          })
        : null;
      if (!arenaLaunch) {
        throw new BadRequestError('Arena terminal launch is unavailable');
      }
      contentAuthorityClass = 'explicit-transient';
      contentAuthorityRoot = arenaLaunch.root;
    }

    return spawnOwnedTaskAgentWorkflow(
      context,
      {
        operationId: compatibilitySpawnOperationId(
          'desktop',
          request.taskId,
          request.agentId,
          replaceExistingSession,
        ),
        purpose: 'desktop-compatibility',
      },
      {
        taskId: request.taskId,
        ...(request.baseBranch !== undefined ? { baseBranch: request.baseBranch } : {}),
        agentId: request.agentId,
        ...(contentAuthorityClass !== undefined ? { contentAuthorityClass } : {}),
        ...(contentAuthorityRoot !== undefined ? { contentAuthorityRoot } : {}),
        command: typeof request.command === 'string' ? request.command : '',
        args: request.args,
        assertSpawnAdmitted: assertProcessAdmission,
        ...(bindOutputChannel !== undefined ? { bindOutputChannel } : {}),
        cwd: typeof request.cwd === 'string' ? request.cwd : '',
        env: request.env,
        cols,
        rows,
        isShell: request.isShell === true,
        replaceExistingSession,
        resumeOnStart: request.resumeOnStart === true,
        onOutput: { __CHANNEL_ID__: channelId },
        ...(request.projectMode !== undefined ? { projectMode: request.projectMode } : {}),
        ...(request.adapter !== undefined ? { adapter: request.adapter } : {}),
        ...(request.runnerProfile !== undefined ? { runnerProfile: request.runnerProfile } : {}),
        ...(request.startsTaskWatchers === true ? { startsTaskWatchers: true } : {}),
      },
    );
  }

  return spawnWorkflow();
}

interface NormalizedInitialAttachRecoveryRequest {
  outputCursor: number | null;
  role: 'selected' | 'visible-sibling' | null;
  snapshotByteLimit: number | null;
  visibleTerminalCount: number;
}

function assertInitialAttachRecoveryRequest(
  value: unknown,
): NormalizedInitialAttachRecoveryRequest {
  if (!value || typeof value !== 'object') {
    throw new BadRequestError('initialRecovery is required');
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.role !== null &&
    candidate.role !== 'selected' &&
    candidate.role !== 'visible-sibling'
  ) {
    throw new BadRequestError('initialRecovery.role must be a startup recovery role or null');
  }
  if (candidate.outputCursor !== null && candidate.outputCursor !== undefined) {
    assertInt(candidate.outputCursor, 'initialRecovery.outputCursor');
    if (candidate.outputCursor < 0) {
      throw new BadRequestError('initialRecovery.outputCursor must be >= 0');
    }
  }
  if (candidate.snapshotByteLimit !== null && candidate.snapshotByteLimit !== undefined) {
    assertInt(candidate.snapshotByteLimit, 'initialRecovery.snapshotByteLimit');
    if (candidate.snapshotByteLimit < 0) {
      throw new BadRequestError('initialRecovery.snapshotByteLimit must be >= 0');
    }
  }
  const visibleTerminalCount = normalizeStartupVisibleTerminalCount(
    candidate.visibleTerminalCount,
    1,
    'initialRecovery.visibleTerminalCount',
  );

  return {
    outputCursor: typeof candidate.outputCursor === 'number' ? candidate.outputCursor : null,
    role: candidate.role as NormalizedInitialAttachRecoveryRequest['role'],
    snapshotByteLimit:
      typeof candidate.snapshotByteLimit === 'number' ? candidate.snapshotByteLimit : null,
    visibleTerminalCount,
  };
}

async function captureInitialAttachRecovery(
  agentId: string,
  initialRecovery: NormalizedInitialAttachRecoveryRequest,
): Promise<TerminalRecoveryBatchEntry> {
  pauseAgent(agentId, 'restore');
  const batchPauseId = holdTerminalRecoveryBatchPause(agentId);

  try {
    let recovery =
      initialRecovery.role === null
        ? getAgentTerminalRecovery(
            agentId,
            null,
            initialRecovery.outputCursor,
            initialRecovery.snapshotByteLimit,
          )
        : await getAgentTerminalStartupRecovery(
            agentId,
            null,
            null,
            initialRecovery.role,
            initialRecovery.visibleTerminalCount,
          );
    if (recovery.kind === 'tail-needed') {
      // A fresh attach has no rendered tail to offer in a phase-two request,
      // so a cursor miss resolves to the capped snapshot here.
      recovery = getAgentTerminalRecovery(agentId, null, null, initialRecovery.snapshotByteLimit);
    } else if (
      recovery.kind === 'delta' &&
      initialRecovery.outputCursor === 0 &&
      initialRecovery.snapshotByteLimit !== null &&
      recovery.data.length > initialRecovery.snapshotByteLimit
    ) {
      // A cursor-0 delta is a full-state transfer in disguise and therefore
      // honors the same byte budget as a snapshot.
      recovery = getAgentTerminalRecovery(agentId, null, null, initialRecovery.snapshotByteLimit);
    }
    return {
      ...serializeTerminalRecoveryEntry(agentId, 'attach-initial', recovery),
      batchPauseId,
    };
  } catch (error) {
    releaseHeldTerminalRecoveryBatchPause(batchPauseId);
    throw error;
  }
}

export interface AgentIpcHandlerOptions {
  promptInputAdmission: TaskPromptInputAdmissionService;
}

export function createAgentIpcHandlers(
  context: HandlerContext,
  options: AgentIpcHandlerOptions,
): Partial<Record<IPC, IpcHandler>> {
  const sendTaskPromptInput = createOrdinaryTaskPromptInputHandler({
    admission: options.promptInputAdmission,
    getAgentGeneration: getAgentLifecycleGeneration,
    getAgentMetadata: getAgentMeta,
    getLeaseIdentity: getTaskCommandLeaseIdentity,
    getSupervisionSnapshot: getAgentSupervisionSnapshot,
  });

  return {
    [IPC.SpawnAgent]: defineIpcHandler<IPC.SpawnAgent>(IPC.SpawnAgent, (args) => {
      assertString(args.taskId, 'taskId');
      assertString(args.agentId, 'agentId');
      getRequiredChannelId(args.onOutput);
      throw new BadRequestError(
        'SpawnAgent is retired; use AttachTerminalSession with an explicit sessionOwner',
      );
    }),

    [IPC.AttachTerminalSession]: defineIpcHandler<IPC.AttachTerminalSession>(
      IPC.AttachTerminalSession,
      async (args) => {
        const request: AttachTerminalSessionRequest = args;
        assertString(request.taskId, 'taskId');
        assertString(request.agentId, 'agentId');
        assertTerminalSessionOwner(request.sessionOwner);
        const channelId = getRequiredChannelId(request.onOutput);
        const initialRecovery = assertInitialAttachRecoveryRequest(request.initialRecovery);
        assertOptionalString(request.clientId, 'clientId');
        const clientId = typeof request.clientId === 'string' ? request.clientId : null;
        let channelBindingFailed = false;
        const bindChannel = (): boolean => {
          const bound = context.bindChannelForClient?.(clientId, channelId) ?? true;
          if (!bound) channelBindingFailed = true;
          return bound;
        };

        async function attachExactSession(
          generation: number,
          isShell: boolean,
          disposition: 'existing' | 'restored',
        ): Promise<AttachTerminalSessionResult> {
          let attached: AgentSpawnDisposition;
          try {
            attached = attachExistingAgentSessionExact(context.sendToChannel, {
              agentId: request.agentId,
              bindChannel,
              generation,
              isShell,
              onOutput: { __CHANNEL_ID__: channelId },
              taskId: request.taskId,
            });
          } catch {
            return unavailableAttachResult('identity-unavailable');
          }
          if (attached.channelBound === false) {
            return unavailableAttachResult('channel-unavailable');
          }
          return {
            channelBound: true,
            disposition,
            generation,
            kind: 'attached',
            recovery: await captureInitialAttachRecovery(request.agentId, initialRecovery),
          };
        }

        if (request.sessionOwner === 'managed-agent') {
          assertManagedAttachRequestIsIdentityOnly(request);
          const restoreCanonicalAgentSession = context.restoreCanonicalAgentSession;
          if (!restoreCanonicalAgentSession) {
            return unavailableAttachResult('session-state-unavailable');
          }
          const restored = await restoreCanonicalAgentSession({
            agentId: request.agentId,
            taskId: request.taskId,
          });
          if (restored.kind === 'unavailable') {
            return unavailableAttachResult(restored.reason);
          }
          if (restored.agentId !== request.agentId || restored.taskId !== request.taskId) {
            return unavailableAttachResult('identity-unavailable');
          }
          return attachExactSession(restored.generation, false, restored.kind);
        }

        if (request.sessionOwner === 'managed-task-shell') {
          assertManagedAttachRequestIsIdentityOnly(request);
        }

        const compatibilityRequest =
          request.sessionOwner === 'managed-task-shell'
            ? null
            : (request as Extract<
                AttachTerminalSessionRequest,
                { sessionOwner: 'arena-transient' | 'compatibility-shell' }
              >);
        const normalized = compatibilityRequest
          ? assertAgentSpawnRequestFields(compatibilityRequest)
          : null;
        if (compatibilityRequest?.sessionOwner === 'compatibility-shell') {
          if (
            compatibilityRequest.isShell !== true ||
            compatibilityRequest.arenaLaunchToken !== undefined
          ) {
            throw new BadRequestError(
              'compatibility-shell requires a shell session without an Arena launch token',
            );
          }
          if (
            compatibilityRequest.compatibilityIntent !== undefined &&
            compatibilityRequest.compatibilityIntent !== 'create'
          ) {
            throw new BadRequestError('compatibilityIntent must be create when provided');
          }
        } else if (
          compatibilityRequest?.sessionOwner === 'arena-transient' &&
          (compatibilityRequest.arenaLaunchToken === undefined ||
            compatibilityRequest.isShell === true ||
            compatibilityRequest.compatibilityIntent !== undefined)
        ) {
          throw new BadRequestError('arena-transient requires a non-shell Arena launch token');
        }

        if (request.sessionOwner !== 'arena-transient') {
          if (request.sessionOwner === 'compatibility-shell') {
            const classifyCanonicalAgentSessionIdentity =
              context.classifyCanonicalAgentSessionIdentity;
            if (!classifyCanonicalAgentSessionIdentity) {
              if (context.agentSessionWriter?.isActive() === true) {
                return unavailableAttachResult('session-state-unavailable');
              }
            } else {
              let classification: 'managed-agent' | 'unmanaged' | 'unavailable';
              try {
                classification = await classifyCanonicalAgentSessionIdentity({
                  agentId: request.agentId,
                  taskId: request.taskId,
                });
              } catch {
                classification = 'unavailable';
              }
              if (classification === 'managed-agent') {
                return unavailableAttachResult('identity-unavailable');
              }
              if (classification === 'unavailable') {
                return unavailableAttachResult('session-state-unavailable');
              }
            }
          }

          const restoreCanonicalTaskShellSession = context.restoreCanonicalTaskShellSession;
          if (!restoreCanonicalTaskShellSession) {
            if (context.agentSessionWriter?.isActive() === true) {
              return unavailableAttachResult('session-state-unavailable');
            }
            if (request.sessionOwner === 'managed-task-shell') {
              return unavailableAttachResult('task-shell-restore-unavailable');
            }
          } else {
            let restoredShell: Awaited<ReturnType<typeof restoreCanonicalTaskShellSession>>;
            try {
              restoredShell = await restoreCanonicalTaskShellSession(
                {
                  sessionId: request.agentId,
                  taskId: request.taskId,
                },
                compatibilityRequest?.compatibilityIntent === 'create'
                  ? { compatibilityIntent: 'create' }
                  : undefined,
              );
            } catch {
              return unavailableAttachResult('restore-failed');
            }
            if (restoredShell.kind === 'unavailable') {
              return unavailableAttachResult(restoredShell.reason);
            }
            if (
              restoredShell.sessionId !== request.agentId ||
              restoredShell.taskId !== request.taskId
            ) {
              return unavailableAttachResult('identity-unavailable');
            }
            if (restoredShell.kind === 'existing' || restoredShell.kind === 'restored') {
              return attachExactSession(restoredShell.generation, true, restoredShell.kind);
            }
            if (request.sessionOwner === 'managed-task-shell') {
              return unavailableAttachResult('task-shell-restore-unavailable');
            }
          }
        }

        if (!normalized || !compatibilityRequest) {
          return unavailableAttachResult('task-shell-restore-unavailable');
        }

        let spawnDisposition: AgentSpawnDisposition;
        try {
          spawnDisposition = await runAgentSpawnRequest(
            context,
            compatibilityRequest,
            normalized,
            bindChannel,
          );
        } catch (error) {
          if (channelBindingFailed) return unavailableAttachResult('channel-unavailable');
          throw error;
        }
        if (spawnDisposition.channelBound === false) {
          return unavailableAttachResult('channel-unavailable');
        }
        const generation = getAgentLifecycleGeneration(request.agentId);
        if (generation === null) return unavailableAttachResult('identity-unavailable');
        const attachedExistingSession = spawnDisposition.kind === 'attached-existing';
        return {
          channelBound: true,
          disposition: attachedExistingSession ? 'existing' : 'created',
          generation,
          kind: 'attached',
          recovery: attachedExistingSession
            ? await captureInitialAttachRecovery(request.agentId, initialRecovery)
            : null,
        };
      },
    ),

    [IPC.ReleaseTerminalRecoveryPause]: defineIpcHandler<IPC.ReleaseTerminalRecoveryPause>(
      IPC.ReleaseTerminalRecoveryPause,
      (args) => {
        const request = args;
        assertString(request.batchPauseId, 'batchPauseId');
        releaseHeldTerminalRecoveryBatchPause(request.batchPauseId);
        return undefined;
      },
    ),

    [IPC.EnsureAgentSessionsBatch]: defineIpcHandler<IPC.EnsureAgentSessionsBatch>(
      IPC.EnsureAgentSessionsBatch,
      async (args) => {
        const request = args;
        assertEnsureAgentSessionsBatchReason(request.reason);
        assertOptionalString(request.clientId, 'clientId');
        if (!Array.isArray(request.requests)) {
          throw new BadRequestError('requests must be an array');
        }

        const normalizedRequests = request.requests.map((candidate, index) => {
          if (!candidate || typeof candidate !== 'object') {
            throw new BadRequestError(`requests[${index}] must be an object`);
          }

          const entry = candidate as Record<string, unknown>;
          assertString(entry.taskId, `requests[${index}].taskId`);
          assertString(entry.agentId, `requests[${index}].agentId`);
          if (
            Object.keys(entry).length !== 2 ||
            !Object.prototype.hasOwnProperty.call(entry, 'taskId') ||
            !Object.prototype.hasOwnProperty.call(entry, 'agentId')
          ) {
            throw new BadRequestError(`requests[${index}] must contain exactly taskId and agentId`);
          }
          return { agentId: entry.agentId, taskId: entry.taskId };
        });

        recordAgentSessionEnsureBatch(normalizedRequests.length);

        const restoreCanonicalAgentSession = context.restoreCanonicalAgentSession;
        const inFlightByIdentity = new Map<string, Promise<EnsureAgentSessionResult>>();
        function restoreEntry(entry: {
          agentId: string;
          taskId: string;
        }): Promise<EnsureAgentSessionResult> {
          const key = `${entry.taskId}\u0000${entry.agentId}`;
          const existing = inFlightByIdentity.get(key);
          if (existing) return existing;

          const pending = (async (): Promise<EnsureAgentSessionResult> => {
            if (!restoreCanonicalAgentSession) {
              return { ...entry, kind: 'unavailable', reason: 'session-state-unavailable' };
            }
            try {
              const result = await restoreCanonicalAgentSession(entry);
              if (result.kind === 'unavailable') return { ...entry, ...result };
              if (result.agentId !== entry.agentId || result.taskId !== entry.taskId) {
                return { ...entry, kind: 'unavailable', reason: 'identity-unavailable' };
              }
              recordAgentSessionEnsureResult(result.kind === 'existing' ? 'existing' : 'created');
              return result;
            } catch {
              return { ...entry, kind: 'unavailable', reason: 'restore-failed' };
            }
          })();
          inFlightByIdentity.set(key, pending);
          return pending;
        }

        const results = await Promise.all(normalizedRequests.map(restoreEntry));

        return { results };
      },
    ),

    [IPC.WriteToAgent]: defineIpcHandler<IPC.WriteToAgent>(IPC.WriteToAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      assertString(request.data, 'data');
      assertOptionalString(request.controllerId, 'controllerId');
      assertOptionalString(request.inputEpoch, 'inputEpoch');
      assertOptionalInt(request.inputSeq, 'inputSeq');
      assertOptionalString(request.taskId, 'taskId');
      assertTerminalOrderToken(request.inputEpoch, request.inputSeq, 'inputEpoch', 'inputSeq');
      const taskId = assertCanApplyTaskCommandMutation(request);
      writeToAgent(
        request.agentId,
        request.data,
        request.trace && request.requestId
          ? {
              clientId: request.controllerId ?? null,
              requestId: request.requestId,
              taskId,
              trace: request.trace,
            }
          : undefined,
        createInputOrderToken(request),
      );
      return undefined;
    }),

    [IPC.SendTaskPromptInput]: defineIpcHandler<IPC.SendTaskPromptInput>(
      IPC.SendTaskPromptInput,
      async (args) => {
        assertString(args.agentId, 'agentId');
        assertString(args.controllerId, 'controllerId');
        assertString(args.taskId, 'taskId');
        assertString(args.text, 'text');
        if (args.text.length === 0) {
          throw new BadRequestError('text must not be empty');
        }

        return sendTaskPromptInput({
          agentId: args.agentId,
          controllerId: args.controllerId,
          taskId: args.taskId,
          text: args.text,
        });
      },
    ),

    [IPC.DetachAgentOutput]: defineIpcHandler<IPC.DetachAgentOutput>(
      IPC.DetachAgentOutput,
      (args) => {
        const request = args;
        assertString(request.agentId, 'agentId');
        assertString(request.channelId, 'channelId');
        detachAgentOutput(request.agentId, request.channelId);
        return undefined;
      },
    ),

    [IPC.GetAgentScrollback]: defineIpcHandler<IPC.GetAgentScrollback>(
      IPC.GetAgentScrollback,
      (args) => {
        const request = args;
        assertString(request.agentId, 'agentId');
        return getAgentScrollback(request.agentId);
      },
    ),

    [IPC.GetScrollbackBatch]: defineIpcHandler<IPC.GetScrollbackBatch>(
      IPC.GetScrollbackBatch,
      async (args) => {
        const request = args;
        assertStringArray(request.agentIds, 'agentIds');
        const agentIds = getUniqueAgentIds(request.agentIds);
        const scrollbackByAgentId = await getSharedScrollbackBatch(agentIds);
        return agentIds.map((agentId) => {
          return scrollbackByAgentId.get(agentId) ?? { agentId, scrollback: null, cols: 80 };
        });
      },
    ),

    [IPC.GetTerminalRecoveryBatch]: defineIpcHandler<IPC.GetTerminalRecoveryBatch>(
      IPC.GetTerminalRecoveryBatch,
      async (args) => {
        const requests = getRequiredRequestEntries(args);

        const normalizedRequests = requests.map((entry, index) => {
          if (!entry || typeof entry !== 'object') {
            throw new BadRequestError(`requests[${index}] must be an object`);
          }

          const candidate = entry as Record<string, unknown>;
          assertString(candidate.agentId, `requests[${index}].agentId`);
          assertString(candidate.requestId, `requests[${index}].requestId`);
          if (candidate.outputCursor !== null && candidate.outputCursor !== undefined) {
            assertInt(candidate.outputCursor, `requests[${index}].outputCursor`);
            if (candidate.outputCursor < 0) {
              throw new BadRequestError(`requests[${index}].outputCursor must be >= 0`);
            }
          }
          if (candidate.renderedTail !== null && candidate.renderedTail !== undefined) {
            assertString(candidate.renderedTail, `requests[${index}].renderedTail`);
            assertBase64String(candidate.renderedTail, `requests[${index}].renderedTail`);
          }
          if (candidate.snapshotByteLimit !== null && candidate.snapshotByteLimit !== undefined) {
            assertInt(candidate.snapshotByteLimit, `requests[${index}].snapshotByteLimit`);
            if (candidate.snapshotByteLimit < 0) {
              throw new BadRequestError(`requests[${index}].snapshotByteLimit must be >= 0`);
            }
          }

          return {
            agentId: candidate.agentId,
            outputCursor:
              typeof candidate.outputCursor === 'number' ? candidate.outputCursor : null,
            renderedTail:
              typeof candidate.renderedTail === 'string' ? candidate.renderedTail : null,
            requestId: candidate.requestId,
            snapshotByteLimit:
              typeof candidate.snapshotByteLimit === 'number' ? candidate.snapshotByteLimit : null,
          } satisfies TerminalRecoveryRequestEntry;
        });

        return fetchTerminalRecoveryBatch(normalizedRequests);
      },
    ),

    [IPC.GetTerminalStartupRecoveryBatch]: defineIpcHandler<IPC.GetTerminalStartupRecoveryBatch>(
      IPC.GetTerminalStartupRecoveryBatch,
      async (args) => {
        const requests = getRequiredRequestEntries(args);

        const normalizedRequests = requests.map((entry, index) => {
          if (!entry || typeof entry !== 'object') {
            throw new BadRequestError(`requests[${index}] must be an object`);
          }

          const candidate = entry as Record<string, unknown>;
          assertString(candidate.agentId, `requests[${index}].agentId`);
          assertString(candidate.requestId, `requests[${index}].requestId`);
          assertString(candidate.role, `requests[${index}].role`);
          if (candidate.role !== 'selected' && candidate.role !== 'visible-sibling') {
            throw new BadRequestError(`requests[${index}].role must be a startup recovery role`);
          }
          const visibleTerminalCount = normalizeStartupVisibleTerminalCount(
            candidate.visibleTerminalCount,
            requests.length,
            `requests[${index}].visibleTerminalCount`,
          );

          return {
            agentId: candidate.agentId,
            requestId: candidate.requestId,
            role: candidate.role,
            visibleTerminalCount,
          } satisfies TerminalStartupRecoveryRequestEntry;
        });

        return fetchTerminalStartupRecoveryBatch(normalizedRequests);
      },
    ),

    [IPC.ResizeAgent]: defineIpcHandler<IPC.ResizeAgent>(IPC.ResizeAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      assertTerminalDimension(request.cols, 'cols');
      assertTerminalDimension(request.rows, 'rows');
      assertOptionalString(request.controllerId, 'controllerId');
      assertOptionalString(request.resizeEpoch, 'resizeEpoch');
      assertOptionalInt(request.resizeSeq, 'resizeSeq');
      assertOptionalString(request.taskId, 'taskId');
      assertTerminalOrderToken(request.resizeEpoch, request.resizeSeq, 'resizeEpoch', 'resizeSeq');
      assertCanApplyTaskCommandMutation(request);
      resizeAgent(request.agentId, request.cols, request.rows, createResizeOrderToken(request));
      return undefined;
    }),

    [IPC.PauseAgent]: defineIpcHandler<IPC.PauseAgent>(IPC.PauseAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      assertOptionalPauseReason(request.reason);
      assertOptionalString(request.channelId, 'channelId');
      assertOptionalString(request.restoreLeaseId, 'restoreLeaseId');
      assertRestoreLeaseIdMatchesReason(request.reason, request.restoreLeaseId);
      if (
        request.reason === 'restore' &&
        request.channelId !== undefined &&
        context.isChannelActive?.(request.channelId) === false
      ) {
        return undefined;
      }
      pauseAgent(request.agentId, request.reason, request.channelId, request.restoreLeaseId);
      return undefined;
    }),

    [IPC.ResumeAgent]: defineIpcHandler<IPC.ResumeAgent>(IPC.ResumeAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      assertOptionalPauseReason(request.reason);
      assertOptionalString(request.channelId, 'channelId');
      assertOptionalString(request.restoreLeaseId, 'restoreLeaseId');
      assertRestoreLeaseIdMatchesReason(request.reason, request.restoreLeaseId);
      resumeAgent(request.agentId, request.reason, request.channelId, request.restoreLeaseId);
      return undefined;
    }),

    [IPC.KillAgent]: defineIpcHandler<IPC.KillAgent>(IPC.KillAgent, async (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      await stopTaskAgentWorkflow(request.agentId);
      return undefined;
    }),

    [IPC.CountRunningAgents]: () => countRunningAndPendingTaskAgents(),
    [IPC.KillAllAgents]: () => stopAllTaskAgentWorkflows(),
    [IPC.ListAgents]: defineIpcHandler<IPC.ListAgents>(IPC.ListAgents, (args) => {
      const request = args;
      assertOptionalString(request.hydraCommand, 'hydraCommand');
      return listAgents(request.hydraCommand);
    }),
    [IPC.RefreshAgentAvailability]: defineIpcHandler<IPC.RefreshAgentAvailability>(
      IPC.RefreshAgentAvailability,
      (args) => {
        const request = args;
        assertOptionalString(request.hydraCommand, 'hydraCommand');
        requestAgentCatalogAvailabilityRevalidation('dialog-open', request.hydraCommand);
        return undefined;
      },
    ),
    [IPC.GetAgentSupervision]: () => listAgentSupervisionSnapshots(),
    [IPC.ListRunningAgentIds]: () => getActiveAgentIds(),
  };
}
