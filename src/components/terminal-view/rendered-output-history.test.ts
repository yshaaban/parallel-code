import { describe, expect, it } from 'vitest';

import { createRenderedOutputHistoryBuffer } from './rendered-output-history';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('rendered-output-history', () => {
  it('preserves append order across multiple segments', () => {
    const history = createRenderedOutputHistoryBuffer(64);

    history.append(encoder.encode('alpha '));
    history.append(encoder.encode('beta '));
    history.append(encoder.encode('gamma'));

    expect(decoder.decode(history.getBytes())).toBe('alpha beta gamma');
  });

  it('keeps only the newest bytes when appends exceed the max history window', () => {
    const history = createRenderedOutputHistoryBuffer(12);

    history.append(encoder.encode('prefix-'));
    history.append(encoder.encode('suffix-tail'));

    expect(decoder.decode(history.getBytes())).toBe('-suffix-tail');
  });

  it('trims from the front when a later append slightly overflows the history window', () => {
    const history = createRenderedOutputHistoryBuffer(10);

    history.append(encoder.encode('abcde'));
    history.append(encoder.encode('fghij'));
    history.append(encoder.encode('kl'));

    expect(decoder.decode(history.getBytes())).toBe('cdefghijkl');
  });

  it('replaces the full buffer with the last maxBytes from a large snapshot', () => {
    const history = createRenderedOutputHistoryBuffer(6);

    history.replace(encoder.encode('snapshot-data'));

    expect(decoder.decode(history.getBytes())).toBe('t-data');
  });

  it('returns the cached flattened bytes when the buffer has not changed', () => {
    const history = createRenderedOutputHistoryBuffer(32);

    history.append(encoder.encode('stable-tail'));

    const first = history.getBytes();
    const second = history.getBytes();

    expect(second).toBe(first);
  });
});
