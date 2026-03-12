import type { AgentStatusSnapshot } from '../../src/domain/server-state.js';
import { getRemoteAgentStatus, type RemoteAgent } from './protocol.js';
import { getActiveAgentIds, getAgentMeta, getAgentPauseState } from '../ipc/pty.js';

export interface BuildRemoteAgentListOptions {
  getTaskName: (taskId: string) => string;
  getAgentStatus?: (agentId: string) => AgentStatusSnapshot;
}

function getDefaultAgentStatus(): AgentStatusSnapshot {
  return {
    exitCode: null,
    lastLine: '',
    status: 'running',
  };
}

export function buildRemoteAgentList(options: BuildRemoteAgentListOptions): RemoteAgent[] {
  const byTask = new Map<string, RemoteAgent>();

  for (const agentId of getActiveAgentIds()) {
    const meta = getAgentMeta(agentId);
    if (!meta || meta.isShell) continue;

    const pauseReason = getAgentPauseState(agentId);
    const snapshot = options.getAgentStatus?.(agentId) ?? getDefaultAgentStatus();
    const agent: RemoteAgent = {
      agentId,
      taskId: meta.taskId,
      taskName: options.getTaskName(meta.taskId),
      status: getRemoteAgentStatus(pauseReason, snapshot.status),
      exitCode: snapshot.exitCode,
      lastLine: snapshot.lastLine,
    };

    const current = byTask.get(meta.taskId);
    if (!current || (agent.status === 'running' && current.status !== 'running')) {
      byTask.set(meta.taskId, agent);
    }
  }

  return Array.from(byTask.values());
}
