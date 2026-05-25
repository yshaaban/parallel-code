import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../electron/ipc/channels';
import { resetBrowserPagehideStateForTests } from '../../lib/browser-pagehide';
import {
  noteTerminalFocusedInput,
  settleTerminalFocusedInput,
} from '../../app/terminal-focused-input';
import {
  fireAndForget,
  getBrowserTransportConnectionState,
  isBrowserControlAuthenticated,
  isElectronRuntime,
  onBrowserAuthenticated,
  onBrowserTransportEvent,
  sendPagehideInvoke,
} from '../../lib/ipc';
import type { TerminalFitLifecycle } from '../../lib/terminalFitLifecycle';
import {
  getTaskCommandController,
  subscribeTaskCommandControllerChanges,
} from '../../store/task-command-controllers';
import type { TerminalInputPipeline } from './terminal-input-pipeline';
import type { TerminalRecoveryRuntime } from './terminal-recovery-runtime';
import type { TerminalViewProps } from './types';

const {
  acquireWebglAddonMock,
  openMarkdownViewerMock,
  createTerminalFitLifecycleMock,
  createTerminalInputPipelineMock,
  createTerminalOutputPipelineMock,
  createTerminalRecoveryRuntimeMock,
  clipboardReadTextMock,
  clipboardWriteTextMock,
  getTerminalShortcutActionMock,
  invokeMock,
  isWebglAddonRuntimeReadyMock,
  matchesDialogSafeShortcutMock,
  matchesGlobalShortcutMock,
  MockTerminalClass,
  outputPipelineFactoryState,
  preloadWebglAddonMock,
  registerTerminalMock,
  releaseWebglAddonMock,
  scheduleFitIfDirtyMock,
  setWebglAddonPriorityMock,
  touchWebglAddonMock,
  unregisterTerminalMock,
} = vi.hoisted(() => {
  const state: {
    fitAddonFits: Array<ReturnType<typeof vi.fn>>;
    lineLinkProvider?:
      | {
          provideLinks: (
            lineNumber: number,
            callback: (
              links?: Array<{ activate: (event: MouseEvent) => void; text: string }>,
            ) => void,
          ) => void;
        }
      | undefined;
    lineText: string;
    hasSuppressedOutputSinceHibernation: boolean;
    lastOutputChannel?:
      | {
          onmessage?: (message: unknown) => void;
        }
      | undefined;
    onQueueEmpty?: () => void;
    recoveryVisibilitySnapshots: boolean[];
    webLinkHandler?: ((event: MouseEvent, uri: string) => void) | undefined;
    writeInFlight: boolean;
  } = {
    fitAddonFits: [],
    lineText: '',
    hasSuppressedOutputSinceHibernation: false,
    writeInFlight: false,
    recoveryVisibilitySnapshots: [],
  };

  return {
    acquireWebglAddonMock: vi.fn<(...args: unknown[]) => unknown>(() => null),
    openMarkdownViewerMock: vi.fn(async () => true),
    createTerminalFitLifecycleMock: vi.fn<
      (options: TerminalFitLifecycleTestOptions) => TerminalFitLifecycle
    >(() => ({
      cleanup: vi.fn(),
      ensureReady: vi.fn(async () => true),
      scheduleStabilize: vi.fn(),
    })),
    createTerminalInputPipelineMock: vi.fn<
      (options: TerminalInputPipelineTestOptions) => TerminalInputPipeline
    >(() => ({
      cleanup: vi.fn(),
      adoptBackendResizeForRecovery: vi.fn(),
      detectPendingInputTraceEcho: vi.fn(),
      drainInputQueue: vi.fn(),
      enqueueProgrammaticInput: vi.fn(),
      finalizePendingInputTraceEchoes: vi.fn(),
      flushPendingInput: vi.fn(),
      flushPendingResizeForRecoveryAlignment: vi.fn(),
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
    createTerminalRecoveryRuntimeMock: vi.fn<
      (options: RecoveryRuntimeTestOptions) => TerminalRecoveryRuntime
    >((options) => ({
      dispose: vi.fn(),
      handleBrowserControlAuthenticated: vi.fn(),
      handleBrowserTransportConnectionState: vi.fn(),
      isOutputFlushBlocked: vi.fn(() => false),
      isRestoreBlocked: vi.fn(() => false),
      notifySpawnReady: vi.fn(),
      restoreTerminalOutput: vi.fn(async (reason?: string) => {
        if (reason === 'hibernate') {
          state.recoveryVisibilitySnapshots.push(options.isRenderHibernating());
        }
      }),
    })),
    clipboardReadTextMock: vi.fn(async () => ''),
    clipboardWriteTextMock: vi.fn(async () => undefined),
    getTerminalShortcutActionMock: vi.fn<(...args: unknown[]) => unknown>(() => ({
      kind: 'allow',
      preventDefault: false,
    })),
    invokeMock: vi.fn<(channel: IPC, args?: unknown) => Promise<unknown>>(async (channel: IPC) => {
      if (channel === IPC.SpawnAgent) {
        return { attachedExistingSession: false };
      }
      return undefined;
    }),
    isWebglAddonRuntimeReadyMock: vi.fn(() => true),
    matchesDialogSafeShortcutMock: vi.fn(() => false),
    matchesGlobalShortcutMock: vi.fn(() => false),
    MockTerminalClass: class {
      cols = 80;
      rows = 24;
      options: Record<string, unknown>;
      private readonly renderListeners: Array<(event: { end: number; start: number }) => void> = [];
      buffer = {
        active: {
          getLine: (index: number) => {
            if (index !== 0 || state.lineText.length === 0) {
              return null;
            }

            return {
              translateToString: () => state.lineText,
            };
          },
          get length(): number {
            return state.lineText.length > 0 ? 1 : 0;
          },
        },
      };

      constructor(options: Record<string, unknown> = {}) {
        this.options = { ...options };
      }

      attachCustomKeyEventHandler = vi.fn();
      clearSelection = vi.fn();
      dispose = vi.fn();
      focus = vi.fn();
      getSelection = vi.fn(() => '');
      hasSelection = vi.fn(() => false);
      loadAddon = vi.fn();
      onData = vi.fn();
      onRender = vi.fn((listener: (event: { end: number; start: number }) => void) => {
        this.renderListeners.push(listener);
      });
      onResize = vi.fn();
      open = vi.fn();
      paste = vi.fn();
      scrollLines = vi.fn();
      scrollPages = vi.fn();
      registerLinkProvider = vi.fn((provider: typeof state.lineLinkProvider) => {
        state.lineLinkProvider = provider;
        return { dispose: vi.fn() };
      });
      write = vi.fn((_chunk?: unknown, callback?: () => void) => {
        callback?.();
      });

      emitRender(start: number, end: number): void {
        for (const listener of this.renderListeners) {
          listener({ end, start });
        }
      }
    },
    outputPipelineFactoryState: state,
    preloadWebglAddonMock: vi.fn(async () => undefined),
    registerTerminalMock: vi.fn(),
    releaseWebglAddonMock: vi.fn(),
    scheduleFitIfDirtyMock: vi.fn(),
    setWebglAddonPriorityMock: vi.fn(),
    touchWebglAddonMock: vi.fn(),
    unregisterTerminalMock: vi.fn(),
  };
});

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

type RecoveryRuntimeTestOptions = {
  ensureTerminalFitReady?: (reason: 'renderer-loss' | 'restore') => Promise<boolean>;
  isRenderHibernating: () => boolean;
  onRestoreBlockedChange?: (isBlocked: boolean) => void;
};

type TerminalFitLifecycleTestOptions = {
  onReady?: () => void;
};

type TerminalInputPipelineTestOptions = {
  onResizeTransactionChange?: (active: boolean) => void;
};

function createTestTerminalFitLifecycle(
  overrides: Partial<TerminalFitLifecycle> = {},
): TerminalFitLifecycle {
  return {
    cleanup: vi.fn(),
    ensureReady: vi.fn(async () => true),
    scheduleStabilize: vi.fn(),
    ...overrides,
  };
}

function createTestTerminalInputPipeline(
  overrides: Partial<TerminalInputPipeline> = {},
): TerminalInputPipeline {
  const { adoptBackendResizeForRecovery = vi.fn(), ...restOverrides } = overrides;
  return {
    adoptBackendResizeForRecovery,
    cleanup: vi.fn(),
    detectPendingInputTraceEcho: vi.fn(),
    drainInputQueue: vi.fn(),
    enqueueProgrammaticInput: vi.fn(),
    finalizePendingInputTraceEchoes: vi.fn(),
    flushPendingInput: vi.fn(),
    flushPendingResizeForRecoveryAlignment: vi.fn(async () => undefined),
    flushPendingResize: vi.fn(async () => undefined),
    handleControllerChange: vi.fn(),
    handleTaskControlLoss: vi.fn(),
    handleTerminalData: vi.fn(),
    handleTerminalResize: vi.fn(),
    isResizeTransactionPending: vi.fn(() => false),
    recordKeyboardTraceStart: vi.fn(),
    requestInputTakeover: vi.fn(async () => true),
    setNextProgrammaticInputTrace: vi.fn(),
    ...restOverrides,
  };
}

function createTestTerminalRecoveryRuntime(
  overrides: Partial<TerminalRecoveryRuntime> = {},
): TerminalRecoveryRuntime {
  return {
    dispose: vi.fn(),
    handleBrowserControlAuthenticated: vi.fn(),
    handleBrowserTransportConnectionState: vi.fn(),
    isOutputFlushBlocked: vi.fn(() => false),
    isRestoreBlocked: vi.fn(() => false),
    notifySpawnReady: vi.fn(),
    restoreTerminalOutput: vi.fn(async () => undefined),
    ...overrides,
  };
}

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
  WebLinksAddon: class {
    activate = vi.fn();
    dispose = vi.fn();

    constructor(handler: (event: MouseEvent, uri: string) => void) {
      outputPipelineFactoryState.webLinkHandler = handler;
    }
  },
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
  getBrowserTransportConnectionState: vi.fn(() => 'disconnected'),
  invoke: invokeMock,
  isBrowserControlAuthenticated: vi.fn(() => false),
  isElectronRuntime: vi.fn(() => true),
  listenServerMessage: vi.fn(() => vi.fn()),
  onBrowserAuthenticated: vi.fn(() => vi.fn()),
  onBrowserTransportEvent: vi.fn(() => vi.fn()),
  sendPagehideInvoke: vi.fn(),
}));

