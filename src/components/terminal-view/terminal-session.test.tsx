import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../electron/ipc/channels';
import type { TerminalViewProps } from './types';

const {
  createTerminalFitLifecycleMock,
  createTerminalInputPipelineMock,
  createTerminalOutputPipelineMock,
  createTerminalRecoveryRuntimeMock,
  invokeMock,
  MockTerminalClass,
  outputPipelineFactoryState,
  registerTerminalMock,
  releaseWebglAddonMock,
  scheduleFitIfDirtyMock,
  unregisterTerminalMock,
} = vi.hoisted(() => {
  const state: {
    fitAddonFits: Array<ReturnType<typeof vi.fn>>;
    hasSuppressedOutputSinceHibernation: boolean;
    lastOutputChannel?:
      | {
          onmessage?: (message: unknown) => void;
        }
      | undefined;
    onQueueEmpty?: () => void;
    recoveryVisibilitySnapshots: boolean[];
    writeInFlight: boolean;
  } = {
    fitAddonFits: [],
    hasSuppressedOutputSinceHibernation: false,
    writeInFlight: false,
    recoveryVisibilitySnapshots: [],
  };

  return {
    createTerminalFitLifecycleMock: vi.fn(() => ({
      cleanup: vi.fn(),
      ensureReady: vi.fn(async () => true),
      scheduleStabilize: vi.fn(),
    })),
    createTerminalInputPipelineMock: vi.fn(() => ({
      cleanup: vi.fn(),
      detectPendingInputTraceEcho: vi.fn(),
      drainInputQueue: vi.fn(),
      enqueueProgrammaticInput: vi.fn(),
      finalizePendingInputTraceEchoes: vi.fn(),
      flushPendingInput: vi.fn(),
      flushPendingResize: vi.fn(),
      handleControllerChange: vi.fn(),
      handleTaskControlLoss: vi.fn(),
      handleTerminalData: vi.fn(),
      handleTerminalResize: vi.fn(),
      isResizeTransactionPending: vi.fn(() => false),
      recordKeyboardTraceStart: vi.fn(),
      requestInputTakeover: vi.fn(async () => true),
      setNextProgrammaticInputTrace: vi.fn(),
    })),
    createTerminalOutputPipelineMock: vi.fn((options: { onQueueEmpty: () => void }) => {
      state.onQueueEmpty = options.onQueueEmpty;
      return {
        appendRenderedOutputHistory: vi.fn(),
        armInteractiveEchoFastPath: vi.fn(),
        cleanup: vi.fn(),
        clearOutputWriteWatchdog: vi.fn(),
        dropQueuedOutputForRecovery: vi.fn(),
        enqueueOutput: vi.fn(),
        flushOutputQueue: vi.fn(),
        flushOutputQueueSlice: vi.fn(() => 0),
        getRecoveryRequestState: vi.fn(() => ({ outputCursor: 0, renderedTail: null })),
        getRenderedOutputCursor: vi.fn(() => 0),
        getRenderedOutputHistory: vi.fn(() => new Uint8Array()),
        hasPendingFlowTransitions: vi.fn(() => false),
        hasQueuedOutput: vi.fn(() => false),
        hasQueuedOutputBytes: vi.fn(() => false),
        hasSuppressedOutputSinceHibernation: vi.fn(() => state.hasSuppressedOutputSinceHibernation),
        hasWriteInFlight: vi.fn(() => state.writeInFlight),
        recoverFlowControlIfIdle: vi.fn(),
        scheduleOutputFlush: vi.fn(),
        setRenderHibernating: vi.fn(),
        setRenderedOutputCursor: vi.fn(),
        setRenderedOutputHistory: vi.fn(),
        updateOutputPriority: vi.fn(),
      };
    }),
    createTerminalRecoveryRuntimeMock: vi.fn((options: { isRenderHibernating: () => boolean }) => ({
      handleBrowserTransportConnectionState: vi.fn(),
      isOutputFlushBlocked: vi.fn(() => false),
      isRestoreBlocked: vi.fn(() => false),
      restoreTerminalOutput: vi.fn(async (reason?: string) => {
        if (reason === 'hibernate') {
          state.recoveryVisibilitySnapshots.push(options.isRenderHibernating());
        }
      }),
    })),
    invokeMock: vi.fn(async (channel: IPC) => {
      if (channel === IPC.SpawnAgent) {
        return { attachedExistingSession: false };
      }
      return undefined;
    }),
    MockTerminalClass: class {
      cols = 80;
      rows = 24;
      buffer = {
        active: {
          getLine: () => null,
          length: 0,
        },
      };

      attachCustomKeyEventHandler = vi.fn();
      clearSelection = vi.fn();
      dispose = vi.fn();
      focus = vi.fn();
      getSelection = vi.fn(() => '');
      hasSelection = vi.fn(() => false);
      loadAddon = vi.fn();
      onData = vi.fn();
      onRender = vi.fn();
      onResize = vi.fn();
      open = vi.fn();
      paste = vi.fn();
      write = vi.fn((_chunk?: unknown, callback?: () => void) => {
        callback?.();
      });
    },
    outputPipelineFactoryState: state,
    registerTerminalMock: vi.fn(),
    releaseWebglAddonMock: vi.fn(),
    scheduleFitIfDirtyMock: vi.fn(),
    unregisterTerminalMock: vi.fn(),
  };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: MockTerminalClass,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();

    constructor() {
      outputPipelineFactoryState.fitAddonFits.push(this.fit);
    }

    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 };
    }
  },
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: function WebLinksAddon() {},
}));

