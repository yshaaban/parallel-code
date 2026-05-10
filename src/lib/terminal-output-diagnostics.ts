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
  currentCursorX: number | null;
  currentCursorY: number | null;
  currentViewportY: number | null;
  currentVisibleLines: string[] | null;
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
  active: TerminalOutputActiveWriteSnapshot | null;
  calls: number;
  directCalls: number;
  directWriteBytes: number;
  durationMs: NumericDiagnosticsStats;
  finalizationDurationMs: NumericDiagnosticsStats;
  intervalMs: NumericDiagnosticsStats;
  queuedCalls: number;
  queuedWriteBytes: number;
  sizeBytes: NumericDiagnosticsStats;
}

export interface TerminalOutputDiagnosticsSummarySnapshot {
  activeWrites: {
    byLane: Record<TerminalOutputDiagnosticsLane, TerminalOutputActiveWriteCounters>;
    byPriority: Record<TerminalOutputPriority, TerminalOutputActiveWriteCounters>;
    bySource: Record<TerminalOutputRoute, TerminalOutputActiveWriteCounters>;
    total: TerminalOutputActiveWriteCounters;
  };
  queueAgeMs: {
    byLane: Record<TerminalOutputDiagnosticsLane, NumericDiagnosticsTotal>;
    byPriority: Record<TerminalOutputPriority, NumericDiagnosticsTotal>;
    bySource: Record<TerminalOutputRoute, NumericDiagnosticsTotal>;
  };
  writeDurationMs: {
    byLane: Record<TerminalOutputDiagnosticsLane, NumericDiagnosticsTotal>;
    byPriority: Record<TerminalOutputPriority, NumericDiagnosticsTotal>;
    byShape: Record<TerminalOutputWriteShape, NumericDiagnosticsTotal>;
    bySource: Record<TerminalOutputRoute, NumericDiagnosticsTotal>;
    total: NumericDiagnosticsTotal;
  };
  writeFinalizationDurationMs: {
    byLane: Record<TerminalOutputDiagnosticsLane, NumericDiagnosticsTotal>;
    byPriority: Record<TerminalOutputPriority, NumericDiagnosticsTotal>;
    byShape: Record<TerminalOutputWriteShape, NumericDiagnosticsTotal>;
    bySource: Record<TerminalOutputRoute, NumericDiagnosticsTotal>;
    total: NumericDiagnosticsTotal;
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
    byShape: Record<TerminalOutputWriteShape, TerminalOutputWriteCounters>;
    bySource: Record<TerminalOutputRoute, TerminalOutputWriteCounters>;
    totalBytes: number;
    totalCalls: number;
  };
}

export interface TerminalOutputUiFluidityCountersSnapshot {
  activeWriteAgeMs: {
    activeVisible: NumericDiagnosticsTotal;
    direct: NumericDiagnosticsTotal;
    focused: NumericDiagnosticsTotal;
    hidden: NumericDiagnosticsTotal;
    queued: NumericDiagnosticsTotal;
    switchTargetVisible: NumericDiagnosticsTotal;
    total: NumericDiagnosticsTotal;
    visible: NumericDiagnosticsTotal;
    visibleBackground: NumericDiagnosticsTotal;
  };
  activeWritesStartedBeforeBoundary: TerminalOutputUiFluidityActiveWriteCounters;
  activeWritesStartedSinceBoundary: TerminalOutputUiFluidityActiveWriteCounters;
  activeWriteCount: {
    activeVisible: number;
    direct: number;
    focused: number;
    hidden: number;
    queued: number;
    switchTargetVisible: number;
    total: number;
    visible: number;
    visibleBackground: number;
  };
  activeVisibleBytes: number;
  controlWriteBytes: number;
  directWriteBytes: number;
  directWriteCalls: number;
  focusedBytes: number;
  hiddenBytes: number;
  queueAge: {
    activeVisible: NumericDiagnosticsTotal;
    focused: NumericDiagnosticsTotal;
    hidden: NumericDiagnosticsTotal;
    queued: NumericDiagnosticsTotal;
    switchTargetVisible: NumericDiagnosticsTotal;
    visible: NumericDiagnosticsTotal;
    visibleBackground: NumericDiagnosticsTotal;
  };
  queuedWriteBytes: number;
  queuedWriteCalls: number;
  plainWriteBytes: number;
  redrawControlWriteBytes: number;
  suppressedBytes: number;
  switchTargetVisibleBytes: number;
  totalBytes: number;
  totalCalls: number;
  visibleBackgroundBytes: number;
  visibleBytes: number;
  writeDurationMs: {
    activeVisible: NumericDiagnosticsTotal;
    control: NumericDiagnosticsTotal;
    direct: NumericDiagnosticsTotal;
    focused: NumericDiagnosticsTotal;
    hidden: NumericDiagnosticsTotal;
    plain: NumericDiagnosticsTotal;
    queued: NumericDiagnosticsTotal;
    redrawControl: NumericDiagnosticsTotal;
    switchTargetVisible: NumericDiagnosticsTotal;
    total: NumericDiagnosticsTotal;
    visible: NumericDiagnosticsTotal;
    visibleBackground: NumericDiagnosticsTotal;
  };
  writeFinalizationDurationMs: {
    activeVisible: NumericDiagnosticsTotal;
    control: NumericDiagnosticsTotal;
    direct: NumericDiagnosticsTotal;
    focused: NumericDiagnosticsTotal;
    hidden: NumericDiagnosticsTotal;
    plain: NumericDiagnosticsTotal;
    queued: NumericDiagnosticsTotal;
    redrawControl: NumericDiagnosticsTotal;
    switchTargetVisible: NumericDiagnosticsTotal;
    total: NumericDiagnosticsTotal;
    visible: NumericDiagnosticsTotal;
    visibleBackground: NumericDiagnosticsTotal;
  };
}

