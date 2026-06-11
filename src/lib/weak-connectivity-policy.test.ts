import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getWeakConnectivityReconnectDelayMs,
  WAKE_LIVENESS_PROBE,
} from './weak-connectivity-policy';

describe('weak connectivity reconnect policy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the fast reconnect table after a fresh disconnect from a long-lived connection', () => {
    vi.useFakeTimers();
    vi.setSystemTime(120_000);

    expect(
      getWeakConnectivityReconnectDelayMs(0, {
        hasConnected: true,
        lastConnectedAt: 0,
        lastConnectionDurationMs: 120_000,
        lastDisconnectedAt: 120_000,
        lastDisconnectReason: 'close',
        lastRttMs: null,
      }),
    ).toBe(0);
  });

  it('bounds wake-time zombie-socket detection with an explicit probe policy', () => {
    expect(WAKE_LIVENESS_PROBE.minHiddenGapMs).toBe(5_000);
    expect(WAKE_LIVENESS_PROBE.probeDeadlineMs).toBe(2_000);
  });
});
