import type { Terminal } from '@xterm/xterm';

import type { TerminalOutputPriority } from './terminal-output-priority';

export interface TerminalOutputDiagnosticsSnapshot {
  summary: TerminalOutputDiagnosticsSummarySnapshot;
  terminals: TerminalOutputTerminalSnapshot[];
}

export interface TerminalOutputTerminalSnapshot {
  agentId: string;
  control: {
    carriageReturnChunks: number;
    carriageReturnCount: number;
    clearLineChunks: number;
    clearLineCount: number;
    cursorPositionChunks: number;
    cursorPositionCount: number;
    redrawChunks: number;
    saveRestoreChunks: number;
    saveRestoreCount: number;
  };
  key: string;
  priority: TerminalOutputPriority | null;
  render: TerminalOutputRenderSnapshot;
  routed: TerminalOutputRouteSnapshot;
  suppressed: TerminalOutputRouteCounters;
  taskId: string;
  writes: TerminalOutputWriteSnapshot;
}

interface TerminalOutputRenderSnapshot {
  changedVisibleLines: NumericDiagnosticsStats;
  cursorRowJump: NumericDiagnosticsStats;
  maxChangedVisibleLines: number;
  maxCursorRowJump: number;
  maxRowSpan: number;
  maxViewportJumpRows: number;
  renderCalls: number;
  resizeEvents: number;
  rowSpan: NumericDiagnosticsStats;
  viewportJumpRows: NumericDiagnosticsStats;
}

interface TerminalOutputRouteSnapshot {
  directBytes: number;
  directChunks: number;
  queuedBytes: number;
  queuedChunks: number;
  sizeBytes: NumericDiagnosticsStats;
}

interface TerminalOutputWriteSnapshot {
  calls: number;
  directCalls: number;
  directWriteBytes: number;
  intervalMs: NumericDiagnosticsStats;
  queuedCalls: number;
  queuedWriteBytes: number;
  sizeBytes: NumericDiagnosticsStats;
}

export interface TerminalOutputDiagnosticsSummarySnapshot {
  queueAgeMs: {
    byLane: Record<TerminalOutputDiagnosticsLane, NumericDiagnosticsTotal>;
    byPriority: Record<TerminalOutputPriority, NumericDiagnosticsTotal>;
    bySource: Record<TerminalOutputRoute, NumericDiagnosticsTotal>;
  };
  routed: {
    byLane: Record<TerminalOutputDiagnosticsLane, TerminalOutputRouteCounters>;
    byPriority: Record<TerminalOutputPriority, TerminalOutputRouteCounters>;
    bySource: Record<TerminalOutputRoute, TerminalOutputRouteCounters>;
  };
  suppressed: {
    byLane: Record<TerminalOutputDiagnosticsLane, TerminalOutputRouteCounters>;
    byPriority: Record<TerminalOutputPriority, TerminalOutputRouteCounters>;
    totalBytes: number;
    totalChunks: number;
  };
  writes: {
    byLane: Record<TerminalOutputDiagnosticsLane, TerminalOutputWriteCounters>;
    byPriority: Record<TerminalOutputPriority, TerminalOutputWriteCounters>;
    bySource: Record<TerminalOutputRoute, TerminalOutputWriteCounters>;
    totalBytes: number;
    totalCalls: number;
  };
}

export type TerminalOutputRoute = 'direct' | 'queued';
export type TerminalOutputDiagnosticsLane = 'focused' | 'hidden' | 'visible';

interface TerminalOutputRouteRecord {
  bytes: number[];
  directBytes: number;
  directChunks: number;
  queuedBytes: number;
  queuedChunks: number;
}

export interface NumericDiagnosticsTotal {
  count: number;
  max: number;
  total: number;
}

export interface TerminalOutputWriteCounters {
  bytes: number;
  calls: number;
}

export interface TerminalOutputRouteCounters {
  bytes: number;
  chunks: number;
}

interface TerminalOutputWriteRecord {
  calls: number;
  directCalls: number;
  directWriteBytes: number;
  intervals: number[];
  lastWriteAt: number;
  queuedCalls: number;
  queuedWriteBytes: number;
  sizes: number[];
}

