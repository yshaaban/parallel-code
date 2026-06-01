import { randomUUID } from 'node:crypto';

import {
  COORDINATOR_LIMITS,
  isCoordinatorPendingPromptStatus,
  type CoordinatorBootstrapSnapshot,
  type CoordinatorDiagnosticsSnapshot,
  type CoordinatorEventEnvelope,
  type CoordinatorEventType,
  type CoordinatorLandingStateSnapshot,
  type CoordinatorPromptKind,
  type CoordinatorPromptRequestSnapshot,
  type CoordinatorPromptStatus,
  type CoordinatorRunLimits,
  type CoordinatorRunSnapshot,
  type CoordinatorRunStatus,
  type CoordinatorSubtaskSnapshot,
  type CoordinatorSubtaskStatus,
} from '../../src/domain/coordinator.js';
import type { ProjectMode } from '../../src/store/types.js';

export interface CoordinatorRuntimeState {
  runs: CoordinatorRunSnapshot[];
  stateVersion: number;
  toolCallResults: Array<{
    createdAt: number;
    key: string;
    result: unknown;
  }>;
}

export type CoordinatorEventListener = (event: CoordinatorEventEnvelope) => void;

interface RunRecord {
  run: CoordinatorRunSnapshot;
  landingByTaskId: Map<string, CoordinatorLandingStateSnapshot>;
  promptsByRequestId: Map<string, CoordinatorPromptRequestSnapshot>;
  subtasksByTaskId: Map<string, CoordinatorSubtaskSnapshot>;
}

interface CreateCoordinatorRunOptions {
  coordinatorTaskId: string;
  projectId: string;
  projectMode: ProjectMode;
  projectRoot: string;
  now?: number;
}

interface AddCoordinatorSubtaskOptions {
  agentId: string;
  assignment: string;
  branchName?: string;
  dedupeKey?: string;
  parentCoordinatorTaskId: string;
  runId: string;
  status?: CoordinatorSubtaskStatus;
  taskId: string;
  toolTokenId: string;
  worktreePath: string;
  now?: number;
}

interface EnqueueCoordinatorPromptOptions {
  dedupeKey?: string;
  kind: CoordinatorPromptKind;
  requestId?: string;
  runId: string;
  sourceTaskId: string;
  targetAgentId: string;
  targetTaskId: string;
  text: string;
  now?: number;
}

interface UpsertCoordinatorLandingOptions {
  landing: CoordinatorLandingStateSnapshot;
  runId: string;
}

interface UpdateCoordinatorPromptPatch {
  attempts?: number;
  deliveredAt?: number;
  deliveryJournal?: CoordinatorPromptRequestSnapshot['deliveryJournal'];
  earliestDeliveryAt?: number;
  failedAt?: number;
  status?: CoordinatorPromptRequestSnapshot['status'];
  waitingReason?: string | undefined;
}

const DEFAULT_RUN_LIMITS: CoordinatorRunLimits = {
  maxActiveSubtasks: COORDINATOR_LIMITS.maxActiveSubtasksPerRun,
  maxPendingPromptsPerTarget: COORDINATOR_LIMITS.maxPendingPromptsPerTarget,
  maxQueuedSubtasks: COORDINATOR_LIMITS.maxQueuedSubtasksPerRun,
};

let recordsByRunId = new Map<string, RunRecord>();
let stateVersion = 0;
const eventListeners = new Set<CoordinatorEventListener>();
const toolCallResults = new Map<
  string,
  {
    createdAt: number;
    result: unknown;
  }
>();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nextVersion(): number {
  stateVersion += 1;
  return stateVersion;
}

function getNow(now: number | undefined): number {
  return now ?? Date.now();
}

function createRunRecord(run: CoordinatorRunSnapshot): RunRecord {
  return {
    run,
    landingByTaskId: new Map(run.landing.map((landing) => [landing.taskId, landing])),
    promptsByRequestId: new Map(run.promptQueue.map((prompt) => [prompt.requestId, prompt])),
    subtasksByTaskId: new Map(run.subtasks.map((subtask) => [subtask.taskId, subtask])),
  };
}

function materializeRun(record: RunRecord): CoordinatorRunSnapshot {
  return {
    ...record.run,
    landing: [...record.landingByTaskId.values()],
    promptQueue: [...record.promptsByRequestId.values()],
    subtasks: [...record.subtasksByTaskId.values()],
  };
}

function replaceRun(record: RunRecord, run: CoordinatorRunSnapshot): void {
  record.run = {
    ...run,
    landing: [...record.landingByTaskId.values()],
    promptQueue: [...record.promptsByRequestId.values()],
    subtasks: [...record.subtasksByTaskId.values()],
  };
}

