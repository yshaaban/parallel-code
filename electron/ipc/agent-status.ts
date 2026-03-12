import { getRemoteAgentStatus, type RemoteAgentStatus } from '../remote/protocol.js';
import { getAgentMeta, getAgentPauseState } from './pty.js';

export interface AgentStatusSnapshot {
  exitCode: number | null;
  lastLine: string;
  status: RemoteAgentStatus;
}

export function getAgentStatusSnapshot(agentId: string): AgentStatusSnapshot {
  const meta = getAgentMeta(agentId);
  if (!meta) {
    return {
      exitCode: null,
      lastLine: '',
      status: 'exited',
    };
  }

  return {
    exitCode: null,
    lastLine: '',
    status: getRemoteAgentStatus(getAgentPauseState(agentId)),
  };
}
