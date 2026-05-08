import { produce, reconcile } from 'solid-js/store';
import { DEFAULT_TERMINAL_FONT, isTerminalFont } from '../lib/fonts';
import { isElectronRuntime } from '../lib/ipc';
import { isLookPreset } from '../lib/look';
import { isNonEmptyString } from '../lib/type-guards';
import {
  getSafeSessionStorage,
  getSafeStorageItem,
  removeSafeStorageItem,
  setSafeStorageItem,
} from '../lib/browser-storage';
import { syncTerminalHighLoadMode } from '../app/terminal-high-load-mode';
import { DEFAULT_FONT_SMOOTHING, DEFAULT_TERMINAL_FONT_SIZE, setStore, store } from './core';
import {
  isStringNumberRecord,
  normalizeInactiveColumnOpacity,
  resolvePersistedFontSmoothing,
  resolvePersistedTerminalFontSize,
  resolvePersistedTerminalHighLoadMode,
} from './persistence-codecs';
import type { LegacyPersistedState } from './persistence-legacy-state';
import { parsePersistedWindowState } from './persistence-legacy-state';
import {
  parsePersistedTerminalPanels,
  restorePersistedTerminals,
  syncPersistedTaskVisibility,
} from './persistence-terminal-restore';
import { normalizeSidebarSectionCollapsedState } from './sidebar-section-state';
import { getPersistedTaskNotificationsEnabled } from './task-notification-preference';
import { normalizeKeybindings } from './keybindings';
import { syncTerminalCounter } from './terminals';
import type { ClientSessionState, ClientSessionTerminalPanels, PersistedTerminal } from './types';

const CLIENT_SESSION_STORAGE_KEY = 'parallel-code-client-session';

interface LoadClientSessionStateOptions {
  restoreTerminalPanels?: boolean;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === 'string',
  );
}

function getSessionStorage(): Storage | null {
  if (isElectronRuntime()) {
    return null;
  }

  return getSafeSessionStorage();
}

function buildClientSessionTerminalPanelsSnapshot(): ClientSessionTerminalPanels | undefined {
  const taskOrder = store.taskOrder.filter(
    (panelId) => store.tasks[panelId] || store.terminals[panelId],
  );
  const collapsedTaskOrder = store.collapsedTaskOrder.filter(
    (panelId) => store.tasks[panelId] || store.terminals[panelId],
  );
  const terminals: Record<string, PersistedTerminal> = {};

  for (const panelId of [...taskOrder, ...collapsedTaskOrder]) {
    const terminal = store.terminals[panelId];
    if (!terminal) {
      continue;
    }

    terminals[panelId] = {
      agentId: terminal.agentId,
      id: terminal.id,
      name: terminal.name,
    };
  }

  if (Object.keys(terminals).length === 0) {
    return undefined;
  }

  return {
    collapsedTaskOrder,
    taskOrder,
    terminals,
  };
}

function getClientSessionStateSnapshot(): ClientSessionState {
  const terminalPanels = buildClientSessionTerminalPanelsSnapshot();

  return {
    activeAgentId: store.activeAgentId,
    activeTaskId: store.activeTaskId,
    editorCommand: store.editorCommand,
    focusedPanel: { ...store.focusedPanel },
    fontScales: { ...store.fontScales },
    globalScale: store.globalScale,
    inactiveColumnOpacity: store.inactiveColumnOpacity,
    lastAgentId: store.lastAgentId,
    lastProjectId: store.lastProjectId,
    panelSizes: { ...store.panelSizes },
    placeholderFocused: store.placeholderFocused,
    placeholderFocusedButton: store.placeholderFocusedButton,
    sidebarSectionCollapsed: { ...store.sidebarSectionCollapsed },
    showPlans: store.showPlans,
    terminalHighLoadMode: store.terminalHighLoadMode,
    sidebarFocused: store.sidebarFocused,
    sidebarFocusedProjectId: store.sidebarFocusedProjectId,
    sidebarFocusedTaskId: store.sidebarFocusedTaskId,
    sidebarVisible: store.sidebarVisible,
    terminalFontSize: store.terminalFontSize,
    taskNotificationsEnabled: store.taskNotificationsEnabled,
    taskNotificationsPreferenceInitialized: true,
    ...(terminalPanels ? { terminalPanels } : {}),
    ...(store.verboseLogging ? { verboseLogging: true } : {}),
    terminalFont: store.terminalFont,
    fontSmoothing: store.fontSmoothing,
    themePreset: store.themePreset,
    windowState: store.windowState ? { ...store.windowState } : null,
    keybindings: store.keybindings,
  };
}

