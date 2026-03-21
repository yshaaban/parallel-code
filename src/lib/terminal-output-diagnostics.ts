import type { TerminalOutputPriority } from './terminal-output-priority';

export interface TerminalOutputDiagnosticsSnapshot {
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
  routed: TerminalOutputRouteSnapshot;
  taskId: string;
  writes: TerminalOutputWriteSnapshot;
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

export type TerminalOutputRoute = 'direct' | 'queued';

interface TerminalOutputRouteRecord {
  bytes: number[];
  directBytes: number;
  directChunks: number;
  queuedBytes: number;
  queuedChunks: number;
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

interface TerminalOutputTerminalRecord {
  agentId: string;
  control: TerminalOutputControlRecord;
  key: string;
  priority: TerminalOutputPriority | null;
  routed: TerminalOutputRouteRecord;
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
  source: TerminalOutputRoute;
  taskId: string;
}

const MAX_SAMPLED_VALUES = 512;
const CLEAR_LINE_PATTERN = new RegExp(String.raw`\u001b\[(?:0|1|2)?K`, 'gu');
const CURSOR_POSITION_PATTERN = new RegExp(String.raw`\u001b\[[0-9;]*[Hf]`, 'gu');
const SAVE_RESTORE_PATTERN = new RegExp(String.raw`\u001b(?:7|8|\[s|\[u)`, 'gu');
const outputDiagnostics = new Map<string, TerminalOutputTerminalRecord>();
const decoder = new TextDecoder();

declare global {
  interface Window {
    __TERMINAL_OUTPUT_DIAGNOSTICS__?: boolean;
    __parallelCodeTerminalOutputDiagnostics?: {
      getSnapshot: () => TerminalOutputDiagnosticsSnapshot;
      reset: () => void;
    };
  }
}

function isTerminalOutputDiagnosticsEnabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.__TERMINAL_OUTPUT_DIAGNOSTICS__ === true &&
    typeof performance !== 'undefined'
  );
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

  return {
    avg: Math.round((sum / sorted.length) * 100) / 100,
    count: sorted.length,
    max: sorted[sorted.length - 1] ?? 0,
    min: sorted[0] ?? 0,
    p50: sorted[p50Index] ?? 0,
    p95: sorted[p95Index] ?? 0,
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
    routed: {
      bytes: [],
      directBytes: 0,
      directChunks: 0,
      queuedBytes: 0,
      queuedChunks: 0,
    },
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
  record.priority = options.priority;
  pushSample(record.routed.bytes, options.chunkLength);
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
  record.priority = options.priority;
  if (record.writes.lastWriteAt > 0) {
    pushSample(record.writes.intervals, Math.max(0, now - record.writes.lastWriteAt));
  }
  record.writes.lastWriteAt = now;
  record.writes.calls += 1;
  pushSample(record.writes.sizes, options.chunk.length);
  if (options.source === 'direct') {
    record.writes.directCalls += 1;
    record.writes.directWriteBytes += options.chunk.length;
  } else {
    record.writes.queuedCalls += 1;
    record.writes.queuedWriteBytes += options.chunk.length;
  }
  recordControlSequences(record, options.chunk);
}

export function getTerminalOutputDiagnosticsSnapshot(): TerminalOutputDiagnosticsSnapshot {
  return {
    terminals: [...outputDiagnostics.values()].map((record) => ({
      agentId: record.agentId,
      control: { ...record.control },
      key: record.key,
      priority: record.priority,
      routed: {
        directBytes: record.routed.directBytes,
        directChunks: record.routed.directChunks,
        queuedBytes: record.routed.queuedBytes,
        queuedChunks: record.routed.queuedChunks,
        sizeBytes: createNumericStats(record.routed.bytes),
      },
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
}
