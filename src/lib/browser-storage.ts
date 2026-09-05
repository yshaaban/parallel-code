export function getSafeSessionStorage(): Storage | null {
  if (typeof globalThis === 'undefined') {
    return null;
  }

  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function getSafeLocalStorage(): Storage | null {
  if (typeof globalThis === 'undefined') {
    return null;
  }

  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function getSafeStorageItem(storage: Storage | null, key: string): string | null {
  if (!storage) {
    return null;
  }

  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function setSafeStorageItem(storage: Storage | null, key: string, value: string): boolean {
  if (!storage) {
    return false;
  }

  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeSafeStorageItem(storage: Storage | null, key: string): boolean {
  if (!storage) {
    return false;
  }

  try {
    storage.removeItem(key);
    return true;
  } catch {
    // Ignore storage cleanup failures for browser-local fallback state.
    return false;
  }
}
