import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getSafeLocalStorage,
  getSafeSessionStorage,
  getSafeStorageItem,
  removeSafeStorageItem,
  setSafeStorageItem,
} from './browser-storage';

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

describe('browser-storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the available browser storage objects when access is allowed', () => {
    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('localStorage', localStorage);
    vi.stubGlobal('sessionStorage', sessionStorage);

    expect(getSafeLocalStorage()).toBe(localStorage);
    expect(getSafeSessionStorage()).toBe(sessionStorage);
    sessionStorage.setItem('credential', 'value');
    expect(removeSafeStorageItem(sessionStorage, 'credential')).toBe(true);
    expect(sessionStorage.getItem('credential')).toBeNull();
  });

  it('returns null when browser storage access throws a security error', () => {
    vi.stubGlobal('window', globalThis);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    });

    expect(getSafeLocalStorage()).toBeNull();
    expect(getSafeSessionStorage()).toBeNull();
  });

  it('guards individual storage operations when storage methods throw', () => {
    const throwingStorage = {
      clear(): void {},
      getItem(): string | null {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
      key(): string | null {
        return null;
      },
      get length(): number {
        return 0;
      },
      removeItem(): void {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
      setItem(): void {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    } satisfies Storage;

    expect(getSafeStorageItem(throwingStorage, 'key')).toBeNull();
    expect(setSafeStorageItem(throwingStorage, 'key', 'value')).toBe(false);
    expect(removeSafeStorageItem(throwingStorage, 'key')).toBe(false);
  });
});
