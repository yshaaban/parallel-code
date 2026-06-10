import { randomUUID } from 'node:crypto';

import { IPC } from '../ipc/channels.js';
import type { HandlerContext } from '../ipc/handler-context.js';
import { BadRequestError } from '../ipc/errors.js';
import {
  getAgentSupervisionSnapshot,
  subscribeAgentSupervision,
} from '../ipc/agent-supervision.js';
import {
  getAgentMeta,
  getAgentScrollbackBuffer,
  hasAgentSession,
  writeToAgent,
} from '../ipc/pty.js';
import {
  acquireTaskCommandLease,
  getTaskCommandControllerSnapshot,
  isTaskCommandLeaseGenerationHeld,
  releaseTaskCommandLease,
} from '../ipc/task-command-leases.js';
import {
  COORDINATOR_LIMITS,
  coordinatorRunAdmitsNewWork,
  getCoordinatorAgentFollowupPromptMode,
  getCoordinatorAgentInitialAssignmentMode,
  getCoordinatorSubtaskStartupSnapshot,
  isCodexCoordinatorAgentCommand,
  isCoordinatorPendingPromptStatus,
  isCoordinatorTerminalSubtaskStatus,
  type CoordinatorAgentFollowupPromptMode,
  type CoordinatorAgentReadinessPolicy,
  type CoordinatorPromptKind,
  type CoordinatorPromptRequestSnapshot,
  type CoordinatorRunSnapshot,
  type CoordinatorSpawnAgentConfig,
  type CoordinatorSubtaskSnapshot,
} from '../../src/domain/coordinator.js';
import { buildCoordinatorSubtaskAssignment } from '../../src/domain/coordinator-instructions.js';
import { materializePromptDispatch } from '../../src/domain/task-prompt-materialization.js';
import { hasCodexPromptInTail, hasShellPromptReadyInTail } from '../../src/lib/prompt-detection.js';
import { getCoordinatorBlockingActivityHints } from './service.js';
import {
  enqueueCoordinatorPrompt,
  getCoordinatorRun,
  listCoordinatorRuns,
  subscribeCoordinatorEvents,
  updateCoordinatorPrompt,
  updateCoordinatorSubtaskStatus,
} from './runtime.js';

export const COORDINATOR_AUTOMATION_CLIENT_ID_PREFIX = 'coordinator:';
const COORDINATOR_AUTOMATION_OWNER_ID = 'coordinator-prompt-delivery';
export const PROMPT_DELIVERY_RETRY_DELAY_MS = 1_000;

export interface QueueCoordinatorPromptOptions {
  dedupeKey?: string;
  kind?: CoordinatorPromptKind;
  run: CoordinatorRunSnapshot;
  sourceTaskId: string;
  subtask: CoordinatorSubtaskSnapshot;
  text: string;
}

let promptDeliveryCleanup: (() => void) | null = null;
let promptDeliveryContext: HandlerContext | null = null;
let promptDeliveryForce = false;
let promptDeliveryTimer: ReturnType<typeof setTimeout> | null = null;
const activePromptDeliveryKeys = new Set<string>();
const scheduledPromptDeliveryKeys = new Set<string>();
const promptDeliveryChainsByTargetKey = new Map<string, Promise<unknown>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function countReservedPromptDeliveryTargets(
  keys: Iterable<string>,
  runId: string | null = null,
): number {
  let count = 0;
  for (const key of keys) {
    if (runId === null || key.startsWith(`${runId}:`)) {
      count += 1;
    }
  }

  return count;
}

function getReservedPromptDeliveryTargetKeys(excludedTargetKey: string | null = null): Set<string> {
  const reservedTargetKeys = new Set(promptDeliveryChainsByTargetKey.keys());
  if (excludedTargetKey !== null) {
    reservedTargetKeys.delete(excludedTargetKey);
  }

  return reservedTargetKeys;
}

function hasGlobalPromptDeliveryCapacity(): boolean {
  return (
    countReservedPromptDeliveryTargets(getReservedPromptDeliveryTargetKeys()) <
    COORDINATOR_LIMITS.maxConcurrentPromptDeliveriesGlobal
  );
}

