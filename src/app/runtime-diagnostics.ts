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
const TERMINAL_RECOVERY_KINDS = ['delta', 'noop', 'snapshot'] as const;
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
const TERMINAL_PRESENTATION_MODE_KINDS = [
  'error',
  'live',
  'loading',
] as const satisfies readonly TerminalPresentationModeKind[];

export type TerminalFitDirtyReason = (typeof TERMINAL_FIT_DIRTY_REASONS)[number];
export type TerminalFitExecutionSource = (typeof TERMINAL_FIT_EXECUTION_SOURCES)[number];
export type TerminalFitScheduleReason = (typeof TERMINAL_FIT_SCHEDULE_REASONS)[number];
export type TerminalRecoveryReason = (typeof TERMINAL_RECOVERY_REASONS)[number];
export type TerminalRecoveryKind = (typeof TERMINAL_RECOVERY_KINDS)[number];
export type TerminalRecoveryResetReason = (typeof TERMINAL_RECOVERY_RESET_REASONS)[number];
export type TerminalRendererSwapReason = 'attach' | 'restore' | 'selected-switch';
export type TerminalResizeDeferReason = (typeof TERMINAL_RESIZE_DEFER_REASONS)[number];

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
    kindCounts: Record<TerminalRecoveryKind, number>;
    renderRefreshes: number;
    requestCounts: Record<TerminalRecoveryReason, number>;
    requestStateBytes: Record<TerminalRecoveryReason, number>;
    resetCounts: Record<TerminalRecoveryResetReason, number>;
    stableRevealWaits: number;
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

let rendererRuntimeDiagnostics: RendererRuntimeDiagnosticsSnapshot = createInitialSnapshot();

function isBrowserRendererRuntimeDiagnosticsEnabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ === true ||
      window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ === true)
  );
}

function shouldRecordRendererRuntimeDiagnostics(): boolean {
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
  if (!shouldRecordRendererRuntimeDiagnostics()) {
    return;
  }

  attachRendererRuntimeDiagnosticsStore();
  updater(rendererRuntimeDiagnostics);
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

function createInitialTerminalPresentationDiagnostics(): RendererRuntimeDiagnosticsSnapshot['terminalPresentation'] {
  return {
    blockedInputAttempts: createCounterRecord(TERMINAL_PRESENTATION_MODE_KINDS),
    enteredCounts: createCounterRecord(TERMINAL_PRESENTATION_MODE_KINDS),
    transitions: 0,
  };
}

function createInitialTerminalRecoveryDiagnostics(): RendererRuntimeDiagnosticsSnapshot['terminalRecovery'] {
  return {
    blockingUiTransitions: 0,
    kindCounts: createCounterRecord(TERMINAL_RECOVERY_KINDS),
    renderRefreshes: 0,
    requestCounts: createCounterRecord(TERMINAL_RECOVERY_REASONS),
    requestStateBytes: createCounterRecord(TERMINAL_RECOVERY_REASONS),
    resetCounts: createCounterRecord(TERMINAL_RECOVERY_RESET_REASONS),
    stableRevealWaits: 0,
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
    terminalOutputScheduler: createInitialTerminalOutputSchedulerDiagnostics(),
    terminalPresentation: createInitialTerminalPresentationDiagnostics(),
    terminalFit: createInitialTerminalFitDiagnostics(),
    terminalRecovery: createInitialTerminalRecoveryDiagnostics(),
    terminalResize: createInitialTerminalResizeDiagnostics(),
    terminalRenderer: createInitialTerminalRendererDiagnostics(),
  };
}

function cloneDiagnostics(): RendererRuntimeDiagnosticsSnapshot {
  return {
    agentOutputAnalysis: { ...rendererRuntimeDiagnostics.agentOutputAnalysis },
    bootstrap: {
      bufferedEvents: { ...rendererRuntimeDiagnostics.bootstrap.bufferedEvents },
      bufferedSnapshots: { ...rendererRuntimeDiagnostics.bootstrap.bufferedSnapshots },
      completions: rendererRuntimeDiagnostics.bootstrap.completions,
      lastDurationMs: rendererRuntimeDiagnostics.bootstrap.lastDurationMs,
    },
    browserSync: { ...rendererRuntimeDiagnostics.browserSync },
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
      visibleSteadyStateSnapshotCounts: {
        ...rendererRuntimeDiagnostics.terminalRecovery.visibleSteadyStateSnapshotCounts,
      },
      writeBytes: { ...rendererRuntimeDiagnostics.terminalRecovery.writeBytes },
      writeChunks: { ...rendererRuntimeDiagnostics.terminalRecovery.writeChunks },
    },
    terminalResize: {
      ...rendererRuntimeDiagnostics.terminalResize,
      commitDeferredCounts: { ...rendererRuntimeDiagnostics.terminalResize.commitDeferredCounts },
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

export function resetRendererRuntimeDiagnostics(): void {
  rendererRuntimeDiagnostics = createInitialSnapshot();
  attachRendererRuntimeDiagnosticsStore();
}

export function getRendererRuntimeDiagnosticsSnapshot(): RendererRuntimeDiagnosticsSnapshot {
  attachRendererRuntimeDiagnosticsStore();
  return cloneDiagnostics();
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
