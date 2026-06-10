import { randomUUID } from 'node:crypto';

import {
  COORDINATOR_LIMITS,
  COORDINATOR_WORKFLOW_PROGRAM_VERSION,
  createCoordinatorWorkflowBudgetSnapshot,
  getCoordinatorSubtaskStartupSnapshot,
  isCoordinatorPendingPromptStatus,
  isCoordinatorTerminalWorkflowLaneStatus,
  type CoordinatorBootstrapSnapshot,
  type CoordinatorDiagnosticsSnapshot,
  type CoordinatorEventEnvelope,
  type CoordinatorEventType,
  type CoordinatorLandingStateSnapshot,
  type CoordinatorPromptKind,
  type CoordinatorPromptRequestSnapshot,
  type CoordinatorPromptStatus,
  type CoordinatorRunLimits,
  type CoordinatorRunResumeSnapshot,
  type CoordinatorRunSnapshot,
  type CoordinatorRunStatus,
  type CoordinatorSubtaskLaunchSnapshot,
  type CoordinatorSubtaskSnapshot,
  type CoordinatorSubtaskStartupSnapshot,
  type CoordinatorSubtaskStatus,
  type CoordinatorWorkflowJournalEntrySnapshot,
  type CoordinatorWorkflowLaneSnapshot,
  type CoordinatorWorkflowPendingApprovalSnapshot,
  type CoordinatorWorkflowLaneSpawnSource,
  type CoordinatorWorkflowLaneStatus,
  type CoordinatorWorkflowAppendPolicySnapshot,
  type CoordinatorWorkflowPolicySnapshot,
  type CoordinatorWorkflowResultSnapshot,
  type CoordinatorWorkflowStageKind,
  type CoordinatorWorkflowStageSnapshot,
  type CoordinatorWorkflowStageStatus,
  type CoordinatorWorkflowStatus,
  type CoordinatorWorkflowStepAppendSnapshot,
  type CoordinatorWorkflowTemplate,
  type CoordinatorWorkflowSnapshot,
} from '../../src/domain/coordinator.js';
import type { CoordinatorWorkflowSpecSnapshot } from '../../src/domain/coordinator-workflow-spec.js';
import type { ProjectMode } from '../../src/store/types.js';

export interface CoordinatorRuntimeState {
  runs: CoordinatorRunSnapshot[];
  stateVersion: number;
  subtaskLaunches: CoordinatorSubtaskLaunchSnapshot[];
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
  workflowsById: Map<string, CoordinatorWorkflowSnapshot>;
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
  startup?: CoordinatorSubtaskStartupSnapshot;
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

interface UpdateCoordinatorSubtaskPatch {
  interruptedByRestoreAt?: number | undefined;
  now?: number;
  result?: string | undefined;
  startup?: CoordinatorSubtaskStartupSnapshot;
  toolTokenId?: string;
}

interface ResumeCoordinatorRunFromStaleOptions {
  now?: number;
  resumeId: string;
}

interface CoordinatorRunResumeOutcome {
  failedTaskIds: string[];
  respawnedTaskIds: string[];
}

interface CreateCoordinatorWorkflowOptions {
  appendPolicy?: Partial<CoordinatorWorkflowAppendPolicySnapshot>;
  execution?: CoordinatorWorkflowSnapshot['execution'];
  policy?: Partial<CoordinatorWorkflowPolicySnapshot>;
  runId: string;
  sourceSpec?: CoordinatorWorkflowSpecSnapshot;
  stages: Array<{
    dependsOn?: string[];
    id?: string;
    kind: CoordinatorWorkflowStageKind;
    name: string;
    status?: CoordinatorWorkflowStageStatus;
  }>;
  status?: CoordinatorWorkflowStatus;
  template: CoordinatorWorkflowTemplate;
  title: string;
  verdicts?: CoordinatorWorkflowSnapshot['verdicts'];
  now?: number;
}

interface AppendCoordinatorWorkflowStepsOptions {
  append: CoordinatorWorkflowStepAppendSnapshot;
  runId: string;
  sourceSpec: CoordinatorWorkflowSpecSnapshot;
  stages: Array<{
    dependsOn?: string[];
    id: string;
    kind: CoordinatorWorkflowStageKind;
    name: string;
  }>;
  workflowId: string;
  now?: number;
}

interface AddCoordinatorWorkflowLaneOptions {
  assignment: string;
  attempt?: number;
  dedupeKey?: string;
  id?: string;
  name: string;
  role?: string;
  runId: string;
  spawnedBy?: CoordinatorWorkflowLaneSpawnSource;
  stageId: string;
  status?: CoordinatorWorkflowLaneStatus;
  taskId?: string;
  agentId?: string;
  timeoutAt?: number;
  workflowId: string;
  now?: number;
}

interface UpdateCoordinatorWorkflowLanePatch {
  agentId?: string;
  completedAt?: number;
  failure?: string | undefined;
  resultId?: string;
  startedAt?: number;
  status?: CoordinatorWorkflowLaneStatus;
  supersededByLaneId?: string;
  taskId?: string;
  timeoutAt?: number | undefined;
  now?: number;
}

interface AddCoordinatorWorkflowPendingApprovalOptions {
  actions: CoordinatorWorkflowPendingApprovalSnapshot['actions'];
  id: string;
  laneId: string;
  resultId: string;
  runId: string;
  stageId: string;
  workflowId: string;
  now?: number;
}

interface ResolveCoordinatorWorkflowPendingApprovalOptions {
  now?: number;
  reason?: string;
}

interface UpdateCoordinatorWorkflowStagePatch {
  completedAt?: number;
  failure?: string | undefined;
  laneIds?: string[];
  resultIds?: string[];
  startedAt?: number;
  status?: CoordinatorWorkflowStageStatus;
  now?: number;
}

interface UpdateCoordinatorWorkflowPatch {
  appendPolicy?: CoordinatorWorkflowSnapshot['appendPolicy'];
  completedAt?: number;
  execution?: CoordinatorWorkflowSnapshot['execution'];
  expansions?: CoordinatorWorkflowSnapshot['expansions'];
  status?: CoordinatorWorkflowStatus;
  verdicts?: CoordinatorWorkflowSnapshot['verdicts'];
  now?: number;
}

interface AddCoordinatorWorkflowResultOptions {
  result: Omit<CoordinatorWorkflowResultSnapshot, 'createdAt' | 'id' | 'runId'> & {
    createdAt?: number;
    id?: string;
  };
  runId: string;
  workflowId: string;
  now?: number;
}

const DEFAULT_RUN_LIMITS: CoordinatorRunLimits = {
  maxActiveSubtasks: COORDINATOR_LIMITS.maxActiveSubtasksPerRun,
  maxPendingPromptsPerTarget: COORDINATOR_LIMITS.maxPendingPromptsPerTarget,
  maxQueuedSubtasks: COORDINATOR_LIMITS.maxQueuedSubtasksPerRun,
};

const DEFAULT_WORKFLOW_POLICY: CoordinatorWorkflowPolicySnapshot = {
  continueOnFailure: true,
  maxConcurrentLanes: COORDINATOR_LIMITS.maxActiveSubtasksPerRun,
  maxIterationsPerBranch: 3,
  maxOutputBytesPerLane: COORDINATOR_LIMITS.snapshotMaxBytes,
  maxTotalLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
  maxTotalRetries: COORDINATOR_LIMITS.maxWorkflowTotalRetries,
  maxTotalSteps: COORDINATOR_LIMITS.maxWorkflowTotalSteps,
  maxWallClockMs: COORDINATOR_LIMITS.workflowDefaultWallClockMs,
  resultRequired: true,
  retryBackoffMs: 1_000,
  retryCount: 0,
  timeoutMs: COORDINATOR_LIMITS.workflowDefaultLaneTimeoutMs,
};

const DEFAULT_WORKFLOW_APPEND_POLICY: CoordinatorWorkflowAppendPolicySnapshot = {
  maxActionsPerDecision: COORDINATOR_LIMITS.maxWorkflowDecisionActionsPerResult,
  maxStepAppends: COORDINATOR_LIMITS.maxWorkflowStepAppends,
};

let recordsByRunId = new Map<string, RunRecord>();
const launchesByRunAndTask = new Map<string, CoordinatorSubtaskLaunchSnapshot>();
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
    run: {
      ...run,
      workflows: run.workflows ?? [],
    },
    landingByTaskId: new Map(run.landing.map((landing) => [landing.taskId, landing])),
    promptsByRequestId: new Map(run.promptQueue.map((prompt) => [prompt.requestId, prompt])),
    subtasksByTaskId: new Map(run.subtasks.map((subtask) => [subtask.taskId, subtask])),
    workflowsById: new Map((run.workflows ?? []).map((workflow) => [workflow.id, workflow])),
  };
}

