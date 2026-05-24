// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { invokeMock, isElectronRuntimeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isElectronRuntimeMock: vi.fn(() => true),
  listenMock: vi.fn(),
}));

vi.mock('./ipc', () => ({
  invoke: invokeMock,
  isElectronRuntime: isElectronRuntimeMock,
  listen: listenMock,
}));

import { appWindow } from './window';

describe('appWindow close request handling', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let closeRequested: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    isElectronRuntimeMock.mockReturnValue(true);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    closeRequested = undefined;
    listenMock.mockImplementation((_channel, handler) => {
      closeRequested = handler;
      return vi.fn();
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('acknowledges prevented async close requests without force-closing', async () => {
    await appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
    });

    closeRequested?.();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith(IPC.WindowCloseHandled);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.WindowForceClose);
  });

  it('acknowledges prevented close requests before waiting on async follow-up work', async () => {
    let finishHandler!: () => void;
    const handlerDone = new Promise<void>((resolve) => {
      finishHandler = resolve;
    });

    await appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      await handlerDone;
    });

    closeRequested?.();

    expect(invokeMock.mock.calls).toEqual([[IPC.WindowCloseHandled]]);

    finishHandler();
    await Promise.resolve();

    expect(invokeMock.mock.calls).toEqual([[IPC.WindowCloseHandled]]);
  });

  it('acknowledges unprevented close requests before force-closing', async () => {
    await appWindow.onCloseRequested(() => {});

    closeRequested?.();

    expect(invokeMock.mock.calls).toEqual([[IPC.WindowCloseHandled], [IPC.WindowForceClose]]);
  });

  it('acknowledges failed async close requests before force-closing', async () => {
    await appWindow.onCloseRequested(async () => {
      throw new Error('close handler failed');
    });

    closeRequested?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock.mock.calls).toEqual([[IPC.WindowCloseHandled], [IPC.WindowForceClose]]);
  });
});