interface TerminalOutputControlRecord {
  carriageReturnChunks: number;
  carriageReturnCount: number;
  clearLineChunks: number;
  clearLineCount: number;
  cursorPositionChunks: number;
  cursorPositionCount: number;
  redrawChunks: number;
  saveRestoreChunks: number;
  saveRestoreCount: number;
}

interface TerminalOutputRenderRecord {
  changedVisibleLines: number[];
  cursorRowJump: number[];
  lastCursorY: number | null;
  lastViewportY: number | null;
  lastVisibleLines: string[] | null;
  maxChangedVisibleLines: number;
  maxCursorRowJump: number;
  maxRowSpan: number;
  maxViewportJumpRows: number;
  renderCalls: number;
  resizeEvents: number;
  rowSpan: number[];
  viewportJumpRows: number[];
}

interface TerminalOutputTerminalRecord {
  agentId: string;
  control: TerminalOutputControlRecord;
  key: string;
  priority: TerminalOutputPriority | null;
  render: TerminalOutputRenderRecord;
  routed: TerminalOutputRouteRecord;
  suppressed: TerminalOutputRouteCounters;
  taskId: string;
  writes: TerminalOutputWriteRecord;
}

interface NumericDiagnosticsStats {
  avg: number;
  count: number;
  max: number;
  min: number;
  p50: number;
  p95: number;
}

interface RecordTerminalOutputRouteOptions {
  agentId: string;
  chunkLength: number;
  priority: TerminalOutputPriority;
  route: TerminalOutputRoute;
  taskId: string;
}

interface RecordTerminalOutputWriteOptions {
  agentId: string;
  chunk: Uint8Array;
  priority: TerminalOutputPriority;
  queueAgeMs?: number;
  source: TerminalOutputRoute;
  taskId: string;
}

interface RecordTerminalOutputSuppressedOptions {
  agentId: string;
  chunkLength: number;
  priority: TerminalOutputPriority;
  taskId: string;
}

declare global {
  interface Window {
    __PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__?: boolean;
    __TERMINAL_OUTPUT_DIAGNOSTICS__?: boolean;
    __parallelCodeTerminalOutputDiagnostics?: {
      getSnapshot: () => TerminalOutputDiagnosticsSnapshot;
      reset: () => void;
    };
  }
}

const MAX_SAMPLED_VALUES = 512;
const TERMINAL_OUTPUT_DIAGNOSTIC_LANES: readonly TerminalOutputDiagnosticsLane[] = [
  'focused',
  'hidden',
  'visible',
];
const TERMINAL_OUTPUT_DIAGNOSTIC_PRIORITIES: readonly TerminalOutputPriority[] = [
  'focused',
  'switch-target-visible',
  'active-visible',
  'visible-background',
  'hidden',
];
const TERMINAL_OUTPUT_ROUTES: readonly TerminalOutputRoute[] = ['direct', 'queued'];
const CLEAR_LINE_PATTERN = new RegExp(String.raw`\u001b\[(?:0|1|2)?K`, 'gu');
const CURSOR_POSITION_PATTERN = new RegExp(String.raw`\u001b\[[0-9;]*[Hf]`, 'gu');
const SAVE_RESTORE_PATTERN = new RegExp(String.raw`\u001b(?:7|8|\[s|\[u)`, 'gu');
const outputDiagnostics = new Map<string, TerminalOutputTerminalRecord>();
let terminalOutputSummary = createTerminalOutputDiagnosticsSummary();
const decoder = new TextDecoder();

function isTerminalOutputDiagnosticsEnabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.__TERMINAL_OUTPUT_DIAGNOSTICS__ === true ||
      window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ === true) &&
    typeof performance !== 'undefined'
  );
}

function createNumericDiagnosticsTotal(): NumericDiagnosticsTotal {
  return {
    count: 0,
    max: 0,
    total: 0,
  };
}

function createTerminalOutputWriteCounters(): TerminalOutputWriteCounters {
  return {
    bytes: 0,
    calls: 0,
  };
}

function createTerminalOutputRouteCounters(): TerminalOutputRouteCounters {
  return {
    bytes: 0,
    chunks: 0,
  };
}