function hasPromptDeliveryCapacity(
  runId: string,
  excludedTargetKey: string | null = null,
): boolean {
  const reservedTargetKeys = getReservedPromptDeliveryTargetKeys(excludedTargetKey);
  return (
    countReservedPromptDeliveryTargets(reservedTargetKeys) <
      COORDINATOR_LIMITS.maxConcurrentPromptDeliveriesGlobal &&
    countReservedPromptDeliveryTargets(reservedTargetKeys, runId) <
      COORDINATOR_LIMITS.maxConcurrentPromptDeliveriesPerRun
  );
}

export function mergeLaunchArgs(
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

export function usesSeededInitialAssignment(agent: CoordinatorSpawnAgentConfig): boolean {
  return getCoordinatorAgentInitialAssignmentMode(agent) !== 'post-ready-prompt';
}

export function canSendFollowupPrompt(
  agentOrMode: CoordinatorSpawnAgentConfig | CoordinatorAgentFollowupPromptMode,
): boolean {
  return (
    (typeof agentOrMode === 'string'
      ? agentOrMode
      : getCoordinatorAgentFollowupPromptMode(agentOrMode)) === 'post-ready-prompt'
  );
}

export function buildCoordinatorSeededLaunchArgs(
  agent: CoordinatorSpawnAgentConfig,
  assignment: string,
  toolCommand: string | undefined,
): string[] {
  const prompt = buildCoordinatorSubtaskAssignment(assignment, {
    ...(toolCommand !== undefined ? { toolCommand } : {}),
  });
  return [...mergeLaunchArgs(agent.args, agent.skipPermissionsArgs), prompt];
}

export function assertSupportedSeededInitialAssignment(agent: CoordinatorSpawnAgentConfig): void {
  if (!usesSeededInitialAssignment(agent)) {
    return;
  }
  if (!isCodexCoordinatorAgentCommand(agent.command)) {
    throw new BadRequestError(
      'Seeded initial assignment modes are currently supported only for codex agents',
    );
  }
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
  const startup = getCoordinatorSubtaskStartupSnapshot(subtask.startup);

  if (prompt.status === 'delivered') {
    updateCoordinatorSubtaskStatus(prompt.runId, prompt.targetTaskId, 'running', {
      startup: {
        ...startup,
        initialAssignmentStatus: 'delivered',
        ...(prompt.deliveredAt !== undefined ? { deliveredAt: prompt.deliveredAt } : {}),
      },
    });
    return;
  }
  if (prompt.status === 'failed') {
    updateCoordinatorSubtaskStatus(prompt.runId, prompt.targetTaskId, 'failed', {
      result: prompt.waitingReason ?? 'Initial assignment delivery failed.',
      startup: {
        ...startup,
        initialAssignmentStatus: 'failed',
      },
    });
    return;
  }
  if (prompt.status === 'blocked-by-question') {
    updateCoordinatorSubtaskStatus(prompt.runId, prompt.targetTaskId, 'waiting-for-user', {
      startup: {
        ...startup,
        initialAssignmentStatus: 'blocked-by-question',
      },
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

function isPromptReadyForReadinessPolicy(
  readinessPolicy: CoordinatorAgentReadinessPolicy,
  scrollback: string,
): boolean {
  switch (readinessPolicy) {
    case 'codex':
      return hasCodexPromptInTail(scrollback);
    case 'shell':
      return hasShellPromptReadyInTail(scrollback);
    case 'terminal-generic':
      return true;
  }
}

export function scheduleCoordinatorPromptDelivery(delayMs = 0, force = false): void {
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

export function coordinatorRunAdmitsPromptDelivery(
  run: Pick<CoordinatorRunSnapshot, 'status'>,
): boolean {
  return coordinatorRunAdmitsNewWork(run.status);
}

async function processCoordinatorPromptQueue(force = false): Promise<void> {
  const context = promptDeliveryContext;
  if (!context) {
    return;
  }

  const now = Date.now();
  let nextRetryAt: number | null = null;
  for (const run of listCoordinatorRuns()) {
    if (!coordinatorRunAdmitsPromptDelivery(run)) {
      continue;
    }
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

      if (!hasGlobalPromptDeliveryCapacity()) {
        return;
      }
    }
  }

  if (nextRetryAt !== null) {
    scheduleCoordinatorPromptDelivery(Math.max(0, nextRetryAt - now));
  }
}

export function startCoordinatorPromptDeliveryLoop(context: HandlerContext): void {
  promptDeliveryContext = context;
  if (promptDeliveryCleanup !== null) {
    scheduleCoordinatorPromptDelivery();
    return;
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
    promptDeliveryCleanup = null;
    promptDeliveryContext = null;
  };
  scheduleCoordinatorPromptDelivery();
}

export function stopCoordinatorPromptDeliveryLoop(): void {
  promptDeliveryCleanup?.();
}

export function resetCoordinatorPromptDeliveryForTests(): void {
  promptDeliveryCleanup?.();
  promptDeliveryCleanup = null;
  promptDeliveryContext = null;
  promptDeliveryForce = false;
  if (promptDeliveryTimer !== null) {
    clearTimeout(promptDeliveryTimer);
    promptDeliveryTimer = null;
  }
  activePromptDeliveryKeys.clear();
  scheduledPromptDeliveryKeys.clear();
  promptDeliveryChainsByTargetKey.clear();
}

export function emitTaskCommandControllerChange(context: HandlerContext, taskId: string): void {
  context.emitIpcEvent?.(
    IPC.TaskCommandControllerChanged,
    getTaskCommandControllerSnapshot(taskId),
  );
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

export async function deliverCoordinatorPromptWithAdmission(
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
  const run = getCoordinatorRun(latestPrompt.runId);
  if (run !== null && !coordinatorRunAdmitsPromptDelivery(run)) {
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
  const run = getCoordinatorRun(prompt.runId);
  const subtask = run?.subtasks.find((candidate) => candidate.taskId === prompt.targetTaskId);
  const startup = getCoordinatorSubtaskStartupSnapshot(subtask?.startup);
  const scrollback = getAgentScrollbackBuffer(prompt.targetAgentId)?.toString('utf8') ?? '';
  if (!isPromptReadyForReadinessPolicy(startup.readinessPolicy, scrollback)) {
    return updateCoordinatorPromptDeliveryState(prompt.runId, prompt.requestId, {
      earliestDeliveryAt: nextRetryAt,
      status: 'waiting-for-terminal-prompt',
      waitingReason: 'agent-quiet',
    });
  }

  const automationClientId = getAutomationClientId(prompt.runId);
  const key = getPromptDeliveryKey(prompt);
  if (activePromptDeliveryKeys.has(key)) {
    return prompt;
  }
  if (!hasPromptDeliveryCapacity(prompt.runId, getPromptDeliveryTargetKey(prompt))) {
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

export async function queueCoordinatorPromptForDelivery(
  context: HandlerContext,
  options: QueueCoordinatorPromptOptions,
): Promise<CoordinatorPromptRequestSnapshot> {
  const { run, subtask } = options;
  if (
    options.kind !== 'initial-assignment' &&
    !canSendFollowupPrompt(getCoordinatorSubtaskStartupSnapshot(subtask.startup).followupPromptMode)
  ) {
    throw new BadRequestError('targetTaskId does not accept follow-up prompts');
  }

  if (options.dedupeKey !== undefined) {
    const existingPrompt = run.promptQueue.find(
      (prompt) =>
        prompt.dedupeKey === options.dedupeKey &&
        prompt.sourceTaskId === options.sourceTaskId &&
        prompt.targetTaskId === subtask.taskId,
    );
    if (existingPrompt) {
      return existingPrompt;
    }
  }

  const pendingPromptsForTarget = run.promptQueue.filter(
    (prompt) =>
      prompt.targetTaskId === subtask.taskId && isCoordinatorPendingPromptStatus(prompt.status),
  );
  if (pendingPromptsForTarget.length >= run.limits.maxPendingPromptsPerTarget) {
    throw new BadRequestError('Coordinator prompt limit reached for target task');
  }

  const prompt = enqueueCoordinatorPrompt({
    kind: options.kind ?? 'follow-up',
    runId: run.id,
    sourceTaskId: options.sourceTaskId,
    targetAgentId: subtask.agentId,
    targetTaskId: subtask.taskId,
    text: options.text,
    ...(options.dedupeKey !== undefined ? { dedupeKey: options.dedupeKey } : {}),
  });
  return deliverCoordinatorPromptWithAdmission(context, prompt);
}
