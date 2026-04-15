import type { AgentDef } from '../ipc/types.js';

export interface BrowserColdBootstrapProjectionBuildOptions {
  currentAvailableAgents: ReadonlyArray<AgentDef>;
  currentCustomAgents: ReadonlyArray<AgentDef>;
}
