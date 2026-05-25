import { performance } from 'node:perf_hooks';

import { IPC } from './channels.js';
import { normalizeAgentRunnerProfileConfig } from './agent-runner-handlers.js';
import { listAgentSupervisionSnapshots } from './agent-supervision.js';
import { listAgents } from './agents.js';
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
  getAgentPauseState,
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

function resumeRestorePausedAgents(pausedIds: string[]): void {
  for (const agentId of pausedIds.reverse()) {
    try {
      resumeAgent(agentId, 'restore');
    } catch {
      // best-effort cleanup
    }
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
  const pausedIds: string[] = [];
  const startedAt = performance.now();

  try {
    for (const agentId of uniqueAgentIds) {
      if (!hasAgentSession(agentId) || getAgentPauseState(agentId) !== null) {
        continue;
      }

      pauseAgent(agentId, 'restore');
      pausedIds.push(agentId);
    }

    const results: TerminalRecoveryBatchEntry[] = requests.map((request) => {
      const recovery = getAgentTerminalRecovery(
        request.agentId,
        decodeTerminalRenderedTail(request.renderedTail),
        request.outputCursor ?? null,
        request.snapshotByteLimit ?? null,
      );
      return serializeTerminalRecoveryEntry(request.agentId, request.requestId, recovery);
    });
    recordTerminalRecoveryBatch(results, performance.now() - startedAt);
    return results;
  } finally {
    resumeRestorePausedAgents(pausedIds);
  }
}

async function fetchTerminalStartupRecoveryBatch(
  requests: TerminalStartupRecoveryRequestEntry[],
): Promise<TerminalRecoveryBatchEntry[]> {
  const uniqueAgentIds = getUniqueAgentIds(requests.map((request) => request.agentId));
  const pausedIds: string[] = [];
  const startedAt = performance.now();

  try {
    for (const agentId of uniqueAgentIds) {
      if (!hasAgentSession(agentId) || getAgentPauseState(agentId) !== null) {
        continue;
      }

      pauseAgent(agentId, 'restore');
      pausedIds.push(agentId);
    }

    const results: TerminalRecoveryBatchEntry[] = await Promise.all(
      requests.map(async (request) => {
        const recovery = await getAgentTerminalStartupRecovery(
          request.agentId,
          null,
          null,
          request.role,
          request.visibleTerminalCount,
        );
        return serializeTerminalRecoveryEntry(request.agentId, request.requestId, recovery);
      }),
    );
    recordTerminalRecoveryBatch(results, performance.now() - startedAt);
    return results;
  } finally {
    resumeRestorePausedAgents(pausedIds);
  }
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

export function createAgentIpcHandlers(context: HandlerContext): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.SpawnAgent]: defineIpcHandler<IPC.SpawnAgent>(IPC.SpawnAgent, async (args) => {
      const request = args;
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
      validateOptionalBranchName(request.baseBranch, 'baseBranch');
      assertOptionalProjectMode(request.projectMode);
      assertOptionalString(request.controllerId, 'controllerId');
      const channelId = getRequiredChannelId(request.onOutput);
      const requestedCols = typeof request.cols === 'number' ? request.cols : 80;
      const requestedRows = typeof request.rows === 'number' ? request.rows : 24;
      const hasExistingSession = hasAgentSession(request.agentId);
      const runnerProfile = hasExistingSession
        ? undefined
        : normalizeAgentRunnerProfileConfig(request.runnerProfile);
      const cols = hasExistingSession ? getAgentCols(request.agentId) : requestedCols;
      const rows = hasExistingSession ? getAgentRows(request.agentId) : requestedRows;

      const attachedExistingSession = spawnTaskAgentWorkflow(context, {
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
        resumeOnStart: request.resumeOnStart === true,
        onOutput: { __CHANNEL_ID__: channelId },
        ...(request.projectMode !== undefined ? { projectMode: request.projectMode } : {}),
        ...(request.adapter !== undefined ? { adapter: request.adapter } : {}),
        ...(!hasExistingSession && runnerProfile !== undefined ? { runnerProfile } : {}),
      });

      return {
        attachedExistingSession,
      };
    }),

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
      assertInt(request.cols, 'cols');
      assertInt(request.rows, 'rows');
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
      pauseAgent(request.agentId, request.reason, request.channelId);
      return undefined;
    }),

    [IPC.ResumeAgent]: defineIpcHandler<IPC.ResumeAgent>(IPC.ResumeAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      assertOptionalPauseReason(request.reason);
      assertOptionalString(request.channelId, 'channelId');
      resumeAgent(request.agentId, request.reason, request.channelId);
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
    [IPC.GetAgentSupervision]: () => listAgentSupervisionSnapshots(),
    [IPC.ListRunningAgentIds]: () => getActiveAgentIds(),
  };
}
