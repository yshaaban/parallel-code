import type { AgentDef } from "../ipc/types";

export interface Agent {
  id: string;
  taskId: string;
  def: AgentDef;
  status: "running" | "exited";
  exitCode: number | null;
}

export interface Task {
  id: string;
  name: string;
  branchName: string;
  worktreePath: string;
  agentIds: string[];
}

export interface AppStore {
  projectRoot: string | null;
  taskOrder: string[];
  tasks: Record<string, Task>;
  agents: Record<string, Agent>;
  activeTaskId: string | null;
  activeAgentId: string | null;
  availableAgents: AgentDef[];
  showNewTaskDialog: boolean;
}
