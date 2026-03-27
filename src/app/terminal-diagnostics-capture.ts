import type {
  TerminalAnomalyMonitorSnapshot,
  TerminalAnomalyTerminalSnapshot,
} from './terminal-anomaly-monitor';
import {
  getTerminalAnomalyMonitorSnapshot,
  resetTerminalAnomalyMonitor,
} from './terminal-anomaly-monitor';
import type { RendererRuntimeDiagnosticsSnapshot } from './runtime-diagnostics';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from './runtime-diagnostics';
import type { UiFluidityDiagnosticsSnapshot } from './ui-fluidity-diagnostics';
import {
  getUiFluidityDiagnosticsSnapshot,
  resetUiFluidityDiagnostics,
} from './ui-fluidity-diagnostics';
import type {
  TerminalOutputDiagnosticsSnapshot,
  TerminalOutputTerminalSnapshot,
} from '../lib/terminal-output-diagnostics';
import {
  getTerminalOutputDiagnosticsSnapshot,
  resetTerminalOutputDiagnostics,
} from '../lib/terminal-output-diagnostics';

export interface TerminalDiagnosticsCaptureTarget {
  focusedKey: string | null;
  outputTerminal: TerminalOutputTerminalSnapshot | null;
  selectedKey: string | null;
  snapshot: TerminalAnomalyTerminalSnapshot | null;
  targetKey: string | null;
  visibleKeys: string[];
}

export type TerminalDiagnosticsFindingKind =
  | 'focused-queue-age'
  | 'long-task-pressure'
  | 'queued-queue-age'
  | 'render-refresh'
  | 'visible-steady-state-recovery';

export interface TerminalDiagnosticsFinding {
  key: TerminalDiagnosticsFindingKind;
  label: string;
  severity: 'warning' | 'error';
  threshold: number;
  value: number;
}

export interface TerminalDiagnosticsCaptureSnapshot {
  anomalyMonitor: TerminalAnomalyMonitorSnapshot;
  capturedAtMs: number;
  enabled: boolean;
  findings: TerminalDiagnosticsFinding[];
  outputDiagnostics: TerminalOutputDiagnosticsSnapshot;
  rendererRuntime: RendererRuntimeDiagnosticsSnapshot;
  target: TerminalDiagnosticsCaptureTarget;
  uiFluidity: UiFluidityDiagnosticsSnapshot;
}

declare global {
  interface Window {
    __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__?: boolean;
    __PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__?: boolean;
    __PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__?: boolean;
    __TERMINAL_OUTPUT_DIAGNOSTICS__?: boolean;
    __parallelCodeTerminalDiagnosticsCapture?: {
      capture: (terminalKey?: string | null) => TerminalDiagnosticsCaptureSnapshot;
      captureFocused: () => TerminalDiagnosticsCaptureSnapshot;
      enable: () => void;
      reset: () => void;
    };
  }
}

function isTerminalDiagnosticsCaptureEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return (
    window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ === true ||
    window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__ === true ||
    window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ === true ||
    window.__TERMINAL_OUTPUT_DIAGNOSTICS__ === true
  );
}

function resetAllTerminalDiagnostics(): void {
  resetRendererRuntimeDiagnostics();
  resetTerminalOutputDiagnostics();
  resetUiFluidityDiagnostics();
  resetTerminalAnomalyMonitor();
}

function enableAllTerminalDiagnostics(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
  window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__ = true;
  window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ = true;
  window.__TERMINAL_OUTPUT_DIAGNOSTICS__ = true;
  resetAllTerminalDiagnostics();
}

function resolveTargetTerminalKey(
  anomalySnapshot: TerminalAnomalyMonitorSnapshot,
  terminalKey?: string | null,
): string | null {
  if (terminalKey) {
    return terminalKey;
  }

  const focusedTerminal = anomalySnapshot.terminals.find((entry) => entry.lifecycle.isFocused);
  if (focusedTerminal) {
    return focusedTerminal.key;
  }

  const selectedTerminal = anomalySnapshot.terminals.find((entry) => entry.lifecycle.isSelected);
  if (selectedTerminal) {
    return selectedTerminal.key;
  }

  const visibleTerminal = anomalySnapshot.terminals.find((entry) => entry.lifecycle.isVisible);
  if (visibleTerminal) {
    return visibleTerminal.key;
  }

  return anomalySnapshot.terminals[0]?.key ?? null;
}