vi.mock('../../lib/ipc', () => ({
  Channel: class {
    constructor() {
      outputPipelineFactoryState.lastOutputChannel = this;
    }

    cleanup = vi.fn();
    id = 'channel-1';
    onmessage: ((message: unknown) => void) | undefined;
    ready = Promise.resolve();
  },
  fireAndForget: vi.fn(),
  invoke: invokeMock,
  isElectronRuntime: vi.fn(() => true),
  listenServerMessage: vi.fn(() => vi.fn()),
  onBrowserTransportEvent: vi.fn(() => vi.fn()),
}));

vi.mock('../../lib/dispatch-by-type', () => ({
  dispatchByType: vi.fn(),
}));

vi.mock('../../lib/fonts', () => ({
  getTerminalFontFamily: vi.fn(() => 'monospace'),
}));

vi.mock('../../lib/terminalLatency', () => ({
  detectProbeInOutput: vi.fn(),
  getTerminalTraceTimestampMs: vi.fn(() => 0),
  hasPendingProbes: vi.fn(() => false),
  hasTerminalTraceClockAlignment: vi.fn(() => false),
  recordOutputReceived: vi.fn(() => 0),
}));

vi.mock('../../lib/terminalFitLifecycle', () => ({
  createTerminalFitLifecycle: createTerminalFitLifecycleMock,
}));

vi.mock('../../lib/terminalFitManager', () => ({
  registerTerminal: registerTerminalMock,
  scheduleFitIfDirty: scheduleFitIfDirtyMock,
  unregisterTerminal: unregisterTerminalMock,
}));

vi.mock('../../lib/terminal-shortcuts', () => ({
  getTerminalShortcutAction: vi.fn(() => ({ kind: 'allow', preventDefault: false })),
}));

vi.mock('../../lib/shortcuts', () => ({
  matchesGlobalShortcut: vi.fn(() => false),
}));

vi.mock('../../lib/theme', () => ({
  getTerminalTheme: vi.fn(() => ({})),
}));

vi.mock('../../lib/webglPool', () => ({
  acquireWebglAddon: vi.fn(() => false),
  releaseWebglAddon: releaseWebglAddonMock,
}));

vi.mock('../../lib/platform', () => ({
  isMac: false,
}));

vi.mock('../../app/runtime-diagnostics', () => ({
  recordTerminalFitExecution: vi.fn(),
  recordTerminalFitSchedule: vi.fn(),
  recordTerminalRendererSwap: vi.fn(),
}));

vi.mock('../../store/notification', () => ({
  showNotification: vi.fn(),
}));

vi.mock('../../store/store', () => ({
  store: {
    terminalFont: 'mono',
    themePreset: 'minimal',
  },
}));

