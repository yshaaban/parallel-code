import { afterEach, describe, expect, it } from 'vitest';

import {
  getTerminalVisibilityDensity,
  getVisibleTerminalCount,
  registerTerminalVisibility,
  resetTerminalVisibleSetForTests,
} from './terminal-visible-set';

afterEach(() => {
  resetTerminalVisibleSetForTests();
});

describe('terminal-visible-set', () => {
  it('tracks visible terminal density from live registrations', () => {
    const focused = registerTerminalVisibility('focused', {
      isFocused: true,
      isSelected: true,
      isVisible: true,
    });
    const visibleBackground = registerTerminalVisibility('visible-background', {
      isFocused: false,
      isSelected: false,
      isVisible: true,
    });
    const hidden = registerTerminalVisibility('hidden', {
      isFocused: false,
      isSelected: false,
      isVisible: false,
    });

    expect(getVisibleTerminalCount()).toBe(2);
    expect(getTerminalVisibilityDensity()).toBe('few');

    visibleBackground.update({
      isFocused: false,
      isSelected: false,
      isVisible: false,
    });

    expect(getVisibleTerminalCount()).toBe(1);
    expect(getTerminalVisibilityDensity()).toBe('single');

    focused.unregister();
    visibleBackground.unregister();
    hidden.unregister();
  });
});
