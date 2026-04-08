import { produce } from 'solid-js/store';

import type { BrowserColdBootstrapProjection } from '../domain/browser-cold-bootstrap.js';
import type { AgentDef } from '../ipc/types.js';
import { createDisabledRemoteAccessStatus } from '../domain/server-state.js';
import { getLocalDateKey } from '../lib/date.js';
import { isHydraStartupMode } from '../lib/hydra.js';
import { clearRemovedTaskCommandLeaseState } from '../app/task-command-lease.js';
import { resetTaskPromptDispatchState } from '../app/task-prompt-dispatch.js';
import { resetTerminalFocusedInputState } from '../app/terminal-focused-input.js';
import {
  forEachHydratedPersistedTaskInContext,
  parsePersistedLoadContext,
} from './persistence-load-context.js';
import { createInitialAppStore, setStore, store } from './core.js';
import { toNonNegativeInt } from './persistence-codecs.js';
import { resetTaskCommandControllerStoreState } from './task-command-controllers.js';
import { resetTaskGitStatusRuntimeState } from './task-git-status.js';
import { clearTerminalStartupEntriesForTask } from './terminal-startup.js';
import { syncTerminalCounter } from './terminals.js';
import { clearAgentActivity, markAgentSpawned } from './taskStatus.js';
import {
  restorePersistedTerminals,
  syncPersistedTaskVisibility,
} from './persistence-terminal-restore.js';
import type { Agent } from './types.js';

interface BrowserColdBootstrapProjectionBuildOptions {
  currentAvailableAgents: ReadonlyArray<AgentDef>;
  currentCustomAgents: ReadonlyArray<AgentDef>;
}

function createEmptyBrowserColdBootstrapProjection(
  options?: Partial<BrowserColdBootstrapProjectionBuildOptions>,
): BrowserColdBootstrapProjection {
  return {
    availableAgents: [...(options?.currentAvailableAgents ?? [])],
    collapsedTaskOrder: [],
    completedTaskCount: 0,
    completedTaskDate: getLocalDateKey(),
    customAgents: [...(options?.currentCustomAgents ?? [])],
    hydraCommand: '',
    hydraForceDispatchFromPromptPanel: true,
    hydraStartupMode: 'auto',
    lastProjectId: null,
    mergedLinesAdded: 0,
    mergedLinesRemoved: 0,
    projects: [],
    taskOrder: [],
    tasks: {},
    terminals: {},
  };
}

function clearRemovedTaskRuntimeState(taskIds: Iterable<string>): void {
  for (const taskId of taskIds) {
    void clearRemovedTaskCommandLeaseState(taskId);
    clearTerminalStartupEntriesForTask(taskId);
  }
}

function getCompletedTaskDate(value: unknown, today: string): string {
  if (typeof value === 'string') {
    return value;
  }

  return today;
}

function getHydraStartupMode(value: unknown): BrowserColdBootstrapProjection['hydraStartupMode'] {
  if (typeof value === 'string' && isHydraStartupMode(value)) {
    return value;
  }

  return 'auto';
}

