import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ipc', () => ({
  invoke: vi.fn(),
}));

import { invoke } from './ipc';
import {
  assertTerminalLatencyStateCleanForTests,
  detectProbeInOutput,
  detectRenderedProbeInOutput,
  getBrowserControlSendStats,
  getFlowRequestStats,
  getInputStageStats,
  getRenderLatencyStats,
  hasPendingProbeRenders,
  hasPendingProbes,
  measureRoundTrip,
  recordBrowserControlSendBufferedAmount,
  recordBrowserControlSendCompleted,
  recordFlowRequest,
  recordInputAccepted,
  recordInputBuffered,
  recordInputCommandResultReceived,
  recordInputDispatched,
  recordInputLeaseRequested,
  recordInputLeaseResolved,
  recordInputQueued,
  recordInputSent,
  resetBrowserControlSendStats,
  resetFlowEvents,
  resetInputStageSamples,
  resetRoundTripSamples,
  startRoundTripProbe,
  waitForRenderedRoundTripProbe,
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
    resetBrowserControlSendStats();
    resetFlowEvents();
    resetInputStageSamples();
    resetRoundTripSamples();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    resetBrowserControlSendStats();
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
    expect(hasPendingProbeRenders()).toBe(true);
    detectRenderedProbeInOutput(marker);
    expect(hasPendingProbeRenders()).toBe(false);

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

  it('times out rendered probe waits when output settles before the IPC write resolves', async () => {
    let resolveWrite: ((value?: undefined) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveWrite = () => resolve(undefined);
        }),
    );

    const probePromise = measureRoundTrip('agent-4', 100);
    const request = vi.mocked(invoke).mock.calls[0]?.[1] as { data: string };
    const marker = request.data.slice('echo '.length, -1);

    detectProbeInOutput(marker);

    await expect(probePromise).resolves.toBeGreaterThanOrEqual(0);
    expect(hasPendingProbes()).toBe(false);
    expect(hasPendingProbeRenders()).toBe(true);

    const renderedProbePromise = waitForRenderedRoundTripProbe(marker);
    vi.advanceTimersByTime(100);

    await expect(renderedProbePromise).resolves.toBe(-1);
    expect(hasPendingProbeRenders()).toBe(false);

    resolveWrite?.();
    await Promise.resolve();
  });

  it('tracks input buffer and send stage timings when perf is enabled', () => {
    const queueTs = recordInputQueued();

    vi.advanceTimersByTime(3);
    const bufferedTs = recordInputBuffered(queueTs);

    vi.advanceTimersByTime(5);
    const leaseRequestedTs = recordInputLeaseRequested();
    vi.advanceTimersByTime(7);
    recordInputLeaseResolved(leaseRequestedTs);

    vi.advanceTimersByTime(2);
    const dispatchedTs = recordInputDispatched(bufferedTs);

    vi.advanceTimersByTime(4);
    const commandResultReceivedAt = recordInputCommandResultReceived(
      dispatchedTs,
      performance.now(),
    );

    vi.advanceTimersByTime(1);
    recordInputAccepted(dispatchedTs, commandResultReceivedAt);
    recordInputSent(bufferedTs);

    expect(getInputStageStats()).toEqual({
      accepted: expect.objectContaining({
        count: 1,
        p50: 5,
        p95: 5,
      }),
      acceptedSettled: expect.objectContaining({
        count: 1,
        p50: 1,
        p95: 1,
      }),
      buffered: expect.objectContaining({
        count: 1,
        p50: 3,
        p95: 3,
      }),
      commandResultReceived: expect.objectContaining({
        count: 1,
        p50: 4,
        p95: 4,
      }),
      dispatched: expect.objectContaining({
        count: 1,
        p50: 14,
        p95: 14,
      }),
      leaseWait: expect.objectContaining({
        count: 1,
        p50: 7,
        p95: 7,
      }),
      sent: expect.objectContaining({
        count: 1,
        p50: 19,
        p95: 19,
      }),
    });
  });

  it('tracks browser control send buffer pressure when perf is enabled', () => {
    recordBrowserControlSendBufferedAmount('input', 0);
    recordBrowserControlSendCompleted('input', 0.25, 256);
    recordBrowserControlSendBufferedAmount('input', 128);
    recordBrowserControlSendCompleted('input', 0.5, 512);
    recordBrowserControlSendBufferedAmount('resize', 64);
    recordBrowserControlSendCompleted('resize', 0.75, 128);
    recordBrowserControlSendBufferedAmount('input', Number.NaN);
    recordBrowserControlSendBufferedAmount('input', -1);
    recordBrowserControlSendCompleted('input', Number.NaN, 10);
    recordBrowserControlSendCompleted('input', 1, -1);

    expect(getBrowserControlSendStats()).toEqual({
      byType: {
        input: {
          nonZeroBufferedSendAttempts: 1,
          postSendBufferedAmountMax: 512,
          sendAttempts: 2,
          sendBufferedAmountMax: 128,
          sendDurationMs: expect.objectContaining({
            count: 2,
            p95: 0.5,
          }),
        },
        resize: {
          nonZeroBufferedSendAttempts: 1,
          postSendBufferedAmountMax: 128,
          sendAttempts: 1,
          sendBufferedAmountMax: 64,
          sendDurationMs: expect.objectContaining({
            count: 1,
            p95: 0.75,
          }),
        },
      },
      nonZeroBufferedSendAttempts: 2,
      postSendBufferedAmountMax: 512,
      sendAttempts: 3,
      sendBufferedAmountMax: 128,
      sendDurationMs: expect.objectContaining({
        count: 3,
        p95: 0.75,
      }),
    });

    resetBrowserControlSendStats();

    expect(getBrowserControlSendStats()).toEqual({
      byType: {},
      nonZeroBufferedSendAttempts: 0,
      postSendBufferedAmountMax: 0,
      sendAttempts: 0,
      sendBufferedAmountMax: 0,
      sendDurationMs: expect.objectContaining({
        count: 0,
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
    expect(hasPendingProbeRenders()).toBe(true);
    detectRenderedProbeInOutput(`echo ${marker}`);
    await expect(waitForRenderedRoundTripProbe(marker)).resolves.toBeGreaterThanOrEqual(0);
    expect(hasPendingProbeRenders()).toBe(false);
  });

  it('cleans up settled marker probes even when callers never wait for them', () => {
    const marker = startRoundTripProbe(5_000);

    detectProbeInOutput(`echo ${marker}`);
    detectRenderedProbeInOutput(`echo ${marker}`);
    expect(hasPendingProbes()).toBe(false);
    expect(hasPendingProbeRenders()).toBe(false);

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
    detectRenderedProbeInOutput(`echo ${marker}`);

    await expect(
      window.__parallelCodeTerminalLatency?.waitForRoundTripProbe(marker ?? ''),
    ).resolves.toBeGreaterThanOrEqual(0);
    await expect(
      window.__parallelCodeTerminalLatency?.waitForRenderedRoundTripProbe(marker ?? ''),
    ).resolves.toBeGreaterThanOrEqual(0);
    expect(window.__parallelCodeTerminalLatency?.getSnapshot().roundTrip.count).toBe(1);
    expect(window.__parallelCodeTerminalLatency?.getSnapshot().renderedRoundTrip.count).toBe(1);

    window.__parallelCodeTerminalLatency?.reset();
    expect(window.__parallelCodeTerminalLatency?.getSnapshot().roundTrip.count).toBe(0);
    expect(window.__parallelCodeTerminalLatency?.getSnapshot().renderedRoundTrip.count).toBe(0);
  });
});
