import { IPC } from '../../electron/ipc/channels';
import { invoke, isElectronRuntime, sendPagehideInvoke } from '../lib/ipc';
import { buildPersistedState, buildWorkspaceSharedState } from './persistence-codecs';
import { saveBrowserColdBootstrapHandoffSnapshot } from './browser-cold-bootstrap-handoff';
import {
  getLoadedWorkspaceRevision,
  getLoadedWorkspaceStateJson,
  getStateSyncSourceId,
  recordLoadedStateJson,
  recordLoadedWorkspaceState,
} from './persistence-session';

export function getWorkspaceStateSnapshotJson(): string {
  return JSON.stringify(buildWorkspaceSharedState());
}

function createBrowserWorkspaceStateSaveRequest(json: string): {
  baseRevision: number;
  json: string;
  sourceId: string;
} {
  return {
    baseRevision: getLoadedWorkspaceRevision(),
    json,
    sourceId: getStateSyncSourceId(),
  };
}

function isWorkspaceRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Workspace state revision conflict');
}

async function refreshCanonicalWorkspaceAfterConflict(): Promise<void> {
  const payload = await invoke(IPC.LoadWorkspaceState);
  if (!payload?.json) return;
  const { applyLoadedWorkspaceStateJson } = await import('./persistence-load');
  applyLoadedWorkspaceStateJson(payload.json, payload.revision);
}

export async function saveState(): Promise<void> {
  const json = JSON.stringify(buildPersistedState());
  const sharedJson = JSON.stringify(buildWorkspaceSharedState());
  const baseRevision = getLoadedWorkspaceRevision();

  try {
    await invoke(IPC.SaveAppState, {
      baseRevision,
      json,
      sourceId: getStateSyncSourceId(),
    });
    recordLoadedStateJson(json);
    recordLoadedWorkspaceState(sharedJson, baseRevision + 1);
  } catch (error) {
    if (isWorkspaceRevisionConflict(error)) {
      await refreshCanonicalWorkspaceAfterConflict();
      throw error;
    }
    console.warn('Failed to save state:', error);
  }
}

export async function saveBrowserWorkspaceState(): Promise<void> {
  const json = JSON.stringify(buildWorkspaceSharedState());
  await saveBrowserWorkspaceStateSnapshot(json);
}

export async function saveBrowserWorkspaceStateSnapshot(json: string): Promise<void> {
  try {
    const response = await invoke(
      IPC.SaveWorkspaceState,
      createBrowserWorkspaceStateSaveRequest(json),
    );
    recordLoadedWorkspaceState(json, response.revision);
  } catch (error) {
    if (isWorkspaceRevisionConflict(error)) {
      // A pagehide write can commit after the next page reads its startup revision. Rebase
      // through the canonical owner before autosave schedules a new snapshot, not this stale one.
      await refreshCanonicalWorkspaceAfterConflict();
    }
    throw error;
  }
}

export function saveBrowserWorkspaceStateOnPagehide(): void {
  const json = JSON.stringify(buildWorkspaceSharedState());
  saveBrowserColdBootstrapHandoffSnapshot(json);
  if (json === getLoadedWorkspaceStateJson()) {
    return;
  }
  sendPagehideInvoke(IPC.SaveWorkspaceState, createBrowserWorkspaceStateSaveRequest(json));
}

export async function saveCurrentRuntimeState(): Promise<void> {
  if (isElectronRuntime()) {
    await saveState();
    return;
  }

  await saveBrowserWorkspaceState();
}
