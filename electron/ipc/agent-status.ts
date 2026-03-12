import { getRemoteAgentStatus, type AgentStatusSnapshot } from '../../src/domain/server-state.js';
import { getAgentMeta, getAgentPauseState } from './pty.js';

export type { AgentStatusSnapshot } from '../../src/domain/server-state.js';

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