vi.mock('../../store/task-command-controllers', () => ({
  subscribeTaskCommandControllerChanges: vi.fn(() => vi.fn()),
}));

vi.mock('../../lib/runtime-client-id', () => ({
  getRuntimeClientId: vi.fn(() => 'client-1'),
}));

vi.mock('./terminal-input-pipeline', () => ({
  createTerminalInputPipeline: createTerminalInputPipelineMock,
}));

vi.mock('./terminal-output-pipeline', () => ({
  createTerminalOutputPipeline: createTerminalOutputPipelineMock,
}));

vi.mock('./terminal-recovery-runtime', () => ({
  createTerminalRecoveryRuntime: createTerminalRecoveryRuntimeMock,
}));

import { startTerminalSession } from './terminal-session';

function createProps(): TerminalViewProps {
  return {
    agentId: 'agent-1',
    args: [],
    command: '/bin/sh',
    cwd: '/tmp',
    taskId: 'task-1',
  };
}

function createMeasuredContainer(): HTMLDivElement {
  const container = document.createElement('div');
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: 320 },
    clientWidth: { configurable: true, value: 640 },
  });
  return container;
}

async function flushSessionStartup(cycles = 2): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve();
  }
}

describe('startTerminalSession render hibernation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    outputPipelineFactoryState.fitAddonFits = [];
    outputPipelineFactoryState.hasSuppressedOutputSinceHibernation = false;
    outputPipelineFactoryState.onQueueEmpty = undefined;
    outputPipelineFactoryState.recoveryVisibilitySnapshots = [];
    outputPipelineFactoryState.lastOutputChannel = undefined;
    outputPipelineFactoryState.writeInFlight = false;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('waits for in-flight writes to drain before entering render hibernation', async () => {
    const container = createMeasuredContainer();
    const renderHibernationChanges: boolean[] = [];

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'hidden',
      getRenderHibernationDelayMs: () => 5,
      onRenderHibernationChange: (isHibernating) => {
        renderHibernationChanges.push(isHibernating);
      },
      props: createProps(),
    });

    await flushSessionStartup(4);

    outputPipelineFactoryState.writeInFlight = true;
    await vi.advanceTimersByTimeAsync(5);
    expect(renderHibernationChanges).toEqual([]);

    outputPipelineFactoryState.writeInFlight = false;
    outputPipelineFactoryState.onQueueEmpty?.();
    await vi.advanceTimersByTimeAsync(5);

    expect(renderHibernationChanges).toEqual([true]);
    session.cleanup();
  });

  it('waits for fit readiness before spawning the PTY', async () => {
    const container = createMeasuredContainer();

    let resolveFitReady!: (value: boolean) => void;
    const fitReadyPromise = new Promise<boolean>((resolve) => {
      resolveFitReady = resolve;
    });
    const ensureReadyMock = vi.fn(() => fitReadyPromise);
    createTerminalFitLifecycleMock.mockImplementationOnce(() => ({
      cleanup: vi.fn(),
      ensureReady: ensureReadyMock,
      scheduleStabilize: vi.fn(),
    }));

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup();

    expect(ensureReadyMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.SpawnAgent, expect.anything());

    resolveFitReady(true);
    await flushSessionStartup();

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.SpawnAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        taskId: 'task-1',
      }),
    );

    session.cleanup();
  });

  it('retries fit readiness after a timeout instead of spawning with an unready terminal', async () => {
    const container = createMeasuredContainer();
    const ensureReadyMock = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    createTerminalFitLifecycleMock.mockImplementationOnce(() => ({
      cleanup: vi.fn(),
      ensureReady: ensureReadyMock,
      scheduleStabilize: vi.fn(),
    }));

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup();

    expect(ensureReadyMock).toHaveBeenCalledTimes(2);
    await flushSessionStartup(4);
    expect(invokeMock).toHaveBeenCalledWith(
      IPC.SpawnAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        taskId: 'task-1',
      }),
    );

    session.cleanup();
  });

  it('keeps hibernate recovery in the frozen-surface path while waking', async () => {
    const container = createMeasuredContainer();
    const renderHibernationChanges: boolean[] = [];

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'hidden',
      getRenderHibernationDelayMs: () => 0,
      onRenderHibernationChange: (isHibernating) => {
        renderHibernationChanges.push(isHibernating);
      },
      props: createProps(),
    });

    await flushSessionStartup(4);

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.SpawnAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        taskId: 'task-1',
      }),
    );

    session.updateOutputPriority();
    expect(renderHibernationChanges).toEqual([true]);
    outputPipelineFactoryState.hasSuppressedOutputSinceHibernation = true;

    session.prewarmRenderHibernation();
    await flushSessionStartup();

    expect(outputPipelineFactoryState.recoveryVisibilitySnapshots).toEqual([true]);

    session.cleanup();
  });

  it('cancels the delayed initial command when the session is cleaned up first', async () => {
    const enqueueProgrammaticInput = vi.fn();
    createTerminalInputPipelineMock.mockImplementationOnce(() => ({
      cleanup: vi.fn(),
      detectPendingInputTraceEcho: vi.fn(),
      drainInputQueue: vi.fn(),
      enqueueProgrammaticInput,
      finalizePendingInputTraceEchoes: vi.fn(),
      flushPendingInput: vi.fn(),
      flushPendingResize: vi.fn(),
      handleControllerChange: vi.fn(),
      handleTaskControlLoss: vi.fn(),
      handleTerminalData: vi.fn(),
      handleTerminalResize: vi.fn(),
      isResizeTransactionPending: vi.fn(() => false),
      recordKeyboardTraceStart: vi.fn(),
      requestInputTakeover: vi.fn(async () => true),
      setNextProgrammaticInputTrace: vi.fn(),
    }));

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: {
        ...createProps(),
        initialCommand: 'pwd',
      },
    });

    await flushSessionStartup();
    outputPipelineFactoryState.lastOutputChannel?.onmessage?.({
      data: 'prompt',
      type: 'Data',
    });
    session.cleanup();

    await vi.advanceTimersByTimeAsync(50);

    expect(enqueueProgrammaticInput).not.toHaveBeenCalled();
  });

  it('defers session fit stabilization until startup is ready and any resize transaction settles', async () => {
    const container = createMeasuredContainer();
    let resizeTransactionPending = false;
    let onResizeTransactionChangeHandler: ((active: boolean) => void) | undefined;
    createTerminalInputPipelineMock.mockImplementationOnce(((...args: unknown[]) => {
      const options = args[0] as {
        onResizeTransactionChange?: (active: boolean) => void;
      };
      onResizeTransactionChangeHandler = options.onResizeTransactionChange;
      return {
        cleanup: vi.fn(),
        detectPendingInputTraceEcho: vi.fn(),
        drainInputQueue: vi.fn(),
        enqueueProgrammaticInput: vi.fn(),
        finalizePendingInputTraceEchoes: vi.fn(),
        flushPendingInput: vi.fn(),
        flushPendingResize: vi.fn(),
        handleControllerChange: vi.fn(),
        handleTaskControlLoss: vi.fn(),
        handleTerminalData: vi.fn(),
        handleTerminalResize: vi.fn(),
        isResizeTransactionPending: vi.fn(() => resizeTransactionPending),
        recordKeyboardTraceStart: vi.fn(),
        requestInputTakeover: vi.fn(async () => true),
        setNextProgrammaticInputTrace: vi.fn(),
      };
    }) as never);

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(16);

    const fitMock = outputPipelineFactoryState.fitAddonFits[0];
    expect(fitMock).toBeDefined();
    fitMock?.mockClear();

    resizeTransactionPending = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await flushSessionStartup();

    expect(fitMock).not.toHaveBeenCalled();

    expect(onResizeTransactionChangeHandler).toBeTypeOf('function');

    resizeTransactionPending = false;
    onResizeTransactionChangeHandler?.(false);
    await flushSessionStartup();

    expect(fitMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(16);

    expect(fitMock).toHaveBeenCalledTimes(2);
    expect(scheduleFitIfDirtyMock).toHaveBeenCalledWith('agent-1');

    session.cleanup();
  });
});
