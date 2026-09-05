import { isElectronRuntime } from '../lib/ipc';
import type { AgentDef } from '../ipc/types';
import { isTerminalTask } from '../domain/task-mode';
import { getCanonicalMergeProgressPersistenceProjection } from '../app/merge-progress';
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

function buildPersistedMergeProgressFields(): Pick<
  WorkspaceSharedState,
  'committedMergeOperationId' | 'mergeOperation' | 'mergeProgress'
> {
  const projection = getCanonicalMergeProgressPersistenceProjection();
  if (!projection) return {};
  return {
    mergeProgress: { ...projection.mergeProgress },
    ...(projection.mergeOperation
      ? {
          committedMergeOperationId: projection.committedMergeOperationId,
          mergeOperation: { ...projection.mergeOperation },
        }
      : {}),
  };
}

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
  const terminalTask = isTerminalTask(task);
  const exposedPorts = buildPersistedExposedPorts(task.id);
  const taskProjectMode = getProjectMode(task);
  const baseBranch = taskProjectMode === 'git' ? normalizeTaskBaseBranch(task) : undefined;
  const gitIsolation = taskProjectMode === 'git' ? getTaskGitIsolation(task) : undefined;
  const worktreeOwnership = taskProjectMode === 'git' ? getTaskWorktreeOwnership(task) : undefined;
  const fallbackAgentDefs = terminalTask ? [] : (options?.fallbackAgentDefs ?? []);
  const persistedAgentIds = terminalTask ? [] : task.agentIds;
  const agentDefs = terminalTask ? null : getCompleteTaskAgentDefs(task, fallbackAgentDefs);
  const hasCompleteActiveMultiAgentDefs =
    persistedAgentIds.length > 1 && agentDefs?.length === persistedAgentIds.length;
  const hasCompleteCollapsedMultiAgentDefs =
    options?.collapsed === true &&
    persistedAgentIds.length === 0 &&
    fallbackAgentDefs.length > 1 &&
    agentDefs?.length === fallbackAgentDefs.length;
  const shouldPersistAgentDefs =
    hasCompleteActiveMultiAgentDefs || hasCompleteCollapsedMultiAgentDefs;
  const selectedAgentId = terminalTask
    ? null
    : persistedAgentIds.length <= 1 || hasCompleteActiveMultiAgentDefs
      ? getSelectedTaskAgentId(task)
      : null;
  const persistedTask: PersistedTask = {
    id: task.id,
    taskMode: task.taskMode,
    name: task.name,
    projectId: task.projectId,
    branchName: task.branchName,
    worktreePath: task.worktreePath,
    notes: task.notes,
    lastPrompt: terminalTask ? '' : task.lastPrompt,
    shellCount: task.shellAgentIds.length,
    agentId: persistedAgentIds[0] ?? null,
    ...(hasCompleteActiveMultiAgentDefs ? { agentIds: [...persistedAgentIds] } : {}),
    ...(shouldPersistAgentDefs && agentDefs ? { agentDefs } : {}),
    ...(selectedAgentId ? { selectedAgentId } : {}),
    ...(!terminalTask && task.terminalLayoutMode !== undefined
      ? { terminalLayoutMode: task.terminalLayoutMode }
      : {}),
    shellAgentIds: [...task.shellAgentIds],
    agentDef: terminalTask ? null : getPrimaryAgentDef(task, fallbackAgentDefs),
    ...buildTaskProjectModeFields(task),
    ...(gitIsolation !== undefined ? { gitIsolation } : {}),
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    ...(worktreeOwnership === 'external' ? { worktreeOwnership } : {}),
    ...(!terminalTask && task.skipPermissions !== undefined
      ? { skipPermissions: task.skipPermissions }
      : {}),
    ...(task.githubUrl !== undefined ? { githubUrl: task.githubUrl } : {}),
    ...(!terminalTask && task.initialPromptDeliveryId && task.initialPrompt !== undefined
      ? {
          initialPrompt: task.initialPrompt,
          initialPromptDeliveryId: task.initialPromptDeliveryId,
          initialPromptDeliveryMode: task.initialPromptDeliveryMode ?? 'automatic',
        }
      : {}),
    ...(!terminalTask && task.savedInitialPrompt !== undefined
      ? { savedInitialPrompt: task.savedInitialPrompt }
      : {}),
    ...(!terminalTask && task.savedSelectedAgentIndex !== undefined
      ? { savedSelectedAgentIndex: task.savedSelectedAgentIndex }
      : {}),
    ...(task.planFileName !== undefined ? { planFileName: task.planFileName } : {}),
    ...(task.planRelativePath !== undefined ? { planRelativePath: task.planRelativePath } : {}),
    ...(task.stepsTracking !== undefined ? { stepsTracking: task.stepsTracking } : {}),
    ...(!terminalTask && task.coordinatorCredentialPath !== undefined
      ? { coordinatorCredentialPath: task.coordinatorCredentialPath }
      : {}),
    ...(!terminalTask && task.coordinatorParentTaskId !== undefined
      ? { coordinatorParentTaskId: task.coordinatorParentTaskId }
      : {}),
    ...(!terminalTask && task.coordinatorRole !== undefined
      ? { coordinatorRole: task.coordinatorRole }
      : {}),
    ...(!terminalTask && task.coordinatorRunId !== undefined
      ? { coordinatorRunId: task.coordinatorRunId }
      : {}),
    ...(!terminalTask && task.coordinatorToolCommand !== undefined
      ? { coordinatorToolCommand: task.coordinatorToolCommand }
      : {}),
    ...(task.taskCreationProvenance !== undefined
      ? { taskCreationProvenance: task.taskCreationProvenance }
      : {}),
    ...(task.taskCreationOperationLink !== undefined
      ? { taskCreationOperationLink: task.taskCreationOperationLink }
      : {}),
    ...(task.taskInitialShellOwnership !== undefined
      ? { taskInitialShellOwnership: task.taskInitialShellOwnership }
      : {}),
    ...(exposedPorts ? { exposedPorts } : {}),
  };

  if (options?.collapsed) {
    persistedTask.collapsed = true;
  }

  return persistedTask;
}

function buildPersistedActiveOrder(): string[] {
  const nextOrder: string[] = [];

  for (const id of store.taskOrder) {
    if (store.tasks[id] || store.terminals[id]) {
      nextOrder.push(id);
    }
  }

  return nextOrder;
}

function buildPersistedSharedTaskOrder(): string[] {
  const nextOrder: string[] = [];

  for (const id of store.taskOrder) {
    if (store.tasks[id]) {
      nextOrder.push(id);
    }
  }

  return nextOrder;
}

function buildPersistedCollapsedOrder(): string[] {
  return store.collapsedTaskOrder.filter((taskId) => Boolean(store.tasks[taskId]));
}

function buildPersistedTaskEntries(
  taskOrder: readonly string[],
  collapsedTaskOrder: readonly string[],
): Record<string, PersistedTask> {
  const tasks: Record<string, PersistedTask> = {};

  for (const taskId of taskOrder) {
    const task = store.tasks[taskId];
    if (!task) {
      continue;
    }

    tasks[taskId] = buildPersistedTask(task);
  }

  for (const taskId of collapsedTaskOrder) {
    const task = store.tasks[taskId];
    if (!task) {
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
    if (!terminal) {
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
    ...buildPersistedMergeProgressFields(),
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
    ...buildPersistedMergeProgressFields(),
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
