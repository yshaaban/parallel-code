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
import type { Agent, Project, Task } from '../store/types';

type EnsureAgentSessionsBatchRequest = RendererInvokeRequestMap[IPC.EnsureAgentSessionsBatch];
type EnsureAgentSessionsBatchReason = EnsureAgentSessionsBatchRequest['reason'];
type EnsureAgentSessionRequest = EnsureAgentSessionsBatchRequest['requests'][number];
type EnsureAgentSessionResult =
  RendererInvokeResponseMap[IPC.EnsureAgentSessionsBatch]['results'][number];

const DEFAULT_STARTUP_RESTORE_COLS = 80;
const DEFAULT_STARTUP_RESTORE_ROWS = 24;

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

function getOrderedTaskAgentIds(task: Task): string[] {
  const agentIds = Array.isArray(task.agentIds) ? task.agentIds : [];
  const preferredAgentId =
    store.activeTaskId === task.id
      ? (store.activeAgentId ?? task.selectedAgentId)
      : task.selectedAgentId;
  if (!preferredAgentId || !agentIds.includes(preferredAgentId)) {
    return agentIds;
  }

  return [preferredAgentId, ...agentIds.filter((agentId) => agentId !== preferredAgentId)];
}

function appendStartupRestoreAgentSessionRequests(
  taskId: string,
  requests: EnsureAgentSessionRequest[],
  seenAgentIds: Set<string>,
): void {
  const task = store.tasks[taskId];
  if (!task || task.collapsed) {
    return;
  }

  for (const agentId of getOrderedTaskAgentIds(task)) {
    if (seenAgentIds.has(agentId)) {
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

function collectStartupRestoreAgentSessionRequests(): EnsureAgentSessionRequest[] {
  const requests: EnsureAgentSessionRequest[] = [];
  const seenAgentIds = new Set<string>();

  if (store.activeTaskId) {
    appendStartupRestoreAgentSessionRequests(store.activeTaskId, requests, seenAgentIds);
  }

  for (const taskId of store.taskOrder) {
    appendStartupRestoreAgentSessionRequests(taskId, requests, seenAgentIds);
  }

  return requests;
}

function getBatchEnsureFailures(
  response: RendererInvokeResponseMap[IPC.EnsureAgentSessionsBatch] | null | undefined,
): EnsureAgentSessionResult[] {
  if (!response || !Array.isArray(response.results)) {
    return [];
  }

  return response.results.filter((result) => result.error !== undefined);
}

async function ensureAgentSessionsForStartupRestore(): Promise<void> {
  const requests = collectStartupRestoreAgentSessionRequests();
  if (requests.length === 0) {
    return;
  }

  const reason: EnsureAgentSessionsBatchReason = 'startup-restore';
  const response = await invoke(IPC.EnsureAgentSessionsBatch, {
    reason,
    requests,
  });
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

export function startStartupRestoreAgentSessionEnsure(): void {
  void ensureAgentSessionsForStartupRestore().catch((error) => {
    console.warn('[terminal] Failed to prewarm restored agent sessions:', error);
  });
}
