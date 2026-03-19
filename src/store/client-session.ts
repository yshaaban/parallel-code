import { DEFAULT_TERMINAL_FONT, isTerminalFont } from '../lib/fonts';
import { isElectronRuntime } from '../lib/ipc';
import { isLookPreset } from '../lib/look';
import { isNonEmptyString } from '../lib/type-guards';
import { setStore, store } from './core';
import { parsePersistedWindowState } from './persistence-legacy-state';
import { normalizeSidebarSectionCollapsedState } from './sidebar-section-state';
import { getPersistedTaskNotificationsEnabled } from './task-notification-preference';
import type { ClientSessionState } from './types';

const CLIENT_SESSION_STORAGE_KEY = 'parallel-code-client-session';

function isStringNumberRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === 'number' && Number.isFinite(entry),
  );
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

function reconcileClientSessionSelection(): void {
  const activeTaskId = store.activeTaskId;
  if (activeTaskId && (store.tasks[activeTaskId] || store.terminals[activeTaskId])) {
    const activeTask = store.tasks[activeTaskId];
    const nextActiveAgentId =
      activeTask?.agentIds[0] ?? activeTask?.shellAgentIds[0] ?? store.activeAgentId ?? null;
    setStore('activeAgentId', nextActiveAgentId);
    return;
  }

  const fallbackActiveTaskId = getFallbackActiveTaskId();
  setStore('activeTaskId', fallbackActiveTaskId);
  const fallbackTask = fallbackActiveTaskId ? store.tasks[fallbackActiveTaskId] : null;
  setStore('activeAgentId', fallbackTask?.agentIds[0] ?? fallbackTask?.shellAgentIds[0] ?? null);
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

  const activeTaskId = isNonEmptyString(raw.activeTaskId) ? raw.activeTaskId : null;
  const activeAgentId = isNonEmptyString(raw.activeAgentId) ? raw.activeAgentId : null;

  setStore('activeTaskId', activeTaskId);
  setStore('activeAgentId', activeAgentId);
  setStore('editorCommand', typeof raw.editorCommand === 'string' ? raw.editorCommand : '');
  setStore('lastProjectId', isNonEmptyString(raw.lastProjectId) ? raw.lastProjectId : null);
  setStore('lastAgentId', isNonEmptyString(raw.lastAgentId) ? raw.lastAgentId : null);
  setStore('sidebarVisible', typeof raw.sidebarVisible === 'boolean' ? raw.sidebarVisible : true);
  setStore('sidebarFocused', raw.sidebarFocused === true);
  setStore(
    'sidebarFocusedProjectId',
    isNonEmptyString(raw.sidebarFocusedProjectId) ? raw.sidebarFocusedProjectId : null,
  );
  setStore(
    'sidebarFocusedTaskId',
    isNonEmptyString(raw.sidebarFocusedTaskId) ? raw.sidebarFocusedTaskId : null,
  );
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
  setStore('taskNotificationsEnabled', getPersistedTaskNotificationsEnabled(raw));
  setStore('taskNotificationsPreferenceInitialized', true);
  setStore(
    'inactiveColumnOpacity',
    typeof raw.inactiveColumnOpacity === 'number' &&
      Number.isFinite(raw.inactiveColumnOpacity) &&
      raw.inactiveColumnOpacity >= 0.3 &&
      raw.inactiveColumnOpacity <= 1
      ? Math.round(raw.inactiveColumnOpacity * 100) / 100
      : 0.6,
  );
  setStore(
    'terminalFont',
    isTerminalFont(raw.terminalFont) ? raw.terminalFont : DEFAULT_TERMINAL_FONT,
  );
  setStore('themePreset', isLookPreset(raw.themePreset) ? raw.themePreset : 'minimal');
  setStore('windowState', parsePersistedWindowState(raw.windowState));
  reconcileClientSessionSelection();
  return true;
}

export function reconcileClientSessionState(): void {
  if (isElectronRuntime()) {
    return;
  }

  reconcileClientSessionSelection();
  saveClientSessionState();
}
