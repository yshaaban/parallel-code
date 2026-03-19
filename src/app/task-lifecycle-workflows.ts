import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import {
  hasProjectDirectModeTask,
  hasTaskClosingState,
  isTaskCloseInProgress,
  isTaskRemoving,
} from '../domain/task-closing';
import type { AgentDef } from '../ipc/types';
import { recordMergedLines, recordTaskCompleted } from '../store/completion';
import {
  getProject,
  getProjectBranchPrefix,
  getProjectPath,
  isProjectMissing,
} from '../store/projects';
import { setStore, store, updateWindowTitle } from '../store/state';
import { removeAgentScopedStoreState, removeTaskStoreState } from '../store/task-state-cleanup';
import { clearAgentActivity, markAgentSpawned } from '../store/taskStatus';
import type { Agent, Task } from '../store/types';
import { clearTaskConvergence } from './task-convergence';
import { isTaskCommandLeaseSkipped, runWithTaskCommandLease } from './task-command-lease';
import {
  clearTaskCloseState,
  markTaskCloseError,
  markTaskClosing,
  markTaskRemoving,
} from './task-close-state';
import { createPushOutputBinding } from './task-output-channels';
import { clearTaskReview } from './task-review-state';
import { clearAgentSupervisionSnapshots } from './task-attention';

const REMOVE_ANIMATION_MS = 300;

function removeTaskFromStore(taskId: string, agentIds: string[]): void {
  recordTaskCompleted();

  for (const agentId of agentIds) {
    clearAgentActivity(agentId);
  }
  clearAgentSupervisionSnapshots(agentIds);
  clearTaskConvergence(taskId);
  clearTaskReview(taskId);

  markTaskRemoving(taskId);

  setTimeout(() => {
    setStore(
      produce((state) => {
        let neighbor: string | null = null;
        if (state.activeTaskId === taskId) {
          const index = state.taskOrder.indexOf(taskId);
          const filteredOrder = state.taskOrder.filter((id) => id !== taskId);
          const neighborIndex = index <= 0 ? 0 : index - 1;
          neighbor = filteredOrder[neighborIndex] ?? null;
        }

        removeTaskStoreState(state, taskId);

        if (state.activeTaskId === taskId) {
          state.activeTaskId = neighbor;
          const neighborTask = neighbor ? state.tasks[neighbor] : null;
          state.activeAgentId = neighborTask?.agentIds[0] ?? null;
        }

        removeAgentScopedStoreState(state, agentIds);
      }),
    );

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
  if (!projectRoot) {
    throw new Error('Project not found');
  }
  if (isProjectMissing(projectId)) {
    throw new Error('Project folder not found');
  }

  const branchPrefix = opts.branchPrefixOverride ?? getProjectBranchPrefix(projectId);
  const result = await invoke(IPC.CreateTask, {
    name,
    projectId,
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
  if (
    hasProjectDirectModeTask(
      [...store.taskOrder, ...store.collapsedTaskOrder],
      store.tasks,
      projectId,
    )
  ) {
    throw new Error('A direct-mode task already exists for this project');
  }

  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) {
    throw new Error('Project not found');
  }
  if (isProjectMissing(projectId)) {
    throw new Error('Project folder not found');
  }

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
  updateWindowTitle(name);
  return id;
}

export async function closeTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || isTaskCloseInProgress(task)) {
    return;
  }

  const result = await runWithTaskCommandLease(taskId, 'close this task', async () => {
    const agentIds = [...task.agentIds];
    const shellAgentIds = [...task.shellAgentIds];
    const branchName = task.branchName;
    const projectRoot = getProjectPath(task.projectId) ?? '';
    const deleteBranch = getProject(task.projectId)?.deleteBranchOnClose ?? true;

    markTaskClosing(taskId);

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
          controllerId: getRuntimeClientId(),
          deleteBranch,
          projectRoot,
          worktreePath: task.worktreePath,
        });
      }

      removeTaskFromStore(taskId, [...agentIds, ...shellAgentIds]);
    } catch (error) {
      console.error('Failed to close task:', error);
      markTaskCloseError(taskId, String(error));
    }
  });

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }
}

