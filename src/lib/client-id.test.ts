import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageState = vi.hoisted(() => ({
  localStorage: null as Storage | null,
  sessionStorage: null as Storage | null,
}));

vi.mock('./browser-storage', () => ({
  getSafeLocalStorage: () => storageState.localStorage,
  getSafeSessionStorage: () => storageState.sessionStorage,
  getSafeStorageItem: (storage: Storage | null, key: string) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setSafeStorageItem: (storage: Storage | null, key: string, value: string) => {
    try {
      storage?.setItem(key, value);
    } catch {
      return;
    }
  },
}));

import { getPersistentClientId, resetPersistentClientIdStateForTests } from './client-id';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    clear(): void {
      values.clear();
    },
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    key(index: number): string | null {
      return [...values.keys()][index] ?? null;
    },
    get length(): number {
      return values.size;
    },
    removeItem(key: string): void {
      values.delete(key);
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
  };
}

describe('client-id', () => {
  beforeEach(() => {
    storageState.localStorage = null;
    storageState.sessionStorage = null;
    resetPersistentClientIdStateForTests();
  });

  it('returns a stable runtime fallback id when storage is unavailable', () => {
    const firstClientId = getPersistentClientId('parallel-code-client-id', 'server');
    const secondClientId = getPersistentClientId('parallel-code-client-id', 'server');

    expect(firstClientId).toBe(secondClientId);
  });

  it('returns a stable runtime fallback id when storage writes throw', () => {
    storageState.sessionStorage = {
      clear(): void {},
      getItem(): string | null {
        throw new DOMException('Access denied', 'SecurityError');
      },
      key(): string | null {
        return null;
      },
      get length(): number {
        return 0;
      },
      removeItem(): void {},
      setItem(): void {
        throw new DOMException('Access denied', 'SecurityError');
      },
    };

    const firstClientId = getPersistentClientId('parallel-code-client-id', 'server');
    const secondClientId = getPersistentClientId('parallel-code-client-id', 'server');

    expect(firstClientId).toBe(secondClientId);
  });

  it('returns the persisted client id when storage is available', () => {
    storageState.sessionStorage = createMemoryStorage();

    const firstClientId = getPersistentClientId('parallel-code-client-id', 'server');
    const secondClientId = getPersistentClientId('parallel-code-client-id', 'server');

    expect(firstClientId).toBe(secondClientId);
    expect(storageState.sessionStorage.getItem('parallel-code-client-id')).toBe(firstClientId);
  });
});
