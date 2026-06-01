import { createHash, randomUUID } from 'node:crypto';

import { IPC } from '../ipc/channels.js';
import type { HandlerContext } from '../ipc/handler-context.js';
import { BadRequestError } from '../ipc/errors.js';
import { getAllFileDiffs, getProjectDiff, getWorktreeStatus, mergeTask } from '../ipc/git.js';
import {
  getAgentSupervisionSnapshot,
  subscribeAgentSupervision,
} from '../ipc/agent-supervision.js';
import { normalizeAgentRunnerProfileConfig } from '../ipc/agent-runner-handlers.js';
import {
  getAgentMeta,
  getAgentScrollbackBuffer,
  hasAgentSession,
  writeToAgent,
} from '../ipc/pty.js';
import {
  acquireTaskCommandLease,
  getTaskCommandControllerSnapshot,
  isTaskCommandLeaseHeld,
  isTaskCommandLeaseGenerationHeld,
  releaseTaskCommandLease,
} from '../ipc/task-command-leases.js';
import {
  cleanupTaskRuntimeWorkflow,
  createTaskWorkflow,
  deleteTaskWorkflow,
  spawnTaskAgentWorkflow,
} from '../ipc/task-workflows.js';
import {
  COORDINATOR_LIMITS,
  isCoordinatorPendingPromptStatus,
  isCoordinatorTerminalSubtaskStatus,
  type CoordinatorCloseTaskPayload,
  type CoordinatorGetTaskDiffPayload,
  type CoordinatorGetTaskOutputPayload,
  type CoordinatorLandSelfPayload,
  type CoordinatorLandingStateSnapshot,
  type CoordinatorPromptKind,
  type CoordinatorPromptRequestSnapshot,
  type CoordinatorRunSnapshot,
  type CoordinatorSendPromptPayload,
  type CoordinatorSignalDonePayload,
  type CoordinatorSpawnSubtaskPayload,
  type CoordinatorSubtaskSnapshot,
  type CoordinatorTargetTaskPayload,
  type CoordinatorToolCallEnvelope,
  type CoordinatorToolCallResult,
  type CoordinatorUiToolCallRequest,
  type CoordinatorWaitForIdlePayload,
} from '../../src/domain/coordinator.js';
import { buildCoordinatorSubtaskAssignment } from '../../src/domain/coordinator-instructions.js';
import type { AgentSupervisionSnapshot } from '../../src/domain/server-state.js';
import { materializePromptDispatch } from '../../src/domain/task-prompt-materialization.js';
import { isRecord, isStringArray } from '../../src/lib/type-guards.js';
import type { TaskNameRegistry } from '../../server/task-names.js';
import type { DeleteTaskCleanupWarning } from '../../src/domain/task-cleanup.js';
import type { CreateTaskResult } from '../../src/ipc/types.js';
import type { ProjectMode, TaskGitIsolationMode } from '../../src/store/types.js';
import {
  cleanupCoordinatorStateForTask,
  createCoordinatorCredential,
  getCoordinatorBlockingActivityHints,
  revokeCoordinatorTaskCredential,
  resolveCoordinatorToken,
} from './service.js';
import {
  addCoordinatorSubtask,
  cancelCoordinatorPromptsForTask,
  enqueueCoordinatorPrompt,
  getCoordinatorRun,
  getCoordinatorRunByCoordinatorTaskId,
  getCoordinatorToolResult,
  listCoordinatorRuns,
  rememberCoordinatorToolResult,
  subscribeCoordinatorEvents,
  updateCoordinatorPrompt,
  updateCoordinatorSubtaskStatus,
  upsertCoordinatorLanding,
} from './runtime.js';

const COORDINATOR_AUTOMATION_CLIENT_ID_PREFIX = 'coordinator:';
const COORDINATOR_AUTOMATION_OWNER_ID = 'coordinator-prompt-delivery';
const COORDINATOR_LANDING_OWNER_ID = 'coordinator-self-landing';
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const PROMPT_DELIVERY_RETRY_DELAY_MS = 1_000;
const WAIT_FOR_IDLE_MAX_TIMEOUT_MS = 60_000;
const WAIT_FOR_IDLE_POLL_MS = 100;
const TASK_OUTPUT_DEFAULT_MAX_BYTES = 64 * 1024;
const TASK_OUTPUT_MAX_BYTES = 256 * 1024;
const TASK_DIFF_DEFAULT_MAX_BYTES = 128 * 1024;
const TASK_DIFF_MAX_BYTES = 512 * 1024;

interface CoordinatorToolGatewayContext {
  context: HandlerContext;
  taskNames: Pick<TaskNameRegistry, 'deleteTask' | 'registerCreatedTask'>;
}

interface CoordinatorToolInvocation {
  callId: string;
  payload?: unknown;
  runId: string;
  taskId: string;
  toolName: CoordinatorToolCallEnvelope['toolName'];
}

let promptDeliveryCleanup: (() => void) | null = null;
let promptDeliveryContext: HandlerContext | null = null;
let promptDeliveryForce = false;
let promptDeliveryReferences = 0;
let promptDeliveryTimer: ReturnType<typeof setTimeout> | null = null;
const activePromptDeliveryKeys = new Set<string>();
const scheduledPromptDeliveryKeys = new Set<string>();
const promptDeliveryChainsByTargetKey = new Map<string, Promise<unknown>>();
const activeSpawnSubtasksByDedupeKey = new Map<
  string,
  {
    projectId: string;
    promise: Promise<CoordinatorSubtaskSnapshot>;
    runId: string;
  }
>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestError(`${label} must be a non-empty string`);
  }
}

function assertOptionalString(value: unknown, label: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw new BadRequestError(`${label} must be a string when provided`);
  }
}

function assertTextSize(value: string, label: string, maxChars: number): void {
  if (value.length > maxChars) {
    throw new BadRequestError(`${label} must be no longer than ${maxChars} characters`);
  }
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry): entry is string => typeof entry === 'string')
  );
}

function readSpawnPayload(payload: unknown): CoordinatorSpawnSubtaskPayload {
  if (!isRecord(payload) || !isRecord(payload.agent)) {
    throw new BadRequestError('spawn_subtask payload is required');
  }

  assertString(payload.name, 'name');
  assertString(payload.assignment, 'assignment');
  assertString(payload.agent.command, 'agent.command');
  assertOptionalString(payload.agent.name, 'agent.name');
  assertOptionalString(payload.baseBranch, 'baseBranch');
  assertOptionalString(payload.branchPrefix, 'branchPrefix');
  assertOptionalString(payload.dedupeKey, 'dedupeKey');
  if (payload.agent.args !== undefined && !isStringArray(payload.agent.args)) {
    throw new BadRequestError('agent.args must be a string array when provided');
  }
  if (
    payload.agent.skipPermissionsArgs !== undefined &&
    !isStringArray(payload.agent.skipPermissionsArgs)
  ) {
    throw new BadRequestError('agent.skipPermissionsArgs must be a string array when provided');
  }
  if (payload.agent.env !== undefined && !isRecordOfStrings(payload.agent.env)) {
    throw new BadRequestError('agent.env must be an object of string values when provided');
  }
  assertTextSize(payload.assignment, 'assignment', COORDINATOR_LIMITS.assignmentTextMaxChars);

  return {
    agent: {
      ...(payload.agent.args !== undefined ? { args: payload.agent.args } : {}),
      command: payload.agent.command,
      ...(payload.agent.env !== undefined ? { env: payload.agent.env } : {}),
      ...(payload.agent.name !== undefined ? { name: payload.agent.name } : {}),
      ...(payload.agent.skipPermissionsArgs !== undefined
        ? { skipPermissionsArgs: payload.agent.skipPermissionsArgs }
        : {}),
    },
    assignment: payload.assignment,
    ...(payload.baseBranch !== undefined ? { baseBranch: payload.baseBranch } : {}),
    ...(payload.branchPrefix !== undefined ? { branchPrefix: payload.branchPrefix } : {}),
    ...(payload.dedupeKey !== undefined ? { dedupeKey: payload.dedupeKey } : {}),
    name: payload.name,
  };
}