export async function retryCloseTask(taskId: string): Promise<void> {
  clearTaskCloseState(taskId);
  await closeTask(taskId);
}

export async function mergeTask(
  taskId: string,
  options?: { squash?: boolean; message?: string; cleanup?: boolean },
): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || isTaskRemoving(task) || task.directMode) {
    return;
  }

  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot) {
    return;
  }

  const result = await runWithTaskCommandLease(taskId, 'merge this task', async () => {
    const agentIds = [...task.agentIds];
    const shellAgentIds = [...task.shellAgentIds];
    const branchName = task.branchName;
    const cleanup = options?.cleanup ?? false;

    const mergeResult = await invoke(IPC.MergeTask, {
      projectRoot,
      branchName,
      squash: options?.squash ?? false,
      cleanup,
      controllerId: getRuntimeClientId(),
      taskId,
      ...(options?.message !== undefined ? { message: options.message } : {}),
    });
    recordMergedLines(mergeResult.lines_added, mergeResult.lines_removed);

    if (cleanup) {
      await Promise.allSettled(
        [...agentIds, ...shellAgentIds].map((id) => invoke(IPC.KillAgent, { agentId: id })),
      );
      removeTaskFromStore(taskId, [...agentIds, ...shellAgentIds]);
    }
  });

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }
}

export async function pushTask(taskId: string, onOutput?: (text: string) => void): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.directMode) {
    return;
  }

  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot) {
    return;
  }

  const result = await runWithTaskCommandLease(taskId, 'push this task', async () => {
    const { channel, cleanup } = createPushOutputBinding(onOutput);

    try {
      await invoke(IPC.PushTask, {
        projectRoot,
        branchName: task.branchName,
        controllerId: getRuntimeClientId(),
        taskId,
        ...(channel ? { onOutput: channel } : {}),
      });
    } finally {
      cleanup();
    }
  });

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }
}

export async function collapseTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || task.collapsed || hasTaskClosingState(task)) {
    return;
  }

  const result = await runWithTaskCommandLease(taskId, 'collapse this task', async () => {
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
        if (!state.tasks[taskId]) {
          return;
        }

        state.tasks[taskId].collapsed = true;
        if (agentDef) {
          state.tasks[taskId].savedAgentDef = agentDef;
        } else {
          delete state.tasks[taskId].savedAgentDef;
        }
        state.tasks[taskId].agentIds = [];
        state.tasks[taskId].shellAgentIds = [];
        const index = state.taskOrder.indexOf(taskId);
        if (index !== -1) {
          state.taskOrder.splice(index, 1);
        }
        state.collapsedTaskOrder.push(taskId);

        removeAgentScopedStoreState(state, [...agentIds, ...shellAgentIds]);

        if (state.activeTaskId === taskId) {
          const neighbor = state.taskOrder[Math.max(0, index - 1)] ?? null;
          state.activeTaskId = neighbor;
          const neighborTask = neighbor ? state.tasks[neighbor] : null;
          state.activeAgentId = neighborTask?.agentIds[0] ?? null;
        }
      }),
    );

    const activeId = store.activeTaskId;
    const activeTask = activeId ? store.tasks[activeId] : null;
    const activeTerminal = activeId ? store.terminals[activeId] : null;
    updateWindowTitle(activeTask?.name ?? activeTerminal?.name);
  });

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }
}

export async function uncollapseTask(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || !task.collapsed) {
    return;
  }

  const result = await runWithTaskCommandLease(taskId, 'restore this task', async () => {
    const savedDef = task.savedAgentDef;
    const agentId = savedDef ? crypto.randomUUID() : null;

    setStore(
      produce((state) => {
        const currentTask = state.tasks[taskId];
        if (!currentTask) {
          return;
        }

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
    }

    updateWindowTitle(task.name);
  });

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }
}
