import { produce, reconcile } from 'solid-js/store';
import { isElectronRuntime } from '../lib/ipc';
import { isNonEmptyString, isRecord } from '../lib/type-guards';
import {
  getSafeSessionStorage,
  getSafeStorageItem,
  removeSafeStorageItem,
  setSafeStorageItem,
} from '../lib/browser-storage';
import { syncTerminalHighLoadMode } from '../app/terminal-high-load-mode';
import { setStore, store } from './core';
import {
  applyBrowserSessionLocalShellPreferences,
  buildBrowserLocalShellPreferences,
  resolveLocalShellPreferences,
} from './local-shell-preferences';
import type { LegacyPersistedState } from './persistence-legacy-state';
import {
  parsePersistedTerminalPanels,
  restorePersistedTerminals,
  syncPersistedTaskVisibility,
} from './persistence-terminal-restore';
import { syncTerminalCounter } from './terminals';
import { getSelectedTaskRuntimeAgentId } from './task-agent-selection';
import { reconcileTaskFocusedPanelState } from './focus';
import type { ClientSessionState, ClientSessionTerminalPanels, PersistedTerminal } from './types';

const CLIENT_SESSION_STORAGE_KEY = 'parallel-code-client-session';

interface LoadClientSessionStateOptions {
  restoreTerminalPanels?: boolean;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
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
    ...buildBrowserLocalShellPreferences(store),
    lastAgentId: store.lastAgentId,
    lastProjectId: store.lastProjectId,
    placeholderFocused: store.placeholderFocused,
    placeholderFocusedButton: store.placeholderFocusedButton,
    sidebarFocused: store.sidebarFocused,
    sidebarFocusedProjectId: store.sidebarFocusedProjectId,
    sidebarFocusedTaskId: store.sidebarFocusedTaskId,
    ...(terminalPanels ? { terminalPanels } : {}),
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

function parseClientSessionState(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

function getSelectionAgentId(
  selectionId: string | null,
  preferredAgentId?: string | null,
): string | null {
  if (!selectionId) {
    return null;
  }

  const task = store.tasks[selectionId];
  if (task) {
    return getSelectedTaskRuntimeAgentId(task, preferredAgentId);
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
    setStore('activeAgentId', getSelectionAgentId(activeTaskId, store.activeAgentId));
    if (store.tasks[activeTaskId] && store.focusedPanel[activeTaskId] !== undefined) {
      reconcileTaskFocusedPanelState(activeTaskId);
    }
    return;
  }

  const fallbackActiveTaskId = getFallbackActiveTaskId();
  setStore('activeTaskId', fallbackActiveTaskId);
  setStore('activeAgentId', getSelectionAgentId(fallbackActiveTaskId));
  if (
    fallbackActiveTaskId &&
    store.tasks[fallbackActiveTaskId] &&
    store.focusedPanel[fallbackActiveTaskId] !== undefined
  ) {
    reconcileTaskFocusedPanelState(fallbackActiveTaskId);
  }
}

export interface ClientSessionSelectionPeek {
  activeAgentId: string | null;
  activeTaskId: string | null;
  standaloneTerminalAgentId: string | null;
}

const EMPTY_CLIENT_SESSION_SELECTION_PEEK: ClientSessionSelectionPeek = {
  activeAgentId: null,
  activeTaskId: null,
  standaloneTerminalAgentId: null,
};

// Pure read of the persisted client-session fragment through the same parsers
// loadClientSessionState uses (one parser per persisted fragment); never writes
// the store. Used to publish the speculative selected-terminal intent before
// any network round trip resolves.
export function peekClientSessionSelection(): ClientSessionSelectionPeek {
  const storage = getSessionStorage();
  if (!storage) {
    return { ...EMPTY_CLIENT_SESSION_SELECTION_PEEK };
  }

  const saved = getSafeStorageItem(storage, CLIENT_SESSION_STORAGE_KEY);
  if (!saved) {
    return { ...EMPTY_CLIENT_SESSION_SELECTION_PEEK };
  }

  const raw = parseClientSessionState(saved);
  if (!raw) {
    return { ...EMPTY_CLIENT_SESSION_SELECTION_PEEK };
  }

  const activeTaskId = parseOptionalSessionId(raw.activeTaskId);
  const terminalPanels = parsePersistedTerminalPanels(raw.terminalPanels);
  const standaloneTerminalAgentId =
    activeTaskId && terminalPanels
      ? (terminalPanels.terminals[activeTaskId]?.agentId ?? null)
      : null;

  return {
    activeAgentId: parseOptionalSessionId(raw.activeAgentId),
    activeTaskId,
    standaloneTerminalAgentId,
  };
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

  const raw = parseClientSessionState(saved);
  if (!raw) {
    removeSafeStorageItem(storage, CLIENT_SESSION_STORAGE_KEY);
    return false;
  }

  const activeTaskId = parseOptionalSessionId(raw.activeTaskId);
  const activeAgentId = parseOptionalSessionId(raw.activeAgentId);
  const localShellPreferences = resolveLocalShellPreferences(raw, {
    terminalHighLoadMode: store.terminalHighLoadMode,
    terminalLocalInputFeedbackEnabled: store.terminalLocalInputFeedbackEnabled,
  });
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
  setStore('sidebarFocused', raw.sidebarFocused === true);
  setStore('sidebarFocusedProjectId', parseOptionalSessionId(raw.sidebarFocusedProjectId));
  setStore('sidebarFocusedTaskId', parseOptionalSessionId(raw.sidebarFocusedTaskId));
  setStore('placeholderFocused', raw.placeholderFocused === true);
  setStore(
    'placeholderFocusedButton',
    raw.placeholderFocusedButton === 'add-terminal' ? 'add-terminal' : 'add-task',
  );
  setStore('focusedPanel', isStringRecord(raw.focusedPanel) ? raw.focusedPanel : {});
  setStore(
    produce((storeState) => {
      applyBrowserSessionLocalShellPreferences(storeState, localShellPreferences);
    }),
  );
  syncTerminalHighLoadMode(store.terminalHighLoadMode);
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
