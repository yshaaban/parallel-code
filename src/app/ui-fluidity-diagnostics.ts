import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
  type RendererRuntimeDiagnosticsSnapshot,
} from './runtime-diagnostics';
import {
  getTerminalFramePressureLevel,
  type TerminalFramePressureLevel,
} from './terminal-frame-pressure';
import {
  getTerminalSwitchWindowSnapshot,
  subscribeTerminalSwitchWindowChanges,
  type TerminalSwitchWindowCompletion,
  type TerminalSwitchWindowSnapshot,
} from './terminal-switch-window';
import {
  getTerminalSwitchEchoGraceSnapshot,
  subscribeTerminalSwitchEchoGraceChanges,
  type TerminalSwitchEchoGraceCompletion,
  type TerminalSwitchEchoGraceSnapshot,
} from './terminal-switch-echo-grace';
import {
  getTerminalFocusedInputSnapshot,
  type TerminalFocusedInputSnapshot,
} from './terminal-focused-input';
import {
  getTerminalOutputPacingSnapshot,
  type TerminalOutputPacingSnapshot,
} from './terminal-output-scheduler';
import {
  getTerminalPerformanceExperimentConfig,
  type TerminalPerformanceExperimentConfig,
} from '../lib/terminal-performance-experiments';
import {
  getTerminalOutputDiagnosticsSummary,
  resetTerminalOutputDiagnostics,
  type NumericDiagnosticsTotal,
  type TerminalOutputDiagnosticsSummarySnapshot,
} from '../lib/terminal-output-diagnostics';
import { getWebglPoolRuntimeSnapshot } from '../lib/webglPool';

interface NumericSampleStats {
  avg: number;
  count: number;
  max: number;
  min: number;
  p50: number;
  p95: number;
}

export interface UiFluidityDiagnosticsSnapshot {
  experiment: TerminalPerformanceExperimentConfig;
  frames: {
    gapMs: NumericSampleStats;
    overBudget16ms: number;
    overBudget33ms: number;
    overBudget50ms: number;
    pressureCounts: Record<TerminalFramePressureLevel, number>;
  };
  focusedInput: UiFluidityFocusedInputSnapshot;
  longTasks: {
    durationMs: NumericSampleStats;
    recent: UiFluidityLongTaskEntry[];
    totalDurationMs: number;
  };
  pacing: TerminalOutputPacingSnapshot;
  rendererRuntime: RendererRuntimeDiagnosticsSnapshot;
  switchEchoGrace: UiFluiditySwitchEchoGraceSnapshot | null;
  switchWindow: UiFluiditySwitchWindowSnapshot | null;
  runtimePerFrame: {
    activeWebglContexts: NumericSampleStats;
    agentAnalysisDurationMs: NumericSampleStats;
    ownerDurationMs: NumericSampleStats;
    schedulerDrainDurationMs: NumericSampleStats;
    schedulerScanDurationMs: NumericSampleStats;
    visibleWebglContexts: NumericSampleStats;
  };
  terminalOutput: TerminalOutputDiagnosticsSummarySnapshot;
  terminalOutputPerFrame: {
    activeVisibleBytes: NumericSampleStats;
    activeVisibleQueueAgeMs: NumericSampleStats;
    directWriteBytes: NumericSampleStats;
    directWriteCalls: NumericSampleStats;
    focusedQueueAgeMs: NumericSampleStats;
    focusedWriteBytes: NumericSampleStats;
    hiddenBytes: NumericSampleStats;
    hiddenQueueAgeMs: NumericSampleStats;
    nonTargetVisibleBytes: NumericSampleStats;
    queuedWriteBytes: NumericSampleStats;
    queuedWriteCalls: NumericSampleStats;
    queuedQueueAgeMs: NumericSampleStats;
    suppressedBytes: NumericSampleStats;
    switchTargetVisibleBytes: NumericSampleStats;
    switchTargetVisibleQueueAgeMs: NumericSampleStats;
    visibleBytes: NumericSampleStats;
    visibleBackgroundBytes: NumericSampleStats;
    visibleBackgroundQueueAgeMs: NumericSampleStats;
    visibleQueueAgeMs: NumericSampleStats;
    writeBytes: NumericSampleStats;
    writeCalls: NumericSampleStats;
  };
  terminalOutputDuringFocusedInputPerFrame: {
    focusedWriteBytes: NumericSampleStats;
    hiddenBytes: NumericSampleStats;
    nonTargetVisibleBytes: NumericSampleStats;
    queuedQueueAgeMs: NumericSampleStats;
    visibleBackgroundBytes: NumericSampleStats;
  };
}

interface UiFluidityLongTaskEntry {
  durationMs: number;
  startMs: number;
}

interface UiFluidityFocusedInputSnapshot {
  active: boolean;
  ageMs: number;
  echoReservationActive: boolean;
  echoReservationRemainingMs: number;
  remainingMs: number;
  taskId: string | null;
}

interface UiFluiditySwitchWindowSnapshot {
  active: boolean;
  activeVisibleBytes: number;
  activeVisibleQueueAgeMs: number;
  agentAnalysisDurationMs: number;
  ageMs: number;
  firstPaintSample: UiFluiditySwitchWindowPhaseSnapshot | null;
  firstPaintDurationMs: number | null;
  focusedBytes: number;
  focusedQueueAgeMs: number;
  hiddenBytes: number;
  hiddenQueueAgeMs: number;
  inputReadySample: UiFluiditySwitchWindowPhaseSnapshot | null;
  inputReadyDurationMs: number | null;
  lastCompletion: TerminalSwitchWindowCompletion | null;
  phase: TerminalSwitchWindowSnapshot['phase'];
  queuedQueueAgeMs: number;
  remainingMs: number;
  selectedRecoveryActive: boolean;
  schedulerDrainDurationMs: number;
  schedulerScanDurationMs: number;
  switchTargetVisibleBytes: number;
  switchTargetVisibleQueueAgeMs: number;
  targetTaskId: string | null;
  visibleBackgroundBytes: number;
  visibleBackgroundQueueAgeMs: number;
  visibleBytes: number;
  visibleQueueAgeMs: number;
}

