import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import type { WorktreeStatus } from '../ipc/types';
import { markAutosaveClean } from '../store/autosave';
import { applyGitStatusFromPush } from '../store/taskStatus';
import {
  getProjectPath,
  loadState,
  markAgentExited,
  markAgentRunning,
  refreshTaskStatus,
  setAgentStatus,
  showNotification,
  store,
  validateProjectPaths,
} from '../store/store';

export type RuntimeAgentStatus = 'running' | 'paused' | 'flow-controlled' | 'restoring' | 'exited';

export interface AgentStatusMessage {
  agentId: string;
  status: RuntimeAgentStatus;
}

export interface AgentLifecycleMessage {
  agentId: string;
  event: 'spawn' | 'exit' | 'pause' | 'resume';
  exitCode?: number | null;
  signal?: string | null;
  status?: RuntimeAgentStatus;
}

export interface GitStatusServerEvent {
  branchName?: string;
  projectRoot?: string;
  worktreePath?: string;
}

const BROWSER_SYNC_FAILURE_MESSAGE = 'Failed to sync browser state from server';

function getMissingAgentSessionsMessage(missingCount: number): string {
  if (missingCount === 1) {
    return '1 agent session ended while the server was unavailable';
  }
  return `${missingCount} agent sessions ended while the server was unavailable`;
}

export function getLifecycleStatusOrFallback(
  status: RuntimeAgentStatus | undefined,
  fallback: 'running' | 'paused',
): 'running' | 'paused' | 'flow-controlled' | 'restoring' {
  if (!status || status === 'exited') return fallback;
  return status;
}

export function createBrowserStateSync(electronRuntime: boolean): {
  cleanupBrowserStateSyncTimer: () => void;
  scheduleBrowserStateSync: (delayMs?: number, notify?: boolean) => void;
  syncBrowserStateFromServer: (notify?: boolean) => Promise<void>;
} {
  let stateSyncTimer: number | undefined;

  async function syncBrowserStateFromServer(notify = false): Promise<void> {
    try {
      await loadState();
      markAutosaveClean();
      await validateProjectPaths();
      if (notify) showNotification('State updated in another browser tab');
    } catch (error) {
      console.warn('Failed to sync browser state from server:', error);
      showNotification(BROWSER_SYNC_FAILURE_MESSAGE);
    }
  }

  function scheduleBrowserStateSync(delayMs = 0, notify = false): void {
    if (electronRuntime) return;
    if (stateSyncTimer !== undefined) clearTimeout(stateSyncTimer);
    stateSyncTimer = window.setTimeout(() => {
      stateSyncTimer = undefined;
      void syncBrowserStateFromServer(notify);
    }, delayMs);
  }

  function cleanupBrowserStateSyncTimer(): void {
    if (stateSyncTimer !== undefined) {
      clearTimeout(stateSyncTimer);
      stateSyncTimer = undefined;
    }
  }

  return {
    cleanupBrowserStateSyncTimer,
    scheduleBrowserStateSync,
    syncBrowserStateFromServer,
  };
}

export function refreshGitStatusFromServerEvent(message: GitStatusServerEvent): void {
  const seen = new Set<string>();
  for (const task of Object.values(store.tasks)) {
    if (seen.has(task.id)) continue;

    const matchesWorktree =
      typeof message.worktreePath === 'string' && task.worktreePath === message.worktreePath;
    const matchesBranch =
      typeof message.branchName === 'string' &&
      task.branchName === message.branchName &&
      (message.projectRoot === undefined || getProjectPath(task.projectId) === message.projectRoot);
    const matchesProject =
      typeof message.projectRoot === 'string' &&
      getProjectPath(task.projectId) === message.projectRoot;

    if (matchesWorktree || matchesBranch || matchesProject) {
      seen.add(task.id);
      refreshTaskStatus(task.id);
    }
  }
}

export function handleAgentLifecycleMessage(message: AgentLifecycleMessage): void {
  if (message.event === 'exit') {
    markAgentExited(message.agentId, {
      exit_code: message.exitCode ?? null,
      signal: message.signal ?? null,
      last_output: [],
    });
    return;
  }

  if (message.event === 'pause') {
    setAgentStatus(message.agentId, getLifecycleStatusOrFallback(message.status, 'paused'));
    return;
  }

  if (message.event === 'spawn' || message.event === 'resume') {
    setAgentStatus(message.agentId, getLifecycleStatusOrFallback(message.status, 'running'));
  }
}

export async function reconcileRunningAgents(notifyIfChanged = false): Promise<void> {
  const activeAgentIds = await invoke<string[]>(IPC.ListRunningAgentIds).catch(() => null);
  if (!activeAgentIds) return;

  const activeSet = new Set(activeAgentIds);
  let missingCount = 0;
  for (const agent of Object.values(store.agents)) {
    if (activeSet.has(agent.id)) {
      if (agent.status === 'exited') {
        markAgentRunning(agent.id);
      }
      continue;
    }

    if (agent.status !== 'exited') {
      missingCount += 1;
      markAgentExited(agent.id, {
        exit_code: null,
        signal: 'server_unavailable',
        last_output: [],
      });
    }
  }

  if (notifyIfChanged && missingCount > 0) {
    showNotification(getMissingAgentSessionsMessage(missingCount));
  }
}

export function syncAgentStatusesFromServer(agents: AgentStatusMessage[]): void {
  for (const agent of agents) {
    if (!store.agents[agent.agentId] || agent.status === 'exited') continue;
    setAgentStatus(agent.agentId, agent.status);
  }
}

export function handleGitWatcherUpdate(message: {
  worktreePath?: string;
  status?: WorktreeStatus;
}): void {
  if (!message.worktreePath) return;
  if (message.status) {
    applyGitStatusFromPush(message.worktreePath, message.status);
    return;
  }

  refreshGitStatusFromServerEvent({ worktreePath: message.worktreePath });
}
