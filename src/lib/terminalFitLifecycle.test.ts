import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalFitLifecycle } from './terminalFitLifecycle.js';

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = () => {
      innerResolve();
    };
  });
  return { promise, resolve };
}

describe('terminal fit lifecycle', () => {
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      return Number(
        globalThis.setTimeout(() => {
          callback(performance.now());
        }, 0),
      );
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((handle: number): void => {
      clearTimeout(handle);
    }) as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
      writable: true,
    });
  });

  it('resolves immediately when the first fit produces a valid viewport', async () => {
    const onReady = vi.fn();
    let measuredSize = { height: 240, width: 320 };
    let terminalSize = { cols: 80, rows: 24 };
    const fit = vi.fn(() => {
      measuredSize = { height: 240, width: 320 };
      terminalSize = { cols: 80, rows: 24 };
    });

    const lifecycle = createTerminalFitLifecycle({
      fit,
      getMeasuredSize: () => measuredSize,
      getTerminalSize: () => terminalSize,
      onReady,
    });

    lifecycle.scheduleStabilize();
    await expect(lifecycle.ensureReady()).resolves.toBe(true);

    expect(fit).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('retries and resolves when font readiness produces a valid fit', async () => {
    const fontsReady = createDeferred();
    let fontsLoaded = false;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        fonts: {
          ready: fontsReady.promise,
        },
      },
      writable: true,
    });

    const onReady = vi.fn();
    const fit = vi.fn(() => {});
    const lifecycle = createTerminalFitLifecycle({
      fit,
      getMeasuredSize: () => ({
        height: fontsLoaded ? 240 : 0,
        width: fontsLoaded ? 320 : 0,
      }),
      getTerminalSize: () => ({
        cols: fontsLoaded ? 80 : 0,
        rows: fontsLoaded ? 24 : 0,
      }),
      onReady,
      retryIntervalMs: 100,
    });

    lifecycle.scheduleStabilize();
    await vi.advanceTimersByTimeAsync(32);
    expect(onReady).not.toHaveBeenCalled();

    fontsLoaded = true;
    fontsReady.resolve();
    await Promise.resolve();
    await expect(lifecycle.ensureReady()).resolves.toBe(true);

    expect(fit).toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('falls back without notifying ready when sizing never becomes valid', async () => {
    const onReady = vi.fn();
    const fit = vi.fn(() => {});
    const lifecycle = createTerminalFitLifecycle({
      fit,
      getMeasuredSize: () => ({
        height: 0,
        width: 0,
      }),
      getTerminalSize: () => ({
        cols: 0,
        rows: 0,
      }),
      maxWaitMs: 100,
      onReady,
      retryIntervalMs: 25,
    });

    lifecycle.scheduleStabilize();
    await vi.advanceTimersByTimeAsync(100);
    await expect(lifecycle.ensureReady()).resolves.toBe(false);

    expect(fit).toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });
});