interface UiFluiditySwitchEchoGraceSnapshot {
  active: boolean;
  ageMs: number;
  completionSample: UiFluiditySwitchWindowPhaseSnapshot | null;
  durationMs: number | null;
  focusedBytes: number;
  focusedQueueAgeMs: number;
  hiddenBytes: number;
  hiddenQueueAgeMs: number;
  lastCompletion: TerminalSwitchEchoGraceCompletion | null;
  nonTargetVisibleBytes: number;
  queuedQueueAgeMs: number;
  remainingMs: number;
  switchTargetVisibleBytes: number;
  switchTargetVisibleQueueAgeMs: number;
  targetTaskId: string | null;
  visibleBackgroundBytes: number;
  visibleBackgroundQueueAgeMs: number;
  visibleQueueAgeMs: number;
}

interface UiFluiditySwitchWindowPhaseSnapshot {
  activeVisibleBytes: number;
  activeVisibleQueueAgeMs: number;
  focusedBytes: number;
  focusedQueueAgeMs: number;
  framePressureLevel: TerminalFramePressureLevel;
  hiddenBytes: number;
  hiddenQueueAgeMs: number;
  nonTargetVisibleBytes: number;
  queuedQueueAgeMs: number;
  switchTargetVisibleBytes: number;
  switchTargetVisibleQueueAgeMs: number;
  visibleBackgroundBytes: number;
  visibleBackgroundQueueAgeMs: number;
  visibleQueueAgeMs: number;
}

interface UiFluidityCounters {
  output: {
    activeVisibleBytes: number;
    directWriteBytes: number;
    directWriteCalls: number;
    hiddenBytes: number;
    nonTargetVisibleBytes: number;
    queuedWriteBytes: number;
    queuedWriteCalls: number;
    suppressedBytes: number;
    queueAge: {
      activeVisible: NumericDiagnosticsTotal;
      focused: NumericDiagnosticsTotal;
      hidden: NumericDiagnosticsTotal;
      queued: NumericDiagnosticsTotal;
      switchTargetVisible: NumericDiagnosticsTotal;
      visibleBackground: NumericDiagnosticsTotal;
      visible: NumericDiagnosticsTotal;
    };
    focusedBytes: number;
    switchTargetVisibleBytes: number;
    totalBytes: number;
    totalCalls: number;
    visibleBytes: number;
    visibleBackgroundBytes: number;
  };
  runtime: {
    activeWebglContextsCurrent: number;
    agentAnalysisDurationMs: number;
    schedulerDrainDurationMs: number;
    schedulerScanDurationMs: number;
    visibleWebglContextsCurrent: number;
  };
}

interface UiFluidityState {
  activeSwitchEchoGrace: UiFluiditySwitchEchoGraceState | null;
  activeSwitchWindow: UiFluiditySwitchWindowState | null;
  activeVisibleBytesPerFrame: number[];
  activeVisibleQueueAgeMsPerFrame: number[];
  activeWebglContextsPerFrame: number[];
  frameGapMs: number[];
  frameOverBudget16ms: number;
  frameOverBudget33ms: number;
  frameOverBudget50ms: number;
  framePressureCounts: Record<TerminalFramePressureLevel, number>;
  directWriteBytesPerFrame: number[];
  directWriteCallsPerFrame: number[];
  focusedInputFocusedWriteBytesPerFrame: number[];
  focusedInputHiddenBytesPerFrame: number[];
  focusedInputNonTargetVisibleBytesPerFrame: number[];
  focusedInputQueuedQueueAgeMsPerFrame: number[];
  focusedInputVisibleBackgroundBytesPerFrame: number[];
  focusedWriteBytesPerFrame: number[];
  hiddenBytesPerFrame: number[];
  hiddenQueueAgeMsPerFrame: number[];
  lastFrameAtMs: number | null;
  longTaskDurationMs: number[];
  nonTargetVisibleBytesPerFrame: number[];
  lastCompletedSwitchWindow: UiFluiditySwitchWindowSnapshot | null;
  lastCompletedSwitchEchoGrace: UiFluiditySwitchEchoGraceSnapshot | null;
  lastObservedSwitchEchoGraceCompletion: TerminalSwitchEchoGraceCompletion | null;
  lastObservedSwitchWindowCompletion: TerminalSwitchWindowCompletion | null;
  ownerDurationMsPerFrame: number[];
  previousCounters: UiFluidityCounters | null;
  queuedWriteBytesPerFrame: number[];
  queuedWriteCallsPerFrame: number[];
  queuedQueueAgeMsPerFrame: number[];
  suppressedBytesPerFrame: number[];
  switchTargetVisibleBytesPerFrame: number[];
  switchTargetVisibleQueueAgeMsPerFrame: number[];
  recentLongTasks: UiFluidityLongTaskEntry[];
  schedulerDrainDurationMsPerFrame: number[];
  schedulerScanDurationMsPerFrame: number[];
  visibleWebglContextsPerFrame: number[];
  visibleBytesPerFrame: number[];
  visibleBackgroundBytesPerFrame: number[];
  visibleBackgroundQueueAgeMsPerFrame: number[];
  visibleQueueAgeMsPerFrame: number[];
  writeBytesPerFrame: number[];
  writeCallsPerFrame: number[];
  focusedQueueAgeMsPerFrame: number[];
  agentAnalysisDurationMsPerFrame: number[];
}

interface UiFluiditySwitchWindowState {
  baselineCounters: UiFluidityCounters;
  firstPaintSample: UiFluiditySwitchWindowPhaseSnapshot | null;
  inputReadySample: UiFluiditySwitchWindowPhaseSnapshot | null;
  switchWindow: TerminalSwitchWindowSnapshot;
}

interface UiFluiditySwitchEchoGraceState {
  baselineCounters: UiFluidityCounters;
  completionSample: UiFluiditySwitchWindowPhaseSnapshot | null;
  switchEchoGrace: TerminalSwitchEchoGraceSnapshot;
}

declare global {
  interface Window {
    __PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__?: boolean;
    __parallelCodeUiFluidityDiagnostics?: {
      getSnapshot: () => UiFluidityDiagnosticsSnapshot;
      reset: () => void;
    };
  }
}

const FRAME_BUDGET_MS = 16.7;
const MAX_SAMPLED_VALUES = 512;
const MAX_RECENT_LONGTASKS = 64;

let diagnosticsInstalled = false;
let longTaskObserver: PerformanceObserver | null = null;
let switchEchoGraceObserverInstalled = false;
let switchWindowObserverInstalled = false;
let state = createUiFluidityState();

