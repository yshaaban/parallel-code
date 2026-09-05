import type { AgentDef } from '../ipc/types';

export type ManualAgentSessionAction =
  | { kind: 'restart' }
  | { kind: 'resume' }
  | { agentDef: AgentDef; kind: 'switch' };
