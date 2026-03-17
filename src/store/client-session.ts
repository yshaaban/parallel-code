import { DEFAULT_TERMINAL_FONT, isTerminalFont } from '../lib/fonts';
import { isElectronRuntime } from '../lib/ipc';
import { isLookPreset } from '../lib/look';
import { setStore, store } from './core';
import type { ClientSessionState, PersistedWindowState } from './types';

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

function parsePersistedWindowState(value: unknown): PersistedWindowState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const { x, y, width, height, maximized } = raw;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0 ||
    typeof maximized !== 'boolean'
  ) {
    return null;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    maximized,
  };
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
    showPlans: store.showPlans,
    sidebarFocused: store.sidebarFocused,
    sidebarFocusedProjectId: store.sidebarFocusedProjectId,
    sidebarFocusedTaskId: store.sidebarFocusedTaskId,
    sidebarVisible: store.sidebarVisible,
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

  const activeTaskId =
    typeof raw.activeTaskId === 'string' && raw.activeTaskId.length > 0 ? raw.activeTaskId : null;
  const activeAgentId =
    typeof raw.activeAgentId === 'string' && raw.activeAgentId.length > 0
      ? raw.activeAgentId
      : null;

  setStore('activeTaskId', activeTaskId);
  setStore('activeAgentId', activeAgentId);
  setStore('editorCommand', typeof raw.editorCommand === 'string' ? raw.editorCommand : '');
  setStore(
    'lastProjectId',
    typeof raw.lastProjectId === 'string' && raw.lastProjectId.length > 0
      ? raw.lastProjectId
      : null,
  );
  setStore(
    'lastAgentId',
    typeof raw.lastAgentId === 'string' && raw.lastAgentId.length > 0 ? raw.lastAgentId : null,
  );
  setStore('sidebarVisible', typeof raw.sidebarVisible === 'boolean' ? raw.sidebarVisible : true);
  setStore('sidebarFocused', raw.sidebarFocused === true);
  setStore(
    'sidebarFocusedProjectId',
    typeof raw.sidebarFocusedProjectId === 'string' && raw.sidebarFocusedProjectId.length > 0
      ? raw.sidebarFocusedProjectId
      : null,
  );
  setStore(
    'sidebarFocusedTaskId',
    typeof raw.sidebarFocusedTaskId === 'string' && raw.sidebarFocusedTaskId.length > 0
      ? raw.sidebarFocusedTaskId
      : null,
  );
  setStore('placeholderFocused', raw.placeholderFocused === true);
  setStore(
    'placeholderFocusedButton',
    raw.placeholderFocusedButton === 'add-terminal' ? 'add-terminal' : 'add-task',
  );
  setStore('fontScales', isStringNumberRecord(raw.fontScales) ? raw.fontScales : {});
  setStore('panelSizes', isStringNumberRecord(raw.panelSizes) ? raw.panelSizes : {});
  setStore('focusedPanel', isStringRecord(raw.focusedPanel) ? raw.focusedPanel : {});
  setStore('globalScale', typeof raw.globalScale === 'number' ? raw.globalScale : 1);
  setStore('showPlans', typeof raw.showPlans === 'boolean' ? raw.showPlans : true);
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
