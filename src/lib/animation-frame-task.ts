export interface AnimationFrameTask {
  cancel: () => void;
  schedule: (callback: FrameRequestCallback) => void;
}

export function createAnimationFrameTask(): AnimationFrameTask {
  let frame: number | null = null;

  function cancel(): void {
    if (frame === null) {
      return;
    }

    cancelAnimationFrame(frame);
    frame = null;
  }

  function schedule(callback: FrameRequestCallback): void {
    cancel();
    frame = requestAnimationFrame((timestamp) => {
      frame = null;
      callback(timestamp);
    });
  }

  return { cancel, schedule };
}
