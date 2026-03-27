import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  noteTerminalFocusedInput,
  resetTerminalFocusedInputForTests,
} from './terminal-focused-input';
import {
  recordAgentOutputAnalysis,
  recordTerminalFitDirtyMark,
  recordTerminalFitExecution,
  recordTerminalFitFlush,
  recordTerminalFitSchedule,
  recordTerminalRendererAcquire,
  recordTerminalRendererEviction,
  recordTerminalRendererFallbackActivation,
  recordTerminalRendererRelease,
  recordTerminalRendererSwap,
  recordTerminalOutputSchedulerDrain,
  recordTerminalOutputSchedulerScan,
  resetRendererRuntimeDiagnostics,
} from './runtime-diagnostics';
import {
  beginTerminalSwitchWindow,
  markTerminalSwitchWindowFirstPaint,
  markTerminalSwitchWindowInputReady,
  resetTerminalSwitchWindowForTests,
} from './terminal-switch-window';
import {
  activateTerminalSwitchEchoGrace,
  beginTerminalSwitchEchoGrace,
  completeTerminalSwitchEchoGrace,
  resetTerminalSwitchEchoGraceForTests,
} from './terminal-switch-echo-grace';
import {
  getUiFluidityDiagnosticsSnapshot,
  installUiFluidityDiagnostics,
  resetUiFluidityDiagnosticsForTests,
} from './ui-fluidity-diagnostics';
import {
  recordTerminalOutputRoute,
  recordTerminalOutputSuppressed,
  recordTerminalOutputWrite,
  resetTerminalOutputDiagnostics,
} from '../lib/terminal-output-diagnostics';

