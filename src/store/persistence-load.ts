import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke, isElectronRuntime } from '../lib/ipc';
import { getLocalDateKey } from '../lib/date';
import { DEFAULT_TERMINAL_FONT, isTerminalFont } from '../lib/fonts';
import { isHydraStartupMode } from '../lib/hydra';
import { isLookPreset } from '../lib/look';
import {
  createWorkspaceStateBaseAgents,
  getRestoredHydraCommand,
} from './persistence-agent-defaults';
import {
  isLegacyPersistedState,
  parsePersistedWindowState,
  type LegacyPersistedState,
} from './persistence-legacy-state';
import { parseSharedProjects } from './persistence-projects';
import { forEachHydratedPersistedTask } from './persistence-task-hydration';
import {
  restorePersistedTerminals,
  syncPersistedTaskVisibility,
} from './persistence-terminal-restore';
import { syncTerminalCounter } from './terminals';
import { clearAgentActivity, markAgentSpawned, resetTaskStatusRuntimeState } from './taskStatus';
import { setStore, store } from './core';
import { toNonNegativeInt } from './persistence-codecs';
import {
  getLoadedStateJson,
  getLoadedWorkspaceRevision,
  getLoadedWorkspaceStateJson,
  recordLoadedStateJson,
  recordLoadedWorkspaceState,
} from './persistence-session';
import { resetTaskGitStatusRuntimeState } from './task-git-status';
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
import type { Agent } from './types';

function isStringNumberRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === 'number' && Number.isFinite(entry),
  );
}

function createRestoredWorkspaceAgents(raw: LegacyPersistedState): {
  availableAgents: typeof store.availableAgents;
  customAgents: typeof store.customAgents;
} {
  return createWorkspaceStateBaseAgents(
    raw,
    getRestoredHydraCommand(raw),
    store.availableAgents,
    store.customAgents,
  );
}

