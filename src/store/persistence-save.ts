import { IPC } from '../../electron/ipc/channels';
import { invoke, isElectronRuntime } from '../lib/ipc';
import { buildPersistedState, buildWorkspaceSharedState } from './persistence-codecs';
import {
  getLoadedWorkspaceRevision,
  getStateSyncSourceId,
  recordLoadedStateJson,
  recordLoadedWorkspaceState,
} from './persistence-session';

export function getWorkspaceStateSnapshotJson(): string {
  return JSON.stringify(buildWorkspaceSharedState());
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
  const response = await invoke(IPC.SaveWorkspaceState, {
    baseRevision: getLoadedWorkspaceRevision(),
    json,
    sourceId: getStateSyncSourceId(),
  });
  recordLoadedWorkspaceState(json, response.revision);
}

export async function saveCurrentRuntimeState(): Promise<void> {
  if (isElectronRuntime()) {
    await saveState();
    return;
  }

  await saveBrowserWorkspaceState();
}
