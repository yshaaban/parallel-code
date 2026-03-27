import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalFitLifecycle } from './terminalFitLifecycle';

describe('createTerminalFitLifecycle', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      return globalThis.setTimeout(() => callback(performance.now()), 0) as unknown as number;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((handle: number): void => {
      clearTimeout(handle);
    }) as typeof globalThis.cancelAnimationFrame;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it('keeps stabilizing after the first readiness wait times out', async () => {
    let measuredWidth = 0;
    let measuredHeight = 0;
    let cols = 0;
    let rows = 0;
    const onReady = vi.fn();

    const lifecycle = createTerminalFitLifecycle({
      fit: () => {
        if (measuredWidth <= 0 || measuredHeight <= 0) {
          return;
        }

        cols = 120;
        rows = 40;
      },
      getMeasuredSize: () => ({
        height: measuredHeight,
        width: measuredWidth,
      }),
      getTerminalSize: () => ({ cols, rows }),
      maxWaitMs: 50,
      onReady,
      retryIntervalMs: 10,
    });

    const firstReadyAttempt = lifecycle.ensureReady();
    await vi.advanceTimersByTimeAsync(60);

    await expect(firstReadyAttempt).resolves.toBe(false);
    expect(onReady).not.toHaveBeenCalled();

    measuredWidth = 1200;
    measuredHeight = 800;
    await vi.advanceTimersByTimeAsync(20);

    expect(onReady).toHaveBeenCalledTimes(1);
    await expect(lifecycle.ensureReady()).resolves.toBe(true);
  });
});
