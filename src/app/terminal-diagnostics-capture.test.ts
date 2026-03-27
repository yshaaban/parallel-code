import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  enableTerminalDiagnosticsCapture,
  getTerminalDiagnosticsCaptureSnapshot,
  installTerminalDiagnosticsCapture,
  resetTerminalDiagnosticsCaptureForTests,
} from './terminal-diagnostics-capture';
import {
  registerTerminalAnomalyMonitorTerminal,
  resetTerminalAnomalyMonitor,
} from './terminal-anomaly-monitor';
import { resetRendererRuntimeDiagnostics } from './runtime-diagnostics';
import { resetUiFluidityDiagnosticsForTests } from './ui-fluidity-diagnostics';
import { resetTerminalOutputDiagnostics } from '../lib/terminal-output-diagnostics';

describe('terminal-diagnostics-capture', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    resetRendererRuntimeDiagnostics();
    resetTerminalOutputDiagnostics();
    resetTerminalAnomalyMonitor();
    resetUiFluidityDiagnosticsForTests();
    resetTerminalDiagnosticsCaptureForTests();
  });

  afterEach(() => {
    resetRendererRuntimeDiagnostics();
    resetTerminalOutputDiagnostics();
    resetTerminalAnomalyMonitor();
    resetUiFluidityDiagnosticsForTests();
    resetTerminalDiagnosticsCaptureForTests();
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('installs a live diagnostics capture store and enables diagnostics on demand', () => {
    installTerminalDiagnosticsCapture();
    expect(window.__parallelCodeTerminalDiagnosticsCapture).toBeDefined();

    window.__parallelCodeTerminalDiagnosticsCapture?.enable();

    expect(window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__).toBe(true);
    expect(window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__).toBe(true);
    expect(window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__).toBe(true);
    expect(window.__TERMINAL_OUTPUT_DIAGNOSTICS__).toBe(true);
  });

  it('captures the focused terminal snapshot across diagnostics stores', () => {
    enableTerminalDiagnosticsCapture();

    const registration = registerTerminalAnomalyMonitorTerminal({
      agentId: 'agent-1',
      key: 'task-1:agent-1',
      taskId: 'task-1',
    });
    registration.updateLifecycle({
      cursorBlink: true,
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

    const snapshot = getTerminalDiagnosticsCaptureSnapshot();

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.target.focusedKey).toBe('task-1:agent-1');
    expect(snapshot.target.selectedKey).toBe('task-1:agent-1');
    expect(snapshot.target.targetKey).toBe('task-1:agent-1');
    expect(snapshot.target.snapshot).toEqual(
      expect.objectContaining({
        agentId: 'agent-1',
        key: 'task-1:agent-1',
      }),
    );
    expect(snapshot.findings).toEqual([]);
    expect(snapshot.anomalyMonitor.summary.terminalsTracked).toBe(1);
    expect(snapshot.rendererRuntime.terminalRecovery.kindCounts.snapshot).toBe(0);
  });
});
