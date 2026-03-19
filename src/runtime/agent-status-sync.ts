import { IPC } from '../../electron/ipc/channels';
import { assertNever } from '../lib/assert-never';
import {
  isExitedRemoteAgentStatus,
  resolveRemoteLifecycleStatus,
  type AgentLifecycleEvent,
  type RemoteAgentStatus,
} from '../domain/server-state';
import { invoke } from '../lib/ipc';
import { markAgentExited, markAgentRunning, setAgentStatus } from '../store/agents';
import { showNotification } from '../store/notification';
import { store } from '../store/state';

export type RuntimeAgentStatus = RemoteAgentStatus;

export interface AgentStatusMessage {
  agentId: string;
  status: RuntimeAgentStatus;
}

function getMissingAgentSessionsMessage(missingCount: number): string {
  if (missingCount === 1) {
    return '1 agent session ended while the server was unavailable';
  }
  return `${missingCount} agent sessions ended while the server was unavailable`;
}

export function handleAgentLifecycleMessage(message: AgentLifecycleEvent): void {
  switch (message.event) {
    case 'exit':
      markAgentExited(message.agentId, {
        exit_code: message.exitCode ?? null,
        signal: message.signal ?? null,
        last_output: [],
      });
      return;
    case 'pause':
      setAgentStatus(message.agentId, resolveRemoteLifecycleStatus(message.status, 'paused'));
      return;
    case 'spawn':
    case 'resume':
      setAgentStatus(message.agentId, resolveRemoteLifecycleStatus(message.status, 'running'));
      return;
    default:
      return assertNever(message.event, 'Unhandled agent lifecycle event');
  }
}

export function reconcileRunningAgentIds(activeAgentIds: string[], notifyIfChanged = false): void {
  const activeSet = new Set(activeAgentIds);
  let missingCount = 0;
  for (const agent of Object.values(store.agents)) {
    if (activeSet.has(agent.id)) {
      if (isExitedRemoteAgentStatus(agent.status)) {
        markAgentRunning(agent.id);
      }
      continue;
    }
    if (!isExitedRemoteAgentStatus(agent.status)) {
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

export async function reconcileRunningAgents(notifyIfChanged = false): Promise<void> {
  const activeAgentIds = await invoke(IPC.ListRunningAgentIds).catch(() => null);
  if (!activeAgentIds) {
    return;
  }

  reconcileRunningAgentIds(activeAgentIds, notifyIfChanged);
}

export function syncAgentStatusesFromServer(
  agents: Array<{
    agentId: string;
    status: RemoteAgentStatus;
  }>,
): void {
  for (const { agentId, status } of agents) {
    const current = store.agents[agentId];
    if (
      !current ||
      isExitedRemoteAgentStatus(current.status) ||
      isExitedRemoteAgentStatus(status)
    ) {
      continue;
    }

    setAgentStatus(agentId, status);
  }
}
