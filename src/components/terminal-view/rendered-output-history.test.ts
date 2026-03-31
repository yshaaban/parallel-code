import { describe, expect, it } from 'vitest';

import { createRenderedOutputHistoryBuffer } from './rendered-output-history';

describe('rendered-output-history', () => {
  it('returns only the requested tail bytes without flattening the full history shape', () => {
    const history = createRenderedOutputHistoryBuffer(32);

    history.append(new TextEncoder().encode('alpha'));
    history.append(new TextEncoder().encode('beta'));
    history.append(new TextEncoder().encode('gamma'));

    expect(new TextDecoder().decode(history.getTailBytes(6))).toBe('agamma');
  });

  it('caps tail bytes to the retained history length', () => {
    const history = createRenderedOutputHistoryBuffer(8);

    history.append(new TextEncoder().encode('0123456789'));

    expect(new TextDecoder().decode(history.getTailBytes(64))).toBe('23456789');
  });
});
