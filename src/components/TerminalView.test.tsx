import { cleanup, render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  getTerminalSwitchWindowSnapshot,
  resetTerminalSwitchWindowForTests,
} from '../app/terminal-switch-window';
import { resetTerminalPerformanceExperimentConfigForTests } from '../lib/terminal-performance-experiments';
import { syncTerminalHighLoadMode } from '../app/terminal-high-load-mode';
import { setStore } from '../store/core';
import {
  getTerminalStartupSummary,
  registerTerminalStartupCandidate,
  resetTerminalStartupStateForTests,
} from '../store/terminal-startup';
import { resetStoreForTest } from '../test/store-test-helpers';
import type { StartTerminalSessionOptions } from './terminal-view/terminal-session';

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
  registerTerminalAttachCandidateMock,
  requestTerminalOutputDrainMock,
  requestInputTakeoverMock,
  setWebglAddonPriorityMock,
  sessionCleanupMock,
  startTerminalSessionMock,
  touchWebglAddonMock,
} = vi.hoisted(() => ({
  armFocusedTerminalOutputPreemptionMock: vi.fn(),
  getTerminalFontFamilyMock: vi.fn((font: string) => `font:${font}`),
  getTerminalThemeMock: vi.fn((preset: string) => ({ preset })),
  markDirtyMock: vi.fn(),
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
  setWebglAddonPriorityMock: vi.fn(),
  sessionCleanupMock: vi.fn(),
  startTerminalSessionMock: vi.fn(),
  touchWebglAddonMock: vi.fn(),
}));

vi.mock('./terminal-view/terminal-session', () => ({
  startTerminalSession: startTerminalSessionMock,
}));

vi.mock('../lib/fonts', () => ({
  DEFAULT_TERMINAL_FONT: 'JetBrains Mono',
  getTerminalFontFamily: getTerminalFontFamilyMock,
}));

