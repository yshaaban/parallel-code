import { afterEach, describe, expect, it } from 'vitest';

import { getInitialTerminalHighLoadModeEnabled } from './terminal-high-load-mode-bootstrap';

describe('terminal-high-load-mode-bootstrap', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('defaults High Load Mode on in browser runtimes when no explicit override exists', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });

    expect(getInitialTerminalHighLoadModeEnabled()).toBe(true);
  });

  it('keeps High Load Mode off outside browser runtimes', () => {
    Reflect.deleteProperty(globalThis, 'window');

    expect(getInitialTerminalHighLoadModeEnabled()).toBe(false);
  });

  it('respects an explicit bootstrap false override', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__: false,
      },
    });

    expect(getInitialTerminalHighLoadModeEnabled()).toBe(false);
  });
});
