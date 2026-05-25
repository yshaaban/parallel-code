import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
  buildAlternateScreenFixture,
  buildCursorAddressedRedrawFixture,
  buildResizeStormFixture,
} from './fixtures/nonbrowser-terminal-stress.mjs';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } =
  require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

type HeadlessTerminal = import('@xterm/headless').Terminal;

interface WriteFixture {
  chunks: string[];
  expectedCursor: {
    x: number;
    y: number;
  };
  expectedPromptText: string;
  initialCols: number;
  initialRows: number;
  promptRow: number;
}

interface ResizeStormFixture {
  expectedCursor: {
    x: number;
    y: number;
  };
  expectedPromptText: string;
  finalCols: number;
  finalRows: number;
  initialCols: number;
  initialRows: number;
  promptRow: number;
  steps: Array<
    | {
        chunks: string[];
        kind: 'write';
      }
    | {
        cols: number;
        kind: 'resize';
        rows: number;
      }
  >;
}

interface TerminalHarness {
  serializeAddon: import('@xterm/addon-serialize').SerializeAddon;
  terminal: HeadlessTerminal;
}

interface TerminalSnapshot {
  baseY: number;
  bufferType: 'normal' | 'alternate';
  cols: number;
  cursorX: number;
  cursorY: number;
  rows: number;
  viewportY: number;
  visibleLines: string[];
}

function createTerminalHarness(cols: number, rows: number): TerminalHarness {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 1_000,
  });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon as unknown as Parameters<HeadlessTerminal['loadAddon']>[0]);
  return { serializeAddon, terminal };
}

async function writeChunk(terminal: HeadlessTerminal, chunk: string): Promise<void> {
  await new Promise<void>((resolve) => {
    terminal.write(chunk, resolve);
  });
}

async function writeChunks(terminal: HeadlessTerminal, chunks: readonly string[]): Promise<void> {
  for (const chunk of chunks) {
    await writeChunk(terminal, chunk);
  }
}

async function applyResizeStormFixture(
  terminal: HeadlessTerminal,
  fixture: ResizeStormFixture,
): Promise<void> {
  for (const step of fixture.steps) {
    if (step.kind === 'resize') {
      terminal.resize(step.cols, step.rows);
      continue;
    }

    await writeChunks(terminal, step.chunks);
  }
}

function getVisibleLine(terminal: HeadlessTerminal, oneBasedRow: number): string {
  const buffer = terminal.buffer.active;
  return buffer.getLine(buffer.viewportY + oneBasedRow - 1)?.translateToString(true) ?? '';
}

function snapshotTerminal(terminal: HeadlessTerminal): TerminalSnapshot {
  const buffer = terminal.buffer.active;
  const visibleLines: string[] = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    visibleLines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
  }

  return {
    baseY: buffer.baseY,
    bufferType: buffer.type,
    cols: terminal.cols,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    rows: terminal.rows,
    viewportY: buffer.viewportY,
    visibleLines,
  };
}

async function snapshotRecoveredTerminal(
  serializedState: string,
  cols: number,
  rows: number,
): Promise<TerminalSnapshot> {
  const recovered = createTerminalHarness(cols, rows);
  try {
    await writeChunk(recovered.terminal, serializedState);
    return snapshotTerminal(recovered.terminal);
  } finally {
    recovered.terminal.dispose();
  }
}

function expectSplitControlSequences(chunks: readonly string[]): void {
  expect(chunks.some((chunk, index) => chunk === '\x1b' && chunks[index + 1] === '[')).toBe(true);
}

function expectRecoveredCursorAtFixtureTarget(
  recovered: TerminalSnapshot,
  fixture: Pick<WriteFixture, 'expectedCursor'>,
): void {
  expect(recovered.cursorY).toBe(fixture.expectedCursor.y);
  expect(recovered.cursorX).toBe(fixture.expectedCursor.x);
  expect(recovered.cursorY).not.toBe(recovered.rows - 1);
  expect(recovered.cursorX).not.toBe(recovered.cols);
}

describe('nonbrowser terminal stress recovery', () => {
  it('recovers cursor-addressed redraws without moving the cursor to the bottom or line end', async () => {
    const fixture = buildCursorAddressedRedrawFixture() as WriteFixture;
    expectSplitControlSequences(fixture.chunks);

    const live = createTerminalHarness(fixture.initialCols, fixture.initialRows);
    try {
      await writeChunks(live.terminal, fixture.chunks);
      const serializedState = live.serializeAddon.serialize();
      const liveSnapshot = snapshotTerminal(live.terminal);
      const recoveredSnapshot = await snapshotRecoveredTerminal(
        serializedState,
        live.terminal.cols,
        live.terminal.rows,
      );

      expect(recoveredSnapshot).toEqual(liveSnapshot);
      expect(getVisibleLine(live.terminal, fixture.promptRow)).toContain(
        fixture.expectedPromptText,
      );
      expectRecoveredCursorAtFixtureTarget(recoveredSnapshot, fixture);
    } finally {
      live.terminal.dispose();
    }
  });

  it('recovers alternate-screen redraw state and cursor placement', async () => {
    const fixture = buildAlternateScreenFixture() as WriteFixture;
    expectSplitControlSequences(fixture.chunks);

    const live = createTerminalHarness(fixture.initialCols, fixture.initialRows);
    try {
      await writeChunks(live.terminal, fixture.chunks);
      const serializedState = live.serializeAddon.serialize();
      const liveSnapshot = snapshotTerminal(live.terminal);
      const recoveredSnapshot = await snapshotRecoveredTerminal(
        serializedState,
        live.terminal.cols,
        live.terminal.rows,
      );

      expect(liveSnapshot.bufferType).toBe('alternate');
      expect(recoveredSnapshot).toEqual(liveSnapshot);
      expect(getVisibleLine(live.terminal, fixture.promptRow)).toContain(
        fixture.expectedPromptText,
      );
      expectRecoveredCursorAtFixtureTarget(recoveredSnapshot, fixture);
    } finally {
      live.terminal.dispose();
    }
  });

  it('matches live and recovered terminal state after split writes and resize storms', async () => {
    const fixture = buildResizeStormFixture() as ResizeStormFixture;
    const writeSteps = fixture.steps.filter((step) => step.kind === 'write');
    expect(writeSteps.length).toBeGreaterThan(0);
    expect(writeSteps.some((step) => step.chunks.length > 1)).toBe(true);

    const live = createTerminalHarness(fixture.initialCols, fixture.initialRows);
    try {
      await applyResizeStormFixture(live.terminal, fixture);
      expect(live.terminal.cols).toBe(fixture.finalCols);
      expect(live.terminal.rows).toBe(fixture.finalRows);

      const serializedState = live.serializeAddon.serialize();
      const liveSnapshot = snapshotTerminal(live.terminal);
      const recoveredSnapshot = await snapshotRecoveredTerminal(
        serializedState,
        live.terminal.cols,
        live.terminal.rows,
      );

      expect(recoveredSnapshot).toEqual(liveSnapshot);
      expect(getVisibleLine(live.terminal, fixture.promptRow)).toContain(
        fixture.expectedPromptText,
      );
      expectRecoveredCursorAtFixtureTarget(recoveredSnapshot, fixture);
    } finally {
      live.terminal.dispose();
    }
  }, 15_000);
});
