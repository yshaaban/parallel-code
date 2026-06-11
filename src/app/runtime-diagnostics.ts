import {
  SERVER_STATE_BOOTSTRAP_CATEGORIES,
  type ServerStateBootstrapCategory,
} from '../domain/server-state-bootstrap';
import type { TerminalPresentationModeKind } from '../lib/terminal-presentation-mode';

interface CategoryCounters {
  [category: string]: number;
}

const TERMINAL_FIT_DIRTY_REASONS = [
  'font-family',
  'font-size',
  'intersection',
  'resize',
  'theme',
  'unknown',
] as const;

const TERMINAL_FIT_EXECUTION_SOURCES = [
  'lifecycle',
  'manager',
  'resize-commit',
  'session-immediate',
  'session-raf',
] as const;

const TERMINAL_FIT_SCHEDULE_REASONS = [
  'attach',
  'ready',
  'renderer-loss',
  'restore',
  'spawn-ready',
  'startup',
  'visibility',
] as const;
const TERMINAL_RECOVERY_REASONS = [
  'attach',
  'backpressure',
  'hibernate',
  'reconnect',
  'renderer-loss',
] as const;
const TERMINAL_RECOVERY_KINDS = [
  'delta',
  'noop',
  'snapshot',
  'tail-needed',
  'terminal-state',
] as const;
const TERMINAL_RECOVERY_RESET_REASONS = [
  'attach',
  'backpressure',
  'hibernate',
  'reconnect',
] as const;
const TERMINAL_RESIZE_DEFER_REASONS = [
  'in-flight',
  'not-live',
  'peer-controlled',
  'restore-blocked',
  'spawn-pending',
] as const;
const TERMINAL_RESIZE_PENDING_REASONS = [
  ...TERMINAL_RESIZE_DEFER_REASONS,
  'scheduled',
  'sending',
] as const;
const TERMINAL_PRESENTATION_MODE_KINDS = [
  'error',
  'live',
  'loading',
] as const satisfies readonly TerminalPresentationModeKind[];
const TERMINAL_STARTUP_PAINT_ROLES = ['selected', 'visible-sibling', 'hidden'] as const;
const TERMINAL_STARTUP_TASK_SCHEDULING_OUTCOMES = [
  'fallback-animation-frame',
  'fallback-timeout',
  'off',
  'scheduler-post-task',
  'scheduler-yield',
] as const;
const TERMINAL_STARTUP_WRITE_SIZE_BUCKETS = [
  'lt-4k',
  'k4-to-32k',
  'k32-to-128k',
  'gte-128k',
] as const;
const TERMINAL_RECOVERY_STARTUP_DEFER_PRIORITIES = [
  'active-visible',
  'hidden',
  'visible-background',
] as const;
const BROWSER_STARTUP_CANCEL_REASONS = [
  'auth-expired',
  'cleanup',
  'replaced',
  'reset',
  'restore-failed',
  'transport-lost',
] as const;
const BROWSER_RECONNECT_RESTORE_OUTCOMES = [
  'full-restore',
  'short-disconnect-skip',
  'stale-snapshot-skip',
  'status-check-failed',
] as const;

export type TerminalFitDirtyReason = (typeof TERMINAL_FIT_DIRTY_REASONS)[number];
export type TerminalFitExecutionSource = (typeof TERMINAL_FIT_EXECUTION_SOURCES)[number];
export type TerminalFitScheduleReason = (typeof TERMINAL_FIT_SCHEDULE_REASONS)[number];
export type TerminalRecoveryReason = (typeof TERMINAL_RECOVERY_REASONS)[number];
export type TerminalRecoveryKind = (typeof TERMINAL_RECOVERY_KINDS)[number];
export type TerminalRecoveryResetReason = (typeof TERMINAL_RECOVERY_RESET_REASONS)[number];
export type BrowserStartupCancelReason = (typeof BROWSER_STARTUP_CANCEL_REASONS)[number];
export type BrowserReconnectRestoreOutcome = (typeof BROWSER_RECONNECT_RESTORE_OUTCOMES)[number];
export type TerminalRendererSwapReason = 'attach' | 'restore' | 'selected-switch';
export type TerminalResizeDeferReason = (typeof TERMINAL_RESIZE_DEFER_REASONS)[number];
export type TerminalResizePendingReason = (typeof TERMINAL_RESIZE_PENDING_REASONS)[number];
export type TerminalStartupPaintRole = (typeof TERMINAL_STARTUP_PAINT_ROLES)[number];
export type TerminalStartupTaskSchedulingOutcome =
  (typeof TERMINAL_STARTUP_TASK_SCHEDULING_OUTCOMES)[number];
export type TerminalStartupWriteSizeBucket = (typeof TERMINAL_STARTUP_WRITE_SIZE_BUCKETS)[number];

export interface TerminalRendererPoolSnapshot {
  activeContextsCurrent: number;
  visibleContextsCurrent: number;
}

declare global {
  interface Window {
    __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__?: boolean;
    __PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__?: boolean;
    __parallelCodeRendererRuntimeDiagnostics?: {
      getSnapshot: () => RendererRuntimeDiagnosticsSnapshot;
      reset: () => void;
    };
  }
}

