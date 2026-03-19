import { isElectronRuntime } from '../lib/ipc';
import type { AgentDef } from '../ipc/types';
import { isTaskRemoving, isTerminalRemoving } from '../domain/task-closing';
import { store } from './core';
import type {
  PersistedState,
  PersistedTask,
  PersistedTaskExposedPort,
  PersistedTerminal,
  Task,
  Terminal,
  WorkspaceSharedState,
} from './types';

function getPrimaryAgentDef(task: Task): AgentDef | null {
  const agentId = task.agentIds[0];
  return agentId ? (store.agents[agentId]?.def ?? null) : null;
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

function buildPersistedTask(
  task: Task,
  options?: { collapsed?: boolean; fallbackAgentDef?: AgentDef | null },
): PersistedTask {
  const exposedPorts = buildPersistedExposedPorts(task.id);
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
    shellAgentIds: [...task.shellAgentIds],
    agentDef: getPrimaryAgentDef(task) ?? options?.fallbackAgentDef ?? null,
    ...(task.directMode ? { directMode: true } : {}),
    ...(task.skipPermissions !== undefined ? { skipPermissions: task.skipPermissions } : {}),
    ...(task.githubUrl !== undefined ? { githubUrl: task.githubUrl } : {}),
    ...(task.savedInitialPrompt !== undefined
      ? { savedInitialPrompt: task.savedInitialPrompt }
      : {}),
    ...(task.planFileName !== undefined ? { planFileName: task.planFileName } : {}),
    ...(task.planRelativePath !== undefined ? { planRelativePath: task.planRelativePath } : {}),
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
      fallbackAgentDef: task.savedAgentDef ?? null,
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
  const taskOrder = buildPersistedActiveOrder();
  const collapsedTaskOrder = buildPersistedCollapsedOrder();
  const tasks = buildPersistedTaskEntries(taskOrder, collapsedTaskOrder);
  const terminals = buildPersistedTerminalEntries(taskOrder);

  return {
    projects: store.projects.map((project) => ({ ...project })),
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
    ...(terminals ? { terminals } : {}),
  };
}

export function buildPersistedState(): PersistedState {
  const { hydraCommand, ...workspaceState } = buildWorkspaceSharedState();
  const persisted: PersistedState = {
    ...workspaceState,
    lastProjectId: store.lastProjectId,
    lastAgentId: store.lastAgentId,
    autoTrustFolders: store.autoTrustFolders,
    ...(store.editorCommand ? { editorCommand: store.editorCommand } : {}),
    ...(hydraCommand ? { hydraCommand } : {}),
  };

  if (!isElectronRuntime()) {
    return persisted;
  }

  persisted.activeTaskId = store.activeTaskId;
  persisted.sidebarVisible = store.sidebarVisible;
  persisted.fontScales = { ...store.fontScales };
  persisted.panelSizes = { ...store.panelSizes };
  persisted.globalScale = store.globalScale;
  persisted.terminalFont = store.terminalFont;
  persisted.themePreset = store.themePreset;
  persisted.sidebarSectionCollapsed = { ...store.sidebarSectionCollapsed };
  persisted.showPlans = store.showPlans;
  persisted.taskNotificationsEnabled = store.taskNotificationsEnabled;
  persisted.taskNotificationsPreferenceInitialized = store.taskNotificationsPreferenceInitialized;
  persisted.inactiveColumnOpacity = store.inactiveColumnOpacity;
  persisted.hasSeenDesktopIntro = store.hasSeenDesktopIntro;
  if (store.windowState) {
    persisted.windowState = { ...store.windowState };
  }

  return persisted;
}

export function toNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}