function readSendPromptPayload(payload: unknown): CoordinatorSendPromptPayload {
  if (!isRecord(payload)) {
    throw new BadRequestError('send_prompt payload is required');
  }

  assertString(payload.targetTaskId, 'targetTaskId');
  assertString(payload.text, 'text');
  assertOptionalString(payload.dedupeKey, 'dedupeKey');
  if (
    payload.kind !== undefined &&
    payload.kind !== 'follow-up' &&
    payload.kind !== 'review-finding' &&
    payload.kind !== 'system' &&
    payload.kind !== 'initial-assignment'
  ) {
    throw new BadRequestError('kind must be a coordinator prompt kind');
  }
  assertTextSize(payload.text, 'text', COORDINATOR_LIMITS.promptTextMaxChars);

  return {
    ...(payload.dedupeKey !== undefined ? { dedupeKey: payload.dedupeKey } : {}),
    ...(payload.kind !== undefined ? { kind: payload.kind as CoordinatorPromptKind } : {}),
    targetTaskId: payload.targetTaskId,
    text: payload.text,
  };
}

function readTargetTaskPayload(payload: unknown): CoordinatorTargetTaskPayload {
  if (payload === undefined) {
    return {};
  }
  if (!isRecord(payload)) {
    throw new BadRequestError('payload must be an object when provided');
  }
  assertOptionalString(payload.targetTaskId, 'targetTaskId');
  return payload.targetTaskId === undefined ? {} : { targetTaskId: payload.targetTaskId };
}

function readPositiveByteLimit(
  value: unknown,
  label: string,
  defaultValue: number,
  max: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new BadRequestError(`${label} must be a positive integer`);
  }

  return Math.min(value, max);
}

function readNonNegativeTimeout(
  value: unknown,
  label: string,
  defaultValue: number,
  max: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadRequestError(`${label} must be a non-negative integer`);
  }

  return Math.min(value, max);
}

function readCloseTaskPayload(payload: unknown): CoordinatorCloseTaskPayload {
  if (!isRecord(payload)) {
    throw new BadRequestError('close_task payload is required');
  }
  assertString(payload.targetTaskId, 'targetTaskId');
  return { targetTaskId: payload.targetTaskId };
}

function readGetTaskOutputPayload(payload: unknown): CoordinatorGetTaskOutputPayload {
  const base = readTargetTaskPayload(payload);
  if (payload === undefined) {
    return base;
  }
  if (!isRecord(payload)) {
    throw new BadRequestError('get_task_output payload must be an object when provided');
  }
  return {
    ...base,
    maxBytes: readPositiveByteLimit(
      payload.maxBytes,
      'maxBytes',
      TASK_OUTPUT_DEFAULT_MAX_BYTES,
      TASK_OUTPUT_MAX_BYTES,
    ),
  };
}

function readGetTaskDiffPayload(payload: unknown): CoordinatorGetTaskDiffPayload {
  const base = readTargetTaskPayload(payload);
  if (payload === undefined) {
    return base;
  }
  if (!isRecord(payload)) {
    throw new BadRequestError('get_task_diff payload must be an object when provided');
  }
  if (payload.includePatch !== undefined && typeof payload.includePatch !== 'boolean') {
    throw new BadRequestError('includePatch must be a boolean when provided');
  }
  return {
    ...base,
    includePatch: payload.includePatch === true,
    maxBytes: readPositiveByteLimit(
      payload.maxBytes,
      'maxBytes',
      TASK_DIFF_DEFAULT_MAX_BYTES,
      TASK_DIFF_MAX_BYTES,
    ),
  };
}

function readWaitForIdlePayload(payload: unknown): CoordinatorWaitForIdlePayload {
  const base = readTargetTaskPayload(payload);
  if (payload === undefined) {
    return base;
  }
  if (!isRecord(payload)) {
    throw new BadRequestError('wait_for_idle payload must be an object when provided');
  }
  return {
    ...base,
    timeoutMs: readNonNegativeTimeout(
      payload.timeoutMs,
      'timeoutMs',
      WAIT_FOR_IDLE_MAX_TIMEOUT_MS,
      WAIT_FOR_IDLE_MAX_TIMEOUT_MS,
    ),
  };
}

function readSignalDonePayload(payload: unknown): CoordinatorSignalDonePayload {
  if (payload === undefined) {
    return {};
  }
  if (!isRecord(payload)) {
    throw new BadRequestError('signal_done payload must be an object when provided');
  }
  assertOptionalString(payload.result, 'result');
  return payload.result === undefined ? {} : { result: payload.result };
}

function readLandSelfPayload(payload: unknown): CoordinatorLandSelfPayload {
  if (!isRecord(payload)) {
    throw new BadRequestError('land_self payload is required');
  }
  assertString(payload.summary, 'summary');
  if (!isStringArray(payload.verification)) {
    throw new BadRequestError('verification must be a string array');
  }
  assertTextSize(payload.summary, 'summary', COORDINATOR_LIMITS.summaryTextMaxChars);
  for (const entry of payload.verification) {
    assertTextSize(entry, 'verification entry', COORDINATOR_LIMITS.verificationEntryMaxChars);
  }

  return {
    summary: payload.summary,
    verification: payload.verification,
  };
}

function getToolCallKey(envelope: CoordinatorToolCallEnvelope): string {
  const token = resolveCoordinatorToken(envelope.token);
  const tokenKey = token?.tokenId ?? createHash('sha256').update(envelope.token).digest('hex');
  return `${tokenKey}:${envelope.callId}`;
}

function getAutomationClientId(runId: string): string {
  return `${COORDINATOR_AUTOMATION_CLIENT_ID_PREFIX}${runId}`;
}

function getPromptDeliveryKey(
  prompt: Pick<CoordinatorPromptRequestSnapshot, 'requestId' | 'runId'>,
): string {
  return `${prompt.runId}:${prompt.requestId}`;
}

function getPromptDeliveryTargetKey(
  prompt: Pick<CoordinatorPromptRequestSnapshot, 'runId' | 'targetTaskId'>,
): string {
  return `${prompt.runId}:${prompt.targetTaskId}`;
}

function getLatestPromptSnapshot(
  prompt: Pick<CoordinatorPromptRequestSnapshot, 'requestId' | 'runId'>,
): CoordinatorPromptRequestSnapshot | null {
  return (
    getCoordinatorRun(prompt.runId)?.promptQueue.find(
      (candidate) => candidate.requestId === prompt.requestId,
    ) ?? null
  );
}

function getActivePromptDeliveryCountForRun(runId: string): number {
  let count = 0;
  for (const key of activePromptDeliveryKeys) {
    if (key.startsWith(`${runId}:`)) {
      count += 1;
    }
  }

  return count;
}

function hasPromptDeliveryCapacity(runId: string): boolean {
  return (
    activePromptDeliveryKeys.size < COORDINATOR_LIMITS.maxConcurrentPromptDeliveriesGlobal &&
    getActivePromptDeliveryCountForRun(runId) <
      COORDINATOR_LIMITS.maxConcurrentPromptDeliveriesPerRun
  );
}

function getSpawnDedupeKey(
  runId: string,
  payload: Pick<CoordinatorSpawnSubtaskPayload, 'assignment' | 'dedupeKey' | 'name'>,
): string {
  return payload.dedupeKey ?? `${runId}:${payload.name}:${payload.assignment}`;
}

function getSpawnDedupeReservationKey(runId: string, dedupeKey: string): string {
  return `${runId}:${dedupeKey}`;
}

function getActiveSpawnCountForRun(runId: string): number {
  let count = 0;
  for (const spawn of activeSpawnSubtasksByDedupeKey.values()) {
    if (spawn.runId === runId) {
      count += 1;
    }
  }

  return count;
}

function getActiveSpawnCountForProject(projectId: string): number {
  let count = 0;
  for (const spawn of activeSpawnSubtasksByDedupeKey.values()) {
    if (spawn.projectId === projectId) {
      count += 1;
    }
  }

  return count;
}

function mergeLaunchArgs(
  args: string[] | undefined,
  skipPermissionsArgs: string[] | undefined,
): string[] {
  const mergedArgs = [...(args ?? [])];
  for (const arg of skipPermissionsArgs ?? []) {
    if (!mergedArgs.includes(arg)) {
      mergedArgs.push(arg);
    }
  }

  return mergedArgs;
}

function shouldCleanupCoordinatorSubtask(status: CoordinatorSubtaskSnapshot['status']): boolean {
  return status !== 'cancelled' && status !== 'exited' && status !== 'landed';
}

function isStartupSubtaskStatus(status: CoordinatorSubtaskSnapshot['status']): boolean {
  return status === 'spawning' || status === 'waiting-for-agent-ready' || status === 'running';
}

