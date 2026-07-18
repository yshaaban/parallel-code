import { describe, expect, it, vi } from 'vitest';

import {
  DesktopRuntimeCleanupError,
  finishDesktopRuntimeShutdown,
  settleDesktopRuntimeCleanupOwners,
} from './runtime-cleanup.js';

describe('desktop runtime cleanup', () => {
  it('waits for every owner and rejects with every labeled failure', async () => {
    let rejectCoordinator: (error: unknown) => void = () => {};
    let rejectAskAboutCode: (error: unknown) => void = () => {};
    const coordinatorError = new Error('coordinator cleanup failed');
    const askAboutCodeError = new Error('ask cleanup failed');
    const coordinatorCleanup = new Promise<void>((_resolve, reject) => {
      rejectCoordinator = reject;
    });
    const askAboutCodeCleanup = new Promise<void>((_resolve, reject) => {
      rejectAskAboutCode = reject;
    });
    const cleanup = settleDesktopRuntimeCleanupOwners([
      { cleanup: coordinatorCleanup, label: 'coordinator' },
      { cleanup: Promise.resolve(), label: 'agent runner' },
      { cleanup: askAboutCodeCleanup, label: 'ask about code' },
    ]);
    let cleanupSettled = false;
    void cleanup.then(
      () => {
        cleanupSettled = true;
      },
      () => {
        cleanupSettled = true;
      },
    );

    rejectCoordinator(coordinatorError);
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    rejectAskAboutCode(askAboutCodeError);
    const error = await cleanup.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DesktopRuntimeCleanupError);
    expect((error as DesktopRuntimeCleanupError).failures).toEqual([
      { error: coordinatorError, label: 'coordinator' },
      { error: askAboutCodeError, label: 'ask about code' },
    ]);
    expect(cleanupSettled).toBe(true);
  });

  it('resolves only after every successful owner settles', async () => {
    let resolveAskAboutCode: () => void = () => {};
    const askAboutCodeCleanup = new Promise<void>((resolve) => {
      resolveAskAboutCode = resolve;
    });
    const cleanup = settleDesktopRuntimeCleanupOwners([
      { cleanup: Promise.resolve(), label: 'coordinator' },
      { cleanup: askAboutCodeCleanup, label: 'ask about code' },
    ]);
    let cleanupSettled = false;
    void cleanup.then(() => {
      cleanupSettled = true;
    });

    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    resolveAskAboutCode();
    await expect(cleanup).resolves.toBeUndefined();
    expect(cleanupSettled).toBe(true);
  });

  it('quits normally only after successful cleanup', async () => {
    const quit = vi.fn();
    const exit = vi.fn();

    await finishDesktopRuntimeShutdown(Promise.resolve(), { exit, quit });

    expect(quit).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it('uses a nonzero exit and preserves the cleanup failure', async () => {
    const cleanupError = new Error('cleanup failed');
    const quit = vi.fn();
    const exit = vi.fn();

    await finishDesktopRuntimeShutdown(Promise.reject(cleanupError), { exit, quit });

    expect(exit).toHaveBeenCalledWith(1, cleanupError);
    expect(quit).not.toHaveBeenCalled();
  });
});
