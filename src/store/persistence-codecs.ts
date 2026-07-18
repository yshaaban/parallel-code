import { isElectronRuntime } from '../lib/ipc';
import type { AgentDef } from '../ipc/types';
import { isTaskRemoving, isTerminalRemoving } from '../domain/task-closing';
import { normalizeBaseBranch } from '../lib/base-branch.js';
import { store } from './core';
import { buildElectronLocalShellPreferences } from './local-shell-preferences';
import type {
  PersistedState,
  PersistedTask,
  PersistedTaskExposedPort,
  PersistedTerminal,
  Project,
  Task,
  Terminal,
  WorkspaceSharedState,
} from './types';
import {
  buildProjectGitIsolationFields,
  clearProjectGitFields,
  getTaskWorktreeOwnership,
  getTaskGitIsolation,
  normalizeTaskBaseBranch,
} from './task-git-isolation';
import {
  buildProjectModeFields,
  buildTaskProjectModeFields,
  getProjectMode,
  isNonGitProject,
} from './project-mode';
import { getSelectedTaskAgentId } from './task-agent-selection';

function getPrimaryAgentDef(task: Task, fallbackAgentDefs: AgentDef[] = []): AgentDef | null {
  const agentId = task.agentIds[0];
  if (!agentId) {
    return fallbackAgentDefs[0] ?? null;
  }

  return store.agents[agentId]?.def ?? null;
}

function getCompleteTaskAgentDefs(
  task: Task,
  fallbackAgentDefs: AgentDef[] = [],
): AgentDef[] | null {
  if (task.agentIds.length === 0) {
    return fallbackAgentDefs.length > 0 ? fallbackAgentDefs : null;
  }

  const agentDefs: AgentDef[] = [];
  for (const agentId of task.agentIds) {
    const agentDef = store.agents[agentId]?.def;
    if (!agentDef) {
      return null;
    }

    agentDefs.push(agentDef);
  }

  return agentDefs;
}

function buildPersistedExposedPorts(taskId: string): PersistedTaskExposedPort[] | undefined {
  const exposedPorts = store.taskPorts[taskId]?.exposed;
  if (!exposedPorts || exposedPorts.length === 0) {
    return undefined;
  }

  return exposedPorts.map((port) => ({
    port: port.port,
    ...(port.host !== null ? { host: port.host } : {}),
    ...(port.label !== null ? { label: port.label } : {}),
    ...(port.protocol !== 'http' ? { protocol: port.protocol } : {}),
    ...(port.source !== 'manual' ? { source: port.source } : {}),
  }));
}

function buildPersistedProject(project: Project): Project {
  const persistedProject: Project = {
    ...project,
    ...buildProjectModeFields(project),
    ...buildProjectGitIsolationFields(project),
  };
  if (isNonGitProject(persistedProject)) {
    clearProjectGitFields(persistedProject);
    return persistedProject;
  }

  const baseBranch = normalizeBaseBranch(project.baseBranch);
  if (baseBranch !== undefined) {
    persistedProject.baseBranch = baseBranch;
  } else {
    delete persistedProject.baseBranch;
  }
  if (persistedProject.projectMode !== 'non-git') {
    delete persistedProject.projectMode;
  }
  delete persistedProject.defaultDirectMode;
  return persistedProject;
}