function createUiFluidityState(): UiFluidityState {
  return {
    activeSwitchEchoGrace: null,
    activeSwitchWindow: null,
    activeVisibleBytesPerFrame: [],
    activeVisibleQueueAgeMsPerFrame: [],
    activeWebglContextsPerFrame: [],
    agentAnalysisDurationMsPerFrame: [],
    directWriteBytesPerFrame: [],
    directWriteCallsPerFrame: [],
    focusedInputFocusedWriteBytesPerFrame: [],
    focusedInputHiddenBytesPerFrame: [],
    focusedInputNonTargetVisibleBytesPerFrame: [],
    focusedInputQueuedQueueAgeMsPerFrame: [],
    focusedInputVisibleBackgroundBytesPerFrame: [],
    focusedQueueAgeMsPerFrame: [],
    focusedWriteBytesPerFrame: [],
    frameGapMs: [],
    frameOverBudget16ms: 0,
    frameOverBudget33ms: 0,
    frameOverBudget50ms: 0,
    framePressureCounts: {
      critical: 0,
      elevated: 0,
      stable: 0,
    },
    hiddenBytesPerFrame: [],
    hiddenQueueAgeMsPerFrame: [],
    lastFrameAtMs: null,
    lastCompletedSwitchEchoGrace: null,
    lastCompletedSwitchWindow: null,
    lastObservedSwitchEchoGraceCompletion: null,
    lastObservedSwitchWindowCompletion: null,
    longTaskDurationMs: [],
    nonTargetVisibleBytesPerFrame: [],
    ownerDurationMsPerFrame: [],
    previousCounters: null,
    queuedWriteBytesPerFrame: [],
    queuedWriteCallsPerFrame: [],
    queuedQueueAgeMsPerFrame: [],
    suppressedBytesPerFrame: [],
    switchTargetVisibleBytesPerFrame: [],
    switchTargetVisibleQueueAgeMsPerFrame: [],
    recentLongTasks: [],
    schedulerDrainDurationMsPerFrame: [],
    schedulerScanDurationMsPerFrame: [],
    visibleWebglContextsPerFrame: [],
    visibleBytesPerFrame: [],
    visibleBackgroundBytesPerFrame: [],
    visibleBackgroundQueueAgeMsPerFrame: [],
    visibleQueueAgeMsPerFrame: [],
    writeBytesPerFrame: [],
    writeCallsPerFrame: [],
  };
}

function isUiFluidityDiagnosticsEnabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ === true &&
    typeof performance !== 'undefined' &&
    typeof requestAnimationFrame === 'function'
  );
}

function pushSample(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > MAX_SAMPLED_VALUES) {
    samples.shift();
  }
}

function getPositiveDelta(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

function createNumericSampleStats(values: readonly number[]): NumericSampleStats {
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

function getNumericDiagnosticsDelta(
  current: NumericDiagnosticsTotal,
  previous: NumericDiagnosticsTotal,
): NumericDiagnosticsTotal {
  return {
    count: Math.max(0, current.count - previous.count),
    max: Math.max(0, current.max),
    total: Math.max(0, current.total - previous.total),
  };
}

function getAverageFromDiagnosticsTotal(totals: NumericDiagnosticsTotal): number {
  if (totals.count <= 0) {
    return 0;
  }

  return totals.total / totals.count;
}

function recordFrameOutputCounters(
  currentCounters: UiFluidityCounters,
  previousCounters: UiFluidityCounters,
  focusedInputSnapshot: TerminalFocusedInputSnapshot,
): void {
  const activeVisibleQueueAge = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.activeVisible,
      previousCounters.output.queueAge.activeVisible,
    ),
  );
  const focusedQueueAge = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.focused,
      previousCounters.output.queueAge.focused,
    ),
  );
  const visibleQueueAge = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.visible,
      previousCounters.output.queueAge.visible,
    ),
  );
  const hiddenQueueAge = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.hidden,
      previousCounters.output.queueAge.hidden,
    ),
  );
  const queuedQueueAge = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.queued,
      previousCounters.output.queueAge.queued,
    ),
  );
  const visibleBackgroundQueueAge = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.visibleBackground,
      previousCounters.output.queueAge.visibleBackground,
    ),
  );
  const switchTargetVisibleQueueAge = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.switchTargetVisible,
      previousCounters.output.queueAge.switchTargetVisible,
    ),
  );

  pushSample(
    state.writeCallsPerFrame,
    getPositiveDelta(currentCounters.output.totalCalls, previousCounters.output.totalCalls),
  );
  pushSample(
    state.writeBytesPerFrame,
    getPositiveDelta(currentCounters.output.totalBytes, previousCounters.output.totalBytes),
  );
  pushSample(
    state.directWriteCallsPerFrame,
    getPositiveDelta(
      currentCounters.output.directWriteCalls,
      previousCounters.output.directWriteCalls,
    ),
  );
  pushSample(
    state.directWriteBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.directWriteBytes,
      previousCounters.output.directWriteBytes,
    ),
  );
  pushSample(
    state.queuedWriteCallsPerFrame,
    getPositiveDelta(
      currentCounters.output.queuedWriteCalls,
      previousCounters.output.queuedWriteCalls,
    ),
  );
  pushSample(
    state.queuedWriteBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.queuedWriteBytes,
      previousCounters.output.queuedWriteBytes,
    ),
  );
  pushSample(
    state.suppressedBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.suppressedBytes,
      previousCounters.output.suppressedBytes,
    ),
  );
  pushSample(
    state.focusedWriteBytesPerFrame,
    getPositiveDelta(currentCounters.output.focusedBytes, previousCounters.output.focusedBytes),
  );
  pushSample(
    state.activeVisibleBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.activeVisibleBytes,
      previousCounters.output.activeVisibleBytes,
    ),
  );
  pushSample(
    state.visibleBytesPerFrame,
    getPositiveDelta(currentCounters.output.visibleBytes, previousCounters.output.visibleBytes),
  );
  pushSample(
    state.visibleBackgroundBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.visibleBackgroundBytes,
      previousCounters.output.visibleBackgroundBytes,
    ),
  );
  pushSample(
    state.switchTargetVisibleBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.switchTargetVisibleBytes,
      previousCounters.output.switchTargetVisibleBytes,
    ),
  );
  pushSample(
    state.nonTargetVisibleBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.nonTargetVisibleBytes,
      previousCounters.output.nonTargetVisibleBytes,
    ),
  );
  pushSample(
    state.hiddenBytesPerFrame,
    getPositiveDelta(currentCounters.output.hiddenBytes, previousCounters.output.hiddenBytes),
  );
  pushSample(state.activeVisibleQueueAgeMsPerFrame, activeVisibleQueueAge);
  pushSample(state.focusedQueueAgeMsPerFrame, focusedQueueAge);
  pushSample(state.visibleQueueAgeMsPerFrame, visibleQueueAge);
  pushSample(state.visibleBackgroundQueueAgeMsPerFrame, visibleBackgroundQueueAge);
  pushSample(state.switchTargetVisibleQueueAgeMsPerFrame, switchTargetVisibleQueueAge);
  pushSample(state.hiddenQueueAgeMsPerFrame, hiddenQueueAge);
  pushSample(state.queuedQueueAgeMsPerFrame, queuedQueueAge);

  if (!focusedInputSnapshot.active) {
    return;
  }

  pushSample(
    state.focusedInputFocusedWriteBytesPerFrame,
    getPositiveDelta(currentCounters.output.focusedBytes, previousCounters.output.focusedBytes),
  );
  pushSample(
    state.focusedInputHiddenBytesPerFrame,
    getPositiveDelta(currentCounters.output.hiddenBytes, previousCounters.output.hiddenBytes),
  );
  pushSample(
    state.focusedInputNonTargetVisibleBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.nonTargetVisibleBytes,
      previousCounters.output.nonTargetVisibleBytes,
    ),
  );
  pushSample(state.focusedInputQueuedQueueAgeMsPerFrame, queuedQueueAge);
  pushSample(
    state.focusedInputVisibleBackgroundBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.visibleBackgroundBytes,
      previousCounters.output.visibleBackgroundBytes,
    ),
  );
}