export type TerminalOutputRoute = 'direct' | 'queued';
export type TerminalOutputDiagnosticsLane = 'focused' | 'hidden' | 'visible';
export type TerminalOutputWriteShape = 'control' | 'plain' | 'redraw-control';

export interface TerminalOutputUiFluidityActiveWriteCounters {
  activeVisible: TerminalOutputActiveWriteCounters;
  direct: TerminalOutputActiveWriteCounters;
  focused: TerminalOutputActiveWriteCounters;
  hidden: TerminalOutputActiveWriteCounters;
  queued: TerminalOutputActiveWriteCounters;
  switchTargetVisible: TerminalOutputActiveWriteCounters;
  total: TerminalOutputActiveWriteCounters;
  visible: TerminalOutputActiveWriteCounters;
  visibleBackground: TerminalOutputActiveWriteCounters;
}

type TerminalOutputActiveWritesSummary = TerminalOutputDiagnosticsSummarySnapshot['activeWrites'];
type TerminalOutputDurationSummary = TerminalOutputDiagnosticsSummarySnapshot['writeDurationMs'];
type TerminalOutputUiFluidityActiveWriteAgeSnapshot =
  TerminalOutputUiFluidityCountersSnapshot['activeWriteAgeMs'];
type TerminalOutputUiFluidityActiveWriteCountSnapshot =
  TerminalOutputUiFluidityCountersSnapshot['activeWriteCount'];
type TerminalOutputUiFluidityDurationCounters =
  TerminalOutputUiFluidityCountersSnapshot['writeDurationMs'];

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

export interface TerminalOutputActiveWriteCounters {
  ageMs: NumericDiagnosticsTotal;
  bytes: number;
  count: number;
}

export interface TerminalOutputRouteCounters {
  bytes: number;
  chunks: number;
}

interface TerminalOutputActiveWriteRecord {
  bytes: number;
  priority: TerminalOutputPriority;
  shape: TerminalOutputWriteShape;
  source: TerminalOutputRoute;
  startedAtMs: number;
}

interface TerminalOutputActiveWriteSnapshot {
  bytes: number;
  durationMs: number;
  priority: TerminalOutputPriority;
  shape: TerminalOutputWriteShape;
  source: TerminalOutputRoute;
}