function materializeRun(record: RunRecord): CoordinatorRunSnapshot {
  return {
    ...record.run,
    landing: [...record.landingByTaskId.values()],
    promptQueue: [...record.promptsByRequestId.values()],
    subtasks: [...record.subtasksByTaskId.values()],
    workflows: [...record.workflowsById.values()],
  };
}

function replaceRun(record: RunRecord, run: CoordinatorRunSnapshot): void {
  record.run = {
    ...run,
    landing: [...record.landingByTaskId.values()],
    promptQueue: [...record.promptsByRequestId.values()],
    subtasks: [...record.subtasksByTaskId.values()],
    workflows: [...record.workflowsById.values()],
  };
}

function createLegacyPromptStartupSnapshot(
  initialAssignmentStatus: CoordinatorSubtaskStartupSnapshot['initialAssignmentStatus'],
  deliveredAt?: number,
): CoordinatorSubtaskStartupSnapshot {
  return {
    followupPromptMode: 'post-ready-prompt',
    initialAssignmentMode: 'post-ready-prompt',
    initialAssignmentStatus,
    readinessPolicy: 'terminal-generic',
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
  };
}

function getLegacySubtaskInitialAssignmentStatus(
  subtask: CoordinatorSubtaskSnapshot,
): CoordinatorSubtaskStartupSnapshot['initialAssignmentStatus'] {
  if (subtask.status === 'waiting-for-agent-ready') {
    return 'pending-prompt';
  }

  return 'delivered';
}

function createLegacySubtaskStartupSnapshot(
  subtask: CoordinatorSubtaskSnapshot,
  prompts: readonly CoordinatorPromptRequestSnapshot[],
): CoordinatorSubtaskStartupSnapshot {
  const initialPrompts = prompts.filter(
    (prompt) => prompt.kind === 'initial-assignment' && prompt.targetTaskId === subtask.taskId,
  );
  const initialPrompt = initialPrompts[initialPrompts.length - 1];
  if (initialPrompt) {
    switch (initialPrompt.status) {
      case 'delivered':
        return createLegacyPromptStartupSnapshot('delivered', initialPrompt.deliveredAt);
      case 'blocked-by-question':
        return createLegacyPromptStartupSnapshot('blocked-by-question');
      case 'failed':
        return createLegacyPromptStartupSnapshot('failed');
      default:
        return createLegacyPromptStartupSnapshot('pending-prompt');
    }
  }

  return {
    ...getCoordinatorSubtaskStartupSnapshot(subtask.startup),
    initialAssignmentMode: 'post-ready-prompt',
    initialAssignmentStatus: getLegacySubtaskInitialAssignmentStatus(subtask),
  };
}

function normalizeRestoredSubtask(
  subtask: CoordinatorSubtaskSnapshot,
  prompts: readonly CoordinatorPromptRequestSnapshot[],
  now: number,
): CoordinatorSubtaskSnapshot {
  const startup = subtask.startup ?? createLegacySubtaskStartupSnapshot(subtask, prompts);
  if (
    subtask.status === 'running' ||
    subtask.status === 'spawning' ||
    subtask.status === 'waiting-for-agent-ready'
  ) {
    return {
      ...subtask,
      interruptedByRestoreAt: subtask.interruptedByRestoreAt ?? now,
      result: 'Server restored coordinator state without the live PTY session.',
      startup,
      status: 'exited',
    };
  }

  return {
    ...subtask,
    startup,
  };
}