function recordFrameRuntimeCounters(
  currentCounters: UiFluidityCounters,
  previousCounters: UiFluidityCounters,
): void {
  const schedulerScanMs = getPositiveDelta(
    currentCounters.runtime.schedulerScanDurationMs,
    previousCounters.runtime.schedulerScanDurationMs,
  );
  const schedulerDrainMs = getPositiveDelta(
    currentCounters.runtime.schedulerDrainDurationMs,
    previousCounters.runtime.schedulerDrainDurationMs,
  );
  const agentAnalysisMs = getPositiveDelta(
    currentCounters.runtime.agentAnalysisDurationMs,
    previousCounters.runtime.agentAnalysisDurationMs,
  );

  pushSample(state.schedulerScanDurationMsPerFrame, schedulerScanMs);
  pushSample(state.schedulerDrainDurationMsPerFrame, schedulerDrainMs);
  pushSample(state.agentAnalysisDurationMsPerFrame, agentAnalysisMs);
  pushSample(state.activeWebglContextsPerFrame, currentCounters.runtime.activeWebglContextsCurrent);
  pushSample(
    state.visibleWebglContextsPerFrame,
    currentCounters.runtime.visibleWebglContextsCurrent,
  );
  pushSample(state.ownerDurationMsPerFrame, schedulerScanMs + schedulerDrainMs + agentAnalysisMs);
}

function areSwitchWindowCompletionsEqual(
  left: TerminalSwitchWindowCompletion | null,
  right: TerminalSwitchWindowCompletion | null,
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.durationMs === right.durationMs &&
    left.reason === right.reason &&
    left.taskId === right.taskId
  );
}

function areSwitchEchoGraceCompletionsEqual(
  left: TerminalSwitchEchoGraceCompletion | null,
  right: TerminalSwitchEchoGraceCompletion | null,
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.durationMs === right.durationMs &&
    left.reason === right.reason &&
    left.taskId === right.taskId
  );
}

function getUiFluidityCounters(): UiFluidityCounters {
  const terminalOutputSummary = getTerminalOutputDiagnosticsSummary();
  const rendererRuntime = getRendererRuntimeDiagnosticsSnapshot();
  const webglPoolSnapshot = getWebglPoolRuntimeSnapshot();

  return {
    output: {
      activeVisibleBytes: terminalOutputSummary.writes.byPriority['active-visible'].bytes,
      directWriteBytes: terminalOutputSummary.writes.bySource.direct.bytes,
      directWriteCalls: terminalOutputSummary.writes.bySource.direct.calls,
      hiddenBytes: terminalOutputSummary.writes.byLane.hidden.bytes,
      nonTargetVisibleBytes:
        terminalOutputSummary.writes.byPriority['active-visible'].bytes +
        terminalOutputSummary.writes.byPriority['visible-background'].bytes,
      queuedWriteBytes: terminalOutputSummary.writes.bySource.queued.bytes,
      queuedWriteCalls: terminalOutputSummary.writes.bySource.queued.calls,
      suppressedBytes: terminalOutputSummary.suppressed.totalBytes,
      queueAge: {
        activeVisible: terminalOutputSummary.queueAgeMs.byPriority['active-visible'],
        focused: terminalOutputSummary.queueAgeMs.byLane.focused,
        hidden: terminalOutputSummary.queueAgeMs.byLane.hidden,
        queued: terminalOutputSummary.queueAgeMs.bySource.queued,
        switchTargetVisible: terminalOutputSummary.queueAgeMs.byPriority['switch-target-visible'],
        visibleBackground: terminalOutputSummary.queueAgeMs.byPriority['visible-background'],
        visible: terminalOutputSummary.queueAgeMs.byLane.visible,
      },
      focusedBytes: terminalOutputSummary.writes.byPriority.focused.bytes,
      switchTargetVisibleBytes:
        terminalOutputSummary.writes.byPriority['switch-target-visible'].bytes,
      totalBytes: terminalOutputSummary.writes.totalBytes,
      totalCalls: terminalOutputSummary.writes.totalCalls,
      visibleBytes: terminalOutputSummary.writes.byLane.visible.bytes,
      visibleBackgroundBytes: terminalOutputSummary.writes.byPriority['visible-background'].bytes,
    },
    runtime: {
      activeWebglContextsCurrent: webglPoolSnapshot.activeContextsCurrent,
      agentAnalysisDurationMs: rendererRuntime.agentOutputAnalysis.totalAnalysisDurationMs,
      schedulerDrainDurationMs: rendererRuntime.terminalOutputScheduler.totalDrainDurationMs,
      schedulerScanDurationMs: rendererRuntime.terminalOutputScheduler.totalScanDurationMs,
      visibleWebglContextsCurrent: webglPoolSnapshot.visibleContextsCurrent,
    },
  };
}

