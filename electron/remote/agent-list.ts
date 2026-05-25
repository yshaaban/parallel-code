import type { AgentStatusSnapshot, RemoteAgentTaskMeta } from '../../src/domain/server-state.js';
import { getRemoteAgentStatus, type RemoteAgent } from './protocol.js';
import { getActiveAgentIds, getAgentMeta, getAgentPauseState } from '../ipc/pty.js';

export interface BuildRemoteAgentListOptions {
  getTaskName: (taskId: string) => string;
  getAgentStatus?: (agentId: string) => AgentStatusSnapshot;
  getTaskMetadata?: (taskId: string, agentId: string) => RemoteAgentTaskMeta | null;
}

function getDefaultAgentStatus(): AgentStatusSnapshot {
  return {
    exitCode: null,
    lastLine: '',
    status: 'running',
  };
}

export function buildRemoteAgentList(options: BuildRemoteAgentListOptions): RemoteAgent[] {
  const agents: RemoteAgent[] = [];

  for (const agentId of getActiveAgentIds()) {
    const meta = getAgentMeta(agentId);
    if (!meta || meta.isShell) continue;

    const pauseReason = getAgentPauseState(agentId);
    const snapshot = options.getAgentStatus?.(agentId) ?? getDefaultAgentStatus();
    const taskMeta = options.getTaskMetadata?.(meta.taskId, agentId) ?? null;
    const agent: RemoteAgent = {
      agentId,
      taskId: meta.taskId,
      taskName: options.getTaskName(meta.taskId),
      status: getRemoteAgentStatus(pauseReason, snapshot.status),
      exitCode: snapshot.exitCode,
      lastLine: snapshot.lastLine,
      ...(meta.runnerIdentity !== undefined
        ? {
            runnerInstanceId: meta.runnerIdentity.runnerInstanceId,
            runnerProvider: meta.runnerIdentity.provider,
          }
        : {}),
      ...(taskMeta ? { taskMeta } : {}),
    };

    agents.push(agent);
  }

  return agents;
}