function createRecordFromEntries<Key extends string, Value>(
  keys: readonly Key[],
  createValue: () => Value,
): Record<Key, Value> {
  const record = {} as Record<Key, Value>;
  for (const key of keys) {
    record[key] = createValue();
  }
  return record;
}

function createNumericDiagnosticsTotalsByLane(): Record<
  TerminalOutputDiagnosticsLane,
  NumericDiagnosticsTotal
> {
  return createRecordFromEntries(TERMINAL_OUTPUT_DIAGNOSTIC_LANES, createNumericDiagnosticsTotal);
}

function createNumericDiagnosticsTotalsByRoute(): Record<
  TerminalOutputRoute,
  NumericDiagnosticsTotal
> {
  return createRecordFromEntries(TERMINAL_OUTPUT_ROUTES, createNumericDiagnosticsTotal);
}

function createNumericDiagnosticsTotalsByPriority(): Record<
  TerminalOutputPriority,
  NumericDiagnosticsTotal
> {
  return createRecordFromEntries(
    TERMINAL_OUTPUT_DIAGNOSTIC_PRIORITIES,
    createNumericDiagnosticsTotal,
  );
}

function createRouteCountersByLane(): Record<
  TerminalOutputDiagnosticsLane,
  TerminalOutputRouteCounters
> {
  return createRecordFromEntries(
    TERMINAL_OUTPUT_DIAGNOSTIC_LANES,
    createTerminalOutputRouteCounters,
  );
}

function createRouteCountersBySource(): Record<TerminalOutputRoute, TerminalOutputRouteCounters> {
  return createRecordFromEntries(TERMINAL_OUTPUT_ROUTES, createTerminalOutputRouteCounters);
}

function createRouteCountersByPriority(): Record<
  TerminalOutputPriority,
  TerminalOutputRouteCounters
> {
  return createRecordFromEntries(
    TERMINAL_OUTPUT_DIAGNOSTIC_PRIORITIES,
    createTerminalOutputRouteCounters,
  );
}

function createWriteCountersByLane(): Record<
  TerminalOutputDiagnosticsLane,
  TerminalOutputWriteCounters
> {
  return createRecordFromEntries(
    TERMINAL_OUTPUT_DIAGNOSTIC_LANES,
    createTerminalOutputWriteCounters,
  );
}

function createWriteCountersBySource(): Record<TerminalOutputRoute, TerminalOutputWriteCounters> {
  return createRecordFromEntries(TERMINAL_OUTPUT_ROUTES, createTerminalOutputWriteCounters);
}

function createWriteCountersByPriority(): Record<
  TerminalOutputPriority,
  TerminalOutputWriteCounters
> {
  return createRecordFromEntries(
    TERMINAL_OUTPUT_DIAGNOSTIC_PRIORITIES,
    createTerminalOutputWriteCounters,
  );
}

function createTerminalOutputDiagnosticsSummary(): TerminalOutputDiagnosticsSummarySnapshot {
  return {
    queueAgeMs: {
      byLane: createNumericDiagnosticsTotalsByLane(),
      byPriority: createNumericDiagnosticsTotalsByPriority(),
      bySource: createNumericDiagnosticsTotalsByRoute(),
    },
    routed: {
      byLane: createRouteCountersByLane(),
      byPriority: createRouteCountersByPriority(),
      bySource: createRouteCountersBySource(),
    },
    suppressed: {
      byLane: createRouteCountersByLane(),
      byPriority: createRouteCountersByPriority(),
      totalBytes: 0,
      totalChunks: 0,
    },
    writes: {
      byLane: createWriteCountersByLane(),
      byPriority: createWriteCountersByPriority(),
      bySource: createWriteCountersBySource(),
      totalBytes: 0,
      totalCalls: 0,
    },
  };
}

function pushSample(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > MAX_SAMPLED_VALUES) {
    samples.shift();
  }
}

