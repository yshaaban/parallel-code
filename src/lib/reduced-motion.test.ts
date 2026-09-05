import { afterEach, describe, expect, it, vi } from 'vitest';

import { shouldAnimateTaskAppearance } from './reduced-motion';

const originalWindow = globalThis.window;

function installMatchMedia(matches: boolean): ReturnType<typeof vi.fn> {
  const matchMedia = vi.fn(() => ({ matches }));
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { matchMedia },
  });
  return matchMedia;
}

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('shouldAnimateTaskAppearance', () => {
  it('omits appearance motion when the current browser preference requests reduction', () => {
    const matchMedia = installMatchMedia(true);

    expect(shouldAnimateTaskAppearance()).toBe(false);
    expect(matchMedia).toHaveBeenCalledOnce();
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('preserves appearance motion for no-preference', () => {
    installMatchMedia(false);
    expect(shouldAnimateTaskAppearance()).toBe(true);
  });

  it('preserves existing behavior when window or matchMedia is unavailable', () => {
    Reflect.deleteProperty(globalThis, 'window');
    expect(shouldAnimateTaskAppearance()).toBe(true);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    expect(shouldAnimateTaskAppearance()).toBe(true);
  });

  it('fails open without retaining a broken media query object', () => {
    const matchMedia = vi.fn(() => {
      throw new Error('media API unavailable');
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { matchMedia },
    });

    expect(shouldAnimateTaskAppearance()).toBe(true);
    expect(shouldAnimateTaskAppearance()).toBe(true);
    expect(matchMedia).toHaveBeenCalledTimes(2);
  });
});