vi.mock('../lib/theme', () => ({
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

vi.mock('../lib/webglPool', () => ({
  setWebglAddonPriority: setWebglAddonPriorityMock,
  touchWebglAddon: touchWebglAddonMock,
}));

vi.mock('../app/terminal-attach-scheduler', () => ({
  registerTerminalAttachCandidate: registerTerminalAttachCandidateMock,
}));

vi.mock('../app/terminal-output-scheduler', () => ({
  armFocusedTerminalOutputPreemption: armFocusedTerminalOutputPreemptionMock,
  requestTerminalOutputDrain: requestTerminalOutputDrainMock,
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
    store: core.store,
  };
});

import { TerminalView } from './TerminalView';

type SessionStatus = 'attaching' | 'error' | 'ready' | 'restoring';
type MockSessionOptions = Pick<
  StartTerminalSessionOptions,
  | 'getRenderHibernationDelayMs'
  | 'isSelectedRecoveryProtected'
  | 'onAttachBound'
  | 'onBlockedInputAttempt'
  | 'onRenderHibernationChange'
  | 'onRestoreBlockedChange'
  | 'onSelectedRecoverySettle'
  | 'onSelectedRecoveryStart'
  | 'onStatusChange'
  | 'shouldCommitResize'
>;
interface MockTerminalSurface {
  blur?: () => void;
  focus: () => void;
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
  flushPendingResize: () => void;
  isRestoreBlocked: () => boolean;
  prewarmRenderHibernation: () => void;
  requestInputTakeover: () => Promise<boolean>;
  term: MockTerminalSurface;
  updateOutputPriority: () => void;
}

function createMockTerminalSession(
  overrides: Partial<MockTerminalSession> = {},
): MockTerminalSession {
  return {
    cleanup: sessionCleanupMock,
    flushPendingResize: vi.fn(),
    isRestoreBlocked: vi.fn(() => false),
    prewarmRenderHibernation: vi.fn(),
    requestInputTakeover: requestInputTakeoverMock,
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

function getLastRenderHibernationHandler(): ((isHibernating: boolean) => void) | undefined {
  return getLastSessionOptions()?.onRenderHibernationChange;
}

function getLastRestoreBlockedHandler(): ((isBlocked: boolean) => void) | undefined {
  return getLastSessionOptions()?.onRestoreBlockedChange;
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
    setWebglAddonPriorityMock.mockReset();
    touchWebglAddonMock.mockReset();
    registerTerminalAttachCandidateMock.mockClear();
    markDirtyMock.mockReset();
    getTerminalFontFamilyMock.mockReset();
    getTerminalThemeMock.mockReset();
    getTerminalFontFamilyMock.mockImplementation((font: string) => `font:${font}`);
    getTerminalThemeMock.mockImplementation((preset: string) => ({ preset }));
    requestInputTakeoverMock.mockResolvedValue(true);
    delete window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__;
    delete window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__;
    syncTerminalHighLoadMode(false);
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalAnomalyMonitorForTests();
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
    resetPanelResizeDragging();
    resetTerminalSurfaceTieringForTests();
    resetTerminalSwitchEchoGraceForTests();
    resetTerminalSwitchWindowForTests();
    resetTerminalFramePressureForTests();
    resetTerminalPerformanceExperimentConfigForTests();
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

  it('reacts to focus, font size, terminal font, and theme changes', async () => {
    const [fontSize, setFontSize] = createSignal<number | undefined>(12);
    const [focused, setFocused] = createSignal(false);

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
    expect(touchWebglAddonMock).toHaveBeenCalledWith('agent-1');
  });

  it('suppresses cursor blinking while restore is blocked and reenables it when recovery settles', () => {
    const [focused] = createSignal(true);
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
    const statusHandler = getLastStatusChangeHandler();

    statusHandler?.('ready');
    expect(session.term.options.cursorBlink).toBe(false);

    setFocused(true);
    expect(session.term.options.cursorBlink).toBe(true);

    statusHandler?.('attaching');
    expect(session.term.options.cursorBlink).toBe(false);

    statusHandler?.('restoring');
    expect(session.term.options.cursorBlink).toBe(false);

    statusHandler?.('error');
    expect(session.term.options.cursorBlink).toBe(false);

    statusHandler?.('ready');
    expect(session.term.options.cursorBlink).toBe(true);

    setFocused(false);
    expect(session.term.options.cursorBlink).toBe(false);
  });

  it('suppresses cursor blinking while another client controls the terminal', () => {
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
    expect(card?.style.width).toBe('32ch');
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
    expect(restoringCard?.style.width).toBe('32ch');
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
      />
    ));

    expect(startTerminalSessionMock).not.toHaveBeenCalled();

    delayedAttach?.();

    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(updateOutputPriorityMock).toHaveBeenCalledTimes(1);
    expect(setWebglAddonPriorityMock).toHaveBeenCalledTimes(1);
    expect(touchWebglAddonMock).not.toHaveBeenCalled();
    expect(
      (
        startTerminalSessionMock.mock.results[0]?.value as {
          term: { options: { cursorBlink: boolean } };
        }
      ).term.options.cursorBlink,
    ).toBe(false);
  });

  it('flushes the trailing PTY resize when panel dragging ends', async () => {
    const flushPendingResizeMock = vi.fn();
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

    beginPanelResizeDrag();
    await Promise.resolve();
    expect(flushPendingResizeMock).toHaveBeenCalledTimes(1);

    endPanelResizeDrag();
    await Promise.resolve();
    expect(flushPendingResizeMock).toHaveBeenCalledTimes(2);
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
    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(terminalRoot?.hasAttribute('data-terminal-dormant')).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(terminalRoot?.getAttribute('data-terminal-dormant')).toBe('true');
    expect(sessionCleanupMock).toHaveBeenCalledTimes(1);
    expect(unregisterMock).toHaveBeenCalledTimes(1);

    setStore('activeTaskId', 'task-1');
    intersectionCallback?.([{ isIntersecting: true }]);
    expect(startTerminalSessionMock).toHaveBeenCalledTimes(2);
    expect(terminalRoot?.hasAttribute('data-terminal-dormant')).toBe(false);

    setStore('activeTaskId', 'task-2');
    intersectionCallback?.([{ isIntersecting: false }]);
    await vi.advanceTimersByTimeAsync(200);

    expect(sessionCleanupMock).toHaveBeenCalledTimes(2);
    expect(unregisterMock).toHaveBeenCalledTimes(2);
    expect(terminalRoot?.getAttribute('data-terminal-dormant')).toBe('true');

    setStore('activeTaskId', 'task-1');
    intersectionCallback?.([{ isIntersecting: true }]);
    expect(startTerminalSessionMock).toHaveBeenCalledTimes(3);
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

    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(terminalRoot?.getAttribute('data-terminal-dormant')).toBe('true');

    requestTerminalPrewarm('task-1', 'pointer-intent');

    expect(armFocusedTerminalOutputPreemptionMock).toHaveBeenCalledTimes(1);
    expect(startTerminalSessionMock).toHaveBeenCalledTimes(2);
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

    await vi.advanceTimersByTimeAsync(200);

    startTerminalSessionMock.mockImplementationOnce(
      (options: { isSelectedRecoveryProtected?: () => boolean }) => {
        expect(getTerminalSwitchWindowSnapshot()).toEqual(
          expect.objectContaining({
            active: true,
            targetTaskId: 'task-1',
          }),
        );
        expect(options.isSelectedRecoveryProtected?.()).toBe(true);

        return {
          cleanup: sessionCleanupMock,
          isRestoreBlocked: vi.fn(() => false),
          prewarmRenderHibernation: vi.fn(),
          requestInputTakeover: requestInputTakeoverMock,
          term: {
            focus: vi.fn(),
            options: {
              cursorBlink: false,
              fontFamily: '',
              fontSize: 12,
              theme: undefined,
            },
          },
          updateOutputPriority: vi.fn(),
        };
      },
    );

    setStore('activeTaskId', 'task-1');
    intersectionCallback?.([{ isIntersecting: true }]);

    expect(startTerminalSessionMock).toHaveBeenCalledTimes(2);
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

  it('marks first paint only after live render is ready, even while selected recovery is still active', async () => {
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
        firstPaintDurationMs: expect.any(Number),
        inputReadyDurationMs: null,
        phase: 'input-ready-pending',
        targetTaskId: 'task-1',
      }),
    );
    expect(terminalRoot?.getAttribute('data-terminal-live-render-ready')).toBe('true');
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

  it('does not begin a terminal switch window for the initially selected task', () => {
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
      />
    ));

    expect(getTerminalSwitchWindowSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: null,
        targetTaskId: null,
      }),
    );
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

    const session = startTerminalSessionMock.mock.results[0]?.value as {
      prewarmRenderHibernation: ReturnType<typeof vi.fn>;
    };
    intersectionCallback?.([{ isIntersecting: false }]);

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

  it('releases the attach slot as soon as the terminal bind completes', () => {
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
});
