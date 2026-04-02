import type { AgentDef } from '../ipc/types.js';
import type { HydraStartupMode } from '../lib/hydra.js';
import type { Project, Task, Terminal } from '../store/types.js';

export interface BrowserColdBootstrapProjection {
  availableAgents: AgentDef[];
  collapsedTaskOrder: string[];
  completedTaskCount: number;
  completedTaskDate: string;
  customAgents: AgentDef[];
  hydraCommand: string;
  hydraForceDispatchFromPromptPanel: boolean;
  hydraStartupMode: HydraStartupMode;
  lastProjectId: string | null;
  mergedLinesAdded: number;
  mergedLinesRemoved: number;
  projects: Project[];
  taskOrder: string[];
  tasks: Record<string, Task>;
  terminals: Record<string, Terminal>;
}
