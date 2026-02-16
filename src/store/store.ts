import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import type { AgentDef, CreateTaskResult } from "../ipc/types";
import type { AppStore, Agent, Task } from "./types";

const [store, setStore] = createStore<AppStore>({
  projectRoot: null,
  taskOrder: [],
  tasks: {},
  agents: {},
  activeTaskId: null,
  activeAgentId: null,
  availableAgents: [],
  showNewTaskDialog: false,
});

export { store };

export async function loadAgents(): Promise<void> {
  const agents = await invoke<AgentDef[]>("list_agents");
  setStore("availableAgents", agents);
}

export async function setProjectRoot(path: string): Promise<void> {
  await invoke("set_project_root", { path });
  setStore("projectRoot", path);
}

export async function createTask(
  name: string,
  agentDef: AgentDef
): Promise<void> {
  const result = await invoke<CreateTaskResult>("create_task", { name });

  const agentId = crypto.randomUUID();
  const task: Task = {
    id: result.id,
    name,
    branchName: result.branch_name,
    worktreePath: result.worktree_path,
    agentIds: [agentId],
  };

  const agent: Agent = {
    id: agentId,
    taskId: result.id,
    def: agentDef,
    status: "running",
    exitCode: null,
  };

  setStore(
    produce((s) => {
      s.tasks[result.id] = task;
      s.agents[agentId] = agent;
      s.taskOrder.push(result.id);
      s.activeTaskId = result.id;
      s.activeAgentId = agentId;
    })
  );
}

export async function addAgentToTask(
  taskId: string,
  agentDef: AgentDef
): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  const agentId = crypto.randomUUID();
  const agent: Agent = {
    id: agentId,
    taskId,
    def: agentDef,
    status: "running",
    exitCode: null,
  };

  setStore(
    produce((s) => {
      s.agents[agentId] = agent;
      s.tasks[taskId].agentIds.push(agentId);
      s.activeAgentId = agentId;
    })
  );
}

export function markAgentExited(agentId: string, code: number | null): void {
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].status = "exited";
        s.agents[agentId].exitCode = code;
      }
    })
  );
}

export async function closeTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  // Kill all agents in this task
  for (const agentId of task.agentIds) {
    await invoke("kill_agent", { agentId }).catch(() => {});
  }

  // Delete worktree
  await invoke("delete_task", { taskId, deleteBranch: false }).catch(() => {});

  setStore(
    produce((s) => {
      // Remove agents
      for (const agentId of task.agentIds) {
        delete s.agents[agentId];
      }
      // Remove task
      delete s.tasks[taskId];
      s.taskOrder = s.taskOrder.filter((id) => id !== taskId);

      // Update active
      if (s.activeTaskId === taskId) {
        s.activeTaskId = s.taskOrder[0] ?? null;
        const firstTask = s.activeTaskId ? s.tasks[s.activeTaskId] : null;
        s.activeAgentId = firstTask?.agentIds[0] ?? null;
      }
    })
  );
}

export function setActiveTask(taskId: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  setStore("activeTaskId", taskId);
  setStore("activeAgentId", task.agentIds[0] ?? null);
}

export function setActiveAgent(agentId: string): void {
  setStore("activeAgentId", agentId);
}

export function toggleNewTaskDialog(show?: boolean): void {
  setStore("showNewTaskDialog", show ?? !store.showNewTaskDialog);
}

export function navigateTask(direction: "left" | "right"): void {
  const { taskOrder, activeTaskId } = store;
  if (taskOrder.length === 0) return;
  const idx = activeTaskId ? taskOrder.indexOf(activeTaskId) : -1;
  const next =
    direction === "left"
      ? Math.max(0, idx - 1)
      : Math.min(taskOrder.length - 1, idx + 1);
  setActiveTask(taskOrder[next]);
}

export function navigateAgent(direction: "up" | "down"): void {
  const { activeTaskId, activeAgentId } = store;
  if (!activeTaskId) return;
  const task = store.tasks[activeTaskId];
  if (!task) return;
  const idx = activeAgentId ? task.agentIds.indexOf(activeAgentId) : -1;
  const next =
    direction === "up"
      ? Math.max(0, idx - 1)
      : Math.min(task.agentIds.length - 1, idx + 1);
  setStore("activeAgentId", task.agentIds[next]);
}
