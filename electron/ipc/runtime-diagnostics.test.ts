import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBackendRuntimeDiagnosticsSnapshot,
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
});
