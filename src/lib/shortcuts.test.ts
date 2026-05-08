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

  it('fires global task-position digit shortcuts with and without Shift', () => {
    const handler = vi.fn();
    const unregisterPlain = registerShortcut({
      cmdOrCtrl: true,
      global: true,
      handler,
      key: '1',
    });
    const unregisterShift = registerShortcut({
      cmdOrCtrl: true,
      global: true,
      handler,
      key: '2',
      shift: true,
    });
    const cleanup = initShortcuts();

    const plainEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: '1',
      metaKey: true,
    });
    document.body.dispatchEvent(plainEvent);

    const shiftEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'Digit2',
      key: '@',
      metaKey: true,
      shiftKey: true,
    });
    document.body.dispatchEvent(shiftEvent);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(plainEvent.defaultPrevented).toBe(true);
    expect(shiftEvent.defaultPrevented).toBe(true);

    cleanup();
    unregisterPlain();
    unregisterShift();
  });
});