export interface RendererRuntimeDiagnosticsSnapshot {
  agentOutputAnalysis: {
    activeAgents: number;
    analysisCalls: number;
    analysisSchedules: number;
    backgroundChecks: number;
    backgroundSkips: number;
    deferredAnalyses: number;
    immediateAnalyses: number;
    lastAnalysisDurationMs: number | null;
    maxAnalysisDurationMs: number;
    pendingTimers: number;
    totalAnalysisDurationMs: number;
  };
  bootstrap: {
    bufferedEvents: CategoryCounters;
    bufferedSnapshots: CategoryCounters;
    completions: number;
    lastDurationMs: number | null;
  };
  browserSync: {
    completed: number;
    failed: number;
    lastDurationMs: number | null;
    scheduled: number;
    started: number;
    superseded: number;
  };
  browserStartup: {
    currentMode: 'cold-bootstrap' | 'reconnect-restore' | null;
    currentTier:
      | 'idle'
      | 'shell'
      | 'summary'
      | 'selected-task'
      | 'selected-terminal'
      | 'background';
    modeCompleteCounts: Record<'cold-bootstrap' | 'reconnect-restore', number>;
    modeCancelCounts: Record<'cold-bootstrap' | 'reconnect-restore', number>;
    modeCancelReasonCounts: Record<
      'cold-bootstrap' | 'reconnect-restore',
      Record<BrowserStartupCancelReason, number>
    >;
    modeLastCanceledMs: Record<'cold-bootstrap' | 'reconnect-restore', number | null>;
    modeLastDurationMs: Record<'cold-bootstrap' | 'reconnect-restore', number | null>;
    modeStartCounts: Record<'cold-bootstrap' | 'reconnect-restore', number>;
    tierLastReachedMs: Record<
      'idle' | 'shell' | 'summary' | 'selected-task' | 'selected-terminal' | 'background',
      number | null
    >;
    tierCounts: Record<
      'idle' | 'shell' | 'summary' | 'selected-task' | 'selected-terminal' | 'background',
      number
    >;
  };
  browserReconnect: {
    disconnectCounts: Record<
      | 'auth-expired'
      | 'close'
      | 'connect-close'
      | 'connect-error'
      | 'manual'
      | 'missed-pong'
      | 'send-error',
      number
    >;
    fullRestoreDeferredMs: number;
    lastDisconnectedDurationMs: number | null;
    lastReconnectDelayMs: number | null;
    lastRestoreDurationMs: number | null;
    maxReconnectDelayMs: number;
    maxRestoreDurationMs: number;
    pongCount: number;
    reconnectSchedules: number;
    replayGaps: number;
    restoreOutcomeCounts: Record<BrowserReconnectRestoreOutcome, number>;
    rttLastMs: number | null;
    rttMaxMs: number;
  };
  terminalInput: {
    bufferedCharsCurrent: number;
    bufferedCharsMax: number;
    droppedSuffixBatches: number;
    immediateFlushes: number;
    inFlightBatchesCurrent: number;
    inFlightBatchesMax: number;
    localFeedbackAckPulses: number;
    queuedChunksCurrent: number;
    queuedChunksMax: number;
    retrySchedules: number;
    scheduledFlushes: number;
    sentBatchChars: number;
    sentBatchCharsMax: number;
    sentBatches: number;
  };
  terminalOutputScheduler: {
    candidatesCurrent: number;
    candidatesMax: number;
    drainCalls: number;
    drainedBytes: number;
    laneSelections: {
      focused: number;
      hidden: number;
      visible: number;
    };
    lastDrainDurationMs: number | null;
    lastScanDurationMs: number | null;
    maxDrainDurationMs: number;
    maxScanDurationMs: number;
    rescheduledDrains: number;
    scanCalls: number;
    scannedCandidates: number;
    totalDrainDurationMs: number;
    totalScanDurationMs: number;
  };
  terminalPresentation: {
    blockedInputAttempts: Record<TerminalPresentationModeKind, number>;
    enteredCounts: Record<TerminalPresentationModeKind, number>;
    transitions: number;
  };
  terminalStartupPaint: {
    fitExecutionCounts: Record<TerminalStartupPaintRole, number>;
    fitExecutionSourceCounts: Record<
      TerminalStartupPaintRole,
      Record<TerminalFitExecutionSource, number>
    >;
    fitGeometryChangeCounts: Record<TerminalStartupPaintRole, number>;
    fitScheduleCounts: Record<TerminalStartupPaintRole, number>;
    fitScheduleReasonCounts: Record<
      TerminalStartupPaintRole,
      Record<TerminalFitScheduleReason, number>
    >;
    logicalReadyCounts: Record<TerminalStartupPaintRole, number>;
    logicalReadyLastMs: Record<TerminalStartupPaintRole, number | null>;
    logicalReadyMaxMs: Record<TerminalStartupPaintRole, number>;
    logicalReadyTotalMs: Record<TerminalStartupPaintRole, number>;
    logicalToPaintReadyDelayLastMs: Record<TerminalStartupPaintRole, number | null>;
    logicalToPaintReadyDelayMaxMs: Record<TerminalStartupPaintRole, number>;
    logicalToPaintReadyDelayTotalMs: Record<TerminalStartupPaintRole, number>;
    paintReadyCounts: Record<TerminalStartupPaintRole, number>;
    paintReadyLastMs: Record<TerminalStartupPaintRole, number | null>;
    paintReadyMaxMs: Record<TerminalStartupPaintRole, number>;
    paintReadyTotalMs: Record<TerminalStartupPaintRole, number>;
    renderEventCounts: Record<TerminalStartupPaintRole, number>;
    taskContinuationDelayLastMs: Record<TerminalStartupPaintRole, number | null>;
    taskContinuationDelayMaxMs: Record<TerminalStartupPaintRole, number>;
    taskContinuationDelayTotalMs: Record<TerminalStartupPaintRole, number>;
    taskOutcomeCounts: Record<
      TerminalStartupPaintRole,
      Record<TerminalStartupTaskSchedulingOutcome, number>
    >;
    taskScheduleCounts: Record<TerminalStartupPaintRole, number>;
    writeBytes: Record<TerminalStartupPaintRole, number>;
    writeCounts: Record<TerminalStartupPaintRole, number>;
    writeMaxBytes: Record<TerminalStartupPaintRole, number>;
    writeSizeBucketCounts: Record<
      TerminalStartupPaintRole,
      Record<TerminalStartupWriteSizeBucket, number>
    >;
  };
  terminalFit: {
    dirtyMarks: number;
    dirtyReasonCounts: Record<TerminalFitDirtyReason, number>;
    executionCounts: Record<TerminalFitExecutionSource, number>;
    flushCalls: number;
    idleFlushCalls: number;
    geometryChangeFits: number;
    noopSkips: number;
    scheduleCalls: number;
    scheduleReasonCounts: Record<TerminalFitScheduleReason, number>;
  };
  terminalRecovery: {
    blockingUiTransitions: number;
    geometryAlignmentFallbacks: number;
    kindCounts: Record<TerminalRecoveryKind, number>;
    renderRefreshes: number;
    requestCounts: Record<TerminalRecoveryReason, number>;
    requestStateBytes: Record<TerminalRecoveryReason, number>;
    resetCounts: Record<TerminalRecoveryResetReason, number>;
    stableRevealWaits: number;
    startupFirstPaintDeferredCounts: Record<
      (typeof TERMINAL_RECOVERY_STARTUP_DEFER_PRIORITIES)[number],
      number
    >;
    startupFirstPaintDeferredWaitMs: number;
    visibleSteadyStateSnapshotCounts: Record<TerminalRecoveryReason, number>;
    writeBytes: Record<TerminalRecoveryReason, number>;
    writeChunks: Record<TerminalRecoveryReason, number>;
  };
  terminalResize: {
    commitAttempts: number;
    commitDeferredCounts: Record<TerminalResizeDeferReason, number>;
    commitNoopSkips: number;
    commitSuccesses: number;
    flushCalls: number;
    pendingCurrent: number;
    pendingCurrentMax: number;
    pendingMaxAgeMs: number;
    pendingOldestAgeMs: number | null;
    pendingReasonCounts: Record<TerminalResizePendingReason, number>;
    queuedUpdates: number;
    trailingReschedules: number;
  };
  terminalRenderer: {
    acquireAttempts: number;
    acquireHits: number;
    acquireMisses: number;
    activeContextsCurrent: number;
    activeContextsMax: number;
    explicitReleases: number;
    fallbackActivations: number;
    fallbackRecoveries: number;
    rendererSwapCounts: Record<TerminalRendererSwapReason, number>;
    visibleContextsCurrent: number;
    visibleContextsMax: number;
    webglEvictions: number;
  };
}

export interface RendererRuntimeUiFluidityCountersSnapshot {
  agentAnalysisDurationMs: number;
  schedulerDrainDurationMs: number;
  schedulerScanDurationMs: number;
}

function createCounterRecord<TCategory extends string>(
  categories: readonly TCategory[],
): Record<TCategory, number> {
  return Object.fromEntries(categories.map((category) => [category, 0])) as Record<
    TCategory,
    number
  >;
}

function createCategoryCounters(): CategoryCounters {
  return createCounterRecord(SERVER_STATE_BOOTSTRAP_CATEGORIES);
}

function createPerStartupRoleRecord<TValue>(
  createValue: (role: TerminalStartupPaintRole) => TValue,
): Record<TerminalStartupPaintRole, TValue> {
  return Object.fromEntries(
    TERMINAL_STARTUP_PAINT_ROLES.map((role) => [role, createValue(role)]),
  ) as Record<TerminalStartupPaintRole, TValue>;
}

function createPerStartupRoleNullableNumberRecord(): Record<
  TerminalStartupPaintRole,
  number | null
> {
  return createPerStartupRoleRecord(() => null);
}

function clonePerStartupRoleRecord<TValue>(
  record: Record<TerminalStartupPaintRole, TValue>,
  cloneValue: (value: TValue) => TValue,
): Record<TerminalStartupPaintRole, TValue> {
  return createPerStartupRoleRecord((role) => cloneValue(record[role]));
}

function recordStartupDurationMetric(details: {
  countRecord?: Record<TerminalStartupPaintRole, number>;
  durationMs: number;
  lastRecord: Record<TerminalStartupPaintRole, number | null>;
  maxRecord: Record<TerminalStartupPaintRole, number>;
  role: TerminalStartupPaintRole;
  totalRecord: Record<TerminalStartupPaintRole, number>;
}): void {
  const { countRecord, durationMs, lastRecord, maxRecord, role, totalRecord } = details;
  if (countRecord) {
    countRecord[role] += 1;
  }
  lastRecord[role] = durationMs;
  totalRecord[role] += durationMs;
  if (durationMs > maxRecord[role]) {
    maxRecord[role] = durationMs;
  }
}

