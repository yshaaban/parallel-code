import { createEffect, onCleanup } from 'solid-js';
import { isElectronRuntime } from '../lib/ipc';
import { getClientSessionStateSnapshotJson, saveClientSessionState } from './client-session';
import {
  getWorkspaceStateSnapshotJson,
  saveBrowserWorkspaceStateSnapshot,
  saveState,
} from './persistence';

let autosaveTimer: number | undefined;
let autosaveSnapshot = '';
let pendingWorkspaceAutosaveSnapshot: string | null = null;
let workspaceAutosaveInFlight = false;
let workspaceAutosaveGeneration = 0;
let clientSessionAutosaveTimer: number | undefined;
let clientSessionAutosaveSnapshot = '';
let pendingClientSessionAutosaveSnapshot: string | null = null;
let clientSessionAutosaveInFlight = false;
let clientSessionAutosaveGeneration = 0;
const AUTOSAVE_DELAY_MS = 1000;

function isWorkspaceRevisionConflictError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Workspace state revision conflict');
}

function clearAutosaveTimer(timer: number | undefined): void {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

function scheduleWorkspaceAutosave(): void {
  if (workspaceAutosaveInFlight || pendingWorkspaceAutosaveSnapshot === null) {
    return;
  }

  clearAutosaveTimer(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = undefined;
    const snapshot = pendingWorkspaceAutosaveSnapshot;
    if (snapshot === null) {
      return;
    }

    workspaceAutosaveInFlight = true;
    const autosaveGeneration = ++workspaceAutosaveGeneration;
    if (isElectronRuntime()) {
      void saveState()
        .then(() => {
          if (autosaveGeneration !== workspaceAutosaveGeneration) {
            return;
          }
          autosaveSnapshot = getWorkspaceStateSnapshotJson();
          pendingWorkspaceAutosaveSnapshot =
            pendingWorkspaceAutosaveSnapshot === snapshot ? null : pendingWorkspaceAutosaveSnapshot;
        })
        .catch((error) => {
          if (autosaveGeneration !== workspaceAutosaveGeneration) {
            return;
          }
          console.warn('Failed to save workspace state:', error);
          scheduleWorkspaceAutosave();
        })
        .finally(() => {
          if (autosaveGeneration !== workspaceAutosaveGeneration) {
            return;
          }
          workspaceAutosaveInFlight = false;
          if (
            pendingWorkspaceAutosaveSnapshot !== null &&
            pendingWorkspaceAutosaveSnapshot !== autosaveSnapshot
          ) {
            scheduleWorkspaceAutosave();
          }
        });
      return;
    }

    void saveBrowserWorkspaceStateSnapshot(snapshot)
      .then(() => {
        if (autosaveGeneration !== workspaceAutosaveGeneration) {
          return;
        }
        autosaveSnapshot = snapshot;
        if (pendingWorkspaceAutosaveSnapshot === snapshot) {
          pendingWorkspaceAutosaveSnapshot = null;
        }
      })
      .catch((error) => {
        if (autosaveGeneration !== workspaceAutosaveGeneration) {
          return;
        }
        console.warn('Failed to save workspace state:', error);
        if (!isWorkspaceRevisionConflictError(error)) {
          scheduleWorkspaceAutosave();
        }
      })
      .finally(() => {
        if (autosaveGeneration !== workspaceAutosaveGeneration) {
          return;
        }
        workspaceAutosaveInFlight = false;
        if (
          pendingWorkspaceAutosaveSnapshot !== null &&
          pendingWorkspaceAutosaveSnapshot !== autosaveSnapshot
        ) {
          scheduleWorkspaceAutosave();
        }
      });
  }, AUTOSAVE_DELAY_MS);
}

function scheduleClientSessionAutosave(): void {
  if (clientSessionAutosaveInFlight || pendingClientSessionAutosaveSnapshot === null) {
    return;
  }

  clearAutosaveTimer(clientSessionAutosaveTimer);
  clientSessionAutosaveTimer = window.setTimeout(() => {
    clientSessionAutosaveTimer = undefined;
    clientSessionAutosaveInFlight = true;
    const autosaveGeneration = ++clientSessionAutosaveGeneration;
    saveClientSessionState();
    if (autosaveGeneration !== clientSessionAutosaveGeneration) {
      return;
    }
    clientSessionAutosaveSnapshot = getClientSessionStateSnapshotJson();
    if (pendingClientSessionAutosaveSnapshot === clientSessionAutosaveSnapshot) {
      pendingClientSessionAutosaveSnapshot = null;
    }
    clientSessionAutosaveInFlight = false;
    if (
      pendingClientSessionAutosaveSnapshot !== null &&
      pendingClientSessionAutosaveSnapshot !== clientSessionAutosaveSnapshot
    ) {
      scheduleClientSessionAutosave();
    }
  }, AUTOSAVE_DELAY_MS);
}

export function getAutosaveWorkspaceSnapshot(): string {
  return getWorkspaceStateSnapshotJson();
}

export function getAutosaveClientSessionSnapshot(): string {
  return getClientSessionStateSnapshotJson();
}

export function hasPendingWorkspaceAutosaveChanges(): boolean {
  return (
    pendingWorkspaceAutosaveSnapshot !== null &&
    pendingWorkspaceAutosaveSnapshot !== autosaveSnapshot
  );
}

export function setupAutosave(): void {
  autosaveSnapshot = getAutosaveWorkspaceSnapshot();
  pendingWorkspaceAutosaveSnapshot = null;
  clientSessionAutosaveSnapshot = getAutosaveClientSessionSnapshot();
  pendingClientSessionAutosaveSnapshot = null;

  createEffect(() => {
    const snapshot = getAutosaveWorkspaceSnapshot();

    if (snapshot === autosaveSnapshot && pendingWorkspaceAutosaveSnapshot === null) {
      return;
    }

    pendingWorkspaceAutosaveSnapshot = snapshot;
    scheduleWorkspaceAutosave();
  });

  if (!isElectronRuntime()) {
    createEffect(() => {
      const snapshot = getAutosaveClientSessionSnapshot();
      if (
        snapshot === clientSessionAutosaveSnapshot &&
        pendingClientSessionAutosaveSnapshot === null
      ) {
        return;
      }

      pendingClientSessionAutosaveSnapshot = snapshot;
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
  pendingWorkspaceAutosaveSnapshot = null;
  workspaceAutosaveInFlight = false;
  workspaceAutosaveGeneration += 1;
  clientSessionAutosaveSnapshot = getAutosaveClientSessionSnapshot();
  pendingClientSessionAutosaveSnapshot = null;
  clientSessionAutosaveInFlight = false;
  clientSessionAutosaveGeneration += 1;
  clearAutosaveTimer(autosaveTimer);
  autosaveTimer = undefined;
  clearAutosaveTimer(clientSessionAutosaveTimer);
  clientSessionAutosaveTimer = undefined;
}