vi.mock('../../lib/dispatch-by-type', () => ({
  dispatchByType: vi.fn(
    (handlers: Record<string, (message: unknown) => void>, message: unknown) => {
      if (!message || typeof message !== 'object') {
        return;
      }

      const type = (message as { type?: unknown }).type;
      if (typeof type !== 'string') {
        return;
      }

      handlers[type]?.(message);
    },
  ),
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
  getTerminalShortcutAction: getTerminalShortcutActionMock,
}));

vi.mock('../../lib/shortcuts', () => ({
  matchesDialogSafeShortcut: matchesDialogSafeShortcutMock,
  matchesGlobalShortcut: matchesGlobalShortcutMock,
}));

vi.mock('../../lib/theme', () => ({
  getTerminalTheme: vi.fn(() => ({})),
}));

vi.mock('../../lib/webglPool', () => ({
  acquireWebglAddon: acquireWebglAddonMock,
  isWebglAddonRuntimeReady: isWebglAddonRuntimeReadyMock,
  preloadWebglAddon: preloadWebglAddonMock,
  releaseWebglAddon: releaseWebglAddonMock,
  setWebglAddonPriority: setWebglAddonPriorityMock,
  touchWebglAddon: touchWebglAddonMock,
}));

vi.mock('../../lib/platform', () => ({
  isMac: false,
}));

vi.mock('../../app/runtime-diagnostics', () => ({
  recordTerminalFitExecution: vi.fn(),
  recordTerminalFitSchedule: vi.fn(),
  recordTerminalRendererSwap: vi.fn(),
}));

vi.mock('../../app/markdown-viewer', () => ({
  openMarkdownViewer: openMarkdownViewerMock,
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
  getTaskCommandController: vi.fn(() => null),
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

function createProps(overrides: Partial<TerminalViewProps> = {}): TerminalViewProps {
  return {
    agentId: 'agent-1',
    args: [],
    command: '/bin/sh',
    cwd: '/tmp',
    taskId: 'task-1',
    ...overrides,
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

function createFakeFile(name: string, bytes: Uint8Array): File {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  return {
    arrayBuffer: () => Promise.resolve(buffer),
    name,
    size: bytes.byteLength,
  } as File;
}

function createDropEvent(files: File[]): DragEvent {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      dropEffect: 'none',
      files,
      types: ['Files'],
    },
  });
  return event;
}

async function flushSessionStartup(cycles = 2): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve();
  }
}

type TerminalSessionForTest = ReturnType<typeof startTerminalSession>;
type MockTerminalInstance = InstanceType<typeof MockTerminalClass>;
type TerminalKeyHandler = (event: KeyboardEvent) => boolean;
type TerminalWebLinkHandler = (event: MouseEvent, uri: string) => void;
type TestElectronWindow = {
  electron?: { getPathForFile?: (file: File) => string };
};

function getMockTerminal(session: TerminalSessionForTest): MockTerminalInstance {
  return session.term as unknown as MockTerminalInstance;
}

function getTestElectronWindow(): TestElectronWindow {
  return window as Window & TestElectronWindow;
}

function getTerminalKeyHandler(session: TerminalSessionForTest): TerminalKeyHandler | undefined {
  return getMockTerminal(session).attachCustomKeyEventHandler.mock.calls[0]?.[0] as
    | TerminalKeyHandler
    | undefined;
}

function emitTerminalRender(session: TerminalSessionForTest, start: number, end: number): void {
  getMockTerminal(session).emitRender(start, end);
}

async function waitForTerminalWebLinkHandler(): Promise<TerminalWebLinkHandler> {
  for (let index = 0; index < 10; index += 1) {
    const handler = outputPipelineFactoryState.webLinkHandler;
    if (handler) {
      return handler;
    }

    await vi.advanceTimersByTimeAsync(0);
    await flushSessionStartup(1);
  }

  throw new Error('Expected terminal web link handler to be registered');
}

