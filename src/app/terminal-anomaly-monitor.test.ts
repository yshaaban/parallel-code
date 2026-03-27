import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getTerminalAnomalyMonitorSnapshot,
  getTerminalAnomalyTerminalSnapshot,
  registerTerminalAnomalyMonitorTerminal,
  resetTerminalAnomalyMonitorForTests,
  subscribeTerminalAnomalyMonitorChanges,
} from './terminal-anomaly-monitor';
import {
  recordTerminalOutputSchedulerScan,
  resetRendererRuntimeDiagnostics,
} from './runtime-diagnostics';
import {
  recordTerminalOutputWrite,
  resetTerminalOutputDiagnostics,
} from '../lib/terminal-output-diagnostics';

describe('terminal-anomaly-monitor', () => {
  const originalWindow = globalThis.window;
  const originalPerformance = globalThis.performance;
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 0;
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
        __PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__: true,
        __TERMINAL_OUTPUT_DIAGNOSTICS__: true,
      },
    });
    vi.stubGlobal('performance', {
      now: () => nowMs,
    } as Performance);
    resetRendererRuntimeDiagnostics();
    resetTerminalOutputDiagnostics();
    resetTerminalAnomalyMonitorForTests();
  });

  afterEach(() => {
    resetRendererRuntimeDiagnostics();
    resetTerminalOutputDiagnostics();
    resetTerminalAnomalyMonitorForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    globalThis.performance = originalPerformance;
  });

  function advanceClock(ms: number): void {
    nowMs += ms;
    vi.advanceTimersByTime(ms);
  }

  it('tracks prolonged loading and exposes the combined diagnostics capture snapshot', () => {
    const registration = registerTerminalAnomalyMonitorTerminal({
      agentId: 'agent-1',
      key: 'task-1:agent-1',
      taskId: 'task-1',
    });

    registration.updateLifecycle({
      cursorBlink: false,
      hasPeerController: false,
      isFocused: true,
      isSelected: true,
      isVisible: true,
      liveRenderReady: false,
      presentationMode: 'loading',
      renderHibernating: false,
      restoreBlocked: false,
      sessionDormant: false,
      status: 'binding',
      surfaceTier: 'interactive-live',
    });

    recordTerminalOutputSchedulerScan(3, 4);
    recordTerminalOutputWrite({
      agentId: 'agent-1',
      chunk: new TextEncoder().encode('hello'),
      priority: 'focused',
      queueAgeMs: 12,
      source: 'queued',
      taskId: 'task-1',
    });

    advanceClock(4_000);

    const snapshot = getTerminalAnomalyMonitorSnapshot();
    expect(window.__parallelCodeTerminalAnomalyMonitor).toBeDefined();
    expect(snapshot.summary.terminalsTracked).toBe(1);
    expect(snapshot.summary.terminalsWithAnomalies).toBe(1);
    expect(snapshot.summary.anomalyCounts['prolonged-loading']).toBe(1);
    expect(snapshot.rendererRuntime.terminalOutputScheduler.scanCalls).toBe(1);
    expect(snapshot.outputSummary.writes.totalCalls).toBe(1);
    expect(snapshot.terminals[0]?.anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'prolonged-loading',
          label: 'Loading taking too long',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('records live interaction events, notifies listeners when thresholds trip, and clears anomalies after recovery', () => {
    const changes = vi.fn();
    const unsubscribe = subscribeTerminalAnomalyMonitorChanges(changes);
    const registration = registerTerminalAnomalyMonitorTerminal({
      agentId: 'agent-2',
      key: 'task-2:agent-2',
      taskId: 'task-2',
    });

    registration.updateLifecycle({
      cursorBlink: false,
      hasPeerController: true,
      isFocused: true,
      isSelected: true,
      isVisible: true,
      liveRenderReady: true,
      presentationMode: 'live',
      renderHibernating: false,
      restoreBlocked: false,
      sessionDormant: false,
      status: 'ready',
      surfaceTier: 'interactive-live',
    });
    registration.recordInteraction('blocked-input');
    registration.recordInteraction('read-only-input');

    registration.updateLifecycle({
      cursorBlink: false,
      hasPeerController: true,
      isFocused: true,
      isSelected: true,
      isVisible: true,
      liveRenderReady: false,
      presentationMode: 'live',
      renderHibernating: false,
      restoreBlocked: true,
      sessionDormant: false,
      status: 'ready',
      surfaceTier: 'interactive-live',
    });

    advanceClock(1_500);

    const anomalousSnapshot = getTerminalAnomalyTerminalSnapshot('task-2:agent-2');
    expect(changes).toHaveBeenCalled();
    expect(anomalousSnapshot?.counters).toEqual(
      expect.objectContaining({
        blockedInputAttempts: 1,
        readOnlyInputAttempts: 1,
      }),
    );
    expect(anomalousSnapshot?.anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'visible-restore-blocked',
        }),
      ]),
    );
    expect(anomalousSnapshot?.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'blocked-input' }),
        expect.objectContaining({ type: 'read-only-input' }),
        expect.objectContaining({
          anomalyKind: 'visible-restore-blocked',
          type: 'anomaly-entered',
        }),
      ]),
    );

    registration.updateLifecycle({
      cursorBlink: false,
      hasPeerController: false,
      isFocused: true,
      isSelected: true,
      isVisible: true,
      liveRenderReady: true,
      presentationMode: 'live',
      renderHibernating: false,
      restoreBlocked: false,
      sessionDormant: false,
      status: 'ready',
      surfaceTier: 'interactive-live',
    });

    const recoveredSnapshot = getTerminalAnomalyTerminalSnapshot('task-2:agent-2');
    expect(recoveredSnapshot?.anomalies).toEqual([]);
    expect(recoveredSnapshot?.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anomalyKind: 'visible-restore-blocked',
          type: 'anomaly-cleared',
        }),
      ]),
    );

    unsubscribe();
  });

  it('flags invalid focused-ready and peer-controlled cursor states immediately', () => {
    const registration = registerTerminalAnomalyMonitorTerminal({
      agentId: 'agent-3',
      key: 'task-3:agent-3',
      taskId: 'task-3',
    });

    registration.updateLifecycle({
      cursorBlink: true,
      hasPeerController: true,
      isFocused: true,
      isSelected: true,
      isVisible: true,
      liveRenderReady: false,
      presentationMode: 'live',
      renderHibernating: false,
      restoreBlocked: false,
      sessionDormant: false,
      status: 'ready',
      surfaceTier: 'interactive-live',
    });
    advanceClock(250);

    const snapshot = getTerminalAnomalyTerminalSnapshot('task-3:agent-3');
    expect(snapshot?.anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'focused-ready-without-live-render', severity: 'error' }),
        expect.objectContaining({ key: 'peer-controlled-cursor', severity: 'error' }),
      ]),
    );
  });
});