function isPromptTargetActive(prompt: CoordinatorPromptRequestSnapshot): boolean {
  const run = getCoordinatorRun(prompt.runId);
  const subtask = run?.subtasks.find((candidate) => candidate.taskId === prompt.targetTaskId);
  return subtask !== undefined && !isCoordinatorTerminalSubtaskStatus(subtask.status);
}

function updateInitialPromptSubtaskStatus(prompt: CoordinatorPromptRequestSnapshot): void {
  if (prompt.kind !== 'initial-assignment') {
    return;
  }

  const run = getCoordinatorRun(prompt.runId);
  const subtask = run?.subtasks.find((candidate) => candidate.taskId === prompt.targetTaskId);
  if (!subtask || !isStartupSubtaskStatus(subtask.status)) {
    return;
  }

  if (prompt.status === 'delivered') {
    updateCoordinatorSubtaskStatus(prompt.runId, prompt.targetTaskId, 'running');
    return;
  }
  if (prompt.status === 'failed') {
    updateCoordinatorSubtaskStatus(prompt.runId, prompt.targetTaskId, 'failed', {
      result: prompt.waitingReason ?? 'Initial assignment delivery failed.',
    });
    return;
  }
  if (prompt.status === 'blocked-by-question') {
    updateCoordinatorSubtaskStatus(prompt.runId, prompt.targetTaskId, 'waiting-for-user', {
      ...(prompt.waitingReason !== undefined ? { result: prompt.waitingReason } : {}),
    });
  }
}

function updateCoordinatorPromptDeliveryState(
  runId: string,
  requestId: string,
  patch: Parameters<typeof updateCoordinatorPrompt>[2],
): CoordinatorPromptRequestSnapshot {
  const prompt = updateCoordinatorPrompt(runId, requestId, patch);
  updateInitialPromptSubtaskStatus(prompt);
  return prompt;
}

function assertCoordinatorTaskCaller(envelope: CoordinatorToolInvocation): void {
  const run = getCoordinatorRun(envelope.runId);
  if (!run || run.coordinatorTaskId !== envelope.taskId) {
    throw new BadRequestError('Only the coordinator task can call this tool');
  }
}

function assertCoordinatorSubtaskCaller(
  envelope: CoordinatorToolInvocation,
): CoordinatorSubtaskSnapshot {
  const run = getCoordinatorRun(envelope.runId);
  const subtask = run?.subtasks.find((candidate) => candidate.taskId === envelope.taskId);
  if (!run || !subtask) {
    throw new BadRequestError('Tool must be called by a subtask in the coordinator run');
  }

  return subtask;
}

function requireCoordinatorRun(runId: string): CoordinatorRunSnapshot {
  const run = getCoordinatorRun(runId);
  if (!run) {
    throw new BadRequestError('Coordinator run not found');
  }

  return run;
}

function resolveTargetSubtask(
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorTargetTaskPayload,
): CoordinatorSubtaskSnapshot {
  const run = requireCoordinatorRun(envelope.runId);
  const targetTaskId = payload.targetTaskId ?? envelope.taskId;
  const subtask = run.subtasks.find((candidate) => candidate.taskId === targetTaskId);
  if (!subtask) {
    throw new BadRequestError('targetTaskId must belong to the coordinator run');
  }

  if (isCoordinatorTerminalSubtaskStatus(subtask.status)) {
    throw new BadRequestError('targetTaskId is no longer active');
  }

  return subtask;
}

