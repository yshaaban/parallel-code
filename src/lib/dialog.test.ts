// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, isElectronRuntimeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isElectronRuntimeMock: vi.fn(() => false),
}));

vi.mock('./ipc', () => ({
  invoke: invokeMock,
  isElectronRuntime: isElectronRuntimeMock,
}));

import {
  clearConfirmNotifier,
  confirm,
  getPendingConfirm,
  registerConfirmNotifier,
  resolvePendingConfirm,
} from './dialog';

describe('dialog confirm helpers', () => {
  let originalConfirm: typeof window.confirm;

  beforeEach(() => {
    vi.clearAllMocks();
    isElectronRuntimeMock.mockReturnValue(false);
    clearConfirmNotifier();
    originalConfirm = window.confirm;
  });

  afterEach(() => {
    window.confirm = originalConfirm;
    clearConfirmNotifier();
  });

  it('falls back to window.confirm in browser mode when no dialog host is registered', async () => {
    const confirmSpy = vi.fn(() => true);
    window.confirm = confirmSpy;

    await expect(confirm('Delete this task?')).resolves.toBe(true);
    expect(confirmSpy).toHaveBeenCalledWith('Delete this task?');
  });

  it('routes browser confirms through the pending confirm host when registered', async () => {
    const notify = vi.fn();
    registerConfirmNotifier(notify);

    const resultPromise = confirm('Take over this task?', {
      cancelLabel: 'Cancel',
      okLabel: 'Take Over',
      title: 'Task In Use',
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(getPendingConfirm()).toMatchObject({
      message: 'Take over this task?',
      options: {
        cancelLabel: 'Cancel',
        okLabel: 'Take Over',
        title: 'Task In Use',
      },
    });

    resolvePendingConfirm(true);

    await expect(resultPromise).resolves.toBe(true);
    expect(getPendingConfirm()).toBeNull();
  });

  it('resolves pending browser confirms as false when the host unregisters', async () => {
    registerConfirmNotifier(() => {});

    const resultPromise = confirm('Take over this task?');
    expect(getPendingConfirm()).not.toBeNull();

    clearConfirmNotifier();

    await expect(resultPromise).resolves.toBe(false);
    expect(getPendingConfirm()).toBeNull();
  });
});