function normalizeRestoredRun(run: CoordinatorRunSnapshot): CoordinatorRunSnapshot {
  const staleStatuses: CoordinatorRunStatus[] = ['draining', 'running', 'starting'];
  const stalePromptStatuses: CoordinatorPromptStatus[] = [
    'delivering',
    'queued',
    'waiting-for-agent-session',
    'waiting-for-command-lease',
    'waiting-for-terminal-input-clear',
    'waiting-for-terminal-prompt',
    'waiting-for-user-idle',
  ];
  return {
    ...run,
    promptQueue: run.promptQueue.map((prompt) =>
      stalePromptStatuses.includes(prompt.status)
        ? {
            ...prompt,
            status: 'write-unknown-after-restore',
            waitingReason: 'server-restored-without-live-pty-session',
          }
        : prompt,
    ),
    status: staleStatuses.includes(run.status) ? 'stale-after-restore' : run.status,
    subtasks: run.subtasks.map((subtask) =>
      subtask.status === 'running' ||
      subtask.status === 'spawning' ||
      subtask.status === 'waiting-for-agent-ready'
        ? {
            ...subtask,
            status: 'exited',
            result: 'Server restored coordinator state without the live PTY session.',
          }
        : subtask,
    ),
  };
}

function requireRunRecord(runId: string): RunRecord {
  const record = recordsByRunId.get(runId);
  if (!record) {
    throw new Error(`Coordinator run not found: ${runId}`);
  }

  return record;
}

function emitCoordinatorEvent(
  runId: string,
  eventType: CoordinatorEventType,
  entityKey: string,
  entityVersion: number,
  payload: unknown,
  options: {
    snapshotRequired?: boolean;
    tombstone?: boolean;
  } = {},
): CoordinatorEventEnvelope {
  const event: CoordinatorEventEnvelope = {
    categorySeq: stateVersion,
    createdAt: Date.now(),
    entityKey,
    entityVersion,
    eventType,
    payload,
    runId,
    ...(options.snapshotRequired !== undefined
      ? { snapshotRequired: options.snapshotRequired }
      : {}),
    ...(options.tombstone !== undefined ? { tombstone: options.tombstone } : {}),
  };

  for (const listener of eventListeners) {
    listener(clone(event));
  }

  return event;
}

function updateRunTimestamp(record: RunRecord, now: number): void {
  const nextRun = materializeRun(record);
  nextRun.updatedAt = now;
  nextRun.eventVersion = stateVersion;
  replaceRun(record, nextRun);
}

