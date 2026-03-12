import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setPendingShellCommand } from '../lib/bookmarks';
import { getHydraPromptPanelText, isHydraAgentDef } from '../lib/hydra';
import type { AgentDef, CreateTaskResult, MergeResult } from '../ipc/types';
import { clearAgentSupervisionSnapshots } from './task-attention';
import { recordMergedLines, recordTaskCompleted } from '../store/completion';
import { setTaskFocusedPanel } from '../store/focus';
import {
  getProject,
  getProjectBranchPrefix,
  getProjectPath,
  isProjectMissing,
} from '../store/projects';
import { cleanupPanelEntries, setStore, store, updateWindowTitle } from '../store/core';
import {
  clearAgentActivity,
  isAgentIdle,
  markAgentBusy,
  markAgentSpawned,
  rescheduleTaskStatusPolling,
} from '../store/taskStatus';
import type { Agent, Task } from '../store/types';

const AGENT_WRITE_READY_TIMEOUT_MS = 8_000;
const AGENT_WRITE_RETRY_MS = 50;
const REMOVE_ANIMATION_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAgentNotFoundError(error: unknown): boolean {
  return String(error).toLowerCase().includes('agent not found');
}

async function writeToAgentWhenReady(agentId: string, data: string): Promise<void> {
  const deadline = Date.now() + AGENT_WRITE_READY_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      await invoke(IPC.WriteToAgent, { agentId, data });
      return;
    } catch (error) {
      lastError = error;
      if (!isAgentNotFoundError(error)) throw error;
      const agent = store.agents[agentId];
      if (!agent || agent.status === 'exited') throw error;
      await sleep(AGENT_WRITE_RETRY_MS);
    }
  }

  throw lastError ?? new Error(`Timed out waiting for agent ${agentId} to become writable`);
}

function hasExistingDirectModeTask(projectId: string): boolean {
  const allTaskIds = [...store.taskOrder, ...store.collapsedTaskOrder];
  return allTaskIds.some((taskId) => {
    const task = store.tasks[taskId];
    return (
      task && task.projectId === projectId && task.directMode && task.closingStatus !== 'removing'
    );
  });
}

function deleteRecordEntry<Value>(record: Record<string, Value>, key: string): void {
  Reflect.deleteProperty(record, key);
}

function removeTaskFromStore(taskId: string, agentIds: string[]): void {
  recordTaskCompleted();

  for (const agentId of agentIds) {
    clearAgentActivity(agentId);
  }
  clearAgentSupervisionSnapshots(agentIds);

  setStore('tasks', taskId, 'closingStatus', 'removing');

  setTimeout(() => {
    setStore(
      produce((state) => {
        deleteRecordEntry(state.tasks, taskId);
        deleteRecordEntry(state.taskGitStatus, taskId);

        let neighbor: string | null = null;
        if (state.activeTaskId === taskId) {
          const index = state.taskOrder.indexOf(taskId);
          const filteredOrder = state.taskOrder.filter((id) => id !== taskId);
          const neighborIndex = index <= 0 ? 0 : index - 1;
          neighbor = filteredOrder[neighborIndex] ?? null;
        }

        cleanupPanelEntries(state, taskId);

        if (state.activeTaskId === taskId) {
          state.activeTaskId = neighbor;
          const neighborTask = neighbor ? state.tasks[neighbor] : null;
          state.activeAgentId = neighborTask?.agentIds[0] ?? null;
        }

        for (const agentId of agentIds) {
          deleteRecordEntry(state.agents, agentId);
        }
      }),
    );

    rescheduleTaskStatusPolling();
    const activeId = store.activeTaskId;
    const activeTask = activeId ? store.tasks[activeId] : null;
    const activeTerminal = activeId ? store.terminals[activeId] : null;
    updateWindowTitle(activeTask?.name ?? activeTerminal?.name);
  }, REMOVE_ANIMATION_MS);
}