function trimUtf8BufferTail(
  buffer: Buffer,
  maxBytes: number,
): {
  text: string;
  truncatedBytes: number;
} {
  if (buffer.length <= maxBytes) {
    return {
      text: buffer.toString('utf8'),
      truncatedBytes: 0,
    };
  }

  let start = buffer.length - maxBytes;
  while (start < buffer.length) {
    const byte = buffer[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    start += 1;
  }

  return {
    text: buffer.subarray(start).toString('utf8'),
    truncatedBytes: start,
  };
}

function trimUtf8Text(
  text: string,
  maxBytes: number,
): {
  text: string;
  truncatedBytes: number;
} {
  const buffer = Buffer.from(text, 'utf8');
  return trimUtf8BufferTail(buffer, maxBytes);
}

function scheduleCoordinatorPromptDelivery(delayMs = 0, force = false): void {
  if (force) {
    promptDeliveryForce = true;
  }
  if (promptDeliveryContext === null) {
    return;
  }
  if (promptDeliveryTimer !== null) {
    if (force && delayMs === 0) {
      clearTimeout(promptDeliveryTimer);
      promptDeliveryTimer = null;
    } else {
      return;
    }
  }

  promptDeliveryTimer = setTimeout(() => {
    const forceDelivery = promptDeliveryForce;
    promptDeliveryForce = false;
    promptDeliveryTimer = null;
    void processCoordinatorPromptQueue(forceDelivery);
  }, delayMs);
}

function isDeliverablePromptStatus(status: CoordinatorPromptRequestSnapshot['status']): boolean {
  return (
    status === 'queued' ||
    status === 'waiting-for-agent-session' ||
    status === 'waiting-for-terminal-prompt' ||
    status === 'waiting-for-user-idle' ||
    status === 'waiting-for-terminal-input-clear' ||
    status === 'waiting-for-command-lease'
  );
}

async function processCoordinatorPromptQueue(force = false): Promise<void> {
  const context = promptDeliveryContext;
  if (!context) {
    return;
  }

  const now = Date.now();
  let nextRetryAt: number | null = null;
  for (const run of listCoordinatorRuns()) {
    for (const prompt of run.promptQueue) {
      if (!isDeliverablePromptStatus(prompt.status)) {
        continue;
      }
      if (!force && prompt.earliestDeliveryAt > now) {
        if (nextRetryAt === null) {
          nextRetryAt = prompt.earliestDeliveryAt;
        } else {
          nextRetryAt = Math.min(nextRetryAt, prompt.earliestDeliveryAt);
        }
        continue;
      }

      void deliverCoordinatorPromptWithAdmission(context, prompt);

      if (activePromptDeliveryKeys.size >= COORDINATOR_LIMITS.maxConcurrentPromptDeliveriesGlobal) {
        return;
      }
    }
  }

  if (nextRetryAt !== null) {
    scheduleCoordinatorPromptDelivery(Math.max(0, nextRetryAt - now));
  }
}

export function startCoordinatorPromptDeliveryRuntime(context: HandlerContext): () => void {
  promptDeliveryContext = context;
  promptDeliveryReferences += 1;

  function stopCoordinatorPromptDeliveryRuntime(): void {
    promptDeliveryReferences = Math.max(0, promptDeliveryReferences - 1);
    if (promptDeliveryReferences > 0) {
      return;
    }

    promptDeliveryCleanup?.();
  }

  if (promptDeliveryCleanup !== null) {
    scheduleCoordinatorPromptDelivery();
    return stopCoordinatorPromptDeliveryRuntime;
  }

  const cleanupCoordinatorEvents = subscribeCoordinatorEvents((event) => {
    if (event.eventType === 'prompt-upserted' || event.eventType === 'subtask-upserted') {
      scheduleCoordinatorPromptDelivery(PROMPT_DELIVERY_RETRY_DELAY_MS);
    }
  });
  const cleanupSupervisionEvents = subscribeAgentSupervision(() => {
    scheduleCoordinatorPromptDelivery(0, true);
  });
  promptDeliveryCleanup = () => {
    cleanupCoordinatorEvents();
    cleanupSupervisionEvents();
    if (promptDeliveryTimer !== null) {
      clearTimeout(promptDeliveryTimer);
      promptDeliveryTimer = null;
    }
    activePromptDeliveryKeys.clear();
    scheduledPromptDeliveryKeys.clear();
    promptDeliveryChainsByTargetKey.clear();
    promptDeliveryForce = false;
    promptDeliveryReferences = 0;
    promptDeliveryCleanup = null;
    promptDeliveryContext = null;
  };
  scheduleCoordinatorPromptDelivery();

  return stopCoordinatorPromptDeliveryRuntime;
}

export function resetCoordinatorToolGatewayForTests(): void {
  promptDeliveryCleanup?.();
  promptDeliveryCleanup = null;
  promptDeliveryContext = null;
  promptDeliveryForce = false;
  promptDeliveryReferences = 0;
  if (promptDeliveryTimer !== null) {
    clearTimeout(promptDeliveryTimer);
    promptDeliveryTimer = null;
  }
  activePromptDeliveryKeys.clear();
  scheduledPromptDeliveryKeys.clear();
  promptDeliveryChainsByTargetKey.clear();
  activeSpawnSubtasksByDedupeKey.clear();
}

function emitTaskCommandControllerChange(context: HandlerContext, taskId: string): void {
  context.emitIpcEvent?.(
    IPC.TaskCommandControllerChanged,
    getTaskCommandControllerSnapshot(taskId),
  );
}

function emitReleasedTaskCommandController(
  context: HandlerContext,
  snapshot: ReturnType<typeof cleanupTaskRuntimeWorkflow>['releasedTaskCommandController'],
): void {
  if (snapshot) {
    context.emitIpcEvent?.(IPC.TaskCommandControllerChanged, snapshot);
  }
}

function getTaskProjectMode(projectMode: ProjectMode): ProjectMode | undefined {
  return projectMode === 'non-git' ? 'non-git' : undefined;
}

function getCreatedTaskMetadata(
  result: CreateTaskResult,
  projectMode: ProjectMode,
): {
  gitIsolation: TaskGitIsolationMode | null;
  projectMode: ProjectMode | null;
  worktreeOwnership: 'external' | 'managed' | null;
} {
  if (projectMode === 'non-git') {
    return {
      gitIsolation: null,
      projectMode,
      worktreeOwnership: null,
    };
  }

  const gitIsolation: TaskGitIsolationMode = result.git_isolation ?? 'worktree';
  return {
    gitIsolation,
    projectMode: 'git',
    worktreeOwnership: gitIsolation === 'worktree' ? 'managed' : 'external',
  };
}

async function createHiddenSubtask(
  gateway: CoordinatorToolGatewayContext,
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorSpawnSubtaskPayload,
): Promise<CoordinatorSubtaskSnapshot> {
  assertCoordinatorTaskCaller(envelope);
  const run = getCoordinatorRun(envelope.runId);
  if (!run) {
    throw new BadRequestError('Coordinator run not found');
  }

  const activeSubtaskCount = run.subtasks.filter(
    (subtask) => !isCoordinatorTerminalSubtaskStatus(subtask.status),
  ).length;
  if (activeSubtaskCount >= run.limits.maxActiveSubtasks + run.limits.maxQueuedSubtasks) {
    throw new BadRequestError('Coordinator subtask limit reached');
  }

  const dedupeKey = getSpawnDedupeKey(run.id, payload);
  const existingSubtask = run.subtasks.find((subtask) => subtask.dedupeKey === dedupeKey);
  if (existingSubtask) {
    return existingSubtask;
  }

  const reservationKey = getSpawnDedupeReservationKey(run.id, dedupeKey);
  const activeSpawn = activeSpawnSubtasksByDedupeKey.get(reservationKey);
  if (activeSpawn) {
    return activeSpawn.promise;
  }
  if (
    activeSubtaskCount + getActiveSpawnCountForRun(run.id) >=
    run.limits.maxActiveSubtasks + run.limits.maxQueuedSubtasks
  ) {
    throw new BadRequestError('Coordinator subtask limit reached');
  }
  if (activeSpawnSubtasksByDedupeKey.size >= COORDINATOR_LIMITS.maxConcurrentSpawnsGlobal) {
    throw new BadRequestError('Coordinator global spawn limit reached');
  }
  if (
    getActiveSpawnCountForProject(run.projectId) >= COORDINATOR_LIMITS.maxConcurrentSpawnsPerProject
  ) {
    throw new BadRequestError('Coordinator project spawn limit reached');
  }

  const spawnPromise = createHiddenSubtaskAfterDedupe(gateway, payload, run, dedupeKey);
  activeSpawnSubtasksByDedupeKey.set(reservationKey, {
    projectId: run.projectId,
    promise: spawnPromise,
    runId: run.id,
  });
  try {
    return await spawnPromise;
  } finally {
    if (activeSpawnSubtasksByDedupeKey.get(reservationKey)?.promise === spawnPromise) {
      activeSpawnSubtasksByDedupeKey.delete(reservationKey);
    }
  }
}

async function createHiddenSubtaskAfterDedupe(
  gateway: CoordinatorToolGatewayContext,
  payload: CoordinatorSpawnSubtaskPayload,
  run: CoordinatorRunSnapshot,
  dedupeKey: string,
): Promise<CoordinatorSubtaskSnapshot> {
  const agentId = randomUUID();
  const projectMode = getTaskProjectMode(run.projectMode);
  const taskResult = await createTaskWorkflow(gateway.context, {
    ...(payload.baseBranch !== undefined ? { baseBranch: payload.baseBranch } : {}),
    ...(payload.branchPrefix !== undefined ? { branchPrefix: payload.branchPrefix } : {}),
    ...(run.projectMode === 'git' ? { gitIsolation: 'worktree' as const } : {}),
    name: payload.name,
    projectId: run.projectId,
    ...(projectMode !== undefined ? { projectMode } : {}),
    projectRoot: run.projectRoot,
    symlinkDirs: [],
  });
  const result = taskResult as CreateTaskResult;
  const taskMetadata = getCreatedTaskMetadata(result, run.projectMode);
  let taskRegistryUpdated = false;
  try {
    gateway.taskNames.registerCreatedTask(result.id, {
      agentDefId: `coordinator-custom:${payload.agent.command}`,
      agentDefName: payload.agent.name ?? payload.agent.command,
      branchName: result.branch_name,
      gitIsolation: taskMetadata.gitIsolation,
      projectMode: taskMetadata.projectMode,
      taskName: payload.name,
      worktreePath: result.worktree_path,
      worktreeOwnership: taskMetadata.worktreeOwnership,
    });
    taskRegistryUpdated = true;

    const credential = createCoordinatorCredential(gateway.context, {
      agentId,
      runId: run.id,
      taskId: result.id,
      ...(gateway.context.coordinatorToolCallUrl !== undefined
        ? { toolCallUrl: gateway.context.coordinatorToolCallUrl }
        : {}),
    });
    addCoordinatorSubtask({
      agentId,
      assignment: payload.assignment,
      branchName: result.branch_name,
      dedupeKey,
      parentCoordinatorTaskId: run.coordinatorTaskId,
      runId: run.id,
      status: 'spawning',
      taskId: result.id,
      toolTokenId: credential.tokenId,
      worktreePath: result.worktree_path,
    });

    const env = {
      ...(payload.agent.env ?? {}),
      PARALLEL_CODE_COORDINATOR_CREDENTIAL: credential.credentialPath,
      PARALLEL_CODE_COORDINATOR_RUN_ID: run.id,
      ...(credential.toolCommand !== undefined
        ? { PARALLEL_CODE_COORDINATOR_TOOL: credential.toolCommand }
        : {}),
    };
    const launchArgs = mergeLaunchArgs(payload.agent.args, payload.agent.skipPermissionsArgs);
    const runnerProfile = normalizeAgentRunnerProfileConfig(undefined);
    spawnTaskAgentWorkflow(gateway.context, {
      agentId,
      args: launchArgs,
      command: payload.agent.command,
      cols: DEFAULT_TERMINAL_COLS,
      cwd: result.worktree_path,
      env,
      isShell: false,
      projectMode: run.projectMode,
      rows: DEFAULT_TERMINAL_ROWS,
      taskId: result.id,
      ...(runnerProfile !== undefined ? { runnerProfile } : {}),
    });

    const prompt = enqueueCoordinatorPrompt({
      kind: 'initial-assignment',
      runId: run.id,
      sourceTaskId: run.coordinatorTaskId,
      targetAgentId: agentId,
      targetTaskId: result.id,
      text: buildCoordinatorSubtaskAssignment(payload.assignment, {
        ...(credential.toolCommand !== undefined ? { toolCommand: credential.toolCommand } : {}),
      }),
      ...(payload.dedupeKey !== undefined ? { dedupeKey: payload.dedupeKey } : {}),
    });
    updateCoordinatorSubtaskStatus(run.id, result.id, 'waiting-for-agent-ready');
    await deliverCoordinatorPromptWithAdmission(gateway.context, prompt);
    const latestSubtask = getCoordinatorRun(run.id)?.subtasks.find(
      (candidate) => candidate.taskId === result.id,
    );
    if (!latestSubtask) {
      throw new Error(`Coordinator subtask disappeared during spawn: ${result.id}`);
    }

    return latestSubtask;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (taskRegistryUpdated) {
      gateway.taskNames.deleteTask(result.id);
    }
    revokeCoordinatorTaskCredential(gateway.context, result.id);
    await deleteCreatedCoordinatorTask(gateway.context, result, run, [agentId]);
    if (!getCoordinatorRun(run.id)?.subtasks.some((subtask) => subtask.taskId === result.id)) {
      throw error;
    }

    return updateCoordinatorSubtaskStatus(run.id, result.id, 'failed', { result: message });
  }
}

async function deleteCreatedCoordinatorTask(
  context: HandlerContext,
  result: CreateTaskResult,
  run: Pick<CoordinatorRunSnapshot, 'projectMode' | 'projectRoot'>,
  agentIds: string[],
): Promise<void> {
  try {
    if (run.projectMode === 'git' && result.git_isolation !== 'current-branch') {
      const cleanup = await deleteTaskWorkflow({
        agentIds,
        branchName: result.branch_name,
        deleteBranch: true,
        projectRoot: run.projectRoot,
        taskId: result.id,
        worktreePath: result.worktree_path,
      });
      emitReleasedTaskCommandController(context, cleanup.releasedTaskCommandController);
      return;
    }

    const cleanup = cleanupTaskRuntimeWorkflow({
      agentIds,
      projectMode: run.projectMode,
      removeTaskState: true,
      taskId: result.id,
      worktreePath: result.worktree_path,
    });
    emitReleasedTaskCommandController(context, cleanup.releasedTaskCommandController);
  } catch (cleanupError) {
    console.warn('Failed to clean coordinator-created task after spawn failure:', cleanupError);
  }
}

function toCoordinatorSubtaskCleanupWarning(
  subtask: CoordinatorSubtaskSnapshot,
  message: string,
): DeleteTaskCleanupWarning {
  return {
    kind: 'worktree',
    message: `Coordinator subtask ${subtask.taskId} cleanup did not finish: ${message}`,
  };
}

async function cleanupCoordinatorSubtaskRuntime(
  gateway: CoordinatorToolGatewayContext,
  run: CoordinatorRunSnapshot,
  subtask: CoordinatorSubtaskSnapshot,
): Promise<DeleteTaskCleanupWarning[]> {
  if (!shouldCleanupCoordinatorSubtask(subtask.status)) {
    return [];
  }

  cancelCoordinatorPromptsForTask(run.id, subtask.taskId, 'subtask-cleaned-up');

  try {
    if (run.projectMode === 'git' && subtask.branchName) {
      const cleanup = await deleteTaskWorkflow({
        agentIds: [subtask.agentId],
        branchName: subtask.branchName,
        deleteBranch: true,
        projectRoot: run.projectRoot,
        taskId: subtask.taskId,
        worktreePath: subtask.worktreePath,
      });
      emitReleasedTaskCommandController(gateway.context, cleanup.releasedTaskCommandController);
      gateway.taskNames.deleteTask(subtask.taskId);
      revokeCoordinatorTaskCredential(gateway.context, subtask.taskId);
      if (cleanup.cleanupWarnings.length > 0) {
        updateCoordinatorSubtaskStatus(run.id, subtask.taskId, 'cleanup-failed');
        return cleanup.cleanupWarnings.map((warning) =>
          toCoordinatorSubtaskCleanupWarning(subtask, warning.message),
        );
      }

      updateCoordinatorSubtaskStatus(run.id, subtask.taskId, 'cancelled');
      return [];
    }

    const cleanup = cleanupTaskRuntimeWorkflow({
      agentIds: [subtask.agentId],
      projectMode: run.projectMode,
      removeTaskState: true,
      taskId: subtask.taskId,
      worktreePath: subtask.worktreePath,
    });
    emitReleasedTaskCommandController(gateway.context, cleanup.releasedTaskCommandController);
    gateway.taskNames.deleteTask(subtask.taskId);
    revokeCoordinatorTaskCredential(gateway.context, subtask.taskId);
    updateCoordinatorSubtaskStatus(run.id, subtask.taskId, 'cancelled');
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gateway.taskNames.deleteTask(subtask.taskId);
    revokeCoordinatorTaskCredential(gateway.context, subtask.taskId);
    updateCoordinatorSubtaskStatus(run.id, subtask.taskId, 'cleanup-failed');
    return [toCoordinatorSubtaskCleanupWarning(subtask, message)];
  }
}

export async function cleanupCoordinatorTaskStateAndOwnedSubtasks(
  gateway: CoordinatorToolGatewayContext,
  taskId: string,
): Promise<DeleteTaskCleanupWarning[]> {
  const run = getCoordinatorRunByCoordinatorTaskId(taskId);
  if (!run) {
    cleanupCoordinatorStateForTask(gateway.context, taskId);
    return [];
  }

  const warnings: DeleteTaskCleanupWarning[] = [];
  for (const subtask of run.subtasks) {
    warnings.push(...(await cleanupCoordinatorSubtaskRuntime(gateway, run, subtask)));
  }
  cleanupCoordinatorStateForTask(gateway.context, taskId);
  return warnings;
}

async function deliverCoordinatorPromptSerialized(
  context: HandlerContext,
  prompt: CoordinatorPromptRequestSnapshot,
): Promise<CoordinatorPromptRequestSnapshot> {
  const targetKey = getPromptDeliveryTargetKey(prompt);
  const previousDelivery = promptDeliveryChainsByTargetKey.get(targetKey) ?? Promise.resolve();
  const delivery = previousDelivery
    .catch(() => undefined)
    .then(async () => {
      const latestPrompt = getLatestPromptSnapshot(prompt);
      if (!latestPrompt) {
        return prompt;
      }
      if (!isDeliverablePromptStatus(latestPrompt.status)) {
        return latestPrompt;
      }

      return deliverCoordinatorPrompt(context, latestPrompt);
    });
  const trackedDelivery = delivery.finally(() => {
    if (promptDeliveryChainsByTargetKey.get(targetKey) === trackedDelivery) {
      promptDeliveryChainsByTargetKey.delete(targetKey);
    }
  });
  promptDeliveryChainsByTargetKey.set(targetKey, trackedDelivery);
  return delivery;
}

async function deliverCoordinatorPromptWithAdmission(
  context: HandlerContext,
  prompt: CoordinatorPromptRequestSnapshot,
): Promise<CoordinatorPromptRequestSnapshot> {
  const latestPrompt = getLatestPromptSnapshot(prompt);
  if (!latestPrompt) {
    return prompt;
  }
  if (!isDeliverablePromptStatus(latestPrompt.status)) {
    return latestPrompt;
  }

  const key = getPromptDeliveryKey(latestPrompt);
  if (scheduledPromptDeliveryKeys.has(key) || activePromptDeliveryKeys.has(key)) {
    return latestPrompt;
  }
  if (!hasPromptDeliveryCapacity(latestPrompt.runId)) {
    scheduleCoordinatorPromptDelivery(PROMPT_DELIVERY_RETRY_DELAY_MS);
    return latestPrompt;
  }

  scheduledPromptDeliveryKeys.add(key);
  try {
    return await deliverCoordinatorPromptSerialized(context, latestPrompt);
  } finally {
    scheduledPromptDeliveryKeys.delete(key);
    scheduleCoordinatorPromptDelivery(PROMPT_DELIVERY_RETRY_DELAY_MS);
  }
}

function canCompletePromptDelivery(prompt: CoordinatorPromptRequestSnapshot): boolean {
  const latestPrompt = getLatestPromptSnapshot(prompt);
  if (!latestPrompt || latestPrompt.status !== 'delivering') {
    return false;
  }

  return isPromptTargetActive(latestPrompt);
}

async function deliverCoordinatorPrompt(
  context: HandlerContext,
  prompt: CoordinatorPromptRequestSnapshot,
): Promise<CoordinatorPromptRequestSnapshot> {
  const nextRetryAt = Date.now() + PROMPT_DELIVERY_RETRY_DELAY_MS;
  if (!isPromptTargetActive(prompt)) {
    return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
      status: 'cancelled',
      waitingReason: 'target-task-not-active',
    });
  }

  const blockingHints = getCoordinatorBlockingActivityHints(prompt.targetTaskId);
  if (blockingHints.length > 0) {
    return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
      earliestDeliveryAt: nextRetryAt,
      status: 'waiting-for-user-idle',
      waitingReason: blockingHints[0]?.kind ?? 'user-activity',
    });
  }

  if (!hasAgentSession(prompt.targetAgentId)) {
    return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
      earliestDeliveryAt: nextRetryAt,
      status: 'waiting-for-agent-session',
      waitingReason: 'agent-session-missing',
    });
  }

  const agentMeta = getAgentMeta(prompt.targetAgentId);
  if (!agentMeta || agentMeta.taskId !== prompt.targetTaskId) {
    return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
      failedAt: Date.now(),
      status: 'failed',
      waitingReason: 'agent-task-mismatch',
    });
  }

  const supervision = getAgentSupervisionSnapshot(prompt.targetAgentId);
  if (!supervision || supervision.taskId !== prompt.targetTaskId) {
    return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
      earliestDeliveryAt: nextRetryAt,
      status: 'waiting-for-agent-session',
      waitingReason: 'agent-supervision-missing',
    });
  }
  if (supervision.state === 'awaiting-input') {
    return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
      status: 'blocked-by-question',
      waitingReason: 'agent-awaiting-input',
    });
  }
  if (supervision.state !== 'idle-at-prompt') {
    return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
      earliestDeliveryAt: nextRetryAt,
      status: 'waiting-for-terminal-prompt',
      waitingReason: `agent-${supervision.state}`,
    });
  }

  const automationClientId = getAutomationClientId(prompt.runId);
  const key = getPromptDeliveryKey(prompt);
  if (activePromptDeliveryKeys.has(key)) {
    return prompt;
  }
  if (!hasPromptDeliveryCapacity(prompt.runId)) {
    scheduleCoordinatorPromptDelivery(PROMPT_DELIVERY_RETRY_DELAY_MS);
    return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
      earliestDeliveryAt: nextRetryAt,
      status: 'queued',
      waitingReason: undefined,
    });
  }

  activePromptDeliveryKeys.add(key);
  let acquiredLeaseGeneration: number | null = null;
  try {
    const lease = acquireTaskCommandLease(
      prompt.targetTaskId,
      automationClientId,
      COORDINATOR_AUTOMATION_OWNER_ID,
      'send a coordinator prompt',
    );
    if (!lease.acquired) {
      return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
        earliestDeliveryAt: nextRetryAt,
        status: 'waiting-for-command-lease',
        waitingReason: 'task-command-lease-held',
      });
    }
    acquiredLeaseGeneration = lease.leaseGeneration;
    if (lease.changed) {
      emitTaskCommandControllerChange(context, prompt.targetTaskId);
    }

    const deliveryAttemptId = randomUUID();
    const journal = [
      ...prompt.deliveryJournal,
      {
        agentGeneration: agentMeta.generation,
        deliveryAttemptId,
        ptySessionId: `${prompt.targetAgentId}:${agentMeta.generation}`,
        requestId: prompt.requestId,
        writePreparedAt: Date.now(),
      },
    ];
    let updatedPrompt = updateCoordinatorPrompt(prompt.runId, prompt.requestId, {
      attempts: prompt.attempts + 1,
      deliveryJournal: journal,
      status: 'delivering',
      waitingReason: undefined,
    });

    const dispatch = materializePromptDispatch(prompt.text);
    for (const write of dispatch.writes) {
      if (!isPromptTargetActive(prompt)) {
        return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
          status: 'cancelled',
          waitingReason: 'target-task-not-active',
        });
      }
      if (!hasAgentSession(prompt.targetAgentId)) {
        throw new Error('Agent session disappeared during prompt delivery');
      }
      const currentMeta = getAgentMeta(prompt.targetAgentId);
      if (!currentMeta || currentMeta.generation !== agentMeta.generation) {
        throw new Error('Agent generation changed during prompt delivery');
      }
      if (
        !isTaskCommandLeaseGenerationHeld(
          prompt.targetTaskId,
          automationClientId,
          COORDINATOR_AUTOMATION_OWNER_ID,
          acquiredLeaseGeneration,
        )
      ) {
        throw new Error('Task command lease was lost during prompt delivery');
      }
      writeToAgent(prompt.targetAgentId, write.data);
      if (write.delayAfterMs > 0) {
        await sleep(write.delayAfterMs);
      }
    }

    if (!canCompletePromptDelivery(prompt)) {
      const latestPrompt = getLatestPromptSnapshot(prompt);
      if (latestPrompt) {
        return latestPrompt;
      }

      return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
        status: 'cancelled',
        waitingReason: 'prompt-no-longer-active',
      });
    }

    const latestDeliveryPrompt = getLatestPromptSnapshot(prompt) ?? updatedPrompt;
    const acceptedJournal = latestDeliveryPrompt.deliveryJournal.map((entry) =>
      entry.deliveryAttemptId === deliveryAttemptId
        ? { ...entry, writeAcceptedAt: Date.now() }
        : entry,
    );
    updatedPrompt = updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
      deliveredAt: Date.now(),
      deliveryJournal: acceptedJournal,
      status: 'delivered',
    });
    return updatedPrompt;
  } catch (error) {
    return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
      failedAt: Date.now(),
      status: 'failed',
      waitingReason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    activePromptDeliveryKeys.delete(key);
    if (acquiredLeaseGeneration !== null) {
      const release = releaseTaskCommandLease(
        prompt.targetTaskId,
        automationClientId,
        COORDINATOR_AUTOMATION_OWNER_ID,
        Date.now(),
        acquiredLeaseGeneration,
      );
      if (release.changed) {
        context.emitIpcEvent?.(IPC.TaskCommandControllerChanged, release.snapshot);
      }
    }
    scheduleCoordinatorPromptDelivery(PROMPT_DELIVERY_RETRY_DELAY_MS);
  }
}

