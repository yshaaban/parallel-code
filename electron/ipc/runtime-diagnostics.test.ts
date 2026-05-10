import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBackendRuntimeDiagnosticsGeneration,
  getBackendRuntimeDiagnosticsSnapshot,
  recordBrowserControlBufferedAmount,
  recordBrowserControlDelayedQueue,
  recordBrowserControlSendResult,
  recordPreviewProbeResult,
  recordTerminalInputTraceBackendOutputFlushed,
  recordTerminalInputTraceCommandResultSent,
  recordTerminalInputTraceFailure,
  recordTerminalInputTracePtyEnqueued,
  recordTerminalInputTracePtyOutput,
  recordTerminalInputTracePtyWritten,
  recordTerminalInputTraceClientUpdate,
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

  it('splits backend echo, backend flush, browser delivery, and render timing for input traces', () => {
    recordTerminalInputTraceServerReceived({
      agentId: 'agent-1',
      clientId: 'client-1',
      inputPreview: 'pwd',
      requestId: 'request-1',
      taskId: 'task-1',
      trace: {
        bufferedAtMs: 1_000,
        echoText: 'pwd',
        inputChars: 4,
        inputKind: 'interactive',
        sendStartedAtMs: 1_001,
        startedAtMs: 999,
      },
    });
    recordTerminalInputTracePtyEnqueued('agent-1', 'request-1');
    recordTerminalInputTracePtyWritten('agent-1', 'request-1');
    recordTerminalInputTraceCommandResultSent('agent-1', 'request-1');
    recordTerminalInputTracePtyOutput('agent-1', '\u001b[32mpwd\u001b[0m\r\n');
    recordTerminalInputTraceBackendOutputFlushed('agent-1', 'pwd\r\n');
    recordTerminalInputTraceClientUpdate({
      agentId: 'agent-1',
      outputReceivedAtMs: 1_050,
      outputRenderedAtMs: 1_060,
      outputTransportReceivedAtMs: 1_045,
      requestId: 'request-1',
    });

    const diagnostics = getBackendRuntimeDiagnosticsSnapshot();
    const stages = diagnostics.terminalInputTracing.completedTraces[0]?.stages;

    expect(stages?.ptyOutputReceivedAtMs).not.toBeNull();
    expect(stages?.backendOutputFlushedAtMs).not.toBeNull();
    expect(diagnostics.terminalInputTracing.summary.ptyEchoMs.count).toBe(1);
    expect(diagnostics.terminalInputTracing.summary.commandAckMs.count).toBe(1);
    expect(diagnostics.terminalInputTracing.summary.ptyWriteToCommandAckMs.count).toBe(1);
    expect(diagnostics.terminalInputTracing.summary.backendOutputBufferMs.count).toBe(1);
    expect(diagnostics.terminalInputTracing.summary.browserDeliveryMs.count).toBe(1);
    expect(diagnostics.terminalInputTracing.summary.browserTransportDeliveryMs.count).toBe(1);
    expect(diagnostics.terminalInputTracing.summary.browserChannelDispatchMs.p95).toBe(5);
    expect(diagnostics.terminalInputTracing.summary.renderMs.p95).toBe(10);
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

  it('ignores browser control diagnostics from before the latest diagnostics reset', () => {
    const previousGeneration = getBackendRuntimeDiagnosticsGeneration();
    resetBackendRuntimeDiagnostics();

    recordBrowserControlSendResult('backpressure', {
      generation: previousGeneration,
    });
    recordBrowserControlDelayedQueue(4, 128_000, 250, {
      generation: previousGeneration,
    });
    recordBrowserControlBufferedAmount(96_000, {
      generation: previousGeneration,
    });
    recordBrowserControlSendResult('not-open', {
      generation: getBackendRuntimeDiagnosticsGeneration(),
    });
    recordBrowserControlDelayedQueue(2, 64_000, 125, {
      generation: getBackendRuntimeDiagnosticsGeneration(),
    });
    recordBrowserControlBufferedAmount(32_000, {
      generation: getBackendRuntimeDiagnosticsGeneration(),
    });

    expect(getBackendRuntimeDiagnosticsSnapshot().browserControl).toMatchObject({
      backpressureRejects: 0,
      delayedQueueMaxAgeMs: 125,
      delayedQueueMaxBytes: 64_000,
      delayedQueueMaxDepth: 2,
      maxBufferedAmountBytes: 32_000,
      notOpenRejects: 1,
    });
  });
});
