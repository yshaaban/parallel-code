import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';

import { IPC } from '../ipc/channels.js';
import type { HandlerContext } from '../ipc/handler-context.js';
import { BadRequestError } from '../ipc/errors.js';
import { getAllFileDiffs, getProjectDiff, getWorktreeStatus, mergeTask } from '../ipc/git.js';
import { getAgentSupervisionSnapshot } from '../ipc/agent-supervision.js';
import { normalizeAgentRunnerProfileConfig } from '../ipc/agent-runner-handlers.js';
import { getAgentScrollbackBuffer } from '../ipc/pty.js';
import {
  acquireTaskCommandLease,
  isTaskCommandLeaseHeld,
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
  coordinatorRunAdmitsNewWork,
  createCoordinatorSubtaskStartupSnapshot,
  getCoordinatorRendererActionAllowedRunStatuses,
  getCoordinatorSubtaskStartupSnapshot,
  isCoordinatorOperatorActionName,
  isCoordinatorPendingPromptStatus,
  isCoordinatorTerminalSubtaskStatus,
  isCoordinatorTerminalWorkflowLaneStatus,
  isCoordinatorTerminalWorkflowStatus,
  isCoordinatorWorkflowResultConfidence,
  isCoordinatorWorkflowResultStatus,
  isCoordinatorWorkflowTemplate,
  type CoordinatorAgentFollowupPromptMode,
  type CoordinatorAgentInitialAssignmentMode,
  type CoordinatorAgentReadinessPolicy,
  type CoordinatorAppendWorkflowStepsPayload,
  type CoordinatorApproveWorkflowActionsPayload,
  type CoordinatorCloseTaskPayload,
  type CoordinatorDenyWorkflowActionsPayload,
  type CoordinatorGetTaskDiffPayload,
  type CoordinatorGetTaskOutputPayload,
  type CoordinatorLandSelfPayload,
  type CoordinatorLandingStateSnapshot,
  type CoordinatorOperatorActionName,
  type CoordinatorPromptKind,
  type CoordinatorPromptRequestSnapshot,
  type CoordinatorRetryLanePayload,
  type CoordinatorRunResumeResult,
  type CoordinatorRunSnapshot,
  type CoordinatorSendPromptPayload,
  type CoordinatorSignalDonePayload,
  type CoordinatorSpawnManyLanePayload,
  type CoordinatorSpawnManyPayload,
  type CoordinatorSpawnSubtaskPayload,
  type CoordinatorStartWorkflowLanePayload,
  type CoordinatorStartWorkflowPayload,
  type CoordinatorSubmitResultPayload,
  type CoordinatorSubtaskLaunchSnapshot,
  type CoordinatorSubtaskSnapshot,
  type CoordinatorSubtaskStartupSnapshot,
  type CoordinatorTargetTaskPayload,
  type CoordinatorToolCallEnvelope,
  type CoordinatorToolCallResult,
  type CoordinatorUiToolCallRequest,
  type CoordinatorWaitForIdlePayload,
  type CoordinatorWorkflowFindingSnapshot,
  type CoordinatorWorkflowPolicySnapshot,
  type CoordinatorWorkflowResultSnapshot,
  type CoordinatorWorkflowResultStatus,
  type CoordinatorWorkflowSnapshot,
  type CoordinatorWorkflowTemplate,
} from '../../src/domain/coordinator.js';
import { buildCoordinatorSubtaskAssignment } from '../../src/domain/coordinator-instructions.js';
import type { AgentSupervisionSnapshot } from '../../src/domain/server-state.js';
import { isRecord, isStringArray } from '../../src/lib/type-guards.js';
import type { TaskNameRegistry } from '../../server/task-names.js';
import type { DeleteTaskCleanupWarning } from '../../src/domain/task-cleanup.js';
import type { CreateTaskResult } from '../../src/ipc/types.js';
import type { ProjectMode, TaskGitIsolationMode } from '../../src/store/types.js';
import {
  cleanupCoordinatorStateForTask,
  createCoordinatorCredential,
  revokeCoordinatorTaskCredential,
  resolveCoordinatorToken,
} from './service.js';
import {
  COORDINATOR_AUTOMATION_CLIENT_ID_PREFIX,
  assertSupportedSeededInitialAssignment,
  buildCoordinatorSeededLaunchArgs,
  deliverCoordinatorPromptWithAdmission,
  emitTaskCommandControllerChange,
  mergeLaunchArgs,
  queueCoordinatorPromptForDelivery,
  resetCoordinatorPromptDeliveryForTests,
  scheduleCoordinatorPromptDelivery,
  startCoordinatorPromptDeliveryLoop,
  stopCoordinatorPromptDeliveryLoop,
  usesSeededInitialAssignment,
} from './prompt-delivery.js';
import {
  appendCoordinatorWorkflowExecutionSteps,
  type AppendCoordinatorWorkflowStepsExecutionResult,
  advanceCoordinatorWorkflowExecution,
  approveCoordinatorWorkflowActions,
  assertWorkflowBudgetAdmits,
  assertWorkflowWithinDeadline,
  DEFAULT_WORKFLOW_AGENT_COMMAND,
  DEFAULT_WORKFLOW_CONCURRENCY,
  denyCoordinatorWorkflowActions,
  getCoordinatorWorkflowNextTickAt,
  getWorkflowLaneStatusForResultStatus,
  getWorkflowResultStatusForActions,
  hasPendingWorkflowApprovalForLane,
  normalizeWorkflowFindingsForResult,
  readWorkflowDecisionActions,
  recordPendingWorkflowApproval,
  recordWorkflowVerdictsFromResult,
  resolveOwnedWorkflowLane as resolveExecutorOwnedWorkflowLane,
  resumeCoordinatorWorkflowExecution,
  retryCoordinatorWorkflowLaneFromOperator,
  startCoordinatorWorkflowExecution,
  tickCoordinatorWorkflowExecution,
  validateWorkflowDecisionActionsForResult,
  type SpawnCoordinatorWorkflowLane,
} from './workflow-executor.js';
import {
  addCoordinatorWorkflowLane,
  addCoordinatorWorkflowResult,
  appendCoordinatorWorkflowJournal,
  addCoordinatorSubtask,
  cancelCoordinatorWorkflowLanesForTask,
  cancelCoordinatorPromptsForTask,
  createCoordinatorWorkflow,
  enqueueCoordinatorPrompt,
  getCoordinatorRun,
  getCoordinatorRunByCoordinatorTaskId,
  getCoordinatorSubtaskLaunch,
  getCoordinatorToolResult,
  getCoordinatorWorkflow,
  listCoordinatorRuns,
  recordCoordinatorRunResumeOutcome,
  recordCoordinatorSubtaskLaunch,
  rememberCoordinatorToolResult,
  removeCoordinatorSubtaskLaunch,
  resumeCoordinatorRunFromStale,
  setCoordinatorRunPaused,
  subscribeCoordinatorEvents,
  updateCoordinatorSubtaskStatus,
  updateCoordinatorWorkflow,
  updateCoordinatorWorkflowLane,
  updateCoordinatorWorkflowStage,
  upsertCoordinatorLanding,
} from './runtime.js';

const COORDINATOR_LANDING_OWNER_ID = 'coordinator-self-landing';
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
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

interface WorkflowSpawnedLane {
  error?: string;
  laneId: string;
  subtask?: CoordinatorSubtaskSnapshot;
}

let coordinatorSchedulerCleanup: (() => void) | null = null;
let coordinatorSchedulerContext: HandlerContext | null = null;
let coordinatorSchedulerTaskNames: Pick<
  TaskNameRegistry,
  'deleteTask' | 'registerCreatedTask'
> | null = null;
let promptDeliveryReferences = 0;
let workflowExecutionActive = false;
let workflowExecutionTimer: ReturnType<typeof setTimeout> | null = null;
let workflowExecutionTimerDueAt: number | null = null;
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

function assertOptionalStringSize(
  value: unknown,
  label: string,
  maxChars: number,
): asserts value is string | undefined {
  assertOptionalString(value, label);
  if (value !== undefined) {
    assertTextSize(value, label, maxChars);
  }
}

function assertJsonPayloadSize(value: unknown, label: string, maxBytes: number): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new BadRequestError(`${label} must be JSON-serializable`);
  }
  if (serialized === undefined) {
    throw new BadRequestError(`${label} must be JSON-serializable`);
  }

  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new BadRequestError(`${label} must be no larger than ${maxBytes} bytes`);
  }
}

function readStringListPayload(
  value: unknown,
  label: string,
  maxItems: number,
  maxChars: number,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isStringArray(value)) {
    throw new BadRequestError(`${label} must be a string array when provided`);
  }
  if (value.length > maxItems) {
    throw new BadRequestError(`${label} must be no longer than ${maxItems} entries`);
  }
  for (const entry of value) {
    assertTextSize(entry, `${label} entry`, maxChars);
  }

  return value;
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry): entry is string => typeof entry === 'string')
  );
}

function assertOptionalCoordinatorAgentInitialAssignmentMode(value: unknown, label: string): void {
  if (
    value !== undefined &&
    value !== 'spawn-seeded-interactive' &&
    value !== 'post-ready-prompt'
  ) {
    throw new BadRequestError(`${label} must be spawn-seeded-interactive or post-ready-prompt`);
  }
}

function assertOptionalCoordinatorAgentFollowupPromptMode(value: unknown, label: string): void {
  if (value !== undefined && value !== 'post-ready-prompt' && value !== 'disallow') {
    throw new BadRequestError(`${label} must be a coordinator follow-up prompt mode`);
  }
}

function assertOptionalCoordinatorAgentReadinessPolicy(value: unknown, label: string): void {
  if (
    value !== undefined &&
    value !== 'codex' &&
    value !== 'shell' &&
    value !== 'terminal-generic'
  ) {
    throw new BadRequestError(`${label} must be a coordinator readiness policy`);
  }
}

function readSpawnPayload(payload: unknown): CoordinatorSpawnSubtaskPayload {
  if (!isRecord(payload) || !isRecord(payload.agent)) {
    throw new BadRequestError('spawn_subtask payload is required');
  }

  assertString(payload.name, 'name');
  assertString(payload.assignment, 'assignment');
  assertString(payload.agent.command, 'agent.command');
  assertOptionalString(payload.agent.name, 'agent.name');
  assertOptionalCoordinatorAgentInitialAssignmentMode(
    payload.agent.initialAssignmentMode,
    'agent.initialAssignmentMode',
  );
  assertOptionalCoordinatorAgentFollowupPromptMode(
    payload.agent.followupPromptMode,
    'agent.followupPromptMode',
  );
  assertOptionalCoordinatorAgentReadinessPolicy(
    payload.agent.readinessPolicy,
    'agent.readinessPolicy',
  );
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
      ...(payload.agent.followupPromptMode !== undefined
        ? {
            followupPromptMode: payload.agent
              .followupPromptMode as CoordinatorAgentFollowupPromptMode,
          }
        : {}),
      ...(payload.agent.initialAssignmentMode !== undefined
        ? {
            initialAssignmentMode: payload.agent
              .initialAssignmentMode as CoordinatorAgentInitialAssignmentMode,
          }
        : {}),
      ...(payload.agent.name !== undefined ? { name: payload.agent.name } : {}),
      ...(payload.agent.readinessPolicy !== undefined
        ? { readinessPolicy: payload.agent.readinessPolicy as CoordinatorAgentReadinessPolicy }
        : {}),
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

function readOptionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new BadRequestError(`${label} must be a positive integer`);
  }

  return value;
}

