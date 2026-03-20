import { render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import {
  getTerminalStartupSummary,
  registerTerminalStartupCandidate,
  resetTerminalStartupStateForTests,
} from '../store/terminal-startup';
import { resetStoreForTest } from '../test/store-test-helpers';

const {
  getTerminalFontFamilyMock,
  getTerminalThemeMock,
  markDirtyMock,
  registerTerminalAttachCandidateMock,
  requestInputTakeoverMock,
  setWebglAddonPriorityMock,
  sessionCleanupMock,
  startTerminalSessionMock,
  touchWebglAddonMock,
} = vi.hoisted(() => ({
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

function getLastSessionOptions():
  | {
      onAttachBound?: () => void;
      onStatusChange?: (status: 'attaching' | 'error' | 'ready' | 'restoring') => void;
    }
  | undefined {
  const lastCall =
    startTerminalSessionMock.mock.calls[startTerminalSessionMock.mock.calls.length - 1];
  return lastCall?.[0] as
    | {
        onAttachBound?: () => void;
        onStatusChange?: (status: 'attaching' | 'error' | 'ready' | 'restoring') => void;
      }
    | undefined;
}

function getLastStatusChangeHandler():
  | ((status: 'attaching' | 'error' | 'ready' | 'restoring') => void)
  | undefined {
  return getLastSessionOptions()?.onStatusChange;
}

function getLastAttachBoundHandler(): (() => void) | undefined {
  return getLastSessionOptions()?.onAttachBound;
}

describe('TerminalView', () => {
  const originalIntersectionObserver = globalThis.IntersectionObserver;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    resetStoreForTest();
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
    startTerminalSessionMock.mockReturnValue({
      cleanup: sessionCleanupMock,
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
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    requestInputTakeoverMock.mockReset();
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: originalIntersectionObserver,
    });
    resetTerminalStartupStateForTests();
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
    expect(markDirtyMock).toHaveBeenCalledWith('agent-1');

    setStore('terminalFont', 'Fira Code');
    expect(getTerminalFontFamilyMock).toHaveBeenCalledWith('Fira Code');
    expect(session.term.options.fontFamily).toBe('font:Fira Code');

    setStore('themePreset', 'classic');
    expect(getTerminalThemeMock).toHaveBeenCalledWith('classic');
    expect(session.term.options.theme).toEqual({ preset: 'classic' });

    setFocused(true);
    expect(session.term.options.cursorBlink).toBe(true);
    expect(touchWebglAddonMock).toHaveBeenCalledWith('agent-1');
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

    expect(result.getByText('Connecting to terminal…')).toBeTruthy();
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

    expect(initialPriority).toBe(3);
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
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
    expect(getTerminalStartupSummary()).toEqual({
      attachingCount: 0,
      bindingCount: 0,
      detail: '1 queued',
      label: 'Preparing terminal…',
      pendingCount: 1,
      queuedCount: 1,
      restoringCount: 0,
    });

    onStatusChange?.('attaching');
    expect(screen.getByText('Attaching terminal…')).toBeDefined();
    expect(getTerminalStartupSummary()).toEqual({
      attachingCount: 1,
      bindingCount: 0,
      detail: '1 attaching',
      label: 'Attaching terminal…',
      pendingCount: 1,
      queuedCount: 0,
      restoringCount: 0,
    });

    onStatusChange?.('restoring');
    expect(screen.getByText('Restoring terminal output…')).toBeDefined();
    expect(getTerminalStartupSummary()).toEqual({
      attachingCount: 0,
      bindingCount: 0,
      detail: '1 restoring',
      label: 'Restoring terminal output…',
      pendingCount: 1,
      queuedCount: 0,
      restoringCount: 1,
    });

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

  it('shows a read-only takeover action when another client controls the task', async () => {
    setStore('taskCommandControllers', 'task-1', {
      action: 'type in the terminal',
      controllerId: 'peer-client',
    });
    startTerminalSessionMock.mockImplementation(
      ({ onStatusChange }: { onStatusChange?: (status: 'ready') => void }) => {
        onStatusChange?.('ready');
        return {
          cleanup: sessionCleanupMock,
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

    await result.findByText('Another browser session is currently typing in this terminal.');
    const takeOverButton = result
      .getAllByRole('button')
      .find((button) => button.textContent?.includes('Take Over'));

    expect(takeOverButton).toBeDefined();
    takeOverButton?.click();

    expect(requestInputTakeoverMock).toHaveBeenCalledTimes(1);
  });

  it('collapses the takeover banner into a compact chip when dismissed', async () => {
    setStore('taskCommandControllers', 'task-1', {
      action: 'type in the terminal',
      controllerId: 'peer-client',
    });
    startTerminalSessionMock.mockImplementation(
      ({ onStatusChange }: { onStatusChange?: (status: 'ready') => void }) => {
        onStatusChange?.('ready');
        return {
          cleanup: sessionCleanupMock,
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

    const dismissButton = await result.findByRole('button', {
      name: 'Dismiss control notice',
    });
    dismissButton.click();

    expect(result.getByText('Terminal in use')).toBeTruthy();
  });
});
