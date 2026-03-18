import { createSignal } from 'solid-js';

const DISPLAY_NAME_STORAGE_KEY = 'parallel-code-display-name';

function getDisplayNameStorage(): Storage | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  return localStorage;
}

function readStoredDisplayName(): string | null {
  const storage = getDisplayNameStorage();
  if (!storage) {
    return null;
  }

  const value = storage.getItem(DISPLAY_NAME_STORAGE_KEY)?.trim() ?? '';
  return value.length > 0 ? value : null;
}

const [storedDisplayName, setStoredDisplayNameSignal] = createSignal(readStoredDisplayName());

export function getStoredDisplayName(): string | null {
  return storedDisplayName();
}

export function getFallbackDisplayName(clientId: string): string {
  return `Session ${clientId.slice(-4).toUpperCase()}`;
}

export function setStoredDisplayName(displayName: string): string {
  const normalizedDisplayName = displayName.trim();
  const storage = getDisplayNameStorage();
  if (storage) {
    storage.setItem(DISPLAY_NAME_STORAGE_KEY, normalizedDisplayName);
  }
  setStoredDisplayNameSignal(normalizedDisplayName || null);

  return normalizedDisplayName;
}