let rendererRuntimeDiagnostics: RendererRuntimeDiagnosticsSnapshot = createInitialSnapshot();

interface TerminalResizePendingEntry {
  pendingSinceMs: number;
  reason: TerminalResizePendingReason;
}

type TerminalResizePendingStateDetails =
  | { agentId: string; pending: false }
  | {
      agentId: string;
      pending: true;
      pendingSinceMs: number;
      reason: TerminalResizePendingReason;
    };

const terminalResizePendingEntries = new Map<string, TerminalResizePendingEntry>();

function isBrowserRendererRuntimeDiagnosticsEnabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ === true ||
      window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ === true)
  );
}

export function isRendererRuntimeDiagnosticsEnabled(): boolean {
  return isBrowserRendererRuntimeDiagnosticsEnabled();
}

function attachRendererRuntimeDiagnosticsStore(): void {
  if (!isBrowserRendererRuntimeDiagnosticsEnabled()) {
    return;
  }

  if (window.__parallelCodeRendererRuntimeDiagnostics) {
    return;
  }

  window.__parallelCodeRendererRuntimeDiagnostics = {
    getSnapshot: getRendererRuntimeDiagnosticsSnapshot,
    reset: resetRendererRuntimeDiagnostics,
  };
}

function mutateRendererRuntimeDiagnostics(
  updater: (snapshot: RendererRuntimeDiagnosticsSnapshot) => void,
): void {
  if (!isRendererRuntimeDiagnosticsEnabled()) {
    return;
  }

  attachRendererRuntimeDiagnosticsStore();
  updater(rendererRuntimeDiagnostics);
}

function getDiagnosticsNowMs(): number {
  if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
    return Date.now();
  }

  return performance.now();
}

function getTerminalResizePendingSummary(nowMs = getDiagnosticsNowMs()): {
  current: number;
  oldestAgeMs: number | null;
  reasonCounts: Record<TerminalResizePendingReason, number>;
} {
  const reasonCounts = createCounterRecord(TERMINAL_RESIZE_PENDING_REASONS);
  let oldestAgeMs: number | null = null;

  for (const entry of terminalResizePendingEntries.values()) {
    reasonCounts[entry.reason] += 1;
    const ageMs = Math.max(0, nowMs - entry.pendingSinceMs);
    if (oldestAgeMs === null || ageMs > oldestAgeMs) {
      oldestAgeMs = ageMs;
    }
  }

  return {
    current: terminalResizePendingEntries.size,
    oldestAgeMs,
    reasonCounts,
  };
}

function updateTerminalResizePendingEntries(
  details: TerminalResizePendingStateDetails,
  nowMs: number,
): number {
  if (details.pending) {
    terminalResizePendingEntries.set(details.agentId, {
      pendingSinceMs: details.pendingSinceMs,
      reason: details.reason,
    });
    return 0;
  }

  const pendingEntry = terminalResizePendingEntries.get(details.agentId);
  terminalResizePendingEntries.delete(details.agentId);
  return pendingEntry ? Math.max(0, nowMs - pendingEntry.pendingSinceMs) : 0;
}

function syncKnownTerminalResizePendingEntryWhileDisabled(
  details: TerminalResizePendingStateDetails,
): void {
  if (!details.pending) {
    terminalResizePendingEntries.delete(details.agentId);
    return;
  }

  const pendingEntry = terminalResizePendingEntries.get(details.agentId);
  if (!pendingEntry) {
    return;
  }

  pendingEntry.pendingSinceMs = details.pendingSinceMs;
  pendingEntry.reason = details.reason;
}

function createInitialTerminalOutputSchedulerDiagnostics(): RendererRuntimeDiagnosticsSnapshot['terminalOutputScheduler'] {
  return {
    candidatesCurrent: 0,
    candidatesMax: 0,
    drainCalls: 0,
    drainedBytes: 0,
    laneSelections: {
      focused: 0,
      hidden: 0,
      visible: 0,
    },
    lastDrainDurationMs: null,
    lastScanDurationMs: null,
    maxDrainDurationMs: 0,
    maxScanDurationMs: 0,
    rescheduledDrains: 0,
    scanCalls: 0,
    scannedCandidates: 0,
    totalDrainDurationMs: 0,
    totalScanDurationMs: 0,
  };
}

function createInitialTerminalInputDiagnostics(): RendererRuntimeDiagnosticsSnapshot['terminalInput'] {
  return {
    bufferedCharsCurrent: 0,
    bufferedCharsMax: 0,
    droppedSuffixBatches: 0,
    immediateFlushes: 0,
    inFlightBatchesCurrent: 0,
    inFlightBatchesMax: 0,
    localFeedbackAckPulses: 0,
    queuedChunksCurrent: 0,
    queuedChunksMax: 0,
    retrySchedules: 0,
    scheduledFlushes: 0,
    sentBatchChars: 0,
    sentBatchCharsMax: 0,
    sentBatches: 0,
  };
}

function createInitialTerminalPresentationDiagnostics(): RendererRuntimeDiagnosticsSnapshot['terminalPresentation'] {
  return {
    blockedInputAttempts: createCounterRecord(TERMINAL_PRESENTATION_MODE_KINDS),
    enteredCounts: createCounterRecord(TERMINAL_PRESENTATION_MODE_KINDS),
    transitions: 0,
  };
}

function createInitialTerminalStartupPaintDiagnostics(): RendererRuntimeDiagnosticsSnapshot['terminalStartupPaint'] {
  return {
    fitExecutionCounts: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    fitExecutionSourceCounts: createPerStartupRoleRecord(() =>
      createCounterRecord(TERMINAL_FIT_EXECUTION_SOURCES),
    ),
    fitGeometryChangeCounts: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    fitScheduleCounts: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    fitScheduleReasonCounts: createPerStartupRoleRecord(() =>
      createCounterRecord(TERMINAL_FIT_SCHEDULE_REASONS),
    ),
    logicalReadyCounts: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    logicalReadyLastMs: createPerStartupRoleNullableNumberRecord(),
    logicalReadyMaxMs: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    logicalReadyTotalMs: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    logicalToPaintReadyDelayLastMs: createPerStartupRoleNullableNumberRecord(),
    logicalToPaintReadyDelayMaxMs: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    logicalToPaintReadyDelayTotalMs: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    paintReadyCounts: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    paintReadyLastMs: createPerStartupRoleNullableNumberRecord(),
    paintReadyMaxMs: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    paintReadyTotalMs: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    renderEventCounts: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    taskContinuationDelayLastMs: createPerStartupRoleNullableNumberRecord(),
    taskContinuationDelayMaxMs: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    taskContinuationDelayTotalMs: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    taskOutcomeCounts: createPerStartupRoleRecord(() =>
      createCounterRecord(TERMINAL_STARTUP_TASK_SCHEDULING_OUTCOMES),
    ),
    taskScheduleCounts: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    writeBytes: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    writeCounts: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    writeMaxBytes: createCounterRecord(TERMINAL_STARTUP_PAINT_ROLES),
    writeSizeBucketCounts: createPerStartupRoleRecord(() =>
      createCounterRecord(TERMINAL_STARTUP_WRITE_SIZE_BUCKETS),
    ),
  };
}

function createInitialTerminalRecoveryDiagnostics(): RendererRuntimeDiagnosticsSnapshot['terminalRecovery'] {
  return {
    blockingUiTransitions: 0,
    geometryAlignmentFallbacks: 0,
    kindCounts: createCounterRecord(TERMINAL_RECOVERY_KINDS),
    renderRefreshes: 0,
    requestCounts: createCounterRecord(TERMINAL_RECOVERY_REASONS),
    requestStateBytes: createCounterRecord(TERMINAL_RECOVERY_REASONS),
    resetCounts: createCounterRecord(TERMINAL_RECOVERY_RESET_REASONS),
    stableRevealWaits: 0,
    startupFirstPaintDeferredCounts: createCounterRecord(
      TERMINAL_RECOVERY_STARTUP_DEFER_PRIORITIES,
    ),
    startupFirstPaintDeferredWaitMs: 0,
    visibleSteadyStateSnapshotCounts: createCounterRecord(TERMINAL_RECOVERY_REASONS),
    writeBytes: createCounterRecord(TERMINAL_RECOVERY_REASONS),
    writeChunks: createCounterRecord(TERMINAL_RECOVERY_REASONS),
  };
}

