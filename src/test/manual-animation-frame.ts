import { vi } from 'vitest';

interface ManualAnimationFrame {
  cancelAnimationFrameMock: ReturnType<typeof vi.fn>;
  flush: () => void;
  pendingCount: () => number;
  requestAnimationFrameMock: ReturnType<typeof vi.fn>;
}

export function installManualAnimationFrame(): ManualAnimationFrame {
  let nextFrame = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback): number => {
    const frame = nextFrame;
    nextFrame += 1;
    callbacks.set(frame, callback);
    return frame;
  });
  const cancelAnimationFrameMock = vi.fn((frame: number): void => {
    callbacks.delete(frame);
  });

  vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
  vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);

  return {
    cancelAnimationFrameMock,
    flush: () => {
      for (const [frame, callback] of Array.from(callbacks.entries())) {
        callbacks.delete(frame);
        callback(16);
      }
    },
    pendingCount: () => callbacks.size,
    requestAnimationFrameMock,
  };
}
