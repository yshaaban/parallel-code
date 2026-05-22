import { describe, expect, it } from 'vitest';

import {
  decodeBase64ToUint8Array,
  getBase64DecodedByteLength,
  isValidBase64,
  tryDecodeBase64ToUint8Array,
} from './base64';

function decodeToText(base64: string): string {
  return new TextDecoder().decode(decodeBase64ToUint8Array(base64));
}

describe('base64 helpers', () => {
  it('decodes canonical base64 payloads', () => {
    const encoded = Buffer.from('terminal payload', 'utf8').toString('base64');

    expect(getBase64DecodedByteLength(encoded)).toBe(Buffer.byteLength('terminal payload'));
    expect(decodeToText(encoded)).toBe('terminal payload');
    expect(tryDecodeBase64ToUint8Array(encoded)).toEqual(decodeBase64ToUint8Array(encoded));
    expect(decodeBase64ToUint8Array('AA==')).toEqual(new Uint8Array([0]));
    expect(decodeBase64ToUint8Array('AAA=')).toEqual(new Uint8Array([0, 0]));
  });

  it('accepts empty payloads', () => {
    expect(isValidBase64('')).toBe(true);
    expect(decodeBase64ToUint8Array('')).toEqual(new Uint8Array(0));
  });

  it('rejects malformed or non-canonical payloads before decoding', () => {
    const invalidPayloads = ['not-valid-base64!', 'abc', 'abcd=', '====', 'AA=A', 'AB==', 'AAB='];

    for (const payload of invalidPayloads) {
      expect(getBase64DecodedByteLength(payload)).toBeNull();
      expect(isValidBase64(payload)).toBe(false);
      expect(tryDecodeBase64ToUint8Array(payload)).toBeNull();
      expect(() => decodeBase64ToUint8Array(payload)).toThrow('Invalid base64 payload');
    }
  });
});