async function sendCoordinatorPrompt(
  context: HandlerContext,
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorSendPromptPayload,
): Promise<CoordinatorPromptRequestSnapshot> {
  assertCoordinatorTaskCaller(envelope);
  const run = getCoordinatorRun(envelope.runId);
  const subtask = run?.subtasks.find((candidate) => candidate.taskId === payload.targetTaskId);
  if (!run || !subtask) {
    throw new BadRequestError('targetTaskId must belong to the coordinator run');
  }
  if (isCoordinatorTerminalSubtaskStatus(subtask.status)) {
    throw new BadRequestError('targetTaskId is no longer active');
  }

  if (payload.dedupeKey !== undefined) {
    const existingPrompt = run.promptQueue.find(
      (prompt) =>
        prompt.dedupeKey === payload.dedupeKey &&
        prompt.sourceTaskId === envelope.taskId &&
        prompt.targetTaskId === payload.targetTaskId,
    );
    if (existingPrompt) {
      return existingPrompt;
    }
  }

  const pendingPromptsForTarget = run.promptQueue.filter(
    (prompt) =>
      prompt.targetTaskId === payload.targetTaskId &&
      isCoordinatorPendingPromptStatus(prompt.status),
  );
  if (pendingPromptsForTarget.length >= run.limits.maxPendingPromptsPerTarget) {
    throw new BadRequestError('Coordinator prompt limit reached for target task');
  }

  const prompt = enqueueCoordinatorPrompt({
    kind: payload.kind ?? 'follow-up',
    runId: run.id,
    sourceTaskId: envelope.taskId,
    targetAgentId: subtask.agentId,
    targetTaskId: subtask.taskId,
    text: payload.text,
    ...(payload.dedupeKey !== undefined ? { dedupeKey: payload.dedupeKey } : {}),
  });
  return deliverCoordinatorPromptWithAdmission(context, prompt);
}

