import { afterEach, describe, expect, it, vi } from 'vitest';

import { installManualAnimationFrame } from './manual-animation-frame';

describe('manual-animation-frame', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not invoke a later callback canceled during the same frame flush', () => {
    const animationFrame = installManualAnimationFrame();
    const canceledCallback = vi.fn();
    let canceledHandle = 0;
    requestAnimationFrame(() => cancelAnimationFrame(canceledHandle));
    canceledHandle = requestAnimationFrame(canceledCallback);

    animationFrame.flush();

    expect(canceledCallback).not.toHaveBeenCalled();
  });

  it('defers callbacks scheduled during a flush until the next frame', () => {
    const animationFrame = installManualAnimationFrame();
    const nextFrameCallback = vi.fn();
    requestAnimationFrame(() => requestAnimationFrame(nextFrameCallback));

    animationFrame.flush();
    expect(nextFrameCallback).not.toHaveBeenCalled();
    expect(animationFrame.pendingCount()).toBe(1);

    animationFrame.flush();
    expect(nextFrameCallback).toHaveBeenCalledOnce();
  });
});
