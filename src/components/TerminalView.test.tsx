import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { Show, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  beginBrowserColdBootstrap,
  getBrowserStartupState,
  resetBrowserStartupStateForTests,
} from '../app/browser-startup';
import {
  getTerminalAnomalyMonitorSnapshot,
  resetTerminalAnomalyMonitorForTests,
} from '../app/terminal-anomaly-monitor';
import {
  beginPanelResizeDrag,
  endPanelResizeDrag,
  resetPanelResizeDragging,
} from '../app/panel-resize-drag';
import { resetTerminalFramePressureForTests } from '../app/terminal-frame-pressure';
import { requestTerminalPrewarm, resetTerminalPrewarmForTests } from '../app/terminal-prewarm';
import { resetTerminalRecentHiddenReservationForTests } from '../app/terminal-recent-hidden-reservation';
import { resetTerminalSurfaceTieringForTests } from '../app/terminal-surface-tiering';
import {
  getTerminalSwitchEchoGraceSnapshot,
  resetTerminalSwitchEchoGraceForTests,
} from '../app/terminal-switch-echo-grace';
import {
  beginTerminalSwitchWindow,
  getTerminalSwitchWindowSnapshot,
  resetTerminalSwitchWindowForTests,
} from '../app/terminal-switch-window';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from '../app/runtime-diagnostics';
import {
  getTaskTerminalStartupPaintCoordinationSnapshot,
  resetTerminalStartupPaintCoordinationForTests,
} from '../app/terminal-startup-paint';
import { resetTerminalPerformanceExperimentConfigForTests } from '../lib/terminal-performance-experiments';
import { syncTerminalHighLoadMode } from '../app/terminal-high-load-mode';
import { setStore } from '../store/core';
import { resetTaskTerminalSlateCacheForTests } from '../store/task-terminal-slate';
import { resetPendingSessionInputForTests } from './terminal-view/terminal-pending-session-input';
import {
  getTerminalStartupSummary,
  registerTerminalStartupCandidate,
  resetTerminalStartupStateForTests,
} from '../store/terminal-startup';
import { resetStoreForTest } from '../test/store-test-helpers';
import type { StartTerminalSessionOptions } from './terminal-view/terminal-session';
import type { TerminalSearchCapability } from './terminal-view/terminal-search-runtime';

function expectTerminalStartupSummary(
  expected: Partial<NonNullable<ReturnType<typeof getTerminalStartupSummary>>>,
): void {
  expect(getTerminalStartupSummary()).toEqual(expect.objectContaining(expected));
}

const {
  armFocusedTerminalOutputPreemptionMock,
  getTerminalFontFamilyMock,
  getTerminalThemeMock,
  markDirtyMock,
  notifyTerminalAttachPolicyChangedMock,
  registerTerminalAttachCandidateMock,
  requestTerminalOutputDrainMock,
  requestInputTakeoverMock,
  sessionCleanupMock,
  setTaskFocusedPanelStateMock,
  startTerminalSessionMock,
  syncFocusedTypingTaskCommandLeaseMock,
} = vi.hoisted(() => ({
  armFocusedTerminalOutputPreemptionMock: vi.fn(),
  getTerminalFontFamilyMock: vi.fn((font: string) => `font:${font}`),
  getTerminalThemeMock: vi.fn((preset: string) => ({ preset })),
  markDirtyMock: vi.fn(),
  notifyTerminalAttachPolicyChangedMock: vi.fn(),
  registerTerminalAttachCandidateMock: vi.fn(
    (options: { attach: () => void; getPriority: () => number }) => {
      options.attach();
      return {
        release: vi.fn(),
        unregister: vi.fn(),
        updatePriority: vi.fn(),
      };
    },
  ),
  requestTerminalOutputDrainMock: vi.fn(),
  requestInputTakeoverMock: vi.fn().mockResolvedValue(true),
  sessionCleanupMock: vi.fn(),
  setTaskFocusedPanelStateMock: vi.fn(),
  startTerminalSessionMock: vi.fn(),
  syncFocusedTypingTaskCommandLeaseMock: vi.fn(),
}));

vi.mock('./terminal-view/terminal-session', () => ({
  startTerminalSession: startTerminalSessionMock,
}));

vi.mock('./terminal-view/terminal-session-loader', () => ({
  startLoadedTerminalSession: startTerminalSessionMock,
}));

vi.mock('../lib/fonts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fonts')>()),
  getTerminalFontFamily: getTerminalFontFamilyMock,
}));

vi.mock('../lib/theme', () => ({
  getTerminalSearchDecorationTheme: vi.fn(() => ({
    activeMatchBackground: '#ffffff',
    activeMatchBorder: '#ffffff',
    activeMatchColorOverviewRuler: '#ffffff',
    matchBackground: '#777777',
    matchBorder: '#777777',
    matchOverviewRuler: '#777777',
  })),
  getTerminalTheme: getTerminalThemeMock,
  theme: {
    border: '#2b2b2b',
    fg: '#ffffff',
    fgMuted: '#999999',
  },
}));

vi.mock('../lib/terminalFitManager', () => ({
  markDirty: markDirtyMock,
}));

vi.mock('../app/terminal-attach-scheduler', () => ({
  notifyTerminalAttachPolicyChanged: notifyTerminalAttachPolicyChangedMock,
  registerTerminalAttachCandidate: registerTerminalAttachCandidateMock,
}));

vi.mock('../app/terminal-output-scheduler', () => ({
  armFocusedTerminalOutputPreemption: armFocusedTerminalOutputPreemptionMock,
  requestTerminalOutputDrain: requestTerminalOutputDrainMock,
}));

vi.mock('../app/task-command-lease-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app/task-command-lease-session')>()),
  syncFocusedTypingTaskCommandLease: syncFocusedTypingTaskCommandLeaseMock,
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    getPeerTaskCommandControlStatus: (taskId: string, fallbackAction: string) => {
      const controller = core.store.taskCommandControllers[taskId];
      if (!controller || controller.controllerId === 'client-self') {
        return null;
      }

      const action = controller.action ?? fallbackAction;
      return {
        action,
        controllerId: controller.controllerId,
        controllerKey: `${controller.controllerId}:${action}`,
        label: action === 'type in the terminal' ? 'Terminal in use' : 'Read-only',
        message:
          action === 'type in the terminal'
            ? 'Another browser session is currently typing in this terminal.'
            : `Another browser session is controlling this task to ${action}.`,
      };
    },
    setTaskFocusedPanelState: setTaskFocusedPanelStateMock,
    store: core.store,
  };
});

import { TerminalView } from './TerminalView';

type SessionStatus = 'attaching' | 'error' | 'ready' | 'restoring';
type MockSessionOptions = Pick<
  StartTerminalSessionOptions,
  | 'canAcceptInput'
  | 'canBufferInputWhileInteractionPending'
  | 'getRenderHibernationDelayMs'
  | 'isSelectedRecoveryProtected'
  | 'onAttachBound'
  | 'onAttachDispatched'
  | 'onAttachMilestone'
  | 'onAttachUnavailable'
  | 'onBlockedInputAttempt'
  | 'onInputAccepted'
  | 'onLocalInputFeedback'
  | 'onOutputRendered'
  | 'onPaintReadyChange'
  | 'onStartupRenderEvent'
  | 'onStartupWriteRendered'
  | 'onRenderHibernationChange'
  | 'onResizeTransactionChange'
  | 'onRestoreBlockedChange'
  | 'onSearchRequested'
  | 'onSearchResult'
  | 'onSearchUnavailable'
  | 'onSelectedRecoverySettle'
  | 'onSelectedRecoveryStart'
  | 'onStatusChange'
  | 'sessionIdentity'
  | 'shouldCommitResize'
>;
interface MockTerminalSurface {
  blur?: Mock<() => void>;
  focus: Mock<() => void>;
  options: {
    cursorBlink: boolean;
    disableStdin?: boolean;
    fontFamily: string;
    fontSize: number;
    theme: unknown;
  };
}
interface MockTerminalSession {
  cleanup: () => void;
  flushPendingResize: () => Promise<void>;
  handleTerminalData: (data: string) => void;
  isRestoreBlocked: () => boolean;
  prefetchInputLease: () => void;
  prewarmRenderHibernation: () => void;
  requestInputTakeover: () => Promise<boolean>;
  retryAttach: () => void;
  search: {
    [Key in keyof TerminalSearchCapability]: Mock<TerminalSearchCapability[Key]>;
  };
  term: MockTerminalSurface;
  updateOutputPriority: () => void;
}

function createMockTerminalSession(
  overrides: Partial<MockTerminalSession> = {},
): MockTerminalSession {
  return {
    cleanup: sessionCleanupMock,
    flushPendingResize: vi.fn(async () => undefined),
    handleTerminalData: vi.fn(),
    isRestoreBlocked: vi.fn(() => false),
    prefetchInputLease: vi.fn(),
    prewarmRenderHibernation: vi.fn(),
    requestInputTakeover: requestInputTakeoverMock,
    retryAttach: vi.fn(),
    search: {
      clear: vi.fn<TerminalSearchCapability['clear']>(),
      close: vi.fn<TerminalSearchCapability['close']>(),
      find: vi.fn<TerminalSearchCapability['find']>(),
      getSelectionSeed: vi.fn<TerminalSearchCapability['getSelectionSeed']>(() => ''),
      setDecorationTheme: vi.fn<TerminalSearchCapability['setDecorationTheme']>(),
    },
    term: {
      blur: vi.fn(),
      focus: vi.fn(),
      options: {
        cursorBlink: false,
        disableStdin: false,
        fontFamily: '',
        fontSize: 12,
        theme: undefined,
      },
    },
    updateOutputPriority: vi.fn(),
    ...overrides,
  };
}

function getLastSessionOptions(): MockSessionOptions | undefined {
  const lastCall =
    startTerminalSessionMock.mock.calls[startTerminalSessionMock.mock.calls.length - 1];
  return lastCall?.[0] as MockSessionOptions | undefined;
}

function getLastStatusChangeHandler(): ((status: SessionStatus) => void) | undefined {
  return getLastSessionOptions()?.onStatusChange;
}

function getLastAttachBoundHandler(): (() => void) | undefined {
  return getLastSessionOptions()?.onAttachBound;
}

function getLastAttachDispatchedHandler(): (() => void) | undefined {
  return getLastSessionOptions()?.onAttachDispatched;
}

function getLastAttachUnavailableHandler():
  | NonNullable<StartTerminalSessionOptions['onAttachUnavailable']>
  | undefined {
  return getLastSessionOptions()?.onAttachUnavailable;
}

function getLastRenderHibernationHandler(): ((isHibernating: boolean) => void) | undefined {
  return getLastSessionOptions()?.onRenderHibernationChange;
}

function getLastPaintReadyChangeHandler(): ((isPaintReady: boolean) => void) | undefined {
  return getLastSessionOptions()?.onPaintReadyChange;
}

function getLastStartupRenderEventHandler(): (() => void) | undefined {
  return getLastSessionOptions()?.onStartupRenderEvent;
}

function getLastStartupWriteRenderedHandler(): ((byteLength: number) => void) | undefined {
  return getLastSessionOptions()?.onStartupWriteRendered;
}

function getLastRestoreBlockedHandler(): ((isBlocked: boolean) => void) | undefined {
  return getLastSessionOptions()?.onRestoreBlockedChange;
}

function getLastResizeTransactionChangeHandler(): ((isActive: boolean) => void) | undefined {
  return getLastSessionOptions()?.onResizeTransactionChange;
}

function getLastInputAcceptedHandler(): (() => void) | undefined {
  return getLastSessionOptions()?.onInputAccepted;
}

function getLastLocalInputFeedbackHandler(): ((data: string) => void) | undefined {
  return getLastSessionOptions()?.onLocalInputFeedback;
}

function getLastOutputRenderedHandler(): ((byteLength: number) => void) | undefined {
  return getLastSessionOptions()?.onOutputRendered;
}

function getLastSearchRequestedHandler(): StartTerminalSessionOptions['onSearchRequested'] {
  return getLastSessionOptions()?.onSearchRequested;
}

function getLastSearchResultHandler(): StartTerminalSessionOptions['onSearchResult'] {
  return getLastSessionOptions()?.onSearchResult;
}

function getLastSearchUnavailableHandler(): StartTerminalSessionOptions['onSearchUnavailable'] {
  return getLastSessionOptions()?.onSearchUnavailable;
}

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

type IntersectionObserverTestCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

function installIntersectionObserverForTest(
  onConstruct?: (callback: IntersectionObserverTestCallback) => void,
): void {
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: class {
      constructor(callback: IntersectionObserverTestCallback) {
        onConstruct?.(callback);
      }

      disconnect(): void {}

      observe(): void {}
    },
  });
}

describe('TerminalView', () => {
  const originalIntersectionObserver = globalThis.IntersectionObserver;

  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    resetStoreForTest();
    armFocusedTerminalOutputPreemptionMock.mockReset();
    requestTerminalOutputDrainMock.mockReset();
    startTerminalSessionMock.mockReset();
    sessionCleanupMock.mockReset();
    registerTerminalAttachCandidateMock.mockClear();
    markDirtyMock.mockReset();
    getTerminalFontFamilyMock.mockReset();
    getTerminalThemeMock.mockReset();
    setTaskFocusedPanelStateMock.mockReset();
    getTerminalFontFamilyMock.mockImplementation((font: string) => `font:${font}`);
    getTerminalThemeMock.mockImplementation((preset: string) => ({ preset }));
    requestInputTakeoverMock.mockResolvedValue(true);
    delete window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__;
    delete window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__;
    delete window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__;
    delete window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__;
    syncTerminalHighLoadMode(false);
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalAnomalyMonitorForTests();
    resetTerminalStartupPaintCoordinationForTests();
    resetRendererRuntimeDiagnostics();
    resetBrowserStartupStateForTests();
    resetPanelResizeDragging();
    startTerminalSessionMock.mockReturnValue(createMockTerminalSession());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    requestInputTakeoverMock.mockReset();
    delete window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__;
    delete window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__;
    delete window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__;
    delete window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: originalIntersectionObserver,
    });
    resetTerminalStartupStateForTests();
    resetTerminalPrewarmForTests();
    resetTerminalRecentHiddenReservationForTests();
    resetTerminalAnomalyMonitorForTests();
    resetTerminalStartupPaintCoordinationForTests();
    resetPanelResizeDragging();
    resetTerminalSurfaceTieringForTests();
    resetTerminalSwitchEchoGraceForTests();
    resetTerminalSwitchWindowForTests();
    resetTerminalFramePressureForTests();
    resetTerminalPerformanceExperimentConfigForTests();
    resetRendererRuntimeDiagnostics();
    resetBrowserStartupStateForTests();
    syncTerminalHighLoadMode(false);
    resetStoreForTest();
  });

  it('starts and cleans up the terminal session', () => {
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);

    result.unmount();

    expect(sessionCleanupMock).toHaveBeenCalledTimes(1);
  });

  it('passes task watcher ownership into the loaded terminal session', () => {
    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="shell-1"
        command="bash"
        args={['-l']}
        cwd="/tmp/project"
        isShell
        startsTaskWatchers
      />
    ));

    expect(startTerminalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        props: expect.objectContaining({
          agentId: 'shell-1',
          isShell: true,
          startsTaskWatchers: true,
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('opens local terminal search for the exact session and seeds one bounded selection', async () => {
    const session = createMockTerminalSession();
    session.search.getSelectionSeed.mockReturnValue('selected output');
    startTerminalSessionMock.mockReturnValueOnce(session);
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));
    const options = getLastSessionOptions();
    session.search.setDecorationTheme.mockClear();
    syncFocusedTypingTaskCommandLeaseMock.mockClear();

    getLastSearchRequestedHandler()?.(options?.sessionIdentity ?? '', session.search);
    await Promise.resolve();

    const input = result.getByLabelText('Find in terminal') as HTMLInputElement;
    expect(input.value).toBe('selected output');
    expect(document.activeElement).toBe(input);
    expect(session.search.find).toHaveBeenCalledWith('selected output', {
      direction: 'next',
      incremental: true,
    });
    expect(session.search.setDecorationTheme).toHaveBeenCalledTimes(1);
    expect(session.handleTerminalData).not.toHaveBeenCalled();
    expect(syncFocusedTypingTaskCommandLeaseMock).not.toHaveBeenCalled();
  });

  it('keeps terminal search usable while peer-controlled without hiding task control', () => {
    setStore('taskCommandControllers', 'task-1', {
      action: 'type in the terminal',
      controllerId: 'peer-client',
    });
    const session = createMockTerminalSession();
    startTerminalSessionMock.mockReturnValueOnce(session);
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    getLastStatusChangeHandler()?.('ready');
    getLastSearchRequestedHandler()?.(
      getLastSessionOptions()?.sessionIdentity ?? '',
      session.search,
    );

    expect(result.getByRole('search')).toBeTruthy();
    expect(
      result.getByText('Another browser session is currently typing in this terminal.'),
    ).toBeTruthy();
    expect(result.getByRole('button', { name: 'Take Over' })).toBeTruthy();
  });

  it('updates, navigates, closes, and restores focus only to the same live session', async () => {
    const session = createMockTerminalSession();
    startTerminalSessionMock.mockReturnValueOnce(session);
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));
    getLastStatusChangeHandler()?.('ready');
    const identity = getLastSessionOptions()?.sessionIdentity ?? '';
    getLastSearchRequestedHandler()?.(identity, session.search);
    const input = result.getByLabelText('Find in terminal') as HTMLInputElement;

    fireEvent.input(input, { target: { value: 'needle' } });
    expect(session.search.find).toHaveBeenLastCalledWith('needle', {
      direction: 'next',
      incremental: true,
    });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(session.search.find).toHaveBeenLastCalledWith('needle', {
      direction: 'previous',
      incremental: false,
    });
    expect(session.handleTerminalData).not.toHaveBeenCalled();

    session.term.focus.mockClear();
    fireEvent.keyDown(input, { key: 'Escape' });
    await Promise.resolve();
    expect(result.queryByRole('search')).toBeNull();
    expect(session.search.close).toHaveBeenCalledTimes(1);
    expect(session.term.focus).toHaveBeenCalledTimes(1);
  });

  it('preserves terminal-search input and query while the same terminal recovers', async () => {
    const session = createMockTerminalSession();
    startTerminalSessionMock.mockReturnValueOnce(session);
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));
    getLastStatusChangeHandler()?.('ready');
    getLastPaintReadyChangeHandler()?.(true);
    getLastSearchRequestedHandler()?.(
      getLastSessionOptions()?.sessionIdentity ?? '',
      session.search,
    );
    const input = result.getByLabelText('Find in terminal') as HTMLInputElement;
    input.focus();
    fireEvent.input(input, { target: { value: 'keep query' } });
    session.term.focus.mockClear();
    getLastStatusChangeHandler()?.('restoring');
    getLastStatusChangeHandler()?.('ready');
    await Promise.resolve();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('keep query');
    expect(session.term.focus).not.toHaveBeenCalled();
    hasFocusSpy.mockRestore();
  });

  it('ignores stale search owners and result callbacks', () => {
    const session = createMockTerminalSession();
    session.search.getSelectionSeed.mockReturnValue('needle');
    startTerminalSessionMock.mockReturnValueOnce(session);
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));
    const identity = getLastSessionOptions()?.sessionIdentity ?? '';

    getLastSearchRequestedHandler()?.('stale-session', session.search);
    expect(result.queryByRole('search')).toBeNull();

    getLastSearchRequestedHandler()?.(identity, session.search);
    getLastSearchResultHandler()?.('stale-session', session.search, { count: 9, index: 4 });
    expect(result.getByRole('status').textContent).toBe('Searching…');
    getLastSearchResultHandler()?.(identity, session.search, { count: 3, index: 1 });
    expect(result.getByRole('status').textContent).toBe('2/3');
  });

  it('shows a local unavailable state, does not retry while open, and always allows close', () => {
    const session = createMockTerminalSession();
    session.search.getSelectionSeed.mockReturnValue('needle');
    startTerminalSessionMock.mockReturnValueOnce(session);
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));
    const identity = getLastSessionOptions()?.sessionIdentity ?? '';
    getLastSearchRequestedHandler()?.(identity, session.search);
    getLastSearchUnavailableHandler()?.(identity, session.search);

    const input = result.getByLabelText('Find in terminal');
    expect(result.getByText('Search unavailable')).toBeTruthy();
    fireEvent.input(input, { target: { value: 'another' } });
    expect(session.search.find).toHaveBeenCalledTimes(1);
    fireEvent.click(result.getByLabelText('Close terminal search'));
    expect(result.queryByRole('search')).toBeNull();
  });

  it('focuses the existing overlay on repeated Find and closes without focus on teardown', async () => {
    const session = createMockTerminalSession();
    startTerminalSessionMock.mockReturnValueOnce(session);
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));
    const identity = getLastSessionOptions()?.sessionIdentity ?? '';
    const requestSearch = getLastSearchRequestedHandler();
    requestSearch?.(identity, session.search);
    const nextButton = result.getByLabelText('Next terminal match') as HTMLButtonElement;
    nextButton.focus();

    requestSearch?.(identity, session.search);
    await Promise.resolve();
    expect(document.activeElement).toBe(result.getByLabelText('Find in terminal'));
    expect(session.search.clear).toHaveBeenCalledTimes(1);

    session.term.focus.mockClear();
    result.unmount();
    expect(session.search.close).toHaveBeenCalledTimes(1);
    expect(session.term.focus).not.toHaveBeenCalled();
  });

  it('does not read disposed task identity during terminal session cleanup callbacks', () => {
    const [task, setTask] = createSignal<{ id: string } | null>({ id: 'task-1' });
    startTerminalSessionMock.mockImplementation((options: StartTerminalSessionOptions) =>
      createMockTerminalSession({
        cleanup: () => {
          options.onPaintReadyChange?.(false);
          options.onRestoreBlockedChange?.(false);
        },
      }),
    );

    render(() => (
      <Show when={task()}>
        {(currentTask) => (
          <TerminalView
            taskId={currentTask().id}
            agentId="agent-1"
            command="claude"
            args={[]}
            cwd="/tmp/project"
            isFocused
          />
        )}
      </Show>
    ));

    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(() => setTask(null)).not.toThrow();
  });

  it('mounts the live xterm surface in an inset fit container', () => {
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const liveSurface = result.container.querySelector<HTMLElement>(
      '[data-terminal-live-surface="true"]',
    );

    expect(liveSurface?.style.position).toBe('absolute');
    expect(liveSurface?.style.inset).toBe('4px');
    expect(liveSurface?.style.padding).toBe('');
  });

  it('shows local input ack pulse by default from the terminal input feedback setting', () => {
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    getLastStatusChangeHandler()?.('ready');
    getLastLocalInputFeedbackHandler()?.('a');

    expect(result.container.querySelector('[data-terminal-input-ack="true"]')).not.toBeNull();
  });

  it('keeps the terminal input acknowledgement frame disabled when the setting is off', () => {
    setStore('activeTaskId', 'task-1');
    setStore('terminalLocalInputFeedbackEnabled', false);
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    getLastStatusChangeHandler()?.('ready');
    getLastLocalInputFeedbackHandler()?.('a');

    expect(result.container.querySelector('[data-terminal-input-ack="true"]')).toBeNull();
  });

  it('shows the experiment-gated terminal input acknowledgement and clears it after output renders', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      inputAcknowledgementDurationMs: 240,
      inputAcknowledgementMode: 'pulse',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setStore('activeTaskId', 'task-1');
    setStore('terminalLocalInputFeedbackEnabled', false);

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    getLastStatusChangeHandler()?.('ready');
    getLastInputAcceptedHandler()?.();

    expect(result.container.querySelector('[data-terminal-input-ack="true"]')).not.toBeNull();

    getLastOutputRenderedHandler()?.(1);

    expect(result.container.querySelector('[data-terminal-input-ack="true"]')).toBeNull();
  });

  it('expires the terminal input acknowledgement when no output arrives', () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      inputAcknowledgementDurationMs: 240,
      inputAcknowledgementMode: 'pulse',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setStore('activeTaskId', 'task-1');
    setStore('terminalLocalInputFeedbackEnabled', false);

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    getLastStatusChangeHandler()?.('ready');
    getLastInputAcceptedHandler()?.();

    expect(result.container.querySelector('[data-terminal-input-ack="true"]')).not.toBeNull();

    vi.advanceTimersByTime(239);
    expect(result.container.querySelector('[data-terminal-input-ack="true"]')).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(result.container.querySelector('[data-terminal-input-ack="true"]')).toBeNull();
  });

  it('shows local input ack pulse immediately when the local feedback experiment is enabled', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      localInputFeedbackDurationMs: 240,
      localInputFeedbackMode: 'ack-pulse',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setStore('activeTaskId', 'task-1');

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    getLastStatusChangeHandler()?.('ready');
    getLastLocalInputFeedbackHandler()?.('a');

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    const pulse = result.container.querySelector('[data-terminal-input-ack="true"]');
    expect(pulse).toBe(terminalRoot);
    expect(pulse?.getAttribute('data-terminal-input-ack-phase')).toBe('odd');
    expect(result.container.querySelector('.terminal-input-ack-overlay')).toBeNull();

    getLastLocalInputFeedbackHandler()?.('b');

    expect(terminalRoot?.getAttribute('data-terminal-input-ack-phase')).toBe('even');

    getLastOutputRenderedHandler()?.(1);

    expect(result.container.querySelector('[data-terminal-input-ack="true"]')).toBeNull();
  });

  it('lets the local input feedback experiment override disable the setting', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      localInputFeedbackMode: 'off',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setStore('activeTaskId', 'task-1');
    setStore('terminalLocalInputFeedbackEnabled', true);

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    getLastStatusChangeHandler()?.('ready');
    getLastLocalInputFeedbackHandler()?.('a');

    expect(result.container.querySelector('[data-terminal-input-ack="true"]')).toBeNull();
  });

  it('reacts to focus, font size, terminal font, and theme changes', async () => {
    const [fontSize, setFontSize] = createSignal<number | undefined>(12);
    const [focused, setFocused] = createSignal(false);
    setStore('activeTaskId', 'task-1');

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        fontSize={fontSize()}
        isFocused={focused()}
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as {
      term: {
        options: {
          cursorBlink: boolean;
          fontFamily: string;
          fontSize: number;
          theme: unknown;
        };
      };
    };

    expect(session.term.options.fontSize).toBe(12);

    setFontSize(18);
    expect(session.term.options.fontSize).toBe(18);
    expect(markDirtyMock).toHaveBeenCalledWith('agent-1', 'font-size');

    setStore('terminalFont', 'Fira Code');
    expect(getTerminalFontFamilyMock).toHaveBeenCalledWith('Fira Code');
    expect(session.term.options.fontFamily).toBe('font:Fira Code');
    expect(markDirtyMock).toHaveBeenCalledWith('agent-1', 'font-family');

    setStore('themePreset', 'classic');
    expect(getTerminalThemeMock).toHaveBeenCalledWith('classic');
    expect(session.term.options.theme).toEqual({ preset: 'classic' });
    expect(markDirtyMock).toHaveBeenCalledWith('agent-1', 'theme');

    getLastStatusChangeHandler()?.('ready');
    setFocused(true);
    expect(session.term.options.cursorBlink).toBe(true);
  });

  it('suppresses cursor blinking while restore is blocked and reenables it when recovery settles', () => {
    const [focused] = createSignal(true);
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={focused()}
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const statusHandler = getLastStatusChangeHandler();
    const restoreBlockedHandler = getLastRestoreBlockedHandler();
    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');

    statusHandler?.('ready');
    expect(session.term.options.cursorBlink).toBe(true);
    expect(terminalRoot?.hasAttribute('data-terminal-restore-blocked')).toBe(false);

    restoreBlockedHandler?.(true);
    expect(session.term.options.cursorBlink).toBe(false);
    expect(terminalRoot?.getAttribute('data-terminal-restore-blocked')).toBe('true');

    restoreBlockedHandler?.(false);
    expect(session.term.options.cursorBlink).toBe(true);
    expect(terminalRoot?.hasAttribute('data-terminal-restore-blocked')).toBe(false);
  });

  it('suppresses cursor blinking while the terminal is render-hibernating', () => {
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={true}
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const statusHandler = getLastStatusChangeHandler();
    const renderHibernationHandler = getLastRenderHibernationHandler();

    statusHandler?.('ready');
    expect(session.term.options.cursorBlink).toBe(true);

    renderHibernationHandler?.(true);
    expect(session.term.options.cursorBlink).toBe(false);

    renderHibernationHandler?.(false);
    expect(session.term.options.cursorBlink).toBe(true);

    expect(
      result.container
        .querySelector('[data-terminal-agent-id="agent-1"]')
        ?.hasAttribute('data-terminal-render-hibernating'),
    ).toBe(false);
  });

  it('only blinks the cursor while the focused terminal is ready and live', () => {
    const [focused, setFocused] = createSignal(false);
    setStore('activeTaskId', 'task-1');
    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={focused()}
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const blurMock = session.term.blur as ReturnType<typeof vi.fn>;
    const statusHandler = getLastStatusChangeHandler();

    statusHandler?.('ready');
    blurMock.mockClear();
    expect(session.term.options.cursorBlink).toBe(false);
    expect(blurMock).not.toHaveBeenCalled();

    setFocused(true);
    expect(session.term.options.cursorBlink).toBe(true);
    expect(blurMock).not.toHaveBeenCalled();

    statusHandler?.('attaching');
    expect(session.term.options.cursorBlink).toBe(false);

    statusHandler?.('restoring');
    expect(session.term.options.cursorBlink).toBe(false);

    statusHandler?.('error');
    expect(session.term.options.cursorBlink).toBe(false);

    statusHandler?.('ready');
    expect(session.term.options.cursorBlink).toBe(true);
    blurMock.mockClear();

    setFocused(false);
    expect(session.term.options.cursorBlink).toBe(false);
    expect(blurMock).toHaveBeenCalledTimes(1);
  });

  it('suppresses xterm stdin while still allowing buffering while the focused terminal is attaching or restoring', () => {
    setStore('activeTaskId', 'task-1');
    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const sessionOptions = getLastSessionOptions();
    const statusHandler = getLastStatusChangeHandler();

    statusHandler?.('ready');
    expect(session.term.options.disableStdin).toBe(true);
    expect(sessionOptions?.canAcceptInput?.()).toBe(false);

    getLastPaintReadyChangeHandler()?.(true);
    expect(session.term.options.disableStdin).toBe(false);
    expect(sessionOptions?.canAcceptInput?.()).toBe(true);

    statusHandler?.('attaching');
    expect(session.term.options.disableStdin).toBe(true);
    expect(sessionOptions?.canAcceptInput?.()).toBe(false);
    expect(sessionOptions?.canBufferInputWhileInteractionPending?.()).toBe(true);

    statusHandler?.('restoring');
    expect(session.term.options.disableStdin).toBe(true);
    expect(sessionOptions?.canAcceptInput?.()).toBe(false);
    expect(sessionOptions?.canBufferInputWhileInteractionPending?.()).toBe(true);

    statusHandler?.('ready');
    getLastPaintReadyChangeHandler()?.(true);
    expect(session.term.options.disableStdin).toBe(false);
    expect(sessionOptions?.canAcceptInput?.()).toBe(true);
  });

  it('captures printable input for buffering while the focused terminal is restoring', () => {
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');

    getLastStatusChangeHandler()?.('restoring');
    fireEvent.keyDown(terminalRoot as Element, { key: 'a' });
    fireEvent.keyDown(terminalRoot as Element, { key: 'Enter' });

    expect(session.handleTerminalData).toHaveBeenCalledWith('a');
    expect(session.handleTerminalData).toHaveBeenCalledWith('\r');
  });

  it('captures TUI navigation keys for buffering while the focused terminal is restoring', () => {
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');

    getLastStatusChangeHandler()?.('restoring');
    fireEvent.keyDown(terminalRoot as Element, { key: 'ArrowUp' });
    fireEvent.keyDown(terminalRoot as Element, { key: 'ArrowDown' });
    fireEvent.keyDown(terminalRoot as Element, { key: 'Delete' });
    fireEvent.keyDown(terminalRoot as Element, { key: 'Tab', shiftKey: true });

    expect(session.handleTerminalData).toHaveBeenCalledWith('\x1b[A');
    expect(session.handleTerminalData).toHaveBeenCalledWith('\x1b[B');
    expect(session.handleTerminalData).toHaveBeenCalledWith('\x1b[3~');
    expect(session.handleTerminalData).toHaveBeenCalledWith('\x1b[Z');
  });

  it('buffers keystrokes typed before the session exists and flushes them in order at session start', () => {
    resetPendingSessionInputForTests();
    setStore('activeTaskId', 'task-1');
    let pendingAttach: (() => void) | undefined;
    registerTerminalAttachCandidateMock.mockImplementationOnce(
      (options: { attach: () => void; getPriority: () => number }) => {
        pendingAttach = options.attach;
        return {
          release: vi.fn(),
          unregister: vi.fn(),
          updatePriority: vi.fn(),
        };
      },
    );
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    fireEvent.keyDown(terminalRoot as Element, { key: 'a' });
    fireEvent.keyDown(terminalRoot as Element, { key: 'b' });
    fireEvent.keyDown(terminalRoot as Element, { key: 'Enter' });

    const queuedIndicator = result.container.querySelector('[data-terminal-queued-input-count]');
    expect(queuedIndicator?.getAttribute('data-terminal-queued-input-count')).toBe('3');
    expect(queuedIndicator?.textContent).toContain('3 keys queued');

    pendingAttach?.();
    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const handleTerminalDataMock = vi.mocked(session.handleTerminalData);
    expect(handleTerminalDataMock.mock.calls[0]?.[0]).toBe('ab\r');

    fireEvent.keyDown(terminalRoot as Element, { key: 'c' });
    expect(handleTerminalDataMock.mock.calls[1]?.[0]).toBe('c');

    expect(result.container.querySelector('[data-terminal-queued-input-count]')).toBeNull();
  });

  it('shows a single queued key with singular copy while waiting for the session', () => {
    resetPendingSessionInputForTests();
    setStore('activeTaskId', 'task-1');
    registerTerminalAttachCandidateMock.mockImplementationOnce(() => ({
      release: vi.fn(),
      unregister: vi.fn(),
      updatePriority: vi.fn(),
    }));
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    fireEvent.keyDown(
      result.container.querySelector('[data-terminal-agent-id="agent-1"]') as Element,
      { key: 'x' },
    );

    const queuedIndicator = result.container.querySelector('[data-terminal-queued-input-count]');
    expect(queuedIndicator?.textContent).toContain('1 key queued');
    resetPendingSessionInputForTests();
  });

  it('renders the cached last-known screen under the loading overlay and drops it at live render ready', () => {
    resetTaskTerminalSlateCacheForTests();
    setStore('activeTaskId', 'task-1');
    setStore('agentSupervision', {
      'agent-1': {
        agentId: 'agent-1',
        attentionReason: null,
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'npm run build — done in 4.2s',
        state: 'active',
        taskId: 'task-1',
        updatedAt: 1_000,
      },
    });
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    expect(result.container.querySelector('[data-terminal-loading-overlay="true"]')).not.toBeNull();
    const placeholder = result.container.querySelector('[data-terminal-placeholder-tail="true"]');
    expect(placeholder?.textContent).toBe('npm run build — done in 4.2s');
    expect(
      result.container.querySelector('[data-terminal-loading-label="true"]')?.textContent,
    ).toBe('Preparing terminal…');

    getLastStatusChangeHandler()?.('ready');

    expect(result.container.querySelector('[data-terminal-placeholder-tail="true"]')).toBeNull();
    expect(result.container.querySelector('[data-terminal-loading-overlay="true"]')).toBeNull();
  });

  it('keeps the loading overlay free of placeholder markup when no last-known screen exists', () => {
    resetTaskTerminalSlateCacheForTests();
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    expect(result.container.querySelector('[data-terminal-loading-overlay="true"]')).not.toBeNull();
    expect(result.container.querySelector('[data-terminal-placeholder-tail="true"]')).toBeNull();
  });

  it('fills an empty placeholder when the supervision preview hydrates during cold-start loading', () => {
    resetTaskTerminalSlateCacheForTests();
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    expect(result.container.querySelector('[data-terminal-placeholder-tail="true"]')).toBeNull();

    setStore('agentSupervision', {
      'agent-1': {
        agentId: 'agent-1',
        attentionReason: null,
        isShell: false,
        lastOutputAt: 1_000,
        preview: 'hydrated preview line',
        state: 'active',
        taskId: 'task-1',
        updatedAt: 1_000,
      },
    });

    expect(
      result.container.querySelector('[data-terminal-placeholder-tail="true"]')?.textContent,
    ).toBe('hydrated preview line');
  });

  it('keeps buffering restore input when terminal focus briefly falls back to the document', () => {
    setStore('activeTaskId', 'task-1');
    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;

    getLastStatusChangeHandler()?.('restoring');
    fireEvent.keyDown(document.body, { key: 'a' });

    expect(session.handleTerminalData).toHaveBeenCalledWith('a');
  });

  it('buffers terminal beforeinput text while restore keydown handling is bypassed', () => {
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    const beforeInputEvent = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: 'a',
      inputType: 'insertText',
    });

    getLastStatusChangeHandler()?.('restoring');
    terminalRoot?.dispatchEvent(beforeInputEvent);

    expect(beforeInputEvent.defaultPrevented).toBe(true);
    expect(session.handleTerminalData).toHaveBeenCalledWith('a');
  });

  it('keeps the first post-restore key burst on the ordered input path after paint readiness', () => {
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');

    getLastStatusChangeHandler()?.('ready');
    getLastPaintReadyChangeHandler()?.(true);
    fireEvent.keyDown(terminalRoot as Element, { key: 'a' });

    expect(session.handleTerminalData).toHaveBeenCalledWith('a');
  });

  it('releases restore input capture after the ready terminal drains the first burst', () => {
    vi.useFakeTimers();
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');

    getLastStatusChangeHandler()?.('restoring');
    const restoringEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'a',
    });
    terminalRoot?.dispatchEvent(restoringEvent);
    expect(restoringEvent.defaultPrevented).toBe(true);
    expect(session.handleTerminalData).toHaveBeenCalledWith('a');

    getLastStatusChangeHandler()?.('ready');
    getLastPaintReadyChangeHandler()?.(true);
    vi.advanceTimersByTime(251);

    const readyEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'b',
    });
    terminalRoot?.dispatchEvent(readyEvent);

    expect(readyEvent.defaultPrevented).toBe(false);
    expect(session.handleTerminalData).not.toHaveBeenCalledWith('b');
  });

  it('does not steal restore input from editable controls outside the terminal', () => {
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <>
        <input aria-label="outside input" />
        <TerminalView
          taskId="task-1"
          agentId="agent-1"
          command="claude"
          args={[]}
          cwd="/tmp/project"
          isFocused
        />
      </>
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const outsideInput = result.getByLabelText('outside input');

    getLastStatusChangeHandler()?.('restoring');
    fireEvent.keyDown(outsideInput, { key: 'a' });

    expect(session.handleTerminalData).not.toHaveBeenCalled();
  });

  it('requires the active command target before blinking the cursor or accepting input', () => {
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    const sessionOptions = getLastSessionOptions();

    getLastStatusChangeHandler()?.('ready');
    getLastPaintReadyChangeHandler()?.(true);

    expect(session.term.options.cursorBlink).toBe(false);
    expect(session.term.options.disableStdin).toBe(true);
    expect(sessionOptions?.canAcceptInput?.()).toBe(false);
    expect(terminalRoot?.hasAttribute('data-terminal-cursor-blink')).toBe(false);

    setStore('activeTaskId', 'task-1');

    expect(session.term.options.cursorBlink).toBe(true);
    expect(session.term.options.disableStdin).toBe(false);
    expect(sessionOptions?.canAcceptInput?.()).toBe(true);
    expect(terminalRoot?.getAttribute('data-terminal-cursor-blink')).toBe('true');
  });

  it('suppresses cursor blinking and stdin while a resize transaction is active', () => {
    setStore('activeTaskId', 'task-1');
    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const sessionOptions = getLastSessionOptions();

    getLastStatusChangeHandler()?.('ready');
    getLastPaintReadyChangeHandler()?.(true);
    expect(session.term.options.cursorBlink).toBe(true);
    expect(session.term.options.disableStdin).toBe(false);
    expect(sessionOptions?.canAcceptInput?.()).toBe(true);

    getLastResizeTransactionChangeHandler()?.(true);
    expect(session.term.options.cursorBlink).toBe(false);
    expect(session.term.options.disableStdin).toBe(true);
    expect(sessionOptions?.canAcceptInput?.()).toBe(false);

    getLastResizeTransactionChangeHandler()?.(false);
    expect(session.term.options.cursorBlink).toBe(true);
    expect(session.term.options.disableStdin).toBe(false);
    expect(sessionOptions?.canAcceptInput?.()).toBe(true);
  });

  it('buffers terminal input while resize temporarily blocks direct stdin', () => {
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const sessionOptions = getLastSessionOptions();
    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');

    getLastStatusChangeHandler()?.('ready');
    getLastPaintReadyChangeHandler()?.(true);
    getLastResizeTransactionChangeHandler()?.(true);

    expect(session.term.options.disableStdin).toBe(true);
    expect(sessionOptions?.canAcceptInput?.()).toBe(false);
    expect(sessionOptions?.canBufferInputWhileInteractionPending?.()).toBe(true);

    const keyEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'x',
    });
    terminalRoot?.dispatchEvent(keyEvent);

    expect(keyEvent.defaultPrevented).toBe(true);
    expect(session.handleTerminalData).toHaveBeenCalledWith('x');
  });

  it('captures xterm textarea input while resize temporarily disables stdin', () => {
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    const terminalInput = document.createElement('textarea');
    terminalInput.setAttribute('aria-label', 'Terminal input');
    terminalRoot?.appendChild(terminalInput);

    getLastStatusChangeHandler()?.('ready');
    getLastPaintReadyChangeHandler()?.(true);
    getLastResizeTransactionChangeHandler()?.(true);
    expect(session.term.options.disableStdin).toBe(true);

    const keyEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'E',
    });
    terminalInput.dispatchEvent(keyEvent);

    expect(keyEvent.defaultPrevented).toBe(true);
    expect(session.handleTerminalData).toHaveBeenCalledWith('E');
  });

  it('updates cursor blinking when DOM focus moves into and out of the terminal', async () => {
    setStore('activeTaskId', 'task-1');
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={false}
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const blurMock = session.term.blur as ReturnType<typeof vi.fn>;
    const statusHandler = getLastStatusChangeHandler();
    const terminalRoot = result.container.querySelector(
      '[data-terminal-agent-id="agent-1"]',
    ) as HTMLDivElement | null;
    const terminalInput = document.createElement('textarea');
    const outsideButton = document.createElement('button');
    terminalInput.setAttribute('aria-label', 'Terminal input');

    expect(terminalRoot).toBeTruthy();
    terminalRoot?.appendChild(terminalInput);
    document.body.appendChild(outsideButton);

    statusHandler?.('ready');
    blurMock.mockClear();
    expect(session.term.options.cursorBlink).toBe(false);
    expect(terminalRoot?.hasAttribute('data-terminal-cursor-blink')).toBe(false);
    expect(blurMock).not.toHaveBeenCalled();

    terminalInput.focus();
    terminalInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await Promise.resolve();

    expect(session.term.options.cursorBlink).toBe(true);
    expect(terminalRoot?.getAttribute('data-terminal-cursor-blink')).toBe('true');

    outsideButton.focus();
    outsideButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await Promise.resolve();

    expect(session.term.options.cursorBlink).toBe(false);
    expect(terminalRoot?.hasAttribute('data-terminal-cursor-blink')).toBe(false);
    expect(blurMock).toHaveBeenCalledTimes(1);

    outsideButton.remove();
  });

  it('ignores focus on takeover controls when computing terminal cursor blinking', async () => {
    setStore('taskCommandControllers', 'task-1', {
      action: 'type in the terminal',
      controllerId: 'peer-client',
    });

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={false}
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const statusHandler = getLastStatusChangeHandler();
    statusHandler?.('ready');

    const takeOverButton = await result.findByRole('button', { name: 'Take Over' });
    takeOverButton.focus();
    takeOverButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await Promise.resolve();

    expect(session.term.options.cursorBlink).toBe(false);
  });

  it('restores DOM focus for a focused terminal after recovery completes and paint is ready', async () => {
    const session = createMockTerminalSession();
    startTerminalSessionMock.mockReturnValueOnce(session);
    let documentFocused = false;
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockImplementation(() => documentFocused);

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={true}
      />
    ));

    const statusHandler = getLastStatusChangeHandler();
    const restoreBlockedHandler = getLastRestoreBlockedHandler();

    statusHandler?.('restoring');
    restoreBlockedHandler?.(true);
    statusHandler?.('ready');
    restoreBlockedHandler?.(false);

    expect(session.term.focus).not.toHaveBeenCalled();

    documentFocused = true;
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();

    expect(session.term.focus).not.toHaveBeenCalled();

    getLastPaintReadyChangeHandler()?.(true);
    await Promise.resolve();

    expect(session.term.focus).toHaveBeenCalledTimes(1);
    hasFocusSpy.mockRestore();
  });

  it('focuses a ready live terminal when app focus moves to it', async () => {
    const session = createMockTerminalSession();
    startTerminalSessionMock.mockReturnValueOnce(session);
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockImplementation(() => true);
    const [focused, setFocused] = createSignal(false);
    setStore('activeTaskId', 'task-1');

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={focused()}
      />
    ));

    getLastStatusChangeHandler()?.('ready');
    getLastPaintReadyChangeHandler()?.(true);
    await Promise.resolve();

    expect(session.term.focus).not.toHaveBeenCalled();

    setFocused(true);
    await Promise.resolve();

    expect(session.term.focus).toHaveBeenCalledTimes(1);
    hasFocusSpy.mockRestore();
  });

  it('does not steal DOM focus back from sidebar-owned focus after recovery', async () => {
    const session = createMockTerminalSession();
    startTerminalSessionMock.mockReturnValueOnce(session);
    let documentFocused = false;
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockImplementation(() => documentFocused);

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={true}
      />
    ));

    const statusHandler = getLastStatusChangeHandler();
    const restoreBlockedHandler = getLastRestoreBlockedHandler();

    statusHandler?.('restoring');
    restoreBlockedHandler?.(true);
    statusHandler?.('ready');
    restoreBlockedHandler?.(false);

    documentFocused = true;
    setStore('sidebarFocused', true);
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();

    expect(session.term.focus).not.toHaveBeenCalled();
    hasFocusSpy.mockRestore();
  });

  it.each(['input', 'textarea', 'select', 'contenteditable'])(
    'preserves a focused %s during recovery even when terminal intent is stale',
    async (kind) => {
      const session = createMockTerminalSession();
      startTerminalSessionMock.mockReturnValueOnce(session);
      const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const [focused, setFocused] = createSignal(true);
      const editor = document.createElement(kind === 'contenteditable' ? 'div' : kind);
      if (kind === 'contenteditable') {
        editor.setAttribute('contenteditable', 'true');
        editor.tabIndex = 0;
      }
      document.body.append(editor);
      try {
        render(() => (
          <TerminalView
            taskId="task-1"
            agentId="agent-1"
            command="claude"
            args={[]}
            cwd="/tmp/project"
            isFocused={focused()}
          />
        ));
        getLastStatusChangeHandler()?.('restoring');
        editor.focus();
        session.term.focus.mockClear();
        getLastStatusChangeHandler()?.('ready');
        getLastPaintReadyChangeHandler()?.(true);
        await Promise.resolve();

        expect(document.activeElement).toBe(editor);
        expect(session.term.focus).not.toHaveBeenCalled();

        // A subsequent explicit request for terminal focus still wins.
        setFocused(false);
        setFocused(true);
        await Promise.resolve();
        expect(session.term.focus).toHaveBeenCalledTimes(1);
      } finally {
        editor.remove();
        hasFocusSpy.mockRestore();
      }
    },
  );

  it('suppresses cursor blinking while another client controls the terminal', () => {
    setStore('activeTaskId', 'task-1');
    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={true}
      />
    ));

    const session = startTerminalSessionMock.mock.results[0]?.value as MockTerminalSession;
    const statusHandler = getLastStatusChangeHandler();

    statusHandler?.('ready');
    expect(session.term.options.cursorBlink).toBe(true);

    setStore('taskCommandControllers', 'task-1', {
      action: 'type in the terminal',
      controllerId: 'peer-client',
    });
    expect(session.term.options.cursorBlink).toBe(false);

    setStore('taskCommandControllers', 'task-1', {
      action: 'type in the terminal',
      controllerId: 'client-self',
    });
    expect(session.term.options.cursorBlink).toBe(true);
  });

  it('shows an initialization overlay while the terminal is binding', () => {
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    expect(result.getByText('Preparing terminal…')).toBeTruthy();
  });

  it('surfaces app-owned terminal anomalies through the read-only monitor attrs and overlay', async () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__ = true;

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={true}
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    const statusHandler = getLastStatusChangeHandler();
    const restoreBlockedHandler = getLastRestoreBlockedHandler();

    statusHandler?.('ready');
    restoreBlockedHandler?.(true);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(terminalRoot?.getAttribute('data-terminal-anomaly-count')).toBe('1');
    expect(terminalRoot?.getAttribute('data-terminal-anomaly-kinds')).toBe(
      'visible-restore-blocked',
    );
    expect(terminalRoot?.getAttribute('data-terminal-anomaly-severity')).toBe('warning');
    expect(result.getByText('Visible while restore blocked')).toBeTruthy();
    expect(
      getTerminalAnomalyMonitorSnapshot().summary.anomalyCounts['visible-restore-blocked'],
    ).toBe(1);

    restoreBlockedHandler?.(false);

    expect(terminalRoot?.hasAttribute('data-terminal-anomaly-count')).toBe(false);
    expect(result.queryByText('Visible while restore blocked')).toBeNull();
  });

  it('combines multiple terminal anomalies into one diagnostic presentation', async () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__ = true;

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={true}
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    const statusHandler = getLastStatusChangeHandler();
    const renderHibernationHandler = getLastRenderHibernationHandler();
    const restoreBlockedHandler = getLastRestoreBlockedHandler();

    statusHandler?.('ready');
    renderHibernationHandler?.(true);
    restoreBlockedHandler?.(true);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(terminalRoot?.getAttribute('data-terminal-anomaly-count')).toBe('2');
    expect(terminalRoot?.getAttribute('data-terminal-anomaly-kinds')).toBe(
      'visible-render-hibernating,visible-restore-blocked',
    );
    expect(terminalRoot?.getAttribute('data-terminal-anomaly-severity')).toBe('warning');
    expect(
      result.getByText('Visible while render hibernating · Visible while restore blocked'),
    ).toBeTruthy();
  });

  it('keeps the initialization overlay left-anchored and width-stable across startup phases', () => {
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    const overlay = result.container.querySelector(
      '[data-terminal-loading-overlay="true"]',
    ) as HTMLDivElement | null;
    const card = result.container.querySelector(
      '[data-terminal-loading-card="true"]',
    ) as HTMLDivElement | null;
    const label = result.container.querySelector(
      '[data-terminal-loading-label="true"]',
    ) as HTMLSpanElement | null;

    expect(overlay).toBeTruthy();
    expect(card).toBeTruthy();
    expect(label).toBeTruthy();
    expect(overlay?.style.justifyContent).toBe('flex-start');
    expect(overlay?.style.alignItems).toBe('flex-start');
    // The compact chip is content-sized; width stability across phases comes
    // from the stable loading copy instead of a fixed ch width.
    expect(card?.style.width).toBe('');
    expect(label?.style.textAlign).toBe('left');
    expect(label?.textContent).toBe('Preparing terminal…');

    const onStatusChange = getLastStatusChangeHandler();
    onStatusChange?.('attaching');

    const attachingLabel = result.container.querySelector(
      '[data-terminal-loading-label="true"]',
    ) as HTMLSpanElement | null;
    expect(attachingLabel?.textContent).toBe('Preparing terminal…');
    expect(attachingLabel?.style.textAlign).toBe('left');

    onStatusChange?.('restoring');

    const restoringCard = result.container.querySelector(
      '[data-terminal-loading-card="true"]',
    ) as HTMLDivElement | null;
    const restoringLabel = result.container.querySelector(
      '[data-terminal-loading-label="true"]',
    ) as HTMLSpanElement | null;
    expect(restoringCard?.style.width).toBe('');
    expect(restoringLabel?.textContent).toBe('Preparing terminal…');
    expect(restoringLabel?.style.textAlign).toBe('left');
  });

  it('defers non-focused terminals until visibility is confirmed', () => {
    let initialPriority = Number.NaN;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        disconnect(): void {}
        observe(): void {}
      },
    });
    registerTerminalAttachCandidateMock.mockImplementationOnce(
      (options: { getPriority: () => number }) => {
        initialPriority = options.getPriority();
        return {
          release: vi.fn(),
          unregister: vi.fn(),
          updatePriority: vi.fn(),
        };
      },
    );
    setStore('activeTaskId', 'task-1');

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    expect(initialPriority).toBe(1);
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
  });

  it('applies current cursor and output priority state when attach starts later', () => {
    const updateOutputPriorityMock = vi.fn();
    let delayedAttach: (() => void) | undefined;

    startTerminalSessionMock.mockReturnValue(
      createMockTerminalSession({
        term: {
          blur: vi.fn(),
          focus: vi.fn(),
          options: {
            cursorBlink: true,
            disableStdin: false,
            fontFamily: '',
            fontSize: 12,
            theme: undefined,
          },
        },
        updateOutputPriority: updateOutputPriorityMock,
      }),
    );
    registerTerminalAttachCandidateMock.mockImplementationOnce(
      (options: { attach: () => void; getPriority: () => number }) => {
        delayedAttach = options.attach;
        void options.getPriority();
        return {
          release: vi.fn(),
          unregister: vi.fn(),
          updatePriority: vi.fn(),
        };
      },
    );

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    expect(startTerminalSessionMock).not.toHaveBeenCalled();

    delayedAttach?.();

    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(updateOutputPriorityMock).toHaveBeenCalled();
    expect(
      (
        startTerminalSessionMock.mock.results[0]?.value as {
          term: { options: { cursorBlink: boolean } };
        }
      ).term.options.cursorBlink,
    ).toBe(false);
  });

  it('clears failed lazy session attach state so priority changes can retry', async () => {
    const loadError = new Error('terminal runtime chunk failed');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unregisterMocks: Array<ReturnType<typeof vi.fn>> = [];
    const [focused, setFocused] = createSignal(true);

    startTerminalSessionMock
      .mockRejectedValueOnce(loadError)
      .mockReturnValueOnce(createMockTerminalSession());
    registerTerminalAttachCandidateMock.mockImplementation(
      (options: { attach: () => void; getPriority: () => number }) => {
        const unregister = vi.fn();
        unregisterMocks.push(unregister);
        void options.getPriority();
        options.attach();
        return {
          release: vi.fn(),
          unregister,
          updatePriority: vi.fn(),
        };
      },
    );
    setStore('activeTaskId', 'task-1');

    try {
      render(() => (
        <TerminalView
          taskId="task-1"
          agentId="agent-1"
          command="claude"
          args={[]}
          cwd="/tmp/project"
          isFocused={focused()}
        />
      ));

      await vi.waitFor(() => {
        expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);
        expect(unregisterMocks[0]).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith('Failed to load terminal runtime:', loadError);
      });

      setFocused(false);
      await Promise.resolve();
      setFocused(true);

      await vi.waitFor(() => {
        expect(startTerminalSessionMock).toHaveBeenCalledTimes(2);
      });
      expect(unregisterMocks).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('clears failed lazy session attach state when the loader throws synchronously', async () => {
    const loadError = new Error('terminal runtime sync failure');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unregisterMocks: Array<ReturnType<typeof vi.fn>> = [];
    const [focused, setFocused] = createSignal(true);

    startTerminalSessionMock
      .mockImplementationOnce(() => {
        throw loadError;
      })
      .mockReturnValueOnce(createMockTerminalSession());
    registerTerminalAttachCandidateMock.mockImplementation(
      (options: { attach: () => void; getPriority: () => number }) => {
        const unregister = vi.fn();
        unregisterMocks.push(unregister);
        void options.getPriority();
        options.attach();
        return {
          release: vi.fn(),
          unregister,
          updatePriority: vi.fn(),
        };
      },
    );
    setStore('activeTaskId', 'task-1');

    try {
      render(() => (
        <TerminalView
          taskId="task-1"
          agentId="agent-1"
          command="claude"
          args={[]}
          cwd="/tmp/project"
          isFocused={focused()}
        />
      ));

      await vi.waitFor(() => {
        expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);
        expect(unregisterMocks[0]).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith('Failed to load terminal runtime:', loadError);
      });

      setFocused(false);
      await Promise.resolve();
      setFocused(true);

      await vi.waitFor(() => {
        expect(startTerminalSessionMock).toHaveBeenCalledTimes(2);
      });
      expect(unregisterMocks).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('flushes the trailing PTY resize when panel dragging ends', async () => {
    const dragFlush = createDeferredPromise<undefined>();
    const flushPendingResizeMock = vi.fn(async () => undefined);
    flushPendingResizeMock.mockResolvedValueOnce(undefined);
    flushPendingResizeMock.mockReturnValueOnce(dragFlush.promise);
    startTerminalSessionMock.mockReturnValue(
      createMockTerminalSession({
        flushPendingResize: flushPendingResizeMock,
      }),
    );
    setStore('activeTaskId', 'task-1');

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    expect(flushPendingResizeMock).toHaveBeenCalledTimes(0);

    getLastStatusChangeHandler()?.('ready');
    await Promise.resolve();
    expect(flushPendingResizeMock).toHaveBeenCalledTimes(1);
    markDirtyMock.mockClear();

    beginPanelResizeDrag();
    await Promise.resolve();
    expect(flushPendingResizeMock).toHaveBeenCalledTimes(1);
    expect(markDirtyMock).not.toHaveBeenCalled();

    endPanelResizeDrag();
    await Promise.resolve();
    expect(flushPendingResizeMock).toHaveBeenCalledTimes(2);
    expect(markDirtyMock).not.toHaveBeenCalled();

    dragFlush.resolve(undefined);

    await vi.waitFor(() => {
      expect(markDirtyMock).toHaveBeenCalledTimes(1);
      expect(markDirtyMock).toHaveBeenCalledWith('agent-1', 'resize');
    });
  });

  it('flushes pending resize when a ready hidden terminal becomes visible', async () => {
    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
    const flushPendingResizeMock = vi.fn(async () => undefined);

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });
    startTerminalSessionMock.mockReturnValue(
      createMockTerminalSession({
        flushPendingResize: flushPendingResizeMock,
      }),
    );

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={false}
      />
    ));

    // Cold-hidden non-shell terminals defer their renderer attach until
    // visibility, so the session starts on the first visibility confirmation.
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    intersectionCallback?.([{ isIntersecting: true }]);
    await Promise.resolve();
    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);

    intersectionCallback?.([{ isIntersecting: false }]);
    await Promise.resolve();
    getLastStatusChangeHandler()?.('ready');
    await Promise.resolve();
    expect(flushPendingResizeMock).toHaveBeenCalledTimes(0);

    intersectionCallback?.([{ isIntersecting: true }]);
    await Promise.resolve();

    expect(flushPendingResizeMock).toHaveBeenCalledTimes(1);
  });

  it('moves hidden terminals into dormancy after their first live session and wakes them on selection', async () => {
    vi.useFakeTimers();

    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
    const unregisterMock = vi.fn();

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      hiddenTerminalSessionDormancyDelayMs: 200,
      label: 'test-dormancy',
    };

    registerTerminalAttachCandidateMock.mockImplementation(
      (options: { attach: () => void; getPriority: () => number }) => {
        options.attach();
        void options.getPriority();
        return {
          release: vi.fn(),
          unregister: unregisterMock,
          updatePriority: vi.fn(),
        };
      },
    );

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    // Never-viewed cold-hidden non-shell terminals defer their first renderer
    // attach entirely (the backend session stays live via the ensure path).
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    expect(terminalRoot?.getAttribute('data-terminal-dormant')).toBe('true');

    setStore('activeTaskId', 'task-1');
    intersectionCallback?.([{ isIntersecting: true }]);
    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(terminalRoot?.hasAttribute('data-terminal-dormant')).toBe(false);

    setStore('activeTaskId', 'task-2');
    intersectionCallback?.([{ isIntersecting: false }]);
    await vi.advanceTimersByTimeAsync(200);

    expect(sessionCleanupMock).toHaveBeenCalledTimes(1);
    expect(unregisterMock).toHaveBeenCalledTimes(1);
    expect(terminalRoot?.getAttribute('data-terminal-dormant')).toBe('true');

    setStore('activeTaskId', 'task-1');
    intersectionCallback?.([{ isIntersecting: true }]);
    expect(startTerminalSessionMock).toHaveBeenCalledTimes(2);
    expect(terminalRoot?.hasAttribute('data-terminal-dormant')).toBe(false);
  });

  it('keeps the most recently active hidden terminal hot instead of handoff-live when it is hidden', async () => {
    vi.useFakeTimers();

    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      hiddenTerminalHotCount: 1,
      hiddenTerminalHibernationDelayMs: 75,
      hiddenTerminalSessionDormancyDelayMs: 200,
      label: 'test-hot-hidden',
    };
    setStore('activeTaskId', 'task-1');

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('hot-hidden-live');

    setStore('activeTaskId', 'task-2');
    intersectionCallback?.([{ isIntersecting: false }]);
    await vi.advanceTimersByTimeAsync(200);

    expect(terminalRoot?.hasAttribute('data-terminal-dormant')).toBe(false);
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('hot-hidden-live');
    expect(sessionCleanupMock).not.toHaveBeenCalled();
    expect(getLastSessionOptions()?.getRenderHibernationDelayMs?.()).toBe(75);
  });

  it('preserves hidden render hibernation in the built-in high load mode profile', async () => {
    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    syncTerminalHighLoadMode(true);
    resetTerminalPerformanceExperimentConfigForTests();
    setStore('activeTaskId', 'task-2');

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));
    // The session has to attach once (deferred cold-hidden terminals never
    // start a renderer session) before going hidden again.
    intersectionCallback?.([{ isIntersecting: true }]);
    await Promise.resolve();
    intersectionCallback?.([{ isIntersecting: false }]);
    await Promise.resolve();

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('cold-hidden');
    expect(getLastSessionOptions()?.getRenderHibernationDelayMs?.()).toBe(75);
  });

  it('revives a dormant hidden terminal on explicit prewarm intent', async () => {
    vi.useFakeTimers();

    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      hiddenTerminalSessionDormancyDelayMs: 200,
      label: 'test-dormant-prewarm',
    };

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    intersectionCallback?.([{ isIntersecting: false }]);
    await vi.advanceTimersByTimeAsync(200);

    // Never-viewed cold-hidden terminals defer the renderer attach entirely.
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    expect(terminalRoot?.getAttribute('data-terminal-dormant')).toBe('true');

    requestTerminalPrewarm('task-1', 'pointer-intent');

    expect(armFocusedTerminalOutputPreemptionMock).toHaveBeenCalledTimes(1);
    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(terminalRoot?.hasAttribute('data-terminal-dormant')).toBe(false);
  });

  it('keeps a recently hidden terminal reserved without forcing handoff-live while hidden', async () => {
    vi.useFakeTimers();

    const intersectionCallbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallbacks.push(callback);
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 1,
      label: 'test-recent-hidden-reservation',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    syncTerminalHighLoadMode(true);
    setStore('activeTaskId', 'task-1');

    const result = render(() => (
      <>
        <TerminalView
          taskId="task-1"
          agentId="agent-1"
          command="claude"
          args={[]}
          cwd="/tmp/project"
        />
        <TerminalView
          taskId="task-2"
          agentId="agent-2"
          command="claude"
          args={[]}
          cwd="/tmp/project"
          isFocused
        />
      </>
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('cold-hidden');

    setStore('activeTaskId', 'task-3');
    intersectionCallbacks[0]?.([{ isIntersecting: false }]);

    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('hot-hidden-live');

    setStore('activeTaskId', 'task-1');
    intersectionCallbacks[0]?.([{ isIntersecting: true }]);

    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('passive-visible');
  });

  it('does not eagerly start a cold-hidden shell terminal until it is selected', async () => {
    const intersectionCallbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallbacks.push(callback);
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    setStore('activeTaskId', 'task-2');

    const result = render(() => (
      <>
        <TerminalView
          taskId="task-1"
          agentId="agent-1"
          command="claude"
          args={[]}
          cwd="/tmp/project"
          isShell
        />
        <TerminalView
          taskId="task-2"
          agentId="agent-2"
          command="claude"
          args={[]}
          cwd="/tmp/project"
          isFocused
          isShell
        />
      </>
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('cold-hidden');
    expect(terminalRoot?.getAttribute('data-terminal-dormant')).toBe('true');
    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);

    setStore('activeTaskId', 'task-1');
    intersectionCallbacks[0]?.([{ isIntersecting: true }]);

    expect(startTerminalSessionMock).toHaveBeenCalledTimes(2);
    expect(terminalRoot?.hasAttribute('data-terminal-dormant')).toBe(false);
  });

  it('waits for observed visibility before starting a non-focused hot-hidden shell terminal', () => {
    let intersectionCallback: IntersectionObserverTestCallback | undefined;
    const visibleRect = {
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(visibleRect);

    installIntersectionObserverForTest((callback) => {
      intersectionCallback = callback;
    });

    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      hiddenTerminalHotCount: 1,
      label: 'test-hot-hidden-shell',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setStore('activeTaskId', 'task-1');

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isShell
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('hot-hidden-live');
    expect(terminalRoot?.getAttribute('data-terminal-dormant')).toBe('true');
    expect(startTerminalSessionMock).not.toHaveBeenCalled();

    intersectionCallback?.([{ isIntersecting: true }]);

    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('passive-visible');
    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);

    getBoundingClientRectSpy.mockRestore();
  });

  it('prewarms a non-focused hidden shell terminal without waiting for visibility', () => {
    installIntersectionObserverForTest();

    setStore('activeTaskId', 'task-2');

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isShell
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('cold-hidden');
    expect(terminalRoot?.getAttribute('data-terminal-dormant')).toBe('true');
    expect(startTerminalSessionMock).not.toHaveBeenCalled();

    requestTerminalPrewarm('task-1', 'pointer-intent');

    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(terminalRoot?.hasAttribute('data-terminal-dormant')).toBe(false);
  });

  it('arms the switch window before reviving a newly selected dormant session', async () => {
    vi.useFakeTimers();

    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      hiddenTerminalSessionDormancyDelayMs: 200,
      switchTargetWindowMs: 250,
    };

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    intersectionCallback?.([{ isIntersecting: true }]);
    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);
    intersectionCallback?.([{ isIntersecting: false }]);
    await vi.advanceTimersByTimeAsync(200);
    expect(sessionCleanupMock).toHaveBeenCalledTimes(1);

    let selectedRecoveryProtectedAtSessionStart: boolean | undefined;
    let switchWindowAtSessionStart: ReturnType<typeof getTerminalSwitchWindowSnapshot> | undefined;
    startTerminalSessionMock.mockImplementationOnce(
      (options: { isSelectedRecoveryProtected?: () => boolean }) => {
        switchWindowAtSessionStart = getTerminalSwitchWindowSnapshot();
        selectedRecoveryProtectedAtSessionStart = options.isSelectedRecoveryProtected?.();
        return createMockTerminalSession();
      },
    );

    setStore('activeTaskId', 'task-1');
    intersectionCallback?.([{ isIntersecting: true }]);

    expect(startTerminalSessionMock).toHaveBeenCalledTimes(2);
    expect(switchWindowAtSessionStart).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );
    expect(selectedRecoveryProtectedAtSessionStart).toBe(true);
  });

  it('arms focused output preemption when a terminal gains selection or focus', () => {
    const [focused, setFocused] = createSignal(false);

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={focused()}
      />
    ));

    expect(armFocusedTerminalOutputPreemptionMock).not.toHaveBeenCalled();
    expect(getTerminalSwitchWindowSnapshot().active).toBe(false);

    setStore('activeTaskId', 'task-1');
    expect(armFocusedTerminalOutputPreemptionMock).toHaveBeenCalledTimes(1);
    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
      }),
    );

    setStore('activeTaskId', 'task-2');
    expect(armFocusedTerminalOutputPreemptionMock).toHaveBeenCalledTimes(1);
    expect(getTerminalSwitchWindowSnapshot().active).toBe(false);

    setFocused(true);
    expect(armFocusedTerminalOutputPreemptionMock).toHaveBeenCalledTimes(2);
    expect(getTerminalSwitchWindowSnapshot().active).toBe(false);
  });

  it.each([
    { focusPanelId: 'ai-terminal', isShell: false, owner: 'AI terminal' },
    { focusPanelId: 'shell:1', isShell: true, owner: 'secondary task shell' },
    { focusPanelId: 'terminal', isShell: true, owner: 'standalone terminal' },
  ])('restores $owner focus ownership after takeover succeeds', async (testCase) => {
    const session = createMockTerminalSession();
    startTerminalSessionMock.mockReturnValueOnce(session);
    setStore('taskCommandControllers', 'task-1', {
      action: 'type in the terminal',
      controllerId: 'peer-client',
    });

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        focusPanelId={testCase.focusPanelId}
        isShell={testCase.isShell}
      />
    ));

    getLastStatusChangeHandler()?.('ready');

    const takeOverButton = await result.findByRole('button', { name: 'Take Over' });
    takeOverButton.click();

    await vi.waitFor(() => {
      expect(requestInputTakeoverMock).toHaveBeenCalledTimes(1);
    });
    expect(setTaskFocusedPanelStateMock).toHaveBeenCalledWith('task-1', testCase.focusPanelId);
    expect(syncFocusedTypingTaskCommandLeaseMock).toHaveBeenCalledWith(
      'task-1',
      testCase.focusPanelId,
    );
    expect(session.term.focus).toHaveBeenCalledTimes(1);
  });

  it('focuses the live command target session when its terminal surface is pressed', () => {
    const session = createMockTerminalSession();
    startTerminalSessionMock.mockReturnValueOnce(session);
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isCommandTarget
      />
    ));

    setStore('activeTaskId', 'task-1');
    getLastStatusChangeHandler()?.('ready');

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    terminalRoot?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(session.term.focus).toHaveBeenCalledTimes(1);
  });

  it('ignores a late takeover result after the terminal session is cleaned up', async () => {
    const takeover = createDeferredPromise<boolean>();
    const session = createMockTerminalSession({
      requestInputTakeover: vi.fn(() => takeover.promise),
    });
    startTerminalSessionMock.mockReturnValueOnce(session);
    setStore('taskCommandControllers', 'task-1', {
      action: 'type in the terminal',
      controllerId: 'peer-client',
    });

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    getLastStatusChangeHandler()?.('ready');

    const takeOverButton = await result.findByRole('button', { name: 'Take Over' });
    takeOverButton.click();

    await vi.waitFor(() => {
      expect(session.requestInputTakeover).toHaveBeenCalledTimes(1);
    });

    result.unmount();
    takeover.resolve(true);
    await takeover.promise;
    await Promise.resolve();

    expect(setTaskFocusedPanelStateMock).not.toHaveBeenCalled();
    expect(session.term.focus).not.toHaveBeenCalled();
  });

  it('begins a terminal switch window when the task becomes selected', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
    };

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    expect(getTerminalSwitchWindowSnapshot().active).toBe(false);

    setStore('activeTaskId', 'task-1');

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );
  });

  it('arms selected-recovery protection as soon as the task becomes the active switch target', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
    };

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    expect(getLastSessionOptions()?.isSelectedRecoveryProtected?.()).toBe(false);

    setStore('activeTaskId', 'task-1');

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );
    expect(getLastSessionOptions()?.isSelectedRecoveryProtected?.()).toBe(true);
  });

  it('marks first paint only after paint-settled readiness, even while selected recovery is still active', async () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
    };

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    setStore('activeTaskId', 'task-1');
    getLastSessionOptions()?.onSelectedRecoveryStart?.();
    getLastStatusChangeHandler()?.('ready');
    await vi.advanceTimersByTimeAsync(16);

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        firstPaintDurationMs: null,
        inputReadyDurationMs: null,
        phase: 'first-paint-pending',
        targetTaskId: 'task-1',
      }),
    );
    expect(terminalRoot?.getAttribute('data-terminal-live-render-ready')).toBe('true');
    expect(terminalRoot?.hasAttribute('data-terminal-paint-ready')).toBe(false);

    getLastPaintReadyChangeHandler()?.(true);
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        firstPaintDurationMs: expect.any(Number),
        inputReadyDurationMs: null,
        phase: 'input-ready-pending',
        targetTaskId: 'task-1',
      }),
    );
    expect(terminalRoot?.getAttribute('data-terminal-live-render-ready')).toBe('true');
    expect(terminalRoot?.getAttribute('data-terminal-paint-ready')).toBe('true');
  });

  it('treats a focused ready terminal as live-render-ready before visibility observer catch-up', () => {
    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
    const [focused, setFocused] = createSignal(false);

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={focused()}
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(terminalRoot?.hasAttribute('data-terminal-live-render-ready')).toBe(false);

    setFocused(true);
    getLastStatusChangeHandler()?.('ready');

    expect(intersectionCallback).toBeDefined();
    expect(terminalRoot?.getAttribute('data-terminal-live-render-ready')).toBe('true');
    expect(getTaskTerminalStartupPaintCoordinationSnapshot('task-1')).toEqual(
      expect.objectContaining({
        hiddenPendingCount: 1,
        selectedPaintReady: false,
        selectedPendingCount: 0,
      }),
    );
  });

  it('records startup write and render attribution until paint-ready settles', async () => {
    vi.useFakeTimers();
    Object.assign(window, {
      __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
    });

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    setStore('activeTaskId', 'task-1');
    getLastStatusChangeHandler()?.('ready');
    await vi.advanceTimersByTimeAsync(20);
    getLastStartupWriteRenderedHandler()?.(128);
    getLastStartupRenderEventHandler()?.();
    await vi.advanceTimersByTimeAsync(30);
    getLastPaintReadyChangeHandler()?.(true);
    await vi.advanceTimersByTimeAsync(16);

    expect(getRendererRuntimeDiagnosticsSnapshot().terminalStartupPaint).toEqual(
      expect.objectContaining({
        logicalReadyCounts: expect.objectContaining({
          selected: 1,
        }),
        paintReadyCounts: expect.objectContaining({
          selected: 1,
        }),
        renderEventCounts: expect.objectContaining({
          selected: 1,
        }),
        writeBytes: expect.objectContaining({
          selected: 128,
        }),
        writeCounts: expect.objectContaining({
          selected: 1,
        }),
      }),
    );
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalStartupPaint.logicalToPaintReadyDelayLastMs
        .selected,
    ).toBe(50);
  });

  it('records terminal attach milestones for scorecard diagnostics', () => {
    window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ = {};

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    setStore('activeTaskId', 'task-1');
    const options = getLastSessionOptions();
    options?.onAttachMilestone?.('channel-ready');
    options?.onAttachMilestone?.('attach-fit-ready');
    options?.onAttachMilestone?.('attach-requested');
    options?.onAttachMilestone?.('attach-resolved');
    getLastAttachBoundHandler()?.();
    options?.onAttachMilestone?.('attach-recovery-started');
    options?.onAttachMilestone?.('attach-recovery-settled');
    getLastStatusChangeHandler()?.('ready');
    getLastPaintReadyChangeHandler()?.(true);

    expect(window.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__['task-1:agent-1']).toEqual(
      expect.objectContaining({
        agentId: 'agent-1',
        attachBoundAtMs: expect.any(Number),
        attachFitReadyAtMs: expect.any(Number),
        attachQueuedAtMs: expect.any(Number),
        attachStartedAtMs: expect.any(Number),
        channelReadyAtMs: expect.any(Number),
        key: 'task-1:agent-1',
        paintReadyAtMs: expect.any(Number),
        readyAtMs: expect.any(Number),
        recoverySettledAtMs: expect.any(Number),
        recoveryStartedAtMs: expect.any(Number),
        selectedInteractiveAtMs: expect.any(Number),
        spawnRequestedAtMs: expect.any(Number),
        spawnResolvedAtMs: expect.any(Number),
        status: 'ready',
        taskId: 'task-1',
      }),
    );
  });

  it('keeps the live terminal surface visually masked while attach or restore loading is visible', () => {
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    const terminalContainer = terminalRoot?.querySelector(':scope > div');

    expect(terminalContainer).not.toBeNull();
    expect((terminalContainer as HTMLDivElement).style.opacity).toBe('0');
    expect((terminalContainer as HTMLDivElement).style.pointerEvents).toBe('none');

    getLastStatusChangeHandler()?.('ready');

    expect((terminalContainer as HTMLDivElement).style.opacity).toBe('');
    expect((terminalContainer as HTMLDivElement).style.pointerEvents).toBe('');

    getLastStatusChangeHandler()?.('restoring');

    expect((terminalContainer as HTMLDivElement).style.opacity).toBe('0');
    expect((terminalContainer as HTMLDivElement).style.pointerEvents).toBe('none');
  });

  it('keeps a ready live terminal visible while a resize transaction settles', () => {
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    const terminalContainer = terminalRoot?.querySelector(':scope > div');

    getLastStatusChangeHandler()?.('ready');

    expect(terminalRoot?.hasAttribute('data-terminal-resize-overlay')).toBe(false);
    expect(terminalRoot?.querySelector('[data-terminal-resize-overlay="true"]')).toBeNull();
    expect((terminalContainer as HTMLDivElement).style.opacity).toBe('');
    expect((terminalContainer as HTMLDivElement).style.pointerEvents).toBe('');

    getLastResizeTransactionChangeHandler()?.(true);

    expect(terminalRoot?.hasAttribute('data-terminal-resize-overlay')).toBe(false);
    expect(terminalRoot?.querySelector('[data-terminal-resize-overlay="true"]')).toBeNull();
    expect((terminalContainer as HTMLDivElement).style.opacity).toBe('');
    expect((terminalContainer as HTMLDivElement).style.pointerEvents).toBe('');

    getLastResizeTransactionChangeHandler()?.(false);

    expect(terminalRoot?.hasAttribute('data-terminal-resize-overlay')).toBe(false);
    expect(terminalRoot?.querySelector('[data-terminal-resize-overlay="true"]')).toBeNull();
    expect((terminalContainer as HTMLDivElement).style.opacity).toBe('');
    expect((terminalContainer as HTMLDivElement).style.pointerEvents).toBe('');
  });

  it('suppresses the resize overlay during active panel drag', () => {
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    const terminalContainer = terminalRoot?.querySelector(':scope > div');

    getLastStatusChangeHandler()?.('ready');
    beginPanelResizeDrag();
    getLastResizeTransactionChangeHandler()?.(true);

    expect(terminalRoot?.hasAttribute('data-terminal-resize-overlay')).toBe(false);
    expect(terminalRoot?.querySelector('[data-terminal-resize-overlay="true"]')).toBeNull();
    expect((terminalContainer as HTMLDivElement).style.opacity).toBe('');
    expect((terminalContainer as HTMLDivElement).style.pointerEvents).toBe('');

    endPanelResizeDrag();
  });

  it('begins a terminal switch window for the initially selected visible task', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
    };
    setStore('activeTaskId', 'task-1');

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        lastCompletion: null,
        phase: 'first-paint-pending',
        targetTaskId: 'task-1',
      }),
    );
  });

  it('completes browser cold bootstrap when the selected visible terminal becomes paint-ready without focus', async () => {
    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    beginBrowserColdBootstrap();

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    setStore('activeTaskId', 'task-1');
    intersectionCallback?.([{ isIntersecting: true }]);
    getLastStatusChangeHandler()?.('ready');
    getLastPaintReadyChangeHandler()?.(true);

    await vi.waitFor(() => {
      expect(getBrowserStartupState()).toMatchObject({
        coldBootstrapPending: false,
        tier: 'background',
      });
    });
  });

  it('completes the terminal switch window when the selected task becomes ready', async () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
    };
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: undefined,
    });

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    setStore('activeTaskId', 'task-1');
    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );

    getLastStatusChangeHandler()?.('ready');
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        firstPaintDurationMs: null,
        inputReadyDurationMs: null,
        phase: 'first-paint-pending',
        targetTaskId: 'task-1',
      }),
    );

    getLastPaintReadyChangeHandler()?.(true);
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'completed',
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('reports readiness to a task-owned switch window without owning its lifecycle', async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: undefined,
    });

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
        manageTaskSwitchWindowLifecycle={false}
      />
    ));

    setStore('activeTaskId', 'task-1');
    beginTerminalSwitchWindow('task-1', 250, 0, 'task-1', 3);

    getLastStatusChangeHandler()?.('ready');
    getLastPaintReadyChangeHandler()?.(true);
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'completed',
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('keeps the switch window open while selected recovery is still active', async () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetProtectUntilInputReady: true,
      switchTargetWindowMs: 250,
    };

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    setStore('activeTaskId', 'task-1');
    getLastSessionOptions()?.onSelectedRecoveryStart?.();
    getLastStatusChangeHandler()?.('ready');
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        firstPaintDurationMs: null,
        inputReadyDurationMs: null,
        phase: 'first-paint-pending',
        selectedRecoveryActive: true,
        targetTaskId: 'task-1',
      }),
    );

    getLastPaintReadyChangeHandler()?.(true);
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        inputReadyDurationMs: null,
        phase: 'input-ready-pending',
        selectedRecoveryActive: true,
        targetTaskId: 'task-1',
      }),
    );

    getLastSessionOptions()?.onSelectedRecoverySettle?.();
    await vi.advanceTimersByTimeAsync(16);

    expect(requestTerminalOutputDrainMock).toHaveBeenCalledTimes(1);
    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'completed',
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('keeps the switch window open while the selected terminal stays render-hibernating', async () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetProtectUntilInputReady: true,
      switchTargetWindowMs: 250,
    };

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    setStore('activeTaskId', 'task-1');
    getLastRenderHibernationHandler()?.(true);
    getLastStatusChangeHandler()?.('ready');
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        firstPaintDurationMs: null,
        inputReadyDurationMs: null,
        phase: 'first-paint-pending',
        targetTaskId: 'task-1',
      }),
    );

    getLastRenderHibernationHandler()?.(false);
    getLastPaintReadyChangeHandler()?.(true);
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'completed',
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('does not reserve switch echo grace for the initially selected terminal', async () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchPostInputReadyEchoGraceMs: 120,
      switchTargetWindowMs: 250,
    };
    setStore('activeTaskId', 'task-1');

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused={true}
      />
    ));

    getLastStatusChangeHandler()?.('ready');
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );

    getLastPaintReadyChangeHandler()?.(true);
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'completed',
          taskId: 'task-1',
        }),
      }),
    );
    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: null,
        targetTaskId: null,
      }),
    );
  });

  it('starts a post-input-ready switch echo grace when configured', async () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchPostInputReadyEchoGraceMs: 120,
      switchTargetWindowMs: 250,
    };

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    setStore('activeTaskId', 'task-1');
    getLastStatusChangeHandler()?.('ready');
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        firstPaintDurationMs: null,
        inputReadyDurationMs: null,
        phase: 'first-paint-pending',
        targetTaskId: 'task-1',
      }),
    );

    getLastPaintReadyChangeHandler()?.(true);
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'completed',
          taskId: 'task-1',
        }),
      }),
    );
    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        targetTaskId: 'task-1',
      }),
    );

    await vi.advanceTimersByTimeAsync(120);

    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'timed-out',
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('completes the terminal switch window when a selected task was already ready', async () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
    };

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    getLastStatusChangeHandler()?.('ready');
    setStore('activeTaskId', 'task-1');
    getLastPaintReadyChangeHandler()?.(true);
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          firstPaintDurationMs: expect.any(Number),
          reason: 'completed',
          taskId: 'task-1',
        }),
        targetTaskId: null,
      }),
    );
  });

  it('keeps the switch window active in a settled phase when a settle delay is configured', async () => {
    vi.useFakeTimers();
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetProtectUntilInputReady: true,
      switchTargetWindowMs: 250,
      switchWindowSettleDelayMs: 40,
    };

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    setStore('activeTaskId', 'task-1');
    getLastStatusChangeHandler()?.('ready');
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        phase: 'first-paint-pending',
        targetTaskId: 'task-1',
      }),
    );

    getLastPaintReadyChangeHandler()?.(true);
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        phase: 'settled-pending',
        targetTaskId: 'task-1',
      }),
    );

    await vi.advanceTimersByTimeAsync(40);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          inputReadyDurationMs: expect.any(Number),
          reason: 'completed',
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('waits for the selected terminal to become visible before marking switch input-ready', async () => {
    vi.useFakeTimers();

    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetProtectUntilInputReady: true,
      switchTargetWindowMs: 250,
      switchWindowSettleDelayMs: 40,
    };

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    setStore('activeTaskId', 'task-1');
    getLastStatusChangeHandler()?.('ready');
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        firstPaintDurationMs: null,
        inputReadyDurationMs: null,
        phase: 'first-paint-pending',
        targetTaskId: 'task-1',
      }),
    );

    intersectionCallback?.([{ isIntersecting: true }]);
    getLastPaintReadyChangeHandler()?.(true);
    await vi.advanceTimersByTimeAsync(16);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        firstPaintDurationMs: expect.any(Number),
        inputReadyDurationMs: expect.any(Number),
        phase: 'settled-pending',
        targetTaskId: 'task-1',
      }),
    );
  });

  it('cancels the terminal switch window when selection is cleared before ready', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
    };

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    setStore('activeTaskId', 'task-1');
    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );

    setStore('activeTaskId', null);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'cancelled',
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('cancels the terminal switch window when the selected terminal unmounts mid-switch', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
    };

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    setStore('activeTaskId', 'task-1');
    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );

    result.unmount();

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'cancelled',
          taskId: 'task-1',
        }),
      }),
    );
  });

  it('does not let an unfocused sibling cancel the selected terminal switch window', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      switchTargetWindowMs: 250,
    };

    const [showSibling, setShowSibling] = createSignal(true);

    render(() => (
      <>
        {showSibling() ? (
          <TerminalView
            taskId="task-1"
            agentId="agent-sibling"
            command="claude"
            args={[]}
            cwd="/tmp/project"
          />
        ) : null}
        <TerminalView
          taskId="task-1"
          agentId="agent-owner"
          command="claude"
          args={[]}
          cwd="/tmp/project"
          isFocused
        />
      </>
    ));

    setStore('activeTaskId', 'task-1');

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );

    setShowSibling(false);

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );
  });

  it('does not keep a hidden selected sibling in the handoff-live surface tier', () => {
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        disconnect(): void {}

        observe(): void {}
      },
    });

    const result = render(() => (
      <>
        <TerminalView
          taskId="task-1"
          agentId="agent-hidden"
          command="claude"
          args={[]}
          cwd="/tmp/project"
        />
        <TerminalView
          taskId="task-1"
          agentId="agent-owner"
          command="claude"
          args={[]}
          cwd="/tmp/project"
          isFocused
        />
      </>
    ));

    setStore('activeTaskId', 'task-1');

    const hiddenRoot = result.container.querySelector('[data-terminal-agent-id="agent-hidden"]');
    const ownerRoot = result.container.querySelector('[data-terminal-agent-id="agent-owner"]');

    expect(ownerRoot?.getAttribute('data-terminal-surface-tier')).toBe('interactive-live');
    expect(hiddenRoot?.getAttribute('data-terminal-surface-tier')).not.toBe('handoff-live');
  });

  it('keeps a visible unfocused sibling passive-visible by default', () => {
    const intersectionCallbacks: Array<
      ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined
    > = [];

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallbacks.push(callback);
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    const result = render(() => (
      <>
        <TerminalView
          taskId="task-1"
          agentId="agent-visible"
          command="claude"
          args={[]}
          cwd="/tmp/project"
        />
        <TerminalView
          taskId="task-1"
          agentId="agent-focused"
          command="claude"
          args={[]}
          cwd="/tmp/project"
          isFocused
        />
      </>
    ));

    setStore('activeTaskId', 'task-1');
    intersectionCallbacks[0]?.([{ isIntersecting: true }]);
    intersectionCallbacks[1]?.([{ isIntersecting: true }]);

    const visibleRoot = result.container.querySelector('[data-terminal-agent-id="agent-visible"]');
    const focusedRoot = result.container.querySelector('[data-terminal-agent-id="agent-focused"]');

    expect(focusedRoot?.getAttribute('data-terminal-surface-tier')).toBe('interactive-live');
    expect(visibleRoot?.getAttribute('data-terminal-surface-tier')).toBe('passive-visible');
  });

  it('keeps the selected visible command target live after the switch window is gone', () => {
    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp"
        isCommandTarget
      />
    ));

    setStore('activeTaskId', 'task-1');
    intersectionCallback?.([{ isIntersecting: true }]);

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(getTerminalSwitchWindowSnapshot().active).toBe(false);
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('interactive-live');
  });

  it('keeps an explicit command target live before visibility observer catch-up', () => {
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        disconnect(): void {}

        observe(): void {}
      },
    });

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp"
        isCommandTarget
      />
    ));

    setStore('activeTaskId', 'task-1');

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('interactive-live');
  });

  it('keeps an initially active explicit command target live on first mount', () => {
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        disconnect(): void {}

        observe(): void {}
      },
    });

    setStore('activeTaskId', 'task-1');

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp"
        isCommandTarget
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(terminalRoot?.getAttribute('data-terminal-active-command-target')).toBe('true');
    expect(terminalRoot?.getAttribute('data-terminal-command-target')).toBe('true');
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('interactive-live');
  });

  it('keeps a newly selected command target live when visibility has not caught up', () => {
    const [isCommandTarget, setIsCommandTarget] = createSignal(false);
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        disconnect(): void {}

        observe(): void {}
      },
    });

    setStore('activeTaskId', 'task-1');

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp"
        isCommandTarget={isCommandTarget()}
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('cold-hidden');

    setIsCommandTarget(true);

    expect(terminalRoot?.getAttribute('data-terminal-active-command-target')).toBe('true');
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('interactive-live');
  });

  it('keeps an active-task terminal passive when it is not the command target', () => {
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-passive"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isCommandTarget={false}
      />
    ));

    setStore('activeTaskId', 'task-1');
    getLastStatusChangeHandler()?.('ready');
    getLastPaintReadyChangeHandler()?.(true);

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-passive"]');
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('passive-visible');
    expect(terminalRoot?.getAttribute('data-terminal-cursor-blink')).toBeNull();
  });

  it('arms focused output preemption when a terminal becomes visible', () => {
    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    expect(armFocusedTerminalOutputPreemptionMock).not.toHaveBeenCalled();

    intersectionCallback?.([{ isIntersecting: true }]);
    expect(armFocusedTerminalOutputPreemptionMock).toHaveBeenCalledTimes(1);
  });

  it('prewarms hidden render-hibernating terminals on explicit task intent', () => {
    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    // Start the session once via visibility (deferred cold-hidden terminals
    // never attach before first visibility), then hide it again.
    intersectionCallback?.([{ isIntersecting: true }]);
    const session = startTerminalSessionMock.mock.results[0]?.value as {
      prewarmRenderHibernation: ReturnType<typeof vi.fn>;
    };
    intersectionCallback?.([{ isIntersecting: false }]);
    armFocusedTerminalOutputPreemptionMock.mockClear();

    requestTerminalPrewarm('task-1');

    expect(armFocusedTerminalOutputPreemptionMock).toHaveBeenCalledTimes(1);
    expect(session.prewarmRenderHibernation).toHaveBeenCalledTimes(1);
  });

  it('keeps over-budget visible terminals readable even when they stay in the passive-visible surface tier', () => {
    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      label: 'terminal-view-frozen-visible',
    };
    setStore('activeTaskId', 'task-2');

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    intersectionCallback?.([{ isIntersecting: true }]);

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(terminalRoot?.getAttribute('data-terminal-surface-tier')).toBe('passive-visible');
    expect(terminalRoot?.hasAttribute('data-terminal-dormant')).toBe(false);
    expect(getLastSessionOptions()?.getRenderHibernationDelayMs?.()).toBeNull();
  });

  it('keeps passive-visible terminals on the live presentation surface', () => {
    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      label: 'terminal-view-passive-visible',
    };
    setStore('activeTaskId', 'task-2');

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    intersectionCallback?.([{ isIntersecting: true }]);
    getLastStatusChangeHandler()?.('ready');

    expect(
      result.container
        .querySelector('[data-terminal-agent-id="agent-1"]')
        ?.getAttribute('data-terminal-presentation-mode'),
    ).toBe('live');
    expect(result.container.querySelector('[data-terminal-passive-overlay="true"]')).toBeNull();
  });

  it('does not replace passive-visible terminals with fallback overlay copy', () => {
    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      label: 'terminal-view-passive-visible-empty',
    };
    setStore('activeTaskId', 'task-2');

    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    intersectionCallback?.([{ isIntersecting: true }]);
    getLastStatusChangeHandler()?.('ready');

    expect(result.container.querySelector('[data-terminal-passive-overlay="true"]')).toBeNull();
    expect(
      result.container
        .querySelector('[data-terminal-agent-id="agent-1"]')
        ?.getAttribute('data-terminal-presentation-mode'),
    ).toBe('live');
  });

  it('keeps resize authority off until an unfocused selected terminal becomes visible', () => {
    let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallback = callback;
        }

        disconnect(): void {}

        observe(): void {}
      },
    });

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    setStore('activeTaskId', 'task-1');

    expect(getLastSessionOptions()?.shouldCommitResize?.()).toBe(false);

    intersectionCallback?.([{ isIntersecting: true }]);

    expect(getLastSessionOptions()?.shouldCommitResize?.()).toBe(false);

    getLastStatusChangeHandler()?.('ready');

    expect(getLastSessionOptions()?.shouldCommitResize?.()).toBe(true);
  });

  it('reflects render hibernation state on the terminal shell', () => {
    const result = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    const terminalRoot = result.container.querySelector('[data-terminal-agent-id="agent-1"]');
    expect(terminalRoot?.hasAttribute('data-terminal-render-hibernating')).toBe(false);

    getLastRenderHibernationHandler()?.(true);
    expect(terminalRoot?.getAttribute('data-terminal-render-hibernating')).toBe('true');

    getLastRenderHibernationHandler()?.(false);
    expect(terminalRoot?.hasAttribute('data-terminal-render-hibernating')).toBe(false);
  });

  it('updates shared startup state as terminal status changes', () => {
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    const onStatusChange = getLastStatusChangeHandler();
    expectTerminalStartupSummary({ pendingCount: 1 });
    expect(getTerminalStartupSummary()?.detail).toContain('queued');
    expect(getTerminalStartupSummary()?.queuedCount).toBe(1);

    onStatusChange?.('attaching');
    expectTerminalStartupSummary({
      attachingCount: 1,
      pendingCount: 1,
    });
    expect(getTerminalStartupSummary()?.detail).toContain('attaching');
    expect(getTerminalStartupSummary()?.queuedCount).toBe(0);

    onStatusChange?.('restoring');
    expectTerminalStartupSummary({
      pendingCount: 1,
      restoringCount: 1,
    });
    expect(getTerminalStartupSummary()?.detail).toContain('restoring');
    expect(getTerminalStartupSummary()?.queuedCount).toBe(0);

    onStatusChange?.('ready');
    expect(getTerminalStartupSummary()).toBeNull();
  });

  it('releases the attach slot as soon as the attach RPC is dispatched', () => {
    const releaseMock = vi.fn();

    registerTerminalAttachCandidateMock.mockImplementationOnce(
      (options: { attach: () => void; getPriority: () => number }) => {
        void options.getPriority();
        options.attach();
        return {
          release: releaseMock,
          unregister: vi.fn(),
          updatePriority: vi.fn(),
        };
      },
    );

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    expect(releaseMock).not.toHaveBeenCalled();

    // The slot guards renderer CPU phases only: it releases when the attach
    // RPC dispatches, not when the backend bind resolves.
    getLastAttachDispatchedHandler()?.();
    expect(releaseMock).toHaveBeenCalledTimes(1);

    getLastAttachBoundHandler()?.();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('clears shared startup state when terminal initialization fails', () => {
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');

    render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
      />
    ));

    const onStatusChange = getLastStatusChangeHandler();
    onStatusChange?.('error');

    expect(getTerminalStartupSummary()).toBeNull();
  });

  it('announces a typed restore failure and retries it without replacing the terminal session', () => {
    const session = createMockTerminalSession();
    startTerminalSessionMock.mockReturnValueOnce(session);
    const view = render(() => (
      <TerminalView
        taskId="task-1"
        agentId="agent-1"
        command="claude"
        args={[]}
        cwd="/tmp/project"
        isFocused
      />
    ));

    getLastAttachUnavailableHandler()?.('restore-failed');
    getLastStatusChangeHandler()?.('error');

    const status = view.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('The terminal could not be restored.');
    fireEvent.click(view.getByRole('button', { name: 'Retry restore' }));

    expect(session.retryAttach).toHaveBeenCalledOnce();
    expect(view.queryByRole('status')).toBeNull();
    expect(startTerminalSessionMock).toHaveBeenCalledOnce();
  });
});
