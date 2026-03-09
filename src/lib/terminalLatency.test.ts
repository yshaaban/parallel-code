import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ipc', () => ({
  invoke: vi.fn(),
}));

import { invoke } from './ipc';
import {
  detectProbeInOutput,
  hasPendingProbes,
  measureRoundTrip,
  resetRoundTripSamples,
} from './terminalLatency';

describe('terminalLatency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockReset();
    resetRoundTripSamples();
  });

  afterEach(() => {
    resetRoundTripSamples();
    vi.useRealTimers();
  });

  it('registers probes before the write promise resolves', async () => {
    let resolveWrite: (() => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
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
});
