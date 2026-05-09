import { createRandomId } from '../lib/random-id';

function createStateSyncSourceId(): string {
  return createRandomId();
}

const STATE_SYNC_SOURCE_ID = createStateSyncSourceId();
let lastLoadedStateJson: string | null = null;
let lastLoadedWorkspaceStateJson: string | null = null;
let lastLoadedWorkspaceRevision = 0;

export function getStateSyncSourceId(): string {
  return STATE_SYNC_SOURCE_ID;
}

export function getLoadedStateJson(): string | null {
  return lastLoadedStateJson;
}

export function recordLoadedStateJson(json: string): void {
  lastLoadedStateJson = json;
}

export function getLoadedWorkspaceStateJson(): string | null {
  return lastLoadedWorkspaceStateJson;
}

export function getLoadedWorkspaceRevision(): number {
  return lastLoadedWorkspaceRevision;
}

export function recordLoadedWorkspaceState(json: string, revision: number): void {
  lastLoadedWorkspaceStateJson = json;
  lastLoadedWorkspaceRevision = revision;
}

export function resetPersistenceSessionStateForTests(): void {
  lastLoadedStateJson = null;
  lastLoadedWorkspaceStateJson = null;
  lastLoadedWorkspaceRevision = 0;
}