describe('ui-fluidity-diagnostics', () => {
  const originalPerformanceObserver = globalThis.PerformanceObserver;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalPerformance = globalThis.performance;
  let animationFrameCallbacks: FrameRequestCallback[] = [];
  let longTaskCallback: ((list: { getEntries: () => PerformanceEntry[] }) => void) | null = null;

  beforeEach(() => {
    animationFrameCallbacks = [];
    longTaskCallback = null;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__: true,
      },
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }),
    );
    vi.stubGlobal('performance', {
      now: (() => {
        let now = 0;
        return () => {
          now += 5;
          return now;
        };
      })(),
    } as Performance);
    vi.stubGlobal(
      'PerformanceObserver',
      class TestPerformanceObserver {
        static readonly supportedEntryTypes = ['longtask'];

        constructor(callback: (list: { getEntries: () => PerformanceEntry[] }) => void) {
          longTaskCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}

        takeRecords(): PerformanceEntry[] {
          return [];
        }
      } as unknown as typeof PerformanceObserver,
    );
    resetRendererRuntimeDiagnostics();
    resetTerminalOutputDiagnostics();
    resetTerminalFocusedInputForTests();
    resetTerminalSwitchEchoGraceForTests();
    resetTerminalSwitchWindowForTests();
    resetUiFluidityDiagnosticsForTests();
  });

  afterEach(() => {
    resetUiFluidityDiagnosticsForTests();
    resetRendererRuntimeDiagnostics();
    resetTerminalOutputDiagnostics();
    resetTerminalFocusedInputForTests();
    resetTerminalSwitchEchoGraceForTests();
    resetTerminalSwitchWindowForTests();
    vi.unstubAllGlobals();
    globalThis.PerformanceObserver = originalPerformanceObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.performance = originalPerformance;
  });

  it('tracks frame gaps, per-frame write pressure, owner time, and long tasks', () => {
    installUiFluidityDiagnostics();
    const firstFrame = animationFrameCallbacks.shift();
    expect(firstFrame).toBeTypeOf('function');
    firstFrame?.(16);

    recordTerminalOutputRoute({
      agentId: 'agent-1',
      chunkLength: 64,
      priority: 'focused',
      route: 'queued',
      taskId: 'task-1',
    });
    recordTerminalOutputWrite({
      agentId: 'agent-1',
      chunk: new TextEncoder().encode('hello world'),
      priority: 'focused',
      queueAgeMs: 18,
      source: 'queued',
      taskId: 'task-1',
    });
    recordTerminalOutputRoute({
      agentId: 'agent-3',
      chunkLength: 48,
      priority: 'active-visible',
      route: 'queued',
      taskId: 'task-3',
    });
    recordTerminalOutputWrite({
      agentId: 'agent-3',
      chunk: new TextEncoder().encode('visible active output'),
      priority: 'active-visible',
      queueAgeMs: 28,
      source: 'queued',
      taskId: 'task-3',
    });
    beginTerminalSwitchWindow('task-4', 250);
    recordTerminalOutputRoute({
      agentId: 'agent-4',
      chunkLength: 40,
      priority: 'switch-target-visible',
      route: 'queued',
      taskId: 'task-4',
    });
    recordTerminalOutputWrite({
      agentId: 'agent-4',
      chunk: new TextEncoder().encode('switch target output'),
      priority: 'switch-target-visible',
      queueAgeMs: 30,
      source: 'queued',
      taskId: 'task-4',
    });
    recordTerminalOutputRoute({
      agentId: 'agent-2',
      chunkLength: 32,
      priority: 'hidden',
      route: 'queued',
      taskId: 'task-2',
    });
    recordTerminalOutputWrite({
      agentId: 'agent-2',
      chunk: new TextEncoder().encode('background'),
      priority: 'hidden',
      queueAgeMs: 44,
      source: 'queued',
      taskId: 'task-2',
    });
    recordTerminalOutputSuppressed({
      agentId: 'agent-2',
      chunkLength: 256,
      priority: 'hidden',
      taskId: 'task-2',
    });
    recordTerminalOutputSchedulerScan(25, 4);
    recordTerminalOutputSchedulerDrain({
      drainedBytes: 96,
      durationMs: 6,
      lane: 'visible',
      rescheduled: false,
    });
    recordAgentOutputAnalysis(7);
    recordTerminalFitDirtyMark('resize');
    recordTerminalFitDirtyMark('theme');
    recordTerminalFitSchedule('attach');
    recordTerminalFitSchedule('restore');
    recordTerminalFitExecution({
      geometryChanged: true,
      source: 'manager',
    });
    recordTerminalFitExecution({
      geometryChanged: false,
      source: 'session-immediate',
    });
    recordTerminalFitFlush(true);
    recordTerminalRendererAcquire({
      hit: true,
      recoveredFromFallback: true,
      snapshot: {
        activeContextsCurrent: 1,
        visibleContextsCurrent: 1,
      },
    });
    recordTerminalRendererSwap('attach');
    noteTerminalFocusedInput('task-1');
    longTaskCallback?.({
      getEntries: () =>
        [
          {
            duration: 52,
            startTime: 20,
          },
        ] as PerformanceEntry[],
    });

    const secondFrame = animationFrameCallbacks.shift();
    expect(secondFrame).toBeTypeOf('function');
    secondFrame?.(38);
    markTerminalSwitchWindowFirstPaint('task-4');
    recordTerminalOutputRoute({
      agentId: 'agent-1',
      chunkLength: 12,
      priority: 'focused',
      route: 'direct',
      taskId: 'task-1',
    });
    recordTerminalOutputWrite({
      agentId: 'agent-1',
      chunk: new TextEncoder().encode('prompt> next'),
      priority: 'focused',
      queueAgeMs: 6,
      source: 'direct',
      taskId: 'task-1',
    });
    recordTerminalOutputRoute({
      agentId: 'agent-5',
      chunkLength: 24,
      priority: 'visible-background',
      route: 'queued',
      taskId: 'task-5',
    });
    recordTerminalOutputWrite({
      agentId: 'agent-5',
      chunk: new TextEncoder().encode('background visible output'),
      priority: 'visible-background',
      queueAgeMs: 12,
      source: 'queued',
      taskId: 'task-5',
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
    markTerminalSwitchWindowInputReady('task-4');

    const snapshot = getUiFluidityDiagnosticsSnapshot();

    expect(snapshot.experiment.label).toBe('high_load_mode');
    expect(snapshot.frames.gapMs.max).toBeGreaterThanOrEqual(22);
    expect(snapshot.frames.overBudget16ms).toBeGreaterThan(0);
    expect(snapshot.frames.pressureCounts.stable).toBeGreaterThan(0);
    expect(snapshot.pacing.visibleTerminalCount).toBe(0);
    expect(snapshot.pacing.framePressureLevel).toBe('stable');
    expect(snapshot.pacing.laneFrameBudgetBytes.focused).toBeGreaterThan(0);
    expect(snapshot.pacing.laneFrameBudgetBytes.visible).toBeGreaterThan(0);
    expect(snapshot.pacing.sharedNonTargetVisibleFrameBudgetBytes).toBeGreaterThan(0);
    expect(snapshot.longTasks.durationMs.max).toBe(52);
    expect(snapshot.longTasks.totalDurationMs).toBe(52);
    expect(snapshot.terminalOutputPerFrame.directWriteCalls.max).toBe(0);
    expect(snapshot.terminalOutputPerFrame.directWriteBytes.max).toBe(0);
    expect(snapshot.terminalOutputPerFrame.queuedWriteCalls.max).toBeGreaterThanOrEqual(3);
    expect(snapshot.terminalOutputPerFrame.queuedWriteBytes.max).toBeGreaterThan(0);
    expect(snapshot.terminalOutputPerFrame.writeCalls.max).toBeGreaterThanOrEqual(3);
    expect(snapshot.terminalOutputPerFrame.writeBytes.max).toBeGreaterThanOrEqual(30);
    expect(snapshot.terminalOutputPerFrame.focusedWriteBytes.max).toBeGreaterThan(0);
    expect(snapshot.terminalOutputPerFrame.hiddenBytes.max).toBeGreaterThan(0);
    expect(snapshot.terminalOutputPerFrame.nonTargetVisibleBytes.max).toBeGreaterThan(0);
    expect(snapshot.terminalOutputPerFrame.suppressedBytes.max).toBe(256);
    expect(snapshot.terminalOutputPerFrame.activeVisibleBytes.max).toBeGreaterThan(0);
    expect(snapshot.terminalOutputPerFrame.switchTargetVisibleBytes.max).toBeGreaterThan(0);
    expect(snapshot.terminalOutputPerFrame.visibleBackgroundBytes.max).toBe(0);
    expect(snapshot.terminalOutputPerFrame.focusedQueueAgeMs.max).toBe(18);
    expect(snapshot.terminalOutputPerFrame.activeVisibleQueueAgeMs.max).toBe(28);
    expect(snapshot.terminalOutputPerFrame.switchTargetVisibleQueueAgeMs.max).toBe(30);
    expect(snapshot.terminalOutputPerFrame.visibleBackgroundQueueAgeMs.max).toBe(0);
    expect(snapshot.terminalOutputPerFrame.hiddenQueueAgeMs.max).toBe(44);
    expect(snapshot.focusedInput).toEqual(
      expect.objectContaining({
        active: true,
        echoReservationActive: true,
        taskId: 'task-1',
      }),
    );
    expect(snapshot.terminalOutputDuringFocusedInputPerFrame.focusedWriteBytes.max).toBe(11);
    expect(snapshot.terminalOutputDuringFocusedInputPerFrame.hiddenBytes.max).toBe(10);
    expect(snapshot.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleBytes.max).toBe(21);
    expect(snapshot.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundBytes.max).toBe(0);
    expect(snapshot.terminalOutputDuringFocusedInputPerFrame.queuedQueueAgeMs.max).toBe(30);
    expect(snapshot.runtimePerFrame.schedulerScanDurationMs.max).toBe(4);
    expect(snapshot.runtimePerFrame.schedulerDrainDurationMs.max).toBe(6);
    expect(snapshot.runtimePerFrame.agentAnalysisDurationMs.max).toBe(7);
    expect(snapshot.runtimePerFrame.activeWebglContexts.max).toBe(0);
    expect(snapshot.runtimePerFrame.visibleWebglContexts.max).toBe(0);
    expect(snapshot.runtimePerFrame.ownerDurationMs.max).toBe(17);
    expect(snapshot.rendererRuntime.terminalFit).toEqual(
      expect.objectContaining({
        dirtyMarks: 2,
        flushCalls: 1,
        geometryChangeFits: 1,
        scheduleCalls: 2,
      }),
    );
    expect(snapshot.rendererRuntime.terminalFit.dirtyReasonCounts.resize).toBe(1);
    expect(snapshot.rendererRuntime.terminalFit.dirtyReasonCounts.theme).toBe(1);
    expect(snapshot.rendererRuntime.terminalFit.executionCounts.manager).toBe(1);
    expect(snapshot.rendererRuntime.terminalFit.executionCounts['session-immediate']).toBe(1);
    expect(snapshot.rendererRuntime.terminalFit.scheduleReasonCounts.attach).toBe(1);
    expect(snapshot.rendererRuntime.terminalFit.scheduleReasonCounts.restore).toBe(1);
    expect(snapshot.rendererRuntime.terminalRenderer).toEqual(
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
    expect(snapshot.rendererRuntime.terminalRenderer.rendererSwapCounts.attach).toBe(1);
    expect(snapshot.switchWindow).toEqual(
      expect.objectContaining({
        active: false,
        activeVisibleBytes: expect.any(Number),
        firstPaintSample: expect.objectContaining({
          focusedBytes: expect.any(Number),
          framePressureLevel: 'stable',
          nonTargetVisibleBytes: expect.any(Number),
          switchTargetVisibleBytes: expect.any(Number),
          visibleBackgroundBytes: 0,
        }),
        firstPaintDurationMs: expect.any(Number),
        focusedBytes: expect.any(Number),
        inputReadyDurationMs: expect.any(Number),
        inputReadySample: expect.objectContaining({
          focusedBytes: expect.any(Number),
          framePressureLevel: 'stable',
          nonTargetVisibleBytes: expect.any(Number),
          switchTargetVisibleBytes: expect.any(Number),
          visibleBackgroundBytes: expect.any(Number),
          visibleBackgroundQueueAgeMs: 12,
        }),
        lastCompletion: expect.objectContaining({
          firstPaintDurationMs: expect.any(Number),
          inputReadyDurationMs: expect.any(Number),
          reason: 'completed',
          taskId: 'task-4',
        }),
        phase: 'inactive',
        selectedRecoveryActive: false,
        switchTargetVisibleBytes: expect.any(Number),
        switchTargetVisibleQueueAgeMs: 30,
        targetTaskId: null,
      }),
    );
    expect(snapshot.switchWindow?.inputReadySample?.focusedBytes ?? 0).toBeGreaterThan(
      snapshot.switchWindow?.firstPaintSample?.focusedBytes ?? 0,
    );
  });

  it('captures post-input-ready switch echo grace completion samples', () => {
    installUiFluidityDiagnostics();
    const firstFrame = animationFrameCallbacks.shift();
    firstFrame?.(16);

    beginTerminalSwitchEchoGrace('task-9', 120);
    activateTerminalSwitchEchoGrace('task-9');
    recordTerminalOutputRoute({
      agentId: 'agent-9',
      chunkLength: 10,
      priority: 'focused',
      route: 'queued',
      taskId: 'task-9',
    });
    recordTerminalOutputWrite({
      agentId: 'agent-9',
      chunk: new TextEncoder().encode('prompt> ok'),
      priority: 'focused',
      queueAgeMs: 7,
      source: 'queued',
      taskId: 'task-9',
    });
    recordTerminalOutputRoute({
      agentId: 'agent-10',
      chunkLength: 23,
      priority: 'visible-background',
      route: 'queued',
      taskId: 'task-10',
    });
    recordTerminalOutputWrite({
      agentId: 'agent-10',
      chunk: new TextEncoder().encode('visible background work'),
      priority: 'visible-background',
      queueAgeMs: 11,
      source: 'queued',
      taskId: 'task-10',
    });
    completeTerminalSwitchEchoGrace('task-9');

    const snapshot = getUiFluidityDiagnosticsSnapshot();

    expect(snapshot.switchEchoGrace).toEqual(
      expect.objectContaining({
        active: false,
        completionSample: expect.objectContaining({
          focusedBytes: expect.any(Number),
          framePressureLevel: 'stable',
          nonTargetVisibleBytes: expect.any(Number),
          visibleBackgroundBytes: expect.any(Number),
        }),
        durationMs: expect.any(Number),
        focusedBytes: expect.any(Number),
        focusedQueueAgeMs: 7,
        lastCompletion: expect.objectContaining({
          reason: 'completed',
          taskId: 'task-9',
        }),
        nonTargetVisibleBytes: expect.any(Number),
        targetTaskId: null,
        visibleBackgroundBytes: expect.any(Number),
        visibleBackgroundQueueAgeMs: 11,
      }),
    );
  });
});
