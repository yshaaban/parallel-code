import { fireEvent, render, screen } from '@solidjs/testing-library';
import { splitProps, untrack, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  closeShellMock,
  clearAgentActivityMock,
  focusCallbacks,
  markAgentOutputMock,
  registerFocusFnMock,
  runBookmarkInTaskMock,
  setTaskFocusedPanelMock,
  setTaskFocusedPanelStateMock,
  spawnShellForTaskMock,
  showNotificationMock,
  storeRef,
  terminalViewProps,
  unregisterFocusFnMock,
} = vi.hoisted(() => ({
  closeShellMock: vi.fn(),
  clearAgentActivityMock: vi.fn(),
  focusCallbacks: new Map<string, () => void>(),
  markAgentOutputMock: vi.fn(),
  registerFocusFnMock: vi.fn((key: string, fn: () => void) => {
    focusCallbacks.set(key, fn);
  }),
  runBookmarkInTaskMock: vi.fn(),
  setTaskFocusedPanelMock: vi.fn(),
  setTaskFocusedPanelStateMock: vi.fn(),
  spawnShellForTaskMock: vi.fn(),
  showNotificationMock: vi.fn(),
  storeRef: {
    current: {
      focusedPanel: {} as Record<string, string>,
    },
  },
  terminalViewProps: new Map<string, Record<string, unknown>>(),
  unregisterFocusFnMock: vi.fn((key: string) => {
    focusCallbacks.delete(key);
  }),
}));

vi.mock('../../store/store', () => ({
  closeShell: closeShellMock,
  clearAgentActivity: clearAgentActivityMock,
  getFontScale: vi.fn(() => 1),
  getStoredTaskFocusedPanel: vi.fn(
    (taskId: string) => storeRef.current.focusedPanel[taskId] ?? null,
  ),
  isTaskPanelFocused: vi.fn(
    (taskId: string, panelId: string) => storeRef.current.focusedPanel[taskId] === panelId,
  ),
  markAgentOutput: markAgentOutputMock,
  registerFocusFn: registerFocusFnMock,
  setTaskFocusedPanel: setTaskFocusedPanelMock,
  setTaskFocusedPanelState: setTaskFocusedPanelStateMock,
  store: storeRef.current,
  unregisterFocusFn: unregisterFocusFnMock,
}));

vi.mock('../../app/task-workflows', () => ({
  closeShell: closeShellMock,
  runBookmarkInTask: runBookmarkInTaskMock,
  spawnShellForTask: spawnShellForTaskMock,
}));

vi.mock('../../store/notification', () => ({
  showNotification: showNotificationMock,
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
  TerminalView: (props: { agentId: string } & Record<string, unknown>) => {
    const [local, rest] = splitProps(props, ['agentId']);
    const agentId = untrack(() => local.agentId);
    terminalViewProps.set(agentId, { agentId, ...rest });
    return <div>Terminal</div>;
  },
}));

import { TaskShellSection } from './TaskShellSection';

describe('TaskShellSection', () => {
  beforeEach(() => {
    vi.useRealTimers();
    focusCallbacks.clear();
    terminalViewProps.clear();
    storeRef.current.focusedPanel = {};
    registerFocusFnMock.mockClear();
    unregisterFocusFnMock.mockClear();
    setTaskFocusedPanelMock.mockClear();
    setTaskFocusedPanelStateMock.mockClear();
    clearAgentActivityMock.mockClear();
    showNotificationMock.mockClear();
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

  it('clears a stale shell exit badge when the shell becomes ready or emits output again', () => {
    render(() => (
      <TaskShellSection
        taskId={() => 'task-1'}
        bookmarks={() => []}
        isActive={() => true}
        shellAgentIds={() => ['shell-1']}
        worktreePath={() => '/tmp/project'}
      />
    ));

    const terminalProps = terminalViewProps.get('shell-1') as
      | {
          onData?: (data: Uint8Array) => void;
          onExit?: (info: { exit_code: number | null; signal: string | null }) => void;
          onReady?: (focusFn: () => void) => void;
        }
      | undefined;
    expect(terminalProps).toBeDefined();

    terminalProps?.onExit?.({
      exit_code: 1,
      signal: 'SIGTERM',
    });
    expect(screen.getByText('Process exited (1)')).toBeDefined();

    terminalProps?.onData?.(new TextEncoder().encode('still running\n'));
    expect(screen.queryByText('Process exited (1)')).toBeNull();

    terminalProps?.onExit?.({
      exit_code: 2,
      signal: 'SIGTERM',
    });
    expect(screen.getByText('Process exited (2)')).toBeDefined();

    terminalProps?.onReady?.(() => {});
    expect(screen.queryByText('Process exited (2)')).toBeNull();
  });

  it('delegates task switch-window lifecycle ownership to the task panel', () => {
    render(() => (
      <TaskShellSection
        taskId={() => 'task-1'}
        bookmarks={() => []}
        isActive={() => true}
        shellAgentIds={() => ['shell-1']}
        worktreePath={() => '/tmp/project'}
      />
    ));

    const terminalProps = terminalViewProps.get('shell-1');
    expect(terminalProps?.manageTaskSwitchWindowLifecycle).toBe(false);
  });

  it('clears shell activity when a shell exits naturally', () => {
    render(() => (
      <TaskShellSection
        taskId={() => 'task-1'}
        bookmarks={() => []}
        isActive={() => true}
        shellAgentIds={() => ['shell-1']}
        worktreePath={() => '/tmp/project'}
      />
    ));

    const terminalProps = terminalViewProps.get('shell-1') as
      | {
          onExit?: (info: { exit_code: number | null; signal: string | null }) => void;
        }
      | undefined;
    expect(terminalProps).toBeDefined();

    terminalProps?.onExit?.({
      exit_code: 0,
      signal: null,
    });

    expect(clearAgentActivityMock).toHaveBeenCalledWith('shell-1');
    expect(screen.getByText('Process exited (0)')).toBeDefined();
  });

  it('handles bookmark failures without leaving an unhandled UI promise', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runBookmarkInTaskMock.mockRejectedValueOnce(new Error('release failed'));

    render(() => (
      <TaskShellSection
        taskId={() => 'task-1'}
        bookmarks={() => [{ id: 'bookmark-1', command: 'npm run test' }]}
        isActive={() => true}
        shellAgentIds={() => []}
        worktreePath={() => '/tmp/project'}
      />
    ));

    const toolbar = screen.getByRole('generic', { name: 'Shell toolbar' });
    fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    fireEvent.keyDown(toolbar, { key: 'Enter' });
    await Promise.resolve();

    expect(showNotificationMock).toHaveBeenCalledWith('Failed to run shell command');
    expect(warnSpy).toHaveBeenCalledWith('Failed to run shell command:', expect.any(Error));

    warnSpy.mockRestore();
  });

  it('handles shell close failures without leaving an unhandled UI promise', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    closeShellMock.mockRejectedValueOnce(new Error('kill failed'));

    render(() => (
      <TaskShellSection
        taskId={() => 'task-1'}
        bookmarks={() => []}
        isActive={() => true}
        shellAgentIds={() => ['shell-1']}
        worktreePath={() => '/tmp/project'}
      />
    ));

    fireEvent.click(screen.getByTitle('Close terminal (Ctrl+Shift+Q)'));
    await Promise.resolve();

    expect(showNotificationMock).toHaveBeenCalledWith('Failed to close terminal');
    expect(warnSpy).toHaveBeenCalledWith('Failed to close terminal:', expect.any(Error));

    warnSpy.mockRestore();
  });
});
