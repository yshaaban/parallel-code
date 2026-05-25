import { afterEach, beforeEach, vi } from 'vitest';

class TestEvent {
  readonly type: string;

  constructor(type: string) {
    this.type = type;
  }
}

if (typeof globalThis.Event === 'undefined') {
  Object.defineProperty(globalThis, 'Event', {
    configurable: true,
    writable: true,
    value: TestEvent,
  });
}

class TestMessageEvent<T = unknown> extends Event {
  readonly data: T;

  constructor(type: string, init: { data: T }) {
    super(type);
    this.data = init.data;
  }
}

class TestCloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;

  constructor(type: string, init: { code?: number; reason?: string; wasClean?: boolean } = {}) {
    super(type);
    this.code = init.code ?? 1000;
    this.reason = init.reason ?? '';
    this.wasClean = init.wasClean ?? true;
  }
}

if (typeof globalThis.MessageEvent === 'undefined') {
  Object.defineProperty(globalThis, 'MessageEvent', {
    configurable: true,
    writable: true,
    value: TestMessageEvent,
  });
}

if (typeof globalThis.CloseEvent === 'undefined') {
  Object.defineProperty(globalThis, 'CloseEvent', {
    configurable: true,
    writable: true,
    value: TestCloseEvent,
  });
}

beforeEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