function buildPersistedTask(
  task: Task,
  options?: { collapsed?: boolean; fallbackAgentDefs?: AgentDef[] },
): PersistedTask {
  const exposedPorts = buildPersistedExposedPorts(task.id);
  const taskProjectMode = getProjectMode(task);
  const baseBranch = taskProjectMode === 'git' ? normalizeTaskBaseBranch(task) : undefined;
  const gitIsolation = taskProjectMode === 'git' ? getTaskGitIsolation(task) : undefined;
  const worktreeOwnership = taskProjectMode === 'git' ? getTaskWorktreeOwnership(task) : undefined;
  const fallbackAgentDefs = options?.fallbackAgentDefs ?? [];
  const agentDefs = getCompleteTaskAgentDefs(task, fallbackAgentDefs);
  const hasCompleteActiveMultiAgentDefs =
    task.agentIds.length > 1 && agentDefs?.length === task.agentIds.length;
  const hasCompleteCollapsedMultiAgentDefs =
    options?.collapsed === true &&
    task.agentIds.length === 0 &&
    fallbackAgentDefs.length > 1 &&
    agentDefs?.length === fallbackAgentDefs.length;
  const shouldPersistAgentDefs =
    hasCompleteActiveMultiAgentDefs || hasCompleteCollapsedMultiAgentDefs;
  const selectedAgentId =
    task.agentIds.length <= 1 || hasCompleteActiveMultiAgentDefs
      ? getSelectedTaskAgentId(task)
      : null;
  const persistedTask: PersistedTask = {
    id: task.id,
    name: task.name,
    projectId: task.projectId,
    branchName: task.branchName,
    worktreePath: task.worktreePath,
    notes: task.notes,
    lastPrompt: task.lastPrompt,
    shellCount: task.shellAgentIds.length,
    agentId: task.agentIds[0] ?? null,
    ...(hasCompleteActiveMultiAgentDefs ? { agentIds: [...task.agentIds] } : {}),
    ...(shouldPersistAgentDefs && agentDefs ? { agentDefs } : {}),
    ...(selectedAgentId ? { selectedAgentId } : {}),
    ...(task.terminalLayoutMode !== undefined
      ? { terminalLayoutMode: task.terminalLayoutMode }
      : {}),
    shellAgentIds: [...task.shellAgentIds],
    agentDef: getPrimaryAgentDef(task, fallbackAgentDefs),
    ...buildTaskProjectModeFields(task),
    ...(gitIsolation !== undefined ? { gitIsolation } : {}),
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    ...(worktreeOwnership === 'external' ? { worktreeOwnership } : {}),
    ...(task.skipPermissions !== undefined ? { skipPermissions: task.skipPermissions } : {}),
    ...(task.githubUrl !== undefined ? { githubUrl: task.githubUrl } : {}),
    ...(task.savedInitialPrompt !== undefined
      ? { savedInitialPrompt: task.savedInitialPrompt }
      : {}),
    ...(task.savedSelectedAgentIndex !== undefined
      ? { savedSelectedAgentIndex: task.savedSelectedAgentIndex }
      : {}),
    ...(task.planFileName !== undefined ? { planFileName: task.planFileName } : {}),
    ...(task.planRelativePath !== undefined ? { planRelativePath: task.planRelativePath } : {}),
    ...(task.stepsTracking !== undefined ? { stepsTracking: task.stepsTracking } : {}),
    ...(task.coordinatorCredentialPath !== undefined
      ? { coordinatorCredentialPath: task.coordinatorCredentialPath }
      : {}),
    ...(task.coordinatorParentTaskId !== undefined
      ? { coordinatorParentTaskId: task.coordinatorParentTaskId }
      : {}),
    ...(task.coordinatorRole !== undefined ? { coordinatorRole: task.coordinatorRole } : {}),
    ...(task.coordinatorRunId !== undefined ? { coordinatorRunId: task.coordinatorRunId } : {}),
    ...(task.coordinatorToolCommand !== undefined
      ? { coordinatorToolCommand: task.coordinatorToolCommand }
      : {}),
    ...(exposedPorts ? { exposedPorts } : {}),
  };

  if (options?.collapsed) {
    persistedTask.collapsed = true;
  }

  return persistedTask;
}

function shouldPersistTask(task: Task | undefined): task is Task {
  return !!task && !isTaskRemoving(task);
}

function shouldPersistTerminal(terminal: Terminal | undefined): terminal is Terminal {
  return !!terminal && !isTerminalRemoving(terminal);
}

function buildPersistedActiveOrder(): string[] {
  const nextOrder: string[] = [];

  for (const id of store.taskOrder) {
    if (shouldPersistTask(store.tasks[id]) || shouldPersistTerminal(store.terminals[id])) {
      nextOrder.push(id);
    }
  }

  return nextOrder;
}

function buildPersistedSharedTaskOrder(): string[] {
  const nextOrder: string[] = [];

  for (const id of store.taskOrder) {
    if (shouldPersistTask(store.tasks[id])) {
      nextOrder.push(id);
    }
  }

  return nextOrder;
}

function buildPersistedCollapsedOrder(): string[] {
  return store.collapsedTaskOrder.filter((taskId) => shouldPersistTask(store.tasks[taskId]));
}