function listCoordinatorTasks(envelope: CoordinatorToolInvocation): Array<{
  agentId: string;
  assignment: string;
  branchName?: string;
  lastPromptRequestId?: string;
  status: CoordinatorSubtaskSnapshot['status'];
  taskId: string;
  updatedAt: number;
  worktreePath: string;
}> {
  assertCoordinatorTaskCaller(envelope);
  const run = requireCoordinatorRun(envelope.runId);
  return run.subtasks.map((subtask) => ({
    agentId: subtask.agentId,
    assignment: subtask.assignment,
    ...(subtask.branchName !== undefined ? { branchName: subtask.branchName } : {}),
    ...(subtask.lastPromptRequestId !== undefined
      ? { lastPromptRequestId: subtask.lastPromptRequestId }
      : {}),
    status: subtask.status,
    taskId: subtask.taskId,
    updatedAt: subtask.updatedAt,
    worktreePath: subtask.worktreePath,
  }));
}

function getCoordinatorTaskOutput(
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorGetTaskOutputPayload,
): {
  agentId: string;
  output: string;
  taskId: string;
  truncatedBytes: number;
} {
  assertCoordinatorTaskCaller(envelope);
  const subtask = resolveTargetSubtask(envelope, payload);
  const maxBytes = payload.maxBytes ?? TASK_OUTPUT_DEFAULT_MAX_BYTES;
  const output = trimUtf8BufferTail(
    getAgentScrollbackBuffer(subtask.agentId) ?? Buffer.alloc(0),
    maxBytes,
  );

  return {
    agentId: subtask.agentId,
    output: output.text,
    taskId: subtask.taskId,
    truncatedBytes: output.truncatedBytes,
  };
}