export interface CreateTaskOptions {
  name: string;
  agentDef: AgentDef;
  projectId: string;
  symlinkDirs?: string[];
  initialPrompt?: string;
  branchPrefixOverride?: string;
  githubUrl?: string;
  skipPermissions?: boolean;
}

export async function createTask(opts: CreateTaskOptions): Promise<string> {
  const {
    name,
    agentDef,
    projectId,
    symlinkDirs = [],
    initialPrompt,
    githubUrl,
    skipPermissions,
  } = opts;
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) throw new Error('Project not found');
  if (isProjectMissing(projectId)) throw new Error('Project folder not found');

  const branchPrefix = opts.branchPrefixOverride ?? getProjectBranchPrefix(projectId);
  const result = await invoke<CreateTaskResult>(IPC.CreateTask, {
    name,
    projectRoot,
    symlinkDirs,
    branchPrefix,
  });

  const agentId = crypto.randomUUID();
  const task: Task = {
    id: result.id,
    name,
    projectId,
    branchName: result.branch_name,
    worktreePath: result.worktree_path,
    agentIds: [agentId],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(skipPermissions ? { skipPermissions: true } : {}),
    ...(githubUrl !== undefined ? { githubUrl } : {}),
    ...(initialPrompt ? { savedInitialPrompt: initialPrompt } : {}),
  };

  const agent: Agent = {
    id: agentId,
    taskId: result.id,
    def: agentDef,
    resumed: false,
    status: 'running',
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
  };

  setStore(
    produce((state) => {
      state.tasks[result.id] = task;
      state.agents[agentId] = agent;
      state.taskOrder.push(result.id);
      state.activeTaskId = result.id;
      state.activeAgentId = agentId;
      state.lastProjectId = projectId;
      state.lastAgentId = agentDef.id;
    }),
  );

  markAgentSpawned(agentId);
  rescheduleTaskStatusPolling();
  updateWindowTitle(name);
  return result.id;
}

export interface CreateDirectTaskOptions {
  name: string;
  agentDef: AgentDef;
  projectId: string;
  mainBranch: string;
  initialPrompt?: string;
  githubUrl?: string;
  skipPermissions?: boolean;
}

export async function createDirectTask(opts: CreateDirectTaskOptions): Promise<string> {
  const { name, agentDef, projectId, mainBranch, initialPrompt, githubUrl, skipPermissions } = opts;
  if (hasExistingDirectModeTask(projectId)) {
    throw new Error('A direct-mode task already exists for this project');
  }

  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) throw new Error('Project not found');
  if (isProjectMissing(projectId)) throw new Error('Project folder not found');

  const id = crypto.randomUUID();
  const agentId = crypto.randomUUID();

  const task: Task = {
    id,
    name,
    projectId,
    branchName: mainBranch,
    worktreePath: projectRoot,
    agentIds: [agentId],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    directMode: true,
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(initialPrompt ? { savedInitialPrompt: initialPrompt } : {}),
    ...(skipPermissions ? { skipPermissions: true } : {}),
    ...(githubUrl !== undefined ? { githubUrl } : {}),
  };

  const agent: Agent = {
    id: agentId,
    taskId: id,
    def: agentDef,
    resumed: false,
    status: 'running',
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
  };

  setStore(
    produce((state) => {
      state.tasks[id] = task;
      state.agents[agentId] = agent;
      state.taskOrder.push(id);
      state.activeTaskId = id;
      state.activeAgentId = agentId;
      state.lastProjectId = projectId;
      state.lastAgentId = agentDef.id;
    }),
  );

  markAgentSpawned(agentId);
  rescheduleTaskStatusPolling();
  updateWindowTitle(name);
  return id;
}