function createInitialTerminalResizeDiagnostics(): RendererRuntimeDiagnosticsSnapshot['terminalResize'] {
  return {
    commitAttempts: 0,
    commitDeferredCounts: createCounterRecord(TERMINAL_RESIZE_DEFER_REASONS),
    commitNoopSkips: 0,
    commitSuccesses: 0,
    flushCalls: 0,
    pendingCurrent: 0,
    pendingCurrentMax: 0,
    pendingMaxAgeMs: 0,
    pendingOldestAgeMs: null,
    pendingReasonCounts: createCounterRecord(TERMINAL_RESIZE_PENDING_REASONS),
    queuedUpdates: 0,
    trailingReschedules: 0,
  };
}

function createInitialTerminalRendererDiagnostics(): RendererRuntimeDiagnosticsSnapshot['terminalRenderer'] {
  return {
    acquireAttempts: 0,
    acquireHits: 0,
    acquireMisses: 0,
    activeContextsCurrent: 0,
    activeContextsMax: 0,
    explicitReleases: 0,
    fallbackActivations: 0,
    fallbackRecoveries: 0,
    rendererSwapCounts: {
      attach: 0,
      restore: 0,
      'selected-switch': 0,
    },
    visibleContextsCurrent: 0,
    visibleContextsMax: 0,
    webglEvictions: 0,
  };
}

function createInitialAgentOutputAnalysisDiagnostics(): RendererRuntimeDiagnosticsSnapshot['agentOutputAnalysis'] {
  return {
    activeAgents: 0,
    analysisCalls: 0,
    analysisSchedules: 0,
    backgroundChecks: 0,
    backgroundSkips: 0,
    deferredAnalyses: 0,
    immediateAnalyses: 0,
    lastAnalysisDurationMs: null,
    maxAnalysisDurationMs: 0,
    pendingTimers: 0,
    totalAnalysisDurationMs: 0,
  };
}

function createInitialBootstrapDiagnostics(): RendererRuntimeDiagnosticsSnapshot['bootstrap'] {
  return {
    bufferedEvents: createCategoryCounters(),
    bufferedSnapshots: createCategoryCounters(),
    completions: 0,
    lastDurationMs: null,
  };
}

function createInitialBrowserSyncDiagnostics(): RendererRuntimeDiagnosticsSnapshot['browserSync'] {
  return {
    completed: 0,
    failed: 0,
    lastDurationMs: null,
    scheduled: 0,
    started: 0,
    superseded: 0,
  };
}

function createInitialBrowserStartupDiagnostics(): RendererRuntimeDiagnosticsSnapshot['browserStartup'] {
  return {
    currentMode: null,
    currentTier: 'idle',
    modeCompleteCounts: {
      'cold-bootstrap': 0,
      'reconnect-restore': 0,
    },
    modeCancelCounts: {
      'cold-bootstrap': 0,
      'reconnect-restore': 0,
    },
    modeCancelReasonCounts: {
      'cold-bootstrap': createCounterRecord(BROWSER_STARTUP_CANCEL_REASONS),
      'reconnect-restore': createCounterRecord(BROWSER_STARTUP_CANCEL_REASONS),
    },
    modeLastCanceledMs: {
      'cold-bootstrap': null,
      'reconnect-restore': null,
    },
    modeLastDurationMs: {
      'cold-bootstrap': null,
      'reconnect-restore': null,
    },
    modeStartCounts: {
      'cold-bootstrap': 0,
      'reconnect-restore': 0,
    },
    tierLastReachedMs: {
      background: null,
      idle: null,
      'selected-task': null,
      'selected-terminal': null,
      shell: null,
      summary: null,
    },
    tierCounts: {
      background: 0,
      idle: 0,
      'selected-task': 0,
      'selected-terminal': 0,
      shell: 0,
      summary: 0,
    },
  };
}

function createInitialBrowserReconnectDiagnostics(): RendererRuntimeDiagnosticsSnapshot['browserReconnect'] {
  return {
    disconnectCounts: {
      'auth-expired': 0,
      close: 0,
      'connect-close': 0,
      'connect-error': 0,
      manual: 0,
      'missed-pong': 0,
      'send-error': 0,
    },
    fullRestoreDeferredMs: 0,
    lastDisconnectedDurationMs: null,
    lastReconnectDelayMs: null,
    lastRestoreDurationMs: null,
    maxReconnectDelayMs: 0,
    maxRestoreDurationMs: 0,
    pongCount: 0,
    reconnectSchedules: 0,
    replayGaps: 0,
    restoreOutcomeCounts: createCounterRecord(BROWSER_RECONNECT_RESTORE_OUTCOMES),
    rttLastMs: null,
    rttMaxMs: 0,
  };
}

function createInitialTerminalFitDiagnostics(): RendererRuntimeDiagnosticsSnapshot['terminalFit'] {
  return {
    dirtyMarks: 0,
    dirtyReasonCounts: createCounterRecord(TERMINAL_FIT_DIRTY_REASONS),
    executionCounts: createCounterRecord(TERMINAL_FIT_EXECUTION_SOURCES),
    flushCalls: 0,
    idleFlushCalls: 0,
    geometryChangeFits: 0,
    noopSkips: 0,
    scheduleCalls: 0,
    scheduleReasonCounts: createCounterRecord(TERMINAL_FIT_SCHEDULE_REASONS),
  };
}

function createInitialSnapshot(): RendererRuntimeDiagnosticsSnapshot {
  return {
    agentOutputAnalysis: createInitialAgentOutputAnalysisDiagnostics(),
    bootstrap: createInitialBootstrapDiagnostics(),
    browserSync: createInitialBrowserSyncDiagnostics(),
    browserStartup: createInitialBrowserStartupDiagnostics(),
    browserReconnect: createInitialBrowserReconnectDiagnostics(),
    terminalInput: createInitialTerminalInputDiagnostics(),
    terminalOutputScheduler: createInitialTerminalOutputSchedulerDiagnostics(),
    terminalPresentation: createInitialTerminalPresentationDiagnostics(),
    terminalStartupPaint: createInitialTerminalStartupPaintDiagnostics(),
    terminalFit: createInitialTerminalFitDiagnostics(),
    terminalRecovery: createInitialTerminalRecoveryDiagnostics(),
    terminalResize: createInitialTerminalResizeDiagnostics(),
    terminalRenderer: createInitialTerminalRendererDiagnostics(),
  };
}

