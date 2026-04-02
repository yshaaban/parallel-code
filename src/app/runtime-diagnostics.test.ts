import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getRendererRuntimeDiagnosticsSnapshot,
  recordBrowserStartupModeCompleted,
  recordBrowserStartupModeStarted,
  recordBrowserStartupTierReached,
  recordAgentOutputAnalysis,
  recordTerminalFitDirtyMark,
  recordTerminalFitExecution,
  recordTerminalFitFlush,
  recordTerminalFitNoopSkip,
  recordTerminalPresentationBlockedInput,
  recordTerminalPresentationTransition,
  recordTerminalStartupFitExecution,
  recordTerminalStartupFitSchedule,
  recordTerminalStartupLogicalReady,
  recordTerminalStartupLogicalToPaintReadyDelay,
  recordTerminalStartupPaintReady,
  recordTerminalStartupRenderEvent,
  recordTerminalStartupTaskScheduling,
  recordTerminalStartupWrite,
  recordTerminalFitSchedule,
  recordTerminalRecoveryApply,
  recordTerminalRecoveryStartupFirstPaintDeferral,
  recordTerminalRecoveryRenderRefresh,
  recordTerminalRecoveryRequest,
  recordTerminalRecoveryReset,
  recordTerminalRecoveryStableRevealWait,
  recordTerminalRecoveryVisibleSteadyStateSnapshot,
  recordTerminalRendererAcquire,
  recordTerminalRendererEviction,
  recordTerminalRendererFallbackActivation,
  recordTerminalRendererPoolSnapshot,
  recordTerminalRendererRelease,
  recordTerminalRendererSwap,
  recordTerminalOutputSchedulerDrain,
  recordTerminalOutputSchedulerScan,
  recordTerminalResizeCommitAttempt,
  recordTerminalResizeCommitDeferred,
  recordTerminalResizeCommitNoopSkip,
  recordTerminalResizeCommitSuccess,
  recordTerminalResizeFlush,
  recordTerminalResizeQueued,
  resetRendererRuntimeDiagnostics,
} from './runtime-diagnostics';

