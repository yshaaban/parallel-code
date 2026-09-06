import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke, invokeWithAbortSignal, isElectronRuntime } from '../lib/ipc';
import { getLocalDateKey } from '../lib/date';
import { isHydraStartupMode } from '../lib/hydra';
import type { BrowserColdBootstrapProjection } from '../domain/browser-cold-bootstrap.js';
import { resetTaskPromptDispatchState } from '../app/task-prompt-dispatch';
import { resetTerminalFocusedInputState } from '../app/terminal-focused-input';
import { syncTerminalHighLoadMode } from '../app/terminal-high-load-mode';
import { isPersistedTask } from './persistence-legacy-state';
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
import { applyBrowserColdBootstrapProjection } from './browser-cold-bootstrap-projection.js';
import { buildWorkspaceSharedState, toNonNegativeInt } from './persistence-codecs';
import {
  applyFullStateLocalShellPreferences,
  createDefaultLocalShellPreferences,
  resolveLocalShellPreferences,
} from './local-shell-preferences';
import {
  getLoadedStateJson,
  getLoadedWorkspaceRevision,
  getLoadedWorkspaceStateJson,
  getRebasedWorkspaceStateJson,
  recordLoadedStateJson,
  recordLoadedWorkspaceState,
} from './persistence-session';
import { showNotification } from './notification';
import { resetTaskGitStatusRuntimeState } from './task-git-status';
import { applyPersistedMergeProgressProjection } from '../app/merge-progress.js';
import { resetTaskCommandControllerStoreState } from './task-command-controllers';
import { getSelectedTaskRuntimeAgentId } from './task-agent-selection';
import { reconcileTaskFocusedPanelState } from './focus';
import {
  clearRemovedTaskRuntimeState,
  collectTaskAgentIds,
  removeAgentScopedStoreState,
  removeTaskStoreState,
  removeTerminalStoreState,
  reconcileTaskScopedStoreStateForExistingTasks,
} from './task-state-cleanup';
import type { Agent, AppStore } from './types';

