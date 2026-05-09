import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRandomId, resetRandomIdStateForTests } from './random-id';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stubCrypto(cryptoSource: Partial<Crypto> | undefined): void {
  vi.stubGlobal('crypto', cryptoSource);
}

describe('createRandomId', () => {
  afterEach(() => {
    resetRandomIdStateForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses native randomUUID when available', () => {
    const nativeId = '00000000-0000-4000-8000-000000000000';
    const randomUUID = vi.fn(
      (): ReturnType<Crypto['randomUUID']> => nativeId as ReturnType<Crypto['randomUUID']>,
    );
    stubCrypto({ randomUUID });

    expect(createRandomId()).toBe(nativeId);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('creates an RFC 4122 v4 id from getRandomValues when randomUUID is unavailable', () => {
    stubCrypto({
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        if (array instanceof Uint8Array) {
          for (let index = 0; index < array.length; index += 1) {
            array[index] = index;
          }
        }

        return array;
      },
    });

    expect(createRandomId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('keeps a UUID-shaped fallback when runtime crypto is unavailable', () => {
    stubCrypto(undefined);
    vi.spyOn(Date, 'now').mockReturnValue(1_714_000_000_000);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const firstId = createRandomId();
    const secondId = createRandomId();

    expect(firstId).toMatch(UUID_V4_RE);
    expect(secondId).toMatch(UUID_V4_RE);
    expect(secondId).not.toBe(firstId);
  });
});
