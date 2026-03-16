import { performance } from 'node:perf_hooks';

import { IPC } from './channels.js';
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
  getAgentScrollback,
  killAgent,
  killAllAgents,
  pauseAgent,
  resizeAgent,
  resumeAgent,
  writeToAgent,
} from './pty.js';
import { spawnTaskAgentWorkflow } from './task-workflows.js';
import { BadRequestError } from './errors.js';
import { recordScrollbackReplay } from './runtime-diagnostics.js';
import { defineIpcHandler } from './typed-handler.js';
import { assertInt, assertOptionalString, assertString, assertStringArray } from './validate.js';
import { getRequiredChannelId } from './channel-id.js';

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

async function fetchScrollbackBatch(
  agentIds: string[],
): Promise<Map<string, ScrollbackBatchEntrySnapshot>> {
  const pausedIds: string[] = [];
  const startedAt = performance.now();

  try {
    for (const agentId of agentIds) {
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
    for (const agentId of pausedIds.reverse()) {
      try {
        resumeAgent(agentId, 'restore');
      } catch {
        // best-effort cleanup
      }
    }
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
    return existing.promise;
  }

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
      const channelId = getRequiredChannelId(request.onOutput);

      await spawnTaskAgentWorkflow(context, {
        taskId: request.taskId,
        agentId: request.agentId,
        command: typeof request.command === 'string' ? request.command : '',
        args: request.args,
        cwd: typeof request.cwd === 'string' ? request.cwd : '',
        env: request.env,
        cols: typeof request.cols === 'number' ? request.cols : 80,
        rows: typeof request.rows === 'number' ? request.rows : 24,
        isShell: request.isShell === true,
        onOutput: { __CHANNEL_ID__: channelId },
        ...(request.adapter !== undefined ? { adapter: request.adapter } : {}),
      });

      return undefined;
    }),

    [IPC.WriteToAgent]: defineIpcHandler<IPC.WriteToAgent>(IPC.WriteToAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      assertString(request.data, 'data');
      writeToAgent(request.agentId, request.data);
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

    [IPC.ResizeAgent]: defineIpcHandler<IPC.ResizeAgent>(IPC.ResizeAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      assertInt(request.cols, 'cols');
      assertInt(request.rows, 'rows');
      resizeAgent(request.agentId, request.cols, request.rows);
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
