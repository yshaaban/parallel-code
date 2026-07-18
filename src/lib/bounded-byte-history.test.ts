import { describe, expect, it } from 'vitest';

import { createBoundedByteHistory } from './bounded-byte-history';

describe('bounded-byte-history', () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  it('returns only the requested tail bytes without flattening the full history shape', () => {
    const history = createBoundedByteHistory(32);

    history.append(encoder.encode('alpha'));
    history.append(encoder.encode('beta'));
    history.append(encoder.encode('gamma'));

    expect(decoder.decode(history.getTailBytes(6))).toBe('agamma');
  });

  it('caps tail bytes to the retained history length', () => {
    const history = createBoundedByteHistory(8);

    history.append(encoder.encode('0123456789'));

    expect(decoder.decode(history.getTailBytes(64))).toBe('23456789');
  });

  it('preserves exact byte order across whole-segment and partial-segment trimming', () => {
    const history = createBoundedByteHistory(8);

    history.append(encoder.encode('abc'));
    history.append(encoder.encode('def'));
    history.append(encoder.encode('ghi'));
    expect(decoder.decode(history.getBytes())).toBe('bcdefghi');

    history.append(encoder.encode('jklmn'));

    expect(decoder.decode(history.getBytes())).toBe('ghijklmn');
    expect(decoder.decode(history.getTailBytes(5))).toBe('jklmn');
  });

  it('keeps appended and replaced history independent from caller-owned buffers', () => {
    const history = createBoundedByteHistory(8);
    const appended = encoder.encode('abcd');

    history.append(appended);
    appended.fill('x'.charCodeAt(0));
    expect(decoder.decode(history.getBytes())).toBe('abcd');

    const replacement = encoder.encode('123456789');
    history.replace(replacement);
    replacement.fill('y'.charCodeAt(0));
    expect(decoder.decode(history.getBytes())).toBe('23456789');
  });

  it('reuses the flattened cache until new output invalidates it', () => {
    const history = createBoundedByteHistory(16);

    history.append(encoder.encode('alpha'));
    history.append(encoder.encode('beta'));
    const first = history.getBytes();

    expect(history.getBytes()).toBe(first);

    history.append(encoder.encode('gamma'));
    const next = history.getBytes();

    expect(next).not.toBe(first);
    expect(decoder.decode(next)).toBe('alphabetagamma');
  });

  it('resets discarded-segment state when history is replaced', () => {
    const history = createBoundedByteHistory(8);

    history.append(encoder.encode('abcd'));
    history.append(encoder.encode('efgh'));
    history.append(encoder.encode('ijkl'));
    history.replace(encoder.encode('xy'));
    history.append(encoder.encode('z'));

    expect(decoder.decode(history.getBytes())).toBe('xyz');
  });

  it('retains the exact bounded suffix across repeated compaction cycles', () => {
    const chunkBytes = 32;
    const retainedChunkCount = 1_024;
    const appendedChunkCount = 10_000;
    const history = createBoundedByteHistory(chunkBytes * retainedChunkCount);

    for (let index = 0; index < appendedChunkCount; index += 1) {
      const chunk = new Uint8Array(chunkBytes);
      chunk.fill(index % 251);
      history.append(chunk);
    }

    const retained = history.getBytes();
    expect(retained).toHaveLength(chunkBytes * retainedChunkCount);
    for (let retainedIndex = 0; retainedIndex < retainedChunkCount; retainedIndex += 1) {
      const expectedByte = (appendedChunkCount - retainedChunkCount + retainedIndex) % 251;
      const chunkOffset = retainedIndex * chunkBytes;
      expect(retained[chunkOffset]).toBe(expectedByte);
      expect(retained[chunkOffset + chunkBytes - 1]).toBe(expectedByte);
    }
  });

  it('retains many small initial chunks exactly before the byte cap is reached', () => {
    const history = createBoundedByteHistory(8_192);

    for (let index = 0; index < 4_096; index += 1) {
      history.append(Uint8Array.of(index % 251));
    }

    const retained = history.getBytes();
    expect(retained).toHaveLength(4_096);
    for (let index = 0; index < retained.length; index += 1) {
      expect(retained[index]).toBe(index % 251);
    }
  });

  it('keeps a full restored snapshot bounded while thousands of small live chunks arrive', () => {
    const maxBytes = 2 * 1024 * 1024;
    const chunkBytes = 32;
    const appendedChunkCount = 50_000;
    const restored = new Uint8Array(maxBytes);
    for (let index = 0; index < restored.length; index += 1) {
      restored[index] = index % 251;
    }

    const history = createBoundedByteHistory(maxBytes);
    history.replace(restored);

    const appended = new Uint8Array(chunkBytes * appendedChunkCount);
    for (let index = 0; index < appendedChunkCount; index += 1) {
      const chunk = new Uint8Array(chunkBytes);
      chunk.fill((index + 17) % 251);
      appended.set(chunk, index * chunkBytes);
      history.append(chunk);
    }

    const expected = new Uint8Array(maxBytes);
    expected.set(restored.subarray(appended.length), 0);
    expected.set(appended, maxBytes - appended.length);

    expect(Buffer.from(history.getBytes()).equals(Buffer.from(expected))).toBe(true);
    expect(
      Buffer.from(history.getTailBytes(4_096)).equals(
        Buffer.from(expected.subarray(expected.length - 4_096)),
      ),
    ).toBe(true);
  }, 1_500);
});