function createNumericStats(values: readonly number[]): NumericDiagnosticsStats {
  if (values.length === 0) {
    return {
      avg: 0,
      count: 0,
      max: 0,
      min: 0,
      p50: 0,
      p95: 0,
    };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const p50Index = Math.max(0, Math.ceil(sorted.length * 0.5) - 1);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const maxIndex = sorted.length - 1;
  const max = sorted[maxIndex];
  const min = sorted[0];
  const p50 = sorted[p50Index];
  const p95 = sorted[p95Index];

  if (max === undefined || min === undefined || p50 === undefined || p95 === undefined) {
    throw new Error('Terminal output diagnostics percentile index out of bounds');
  }

  return {
    avg: Math.round((sum / sorted.length) * 100) / 100,
    count: sorted.length,
    max,
    min,
    p50,
    p95,
  };
}

function createTerminalRecord(
  key: string,
  taskId: string,
  agentId: string,
): TerminalOutputTerminalRecord {
  return {
    agentId,
    control: {
      carriageReturnChunks: 0,
      carriageReturnCount: 0,
      clearLineChunks: 0,
      clearLineCount: 0,
      cursorPositionChunks: 0,
      cursorPositionCount: 0,
      redrawChunks: 0,
      saveRestoreChunks: 0,
      saveRestoreCount: 0,
    },
    key,
    priority: null,
    render: {
      changedVisibleLines: [],
      cursorRowJump: [],
      lastCursorY: null,
      lastViewportY: null,
      lastVisibleLines: null,
      maxChangedVisibleLines: 0,
      maxCursorRowJump: 0,
      maxRowSpan: 0,
      maxViewportJumpRows: 0,
      renderCalls: 0,
      resizeEvents: 0,
      rowSpan: [],
      viewportJumpRows: [],
    },
    routed: {
      bytes: [],
      directBytes: 0,
      directChunks: 0,
      queuedBytes: 0,
      queuedChunks: 0,
    },
    suppressed: createTerminalOutputRouteCounters(),
    taskId,
    writes: {
      calls: 0,
      directCalls: 0,
      directWriteBytes: 0,
      intervals: [],
      lastWriteAt: 0,
      queuedCalls: 0,
      queuedWriteBytes: 0,
      sizes: [],
    },
  };
}

function getTerminalRecord(taskId: string, agentId: string): TerminalOutputTerminalRecord {
  const key = `${taskId}:${agentId}`;
  const existing = outputDiagnostics.get(key);
  if (existing) {
    return existing;
  }

  const created = createTerminalRecord(key, taskId, agentId);
  outputDiagnostics.set(key, created);
  return created;
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function readVisibleTerminalLines(term: Pick<Terminal, 'buffer' | 'rows'>): {
  cursorY: number;
  lines: string[];
  viewportY: number;
} {
  const activeBuffer = term.buffer.active;
  const viewportY = activeBuffer.viewportY;
  const lines: string[] = [];

  for (let index = 0; index < term.rows; index += 1) {
    const line = activeBuffer.getLine(viewportY + index);
    lines.push(line?.translateToString(true) ?? '');
  }

  return {
    cursorY: activeBuffer.cursorY,
    lines,
    viewportY,
  };
}

function countChangedVisibleLines(
  previousLines: readonly string[] | null,
  nextLines: readonly string[],
): number {
  if (!previousLines) {
    return 0;
  }

  const maxLength = Math.max(previousLines.length, nextLines.length);
  let changedLines = 0;
  for (let index = 0; index < maxLength; index += 1) {
    if ((previousLines[index] ?? '') !== (nextLines[index] ?? '')) {
      changedLines += 1;
    }
  }

  return changedLines;
}

function getTerminalOutputDiagnosticsLane(
  priority: TerminalOutputPriority,
): TerminalOutputDiagnosticsLane {
  switch (priority) {
    case 'focused':
      return 'focused';
    case 'hidden':
      return 'hidden';
    case 'switch-target-visible':
    case 'active-visible':
    case 'visible-background':
      return 'visible';
  }
}

function cloneRecordValues<Key extends string, Value extends object>(
  record: Record<Key, Value>,
  keys: readonly Key[],
): Record<Key, Value> {
  const clone = {} as Record<Key, Value>;
  for (const key of keys) {
    clone[key] = { ...record[key] };
  }
  return clone;
}

function recordNumericDiagnosticsTotal(
  totals: NumericDiagnosticsTotal,
  value: number | undefined,
): void {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return;
  }

  totals.count += 1;
  totals.total += value;
  if (value > totals.max) {
    totals.max = value;
  }
}

function recordControlSequences(record: TerminalOutputTerminalRecord, chunk: Uint8Array): void {
  if (chunk.length === 0) {
    return;
  }

  const text = decoder.decode(chunk);
  const carriageReturnCount = countMatches(text, /\r/gu);
  const clearLineCount = countMatches(text, CLEAR_LINE_PATTERN);
  const cursorPositionCount = countMatches(text, CURSOR_POSITION_PATTERN);
  const saveRestoreCount = countMatches(text, SAVE_RESTORE_PATTERN);

  if (carriageReturnCount > 0) {
    record.control.carriageReturnChunks += 1;
    record.control.carriageReturnCount += carriageReturnCount;
  }
  if (clearLineCount > 0) {
    record.control.clearLineChunks += 1;
    record.control.clearLineCount += clearLineCount;
  }
  if (cursorPositionCount > 0) {
    record.control.cursorPositionChunks += 1;
    record.control.cursorPositionCount += cursorPositionCount;
  }
  if (saveRestoreCount > 0) {
    record.control.saveRestoreChunks += 1;
    record.control.saveRestoreCount += saveRestoreCount;
  }
  if (
    carriageReturnCount > 0 ||
    clearLineCount > 0 ||
    cursorPositionCount > 0 ||
    saveRestoreCount > 0
  ) {
    record.control.redrawChunks += 1;
  }
}

function attachDiagnosticsStore(): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (window.__parallelCodeTerminalOutputDiagnostics) {
    return;
  }

  window.__parallelCodeTerminalOutputDiagnostics = {
    getSnapshot: getTerminalOutputDiagnosticsSnapshot,
    reset: resetTerminalOutputDiagnostics,
  };
}

