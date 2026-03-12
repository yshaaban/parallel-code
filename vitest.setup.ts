import { cleanup } from '@solidjs/testing-library';
import { afterEach } from 'vitest';

if (typeof window !== 'undefined') {
  window.requestAnimationFrame ??= ((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame ??= ((handle: number) => {
    window.clearTimeout(handle);
  }) as typeof window.cancelAnimationFrame;
}

if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView ??= () => {};
}

if (typeof globalThis.CSS === 'undefined') {
  globalThis.CSS = { escape: (value: string) => value } as typeof CSS;
}

afterEach(() => {
  cleanup();
});
