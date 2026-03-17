import { createEffect, onCleanup } from 'solid-js';
import { isElectronRuntime } from '../lib/ipc';
import { getClientSessionStateSnapshotJson, saveClientSessionState } from './client-session';
import { getWorkspaceStateSnapshotJson, saveBrowserWorkspaceState, saveState } from './persistence';

let autosaveTimer: number | undefined;
let autosaveSnapshot = '';
let clientSessionAutosaveTimer: number | undefined;
let clientSessionAutosaveSnapshot = '';
const AUTOSAVE_DELAY_MS = 1000;

function clearAutosaveTimer(timer: number | undefined): void {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

function scheduleWorkspaceAutosave(): void {
  clearAutosaveTimer(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    if (isElectronRuntime()) {
      void saveState();
      return;
    }

    void saveBrowserWorkspaceState().catch((error) => {
      console.warn('Failed to save workspace state:', error);
    });
  }, AUTOSAVE_DELAY_MS);
}

function scheduleClientSessionAutosave(): void {
  clearAutosaveTimer(clientSessionAutosaveTimer);
  clientSessionAutosaveTimer = window.setTimeout(() => {
    saveClientSessionState();
  }, AUTOSAVE_DELAY_MS);
}

export function getAutosaveWorkspaceSnapshot(): string {
  return getWorkspaceStateSnapshotJson();
}

export function getAutosaveClientSessionSnapshot(): string {
  return getClientSessionStateSnapshotJson();
}

export function setupAutosave(): void {
  autosaveSnapshot = getAutosaveWorkspaceSnapshot();
  clientSessionAutosaveSnapshot = getAutosaveClientSessionSnapshot();

  createEffect(() => {
    const snapshot = getAutosaveWorkspaceSnapshot();

    // Skip if nothing actually changed
    if (snapshot === autosaveSnapshot) return;
    autosaveSnapshot = snapshot;
    scheduleWorkspaceAutosave();
  });

  if (!isElectronRuntime()) {
    createEffect(() => {
      const snapshot = getAutosaveClientSessionSnapshot();
      if (snapshot === clientSessionAutosaveSnapshot) {
        return;
      }

      clientSessionAutosaveSnapshot = snapshot;
      scheduleClientSessionAutosave();
    });
  }

  onCleanup(() => {
    clearAutosaveTimer(autosaveTimer);
    autosaveTimer = undefined;
    clearAutosaveTimer(clientSessionAutosaveTimer);
    clientSessionAutosaveTimer = undefined;
  });
}

export function markAutosaveClean(): void {
  autosaveSnapshot = getAutosaveWorkspaceSnapshot();
  clientSessionAutosaveSnapshot = getAutosaveClientSessionSnapshot();
  clearAutosaveTimer(autosaveTimer);
  autosaveTimer = undefined;
  clearAutosaveTimer(clientSessionAutosaveTimer);
  clientSessionAutosaveTimer = undefined;
}
