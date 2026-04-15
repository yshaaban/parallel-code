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

export async function saveState(): Promise<void> {
  const json = JSON.stringify(buildPersistedState());
  recordLoadedStateJson(json);

  await invoke(IPC.SaveAppState, {
    json,
    sourceId: getStateSyncSourceId(),
  }).catch((error) => console.warn('Failed to save state:', error));
}

export async function saveBrowserWorkspaceState(): Promise<void> {
  const json = JSON.stringify(buildWorkspaceSharedState());
  await saveBrowserWorkspaceStateSnapshot(json);
}

export async function saveBrowserWorkspaceStateSnapshot(json: string): Promise<void> {
  const response = await invoke(
    IPC.SaveWorkspaceState,
    createBrowserWorkspaceStateSaveRequest(json),
  );
  recordLoadedWorkspaceState(json, response.revision);
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