function normalizeRestoredRun(run: CoordinatorRunSnapshot, now: number): CoordinatorRunSnapshot {
  const staleStatuses: CoordinatorRunStatus[] = [
    'draining',
    'paused-by-user',
    'running',
    'starting',
  ];
  const stalePromptStatuses: CoordinatorPromptStatus[] = [
    'delivering',
    'queued',
    'waiting-for-agent-session',
    'waiting-for-command-lease',
    'waiting-for-terminal-input-clear',
    'waiting-for-terminal-prompt',
    'waiting-for-user-idle',
  ];
  const restoredPrompts: CoordinatorPromptRequestSnapshot[] = run.promptQueue.map((prompt) => {
    if (!stalePromptStatuses.includes(prompt.status)) {
      return prompt;
    }

    return {
      ...prompt,
      status: 'write-unknown-after-restore',
      waitingReason: 'server-restored-without-live-pty-session',
    };
  });
  return {
    ...run,
    promptQueue: restoredPrompts,
    status: staleStatuses.includes(run.status) ? 'stale-after-restore' : run.status,
    subtasks: run.subtasks.map((subtask) =>
      normalizeRestoredSubtask(subtask, run.promptQueue, now),
    ),
    workflows: (run.workflows ?? []).map(normalizeRestoredWorkflow),
  };
}

