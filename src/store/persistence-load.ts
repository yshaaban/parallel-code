import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke, isElectronRuntime } from '../lib/ipc';
import { getLocalDateKey } from '../lib/date';
import { DEFAULT_TERMINAL_FONT, isTerminalFont } from '../lib/fonts';
import { isHydraStartupMode } from '../lib/hydra';
import { isLookPreset } from '../lib/look';
import { DEFAULT_TASK_NOTIFICATIONS_ENABLED } from '../domain/task-notification';
import { resetTaskPromptDispatchState } from '../app/task-prompt-dispatch';
import { clearRemovedTaskCommandLeaseState } from '../app/task-command-lease';
import { resetTerminalFocusedInputState } from '../app/terminal-focused-input';
import { syncTerminalHighLoadMode } from '../app/terminal-high-load-mode';
import { parsePersistedWindowState } from './persistence-legacy-state';
import {
  createDefaultSidebarSectionCollapsedState,
  normalizeSidebarSectionCollapsedState,
} from './sidebar-section-state';
import {
  forEachHydratedPersistedTaskInContext,
  parsePersistedLoadContext,
} from './persistence-load-context';
import {
  restorePersistedTerminals,
  syncPersistedTaskVisibility,
} from './persistence-terminal-restore';
import { syncTerminalCounter } from './terminals';
import { clearAgentActivity, markAgentSpawned, resetTaskStatusRuntimeState } from './taskStatus';
import { setStore, store } from './core';
import {
  isStringNumberRecord,
  normalizeInactiveColumnOpacity,
  resolvePersistedTerminalHighLoadMode,
  toNonNegativeInt,
} from './persistence-codecs';
import {
  getLoadedStateJson,
  getLoadedWorkspaceRevision,
  getLoadedWorkspaceStateJson,
  recordLoadedStateJson,
  recordLoadedWorkspaceState,
} from './persistence-session';
import { getPersistedTaskNotificationsEnabled } from './task-notification-preference';
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
import { clearTerminalStartupEntriesForTask } from './terminal-startup';
import type { Agent } from './types';

function resetTransientPersistenceRuntimeState(): void {
  resetTaskStatusRuntimeState();
  resetTaskPromptDispatchState();
  resetTerminalFocusedInputState();
  resetTaskGitStatusRuntimeState();
}

function clearRemovedTaskRuntimeState(taskIds: Iterable<string>): void {
  for (const taskId of taskIds) {
    void clearRemovedTaskCommandLeaseState(taskId);
    clearTerminalStartupEntriesForTask(taskId);
  }
}

function createHydratedRunningAgent(
  taskId: string,
  agentId: string,
  agentDef: Agent['def'],
  previousAgent?: Agent,
): Agent {
  if (previousAgent) {
    return {
      ...previousAgent,
      def: agentDef,
      taskId,
    };
  }

  return {
    id: agentId,
    taskId,
    def: agentDef,
    resumed: true,
    status: 'running',
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
  };
}