function createUiFluiditySwitchWindowSnapshot(
  switchWindow: TerminalSwitchWindowSnapshot,
  baselineCounters: UiFluidityCounters,
  currentCounters: UiFluidityCounters,
  firstPaintSample: UiFluiditySwitchWindowPhaseSnapshot | null,
  inputReadySample: UiFluiditySwitchWindowPhaseSnapshot | null,
): UiFluiditySwitchWindowSnapshot {
  const activeVisibleQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.activeVisible,
      baselineCounters.output.queueAge.activeVisible,
    ),
  );
  const focusedQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.focused,
      baselineCounters.output.queueAge.focused,
    ),
  );
  const hiddenQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.hidden,
      baselineCounters.output.queueAge.hidden,
    ),
  );
  const queuedQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.queued,
      baselineCounters.output.queueAge.queued,
    ),
  );
  const switchTargetVisibleQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.switchTargetVisible,
      baselineCounters.output.queueAge.switchTargetVisible,
    ),
  );
  const visibleBackgroundQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.visibleBackground,
      baselineCounters.output.queueAge.visibleBackground,
    ),
  );
  const visibleQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.visible,
      baselineCounters.output.queueAge.visible,
    ),
  );

  return {
    active: switchWindow.active,
    activeVisibleBytes: getPositiveDelta(
      currentCounters.output.activeVisibleBytes,
      baselineCounters.output.activeVisibleBytes,
    ),
    activeVisibleQueueAgeMs,
    agentAnalysisDurationMs: getPositiveDelta(
      currentCounters.runtime.agentAnalysisDurationMs,
      baselineCounters.runtime.agentAnalysisDurationMs,
    ),
    ageMs: switchWindow.active
      ? switchWindow.ageMs
      : (switchWindow.lastCompletion?.durationMs ?? 0),
    firstPaintSample,
    firstPaintDurationMs:
      switchWindow.firstPaintDurationMs ??
      switchWindow.lastCompletion?.firstPaintDurationMs ??
      null,
    focusedBytes: getPositiveDelta(
      currentCounters.output.focusedBytes,
      baselineCounters.output.focusedBytes,
    ),
    focusedQueueAgeMs,
    hiddenBytes: getPositiveDelta(
      currentCounters.output.hiddenBytes,
      baselineCounters.output.hiddenBytes,
    ),
    hiddenQueueAgeMs,
    inputReadySample,
    inputReadyDurationMs:
      switchWindow.inputReadyDurationMs ??
      switchWindow.lastCompletion?.inputReadyDurationMs ??
      null,
    lastCompletion: switchWindow.lastCompletion,
    phase: switchWindow.phase,
    queuedQueueAgeMs,
    remainingMs: switchWindow.remainingMs,
    selectedRecoveryActive: switchWindow.selectedRecoveryActive,
    schedulerDrainDurationMs: getPositiveDelta(
      currentCounters.runtime.schedulerDrainDurationMs,
      baselineCounters.runtime.schedulerDrainDurationMs,
    ),
    schedulerScanDurationMs: getPositiveDelta(
      currentCounters.runtime.schedulerScanDurationMs,
      baselineCounters.runtime.schedulerScanDurationMs,
    ),
    switchTargetVisibleBytes: getPositiveDelta(
      currentCounters.output.switchTargetVisibleBytes,
      baselineCounters.output.switchTargetVisibleBytes,
    ),
    switchTargetVisibleQueueAgeMs,
    targetTaskId: switchWindow.targetTaskId,
    visibleBackgroundBytes: getPositiveDelta(
      currentCounters.output.visibleBackgroundBytes,
      baselineCounters.output.visibleBackgroundBytes,
    ),
    visibleBackgroundQueueAgeMs,
    visibleBytes: getPositiveDelta(
      currentCounters.output.visibleBytes,
      baselineCounters.output.visibleBytes,
    ),
    visibleQueueAgeMs,
  };
}

function createUiFluiditySwitchEchoGraceSnapshot(
  switchEchoGrace: TerminalSwitchEchoGraceSnapshot,
  baselineCounters: UiFluidityCounters,
  currentCounters: UiFluidityCounters,
  completionSample: UiFluiditySwitchWindowPhaseSnapshot | null,
): UiFluiditySwitchEchoGraceSnapshot {
  const focusedQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.focused,
      baselineCounters.output.queueAge.focused,
    ),
  );
  const hiddenQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.hidden,
      baselineCounters.output.queueAge.hidden,
    ),
  );
  const queuedQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.queued,
      baselineCounters.output.queueAge.queued,
    ),
  );
  const switchTargetVisibleQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.switchTargetVisible,
      baselineCounters.output.queueAge.switchTargetVisible,
    ),
  );
  const visibleBackgroundQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.visibleBackground,
      baselineCounters.output.queueAge.visibleBackground,
    ),
  );
  const visibleQueueAgeMs = getAverageFromDiagnosticsTotal(
    getNumericDiagnosticsDelta(
      currentCounters.output.queueAge.visible,
      baselineCounters.output.queueAge.visible,
    ),
  );

  return {
    active: switchEchoGrace.active,
    ageMs: switchEchoGrace.ageMs,
    completionSample,
    durationMs: switchEchoGrace.lastCompletion?.durationMs ?? null,
    focusedBytes: getPositiveDelta(
      currentCounters.output.focusedBytes,
      baselineCounters.output.focusedBytes,
    ),
    focusedQueueAgeMs,
    hiddenBytes: getPositiveDelta(
      currentCounters.output.hiddenBytes,
      baselineCounters.output.hiddenBytes,
    ),
    hiddenQueueAgeMs,
    lastCompletion: switchEchoGrace.lastCompletion,
    nonTargetVisibleBytes: getPositiveDelta(
      currentCounters.output.nonTargetVisibleBytes,
      baselineCounters.output.nonTargetVisibleBytes,
    ),
    queuedQueueAgeMs,
    remainingMs: switchEchoGrace.remainingMs,
    switchTargetVisibleBytes: getPositiveDelta(
      currentCounters.output.switchTargetVisibleBytes,
      baselineCounters.output.switchTargetVisibleBytes,
    ),
    switchTargetVisibleQueueAgeMs,
    targetTaskId: switchEchoGrace.targetTaskId,
    visibleBackgroundBytes: getPositiveDelta(
      currentCounters.output.visibleBackgroundBytes,
      baselineCounters.output.visibleBackgroundBytes,
    ),
    visibleBackgroundQueueAgeMs,
    visibleQueueAgeMs,
  };
}