interface TerminalOutputWriteRecord {
  active: TerminalOutputActiveWriteRecord[];
  calls: number;
  directCalls: number;
  directWriteBytes: number;
  durations: number[];
  finalizationDurations: number[];
  intervals: number[];
  lastCompletedShape: TerminalOutputWriteShape | null;
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
  lastCursorX: number | null;
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

interface RecordTerminalOutputWriteCompletionOptions {
  agentId: string;
  durationMs: number;
  priority: TerminalOutputPriority;
  source: TerminalOutputRoute;
  taskId: string;
}

interface RecordTerminalOutputWriteFinalizationOptions {
  agentId: string;
  durationMs: number;
  priority: TerminalOutputPriority;
  shape?: TerminalOutputWriteShape | null;
  source: TerminalOutputRoute;
  taskId: string;
}

interface RecordTerminalOutputSuppressedOptions {
  agentId: string;
  chunkLength: number;
  priority: TerminalOutputPriority;
  taskId: string;
}

interface TerminalOutputUiFluidityCountersOptions {
  activeWriteBoundaryStartedAtMs?: number | null;
}

declare global {
  interface Window {
    __PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__?: boolean;
    __TERMINAL_OUTPUT_DIAGNOSTICS__?: boolean;
    __TERMINAL_OUTPUT_VISIBLE_LINE_DIAGNOSTICS__?: boolean;
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
const TERMINAL_OUTPUT_WRITE_SHAPES: readonly TerminalOutputWriteShape[] = [
  'plain',
  'control',
  'redraw-control',
];
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

function createTerminalOutputActiveWriteCounters(): TerminalOutputActiveWriteCounters {
  return {
    ageMs: createNumericDiagnosticsTotal(),
    bytes: 0,
    count: 0,
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

function createNumericDiagnosticsTotalsByShape(): Record<
  TerminalOutputWriteShape,
  NumericDiagnosticsTotal
> {
  return createRecordFromEntries(TERMINAL_OUTPUT_WRITE_SHAPES, createNumericDiagnosticsTotal);
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

function createWriteCountersByShape(): Record<
  TerminalOutputWriteShape,
  TerminalOutputWriteCounters
> {
  return createRecordFromEntries(TERMINAL_OUTPUT_WRITE_SHAPES, createTerminalOutputWriteCounters);
}

function createActiveWriteCountersByLane(): Record<
  TerminalOutputDiagnosticsLane,
  TerminalOutputActiveWriteCounters
> {
  return createRecordFromEntries(
    TERMINAL_OUTPUT_DIAGNOSTIC_LANES,
    createTerminalOutputActiveWriteCounters,
  );
}

function createActiveWriteCountersBySource(): Record<
  TerminalOutputRoute,
  TerminalOutputActiveWriteCounters
> {
  return createRecordFromEntries(TERMINAL_OUTPUT_ROUTES, createTerminalOutputActiveWriteCounters);
}

function createActiveWriteCountersByPriority(): Record<
  TerminalOutputPriority,
  TerminalOutputActiveWriteCounters
> {
  return createRecordFromEntries(
    TERMINAL_OUTPUT_DIAGNOSTIC_PRIORITIES,
    createTerminalOutputActiveWriteCounters,
  );
}

function createEmptyTerminalOutputActiveWritesSummary(): TerminalOutputActiveWritesSummary {
  return {
    byLane: createActiveWriteCountersByLane(),
    byPriority: createActiveWriteCountersByPriority(),
    bySource: createActiveWriteCountersBySource(),
    total: createTerminalOutputActiveWriteCounters(),
  };
}

function createTerminalOutputDurationSummary(): TerminalOutputDurationSummary {
  return {
    byLane: createNumericDiagnosticsTotalsByLane(),
    byPriority: createNumericDiagnosticsTotalsByPriority(),
    byShape: createNumericDiagnosticsTotalsByShape(),
    bySource: createNumericDiagnosticsTotalsByRoute(),
    total: createNumericDiagnosticsTotal(),
  };
}

function createTerminalOutputDiagnosticsSummary(): TerminalOutputDiagnosticsSummarySnapshot {
  return {
    activeWrites: createEmptyTerminalOutputActiveWritesSummary(),
    queueAgeMs: {
      byLane: createNumericDiagnosticsTotalsByLane(),
      byPriority: createNumericDiagnosticsTotalsByPriority(),
      bySource: createNumericDiagnosticsTotalsByRoute(),
    },
    writeDurationMs: createTerminalOutputDurationSummary(),
    writeFinalizationDurationMs: createTerminalOutputDurationSummary(),
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
      byShape: createWriteCountersByShape(),
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
      lastCursorX: null,
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
      active: [],
      calls: 0,
      directCalls: 0,
      directWriteBytes: 0,
      durations: [],
      finalizationDurations: [],
      intervals: [],
      lastCompletedShape: null,
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

function mayContainTrackedControlSequence(chunk: Uint8Array): boolean {
  for (const byte of chunk) {
    if (byte === 13 || byte === 27) {
      return true;
    }
  }

  return false;
}

function shouldCaptureVisibleLineDiagnostics(): boolean {
  return (
    typeof window !== 'undefined' && window.__TERMINAL_OUTPUT_VISIBLE_LINE_DIAGNOSTICS__ === true
  );
}

function readVisibleTerminalLines(term: Pick<Terminal, 'buffer' | 'rows'>): {
  cursorX: number;
  cursorY: number;
  lines: string[] | null;
  viewportY: number;
} {
  const activeBuffer = term.buffer.active;
  const viewportY = activeBuffer.viewportY;
  if (!shouldCaptureVisibleLineDiagnostics()) {
    return {
      cursorX: activeBuffer.cursorX,
      cursorY: activeBuffer.cursorY,
      lines: null,
      viewportY,
    };
  }

  const lines: string[] = [];

  for (let index = 0; index < term.rows; index += 1) {
    const line = activeBuffer.getLine(viewportY + index);
    lines.push(line?.translateToString(true) ?? '');
  }

  return {
    cursorX: activeBuffer.cursorX,
    cursorY: activeBuffer.cursorY,
    lines,
    viewportY,
  };
}

function countChangedVisibleLines(
  previousLines: readonly string[] | null,
  nextLines: readonly string[] | null,
): number {
  if (!previousLines || !nextLines) {
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

function cloneNumericDiagnosticsTotal(totals: NumericDiagnosticsTotal): NumericDiagnosticsTotal {
  return {
    count: totals.count,
    max: totals.max,
    total: totals.total,
  };
}

function cloneActiveWriteCounters(
  counters: TerminalOutputActiveWriteCounters,
): TerminalOutputActiveWriteCounters {
  return {
    ageMs: cloneNumericDiagnosticsTotal(counters.ageMs),
    bytes: counters.bytes,
    count: counters.count,
  };
}

function cloneActiveWriteCountersRecord<Key extends string>(
  record: Record<Key, TerminalOutputActiveWriteCounters>,
  keys: readonly Key[],
): Record<Key, TerminalOutputActiveWriteCounters> {
  const clone = {} as Record<Key, TerminalOutputActiveWriteCounters>;
  for (const key of keys) {
    clone[key] = cloneActiveWriteCounters(record[key]);
  }
  return clone;
}

function cloneTerminalOutputActiveWritesSummary(
  activeWrites: TerminalOutputActiveWritesSummary,
): TerminalOutputActiveWritesSummary {
  return {
    byLane: cloneActiveWriteCountersRecord(activeWrites.byLane, TERMINAL_OUTPUT_DIAGNOSTIC_LANES),
    byPriority: cloneActiveWriteCountersRecord(
      activeWrites.byPriority,
      TERMINAL_OUTPUT_DIAGNOSTIC_PRIORITIES,
    ),
    bySource: cloneActiveWriteCountersRecord(activeWrites.bySource, TERMINAL_OUTPUT_ROUTES),
    total: cloneActiveWriteCounters(activeWrites.total),
  };
}

function cloneTerminalOutputDurationSummary(
  durationSummary: TerminalOutputDurationSummary,
): TerminalOutputDurationSummary {
  return {
    byLane: cloneRecordValues(durationSummary.byLane, TERMINAL_OUTPUT_DIAGNOSTIC_LANES),
    byPriority: cloneRecordValues(
      durationSummary.byPriority,
      TERMINAL_OUTPUT_DIAGNOSTIC_PRIORITIES,
    ),
    byShape: cloneRecordValues(durationSummary.byShape, TERMINAL_OUTPUT_WRITE_SHAPES),
    bySource: cloneRecordValues(durationSummary.bySource, TERMINAL_OUTPUT_ROUTES),
    total: cloneNumericDiagnosticsTotal(durationSummary.total),
  };
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

function recordTerminalOutputDurationSummary(
  durationSummary: TerminalOutputDurationSummary,
  lane: TerminalOutputDiagnosticsLane,
  priority: TerminalOutputPriority,
  source: TerminalOutputRoute,
  shape: TerminalOutputWriteShape,
  durationMs: number,
): void {
  recordNumericDiagnosticsTotal(durationSummary.byLane[lane], durationMs);
  recordNumericDiagnosticsTotal(durationSummary.byPriority[priority], durationMs);
  recordNumericDiagnosticsTotal(durationSummary.byShape[shape], durationMs);
  recordNumericDiagnosticsTotal(durationSummary.bySource[source], durationMs);
  recordNumericDiagnosticsTotal(durationSummary.total, durationMs);
}

function recordActiveWriteCounters(
  counters: TerminalOutputActiveWriteCounters,
  activeWrite: TerminalOutputActiveWriteRecord,
  durationMs: number,
): void {
  counters.bytes += activeWrite.bytes;
  counters.count += 1;
  recordNumericDiagnosticsTotal(counters.ageMs, durationMs);
}

function createTerminalOutputActiveWritesSummary(options?: {
  startedAtFilter?: (startedAtMs: number) => boolean;
}): TerminalOutputActiveWritesSummary {
  const activeWrites = createEmptyTerminalOutputActiveWritesSummary();
  const now = typeof performance === 'undefined' ? 0 : performance.now();

  for (const record of outputDiagnostics.values()) {
    for (const activeWrite of record.writes.active) {
      if (options?.startedAtFilter && !options.startedAtFilter(activeWrite.startedAtMs)) {
        continue;
      }

      const lane = getTerminalOutputDiagnosticsLane(activeWrite.priority);
      const durationMs = Math.max(0, now - activeWrite.startedAtMs);
      recordActiveWriteCounters(activeWrites.byLane[lane], activeWrite, durationMs);
      recordActiveWriteCounters(
        activeWrites.byPriority[activeWrite.priority],
        activeWrite,
        durationMs,
      );
      recordActiveWriteCounters(activeWrites.bySource[activeWrite.source], activeWrite, durationMs);
      recordActiveWriteCounters(activeWrites.total, activeWrite, durationMs);
    }
  }

  return activeWrites;
}

function getOldestActiveWrite(
  record: TerminalOutputWriteRecord,
): TerminalOutputActiveWriteRecord | null {
  return record.active[0] ?? null;
}

function createActiveWriteSnapshot(
  activeWrite: TerminalOutputActiveWriteRecord | null,
): TerminalOutputActiveWriteSnapshot | null {
  if (activeWrite === null) {
    return null;
  }

  return {
    bytes: activeWrite.bytes,
    durationMs: Math.max(0, performance.now() - activeWrite.startedAtMs),
    priority: activeWrite.priority,
    shape: activeWrite.shape,
    source: activeWrite.source,
  };
}

function cloneUiFluidityActiveWriteCounters(
  activeWrites: TerminalOutputActiveWritesSummary,
): TerminalOutputUiFluidityActiveWriteCounters {
  return {
    activeVisible: cloneActiveWriteCounters(activeWrites.byPriority['active-visible']),
    direct: cloneActiveWriteCounters(activeWrites.bySource.direct),
    focused: cloneActiveWriteCounters(activeWrites.byPriority.focused),
    hidden: cloneActiveWriteCounters(activeWrites.byLane.hidden),
    queued: cloneActiveWriteCounters(activeWrites.bySource.queued),
    switchTargetVisible: cloneActiveWriteCounters(activeWrites.byPriority['switch-target-visible']),
    total: cloneActiveWriteCounters(activeWrites.total),
    visible: cloneActiveWriteCounters(activeWrites.byLane.visible),
    visibleBackground: cloneActiveWriteCounters(activeWrites.byPriority['visible-background']),
  };
}

function cloneUiFluidityActiveWriteAgeTotals(
  activeWrites: TerminalOutputActiveWritesSummary,
): TerminalOutputUiFluidityActiveWriteAgeSnapshot {
  return {
    activeVisible: cloneNumericDiagnosticsTotal(activeWrites.byPriority['active-visible'].ageMs),
    direct: cloneNumericDiagnosticsTotal(activeWrites.bySource.direct.ageMs),
    focused: cloneNumericDiagnosticsTotal(activeWrites.byPriority.focused.ageMs),
    hidden: cloneNumericDiagnosticsTotal(activeWrites.byLane.hidden.ageMs),
    queued: cloneNumericDiagnosticsTotal(activeWrites.bySource.queued.ageMs),
    switchTargetVisible: cloneNumericDiagnosticsTotal(
      activeWrites.byPriority['switch-target-visible'].ageMs,
    ),
    total: cloneNumericDiagnosticsTotal(activeWrites.total.ageMs),
    visible: cloneNumericDiagnosticsTotal(activeWrites.byLane.visible.ageMs),
    visibleBackground: cloneNumericDiagnosticsTotal(
      activeWrites.byPriority['visible-background'].ageMs,
    ),
  };
}

function getUiFluidityActiveWriteCounts(
  activeWrites: TerminalOutputActiveWritesSummary,
): TerminalOutputUiFluidityActiveWriteCountSnapshot {
  return {
    activeVisible: activeWrites.byPriority['active-visible'].count,
    direct: activeWrites.bySource.direct.count,
    focused: activeWrites.byPriority.focused.count,
    hidden: activeWrites.byLane.hidden.count,
    queued: activeWrites.bySource.queued.count,
    switchTargetVisible: activeWrites.byPriority['switch-target-visible'].count,
    total: activeWrites.total.count,
    visible: activeWrites.byLane.visible.count,
    visibleBackground: activeWrites.byPriority['visible-background'].count,
  };
}

function cloneUiFluidityDurationCounters(
  durationSummary: TerminalOutputDurationSummary,
): TerminalOutputUiFluidityDurationCounters {
  return {
    activeVisible: cloneNumericDiagnosticsTotal(durationSummary.byPriority['active-visible']),
    control: cloneNumericDiagnosticsTotal(durationSummary.byShape.control),
    direct: cloneNumericDiagnosticsTotal(durationSummary.bySource.direct),
    focused: cloneNumericDiagnosticsTotal(durationSummary.byPriority.focused),
    hidden: cloneNumericDiagnosticsTotal(durationSummary.byLane.hidden),
    plain: cloneNumericDiagnosticsTotal(durationSummary.byShape.plain),
    queued: cloneNumericDiagnosticsTotal(durationSummary.bySource.queued),
    redrawControl: cloneNumericDiagnosticsTotal(durationSummary.byShape['redraw-control']),
    switchTargetVisible: cloneNumericDiagnosticsTotal(
      durationSummary.byPriority['switch-target-visible'],
    ),
    total: cloneNumericDiagnosticsTotal(durationSummary.total),
    visible: cloneNumericDiagnosticsTotal(durationSummary.byLane.visible),
    visibleBackground: cloneNumericDiagnosticsTotal(
      durationSummary.byPriority['visible-background'],
    ),
  };
}

function createBoundaryActiveWriteSummaries(boundaryStartedAtMs: number | null | undefined): {
  startedBeforeBoundary: TerminalOutputActiveWritesSummary;
  startedSinceBoundary: TerminalOutputActiveWritesSummary;
} {
  if (boundaryStartedAtMs === null || boundaryStartedAtMs === undefined) {
    return {
      startedBeforeBoundary: createEmptyTerminalOutputActiveWritesSummary(),
      startedSinceBoundary: createEmptyTerminalOutputActiveWritesSummary(),
    };
  }

  return {
    startedBeforeBoundary: createTerminalOutputActiveWritesSummary({
      startedAtFilter: (startedAtMs) => startedAtMs < boundaryStartedAtMs,
    }),
    startedSinceBoundary: createTerminalOutputActiveWritesSummary({
      startedAtFilter: (startedAtMs) => startedAtMs >= boundaryStartedAtMs,
    }),
  };
}

interface TerminalOutputControlAnalysis {
  carriageReturnCount: number;
  clearLineCount: number;
  cursorPositionCount: number;
  saveRestoreCount: number;
  shape: TerminalOutputWriteShape;
}

function analyzeControlSequences(chunk: Uint8Array): TerminalOutputControlAnalysis {
  if (chunk.length === 0 || !mayContainTrackedControlSequence(chunk)) {
    return {
      carriageReturnCount: 0,
      clearLineCount: 0,
      cursorPositionCount: 0,
      saveRestoreCount: 0,
      shape: 'plain',
    };
  }

  const text = decoder.decode(chunk);
  const carriageReturnCount = countMatches(text, /\r/gu);
  const clearLineCount = countMatches(text, CLEAR_LINE_PATTERN);
  const cursorPositionCount = countMatches(text, CURSOR_POSITION_PATTERN);
  const saveRestoreCount = countMatches(text, SAVE_RESTORE_PATTERN);
  const hasRedrawControl =
    carriageReturnCount > 0 ||
    clearLineCount > 0 ||
    cursorPositionCount > 0 ||
    saveRestoreCount > 0;

  return {
    carriageReturnCount,
    clearLineCount,
    cursorPositionCount,
    saveRestoreCount,
    shape: hasRedrawControl ? 'redraw-control' : 'control',
  };
}

function recordControlSequences(
  record: TerminalOutputTerminalRecord,
  analysis: TerminalOutputControlAnalysis,
): void {
  if (analysis.shape === 'plain') {
    return;
  }

  if (analysis.carriageReturnCount > 0) {
    record.control.carriageReturnChunks += 1;
    record.control.carriageReturnCount += analysis.carriageReturnCount;
  }
  if (analysis.clearLineCount > 0) {
    record.control.clearLineChunks += 1;
    record.control.clearLineCount += analysis.clearLineCount;
  }
  if (analysis.cursorPositionCount > 0) {
    record.control.cursorPositionChunks += 1;
    record.control.cursorPositionCount += analysis.cursorPositionCount;
  }
  if (analysis.saveRestoreCount > 0) {
    record.control.saveRestoreChunks += 1;
    record.control.saveRestoreCount += analysis.saveRestoreCount;
  }
  if (analysis.shape === 'redraw-control') {
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
  const controlAnalysis = analyzeControlSequences(options.chunk);
  const shape = controlAnalysis.shape;
  record.priority = options.priority;
  record.writes.active.push({
    bytes: options.chunk.length,
    priority: options.priority,
    shape,
    source: options.source,
    startedAtMs: now,
  });
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
  terminalOutputSummary.writes.byShape[shape].calls += 1;
  terminalOutputSummary.writes.byShape[shape].bytes += options.chunk.length;
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
  recordControlSequences(record, controlAnalysis);
}

export function recordTerminalOutputWriteCompletion(
  options: RecordTerminalOutputWriteCompletionOptions,
): TerminalOutputWriteShape | null {
  if (!isTerminalOutputDiagnosticsEnabled()) {
    return null;
  }

  attachDiagnosticsStore();
  const durationMs = Math.max(0, options.durationMs);
  const record = getTerminalRecord(options.taskId, options.agentId);
  const lane = getTerminalOutputDiagnosticsLane(options.priority);
  const completedWrite = record.writes.active.shift() ?? null;
  const shape = completedWrite?.shape ?? record.writes.lastCompletedShape ?? 'plain';
  record.priority = options.priority;
  record.writes.lastCompletedShape = shape;
  pushSample(record.writes.durations, durationMs);
  recordTerminalOutputDurationSummary(
    terminalOutputSummary.writeDurationMs,
    lane,
    options.priority,
    options.source,
    shape,
    durationMs,
  );
  return shape;
}

export function recordTerminalOutputWriteFinalization(
  options: RecordTerminalOutputWriteFinalizationOptions,
): void {
  if (!isTerminalOutputDiagnosticsEnabled()) {
    return;
  }

  attachDiagnosticsStore();
  const durationMs = Math.max(0, options.durationMs);
  const record = getTerminalRecord(options.taskId, options.agentId);
  const lane = getTerminalOutputDiagnosticsLane(options.priority);
  const shape = options.shape ?? record.writes.lastCompletedShape ?? 'plain';
  record.priority = options.priority;
  pushSample(record.writes.finalizationDurations, durationMs);
  recordTerminalOutputDurationSummary(
    terminalOutputSummary.writeFinalizationDurationMs,
    lane,
    options.priority,
    options.source,
    shape,
    durationMs,
  );
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
  record.render.lastCursorX = nextVisible.cursorX;
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
  const activeWrites = createTerminalOutputActiveWritesSummary();

  return {
    activeWrites: cloneTerminalOutputActiveWritesSummary(activeWrites),
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
    writeDurationMs: cloneTerminalOutputDurationSummary(terminalOutputSummary.writeDurationMs),
    writeFinalizationDurationMs: cloneTerminalOutputDurationSummary(
      terminalOutputSummary.writeFinalizationDurationMs,
    ),
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
      byShape: cloneRecordValues(
        terminalOutputSummary.writes.byShape,
        TERMINAL_OUTPUT_WRITE_SHAPES,
      ),
      bySource: cloneRecordValues(terminalOutputSummary.writes.bySource, TERMINAL_OUTPUT_ROUTES),
      totalBytes: terminalOutputSummary.writes.totalBytes,
      totalCalls: terminalOutputSummary.writes.totalCalls,
    },
  };
}

export function getTerminalOutputUiFluidityCountersSnapshot(
  options?: TerminalOutputUiFluidityCountersOptions,
): TerminalOutputUiFluidityCountersSnapshot {
  const activeWrites = createTerminalOutputActiveWritesSummary();
  const boundaryActiveWrites = createBoundaryActiveWriteSummaries(
    options?.activeWriteBoundaryStartedAtMs,
  );

  return {
    activeWriteAgeMs: cloneUiFluidityActiveWriteAgeTotals(activeWrites),
    activeWritesStartedBeforeBoundary: cloneUiFluidityActiveWriteCounters(
      boundaryActiveWrites.startedBeforeBoundary,
    ),
    activeWritesStartedSinceBoundary: cloneUiFluidityActiveWriteCounters(
      boundaryActiveWrites.startedSinceBoundary,
    ),
    activeWriteCount: getUiFluidityActiveWriteCounts(activeWrites),
    activeVisibleBytes: terminalOutputSummary.writes.byPriority['active-visible'].bytes,
    controlWriteBytes: terminalOutputSummary.writes.byShape.control.bytes,
    directWriteBytes: terminalOutputSummary.writes.bySource.direct.bytes,
    directWriteCalls: terminalOutputSummary.writes.bySource.direct.calls,
    focusedBytes: terminalOutputSummary.writes.byPriority.focused.bytes,
    hiddenBytes: terminalOutputSummary.writes.byLane.hidden.bytes,
    queueAge: {
      activeVisible: cloneNumericDiagnosticsTotal(
        terminalOutputSummary.queueAgeMs.byPriority['active-visible'],
      ),
      focused: cloneNumericDiagnosticsTotal(terminalOutputSummary.queueAgeMs.byLane.focused),
      hidden: cloneNumericDiagnosticsTotal(terminalOutputSummary.queueAgeMs.byLane.hidden),
      queued: cloneNumericDiagnosticsTotal(terminalOutputSummary.queueAgeMs.bySource.queued),
      switchTargetVisible: cloneNumericDiagnosticsTotal(
        terminalOutputSummary.queueAgeMs.byPriority['switch-target-visible'],
      ),
      visible: cloneNumericDiagnosticsTotal(terminalOutputSummary.queueAgeMs.byLane.visible),
      visibleBackground: cloneNumericDiagnosticsTotal(
        terminalOutputSummary.queueAgeMs.byPriority['visible-background'],
      ),
    },
    plainWriteBytes: terminalOutputSummary.writes.byShape.plain.bytes,
    queuedWriteBytes: terminalOutputSummary.writes.bySource.queued.bytes,
    queuedWriteCalls: terminalOutputSummary.writes.bySource.queued.calls,
    redrawControlWriteBytes: terminalOutputSummary.writes.byShape['redraw-control'].bytes,
    suppressedBytes: terminalOutputSummary.suppressed.totalBytes,
    switchTargetVisibleBytes:
      terminalOutputSummary.writes.byPriority['switch-target-visible'].bytes,
    totalBytes: terminalOutputSummary.writes.totalBytes,
    totalCalls: terminalOutputSummary.writes.totalCalls,
    visibleBackgroundBytes: terminalOutputSummary.writes.byPriority['visible-background'].bytes,
    visibleBytes: terminalOutputSummary.writes.byLane.visible.bytes,
    writeDurationMs: cloneUiFluidityDurationCounters(terminalOutputSummary.writeDurationMs),
    writeFinalizationDurationMs: cloneUiFluidityDurationCounters(
      terminalOutputSummary.writeFinalizationDurationMs,
    ),
  };
}

export function getTerminalOutputDiagnosticsSnapshot(): TerminalOutputDiagnosticsSnapshot {
  return {
    summary: getTerminalOutputDiagnosticsSummary(),
    terminals: [...outputDiagnostics.values()].map((record) => {
      const activeWrite = getOldestActiveWrite(record.writes);

      return {
        agentId: record.agentId,
        control: { ...record.control },
        key: record.key,
        priority: record.priority,
        render: {
          changedVisibleLines: createNumericStats(record.render.changedVisibleLines),
          currentCursorX: record.render.lastCursorX,
          currentCursorY: record.render.lastCursorY,
          currentViewportY: record.render.lastViewportY,
          currentVisibleLines:
            record.render.lastVisibleLines === null ? null : [...record.render.lastVisibleLines],
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
          active: createActiveWriteSnapshot(activeWrite),
          calls: record.writes.calls,
          directCalls: record.writes.directCalls,
          directWriteBytes: record.writes.directWriteBytes,
          durationMs: createNumericStats(record.writes.durations),
          finalizationDurationMs: createNumericStats(record.writes.finalizationDurations),
          intervalMs: createNumericStats(record.writes.intervals),
          queuedCalls: record.writes.queuedCalls,
          queuedWriteBytes: record.writes.queuedWriteBytes,
          sizeBytes: createNumericStats(record.writes.sizes),
        },
      };
    }),
  };
}

export function resetTerminalOutputDiagnostics(): void {
  outputDiagnostics.clear();
  terminalOutputSummary = createTerminalOutputDiagnosticsSummary();
}
