import { fireEvent, render, screen } from '@solidjs/testing-library';
import type { JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  closeShellMock,
  focusCallbacks,
  markAgentOutputMock,
  registerFocusFnMock,
  runBookmarkInTaskMock,
  setTaskFocusedPanelMock,
  setTaskFocusedPanelStateMock,
  spawnShellForTaskMock,
  storeRef,
  unregisterFocusFnMock,
} = vi.hoisted(() => ({
  closeShellMock: vi.fn(),
  focusCallbacks: new Map<string, () => void>(),
  markAgentOutputMock: vi.fn(),
  registerFocusFnMock: vi.fn((key: string, fn: () => void) => {
    focusCallbacks.set(key, fn);
  }),
  runBookmarkInTaskMock: vi.fn(),
  setTaskFocusedPanelMock: vi.fn(),
  setTaskFocusedPanelStateMock: vi.fn(),
  spawnShellForTaskMock: vi.fn(),
  storeRef: {
    current: {
      focusedPanel: {} as Record<string, string>,
    },
  },
  unregisterFocusFnMock: vi.fn((key: string) => {
    focusCallbacks.delete(key);
  }),
}));

vi.mock('../../store/store', () => ({
  closeShell: closeShellMock,
  getFontScale: vi.fn(() => 1),
  getStoredTaskFocusedPanel: vi.fn(
    (taskId: string) => storeRef.current.focusedPanel[taskId] ?? null,
  ),
  isTaskPanelFocused: vi.fn(
    (taskId: string, panelId: string) => storeRef.current.focusedPanel[taskId] === panelId,
  ),
  markAgentOutput: markAgentOutputMock,
  registerFocusFn: registerFocusFnMock,
  runBookmarkInTask: runBookmarkInTaskMock,
  setTaskFocusedPanel: setTaskFocusedPanelMock,
  setTaskFocusedPanelState: setTaskFocusedPanelStateMock,
  store: storeRef.current,
  spawnShellForTask: spawnShellForTaskMock,
  unregisterFocusFn: unregisterFocusFnMock,
}));

vi.mock('../../lib/bookmarks', () => ({
  consumePendingShellCommand: vi.fn(() => null),
}));

vi.mock('../ScalablePanel', () => ({
  ScalablePanel: (props: { children: JSX.Element }) => <div>{props.children}</div>,
}));

vi.mock('../TaskShellToolbar', () => ({
  TaskShellToolbar: (props: {
    onToolbarBlur: () => void;
    onToolbarClick: () => void;
    onToolbarFocus: () => void;
    onToolbarKeyDown: (event: KeyboardEvent) => void;
    selectedIndex: number;
    setToolbarRef: (element: HTMLDivElement) => void;
  }) => (
    <div>
      <div
        ref={(element) => {
          props.setToolbarRef(element);
        }}
        tabIndex={0}
        aria-label="Shell toolbar"
        onFocus={() => props.onToolbarFocus()}
        onBlur={() => props.onToolbarBlur()}
        onClick={() => props.onToolbarClick()}
        onKeyDown={(event) => props.onToolbarKeyDown(event)}
      />
      <div>{`Selected index: ${props.selectedIndex}`}</div>
    </div>
  ),
}));

vi.mock('../TerminalView', () => ({
  TerminalView: () => <div>Terminal</div>,
}));

import { TaskShellSection } from './TaskShellSection';

describe('TaskShellSection', () => {
  beforeEach(() => {
    vi.useRealTimers();
    focusCallbacks.clear();
    storeRef.current.focusedPanel = {};
    registerFocusFnMock.mockClear();
    unregisterFocusFnMock.mockClear();
    setTaskFocusedPanelMock.mockClear();
    setTaskFocusedPanelStateMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers shell toolbar focus callbacks per button and updates selected index', () => {
    render(() => (
      <TaskShellSection
        taskId={() => 'task-1'}
        bookmarks={() => [
          { id: 'bookmark-1', command: 'npm run dev' },
          { id: 'bookmark-2', command: 'npm run test' },
        ]}
        isActive={() => true}
        shellAgentIds={() => []}
        worktreePath={() => '/tmp/project'}
      />
    ));

    expect(registerFocusFnMock).toHaveBeenCalledWith('task-1:shell-toolbar', expect.any(Function));
    expect(registerFocusFnMock).toHaveBeenCalledWith(
      'task-1:shell-toolbar:0',
      expect.any(Function),
    );
    expect(registerFocusFnMock).toHaveBeenCalledWith(
      'task-1:shell-toolbar:1',
      expect.any(Function),
    );
    expect(registerFocusFnMock).toHaveBeenCalledWith(
      'task-1:shell-toolbar:2',
      expect.any(Function),
    );

    focusCallbacks.get('task-1:shell-toolbar:2')?.();
    expect(screen.getByText('Selected index: 2')).toBeDefined();

    focusCallbacks.get('task-1:shell-toolbar')?.();
    expect(screen.getByText('Selected index: 0')).toBeDefined();
  });

  it('syncs the selected toolbar index from stored focus state on mount', () => {
    storeRef.current.focusedPanel = { 'task-1': 'shell-toolbar:2' };

    render(() => (
      <TaskShellSection
        taskId={() => 'task-1'}
        bookmarks={() => [
          { id: 'bookmark-1', command: 'npm run dev' },
          { id: 'bookmark-2', command: 'npm run test' },
        ]}
        isActive={() => true}
        shellAgentIds={() => []}
        worktreePath={() => '/tmp/project'}
      />
    ));

    expect(screen.getByText('Selected index: 2')).toBeDefined();
  });

  it('clamps stale stored toolbar focus without triggering interactive focus changes', () => {
    storeRef.current.focusedPanel = { 'task-1': 'shell-toolbar:9' };

    render(() => (
      <TaskShellSection
        taskId={() => 'task-1'}
        bookmarks={() => [{ id: 'bookmark-1', command: 'npm run dev' }]}
        isActive={() => false}
        shellAgentIds={() => []}
        worktreePath={() => '/tmp/project'}
      />
    ));

    expect(setTaskFocusedPanelStateMock).toHaveBeenCalledWith('task-1', 'shell-toolbar:1');
    expect(setTaskFocusedPanelMock).not.toHaveBeenCalled();
  });

  it('writes shell-toolbar focus state for plain arrow keys but leaves Alt+Arrow to global navigation', () => {
    render(() => (
      <TaskShellSection
        taskId={() => 'task-1'}
        bookmarks={() => [{ id: 'bookmark-1', command: 'npm run dev' }]}
        isActive={() => true}
        shellAgentIds={() => []}
        worktreePath={() => '/tmp/project'}
      />
    ));

    const toolbar = screen.getByRole('generic', { name: 'Shell toolbar' });
    fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    expect(setTaskFocusedPanelMock).toHaveBeenCalledWith('task-1', 'shell-toolbar:1');

    setTaskFocusedPanelMock.mockClear();
    fireEvent.keyDown(toolbar, { key: 'ArrowRight', altKey: true });
    expect(setTaskFocusedPanelMock).not.toHaveBeenCalled();
  });
});