function cloneDiagnostics(): RendererRuntimeDiagnosticsSnapshot {
  const terminalResizePendingSummary = getTerminalResizePendingSummary();

  return {
    agentOutputAnalysis: { ...rendererRuntimeDiagnostics.agentOutputAnalysis },
    bootstrap: {
      bufferedEvents: { ...rendererRuntimeDiagnostics.bootstrap.bufferedEvents },
      bufferedSnapshots: { ...rendererRuntimeDiagnostics.bootstrap.bufferedSnapshots },
      completions: rendererRuntimeDiagnostics.bootstrap.completions,
      lastDurationMs: rendererRuntimeDiagnostics.bootstrap.lastDurationMs,
    },
    browserSync: { ...rendererRuntimeDiagnostics.browserSync },
    browserStartup: {
      currentMode: rendererRuntimeDiagnostics.browserStartup.currentMode,
      currentTier: rendererRuntimeDiagnostics.browserStartup.currentTier,
      modeCancelCounts: { ...rendererRuntimeDiagnostics.browserStartup.modeCancelCounts },
      modeCancelReasonCounts: {
        'cold-bootstrap': {
          ...rendererRuntimeDiagnostics.browserStartup.modeCancelReasonCounts['cold-bootstrap'],
        },
        'reconnect-restore': {
          ...rendererRuntimeDiagnostics.browserStartup.modeCancelReasonCounts['reconnect-restore'],
        },
      },
      modeLastCanceledMs: { ...rendererRuntimeDiagnostics.browserStartup.modeLastCanceledMs },
      modeCompleteCounts: { ...rendererRuntimeDiagnostics.browserStartup.modeCompleteCounts },
      modeLastDurationMs: { ...rendererRuntimeDiagnostics.browserStartup.modeLastDurationMs },
      modeStartCounts: { ...rendererRuntimeDiagnostics.browserStartup.modeStartCounts },
      tierLastReachedMs: { ...rendererRuntimeDiagnostics.browserStartup.tierLastReachedMs },
      tierCounts: { ...rendererRuntimeDiagnostics.browserStartup.tierCounts },
    },
    browserReconnect: {
      ...rendererRuntimeDiagnostics.browserReconnect,
      disconnectCounts: { ...rendererRuntimeDiagnostics.browserReconnect.disconnectCounts },
      restoreOutcomeCounts: {
        ...rendererRuntimeDiagnostics.browserReconnect.restoreOutcomeCounts,
      },
    },
    terminalInput: { ...rendererRuntimeDiagnostics.terminalInput },
    terminalOutputScheduler: {
      ...rendererRuntimeDiagnostics.terminalOutputScheduler,
      laneSelections: { ...rendererRuntimeDiagnostics.terminalOutputScheduler.laneSelections },
    },
    terminalPresentation: {
      ...rendererRuntimeDiagnostics.terminalPresentation,
      blockedInputAttempts: {
        ...rendererRuntimeDiagnostics.terminalPresentation.blockedInputAttempts,
      },
      enteredCounts: { ...rendererRuntimeDiagnostics.terminalPresentation.enteredCounts },
    },
    terminalStartupPaint: {
      ...rendererRuntimeDiagnostics.terminalStartupPaint,
      fitExecutionCounts: { ...rendererRuntimeDiagnostics.terminalStartupPaint.fitExecutionCounts },
      fitExecutionSourceCounts: clonePerStartupRoleRecord(
        rendererRuntimeDiagnostics.terminalStartupPaint.fitExecutionSourceCounts,
        (record) => ({ ...record }),
      ),
      fitGeometryChangeCounts: {
        ...rendererRuntimeDiagnostics.terminalStartupPaint.fitGeometryChangeCounts,
      },
      fitScheduleCounts: { ...rendererRuntimeDiagnostics.terminalStartupPaint.fitScheduleCounts },
      fitScheduleReasonCounts: clonePerStartupRoleRecord(
        rendererRuntimeDiagnostics.terminalStartupPaint.fitScheduleReasonCounts,
        (record) => ({ ...record }),
      ),
      logicalReadyCounts: { ...rendererRuntimeDiagnostics.terminalStartupPaint.logicalReadyCounts },
      logicalReadyLastMs: { ...rendererRuntimeDiagnostics.terminalStartupPaint.logicalReadyLastMs },
      logicalReadyMaxMs: { ...rendererRuntimeDiagnostics.terminalStartupPaint.logicalReadyMaxMs },
      logicalReadyTotalMs: {
        ...rendererRuntimeDiagnostics.terminalStartupPaint.logicalReadyTotalMs,
      },
      logicalToPaintReadyDelayLastMs: {
        ...rendererRuntimeDiagnostics.terminalStartupPaint.logicalToPaintReadyDelayLastMs,
      },
      logicalToPaintReadyDelayMaxMs: {
        ...rendererRuntimeDiagnostics.terminalStartupPaint.logicalToPaintReadyDelayMaxMs,
      },
      logicalToPaintReadyDelayTotalMs: {
        ...rendererRuntimeDiagnostics.terminalStartupPaint.logicalToPaintReadyDelayTotalMs,
      },
      paintReadyCounts: { ...rendererRuntimeDiagnostics.terminalStartupPaint.paintReadyCounts },
      paintReadyLastMs: { ...rendererRuntimeDiagnostics.terminalStartupPaint.paintReadyLastMs },
      paintReadyMaxMs: { ...rendererRuntimeDiagnostics.terminalStartupPaint.paintReadyMaxMs },
      paintReadyTotalMs: { ...rendererRuntimeDiagnostics.terminalStartupPaint.paintReadyTotalMs },
      renderEventCounts: { ...rendererRuntimeDiagnostics.terminalStartupPaint.renderEventCounts },
      taskContinuationDelayLastMs: {
        ...rendererRuntimeDiagnostics.terminalStartupPaint.taskContinuationDelayLastMs,
      },
      taskContinuationDelayMaxMs: {
        ...rendererRuntimeDiagnostics.terminalStartupPaint.taskContinuationDelayMaxMs,
      },
      taskContinuationDelayTotalMs: {
        ...rendererRuntimeDiagnostics.terminalStartupPaint.taskContinuationDelayTotalMs,
      },
      taskOutcomeCounts: clonePerStartupRoleRecord(
        rendererRuntimeDiagnostics.terminalStartupPaint.taskOutcomeCounts,
        (record) => ({ ...record }),
      ),
      taskScheduleCounts: { ...rendererRuntimeDiagnostics.terminalStartupPaint.taskScheduleCounts },
      writeBytes: { ...rendererRuntimeDiagnostics.terminalStartupPaint.writeBytes },
      writeCounts: { ...rendererRuntimeDiagnostics.terminalStartupPaint.writeCounts },
      writeMaxBytes: { ...rendererRuntimeDiagnostics.terminalStartupPaint.writeMaxBytes },
      writeSizeBucketCounts: clonePerStartupRoleRecord(
        rendererRuntimeDiagnostics.terminalStartupPaint.writeSizeBucketCounts,
        (record) => ({ ...record }),
      ),
    },
    terminalFit: {
      ...rendererRuntimeDiagnostics.terminalFit,
      dirtyReasonCounts: { ...rendererRuntimeDiagnostics.terminalFit.dirtyReasonCounts },
      executionCounts: { ...rendererRuntimeDiagnostics.terminalFit.executionCounts },
      scheduleReasonCounts: { ...rendererRuntimeDiagnostics.terminalFit.scheduleReasonCounts },
    },
    terminalRecovery: {
      ...rendererRuntimeDiagnostics.terminalRecovery,
      kindCounts: { ...rendererRuntimeDiagnostics.terminalRecovery.kindCounts },
      requestCounts: { ...rendererRuntimeDiagnostics.terminalRecovery.requestCounts },
      requestStateBytes: { ...rendererRuntimeDiagnostics.terminalRecovery.requestStateBytes },
      resetCounts: { ...rendererRuntimeDiagnostics.terminalRecovery.resetCounts },
      startupFirstPaintDeferredCounts: {
        ...rendererRuntimeDiagnostics.terminalRecovery.startupFirstPaintDeferredCounts,
      },
      visibleSteadyStateSnapshotCounts: {
        ...rendererRuntimeDiagnostics.terminalRecovery.visibleSteadyStateSnapshotCounts,
      },
      writeBytes: { ...rendererRuntimeDiagnostics.terminalRecovery.writeBytes },
      writeChunks: { ...rendererRuntimeDiagnostics.terminalRecovery.writeChunks },
    },
    terminalResize: {
      ...rendererRuntimeDiagnostics.terminalResize,
      commitDeferredCounts: { ...rendererRuntimeDiagnostics.terminalResize.commitDeferredCounts },
      pendingCurrent: terminalResizePendingSummary.current,
      pendingCurrentMax: Math.max(
        rendererRuntimeDiagnostics.terminalResize.pendingCurrentMax,
        terminalResizePendingSummary.current,
      ),
      pendingMaxAgeMs: Math.max(
        rendererRuntimeDiagnostics.terminalResize.pendingMaxAgeMs,
        terminalResizePendingSummary.oldestAgeMs ?? 0,
      ),
      pendingOldestAgeMs: terminalResizePendingSummary.oldestAgeMs,
      pendingReasonCounts: terminalResizePendingSummary.reasonCounts,
    },
    terminalRenderer: {
      ...rendererRuntimeDiagnostics.terminalRenderer,
      rendererSwapCounts: { ...rendererRuntimeDiagnostics.terminalRenderer.rendererSwapCounts },
    },
  };
}