export function recordTerminalOutputRoute(options: RecordTerminalOutputRouteOptions): void {
  if (!isTerminalOutputDiagnosticsEnabled()) {
    return;
  }

  attachDiagnosticsStore();
  const record = getTerminalRecord(options.taskId, options.agentId);
  const lane = getTerminalOutputDiagnosticsLane(options.priority);
  record.priority = options.priority;
  pushSample(record.routed.bytes, options.chunkLength);
  terminalOutputSummary.routed.byLane[lane].bytes += options.chunkLength;
  terminalOutputSummary.routed.byLane[lane].chunks += 1;
  terminalOutputSummary.routed.byPriority[options.priority].bytes += options.chunkLength;
  terminalOutputSummary.routed.byPriority[options.priority].chunks += 1;
  terminalOutputSummary.routed.bySource[options.route].bytes += options.chunkLength;
  terminalOutputSummary.routed.bySource[options.route].chunks += 1;
  if (options.route === 'direct') {
    record.routed.directChunks += 1;
    record.routed.directBytes += options.chunkLength;
    return;
  }

  record.routed.queuedChunks += 1;
  record.routed.queuedBytes += options.chunkLength;
}

export function recordTerminalOutputWrite(options: RecordTerminalOutputWriteOptions): void {
  if (!isTerminalOutputDiagnosticsEnabled()) {
    return;
  }

  attachDiagnosticsStore();
  const now = performance.now();
  const record = getTerminalRecord(options.taskId, options.agentId);
  const lane = getTerminalOutputDiagnosticsLane(options.priority);
  record.priority = options.priority;
  if (record.writes.lastWriteAt > 0) {
    pushSample(record.writes.intervals, Math.max(0, now - record.writes.lastWriteAt));
  }
  record.writes.lastWriteAt = now;
  record.writes.calls += 1;
  terminalOutputSummary.writes.totalCalls += 1;
  terminalOutputSummary.writes.totalBytes += options.chunk.length;
  terminalOutputSummary.writes.byLane[lane].calls += 1;
  terminalOutputSummary.writes.byLane[lane].bytes += options.chunk.length;
  terminalOutputSummary.writes.byPriority[options.priority].calls += 1;
  terminalOutputSummary.writes.byPriority[options.priority].bytes += options.chunk.length;
  terminalOutputSummary.writes.bySource[options.source].calls += 1;
  terminalOutputSummary.writes.bySource[options.source].bytes += options.chunk.length;
  pushSample(record.writes.sizes, options.chunk.length);
  if (options.source === 'direct') {
    record.writes.directCalls += 1;
    record.writes.directWriteBytes += options.chunk.length;
  } else {
    record.writes.queuedCalls += 1;
    record.writes.queuedWriteBytes += options.chunk.length;
  }
  recordNumericDiagnosticsTotal(terminalOutputSummary.queueAgeMs.byLane[lane], options.queueAgeMs);
  recordNumericDiagnosticsTotal(
    terminalOutputSummary.queueAgeMs.byPriority[options.priority],
    options.queueAgeMs,
  );
  recordNumericDiagnosticsTotal(
    terminalOutputSummary.queueAgeMs.bySource[options.source],
    options.queueAgeMs,
  );
  recordControlSequences(record, options.chunk);
}