function readOptionalNonNegativeInt(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadRequestError(`${label} must be a non-negative integer`);
  }

  return value;
}

function readOptionalCappedInt(
  value: unknown,
  label: string,
  cap: number,
  options: { positive: boolean },
): number | undefined {
  const parsed = options.positive
    ? readOptionalPositiveInt(value, label)
    : readOptionalNonNegativeInt(value, label);
  if (parsed !== undefined && parsed > cap) {
    throw new BadRequestError(`${label} must be no greater than ${cap}`);
  }

  return parsed;
}

function readWorkflowPolicyPayload(
  payload: unknown,
): Partial<CoordinatorWorkflowPolicySnapshot> | undefined {
  if (payload === undefined) {
    return undefined;
  }
  if (!isRecord(payload)) {
    throw new BadRequestError('policy must be an object when provided');
  }
  if (payload.continueOnFailure !== undefined && typeof payload.continueOnFailure !== 'boolean') {
    throw new BadRequestError('policy.continueOnFailure must be a boolean when provided');
  }
  if (
    payload.requireDecisionApproval !== undefined &&
    typeof payload.requireDecisionApproval !== 'boolean'
  ) {
    throw new BadRequestError('policy.requireDecisionApproval must be a boolean when provided');
  }
  if (payload.resultRequired !== undefined && typeof payload.resultRequired !== 'boolean') {
    throw new BadRequestError('policy.resultRequired must be a boolean when provided');
  }
  assertOptionalStringSize(
    payload.budgetHint,
    'policy.budgetHint',
    COORDINATOR_LIMITS.maxWorkflowResultEntryChars,
  );

  const maxConcurrentLanes = readOptionalCappedInt(
    payload.maxConcurrentLanes,
    'policy.maxConcurrentLanes',
    COORDINATOR_LIMITS.maxWorkflowLanes,
    { positive: true },
  );
  const timeoutMs = readOptionalCappedInt(
    payload.timeoutMs,
    'policy.timeoutMs',
    COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
    { positive: false },
  );
  const maxOutputBytesPerLane = readOptionalPositiveInt(
    payload.maxOutputBytesPerLane,
    'policy.maxOutputBytesPerLane',
  );
  const maxIterationsPerBranch = readOptionalCappedInt(
    payload.maxIterationsPerBranch,
    'policy.maxIterationsPerBranch',
    COORDINATOR_LIMITS.maxWorkflowBranchIterations,
    { positive: true },
  );
  const retryBackoffMs = readOptionalNonNegativeInt(
    payload.retryBackoffMs,
    'policy.retryBackoffMs',
  );
  const retryCount = readOptionalNonNegativeInt(payload.retryCount, 'policy.retryCount');
  const maxTotalLanes = readOptionalCappedInt(
    payload.maxTotalLanes,
    'policy.maxTotalLanes',
    COORDINATOR_LIMITS.maxWorkflowLanes,
    { positive: true },
  );
  const maxTotalRetries = readOptionalCappedInt(
    payload.maxTotalRetries,
    'policy.maxTotalRetries',
    COORDINATOR_LIMITS.maxWorkflowTotalRetries,
    { positive: false },
  );
  const maxTotalSteps = readOptionalCappedInt(
    payload.maxTotalSteps,
    'policy.maxTotalSteps',
    COORDINATOR_LIMITS.maxWorkflowTotalSteps,
    { positive: true },
  );
  const maxWallClockMs = readOptionalCappedInt(
    payload.maxWallClockMs,
    'policy.maxWallClockMs',
    COORDINATOR_LIMITS.workflowMaxLaneTimeoutMs,
    { positive: true },
  );

  return {
    ...(payload.budgetHint !== undefined ? { budgetHint: payload.budgetHint } : {}),
    ...(payload.continueOnFailure !== undefined
      ? { continueOnFailure: payload.continueOnFailure }
      : {}),
    ...(maxConcurrentLanes !== undefined ? { maxConcurrentLanes } : {}),
    ...(maxIterationsPerBranch !== undefined ? { maxIterationsPerBranch } : {}),
    ...(maxOutputBytesPerLane !== undefined ? { maxOutputBytesPerLane } : {}),
    ...(maxTotalLanes !== undefined ? { maxTotalLanes } : {}),
    ...(maxTotalRetries !== undefined ? { maxTotalRetries } : {}),
    ...(maxTotalSteps !== undefined ? { maxTotalSteps } : {}),
    ...(maxWallClockMs !== undefined ? { maxWallClockMs } : {}),
    ...(payload.requireDecisionApproval !== undefined
      ? { requireDecisionApproval: payload.requireDecisionApproval }
      : {}),
    ...(payload.resultRequired !== undefined ? { resultRequired: payload.resultRequired } : {}),
    ...(retryBackoffMs !== undefined ? { retryBackoffMs } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function readSpawnAgentPayload(
  value: unknown,
  fallback: CoordinatorSpawnSubtaskPayload['agent'] | undefined,
): CoordinatorSpawnSubtaskPayload['agent'] {
  if (value === undefined) {
    return fallback ?? { command: DEFAULT_WORKFLOW_AGENT_COMMAND };
  }
  if (!isRecord(value)) {
    throw new BadRequestError('agent must be an object when provided');
  }
  assertString(value.command, 'agent.command');
  assertOptionalString(value.name, 'agent.name');
  assertOptionalCoordinatorAgentInitialAssignmentMode(
    value.initialAssignmentMode,
    'agent.initialAssignmentMode',
  );
  assertOptionalCoordinatorAgentFollowupPromptMode(
    value.followupPromptMode,
    'agent.followupPromptMode',
  );
  assertOptionalCoordinatorAgentReadinessPolicy(value.readinessPolicy, 'agent.readinessPolicy');
  if (value.args !== undefined && !isStringArray(value.args)) {
    throw new BadRequestError('agent.args must be a string array when provided');
  }
  if (value.skipPermissionsArgs !== undefined && !isStringArray(value.skipPermissionsArgs)) {
    throw new BadRequestError('agent.skipPermissionsArgs must be a string array when provided');
  }
  if (value.env !== undefined && !isRecordOfStrings(value.env)) {
    throw new BadRequestError('agent.env must be an object of string values when provided');
  }

  return {
    ...(value.args !== undefined ? { args: value.args } : {}),
    command: value.command,
    ...(value.env !== undefined ? { env: value.env } : {}),
    ...(value.followupPromptMode !== undefined
      ? { followupPromptMode: value.followupPromptMode as CoordinatorAgentFollowupPromptMode }
      : {}),
    ...(value.initialAssignmentMode !== undefined
      ? {
          initialAssignmentMode:
            value.initialAssignmentMode as CoordinatorAgentInitialAssignmentMode,
        }
      : {}),
    ...(value.name !== undefined ? { name: value.name } : {}),
    ...(value.readinessPolicy !== undefined
      ? { readinessPolicy: value.readinessPolicy as CoordinatorAgentReadinessPolicy }
      : {}),
    ...(value.skipPermissionsArgs !== undefined
      ? { skipPermissionsArgs: value.skipPermissionsArgs }
      : {}),
  };
}

function readSpawnManyLanePayload(
  value: unknown,
  fallbackAgent: CoordinatorSpawnSubtaskPayload['agent'] | undefined,
): CoordinatorSpawnManyLanePayload {
  if (!isRecord(value)) {
    throw new BadRequestError('spawn_many lanes must be objects');
  }
  assertString(value.name, 'lane.name');
  assertString(value.assignment, 'lane.assignment');
  assertOptionalStringSize(
    value.dedupeKey,
    'lane.dedupeKey',
    COORDINATOR_LIMITS.maxWorkflowShortTextChars,
  );
  assertOptionalStringSize(value.role, 'lane.role', COORDINATOR_LIMITS.maxWorkflowShortTextChars);
  assertTextSize(value.name, 'lane.name', COORDINATOR_LIMITS.maxWorkflowShortTextChars);
  assertTextSize(value.assignment, 'lane.assignment', COORDINATOR_LIMITS.assignmentTextMaxChars);

  return {
    agent: readSpawnAgentPayload(value.agent, fallbackAgent),
    assignment: value.assignment,
    ...(value.dedupeKey !== undefined ? { dedupeKey: value.dedupeKey } : {}),
    name: value.name,
    ...(value.role !== undefined ? { role: value.role } : {}),
  };
}

function readSpawnManyPayload(payload: unknown): CoordinatorSpawnManyPayload {
  if (!isRecord(payload) || !Array.isArray(payload.lanes)) {
    throw new BadRequestError('spawn_many payload with lanes is required');
  }
  if (payload.lanes.length === 0) {
    throw new BadRequestError('spawn_many requires at least one lane');
  }
  if (payload.lanes.length > COORDINATOR_LIMITS.maxWorkflowLanes) {
    throw new BadRequestError(
      `spawn_many lanes must be no longer than ${COORDINATOR_LIMITS.maxWorkflowLanes}`,
    );
  }
  assertOptionalStringSize(payload.title, 'title', COORDINATOR_LIMITS.maxWorkflowShortTextChars);
  assertOptionalString(payload.workflowId, 'workflowId');
  const agent = readSpawnAgentPayload(payload.agent, undefined);
  const policy = readWorkflowPolicyPayload(payload.policy);

  return {
    agent,
    lanes: payload.lanes.map((lane) => readSpawnManyLanePayload(lane, agent)),
    ...(policy !== undefined ? { policy } : {}),
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.workflowId !== undefined ? { workflowId: payload.workflowId } : {}),
  };
}

function readStartWorkflowLanePayload(
  value: unknown,
  fallbackAgent: CoordinatorSpawnSubtaskPayload['agent'],
): CoordinatorStartWorkflowLanePayload {
  if (!isRecord(value)) {
    throw new BadRequestError('workflow lanes must be objects');
  }
  assertString(value.name, 'lane.name');
  assertOptionalString(value.assignment, 'lane.assignment');
  assertOptionalStringSize(value.role, 'lane.role', COORDINATOR_LIMITS.maxWorkflowShortTextChars);
  assertTextSize(value.name, 'lane.name', COORDINATOR_LIMITS.maxWorkflowShortTextChars);
  if (value.assignment !== undefined) {
    assertTextSize(value.assignment, 'lane.assignment', COORDINATOR_LIMITS.assignmentTextMaxChars);
  }

  return {
    agent: readSpawnAgentPayload(value.agent, fallbackAgent),
    ...(value.assignment !== undefined ? { assignment: value.assignment } : {}),
    name: value.name,
    ...(value.role !== undefined ? { role: value.role } : {}),
  };
}

function readStartWorkflowPayload(payload: unknown): CoordinatorStartWorkflowPayload {
  if (!isRecord(payload)) {
    throw new BadRequestError('start_workflow payload is required');
  }
  if (!isCoordinatorWorkflowTemplate(payload.template)) {
    throw new BadRequestError('template must be a coordinator workflow template');
  }
  assertString(payload.problem, 'problem');
  assertOptionalStringSize(payload.title, 'title', COORDINATOR_LIMITS.maxWorkflowShortTextChars);
  assertTextSize(payload.problem, 'problem', COORDINATOR_LIMITS.assignmentTextMaxChars);
  const agent = readSpawnAgentPayload(payload.agent, undefined);
  if (payload.lanes !== undefined && !Array.isArray(payload.lanes)) {
    throw new BadRequestError('lanes must be an array when provided');
  }
  if (Array.isArray(payload.lanes) && payload.lanes.length > COORDINATOR_LIMITS.maxWorkflowLanes) {
    throw new BadRequestError(
      `lanes must be no longer than ${COORDINATOR_LIMITS.maxWorkflowLanes}`,
    );
  }
  if (payload.spec !== undefined && !isRecord(payload.spec)) {
    throw new BadRequestError('spec must be an object when provided');
  }
  if (payload.spec !== undefined && payload.template !== 'custom') {
    throw new BadRequestError('spec is only supported with the custom workflow template');
  }

  const policy = readWorkflowPolicyPayload(payload.policy);
  return {
    agent,
    ...(policy !== undefined ? { policy } : {}),
    problem: payload.problem,
    ...(payload.spec !== undefined ? { spec: payload.spec } : {}),
    template: payload.template,
    ...(Array.isArray(payload.lanes)
      ? { lanes: payload.lanes.map((lane) => readStartWorkflowLanePayload(lane, agent)) }
      : {}),
    ...(payload.title !== undefined ? { title: payload.title } : {}),
  };
}

function readAppendWorkflowStepsPayload(payload: unknown): CoordinatorAppendWorkflowStepsPayload {
  if (!isRecord(payload)) {
    throw new BadRequestError('append_workflow_steps payload is required');
  }
  assertString(payload.appendId, 'appendId');
  assertString(payload.workflowId, 'workflowId');
  assertOptionalString(payload.laneId, 'laneId');
  assertOptionalStringSize(payload.reason, 'reason', COORDINATOR_LIMITS.maxWorkflowSummaryChars);
  if (!Array.isArray(payload.steps) || payload.steps.length === 0) {
    throw new BadRequestError('steps must be a non-empty array');
  }
  if (payload.steps.length > COORDINATOR_LIMITS.maxWorkflowLanes) {
    throw new BadRequestError(
      `steps must be no longer than ${COORDINATOR_LIMITS.maxWorkflowLanes}`,
    );
  }
  assertTextSize(payload.appendId, 'appendId', COORDINATOR_LIMITS.maxWorkflowShortTextChars);
  assertTextSize(payload.workflowId, 'workflowId', COORDINATOR_LIMITS.maxWorkflowShortTextChars);
  if (payload.laneId !== undefined) {
    assertTextSize(payload.laneId, 'laneId', COORDINATOR_LIMITS.maxWorkflowShortTextChars);
  }
  assertJsonPayloadSize(payload.steps, 'steps', COORDINATOR_LIMITS.maxWorkflowMetadataBytes);

  return {
    appendId: payload.appendId,
    ...(payload.laneId !== undefined ? { laneId: payload.laneId } : {}),
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    steps: payload.steps,
    workflowId: payload.workflowId,
  };
}

function readWorkflowEvidence(value: unknown): CoordinatorSubmitResultPayload['evidence'] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new BadRequestError('evidence must be an array when provided');
  }
  if (value.length > COORDINATOR_LIMITS.maxWorkflowEvidence) {
    throw new BadRequestError(
      `evidence must be no longer than ${COORDINATOR_LIMITS.maxWorkflowEvidence}`,
    );
  }

  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new BadRequestError('evidence entries must be objects');
    }
    assertString(entry.label, 'evidence.label');
    assertOptionalStringSize(
      entry.file,
      'evidence.file',
      COORDINATOR_LIMITS.maxWorkflowResultEntryChars,
    );
    assertOptionalStringSize(
      entry.note,
      'evidence.note',
      COORDINATOR_LIMITS.maxWorkflowResultEntryChars,
    );
    assertOptionalStringSize(
      entry.url,
      'evidence.url',
      COORDINATOR_LIMITS.maxWorkflowResultEntryChars,
    );
    assertTextSize(entry.label, 'evidence.label', COORDINATOR_LIMITS.maxWorkflowResultEntryChars);
    if (
      entry.line !== undefined &&
      (typeof entry.line !== 'number' || !Number.isInteger(entry.line) || entry.line < 0)
    ) {
      throw new BadRequestError('evidence.line must be a non-negative integer when provided');
    }

    return {
      ...(entry.file !== undefined ? { file: entry.file } : {}),
      label: entry.label,
      ...(entry.line !== undefined ? { line: entry.line } : {}),
      ...(entry.note !== undefined ? { note: entry.note } : {}),
      ...(entry.url !== undefined ? { url: entry.url } : {}),
    };
  });
}