function buildPersistedTaskEntries(
  taskOrder: readonly string[],
  collapsedTaskOrder: readonly string[],
): Record<string, PersistedTask> {
  const tasks: Record<string, PersistedTask> = {};

  for (const taskId of taskOrder) {
    const task = store.tasks[taskId];
    if (!shouldPersistTask(task)) {
      continue;
    }

    tasks[taskId] = buildPersistedTask(task);
  }

  for (const taskId of collapsedTaskOrder) {
    const task = store.tasks[taskId];
    if (!shouldPersistTask(task)) {
      continue;
    }

    tasks[taskId] = buildPersistedTask(task, {
      collapsed: true,
      fallbackAgentDefs: task.savedAgentDefs ?? (task.savedAgentDef ? [task.savedAgentDef] : []),
    });
  }

  return tasks;
}

function buildPersistedTerminalEntries(
  taskOrder: readonly string[],
): Record<string, PersistedTerminal> | undefined {
  let terminals: Record<string, PersistedTerminal> | undefined;

  for (const taskId of taskOrder) {
    const terminal = store.terminals[taskId];
    if (!shouldPersistTerminal(terminal)) {
      continue;
    }

    terminals ??= {};
    terminals[taskId] = {
      id: terminal.id,
      name: terminal.name,
      agentId: terminal.agentId,
    };
  }

  return terminals;
}

export function buildWorkspaceSharedState(): WorkspaceSharedState {
  const taskOrder = buildPersistedSharedTaskOrder();
  const collapsedTaskOrder = buildPersistedCollapsedOrder();
  const tasks = buildPersistedTaskEntries(taskOrder, collapsedTaskOrder);

  return {
    projects: store.projects.map((project) => buildPersistedProject(project)),
    taskOrder,
    collapsedTaskOrder,
    tasks,
    completedTaskDate: store.completedTaskDate,
    completedTaskCount: store.completedTaskCount,
    mergedLinesAdded: store.mergedLinesAdded,
    mergedLinesRemoved: store.mergedLinesRemoved,
    hydraCommand: store.hydraCommand,
    hydraForceDispatchFromPromptPanel: store.hydraForceDispatchFromPromptPanel,
    hydraStartupMode: store.hydraStartupMode,
    ...(store.customAgents.length > 0 ? { customAgents: [...store.customAgents] } : {}),
  };
}

export function buildPersistedState(): PersistedState {
  const taskOrder = buildPersistedActiveOrder();
  const collapsedTaskOrder = buildPersistedCollapsedOrder();
  const tasks = buildPersistedTaskEntries(taskOrder, collapsedTaskOrder);
  const terminals = buildPersistedTerminalEntries(taskOrder);
  const electronRuntime = isElectronRuntime();
  const persisted: PersistedState = {
    projects: store.projects.map((project) => buildPersistedProject(project)),
    taskOrder,
    collapsedTaskOrder,
    tasks,
    completedTaskDate: store.completedTaskDate,
    completedTaskCount: store.completedTaskCount,
    mergedLinesAdded: store.mergedLinesAdded,
    mergedLinesRemoved: store.mergedLinesRemoved,
    lastProjectId: store.lastProjectId,
    lastAgentId: store.lastAgentId,
    autoTrustFolders: store.autoTrustFolders,
    hydraForceDispatchFromPromptPanel: store.hydraForceDispatchFromPromptPanel,
    hydraStartupMode: store.hydraStartupMode,
    ...(store.customAgents.length > 0 ? { customAgents: [...store.customAgents] } : {}),
    ...(terminals ? { terminals } : {}),
    ...(store.editorCommand ? { editorCommand: store.editorCommand } : {}),
    ...(store.hydraCommand ? { hydraCommand: store.hydraCommand } : {}),
    ...(!electronRuntime && store.verboseLogging ? { verboseLogging: true } : {}),
  };

  if (!electronRuntime) {
    return persisted;
  }

  Object.assign(persisted, buildElectronLocalShellPreferences(store));
  persisted.activeTaskId = store.activeTaskId;
  persisted.hasSeenDesktopIntro = store.hasSeenDesktopIntro;

  return persisted;
}

export function toNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}
