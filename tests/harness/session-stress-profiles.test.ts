import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEmptyPhaseMetrics,
  getLocalServerStartupTimeoutMs,
  parseLocalServerReadyLine,
  summarizeWatcherResults,
  waitForLocalServerReady,
} from '../../scripts/session-stress.mjs';
import { evaluateSessionStressProfile } from '../../scripts/session-stress-profiles.mjs';

describe('session stress profiles', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails closed when a required metric is missing', () => {
    const result = {
      phases: {
        output: {
          wallClockMs: 1_000,
        },
        mixed: {
          metrics: {},
        },
      },
    };

    const evaluation = evaluateSessionStressProfile('pr_smoke', result);

    expect(evaluation.pass).toBe(false);
    expect(evaluation.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actual: Number.NaN,
          label: 'mixed max skew',
          pass: false,
        }),
      ]),
    );
  });

  it('parses only the explicit local server readiness line', () => {
    expect(
      parseLocalServerReadyLine('Parallel Code server listening on http://127.0.0.1:4173'),
    ).toEqual({
      port: 4173,
      url: 'http://127.0.0.1:4173/',
    });
    expect(parseLocalServerReadyLine('dependency listening on unix socket')).toBeNull();
  });

  it('normalizes invalid local server startup timeouts to the default', () => {
    expect(getLocalServerStartupTimeoutMs({ serverStartupTimeoutMs: 45_000 })).toBe(45_000);
    expect(getLocalServerStartupTimeoutMs({ serverStartupTimeoutMs: 0 })).toBe(30_000);
    expect(getLocalServerStartupTimeoutMs({})).toBe(30_000);
  });

  it('summarizes empty stress marker results with zero metrics', () => {
    expect(summarizeWatcherResults([])).toEqual(createEmptyPhaseMetrics());
  });

  it('terminates the local server process when startup readiness times out', async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const serverProcess = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill,
      signalCode: null,
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    });

    const ready = waitForLocalServerReady(serverProcess, {
      port: 4111,
      serverStartupTimeoutMs: 5,
    });
    const rejected = expect(ready).rejects.toThrow('Server startup timeout after 5ms');

    await vi.advanceTimersByTimeAsync(5);
    await rejected;
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });
});
