import type { AgentDef } from '../ipc/types.js';
import type { HydraStartupMode } from '../lib/hydra.js';
import type { Project, Task, Terminal } from '../store/types.js';
import type { CommittedMergeOperationMarker, MergeProgressSnapshot } from './task-merge.js';

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
  committedMergeOperationId?: string;
  mergeOperation?: CommittedMergeOperationMarker;
  mergeProgress: MergeProgressSnapshot | null;
  projects: Project[];
  taskOrder: string[];
  tasks: Record<string, Task>;
  terminals: Record<string, Terminal>;
}
