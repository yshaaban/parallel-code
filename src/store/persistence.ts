import { produce } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { isElectronRuntime } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import { clearAgentActivity, markAgentSpawned } from './taskStatus';
import { getLocalDateKey } from '../lib/date';
import type {
  Agent,
  Task,
  Terminal,
  PersistedState,
  PersistedTerminal,
  PersistedTask,
  PersistedTaskExposedPort,
  WorkspaceSharedState,
} from './types';
import type { AgentDef } from '../ipc/types';
import { isTaskRemoving, isTerminalRemoving } from '../domain/task-closing';
import { DEFAULT_TERMINAL_FONT, isTerminalFont } from '../lib/fonts';
import { isHydraStartupMode } from '../lib/hydra';
import { isLookPreset } from '../lib/look';
import { syncTerminalCounter } from './terminals';
import {
  createWorkspaceStateBaseAgents,
  forEachHydratedPersistedTask,
  isLegacyPersistedState,
  parsePersistedWindowState,
  parseSharedProjects,
  restorePersistedTerminals,
  type LegacyPersistedState,
  syncPersistedTaskVisibility,
} from './persistence-helpers';
import {
  removeTaskCommandControllerStoreState,
  resetTaskCommandControllerStoreState,
} from './task-command-controllers';
import {
  collectTaskAgentIds,
  removeAgentScopedStoreState,
  removeTaskStoreState,
  removeTerminalStoreState,
} from './task-state-cleanup';

function createStateSyncSourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const STATE_SYNC_SOURCE_ID = createStateSyncSourceId();
let lastLoadedStateJson: string | null = null;
let lastLoadedWorkspaceStateJson: string | null = null;
let lastLoadedWorkspaceRevision = 0;

export function getStateSyncSourceId(): string {
  return STATE_SYNC_SOURCE_ID;
}

function recordLoadedStateJson(json: string): void {
  lastLoadedStateJson = json;
}

function recordLoadedWorkspaceState(json: string, revision: number): void {
  lastLoadedWorkspaceStateJson = json;
  lastLoadedWorkspaceRevision = revision;
}

export function getLoadedWorkspaceRevision(): number {
  return lastLoadedWorkspaceRevision;
}

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

function buildWorkspaceSharedState(): WorkspaceSharedState {
  const taskOrder = buildPersistedActiveOrder();
  const collapsedTaskOrder = buildPersistedCollapsedOrder();
  const tasks = buildPersistedTaskEntries(taskOrder, collapsedTaskOrder);
  const terminals = buildPersistedTerminalEntries(taskOrder);
  const persisted: WorkspaceSharedState = {
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

  return persisted;
}

export function getWorkspaceStateSnapshotJson(): string {
  return JSON.stringify(buildWorkspaceSharedState());
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export async function saveState(): Promise<void> {
  const taskOrder = buildPersistedActiveOrder();
  const collapsedTaskOrder = buildPersistedCollapsedOrder();
  const tasks = buildPersistedTaskEntries(taskOrder, collapsedTaskOrder);
  const terminals = buildPersistedTerminalEntries(taskOrder);
  const persisted: PersistedState = {
    projects: store.projects.map((p) => ({ ...p })),
    lastProjectId: store.lastProjectId,
    lastAgentId: store.lastAgentId,
    taskOrder,
    collapsedTaskOrder,
    tasks,
    completedTaskDate: store.completedTaskDate,
    completedTaskCount: store.completedTaskCount,
    mergedLinesAdded: store.mergedLinesAdded,
    mergedLinesRemoved: store.mergedLinesRemoved,
    autoTrustFolders: store.autoTrustFolders,
    hydraForceDispatchFromPromptPanel: store.hydraForceDispatchFromPromptPanel,
    hydraStartupMode: store.hydraStartupMode,
    ...(store.editorCommand ? { editorCommand: store.editorCommand } : {}),
    ...(store.hydraCommand ? { hydraCommand: store.hydraCommand } : {}),
    ...(store.customAgents.length > 0 ? { customAgents: [...store.customAgents] } : {}),
    ...(terminals ? { terminals } : {}),
  };

  if (isElectronRuntime()) {
    persisted.activeTaskId = store.activeTaskId;
    persisted.sidebarVisible = store.sidebarVisible;
    persisted.fontScales = { ...store.fontScales };
    persisted.panelSizes = { ...store.panelSizes };
    persisted.globalScale = store.globalScale;
    persisted.terminalFont = store.terminalFont;
    persisted.themePreset = store.themePreset;
    persisted.showPlans = store.showPlans;
    persisted.inactiveColumnOpacity = store.inactiveColumnOpacity;
    persisted.hasSeenDesktopIntro = store.hasSeenDesktopIntro;
    if (store.windowState) {
      persisted.windowState = { ...store.windowState };
    }
  }

  const json = JSON.stringify(persisted);
  recordLoadedStateJson(json);

  await invoke(IPC.SaveAppState, {
    json,
    sourceId: STATE_SYNC_SOURCE_ID,
  }).catch((e) => console.warn('Failed to save state:', e));
}

function isStringNumberRecord(v: unknown): v is Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (val) => typeof val === 'number' && Number.isFinite(val),
  );
}

