// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import * as log from './log';

describe('renderer logger', () => {
  const originalElectron = window.electron;
  let invokeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    invokeMock = vi.fn(async () => undefined);
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        ipcRenderer: {
          invoke: invokeMock,
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        },
      },
    });
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    log.resetLoggerForTests();
  });

  afterEach(() => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: originalElectron,
    });
    vi.restoreAllMocks();
    vi.useRealTimers();
    log.resetLoggerForTests();
  });

  it('forwards warn and error entries to main by default', () => {
    log.warn('clipboard', 'copy failed', { taskId: 'task-1' });
    log.error('terminal', 'paste failed', new Error('no clipboard'));

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      IPC.LogFromRenderer,
      expect.objectContaining({
        category: 'clipboard',
        ctx: { taskId: 'task-1' },
        level: 'warn',
        msg: 'copy failed',
      }),
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      IPC.LogFromRenderer,
      expect.objectContaining({
        category: 'terminal',
        level: 'error',
        msg: 'paste failed',
      }),
    );
  });

  it('forwards info only when verbose logging is enabled', () => {
    log.info('ipc', 'cold start');
    expect(invokeMock).not.toHaveBeenCalled();

    log.setVerbose(true);
    log.info('ipc', 'cold start');

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.LogFromRenderer,
      expect.objectContaining({ category: 'ipc', level: 'info' }),
    );
  });

  it('rate limits noisy categories and emits one suppression notice', () => {
    for (let index = 0; index < 60; index += 1) {
      log.warn('rate-limit', `message ${index}`);
    }

    expect(invokeMock).toHaveBeenCalledTimes(50);
    vi.runAllTimers();

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.LogFromRenderer,
      expect.objectContaining({
        category: 'rate-limit',
        level: 'warn',
        msg: 'rate-limit suppressed 10 entries',
      }),
    );
  });

  it('cancels pending rate-limit notices during logger reset', () => {
    for (let index = 0; index < 60; index += 1) {
      log.warn('rate-limit', `message ${index}`);
    }

    expect(invokeMock).toHaveBeenCalledTimes(50);

    log.resetLoggerForTests();
    vi.runAllTimers();

    expect(invokeMock).toHaveBeenCalledTimes(50);
  });

  it('does not throw when the Electron bridge is unavailable', () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: undefined,
    });

    expect(() => log.warn('browser', 'bridge unavailable')).not.toThrow();
  });
});