function incrementCategoryCounter(
  counters: CategoryCounters,
  category: ServerStateBootstrapCategory,
): void {
  counters[category] = (counters[category] ?? 0) + 1;
}

// Degraded bootstrap categories: per-category server-side failures surfaced by
// degraded markers. The client keeps prior state for these categories and the
// bootstrap owners retry them targetedly.
const degradedBootstrapCategories = new Set<ServerStateBootstrapCategory>();

export function recordDegradedBootstrapCategory(category: ServerStateBootstrapCategory): void {
  degradedBootstrapCategories.add(category);
}

export function clearDegradedBootstrapCategory(category: ServerStateBootstrapCategory): void {
  degradedBootstrapCategories.delete(category);
}

export function getDegradedBootstrapCategories(): ServerStateBootstrapCategory[] {
  return [...degradedBootstrapCategories];
}

export function resetRendererRuntimeDiagnostics(): void {
  rendererRuntimeDiagnostics = createInitialSnapshot();
  terminalResizePendingEntries.clear();
  degradedBootstrapCategories.clear();
  attachRendererRuntimeDiagnosticsStore();
}

export function getRendererRuntimeDiagnosticsSnapshot(): RendererRuntimeDiagnosticsSnapshot {
  attachRendererRuntimeDiagnosticsStore();
  return cloneDiagnostics();
}

export function getRendererRuntimeUiFluidityCountersSnapshot(): RendererRuntimeUiFluidityCountersSnapshot {
  attachRendererRuntimeDiagnosticsStore();
  return {
    agentAnalysisDurationMs: rendererRuntimeDiagnostics.agentOutputAnalysis.totalAnalysisDurationMs,
    schedulerDrainDurationMs:
      rendererRuntimeDiagnostics.terminalOutputScheduler.totalDrainDurationMs,
    schedulerScanDurationMs: rendererRuntimeDiagnostics.terminalOutputScheduler.totalScanDurationMs,
  };
}

export function recordBufferedBootstrapEvent(category: ServerStateBootstrapCategory): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    incrementCategoryCounter(snapshot.bootstrap.bufferedEvents, category);
  });
}

export function recordBufferedBootstrapSnapshot(category: ServerStateBootstrapCategory): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    incrementCategoryCounter(snapshot.bootstrap.bufferedSnapshots, category);
  });
}

export function recordBootstrapCompletion(durationMs: number): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.bootstrap.completions += 1;
    snapshot.bootstrap.lastDurationMs = durationMs;
  });
}

export function recordBrowserSyncScheduled(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserSync.scheduled += 1;
  });
}

export function recordBrowserSyncStarted(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserSync.started += 1;
  });
}

export function recordBrowserSyncCompleted(durationMs: number): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserSync.completed += 1;
    snapshot.browserSync.lastDurationMs = durationMs;
  });
}

export function recordBrowserSyncFailed(durationMs: number): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserSync.failed += 1;
    snapshot.browserSync.lastDurationMs = durationMs;
  });
}

export function recordBrowserSyncSuperseded(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserSync.superseded += 1;
  });
}

export function recordBrowserStartupModeStarted(
  mode: 'cold-bootstrap' | 'reconnect-restore',
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserStartup.currentMode = mode;
    snapshot.browserStartup.modeStartCounts[mode] += 1;
  });
}

export function recordBrowserStartupModeCompleted(
  mode: 'cold-bootstrap' | 'reconnect-restore',
  durationMs: number,
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserStartup.currentMode = null;
    snapshot.browserStartup.modeCompleteCounts[mode] += 1;
    snapshot.browserStartup.modeLastDurationMs[mode] = durationMs;
  });
}

export function recordBrowserStartupModeCanceled(
  mode: 'cold-bootstrap' | 'reconnect-restore',
  reason: BrowserStartupCancelReason,
  durationMs: number,
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserStartup.currentMode = null;
    snapshot.browserStartup.modeCancelCounts[mode] += 1;
    snapshot.browserStartup.modeCancelReasonCounts[mode][reason] += 1;
    snapshot.browserStartup.modeLastCanceledMs[mode] = durationMs;
  });
}

export function recordBrowserStartupTierReached(
  tier: 'idle' | 'shell' | 'summary' | 'selected-task' | 'selected-terminal' | 'background',
  elapsedMs: number | null = null,
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserStartup.currentTier = tier;
    snapshot.browserStartup.tierCounts[tier] += 1;
    snapshot.browserStartup.tierLastReachedMs[tier] = elapsedMs;
  });
}

export function recordBrowserReconnectDisconnect(
  reason: keyof RendererRuntimeDiagnosticsSnapshot['browserReconnect']['disconnectCounts'],
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserReconnect.disconnectCounts[reason] += 1;
  });
}

export function recordBrowserReconnectPong(rttMs: number | null): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserReconnect.pongCount += 1;
    snapshot.browserReconnect.rttLastMs = rttMs;
    if (rttMs !== null && rttMs > snapshot.browserReconnect.rttMaxMs) {
      snapshot.browserReconnect.rttMaxMs = rttMs;
    }
  });
}

export function recordBrowserReconnectScheduled(delayMs: number): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserReconnect.reconnectSchedules += 1;
    snapshot.browserReconnect.lastReconnectDelayMs = delayMs;
    if (delayMs > snapshot.browserReconnect.maxReconnectDelayMs) {
      snapshot.browserReconnect.maxReconnectDelayMs = delayMs;
    }
  });
}

export function recordBrowserReconnectSequenceGap(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserReconnect.replayGaps += 1;
  });
}

export function recordBrowserReconnectDisconnectedDuration(durationMs: number | null): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserReconnect.lastDisconnectedDurationMs = durationMs;
  });
}

export function recordBrowserReconnectRestoreOutcome(
  outcome: BrowserReconnectRestoreOutcome,
  durationMs: number,
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserReconnect.restoreOutcomeCounts[outcome] += 1;
    snapshot.browserReconnect.lastRestoreDurationMs = durationMs;
    if (durationMs > snapshot.browserReconnect.maxRestoreDurationMs) {
      snapshot.browserReconnect.maxRestoreDurationMs = durationMs;
    }
  });
}

export function recordBrowserReconnectFullRestoreDeferred(durationMs: number): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.browserReconnect.fullRestoreDeferredMs += Math.max(0, durationMs);
  });
}

export function recordTerminalInputQueueState(details: {
  bufferedChars: number;
  inFlightBatches: number;
  queuedChunks: number;
}): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalInput.bufferedCharsCurrent = details.bufferedChars;
    snapshot.terminalInput.queuedChunksCurrent = details.queuedChunks;
    snapshot.terminalInput.inFlightBatchesCurrent = details.inFlightBatches;
    if (details.bufferedChars > snapshot.terminalInput.bufferedCharsMax) {
      snapshot.terminalInput.bufferedCharsMax = details.bufferedChars;
    }
    if (details.queuedChunks > snapshot.terminalInput.queuedChunksMax) {
      snapshot.terminalInput.queuedChunksMax = details.queuedChunks;
    }
    if (details.inFlightBatches > snapshot.terminalInput.inFlightBatchesMax) {
      snapshot.terminalInput.inFlightBatchesMax = details.inFlightBatches;
    }
  });
}

export function recordTerminalInputFlush(scheduled: boolean): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    if (scheduled) {
      snapshot.terminalInput.scheduledFlushes += 1;
      return;
    }

    snapshot.terminalInput.immediateFlushes += 1;
  });
}

export function recordTerminalInputRetryScheduled(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalInput.retrySchedules += 1;
  });
}

