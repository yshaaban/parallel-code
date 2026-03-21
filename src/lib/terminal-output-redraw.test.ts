import { describe, expect, it } from 'vitest';

import {
  containsTerminalRedrawControlSequence,
  createTerminalRedrawControlTracker,
} from './terminal-output-redraw';

const encoder = new TextEncoder();

describe('terminal-output-redraw', () => {
  it('detects redraw-heavy cursor control sequences', () => {
    expect(
      containsTerminalRedrawControlSequence(
        encoder.encode('\x1b[s\x1b[20;1H\x1b[2K status line\x1b[u'),
      ),
    ).toBe(true);
    expect(containsTerminalRedrawControlSequence(encoder.encode('\r\x1b[2Kspinner'))).toBe(true);
  });

  it('ignores plain text and ordinary printable output', () => {
    expect(containsTerminalRedrawControlSequence(encoder.encode('hello from the shell'))).toBe(
      false,
    );
    expect(containsTerminalRedrawControlSequence(encoder.encode('\nnext prompt> '))).toBe(false);
    expect(
      containsTerminalRedrawControlSequence(encoder.encode('\x1b[31mcolored output\x1b[0m')),
    ).toBe(false);
  });

  it('tracks redraw control sequences that are split across chunk boundaries', () => {
    const tracker = createTerminalRedrawControlTracker();

    expect(tracker.isRedrawControlChunk(encoder.encode('\x1b'))).toBe(true);
    expect(tracker.isRedrawControlChunk(encoder.encode('['))).toBe(true);
    expect(tracker.isRedrawControlChunk(encoder.encode('20;1H'))).toBe(true);
    expect(tracker.isRedrawControlChunk(encoder.encode('plain shell output'))).toBe(false);
  });

  it('clears pending chunk tracking after a non-redraw CSI sequence completes', () => {
    const tracker = createTerminalRedrawControlTracker();

    expect(tracker.isRedrawControlChunk(encoder.encode('\x1b['))).toBe(true);
    expect(tracker.isRedrawControlChunk(encoder.encode('31m'))).toBe(false);
    expect(tracker.isRedrawControlChunk(encoder.encode('plain shell output'))).toBe(false);
  });
});