export async function closeTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.closingStatus === 'closing' || task.closingStatus === 'removing') return;

  const agentIds = [...task.agentIds];
  const shellAgentIds = [...task.shellAgentIds];
  const branchName = task.branchName;
  const projectRoot = getProjectPath(task.projectId) ?? '';
  const deleteBranch = getProject(task.projectId)?.deleteBranchOnClose ?? true;

  setStore('tasks', taskId, 'closingStatus', 'closing');
  setStore('tasks', taskId, 'closingError', undefined);

  try {
    for (const agentId of agentIds) {
      await invoke(IPC.KillAgent, { agentId }).catch(console.error);
    }
    for (const shellId of shellAgentIds) {
      await invoke(IPC.KillAgent, { agentId: shellId }).catch(console.error);
    }

    if (!task.directMode) {
      await invoke(IPC.DeleteTask, {
        taskId,
        agentIds: [...agentIds, ...shellAgentIds],
        branchName,
        deleteBranch,
        projectRoot,
        worktreePath: task.worktreePath,
      });
    }

    removeTaskFromStore(taskId, [...agentIds, ...shellAgentIds]);
  } catch (error) {
    console.error('Failed to close task:', error);
    setStore('tasks', taskId, 'closingStatus', 'error');
    setStore('tasks', taskId, 'closingError', String(error));
  }
}

export async function retryCloseTask(taskId: string): Promise<void> {
  setStore('tasks', taskId, 'closingStatus', undefined);
  setStore('tasks', taskId, 'closingError', undefined);
  await closeTask(taskId);
}

export async function mergeTask(
  taskId: string,
  options?: { squash?: boolean; message?: string; cleanup?: boolean },
): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.closingStatus === 'removing' || task.directMode) return;

  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot) return;

  const agentIds = [...task.agentIds];
  const shellAgentIds = [...task.shellAgentIds];
  const branchName = task.branchName;
  const cleanup = options?.cleanup ?? false;

  const mergeResult = await invoke<MergeResult>(IPC.MergeTask, {
    projectRoot,
    branchName,
    squash: options?.squash ?? false,
    message: options?.message,
    cleanup,
  });
  recordMergedLines(mergeResult.lines_added, mergeResult.lines_removed);

  if (cleanup) {
    await Promise.allSettled(
      [...agentIds, ...shellAgentIds].map((id) => invoke(IPC.KillAgent, { agentId: id })),
    );
    removeTaskFromStore(taskId, [...agentIds, ...shellAgentIds]);
  }
}

export async function pushTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.directMode) return;

  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot) return;

  await invoke(IPC.PushTask, {
    projectRoot,
    branchName: task.branchName,
  });
}

export async function sendPrompt(taskId: string, agentId: string, text: string): Promise<void> {
  const agentDef = store.agents[agentId]?.def;
  const translatedText =
    isHydraAgentDef(agentDef) && store.hydraForceDispatchFromPromptPanel
      ? getHydraPromptPanelText(text, true)
      : text;

  await writeToAgentWhenReady(agentId, translatedText);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeToAgentWhenReady(agentId, '\r');
  setStore('tasks', taskId, 'lastPrompt', text);
}

export function spawnShellForTask(taskId: string, initialCommand?: string): string {
  const shellId = crypto.randomUUID();
  if (initialCommand) setPendingShellCommand(shellId, initialCommand);
  markAgentSpawned(shellId);
  setStore(
    produce((state) => {
      const task = state.tasks[taskId];
      if (!task) return;
      task.shellAgentIds.push(shellId);
    }),
  );
  return shellId;
}

export function runBookmarkInTask(taskId: string, command: string): void {
  const task = store.tasks[taskId];
  if (!task) return;

  for (let index = task.shellAgentIds.length - 1; index >= 0; index -= 1) {
    const shellId = task.shellAgentIds[index];
    if (!shellId) continue;
    if (!isAgentIdle(shellId)) continue;

    markAgentBusy(shellId);
    setTaskFocusedPanel(taskId, `shell:${index}`);
    invoke(IPC.WriteToAgent, { agentId: shellId, data: command + '\r' }).catch(() => {
      spawnShellForTask(taskId, command);
    });
    return;
  }

  spawnShellForTask(taskId, command);
}

