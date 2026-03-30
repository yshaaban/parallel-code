// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { invokeMock, isElectronRuntimeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isElectronRuntimeMock: vi.fn(() => false),
}));

vi.mock('./ipc', () => ({
  invoke: invokeMock,
  isElectronRuntime: isElectronRuntimeMock,
}));

import {
  clearPathInputNotifier,
  clearConfirmNotifier,
  confirm,
  getPendingConfirm,
  getPendingPathInput,
  openDialog,
  registerConfirmNotifier,
  registerPathInputNotifier,
  resolvePendingConfirm,
  resolvePendingPathInput,
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
    clearPathInputNotifier();
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

describe('dialog open helpers', () => {
  let originalPrompt: typeof window.prompt;

  beforeEach(() => {
    vi.clearAllMocks();
    isElectronRuntimeMock.mockReturnValue(false);
    clearPathInputNotifier();
    originalPrompt = window.prompt;
  });

  afterEach(() => {
    window.prompt = originalPrompt;
    clearPathInputNotifier();
  });

  it('uses the native Electron dialog for ordinary paths in Electron runtime', async () => {
    isElectronRuntimeMock.mockReturnValue(true);
    invokeMock.mockResolvedValue('/repo');

    await expect(openDialog({ directory: true, multiple: false })).resolves.toBe('/repo');

    expect(invokeMock).toHaveBeenCalledWith(IPC.DialogOpen, {
      directory: true,
      multiple: false,
    });
  });

  it('routes SSH clone requests through the custom path input host in Electron runtime', async () => {
    isElectronRuntimeMock.mockReturnValue(true);
    const notify = vi.fn();
    registerPathInputNotifier(notify);

    const resultPromise = openDialog({ allowSshClone: true, directory: true, multiple: false });

    expect(invokeMock).not.toHaveBeenCalledWith(IPC.DialogOpen, expect.anything());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(getPendingPathInput()).toMatchObject({
      options: {
        allowSshClone: true,
        directory: true,
        multiple: false,
      },
    });

    resolvePendingPathInput('git@github.com:user/repo.git');

    await expect(resultPromise).resolves.toBe('git@github.com:user/repo.git');
  });

  it('falls back to a prompt that mentions SSH URLs when no host is registered', async () => {
    const promptSpy = vi.fn(() => 'git@github.com:user/repo.git');
    window.prompt = promptSpy;

    await expect(
      openDialog({ allowSshClone: true, directory: true, multiple: false }),
    ).resolves.toBe('git@github.com:user/repo.git');

    expect(promptSpy).toHaveBeenCalledWith(
      'Enter an absolute path or a git SSH URL on the server host',
    );
  });
});
