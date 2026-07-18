import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEmptyPhaseMetrics,
  getLocalServerStartupTimeoutMs,
  initializeLocalServerTarget,
  summarizeWatcherResults,
} from '../../scripts/session-stress.mjs';
import { evaluateSessionStressProfile } from '../../scripts/session-stress-profiles.mjs';

class FakeLocalServerProcess extends EventEmitter {
  exitCode: number | null = null;
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
}

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

  it('normalizes invalid local server startup timeouts to the default', () => {
    expect(getLocalServerStartupTimeoutMs({ serverStartupTimeoutMs: 45_000 })).toBe(45_000);
    expect(getLocalServerStartupTimeoutMs({ serverStartupTimeoutMs: 0 })).toBe(30_000);
    expect(getLocalServerStartupTimeoutMs({})).toBe(30_000);
  });

  it('summarizes empty stress marker results with zero metrics', () => {
    expect(summarizeWatcherResults([])).toEqual(createEmptyPhaseMetrics());
  });

  it('fails stress budgets when marker completion depends on recovery-required resets', () => {
    const metrics = summarizeWatcherResults([
      {
        bytes: 1,
        durationMs: 10,
        messageCount: 1,
        resetChannelCount: 1,
        resetMarkerCount: 1,
        timings: new Map([['marker-1', Number.POSITIVE_INFINITY]]),
      },
      {
        bytes: 1,
        durationMs: 10,
        messageCount: 1,
        resetChannelCount: 0,
        resetMarkerCount: 0,
        timings: new Map([['marker-1', 10]]),
      },
    ]);

    expect(metrics.maxSkewMs).toBe(Number.POSITIVE_INFINITY);

    const evaluation = evaluateSessionStressProfile('pr_smoke', {
      phases: {
        mixed: { metrics },
        output: {
          diagnostics: { browserControl: { backpressureRejects: 0 } },
          wallClockMs: 1,
        },
      },
    });

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

  it('stops the local server process when startup readiness times out', async () => {
    vi.useFakeTimers();
    const serverProcess = new FakeLocalServerProcess();
    serverProcess.kill.mockImplementationOnce((signal) => {
      serverProcess.signalCode = signal as NodeJS.Signals;
      serverProcess.emit('exit', null, serverProcess.signalCode);
      return true;
    });

    const startup = initializeLocalServerTarget(serverProcess, { serverStartupTimeoutMs: 5 }, 4111);
    const rejected = expect(startup).rejects.toThrow(
      'Standalone server did not report readiness within 5ms',
    );

    await vi.advanceTimersByTimeAsync(5);
    await rejected;
    expect(serverProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(serverProcess.listenerCount('error')).toBe(0);
    expect(serverProcess.listenerCount('exit')).toBe(0);
  });

  it('stops the local server when client setup fails after readiness', async () => {
    const serverProcess = new FakeLocalServerProcess();
    serverProcess.kill.mockReturnValueOnce(false);
    const createClient = vi.fn(() => {
      throw new Error('client setup failed');
    });

    const startup = initializeLocalServerTarget(serverProcess, {}, 4111, { createClient });
    serverProcess.stdout.emit(
      'data',
      Buffer.from('Parallel Code server listening on http://127.0.0.1:4111\n'),
    );

    await expect(startup).rejects.toThrow('client setup failed');
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'http://127.0.0.1:4111' }),
    );
    expect(serverProcess.kill).toHaveBeenCalledTimes(1);
    expect(serverProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(serverProcess.listenerCount('error')).toBe(0);
    expect(serverProcess.listenerCount('exit')).toBe(0);
  });

  it('preserves startup and server-stop failures together', async () => {
    const serverProcess = new FakeLocalServerProcess();
    const startupError = new Error('readiness failed');
    const stopError = new Error('server stop failed');
    const stopProcess = vi.fn().mockRejectedValue(stopError);

    const failure = await initializeLocalServerTarget(serverProcess, {}, 4111, {
      stopProcess,
      waitForReady: vi.fn().mockRejectedValue(startupError),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      'Local stress server initialization operation and cleanup failed',
    );
    expect((failure as AggregateError).errors).toEqual([
      startupError,
      expect.objectContaining({
        cause: stopError,
        message: 'stop incomplete local server: server stop failed',
      }),
    ]);
    expect(stopProcess).toHaveBeenCalledOnce();
  });

  it('handles shutdown errors and detaches post-startup output drains', async () => {
    const serverProcess = new FakeLocalServerProcess();
    serverProcess.kill.mockImplementationOnce(() => {
      serverProcess.emit('error', new Error('signal delivery failed'));
      return true;
    });

    const startup = initializeLocalServerTarget(serverProcess, {}, 4111, {
      createClient: () => ({ baseUrl: 'http://127.0.0.1:4111/' }),
    });
    serverProcess.stdout.emit(
      'data',
      Buffer.from('Parallel Code server listening on http://127.0.0.1:4111\n'),
    );
    const target = await startup;

    expect(serverProcess.stdout.listenerCount('data')).toBe(1);
    expect(serverProcess.stderr.listenerCount('data')).toBe(1);
    await expect(target.stop()).resolves.toBeUndefined();
    expect(serverProcess.stdout.listenerCount('data')).toBe(0);
    expect(serverProcess.stderr.listenerCount('data')).toBe(0);
    expect(serverProcess.listenerCount('error')).toBe(0);
    expect(serverProcess.listenerCount('exit')).toBe(0);
  });
});