function readWorkflowFindings(value: unknown): CoordinatorWorkflowFindingSnapshot[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new BadRequestError('findings must be an array when provided');
  }
  if (value.length > COORDINATOR_LIMITS.maxWorkflowFindings) {
    throw new BadRequestError(
      `findings must be no longer than ${COORDINATOR_LIMITS.maxWorkflowFindings}`,
    );
  }

  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new BadRequestError('finding entries must be objects');
    }
    assertString(entry.summary, 'finding.summary');
    assertTextSize(
      entry.summary,
      'finding.summary',
      COORDINATOR_LIMITS.maxWorkflowResultEntryChars,
    );
    const evidenceIds = readStringListPayload(
      entry.evidenceIds,
      'finding.evidenceIds',
      COORDINATOR_LIMITS.maxWorkflowEvidence,
      COORDINATOR_LIMITS.maxWorkflowResultEntryChars,
    );
    const fileRefs = readStringListPayload(
      entry.fileRefs,
      'finding.fileRefs',
      COORDINATOR_LIMITS.maxWorkflowResultListItems,
      COORDINATOR_LIMITS.maxWorkflowResultEntryChars,
    );
    const finding: CoordinatorWorkflowFindingSnapshot = {
      summary: entry.summary,
    };
    assertOptionalStringSize(entry.id, 'finding.id', COORDINATOR_LIMITS.maxWorkflowShortTextChars);
    assertOptionalStringSize(
      entry.owner,
      'finding.owner',
      COORDINATOR_LIMITS.maxWorkflowResultEntryChars,
    );
    assertOptionalStringSize(
      entry.riskType,
      'finding.riskType',
      COORDINATOR_LIMITS.maxWorkflowResultEntryChars,
    );
    assertOptionalStringSize(
      entry.sourceLaneId,
      'finding.sourceLaneId',
      COORDINATOR_LIMITS.maxWorkflowShortTextChars,
    );
    assertOptionalStringSize(
      entry.sourceResultId,
      'finding.sourceResultId',
      COORDINATOR_LIMITS.maxWorkflowShortTextChars,
    );
    assertOptionalStringSize(
      entry.title,
      'finding.title',
      COORDINATOR_LIMITS.maxWorkflowResultEntryChars,
    );
    if (
      entry.confidence !== undefined &&
      !isCoordinatorWorkflowResultConfidence(entry.confidence)
    ) {
      throw new BadRequestError('finding.confidence must be low, medium, or high');
    }
    if (entry.confidence !== undefined) {
      finding.confidence = entry.confidence;
    }
    if (evidenceIds !== undefined) {
      finding.evidenceIds = evidenceIds;
    }
    if (fileRefs !== undefined) {
      finding.fileRefs = fileRefs;
    }
    if (entry.id !== undefined) {
      finding.id = entry.id;
    }
    if (entry.owner !== undefined) {
      finding.owner = entry.owner;
    }
    if (entry.riskType !== undefined) {
      finding.riskType = entry.riskType;
    }
    if (entry.sourceLaneId !== undefined) {
      finding.sourceLaneId = entry.sourceLaneId;
    }
    if (entry.sourceResultId !== undefined) {
      finding.sourceResultId = entry.sourceResultId;
    }
    if (entry.title !== undefined) {
      finding.title = entry.title;
    }
    if (entry.severity !== undefined) {
      if (
        entry.severity !== 'critical' &&
        entry.severity !== 'major' &&
        entry.severity !== 'minor' &&
        entry.severity !== 'nit'
      ) {
        throw new BadRequestError('finding.severity must be critical, major, minor, or nit');
      }
      finding.severity = entry.severity;
    }
    if (entry.status !== undefined) {
      if (
        entry.status !== 'confirmed' &&
        entry.status !== 'semi-confirmed' &&
        entry.status !== 'highly-likely' &&
        entry.status !== 'rejected' &&
        entry.status !== 'unknown'
      ) {
        throw new BadRequestError('finding.status must be a valid workflow finding status');
      }
      finding.status = entry.status;
    }

    return finding;
  });
}