export function applyLoadedStateJson(json: string): boolean {
  if (json === getLoadedStateJson()) {
    return false;
  }

  const context = parsePersistedLoadContext(json, {
    currentAvailableAgents: store.availableAgents,
    currentCustomAgents: store.customAgents,
    invalidMessage: 'Invalid persisted state structure, skipping load',
    parseErrorMessage: 'Failed to parse persisted state',
  });
  if (!context) {
    return false;
  }

  const restoredRunningAgentIds: string[] = [];
  const previousTaskIds = Object.keys(store.tasks);
  const today = getLocalDateKey();
  const { raw } = context;
  const electronRuntime = isElectronRuntime();
  const lastAgentId: string | null = raw.lastAgentId ?? null;

  resetTransientPersistenceRuntimeState();

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
      storeState.incomingTaskTakeoverRequests = {};
      resetTaskCommandControllerStoreState(storeState);
      storeState.focusedPanel = {};
      storeState.missingProjectIds = {};
      storeState.activeAgentId = null;
      storeState.sidebarFocused = false;
      storeState.sidebarFocusedProjectId = null;
      storeState.sidebarFocusedTaskId = null;
      storeState.placeholderFocused = false;
      storeState.placeholderFocusedButton = 'add-task';
      storeState.sidebarSectionCollapsed = electronRuntime
        ? normalizeSidebarSectionCollapsedState(raw.sidebarSectionCollapsed)
        : createDefaultSidebarSectionCollapsedState();
      storeState.customAgents = context.customAgents;
      storeState.availableAgents = context.availableAgents;
      storeState.projects = context.projects;
      storeState.lastProjectId = context.lastProjectId;
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
      storeState.terminalHighLoadMode = electronRuntime
        ? resolvePersistedTerminalHighLoadMode(
            raw.terminalHighLoadMode,
            storeState.terminalHighLoadMode,
          )
        : storeState.terminalHighLoadMode;
      storeState.taskNotificationsEnabled = electronRuntime
        ? getPersistedTaskNotificationsEnabled(raw)
        : DEFAULT_TASK_NOTIFICATIONS_ENABLED;
      storeState.taskNotificationsPreferenceInitialized = true;

      storeState.inactiveColumnOpacity = electronRuntime
        ? normalizeInactiveColumnOpacity(raw.inactiveColumnOpacity)
        : 0.6;
      storeState.hasSeenDesktopIntro =
        electronRuntime && typeof raw.hasSeenDesktopIntro === 'boolean'
          ? raw.hasSeenDesktopIntro
          : false;

      const rawEditorCommand = raw.editorCommand;
      storeState.editorCommand =
        typeof rawEditorCommand === 'string' ? rawEditorCommand.trim() : '';
      storeState.hydraCommand = context.restoredHydraCommand;
      storeState.hydraForceDispatchFromPromptPanel =
        typeof raw.hydraForceDispatchFromPromptPanel === 'boolean'
          ? raw.hydraForceDispatchFromPromptPanel
          : true;
      const rawHydraStartupMode =
        typeof raw.hydraStartupMode === 'string' ? raw.hydraStartupMode : undefined;
      storeState.hydraStartupMode = isHydraStartupMode(rawHydraStartupMode)
        ? rawHydraStartupMode
        : 'auto';

      forEachHydratedPersistedTaskInContext(context, {
        getExistingTask() {
          return undefined;
        },
        visit(entry) {
          storeState.tasks[entry.taskId] = entry.task;
          if (entry.collapsed || !entry.agentDef || !entry.primaryAgentId) {
            return;
          }

          storeState.agents[entry.primaryAgentId] = createHydratedRunningAgent(
            entry.taskId,
            entry.primaryAgentId,
            entry.agentDef,
          );
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

  syncTerminalHighLoadMode(store.terminalHighLoadMode);

  for (const agentId of restoredRunningAgentIds) {
    markAgentSpawned(agentId);
  }
  clearRemovedTaskRuntimeState(previousTaskIds);

  recordLoadedStateJson(json);
  syncTerminalCounter();
  return true;
}

export function applyLoadedWorkspaceStateJson(json: string, revision = 0): boolean {
  if (json === getLoadedWorkspaceStateJson() && revision === getLoadedWorkspaceRevision()) {
    return false;
  }

  const context = parsePersistedLoadContext(json, {
    currentAvailableAgents: store.availableAgents,
    currentCustomAgents: store.customAgents,
    invalidMessage: 'Invalid persisted workspace state structure, skipping load',
    parseErrorMessage: 'Failed to parse persisted workspace state',
  });
  if (!context) {
    return false;
  }

  const today = getLocalDateKey();
  const currentTasksById = new Map(Object.entries(store.tasks));
  const nextTaskIds = new Set([
    ...context.raw.taskOrder,
    ...(context.raw.collapsedTaskOrder ?? []),
  ]);
  const removedAgentIds = new Set<string>();
  const removedTaskIds = new Set<string>();

  resetTaskPromptDispatchState();
  resetTerminalFocusedInputState();

  setStore(
    produce((storeState) => {
      const agentsToDelete = new Set<string>();

      for (const [taskId, task] of Object.entries(storeState.tasks)) {
        if (nextTaskIds.has(taskId)) {
          continue;
        }

        removedTaskIds.add(taskId);
        collectTaskAgentIds(task).forEach((agentId) => agentsToDelete.add(agentId));
        removeTaskStoreState(storeState, taskId);
        removeTerminalStoreState(storeState, taskId, { agentIdsToDelete: agentsToDelete });
      }

      storeState.projects = context.projects;
      storeState.lastProjectId = context.lastProjectId;
      storeState.completedTaskDate =
        typeof context.raw.completedTaskDate === 'string' ? context.raw.completedTaskDate : today;
      storeState.completedTaskCount = toNonNegativeInt(context.raw.completedTaskCount);
      storeState.mergedLinesAdded = toNonNegativeInt(context.raw.mergedLinesAdded);
      storeState.mergedLinesRemoved = toNonNegativeInt(context.raw.mergedLinesRemoved);
      storeState.hydraCommand = context.restoredHydraCommand;
      storeState.hydraForceDispatchFromPromptPanel =
        typeof context.raw.hydraForceDispatchFromPromptPanel === 'boolean'
          ? context.raw.hydraForceDispatchFromPromptPanel
          : true;
      const rawHydraStartupMode =
        typeof context.raw.hydraStartupMode === 'string' ? context.raw.hydraStartupMode : undefined;
      storeState.hydraStartupMode = isHydraStartupMode(rawHydraStartupMode)
        ? rawHydraStartupMode
        : 'auto';
      storeState.customAgents = context.customAgents;
      storeState.availableAgents = context.availableAgents;

      forEachHydratedPersistedTaskInContext(context, {
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
            storeState.agents[entry.primaryAgentId] = createHydratedRunningAgent(
              taskId,
              entry.primaryAgentId,
              entry.agentDef,
              previousAgent,
            );
          }
        },
      });

      restorePersistedTerminals(storeState, context.raw, {
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

      syncPersistedTaskVisibility(storeState, context.raw);
    }),
  );

  for (const agentId of removedAgentIds) {
    clearAgentActivity(agentId);
  }
  clearRemovedTaskRuntimeState(removedTaskIds);

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
