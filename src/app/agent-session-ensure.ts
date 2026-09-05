import { IPC } from '../../electron/ipc/channels';
import type {
  RendererInvokeRequestMap,
  RendererInvokeResponseMap,
} from '../domain/renderer-invoke';
import { invoke } from '../lib/ipc';
import { store } from '../store/state';
import { getSelectedTaskAgentId } from '../store/task-agent-selection';
import type { Agent, Task } from '../store/types';
import {
  getGlobalTerminalStartupPaintCoordinationSnapshot,
  subscribeTerminalStartupPaintCoordinationChanges,
} from './terminal-startup-paint';

type EnsureAgentSessionsBatchRequest = RendererInvokeRequestMap[IPC.EnsureAgentSessionsBatch];
type EnsureAgentSessionsBatchReason = EnsureAgentSessionsBatchRequest['reason'];
type EnsureAgentSessionRequest = EnsureAgentSessionsBatchRequest['requests'][number];
type EnsureAgentSessionResult =
  RendererInvokeResponseMap[IPC.EnsureAgentSessionsBatch]['results'][number];

const STARTUP_RESTORE_BACKGROUND_FALLBACK_MS = 1_000;

interface StartupRestoreAgentSessionEnsureOptions {
  isDisposed?: () => boolean;
}

function createEnsureAgentSessionRequest(task: Task, agent: Agent): EnsureAgentSessionRequest {
  return {
    agentId: agent.id,
    taskId: task.id,
  };
}

function createTaskAgentSelectionReference(
  task: Pick<Task, 'selectedAgentId'>,
  agentIds: string[],
): Pick<Task, 'agentIds' | 'selectedAgentId'> {
  if (task.selectedAgentId === undefined) {
    return { agentIds };
  }

  return {
    agentIds,
    selectedAgentId: task.selectedAgentId,
  };
}

function getTaskPreferredAgentId(
  task: Pick<Task, 'agentIds' | 'selectedAgentId'>,
  agentIds: string[],
  preferredAgentId?: string | null,
): string | null {
  return getSelectedTaskAgentId(
    createTaskAgentSelectionReference(task, agentIds),
    preferredAgentId,
  );
}

function getOrderedTaskAgentIds(task: Task): string[] {
  const agentIds = Array.isArray(task.agentIds) ? task.agentIds : [];
  if (agentIds.length === 0) {
    return [];
  }

  const preferredAgentId = getTaskPreferredAgentId(
    task,
    agentIds,
    store.activeTaskId === task.id ? store.activeAgentId : null,
  );
  if (!preferredAgentId || !agentIds.includes(preferredAgentId)) {
    return agentIds;
  }

  return [preferredAgentId, ...agentIds.filter((agentId) => agentId !== preferredAgentId)];
}

function appendStartupRestoreAgentSessionRequests(
  taskId: string,
  requests: EnsureAgentSessionRequest[],
  seenAgentIds: Set<string>,
  excludedAgentIds: ReadonlySet<string>,
): void {
  const task = store.tasks[taskId];
  if (!task || task.collapsed) {
    return;
  }

  for (const agentId of getOrderedTaskAgentIds(task)) {
    if (seenAgentIds.has(agentId) || excludedAgentIds.has(agentId)) {
      continue;
    }

    const agent = store.agents[agentId];
    if (!agent) {
      continue;
    }

    seenAgentIds.add(agentId);
    requests.push(createEnsureAgentSessionRequest(task, agent));
  }
}

function getActiveStartupRestoreSelectedAgentId(): string | null {
  if (!store.activeTaskId) {
    return null;
  }

  const task = store.tasks[store.activeTaskId];
  if (!task || task.collapsed) {
    return null;
  }

  const agentIds = Array.isArray(task.agentIds) ? task.agentIds : [];
  if (agentIds.length === 0) {
    return null;
  }

  return getTaskPreferredAgentId(task, agentIds, store.activeAgentId);
}

function collectStartupRestoreAgentSessionRequests(
  excludedAgentIds: ReadonlySet<string>,
): EnsureAgentSessionRequest[] {
  const requests: EnsureAgentSessionRequest[] = [];
  const seenAgentIds = new Set<string>();

  if (store.activeTaskId) {
    appendStartupRestoreAgentSessionRequests(
      store.activeTaskId,
      requests,
      seenAgentIds,
      excludedAgentIds,
    );
  }

  for (const taskId of store.taskOrder) {
    appendStartupRestoreAgentSessionRequests(taskId, requests, seenAgentIds, excludedAgentIds);
  }

  return requests;
}

function collectStartupRestoreBackgroundAgentSessionRequests(): EnsureAgentSessionRequest[] {
  const excludedAgentIds = new Set<string>();
  const selectedAgentId = getActiveStartupRestoreSelectedAgentId();
  if (selectedAgentId) {
    excludedAgentIds.add(selectedAgentId);
  }

  return collectStartupRestoreAgentSessionRequests(excludedAgentIds);
}

function getBatchEnsureFailures(
  response: RendererInvokeResponseMap[IPC.EnsureAgentSessionsBatch] | null | undefined,
): Array<Extract<EnsureAgentSessionResult, { kind: 'unavailable' }>> {
  if (!response || !Array.isArray(response.results)) {
    return [];
  }

  return response.results.filter(
    (result): result is Extract<EnsureAgentSessionResult, { kind: 'unavailable' }> =>
      result.kind === 'unavailable',
  );
}

