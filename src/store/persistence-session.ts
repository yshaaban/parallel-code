function createStateSyncSourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