function createHydratedRunningAgent(taskId: string, agentId: string, agentDef: AgentDef): Agent {
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

function withSavedAgentDef<TTask extends { savedAgentDef?: AgentDef }>(
  task: TTask,
  agentDef: AgentDef | null | undefined,
): TTask {
  if (!agentDef) {
    return task;
  }

  return {
    ...task,
    savedAgentDef: agentDef,
  };
}

function restoreExpandedProjectionAgents(storeState: typeof store): string[] {
  const restoredRunningAgentIds: string[] = [];

  for (const task of Object.values(storeState.tasks)) {
    const agentId = task.agentIds[0];
    const agentDef = task.savedAgentDef;
    if (!agentId || !agentDef || task.collapsed) {
      continue;
    }

    storeState.agents[agentId] = createHydratedRunningAgent(task.id, agentId, agentDef);
    restoredRunningAgentIds.push(agentId);
  }

  return restoredRunningAgentIds;
}

function resetStoreForBrowserColdBootstrap(
  storeState: typeof store,
  initialStore: ReturnType<typeof createInitialAppStore>,
): void {
  storeState.tasks = {};
  storeState.terminals = {};
  storeState.agents = {};
  storeState.agentSupervision = {};
  storeState.agentActive = {};
  storeState.activeTaskId = initialStore.activeTaskId;
  storeState.activeAgentId = initialStore.activeAgentId;
  storeState.lastAgentId = initialStore.lastAgentId;
  storeState.taskGitStatus = {};
  storeState.taskPorts = {};
  storeState.taskConvergence = {};
  storeState.taskReview = {};
  storeState.incomingTaskTakeoverRequests = {};
  storeState.peerSessions = {};
  resetTaskCommandControllerStoreState(storeState);
  storeState.focusedPanel = {};
  storeState.sidebarFocused = initialStore.sidebarFocused;
  storeState.sidebarFocusedProjectId = initialStore.sidebarFocusedProjectId;
  storeState.sidebarFocusedTaskId = initialStore.sidebarFocusedTaskId;
  storeState.placeholderFocused = initialStore.placeholderFocused;
  storeState.placeholderFocusedButton = initialStore.placeholderFocusedButton;
  storeState.sidebarSectionCollapsed = { ...initialStore.sidebarSectionCollapsed };
  storeState.sidebarVisible = initialStore.sidebarVisible;
  storeState.fontScales = {};
  storeState.panelSizes = {};
  storeState.globalScale = initialStore.globalScale;
  storeState.terminalFont = initialStore.terminalFont;
  storeState.themePreset = initialStore.themePreset;
  storeState.windowState = initialStore.windowState;
  storeState.showPlans = initialStore.showPlans;
  storeState.terminalHighLoadMode = initialStore.terminalHighLoadMode;
  storeState.taskNotificationsEnabled = initialStore.taskNotificationsEnabled;
  storeState.taskNotificationsPreferenceInitialized =
    initialStore.taskNotificationsPreferenceInitialized;
  storeState.inactiveColumnOpacity = initialStore.inactiveColumnOpacity;
  storeState.editorCommand = initialStore.editorCommand;
  storeState.remoteAccess = createDisabledRemoteAccessStatus(initialStore.remoteAccess.port);
  storeState.missingProjectIds = {};
}

export function buildBrowserColdBootstrapProjectionFromJson(
  json: string | null,
  options: BrowserColdBootstrapProjectionBuildOptions,
): BrowserColdBootstrapProjection {
  if (!json) {
    return createEmptyBrowserColdBootstrapProjection(options);
  }

  const context = parsePersistedLoadContext(json, {
    currentAvailableAgents: options.currentAvailableAgents,
    currentCustomAgents: options.currentCustomAgents,
    invalidMessage: 'Invalid browser cold bootstrap workspace state structure, skipping load',
    parseErrorMessage: 'Failed to parse browser cold bootstrap workspace state',
  });
  if (!context) {
    return createEmptyBrowserColdBootstrapProjection(options);
  }

  const tempStore = createInitialAppStore();
  const today = getLocalDateKey();

  forEachHydratedPersistedTaskInContext(context, {
    getExistingTask() {
      return undefined;
    },
    visit(entry) {
      tempStore.tasks[entry.taskId] = withSavedAgentDef(entry.task, entry.agentDef);
    },
  });

  restorePersistedTerminals(tempStore, context.raw);
  syncPersistedTaskVisibility(tempStore, context.raw);

  return {
    availableAgents: [...context.availableAgents],
    collapsedTaskOrder: [...tempStore.collapsedTaskOrder],
    completedTaskCount: toNonNegativeInt(context.raw.completedTaskCount),
    completedTaskDate: getCompletedTaskDate(context.raw.completedTaskDate, today),
    customAgents: [...context.customAgents],
    hydraCommand: context.restoredHydraCommand,
    hydraForceDispatchFromPromptPanel:
      typeof context.raw.hydraForceDispatchFromPromptPanel === 'boolean'
        ? context.raw.hydraForceDispatchFromPromptPanel
        : true,
    hydraStartupMode: getHydraStartupMode(context.raw.hydraStartupMode),
    lastProjectId: context.lastProjectId,
    mergedLinesAdded: toNonNegativeInt(context.raw.mergedLinesAdded),
    mergedLinesRemoved: toNonNegativeInt(context.raw.mergedLinesRemoved),
    projects: [...context.projects],
    taskOrder: [...tempStore.taskOrder],
    tasks: { ...tempStore.tasks },
    terminals: { ...tempStore.terminals },
  };
}

export function applyBrowserColdBootstrapProjection(
  projection: BrowserColdBootstrapProjection,
): boolean {
  const previousAgentIds = Object.keys(store.agents);
  const previousTaskIds = Object.keys(store.tasks);
  const nextTaskIds = new Set([...projection.taskOrder, ...projection.collapsedTaskOrder]);
  const removedTaskIds = previousTaskIds.filter((taskId) => !nextTaskIds.has(taskId));
  const initialStore = createInitialAppStore();
  let restoredRunningAgentIds: string[] = [];

  resetTaskPromptDispatchState();
  resetTerminalFocusedInputState();
  resetTaskGitStatusRuntimeState();

  setStore(
    produce((storeState) => {
      resetStoreForBrowserColdBootstrap(storeState, initialStore);
      storeState.tasks = { ...projection.tasks };
      storeState.terminals = { ...projection.terminals };
      storeState.projects = [...projection.projects];
      storeState.lastProjectId = projection.lastProjectId;
      storeState.completedTaskDate = projection.completedTaskDate;
      storeState.completedTaskCount = projection.completedTaskCount;
      storeState.mergedLinesAdded = projection.mergedLinesAdded;
      storeState.mergedLinesRemoved = projection.mergedLinesRemoved;
      storeState.hydraCommand = projection.hydraCommand;
      storeState.hydraForceDispatchFromPromptPanel = projection.hydraForceDispatchFromPromptPanel;
      storeState.hydraStartupMode = projection.hydraStartupMode;
      storeState.customAgents = [...projection.customAgents];
      storeState.availableAgents = [...projection.availableAgents];
      storeState.taskOrder = [...projection.taskOrder];
      storeState.collapsedTaskOrder = [...projection.collapsedTaskOrder];
      restoredRunningAgentIds = restoreExpandedProjectionAgents(storeState);
    }),
  );

  for (const agentId of previousAgentIds) {
    clearAgentActivity(agentId);
  }
  for (const agentId of restoredRunningAgentIds) {
    markAgentSpawned(agentId);
  }

  clearRemovedTaskRuntimeState(removedTaskIds);
  syncTerminalCounter();
  return true;
}
