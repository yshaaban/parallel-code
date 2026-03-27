import { reconcile } from 'solid-js/store';
import { DEFAULT_TERMINAL_FONT, isTerminalFont } from '../lib/fonts';
import { isElectronRuntime } from '../lib/ipc';
import { isLookPreset } from '../lib/look';
import { isNonEmptyString } from '../lib/type-guards';
import { syncTerminalHighLoadMode } from '../app/terminal-high-load-mode';
import { setStore, store } from './core';
import {
  isStringNumberRecord,
  normalizeInactiveColumnOpacity,
  resolvePersistedTerminalHighLoadMode,
} from './persistence-codecs';
import { parsePersistedWindowState } from './persistence-legacy-state';
import { normalizeSidebarSectionCollapsedState } from './sidebar-section-state';
import { getPersistedTaskNotificationsEnabled } from './task-notification-preference';
import type { ClientSessionState } from './types';

const CLIENT_SESSION_STORAGE_KEY = 'parallel-code-client-session';

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === 'string',
  );
}

function getSessionStorage(): Storage | null {
  if (typeof sessionStorage === 'undefined' || isElectronRuntime()) {
    return null;
  }

  return sessionStorage;
}

function getClientSessionStateSnapshot(): ClientSessionState {
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
    taskNotificationsEnabled: store.taskNotificationsEnabled,
    taskNotificationsPreferenceInitialized: true,
    terminalFont: store.terminalFont,
    themePreset: store.themePreset,
    windowState: store.windowState ? { ...store.windowState } : null,
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

  storage.setItem(CLIENT_SESSION_STORAGE_KEY, JSON.stringify(getClientSessionStateSnapshot()));
}

export function loadClientSessionState(): boolean {
  const storage = getSessionStorage();
  if (!storage) {
    return false;
  }

  const saved = storage.getItem(CLIENT_SESSION_STORAGE_KEY);
  if (!saved) {
    return false;
  }

  let raw: ClientSessionState;
  try {
    raw = JSON.parse(saved) as ClientSessionState;
  } catch {
    storage.removeItem(CLIENT_SESSION_STORAGE_KEY);
    return false;
  }

  const activeTaskId = parseOptionalSessionId(raw.activeTaskId);
  const activeAgentId = parseOptionalSessionId(raw.activeAgentId);

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
  setStore('inactiveColumnOpacity', normalizeInactiveColumnOpacity(raw.inactiveColumnOpacity));
  setStore(
    'terminalFont',
    isTerminalFont(raw.terminalFont) ? raw.terminalFont : DEFAULT_TERMINAL_FONT,
  );
  setStore('themePreset', isLookPreset(raw.themePreset) ? raw.themePreset : 'minimal');
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
