// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

const { isElectronRuntimeMock } = vi.hoisted(() => ({
  isElectronRuntimeMock: vi.fn(() => false),
}));

vi.mock('./ipc', () => ({
  isElectronRuntime: isElectronRuntimeMock,
}));

import { initShortcuts, registerShortcut } from './shortcuts';

describe('shortcuts', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('fires a dialog-safe shortcut from a focused textarea when a dialog overlay is open', () => {
    const handler = vi.fn();
    const unregister = registerShortcut({
      dialogSafe: true,
      handler,
      key: 'Escape',
    });
    const cleanup = initShortcuts();

    const dialogOverlay = document.createElement('div');
    dialogOverlay.className = 'dialog-overlay';
    const input = document.createElement('textarea');
    document.body.append(dialogOverlay, input);
    input.focus();

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });
    input.dispatchEvent(event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);

    cleanup();
    unregister();
  });

  it('does not fire a non-global shortcut from a focused textarea when no dialog is open', () => {
    const handler = vi.fn();
    const unregister = registerShortcut({
      dialogSafe: true,
      handler,
      key: 'Escape',
    });
    const cleanup = initShortcuts();

    const input = document.createElement('textarea');
    document.body.append(input);
    input.focus();

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });
    input.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    cleanup();
    unregister();
  });
});
