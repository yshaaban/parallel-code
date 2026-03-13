import { cleanup } from '@solidjs/testing-library';
import { afterEach } from 'vitest';

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  binaryType: BinaryType = 'blob';
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent<string | ArrayBuffer | Blob>) => unknown) | null =
    null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  readyState = TestWebSocket.CONNECTING;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      if (this.readyState !== TestWebSocket.CONNECTING) {
        return;
      }
      this.readyState = TestWebSocket.OPEN;
      this.onopen?.call(this as unknown as WebSocket, new Event('open'));
    });
  }

  close(code = 1000): void {
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }

    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent);
  }

  send(): void {}
}

if (typeof window !== 'undefined') {
  window.requestAnimationFrame ??= ((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame ??= ((handle: number) => {
    window.clearTimeout(handle);
  }) as typeof window.cancelAnimationFrame;
  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    writable: true,
    value: TestWebSocket,
  });
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: TestWebSocket,
  });
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