function readSubmitResultPayload(payload: unknown): CoordinatorSubmitResultPayload {
  if (!isRecord(payload)) {
    throw new BadRequestError('submit_result payload is required');
  }
  assertString(payload.summary, 'summary');
  assertOptionalString(payload.workflowId, 'workflowId');
  assertOptionalString(payload.laneId, 'laneId');
  const status = payload.status;
  const confidence = payload.confidence;
  if (status !== undefined && !isCoordinatorWorkflowResultStatus(status)) {
    throw new BadRequestError('status must be a coordinator workflow result status');
  }
  if (confidence !== undefined && !isCoordinatorWorkflowResultConfidence(confidence)) {
    throw new BadRequestError('confidence must be low, medium, or high');
  }
  if (payload.metadata !== undefined && !isRecord(payload.metadata)) {
    throw new BadRequestError('metadata must be an object when provided');
  }
  if (payload.metadata !== undefined) {
    assertJsonPayloadSize(
      payload.metadata,
      'metadata',
      COORDINATOR_LIMITS.maxWorkflowMetadataBytes,
    );
  }
  assertTextSize(payload.summary, 'summary', COORDINATOR_LIMITS.maxWorkflowSummaryChars);

  const commandsRun = readStringListPayload(
    payload.commandsRun,
    'commandsRun',
    COORDINATOR_LIMITS.maxWorkflowResultListItems,
    COORDINATOR_LIMITS.maxWorkflowResultEntryChars,
  );
  const evidence = readWorkflowEvidence(payload.evidence);
  const findings = readWorkflowFindings(payload.findings);
  const risks = readStringListPayload(
    payload.risks,
    'risks',
    COORDINATOR_LIMITS.maxWorkflowResultListItems,
    COORDINATOR_LIMITS.maxWorkflowResultEntryChars,
  );
  return {
    ...(commandsRun !== undefined ? { commandsRun } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(findings !== undefined ? { findings } : {}),
    ...(payload.laneId !== undefined ? { laneId: payload.laneId } : {}),
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    ...(risks !== undefined ? { risks } : {}),
    status: status ?? 'completed',
    summary: payload.summary,
    ...(payload.workflowId !== undefined ? { workflowId: payload.workflowId } : {}),
  };
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

function readApproveWorkflowActionsPayload(
  payload: unknown,
): CoordinatorApproveWorkflowActionsPayload {
  if (!isRecord(payload)) {
    throw new BadRequestError('approve_workflow_actions payload must be an object');
  }
  assertString(payload.approvalId, 'approvalId');
  assertString(payload.workflowId, 'workflowId');

  return { approvalId: payload.approvalId, workflowId: payload.workflowId };
}

function readDenyWorkflowActionsPayload(payload: unknown): CoordinatorDenyWorkflowActionsPayload {
  if (!isRecord(payload)) {
    throw new BadRequestError('deny_workflow_actions payload must be an object');
  }
  assertString(payload.approvalId, 'approvalId');
  assertString(payload.workflowId, 'workflowId');
  assertOptionalString(payload.reason, 'reason');
  assertOptionalStringSize(payload.reason, 'reason', COORDINATOR_LIMITS.maxWorkflowShortTextChars);

  return {
    approvalId: payload.approvalId,
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    workflowId: payload.workflowId,
  };
}

function readRetryLanePayload(payload: unknown): CoordinatorRetryLanePayload {
  if (!isRecord(payload)) {
    throw new BadRequestError('retry_lane payload must be an object');
  }
  assertString(payload.laneId, 'laneId');
  assertString(payload.workflowId, 'workflowId');

  return { laneId: payload.laneId, workflowId: payload.workflowId };
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

function shouldCleanupCoordinatorSubtask(status: CoordinatorSubtaskSnapshot['status']): boolean {
  return status !== 'cancelled' && status !== 'landed';
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

function scheduleCoordinatorWorkflowExecution(delayMs = 0): void {
  if (coordinatorSchedulerContext === null) {
    return;
  }

  const dueAt = Date.now() + delayMs;
  if (
    workflowExecutionTimer !== null &&
    workflowExecutionTimerDueAt !== null &&
    workflowExecutionTimerDueAt <= dueAt
  ) {
    return;
  }
  if (workflowExecutionTimer !== null) {
    clearTimeout(workflowExecutionTimer);
    workflowExecutionTimer = null;
  }

  workflowExecutionTimerDueAt = dueAt;
  workflowExecutionTimer = setTimeout(() => {
    workflowExecutionTimer = null;
    workflowExecutionTimerDueAt = null;
    void processCoordinatorWorkflowExecutionQueue();
  }, delayMs);
}

function scheduleNextCoordinatorWorkflowExecution(): void {
  const now = Date.now();
  let nextTickAt: number | null = null;
  for (const run of listCoordinatorRuns()) {
    for (const workflow of run.workflows) {
      const workflowTickAt = getCoordinatorWorkflowNextTickAt(workflow, now);
      if (workflowTickAt === null) {
        continue;
      }
      nextTickAt = nextTickAt === null ? workflowTickAt : Math.min(nextTickAt, workflowTickAt);
    }
  }

  if (nextTickAt !== null) {
    scheduleCoordinatorWorkflowExecution(Math.max(0, nextTickAt - now));
  }
}

function isTerminalWorkflowStageStatus(
  status: CoordinatorWorkflowSnapshot['stages'][number]['status'],
): boolean {
  return (
    status === 'blocked' ||
    status === 'cancelled' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'skipped' ||
    status === 'stale-after-restore'
  );
}

function getWorkflowSchedulerFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failWorkflowAfterSchedulerError(
  workflow: CoordinatorWorkflowSnapshot,
  error: unknown,
): void {
  const now = Date.now();
  const failure = `Workflow scheduler failed: ${getWorkflowSchedulerFailureMessage(error)}`;
  appendCoordinatorWorkflowJournal(workflow.runId, workflow.id, {
    at: now,
    kind: 'workflow-scheduler-failed',
    message: failure,
  });
  for (const lane of workflow.lanes) {
    if (isCoordinatorTerminalWorkflowLaneStatus(lane.status)) {
      continue;
    }
    if (lane.taskId !== undefined) {
      cancelCoordinatorPromptsForTask(workflow.runId, lane.taskId, 'workflow-scheduler-failed');
    }
    try {
      updateCoordinatorWorkflowLane(workflow.runId, workflow.id, lane.id, {
        completedAt: now,
        failure,
        now,
        status: 'failed',
      });
    } catch (laneFailureError) {
      console.warn('Failed to mark coordinator workflow lane failed:', laneFailureError);
    }
  }
  for (const stage of workflow.stages) {
    if (isTerminalWorkflowStageStatus(stage.status)) {
      continue;
    }
    updateCoordinatorWorkflowStage(workflow.runId, workflow.id, stage.id, {
      completedAt: now,
      failure,
      status: 'failed',
    });
  }
  updateCoordinatorWorkflow(workflow.runId, workflow.id, {
    completedAt: now,
    execution: {
      activeLaneCount: 0,
      failureSummary: failure,
      lastTickAt: now,
      pendingRetryLaneIds: [],
      readyStageIds: [],
    },
    now,
    status: 'failed',
  });
}

async function processCoordinatorWorkflowExecutionQueue(): Promise<void> {
  const context = coordinatorSchedulerContext;
  const taskNames = coordinatorSchedulerTaskNames;
  if (context === null || taskNames === null || workflowExecutionActive) {
    return;
  }

  workflowExecutionActive = true;
  try {
    const now = Date.now();
    for (const run of listCoordinatorRuns()) {
      for (const workflow of run.workflows) {
        const workflowTickAt = getCoordinatorWorkflowNextTickAt(workflow, now);
        if (workflowTickAt === null || workflowTickAt > now) {
          continue;
        }

        try {
          await tickCoordinatorWorkflowExecution({
            now,
            runId: run.id,
            spawnLane: (currentWorkflow, stageId, lanePayload) =>
              spawnWorkflowLane(
                {
                  context,
                  taskNames,
                },
                {
                  callId: `workflow-runtime:${currentWorkflow.id}`,
                  runId: run.id,
                  taskId: run.coordinatorTaskId,
                  toolName: 'start_workflow',
                },
                currentWorkflow,
                stageId,
                lanePayload,
              ),
            workflowId: workflow.id,
          });
        } catch (error) {
          try {
            failWorkflowAfterSchedulerError(workflow, error);
          } catch (failureError) {
            console.warn('Failed to record coordinator workflow scheduler failure:', failureError);
          }
        }
      }
    }
  } finally {
    workflowExecutionActive = false;
    scheduleNextCoordinatorWorkflowExecution();
  }
}

export function startCoordinatorPromptDeliveryRuntime(
  context: HandlerContext,
  taskNames?: Pick<TaskNameRegistry, 'deleteTask' | 'registerCreatedTask'>,
): () => void {
  coordinatorSchedulerContext = context;
  coordinatorSchedulerTaskNames = taskNames ?? coordinatorSchedulerTaskNames;
  promptDeliveryReferences += 1;
  startCoordinatorPromptDeliveryLoop(context);

  function stopCoordinatorPromptDeliveryRuntime(): void {
    promptDeliveryReferences = Math.max(0, promptDeliveryReferences - 1);
    if (promptDeliveryReferences > 0) {
      return;
    }

    stopCoordinatorPromptDeliveryLoop();
    coordinatorSchedulerCleanup?.();
  }

  if (coordinatorSchedulerCleanup !== null) {
    scheduleNextCoordinatorWorkflowExecution();
    return stopCoordinatorPromptDeliveryRuntime;
  }

  const cleanupCoordinatorEvents = subscribeCoordinatorEvents((event) => {
    if (
      event.eventType === 'run-upserted' ||
      event.eventType === 'run-meta-upserted' ||
      event.eventType === 'workflow-upserted'
    ) {
      scheduleNextCoordinatorWorkflowExecution();
    }
  });
  coordinatorSchedulerCleanup = () => {
    cleanupCoordinatorEvents();
    if (workflowExecutionTimer !== null) {
      clearTimeout(workflowExecutionTimer);
      workflowExecutionTimer = null;
    }
    promptDeliveryReferences = 0;
    workflowExecutionActive = false;
    workflowExecutionTimerDueAt = null;
    coordinatorSchedulerCleanup = null;
    coordinatorSchedulerContext = null;
    coordinatorSchedulerTaskNames = null;
  };
  scheduleNextCoordinatorWorkflowExecution();

  return stopCoordinatorPromptDeliveryRuntime;
}

export function resetCoordinatorToolGatewayForTests(): void {
  resetCoordinatorPromptDeliveryForTests();
  coordinatorSchedulerCleanup?.();
  coordinatorSchedulerCleanup = null;
  coordinatorSchedulerContext = null;
  coordinatorSchedulerTaskNames = null;
  promptDeliveryReferences = 0;
  if (workflowExecutionTimer !== null) {
    clearTimeout(workflowExecutionTimer);
    workflowExecutionTimer = null;
  }
  workflowExecutionActive = false;
  workflowExecutionTimerDueAt = null;
  activeSpawnSubtasksByDedupeKey.clear();
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

function getWorkflowLaneDedupeKey(
  lane: CoordinatorSpawnManyLanePayload,
  workflow: CoordinatorWorkflowSnapshot,
): string {
  return (
    lane.dedupeKey ??
    `${workflow.runId}:workflow:${workflow.template}:${workflow.title}:${lane.name}:${lane.assignment}`
  );
}

function toLaneSpawnPayload(
  lane: CoordinatorSpawnManyLanePayload,
  workflow: CoordinatorWorkflowSnapshot,
): CoordinatorSpawnSubtaskPayload {
  return {
    agent: lane.agent ?? { command: DEFAULT_WORKFLOW_AGENT_COMMAND },
    assignment: lane.assignment,
    dedupeKey: getWorkflowLaneDedupeKey(lane, workflow),
    name: lane.name,
  };
}

function getWorkflowStageTimeoutMs(workflow: CoordinatorWorkflowSnapshot, stageId: string): number {
  return (
    workflow.sourceSpec?.steps.find((step) => step.id === stageId)?.policy?.timeoutMs ??
    workflow.policy.timeoutMs
  );
}

function countNewWorkflowLanePayloads(
  workflow: CoordinatorWorkflowSnapshot,
  lanes: CoordinatorSpawnManyLanePayload[],
): number {
  const existingKeys = new Set(
    workflow.lanes.flatMap((lane) => (lane.dedupeKey !== undefined ? [lane.dedupeKey] : [])),
  );
  const newKeys = new Set<string>();
  for (const lane of lanes) {
    const dedupeKey = getWorkflowLaneDedupeKey(lane, workflow);
    if (!existingKeys.has(dedupeKey)) {
      newKeys.add(dedupeKey);
    }
  }

  return newKeys.size;
}

function mergeWorkflowPolicyPayload(
  policy: Partial<CoordinatorWorkflowPolicySnapshot> | undefined,
  laneCount: number,
): Partial<CoordinatorWorkflowPolicySnapshot> {
  return {
    maxConcurrentLanes: Math.max(DEFAULT_WORKFLOW_CONCURRENCY, laneCount),
    ...(policy ?? {}),
  };
}

function createWorkflowStageDefinitions(template: CoordinatorWorkflowTemplate): Array<{
  id: string;
  kind: CoordinatorWorkflowSnapshot['stages'][number]['kind'];
  name: string;
  dependsOn?: string[];
}> {
  switch (template) {
    case 'adversarial_review':
      return [
        { id: 'find', kind: 'find', name: 'Find' },
        { id: 'verify', kind: 'verify', name: 'Verify', dependsOn: ['find'] },
        { id: 'judge', kind: 'judge', name: 'Judge', dependsOn: ['verify'] },
        { id: 'synthesize', kind: 'synthesize', name: 'Synthesize', dependsOn: ['judge'] },
      ];
    case 'map_reduce':
      return [
        { id: 'map', kind: 'map', name: 'Map' },
        { id: 'reduce', kind: 'reduce', name: 'Reduce', dependsOn: ['map'] },
      ];
    case 'repo_review':
      return [
        { id: 'scan', kind: 'find', name: 'Scan' },
        { id: 'verify', kind: 'verify', name: 'Verify', dependsOn: ['scan'] },
        { id: 'decide', kind: 'decision', name: 'Decide', dependsOn: ['verify'] },
        { id: 'synthesize', kind: 'synthesize', name: 'Synthesize', dependsOn: ['decide'] },
      ];
    case 'custom':
      return [{ id: 'fan-out', kind: 'fan-out', name: 'Fan-out' }];
  }
}

function buildLaneAssignment(
  workflow: CoordinatorWorkflowSnapshot,
  lane: Pick<CoordinatorStartWorkflowLanePayload, 'assignment' | 'name' | 'role'>,
  problem: string,
): string {
  const body = lane.assignment ?? problem;
  return [
    `Workflow: ${workflow.title}`,
    lane.role !== undefined ? `Role: ${lane.role}` : `Lane: ${lane.name}`,
    body,
    '',
    'When finished, call submit_result with summary, findings, evidence, commandsRun, risks, and confidence.',
  ].join('\n');
}

function trimWorkflowAssignment(text: string): string {
  if (text.length <= COORDINATOR_LIMITS.assignmentTextMaxChars) {
    return text;
  }

  return `${text.slice(0, COORDINATOR_LIMITS.assignmentTextMaxChars - 32)}\n[truncated]`;
}

async function spawnWorkflowLane(
  gateway: CoordinatorToolGatewayContext,
  envelope: CoordinatorToolInvocation,
  workflow: CoordinatorWorkflowSnapshot,
  stageId: string,
  lanePayload: CoordinatorSpawnManyLanePayload,
): Promise<WorkflowSpawnedLane> {
  const laneDedupeKey = getWorkflowLaneDedupeKey(lanePayload, workflow);
  const existingLane = getCoordinatorWorkflow(workflow.runId, workflow.id)?.lanes.find(
    (candidate) => candidate.dedupeKey === laneDedupeKey,
  );
  if (existingLane) {
    const existingSubtask =
      existingLane.taskId !== undefined
        ? getCoordinatorRun(workflow.runId)?.subtasks.find(
            (subtask) => subtask.taskId === existingLane.taskId,
          )
        : undefined;
    return {
      ...(existingLane.failure !== undefined ? { error: existingLane.failure } : {}),
      laneId: existingLane.id,
      ...(existingSubtask !== undefined ? { subtask: existingSubtask } : {}),
    };
  }

  const lane = addCoordinatorWorkflowLane({
    assignment: lanePayload.assignment,
    ...(lanePayload.attempt !== undefined ? { attempt: lanePayload.attempt } : {}),
    dedupeKey: laneDedupeKey,
    name: lanePayload.name,
    ...(lanePayload.role !== undefined ? { role: lanePayload.role } : {}),
    runId: workflow.runId,
    spawnedBy: lanePayload.spawnedBy ?? 'scheduler',
    stageId,
    status: 'spawning',
    timeoutAt: Date.now() + getWorkflowStageTimeoutMs(workflow, stageId),
    workflowId: workflow.id,
  });
  updateCoordinatorWorkflowStage(workflow.runId, workflow.id, stageId, {
    startedAt: Date.now(),
    status: 'running',
  });
  appendCoordinatorWorkflowJournal(workflow.runId, workflow.id, {
    kind: 'lane-spawning',
    laneId: lane.id,
    message: `Spawning lane ${lanePayload.name}.`,
    stageId,
  });

  try {
    const subtask = await createHiddenSubtask(
      gateway,
      envelope,
      toLaneSpawnPayload(lanePayload, workflow),
    );
    if (isCoordinatorTerminalSubtaskStatus(subtask.status)) {
      const failure = subtask.result ?? `Lane subtask ended with status ${subtask.status}.`;
      updateCoordinatorWorkflowLane(workflow.runId, workflow.id, lane.id, {
        agentId: subtask.agentId,
        completedAt: Date.now(),
        failure,
        status: 'failed',
        taskId: subtask.taskId,
      });
      appendCoordinatorWorkflowJournal(workflow.runId, workflow.id, {
        kind: 'lane-spawn-failed',
        laneId: lane.id,
        message: failure,
        stageId,
      });
      return { error: failure, laneId: lane.id, subtask };
    }

    updateCoordinatorWorkflowLane(workflow.runId, workflow.id, lane.id, {
      agentId: subtask.agentId,
      startedAt: Date.now(),
      status: 'waiting-for-result',
      taskId: subtask.taskId,
    });
    updateCoordinatorWorkflowStage(workflow.runId, workflow.id, stageId, {
      status: 'waiting-for-results',
    });
    appendCoordinatorWorkflowJournal(workflow.runId, workflow.id, {
      kind: 'lane-running',
      laneId: lane.id,
      message: `Lane ${lanePayload.name} is running.`,
      stageId,
    });
    return { laneId: lane.id, subtask };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    updateCoordinatorWorkflowLane(workflow.runId, workflow.id, lane.id, {
      completedAt: Date.now(),
      failure,
      status: 'failed',
    });
    appendCoordinatorWorkflowJournal(workflow.runId, workflow.id, {
      kind: 'lane-spawn-failed',
      laneId: lane.id,
      message: failure,
      stageId,
    });
    return { error: failure, laneId: lane.id };
  }
}

async function spawnCoordinatorLanes(
  gateway: CoordinatorToolGatewayContext,
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorSpawnManyPayload,
): Promise<{
  lanes: WorkflowSpawnedLane[];
  workflow: CoordinatorWorkflowSnapshot;
}> {
  assertCoordinatorTaskCaller(envelope);
  const policy = mergeWorkflowPolicyPayload(payload.policy, payload.lanes.length);
  const maxConcurrentLanes =
    policy.maxConcurrentLanes ?? COORDINATOR_LIMITS.maxActiveSubtasksPerRun;
  if (payload.lanes.length > maxConcurrentLanes) {
    throw new BadRequestError('spawn_many exceeds workflow maxConcurrentLanes');
  }
  const existingWorkflow =
    payload.workflowId !== undefined
      ? getCoordinatorWorkflow(envelope.runId, payload.workflowId)
      : null;
  if (payload.workflowId !== undefined && existingWorkflow === null) {
    throw new BadRequestError('Coordinator workflow not found');
  }
  if (existingWorkflow !== null && existingWorkflow.template !== 'custom') {
    throw new BadRequestError('spawn_many can only extend custom workflows');
  }
  const workflow =
    existingWorkflow ??
    createCoordinatorWorkflow({
      policy,
      runId: envelope.runId,
      stages: createWorkflowStageDefinitions('custom'),
      template: 'custom',
      title: payload.title ?? 'Fan-out',
    });
  const stage = workflow.stages[0];
  if (!stage) {
    throw new BadRequestError('Coordinator workflow has no stage for fan-out');
  }
  const lanesToSpawn = payload.lanes.map((lane) => ({
    ...lane,
    assignment: trimWorkflowAssignment(buildLaneAssignment(workflow, lane, lane.assignment)),
  }));
  const newLaneCount = countNewWorkflowLanePayloads(workflow, lanesToSpawn);
  assertWorkflowWithinDeadline(workflow, Date.now());
  assertWorkflowBudgetAdmits(workflow, { addedLanes: newLaneCount, label: 'spawn_many' });
  const activeLaneCount = workflow.lanes.filter(
    (lane) => !isCoordinatorTerminalWorkflowLaneStatus(lane.status),
  ).length;
  if (activeLaneCount + newLaneCount > workflow.policy.maxConcurrentLanes) {
    throw new BadRequestError('spawn_many exceeds workflow maxConcurrentLanes');
  }

  const lanes: WorkflowSpawnedLane[] = [];
  const failedLaneIds: string[] = [];
  for (const lane of lanesToSpawn) {
    const spawnedLane = await spawnWorkflowLane(gateway, envelope, workflow, stage.id, lane);
    lanes.push(spawnedLane);
    if (spawnedLane.error !== undefined) {
      failedLaneIds.push(spawnedLane.laneId);
      if (!workflow.policy.continueOnFailure) {
        break;
      }
    }
  }
  const failedLaneId = failedLaneIds[failedLaneIds.length - 1];
  if (failedLaneId !== undefined) {
    await advanceCoordinatorWorkflowExecution({
      laneId: failedLaneId,
      runId: envelope.runId,
      spawnLane: (currentWorkflow, stageId, lanePayload) =>
        spawnWorkflowLane(gateway, envelope, currentWorkflow, stageId, lanePayload),
      workflowId: workflow.id,
    });
  }

  return {
    lanes,
    workflow: getCoordinatorWorkflow(envelope.runId, workflow.id) ?? workflow,
  };
}

async function startCoordinatorWorkflow(
  gateway: CoordinatorToolGatewayContext,
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorStartWorkflowPayload,
): Promise<{
  lanes: WorkflowSpawnedLane[];
  workflow: CoordinatorWorkflowSnapshot;
}> {
  assertCoordinatorTaskCaller(envelope);
  return startCoordinatorWorkflowExecution({
    ...(payload.agent !== undefined ? { agent: payload.agent } : {}),
    ...(payload.lanes !== undefined ? { lanes: payload.lanes } : {}),
    ...(payload.policy !== undefined ? { policy: payload.policy } : {}),
    problem: payload.problem,
    runId: envelope.runId,
    spawnLane: (workflow, stageId, lanePayload) =>
      spawnWorkflowLane(gateway, envelope, workflow, stageId, lanePayload),
    ...(payload.spec !== undefined ? { spec: payload.spec } : {}),
    template: payload.template,
    ...(payload.title !== undefined ? { title: payload.title } : {}),
  });
}

function resolveWorkflowAppendCaller(
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorAppendWorkflowStepsPayload,
): {
  run: CoordinatorRunSnapshot;
  sourceLaneId?: string;
  sourceTaskId: string;
  workflow: CoordinatorWorkflowSnapshot;
} {
  const run = requireCoordinatorRun(envelope.runId);
  if (run.status !== 'running') {
    throw new BadRequestError(`Coordinator run is ${run.status}`);
  }
  if (envelope.taskId === run.coordinatorTaskId) {
    const workflow = getCoordinatorWorkflow(run.id, payload.workflowId);
    if (!workflow) {
      throw new BadRequestError('Coordinator workflow not found');
    }

    return {
      run,
      sourceTaskId: envelope.taskId,
      workflow,
    };
  }

  const subtask = assertCoordinatorSubtaskCaller(envelope);
  const { lane, workflow } = resolveExecutorOwnedWorkflowLane(
    run.id,
    subtask.taskId,
    payload.workflowId,
    payload.laneId,
    {
      actionName: 'append_workflow_steps',
      requireActiveLane: true,
    },
  );

  return {
    run,
    sourceLaneId: lane.id,
    sourceTaskId: subtask.taskId,
    workflow,
  };
}

async function appendCoordinatorWorkflowStepsFromTool(
  gateway: CoordinatorToolGatewayContext,
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorAppendWorkflowStepsPayload,
): Promise<AppendCoordinatorWorkflowStepsExecutionResult> {
  const caller = resolveWorkflowAppendCaller(envelope, payload);
  return appendCoordinatorWorkflowExecutionSteps({
    appendId: payload.appendId,
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    runId: caller.run.id,
    ...(caller.sourceLaneId !== undefined ? { sourceLaneId: caller.sourceLaneId } : {}),
    sourceTaskId: caller.sourceTaskId,
    spawnLane: (workflow, stageId, lanePayload) =>
      spawnWorkflowLane(
        gateway,
        {
          ...envelope,
          taskId: caller.run.coordinatorTaskId,
        },
        workflow,
        stageId,
        lanePayload,
      ),
    steps: payload.steps,
    workflowId: caller.workflow.id,
  });
}

function getSubtaskStatusForResult(
  status: CoordinatorWorkflowResultStatus,
): CoordinatorSubtaskSnapshot['status'] {
  switch (status) {
    case 'completed':
      return 'ready-for-review';
    case 'blocked':
    case 'needs-followup':
      return 'waiting-for-coordinator';
    case 'failed':
      return 'failed';
  }
}

async function submitCoordinatorWorkflowResult(
  gateway: CoordinatorToolGatewayContext,
  envelope: CoordinatorToolInvocation,
  payload: CoordinatorSubmitResultPayload,
): Promise<{
  result: CoordinatorWorkflowResultSnapshot;
  workflow: CoordinatorWorkflowSnapshot;
}> {
  const subtask = assertCoordinatorSubtaskCaller(envelope);
  const run = requireCoordinatorRun(envelope.runId);
  const { lane, workflow } = resolveExecutorOwnedWorkflowLane(
    run.id,
    subtask.taskId,
    payload.workflowId,
    payload.laneId,
    {
      actionName: 'submit_result',
    },
  );
  if (isCoordinatorTerminalWorkflowLaneStatus(lane.status) && lane.resultId !== undefined) {
    throw new BadRequestError('workflow lane already has a terminal result');
  }
  if (hasPendingWorkflowApprovalForLane(workflow, lane.id)) {
    throw new BadRequestError('workflow lane already has a result pending approval');
  }
  if (workflow.results.length >= COORDINATOR_LIMITS.maxWorkflowResults) {
    throw new BadRequestError('Coordinator workflow result limit reached');
  }
  const workflowActions = readWorkflowDecisionActions(workflow, lane, payload.metadata);
  const resultStatus = getWorkflowResultStatusForActions(workflowActions, payload.status);
  const requiresApproval =
    workflow.policy.requireDecisionApproval === true && workflowActions.length > 0;

  const now = Date.now();
  const resultId = randomUUID();
  validateWorkflowDecisionActionsForResult(workflow, lane, resultId, workflowActions);
  const result = addCoordinatorWorkflowResult({
    result: {
      agentId: subtask.agentId,
      commandsRun: payload.commandsRun ?? [],
      ...(payload.confidence !== undefined ? { confidence: payload.confidence } : {}),
      evidence: payload.evidence ?? [],
      findings: normalizeWorkflowFindingsForResult(
        {
          id: resultId,
          laneId: lane.id,
          stageId: lane.stageId,
        },
        payload.findings ?? [],
      ),
      id: resultId,
      laneId: lane.id,
      ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
      risks: payload.risks ?? [],
      stageId: lane.stageId,
      status: resultStatus,
      summary: payload.summary,
      taskId: subtask.taskId,
      workflowId: workflow.id,
    },
    runId: run.id,
    workflowId: workflow.id,
    now,
  });
  if (!requiresApproval) {
    updateCoordinatorWorkflowLane(run.id, workflow.id, lane.id, {
      completedAt: now,
      resultId: result.id,
      status: getWorkflowLaneStatusForResultStatus(result.status),
    });
  }
  appendCoordinatorWorkflowJournal(run.id, workflow.id, {
    kind: 'lane-result',
    laneId: lane.id,
    message: result.summary,
    resultId: result.id,
    stageId: lane.stageId,
  });
  if (requiresApproval) {
    recordPendingWorkflowApproval({
      actions: workflowActions,
      laneId: lane.id,
      resultId: result.id,
      runId: run.id,
      stageId: lane.stageId,
      workflowId: workflow.id,
    });
  }
  updateCoordinatorSubtaskStatus(run.id, subtask.taskId, getSubtaskStatusForResult(result.status), {
    result: result.summary,
  });
  recordWorkflowVerdictsFromResult(run.id, workflow.id, result);

  return {
    result,
    workflow: await advanceCoordinatorWorkflowExecution({
      laneId: lane.id,
      result,
      runId: run.id,
      sourceTaskId: subtask.taskId,
      spawnLane: (currentWorkflow, stageId, lanePayload) =>
        spawnWorkflowLane(
          gateway,
          {
            ...envelope,
            taskId: run.coordinatorTaskId,
          },
          currentWorkflow,
          stageId,
          lanePayload,
        ),
      ...(requiresApproval ? {} : { workflowActions }),
      workflowId: workflow.id,
    }),
  };
}

interface CoordinatorSubtaskAgentLaunchOptions {
  agent: CoordinatorSpawnSubtaskPayload['agent'];
  agentId: string;
  assignment: string;
  branchName: string;
  name: string;
  onTaskRegistered?: () => void;
  run: Pick<CoordinatorRunSnapshot, 'id' | 'projectMode'>;
  taskId: string;
  taskMetadata: ReturnType<typeof getCreatedTaskMetadata>;
  worktreePath: string;
}

/**
 * Shared subtask-agent launch path for first spawns and respawns: task-name registration,
 * credential creation, seeded/merged launch args, PARALLEL_CODE_* env, and the agent spawn itself.
 * Per-path work (dedupe registration, credential rotation, prompt queueing) stays at the call
 * sites; `spawnAgent` is deferred so callers can record run state between credential creation and
 * the spawn.
 */
function prepareCoordinatorSubtaskAgentLaunch(
  gateway: CoordinatorToolGatewayContext,
  options: CoordinatorSubtaskAgentLaunchOptions,
): {
  credential: ReturnType<typeof createCoordinatorCredential>;
  spawnAgent: () => void;
  usesSeededStartup: boolean;
} {
  gateway.taskNames.registerCreatedTask(options.taskId, {
    agentDefId: `coordinator-custom:${options.agent.command}`,
    agentDefName: options.agent.name ?? options.agent.command,
    branchName: options.branchName,
    gitIsolation: options.taskMetadata.gitIsolation,
    projectMode: options.taskMetadata.projectMode,
    taskName: options.name,
    worktreePath: options.worktreePath,
    worktreeOwnership: options.taskMetadata.worktreeOwnership,
  });
  options.onTaskRegistered?.();

  const credential = createCoordinatorCredential(gateway.context, {
    agentId: options.agentId,
    runId: options.run.id,
    taskId: options.taskId,
    ...(gateway.context.coordinatorToolCallUrl !== undefined
      ? { toolCallUrl: gateway.context.coordinatorToolCallUrl }
      : {}),
  });
  const usesSeededStartup = usesSeededInitialAssignment(options.agent);
  const launchArgs = usesSeededStartup
    ? buildCoordinatorSeededLaunchArgs(options.agent, options.assignment, credential.toolCommand)
    : mergeLaunchArgs(options.agent.args, options.agent.skipPermissionsArgs);
  const env = {
    ...(options.agent.env ?? {}),
    PARALLEL_CODE_COORDINATOR_CREDENTIAL: credential.credentialPath,
    PARALLEL_CODE_COORDINATOR_RUN_ID: options.run.id,
    ...(credential.toolCommand !== undefined
      ? { PARALLEL_CODE_COORDINATOR_TOOL: credential.toolCommand }
      : {}),
  };
  const runnerProfile = normalizeAgentRunnerProfileConfig(undefined);
  const spawnAgent = (): void => {
    spawnTaskAgentWorkflow(gateway.context, {
      agentId: options.agentId,
      args: launchArgs,
      command: options.agent.command,
      cols: DEFAULT_TERMINAL_COLS,
      cwd: options.worktreePath,
      env,
      isShell: false,
      projectMode: options.run.projectMode,
      rows: DEFAULT_TERMINAL_ROWS,
      taskId: options.taskId,
      ...(runnerProfile !== undefined ? { runnerProfile } : {}),
    });
  };

  return { credential, spawnAgent, usesSeededStartup };
}

async function createHiddenSubtaskAfterDedupe(
  gateway: CoordinatorToolGatewayContext,
  payload: CoordinatorSpawnSubtaskPayload,
  run: CoordinatorRunSnapshot,
  dedupeKey: string,
): Promise<CoordinatorSubtaskSnapshot> {
  assertSupportedSeededInitialAssignment(payload.agent);
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
    const { credential, spawnAgent, usesSeededStartup } = prepareCoordinatorSubtaskAgentLaunch(
      gateway,
      {
        agent: payload.agent,
        agentId,
        assignment: payload.assignment,
        branchName: result.branch_name,
        name: payload.name,
        onTaskRegistered: () => {
          taskRegistryUpdated = true;
        },
        run,
        taskId: result.id,
        taskMetadata,
        worktreePath: result.worktree_path,
      },
    );
    recordCoordinatorSubtaskLaunch({
      agent: payload.agent,
      assignment: payload.assignment,
      ...(payload.baseBranch !== undefined ? { baseBranch: payload.baseBranch } : {}),
      ...(payload.branchPrefix !== undefined ? { branchPrefix: payload.branchPrefix } : {}),
      dedupeKey,
      name: payload.name,
      recordedAt: Date.now(),
      runId: run.id,
      taskId: result.id,
    });
    addCoordinatorSubtask({
      agentId,
      assignment: payload.assignment,
      branchName: result.branch_name,
      dedupeKey,
      parentCoordinatorTaskId: run.coordinatorTaskId,
      runId: run.id,
      startup: createCoordinatorSubtaskStartupSnapshot(
        payload.agent,
        usesSeededStartup ? 'seeded-at-spawn' : 'pending-prompt',
      ),
      status: 'spawning',
      taskId: result.id,
      toolTokenId: credential.tokenId,
      worktreePath: result.worktree_path,
    });

    spawnAgent();

    if (usesSeededStartup) {
      updateCoordinatorSubtaskStatus(run.id, result.id, 'running');
    } else {
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
    }
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
    removeCoordinatorSubtaskLaunch(run.id, result.id);
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

interface CoordinatorSubtaskRespawnOptions {
  launch: CoordinatorSubtaskLaunchSnapshot;
  resumeId: string;
  run: CoordinatorRunSnapshot;
  subtask: CoordinatorSubtaskSnapshot;
}

async function respawnCoordinatorSubtaskAgent(
  gateway: CoordinatorToolGatewayContext,
  options: CoordinatorSubtaskRespawnOptions,
): Promise<CoordinatorSubtaskSnapshot> {
  const { launch, resumeId, run, subtask } = options;
  assertSupportedSeededInitialAssignment(launch.agent);
  // Respawn rotates the task credential before the shared launch path mints a fresh one.
  revokeCoordinatorTaskCredential(gateway.context, subtask.taskId);
  const { credential, spawnAgent, usesSeededStartup } = prepareCoordinatorSubtaskAgentLaunch(
    gateway,
    {
      agent: launch.agent,
      agentId: subtask.agentId,
      assignment: launch.assignment,
      branchName: subtask.branchName ?? '',
      name: launch.name,
      run,
      taskId: subtask.taskId,
      taskMetadata: getCreatedTaskMetadata(
        { git_isolation: 'worktree' } as CreateTaskResult,
        run.projectMode,
      ),
      worktreePath: subtask.worktreePath,
    },
  );
  spawnAgent();

  const startup = getCoordinatorSubtaskStartupSnapshot(subtask.startup);
  if (usesSeededStartup) {
    return updateCoordinatorSubtaskStatus(run.id, subtask.taskId, 'running', {
      interruptedByRestoreAt: undefined,
      result: undefined,
      startup: {
        ...startup,
        initialAssignmentStatus: 'seeded-at-spawn',
        seededAt: Date.now(),
      },
      toolTokenId: credential.tokenId,
    });
  }

  // A readiness-gated respawn always needs a fresh initial assignment because any earlier prompt
  // targeted the pre-restore PTY that no longer exists.
  const updated = updateCoordinatorSubtaskStatus(
    run.id,
    subtask.taskId,
    'waiting-for-agent-ready',
    {
      interruptedByRestoreAt: undefined,
      result: undefined,
      startup: {
        ...startup,
        initialAssignmentStatus: 'pending-prompt',
      },
      toolTokenId: credential.tokenId,
    },
  );
  const currentRun = getCoordinatorRun(run.id);
  await queueCoordinatorPromptForDelivery(gateway.context, {
    dedupeKey: `resume:${resumeId}:${subtask.taskId}:initial`,
    kind: 'initial-assignment',
    run: currentRun ?? run,
    sourceTaskId: run.coordinatorTaskId,
    subtask: updated,
    text: buildCoordinatorSubtaskAssignment(launch.assignment, {
      ...(credential.toolCommand !== undefined ? { toolCommand: credential.toolCommand } : {}),
    }),
  });
  return (
    getCoordinatorRun(run.id)?.subtasks.find((candidate) => candidate.taskId === subtask.taskId) ??
    updated
  );
}

async function resumeCoordinatorRun(
  gateway: CoordinatorToolGatewayContext,
  request: Extract<CoordinatorUiToolCallRequest, { toolName: 'resume_run' }>,
): Promise<CoordinatorRunResumeResult> {
  const resumeId = request.requestId;
  const run = resumeCoordinatorRunFromStale(request.runId, { resumeId });
  const failed: CoordinatorRunResumeResult['failed'] = [];
  const respawned: string[] = [];
  const laneTaskIds = new Set(
    run.workflows.flatMap((workflow) =>
      workflow.lanes.flatMap((lane) => (lane.taskId !== undefined ? [lane.taskId] : [])),
    ),
  );

  for (const subtask of run.subtasks) {
    if (subtask.interruptedByRestoreAt === undefined || laneTaskIds.has(subtask.taskId)) {
      continue;
    }

    const launch = getCoordinatorSubtaskLaunch(run.id, subtask.taskId);
    if (launch === null) {
      const reason =
        'Coordinator subtask has no recorded launch payload, so it cannot be respawned.';
      updateCoordinatorSubtaskStatus(run.id, subtask.taskId, 'failed', {
        interruptedByRestoreAt: undefined,
        result: reason,
      });
      failed.push({ reason, taskId: subtask.taskId });
      continue;
    }

    try {
      await respawnCoordinatorSubtaskAgent(gateway, { launch, resumeId, run, subtask });
      respawned.push(subtask.taskId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      updateCoordinatorSubtaskStatus(run.id, subtask.taskId, 'failed', {
        interruptedByRestoreAt: undefined,
        result: reason,
      });
      failed.push({ reason, taskId: subtask.taskId });
    }
  }

  for (const workflow of run.workflows) {
    if (workflow.status !== 'stale-after-restore') {
      continue;
    }

    let workflowOutcome: Awaited<ReturnType<typeof resumeCoordinatorWorkflowExecution>>;
    try {
      workflowOutcome = await resumeCoordinatorWorkflowExecution({
        respawnLane: async (_workflow, lane) => {
          if (lane.taskId === undefined) {
            throw new Error('Workflow lane has no task to respawn.');
          }
          const currentRun = requireCoordinatorRun(run.id);
          const laneSubtask = currentRun.subtasks.find(
            (candidate) => candidate.taskId === lane.taskId,
          );
          if (!laneSubtask) {
            throw new Error(`Coordinator subtask not found for lane task ${lane.taskId}.`);
          }
          const launch = getCoordinatorSubtaskLaunch(run.id, lane.taskId);
          if (launch === null) {
            throw new Error(
              'Coordinator subtask has no recorded launch payload, so it cannot be respawned.',
            );
          }

          const subtask = await respawnCoordinatorSubtaskAgent(gateway, {
            launch,
            resumeId,
            run: currentRun,
            subtask: laneSubtask,
          });
          return { laneId: lane.id, subtask };
        },
        runId: run.id,
        spawnLane: (currentWorkflow, stageId, lanePayload) =>
          spawnWorkflowLane(
            gateway,
            {
              callId: `resume:${resumeId}:${currentWorkflow.id}`,
              runId: run.id,
              taskId: run.coordinatorTaskId,
              toolName: 'start_workflow',
            },
            currentWorkflow,
            stageId,
            lanePayload,
          ),
        workflowId: workflow.id,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({
        reason: `Coordinator workflow ${workflow.id} resume failed: ${reason}`,
      });
      continue;
    }
    respawned.push(...workflowOutcome.respawned);
    failed.push(...workflowOutcome.failed);
    for (const laneFailure of workflowOutcome.failed) {
      if (laneFailure.taskId === undefined) {
        continue;
      }
      const failedSubtask = getCoordinatorRun(run.id)?.subtasks.find(
        (candidate) => candidate.taskId === laneFailure.taskId,
      );
      if (failedSubtask?.interruptedByRestoreAt !== undefined) {
        updateCoordinatorSubtaskStatus(run.id, laneFailure.taskId, 'failed', {
          interruptedByRestoreAt: undefined,
          result: laneFailure.reason,
        });
      }
    }
  }

  const updatedRun = recordCoordinatorRunResumeOutcome(run.id, resumeId, {
    failedTaskIds: failed.flatMap((entry) => (entry.taskId !== undefined ? [entry.taskId] : [])),
    respawnedTaskIds: respawned,
  });
  scheduleCoordinatorPromptDelivery();
  scheduleNextCoordinatorWorkflowExecution();

  return {
    failed,
    respawned,
    resumeId,
    run: updatedRun,
  };
}

function isActiveCoordinatorWorkflowStatus(status: CoordinatorWorkflowSnapshot['status']): boolean {
  return !isCoordinatorTerminalWorkflowStatus(status);
}

function pauseCoordinatorRun(
  request: Extract<CoordinatorUiToolCallRequest, { toolName: 'pause_run' }>,
): CoordinatorRunSnapshot {
  const now = Date.now();
  const run = setCoordinatorRunPaused(request.runId, true, now);
  for (const workflow of run.workflows) {
    if (!isActiveCoordinatorWorkflowStatus(workflow.status)) {
      continue;
    }
    appendCoordinatorWorkflowJournal(run.id, workflow.id, {
      at: now,
      kind: 'run-paused',
      message: 'Operator paused the coordinator run; new work is deferred.',
    });
  }

  return getCoordinatorRun(request.runId) ?? run;
}

async function unpauseCoordinatorRun(
  gateway: CoordinatorToolGatewayContext,
  request: Extract<CoordinatorUiToolCallRequest, { toolName: 'unpause_run' }>,
): Promise<CoordinatorRunSnapshot> {
  const now = Date.now();
  const run = setCoordinatorRunPaused(request.runId, false, now);
  for (const workflow of run.workflows) {
    if (!isActiveCoordinatorWorkflowStatus(workflow.status)) {
      continue;
    }
    appendCoordinatorWorkflowJournal(run.id, workflow.id, {
      at: now,
      kind: 'run-unpaused',
      message: 'Operator unpaused the coordinator run; deferred work is admitted again.',
    });
    await tickCoordinatorWorkflowExecution({
      runId: run.id,
      spawnLane: (currentWorkflow, stageId, lanePayload) =>
        spawnWorkflowLane(
          gateway,
          {
            callId: `unpause:${request.requestId}:${currentWorkflow.id}`,
            runId: run.id,
            taskId: run.coordinatorTaskId,
            toolName: 'start_workflow',
          },
          currentWorkflow,
          stageId,
          lanePayload,
        ),
      workflowId: workflow.id,
    });
  }
  scheduleCoordinatorPromptDelivery(0, true);
  scheduleNextCoordinatorWorkflowExecution();

  return getCoordinatorRun(request.runId) ?? run;
}

function createOperatorWorkflowSpawnLane(
  gateway: CoordinatorToolGatewayContext,
  request: CoordinatorUiToolCallRequest,
): SpawnCoordinatorWorkflowLane {
  return (currentWorkflow, stageId, lanePayload) => {
    const run = requireCoordinatorRun(request.runId);
    return spawnWorkflowLane(
      gateway,
      {
        callId: `${request.toolName}:${request.requestId}:${currentWorkflow.id}`,
        runId: request.runId,
        taskId: run.coordinatorTaskId,
        toolName: 'start_workflow',
      },
      currentWorkflow,
      stageId,
      lanePayload,
    );
  };
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
  cancelCoordinatorWorkflowLanesForTask(run.id, subtask.taskId, 'subtask-cleaned-up');
  removeCoordinatorSubtaskLaunch(run.id, subtask.taskId);

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

  return queueCoordinatorPromptForDelivery(context, {
    ...(payload.dedupeKey !== undefined ? { dedupeKey: payload.dedupeKey } : {}),
    ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
    run,
    sourceTaskId: envelope.taskId,
    subtask,
    text: payload.text,
  });
}

function listCoordinatorTasks(envelope: CoordinatorToolInvocation): Array<{
  agentId: string;
  assignment: string;
  branchName?: string;
  followupPromptMode: CoordinatorSubtaskStartupSnapshot['followupPromptMode'];
  initialAssignmentMode: CoordinatorSubtaskStartupSnapshot['initialAssignmentMode'];
  initialAssignmentStatus: CoordinatorSubtaskStartupSnapshot['initialAssignmentStatus'];
  lastPromptRequestId?: string;
  pendingPromptStatus?: CoordinatorPromptRequestSnapshot['status'];
  pendingPromptWaitingReason?: string;
  readinessPolicy: CoordinatorSubtaskStartupSnapshot['readinessPolicy'];
  status: CoordinatorSubtaskSnapshot['status'];
  taskId: string;
  updatedAt: number;
  worktreePath: string;
}> {
  assertCoordinatorTaskCaller(envelope);
  const run = requireCoordinatorRun(envelope.runId);
  return run.subtasks.map((subtask) => {
    const startup = getCoordinatorSubtaskStartupSnapshot(subtask.startup);
    const pendingPrompt = run.promptQueue.find(
      (prompt) =>
        prompt.targetTaskId === subtask.taskId && isCoordinatorPendingPromptStatus(prompt.status),
    );
    return {
      agentId: subtask.agentId,
      assignment: subtask.assignment,
      ...(subtask.branchName !== undefined ? { branchName: subtask.branchName } : {}),
      followupPromptMode: startup.followupPromptMode,
      initialAssignmentMode: startup.initialAssignmentMode,
      initialAssignmentStatus: startup.initialAssignmentStatus,
      ...(subtask.lastPromptRequestId !== undefined
        ? { lastPromptRequestId: subtask.lastPromptRequestId }
        : {}),
      ...(pendingPrompt !== undefined ? { pendingPromptStatus: pendingPrompt.status } : {}),
      ...(pendingPrompt?.waitingReason !== undefined
        ? { pendingPromptWaitingReason: pendingPrompt.waitingReason }
        : {}),
      readinessPolicy: startup.readinessPolicy,
      status: subtask.status,
      taskId: subtask.taskId,
      updatedAt: subtask.updatedAt,
      worktreePath: subtask.worktreePath,
    };
  });
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
    removeCoordinatorSubtaskLaunch(run.id, subtask.taskId);
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
  if (run.status !== 'running' && run.status !== 'draining' && run.status !== 'paused-by-user') {
    throw new BadRequestError(`Coordinator run is ${run.status}`);
  }
  assertCoordinatorRunAdmitsAgentTool(run, envelope.toolName);
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

/**
 * Pause stops admission of NEW work on the agent tool path. In-flight lanes may still report
 * (`submit_result`, `signal_done`), land, and be inspected, but spawning, prompting, and graph
 * growth are rejected until the operator unpauses the run.
 */
const COORDINATOR_PAUSED_REJECTED_AGENT_TOOLS = new Set<CoordinatorToolCallEnvelope['toolName']>([
  'append_workflow_steps',
  'send_prompt',
  'spawn_many',
  'spawn_subtask',
  'start_workflow',
]);

function assertCoordinatorRunAdmitsAgentTool(
  run: Pick<CoordinatorRunSnapshot, 'status'>,
  toolName: CoordinatorToolCallEnvelope['toolName'],
): void {
  if (
    !coordinatorRunAdmitsNewWork(run.status) &&
    COORDINATOR_PAUSED_REJECTED_AGENT_TOOLS.has(toolName)
  ) {
    throw new BadRequestError('Coordinator run is paused-by-user');
  }
}

function assertCoordinatorRendererToolAllowed(
  toolName: CoordinatorToolInvocation['toolName'] | CoordinatorOperatorActionName,
): void {
  if (
    toolName === 'append_workflow_steps' ||
    toolName === 'land_self' ||
    toolName === 'signal_done' ||
    toolName === 'submit_result'
  ) {
    throw new BadRequestError(`Coordinator UI cannot call ${toolName}`);
  }
}

function assertRendererActionAuthorized(
  request: CoordinatorUiToolCallRequest,
  options: { replayOfRememberedResult?: boolean } = {},
): void {
  const run = getCoordinatorRun(request.runId);
  if (!run) {
    throw new BadRequestError('Coordinator run is no longer active');
  }
  if (run.coordinatorTaskId !== request.coordinatorTaskId) {
    throw new BadRequestError('coordinatorTaskId must own the coordinator run');
  }
  assertCoordinatorRendererToolAllowed(request.toolName);
  const allowedRunStatuses = getCoordinatorRendererActionAllowedRunStatuses(request.toolName);
  if (allowedRunStatuses === undefined) {
    return;
  }
  if (options.replayOfRememberedResult !== true && !allowedRunStatuses.includes(run.status)) {
    throw new BadRequestError(`Coordinator run is ${run.status}`);
  }
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
    case 'append_workflow_steps':
      result = await appendCoordinatorWorkflowStepsFromTool(
        gateway,
        invocation,
        readAppendWorkflowStepsPayload(invocation.payload),
      );
      break;
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
    case 'spawn_many':
      result = await spawnCoordinatorLanes(
        gateway,
        invocation,
        readSpawnManyPayload(invocation.payload),
      );
      break;
    case 'start_workflow':
      result = await startCoordinatorWorkflow(
        gateway,
        invocation,
        readStartWorkflowPayload(invocation.payload),
      );
      break;
    case 'submit_result':
      result = await submitCoordinatorWorkflowResult(
        gateway,
        invocation,
        readSubmitResultPayload(invocation.payload),
      );
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

function isCoordinatorOperatorActionRequest(
  request: CoordinatorUiToolCallRequest,
): request is Extract<CoordinatorUiToolCallRequest, { toolName: CoordinatorOperatorActionName }> {
  return isCoordinatorOperatorActionName(request.toolName);
}

async function dispatchCoordinatorOperatorAction(
  gateway: CoordinatorToolGatewayContext,
  request: Extract<CoordinatorUiToolCallRequest, { toolName: CoordinatorOperatorActionName }>,
): Promise<unknown> {
  switch (request.toolName) {
    case 'approve_workflow_actions': {
      const payload = readApproveWorkflowActionsPayload(request.payload);
      return approveCoordinatorWorkflowActions({
        approvalId: payload.approvalId,
        runId: request.runId,
        spawnLane: createOperatorWorkflowSpawnLane(gateway, request),
        workflowId: payload.workflowId,
      });
    }
    case 'deny_workflow_actions': {
      const payload = readDenyWorkflowActionsPayload(request.payload);
      return denyCoordinatorWorkflowActions({
        approvalId: payload.approvalId,
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        runId: request.runId,
        spawnLane: createOperatorWorkflowSpawnLane(gateway, request),
        workflowId: payload.workflowId,
      });
    }
    case 'pause_run':
      return pauseCoordinatorRun(request);
    case 'resume_run':
      return resumeCoordinatorRun(gateway, request);
    case 'retry_lane': {
      const payload = readRetryLanePayload(request.payload);
      return retryCoordinatorWorkflowLaneFromOperator({
        laneId: payload.laneId,
        runId: request.runId,
        spawnLane: createOperatorWorkflowSpawnLane(gateway, request),
        workflowId: payload.workflowId,
      });
    }
    case 'unpause_run':
      return unpauseCoordinatorRun(gateway, request);
  }
}

export async function executeCoordinatorRendererAction(
  gateway: CoordinatorToolGatewayContext,
  request: CoordinatorUiToolCallRequest,
): Promise<CoordinatorToolCallResult> {
  assertString(request.requestId, 'requestId');
  assertString(request.runId, 'runId');
  assertString(request.coordinatorTaskId, 'coordinatorTaskId');
  const toolCallKey = `renderer:${request.runId}:${request.coordinatorTaskId}:${request.requestId}`;
  const previousResult = getCoordinatorToolResult(toolCallKey);
  assertRendererActionAuthorized(request, {
    replayOfRememberedResult: previousResult !== undefined,
  });
  if (previousResult !== undefined) {
    return previousResult as CoordinatorToolCallResult;
  }

  const result = isCoordinatorOperatorActionRequest(request)
    ? await dispatchCoordinatorOperatorAction(gateway, request)
    : await dispatchCoordinatorToolInvocation(gateway, {
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
