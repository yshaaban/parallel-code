import { IPC } from '../../electron/ipc/channels';
import {
  resolveAgentRunnerProfile,
  type AgentRunnerProfileConfig,
} from '../domain/agent-runners.js';
import type {
  RendererInvokeRequestMap,
  RendererInvokeResponseMap,
} from '../domain/renderer-invoke';
import { buildAgentSpawnArgs, shouldResumeAgentOnSpawn } from '../lib/agent-resume';
import { getAgentSpawnCommand, getAgentSpawnEnvironment } from '../lib/agent-spawn-config';
import { invoke } from '../lib/ipc';
import { store } from '../store/state';
import { getSelectedTaskAgentId } from '../store/task-agent-selection';
import type { Agent, Project, Task } from '../store/types';
import {
  getGlobalTerminalStartupPaintCoordinationSnapshot,
  subscribeTerminalStartupPaintCoordinationChanges,
} from './terminal-startup-paint';

type EnsureAgentSessionsBatchRequest = RendererInvokeRequestMap[IPC.EnsureAgentSessionsBatch];
type EnsureAgentSessionsBatchReason = EnsureAgentSessionsBatchRequest['reason'];
type EnsureAgentSessionRequest = EnsureAgentSessionsBatchRequest['requests'][number];
type EnsureAgentSessionResult =
  RendererInvokeResponseMap[IPC.EnsureAgentSessionsBatch]['results'][number];

const DEFAULT_STARTUP_RESTORE_COLS = 80;
const DEFAULT_STARTUP_RESTORE_ROWS = 24;
const STARTUP_RESTORE_BACKGROUND_FALLBACK_MS = 1_000;

interface StartupRestoreAgentSessionEnsureOptions {
  isDisposed?: () => boolean;
}

function getProjectForTask(task: Pick<Task, 'projectId'>): Project | undefined {
  return store.projects.find((project) => project.id === task.projectId);
}

function getRunnerProfileForTask(
  task: Pick<Task, 'projectId'>,
): AgentRunnerProfileConfig | undefined {
  const project = getProjectForTask(task);
  const resolution = resolveAgentRunnerProfile(
    project?.agentRunnerConfig,
    project?.containerConfig,
  );

  return resolution.configuredProfile ?? undefined;
}

function createEnsureAgentSessionRequest(task: Task, agent: Agent): EnsureAgentSessionRequest {
  const agentDef = agent.def;
  const runnerProfile = getRunnerProfileForTask(task);

  return {
    agentId: agent.id,
    args: buildAgentSpawnArgs(agentDef, {
      resumed: agent.resumed,
      skipPermissions: task.skipPermissions === true,
    }),
    ...(agentDef.adapter !== undefined ? { adapter: agentDef.adapter } : {}),
    ...(task.baseBranch !== undefined ? { baseBranch: task.baseBranch } : {}),
    cols: DEFAULT_STARTUP_RESTORE_COLS,
    command: getAgentSpawnCommand(agentDef, store.hydraCommand),
    cwd: task.worktreePath,
    env: getAgentSpawnEnvironment(agentDef, store.hydraStartupMode) ?? {},
    ...(task.projectMode !== undefined ? { projectMode: task.projectMode } : {}),
    resumeOnStart: shouldResumeAgentOnSpawn(agentDef, agent.resumed),
    rows: DEFAULT_STARTUP_RESTORE_ROWS,
    ...(runnerProfile !== undefined ? { runnerProfile } : {}),
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
): EnsureAgentSessionResult[] {
  if (!response || !Array.isArray(response.results)) {
    return [];
  }

  return response.results.filter((result) => result.error !== undefined);
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
      error: failure.error,
      taskId: failure.taskId,
    })),
  );
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