function normalizeRestoredWorkflow(
  workflow: CoordinatorWorkflowSnapshot,
): CoordinatorWorkflowSnapshot {
  const staleWorkflowStatuses: CoordinatorWorkflowStatus[] = [
    'pending',
    'running',
    'waiting-for-results',
  ];
  const staleStageStatuses: CoordinatorWorkflowStageStatus[] = [
    'pending',
    'running',
    'waiting-for-results',
  ];
  const staleLaneStatuses: CoordinatorWorkflowLaneStatus[] = [
    'pending',
    'spawning',
    'running',
    'waiting-for-result',
  ];
  const now = Date.now();
  const workflowWithCancelledApprovals = cancelWorkflowPendingApprovalsOnSnapshot(
    {
      ...workflow,
      journal: workflow.journal.map((entry, index) => ({
        ...entry,
        seq: entry.seq ?? index + 1,
      })),
    },
    {
      journalMessage: 'Cancelled pending approval: stale-after-restore.',
      now,
      reason: 'stale-after-restore',
    },
  );
  const restoredWorkflow: CoordinatorWorkflowSnapshot = {
    ...workflowWithCancelledApprovals,
    appendPolicy: mergeWorkflowAppendPolicy(workflow.appendPolicy),
    policy: mergeWorkflowPolicy(workflow.policy),
    lanes: workflow.lanes.map((lane) =>
      staleLaneStatuses.includes(lane.status)
        ? {
            ...lane,
            failure: 'Server restored coordinator workflow state without the live PTY session.',
            status: 'stale-after-restore',
          }
        : lane,
    ),
    stages: workflow.stages.map((stage) =>
      staleStageStatuses.includes(stage.status)
        ? {
            ...stage,
            failure: 'Server restored coordinator workflow state without the live PTY session.',
            status: 'stale-after-restore',
          }
        : stage,
    ),
    programVersion: workflow.programVersion ?? COORDINATOR_WORKFLOW_PROGRAM_VERSION,
    status: staleWorkflowStatuses.includes(workflow.status)
      ? 'stale-after-restore'
      : workflow.status,
  };

  return {
    ...restoredWorkflow,
    execution: createRuntimeWorkflowExecutionSnapshot(restoredWorkflow, Date.now()),
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
    workflows: [],
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

export function setCoordinatorRunPaused(
  runId: string,
  paused: boolean,
  now = Date.now(),
): CoordinatorRunSnapshot {
  const record = requireRunRecord(runId);
  const version = nextVersion();
  const run = materializeRun(record);
  const nextRun: CoordinatorRunSnapshot = {
    ...run,
    eventVersion: version,
    status: paused ? 'paused-by-user' : 'running',
    updatedAt: now,
    ...(paused ? { pausedAt: now } : {}),
  };
  if (!paused) {
    delete nextRun.pausedAt;
  }
  replaceRun(record, nextRun);
  emitCoordinatorEvent(runId, 'run-upserted', `run:${runId}`, version, materializeRun(record));
  return clone(materializeRun(record));
}

function getResumedRunStatus(run: CoordinatorRunSnapshot): CoordinatorRunStatus {
  if (run.pausedAt !== undefined) {
    return 'paused-by-user';
  }

  return 'running';
}

function appendCoordinatorRunResumeEntry(
  resumes: CoordinatorRunResumeSnapshot[],
  resumeId: string,
  requestedAt: number,
): CoordinatorRunResumeSnapshot[] {
  if (resumes.some((entry) => entry.resumeId === resumeId)) {
    return resumes;
  }

  return [
    ...resumes,
    {
      failedTaskIds: [],
      requestedAt,
      respawnedTaskIds: [],
      resumeId,
    },
  ];
}

export function resumeCoordinatorRunFromStale(
  runId: string,
  options: ResumeCoordinatorRunFromStaleOptions,
): CoordinatorRunSnapshot {
  const record = requireRunRecord(runId);
  if (record.run.status !== 'stale-after-restore') {
    throw new Error(`Coordinator run is ${record.run.status}`);
  }

  const now = getNow(options.now);
  const version = nextVersion();
  const run = materializeRun(record);
  const resumes = run.resumes ?? [];
  const nextRun: CoordinatorRunSnapshot = {
    ...run,
    eventVersion: version,
    resumes: appendCoordinatorRunResumeEntry(resumes, options.resumeId, now),
    status: getResumedRunStatus(run),
    updatedAt: now,
  };
  replaceRun(record, nextRun);
  emitCoordinatorEvent(runId, 'run-upserted', `run:${runId}`, version, materializeRun(record));
  return clone(materializeRun(record));
}

export function recordCoordinatorRunResumeOutcome(
  runId: string,
  resumeId: string,
  outcome: CoordinatorRunResumeOutcome,
  now = Date.now(),
): CoordinatorRunSnapshot {
  const record = requireRunRecord(runId);
  const version = nextVersion();
  const run = materializeRun(record);
  const resumes: CoordinatorRunResumeSnapshot[] = (run.resumes ?? []).map((entry) => {
    if (entry.resumeId !== resumeId) {
      return entry;
    }

    return {
      ...entry,
      failedTaskIds: [...outcome.failedTaskIds],
      respawnedTaskIds: [...outcome.respawnedTaskIds],
    };
  });
  const nextRun: CoordinatorRunSnapshot = {
    ...run,
    eventVersion: version,
    resumes,
    updatedAt: now,
  };
  replaceRun(record, nextRun);
  emitCoordinatorEvent(runId, 'run-upserted', `run:${runId}`, version, materializeRun(record));
  return clone(materializeRun(record));
}

function getSubtaskLaunchKey(runId: string, taskId: string): string {
  return `${runId}:${taskId}`;
}

export function recordCoordinatorSubtaskLaunch(launch: CoordinatorSubtaskLaunchSnapshot): void {
  launchesByRunAndTask.set(getSubtaskLaunchKey(launch.runId, launch.taskId), clone(launch));
}

export function getCoordinatorSubtaskLaunch(
  runId: string,
  taskId: string,
): CoordinatorSubtaskLaunchSnapshot | null {
  const launch = launchesByRunAndTask.get(getSubtaskLaunchKey(runId, taskId));
  return launch === undefined ? null : clone(launch);
}

export function removeCoordinatorSubtaskLaunch(runId: string, taskId: string): void {
  launchesByRunAndTask.delete(getSubtaskLaunchKey(runId, taskId));
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
    startup: getCoordinatorSubtaskStartupSnapshot(options.startup ?? existing?.startup),
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
  options: UpdateCoordinatorSubtaskPatch = {},
): CoordinatorSubtaskSnapshot {
  const record = requireRunRecord(runId);
  const existing = record.subtasksByTaskId.get(taskId);
  if (!existing) {
    throw new Error(`Coordinator subtask not found: ${taskId}`);
  }

  const now = getNow(options.now);
  const version = nextVersion();
  const nextSubtask = {
    ...existing,
    ...(options.interruptedByRestoreAt !== undefined
      ? { interruptedByRestoreAt: options.interruptedByRestoreAt }
      : {}),
    ...(options.result !== undefined ? { result: options.result } : {}),
    ...(options.startup !== undefined ? { startup: options.startup } : {}),
    ...(options.toolTokenId !== undefined ? { toolTokenId: options.toolTokenId } : {}),
    status,
    updatedAt: now,
  };
  if ('interruptedByRestoreAt' in options && options.interruptedByRestoreAt === undefined) {
    delete nextSubtask.interruptedByRestoreAt;
  }
  if ('result' in options && options.result === undefined) {
    delete nextSubtask.result;
  }

  const subtask = nextSubtask as CoordinatorSubtaskSnapshot;
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

function mergeWorkflowPolicy(
  policy: Partial<CoordinatorWorkflowPolicySnapshot> | undefined,
): CoordinatorWorkflowPolicySnapshot {
  return {
    ...DEFAULT_WORKFLOW_POLICY,
    ...(policy?.budgetHint !== undefined ? { budgetHint: policy.budgetHint } : {}),
    ...(policy?.continueOnFailure !== undefined
      ? { continueOnFailure: policy.continueOnFailure }
      : {}),
    ...(policy?.maxConcurrentLanes !== undefined
      ? { maxConcurrentLanes: policy.maxConcurrentLanes }
      : {}),
    ...(policy?.maxIterationsPerBranch !== undefined
      ? { maxIterationsPerBranch: policy.maxIterationsPerBranch }
      : {}),
    ...(policy?.maxOutputBytesPerLane !== undefined
      ? { maxOutputBytesPerLane: policy.maxOutputBytesPerLane }
      : {}),
    ...(policy?.maxTotalLanes !== undefined ? { maxTotalLanes: policy.maxTotalLanes } : {}),
    ...(policy?.maxTotalRetries !== undefined ? { maxTotalRetries: policy.maxTotalRetries } : {}),
    ...(policy?.maxTotalSteps !== undefined ? { maxTotalSteps: policy.maxTotalSteps } : {}),
    ...(policy?.maxWallClockMs !== undefined ? { maxWallClockMs: policy.maxWallClockMs } : {}),
    ...(policy?.requireDecisionApproval !== undefined
      ? { requireDecisionApproval: policy.requireDecisionApproval }
      : {}),
    ...(policy?.resultRequired !== undefined ? { resultRequired: policy.resultRequired } : {}),
    ...(policy?.retryBackoffMs !== undefined ? { retryBackoffMs: policy.retryBackoffMs } : {}),
    ...(policy?.retryCount !== undefined ? { retryCount: policy.retryCount } : {}),
    ...(policy?.timeoutMs !== undefined ? { timeoutMs: policy.timeoutMs } : {}),
  };
}

function mergeWorkflowAppendPolicy(
  policy: Partial<CoordinatorWorkflowAppendPolicySnapshot> | undefined,
): CoordinatorWorkflowAppendPolicySnapshot {
  return {
    ...DEFAULT_WORKFLOW_APPEND_POLICY,
    ...(policy?.maxActionsPerDecision !== undefined
      ? { maxActionsPerDecision: policy.maxActionsPerDecision }
      : {}),
    ...(policy?.maxStepAppends !== undefined ? { maxStepAppends: policy.maxStepAppends } : {}),
  };
}

function getNextWorkflowJournalSeq(workflow: Pick<CoordinatorWorkflowSnapshot, 'journal'>): number {
  return (workflow.journal[workflow.journal.length - 1]?.seq ?? 0) + 1;
}

interface CancelWorkflowPendingApprovalsOptions {
  journalMessage?: string;
  laneIds?: ReadonlySet<string>;
  now: number;
  reason: string;
}

/**
 * One authority for resolving pending approvals as cancelled: the status patch and the
 * `decision-approval-cancelled` journal entries always land together with continuous seqs. Used by
 * the live mutation path, task-scoped lane cancellation, and the restore normalization path.
 */
function cancelWorkflowPendingApprovalsOnSnapshot(
  workflow: CoordinatorWorkflowSnapshot,
  options: CancelWorkflowPendingApprovalsOptions,
): CoordinatorWorkflowSnapshot {
  const shouldCancel = (approval: CoordinatorWorkflowPendingApprovalSnapshot): boolean =>
    approval.status === 'pending' &&
    (options.laneIds === undefined || options.laneIds.has(approval.laneId));
  const cancelledApprovals = (workflow.pendingApprovals ?? []).filter(shouldCancel);
  if (cancelledApprovals.length === 0) {
    return workflow;
  }

  const message = options.journalMessage ?? `Cancelled pending approval: ${options.reason}`;
  let nextJournalSeq = getNextWorkflowJournalSeq(workflow);
  return {
    ...workflow,
    journal: [
      ...workflow.journal,
      ...cancelledApprovals.map((approval) => ({
        at: options.now,
        kind: 'decision-approval-cancelled',
        laneId: approval.laneId,
        message,
        resultId: approval.resultId,
        seq: nextJournalSeq++,
        stageId: approval.stageId,
      })),
    ],
    pendingApprovals: (workflow.pendingApprovals ?? []).map((approval) =>
      shouldCancel(approval)
        ? {
            ...approval,
            reason: options.reason,
            resolvedAt: options.now,
            status: 'cancelled' as const,
          }
        : approval,
    ),
  };
}

function getWorkflowOrThrow(record: RunRecord, workflowId: string): CoordinatorWorkflowSnapshot {
  const workflow = record.workflowsById.get(workflowId);
  if (!workflow) {
    throw new Error(`Coordinator workflow not found: ${workflowId}`);
  }

  return workflow;
}

function setWorkflow(
  record: RunRecord,
  workflow: CoordinatorWorkflowSnapshot,
  now: number,
  version: number,
): CoordinatorWorkflowSnapshot {
  record.workflowsById.set(workflow.id, workflow);
  updateRunTimestamp(record, now);
  emitCoordinatorEvent(
    workflow.runId,
    'run-upserted',
    `run:${workflow.runId}`,
    version,
    materializeRun(record),
  );
  return clone(workflow);
}

function isRuntimeWorkflowStageReady(
  workflow: CoordinatorWorkflowSnapshot,
  stage: CoordinatorWorkflowStageSnapshot,
): boolean {
  if (stage.status !== 'pending') {
    return false;
  }

  return stage.dependsOn.every((dependencyId) =>
    workflow.stages.some(
      (candidate) => candidate.id === dependencyId && candidate.status === 'completed',
    ),
  );
}

function createRuntimeWorkflowExecutionSnapshot(
  workflow: CoordinatorWorkflowSnapshot,
  now: number,
): NonNullable<CoordinatorWorkflowSnapshot['execution']> {
  const knownLaneIds = new Set(workflow.lanes.map((lane) => lane.id));
  const pendingRetryLaneIds =
    workflow.execution?.pendingRetryLaneIds.filter((laneId) => knownLaneIds.has(laneId)) ?? [];
  const completedStageCount = workflow.stages.filter(
    (stage) => stage.status === 'completed',
  ).length;
  const skippedStageCount = workflow.stages.filter((stage) => stage.status === 'skipped').length;
  const failedLaneCount = workflow.lanes.filter((lane) => lane.status === 'failed').length;
  const retryableLaneCount = pendingRetryLaneIds.length;
  const timedOutLaneCount = workflow.lanes.filter((lane) => lane.status === 'timed-out').length;

  return {
    activeLaneCount: workflow.lanes.filter(
      (lane) => !isCoordinatorTerminalWorkflowLaneStatus(lane.status),
    ).length,
    completedStageCount,
    ...(workflow.execution?.blockedReason !== undefined
      ? { blockedReason: workflow.execution.blockedReason }
      : {}),
    budget: createCoordinatorWorkflowBudgetSnapshot(workflow),
    ...(workflow.execution?.cancelledAt !== undefined
      ? { cancelledAt: workflow.execution.cancelledAt }
      : {}),
    ...(workflow.execution?.completionReason !== undefined
      ? { completionReason: workflow.execution.completionReason }
      : {}),
    ...(workflow.execution?.deadlineAt !== undefined
      ? { deadlineAt: workflow.execution.deadlineAt }
      : {}),
    expansionCount: workflow.expansions?.length ?? 0,
    failedLaneCount,
    ...(workflow.execution?.failureSummary !== undefined
      ? { failureSummary: workflow.execution.failureSummary }
      : {}),
    lastTickAt: now,
    ...(workflow.execution?.nextRetryAt !== undefined
      ? { nextRetryAt: workflow.execution.nextRetryAt }
      : {}),
    pendingRetryLaneIds,
    retryableLaneCount,
    readyStageIds: workflow.stages
      .filter((stage) => isRuntimeWorkflowStageReady(workflow, stage))
      .map((stage) => stage.id),
    skippedStageCount,
    timedOutLaneCount,
  };
}

function reopenCompletedWorkflow(
  workflow: CoordinatorWorkflowSnapshot,
): Omit<CoordinatorWorkflowSnapshot, 'completedAt'> {
  const copy: CoordinatorWorkflowSnapshot = { ...workflow };
  delete copy.completedAt;
  if (copy.execution?.completionReason !== undefined) {
    copy.execution = { ...copy.execution };
    delete copy.execution.completionReason;
  }
  return copy;
}

function createWorkflowStepAppendMessage(stepIds: string[]): string {
  const noun = stepIds.length === 1 ? 'step' : 'steps';
  return `Appended ${stepIds.length} workflow ${noun}: ${stepIds.join(', ')}.`;
}

export function createCoordinatorWorkflow(
  options: CreateCoordinatorWorkflowOptions,
): CoordinatorWorkflowSnapshot {
  const record = requireRunRecord(options.runId);
  const now = getNow(options.now);
  const version = nextVersion();
  const workflowId = randomUUID();
  const stages: CoordinatorWorkflowStageSnapshot[] = options.stages.map((stage) => ({
    createdAt: now,
    dependsOn: stage.dependsOn ?? [],
    id: stage.id ?? randomUUID(),
    kind: stage.kind,
    laneIds: [],
    name: stage.name,
    resultIds: [],
    status: stage.status ?? 'pending',
    updatedAt: now,
  }));
  const workflow: CoordinatorWorkflowSnapshot = {
    appendPolicy: mergeWorkflowAppendPolicy(options.appendPolicy),
    createdAt: now,
    eventVersion: version,
    ...(options.execution !== undefined ? { execution: options.execution } : {}),
    id: workflowId,
    journal: [
      {
        at: now,
        kind: 'workflow-created',
        message: `Created ${options.template} workflow.`,
        seq: 1,
      },
    ],
    lanes: [],
    policy: mergeWorkflowPolicy(options.policy),
    programVersion: COORDINATOR_WORKFLOW_PROGRAM_VERSION,
    results: [],
    runId: options.runId,
    ...(options.sourceSpec !== undefined ? { sourceSpec: options.sourceSpec } : {}),
    stages,
    startedAt: now,
    status: options.status ?? 'running',
    template: options.template,
    title: options.title,
    updatedAt: now,
    ...(options.verdicts !== undefined ? { verdicts: options.verdicts } : {}),
  };
  return setWorkflow(record, workflow, now, version);
}

export function appendCoordinatorWorkflowSteps(
  options: AppendCoordinatorWorkflowStepsOptions,
): CoordinatorWorkflowSnapshot {
  const record = requireRunRecord(options.runId);
  const workflow = getWorkflowOrThrow(record, options.workflowId);
  if (workflow.stepAppends?.some((append) => append.appendId === options.append.appendId)) {
    return clone(workflow);
  }

  const existingStageIds = new Set(workflow.stages.map((stage) => stage.id));
  for (const stage of options.stages) {
    if (existingStageIds.has(stage.id)) {
      throw new Error(`Coordinator workflow stage already exists: ${stage.id}`);
    }
  }
  if (
    workflow.status === 'blocked' ||
    workflow.status === 'cancelled' ||
    workflow.status === 'failed' ||
    workflow.status === 'stale-after-restore'
  ) {
    throw new Error(`Coordinator workflow is ${workflow.status}`);
  }

  const now = getNow(options.now);
  const version = nextVersion();
  const appendedStages: CoordinatorWorkflowStageSnapshot[] = options.stages.map((stage) => ({
    createdAt: now,
    dependsOn: stage.dependsOn ?? [],
    id: stage.id,
    kind: stage.kind,
    laneIds: [],
    name: stage.name,
    resultIds: [],
    status: 'pending',
    updatedAt: now,
  }));
  const reopensCompletedWorkflow = workflow.status === 'completed';
  const nextStatus: CoordinatorWorkflowStatus = reopensCompletedWorkflow
    ? 'running'
    : workflow.status;
  const workflowBase = reopensCompletedWorkflow ? reopenCompletedWorkflow(workflow) : workflow;
  const workflowWithAppend: CoordinatorWorkflowSnapshot = {
    ...workflowBase,
    eventVersion: version,
    journal: [
      ...workflow.journal,
      {
        at: now,
        kind: 'workflow-steps-appended',
        ...(options.append.sourceLaneId !== undefined
          ? { laneId: options.append.sourceLaneId }
          : {}),
        message: createWorkflowStepAppendMessage(options.append.stepIds),
        seq: getNextWorkflowJournalSeq(workflow),
      },
    ],
    sourceSpec: options.sourceSpec,
    stages: [...workflow.stages, ...appendedStages],
    status: nextStatus,
    stepAppends: [...(workflow.stepAppends ?? []), options.append],
    updatedAt: now,
  };
  const updatedWorkflow: CoordinatorWorkflowSnapshot = {
    ...workflowWithAppend,
    execution: createRuntimeWorkflowExecutionSnapshot(workflowWithAppend, now),
  };

  return setWorkflow(record, updatedWorkflow, now, version);
}

export function appendCoordinatorWorkflowJournal(
  runId: string,
  workflowId: string,
  entry: Omit<CoordinatorWorkflowJournalEntrySnapshot, 'at' | 'seq'> & {
    at?: number;
    seq?: number;
  },
): CoordinatorWorkflowSnapshot {
  const record = requireRunRecord(runId);
  const workflow = getWorkflowOrThrow(record, workflowId);
  const now = getNow(entry.at);
  const version = nextVersion();
  return setWorkflow(
    record,
    {
      ...workflow,
      eventVersion: version,
      journal: [
        ...workflow.journal,
        {
          ...entry,
          at: now,
          seq: entry.seq ?? getNextWorkflowJournalSeq(workflow),
        },
      ],
      updatedAt: now,
    },
    now,
    version,
  );
}

export function addCoordinatorWorkflowLane(
  options: AddCoordinatorWorkflowLaneOptions,
): CoordinatorWorkflowLaneSnapshot {
  const record = requireRunRecord(options.runId);
  const workflow = getWorkflowOrThrow(record, options.workflowId);
  const stage = workflow.stages.find((candidate) => candidate.id === options.stageId);
  if (!stage) {
    throw new Error(`Coordinator workflow stage not found: ${options.stageId}`);
  }

  const now = getNow(options.now);
  const version = nextVersion();
  const lane: CoordinatorWorkflowLaneSnapshot = {
    assignment: options.assignment,
    attempt: options.attempt ?? 1,
    createdAt: now,
    ...(options.dedupeKey !== undefined ? { dedupeKey: options.dedupeKey } : {}),
    id: options.id ?? randomUUID(),
    name: options.name,
    ...(options.role !== undefined ? { role: options.role } : {}),
    ...(options.spawnedBy !== undefined ? { spawnedBy: options.spawnedBy } : {}),
    stageId: options.stageId,
    status: options.status ?? 'pending',
    ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    ...(options.timeoutAt !== undefined ? { timeoutAt: options.timeoutAt } : {}),
    updatedAt: now,
  };
  const updatedStage = {
    ...stage,
    laneIds: [...new Set([...stage.laneIds, lane.id])],
    updatedAt: now,
  };
  const updatedWorkflow: CoordinatorWorkflowSnapshot = {
    ...workflow,
    eventVersion: version,
    lanes: [...workflow.lanes, lane],
    stages: workflow.stages.map((candidate) =>
      candidate.id === updatedStage.id ? updatedStage : candidate,
    ),
    updatedAt: now,
  };
  setWorkflow(record, updatedWorkflow, now, version);
  return clone(lane);
}

export function updateCoordinatorWorkflowLane(
  runId: string,
  workflowId: string,
  laneId: string,
  patch: UpdateCoordinatorWorkflowLanePatch,
): CoordinatorWorkflowLaneSnapshot {
  const record = requireRunRecord(runId);
  const workflow = getWorkflowOrThrow(record, workflowId);
  const existing = workflow.lanes.find((lane) => lane.id === laneId);
  if (!existing) {
    throw new Error(`Coordinator workflow lane not found: ${laneId}`);
  }

  const now = getNow(patch.now);
  const version = nextVersion();
  const nextLane = {
    ...existing,
    ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
    ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
    ...(patch.failure !== undefined ? { failure: patch.failure } : {}),
    ...(patch.resultId !== undefined ? { resultId: patch.resultId } : {}),
    ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.supersededByLaneId !== undefined
      ? { supersededByLaneId: patch.supersededByLaneId }
      : {}),
    ...(patch.taskId !== undefined ? { taskId: patch.taskId } : {}),
    ...(patch.timeoutAt !== undefined ? { timeoutAt: patch.timeoutAt } : {}),
    updatedAt: now,
  };
  if ('failure' in patch && patch.failure === undefined) {
    delete nextLane.failure;
  }
  if ('timeoutAt' in patch && patch.timeoutAt === undefined) {
    delete nextLane.timeoutAt;
  }

  const lane = nextLane as CoordinatorWorkflowLaneSnapshot;
  const updatedWorkflow: CoordinatorWorkflowSnapshot = {
    ...workflow,
    eventVersion: version,
    lanes: workflow.lanes.map((candidate) => (candidate.id === laneId ? lane : candidate)),
    updatedAt: now,
  };
  setWorkflow(record, updatedWorkflow, now, version);
  return clone(lane);
}

export function updateCoordinatorWorkflowStage(
  runId: string,
  workflowId: string,
  stageId: string,
  patch: UpdateCoordinatorWorkflowStagePatch,
): CoordinatorWorkflowStageSnapshot {
  const record = requireRunRecord(runId);
  const workflow = getWorkflowOrThrow(record, workflowId);
  const existing = workflow.stages.find((stage) => stage.id === stageId);
  if (!existing) {
    throw new Error(`Coordinator workflow stage not found: ${stageId}`);
  }

  const now = getNow(patch.now);
  const version = nextVersion();
  const nextStage = {
    ...existing,
    ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
    ...(patch.failure !== undefined ? { failure: patch.failure } : {}),
    ...(patch.laneIds !== undefined ? { laneIds: patch.laneIds } : {}),
    ...(patch.resultIds !== undefined ? { resultIds: patch.resultIds } : {}),
    ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    updatedAt: now,
  };
  if ('failure' in patch && patch.failure === undefined) {
    delete nextStage.failure;
  }

  const stage = nextStage as CoordinatorWorkflowStageSnapshot;
  const updatedWorkflow: CoordinatorWorkflowSnapshot = {
    ...workflow,
    eventVersion: version,
    stages: workflow.stages.map((candidate) => (candidate.id === stageId ? stage : candidate)),
    updatedAt: now,
  };
  setWorkflow(record, updatedWorkflow, now, version);
  return clone(stage);
}

export function updateCoordinatorWorkflow(
  runId: string,
  workflowId: string,
  patch: UpdateCoordinatorWorkflowPatch,
): CoordinatorWorkflowSnapshot {
  const record = requireRunRecord(runId);
  const workflow = getWorkflowOrThrow(record, workflowId);
  const now = getNow(patch.now);
  const version = nextVersion();
  return setWorkflow(
    record,
    {
      ...workflow,
      ...(patch.appendPolicy !== undefined ? { appendPolicy: patch.appendPolicy } : {}),
      ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      eventVersion: version,
      ...(patch.execution !== undefined ? { execution: patch.execution } : {}),
      ...(patch.expansions !== undefined ? { expansions: patch.expansions } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: now,
      ...(patch.verdicts !== undefined ? { verdicts: patch.verdicts } : {}),
    },
    now,
    version,
  );
}

export function addCoordinatorWorkflowResult(
  options: AddCoordinatorWorkflowResultOptions,
): CoordinatorWorkflowResultSnapshot {
  const record = requireRunRecord(options.runId);
  const now = getNow(options.now);
  const version = nextVersion();
  const result: CoordinatorWorkflowResultSnapshot = {
    ...options.result,
    createdAt: options.result.createdAt ?? now,
    id: options.result.id ?? randomUUID(),
    runId: options.runId,
    workflowId: options.workflowId,
  };

  const workflow = getWorkflowOrThrow(record, options.workflowId);
  const updatedWorkflow: CoordinatorWorkflowSnapshot = {
    ...workflow,
    eventVersion: version,
    results: [...workflow.results, result],
    stages: workflow.stages.map((stage) =>
      stage.id === result.stageId
        ? {
            ...stage,
            resultIds: [...new Set([...stage.resultIds, result.id])],
            updatedAt: now,
          }
        : stage,
    ),
    updatedAt: now,
  };
  setWorkflow(record, updatedWorkflow, now, version);
  return clone(result);
}

export function addCoordinatorWorkflowPendingApproval(
  options: AddCoordinatorWorkflowPendingApprovalOptions,
): CoordinatorWorkflowPendingApprovalSnapshot {
  const record = requireRunRecord(options.runId);
  const workflow = getWorkflowOrThrow(record, options.workflowId);
  const existing = workflow.pendingApprovals?.find((approval) => approval.id === options.id);
  if (existing !== undefined) {
    return clone(existing);
  }

  const now = getNow(options.now);
  const version = nextVersion();
  const approval: CoordinatorWorkflowPendingApprovalSnapshot = {
    actions: options.actions,
    createdAt: now,
    id: options.id,
    laneId: options.laneId,
    resultId: options.resultId,
    stageId: options.stageId,
    status: 'pending',
  };
  setWorkflow(
    record,
    {
      ...workflow,
      eventVersion: version,
      pendingApprovals: [...(workflow.pendingApprovals ?? []), approval],
      updatedAt: now,
    },
    now,
    version,
  );
  return clone(approval);
}

export function resolveCoordinatorWorkflowPendingApproval(
  runId: string,
  workflowId: string,
  approvalId: string,
  resolution: Exclude<CoordinatorWorkflowPendingApprovalSnapshot['status'], 'pending'>,
  options: ResolveCoordinatorWorkflowPendingApprovalOptions = {},
): CoordinatorWorkflowPendingApprovalSnapshot {
  const record = requireRunRecord(runId);
  const workflow = getWorkflowOrThrow(record, workflowId);
  const existing = workflow.pendingApprovals?.find((approval) => approval.id === approvalId);
  if (!existing) {
    throw new Error(`Coordinator workflow approval not found: ${approvalId}`);
  }

  const now = getNow(options.now);
  const version = nextVersion();
  const resolved: CoordinatorWorkflowPendingApprovalSnapshot = {
    ...existing,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    resolvedAt: now,
    status: resolution,
  };
  setWorkflow(
    record,
    {
      ...workflow,
      eventVersion: version,
      pendingApprovals: (workflow.pendingApprovals ?? []).map((approval) =>
        approval.id === approvalId ? resolved : approval,
      ),
      updatedAt: now,
    },
    now,
    version,
  );
  return clone(resolved);
}

export function cancelCoordinatorWorkflowPendingApprovals(
  runId: string,
  workflowId: string,
  options: { laneIds?: ReadonlySet<string>; now?: number; reason: string },
): CoordinatorWorkflowSnapshot {
  const record = requireRunRecord(runId);
  const workflow = getWorkflowOrThrow(record, workflowId);
  const now = getNow(options.now);
  const cancelled = cancelWorkflowPendingApprovalsOnSnapshot(workflow, { ...options, now });
  if (cancelled === workflow) {
    return clone(workflow);
  }

  const version = nextVersion();
  return setWorkflow(record, { ...cancelled, eventVersion: version, updatedAt: now }, now, version);
}

export function cancelCoordinatorWorkflowLanesForTask(
  runId: string,
  taskId: string,
  reason: string,
): CoordinatorWorkflowLaneSnapshot[] {
  const record = requireRunRecord(runId);
  const now = Date.now();
  const cancelled: CoordinatorWorkflowLaneSnapshot[] = [];

  for (const workflow of record.workflowsById.values()) {
    const matchingLaneIds = new Set(
      workflow.lanes
        .filter(
          (lane) => lane.taskId === taskId && !isCoordinatorTerminalWorkflowLaneStatus(lane.status),
        )
        .map((lane) => lane.id),
    );
    if (matchingLaneIds.size === 0) {
      continue;
    }

    const version = nextVersion();
    const updatedLanes = workflow.lanes.map((lane) => {
      if (!matchingLaneIds.has(lane.id)) {
        return lane;
      }

      const cancelledLane: CoordinatorWorkflowLaneSnapshot = {
        ...lane,
        completedAt: now,
        failure: reason,
        status: 'cancelled',
        updatedAt: now,
      };
      cancelled.push(cancelledLane);
      return cancelledLane;
    });
    const affectedStageIds = new Set(
      updatedLanes.filter((lane) => matchingLaneIds.has(lane.id)).map((lane) => lane.stageId),
    );
    const updatedStages = workflow.stages.map((stage) => {
      if (!affectedStageIds.has(stage.id)) {
        return stage;
      }

      const stageLanes = updatedLanes.filter((lane) => stage.laneIds.includes(lane.id));
      if (!stageLanes.every((lane) => isCoordinatorTerminalWorkflowLaneStatus(lane.status))) {
        return {
          ...stage,
          updatedAt: now,
        };
      }

      return {
        ...stage,
        completedAt: now,
        failure: reason,
        status: 'cancelled' as const,
        updatedAt: now,
      };
    });
    const workflowCancelled = updatedStages.some((stage) => stage.status === 'cancelled');
    let nextJournalSeq = getNextWorkflowJournalSeq(workflow);
    const workflowWithCancelledLanes: CoordinatorWorkflowSnapshot = {
      ...workflow,
      journal: [
        ...workflow.journal,
        ...updatedLanes
          .filter((lane) => matchingLaneIds.has(lane.id))
          .map((lane) => ({
            at: now,
            kind: 'lane-cancelled',
            laneId: lane.id,
            message: reason,
            seq: nextJournalSeq++,
            stageId: lane.stageId,
          })),
      ],
      lanes: updatedLanes,
      stages: updatedStages,
    };
    const updatedWorkflow: CoordinatorWorkflowSnapshot = {
      ...cancelWorkflowPendingApprovalsOnSnapshot(workflowWithCancelledLanes, {
        laneIds: matchingLaneIds,
        now,
        reason,
      }),
      ...(workflowCancelled ? { completedAt: now } : {}),
      eventVersion: version,
      ...(workflowCancelled ? { status: 'cancelled' as const } : {}),
      updatedAt: now,
    };
    setWorkflow(record, updatedWorkflow, now, version);
  }

  return clone(cancelled);
}

export function getCoordinatorRun(runId: string): CoordinatorRunSnapshot | null {
  const record = recordsByRunId.get(runId);
  return record ? clone(materializeRun(record)) : null;
}

/** Status-only read for hot paths that must not pay for the full-run clone `getCoordinatorRun` does. */
export function getCoordinatorRunStatus(runId: string): CoordinatorRunStatus | null {
  return recordsByRunId.get(runId)?.run.status ?? null;
}

export function getCoordinatorWorkflow(
  runId: string,
  workflowId: string,
): CoordinatorWorkflowSnapshot | null {
  const record = recordsByRunId.get(runId);
  return record?.workflowsById.has(workflowId)
    ? clone(record.workflowsById.get(workflowId) as CoordinatorWorkflowSnapshot)
    : null;
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
  for (const key of [...launchesByRunAndTask.keys()]) {
    if (key.startsWith(`${runId}:`)) {
      launchesByRunAndTask.delete(key);
    }
  }
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
    subtaskLaunches: [...launchesByRunAndTask.values()].map((launch) => clone(launch)),
    toolCallResults: [...toolCallResults.entries()].map(([key, record]) => ({
      createdAt: record.createdAt,
      key,
      result: clone(record.result),
    })),
  };
}

export function restoreCoordinatorRuntimeState(state: CoordinatorRuntimeState): void {
  const now = Date.now();
  recordsByRunId = new Map(
    state.runs.map((run) => {
      const restoredRun = normalizeRestoredRun(clone(run), now);
      return [restoredRun.id, createRunRecord(restoredRun)];
    }),
  );
  launchesByRunAndTask.clear();
  for (const launch of state.subtaskLaunches) {
    if (recordsByRunId.has(launch.runId)) {
      launchesByRunAndTask.set(getSubtaskLaunchKey(launch.runId, launch.taskId), clone(launch));
    }
  }
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
  launchesByRunAndTask.clear();
  stateVersion = 0;
  eventListeners.clear();
  toolCallResults.clear();
}
