import { describe, expect, it } from 'vitest';
import { getTerminalShortcutAction } from './terminal-shortcuts';

function createShortcutEvent(
  key: string,
  overrides: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    type: string;
  }> = {},
) {
  return {
    altKey: false,
    ctrlKey: false,
    key,
    metaKey: false,
    shiftKey: false,
    type: 'keydown',
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

  it('maps Shift+Enter to Alt+Enter and suppresses its keyup echo', () => {
    expect(
      getTerminalShortcutAction(createShortcutEvent('Enter', { shiftKey: true }), {
        browserMode: false,
        hasSelection: false,
        isMac: false,
      }),
    ).toEqual({
      data: '\x1b\r',
      kind: 'send-input',
      preventDefault: true,
    });

    expect(
      getTerminalShortcutAction(createShortcutEvent('Enter', { shiftKey: true, type: 'keyup' }), {
        browserMode: false,
        hasSelection: false,
        isMac: false,
      }),
    ).toEqual({
      kind: 'block',
      preventDefault: false,
    });
  });

  it('maps macOS Cmd+ArrowLeft/Right to Home/End without affecting Linux word-jump', () => {
    expect(
      getTerminalShortcutAction(createShortcutEvent('ArrowLeft', { metaKey: true }), {
        browserMode: false,
        hasSelection: false,
        isMac: true,
      }),
    ).toEqual({
      data: '\x1b[H',
      kind: 'send-input',
      preventDefault: true,
    });

    expect(
      getTerminalShortcutAction(createShortcutEvent('ArrowRight', { metaKey: true }), {
        browserMode: false,
        hasSelection: false,
        isMac: true,
      }),
    ).toEqual({
      data: '\x1b[F',
      kind: 'send-input',
      preventDefault: true,
    });

    expect(
      getTerminalShortcutAction(createShortcutEvent('ArrowLeft', { ctrlKey: true }), {
        browserMode: false,
        hasSelection: false,
        isMac: false,
      }),
    ).toEqual({
      kind: 'allow',
      preventDefault: false,
    });
  });

  it('maps primary shift arrows and page keys to terminal scrollback actions', () => {
    expect(
      getTerminalShortcutAction(createShortcutEvent('ArrowUp', { ctrlKey: true, shiftKey: true }), {
        browserMode: true,
        hasSelection: false,
        isMac: false,
      }),
    ).toEqual({
      delta: -1,
      kind: 'scrollback',
      preventDefault: true,
      unit: 'line',
    });

    expect(
      getTerminalShortcutAction(
        createShortcutEvent('PageDown', { metaKey: true, shiftKey: true }),
        {
          browserMode: false,
          hasSelection: false,
          isMac: true,
        },
      ),
    ).toEqual({
      delta: 1,
      kind: 'scrollback',
      preventDefault: true,
      unit: 'page',
    });
  });
});
