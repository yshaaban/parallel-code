import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ipc', () => ({
  invoke: vi.fn(),
}));

import { invoke } from './ipc';
import {
  assertTerminalLatencyStateCleanForTests,
  detectProbeInOutput,
  getFlowRequestStats,
  getInputStageStats,
  getRenderLatencyStats,
  hasPendingProbes,
  measureRoundTrip,
  recordFlowRequest,
  recordInputBuffered,
  recordInputQueued,
  recordInputSent,
  resetFlowEvents,
  resetInputStageSamples,
  resetRoundTripSamples,
  startRoundTripProbe,
  waitForRoundTripProbe,
} from './terminalLatency';

describe('terminalLatency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __TERMINAL_PERF__: true,
      },
    });
    vi.mocked(invoke).mockReset();
    resetFlowEvents();
    resetInputStageSamples();
    resetRoundTripSamples();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    resetFlowEvents();
    resetInputStageSamples();
    resetRoundTripSamples();
    assertTerminalLatencyStateCleanForTests();
    vi.useRealTimers();
  });

  it('registers probes before the write promise resolves', async () => {
    let resolveWrite: ((value?: undefined) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveWrite = () => resolve(undefined);
        }),
    );

    const probePromise = measureRoundTrip('agent-1', 5_000);
    expect(hasPendingProbes()).toBe(true);

    const request = vi.mocked(invoke).mock.calls[0]?.[1] as { data: string };
    const marker = request.data.slice('echo '.length, -1);

    detectProbeInOutput(marker);
    await expect(probePromise).resolves.toBeGreaterThanOrEqual(0);
    expect(hasPendingProbes()).toBe(false);

    resolveWrite?.();
    await Promise.resolve();
    vi.advanceTimersByTime(5_000);
  });

  it('clears pending probes and resolves callers on reset', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    const probePromise = measureRoundTrip('agent-2', 5_000);
    await Promise.resolve();
    expect(hasPendingProbes()).toBe(true);

    resetRoundTripSamples();

    await expect(probePromise).resolves.toBe(-1);
    expect(hasPendingProbes()).toBe(false);
    vi.advanceTimersByTime(5_000);
  });

  it('resolves with -1 when a probe times out', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    const probePromise = measureRoundTrip('agent-3', 100);
    await Promise.resolve();
    expect(hasPendingProbes()).toBe(true);

    vi.advanceTimersByTime(100);
    await expect(probePromise).resolves.toBe(-1);
    expect(hasPendingProbes()).toBe(false);
  });

  it('tracks input buffer and send stage timings when perf is enabled', () => {
    const queueTs = recordInputQueued();

    vi.advanceTimersByTime(3);
    const bufferedTs = recordInputBuffered(queueTs);

    vi.advanceTimersByTime(2);
    recordInputSent(bufferedTs);

    expect(getInputStageStats()).toEqual({
      buffered: expect.objectContaining({
        count: 1,
        p50: 3,
        p95: 3,
      }),
      sent: expect.objectContaining({
        count: 1,
        p50: 2,
        p95: 2,
      }),
    });
  });

  it('reports flow-control request stats as request attempts', () => {
    recordFlowRequest('pause');
    vi.advanceTimersByTime(5);
    recordFlowRequest('resume');
    vi.advanceTimersByTime(3);
    recordFlowRequest('resume');

    expect(getFlowRequestStats()).toEqual({
      avgPauseRequestWindowMs: expect.any(Number),
      pauseRequests: 1,
      resumeRequests: 2,
    });
  });

  it('supports typed round-trip probes without the direct write shortcut', async () => {
    const marker = startRoundTripProbe(5_000);

    expect(hasPendingProbes()).toBe(true);
    detectProbeInOutput(`echo ${marker}`);

    await expect(waitForRoundTripProbe(marker)).resolves.toBeGreaterThanOrEqual(0);
    expect(hasPendingProbes()).toBe(false);
  });

  it('cleans up settled marker probes even when callers never wait for them', () => {
    const marker = startRoundTripProbe(5_000);

    detectProbeInOutput(`echo ${marker}`);
    expect(hasPendingProbes()).toBe(false);

    vi.advanceTimersByTime(30_000);

    expect(() => assertTerminalLatencyStateCleanForTests()).not.toThrow();
  });

  it('attaches a browser diagnostics store when perf tracing is enabled', async () => {
    getRenderLatencyStats();

    expect(window.__parallelCodeTerminalLatency).toBeTruthy();
    expect(window.__parallelCodeTerminalLatency?.getSnapshot().render.count).toBe(0);

    const marker = window.__parallelCodeTerminalLatency?.startRoundTripProbe(5_000);
    expect(typeof marker).toBe('string');
    detectProbeInOutput(`echo ${marker}`);

    await expect(
      window.__parallelCodeTerminalLatency?.waitForRoundTripProbe(marker ?? ''),
    ).resolves.toBeGreaterThanOrEqual(0);
    expect(window.__parallelCodeTerminalLatency?.getSnapshot().roundTrip.count).toBe(1);

    window.__parallelCodeTerminalLatency?.reset();
    expect(window.__parallelCodeTerminalLatency?.getSnapshot().roundTrip.count).toBe(0);
  });
});
