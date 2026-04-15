import {
  getSafeLocalStorage,
  getSafeSessionStorage,
  getSafeStorageItem,
  setSafeStorageItem,
} from './browser-storage';

const runtimeFallbackClientIds = new Map<string, string>();

function getClientStorage(): Storage | null {
  return getSafeSessionStorage() ?? getSafeLocalStorage();
}

function createRuntimeFallbackClientId(fallbackClientId: string): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    return fallbackClientId;
  }

  return crypto.randomUUID();
}

function getOrCreateRuntimeFallbackClientId(storageKey: string, fallbackClientId: string): string {
  const existingClientId = runtimeFallbackClientIds.get(storageKey);
  if (existingClientId) {
    return existingClientId;
  }

  const nextClientId = createRuntimeFallbackClientId(fallbackClientId);
  runtimeFallbackClientIds.set(storageKey, nextClientId);
  return nextClientId;
}

export function getPersistentClientId(storageKey: string, fallbackClientId: string): string {
  const storage = getClientStorage();
  if (!storage) {
    return getOrCreateRuntimeFallbackClientId(storageKey, fallbackClientId);
  }

  const existing = getSafeStorageItem(storage, storageKey);
  if (existing) {
    runtimeFallbackClientIds.set(storageKey, existing);
    return existing;
  }

  const clientId = getOrCreateRuntimeFallbackClientId(storageKey, fallbackClientId);
  setSafeStorageItem(storage, storageKey, clientId);
  return clientId;
}

export function resetPersistentClientIdStateForTests(): void {
  runtimeFallbackClientIds.clear();
}