function createTerminalDiagnosticsCaptureSnapshot(
  terminalKey?: string | null,
): TerminalDiagnosticsCaptureSnapshot {
  const anomalyMonitor = getTerminalAnomalyMonitorSnapshot();
  const outputDiagnostics = getTerminalOutputDiagnosticsSnapshot();
  const uiFluidity = getUiFluidityDiagnosticsSnapshot();
  const rendererRuntime = getRendererRuntimeDiagnosticsSnapshot();
  const targetKey = resolveTargetTerminalKey(anomalyMonitor, terminalKey);
  const visibleKeys = anomalyMonitor.terminals
    .filter((entry) => entry.lifecycle.isVisible)
    .map((entry) => entry.key);
  const focusedKey =
    anomalyMonitor.terminals.find((entry) => entry.lifecycle.isFocused)?.key ?? null;
  const selectedKey =
    anomalyMonitor.terminals.find((entry) => entry.lifecycle.isSelected)?.key ?? null;

  return {
    anomalyMonitor,
    capturedAtMs: anomalyMonitor.capturedAtMs,
    enabled: isTerminalDiagnosticsCaptureEnabled(),
    findings: createTerminalDiagnosticsFindings(uiFluidity, rendererRuntime),
    outputDiagnostics,
    rendererRuntime,
    target: {
      focusedKey,
      outputTerminal: outputDiagnostics.terminals.find((entry) => entry.key === targetKey) ?? null,
      selectedKey,
      snapshot: anomalyMonitor.terminals.find((entry) => entry.key === targetKey) ?? null,
      targetKey,
      visibleKeys,
    },
    uiFluidity,
  };
}

function createTerminalDiagnosticsFindings(
  uiFluidity: UiFluidityDiagnosticsSnapshot,
  rendererRuntime: RendererRuntimeDiagnosticsSnapshot,
): TerminalDiagnosticsFinding[] {
  const findings: TerminalDiagnosticsFinding[] = [];
  const visibleSteadyStateRecoveryCount =
    rendererRuntime.terminalRecovery.visibleSteadyStateSnapshotCounts.attach +
    rendererRuntime.terminalRecovery.visibleSteadyStateSnapshotCounts.backpressure +
    rendererRuntime.terminalRecovery.visibleSteadyStateSnapshotCounts.hibernate +
    rendererRuntime.terminalRecovery.visibleSteadyStateSnapshotCounts.reconnect;

  if (visibleSteadyStateRecoveryCount > 0) {
    findings.push({
      key: 'visible-steady-state-recovery',
      label: 'Visible steady-state terminal recovery',
      severity: 'error',
      threshold: 0,
      value: visibleSteadyStateRecoveryCount,
    });
  }
  if (rendererRuntime.terminalRecovery.renderRefreshes > 0) {
    findings.push({
      key: 'render-refresh',
      label: 'Recovery-driven terminal refreshes',
      severity: 'warning',
      threshold: 0,
      value: rendererRuntime.terminalRecovery.renderRefreshes,
    });
  }
  if (uiFluidity.terminalOutputPerFrame.focusedQueueAgeMs.p95 > 48) {
    findings.push({
      key: 'focused-queue-age',
      label: 'Focused terminal queue age above one frame budget',
      severity: 'warning',
      threshold: 48,
      value: uiFluidity.terminalOutputPerFrame.focusedQueueAgeMs.p95,
    });
  }
  if (uiFluidity.terminalOutputPerFrame.queuedQueueAgeMs.p95 > 64) {
    findings.push({
      key: 'queued-queue-age',
      label: 'Queued terminal output age above steady-state budget',
      severity: 'warning',
      threshold: 64,
      value: uiFluidity.terminalOutputPerFrame.queuedQueueAgeMs.p95,
    });
  }
  if (uiFluidity.frames.overBudget50ms > 2) {
    findings.push({
      key: 'long-task-pressure',
      label: 'Repeated frames above 50ms budget',
      severity: 'warning',
      threshold: 2,
      value: uiFluidity.frames.overBudget50ms,
    });
  }

  return findings;
}

function attachTerminalDiagnosticsCaptureStore(): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (window.__parallelCodeTerminalDiagnosticsCapture) {
    return;
  }

  window.__parallelCodeTerminalDiagnosticsCapture = {
    capture: createTerminalDiagnosticsCaptureSnapshot,
    captureFocused(): TerminalDiagnosticsCaptureSnapshot {
      return createTerminalDiagnosticsCaptureSnapshot();
    },
    enable(): void {
      enableAllTerminalDiagnostics();
    },
    reset(): void {
      resetAllTerminalDiagnostics();
    },
  };
}

export function installTerminalDiagnosticsCapture(): void {
  attachTerminalDiagnosticsCaptureStore();
}

export function getTerminalDiagnosticsCaptureSnapshot(
  terminalKey?: string | null,
): TerminalDiagnosticsCaptureSnapshot {
  attachTerminalDiagnosticsCaptureStore();
  return createTerminalDiagnosticsCaptureSnapshot(terminalKey);
}

export function enableTerminalDiagnosticsCapture(): void {
  enableAllTerminalDiagnostics();
  attachTerminalDiagnosticsCaptureStore();
}

export function resetTerminalDiagnosticsCaptureForTests(): void {
  resetAllTerminalDiagnostics();
  if (typeof window !== 'undefined') {
    Reflect.deleteProperty(window, '__parallelCodeTerminalDiagnosticsCapture');
  }
}
