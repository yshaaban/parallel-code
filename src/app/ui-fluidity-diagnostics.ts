import {
  getRendererRuntimeDiagnosticsSnapshot,
  getRendererRuntimeUiFluidityCountersSnapshot,
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
  getTerminalOutputUiFluidityCountersSnapshot,
  resetTerminalOutputDiagnostics,
  type NumericDiagnosticsTotal,
  type TerminalOutputDiagnosticsSummarySnapshot,
  type TerminalOutputUiFluidityActiveWriteCounters,
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
    activeWriteAgeMs: NumericSampleStats;
    activeWriteCount: NumericSampleStats;
    activeVisibleBytes: NumericSampleStats;
    activeVisibleQueueAgeMs: NumericSampleStats;
    activeVisibleWriteDurationMs: NumericSampleStats;
    activeVisibleWriteFinalizationDurationMs: NumericSampleStats;
    controlWriteBytes: NumericSampleStats;
    controlWriteDurationMs: NumericSampleStats;
    directWriteBytes: NumericSampleStats;
    directWriteCalls: NumericSampleStats;
    focusedQueueAgeMs: NumericSampleStats;
    focusedWriteBytes: NumericSampleStats;
    focusedWriteDurationMs: NumericSampleStats;
    focusedWriteFinalizationDurationMs: NumericSampleStats;
    hiddenBytes: NumericSampleStats;
    hiddenQueueAgeMs: NumericSampleStats;
    nonTargetVisibleActiveWriteAgeMs: NumericSampleStats;
    nonTargetVisibleActiveWriteCount: NumericSampleStats;
    nonTargetVisibleBytes: NumericSampleStats;
    plainWriteBytes: NumericSampleStats;
    plainWriteDurationMs: NumericSampleStats;
    queuedWriteBytes: NumericSampleStats;
    queuedWriteCalls: NumericSampleStats;
    queuedWriteDurationMs: NumericSampleStats;
    queuedWriteFinalizationDurationMs: NumericSampleStats;
    queuedQueueAgeMs: NumericSampleStats;
    redrawControlWriteBytes: NumericSampleStats;
    redrawControlWriteDurationMs: NumericSampleStats;
    suppressedBytes: NumericSampleStats;
    switchTargetVisibleBytes: NumericSampleStats;
    switchTargetVisibleQueueAgeMs: NumericSampleStats;
    visibleBytes: NumericSampleStats;
    visibleBackgroundActiveWriteAgeMs: NumericSampleStats;
    visibleBackgroundActiveWriteCount: NumericSampleStats;
    visibleBackgroundBytes: NumericSampleStats;
    visibleBackgroundQueueAgeMs: NumericSampleStats;
    visibleBackgroundWriteDurationMs: NumericSampleStats;
    visibleBackgroundWriteFinalizationDurationMs: NumericSampleStats;
    visibleQueueAgeMs: NumericSampleStats;
    writeBytes: NumericSampleStats;
    writeCalls: NumericSampleStats;
    writeDurationMs: NumericSampleStats;
    writeFinalizationDurationMs: NumericSampleStats;
  };
  terminalOutputDuringFocusedInputPerFrame: {
    activeWriteAgeMs: NumericSampleStats;
    activeWriteCount: NumericSampleStats;
    activeVisibleBytes: NumericSampleStats;
    activeVisibleQueueAgeMs: NumericSampleStats;
    controlWriteBytes: NumericSampleStats;
    controlWriteDurationMs: NumericSampleStats;
    directWriteBytes: NumericSampleStats;
    directWriteCalls: NumericSampleStats;
    focusedWriteBytes: NumericSampleStats;
    hiddenBytes: NumericSampleStats;
    nonTargetVisibleActiveWriteAgeMs: NumericSampleStats;
    nonTargetVisibleActiveWriteCount: NumericSampleStats;
    nonTargetVisibleActiveWriteStartedBeforeInputAgeMs: NumericSampleStats;
    nonTargetVisibleActiveWriteStartedBeforeInputBytes: NumericSampleStats;
    nonTargetVisibleActiveWriteStartedBeforeInputCount: NumericSampleStats;
    nonTargetVisibleActiveWriteStartedDuringInputAgeMs: NumericSampleStats;
    nonTargetVisibleActiveWriteStartedDuringInputBytes: NumericSampleStats;
    nonTargetVisibleActiveWriteStartedDuringInputCount: NumericSampleStats;
    nonTargetVisibleBytes: NumericSampleStats;
    nonTargetVisibleWriteDurationMs: NumericSampleStats;
    nonTargetVisibleWriteFinalizationDurationMs: NumericSampleStats;
    plainWriteBytes: NumericSampleStats;
    plainWriteDurationMs: NumericSampleStats;
    queuedWriteBytes: NumericSampleStats;
    queuedWriteCalls: NumericSampleStats;
    queuedQueueAgeMs: NumericSampleStats;
    redrawControlWriteBytes: NumericSampleStats;
    redrawControlWriteDurationMs: NumericSampleStats;
    visibleBackgroundActiveWriteAgeMs: NumericSampleStats;
    visibleBackgroundActiveWriteCount: NumericSampleStats;
    visibleBackgroundActiveWriteStartedBeforeInputAgeMs: NumericSampleStats;
    visibleBackgroundActiveWriteStartedBeforeInputBytes: NumericSampleStats;
    visibleBackgroundActiveWriteStartedBeforeInputCount: NumericSampleStats;
    visibleBackgroundActiveWriteStartedDuringInputAgeMs: NumericSampleStats;
    visibleBackgroundActiveWriteStartedDuringInputBytes: NumericSampleStats;
    visibleBackgroundActiveWriteStartedDuringInputCount: NumericSampleStats;
    visibleBackgroundBytes: NumericSampleStats;
    visibleBackgroundQueueAgeMs: NumericSampleStats;
    visibleBackgroundWriteDurationMs: NumericSampleStats;
    visibleBackgroundWriteFinalizationDurationMs: NumericSampleStats;
    writeDurationMs: NumericSampleStats;
    writeFinalizationDurationMs: NumericSampleStats;
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
    activeWriteAgeMs: {
      activeVisible: NumericDiagnosticsTotal;
      focused: NumericDiagnosticsTotal;
      hidden: NumericDiagnosticsTotal;
      switchTargetVisible: NumericDiagnosticsTotal;
      total: NumericDiagnosticsTotal;
      visible: NumericDiagnosticsTotal;
      visibleBackground: NumericDiagnosticsTotal;
    };
    activeWritesStartedBeforeFocusedInput: TerminalOutputUiFluidityActiveWriteCounters;
    activeWritesStartedSinceFocusedInput: TerminalOutputUiFluidityActiveWriteCounters;
    activeWriteCount: {
      activeVisible: number;
      focused: number;
      hidden: number;
      switchTargetVisible: number;
      total: number;
      visible: number;
      visibleBackground: number;
    };
    activeVisibleBytes: number;
    controlWriteBytes: number;
    directWriteBytes: number;
    directWriteCalls: number;
    hiddenBytes: number;
    nonTargetVisibleBytes: number;
    queuedWriteBytes: number;
    queuedWriteCalls: number;
    plainWriteBytes: number;
    redrawControlWriteBytes: number;
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
  activeWriteAgeMsPerFrame: number[];
  activeWriteCountPerFrame: number[];
  activeVisibleBytesPerFrame: number[];
  activeVisibleQueueAgeMsPerFrame: number[];
  activeVisibleWriteDurationMsPerFrame: number[];
  activeVisibleWriteFinalizationDurationMsPerFrame: number[];
  controlWriteBytesPerFrame: number[];
  controlWriteDurationMsPerFrame: number[];
  activeWebglContextsPerFrame: number[];
  frameGapMs: number[];
  frameOverBudget16ms: number;
  frameOverBudget33ms: number;
  frameOverBudget50ms: number;
  framePressureCounts: Record<TerminalFramePressureLevel, number>;
  directWriteBytesPerFrame: number[];
  directWriteCallsPerFrame: number[];
  focusedInputActiveVisibleBytesPerFrame: number[];
  focusedInputActiveVisibleQueueAgeMsPerFrame: number[];
  focusedInputActiveWriteAgeMsPerFrame: number[];
  focusedInputActiveWriteCountPerFrame: number[];
  focusedInputControlWriteBytesPerFrame: number[];
  focusedInputControlWriteDurationMsPerFrame: number[];
  focusedInputDirectWriteBytesPerFrame: number[];
  focusedInputDirectWriteCallsPerFrame: number[];
  focusedInputFocusedWriteBytesPerFrame: number[];
  focusedInputHiddenBytesPerFrame: number[];
  focusedInputNonTargetVisibleActiveWriteAgeMsPerFrame: number[];
  focusedInputNonTargetVisibleActiveWriteCountPerFrame: number[];
  focusedInputNonTargetVisibleActiveWriteStartedBeforeInputAgeMsPerFrame: number[];
  focusedInputNonTargetVisibleActiveWriteStartedBeforeInputBytesPerFrame: number[];
  focusedInputNonTargetVisibleActiveWriteStartedBeforeInputCountPerFrame: number[];
  focusedInputNonTargetVisibleActiveWriteStartedDuringInputAgeMsPerFrame: number[];
  focusedInputNonTargetVisibleActiveWriteStartedDuringInputBytesPerFrame: number[];
  focusedInputNonTargetVisibleActiveWriteStartedDuringInputCountPerFrame: number[];
  focusedInputNonTargetVisibleBytesPerFrame: number[];
  focusedInputNonTargetVisibleWriteDurationMsPerFrame: number[];
  focusedInputNonTargetVisibleWriteFinalizationDurationMsPerFrame: number[];
  focusedInputPlainWriteBytesPerFrame: number[];
  focusedInputPlainWriteDurationMsPerFrame: number[];
  focusedInputQueuedWriteBytesPerFrame: number[];
  focusedInputQueuedWriteCallsPerFrame: number[];
  focusedInputQueuedQueueAgeMsPerFrame: number[];
  focusedInputRedrawControlWriteBytesPerFrame: number[];
  focusedInputRedrawControlWriteDurationMsPerFrame: number[];
  focusedInputVisibleBackgroundActiveWriteAgeMsPerFrame: number[];
  focusedInputVisibleBackgroundActiveWriteCountPerFrame: number[];
  focusedInputVisibleBackgroundActiveWriteStartedBeforeInputAgeMsPerFrame: number[];
  focusedInputVisibleBackgroundActiveWriteStartedBeforeInputBytesPerFrame: number[];
  focusedInputVisibleBackgroundActiveWriteStartedBeforeInputCountPerFrame: number[];
  focusedInputVisibleBackgroundActiveWriteStartedDuringInputAgeMsPerFrame: number[];
  focusedInputVisibleBackgroundActiveWriteStartedDuringInputBytesPerFrame: number[];
  focusedInputVisibleBackgroundActiveWriteStartedDuringInputCountPerFrame: number[];
  focusedInputVisibleBackgroundBytesPerFrame: number[];
  focusedInputVisibleBackgroundQueueAgeMsPerFrame: number[];
  focusedInputVisibleBackgroundWriteDurationMsPerFrame: number[];
  focusedInputVisibleBackgroundWriteFinalizationDurationMsPerFrame: number[];
  focusedInputWriteDurationMsPerFrame: number[];
  focusedInputWriteFinalizationDurationMsPerFrame: number[];
  focusedWriteBytesPerFrame: number[];
  focusedWriteDurationMsPerFrame: number[];
  focusedWriteFinalizationDurationMsPerFrame: number[];
  hiddenBytesPerFrame: number[];
  hiddenQueueAgeMsPerFrame: number[];
  lastFrameAtMs: number | null;
  longTaskDurationMs: number[];
  nonTargetVisibleActiveWriteAgeMsPerFrame: number[];
  nonTargetVisibleActiveWriteCountPerFrame: number[];
  nonTargetVisibleBytesPerFrame: number[];
  plainWriteBytesPerFrame: number[];
  plainWriteDurationMsPerFrame: number[];
  lastCompletedSwitchWindow: UiFluiditySwitchWindowSnapshot | null;
  lastCompletedSwitchEchoGrace: UiFluiditySwitchEchoGraceSnapshot | null;
  lastObservedSwitchEchoGraceCompletion: TerminalSwitchEchoGraceCompletion | null;
  lastObservedSwitchWindowCompletion: TerminalSwitchWindowCompletion | null;
  ownerDurationMsPerFrame: number[];
  previousCounters: UiFluidityCounters | null;
  queuedWriteBytesPerFrame: number[];
  queuedWriteCallsPerFrame: number[];
  queuedWriteDurationMsPerFrame: number[];
  queuedWriteFinalizationDurationMsPerFrame: number[];
  queuedQueueAgeMsPerFrame: number[];
  redrawControlWriteBytesPerFrame: number[];
  redrawControlWriteDurationMsPerFrame: number[];
  suppressedBytesPerFrame: number[];
  switchTargetVisibleBytesPerFrame: number[];
  switchTargetVisibleQueueAgeMsPerFrame: number[];
  recentLongTasks: UiFluidityLongTaskEntry[];
  schedulerDrainDurationMsPerFrame: number[];
  schedulerScanDurationMsPerFrame: number[];
  visibleWebglContextsPerFrame: number[];
  visibleBytesPerFrame: number[];
  visibleBackgroundActiveWriteAgeMsPerFrame: number[];
  visibleBackgroundActiveWriteCountPerFrame: number[];
  visibleBackgroundBytesPerFrame: number[];
  visibleBackgroundQueueAgeMsPerFrame: number[];
  visibleBackgroundWriteDurationMsPerFrame: number[];
  visibleBackgroundWriteFinalizationDurationMsPerFrame: number[];
  visibleQueueAgeMsPerFrame: number[];
  writeBytesPerFrame: number[];
  writeCallsPerFrame: number[];
  writeDurationMsPerFrame: number[];
  writeFinalizationDurationMsPerFrame: number[];
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
    activeWriteAgeMsPerFrame: [],
    activeWriteCountPerFrame: [],
    activeVisibleBytesPerFrame: [],
    activeVisibleQueueAgeMsPerFrame: [],
    activeVisibleWriteDurationMsPerFrame: [],
    activeVisibleWriteFinalizationDurationMsPerFrame: [],
    activeWebglContextsPerFrame: [],
    agentAnalysisDurationMsPerFrame: [],
    controlWriteBytesPerFrame: [],
    controlWriteDurationMsPerFrame: [],
    directWriteBytesPerFrame: [],
    directWriteCallsPerFrame: [],
    focusedInputActiveVisibleBytesPerFrame: [],
    focusedInputActiveVisibleQueueAgeMsPerFrame: [],
    focusedInputActiveWriteAgeMsPerFrame: [],
    focusedInputActiveWriteCountPerFrame: [],
    focusedInputControlWriteBytesPerFrame: [],
    focusedInputControlWriteDurationMsPerFrame: [],
    focusedInputDirectWriteBytesPerFrame: [],
    focusedInputDirectWriteCallsPerFrame: [],
    focusedInputFocusedWriteBytesPerFrame: [],
    focusedInputHiddenBytesPerFrame: [],
    focusedInputNonTargetVisibleActiveWriteAgeMsPerFrame: [],
    focusedInputNonTargetVisibleActiveWriteCountPerFrame: [],
    focusedInputNonTargetVisibleActiveWriteStartedBeforeInputAgeMsPerFrame: [],
    focusedInputNonTargetVisibleActiveWriteStartedBeforeInputBytesPerFrame: [],
    focusedInputNonTargetVisibleActiveWriteStartedBeforeInputCountPerFrame: [],
    focusedInputNonTargetVisibleActiveWriteStartedDuringInputAgeMsPerFrame: [],
    focusedInputNonTargetVisibleActiveWriteStartedDuringInputBytesPerFrame: [],
    focusedInputNonTargetVisibleActiveWriteStartedDuringInputCountPerFrame: [],
    focusedInputNonTargetVisibleBytesPerFrame: [],
    focusedInputNonTargetVisibleWriteDurationMsPerFrame: [],
    focusedInputNonTargetVisibleWriteFinalizationDurationMsPerFrame: [],
    focusedInputPlainWriteBytesPerFrame: [],
    focusedInputPlainWriteDurationMsPerFrame: [],
    focusedInputQueuedWriteBytesPerFrame: [],
    focusedInputQueuedWriteCallsPerFrame: [],
    focusedInputQueuedQueueAgeMsPerFrame: [],
    focusedInputRedrawControlWriteBytesPerFrame: [],
    focusedInputRedrawControlWriteDurationMsPerFrame: [],
    focusedInputVisibleBackgroundActiveWriteAgeMsPerFrame: [],
    focusedInputVisibleBackgroundActiveWriteCountPerFrame: [],
    focusedInputVisibleBackgroundActiveWriteStartedBeforeInputAgeMsPerFrame: [],
    focusedInputVisibleBackgroundActiveWriteStartedBeforeInputBytesPerFrame: [],
    focusedInputVisibleBackgroundActiveWriteStartedBeforeInputCountPerFrame: [],
    focusedInputVisibleBackgroundActiveWriteStartedDuringInputAgeMsPerFrame: [],
    focusedInputVisibleBackgroundActiveWriteStartedDuringInputBytesPerFrame: [],
    focusedInputVisibleBackgroundActiveWriteStartedDuringInputCountPerFrame: [],
    focusedInputVisibleBackgroundBytesPerFrame: [],
    focusedInputVisibleBackgroundQueueAgeMsPerFrame: [],
    focusedInputVisibleBackgroundWriteDurationMsPerFrame: [],
    focusedInputVisibleBackgroundWriteFinalizationDurationMsPerFrame: [],
    focusedInputWriteDurationMsPerFrame: [],
    focusedInputWriteFinalizationDurationMsPerFrame: [],
    focusedQueueAgeMsPerFrame: [],
    focusedWriteBytesPerFrame: [],
    focusedWriteDurationMsPerFrame: [],
    focusedWriteFinalizationDurationMsPerFrame: [],
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
    nonTargetVisibleActiveWriteAgeMsPerFrame: [],
    nonTargetVisibleActiveWriteCountPerFrame: [],
    nonTargetVisibleBytesPerFrame: [],
    ownerDurationMsPerFrame: [],
    plainWriteBytesPerFrame: [],
    plainWriteDurationMsPerFrame: [],
    previousCounters: null,
    queuedWriteBytesPerFrame: [],
    queuedWriteCallsPerFrame: [],
    queuedWriteDurationMsPerFrame: [],
    queuedWriteFinalizationDurationMsPerFrame: [],
    queuedQueueAgeMsPerFrame: [],
    redrawControlWriteBytesPerFrame: [],
    redrawControlWriteDurationMsPerFrame: [],
    suppressedBytesPerFrame: [],
    switchTargetVisibleBytesPerFrame: [],
    switchTargetVisibleQueueAgeMsPerFrame: [],
    recentLongTasks: [],
    schedulerDrainDurationMsPerFrame: [],
    schedulerScanDurationMsPerFrame: [],
    visibleWebglContextsPerFrame: [],
    visibleBytesPerFrame: [],
    visibleBackgroundActiveWriteAgeMsPerFrame: [],
    visibleBackgroundActiveWriteCountPerFrame: [],
    visibleBackgroundBytesPerFrame: [],
    visibleBackgroundQueueAgeMsPerFrame: [],
    visibleBackgroundWriteDurationMsPerFrame: [],
    visibleBackgroundWriteFinalizationDurationMsPerFrame: [],
    visibleQueueAgeMsPerFrame: [],
    writeBytesPerFrame: [],
    writeCallsPerFrame: [],
    writeDurationMsPerFrame: [],
    writeFinalizationDurationMsPerFrame: [],
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

function getDiagnosticsTotalDelta(
  current: NumericDiagnosticsTotal,
  previous: NumericDiagnosticsTotal,
): number {
  return getNumericDiagnosticsDelta(current, previous).total;
}

function getFocusedInputStartedAtMs(
  focusedInputSnapshot: TerminalFocusedInputSnapshot,
): number | null {
  if (
    !focusedInputSnapshot.active ||
    typeof performance === 'undefined' ||
    typeof performance.now !== 'function'
  ) {
    return null;
  }

  return Math.max(0, performance.now() - focusedInputSnapshot.ageMs);
}

function getNonTargetVisibleActiveWriteAgeMs(
  counters: TerminalOutputUiFluidityActiveWriteCounters,
): number {
  return Math.max(counters.activeVisible.ageMs.max, counters.visibleBackground.ageMs.max);
}

function getNonTargetVisibleActiveWriteCount(
  counters: TerminalOutputUiFluidityActiveWriteCounters,
): number {
  return counters.activeVisible.count + counters.visibleBackground.count;
}

function getNonTargetVisibleActiveWriteBytes(
  counters: TerminalOutputUiFluidityActiveWriteCounters,
): number {
  return counters.activeVisible.bytes + counters.visibleBackground.bytes;
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
  const activeVisibleWriteDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeDurationMs.activeVisible,
    previousCounters.output.writeDurationMs.activeVisible,
  );
  const activeVisibleWriteFinalizationDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeFinalizationDurationMs.activeVisible,
    previousCounters.output.writeFinalizationDurationMs.activeVisible,
  );
  const controlWriteDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeDurationMs.control,
    previousCounters.output.writeDurationMs.control,
  );
  const focusedWriteDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeDurationMs.focused,
    previousCounters.output.writeDurationMs.focused,
  );
  const focusedWriteFinalizationDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeFinalizationDurationMs.focused,
    previousCounters.output.writeFinalizationDurationMs.focused,
  );
  const queuedWriteDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeDurationMs.queued,
    previousCounters.output.writeDurationMs.queued,
  );
  const queuedWriteFinalizationDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeFinalizationDurationMs.queued,
    previousCounters.output.writeFinalizationDurationMs.queued,
  );
  const plainWriteDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeDurationMs.plain,
    previousCounters.output.writeDurationMs.plain,
  );
  const redrawControlWriteDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeDurationMs.redrawControl,
    previousCounters.output.writeDurationMs.redrawControl,
  );
  const visibleBackgroundWriteDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeDurationMs.visibleBackground,
    previousCounters.output.writeDurationMs.visibleBackground,
  );
  const visibleBackgroundWriteFinalizationDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeFinalizationDurationMs.visibleBackground,
    previousCounters.output.writeFinalizationDurationMs.visibleBackground,
  );
  const writeDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeDurationMs.total,
    previousCounters.output.writeDurationMs.total,
  );
  const writeFinalizationDurationMs = getDiagnosticsTotalDelta(
    currentCounters.output.writeFinalizationDurationMs.total,
    previousCounters.output.writeFinalizationDurationMs.total,
  );
  const nonTargetVisibleWriteDurationMs =
    activeVisibleWriteDurationMs + visibleBackgroundWriteDurationMs;
  const nonTargetVisibleWriteFinalizationDurationMs =
    activeVisibleWriteFinalizationDurationMs + visibleBackgroundWriteFinalizationDurationMs;
  const activeWriteAgeMs = currentCounters.output.activeWriteAgeMs.total.max;
  const activeWriteCount = currentCounters.output.activeWriteCount.total;
  const visibleBackgroundActiveWriteAgeMs =
    currentCounters.output.activeWriteAgeMs.visibleBackground.max;
  const visibleBackgroundActiveWriteCount =
    currentCounters.output.activeWriteCount.visibleBackground;
  const nonTargetVisibleActiveWriteAgeMs = Math.max(
    currentCounters.output.activeWriteAgeMs.activeVisible.max,
    visibleBackgroundActiveWriteAgeMs,
  );
  const nonTargetVisibleActiveWriteCount =
    currentCounters.output.activeWriteCount.activeVisible + visibleBackgroundActiveWriteCount;
  const startedBeforeFocusedInput = currentCounters.output.activeWritesStartedBeforeFocusedInput;
  const startedSinceFocusedInput = currentCounters.output.activeWritesStartedSinceFocusedInput;

  pushSample(
    state.writeCallsPerFrame,
    getPositiveDelta(currentCounters.output.totalCalls, previousCounters.output.totalCalls),
  );
  pushSample(state.writeDurationMsPerFrame, writeDurationMs);
  pushSample(state.writeFinalizationDurationMsPerFrame, writeFinalizationDurationMs);
  pushSample(
    state.writeBytesPerFrame,
    getPositiveDelta(currentCounters.output.totalBytes, previousCounters.output.totalBytes),
  );
  pushSample(
    state.controlWriteBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.controlWriteBytes,
      previousCounters.output.controlWriteBytes,
    ),
  );
  pushSample(state.controlWriteDurationMsPerFrame, controlWriteDurationMs);
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
    state.plainWriteBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.plainWriteBytes,
      previousCounters.output.plainWriteBytes,
    ),
  );
  pushSample(state.plainWriteDurationMsPerFrame, plainWriteDurationMs);
  pushSample(state.queuedWriteDurationMsPerFrame, queuedWriteDurationMs);
  pushSample(state.queuedWriteFinalizationDurationMsPerFrame, queuedWriteFinalizationDurationMs);
  pushSample(
    state.redrawControlWriteBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.redrawControlWriteBytes,
      previousCounters.output.redrawControlWriteBytes,
    ),
  );
  pushSample(state.redrawControlWriteDurationMsPerFrame, redrawControlWriteDurationMs);
  pushSample(state.activeWriteAgeMsPerFrame, activeWriteAgeMs);
  pushSample(state.activeWriteCountPerFrame, activeWriteCount);
  pushSample(state.nonTargetVisibleActiveWriteAgeMsPerFrame, nonTargetVisibleActiveWriteAgeMs);
  pushSample(state.nonTargetVisibleActiveWriteCountPerFrame, nonTargetVisibleActiveWriteCount);
  pushSample(state.visibleBackgroundActiveWriteAgeMsPerFrame, visibleBackgroundActiveWriteAgeMs);
  pushSample(state.visibleBackgroundActiveWriteCountPerFrame, visibleBackgroundActiveWriteCount);
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
  pushSample(state.focusedWriteDurationMsPerFrame, focusedWriteDurationMs);
  pushSample(state.focusedWriteFinalizationDurationMsPerFrame, focusedWriteFinalizationDurationMs);
  pushSample(
    state.activeVisibleBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.activeVisibleBytes,
      previousCounters.output.activeVisibleBytes,
    ),
  );
  pushSample(state.activeVisibleWriteDurationMsPerFrame, activeVisibleWriteDurationMs);
  pushSample(
    state.activeVisibleWriteFinalizationDurationMsPerFrame,
    activeVisibleWriteFinalizationDurationMs,
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
  pushSample(state.visibleBackgroundWriteDurationMsPerFrame, visibleBackgroundWriteDurationMs);
  pushSample(
    state.visibleBackgroundWriteFinalizationDurationMsPerFrame,
    visibleBackgroundWriteFinalizationDurationMs,
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
    state.focusedInputActiveVisibleBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.activeVisibleBytes,
      previousCounters.output.activeVisibleBytes,
    ),
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
  pushSample(
    state.focusedInputDirectWriteCallsPerFrame,
    getPositiveDelta(
      currentCounters.output.directWriteCalls,
      previousCounters.output.directWriteCalls,
    ),
  );
  pushSample(
    state.focusedInputDirectWriteBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.directWriteBytes,
      previousCounters.output.directWriteBytes,
    ),
  );
  pushSample(
    state.focusedInputControlWriteBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.controlWriteBytes,
      previousCounters.output.controlWriteBytes,
    ),
  );
  pushSample(state.focusedInputControlWriteDurationMsPerFrame, controlWriteDurationMs);
  pushSample(
    state.focusedInputQueuedWriteCallsPerFrame,
    getPositiveDelta(
      currentCounters.output.queuedWriteCalls,
      previousCounters.output.queuedWriteCalls,
    ),
  );
  pushSample(
    state.focusedInputQueuedWriteBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.queuedWriteBytes,
      previousCounters.output.queuedWriteBytes,
    ),
  );
  pushSample(
    state.focusedInputPlainWriteBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.plainWriteBytes,
      previousCounters.output.plainWriteBytes,
    ),
  );
  pushSample(state.focusedInputPlainWriteDurationMsPerFrame, plainWriteDurationMs);
  pushSample(
    state.focusedInputRedrawControlWriteBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.redrawControlWriteBytes,
      previousCounters.output.redrawControlWriteBytes,
    ),
  );
  pushSample(state.focusedInputRedrawControlWriteDurationMsPerFrame, redrawControlWriteDurationMs);
  pushSample(state.focusedInputWriteDurationMsPerFrame, writeDurationMs);
  pushSample(state.focusedInputWriteFinalizationDurationMsPerFrame, writeFinalizationDurationMs);
  pushSample(
    state.focusedInputNonTargetVisibleWriteDurationMsPerFrame,
    nonTargetVisibleWriteDurationMs,
  );
  pushSample(
    state.focusedInputNonTargetVisibleWriteFinalizationDurationMsPerFrame,
    nonTargetVisibleWriteFinalizationDurationMs,
  );
  pushSample(state.focusedInputActiveWriteAgeMsPerFrame, activeWriteAgeMs);
  pushSample(state.focusedInputActiveWriteCountPerFrame, activeWriteCount);
  pushSample(
    state.focusedInputNonTargetVisibleActiveWriteAgeMsPerFrame,
    nonTargetVisibleActiveWriteAgeMs,
  );
  pushSample(
    state.focusedInputNonTargetVisibleActiveWriteCountPerFrame,
    nonTargetVisibleActiveWriteCount,
  );
  pushSample(
    state.focusedInputVisibleBackgroundActiveWriteAgeMsPerFrame,
    visibleBackgroundActiveWriteAgeMs,
  );
  pushSample(
    state.focusedInputVisibleBackgroundActiveWriteCountPerFrame,
    visibleBackgroundActiveWriteCount,
  );
  pushSample(
    state.focusedInputNonTargetVisibleActiveWriteStartedBeforeInputAgeMsPerFrame,
    getNonTargetVisibleActiveWriteAgeMs(startedBeforeFocusedInput),
  );
  pushSample(
    state.focusedInputNonTargetVisibleActiveWriteStartedBeforeInputBytesPerFrame,
    getNonTargetVisibleActiveWriteBytes(startedBeforeFocusedInput),
  );
  pushSample(
    state.focusedInputNonTargetVisibleActiveWriteStartedBeforeInputCountPerFrame,
    getNonTargetVisibleActiveWriteCount(startedBeforeFocusedInput),
  );
  pushSample(
    state.focusedInputNonTargetVisibleActiveWriteStartedDuringInputAgeMsPerFrame,
    getNonTargetVisibleActiveWriteAgeMs(startedSinceFocusedInput),
  );
  pushSample(
    state.focusedInputNonTargetVisibleActiveWriteStartedDuringInputBytesPerFrame,
    getNonTargetVisibleActiveWriteBytes(startedSinceFocusedInput),
  );
  pushSample(
    state.focusedInputNonTargetVisibleActiveWriteStartedDuringInputCountPerFrame,
    getNonTargetVisibleActiveWriteCount(startedSinceFocusedInput),
  );
  pushSample(
    state.focusedInputVisibleBackgroundActiveWriteStartedBeforeInputAgeMsPerFrame,
    startedBeforeFocusedInput.visibleBackground.ageMs.max,
  );
  pushSample(
    state.focusedInputVisibleBackgroundActiveWriteStartedBeforeInputBytesPerFrame,
    startedBeforeFocusedInput.visibleBackground.bytes,
  );
  pushSample(
    state.focusedInputVisibleBackgroundActiveWriteStartedBeforeInputCountPerFrame,
    startedBeforeFocusedInput.visibleBackground.count,
  );
  pushSample(
    state.focusedInputVisibleBackgroundActiveWriteStartedDuringInputAgeMsPerFrame,
    startedSinceFocusedInput.visibleBackground.ageMs.max,
  );
  pushSample(
    state.focusedInputVisibleBackgroundActiveWriteStartedDuringInputBytesPerFrame,
    startedSinceFocusedInput.visibleBackground.bytes,
  );
  pushSample(
    state.focusedInputVisibleBackgroundActiveWriteStartedDuringInputCountPerFrame,
    startedSinceFocusedInput.visibleBackground.count,
  );
  pushSample(state.focusedInputActiveVisibleQueueAgeMsPerFrame, activeVisibleQueueAge);
  pushSample(state.focusedInputQueuedQueueAgeMsPerFrame, queuedQueueAge);
  pushSample(
    state.focusedInputVisibleBackgroundBytesPerFrame,
    getPositiveDelta(
      currentCounters.output.visibleBackgroundBytes,
      previousCounters.output.visibleBackgroundBytes,
    ),
  );
  pushSample(
    state.focusedInputVisibleBackgroundWriteDurationMsPerFrame,
    visibleBackgroundWriteDurationMs,
  );
  pushSample(
    state.focusedInputVisibleBackgroundWriteFinalizationDurationMsPerFrame,
    visibleBackgroundWriteFinalizationDurationMs,
  );
  pushSample(state.focusedInputVisibleBackgroundQueueAgeMsPerFrame, visibleBackgroundQueueAge);
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

