import { describe, expect, it } from 'vitest';
import { getTerminalShortcutAction } from './terminal-shortcuts';

function createShortcutEvent(
  key: string,
  overrides: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }> = {},
) {
  return {
    altKey: false,
    ctrlKey: false,
    key,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe('terminal shortcuts', () => {
  it('treats browser-mode primary paste as terminal paste on macOS', () => {
    expect(
      getTerminalShortcutAction(createShortcutEvent('v', { metaKey: true }), {
        browserMode: true,
        hasSelection: false,
        isMac: true,
      }),
    ).toEqual({
      kind: 'paste',
      preventDefault: true,
    });
  });

  it('treats browser-mode primary paste as terminal paste on Windows/Linux', () => {
    expect(
      getTerminalShortcutAction(createShortcutEvent('v', { ctrlKey: true }), {
        browserMode: true,
        hasSelection: false,
        isMac: false,
      }),
    ).toEqual({
      kind: 'paste',
      preventDefault: true,
    });
  });

  it('keeps explicit terminal paste working in browser mode on Windows/Linux', () => {
    expect(
      getTerminalShortcutAction(
        createShortcutEvent('v', {
          ctrlKey: true,
          shiftKey: true,
        }),
        {
          browserMode: true,
          hasSelection: false,
          isMac: false,
        },
      ),
    ).toEqual({
      kind: 'paste',
      preventDefault: true,
    });
  });

  it('lets browser copy handle primary copy with a selection in browser mode', () => {
    expect(
      getTerminalShortcutAction(createShortcutEvent('c', { ctrlKey: true }), {
        browserMode: true,
        hasSelection: true,
        isMac: false,
      }),
    ).toEqual({
      kind: 'block',
      preventDefault: false,
    });
  });

  it('keeps browser find available in browser mode', () => {
    expect(
      getTerminalShortcutAction(createShortcutEvent('f', { ctrlKey: true }), {
        browserMode: true,
        hasSelection: false,
        isMac: false,
      }),
    ).toEqual({
      kind: 'block',
      preventDefault: false,
    });
  });

  it('keeps non-browser primary paste working on Windows/Linux', () => {
    expect(
      getTerminalShortcutAction(createShortcutEvent('v', { ctrlKey: true }), {
        browserMode: false,
        hasSelection: false,
        isMac: false,
      }),
    ).toEqual({
      kind: 'paste',
      preventDefault: true,
    });
  });
});