export function recordTerminalRenderEvent(options: {
  agentId: string;
  endRow: number;
  startRow: number;
  taskId: string;
  term: Pick<Terminal, 'buffer' | 'rows'>;
}): void {
  if (!isTerminalOutputDiagnosticsEnabled()) {
    return;
  }

  attachDiagnosticsStore();
  const record = getTerminalRecord(options.taskId, options.agentId);
  const nextVisible = readVisibleTerminalLines(options.term);
  const rowSpan = Math.max(0, options.endRow - options.startRow + 1);
  const viewportJumpRows =
    record.render.lastViewportY === null
      ? 0
      : Math.abs(nextVisible.viewportY - record.render.lastViewportY);
  const cursorRowJump =
    record.render.lastCursorY === null
      ? 0
      : Math.abs(nextVisible.cursorY - record.render.lastCursorY);
  const changedVisibleLines = countChangedVisibleLines(
    record.render.lastVisibleLines,
    nextVisible.lines,
  );

  record.render.renderCalls += 1;
  pushSample(record.render.rowSpan, rowSpan);
  pushSample(record.render.viewportJumpRows, viewportJumpRows);
  pushSample(record.render.cursorRowJump, cursorRowJump);
  pushSample(record.render.changedVisibleLines, changedVisibleLines);
  record.render.maxRowSpan = Math.max(record.render.maxRowSpan, rowSpan);
  record.render.maxViewportJumpRows = Math.max(record.render.maxViewportJumpRows, viewportJumpRows);
  record.render.maxCursorRowJump = Math.max(record.render.maxCursorRowJump, cursorRowJump);
  record.render.maxChangedVisibleLines = Math.max(
    record.render.maxChangedVisibleLines,
    changedVisibleLines,
  );
  record.render.lastVisibleLines = nextVisible.lines;
  record.render.lastViewportY = nextVisible.viewportY;
  record.render.lastCursorY = nextVisible.cursorY;
}

export function recordTerminalRenderResize(options: { agentId: string; taskId: string }): void {
  if (!isTerminalOutputDiagnosticsEnabled()) {
    return;
  }

  attachDiagnosticsStore();
  const record = getTerminalRecord(options.taskId, options.agentId);
  record.render.resizeEvents += 1;
}

export function recordTerminalOutputSuppressed(
  options: RecordTerminalOutputSuppressedOptions,
): void {
  if (!isTerminalOutputDiagnosticsEnabled()) {
    return;
  }

  attachDiagnosticsStore();
  const record = getTerminalRecord(options.taskId, options.agentId);
  const lane = getTerminalOutputDiagnosticsLane(options.priority);
  record.priority = options.priority;
  record.suppressed.bytes += options.chunkLength;
  record.suppressed.chunks += 1;
  terminalOutputSummary.suppressed.byLane[lane].bytes += options.chunkLength;
  terminalOutputSummary.suppressed.byLane[lane].chunks += 1;
  terminalOutputSummary.suppressed.byPriority[options.priority].bytes += options.chunkLength;
  terminalOutputSummary.suppressed.byPriority[options.priority].chunks += 1;
  terminalOutputSummary.suppressed.totalBytes += options.chunkLength;
  terminalOutputSummary.suppressed.totalChunks += 1;
}