function resetTransientPersistenceRuntimeState(): void {
  resetTaskStatusRuntimeState();
  resetTaskPromptDispatchState();
  resetTerminalFocusedInputState();
  resetTaskGitStatusRuntimeState();
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

function replaceRecordContents<T extends object>(target: T, source: T): void {
  for (const key of Object.keys(target) as Array<keyof T>) {
    if (!(key in source)) {
      delete target[key];
    }
  }

  Object.assign(target, source);
}

function getSharedWorkspaceTaskOrder(raw: {
  collapsedTaskOrder?: string[];
  taskOrder: string[];
  tasks: Record<string, unknown>;
}): {
  collapsedTaskOrder: string[];
  taskOrder: string[];
} {
  const taskOrder = raw.taskOrder.filter((taskId) => isPersistedTask(raw.tasks[taskId]));
  const activeTaskIds = new Set(taskOrder);
  const collapsedTaskOrder = (raw.collapsedTaskOrder ?? []).filter(
    (taskId) => isPersistedTask(raw.tasks[taskId]) && !activeTaskIds.has(taskId),
  );

  return {
    collapsedTaskOrder,
    taskOrder,
  };
}

function getLocalTerminalPanelOrder(): {
  collapsedTaskOrder: string[];
  taskOrder: string[];
} {
  const activeTerminalTaskOrder = store.taskOrder.filter(
    (panelId) => store.terminals[panelId] !== undefined,
  );
  const activeTerminalTaskIds = new Set(activeTerminalTaskOrder);
  const collapsedTerminalTaskOrder = store.collapsedTaskOrder.filter(
    (panelId) => store.terminals[panelId] !== undefined && !activeTerminalTaskIds.has(panelId),
  );

  return {
    collapsedTaskOrder: collapsedTerminalTaskOrder,
    taskOrder: activeTerminalTaskOrder,
  };
}

function getWorkspaceEditConflictMessage(conflictCount: number): string {
  if (conflictCount === 1) {
    return 'A local workspace edit conflicted with a newer workspace change and was not applied. The newer value was kept.';
  }
  return `${conflictCount} local workspace edits conflicted with newer workspace changes and were not applied. The newer values were kept.`;
}

function getLoadedSelectionAgentId(storeState: AppStore, panelId: string): string | null {
  const task = storeState.tasks[panelId];
  if (task) {
    return getSelectedTaskRuntimeAgentId(task, storeState.activeAgentId);
  }

  return storeState.terminals[panelId]?.agentId ?? null;
}

function reconcileLoadedActiveSelection(storeState: AppStore, electronRuntime: boolean): void {
  if (!electronRuntime) {
    storeState.activeTaskId = null;
    storeState.activeAgentId = null;
    return;
  }

  const activePanelId = storeState.activeTaskId;
  const selectedPanelId =
    activePanelId && (storeState.tasks[activePanelId] || storeState.terminals[activePanelId])
      ? activePanelId
      : (storeState.taskOrder[0] ?? null);

  storeState.activeTaskId = selectedPanelId;
  storeState.activeAgentId = selectedPanelId
    ? getLoadedSelectionAgentId(storeState, selectedPanelId)
    : null;
}

function reconcileIncrementalWorkspaceActiveTask(): void {
  const activeTaskId = store.activeTaskId;
  if (activeTaskId === null) {
    if (store.activeAgentId !== null) {
      setStore('activeAgentId', null);
    }
    return;
  }

  const activePanelIsVisible = store.taskOrder.includes(activeTaskId);
  if (activePanelIsVisible && store.tasks[activeTaskId]) {
    reconcileTaskFocusedPanelState(activeTaskId);
    return;
  }

  const activeTerminal = store.terminals[activeTaskId];
  if (activePanelIsVisible && activeTerminal) {
    setStore('activeAgentId', activeTerminal.agentId);
    return;
  }

  const fallbackPanelId =
    store.taskOrder.find((panelId) => store.tasks[panelId] || store.terminals[panelId]) ?? null;
  setStore('activeTaskId', fallbackPanelId);
  setStore(
    'activeAgentId',
    fallbackPanelId ? getLoadedSelectionAgentId(store, fallbackPanelId) : null,
  );

  if (fallbackPanelId && store.tasks[fallbackPanelId]) {
    reconcileTaskFocusedPanelState(fallbackPanelId);
  }
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
  const previousTaskIds = [...Object.keys(store.tasks), ...Object.keys(store.terminals)];
  const today = getLocalDateKey();
  const { raw } = context;
  const electronRuntime = isElectronRuntime();
  const lastAgentId: string | null = raw.lastAgentId ?? null;
  const localShellPreferenceFallbacks = {
    terminalHighLoadMode: store.terminalHighLoadMode,
    terminalLocalInputFeedbackEnabled: store.terminalLocalInputFeedbackEnabled,
  };
  const localShellPreferences = electronRuntime
    ? resolveLocalShellPreferences(raw, localShellPreferenceFallbacks)
    : createDefaultLocalShellPreferences(localShellPreferenceFallbacks);

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
      storeState.taskReviewSignals = {};
      storeState.taskSteps = {};
      storeState.taskStepSummaries = {};
      storeState.incomingTaskTakeoverRequests = {};
      storeState.pendingAction = null;
      storeState.permissionRequests = {};
      storeState.permissionAutoRules = [];
      storeState.reviewComments = {};
      storeState.reviewPanelOpen = {};
      resetTaskCommandControllerStoreState(storeState);
      storeState.focusedPanel = {};
      storeState.missingProjectIds = {};
      storeState.activeAgentId = null;
      storeState.sidebarFocused = false;
      storeState.sidebarFocusedProjectId = null;
      storeState.sidebarFocusedTaskId = null;
      storeState.placeholderFocused = false;
      storeState.placeholderFocusedButton = 'add-task';
      applyFullStateLocalShellPreferences(storeState, localShellPreferences);
      storeState.customAgents = context.customAgents;
      storeState.availableAgents = context.availableAgents;
      storeState.projects = context.projects;
      storeState.lastProjectId = context.lastProjectId;
      storeState.lastAgentId = lastAgentId;
      storeState.taskOrder = raw.taskOrder;
      storeState.activeTaskId = electronRuntime ? (raw.activeTaskId ?? null) : null;

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
      storeState.autoTrustFolders =
        typeof raw.autoTrustFolders === 'boolean' ? raw.autoTrustFolders : false;
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
          if (entry.collapsed) {
            return;
          }

          for (const { agentDef, agentId } of entry.agentEntries) {
            storeState.agents[agentId] = createHydratedRunningAgent(
              entry.taskId,
              agentId,
              agentDef,
            );
            restoredRunningAgentIds.push(agentId);
          }
        },
      });

      restorePersistedTerminals(storeState, raw);
      syncPersistedTaskVisibility(storeState, raw);
      reconcileLoadedActiveSelection(storeState, electronRuntime);
    }),
  );

  applyPersistedMergeProgressProjection(raw);

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
  // A command response can outlive its lease while a newer push is applied. Stale snapshots
  // must not rewind tasks, runtime ownership, or the pending-edit canonical base.
  if (revision < getLoadedWorkspaceRevision()) return false;
  const repeatedLoadedWorkspaceState =
    json === getLoadedWorkspaceStateJson() && revision === getLoadedWorkspaceRevision();

  const rebasedJson = getRebasedWorkspaceStateJson(json);
  const context = parsePersistedLoadContext(rebasedJson, {
    currentAvailableAgents: store.availableAgents,
    currentCustomAgents: store.customAgents,
    invalidMessage: 'Invalid persisted workspace state structure, skipping load',
    parseErrorMessage: 'Failed to parse persisted workspace state',
  });
  if (!context) {
    return false;
  }

  if (repeatedLoadedWorkspaceState) {
    let removedTaskIds: string[] = [];
    setStore(
      produce((storeState) => {
        removedTaskIds = reconcileTaskScopedStoreStateForExistingTasks(storeState);
      }),
    );
    clearRemovedTaskRuntimeState(removedTaskIds);
    reconcileIncrementalWorkspaceActiveTask();
    return false;
  }

  const today = getLocalDateKey();
  const currentTasksById = new Map(Object.entries(store.tasks));
  const sharedWorkspaceTaskOrder = getSharedWorkspaceTaskOrder(context.raw);
  const localTerminalPanelOrder = getLocalTerminalPanelOrder();
  const nextTaskIds = new Set([
    ...sharedWorkspaceTaskOrder.taskOrder,
    ...sharedWorkspaceTaskOrder.collapsedTaskOrder,
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
          if (previousTask) {
            replaceRecordContents(previousTask, entry.task);
          } else {
            storeState.tasks[taskId] = entry.task;
          }

          if (!entry.collapsed) {
            for (const { agentDef, agentId } of entry.agentEntries) {
              const previousAgent = storeState.agents[agentId];
              const hydratedAgent = createHydratedRunningAgent(
                taskId,
                agentId,
                agentDef,
                previousAgent,
              );
              if (previousAgent) {
                replaceRecordContents(previousAgent, hydratedAgent);
              } else {
                storeState.agents[agentId] = hydratedAgent;
              }
            }
          }
        },
      });

      for (const agentId of agentsToDelete) {
        removedAgentIds.add(agentId);
      }
      removeAgentScopedStoreState(storeState, agentsToDelete);

      reconcileTaskScopedStoreStateForExistingTasks(storeState).forEach((taskId) =>
        removedTaskIds.add(taskId),
      );

      storeState.taskOrder = [
        ...sharedWorkspaceTaskOrder.taskOrder,
        ...localTerminalPanelOrder.taskOrder.filter(
          (panelId) => storeState.terminals[panelId] !== undefined,
        ),
      ];
      const visiblePanelIds = new Set(storeState.taskOrder);
      storeState.collapsedTaskOrder = [
        ...sharedWorkspaceTaskOrder.collapsedTaskOrder,
        ...localTerminalPanelOrder.collapsedTaskOrder.filter(
          (panelId) => storeState.terminals[panelId] !== undefined && !visiblePanelIds.has(panelId),
        ),
      ];
    }),
  );

  applyPersistedMergeProgressProjection(context.raw);

  for (const agentId of removedAgentIds) {
    clearAgentActivity(agentId);
  }
  clearRemovedTaskRuntimeState(removedTaskIds);
  reconcileIncrementalWorkspaceActiveTask();

  const workspaceEditConflicts = recordLoadedWorkspaceState(json, revision);
  if (workspaceEditConflicts.length > 0) {
    showNotification(getWorkspaceEditConflictMessage(workspaceEditConflicts.length), {
      kind: 'warning',
      persistent: true,
    });
  }
  syncTerminalCounter();
  return true;
}

