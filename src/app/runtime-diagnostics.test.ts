import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getRendererRuntimeDiagnosticsSnapshot,
  recordAgentOutputAnalysis,
  recordTerminalFitDirtyMark,
  recordTerminalFitExecution,
  recordTerminalFitFlush,
  recordTerminalFitNoopSkip,
  recordTerminalPresentationBlockedInput,
  recordTerminalPresentationTransition,
  recordTerminalFitSchedule,
  recordTerminalRecoveryApply,
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
      }),
    );
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
