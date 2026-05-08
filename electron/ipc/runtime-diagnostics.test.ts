import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBackendRuntimeDiagnosticsGeneration,
  getBackendRuntimeDiagnosticsSnapshot,
  recordPreviewProbeResult,
  recordTerminalInputTraceFailure,
  recordTerminalInputTracePtyEnqueued,
  recordTerminalInputTraceServerReceived,
  resetBackendRuntimeDiagnostics,
} from './runtime-diagnostics.js';

describe('backend runtime diagnostics terminal input tracing', () => {
  const originalPerformance = globalThis.performance;

  beforeEach(() => {
    let now = 0;
    vi.stubGlobal('performance', {
      now: () => {
        now += 1;
        return now;
      },
      timeOrigin: 1_000,
    } as Performance);
    resetBackendRuntimeDiagnostics();
  });

  afterEach(() => {
    resetBackendRuntimeDiagnostics();
    vi.unstubAllGlobals();
    globalThis.performance = originalPerformance;
  });

  it('keeps the earliest server-received timestamp when the same trace is recorded twice', () => {
    const trace = {
      bufferedAtMs: 10,
      inputChars: 4,
      inputKind: 'interactive' as const,
      sendStartedAtMs: 11,
      startedAtMs: 9,
    };

    recordTerminalInputTraceServerReceived({
      agentId: 'agent-1',
      clientId: 'client-1',
      inputPreview: 'pwd',
      requestId: 'request-1',
      taskId: 'task-1',
      trace,
    });
    recordTerminalInputTracePtyEnqueued('agent-1', 'request-1');

    recordTerminalInputTraceServerReceived({
      agentId: 'agent-1',
      clientId: 'client-1',
      inputPreview: 'pwd',
      requestId: 'request-1',
      taskId: 'task-1',
      trace,
    });
    recordTerminalInputTraceFailure('agent-1', 'request-1', 'failed');

    const diagnostics = getBackendRuntimeDiagnosticsSnapshot();
    expect(diagnostics.terminalInputTracing.activeTraceCount).toBe(0);
    expect(diagnostics.terminalInputTracing.completedTraces).toHaveLength(1);
    const stages = diagnostics.terminalInputTracing.completedTraces[0]?.stages;
    expect(stages?.serverReceivedAtMs).not.toBeNull();
    expect(stages?.ptyEnqueuedAtMs).not.toBeNull();
    expect(stages?.serverReceivedAtMs).toBeLessThan(stages?.ptyEnqueuedAtMs ?? 0);
  });

  it('classifies preview probe failure diagnostics and clears stale failure reason after success', () => {
    recordPreviewProbeResult(false, 12, {
      failureReason: 'timeout',
      target: 'http://127.0.0.1:3000',
    });
    recordPreviewProbeResult(false, 8, {
      failureReason: 'connection-error',
      target: 'http://127.0.0.1:3001',
    });

    let diagnostics = getBackendRuntimeDiagnosticsSnapshot().previewValidation;
    expect(diagnostics).toMatchObject({
      connectionFailures: 1,
      lastProbeDurationMs: 8,
      lastProbeFailureReason: 'connection-error',
      lastProbeTarget: 'http://127.0.0.1:3001',
      maxProbeDurationMs: 12,
      probeFailures: 2,
      probeSuccesses: 0,
      timeoutFailures: 1,
    });

    recordPreviewProbeResult(true, 4, {
      target: 'http://127.0.0.1:3002',
    });

    diagnostics = getBackendRuntimeDiagnosticsSnapshot().previewValidation;
    expect(diagnostics).toMatchObject({
      lastProbeDurationMs: 4,
      lastProbeFailureReason: null,
      lastProbeTarget: 'http://127.0.0.1:3002',
      maxProbeDurationMs: 12,
      probeFailures: 2,
      probeSuccesses: 1,
    });
  });

  it('ignores preview probe results from before the latest diagnostics reset', () => {
    const previousGeneration = getBackendRuntimeDiagnosticsGeneration();
    resetBackendRuntimeDiagnostics();

    recordPreviewProbeResult(false, 18, {
      failureReason: 'connection-error',
      generation: previousGeneration,
      target: 'http://127.0.0.1:3000',
    });
    recordPreviewProbeResult(true, 6, {
      generation: getBackendRuntimeDiagnosticsGeneration(),
      target: 'http://127.0.0.1:3001',
    });

    const diagnostics = getBackendRuntimeDiagnosticsSnapshot().previewValidation;
    expect(diagnostics).toMatchObject({
      connectionFailures: 0,
      lastProbeDurationMs: 6,
      lastProbeFailureReason: null,
      lastProbeTarget: 'http://127.0.0.1:3001',
      maxProbeDurationMs: 6,
      probeFailures: 0,
      probeSuccesses: 1,
    });
  });
});