async function getCoordinatorTaskDiff(
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorGetTaskDiffPayload,
): Promise<{
  files: Awaited<ReturnType<typeof getProjectDiff>>['files'];
  patch?: string;
  taskId: string;
  totalAdded: number;
  totalRemoved: number;
  truncatedBytes: number;
}> {
  assertCoordinatorTaskCaller(envelope);
  const run = requireCoordinatorRun(envelope.runId);
  if (run.projectMode === 'non-git') {
    throw new BadRequestError('get_task_diff requires a git-backed coordinator run');
  }

  const subtask = resolveTargetSubtask(envelope, payload);
  const patchTextPromise =
    payload.includePatch === true ? getAllFileDiffs(subtask.worktreePath) : Promise.resolve('');
  const [summary, patchText] = await Promise.all([
    getProjectDiff(subtask.worktreePath, 'all'),
    patchTextPromise,
  ]);
  let trimmedPatch = { text: '', truncatedBytes: 0 };
  if (payload.includePatch === true) {
    trimmedPatch = trimUtf8Text(patchText, payload.maxBytes ?? TASK_DIFF_DEFAULT_MAX_BYTES);
  }

  return {
    files: summary.files,
    ...(payload.includePatch === true ? { patch: trimmedPatch.text } : {}),
    taskId: subtask.taskId,
    totalAdded: summary.totalAdded,
    totalRemoved: summary.totalRemoved,
    truncatedBytes: trimmedPatch.truncatedBytes,
  };
}

async function waitForCoordinatorTaskIdle(
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorWaitForIdlePayload,
): Promise<{
  agentId: string;
  idle: boolean;
  state: AgentSupervisionSnapshot['state'] | 'missing';
  taskId: string;
  timedOut: boolean;
}> {
  assertCoordinatorTaskCaller(envelope);
  const subtask = resolveTargetSubtask(envelope, payload);
  const deadline = Date.now() + (payload.timeoutMs ?? WAIT_FOR_IDLE_MAX_TIMEOUT_MS);

  while (true) {
    const currentSubtask = getCoordinatorRun(envelope.runId)?.subtasks.find(
      (candidate) => candidate.taskId === subtask.taskId,
    );
    if (!currentSubtask || isCoordinatorTerminalSubtaskStatus(currentSubtask.status)) {
      return {
        agentId: subtask.agentId,
        idle: false,
        state: 'missing',
        taskId: subtask.taskId,
        timedOut: false,
      };
    }

    const supervision = getAgentSupervisionSnapshot(subtask.agentId);
    if (supervision?.taskId === subtask.taskId && supervision.state === 'idle-at-prompt') {
      return {
        agentId: subtask.agentId,
        idle: true,
        state: supervision.state,
        taskId: subtask.taskId,
        timedOut: false,
      };
    }

    const now = Date.now();
    if (now >= deadline) {
      break;
    }
    await sleep(WAIT_FOR_IDLE_POLL_MS);
  }

  const supervision = getAgentSupervisionSnapshot(subtask.agentId);
  return {
    agentId: subtask.agentId,
    idle: false,
    state: supervision?.taskId === subtask.taskId ? supervision.state : 'missing',
    taskId: subtask.taskId,
    timedOut: true,
  };
}

async function closeCoordinatorSubtask(
  gateway: CoordinatorToolGatewayContext,
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorCloseTaskPayload,
): Promise<{
  cleanupWarnings: DeleteTaskCleanupWarning[];
  status: CoordinatorSubtaskSnapshot['status'];
  taskId: string;
}> {
  assertCoordinatorTaskCaller(envelope);
  const run = requireCoordinatorRun(envelope.runId);
  const subtask = run.subtasks.find((candidate) => candidate.taskId === payload.targetTaskId);
  if (!subtask) {
    throw new BadRequestError('targetTaskId must belong to the coordinator run');
  }

  const cleanupWarnings = await cleanupCoordinatorSubtaskRuntime(gateway, run, subtask);
  const latestSubtask = getCoordinatorRun(run.id)?.subtasks.find(
    (candidate) => candidate.taskId === subtask.taskId,
  );

  return {
    cleanupWarnings,
    status: latestSubtask?.status ?? subtask.status,
    taskId: subtask.taskId,
  };
}

async function landCoordinatorSubtask(
  gateway: CoordinatorToolGatewayContext,
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorLandSelfPayload,
): Promise<CoordinatorLandingStateSnapshot> {
  const context = gateway.context;
  const run = getCoordinatorRun(envelope.runId);
  const subtask = assertCoordinatorSubtaskCaller(envelope);
  if (!run) {
    throw new BadRequestError('Coordinator run not found');
  }

  const requestedAt = Date.now();
  const baseLanding: CoordinatorLandingStateSnapshot = {
    landingAttemptId: randomUUID(),
    requestedAt,
    requestedByAgentId: subtask.agentId,
    runId: run.id,
    status: 'validating',
    summary: payload.summary,
    taskId: subtask.taskId,
    verification: payload.verification,
  };
  upsertCoordinatorLanding({ landing: baseLanding, runId: run.id });

  if (run.projectMode === 'non-git' || !subtask.branchName) {
    const rejected = {
      ...baseLanding,
      failure: 'Self-landing is only available for git-backed subtasks.',
      status: 'rejected' as const,
    };
    upsertCoordinatorLanding({ landing: rejected, runId: run.id });
    return rejected;
  }

  const landingClientId = `${COORDINATOR_AUTOMATION_CLIENT_ID_PREFIX}${run.id}:landing`;
  const parentLease = acquireTaskCommandLease(
    run.coordinatorTaskId,
    landingClientId,
    COORDINATOR_LANDING_OWNER_ID,
    'land a coordinator subtask',
  );
  if (!parentLease.acquired) {
    const blocked = {
      ...baseLanding,
      failure: 'Coordinator task is currently controlled by a user.',
      status: 'blocked-by-parent-control' as const,
    };
    upsertCoordinatorLanding({ landing: blocked, runId: run.id });
    return blocked;
  }
  if (parentLease.changed) {
    emitTaskCommandControllerChange(context, run.coordinatorTaskId);
  }

  try {
    const worktreeStatus = await getWorktreeStatus(subtask.worktreePath);
    if (worktreeStatus.has_uncommitted_changes) {
      const dirty = {
        ...baseLanding,
        failure: 'Subtask worktree has uncommitted changes.',
        status: 'dirty-worktree' as const,
      };
      upsertCoordinatorLanding({ landing: dirty, runId: run.id });
      return dirty;
    }

    const parentWorktreeStatus = await getWorktreeStatus(run.projectRoot);
    if (parentWorktreeStatus.has_uncommitted_changes) {
      const dirtyParent = {
        ...baseLanding,
        failure: 'Project root has uncommitted changes.',
        status: 'dirty-parent-worktree' as const,
      };
      upsertCoordinatorLanding({ landing: dirtyParent, runId: run.id });
      return dirtyParent;
    }

    const merged = {
      ...baseLanding,
      status: 'merging' as const,
    };
    upsertCoordinatorLanding({ landing: merged, runId: run.id });
    const result = await mergeTask(
      run.projectRoot,
      subtask.worktreePath,
      subtask.branchName,
      false,
      payload.summary,
      false,
    );
    const cleanup = {
      ...merged,
      targetBranch: result.main_branch,
      status: 'cleanup' as const,
    };
    upsertCoordinatorLanding({ landing: cleanup, runId: run.id });
    const cleanupResult = await deleteTaskWorkflow({
      agentIds: [subtask.agentId],
      branchName: subtask.branchName,
      deleteBranch: true,
      projectRoot: run.projectRoot,
      taskId: subtask.taskId,
      worktreePath: subtask.worktreePath,
    });
    emitReleasedTaskCommandController(context, cleanupResult.releasedTaskCommandController);
    gateway.taskNames.deleteTask(subtask.taskId);
    revokeCoordinatorTaskCredential(context, subtask.taskId);
    if (cleanupResult.cleanupWarnings.length > 0) {
      const cleanupFailed = {
        ...cleanup,
        failure: cleanupResult.cleanupWarnings.map((warning) => warning.message).join('\n'),
        status: 'cleanup-failed' as const,
      };
      upsertCoordinatorLanding({ landing: cleanupFailed, runId: run.id });
      updateCoordinatorSubtaskStatus(run.id, subtask.taskId, 'cleanup-failed');
      return cleanupFailed;
    }

    const landed = {
      ...cleanup,
      status: 'landed' as const,
    };
    upsertCoordinatorLanding({ landing: landed, runId: run.id });
    updateCoordinatorSubtaskStatus(run.id, subtask.taskId, 'landed', { result: payload.summary });
    return landed;
  } catch (error) {
    const failed = {
      ...baseLanding,
      failure: error instanceof Error ? error.message : String(error),
      status: 'landing-failed' as const,
    };
    upsertCoordinatorLanding({ landing: failed, runId: run.id });
    updateCoordinatorSubtaskStatus(run.id, subtask.taskId, 'landing-failed');
    return failed;
  } finally {
    const release = releaseTaskCommandLease(
      run.coordinatorTaskId,
      landingClientId,
      COORDINATOR_LANDING_OWNER_ID,
      Date.now(),
      parentLease.leaseGeneration,
    );
    if (release.changed) {
      context.emitIpcEvent?.(IPC.TaskCommandControllerChanged, release.snapshot);
    }
  }
}