export function applyLoadedStateJson(json: string): boolean {
  if (json === lastLoadedStateJson) {
    return false;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn('Failed to parse persisted state');
    return false;
  }

  if (!isLegacyPersistedState(raw)) {
    console.warn('Invalid persisted state structure, skipping load');
    return false;
  }

  const restoredRunningAgentIds: string[] = [];
  const today = getLocalDateKey();
  const restoredHydraCommand = typeof raw.hydraCommand === 'string' ? raw.hydraCommand.trim() : '';
  const electronRuntime = isElectronRuntime();
  const { availableAgents, customAgents } = createWorkspaceStateBaseAgents(
    raw,
    restoredHydraCommand,
  );
  const { lastProjectId, projects } = parseSharedProjects(raw);
  const lastAgentId: string | null = raw.lastAgentId ?? null;

  setStore(
    produce((s) => {
      s.tasks = {};
      s.terminals = {};
      s.agents = {};
      s.agentSupervision = {};
      s.agentActive = {};
      s.taskGitStatus = {};
      s.taskPorts = {};
      s.taskConvergence = {};
      s.taskReview = {};
      resetTaskCommandControllerStoreState(s);
      s.focusedPanel = {};
      s.missingProjectIds = {};
      s.activeAgentId = null;
      s.sidebarFocused = false;
      s.sidebarFocusedProjectId = null;
      s.sidebarFocusedTaskId = null;
      s.placeholderFocused = false;
      s.placeholderFocusedButton = 'add-task';
      s.customAgents = customAgents;
      s.availableAgents = availableAgents;
      s.projects = projects;
      s.lastProjectId = lastProjectId;
      s.lastAgentId = lastAgentId;
      s.taskOrder = raw.taskOrder;
      s.activeTaskId = electronRuntime ? raw.activeTaskId : null;
      s.sidebarVisible =
        electronRuntime && typeof raw.sidebarVisible === 'boolean' ? raw.sidebarVisible : true;
      s.fontScales = electronRuntime && isStringNumberRecord(raw.fontScales) ? raw.fontScales : {};
      s.panelSizes = electronRuntime && isStringNumberRecord(raw.panelSizes) ? raw.panelSizes : {};
      s.globalScale = electronRuntime && typeof raw.globalScale === 'number' ? raw.globalScale : 1;
      const completedTaskDate =
        typeof raw.completedTaskDate === 'string' ? raw.completedTaskDate : today;
      const completedTaskCount = toNonNegativeInt(raw.completedTaskCount);
      if (completedTaskDate === today) {
        s.completedTaskDate = completedTaskDate;
        s.completedTaskCount = completedTaskCount;
      } else {
        s.completedTaskDate = today;
        s.completedTaskCount = 0;
      }
      s.mergedLinesAdded = toNonNegativeInt(raw.mergedLinesAdded);
      s.mergedLinesRemoved = toNonNegativeInt(raw.mergedLinesRemoved);
      s.terminalFont =
        electronRuntime && isTerminalFont(raw.terminalFont)
          ? raw.terminalFont
          : DEFAULT_TERMINAL_FONT;
      s.themePreset =
        electronRuntime && isLookPreset(raw.themePreset) ? raw.themePreset : 'minimal';
      s.windowState = electronRuntime ? parsePersistedWindowState(raw.windowState) : null;
      s.autoTrustFolders = typeof raw.autoTrustFolders === 'boolean' ? raw.autoTrustFolders : false;
      s.showPlans = electronRuntime && typeof raw.showPlans === 'boolean' ? raw.showPlans : true;
      const rawOpacity = raw.inactiveColumnOpacity;
      s.inactiveColumnOpacity =
        electronRuntime &&
        typeof rawOpacity === 'number' &&
        Number.isFinite(rawOpacity) &&
        rawOpacity >= 0.3 &&
        rawOpacity <= 1.0
          ? Math.round(rawOpacity * 100) / 100
          : 0.6;
      s.hasSeenDesktopIntro =
        electronRuntime && typeof raw.hasSeenDesktopIntro === 'boolean'
          ? raw.hasSeenDesktopIntro
          : false;

      const rawEditorCommand = raw.editorCommand;
      s.editorCommand = typeof rawEditorCommand === 'string' ? rawEditorCommand.trim() : '';
      s.hydraCommand = restoredHydraCommand;
      s.hydraForceDispatchFromPromptPanel =
        typeof raw.hydraForceDispatchFromPromptPanel === 'boolean'
          ? raw.hydraForceDispatchFromPromptPanel
          : true;
      const rawHydraStartupMode =
        typeof raw.hydraStartupMode === 'string' ? raw.hydraStartupMode : undefined;
      s.hydraStartupMode = isHydraStartupMode(rawHydraStartupMode) ? rawHydraStartupMode : 'auto';

      forEachHydratedPersistedTask(raw, {
        availableAgents: s.availableAgents,
        hydraCommand: restoredHydraCommand,
        getExistingTask() {
          return undefined;
        },
        visit(entry) {
          s.tasks[entry.taskId] = entry.task;
          if (entry.collapsed || !entry.agentDef || !entry.primaryAgentId) {
            return;
          }

          const agent: Agent = {
            id: entry.primaryAgentId,
            taskId: entry.taskId,
            def: entry.agentDef,
            resumed: true,
            status: 'running',
            exitCode: null,
            signal: null,
            lastOutput: [],
            generation: 0,
          };
          s.agents[entry.primaryAgentId] = agent;
          restoredRunningAgentIds.push(entry.primaryAgentId);
        },
      });

      restorePersistedTerminals(s, raw);
      syncPersistedTaskVisibility(s, raw);

      // Set activeAgentId from the active task
      if (electronRuntime && s.activeTaskId) {
        const activeTask = s.tasks[s.activeTaskId];
        if (activeTask) {
          s.activeAgentId = activeTask.agentIds[0] ?? null;
        }
      }
    }),
  );

  // Restored agents are considered running; reflect that immediately in task status dots.
  for (const agentId of restoredRunningAgentIds) {
    markAgentSpawned(agentId);
  }

  recordLoadedStateJson(json);
  syncTerminalCounter();
  return true;
}

