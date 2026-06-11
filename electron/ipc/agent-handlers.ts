import { performance } from 'node:perf_hooks';

import { IPC } from './channels.js';
import { normalizeAgentRunnerProfileConfig } from './agent-runner-handlers.js';
import { listAgentSupervisionSnapshots } from './agent-supervision.js';
import { listAgents, requestAgentCatalogAvailabilityRevalidation } from './agents.js';
import {
  assertOptionalPauseReason,
  type HandlerContext,
  type IpcHandler,
} from './handler-context.js';
import {
  countRunningAgents,
  detachAgentOutput,
  getActiveAgentIds,
  getAgentCols,
  getAgentMeta,
  getAgentRows,
  getAgentScrollback,
  getAgentTerminalRecovery,
  getAgentTerminalStartupRecovery,
  hasAgentSession,
  killAgent,
  killAllAgents,
  pauseAgent,
  resizeAgent,
  resumeAgent,
  writeToAgent,
} from './pty.js';
import { decodeTerminalRenderedTail, serializeTerminalRecoveryEntry } from './terminal-recovery.js';
import { getTaskCommandControllerSnapshot, isTaskCommandLeaseHeld } from './task-command-leases.js';
import { spawnTaskAgentWorkflow } from './task-workflows.js';
import { BadRequestError } from './errors.js';
import {
  recordTerminalRecoveryBatch,
  recordAgentSessionEnsureBatch,
  recordAgentSessionEnsureResult,
  recordAgentSessionSpawnAdmissionState,
  recordAgentSessionSpawnAdmissionWait,
  recordAgentSessionSpawnDuration,
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
const MAX_CONCURRENT_AGENT_SESSION_SPAWNS = 4;
const pendingScrollbackBatchByKey = new Map<string, CachedScrollbackBatch>();
const pendingAgentSessionSpawnAdmissions: Array<() => void> = [];
let activeAgentSessionSpawns = 0;

async function acquireAgentSessionSpawnAdmission(): Promise<void> {
  const startedAt = performance.now();
  if (activeAgentSessionSpawns < MAX_CONCURRENT_AGENT_SESSION_SPAWNS) {
    activeAgentSessionSpawns += 1;
    recordAgentSessionSpawnAdmissionState({
      activeSpawns: activeAgentSessionSpawns,
      pendingSpawns: pendingAgentSessionSpawnAdmissions.length,
    });
    recordAgentSessionSpawnAdmissionWait(performance.now() - startedAt);
    return;
  }

  await new Promise<void>((resolve) => {
    pendingAgentSessionSpawnAdmissions.push(resolve);
    recordAgentSessionSpawnAdmissionState({
      activeSpawns: activeAgentSessionSpawns,
      pendingSpawns: pendingAgentSessionSpawnAdmissions.length,
    });
  });
  recordAgentSessionSpawnAdmissionState({
    activeSpawns: activeAgentSessionSpawns,
    pendingSpawns: pendingAgentSessionSpawnAdmissions.length,
  });
  recordAgentSessionSpawnAdmissionWait(performance.now() - startedAt);
}

function releaseAgentSessionSpawnAdmission(): void {
  const nextAdmission = pendingAgentSessionSpawnAdmissions.shift();
  if (nextAdmission) {
    recordAgentSessionSpawnAdmissionState({
      activeSpawns: activeAgentSessionSpawns,
      pendingSpawns: pendingAgentSessionSpawnAdmissions.length,
    });
    nextAdmission();
    return;
  }

  activeAgentSessionSpawns = Math.max(0, activeAgentSessionSpawns - 1);
  recordAgentSessionSpawnAdmissionState({
    activeSpawns: activeAgentSessionSpawns,
    pendingSpawns: pendingAgentSessionSpawnAdmissions.length,
  });
}

async function runNewAgentSessionSpawn<T>(operation: () => Promise<T> | T): Promise<T> {
  await acquireAgentSessionSpawnAdmission();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    recordAgentSessionSpawnDuration(performance.now() - startedAt);
    releaseAgentSessionSpawnAdmission();
  }
}

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

interface AgentSpawnRequestFields {
  adapter?: 'hydra';
  agentId: string;
  args: string[];
  baseBranch?: string;
  cols?: number;
  command?: string;
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
  taskId: string;
}

interface NormalizedAgentSpawnRequest {
  channelId: string;
  hasExistingSession: boolean;
  replaceExistingSession: boolean;
  requestedCols: number;
  requestedRows: number;
}

