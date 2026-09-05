import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRendererRuntimeDiagnosticsSnapshot,
  recordBrowserStartupModeCanceled,
  recordBrowserStartupModeCompleted,
  recordBrowserStartupModeStarted,
  recordBrowserStartupTierReached,
  recordAgentOutputAnalysis,
  recordLocalQuestionStaleGenerationDrop,
  recordLocalQuestionTransition,
  recordPromptDispatchBlocked,
  recordPromptDraftPreservedAfterSend,
  recordPromptQuestionAgreementObservation,
  recordTerminalFitDirtyMark,
  recordTerminalFitExecution,
  recordTerminalFitFlush,
  recordTerminalFitNoopSkip,
  recordTerminalLocalInputAckPulse,
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
  recordTerminalRendererAtlasRepair,
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
  recordTerminalResizePendingState,
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
    vi.restoreAllMocks();
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
    recordTerminalLocalInputAckPulse();
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
    recordTerminalResizePendingState({
      agentId: 'agent-1',
      pending: true,
      pendingSinceMs: 0,
      reason: 'not-live',
    });
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
    recordTerminalRendererAtlasRepair({ reason: 'foreground', type: 'intent' });
    recordTerminalRendererAtlasRepair({ queueDepth: 1, type: 'queued' });
    recordTerminalRendererAtlasRepair({ delayMs: 12, type: 'applied' });
    recordTerminalRendererAtlasRepair({ reason: 'hidden', type: 'skipped' });
    recordTerminalRendererAtlasRepair({ type: 'failed' });
    recordBrowserStartupModeCanceled('reconnect-restore', 'transport-lost', 18);
    recordLocalQuestionTransition('enter');
    recordLocalQuestionTransition('clear');
    recordLocalQuestionStaleGenerationDrop('private-agent-id', 1);
    recordPromptDispatchBlocked('agent-question');
    recordPromptDraftPreservedAfterSend();
    recordPromptQuestionAgreementObservation({
      agentId: 'private-agent-id',
      canonicalQuestionActive: true,
      generation: 1,
      localQuestionActive: false,
    });

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
    recordTerminalLocalInputAckPulse();
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
    recordTerminalResizePendingState({
      agentId: 'agent-1',
      pending: true,
      pendingSinceMs: 0,
      reason: 'not-live',
    });
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
    recordTerminalRendererAtlasRepair({ reason: 'foreground', type: 'intent' });
    recordTerminalRendererAtlasRepair({ reason: 'manual', type: 'intent' });
    recordTerminalRendererAtlasRepair({ reason: 'newly-visible', type: 'intent' });
    recordTerminalRendererAtlasRepair({ queueDepth: 1, type: 'queued' });
    recordTerminalRendererAtlasRepair({ queueDepth: 3, type: 'queued' });
    recordTerminalRendererAtlasRepair({ delayMs: 12, type: 'applied' });
    recordTerminalRendererAtlasRepair({ delayMs: 8, type: 'applied' });
    recordTerminalRendererAtlasRepair({ reason: 'disposed', type: 'skipped' });
    recordTerminalRendererAtlasRepair({ reason: 'generation', type: 'skipped' });
    recordTerminalRendererAtlasRepair({ reason: 'hidden', type: 'skipped' });
    recordTerminalRendererAtlasRepair({ reason: 'ineligible', type: 'skipped' });
    recordTerminalRendererAtlasRepair({ type: 'failed' });
    recordBrowserStartupModeStarted('cold-bootstrap');
    recordBrowserStartupTierReached('summary', 12);
    recordBrowserStartupModeCompleted('cold-bootstrap', 24);
    recordBrowserStartupModeStarted('reconnect-restore');
    recordBrowserStartupModeCanceled('reconnect-restore', 'transport-lost', 18);

    expect(getRendererRuntimeDiagnosticsSnapshot().terminalOutputScheduler).toEqual(
      expect.objectContaining({
        drainCalls: 1,
        drainedBytes: 128,
        scanCalls: 1,
        scannedCandidates: 3,
      }),
    );
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalRenderer.atlasRepair).toEqual({
      applied: 2,
      failed: 1,
      intents: {
        foreground: 1,
        manual: 1,
        'newly-visible': 1,
      },
      maxQueueDepth: 3,
      queued: 2,
      skipped: {
        disposed: 1,
        generation: 1,
        hidden: 1,
        ineligible: 1,
      },
      totalDelayMs: 20,
    });
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
        modeCancelCounts: expect.objectContaining({
          'reconnect-restore': 1,
        }),
        modeCancelReasonCounts: expect.objectContaining({
          'reconnect-restore': expect.objectContaining({
            'transport-lost': 1,
          }),
        }),
        modeLastCanceledMs: expect.objectContaining({
          'reconnect-restore': 18,
        }),
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
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalInput).toEqual(
      expect.objectContaining({
        localFeedbackAckPulses: 1,
      }),
    );
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
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalResize.pendingCurrent).toBe(1);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalResize.pendingReasonCounts['not-live'],
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

  it('aggregates content-free prompt-question counters and disagreement duration', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });
    const nowSpy = vi
      .spyOn(globalThis.performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(25)
      .mockReturnValue(25);

    recordLocalQuestionTransition('enter');
    recordLocalQuestionTransition('clear');
    recordLocalQuestionStaleGenerationDrop('private-agent-id', 6);
    recordLocalQuestionStaleGenerationDrop('private-agent-id', 6);
    recordPromptDispatchBlocked('agent-question');
    recordPromptDispatchBlocked('peer-controlled');
    recordPromptDraftPreservedAfterSend();
    recordPromptQuestionAgreementObservation({
      agentId: 'private-agent-id',
      canonicalQuestionActive: true,
      generation: 7,
      localQuestionActive: false,
    });
    recordPromptQuestionAgreementObservation({
      agentId: 'private-agent-id',
      canonicalQuestionActive: true,
      generation: 7,
      localQuestionActive: true,
    });

    const diagnostics = getRendererRuntimeDiagnosticsSnapshot().promptQuestion;
    expect(diagnostics).toEqual({
      blockedDispatchAttempts: {
        'agent-question': 1,
        empty: 0,
        'peer-controlled': 1,
        'send-in-flight': 0,
      },
      canonicalLocalDisagreement: {
        activeCurrent: 0,
        completed: 1,
        lastDurationMs: 15,
        maxDurationMs: 15,
        totalDurationMs: 15,
        trackingDrops: 0,
      },
      draftPreservedAfterSend: 1,
      localClears: 1,
      localEnters: 1,
      staleGenerationDrops: 1,
      staleGenerationTrackingDrops: 0,
    });
    expect(JSON.stringify(diagnostics)).not.toContain('private-agent-id');
    nowSpy.mockRestore();
  });

  it('caps prompt-question disagreement tracking by agent generation', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });

    for (let generation = 0; generation < 129; generation += 1) {
      recordPromptQuestionAgreementObservation({
        agentId: 'private-agent-id',
        canonicalQuestionActive: true,
        generation,
        localQuestionActive: false,
      });
    }

    expect(
      getRendererRuntimeDiagnosticsSnapshot().promptQuestion.canonicalLocalDisagreement,
    ).toEqual(
      expect.objectContaining({
        activeCurrent: 128,
        trackingDrops: 1,
      }),
    );
  });

  it('tracks terminal resize pending age and clears it when the resize settles', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });
    const nowMs =
      typeof performance === 'undefined' || typeof performance.now !== 'function'
        ? Date.now()
        : performance.now();

    recordTerminalResizePendingState({
      agentId: 'agent-1',
      pending: true,
      pendingSinceMs: nowMs - 75,
      reason: 'scheduled',
    });

    const pendingSnapshot = getRendererRuntimeDiagnosticsSnapshot().terminalResize;
    expect(pendingSnapshot.pendingCurrent).toBe(1);
    expect(pendingSnapshot.pendingCurrentMax).toBe(1);
    expect(pendingSnapshot.pendingOldestAgeMs).toBeGreaterThanOrEqual(75);
    expect(pendingSnapshot.pendingMaxAgeMs).toBeGreaterThanOrEqual(75);
    expect(pendingSnapshot.pendingReasonCounts.scheduled).toBe(1);

    recordTerminalResizePendingState({ agentId: 'agent-1', pending: false });

    const clearedSnapshot = getRendererRuntimeDiagnosticsSnapshot().terminalResize;
    expect(clearedSnapshot.pendingCurrent).toBe(0);
    expect(clearedSnapshot.pendingCurrentMax).toBe(1);
    expect(clearedSnapshot.pendingOldestAgeMs).toBeNull();
    expect(clearedSnapshot.pendingMaxAgeMs).toBeGreaterThanOrEqual(75);
    expect(clearedSnapshot.pendingReasonCounts.scheduled).toBe(0);
  });

  it('clears terminal resize pending state when diagnostics are disabled before settlement', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });

    recordTerminalResizePendingState({
      agentId: 'agent-1',
      pending: true,
      pendingSinceMs: 0,
      reason: 'sending',
    });
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalResize.pendingCurrent).toBe(1);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    recordTerminalResizePendingState({ agentId: 'agent-1', pending: false });

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalResize.pendingCurrent).toBe(0);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalResize.pendingReasonCounts.sending).toBe(
      0,
    );
  });
});
