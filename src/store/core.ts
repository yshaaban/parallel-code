import { createStore } from 'solid-js/store';
import { createDisabledRemoteAccessStatus } from '../domain/server-state';
import { getInitialTerminalHighLoadModeEnabled } from '../lib/terminal-high-load-mode-bootstrap';
import { getLocalDateKey } from '../lib/date';
import { createDefaultLocalShellPreferences } from './local-shell-preferences';
import type { AppStore } from './types';

export function createInitialAppStore(): AppStore {
  const localShellPreferences = createDefaultLocalShellPreferences({
    terminalHighLoadMode: getInitialTerminalHighLoadModeEnabled(),
    terminalLocalInputFeedbackEnabled: true,
  });

  return {
    projects: [],
    lastProjectId: null,
    lastAgentId: null,
    taskOrder: [],
    collapsedTaskOrder: [],
    tasks: {},
    terminals: {},
    agents: {},
    agentSupervision: {},
    agentActive: {},
    activeTaskId: null,
    activeAgentId: null,
    incomingTaskTakeoverRequests: {},
    peerSessions: {},
    taskCommandControllers: {},
    availableAgents: [],
    customAgents: [],
    showNewTaskDialog: false,
    showAddProjectDialog: false,
    discoveredProjects: [],
    ...localShellPreferences,
    taskGitStatus: {},
    taskPorts: {},
    taskConvergence: {},
    taskReview: {},
    taskReviewSignals: {},
    taskSteps: {},
    taskStepSummaries: {},
    coordinator: {
      runs: {},
      stateVersion: 0,
      updatedAt: null,
    },
    focusedPanel: {},
    sidebarFocused: false,
    sidebarFocusedProjectId: null,
    sidebarFocusedTaskId: null,
    placeholderFocused: false,
    placeholderFocusedButton: 'add-task',
    showHelpDialog: false,
    showSettingsDialog: false,
    markdownViewer: null,
    hasSeenDesktopIntro: false,
    pendingAction: null,
    notification: null,
    completedTaskDate: getLocalDateKey(),
    completedTaskCount: 0,
    mergedLinesAdded: 0,
    mergedLinesRemoved: 0,
    autoTrustFolders: false,
    editorCommand: '',
    hydraCommand: '',
    hydraForceDispatchFromPromptPanel: true,
    hydraStartupMode: 'auto',
    newTaskDropUrl: null,
    newTaskPrefillPrompt: null,
    missingProjectIds: {},
    remoteAccess: createDisabledRemoteAccessStatus(7777),
    showArena: false,
    permissionRequests: {},
    permissionAutoRules: [],
    reviewComments: {},
    reviewPanelOpen: {},
  };
}

export const [store, setStore] = createStore<AppStore>(createInitialAppStore());

export function updateWindowTitle(_taskName?: string): void {
  // Intentionally no-op: window title text is hidden in the custom/native title bars.
}

function panelSizeKeyMatchesId(key: string, id: string): boolean {
  return (
    key === id || key.startsWith(`${id}:`) || key.endsWith(`:${id}`) || key.includes(`:${id}:`)
  );
}

/** Remove fontScales, panelSizes, focusedPanel, and taskOrder entries for a given ID.
 *  Call inside a `produce` callback. Returns the index the item had in taskOrder. */
export function cleanupPanelEntries(s: AppStore, id: string): number {
  const idx = s.taskOrder.indexOf(id);
  delete s.focusedPanel[id];
  const prefix = id + ':';
  for (const key of Object.keys(s.fontScales)) {
    if (key === id || key.startsWith(prefix)) delete s.fontScales[key];
  }
  for (const key of Object.keys(s.panelSizes)) {
    if (panelSizeKeyMatchesId(key, id)) delete s.panelSizes[key];
  }
  s.taskOrder = s.taskOrder.filter((x) => x !== id);
  s.collapsedTaskOrder = s.collapsedTaskOrder.filter((x) => x !== id);
  return idx;
}
