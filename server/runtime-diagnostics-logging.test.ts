import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getBackendRuntimeDiagnosticsSnapshot } from '../electron/ipc/runtime-diagnostics.js';
import {
  getRuntimeDiagnosticsLoggingConfigFromEnv,
  startRuntimeDiagnosticsLogging,
} from './runtime-diagnostics-logging.js';

describe('runtime diagnostics logging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('parses logging config from env', () => {
    expect(
      getRuntimeDiagnosticsLoggingConfigFromEnv({
        RUNTIME_DIAGNOSTICS_LOG_INTERVAL_MS: '5000',
        RUNTIME_DIAGNOSTICS_LOG_RESET: 'true',
      }),
    ).toEqual({
      intervalMs: 5000,
      resetAfterLog: true,
    });
    expect(getRuntimeDiagnosticsLoggingConfigFromEnv({})).toBeNull();
  });

  it('rejects invalid interval values', () => {
    expect(() =>
      getRuntimeDiagnosticsLoggingConfigFromEnv({
        RUNTIME_DIAGNOSTICS_LOG_INTERVAL_MS: '0',
      }),
    ).toThrow('RUNTIME_DIAGNOSTICS_LOG_INTERVAL_MS must be a positive number of milliseconds');
  });

  it('logs snapshots and optionally resets after each sample', async () => {
    const log = vi.fn();
    const resetSnapshot = vi.fn();
    const stop = startRuntimeDiagnosticsLogging({
      getSnapshot: () => getBackendRuntimeDiagnosticsSnapshot(),
      intervalMs: 1000,
      log,
      now: () => new Date('2026-03-17T12:00:00.000Z'),
      resetAfterLog: true,
      resetSnapshot,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('[runtime-diagnostics]');
    expect(log.mock.calls[0]?.[0]).toContain('"recordedAt":"2026-03-17T12:00:00.000Z"');
    expect(resetSnapshot).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