function assertAgentSpawnRequestFields(
  request: AgentSpawnRequestFields,
): NormalizedAgentSpawnRequest {
  assertString(request.taskId, 'taskId');
  assertString(request.agentId, 'agentId');
  assertStringArray(request.args, 'args');
  if (request.adapter !== undefined && request.adapter !== 'hydra') {
    throw new BadRequestError('adapter must be hydra when provided');
  }
  if (request.cwd !== undefined) {
    assertString(request.cwd, 'cwd');
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
    hasExistingSession: hasAgentSession(request.agentId),
    replaceExistingSession: request.replaceExistingSession === true,
    requestedCols: normalizeTerminalDimension(request.cols, 80, 'cols'),
    requestedRows: normalizeTerminalDimension(request.rows, 24, 'rows'),
  };
}

async function runAgentSpawnRequest(
  context: HandlerContext,
  request: AgentSpawnRequestFields,
  normalized: NormalizedAgentSpawnRequest,
): Promise<boolean> {
  const { channelId, replaceExistingSession, requestedCols, requestedRows } = normalized;

  function spawnWorkflow(): boolean {
    const hasSessionAtSpawn = hasAgentSession(request.agentId);
    const shouldAttachExistingSession = hasSessionAtSpawn && !replaceExistingSession;
    const runnerProfile = shouldAttachExistingSession
      ? undefined
      : normalizeAgentRunnerProfileConfig(request.runnerProfile);
    // Attach-to-existing never resizes: the backend session geometry stays
    // authoritative regardless of the optimistic geometry on the request.
    const cols = shouldAttachExistingSession ? getAgentCols(request.agentId) : requestedCols;
    const rows = shouldAttachExistingSession ? getAgentRows(request.agentId) : requestedRows;

    return spawnTaskAgentWorkflow(context, {
      taskId: request.taskId,
      ...(request.baseBranch !== undefined ? { baseBranch: request.baseBranch } : {}),
      agentId: request.agentId,
      command: typeof request.command === 'string' ? request.command : '',
      args: request.args,
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
      ...(runnerProfile !== undefined ? { runnerProfile } : {}),
    });
  }

  if (normalized.hasExistingSession && !replaceExistingSession) {
    return spawnWorkflow();
  }

  return runNewAgentSessionSpawn(spawnWorkflow);
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

export function createAgentIpcHandlers(context: HandlerContext): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.SpawnAgent]: defineIpcHandler<IPC.SpawnAgent>(IPC.SpawnAgent, async (args) => {
      const request = args;
      const normalized = assertAgentSpawnRequestFields(request);
      const attachedExistingSession = await runAgentSpawnRequest(context, request, normalized);

      return {
        attachedExistingSession,
      };
    }),

    [IPC.AttachTerminalSession]: defineIpcHandler<IPC.AttachTerminalSession>(
      IPC.AttachTerminalSession,
      async (args) => {
        const request = args;
        const normalized = assertAgentSpawnRequestFields(request);
        const initialRecovery = assertInitialAttachRecoveryRequest(request.initialRecovery);
        assertOptionalString(request.clientId, 'clientId');
        const clientId = typeof request.clientId === 'string' ? request.clientId : null;

        // Bind the output channel for the requesting client before the spawn
        // workflow so the attach path's pending-batch flush goes to the OLD
        // channels and every Data frame on the new channel strictly follows
        // the captured recovery cursor.
        const channelBound = context.bindChannelForClient?.(clientId, normalized.channelId) ?? true;
        const attachedExistingSession = await runAgentSpawnRequest(context, request, normalized);
        if (!attachedExistingSession) {
          return {
            attachedExistingSession,
            channelBound,
            recovery: null,
          };
        }

        const agentId = request.agentId;
        // Always hold a request-scoped pause for live sessions (leases
        // stack); see fetchTerminalRecoveryBatch for the concurrent-client
        // rationale.
        const shouldPause = hasAgentSession(agentId);
        let batchPauseId: string | undefined;
        if (shouldPause) {
          pauseAgent(agentId, 'restore');
          batchPauseId = holdTerminalRecoveryBatchPause(agentId);
        }

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
            // A fresh attach has no rendered tail to offer in a phase-two
            // request, so a cursor miss resolves to the capped snapshot here.
            recovery = getAgentTerminalRecovery(
              agentId,
              null,
              null,
              initialRecovery.snapshotByteLimit,
            );
          } else if (
            recovery.kind === 'delta' &&
            initialRecovery.outputCursor === 0 &&
            initialRecovery.snapshotByteLimit !== null &&
            recovery.data.length > initialRecovery.snapshotByteLimit
          ) {
            // Cursor-hit deltas are uncapped by design (live continuity must
            // not be truncated), but a fresh-mount cursor-0 claim has no
            // rendered history to preserve: a delta from byte 0 is a
            // full-state transfer in disguise, so it must honor the attach
            // snapshot byte budget instead of shipping the whole retained
            // ring inline.
            recovery = getAgentTerminalRecovery(
              agentId,
              null,
              null,
              initialRecovery.snapshotByteLimit,
            );
          }
          const entry = serializeTerminalRecoveryEntry(agentId, 'attach-initial', recovery);
          return {
            attachedExistingSession,
            channelBound,
            recovery: batchPauseId === undefined ? entry : { ...entry, batchPauseId },
          };
        } catch (error) {
          if (batchPauseId !== undefined) {
            releaseHeldTerminalRecoveryBatchPause(batchPauseId);
          }
          throw error;
        }
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
          assertStringArray(entry.args, `requests[${index}].args`);
          if (entry.adapter !== undefined && entry.adapter !== 'hydra') {
            throw new BadRequestError(`requests[${index}].adapter must be hydra when provided`);
          }
          if (entry.cwd !== undefined) {
            assertString(entry.cwd, `requests[${index}].cwd`);
          }
          if (entry.resumeOnStart !== undefined && typeof entry.resumeOnStart !== 'boolean') {
            throw new BadRequestError(
              `requests[${index}].resumeOnStart must be a boolean when provided`,
            );
          }
          const baseBranch = entry.baseBranch;
          const projectMode = entry.projectMode;
          validateOptionalBranchName(baseBranch, `requests[${index}].baseBranch`);
          assertOptionalProjectMode(projectMode);

          const taskId = entry.taskId;
          const agentId = entry.agentId;
          const spawnArgs = entry.args;
          const adapter: 'hydra' | undefined = entry.adapter === 'hydra' ? 'hydra' : undefined;
          const command = typeof entry.command === 'string' ? entry.command : '';
          const cwd = typeof entry.cwd === 'string' ? entry.cwd : '';
          const requestedCols = normalizeTerminalDimension(
            entry.cols,
            80,
            `requests[${index}].cols`,
          );
          const requestedRows = normalizeTerminalDimension(
            entry.rows,
            24,
            `requests[${index}].rows`,
          );
          return {
            adapter,
            agentId,
            baseBranch,
            command,
            cwd,
            env: entry.env,
            isShell: entry.isShell === true,
            projectMode,
            requestedCols,
            requestedRows,
            resumeOnStart: entry.resumeOnStart === true,
            runnerProfile: entry.runnerProfile,
            spawnArgs,
            taskId,
          };
        });

        recordAgentSessionEnsureBatch(normalizedRequests.length);

        const results = await Promise.all(
          normalizedRequests.map(async (entry) => {
            function buildExistingResult() {
              return {
                agentId: entry.agentId,
                cols: getAgentCols(entry.agentId),
                created: false,
                existed: true,
                rows: getAgentRows(entry.agentId),
                taskId: getAgentMeta(entry.agentId)?.taskId ?? entry.taskId,
              };
            }

            if (hasAgentSession(entry.agentId)) {
              recordAgentSessionEnsureResult('existing');
              return buildExistingResult();
            }

            try {
              const created = await runNewAgentSessionSpawn(() => {
                if (hasAgentSession(entry.agentId)) {
                  return false;
                }

                const runnerProfile = normalizeAgentRunnerProfileConfig(entry.runnerProfile);
                spawnTaskAgentWorkflow(context, {
                  taskId: entry.taskId,
                  ...(entry.baseBranch !== undefined ? { baseBranch: entry.baseBranch } : {}),
                  agentId: entry.agentId,
                  command: entry.command,
                  args: entry.spawnArgs,
                  cwd: entry.cwd,
                  env: entry.env,
                  cols: entry.requestedCols,
                  rows: entry.requestedRows,
                  isShell: entry.isShell,
                  resumeOnStart: entry.resumeOnStart,
                  ...(entry.projectMode !== undefined ? { projectMode: entry.projectMode } : {}),
                  ...(entry.adapter !== undefined ? { adapter: entry.adapter } : {}),
                  ...(runnerProfile !== undefined ? { runnerProfile } : {}),
                });
                return true;
              });

              if (!created) {
                recordAgentSessionEnsureResult('existing');
                return buildExistingResult();
              }

              recordAgentSessionEnsureResult('created');
              return {
                agentId: entry.agentId,
                cols: entry.requestedCols,
                created: true,
                existed: false,
                rows: entry.requestedRows,
                taskId: entry.taskId,
              };
            } catch (error) {
              return {
                agentId: entry.agentId,
                cols: entry.requestedCols,
                created: false,
                error: error instanceof Error ? error.message : String(error),
                existed: false,
                rows: entry.requestedRows,
                taskId: entry.taskId,
              };
            }
          }),
        );

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

    [IPC.KillAgent]: defineIpcHandler<IPC.KillAgent>(IPC.KillAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      killAgent(request.agentId);
      return undefined;
    }),

    [IPC.CountRunningAgents]: () => countRunningAgents(),
    [IPC.KillAllAgents]: () => killAllAgents(),
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