async function ensureAgentSessionsForStartupRestore(
  options: StartupRestoreAgentSessionEnsureOptions,
): Promise<void> {
  if (options.isDisposed?.() === true) {
    return;
  }

  const requests = collectStartupRestoreBackgroundAgentSessionRequests();
  if (requests.length === 0) {
    return;
  }

  const reason: EnsureAgentSessionsBatchReason = 'startup-restore';
  if (options.isDisposed?.() === true) {
    return;
  }

  const response = await invoke(IPC.EnsureAgentSessionsBatch, {
    reason,
    requests,
  });
  if (options.isDisposed?.() === true) {
    return;
  }

  const failures = getBatchEnsureFailures(response);
  if (failures.length === 0) {
    return;
  }

  console.warn(
    '[terminal] Startup restore prewarm failed for some agent sessions:',
    failures.map((failure) => ({
      agentId: failure.agentId,
      reason: failure.reason,
      taskId: failure.taskId,
    })),
  );
}

const inFlightDeferredEnsureKeys = new Set<string>();
const ensuredDeferredAgentTaskIds = new Map<string, string>();
let deferredEnsureEpoch = 0;

// Cold-hidden non-shell terminals defer their renderer attach until
// visibility/prewarm intent; this keeps the backend session (and with it
// supervision/attention) live for them through the existing
// EnsureAgentSessionsBatch path, deduped per agent.
export function ensureAgentSessionForDeferredTerminal(taskId: string, agentId: string): void {
  const ensureKey = `${taskId}\u0000${agentId}`;
  if (
    inFlightDeferredEnsureKeys.has(ensureKey) ||
    ensuredDeferredAgentTaskIds.get(agentId) === taskId
  ) {
    return;
  }

  const task = store.tasks[taskId];
  const agent = store.agents[agentId];
  if (!task || !agent) {
    return;
  }

  const requestEpoch = deferredEnsureEpoch;
  inFlightDeferredEnsureKeys.add(ensureKey);
  void invoke(IPC.EnsureAgentSessionsBatch, {
    reason: 'startup-restore',
    requests: [createEnsureAgentSessionRequest(task, agent)],
  })
    .then((response) => {
      const result = response.results[0];
      const currentTask = store.tasks[taskId];
      const currentAgent = store.agents[agentId];
      if (
        result?.kind !== 'unavailable' &&
        result?.agentId === agentId &&
        result.taskId === taskId &&
        currentTask?.agentIds?.includes(agentId) === true &&
        currentAgent?.id === agentId &&
        currentAgent.taskId === taskId &&
        requestEpoch === deferredEnsureEpoch
      ) {
        ensuredDeferredAgentTaskIds.set(agentId, taskId);
      }
    })
    .catch((error: unknown) => {
      console.warn('[terminal] Failed to ensure deferred terminal session:', error);
    })
    .finally(() => {
      inFlightDeferredEnsureKeys.delete(ensureKey);
    });
}

// A full reconnect restore means the backend may have lost its PTY sessions
// (for example a browser-mode server restart), so previously ensured deferred
// sessions can no longer be assumed live. Invalidate the dedupe and re-issue
// the ensure for the affected terminals: agents or tasks removed by the
// restore reconciliation are skipped by the store lookups, and terminals that
// attached in the meantime treat the ensure as a backend no-op.
export function reEnsureDeferredAgentSessionsAfterReconnectRestore(): void {
  deferredEnsureEpoch += 1;
  const previouslyEnsured = [...ensuredDeferredAgentTaskIds.entries()];
  ensuredDeferredAgentTaskIds.clear();
  for (const [agentId, taskId] of previouslyEnsured) {
    ensureAgentSessionForDeferredTerminal(taskId, agentId);
  }
}

export function resetDeferredAgentSessionEnsureForTests(): void {
  deferredEnsureEpoch += 1;
  inFlightDeferredEnsureKeys.clear();
  ensuredDeferredAgentTaskIds.clear();
}

function shouldWaitForSelectedPaintBeforeStartupRestoreBackgroundEnsure(): boolean {
  if (!getActiveStartupRestoreSelectedAgentId()) {
    return false;
  }

  return !getGlobalTerminalStartupPaintCoordinationSnapshot().selectedPaintReady;
}

export function startStartupRestoreAgentSessionEnsure(
  options: StartupRestoreAgentSessionEnsureOptions = {},
): () => void {
  let cancelled = false;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let unsubscribePaintChanges: (() => void) | undefined;

  function isStopped(): boolean {
    return cancelled || options.isDisposed?.() === true;
  }

  function cleanupWaiters(): void {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    unsubscribePaintChanges?.();
    unsubscribePaintChanges = undefined;
  }

  function runEnsure(): void {
    if (isStopped()) {
      cleanupWaiters();
      return;
    }

    cleanupWaiters();
    void ensureAgentSessionsForStartupRestore({
      isDisposed: isStopped,
    }).catch((error) => {
      if (!isStopped()) {
        console.warn('[terminal] Failed to prewarm restored agent sessions:', error);
      }
    });
  }

  function maybeRunAfterSelectedPaint(): void {
    if (isStopped()) {
      cleanupWaiters();
      return;
    }

    if (!shouldWaitForSelectedPaintBeforeStartupRestoreBackgroundEnsure()) {
      runEnsure();
    }
  }

  if (shouldWaitForSelectedPaintBeforeStartupRestoreBackgroundEnsure()) {
    timeoutId = globalThis.setTimeout(runEnsure, STARTUP_RESTORE_BACKGROUND_FALLBACK_MS);
    unsubscribePaintChanges = subscribeTerminalStartupPaintCoordinationChanges(
      maybeRunAfterSelectedPaint,
    );
    maybeRunAfterSelectedPaint();
  } else {
    runEnsure();
  }

  return () => {
    cancelled = true;
    cleanupWaiters();
  };
}
