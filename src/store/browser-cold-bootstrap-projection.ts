import { produce } from 'solid-js/store';

import type { BrowserColdBootstrapProjection } from '../domain/browser-cold-bootstrap.js';
import { createDisabledRemoteAccessStatus } from '../domain/server-state.js';
import type { AgentDef } from '../ipc/types.js';
import { resetTaskPromptDispatchState } from '../app/task-prompt-dispatch.js';
import { resetTerminalFocusedInputState } from '../app/terminal-focused-input.js';
import { createInitialAppStore, setStore, store } from './core.js';
import { resetTaskCommandControllerStoreState } from './task-command-controllers.js';
import { resetTaskGitStatusRuntimeState } from './task-git-status.js';
import { syncTerminalCounter } from './terminals.js';
import { clearAgentActivity, markAgentSpawned } from './taskStatus.js';
import { clearRemovedTaskRuntimeState } from './task-state-cleanup.js';
import type { Agent } from './types.js';

export { buildBrowserColdBootstrapProjectionFromJson } from '../domain/browser-cold-bootstrap-projection-builder.js';

function isProjectedTaskId(projection: BrowserColdBootstrapProjection, taskId: string): boolean {
  return projection.tasks[taskId] !== undefined;
}

function getProjectedTaskOrders(
  projection: BrowserColdBootstrapProjection,
): Pick<typeof store, 'taskOrder' | 'collapsedTaskOrder'> {
  const taskOrder = projection.taskOrder.filter((taskId) => isProjectedTaskId(projection, taskId));
  const activeTaskIds = new Set(taskOrder);
  const collapsedTaskOrder = projection.collapsedTaskOrder.filter(
    (taskId) => isProjectedTaskId(projection, taskId) && !activeTaskIds.has(taskId),
  );

  return {
    taskOrder,
    collapsedTaskOrder,
  };
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
  storeState.taskReviewSignals = {};
  storeState.taskSteps = {};
  storeState.taskStepSummaries = {};
  storeState.incomingTaskTakeoverRequests = {};
  storeState.pendingAction = null;
  storeState.permissionRequests = {};
  storeState.permissionAutoRules = [];
  storeState.reviewComments = {};
  storeState.reviewPanelOpen = {};
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
  storeState.terminalFontSize = initialStore.terminalFontSize;
  storeState.terminalFont = initialStore.terminalFont;
  storeState.fontSmoothing = initialStore.fontSmoothing;
  storeState.themePreset = initialStore.themePreset;
  storeState.windowState = initialStore.windowState;
  storeState.showPlans = initialStore.showPlans;
  storeState.terminalHighLoadMode = initialStore.terminalHighLoadMode;
  storeState.taskNotificationsEnabled = initialStore.taskNotificationsEnabled;
  storeState.taskNotificationsPreferenceInitialized =
    initialStore.taskNotificationsPreferenceInitialized;
  storeState.verboseLogging = initialStore.verboseLogging;
  storeState.inactiveColumnOpacity = initialStore.inactiveColumnOpacity;
  storeState.editorCommand = initialStore.editorCommand;
  storeState.remoteAccess = createDisabledRemoteAccessStatus(initialStore.remoteAccess.port);
  storeState.missingProjectIds = {};
}

export function applyBrowserColdBootstrapProjection(
  projection: BrowserColdBootstrapProjection,
): boolean {
  const { taskOrder, collapsedTaskOrder } = getProjectedTaskOrders(projection);
  const previousAgentIds = Object.keys(store.agents);
  const previousTaskIds = Object.keys(store.tasks);
  const nextTaskIds = new Set([...taskOrder, ...collapsedTaskOrder]);
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
      storeState.taskOrder = [...taskOrder];
      storeState.collapsedTaskOrder = [...collapsedTaskOrder];
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
