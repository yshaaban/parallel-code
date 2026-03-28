import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalRenderHibernationController } from './terminal-render-hibernation';

function createRenderHibernationController(
  overrides: Partial<Parameters<typeof createTerminalRenderHibernationController>[0]> = {},
) {
  return createTerminalRenderHibernationController({
    getOutputPriority: () => 'hidden',
    getRenderHibernationDelayMs: () => 0,
    hasQueuedOutput: () => false,
    hasSuppressedOutputSinceHibernation: () => false,
    hasWriteInFlight: () => false,
    isDisposed: () => false,
    isRestoreBlocked: () => false,
    isSpawnFailed: () => false,
    isSpawnReady: () => true,
    restoreTerminalOutput: vi.fn(async () => {}),
    scheduleOutputFlush: vi.fn(),
    ...overrides,
  });
}

describe('terminal-render-hibernation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for in-flight writes to drain before entering hibernation', async () => {
    const changes: boolean[] = [];
    let writeInFlight = true;
    const controller = createRenderHibernationController({
      getRenderHibernationDelayMs: () => 5,
      hasWriteInFlight: () => writeInFlight,
      onRenderHibernationChange: (isHibernating) => {
        changes.push(isHibernating);
      },
    });

    controller.sync();
    await vi.advanceTimersByTimeAsync(5);
    expect(changes).toEqual([]);

    writeInFlight = false;
    controller.sync();
    await vi.advanceTimersByTimeAsync(5);

    expect(changes).toEqual([true]);
    expect(controller.isHibernating()).toBe(true);
  });

  it('keeps recovery visible while a prewarm restore is in flight and re-hibernates afterward', async () => {
    const changes: boolean[] = [];
    let resolveRestore!: () => void;
    const restorePromise = new Promise<void>((resolve) => {
      resolveRestore = resolve;
    });
    const controller = createRenderHibernationController({
      hasSuppressedOutputSinceHibernation: () => true,
      onRenderHibernationChange: (isHibernating) => {
        changes.push(isHibernating);
      },
      restoreTerminalOutput: vi.fn(async () => {
        await restorePromise;
      }),
      scheduleOutputFlush: vi.fn(),
    });

    controller.sync();
    expect(controller.isHibernating()).toBe(true);

    const prewarmPromise = controller.prewarm();
    await Promise.resolve();
    expect(controller.isRecoveryVisible()).toBe(true);

    resolveRestore();
    await prewarmPromise;

    expect(controller.isRecoveryVisible()).toBe(true);
    expect(changes[0]).toBe(true);
    expect(changes[changes.length - 1]).toBe(true);
    expect(changes).toContain(false);
  });

  it('skips hidden prewarm restore when no suppressed output accumulated', async () => {
    const restoreTerminalOutput = vi.fn(async () => {});
    const controller = createRenderHibernationController({
      onRenderHibernationChange: vi.fn(),
      restoreTerminalOutput,
    });

    controller.sync();
    expect(controller.isHibernating()).toBe(true);

    await controller.prewarm();

    expect(restoreTerminalOutput).not.toHaveBeenCalled();
    expect(controller.isRecoveryVisible()).toBe(true);
  });
});