export function applyBrowserColdBootstrapWorkspaceProjection(
  projection: BrowserColdBootstrapProjection,
  revision = 0,
): boolean {
  // Cold hydration resets runtime-only state, including acquired command controllers. Once a
  // canonical workspace exists, the startup recovery owner must use incremental full-state load.
  if (getLoadedWorkspaceStateJson() !== null) return false;
  if (revision < getLoadedWorkspaceRevision()) return false;
  const didApply = applyBrowserColdBootstrapProjection(projection);
  if (!didApply) {
    return false;
  }

  recordLoadedWorkspaceState(JSON.stringify(buildWorkspaceSharedState()), revision);
  return true;
}

export async function loadWorkspaceState(signal?: AbortSignal): Promise<boolean> {
  const payload = signal
    ? await invokeWithAbortSignal(IPC.LoadWorkspaceState, signal)
    : await invoke(IPC.LoadWorkspaceState);
  signal?.throwIfAborted();
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

  const applied = applyLoadedStateJson(json);
  if (!applied || !isElectronRuntime()) {
    return applied;
  }

  // Electron keeps local and revisioned shared state in one state.json. The
  // compatibility LoadAppState response remains a plain JSON string, so read
  // the shared view once to seed stale-save CAS without exposing host metadata.
  let workspace: Awaited<ReturnType<typeof invoke<IPC.LoadWorkspaceState>>> | null = null;
  try {
    workspace = await invoke(IPC.LoadWorkspaceState);
  } catch {
    // Older desktop hosts expose only the legacy LoadAppState response. They
    // remain generation-zero writers until the host-side migration is present.
  }
  if (workspace?.json) {
    recordLoadedWorkspaceState(workspace.json, workspace.revision);
  } else if (getLoadedWorkspaceStateJson() === null) {
    recordLoadedWorkspaceState(JSON.stringify(buildWorkspaceSharedState()), 0);
  }
  return true;
}
