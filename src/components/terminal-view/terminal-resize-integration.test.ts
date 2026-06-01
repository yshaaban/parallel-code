import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../../electron/ipc/channels';
import type { TerminalFitDirtyReason } from '../../app/runtime-diagnostics';

vi.mock('../../lib/ipc', () => ({
  BROWSER_AGENT_COMMAND_CANCELED_ERROR_MESSAGE: 'cancelled',
  cancelBrowserAgentCommandRequest: vi.fn(),
  invoke: vi.fn(),
  sendTerminalInput: vi.fn(async () => undefined),
  sendTerminalInputTraceUpdate: vi.fn(),
}));

vi.mock('../../app/task-command-lease-session', () => ({
  createTaskCommandLeaseSession: vi.fn(() => ({
    acquire: vi.fn(async () => true),
    cleanup: vi.fn(),
    release: vi.fn(async () => undefined),
    takeOver: vi.fn(async () => true),
    touch: vi.fn(() => true),
  })),
  hasTaskCommandLeaseTransportAvailability: vi.fn(() => true),
}));

type FitManagerModule = typeof import('../../lib/terminalFitManager.js');
type InputPipelineModule = typeof import('./terminal-input-pipeline.js');
type IpcModule = typeof import('../../lib/ipc.js');
type RuntimeDiagnosticsModule = typeof import('../../app/runtime-diagnostics.js');

interface MutableContainer extends HTMLDivElement {
  setSize(width: number, height: number): void;
}

function createMutableContainer(width: number, height: number): MutableContainer {
  let clientWidth = width;
  let clientHeight = height;

  return {
    contains: () => false,
    get clientHeight() {
      return clientHeight;
    },
    get clientWidth() {
      return clientWidth;
    },
    setSize(nextWidth: number, nextHeight: number): void {
      clientWidth = nextWidth;
      clientHeight = nextHeight;
    },
  } as unknown as MutableContainer;
}

function createFitAddon(container: MutableContainer): FitAddon {
  return {
    fit: vi.fn(),
    proposeDimensions: vi.fn(() => ({
      cols: Math.floor(container.clientWidth / 8),
      rows: Math.floor(container.clientHeight / 16),
    })),
  } as unknown as FitAddon;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('terminal resize integration', () => {
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalWindow = globalThis.window;

  let fitManagerModule: FitManagerModule;
  let inputPipelineModule: InputPipelineModule;
  let ipcModule: IpcModule;
  let runtimeDiagnosticsModule: RuntimeDiagnosticsModule;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal('performance', {
      now: () => Date.now(),
    } as Performance);
    vi.stubGlobal('requestAnimationFrame', ((callback: FrameRequestCallback): number => {
      return Number(
        globalThis.setTimeout(() => {
          callback(performance.now());
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

    fitManagerModule = await import('../../lib/terminalFitManager.js');
    inputPipelineModule = await import('./terminal-input-pipeline.js');
    ipcModule = await import('../../lib/ipc.js');
    runtimeDiagnosticsModule = await import('../../app/runtime-diagnostics.js');
    runtimeDiagnosticsModule.resetRendererRuntimeDiagnostics();
    vi.mocked(ipcModule.invoke).mockResolvedValue(undefined);
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

  it('commits the latest resize-only fit proposal after a blocked panel drag settles', async () => {
    let shouldCommitResize = false;
    const terminal = {
      cols: 80,
      rows: 24,
    } as Terminal;
    const container = createMutableContainer(640, 320);
    const fitAddon = createFitAddon(container);
    const pipeline = inputPipelineModule.createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      shouldCommitResize: () => shouldCommitResize,
      taskId: 'task-1',
      term: terminal,
    });
    const canProcessDirtyReasons = (dirtyReasons: ReadonlySet<TerminalFitDirtyReason>) => {
      const resizeOnly =
        dirtyReasons.size > 0 && [...dirtyReasons].every((reason) => reason === 'resize');
      if (!shouldCommitResize) {
        return false;
      }

      return resizeOnly || !pipeline.isResizeTransactionPending();
    };

    try {
      fitManagerModule.registerTerminal(
        'agent-1',
        container,
        fitAddon,
        terminal,
        canProcessDirtyReasons,
        ({ cols, rows }) => {
          pipeline.handleTerminalResize(cols, rows);
        },
      );

      pipeline.handleTerminalResize(90, 25);
      container.setSize(960, 480);
      fitManagerModule.markDirty('agent-1', 'resize');

      await vi.advanceTimersByTimeAsync(200);
      await vi.runOnlyPendingTimersAsync();

      expect(fitAddon.proposeDimensions).not.toHaveBeenCalled();
      expect(vi.mocked(ipcModule.invoke)).not.toHaveBeenCalled();

      shouldCommitResize = true;
      fitManagerModule.scheduleFitIfDirty('agent-1');
      await vi.advanceTimersByTimeAsync(0);
      await vi.runOnlyPendingTimersAsync();
      await pipeline.flushPendingResize();
      await flushMicrotasks();

      expect(fitAddon.fit).not.toHaveBeenCalled();
      expect(fitAddon.proposeDimensions).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ipcModule.invoke)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ipcModule.invoke)).toHaveBeenCalledWith(
        IPC.ResizeAgent,
        expect.objectContaining({
          agentId: 'agent-1',
          cols: 120,
          rows: 30,
          taskId: 'task-1',
        }),
      );
      expect(
        runtimeDiagnosticsModule.getRendererRuntimeDiagnosticsSnapshot().terminalResize
          .pendingCurrent,
      ).toBe(0);
    } finally {
      fitManagerModule.unregisterTerminal('agent-1');
      pipeline.cleanup();
    }
  });
});
