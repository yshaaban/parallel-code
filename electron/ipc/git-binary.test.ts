import { describe, expect, it } from 'vitest';

import { isBinaryNumstat, looksBinaryBuffer } from './git-binary.js';

describe('git binary helpers', () => {
  it('detects binary numstat output', () => {
    expect(isBinaryNumstat('-\t-\tassets/logo.png')).toBe(true);
    expect(isBinaryNumstat('12\t4\tsrc/app.ts')).toBe(false);
  });

  it('detects null bytes in a binary buffer sample', () => {
    expect(looksBinaryBuffer(Buffer.from([0x41, 0x42, 0x00, 0x43]))).toBe(true);
    expect(looksBinaryBuffer(Buffer.from('plain text file'))).toBe(false);
  });
});
