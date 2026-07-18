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
    expect(
      containsTerminalRedrawControlSequence(encoder.encode('first line\r\nsecond line\r\r\n')),
    ).toBe(false);
    expect(containsTerminalRedrawControlSequence(encoder.encode('progress 10%\r'))).toBe(true);
  });

  it('tracks redraw control sequences that are split across chunk boundaries', () => {
    const tracker = createTerminalRedrawControlTracker();

    expect(tracker.isRedrawControlChunk(encoder.encode('\x1b'))).toBe(true);
    expect(tracker.isRedrawControlChunk(encoder.encode('['))).toBe(true);
    expect(tracker.isRedrawControlChunk(encoder.encode('20;1H'))).toBe(true);
    expect(tracker.isRedrawControlChunk(encoder.encode('plain shell output'))).toBe(false);
  });

  it('distinguishes split additive line endings from a split bare carriage return', () => {
    const crlfTracker = createTerminalRedrawControlTracker();
    expect(crlfTracker.isRedrawControlChunk(encoder.encode('first line\r'))).toBe(false);
    expect(crlfTracker.isRedrawControlChunk(encoder.encode('\nsecond line'))).toBe(false);

    const normalizedCrlfTracker = createTerminalRedrawControlTracker();
    expect(normalizedCrlfTracker.isRedrawControlChunk(encoder.encode('first line\r'))).toBe(false);
    expect(normalizedCrlfTracker.isRedrawControlChunk(encoder.encode('\r\nsecond line'))).toBe(
      false,
    );

    const redrawTracker = createTerminalRedrawControlTracker();
    expect(redrawTracker.isRedrawControlChunk(encoder.encode('progress 10%\r'))).toBe(false);
    expect(redrawTracker.isRedrawControlChunk(encoder.encode('progress 20%'))).toBe(true);

    const repeatedRedrawTracker = createTerminalRedrawControlTracker();
    expect(
      ['progress 10%\r', 'progress 20%\r', 'progress 30%\r', 'progress 40%\r'].map((chunk) =>
        repeatedRedrawTracker.isRedrawControlChunk(encoder.encode(chunk)),
      ),
    ).toEqual([false, true, true, true]);
  });

  it('reports resolved redraw counts across write boundaries', () => {
    const additiveTracker = createTerminalRedrawControlTracker();
    expect(additiveTracker.analyzeChunk(encoder.encode('first line\r'))).toMatchObject({
      carriageReturnCount: 0,
      containsRedrawControlSequence: false,
      pendingCarriageReturnCount: 1,
    });
    expect(additiveTracker.analyzeChunk(encoder.encode('\r\nsecond line'))).toMatchObject({
      carriageReturnCount: 0,
      containsRedrawControlSequence: false,
      pendingCarriageReturnCount: 0,
    });

    const redrawTracker = createTerminalRedrawControlTracker();
    redrawTracker.analyzeChunk(encoder.encode('progress 10%\r'));
    expect(redrawTracker.analyzeChunk(encoder.encode('progress 20%'))).toMatchObject({
      carriageReturnCount: 1,
      containsRedrawControlSequence: true,
      pendingCarriageReturnCount: 0,
    });
  });

  it('retains a split control prefix that follows known redraw control', () => {
    const tracker = createTerminalRedrawControlTracker();

    expect(tracker.isRedrawControlChunk(encoder.encode('\x1b[2Kstatus\x1b'))).toBe(true);
    expect(tracker.isRedrawControlChunk(encoder.encode('[2Knext'))).toBe(true);
    expect(tracker.isRedrawControlChunk(encoder.encode('plain output'))).toBe(false);
  });

  it('clears pending chunk tracking after a non-redraw CSI sequence completes', () => {
    const tracker = createTerminalRedrawControlTracker();

    expect(tracker.isRedrawControlChunk(encoder.encode('\x1b['))).toBe(true);
    expect(tracker.isRedrawControlChunk(encoder.encode('31m'))).toBe(false);
    expect(tracker.isRedrawControlChunk(encoder.encode('plain shell output'))).toBe(false);
  });

  it('cancels incomplete CSI state and resumes scanning at a new escape sequence', () => {
    for (const chunks of [
      ['\x1b[', '\x1b[31m', 'plain'],
      ['\x1b[', '\x18plain', 'next'],
      ['\x1b[2Kstatus\x1b[', '\x1b[31m', 'plain'],
    ]) {
      const tracker = createTerminalRedrawControlTracker();
      expect(chunks.map((chunk) => tracker.isRedrawControlChunk(encoder.encode(chunk)))).toEqual([
        true,
        false,
        false,
      ]);
    }
  });

  it('retains only parser state across an unterminated CSI parameter stream', () => {
    const tracker = createTerminalRedrawControlTracker();

    expect(tracker.isRedrawControlChunk(encoder.encode('\x1b['))).toBe(true);
    for (let index = 0; index < 1_000; index += 1) {
      expect(tracker.isRedrawControlChunk(encoder.encode('123;'))).toBe(true);
    }
    expect(tracker.isRedrawControlChunk(encoder.encode('31m'))).toBe(false);
    expect(tracker.isRedrawControlChunk(encoder.encode('plain'))).toBe(false);
  });
});