function createUiFluiditySwitchWindowPhaseSnapshot(
  baselineCounters: UiFluidityCounters,
  currentCounters: UiFluidityCounters,
): UiFluiditySwitchWindowPhaseSnapshot {
  return {
    activeVisibleBytes: getPositiveDelta(
      currentCounters.output.activeVisibleBytes,
      baselineCounters.output.activeVisibleBytes,
    ),
    activeVisibleQueueAgeMs: getAverageFromDiagnosticsTotal(
      getNumericDiagnosticsDelta(
        currentCounters.output.queueAge.activeVisible,
        baselineCounters.output.queueAge.activeVisible,
      ),
    ),
    focusedBytes: getPositiveDelta(
      currentCounters.output.focusedBytes,
      baselineCounters.output.focusedBytes,
    ),
    focusedQueueAgeMs: getAverageFromDiagnosticsTotal(
      getNumericDiagnosticsDelta(
        currentCounters.output.queueAge.focused,
        baselineCounters.output.queueAge.focused,
      ),
    ),
    framePressureLevel: getTerminalFramePressureLevel(),
    hiddenBytes: getPositiveDelta(
      currentCounters.output.hiddenBytes,
      baselineCounters.output.hiddenBytes,
    ),
    hiddenQueueAgeMs: getAverageFromDiagnosticsTotal(
      getNumericDiagnosticsDelta(
        currentCounters.output.queueAge.hidden,
        baselineCounters.output.queueAge.hidden,
      ),
    ),
    nonTargetVisibleBytes: getPositiveDelta(
      currentCounters.output.nonTargetVisibleBytes,
      baselineCounters.output.nonTargetVisibleBytes,
    ),
    queuedQueueAgeMs: getAverageFromDiagnosticsTotal(
      getNumericDiagnosticsDelta(
        currentCounters.output.queueAge.queued,
        baselineCounters.output.queueAge.queued,
      ),
    ),
    switchTargetVisibleBytes: getPositiveDelta(
      currentCounters.output.switchTargetVisibleBytes,
      baselineCounters.output.switchTargetVisibleBytes,
    ),
    switchTargetVisibleQueueAgeMs: getAverageFromDiagnosticsTotal(
      getNumericDiagnosticsDelta(
        currentCounters.output.queueAge.switchTargetVisible,
        baselineCounters.output.queueAge.switchTargetVisible,
      ),
    ),
    visibleBackgroundBytes: getPositiveDelta(
      currentCounters.output.visibleBackgroundBytes,
      baselineCounters.output.visibleBackgroundBytes,
    ),
    visibleBackgroundQueueAgeMs: getAverageFromDiagnosticsTotal(
      getNumericDiagnosticsDelta(
        currentCounters.output.queueAge.visibleBackground,
        baselineCounters.output.queueAge.visibleBackground,
      ),
    ),
    visibleQueueAgeMs: getAverageFromDiagnosticsTotal(
      getNumericDiagnosticsDelta(
        currentCounters.output.queueAge.visible,
        baselineCounters.output.queueAge.visible,
      ),
    ),
  };
}

function syncUiFluiditySwitchWindowObservation(currentCounters: UiFluidityCounters): void {
  const currentSwitchWindow = getTerminalSwitchWindowSnapshot();
  const activeSwitchWindow = state.activeSwitchWindow;

  if (currentSwitchWindow.active) {
    const shouldCaptureBaseline =
      activeSwitchWindow === null ||
      activeSwitchWindow.switchWindow.targetTaskId !== currentSwitchWindow.targetTaskId;
    if (shouldCaptureBaseline) {
      state.activeSwitchWindow = {
        baselineCounters: currentCounters,
        firstPaintSample: null,
        inputReadySample: null,
        switchWindow: currentSwitchWindow,
      };
    } else {
      let nextActiveSwitchWindow: UiFluiditySwitchWindowState = {
        ...activeSwitchWindow,
        switchWindow: currentSwitchWindow,
      };

      if (
        nextActiveSwitchWindow.firstPaintSample === null &&
        currentSwitchWindow.firstPaintDurationMs !== null
      ) {
        nextActiveSwitchWindow = {
          ...nextActiveSwitchWindow,
          firstPaintSample: createUiFluiditySwitchWindowPhaseSnapshot(
            nextActiveSwitchWindow.baselineCounters,
            currentCounters,
          ),
        };
      }

      if (
        nextActiveSwitchWindow.inputReadySample === null &&
        currentSwitchWindow.inputReadyDurationMs !== null
      ) {
        nextActiveSwitchWindow = {
          ...nextActiveSwitchWindow,
          inputReadySample: createUiFluiditySwitchWindowPhaseSnapshot(
            nextActiveSwitchWindow.baselineCounters,
            currentCounters,
          ),
        };
      }

      state.activeSwitchWindow = nextActiveSwitchWindow;
    }
  } else if (activeSwitchWindow) {
    const firstPaintSample =
      activeSwitchWindow.firstPaintSample ??
      (currentSwitchWindow.lastCompletion?.firstPaintDurationMs === null
        ? null
        : createUiFluiditySwitchWindowPhaseSnapshot(
            activeSwitchWindow.baselineCounters,
            currentCounters,
          ));
    const inputReadySample =
      activeSwitchWindow.inputReadySample ??
      (currentSwitchWindow.lastCompletion?.inputReadyDurationMs === null
        ? null
        : createUiFluiditySwitchWindowPhaseSnapshot(
            activeSwitchWindow.baselineCounters,
            currentCounters,
          ));
    state.lastCompletedSwitchWindow = createUiFluiditySwitchWindowSnapshot(
      currentSwitchWindow,
      activeSwitchWindow.baselineCounters,
      currentCounters,
      firstPaintSample,
      inputReadySample,
    );
    state.activeSwitchWindow = null;
  }

  if (
    !areSwitchWindowCompletionsEqual(
      currentSwitchWindow.lastCompletion,
      state.lastObservedSwitchWindowCompletion,
    )
  ) {
    state.lastObservedSwitchWindowCompletion = currentSwitchWindow.lastCompletion;
  }
}