describe('runtime-diagnostics', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    resetRendererRuntimeDiagnostics();
  });

  afterEach(() => {
    resetRendererRuntimeDiagnostics();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('does not record hot-path diagnostics when runtime diagnostics are disabled', () => {
    Reflect.deleteProperty(globalThis, 'window');
    const initialSnapshot = getRendererRuntimeDiagnosticsSnapshot();

    recordTerminalOutputSchedulerScan(3, 4);
    recordTerminalOutputSchedulerDrain({
      drainedBytes: 128,
      durationMs: 5,
      lane: 'visible',
      rescheduled: true,
    });
    recordAgentOutputAnalysis(7);
    recordTerminalPresentationTransition('loading');
    recordTerminalPresentationTransition('live');
    recordTerminalPresentationBlockedInput('loading');
    recordTerminalStartupLogicalReady('selected', 120);
    recordTerminalStartupPaintReady('selected', 180);
    recordTerminalStartupLogicalToPaintReadyDelay('selected', 60);
    recordTerminalStartupFitSchedule('selected', 'attach');
    recordTerminalStartupFitExecution('selected', {
      geometryChanged: true,
      source: 'session-immediate',
    });
    recordTerminalStartupRenderEvent('selected');
    recordTerminalStartupTaskScheduling('selected', {
      delayMs: 16,
      outcome: 'scheduler-post-task',
    });
    recordTerminalStartupWrite('selected', 512);
    recordTerminalFitDirtyMark('resize');
    recordTerminalFitSchedule('attach');
    recordTerminalFitExecution({
      geometryChanged: true,
      source: 'manager',
    });
    recordTerminalRecoveryRequest('attach', 128);
    recordTerminalRecoveryApply({
      blockingUi: true,
      kind: 'snapshot',
      reason: 'attach',
      writeBytes: 512,
      writeChunks: 2,
    });
    recordTerminalRecoveryReset('attach');
    recordTerminalRecoveryRenderRefresh();
    recordTerminalRecoveryStableRevealWait();
    recordTerminalRecoveryStartupFirstPaintDeferral({
      priority: 'active-visible',
      waitMs: 45,
    });
    recordTerminalRecoveryStartupFirstPaintDeferral({
      priority: 'hidden',
      waitMs: 30,
    });
    recordTerminalRecoveryVisibleSteadyStateSnapshot('backpressure');
    recordTerminalResizeQueued(false);
    recordTerminalResizeQueued(true);
    recordTerminalResizeFlush();
    recordTerminalResizeCommitDeferred('restore-blocked');
    recordTerminalResizeCommitAttempt();
    recordTerminalResizeCommitNoopSkip();
    recordTerminalResizeCommitSuccess();
    recordTerminalFitFlush(false);
    recordTerminalFitNoopSkip();
    recordTerminalRendererPoolSnapshot({
      activeContextsCurrent: 1,
      visibleContextsCurrent: 1,
    });
    recordTerminalRendererAcquire({
      hit: true,
      snapshot: {
        activeContextsCurrent: 1,
        visibleContextsCurrent: 1,
      },
    });
    recordTerminalRendererFallbackActivation({
      activeContextsCurrent: 0,
      visibleContextsCurrent: 0,
    });
    recordTerminalRendererEviction({
      activeContextsCurrent: 0,
      visibleContextsCurrent: 0,
    });
    recordTerminalRendererRelease({
      activeContextsCurrent: 0,
      visibleContextsCurrent: 0,
    });
    recordTerminalRendererSwap('attach');

    expect(getRendererRuntimeDiagnosticsSnapshot()).toEqual(initialSnapshot);
  });

  it('records hot-path diagnostics when runtime diagnostics are enabled', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });

    recordTerminalOutputSchedulerScan(3, 4);
    recordTerminalOutputSchedulerDrain({
      drainedBytes: 128,
      durationMs: 5,
      lane: 'visible',
      rescheduled: true,
    });
    recordAgentOutputAnalysis(7);
    recordTerminalPresentationTransition('loading');
    recordTerminalPresentationTransition('live');
    recordTerminalPresentationBlockedInput('loading');
    recordTerminalStartupLogicalReady('selected', 120);
    recordTerminalStartupPaintReady('selected', 180);
    recordTerminalStartupLogicalToPaintReadyDelay('selected', 60);
    recordTerminalStartupFitSchedule('selected', 'attach');
    recordTerminalStartupFitExecution('selected', {
      geometryChanged: true,
      source: 'session-immediate',
    });
    recordTerminalStartupRenderEvent('selected');
    recordTerminalStartupTaskScheduling('selected', {
      delayMs: 16,
      outcome: 'scheduler-post-task',
    });
    recordTerminalStartupWrite('selected', 512);
    recordTerminalFitDirtyMark('resize');
    recordTerminalFitSchedule('attach');
    recordTerminalFitExecution({
      geometryChanged: true,
      source: 'session-immediate',
    });
    recordTerminalRecoveryRequest('attach', 128);
    recordTerminalRecoveryApply({
      blockingUi: true,
      kind: 'snapshot',
      reason: 'attach',
      writeBytes: 512,
      writeChunks: 2,
    });
    recordTerminalRecoveryReset('attach');
    recordTerminalRecoveryRenderRefresh();
    recordTerminalRecoveryStableRevealWait();
    recordTerminalRecoveryStartupFirstPaintDeferral({
      priority: 'active-visible',
      waitMs: 45,
    });
    recordTerminalRecoveryStartupFirstPaintDeferral({
      priority: 'hidden',
      waitMs: 30,
    });
    recordTerminalRecoveryVisibleSteadyStateSnapshot('backpressure');
    recordTerminalResizeQueued(false);
    recordTerminalResizeQueued(true);
    recordTerminalResizeFlush();
    recordTerminalResizeCommitDeferred('restore-blocked');
    recordTerminalResizeCommitAttempt();
    recordTerminalResizeCommitNoopSkip();
    recordTerminalResizeCommitSuccess();
    recordTerminalFitFlush(true);
    recordTerminalFitNoopSkip();
    recordTerminalRendererPoolSnapshot({
      activeContextsCurrent: 1,
      visibleContextsCurrent: 1,
    });
    recordTerminalRendererAcquire({
      hit: true,
      recoveredFromFallback: true,
      snapshot: {
        activeContextsCurrent: 1,
        visibleContextsCurrent: 1,
      },
    });
    recordTerminalRendererFallbackActivation({
      activeContextsCurrent: 0,
      visibleContextsCurrent: 0,
    });
    recordTerminalRendererEviction({
      activeContextsCurrent: 0,
      visibleContextsCurrent: 0,
    });
    recordTerminalRendererRelease({
      activeContextsCurrent: 0,
      visibleContextsCurrent: 0,
    });
    recordTerminalRendererSwap('attach');
    recordBrowserStartupModeStarted('cold-bootstrap');
    recordBrowserStartupTierReached('summary', 12);
    recordBrowserStartupModeCompleted('cold-bootstrap', 24);

    expect(getRendererRuntimeDiagnosticsSnapshot().terminalOutputScheduler).toEqual(
      expect.objectContaining({
        drainCalls: 1,
        drainedBytes: 128,
        scanCalls: 1,
        scannedCandidates: 3,
      }),
    );
    expect(getRendererRuntimeDiagnosticsSnapshot().agentOutputAnalysis).toEqual(
      expect.objectContaining({
        analysisCalls: 1,
        totalAnalysisDurationMs: 7,
      }),
    );
    expect(getRendererRuntimeDiagnosticsSnapshot().browserStartup).toEqual(
      expect.objectContaining({
        currentMode: null,
        currentTier: 'summary',
        modeCompleteCounts: expect.objectContaining({
          'cold-bootstrap': 1,
        }),
        modeLastDurationMs: expect.objectContaining({
          'cold-bootstrap': 24,
        }),
        modeStartCounts: expect.objectContaining({
          'cold-bootstrap': 1,
        }),
        tierLastReachedMs: expect.objectContaining({
          summary: 12,
        }),
        tierCounts: expect.objectContaining({
          summary: 1,
        }),
      }),
    );
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalPresentation).toEqual(
      expect.objectContaining({
        transitions: 2,
      }),
    );
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalPresentation.enteredCounts.loading).toBe(
      1,
    );
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalPresentation.enteredCounts.live).toBe(1);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalPresentation.blockedInputAttempts.loading,
    ).toBe(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalStartupPaint).toEqual(
      expect.objectContaining({
        logicalReadyCounts: expect.objectContaining({
          selected: 1,
        }),
        fitExecutionCounts: expect.objectContaining({
          selected: 1,
        }),
        fitGeometryChangeCounts: expect.objectContaining({
          selected: 1,
        }),
        fitScheduleCounts: expect.objectContaining({
          selected: 1,
        }),
        paintReadyCounts: expect.objectContaining({
          selected: 1,
        }),
        renderEventCounts: expect.objectContaining({
          selected: 1,
        }),
        taskContinuationDelayLastMs: expect.objectContaining({
          selected: 16,
        }),
        taskScheduleCounts: expect.objectContaining({
          selected: 1,
        }),
        writeBytes: expect.objectContaining({
          selected: 512,
        }),
        writeCounts: expect.objectContaining({
          selected: 1,
        }),
        writeMaxBytes: expect.objectContaining({
          selected: 512,
        }),
      }),
    );
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalStartupPaint.writeSizeBucketCounts.selected[
        'lt-4k'
      ],
    ).toBe(1);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalStartupPaint.fitExecutionSourceCounts
        .selected['session-immediate'],
    ).toBe(1);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalStartupPaint.fitScheduleReasonCounts.selected
        .attach,
    ).toBe(1);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalStartupPaint.logicalReadyLastMs.selected,
    ).toBe(120);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalStartupPaint.paintReadyLastMs.selected,
    ).toBe(180);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalStartupPaint.logicalToPaintReadyDelayLastMs
        .selected,
    ).toBe(60);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalStartupPaint.taskOutcomeCounts.selected[
        'scheduler-post-task'
      ],
    ).toBe(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalFit).toEqual(
      expect.objectContaining({
        dirtyMarks: 1,
        flushCalls: 1,
        geometryChangeFits: 1,
        noopSkips: 1,
        scheduleCalls: 1,
      }),
    );
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalFit.dirtyReasonCounts.resize).toBe(1);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalFit.executionCounts['session-immediate'],
    ).toBe(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalFit.scheduleReasonCounts.attach).toBe(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalRecovery).toEqual(
      expect.objectContaining({
        blockingUiTransitions: 1,
        renderRefreshes: 1,
        stableRevealWaits: 1,
        startupFirstPaintDeferredWaitMs: 75,
      }),
    );
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalRecovery.startupFirstPaintDeferredCounts[
        'active-visible'
      ],
    ).toBe(1);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalRecovery.startupFirstPaintDeferredCounts
        .hidden,
    ).toBe(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalRecovery.requestCounts.attach).toBe(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalRecovery.requestStateBytes.attach).toBe(
      128,
    );
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalRecovery.kindCounts.snapshot).toBe(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalRecovery.resetCounts.attach).toBe(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalRecovery.writeBytes.attach).toBe(512);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalRecovery.writeChunks.attach).toBe(2);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalRecovery.visibleSteadyStateSnapshotCounts
        .backpressure,
    ).toBe(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalResize).toEqual(
      expect.objectContaining({
        commitAttempts: 1,
        commitNoopSkips: 1,
        commitSuccesses: 1,
        flushCalls: 1,
        queuedUpdates: 2,
        trailingReschedules: 1,
      }),
    );
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalResize.commitDeferredCounts[
        'restore-blocked'
      ],
    ).toBe(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalRenderer).toEqual(
      expect.objectContaining({
        acquireAttempts: 1,
        acquireHits: 1,
        activeContextsCurrent: 0,
        activeContextsMax: 1,
        explicitReleases: 1,
        fallbackActivations: 1,
        fallbackRecoveries: 1,
        visibleContextsCurrent: 0,
        visibleContextsMax: 1,
        webglEvictions: 1,
      }),
    );
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalRenderer.rendererSwapCounts.attach).toBe(
      1,
    );
  });
});