export function getClientSessionStateSnapshotJson(): string {
  return JSON.stringify(getClientSessionStateSnapshot());
}

function getFallbackActiveTaskId(): string | null {
  return store.taskOrder[0] ?? null;
}

function parseOptionalSessionId(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function applyClientSessionTerminalPanels(terminalPanels: ClientSessionTerminalPanels): void {
  const raw = {
    activeTaskId: null,
    collapsedTaskOrder: terminalPanels.collapsedTaskOrder,
    sidebarVisible: true,
    taskOrder: terminalPanels.taskOrder,
    tasks: {},
    terminals: terminalPanels.terminals,
  } as LegacyPersistedState;

  setStore(
    produce((storeState) => {
      restorePersistedTerminals(storeState, raw, {
        pruneMissing: true,
      });
      syncPersistedTaskVisibility(storeState, raw);
    }),
  );
  syncTerminalCounter();
}

function hasClientSessionSelection(selectionId: string | null): selectionId is string {
  if (!selectionId) {
    return false;
  }

  return Boolean(store.tasks[selectionId] || store.terminals[selectionId]);
}

function getSelectionAgentId(selectionId: string | null): string | null {
  if (!selectionId) {
    return null;
  }

  const task = store.tasks[selectionId];
  if (task) {
    return task.agentIds[0] ?? task.shellAgentIds[0] ?? null;
  }

  return store.terminals[selectionId]?.agentId ?? null;
}

function reconcileClientSessionSidebarFocus(): void {
  if (
    store.sidebarFocusedProjectId &&
    !store.projects.some((project) => project.id === store.sidebarFocusedProjectId)
  ) {
    setStore('sidebarFocusedProjectId', null);
  }

  if (!hasClientSessionSelection(store.sidebarFocusedTaskId)) {
    setStore('sidebarFocusedTaskId', null);
  }

  const nextFocusedPanel = Object.fromEntries(
    Object.entries(store.focusedPanel).filter(([selectionId]) =>
      hasClientSessionSelection(selectionId),
    ),
  );
  setStore('focusedPanel', reconcile(nextFocusedPanel));
}

function reconcileClientSessionSelection(): void {
  const activeTaskId = store.activeTaskId;
  if (hasClientSessionSelection(activeTaskId)) {
    setStore('activeAgentId', getSelectionAgentId(activeTaskId));
    return;
  }

  const fallbackActiveTaskId = getFallbackActiveTaskId();
  setStore('activeTaskId', fallbackActiveTaskId);
  setStore('activeAgentId', getSelectionAgentId(fallbackActiveTaskId));
}

export function saveClientSessionState(): void {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  setSafeStorageItem(
    storage,
    CLIENT_SESSION_STORAGE_KEY,
    JSON.stringify(getClientSessionStateSnapshot()),
  );
}

export function loadClientSessionState(options: LoadClientSessionStateOptions = {}): boolean {
  const storage = getSessionStorage();
  if (!storage) {
    return false;
  }

  const saved = getSafeStorageItem(storage, CLIENT_SESSION_STORAGE_KEY);
  if (!saved) {
    return false;
  }

  let raw: ClientSessionState;
  try {
    raw = JSON.parse(saved) as ClientSessionState;
  } catch {
    removeSafeStorageItem(storage, CLIENT_SESSION_STORAGE_KEY);
    return false;
  }

  const activeTaskId = parseOptionalSessionId(raw.activeTaskId);
  const activeAgentId = parseOptionalSessionId(raw.activeAgentId);
  const terminalPanels = parsePersistedTerminalPanels(raw.terminalPanels);
  const shouldRestoreTerminalPanels = options.restoreTerminalPanels === true;
  if (shouldRestoreTerminalPanels && terminalPanels) {
    applyClientSessionTerminalPanels(terminalPanels);
  }

  setStore('activeTaskId', activeTaskId);
  setStore('activeAgentId', activeAgentId);
  setStore('editorCommand', typeof raw.editorCommand === 'string' ? raw.editorCommand : '');
  setStore('lastProjectId', parseOptionalSessionId(raw.lastProjectId));
  setStore('lastAgentId', parseOptionalSessionId(raw.lastAgentId));
  setStore('sidebarVisible', typeof raw.sidebarVisible === 'boolean' ? raw.sidebarVisible : true);
  setStore('sidebarFocused', raw.sidebarFocused === true);
  setStore('sidebarFocusedProjectId', parseOptionalSessionId(raw.sidebarFocusedProjectId));
  setStore('sidebarFocusedTaskId', parseOptionalSessionId(raw.sidebarFocusedTaskId));
  setStore('placeholderFocused', raw.placeholderFocused === true);
  setStore(
    'placeholderFocusedButton',
    raw.placeholderFocusedButton === 'add-terminal' ? 'add-terminal' : 'add-task',
  );
  setStore(
    'sidebarSectionCollapsed',
    normalizeSidebarSectionCollapsedState(raw.sidebarSectionCollapsed),
  );
  setStore('fontScales', isStringNumberRecord(raw.fontScales) ? raw.fontScales : {});
  setStore('panelSizes', isStringNumberRecord(raw.panelSizes) ? raw.panelSizes : {});
  setStore('focusedPanel', isStringRecord(raw.focusedPanel) ? raw.focusedPanel : {});
  setStore('globalScale', typeof raw.globalScale === 'number' ? raw.globalScale : 1);
  setStore('showPlans', typeof raw.showPlans === 'boolean' ? raw.showPlans : true);
  setStore(
    'terminalHighLoadMode',
    resolvePersistedTerminalHighLoadMode(raw.terminalHighLoadMode, store.terminalHighLoadMode),
  );
  syncTerminalHighLoadMode(store.terminalHighLoadMode);
  setStore('taskNotificationsEnabled', getPersistedTaskNotificationsEnabled(raw));
  setStore('taskNotificationsPreferenceInitialized', true);
  setStore('verboseLogging', raw.verboseLogging === true);
  setStore('inactiveColumnOpacity', normalizeInactiveColumnOpacity(raw.inactiveColumnOpacity));
  setStore(
    'terminalFontSize',
    resolvePersistedTerminalFontSize(raw.terminalFontSize, DEFAULT_TERMINAL_FONT_SIZE),
  );
  setStore(
    'terminalFont',
    isTerminalFont(raw.terminalFont) ? raw.terminalFont : DEFAULT_TERMINAL_FONT,
  );
  setStore(
    'fontSmoothing',
    resolvePersistedFontSmoothing(raw.fontSmoothing, DEFAULT_FONT_SMOOTHING),
  );
  setStore('themePreset', isLookPreset(raw.themePreset) ? raw.themePreset : 'minimal');
  setStore('keybindings', normalizeKeybindings(raw.keybindings));
  setStore('windowState', parsePersistedWindowState(raw.windowState));
  reconcileClientSessionSidebarFocus();
  reconcileClientSessionSelection();
  return true;
}

export function reconcileClientSessionState(): void {
  if (isElectronRuntime()) {
    return;
  }

  reconcileClientSessionSidebarFocus();
  reconcileClientSessionSelection();
  saveClientSessionState();
}