function assertAuthorized(envelope: CoordinatorToolCallEnvelope): void {
  const token = resolveCoordinatorToken(envelope.token);
  if (!token || token.runId !== envelope.runId || token.taskId !== envelope.taskId) {
    throw new BadRequestError('Invalid coordinator tool token');
  }

  const run = getCoordinatorRun(envelope.runId);
  if (!run) {
    throw new BadRequestError('Coordinator run is no longer active');
  }
  if (run.status !== 'running' && run.status !== 'draining') {
    throw new BadRequestError(`Coordinator run is ${run.status}`);
  }
  if (envelope.taskId === run.coordinatorTaskId) {
    return;
  }

  const subtask = run.subtasks.find((candidate) => candidate.taskId === envelope.taskId);
  if (
    !subtask ||
    subtask.status === 'cancelled' ||
    subtask.status === 'cleanup-failed' ||
    subtask.status === 'failed' ||
    subtask.status === 'landing-failed' ||
    subtask.status === 'landed' ||
    subtask.status === 'exited'
  ) {
    throw new BadRequestError('Coordinator subtask is no longer active');
  }
}

function isCoordinatorRendererMutationTool(
  toolName: CoordinatorToolInvocation['toolName'],
): boolean {
  return toolName === 'close_task' || toolName === 'send_prompt' || toolName === 'spawn_subtask';
}

function assertCoordinatorRendererToolAllowed(
  toolName: CoordinatorToolInvocation['toolName'],
): void {
  if (toolName === 'signal_done' || toolName === 'land_self') {
    throw new BadRequestError(`Coordinator UI cannot call ${toolName}`);
  }
}

function assertRendererRunAcceptsMutation(
  request: CoordinatorUiToolCallRequest,
  run: CoordinatorRunSnapshot,
): void {
  if (request.toolName === 'spawn_subtask') {
    if (run.status !== 'running') {
      throw new BadRequestError(`Coordinator run is ${run.status}`);
    }
    return;
  }

  if (run.status !== 'running' && run.status !== 'draining') {
    throw new BadRequestError(`Coordinator run is ${run.status}`);
  }
}

function assertRendererActionAuthorized(request: CoordinatorUiToolCallRequest): void {
  const run = getCoordinatorRun(request.runId);
  if (!run) {
    throw new BadRequestError('Coordinator run is no longer active');
  }
  if (run.coordinatorTaskId !== request.coordinatorTaskId) {
    throw new BadRequestError('coordinatorTaskId must own the coordinator run');
  }
  assertCoordinatorRendererToolAllowed(request.toolName);
  if (!isCoordinatorRendererMutationTool(request.toolName)) {
    return;
  }
  assertRendererRunAcceptsMutation(request, run);
  if (!request.controllerId) {
    throw new BadRequestError('controllerId is required for coordinator mutations');
  }
  if (!isTaskCommandLeaseHeld(request.coordinatorTaskId, request.controllerId)) {
    throw new BadRequestError('Coordinator task command lease is required');
  }
}

async function dispatchCoordinatorToolInvocation(
  gateway: CoordinatorToolGatewayContext,
  invocation: CoordinatorToolInvocation,
): Promise<unknown> {
  let result: unknown;
  switch (invocation.toolName) {
    case 'close_task':
      result = await closeCoordinatorSubtask(
        gateway,
        invocation,
        readCloseTaskPayload(invocation.payload),
      );
      break;
    case 'get_task_diff':
      result = await getCoordinatorTaskDiff(invocation, readGetTaskDiffPayload(invocation.payload));
      break;
    case 'get_task_output':
      result = getCoordinatorTaskOutput(invocation, readGetTaskOutputPayload(invocation.payload));
      break;
    case 'get_task_status':
      assertCoordinatorTaskCaller(invocation);
      result = getCoordinatorRun(invocation.runId);
      break;
    case 'list_tasks':
      result = listCoordinatorTasks(invocation);
      break;
    case 'spawn_subtask':
      result = await createHiddenSubtask(gateway, invocation, readSpawnPayload(invocation.payload));
      break;
    case 'send_prompt':
      result = await sendCoordinatorPrompt(
        gateway.context,
        invocation,
        readSendPromptPayload(invocation.payload),
      );
      break;
    case 'signal_done': {
      assertCoordinatorSubtaskCaller(invocation);
      const payload = readSignalDonePayload(invocation.payload);
      result = updateCoordinatorSubtaskStatus(
        invocation.runId,
        invocation.taskId,
        'ready-for-review',
        {
          ...(payload.result !== undefined ? { result: payload.result } : {}),
        },
      );
      break;
    }
    case 'land_self':
      result = await landCoordinatorSubtask(
        gateway,
        invocation,
        readLandSelfPayload(invocation.payload),
      );
      break;
    case 'wait_for_idle':
      result = await waitForCoordinatorTaskIdle(
        invocation,
        readWaitForIdlePayload(invocation.payload),
      );
      break;
    default:
      throw new BadRequestError('Unknown coordinator tool');
  }

  return result;
}

export async function executeCoordinatorToolCall(
  gateway: CoordinatorToolGatewayContext,
  envelope: CoordinatorToolCallEnvelope,
): Promise<CoordinatorToolCallResult> {
  assertString(envelope.callId, 'callId');
  assertString(envelope.runId, 'runId');
  assertString(envelope.taskId, 'taskId');
  assertString(envelope.token, 'token');
  assertAuthorized(envelope);

  const toolCallKey = getToolCallKey(envelope);
  const previousResult = getCoordinatorToolResult(toolCallKey);
  if (previousResult !== undefined) {
    return previousResult as CoordinatorToolCallResult;
  }

  const result = await dispatchCoordinatorToolInvocation(gateway, envelope);
  const response: CoordinatorToolCallResult = {
    accepted: true,
    callId: envelope.callId,
    result,
  };
  rememberCoordinatorToolResult(toolCallKey, response);
  return response;
}

export async function executeCoordinatorRendererAction(
  gateway: CoordinatorToolGatewayContext,
  request: CoordinatorUiToolCallRequest,
): Promise<CoordinatorToolCallResult> {
  assertString(request.requestId, 'requestId');
  assertString(request.runId, 'runId');
  assertString(request.coordinatorTaskId, 'coordinatorTaskId');
  assertRendererActionAuthorized(request);

  const toolCallKey = `renderer:${request.runId}:${request.coordinatorTaskId}:${request.requestId}`;
  const previousResult = getCoordinatorToolResult(toolCallKey);
  if (previousResult !== undefined) {
    return previousResult as CoordinatorToolCallResult;
  }

  const result = await dispatchCoordinatorToolInvocation(gateway, {
    callId: request.requestId,
    runId: request.runId,
    taskId: request.coordinatorTaskId,
    toolName: request.toolName,
    ...(request.payload !== undefined ? { payload: request.payload } : {}),
  });
  const response: CoordinatorToolCallResult = {
    accepted: true,
    callId: request.requestId,
    result,
  };
  rememberCoordinatorToolResult(toolCallKey, response);
  return response;
}