export function recordTerminalInputBatchSent(chars: number): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalInput.sentBatches += 1;
    snapshot.terminalInput.sentBatchChars += chars;
    if (chars > snapshot.terminalInput.sentBatchCharsMax) {
      snapshot.terminalInput.sentBatchCharsMax = chars;
    }
  });
}

export function recordTerminalInputDroppedSuffixBatches(count: number): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalInput.droppedSuffixBatches += count;
  });
}

export function recordTerminalLocalInputAckPulse(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalInput.localFeedbackAckPulses += 1;
  });
}

export function recordTerminalOutputSchedulerCandidateCount(currentCount: number): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalOutputScheduler.candidatesCurrent = currentCount;
    if (currentCount > snapshot.terminalOutputScheduler.candidatesMax) {
      snapshot.terminalOutputScheduler.candidatesMax = currentCount;
    }
  });
}

export function recordTerminalOutputSchedulerScan(
  scannedCandidates: number,
  durationMs: number,
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalOutputScheduler.scanCalls += 1;
    snapshot.terminalOutputScheduler.scannedCandidates += scannedCandidates;
    snapshot.terminalOutputScheduler.lastScanDurationMs = durationMs;
    snapshot.terminalOutputScheduler.totalScanDurationMs += durationMs;
    if (durationMs > snapshot.terminalOutputScheduler.maxScanDurationMs) {
      snapshot.terminalOutputScheduler.maxScanDurationMs = durationMs;
    }
  });
}

export function recordTerminalOutputSchedulerDrain(details: {
  drainedBytes: number;
  durationMs: number;
  lane: 'focused' | 'hidden' | 'visible';
  rescheduled: boolean;
}): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalOutputScheduler.drainCalls += 1;
    snapshot.terminalOutputScheduler.drainedBytes += details.drainedBytes;
    snapshot.terminalOutputScheduler.laneSelections[details.lane] += 1;
    snapshot.terminalOutputScheduler.lastDrainDurationMs = details.durationMs;
    snapshot.terminalOutputScheduler.totalDrainDurationMs += details.durationMs;
    if (details.durationMs > snapshot.terminalOutputScheduler.maxDrainDurationMs) {
      snapshot.terminalOutputScheduler.maxDrainDurationMs = details.durationMs;
    }
    if (details.rescheduled) {
      snapshot.terminalOutputScheduler.rescheduledDrains += 1;
    }
  });
}

export function recordAgentOutputAnalysisRuntime(details: {
  activeAgents: number;
  pendingTimers: number;
}): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.agentOutputAnalysis.activeAgents = details.activeAgents;
    snapshot.agentOutputAnalysis.pendingTimers = details.pendingTimers;
  });
}

export function recordAgentOutputAnalysisSchedule(immediate: boolean): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.agentOutputAnalysis.analysisSchedules += 1;
    if (immediate) {
      snapshot.agentOutputAnalysis.immediateAnalyses += 1;
      return;
    }

    snapshot.agentOutputAnalysis.deferredAnalyses += 1;
  });
}

export function recordAgentOutputAnalysisBackgroundCheck(allowed: boolean): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.agentOutputAnalysis.backgroundChecks += 1;
    if (!allowed) {
      snapshot.agentOutputAnalysis.backgroundSkips += 1;
    }
  });
}

export function recordAgentOutputAnalysis(durationMs: number): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.agentOutputAnalysis.analysisCalls += 1;
    snapshot.agentOutputAnalysis.lastAnalysisDurationMs = durationMs;
    snapshot.agentOutputAnalysis.totalAnalysisDurationMs += durationMs;
    if (durationMs > snapshot.agentOutputAnalysis.maxAnalysisDurationMs) {
      snapshot.agentOutputAnalysis.maxAnalysisDurationMs = durationMs;
    }
  });
}

export function recordTerminalPresentationTransition(mode: TerminalPresentationModeKind): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalPresentation.transitions += 1;
    snapshot.terminalPresentation.enteredCounts[mode] += 1;
  });
}

export function recordTerminalPresentationBlockedInput(mode: TerminalPresentationModeKind): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalPresentation.blockedInputAttempts[mode] += 1;
  });
}

export function recordTerminalStartupLogicalReady(
  role: TerminalStartupPaintRole,
  durationMs: number,
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    recordStartupDurationMetric({
      countRecord: snapshot.terminalStartupPaint.logicalReadyCounts,
      durationMs,
      lastRecord: snapshot.terminalStartupPaint.logicalReadyLastMs,
      maxRecord: snapshot.terminalStartupPaint.logicalReadyMaxMs,
      role,
      totalRecord: snapshot.terminalStartupPaint.logicalReadyTotalMs,
    });
  });
}

export function recordTerminalStartupPaintReady(
  role: TerminalStartupPaintRole,
  durationMs: number,
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    recordStartupDurationMetric({
      countRecord: snapshot.terminalStartupPaint.paintReadyCounts,
      durationMs,
      lastRecord: snapshot.terminalStartupPaint.paintReadyLastMs,
      maxRecord: snapshot.terminalStartupPaint.paintReadyMaxMs,
      role,
      totalRecord: snapshot.terminalStartupPaint.paintReadyTotalMs,
    });
  });
}

export function recordTerminalStartupLogicalToPaintReadyDelay(
  role: TerminalStartupPaintRole,
  durationMs: number,
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    recordStartupDurationMetric({
      durationMs,
      lastRecord: snapshot.terminalStartupPaint.logicalToPaintReadyDelayLastMs,
      maxRecord: snapshot.terminalStartupPaint.logicalToPaintReadyDelayMaxMs,
      role,
      totalRecord: snapshot.terminalStartupPaint.logicalToPaintReadyDelayTotalMs,
    });
  });
}

export function recordTerminalStartupRenderEvent(role: TerminalStartupPaintRole): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalStartupPaint.renderEventCounts[role] += 1;
  });
}

export function recordTerminalStartupTaskScheduling(
  role: TerminalStartupPaintRole,
  details: {
    delayMs: number;
    outcome: TerminalStartupTaskSchedulingOutcome;
  },
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalStartupPaint.taskScheduleCounts[role] += 1;
    snapshot.terminalStartupPaint.taskOutcomeCounts[role][details.outcome] += 1;
    recordStartupDurationMetric({
      durationMs: details.delayMs,
      lastRecord: snapshot.terminalStartupPaint.taskContinuationDelayLastMs,
      maxRecord: snapshot.terminalStartupPaint.taskContinuationDelayMaxMs,
      role,
      totalRecord: snapshot.terminalStartupPaint.taskContinuationDelayTotalMs,
    });
  });
}

export function recordTerminalStartupWrite(
  role: TerminalStartupPaintRole,
  byteLength: number,
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalStartupPaint.writeCounts[role] += 1;
    snapshot.terminalStartupPaint.writeBytes[role] += byteLength;
    if (byteLength > snapshot.terminalStartupPaint.writeMaxBytes[role]) {
      snapshot.terminalStartupPaint.writeMaxBytes[role] = byteLength;
    }
    let bucket: TerminalStartupWriteSizeBucket;
    if (byteLength < 4 * 1024) {
      bucket = 'lt-4k';
    } else if (byteLength < 32 * 1024) {
      bucket = 'k4-to-32k';
    } else if (byteLength < 128 * 1024) {
      bucket = 'k32-to-128k';
    } else {
      bucket = 'gte-128k';
    }
    snapshot.terminalStartupPaint.writeSizeBucketCounts[role][bucket] += 1;
  });
}

export function recordTerminalStartupFitExecution(
  role: TerminalStartupPaintRole,
  details: {
    geometryChanged: boolean;
    source: TerminalFitExecutionSource;
  },
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalStartupPaint.fitExecutionCounts[role] += 1;
    snapshot.terminalStartupPaint.fitExecutionSourceCounts[role][details.source] += 1;
    if (details.geometryChanged) {
      snapshot.terminalStartupPaint.fitGeometryChangeCounts[role] += 1;
    }
  });
}