export function getTerminalOutputDiagnosticsSummary(): TerminalOutputDiagnosticsSummarySnapshot {
  return {
    queueAgeMs: {
      byLane: cloneRecordValues(
        terminalOutputSummary.queueAgeMs.byLane,
        TERMINAL_OUTPUT_DIAGNOSTIC_LANES,
      ),
      byPriority: cloneRecordValues(
        terminalOutputSummary.queueAgeMs.byPriority,
        TERMINAL_OUTPUT_DIAGNOSTIC_PRIORITIES,
      ),
      bySource: cloneRecordValues(
        terminalOutputSummary.queueAgeMs.bySource,
        TERMINAL_OUTPUT_ROUTES,
      ),
    },
    routed: {
      byLane: cloneRecordValues(
        terminalOutputSummary.routed.byLane,
        TERMINAL_OUTPUT_DIAGNOSTIC_LANES,
      ),
      byPriority: cloneRecordValues(
        terminalOutputSummary.routed.byPriority,
        TERMINAL_OUTPUT_DIAGNOSTIC_PRIORITIES,
      ),
      bySource: cloneRecordValues(terminalOutputSummary.routed.bySource, TERMINAL_OUTPUT_ROUTES),
    },
    suppressed: {
      byLane: cloneRecordValues(
        terminalOutputSummary.suppressed.byLane,
        TERMINAL_OUTPUT_DIAGNOSTIC_LANES,
      ),
      byPriority: cloneRecordValues(
        terminalOutputSummary.suppressed.byPriority,
        TERMINAL_OUTPUT_DIAGNOSTIC_PRIORITIES,
      ),
      totalBytes: terminalOutputSummary.suppressed.totalBytes,
      totalChunks: terminalOutputSummary.suppressed.totalChunks,
    },
    writes: {
      byLane: cloneRecordValues(
        terminalOutputSummary.writes.byLane,
        TERMINAL_OUTPUT_DIAGNOSTIC_LANES,
      ),
      byPriority: cloneRecordValues(
        terminalOutputSummary.writes.byPriority,
        TERMINAL_OUTPUT_DIAGNOSTIC_PRIORITIES,
      ),
      bySource: cloneRecordValues(terminalOutputSummary.writes.bySource, TERMINAL_OUTPUT_ROUTES),
      totalBytes: terminalOutputSummary.writes.totalBytes,
      totalCalls: terminalOutputSummary.writes.totalCalls,
    },
  };
}

export function getTerminalOutputDiagnosticsSnapshot(): TerminalOutputDiagnosticsSnapshot {
  return {
    summary: getTerminalOutputDiagnosticsSummary(),
    terminals: [...outputDiagnostics.values()].map((record) => ({
      agentId: record.agentId,
      control: { ...record.control },
      key: record.key,
      priority: record.priority,
      render: {
        changedVisibleLines: createNumericStats(record.render.changedVisibleLines),
        cursorRowJump: createNumericStats(record.render.cursorRowJump),
        maxChangedVisibleLines: record.render.maxChangedVisibleLines,
        maxCursorRowJump: record.render.maxCursorRowJump,
        maxRowSpan: record.render.maxRowSpan,
        maxViewportJumpRows: record.render.maxViewportJumpRows,
        renderCalls: record.render.renderCalls,
        resizeEvents: record.render.resizeEvents,
        rowSpan: createNumericStats(record.render.rowSpan),
        viewportJumpRows: createNumericStats(record.render.viewportJumpRows),
      },
      routed: {
        directBytes: record.routed.directBytes,
        directChunks: record.routed.directChunks,
        queuedBytes: record.routed.queuedBytes,
        queuedChunks: record.routed.queuedChunks,
        sizeBytes: createNumericStats(record.routed.bytes),
      },
      suppressed: { ...record.suppressed },
      taskId: record.taskId,
      writes: {
        calls: record.writes.calls,
        directCalls: record.writes.directCalls,
        directWriteBytes: record.writes.directWriteBytes,
        intervalMs: createNumericStats(record.writes.intervals),
        queuedCalls: record.writes.queuedCalls,
        queuedWriteBytes: record.writes.queuedWriteBytes,
        sizeBytes: createNumericStats(record.writes.sizes),
      },
    })),
  };
}

export function resetTerminalOutputDiagnostics(): void {
  outputDiagnostics.clear();
  terminalOutputSummary = createTerminalOutputDiagnosticsSummary();
}
