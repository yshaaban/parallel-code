import { render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { resetStoreForTest } from '../test/store-test-helpers';

const {
  getTerminalFontFamilyMock,
  getTerminalThemeMock,
  markDirtyMock,
  sessionCleanupMock,
  startTerminalSessionMock,
  touchWebglAddonMock,
} = vi.hoisted(() => ({
  getTerminalFontFamilyMock: vi.fn((font: string) => `font:${font}`),
  getTerminalThemeMock: vi.fn((preset: string) => ({ preset })),
  markDirtyMock: vi.fn(),
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
}));

vi.mock('../lib/terminalFitManager', () => ({
  markDirty: markDirtyMock,
}));

vi.mock('../lib/webglPool', () => ({
  touchWebglAddon: touchWebglAddonMock,
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return { store: core.store };
});

import { TerminalView } from './TerminalView';

describe('TerminalView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    startTerminalSessionMock.mockReturnValue({
      cleanup: sessionCleanupMock,
      term: {
        options: {
          cursorBlink: false,
          fontFamily: '',
          fontSize: 12,
          theme: undefined,
        },
      },
    });
  });

  afterEach(() => {
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
});
