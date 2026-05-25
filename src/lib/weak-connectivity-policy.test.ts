import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getWeakConnectivityReconnectDelayMs,
  isWarmReconnectWindow,
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

  it('requires a measured disconnected duration for warm restore skips', () => {
    expect(isWarmReconnectWindow(null)).toBe(false);
    expect(isWarmReconnectWindow(30_000)).toBe(true);
    expect(isWarmReconnectWindow(30_001)).toBe(false);
  });
});
