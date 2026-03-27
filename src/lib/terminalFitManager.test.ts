import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

type FitManagerModule = typeof import('./terminalFitManager.js');
type RuntimeDiagnosticsModule = typeof import('../app/runtime-diagnostics.js');

describe('terminal fit manager', () => {
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalWindow = globalThis.window;

  let fitManagerModule: FitManagerModule;
  let runtimeDiagnosticsModule: RuntimeDiagnosticsModule;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal('performance', {
      now: () => 1_000,
    } as Performance);
    vi.stubGlobal('requestAnimationFrame', ((callback: FrameRequestCallback): number => {
      return Number(
        globalThis.setTimeout(() => {
          callback(1_000);
        }, 0),
      );
    }) as typeof requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', ((handle: number): void => {
      clearTimeout(handle);
    }) as typeof cancelAnimationFrame);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      } as unknown as typeof ResizeObserver,
    );
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      } as unknown as typeof IntersectionObserver,
    );
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
        clearTimeout,
        setTimeout,
      },
    });

    fitManagerModule = await import('./terminalFitManager.js');
    runtimeDiagnosticsModule = await import('../app/runtime-diagnostics.js');
    runtimeDiagnosticsModule.resetRendererRuntimeDiagnostics();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    globalThis.ResizeObserver = originalResizeObserver;
    globalThis.IntersectionObserver = originalIntersectionObserver;
    globalThis.performance = originalPerformance;
  });

  it('routes resize dirties through proposed geometry instead of fitting immediately', async () => {
    const container = {
      clientHeight: 240,
      clientWidth: 320,
      contains: () => false,
    } as unknown as HTMLDivElement;
    const terminalState = {
      cols: 0,
      rows: 0,
    };
    const term = terminalState as unknown as Terminal;
    const onResizeObserved = vi.fn();
    const fitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({
        cols: Math.floor(container.clientWidth / 8),
        rows: Math.floor(container.clientHeight / 16),
      })),
    } as unknown as FitAddon;

    fitManagerModule.registerTerminal(
      'terminal-1',
      container,
      fitAddon,
      term,
      () => true,
      onResizeObserved,
    );
    fitManagerModule.markDirty('terminal-1', 'resize');
    await vi.advanceTimersByTimeAsync(0);
    await vi.runOnlyPendingTimersAsync();
    fitManagerModule.unregisterTerminal('terminal-1');

    const snapshot = runtimeDiagnosticsModule.getRendererRuntimeDiagnosticsSnapshot().terminalFit;

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(onResizeObserved).toHaveBeenCalledTimes(1);
    expect(onResizeObserved).toHaveBeenCalledWith({ cols: 40, rows: 15 });
    expect(snapshot.dirtyMarks).toBe(1);
    expect(snapshot.dirtyReasonCounts.resize).toBe(1);
    expect(snapshot.executionCounts.manager).toBe(0);
    expect(snapshot.flushCalls).toBeGreaterThanOrEqual(1);
    expect(snapshot.geometryChangeFits).toBe(0);
    expect(snapshot.noopSkips).toBe(0);
  });

  it('records explicit font invalidations without suppressing the fit', async () => {
    const container = {
      clientHeight: 240,
      clientWidth: 320,
      contains: () => false,
    } as unknown as HTMLDivElement;
    const terminalState = {
      cols: 80,
      rows: 24,
    };
    const term = terminalState as unknown as Terminal;
    const fitAddon = {
      fit: vi.fn(),
    } as unknown as FitAddon;

    fitManagerModule.registerTerminal('terminal-2', container, fitAddon, term);
    fitManagerModule.markDirty('terminal-2', 'font-size');
    await vi.advanceTimersByTimeAsync(0);
    fitManagerModule.unregisterTerminal('terminal-2');

    const snapshot = runtimeDiagnosticsModule.getRendererRuntimeDiagnosticsSnapshot().terminalFit;

    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(snapshot.dirtyReasonCounts['font-size']).toBe(1);
    expect(snapshot.executionCounts.manager).toBe(1);
    expect(snapshot.noopSkips).toBe(0);
  });

  it('lets resize transaction ownership block mixed resize and fit dirties until follow-up flush', async () => {
    const container = {
      clientHeight: 240,
      clientWidth: 320,
      contains: () => false,
    } as unknown as HTMLDivElement;
    const terminalState = {
      cols: 0,
      rows: 0,
    };
    const term = terminalState as unknown as Terminal;
    const onResizeObserved = vi.fn();
    const fitAddon = {
      fit: vi.fn(() => {
        terminalState.cols = Math.floor(container.clientWidth / 8);
        terminalState.rows = Math.floor(container.clientHeight / 16);
      }),
      proposeDimensions: vi.fn(() => ({
        cols: Math.floor(container.clientWidth / 8),
        rows: Math.floor(container.clientHeight / 16),
      })),
    } as unknown as FitAddon;

    fitManagerModule.registerTerminal(
      'terminal-mixed',
      container,
      fitAddon,
      term,
      () => true,
      onResizeObserved,
    );
    fitManagerModule.markDirty('terminal-mixed', 'resize');
    fitManagerModule.markDirty('terminal-mixed', 'font-size');

    await vi.advanceTimersByTimeAsync(0);
    await vi.runOnlyPendingTimersAsync();

    expect(onResizeObserved).toHaveBeenCalledTimes(1);
    expect(fitAddon.fit).not.toHaveBeenCalled();

    fitManagerModule.scheduleFitIfDirty('terminal-mixed');
    await vi.advanceTimersByTimeAsync(0);
    await vi.runOnlyPendingTimersAsync();
    fitManagerModule.unregisterTerminal('terminal-mixed');

    const snapshot = runtimeDiagnosticsModule.getRendererRuntimeDiagnosticsSnapshot().terminalFit;

    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(snapshot.dirtyReasonCounts.resize).toBe(1);
    expect(snapshot.dirtyReasonCounts['font-size']).toBe(1);
  });

  it('defers resize proposals until the terminal becomes eligible again', async () => {
    const container = {
      clientHeight: 240,
      clientWidth: 320,
      contains: () => false,
    } as unknown as HTMLDivElement;
    const terminalState = {
      cols: 0,
      rows: 0,
    };
    const term = terminalState as unknown as Terminal;
    const onResizeObserved = vi.fn();
    const fitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({
        cols: Math.floor(container.clientWidth / 8),
        rows: Math.floor(container.clientHeight / 16),
      })),
    } as unknown as FitAddon;
    let shouldFitNow = false;

    fitManagerModule.registerTerminal(
      'terminal-deferred',
      container,
      fitAddon,
      term,
      () => shouldFitNow,
      onResizeObserved,
    );
    fitManagerModule.markDirty('terminal-deferred', 'resize');

    await vi.advanceTimersByTimeAsync(200);
    await vi.runOnlyPendingTimersAsync();
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(onResizeObserved).not.toHaveBeenCalled();

    shouldFitNow = true;
    fitManagerModule.scheduleFitIfDirty('terminal-deferred');
    await vi.advanceTimersByTimeAsync(0);
    await vi.runOnlyPendingTimersAsync();
    fitManagerModule.unregisterTerminal('terminal-deferred');

    const snapshot = runtimeDiagnosticsModule.getRendererRuntimeDiagnosticsSnapshot().terminalFit;

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(onResizeObserved).toHaveBeenCalledTimes(1);
    expect(onResizeObserved).toHaveBeenCalledWith({ cols: 40, rows: 15 });
    expect(snapshot.dirtyReasonCounts.resize).toBe(1);
    expect(snapshot.executionCounts.manager).toBe(0);
  });

  it('keeps dirty fits blocked during a resize transaction and retries them immediately after it ends', async () => {
    const container = {
      clientHeight: 240,
      clientWidth: 320,
      contains: () => false,
    } as unknown as HTMLDivElement;
    const terminalState = {
      cols: 80,
      rows: 24,
    };
    const term = terminalState as unknown as Terminal;
    const fitAddon = {
      fit: vi.fn(() => {
        terminalState.cols = 100;
        terminalState.rows = 30;
      }),
    } as unknown as FitAddon;
    let resizeTransactionPending = true;

    fitManagerModule.registerTerminal(
      'terminal-fit-retry',
      container,
      fitAddon,
      term,
      () => !resizeTransactionPending,
    );
    fitManagerModule.markDirty('terminal-fit-retry', 'font-size');

    await vi.advanceTimersByTimeAsync(200);
    await vi.runOnlyPendingTimersAsync();

    expect(fitAddon.fit).not.toHaveBeenCalled();

    resizeTransactionPending = false;
    fitManagerModule.scheduleFitIfDirty('terminal-fit-retry');
    await vi.advanceTimersByTimeAsync(0);
    await vi.runOnlyPendingTimersAsync();
    fitManagerModule.unregisterTerminal('terminal-fit-retry');

    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
  });
});