export async function closeShell(taskId: string, shellId: string): Promise<void> {
  const closedIndex = store.tasks[taskId]?.shellAgentIds.indexOf(shellId) ?? -1;

  await invoke(IPC.KillAgent, { agentId: shellId }).catch(() => {});
  clearAgentActivity(shellId);
  clearAgentSupervisionSnapshots([shellId]);
  setStore(
    produce((state) => {
      const task = state.tasks[taskId];
      if (task) {
        task.shellAgentIds = task.shellAgentIds.filter((id) => id !== shellId);
      }
    }),
  );

  if (closedIndex < 0) return;

  const remaining = store.tasks[taskId]?.shellAgentIds.length ?? 0;
  if (remaining === 0) {
    setTaskFocusedPanel(taskId, 'shell-toolbar');
    return;
  }

  const focusIndex = Math.min(closedIndex, remaining - 1);
  setTaskFocusedPanel(taskId, `shell:${focusIndex}`);
}

export async function collapseTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.collapsed || task.closingStatus) return;

  const firstAgent = task.agentIds[0] ? store.agents[task.agentIds[0]] : null;
  const agentDef = firstAgent?.def;
  const agentIds = [...task.agentIds];
  const shellAgentIds = [...task.shellAgentIds];

  for (const agentId of agentIds) {
    await invoke(IPC.KillAgent, { agentId }).catch(console.error);
    clearAgentActivity(agentId);
  }
  for (const shellId of shellAgentIds) {
    await invoke(IPC.KillAgent, { agentId: shellId }).catch(console.error);
    clearAgentActivity(shellId);
  }
  clearAgentSupervisionSnapshots([...agentIds, ...shellAgentIds]);

  setStore(
    produce((state) => {
      if (!state.tasks[taskId]) return;
      state.tasks[taskId].collapsed = true;
      if (agentDef) {
        state.tasks[taskId].savedAgentDef = agentDef;
      } else {
        delete state.tasks[taskId].savedAgentDef;
      }
      state.tasks[taskId].agentIds = [];
      state.tasks[taskId].shellAgentIds = [];
      const index = state.taskOrder.indexOf(taskId);
      if (index !== -1) state.taskOrder.splice(index, 1);
      state.collapsedTaskOrder.push(taskId);

      for (const agentId of agentIds) {
        deleteRecordEntry(state.agents, agentId);
      }

      if (state.activeTaskId === taskId) {
        const neighbor = state.taskOrder[Math.max(0, index - 1)] ?? null;
        state.activeTaskId = neighbor;
        const neighborTask = neighbor ? state.tasks[neighbor] : null;
        state.activeAgentId = neighborTask?.agentIds[0] ?? null;
      }
    }),
  );

  rescheduleTaskStatusPolling();
  const activeId = store.activeTaskId;
  const activeTask = activeId ? store.tasks[activeId] : null;
  const activeTerminal = activeId ? store.terminals[activeId] : null;
  updateWindowTitle(activeTask?.name ?? activeTerminal?.name);
}

export function uncollapseTask(taskId: string): void {
  const task = store.tasks[taskId];
  if (!task || !task.collapsed) return;

  const savedDef = task.savedAgentDef;
  const agentId = savedDef ? crypto.randomUUID() : null;

  setStore(
    produce((state) => {
      const currentTask = state.tasks[taskId];
      if (!currentTask) return;
      currentTask.collapsed = false;
      state.collapsedTaskOrder = state.collapsedTaskOrder.filter((id) => id !== taskId);
      state.taskOrder.push(taskId);
      state.activeTaskId = taskId;

      if (agentId && savedDef) {
        const agent: Agent = {
          id: agentId,
          taskId,
          def: savedDef,
          resumed: true,
          status: 'running',
          exitCode: null,
          signal: null,
          lastOutput: [],
          generation: 0,
        };
        state.agents[agentId] = agent;
        currentTask.agentIds = [agentId];
        delete currentTask.savedAgentDef;
      }

      state.activeAgentId = currentTask.agentIds[0] ?? null;
    }),
  );

  if (agentId) {
    markAgentSpawned(agentId);
    rescheduleTaskStatusPolling();
  }

  updateWindowTitle(task.name);
}