export function applyLoadedStateJson(json: string): boolean {
  if (json === getLoadedStateJson()) {
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
  const restoredHydraCommand = getRestoredHydraCommand(raw);
  const electronRuntime = isElectronRuntime();
  const { availableAgents, customAgents } = createRestoredWorkspaceAgents(raw);
  const { lastProjectId, projects } = parseSharedProjects(raw);
  const lastAgentId: string | null = raw.lastAgentId ?? null;

  resetTaskStatusRuntimeState();
  resetTaskGitStatusRuntimeState();

  setStore(
    produce((storeState) => {
      storeState.tasks = {};
      storeState.terminals = {};
      storeState.agents = {};
      storeState.agentSupervision = {};
      storeState.agentActive = {};
      storeState.taskGitStatus = {};
      storeState.taskPorts = {};
      storeState.taskConvergence = {};
      storeState.taskReview = {};
      resetTaskCommandControllerStoreState(storeState);
      storeState.focusedPanel = {};
      storeState.missingProjectIds = {};
      storeState.activeAgentId = null;
      storeState.sidebarFocused = false;
      storeState.sidebarFocusedProjectId = null;
      storeState.sidebarFocusedTaskId = null;
      storeState.placeholderFocused = false;
      storeState.placeholderFocusedButton = 'add-task';
      storeState.customAgents = customAgents;
      storeState.availableAgents = availableAgents;
      storeState.projects = projects;
      storeState.lastProjectId = lastProjectId;
      storeState.lastAgentId = lastAgentId;
      storeState.taskOrder = raw.taskOrder;
      storeState.activeTaskId = electronRuntime ? raw.activeTaskId : null;
      storeState.sidebarVisible =
        electronRuntime && typeof raw.sidebarVisible === 'boolean' ? raw.sidebarVisible : true;
      storeState.fontScales =
        electronRuntime && isStringNumberRecord(raw.fontScales) ? raw.fontScales : {};
      storeState.panelSizes =
        electronRuntime && isStringNumberRecord(raw.panelSizes) ? raw.panelSizes : {};
      storeState.globalScale =
        electronRuntime && typeof raw.globalScale === 'number' ? raw.globalScale : 1;

      const completedTaskDate =
        typeof raw.completedTaskDate === 'string' ? raw.completedTaskDate : today;
      const completedTaskCount = toNonNegativeInt(raw.completedTaskCount);
      if (completedTaskDate === today) {
        storeState.completedTaskDate = completedTaskDate;
        storeState.completedTaskCount = completedTaskCount;
      } else {
        storeState.completedTaskDate = today;
        storeState.completedTaskCount = 0;
      }

      storeState.mergedLinesAdded = toNonNegativeInt(raw.mergedLinesAdded);
      storeState.mergedLinesRemoved = toNonNegativeInt(raw.mergedLinesRemoved);
      storeState.terminalFont =
        electronRuntime && isTerminalFont(raw.terminalFont)
          ? raw.terminalFont
          : DEFAULT_TERMINAL_FONT;
      storeState.themePreset =
        electronRuntime && isLookPreset(raw.themePreset) ? raw.themePreset : 'minimal';
      storeState.windowState = electronRuntime ? parsePersistedWindowState(raw.windowState) : null;
      storeState.autoTrustFolders =
        typeof raw.autoTrustFolders === 'boolean' ? raw.autoTrustFolders : false;
      storeState.showPlans =
        electronRuntime && typeof raw.showPlans === 'boolean' ? raw.showPlans : true;

      const rawOpacity = raw.inactiveColumnOpacity;
      storeState.inactiveColumnOpacity =
        electronRuntime &&
        typeof rawOpacity === 'number' &&
        Number.isFinite(rawOpacity) &&
        rawOpacity >= 0.3 &&
        rawOpacity <= 1.0
          ? Math.round(rawOpacity * 100) / 100
          : 0.6;
      storeState.hasSeenDesktopIntro =
        electronRuntime && typeof raw.hasSeenDesktopIntro === 'boolean'
          ? raw.hasSeenDesktopIntro
          : false;

      const rawEditorCommand = raw.editorCommand;
      storeState.editorCommand =
        typeof rawEditorCommand === 'string' ? rawEditorCommand.trim() : '';
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

      forEachHydratedPersistedTask(raw, {
        availableAgents: storeState.availableAgents,
        hydraCommand: restoredHydraCommand,
        getExistingTask() {
          return undefined;
        },
        visit(entry) {
          storeState.tasks[entry.taskId] = entry.task;
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
          storeState.agents[entry.primaryAgentId] = agent;
          restoredRunningAgentIds.push(entry.primaryAgentId);
        },
      });

      restorePersistedTerminals(storeState, raw);
      syncPersistedTaskVisibility(storeState, raw);

      if (electronRuntime && storeState.activeTaskId) {
        const activeTask = storeState.tasks[storeState.activeTaskId];
        if (activeTask) {
          storeState.activeAgentId = activeTask.agentIds[0] ?? null;
        }
      }
    }),
  );

  for (const agentId of restoredRunningAgentIds) {
    markAgentSpawned(agentId);
  }

  recordLoadedStateJson(json);
  syncTerminalCounter();
  return true;
}

export function applyLoadedWorkspaceStateJson(json: string, revision = 0): boolean {
  if (json === getLoadedWorkspaceStateJson() && revision === getLoadedWorkspaceRevision()) {
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
  const restoredHydraCommand = getRestoredHydraCommand(raw);
  const { availableAgents, customAgents } = createRestoredWorkspaceAgents(raw);
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
          const taskId = entry.taskId;
          const previousTask = storeState.tasks[taskId];
          collectTaskAgentIds(previousTask).forEach((agentId) => agentsToDelete.add(agentId));
          collectTaskAgentIds(entry.task).forEach((agentId) => agentsToDelete.delete(agentId));
          storeState.tasks[taskId] = entry.task;

          if (!entry.collapsed && entry.agentDef && entry.primaryAgentId) {
            const previousAgent = storeState.agents[entry.primaryAgentId];
            storeState.agents[entry.primaryAgentId] = previousAgent
              ? {
                  ...previousAgent,
                  def: entry.agentDef,
                  taskId,
                }
              : {
                  id: entry.primaryAgentId,
                  taskId,
                  def: entry.agentDef,
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