function syncUiFluiditySwitchEchoGraceObservation(currentCounters: UiFluidityCounters): void {
  const currentSwitchEchoGrace = getTerminalSwitchEchoGraceSnapshot();
  const activeSwitchEchoGrace = state.activeSwitchEchoGrace;

  if (currentSwitchEchoGrace.active) {
    const shouldCaptureBaseline =
      activeSwitchEchoGrace === null ||
      activeSwitchEchoGrace.switchEchoGrace.targetTaskId !== currentSwitchEchoGrace.targetTaskId;
    if (shouldCaptureBaseline) {
      state.activeSwitchEchoGrace = {
        baselineCounters: currentCounters,
        completionSample: null,
        switchEchoGrace: currentSwitchEchoGrace,
      };
    } else {
      state.activeSwitchEchoGrace = {
        ...activeSwitchEchoGrace,
        switchEchoGrace: currentSwitchEchoGrace,
      };
    }
  } else if (activeSwitchEchoGrace) {
    const completionSample =
      activeSwitchEchoGrace.completionSample ??
      (currentSwitchEchoGrace.lastCompletion === null
        ? null
        : createUiFluiditySwitchWindowPhaseSnapshot(
            activeSwitchEchoGrace.baselineCounters,
            currentCounters,
          ));
    state.lastCompletedSwitchEchoGrace = createUiFluiditySwitchEchoGraceSnapshot(
      currentSwitchEchoGrace,
      activeSwitchEchoGrace.baselineCounters,
      currentCounters,
      completionSample,
    );
    state.activeSwitchEchoGrace = null;
  }

  if (
    !areSwitchEchoGraceCompletionsEqual(
      currentSwitchEchoGrace.lastCompletion,
      state.lastObservedSwitchEchoGraceCompletion,
    )
  ) {
    state.lastObservedSwitchEchoGraceCompletion = currentSwitchEchoGrace.lastCompletion;
  }
}

function installUiFluiditySwitchWindowObserver(): void {
  if (switchWindowObserverInstalled) {
    return;
  }

  switchWindowObserverInstalled = true;
  subscribeTerminalSwitchWindowChanges(() => {
    if (!isUiFluidityDiagnosticsEnabled()) {
      return;
    }

    const currentCounters = getUiFluidityCounters();
    syncUiFluiditySwitchWindowObservation(currentCounters);
    if (state.previousCounters === null) {
      state.previousCounters = currentCounters;
    }
  });
}

function installUiFluiditySwitchEchoGraceObserver(): void {
  if (switchEchoGraceObserverInstalled) {
    return;
  }

  switchEchoGraceObserverInstalled = true;
  subscribeTerminalSwitchEchoGraceChanges(() => {
    if (!isUiFluidityDiagnosticsEnabled()) {
      return;
    }

    const currentCounters = getUiFluidityCounters();
    syncUiFluiditySwitchEchoGraceObservation(currentCounters);
    if (state.previousCounters === null) {
      state.previousCounters = currentCounters;
    }
  });
}

function recordFrameGap(gapMs: number): void {
  pushSample(state.frameGapMs, gapMs);
  state.framePressureCounts[getTerminalFramePressureLevel()] += 1;
  if (gapMs > FRAME_BUDGET_MS) {
    state.frameOverBudget16ms += 1;
  }
  if (gapMs > 33.4) {
    state.frameOverBudget33ms += 1;
  }
  if (gapMs > 50) {
    state.frameOverBudget50ms += 1;
  }
}

function recordLongTask(entry: PerformanceEntry): void {
  pushSample(state.longTaskDurationMs, entry.duration);
  state.recentLongTasks.push({
    durationMs: entry.duration,
    startMs: entry.startTime,
  });
  if (state.recentLongTasks.length > MAX_RECENT_LONGTASKS) {
    state.recentLongTasks.shift();
  }
}

function sampleUiFluidityFrame(frameTimeMs: number): void {
  if (!isUiFluidityDiagnosticsEnabled()) {
    return;
  }

  const currentCounters = getUiFluidityCounters();
  const focusedInputSnapshot = getTerminalFocusedInputSnapshot();
  syncUiFluiditySwitchEchoGraceObservation(currentCounters);
  syncUiFluiditySwitchWindowObservation(currentCounters);
  const previousCounters = state.previousCounters;
  if (state.lastFrameAtMs !== null) {
    recordFrameGap(Math.max(0, frameTimeMs - state.lastFrameAtMs));
  }

  if (previousCounters) {
    recordFrameOutputCounters(currentCounters, previousCounters, focusedInputSnapshot);
    recordFrameRuntimeCounters(currentCounters, previousCounters);
  }

  state.lastFrameAtMs = frameTimeMs;
  state.previousCounters = currentCounters;
  requestAnimationFrame(sampleUiFluidityFrame);
}

function attachUiFluidityDiagnosticsStore(): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (window.__parallelCodeUiFluidityDiagnostics) {
    return;
  }

  window.__parallelCodeUiFluidityDiagnostics = {
    getSnapshot: getUiFluidityDiagnosticsSnapshot,
    reset: resetUiFluidityDiagnostics,
  };
}

function startLongTaskObserver(): void {
  if (longTaskObserver || typeof PerformanceObserver !== 'function') {
    return;
  }

  longTaskObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      recordLongTask(entry);
    }
  });
  longTaskObserver.observe({ entryTypes: ['longtask'] });
}

function startUiFluidityDiagnosticsLoop(): void {
  if (diagnosticsInstalled || !isUiFluidityDiagnosticsEnabled()) {
    return;
  }

  diagnosticsInstalled = true;
  attachUiFluidityDiagnosticsStore();
  installUiFluiditySwitchWindowObserver();
  installUiFluiditySwitchEchoGraceObserver();
  startLongTaskObserver();
  state.previousCounters = getUiFluidityCounters();
  requestAnimationFrame(sampleUiFluidityFrame);
}

export function resetUiFluidityDiagnostics(): void {
  const currentSwitchWindow = getTerminalSwitchWindowSnapshot();
  const currentSwitchEchoGrace = getTerminalSwitchEchoGraceSnapshot();
  state = createUiFluidityState();
  state.lastObservedSwitchEchoGraceCompletion = currentSwitchEchoGrace.lastCompletion;
  state.lastObservedSwitchWindowCompletion = currentSwitchWindow.lastCompletion;
  longTaskObserver?.takeRecords();
  resetRendererRuntimeDiagnostics();
  resetTerminalOutputDiagnostics();
  if (isUiFluidityDiagnosticsEnabled()) {
    const currentCounters = getUiFluidityCounters();
    state.previousCounters = currentCounters;
    syncUiFluiditySwitchEchoGraceObservation(currentCounters);
    syncUiFluiditySwitchWindowObservation(currentCounters);
  }
}