describe('startTerminalSession render hibernation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetBrowserPagehideStateForTests();
    vi.mocked(isElectronRuntime).mockReturnValue(true);
    vi.mocked(isBrowserControlAuthenticated).mockReturnValue(false);
    vi.mocked(getBrowserTransportConnectionState).mockReturnValue('disconnected');
    vi.mocked(getTaskCommandController).mockReturnValue(null);
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.SpawnAgent) {
        return { attachedExistingSession: false };
      }
      return undefined;
    });
    openMarkdownViewerMock.mockReset();
    openMarkdownViewerMock.mockResolvedValue(true);
    isWebglAddonRuntimeReadyMock.mockReturnValue(true);
    preloadWebglAddonMock.mockResolvedValue(undefined);
    getTerminalShortcutActionMock.mockReturnValue({ kind: 'allow', preventDefault: false });
    clipboardReadTextMock.mockResolvedValue('');
    clipboardWriteTextMock.mockResolvedValue(undefined);
    matchesDialogSafeShortcutMock.mockReset();
    matchesDialogSafeShortcutMock.mockReturnValue(false);
    matchesGlobalShortcutMock.mockReset();
    matchesGlobalShortcutMock.mockReturnValue(false);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: clipboardReadTextMock,
        writeText: clipboardWriteTextMock,
      },
    });
    outputPipelineFactoryState.fitAddonFits = [];
    outputPipelineFactoryState.hasSuppressedOutputSinceHibernation = false;
    outputPipelineFactoryState.lineLinkProvider = undefined;
    outputPipelineFactoryState.lineText = '';
    outputPipelineFactoryState.onQueueEmpty = undefined;
    outputPipelineFactoryState.recoveryVisibilitySnapshots = [];
    outputPipelineFactoryState.lastOutputChannel = undefined;
    outputPipelineFactoryState.webLinkHandler = undefined;
    outputPipelineFactoryState.writeInFlight = false;
  });

  afterEach(() => {
    delete getTestElectronWindow().electron;
    resetBrowserPagehideStateForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps hidden and visible-background terminals on the DOM renderer path', async () => {
    const container = createMeasuredContainer();
    let outputPriority: 'hidden' | 'visible-background' = 'hidden';

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => outputPriority,
      props: createProps(),
    });

    await flushSessionStartup(4);

    session.updateOutputPriority();
    expect(acquireWebglAddonMock).not.toHaveBeenCalled();

    outputPriority = 'visible-background';
    session.updateOutputPriority();
    expect(acquireWebglAddonMock).not.toHaveBeenCalled();

    session.cleanup();
  });

  it('initializes the terminal with explicit line metrics', () => {
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: {
        ...createProps(),
        fontSize: 13,
      },
    });

    expect(session.term.options.fontSize).toBe(13);
    expect(session.term.options.letterSpacing).toBe(0);
    expect(session.term.options.lineHeight).toBe(1);

    session.cleanup();
  });

  it('passes the task base branch through the spawn request', async () => {
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps({ baseBranch: 'release/main' }),
    });

    await flushSessionStartup(4);

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.SpawnAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        baseBranch: 'release/main',
        taskId: 'task-1',
      }),
    );

    session.cleanup();
  });

  it('ignores a late spawn result after cleanup', async () => {
    const spawnDeferred = createDeferredPromise<{ attachedExistingSession: boolean }>();
    const onAttachBound = vi.fn();
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.SpawnAgent) {
        return spawnDeferred.promise;
      }
      return undefined;
    });

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      onAttachBound,
      props: createProps(),
    });

    await flushSessionStartup(4);
    expect(invokeMock).toHaveBeenCalledWith(IPC.SpawnAgent, expect.anything());

    const recoveryRuntime = createTerminalRecoveryRuntimeMock.mock.results[0]?.value;
    const outputPipeline = createTerminalOutputPipelineMock.mock.results[0]?.value;
    session.cleanup();
    spawnDeferred.resolve({ attachedExistingSession: false });
    await flushSessionStartup(4);

    expect(onAttachBound).not.toHaveBeenCalled();
    expect(recoveryRuntime?.notifySpawnReady).not.toHaveBeenCalled();
    expect(outputPipeline?.recoverFlowControlIfIdle).not.toHaveBeenCalled();
  });

  it('does not use normal browser detach cleanup during pagehide', async () => {
    vi.mocked(isElectronRuntime).mockReturnValue(false);
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);
    vi.mocked(fireAndForget).mockClear();
    vi.mocked(sendPagehideInvoke).mockClear();
    window.dispatchEvent(new Event('pagehide'));
    expect(vi.mocked(fireAndForget)).not.toHaveBeenCalled();
    expect(vi.mocked(sendPagehideInvoke)).not.toHaveBeenCalled();

    session.cleanup();
  });

  it('uses pagehide-safe detach cleanup after pagehide has started', async () => {
    vi.mocked(isElectronRuntime).mockReturnValue(false);
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);
    vi.mocked(fireAndForget).mockClear();
    vi.mocked(sendPagehideInvoke).mockClear();
    window.dispatchEvent(new Event('pagehide'));
    session.cleanup();

    expect(vi.mocked(fireAndForget)).not.toHaveBeenCalledWith(IPC.ResumeAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'flow-control',
    });
    expect(vi.mocked(fireAndForget)).not.toHaveBeenCalledWith(IPC.DetachAgentOutput, {
      agentId: 'agent-1',
      channelId: 'channel-1',
    });
    expect(vi.mocked(sendPagehideInvoke)).toHaveBeenNthCalledWith(1, IPC.ResumeAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'flow-control',
    });
    expect(vi.mocked(sendPagehideInvoke)).toHaveBeenNthCalledWith(2, IPC.DetachAgentOutput, {
      agentId: 'agent-1',
      channelId: 'channel-1',
    });
  });

  it('stops detaching the browser output channel on pagehide after cleanup', async () => {
    vi.mocked(isElectronRuntime).mockReturnValue(false);
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);
    vi.mocked(fireAndForget).mockClear();
    vi.mocked(sendPagehideInvoke).mockClear();
    session.cleanup();
    const cleanupCallCount = vi.mocked(fireAndForget).mock.calls.length;
    window.dispatchEvent(new Event('pagehide'));

    expect(vi.mocked(fireAndForget).mock.calls).toHaveLength(cleanupCallCount);
    expect(vi.mocked(sendPagehideInvoke).mock.calls).toHaveLength(0);
  });

  it('requires Ctrl+click to open terminal web links', async () => {
    const openWindowSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const linkHandler = await waitForTerminalWebLinkHandler();

    linkHandler?.(new MouseEvent('click'), 'https://example.com');
    expect(openWindowSpy).not.toHaveBeenCalled();

    linkHandler?.(new MouseEvent('click', { ctrlKey: true }), 'https://example.com');
    expect(openWindowSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener');

    session.cleanup();
    openWindowSpy.mockRestore();
  });

  it('ignores invalid terminal web links even when Ctrl is held', async () => {
    const openWindowSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const linkHandler = await waitForTerminalWebLinkHandler();
    linkHandler(new MouseEvent('click', { ctrlKey: true }), 'not a url');
    expect(openWindowSpy).not.toHaveBeenCalled();

    session.cleanup();
    openWindowSpy.mockRestore();
  });

  it('routes same-worktree markdown file links through the shared viewer on Ctrl+click', async () => {
    outputPipelineFactoryState.lineText = 'See docs/guide.md:14 for details.';
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: {
        ...createProps(),
        cwd: '/tmp/project',
      },
    });

    await flushSessionStartup(4);

    const linkProvider = outputPipelineFactoryState.lineLinkProvider;
    expect(linkProvider).toBeDefined();

    const links = await new Promise<Array<{ activate: (event: MouseEvent) => void; text: string }>>(
      (resolve) => {
        linkProvider?.provideLinks(1, (providedLinks) => {
          resolve(providedLinks ?? []);
        });
      },
    );
    expect(links).toHaveLength(1);

    links[0]?.activate(new MouseEvent('click'));
    expect(openMarkdownViewerMock).not.toHaveBeenCalled();

    links[0]?.activate(new MouseEvent('click', { ctrlKey: true }));
    expect(openMarkdownViewerMock).toHaveBeenCalledWith({
      agentId: 'agent-1',
      relativePath: 'docs/guide.md',
      taskId: 'task-1',
      worktreePath: '/tmp/project',
    });

    session.cleanup();
  });

  it('routes same-worktree file URLs through the shared viewer on Ctrl+click', async () => {
    outputPipelineFactoryState.lineText = 'See file:///tmp/project/docs/guide.md:14 for details.';
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: {
        ...createProps(),
        cwd: '/tmp/project',
      },
    });

    await flushSessionStartup(4);

    const links = await new Promise<Array<{ activate: (event: MouseEvent) => void; text: string }>>(
      (resolve) => {
        outputPipelineFactoryState.lineLinkProvider?.provideLinks(1, (providedLinks) => {
          resolve(providedLinks ?? []);
        });
      },
    );
    expect(links).toHaveLength(1);

    links[0]?.activate(new MouseEvent('click', { ctrlKey: true }));
    expect(openMarkdownViewerMock).toHaveBeenCalledWith({
      agentId: 'agent-1',
      relativePath: 'docs/guide.md',
      taskId: 'task-1',
      worktreePath: '/tmp/project',
    });

    session.cleanup();
  });

  it('matches Windows file URLs case-insensitively within the current worktree', async () => {
    outputPipelineFactoryState.lineText = 'See file:///c:/Work/Repo/docs/Guide.md:14 for details.';
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: {
        ...createProps(),
        cwd: 'C:\\work\\repo',
      },
    });

    await flushSessionStartup(4);

    const links = await new Promise<Array<{ activate: (event: MouseEvent) => void; text: string }>>(
      (resolve) => {
        outputPipelineFactoryState.lineLinkProvider?.provideLinks(1, (providedLinks) => {
          resolve(providedLinks ?? []);
        });
      },
    );
    expect(links).toHaveLength(1);

    links[0]?.activate(new MouseEvent('click', { ctrlKey: true }));
    expect(openMarkdownViewerMock).toHaveBeenCalledWith({
      agentId: 'agent-1',
      relativePath: 'docs/Guide.md',
      taskId: 'task-1',
      worktreePath: 'C:\\work\\repo',
    });

    session.cleanup();
  });

  it('rejects markdown file links that resolve outside the current worktree', async () => {
    outputPipelineFactoryState.lineText = 'Do not open ../outside.md';
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: {
        ...createProps(),
        cwd: '/tmp/project',
      },
    });

    await flushSessionStartup(4);

    const links = await new Promise<Array<{ activate: (event: MouseEvent) => void; text: string }>>(
      (resolve) => {
        outputPipelineFactoryState.lineLinkProvider?.provideLinks(1, (providedLinks) => {
          resolve(providedLinks ?? []);
        });
      },
    );
    expect(links).toHaveLength(0);

    session.cleanup();
  });

  it('keeps external markdown URLs on the web-link path instead of the shared viewer', async () => {
    const openWindowSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const linkHandler = await waitForTerminalWebLinkHandler();
    linkHandler(new MouseEvent('click', { ctrlKey: true }), 'https://example.com/guide.md');
    expect(openMarkdownViewerMock).not.toHaveBeenCalled();
    expect(openWindowSpy).toHaveBeenCalledWith(
      'https://example.com/guide.md',
      '_blank',
      'noopener',
    );

    session.cleanup();
    openWindowSpy.mockRestore();
  });

  it('pastes a resolved clipboard image path into the terminal with shell escaping', async () => {
    const setNextProgrammaticInputTrace = vi.fn();
    createTerminalInputPipelineMock.mockImplementationOnce(() =>
      createTestTerminalInputPipeline({
        setNextProgrammaticInputTrace,
      }),
    );
    getTerminalShortcutActionMock.mockReturnValue({ kind: 'paste', preventDefault: true });
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.SpawnAgent) {
        return { attachedExistingSession: false };
      }
      if (channel === IPC.ResolveClipboardPaste) {
        return { kind: 'image', path: '/tmp/parallel code clipboard.png' };
      }
      return undefined;
    });

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);
    invokeMock.mockClear();

    const keyHandler = getTerminalKeyHandler(session);

    expect(keyHandler).toBeTypeOf('function');
    const accepted = keyHandler?.(new KeyboardEvent('keydown', { ctrlKey: true, key: 'v' }));
    await flushSessionStartup(4);

    expect(accepted).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith(IPC.ResolveClipboardPaste);
    expect(setNextProgrammaticInputTrace).toHaveBeenCalledWith(
      '/tmp/parallel\\ code\\ clipboard.png',
    );
    expect(session.term.paste).toHaveBeenCalledWith('/tmp/parallel\\ code\\ clipboard.png');

    session.cleanup();
  });

  it('cleans selected terminal text before shortcut copy writes to the clipboard', async () => {
    getTerminalShortcutActionMock.mockReturnValue({ kind: 'copy', preventDefault: true });

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);
    const terminal = getMockTerminal(session);
    terminal.getSelection.mockReturnValue(
      [
        "  Let me know if you'd like to commit this or want a   ",
        '  different change instead.                          ',
      ].join('\n'),
    );

    const keyHandler = getTerminalKeyHandler(session);

    expect(keyHandler).toBeTypeOf('function');
    const accepted = keyHandler?.(new KeyboardEvent('keydown', { ctrlKey: true, key: 'c' }));
    await flushSessionStartup(4);

    expect(accepted).toBe(false);
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      "  Let me know if you'd like to commit this or want a different change instead.",
    );
    expect(session.term.clearSelection).toHaveBeenCalled();

    session.cleanup();
  });

  it('cleans selected terminal text for DOM copy events before xterm handles them', async () => {
    const containerRef = createMeasuredContainer();
    const clipboardData = {
      setData: vi.fn(),
    };
    const session = startTerminalSession({
      containerRef,
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);
    const terminal = getMockTerminal(session);
    terminal.getSelection.mockReturnValue('padded text   \n');

    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: clipboardData,
    });
    containerRef.dispatchEvent(event);
    await flushSessionStartup(1);

    expect(event.defaultPrevented).toBe(true);
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'padded text\n');
    expect(session.term.clearSelection).toHaveBeenCalled();

    session.cleanup();
  });

  it('handles terminal scrollback shortcut actions locally without sending input', async () => {
    getTerminalShortcutActionMock.mockReturnValue({
      delta: -1,
      kind: 'scrollback',
      preventDefault: true,
      unit: 'page',
    });

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const keyHandler = getTerminalKeyHandler(session);

    expect(keyHandler).toBeTypeOf('function');
    const accepted = keyHandler?.(
      new KeyboardEvent('keydown', { ctrlKey: true, key: 'PageUp', shiftKey: true }),
    );

    expect(accepted).toBe(false);
    expect(session.term.scrollPages).toHaveBeenCalledWith(-1);
    expect(session.term.paste).not.toHaveBeenCalled();

    session.cleanup();
  });

  it('pastes dropped native file paths into the terminal before xterm sees basenames', async () => {
    const runtimeWindow = getTestElectronWindow();
    const previousElectron = runtimeWindow.electron;
    runtimeWindow.electron = {
      getPathForFile: vi.fn(() => '/tmp/My Image.png'),
    };
    const containerRef = createMeasuredContainer();
    const session = startTerminalSession({
      containerRef,
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);
    invokeMock.mockClear();

    const event = createDropEvent([createFakeFile('My Image.png', new Uint8Array([1, 2, 3]))]);
    containerRef.dispatchEvent(event);
    await flushSessionStartup(4);

    expect(event.defaultPrevented).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.SaveDroppedImage, expect.anything());
    expect(session.term.focus).toHaveBeenCalled();
    expect(session.term.paste).toHaveBeenCalledWith('/tmp/My\\ Image.png');

    session.cleanup();
    runtimeWindow.electron = previousElectron;
  });

  it('saves pathless dropped files before pasting their temp path', async () => {
    const runtimeWindow = getTestElectronWindow();
    const previousElectron = runtimeWindow.electron;
    runtimeWindow.electron = {
      getPathForFile: vi.fn(() => ''),
    };
    invokeMock.mockImplementation(async (channel: IPC) => {
      if (channel === IPC.SpawnAgent) {
        return { attachedExistingSession: false };
      }
      if (channel === IPC.SaveDroppedImage) {
        return '/tmp/parallel-code-drop-screen.png';
      }
      return undefined;
    });
    const containerRef = createMeasuredContainer();
    const session = startTerminalSession({
      containerRef,
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);
    invokeMock.mockClear();

    const event = createDropEvent([
      createFakeFile('screen.png', new Uint8Array([137, 80, 78, 71])),
    ]);
    containerRef.dispatchEvent(event);
    await flushSessionStartup(4);

    expect(event.defaultPrevented).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(IPC.SaveDroppedImage, {
      data: 'iVBORw==',
      name: 'screen.png',
    });
    expect(session.term.paste).toHaveBeenCalledWith('/tmp/parallel-code-drop-screen.png');

    session.cleanup();
    runtimeWindow.electron = previousElectron;
  });

  it('lets shortcut policy suppress non-keydown echoes such as Shift+Enter keyup', async () => {
    getTerminalShortcutActionMock.mockReturnValue({ kind: 'block', preventDefault: false });

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const keyHandler = getTerminalKeyHandler(session);

    expect(keyHandler).toBeTypeOf('function');
    const accepted = keyHandler?.(new KeyboardEvent('keyup', { key: 'Enter', shiftKey: true }));

    expect(accepted).toBe(false);
    expect(getTerminalShortcutActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'Enter', shiftKey: true, type: 'keyup' }),
      expect.any(Object),
    );

    session.cleanup();
  });

  it('suppresses terminal Escape handling for an active dialog-safe shortcut', async () => {
    matchesDialogSafeShortcutMock.mockReturnValue(true);

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const keyHandler = getTerminalKeyHandler(session);

    expect(keyHandler).toBeTypeOf('function');
    const accepted = keyHandler?.(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(accepted).toBe(false);
    expect(matchesDialogSafeShortcutMock).toHaveBeenCalled();

    session.cleanup();
  });

  it('enqueues terminal input for shortcut actions that send escape sequences', async () => {
    const enqueueProgrammaticInput = vi.fn();
    const setNextProgrammaticInputTrace = vi.fn();
    createTerminalInputPipelineMock.mockImplementationOnce(() =>
      createTestTerminalInputPipeline({
        enqueueProgrammaticInput,
        setNextProgrammaticInputTrace,
      }),
    );
    getTerminalShortcutActionMock.mockReturnValue({
      data: '\x1b\r',
      kind: 'send-input',
      preventDefault: true,
    });

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const keyHandler = getTerminalKeyHandler(session);

    expect(keyHandler).toBeTypeOf('function');
    const accepted = keyHandler?.(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));

    expect(accepted).toBe(false);
    expect(setNextProgrammaticInputTrace).toHaveBeenCalledWith('\x1b\r');
    expect(enqueueProgrammaticInput).toHaveBeenCalledWith('\x1b\r');

    session.cleanup();
  });

  it('only marks paint ready after a post-ready render settles', async () => {
    const paintReadyChanges: boolean[] = [];
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      onPaintReadyChange: (isPaintReady) => {
        paintReadyChanges.push(isPaintReady);
      },
      props: createProps(),
    });

    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(500);
    await flushSessionStartup(4);

    expect(paintReadyChanges).toEqual([]);

    emitTerminalRender(session, 0, 10);
    await vi.advanceTimersByTimeAsync(16);

    expect(paintReadyChanges).toEqual([true]);

    session.cleanup();
  });

  it('uses the shorter selected-terminal ready fallback budget during startup', async () => {
    const statusChanges: Array<'attaching' | 'binding' | 'error' | 'ready' | 'restoring'> = [];
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      getStartupPaintRole: () => 'selected',
      onStatusChange: (status) => {
        statusChanges.push(status);
      },
      props: createProps(),
    });

    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(149);
    await flushSessionStartup(4);
    expect(statusChanges).not.toContain('ready');

    await vi.advanceTimersByTimeAsync(1);
    await flushSessionStartup(4);
    expect(statusChanges).toContain('ready');

    session.cleanup();
  });

  it('notifies the recovery runtime when spawn becomes ready', async () => {
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const recoveryRuntime = createTerminalRecoveryRuntimeMock.mock.results[0]?.value;
    await vi.waitFor(() => {
      expect(recoveryRuntime?.notifySpawnReady).toHaveBeenCalledTimes(1);
    });

    session.cleanup();
  });

  it('ignores late existing-session attach recovery after cleanup', async () => {
    const restoreDeferred = createDeferredPromise<undefined>();

    invokeMock.mockResolvedValueOnce({ attachedExistingSession: true });
    createTerminalRecoveryRuntimeMock.mockImplementationOnce(() =>
      createTestTerminalRecoveryRuntime({
        restoreTerminalOutput: vi.fn(async (reason?: string) => {
          if (reason === 'attach') {
            await restoreDeferred.promise;
          }
        }),
      }),
    );

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const recoveryRuntime = createTerminalRecoveryRuntimeMock.mock.results[0]?.value;
    const outputPipeline = createTerminalOutputPipelineMock.mock.results[0]?.value;
    await vi.waitFor(() => {
      expect(recoveryRuntime?.restoreTerminalOutput).toHaveBeenCalledWith('attach');
    });

    session.cleanup();
    restoreDeferred.resolve(undefined);
    await flushSessionStartup(4);

    expect(recoveryRuntime?.notifySpawnReady).not.toHaveBeenCalled();
    expect(outputPipeline?.recoverFlowControlIfIdle).not.toHaveBeenCalled();
  });

  it('seeds recovery runtime from the current browser transport state in browser mode', async () => {
    vi.mocked(isElectronRuntime).mockReturnValue(false);
    vi.mocked(getBrowserTransportConnectionState).mockReturnValue('reconnecting');

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(1);

    expect(createTerminalRecoveryRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialBrowserTransportState: 'reconnecting',
      }),
    );

    session.cleanup();
  });

  it('notifies recovery runtime of browser control authentication separately from raw transport connection', async () => {
    vi.mocked(isElectronRuntime).mockReturnValue(false);

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const recoveryRuntime = createTerminalRecoveryRuntimeMock.mock.results[0]?.value;
    const transportListener = vi.mocked(onBrowserTransportEvent).mock.calls[0]?.[0];
    const authListener = vi.mocked(onBrowserAuthenticated).mock.calls[0]?.[0];

    expect(recoveryRuntime).toBeTruthy();
    expect(transportListener).toBeTypeOf('function');
    expect(authListener).toBeTypeOf('function');

    transportListener?.({ kind: 'connection', state: 'connected' });

    expect(recoveryRuntime?.handleBrowserTransportConnectionState).toHaveBeenCalledWith(
      'connected',
    );
    expect(recoveryRuntime?.handleBrowserControlAuthenticated).not.toHaveBeenCalled();

    authListener?.();

    expect(recoveryRuntime?.handleBrowserControlAuthenticated).toHaveBeenCalledTimes(1);

    session.cleanup();
  });

  it('seeds recovery runtime when browser control is already authenticated before mount', async () => {
    vi.mocked(isElectronRuntime).mockReturnValue(false);
    vi.mocked(isBrowserControlAuthenticated).mockReturnValue(true);

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const recoveryRuntime = createTerminalRecoveryRuntimeMock.mock.results[0]?.value;
    expect(recoveryRuntime?.handleBrowserControlAuthenticated).toHaveBeenCalledTimes(1);

    session.cleanup();
  });

  it('acquires WebGL only after a focused terminal is ready and retains it while the terminal stays visible', async () => {
    const container = createMeasuredContainer();
    let outputPriority:
      | 'focused'
      | 'active-visible'
      | 'switch-target-visible'
      | 'visible-background'
      | 'hidden' = 'focused';

    acquireWebglAddonMock.mockReturnValue({ dispose: vi.fn() });

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => outputPriority,
      props: createProps(),
    });

    await flushSessionStartup(4);

    session.updateOutputPriority();
    expect(acquireWebglAddonMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await flushSessionStartup(4);

    expect(acquireWebglAddonMock).toHaveBeenCalledWith(
      'agent-1',
      expect.any(MockTerminalClass),
      expect.any(Function),
      'focused',
    );
    expect(setWebglAddonPriorityMock).toHaveBeenLastCalledWith('agent-1', 'focused');
    expect(touchWebglAddonMock).toHaveBeenCalledWith('agent-1');

    outputPriority = 'switch-target-visible';
    session.updateOutputPriority();
    expect(releaseWebglAddonMock).not.toHaveBeenCalled();
    expect(setWebglAddonPriorityMock).toHaveBeenLastCalledWith('agent-1', 'visible');

    outputPriority = 'active-visible';
    session.updateOutputPriority();
    expect(releaseWebglAddonMock).not.toHaveBeenCalled();
    expect(setWebglAddonPriorityMock).toHaveBeenLastCalledWith('agent-1', 'visible');

    outputPriority = 'visible-background';
    session.updateOutputPriority();
    expect(releaseWebglAddonMock).not.toHaveBeenCalled();
    expect(setWebglAddonPriorityMock).toHaveBeenLastCalledWith('agent-1', 'visible');

    outputPriority = 'hidden';
    session.updateOutputPriority();
    expect(releaseWebglAddonMock).toHaveBeenCalledWith('agent-1');

    session.cleanup();
  });

  it('loads the WebGL runtime after focused terminal readiness before acquiring the renderer', async () => {
    const container = createMeasuredContainer();
    const deferredWebglRuntime = createDeferredPromise<undefined>();

    isWebglAddonRuntimeReadyMock.mockReturnValue(false);
    preloadWebglAddonMock.mockReturnValue(deferredWebglRuntime.promise);
    acquireWebglAddonMock.mockReturnValue({ dispose: vi.fn() });

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(500);
    await flushSessionStartup(4);

    expect(preloadWebglAddonMock).toHaveBeenCalledTimes(1);
    expect(acquireWebglAddonMock).not.toHaveBeenCalled();

    isWebglAddonRuntimeReadyMock.mockReturnValue(true);
    deferredWebglRuntime.resolve(undefined);
    await flushSessionStartup(2);

    expect(acquireWebglAddonMock).toHaveBeenCalledWith(
      'agent-1',
      expect.any(MockTerminalClass),
      expect.any(Function),
      'focused',
    );

    session.cleanup();
  });

  it('releases WebGL while restore-blocked and keeps it through focused resize commits', async () => {
    const container = createMeasuredContainer();
    const paintReadyChanges: boolean[] = [];
    let restoreBlocked = false;
    let resizePending = false;
    let onRestoreBlockedChange: ((isBlocked: boolean) => void) | undefined;
    let onResizeTransactionChange: ((active: boolean) => void) | undefined;

    createTerminalRecoveryRuntimeMock.mockImplementationOnce(
      (options: RecoveryRuntimeTestOptions) => {
        onRestoreBlockedChange = options.onRestoreBlockedChange;
        return createTestTerminalRecoveryRuntime({
          isRestoreBlocked: vi.fn(() => restoreBlocked),
          restoreTerminalOutput: vi.fn(async () => undefined),
        });
      },
    );
    createTerminalInputPipelineMock.mockImplementationOnce(
      (options: { onResizeTransactionChange?: (active: boolean) => void }) => {
        onResizeTransactionChange = options.onResizeTransactionChange;
        return createTestTerminalInputPipeline({
          isResizeTransactionPending: vi.fn(() => resizePending),
        });
      },
    );
    acquireWebglAddonMock.mockReturnValue({ dispose: vi.fn() });

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'focused',
      onPaintReadyChange: (isPaintReady) => {
        paintReadyChanges.push(isPaintReady);
      },
      props: createProps(),
    });

    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(500);
    await flushSessionStartup(4);
    emitTerminalRender(session, 0, 10);
    await vi.advanceTimersByTimeAsync(16);

    expect(acquireWebglAddonMock).toHaveBeenCalledTimes(1);
    expect(paintReadyChanges).toEqual([true]);

    restoreBlocked = true;
    onRestoreBlockedChange?.(true);
    expect(releaseWebglAddonMock).toHaveBeenCalledWith('agent-1');
    expect(paintReadyChanges).toEqual([true, false]);

    restoreBlocked = false;
    onRestoreBlockedChange?.(false);
    expect(acquireWebglAddonMock).toHaveBeenCalledTimes(2);
    expect(paintReadyChanges).toEqual([true, false]);

    emitTerminalRender(session, 0, 10);
    await vi.advanceTimersByTimeAsync(16);
    expect(paintReadyChanges).toEqual([true, false, true]);

    resizePending = true;
    onResizeTransactionChange?.(true);
    expect(releaseWebglAddonMock).toHaveBeenCalledTimes(1);

    resizePending = false;
    onResizeTransactionChange?.(false);
    expect(acquireWebglAddonMock).toHaveBeenCalledTimes(2);

    session.cleanup();
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
    await vi.advanceTimersByTimeAsync(20);

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
    await flushSessionStartup(4);

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.SpawnAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        baseBranch: undefined,
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
        baseBranch: undefined,
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
    await flushSessionStartup(4);
    expect(renderHibernationChanges).toEqual([true]);
    outputPipelineFactoryState.hasSuppressedOutputSinceHibernation = true;

    session.prewarmRenderHibernation();
    await flushSessionStartup();

    expect(outputPipelineFactoryState.recoveryVisibilitySnapshots).toEqual([true]);

    session.cleanup();
  });

  it('cancels the delayed initial command when the session is cleaned up first', async () => {
    const enqueueProgrammaticInput = vi.fn();
    createTerminalInputPipelineMock.mockImplementationOnce(() =>
      createTestTerminalInputPipeline({
        enqueueProgrammaticInput,
      }),
    );

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
      data: Buffer.from('prompt', 'utf8').toString('base64'),
      type: 'Data',
    });
    session.cleanup();

    await vi.advanceTimersByTimeAsync(50);

    expect(enqueueProgrammaticInput).not.toHaveBeenCalled();
  });

  it('drops malformed base64 terminal output without enqueueing corrupt bytes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let session: ReturnType<typeof startTerminalSession> | undefined;
    try {
      session = startTerminalSession({
        containerRef: createMeasuredContainer(),
        getOutputPriority: () => 'focused',
        props: createProps(),
      });

      await flushSessionStartup();
      outputPipelineFactoryState.lastOutputChannel?.onmessage?.({
        data: 'not-valid-base64!',
        type: 'Data',
      });

      const outputPipeline = createTerminalOutputPipelineMock.mock.results[0]?.value;
      expect(outputPipeline?.enqueueOutput).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[terminal] Ignoring malformed terminal output payload',
        expect.any(Error),
      );
    } finally {
      session?.cleanup();
      warnSpy.mockRestore();
    }
  });

  it('defers session fit stabilization until startup is ready and any resize transaction settles', async () => {
    const container = createMeasuredContainer();
    let resizeTransactionPending = false;
    let onResizeTransactionChangeHandler: ((active: boolean) => void) | undefined;
    createTerminalInputPipelineMock.mockImplementationOnce(
      (options: { onResizeTransactionChange?: (active: boolean) => void }) => {
        onResizeTransactionChangeHandler = options.onResizeTransactionChange;
        return createTestTerminalInputPipeline({
          isResizeTransactionPending: vi.fn(() => resizeTransactionPending),
        });
      },
    );

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

    expect(fitMock).toHaveBeenCalledTimes(1);
    expect(scheduleFitIfDirtyMock).toHaveBeenCalledWith('agent-1');

    session.cleanup();
  });

  it('defers visible-sibling session fit stabilization until selected startup paint is ready', async () => {
    const container = createMeasuredContainer();
    let onReady: (() => void) | undefined;
    let selectedPaintReady = false;
    let startupPaintListener: (() => void) | undefined;
    const originalTerminalExperiments = window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__;

    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      startupSkipNonSelectedVisibleSessionRafFit: true,
      startupVisibleSiblingSessionFitGateUntilSelectedPaintReady: true,
    };

    createTerminalFitLifecycleMock.mockImplementationOnce((options: { onReady?: () => void }) => {
      onReady = options.onReady;
      return createTestTerminalFitLifecycle();
    });

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'visible-background',
      getStartupPaintCoordinationSnapshot: () => ({
        hiddenPendingCount: 0,
        hiddenReadyCount: 0,
        selectedPaintReady,
        selectedPendingCount: selectedPaintReady ? 0 : 1,
        visiblePendingCount: selectedPaintReady ? 0 : 1,
        visibleReadyCount: selectedPaintReady ? 1 : 0,
      }),
      getStartupPaintRole: () => 'visible-sibling',
      props: createProps(),
      subscribeStartupPaintCoordinationChanges: (listener) => {
        startupPaintListener = listener;
        return () => {
          startupPaintListener = undefined;
        };
      },
    });

    await flushSessionStartup(4);
    onReady?.();
    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(500);
    await flushSessionStartup(4);

    const fitMock = outputPipelineFactoryState.fitAddonFits[0];
    expect(fitMock).toBeDefined();
    expect(fitMock).not.toHaveBeenCalled();

    selectedPaintReady = true;
    startupPaintListener?.();
    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(16);

    expect(fitMock).toHaveBeenCalledTimes(1);

    session.cleanup();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = originalTerminalExperiments;
  });

  it('skips redundant restore fit stabilization during attach startup when fit is already ready', async () => {
    const container = createMeasuredContainer();
    let recoveryOptions: RecoveryRuntimeTestOptions | undefined;

    invokeMock.mockResolvedValueOnce({ attachedExistingSession: true });
    createTerminalRecoveryRuntimeMock.mockImplementationOnce(
      (options: RecoveryRuntimeTestOptions) => {
        recoveryOptions = options;
        return createTestTerminalRecoveryRuntime({
          restoreTerminalOutput: vi.fn(async (reason?: string) => {
            if (reason === 'attach') {
              await recoveryOptions?.ensureTerminalFitReady?.('restore');
            }
          }),
        });
      },
    );

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const fitMock = outputPipelineFactoryState.fitAddonFits[0];
    expect(fitMock).toBeDefined();
    expect(fitMock).not.toHaveBeenCalled();

    session.cleanup();
  });

  it('notifies spawn ready after the existing-session attach restore settles', async () => {
    const callSequence: string[] = [];

    invokeMock.mockResolvedValueOnce({ attachedExistingSession: true });
    createTerminalRecoveryRuntimeMock.mockImplementationOnce(() =>
      createTestTerminalRecoveryRuntime({
        notifySpawnReady: vi.fn(() => {
          callSequence.push('notify-spawn-ready');
        }),
        restoreTerminalOutput: vi.fn(async (reason?: string) => {
          if (reason === 'attach') {
            callSequence.push('restore-attach:start');
            await Promise.resolve();
            callSequence.push('restore-attach:end');
          }
        }),
      }),
    );

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);
    await vi.waitFor(() => {
      expect(callSequence).toEqual([
        'restore-attach:start',
        'restore-attach:end',
        'notify-spawn-ready',
      ]);
    });

    session.cleanup();
  });

  it('re-runs fit stabilization when the device pixel ratio changes', async () => {
    const originalDevicePixelRatioDescriptor = Object.getOwnPropertyDescriptor(
      window,
      'devicePixelRatio',
    );
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 1,
    });

    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(500);
    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(16);

    const fitMock = outputPipelineFactoryState.fitAddonFits[0];
    expect(fitMock).toBeDefined();
    fitMock?.mockClear();

    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 1.5,
    });
    window.dispatchEvent(new Event('resize'));
    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(16);

    expect(fitMock).toHaveBeenCalledTimes(1);

    session.cleanup();

    if (originalDevicePixelRatioDescriptor) {
      Object.defineProperty(window, 'devicePixelRatio', originalDevicePixelRatioDescriptor);
    } else {
      // @ts-expect-error test cleanup for synthetic property
      delete window.devicePixelRatio;
    }
  });

  it('yields non-focused fit stabilization while another terminal is typing critically', async () => {
    const session = startTerminalSession({
      containerRef: createMeasuredContainer(),
      getOutputPriority: () => 'visible-background',
      props: createProps(),
    });

    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(500);
    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(16);

    const fitMock = outputPipelineFactoryState.fitAddonFits[0];
    expect(fitMock).toBeDefined();
    fitMock?.mockClear();
    scheduleFitIfDirtyMock.mockClear();

    noteTerminalFocusedInput('other-task', 'other-agent');
    window.dispatchEvent(new Event('resize'));
    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(16);

    expect(fitMock).not.toHaveBeenCalled();

    settleTerminalFocusedInput('other-task', 'other-agent');
    await flushSessionStartup(4);
    await vi.advanceTimersByTimeAsync(16);

    expect(scheduleFitIfDirtyMock).toHaveBeenCalledWith('agent-1');
    expect(fitMock).not.toHaveBeenCalled();

    session.cleanup();
  });

  it('waits for pending resize commit to settle before fit-ready restore continues', async () => {
    const container = createMeasuredContainer();
    const resizeCommit = createDeferredPromise<undefined>();
    const flushPendingResize = vi.fn(() => resizeCommit.promise);
    createTerminalInputPipelineMock.mockImplementationOnce(() =>
      createTestTerminalInputPipeline({
        flushPendingResize,
      }),
    );

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const recoveryOptions = createTerminalRecoveryRuntimeMock.mock.calls[0]?.[0] as
      | {
          ensureTerminalFitReady: (reason: 'renderer-loss' | 'restore') => Promise<boolean>;
        }
      | undefined;

    expect(recoveryOptions).toBeTruthy();

    const flushPendingResizeCallsBeforeRestore = flushPendingResize.mock.calls.length;
    let fitReadyResolved = false;
    const fitReadyPromise =
      recoveryOptions?.ensureTerminalFitReady('restore').then((ready) => {
        fitReadyResolved = ready;
      }) ?? Promise.resolve();

    await Promise.resolve();

    expect(flushPendingResize.mock.calls.length).toBe(flushPendingResizeCallsBeforeRestore + 1);
    expect(fitReadyResolved).toBe(false);

    resizeCommit.resolve(undefined);
    await fitReadyPromise;

    expect(fitReadyResolved).toBe(true);

    session.cleanup();
  });

  it('defers transient non-owner controller updates while browser reconnect restore is still blocking', async () => {
    const container = createMeasuredContainer();
    let restoreBlocked = true;
    let onRestoreBlockedChange: ((isBlocked: boolean) => void) | undefined;
    createTerminalRecoveryRuntimeMock.mockImplementationOnce(
      (options: RecoveryRuntimeTestOptions) => {
        onRestoreBlockedChange = options.onRestoreBlockedChange;
        return createTestTerminalRecoveryRuntime({
          isRestoreBlocked: vi.fn(() => restoreBlocked),
          restoreTerminalOutput: vi.fn(async (reason?: string) => {
            if (reason === 'hibernate') {
              outputPipelineFactoryState.recoveryVisibilitySnapshots.push(
                options.isRenderHibernating(),
              );
            }
          }),
        });
      },
    );
    vi.mocked(isElectronRuntime).mockReturnValue(false);

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const inputPipeline = createTerminalInputPipelineMock.mock.results[0]?.value;
    const handleControllerChange = inputPipeline?.handleControllerChange;
    const flushPendingInput = inputPipeline?.flushPendingInput;
    const drainInputQueue = inputPipeline?.drainInputQueue;
    const controllerListener = vi.mocked(subscribeTaskCommandControllerChanges).mock.calls[0]?.[0];
    const transportListener = vi.mocked(onBrowserTransportEvent).mock.calls[0]?.[0];

    expect(inputPipeline).toBeTruthy();
    expect(controllerListener).toBeTypeOf('function');
    expect(transportListener).toBeTypeOf('function');

    transportListener?.({ kind: 'connection', state: 'disconnected' });
    controllerListener?.({
      action: 'type in the terminal',
      controllerId: 'client-2',
      taskId: 'task-1',
      version: 1,
    });

    expect(inputPipeline?.handleControllerChange).not.toHaveBeenCalledWith('client-2');

    controllerListener?.({
      action: 'type in the terminal',
      controllerId: 'client-1',
      taskId: 'task-1',
      version: 2,
    });

    expect(handleControllerChange).toHaveBeenCalledWith('client-1');
    handleControllerChange?.mockClear();
    flushPendingInput?.mockClear();
    drainInputQueue?.mockClear();

    restoreBlocked = false;
    onRestoreBlockedChange?.(false);
    transportListener?.({ kind: 'connection', state: 'connected' });

    expect(handleControllerChange).not.toHaveBeenCalledWith('client-2');
    expect(flushPendingInput).toHaveBeenCalled();
    expect(drainInputQueue).toHaveBeenCalled();

    session.cleanup();
  });

  it('applies existing task command controller state when a terminal session starts', async () => {
    vi.mocked(getTaskCommandController).mockReturnValue({
      action: 'type in the terminal',
      controllerId: 'client-1',
      version: 1,
    });
    const container = createMeasuredContainer();

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const inputPipeline = createTerminalInputPipelineMock.mock.results[0]?.value;
    expect(inputPipeline?.handleControllerChange).toHaveBeenCalledWith('client-1');

    session.cleanup();
  });

  it('applies deferred non-owner controller loss after browser reconnect restore settles', async () => {
    const container = createMeasuredContainer();
    let restoreBlocked = true;
    let onRestoreBlockedChange: ((isBlocked: boolean) => void) | undefined;
    createTerminalRecoveryRuntimeMock.mockImplementationOnce(
      (options: RecoveryRuntimeTestOptions) => {
        onRestoreBlockedChange = options.onRestoreBlockedChange;
        return createTestTerminalRecoveryRuntime({
          isRestoreBlocked: vi.fn(() => restoreBlocked),
          restoreTerminalOutput: vi.fn(async () => undefined),
        });
      },
    );
    vi.mocked(isElectronRuntime).mockReturnValue(false);

    const session = startTerminalSession({
      containerRef: container,
      getOutputPriority: () => 'focused',
      props: createProps(),
    });

    await flushSessionStartup(4);

    const inputPipeline = createTerminalInputPipelineMock.mock.results[0]?.value;
    const handleControllerChange = inputPipeline?.handleControllerChange;
    const flushPendingInput = inputPipeline?.flushPendingInput;
    const drainInputQueue = inputPipeline?.drainInputQueue;
    const controllerListener = vi.mocked(subscribeTaskCommandControllerChanges).mock.calls[0]?.[0];
    const transportListener = vi.mocked(onBrowserTransportEvent).mock.calls[0]?.[0];

    transportListener?.({ kind: 'connection', state: 'disconnected' });
    controllerListener?.({
      action: 'type in the terminal',
      controllerId: 'client-2',
      taskId: 'task-1',
      version: 1,
    });

    expect(inputPipeline?.handleControllerChange).not.toHaveBeenCalledWith('client-2');

    restoreBlocked = false;
    onRestoreBlockedChange?.(false);
    transportListener?.({ kind: 'connection', state: 'connected' });

    expect(handleControllerChange).toHaveBeenCalledWith('client-2');
    expect(flushPendingInput).toHaveBeenCalled();
    expect(drainInputQueue).toHaveBeenCalled();

    session.cleanup();
  });
});