export function applyLoadedWorkspaceStateJson(json: string, revision = 0): boolean {
  if (json === lastLoadedWorkspaceStateJson && revision === lastLoadedWorkspaceRevision) {
    return false;
  }

  let raw: LegacyPersistedState;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn('Failed to parse persisted workspace state');
    return false;
  }

  if (!isLegacyPersistedState(raw)) {
    console.warn('Invalid persisted workspace state structure, skipping load');
    return false;
  }

  const today = getLocalDateKey();
  const restoredHydraCommand = typeof raw.hydraCommand === 'string' ? raw.hydraCommand.trim() : '';
  const { availableAgents, customAgents } = createWorkspaceStateBaseAgents(
    raw,
    restoredHydraCommand,
  );
  const { lastProjectId, projects } = parseSharedProjects(raw);
  const currentTasksById = new Map(Object.entries(store.tasks));
  const nextTaskIds = new Set([...raw.taskOrder, ...(raw.collapsedTaskOrder ?? [])]);
  const removedAgentIds = new Set<string>();

  setStore(
    produce((storeState) => {
      const agentsToDelete = new Set<string>();

      for (const [taskId, task] of Object.entries(storeState.tasks)) {
        if (nextTaskIds.has(taskId)) {
          continue;
        }

        collectTaskAgentIds(task).forEach((agentId) => agentsToDelete.add(agentId));
        removeTaskStoreState(storeState, taskId);
        removeTerminalStoreState(storeState, taskId, { agentIdsToDelete: agentsToDelete });
      }

      storeState.projects = projects;
      storeState.lastProjectId = lastProjectId;
      storeState.completedTaskDate =
        typeof raw.completedTaskDate === 'string' ? raw.completedTaskDate : today;
      storeState.completedTaskCount = toNonNegativeInt(raw.completedTaskCount);
      storeState.mergedLinesAdded = toNonNegativeInt(raw.mergedLinesAdded);
      storeState.mergedLinesRemoved = toNonNegativeInt(raw.mergedLinesRemoved);
      storeState.hydraCommand = restoredHydraCommand;
      storeState.hydraForceDispatchFromPromptPanel =
        typeof raw.hydraForceDispatchFromPromptPanel === 'boolean'
          ? raw.hydraForceDispatchFromPromptPanel
          : true;
      const rawHydraStartupMode =
        typeof raw.hydraStartupMode === 'string' ? raw.hydraStartupMode : undefined;
      storeState.hydraStartupMode = isHydraStartupMode(rawHydraStartupMode)
        ? rawHydraStartupMode
        : 'auto';
      storeState.customAgents = customAgents;
      storeState.availableAgents = availableAgents;

      forEachHydratedPersistedTask(raw, {
        availableAgents,
        hydraCommand: restoredHydraCommand,
        getExistingTask(taskId) {
          return currentTasksById.get(taskId);
        },
        visit(entry) {
          const hydratedTask = entry;
          const taskId = entry.taskId;
          const previousTask = storeState.tasks[taskId];
          previousTask?.agentIds.forEach((agentId) => agentsToDelete.add(agentId));
          previousTask?.shellAgentIds.forEach((agentId) => agentsToDelete.add(agentId));
          hydratedTask.task.agentIds.forEach((agentId) => agentsToDelete.delete(agentId));
          hydratedTask.task.shellAgentIds.forEach((agentId) => agentsToDelete.delete(agentId));
          storeState.tasks[taskId] = hydratedTask.task;

          if (!hydratedTask.collapsed && hydratedTask.agentDef && hydratedTask.primaryAgentId) {
            const previousAgent = storeState.agents[hydratedTask.primaryAgentId];
            storeState.agents[hydratedTask.primaryAgentId] = previousAgent
              ? {
                  ...previousAgent,
                  def: hydratedTask.agentDef,
                  taskId,
                }
              : {
                  id: hydratedTask.primaryAgentId,
                  taskId,
                  def: hydratedTask.agentDef,
                  resumed: true,
                  status: 'running',
                  exitCode: null,
                  signal: null,
                  lastOutput: [],
                  generation: 0,
                };
          }
        },
      });

      restorePersistedTerminals(storeState, raw, {
        pruneMissing: true,
        agentsToDelete,
      });

      for (const agentId of agentsToDelete) {
        removedAgentIds.add(agentId);
      }
      removeAgentScopedStoreState(storeState, agentsToDelete);

      for (const taskId of Object.keys(storeState.taskCommandControllers)) {
        if (storeState.tasks[taskId]) {
          continue;
        }

        removeTaskCommandControllerStoreState(storeState, taskId);
      }

      syncPersistedTaskVisibility(storeState, raw);
    }),
  );

  for (const agentId of removedAgentIds) {
    clearAgentActivity(agentId);
  }

  recordLoadedWorkspaceState(json, revision);
  syncTerminalCounter();
  return true;
}

export async function saveBrowserWorkspaceState(): Promise<void> {
  const json = JSON.stringify(buildWorkspaceSharedState());
  await saveBrowserWorkspaceStateSnapshot(json);
}

export async function saveBrowserWorkspaceStateSnapshot(json: string): Promise<void> {
  const response = await invoke(IPC.SaveWorkspaceState, {
    baseRevision: getLoadedWorkspaceRevision(),
    json,
    sourceId: STATE_SYNC_SOURCE_ID,
  });
  recordLoadedWorkspaceState(json, response.revision);
}

export async function saveCurrentRuntimeState(): Promise<void> {
  if (isElectronRuntime()) {
    await saveState();
    return;
  }

  await saveBrowserWorkspaceState();
}

export async function loadWorkspaceState(): Promise<boolean> {
  const payload = await invoke(IPC.LoadWorkspaceState).catch(() => null);
  if (!payload?.json) {
    return false;
  }

  return applyLoadedWorkspaceStateJson(payload.json, payload.revision);
}

export async function loadState(): Promise<boolean> {
  const json = await invoke(IPC.LoadAppState).catch(() => null);
  if (!json) {
    return false;
  }

  return applyLoadedStateJson(json);
}