export function subscribeCoordinatorEvents(listener: CoordinatorEventListener): () => void {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

export function createCoordinatorRun(options: CreateCoordinatorRunOptions): CoordinatorRunSnapshot {
  const now = getNow(options.now);
  const version = nextVersion();
  const run: CoordinatorRunSnapshot = {
    coordinatorTaskId: options.coordinatorTaskId,
    createdAt: now,
    eventVersion: version,
    id: randomUUID(),
    landing: [],
    limits: { ...DEFAULT_RUN_LIMITS },
    projectId: options.projectId,
    projectMode: options.projectMode,
    projectRoot: options.projectRoot,
    promptQueue: [],
    status: 'running',
    subtasks: [],
    updatedAt: now,
  };
  const record = createRunRecord(run);
  recordsByRunId.set(run.id, record);
  emitCoordinatorEvent(run.id, 'run-upserted', `run:${run.id}`, version, run);
  return clone(run);
}

export function updateCoordinatorRunStatus(
  runId: string,
  status: CoordinatorRunStatus,
  now = Date.now(),
): CoordinatorRunSnapshot {
  const record = requireRunRecord(runId);
  const version = nextVersion();
  const run = {
    ...materializeRun(record),
    eventVersion: version,
    status,
    updatedAt: now,
  };
  replaceRun(record, run);
  emitCoordinatorEvent(run.id, 'run-upserted', `run:${run.id}`, version, run);
  return clone(run);
}

export function addCoordinatorSubtask(
  options: AddCoordinatorSubtaskOptions,
): CoordinatorSubtaskSnapshot {
  const record = requireRunRecord(options.runId);
  const now = getNow(options.now);
  const version = nextVersion();
  const existing = record.subtasksByTaskId.get(options.taskId);
  const subtask: CoordinatorSubtaskSnapshot = {
    ...(existing ?? {}),
    agentId: options.agentId,
    assignment: options.assignment,
    ...(options.branchName !== undefined ? { branchName: options.branchName } : {}),
    createdAt: existing?.createdAt ?? now,
    ...(options.dedupeKey !== undefined ? { dedupeKey: options.dedupeKey } : {}),
    parentCoordinatorTaskId: options.parentCoordinatorTaskId,
    status: options.status ?? existing?.status ?? 'running',
    taskId: options.taskId,
    toolTokenId: options.toolTokenId,
    updatedAt: now,
    worktreePath: options.worktreePath,
  };
  record.subtasksByTaskId.set(subtask.taskId, subtask);
  updateRunTimestamp(record, now);
  emitCoordinatorEvent(
    options.runId,
    'subtask-upserted',
    `subtask:${subtask.taskId}`,
    version,
    subtask,
  );
  emitCoordinatorEvent(
    options.runId,
    'run-upserted',
    `run:${record.run.id}`,
    version,
    materializeRun(record),
  );
  return clone(subtask);
}

export function updateCoordinatorSubtaskStatus(
  runId: string,
  taskId: string,
  status: CoordinatorSubtaskStatus,
  options: {
    result?: string;
    now?: number;
  } = {},
): CoordinatorSubtaskSnapshot {
  const record = requireRunRecord(runId);
  const existing = record.subtasksByTaskId.get(taskId);
  if (!existing) {
    throw new Error(`Coordinator subtask not found: ${taskId}`);
  }

  const now = getNow(options.now);
  const version = nextVersion();
  const subtask: CoordinatorSubtaskSnapshot = {
    ...existing,
    ...(options.result !== undefined ? { result: options.result } : {}),
    status,
    updatedAt: now,
  };
  record.subtasksByTaskId.set(taskId, subtask);
  updateRunTimestamp(record, now);
  emitCoordinatorEvent(runId, 'subtask-upserted', `subtask:${taskId}`, version, subtask);
  return clone(subtask);
}

export function enqueueCoordinatorPrompt(
  options: EnqueueCoordinatorPromptOptions,
): CoordinatorPromptRequestSnapshot {
  const record = requireRunRecord(options.runId);
  const now = getNow(options.now);
  const requestId = options.requestId ?? randomUUID();
  const prompt: CoordinatorPromptRequestSnapshot = {
    attempts: 0,
    createdAt: now,
    dedupeKey: options.dedupeKey ?? requestId,
    deliveryJournal: [],
    earliestDeliveryAt: now,
    kind: options.kind,
    requestId,
    runId: options.runId,
    sourceTaskId: options.sourceTaskId,
    status: 'queued',
    targetAgentId: options.targetAgentId,
    targetTaskId: options.targetTaskId,
    text: options.text,
  };
  const version = nextVersion();
  record.promptsByRequestId.set(prompt.requestId, prompt);
  const subtask = record.subtasksByTaskId.get(prompt.targetTaskId);
  if (subtask) {
    record.subtasksByTaskId.set(prompt.targetTaskId, {
      ...subtask,
      lastPromptRequestId: prompt.requestId,
      updatedAt: now,
    });
  }
  updateRunTimestamp(record, now);
  emitCoordinatorEvent(
    options.runId,
    'prompt-upserted',
    `prompt:${prompt.requestId}`,
    version,
    prompt,
  );
  return clone(prompt);
}

export function updateCoordinatorPrompt(
  runId: string,
  requestId: string,
  patch: UpdateCoordinatorPromptPatch,
): CoordinatorPromptRequestSnapshot {
  const record = requireRunRecord(runId);
  const existing = record.promptsByRequestId.get(requestId);
  if (!existing) {
    throw new Error(`Coordinator prompt not found: ${requestId}`);
  }

  const version = nextVersion();
  const nextPrompt = {
    ...existing,
    ...patch,
  };
  if ('waitingReason' in patch && patch.waitingReason === undefined) {
    delete nextPrompt.waitingReason;
  }

  const prompt = nextPrompt as CoordinatorPromptRequestSnapshot;
  record.promptsByRequestId.set(requestId, prompt);
  updateRunTimestamp(record, Date.now());
  emitCoordinatorEvent(runId, 'prompt-upserted', `prompt:${requestId}`, version, prompt);
  return clone(prompt);
}

export function cancelCoordinatorPromptsForTask(
  runId: string,
  taskId: string,
  reason: string,
): CoordinatorPromptRequestSnapshot[] {
  const record = requireRunRecord(runId);
  const cancelled: CoordinatorPromptRequestSnapshot[] = [];
  for (const prompt of record.promptsByRequestId.values()) {
    if (prompt.targetTaskId !== taskId || !isCoordinatorPendingPromptStatus(prompt.status)) {
      continue;
    }

    cancelled.push(
      updateCoordinatorPrompt(runId, prompt.requestId, {
        status: 'cancelled',
        waitingReason: reason,
      }),
    );
  }

  return cancelled;
}

export function upsertCoordinatorLanding(
  options: UpsertCoordinatorLandingOptions,
): CoordinatorLandingStateSnapshot {
  const record = requireRunRecord(options.runId);
  const version = nextVersion();
  record.landingByTaskId.set(options.landing.taskId, options.landing);
  updateRunTimestamp(record, Date.now());
  emitCoordinatorEvent(
    options.runId,
    'landing-upserted',
    `landing:${options.landing.taskId}`,
    version,
    options.landing,
  );
  return clone(options.landing);
}

export function getCoordinatorRun(runId: string): CoordinatorRunSnapshot | null {
  const record = recordsByRunId.get(runId);
  return record ? clone(materializeRun(record)) : null;
}

export function getCoordinatorRunByCoordinatorTaskId(
  taskId: string,
): CoordinatorRunSnapshot | null {
  for (const record of recordsByRunId.values()) {
    if (record.run.coordinatorTaskId === taskId) {
      return clone(materializeRun(record));
    }
  }

  return null;
}

export function listCoordinatorRuns(): CoordinatorRunSnapshot[] {
  return [...recordsByRunId.values()].map((record) => clone(materializeRun(record)));
}

export function removeCoordinatorRun(runId: string): void {
  if (!recordsByRunId.has(runId)) {
    return;
  }

  const version = nextVersion();
  recordsByRunId.delete(runId);
  emitCoordinatorEvent(runId, 'run-removed', `run:${runId}`, version, null, {
    tombstone: true,
  });
}

export function getCoordinatorBootstrapSnapshot(): CoordinatorBootstrapSnapshot {
  return {
    generatedAt: Date.now(),
    runs: listCoordinatorRuns(),
    stateVersion,
  };
}

export function getCoordinatorStateVersion(): number {
  return stateVersion;
}

export function rememberCoordinatorToolResult(key: string, result: unknown): void {
  toolCallResults.set(key, {
    createdAt: Date.now(),
    result: clone(result),
  });
  while (toolCallResults.size > COORDINATOR_LIMITS.maxRememberedToolCallResults) {
    const oldest = [...toolCallResults.entries()].sort(
      (left, right) => left[1].createdAt - right[1].createdAt,
    )[0]?.[0];
    if (oldest === undefined) {
      return;
    }

    toolCallResults.delete(oldest);
  }
}

export function getCoordinatorToolResult(key: string): unknown | undefined {
  const result = toolCallResults.get(key);
  return result === undefined ? undefined : clone(result.result);
}

export function getCoordinatorRuntimeState(): CoordinatorRuntimeState {
  return {
    runs: listCoordinatorRuns(),
    stateVersion,
    toolCallResults: [...toolCallResults.entries()].map(([key, record]) => ({
      createdAt: record.createdAt,
      key,
      result: clone(record.result),
    })),
  };
}

export function restoreCoordinatorRuntimeState(state: CoordinatorRuntimeState): void {
  recordsByRunId = new Map(
    state.runs.map((run) => {
      const restoredRun = normalizeRestoredRun(clone(run));
      return [restoredRun.id, createRunRecord(restoredRun)];
    }),
  );
  stateVersion = state.stateVersion;
  toolCallResults.clear();
  for (const entry of state.toolCallResults) {
    toolCallResults.set(entry.key, {
      createdAt: entry.createdAt,
      result: clone(entry.result),
    });
  }
}

export function getCoordinatorDiagnostics(): CoordinatorDiagnosticsSnapshot {
  let activeSubtasks = 0;
  let hiddenOutputDroppedBytes = 0;
  let hiddenOutputRetainedBytes = 0;
  let promptQueueDepth = 0;
  let queuedSpawns = 0;

  for (const run of listCoordinatorRuns()) {
    promptQueueDepth += run.promptQueue.filter((prompt) =>
      isCoordinatorPendingPromptStatus(prompt.status),
    ).length;
    for (const subtask of run.subtasks) {
      if (subtask.status === 'queued' || subtask.status === 'spawning') {
        queuedSpawns += 1;
      }
      if (subtask.status === 'running' || subtask.status === 'waiting-for-agent-ready') {
        activeSubtasks += 1;
      }
      hiddenOutputDroppedBytes += subtask.hiddenOutputState?.droppedBytes ?? 0;
      hiddenOutputRetainedBytes += subtask.hiddenOutputState?.retainedBytes ?? 0;
    }
  }

  return {
    activeRuns: recordsByRunId.size,
    activeSubtasks,
    coordinatorEvents: stateVersion,
    droppedToSnapshotEvents: 0,
    hiddenOutputDroppedBytes,
    hiddenOutputRetainedBytes,
    promptQueueDepth,
    queuedSpawns,
    stateVersion,
  };
}

export function resetCoordinatorRuntimeForTests(): void {
  recordsByRunId.clear();
  stateVersion = 0;
  eventListeners.clear();
  toolCallResults.clear();
}