export function recordTerminalStartupFitSchedule(
  role: TerminalStartupPaintRole,
  reason: TerminalFitScheduleReason,
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalStartupPaint.fitScheduleCounts[role] += 1;
    snapshot.terminalStartupPaint.fitScheduleReasonCounts[role][reason] += 1;
  });
}

export function recordTerminalFitDirtyMark(reason: TerminalFitDirtyReason): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalFit.dirtyMarks += 1;
    snapshot.terminalFit.dirtyReasonCounts[reason] += 1;
  });
}

export function recordTerminalFitExecution(details: {
  geometryChanged: boolean;
  source: TerminalFitExecutionSource;
}): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalFit.executionCounts[details.source] += 1;
    if (details.geometryChanged) {
      snapshot.terminalFit.geometryChangeFits += 1;
    }
  });
}

export function recordTerminalFitFlush(didWork: boolean): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalFit.flushCalls += 1;
    if (!didWork) {
      snapshot.terminalFit.idleFlushCalls += 1;
    }
  });
}

export function recordTerminalFitNoopSkip(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalFit.noopSkips += 1;
  });
}

export function recordTerminalFitSchedule(reason: TerminalFitScheduleReason): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalFit.scheduleCalls += 1;
    snapshot.terminalFit.scheduleReasonCounts[reason] += 1;
  });
}

export function recordTerminalRecoveryRequest(
  reason: TerminalRecoveryReason,
  requestStateBytes: number,
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalRecovery.requestCounts[reason] += 1;
    snapshot.terminalRecovery.requestStateBytes[reason] += requestStateBytes;
  });
}

export function recordTerminalRecoveryApply(details: {
  blockingUi: boolean;
  kind: TerminalRecoveryKind;
  reason: TerminalRecoveryReason;
  writeBytes: number;
  writeChunks: number;
}): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalRecovery.kindCounts[details.kind] += 1;
    snapshot.terminalRecovery.writeBytes[details.reason] += details.writeBytes;
    snapshot.terminalRecovery.writeChunks[details.reason] += details.writeChunks;
    if (details.blockingUi) {
      snapshot.terminalRecovery.blockingUiTransitions += 1;
    }
  });
}

export function recordTerminalRecoveryGeometryAlignmentFallback(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalRecovery.geometryAlignmentFallbacks += 1;
  });
}

export function recordTerminalRecoveryReset(reason: TerminalRecoveryResetReason): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalRecovery.resetCounts[reason] += 1;
  });
}

export function recordTerminalRecoveryRenderRefresh(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalRecovery.renderRefreshes += 1;
  });
}

export function recordTerminalRecoveryStableRevealWait(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalRecovery.stableRevealWaits += 1;
  });
}

export function recordTerminalRecoveryStartupFirstPaintDeferral(details: {
  priority: (typeof TERMINAL_RECOVERY_STARTUP_DEFER_PRIORITIES)[number];
  waitMs: number;
}): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalRecovery.startupFirstPaintDeferredCounts[details.priority] += 1;
    snapshot.terminalRecovery.startupFirstPaintDeferredWaitMs += details.waitMs;
  });
}

export function recordTerminalRecoveryVisibleSteadyStateSnapshot(
  reason: TerminalRecoveryReason,
): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalRecovery.visibleSteadyStateSnapshotCounts[reason] += 1;
  });
}

export function recordTerminalResizeQueued(isTrailingReschedule: boolean): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalResize.queuedUpdates += 1;
    if (isTrailingReschedule) {
      snapshot.terminalResize.trailingReschedules += 1;
    }
  });
}

export function recordTerminalResizeFlush(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalResize.flushCalls += 1;
  });
}

export function recordTerminalResizeCommitDeferred(reason: TerminalResizeDeferReason): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalResize.commitDeferredCounts[reason] += 1;
  });
}

export function recordTerminalResizeCommitAttempt(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalResize.commitAttempts += 1;
  });
}

export function recordTerminalResizeCommitSuccess(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalResize.commitSuccesses += 1;
  });
}

export function recordTerminalResizeCommitNoopSkip(): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalResize.commitNoopSkips += 1;
  });
}

export function recordTerminalResizePendingState(details: TerminalResizePendingStateDetails): void {
  if (!isRendererRuntimeDiagnosticsEnabled()) {
    syncKnownTerminalResizePendingEntryWhileDisabled(details);
    return;
  }

  attachRendererRuntimeDiagnosticsStore();
  const nowMs = getDiagnosticsNowMs();
  const completedPendingAgeMs = updateTerminalResizePendingEntries(details, nowMs);
  const terminalResize = rendererRuntimeDiagnostics.terminalResize;
  const pendingSummary = getTerminalResizePendingSummary(nowMs);
  terminalResize.pendingCurrent = pendingSummary.current;
  terminalResize.pendingCurrentMax = Math.max(
    terminalResize.pendingCurrentMax,
    pendingSummary.current,
  );
  terminalResize.pendingMaxAgeMs = Math.max(
    terminalResize.pendingMaxAgeMs,
    completedPendingAgeMs,
    pendingSummary.oldestAgeMs ?? 0,
  );
  terminalResize.pendingOldestAgeMs = pendingSummary.oldestAgeMs;
  terminalResize.pendingReasonCounts = pendingSummary.reasonCounts;
}

function syncTerminalRendererPoolSnapshot(snapshot: TerminalRendererPoolSnapshot): void {
  rendererRuntimeDiagnostics.terminalRenderer.activeContextsCurrent =
    snapshot.activeContextsCurrent;
  rendererRuntimeDiagnostics.terminalRenderer.visibleContextsCurrent =
    snapshot.visibleContextsCurrent;
  if (
    snapshot.activeContextsCurrent > rendererRuntimeDiagnostics.terminalRenderer.activeContextsMax
  ) {
    rendererRuntimeDiagnostics.terminalRenderer.activeContextsMax = snapshot.activeContextsCurrent;
  }
  if (
    snapshot.visibleContextsCurrent > rendererRuntimeDiagnostics.terminalRenderer.visibleContextsMax
  ) {
    rendererRuntimeDiagnostics.terminalRenderer.visibleContextsMax =
      snapshot.visibleContextsCurrent;
  }
}

export function recordTerminalRendererPoolSnapshot(snapshot: TerminalRendererPoolSnapshot): void {
  mutateRendererRuntimeDiagnostics(() => {
    syncTerminalRendererPoolSnapshot(snapshot);
  });
}

export function recordTerminalRendererAcquire(details: {
  hit: boolean;
  recoveredFromFallback?: boolean;
  snapshot: TerminalRendererPoolSnapshot;
}): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalRenderer.acquireAttempts += 1;
    if (details.hit) {
      snapshot.terminalRenderer.acquireHits += 1;
    } else {
      snapshot.terminalRenderer.acquireMisses += 1;
    }
    if (details.recoveredFromFallback) {
      snapshot.terminalRenderer.fallbackRecoveries += 1;
    }
    syncTerminalRendererPoolSnapshot(details.snapshot);
  });
}

export function recordTerminalRendererFallbackActivation(
  snapshot: TerminalRendererPoolSnapshot,
): void {
  mutateRendererRuntimeDiagnostics((details) => {
    details.terminalRenderer.fallbackActivations += 1;
    syncTerminalRendererPoolSnapshot(snapshot);
  });
}

export function recordTerminalRendererEviction(snapshot: TerminalRendererPoolSnapshot): void {
  mutateRendererRuntimeDiagnostics((details) => {
    details.terminalRenderer.webglEvictions += 1;
    syncTerminalRendererPoolSnapshot(snapshot);
  });
}

export function recordTerminalRendererRelease(snapshot: TerminalRendererPoolSnapshot): void {
  mutateRendererRuntimeDiagnostics((details) => {
    details.terminalRenderer.explicitReleases += 1;
    syncTerminalRendererPoolSnapshot(snapshot);
  });
}

export function recordTerminalRendererSwap(reason: TerminalRendererSwapReason): void {
  mutateRendererRuntimeDiagnostics((snapshot) => {
    snapshot.terminalRenderer.rendererSwapCounts[reason] += 1;
  });
}