export function getUiFluidityDiagnosticsSnapshot(): UiFluidityDiagnosticsSnapshot {
  const currentCounters = getUiFluidityCounters();
  syncUiFluiditySwitchEchoGraceObservation(currentCounters);
  syncUiFluiditySwitchWindowObservation(currentCounters);
  const switchEchoGraceSnapshot = state.activeSwitchEchoGrace
    ? createUiFluiditySwitchEchoGraceSnapshot(
        state.activeSwitchEchoGrace.switchEchoGrace,
        state.activeSwitchEchoGrace.baselineCounters,
        currentCounters,
        state.activeSwitchEchoGrace.completionSample,
      )
    : state.lastCompletedSwitchEchoGrace;
  const switchWindowSnapshot = state.activeSwitchWindow
    ? createUiFluiditySwitchWindowSnapshot(
        state.activeSwitchWindow.switchWindow,
        state.activeSwitchWindow.baselineCounters,
        currentCounters,
        state.activeSwitchWindow.firstPaintSample,
        state.activeSwitchWindow.inputReadySample,
      )
    : state.lastCompletedSwitchWindow;

  return {
    experiment: getTerminalPerformanceExperimentConfig(),
    frames: {
      gapMs: createNumericSampleStats(state.frameGapMs),
      overBudget16ms: state.frameOverBudget16ms,
      overBudget33ms: state.frameOverBudget33ms,
      overBudget50ms: state.frameOverBudget50ms,
      pressureCounts: { ...state.framePressureCounts },
    },
    focusedInput: getTerminalFocusedInputSnapshot(),
    longTasks: {
      durationMs: createNumericSampleStats(state.longTaskDurationMs),
      recent: [...state.recentLongTasks],
      totalDurationMs: state.longTaskDurationMs.reduce((total, value) => total + value, 0),
    },
    pacing: getTerminalOutputPacingSnapshot(),
    rendererRuntime: getRendererRuntimeDiagnosticsSnapshot(),
    switchEchoGrace: switchEchoGraceSnapshot,
    switchWindow: switchWindowSnapshot,
    runtimePerFrame: {
      activeWebglContexts: createNumericSampleStats(state.activeWebglContextsPerFrame),
      agentAnalysisDurationMs: createNumericSampleStats(state.agentAnalysisDurationMsPerFrame),
      ownerDurationMs: createNumericSampleStats(state.ownerDurationMsPerFrame),
      schedulerDrainDurationMs: createNumericSampleStats(state.schedulerDrainDurationMsPerFrame),
      schedulerScanDurationMs: createNumericSampleStats(state.schedulerScanDurationMsPerFrame),
      visibleWebglContexts: createNumericSampleStats(state.visibleWebglContextsPerFrame),
    },
    terminalOutput: getTerminalOutputDiagnosticsSummary(),
    terminalOutputPerFrame: {
      activeVisibleBytes: createNumericSampleStats(state.activeVisibleBytesPerFrame),
      activeVisibleQueueAgeMs: createNumericSampleStats(state.activeVisibleQueueAgeMsPerFrame),
      directWriteBytes: createNumericSampleStats(state.directWriteBytesPerFrame),
      directWriteCalls: createNumericSampleStats(state.directWriteCallsPerFrame),
      focusedQueueAgeMs: createNumericSampleStats(state.focusedQueueAgeMsPerFrame),
      focusedWriteBytes: createNumericSampleStats(state.focusedWriteBytesPerFrame),
      hiddenBytes: createNumericSampleStats(state.hiddenBytesPerFrame),
      hiddenQueueAgeMs: createNumericSampleStats(state.hiddenQueueAgeMsPerFrame),
      nonTargetVisibleBytes: createNumericSampleStats(state.nonTargetVisibleBytesPerFrame),
      queuedWriteBytes: createNumericSampleStats(state.queuedWriteBytesPerFrame),
      queuedWriteCalls: createNumericSampleStats(state.queuedWriteCallsPerFrame),
      queuedQueueAgeMs: createNumericSampleStats(state.queuedQueueAgeMsPerFrame),
      suppressedBytes: createNumericSampleStats(state.suppressedBytesPerFrame),
      switchTargetVisibleBytes: createNumericSampleStats(state.switchTargetVisibleBytesPerFrame),
      switchTargetVisibleQueueAgeMs: createNumericSampleStats(
        state.switchTargetVisibleQueueAgeMsPerFrame,
      ),
      visibleBytes: createNumericSampleStats(state.visibleBytesPerFrame),
      visibleBackgroundBytes: createNumericSampleStats(state.visibleBackgroundBytesPerFrame),
      visibleBackgroundQueueAgeMs: createNumericSampleStats(
        state.visibleBackgroundQueueAgeMsPerFrame,
      ),
      visibleQueueAgeMs: createNumericSampleStats(state.visibleQueueAgeMsPerFrame),
      writeBytes: createNumericSampleStats(state.writeBytesPerFrame),
      writeCalls: createNumericSampleStats(state.writeCallsPerFrame),
    },
    terminalOutputDuringFocusedInputPerFrame: {
      focusedWriteBytes: createNumericSampleStats(state.focusedInputFocusedWriteBytesPerFrame),
      hiddenBytes: createNumericSampleStats(state.focusedInputHiddenBytesPerFrame),
      nonTargetVisibleBytes: createNumericSampleStats(
        state.focusedInputNonTargetVisibleBytesPerFrame,
      ),
      queuedQueueAgeMs: createNumericSampleStats(state.focusedInputQueuedQueueAgeMsPerFrame),
      visibleBackgroundBytes: createNumericSampleStats(
        state.focusedInputVisibleBackgroundBytesPerFrame,
      ),
    },
  };
}

export function installUiFluidityDiagnostics(): void {
  if (!isUiFluidityDiagnosticsEnabled()) {
    return;
  }

  attachUiFluidityDiagnosticsStore();
  startUiFluidityDiagnosticsLoop();
}

export function resetUiFluidityDiagnosticsForTests(): void {
  diagnosticsInstalled = false;
  switchEchoGraceObserverInstalled = false;
  switchWindowObserverInstalled = false;
  longTaskObserver?.disconnect();
  longTaskObserver = null;
  state = createUiFluidityState();
  if (typeof window !== 'undefined') {
    Reflect.deleteProperty(window, '__parallelCodeUiFluidityDiagnostics');
  }
}
