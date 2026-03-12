import { createEffect, onCleanup } from 'solid-js';
import { store } from './core';
import { saveState } from './persistence';

let autosaveTimer: number | undefined;
let autosaveSnapshot = '';
const AUTOSAVE_DELAY_MS = 1000;

/** Build a snapshot string of all persisted fields. Using JSON.stringify
 *  creates a single reactive dependency on the serialized form — the effect
 *  only re-runs when a persisted value actually changes, instead of on every
 *  individual field mutation (cursor moves, panel resizes, etc.). */
function persistedSnapshot(): string {
  return JSON.stringify({
    projects: store.projects,
    lastProjectId: store.lastProjectId,
    lastAgentId: store.lastAgentId,
    taskOrder: store.taskOrder,
    collapsedTaskOrder: store.collapsedTaskOrder,
    activeTaskId: store.activeTaskId,
    sidebarVisible: store.sidebarVisible,
    fontScales: store.fontScales,
    panelSizes: store.panelSizes,
    globalScale: store.globalScale,
    completedTaskDate: store.completedTaskDate,
    completedTaskCount: store.completedTaskCount,
    mergedLinesAdded: store.mergedLinesAdded,
    mergedLinesRemoved: store.mergedLinesRemoved,
    terminalFont: store.terminalFont,
    themePreset: store.themePreset,
    windowState: store.windowState,
    autoTrustFolders: store.autoTrustFolders,
    showPlans: store.showPlans,
    inactiveColumnOpacity: store.inactiveColumnOpacity,
    editorCommand: store.editorCommand,
    customAgents: store.customAgents,
    tasks: Object.fromEntries(
      [...store.taskOrder, ...store.collapsedTaskOrder].flatMap((id) => {
        const task = store.tasks[id];
        if (!task) return [];

        return [
          [
            id,
            {
              notes: task.notes,
              lastPrompt: task.lastPrompt,
              name: task.name,
              agentIds: task.agentIds,
              shellAgentIds: task.shellAgentIds,
              directMode: task.directMode,
              savedInitialPrompt: task.savedInitialPrompt,
              collapsed: task.collapsed,
            },
          ],
        ];
      }),
    ),
    terminals: Object.fromEntries(
      store.taskOrder.flatMap((id) => {
        const terminal = store.terminals[id];
        if (!terminal) return [];

        return [[id, { name: terminal.name, agentId: terminal.agentId }]];
      }),
    ),
  });
}

export function setupAutosave(): void {
  autosaveSnapshot = persistedSnapshot();

  createEffect(() => {
    const snapshot = persistedSnapshot();

    // Skip if nothing actually changed
    if (snapshot === autosaveSnapshot) return;
    autosaveSnapshot = snapshot;

    clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => saveState(), AUTOSAVE_DELAY_MS);
  });

  onCleanup(() => {
    clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
  });
}

export function markAutosaveClean(): void {
  autosaveSnapshot = persistedSnapshot();
  clearTimeout(autosaveTimer);
  autosaveTimer = undefined;
}