function getUiFluidityCounters(
  focusedInputSnapshot = getTerminalFocusedInputSnapshot(),
): UiFluidityCounters {
  const terminalOutputSummary = getTerminalOutputUiFluidityCountersSnapshot({
    activeWriteBoundaryStartedAtMs: getFocusedInputStartedAtMs(focusedInputSnapshot),
  });
  const rendererRuntime = getRendererRuntimeUiFluidityCountersSnapshot();
  const webglPoolSnapshot = getWebglPoolRuntimeSnapshot();

  return {
    output: {
      activeWriteAgeMs: {
        activeVisible: terminalOutputSummary.activeWriteAgeMs.activeVisible,
        focused: terminalOutputSummary.activeWriteAgeMs.focused,
        hidden: terminalOutputSummary.activeWriteAgeMs.hidden,
        switchTargetVisible: terminalOutputSummary.activeWriteAgeMs.switchTargetVisible,
        total: terminalOutputSummary.activeWriteAgeMs.total,
        visible: terminalOutputSummary.activeWriteAgeMs.visible,
        visibleBackground: terminalOutputSummary.activeWriteAgeMs.visibleBackground,
      },
      activeWritesStartedBeforeFocusedInput:
        terminalOutputSummary.activeWritesStartedBeforeBoundary,
      activeWritesStartedSinceFocusedInput: terminalOutputSummary.activeWritesStartedSinceBoundary,
      activeWriteCount: {
        activeVisible: terminalOutputSummary.activeWriteCount.activeVisible,
        focused: terminalOutputSummary.activeWriteCount.focused,
        hidden: terminalOutputSummary.activeWriteCount.hidden,
        switchTargetVisible: terminalOutputSummary.activeWriteCount.switchTargetVisible,
        total: terminalOutputSummary.activeWriteCount.total,
        visible: terminalOutputSummary.activeWriteCount.visible,
        visibleBackground: terminalOutputSummary.activeWriteCount.visibleBackground,
      },
      activeVisibleBytes: terminalOutputSummary.activeVisibleBytes,
      controlWriteBytes: terminalOutputSummary.controlWriteBytes,
      directWriteBytes: terminalOutputSummary.directWriteBytes,
      directWriteCalls: terminalOutputSummary.directWriteCalls,
      hiddenBytes: terminalOutputSummary.hiddenBytes,
      nonTargetVisibleBytes:
        terminalOutputSummary.activeVisibleBytes + terminalOutputSummary.visibleBackgroundBytes,
      plainWriteBytes: terminalOutputSummary.plainWriteBytes,
      queuedWriteBytes: terminalOutputSummary.queuedWriteBytes,
      queuedWriteCalls: terminalOutputSummary.queuedWriteCalls,
      redrawControlWriteBytes: terminalOutputSummary.redrawControlWriteBytes,
      suppressedBytes: terminalOutputSummary.suppressedBytes,
      queueAge: terminalOutputSummary.queueAge,
      writeDurationMs: terminalOutputSummary.writeDurationMs,
      writeFinalizationDurationMs: terminalOutputSummary.writeFinalizationDurationMs,
      focusedBytes: terminalOutputSummary.focusedBytes,
      switchTargetVisibleBytes: terminalOutputSummary.switchTargetVisibleBytes,
      totalBytes: terminalOutputSummary.totalBytes,
      totalCalls: terminalOutputSummary.totalCalls,
      visibleBytes: terminalOutputSummary.visibleBytes,
      visibleBackgroundBytes: terminalOutputSummary.visibleBackgroundBytes,
    },
    runtime: {
      activeWebglContextsCurrent: webglPoolSnapshot.activeContextsCurrent,
      agentAnalysisDurationMs: rendererRuntime.agentAnalysisDurationMs,
      schedulerDrainDurationMs: rendererRuntime.schedulerDrainDurationMs,
      schedulerScanDurationMs: rendererRuntime.schedulerScanDurationMs,
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

  const focusedInputSnapshot = getTerminalFocusedInputSnapshot();
  const currentCounters = getUiFluidityCounters(focusedInputSnapshot);
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
  const focusedInputSnapshot = getTerminalFocusedInputSnapshot();
  const currentCounters = getUiFluidityCounters(focusedInputSnapshot);
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
    focusedInput: focusedInputSnapshot,
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
      activeWriteAgeMs: createNumericSampleStats(state.activeWriteAgeMsPerFrame),
      activeWriteCount: createNumericSampleStats(state.activeWriteCountPerFrame),
      activeVisibleBytes: createNumericSampleStats(state.activeVisibleBytesPerFrame),
      activeVisibleQueueAgeMs: createNumericSampleStats(state.activeVisibleQueueAgeMsPerFrame),
      activeVisibleWriteDurationMs: createNumericSampleStats(
        state.activeVisibleWriteDurationMsPerFrame,
      ),
      activeVisibleWriteFinalizationDurationMs: createNumericSampleStats(
        state.activeVisibleWriteFinalizationDurationMsPerFrame,
      ),
      controlWriteBytes: createNumericSampleStats(state.controlWriteBytesPerFrame),
      controlWriteDurationMs: createNumericSampleStats(state.controlWriteDurationMsPerFrame),
      directWriteBytes: createNumericSampleStats(state.directWriteBytesPerFrame),
      directWriteCalls: createNumericSampleStats(state.directWriteCallsPerFrame),
      focusedQueueAgeMs: createNumericSampleStats(state.focusedQueueAgeMsPerFrame),
      focusedWriteBytes: createNumericSampleStats(state.focusedWriteBytesPerFrame),
      focusedWriteDurationMs: createNumericSampleStats(state.focusedWriteDurationMsPerFrame),
      focusedWriteFinalizationDurationMs: createNumericSampleStats(
        state.focusedWriteFinalizationDurationMsPerFrame,
      ),
      hiddenBytes: createNumericSampleStats(state.hiddenBytesPerFrame),
      hiddenQueueAgeMs: createNumericSampleStats(state.hiddenQueueAgeMsPerFrame),
      nonTargetVisibleActiveWriteAgeMs: createNumericSampleStats(
        state.nonTargetVisibleActiveWriteAgeMsPerFrame,
      ),
      nonTargetVisibleActiveWriteCount: createNumericSampleStats(
        state.nonTargetVisibleActiveWriteCountPerFrame,
      ),
      nonTargetVisibleBytes: createNumericSampleStats(state.nonTargetVisibleBytesPerFrame),
      plainWriteBytes: createNumericSampleStats(state.plainWriteBytesPerFrame),
      plainWriteDurationMs: createNumericSampleStats(state.plainWriteDurationMsPerFrame),
      queuedWriteBytes: createNumericSampleStats(state.queuedWriteBytesPerFrame),
      queuedWriteCalls: createNumericSampleStats(state.queuedWriteCallsPerFrame),
      queuedWriteDurationMs: createNumericSampleStats(state.queuedWriteDurationMsPerFrame),
      queuedWriteFinalizationDurationMs: createNumericSampleStats(
        state.queuedWriteFinalizationDurationMsPerFrame,
      ),
      queuedQueueAgeMs: createNumericSampleStats(state.queuedQueueAgeMsPerFrame),
      redrawControlWriteBytes: createNumericSampleStats(state.redrawControlWriteBytesPerFrame),
      redrawControlWriteDurationMs: createNumericSampleStats(
        state.redrawControlWriteDurationMsPerFrame,
      ),
      suppressedBytes: createNumericSampleStats(state.suppressedBytesPerFrame),
      switchTargetVisibleBytes: createNumericSampleStats(state.switchTargetVisibleBytesPerFrame),
      switchTargetVisibleQueueAgeMs: createNumericSampleStats(
        state.switchTargetVisibleQueueAgeMsPerFrame,
      ),
      visibleBytes: createNumericSampleStats(state.visibleBytesPerFrame),
      visibleBackgroundActiveWriteAgeMs: createNumericSampleStats(
        state.visibleBackgroundActiveWriteAgeMsPerFrame,
      ),
      visibleBackgroundActiveWriteCount: createNumericSampleStats(
        state.visibleBackgroundActiveWriteCountPerFrame,
      ),
      visibleBackgroundBytes: createNumericSampleStats(state.visibleBackgroundBytesPerFrame),
      visibleBackgroundQueueAgeMs: createNumericSampleStats(
        state.visibleBackgroundQueueAgeMsPerFrame,
      ),
      visibleBackgroundWriteDurationMs: createNumericSampleStats(
        state.visibleBackgroundWriteDurationMsPerFrame,
      ),
      visibleBackgroundWriteFinalizationDurationMs: createNumericSampleStats(
        state.visibleBackgroundWriteFinalizationDurationMsPerFrame,
      ),
      visibleQueueAgeMs: createNumericSampleStats(state.visibleQueueAgeMsPerFrame),
      writeBytes: createNumericSampleStats(state.writeBytesPerFrame),
      writeCalls: createNumericSampleStats(state.writeCallsPerFrame),
      writeDurationMs: createNumericSampleStats(state.writeDurationMsPerFrame),
      writeFinalizationDurationMs: createNumericSampleStats(
        state.writeFinalizationDurationMsPerFrame,
      ),
    },
    terminalOutputDuringFocusedInputPerFrame: {
      activeWriteAgeMs: createNumericSampleStats(state.focusedInputActiveWriteAgeMsPerFrame),
      activeWriteCount: createNumericSampleStats(state.focusedInputActiveWriteCountPerFrame),
      activeVisibleBytes: createNumericSampleStats(state.focusedInputActiveVisibleBytesPerFrame),
      activeVisibleQueueAgeMs: createNumericSampleStats(
        state.focusedInputActiveVisibleQueueAgeMsPerFrame,
      ),
      controlWriteBytes: createNumericSampleStats(state.focusedInputControlWriteBytesPerFrame),
      controlWriteDurationMs: createNumericSampleStats(
        state.focusedInputControlWriteDurationMsPerFrame,
      ),
      directWriteBytes: createNumericSampleStats(state.focusedInputDirectWriteBytesPerFrame),
      directWriteCalls: createNumericSampleStats(state.focusedInputDirectWriteCallsPerFrame),
      focusedWriteBytes: createNumericSampleStats(state.focusedInputFocusedWriteBytesPerFrame),
      hiddenBytes: createNumericSampleStats(state.focusedInputHiddenBytesPerFrame),
      nonTargetVisibleActiveWriteAgeMs: createNumericSampleStats(
        state.focusedInputNonTargetVisibleActiveWriteAgeMsPerFrame,
      ),
      nonTargetVisibleActiveWriteCount: createNumericSampleStats(
        state.focusedInputNonTargetVisibleActiveWriteCountPerFrame,
      ),
      nonTargetVisibleActiveWriteStartedBeforeInputAgeMs: createNumericSampleStats(
        state.focusedInputNonTargetVisibleActiveWriteStartedBeforeInputAgeMsPerFrame,
      ),
      nonTargetVisibleActiveWriteStartedBeforeInputBytes: createNumericSampleStats(
        state.focusedInputNonTargetVisibleActiveWriteStartedBeforeInputBytesPerFrame,
      ),
      nonTargetVisibleActiveWriteStartedBeforeInputCount: createNumericSampleStats(
        state.focusedInputNonTargetVisibleActiveWriteStartedBeforeInputCountPerFrame,
      ),
      nonTargetVisibleActiveWriteStartedDuringInputAgeMs: createNumericSampleStats(
        state.focusedInputNonTargetVisibleActiveWriteStartedDuringInputAgeMsPerFrame,
      ),
      nonTargetVisibleActiveWriteStartedDuringInputBytes: createNumericSampleStats(
        state.focusedInputNonTargetVisibleActiveWriteStartedDuringInputBytesPerFrame,
      ),
      nonTargetVisibleActiveWriteStartedDuringInputCount: createNumericSampleStats(
        state.focusedInputNonTargetVisibleActiveWriteStartedDuringInputCountPerFrame,
      ),
      nonTargetVisibleBytes: createNumericSampleStats(
        state.focusedInputNonTargetVisibleBytesPerFrame,
      ),
      nonTargetVisibleWriteDurationMs: createNumericSampleStats(
        state.focusedInputNonTargetVisibleWriteDurationMsPerFrame,
      ),
      nonTargetVisibleWriteFinalizationDurationMs: createNumericSampleStats(
        state.focusedInputNonTargetVisibleWriteFinalizationDurationMsPerFrame,
      ),
      plainWriteBytes: createNumericSampleStats(state.focusedInputPlainWriteBytesPerFrame),
      plainWriteDurationMs: createNumericSampleStats(
        state.focusedInputPlainWriteDurationMsPerFrame,
      ),
      queuedWriteBytes: createNumericSampleStats(state.focusedInputQueuedWriteBytesPerFrame),
      queuedWriteCalls: createNumericSampleStats(state.focusedInputQueuedWriteCallsPerFrame),
      queuedQueueAgeMs: createNumericSampleStats(state.focusedInputQueuedQueueAgeMsPerFrame),
      redrawControlWriteBytes: createNumericSampleStats(
        state.focusedInputRedrawControlWriteBytesPerFrame,
      ),
      redrawControlWriteDurationMs: createNumericSampleStats(
        state.focusedInputRedrawControlWriteDurationMsPerFrame,
      ),
      visibleBackgroundActiveWriteAgeMs: createNumericSampleStats(
        state.focusedInputVisibleBackgroundActiveWriteAgeMsPerFrame,
      ),
      visibleBackgroundActiveWriteCount: createNumericSampleStats(
        state.focusedInputVisibleBackgroundActiveWriteCountPerFrame,
      ),
      visibleBackgroundActiveWriteStartedBeforeInputAgeMs: createNumericSampleStats(
        state.focusedInputVisibleBackgroundActiveWriteStartedBeforeInputAgeMsPerFrame,
      ),
      visibleBackgroundActiveWriteStartedBeforeInputBytes: createNumericSampleStats(
        state.focusedInputVisibleBackgroundActiveWriteStartedBeforeInputBytesPerFrame,
      ),
      visibleBackgroundActiveWriteStartedBeforeInputCount: createNumericSampleStats(
        state.focusedInputVisibleBackgroundActiveWriteStartedBeforeInputCountPerFrame,
      ),
      visibleBackgroundActiveWriteStartedDuringInputAgeMs: createNumericSampleStats(
        state.focusedInputVisibleBackgroundActiveWriteStartedDuringInputAgeMsPerFrame,
      ),
      visibleBackgroundActiveWriteStartedDuringInputBytes: createNumericSampleStats(
        state.focusedInputVisibleBackgroundActiveWriteStartedDuringInputBytesPerFrame,
      ),
      visibleBackgroundActiveWriteStartedDuringInputCount: createNumericSampleStats(
        state.focusedInputVisibleBackgroundActiveWriteStartedDuringInputCountPerFrame,
      ),
      visibleBackgroundBytes: createNumericSampleStats(
        state.focusedInputVisibleBackgroundBytesPerFrame,
      ),
      visibleBackgroundQueueAgeMs: createNumericSampleStats(
        state.focusedInputVisibleBackgroundQueueAgeMsPerFrame,
      ),
      visibleBackgroundWriteDurationMs: createNumericSampleStats(
        state.focusedInputVisibleBackgroundWriteDurationMsPerFrame,
      ),
      visibleBackgroundWriteFinalizationDurationMs: createNumericSampleStats(
        state.focusedInputVisibleBackgroundWriteFinalizationDurationMsPerFrame,
      ),
      writeDurationMs: createNumericSampleStats(state.focusedInputWriteDurationMsPerFrame),
      writeFinalizationDurationMs: createNumericSampleStats(
        state.focusedInputWriteFinalizationDurationMsPerFrame,
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
