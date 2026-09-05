import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  closeMarkdownViewerMock,
  closeShellMock,
  getTaskFocusedPanelMock,
  handlers,
  jumpToTaskMock,
  navigateTaskMock,
  requestTaskGitActionMock,
  requestVisibleWebglAtlasRepairMock,
  registeredShortcuts,
  registerShortcutMock,
  showNotificationMock,
  storeRef,
  toggleAddProjectDialogMock,
  toggleNewTaskDialogMock,
} = vi.hoisted(() => ({
  closeMarkdownViewerMock: vi.fn(),
  closeShellMock: vi.fn(),
  getTaskFocusedPanelMock: vi.fn(),
  handlers: new Map<string, (event?: Pick<KeyboardEvent, 'repeat'>) => void>(),
  jumpToTaskMock: vi.fn(),
  navigateTaskMock: vi.fn(),
  requestTaskGitActionMock: vi.fn(),
  requestVisibleWebglAtlasRepairMock: vi.fn(),
  registeredShortcuts: [] as Array<Record<string, unknown>>,
  registerShortcutMock: vi.fn(
    (definition: {
      actionId?: string;
      handler: (event?: Pick<KeyboardEvent, 'repeat'>) => void;
      key?: string;
    }) => {
      registeredShortcuts.push(definition as Record<string, unknown>);
      handlers.set(definition.actionId ?? definition.key ?? '', definition.handler);
    },
  ),
  showNotificationMock: vi.fn(),
  storeRef: {
    current: {
      activeTaskId: 'task-1',
      markdownViewer: null as { content: string } | null,
      showArena: false,
      showAddProjectDialog: false,
      showHelpDialog: false,
      showNewTaskDialog: false,
      showSettingsDialog: false,
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          shellAgentIds: ['shell-1'],
        },
      },
    },
  },
  toggleAddProjectDialogMock: vi.fn(),
  toggleNewTaskDialogMock: vi.fn(),
}));

vi.mock('../lib/shortcuts', () => ({
  initShortcuts: vi.fn(() => vi.fn()),
  registerShortcut: registerShortcutMock,
}));

vi.mock('../lib/webglPool', () => ({
  requestVisibleWebglAtlasRepair: requestVisibleWebglAtlasRepairMock,
}));

vi.mock('../store/focus', () => ({
  getTaskFocusedPanel: getTaskFocusedPanelMock,
  hasBlockingDialog: vi.fn(() => false),
  navigateColumn: vi.fn(),
  navigateRow: vi.fn(),
  navigateTask: navigateTaskMock,
  sendActivePrompt: vi.fn(),
  setPendingAction: vi.fn(),
  toggleHelpDialog: vi.fn(),
  toggleSettingsDialog: vi.fn(),
}));

vi.mock('../store/navigation', () => ({
  jumpToTask: jumpToTaskMock,
  moveActiveTask: vi.fn(),
  toggleAddProjectDialog: toggleAddProjectDialogMock,
  toggleNewTaskDialog: toggleNewTaskDialogMock,
}));

vi.mock('../store/state', () => ({
  store: storeRef.current,
}));

vi.mock('../store/terminals', () => ({
  closeTerminal: vi.fn(),
  createTerminal: vi.fn(),
}));

vi.mock('../store/ui', () => ({
  adjustGlobalScale: vi.fn(),
  resetFontScale: vi.fn(),
  resetGlobalScale: vi.fn(),
  toggleSidebar: vi.fn(),
}));

vi.mock('../store/notification', () => ({
  showNotification: showNotificationMock,
}));

vi.mock('../app/markdown-viewer', () => ({
  closeMarkdownViewer: closeMarkdownViewerMock,
}));

vi.mock('../app/new-task-dialog-workflows', () => ({
  openNewTaskDialog: vi.fn(),
}));

vi.mock('../app/task-git-action-capability', () => ({
  requestTaskGitAction: requestTaskGitActionMock,
}));

vi.mock('../app/task-shell-workflows', () => ({
  closeShell: closeShellMock,
  spawnShellForTask: vi.fn(),
}));

import { registerAppShortcuts } from './app-shortcuts';

describe('registerAppShortcuts', () => {
  beforeEach(() => {
    handlers.clear();
    registeredShortcuts.length = 0;
    registerShortcutMock.mockClear();
    jumpToTaskMock.mockReset();
    navigateTaskMock.mockReset();
    requestTaskGitActionMock.mockReset();
    requestVisibleWebglAtlasRepairMock.mockReset();
    closeMarkdownViewerMock.mockReset();
    closeShellMock.mockReset();
    getTaskFocusedPanelMock.mockReturnValue('shell:0');
    Object.assign(storeRef.current, {
      markdownViewer: null,
      showArena: false,
      showAddProjectDialog: false,
      showHelpDialog: false,
      showNewTaskDialog: false,
      showSettingsDialog: false,
    });
    toggleAddProjectDialogMock.mockReset();
    toggleNewTaskDialogMock.mockReset();
    showNotificationMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers zoom reset by keybinding action', () => {
    registerAppShortcuts();

    expect(registeredShortcuts).toContainEqual(
      expect.objectContaining({
        actionId: 'app.reset-zoom',
      }),
    );
  });

  it('lazily requests a manual terminal redraw and ignores key repeat', async () => {
    registerAppShortcuts();
    const redrawHandler = handlers.get('app.redraw-terminals') as unknown as (
      event: Pick<KeyboardEvent, 'repeat'>,
    ) => void;

    redrawHandler({ repeat: true });
    await Promise.resolve();
    expect(requestVisibleWebglAtlasRepairMock).not.toHaveBeenCalled();

    redrawHandler({ repeat: false });
    await vi.waitFor(() => {
      expect(requestVisibleWebglAtlasRepairMock).toHaveBeenCalledWith('manual');
    });
    expect(showNotificationMock).not.toHaveBeenCalled();
  });

  it('contains lazy terminal redraw failures without surfacing a notification', async () => {
    const error = new Error('lazy redraw failed');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    requestVisibleWebglAtlasRepairMock.mockImplementationOnce(() => {
      throw error;
    });
    registerAppShortcuts();
    const redrawHandler = handlers.get('app.redraw-terminals') as unknown as (
      event: Pick<KeyboardEvent, 'repeat'>,
    ) => void;

    redrawHandler({ repeat: false });

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('Failed to redraw terminals:', error);
    });
    expect(showNotificationMock).not.toHaveBeenCalled();
  });

  it('registers zoom in and out by keybinding action', () => {
    registerAppShortcuts();

    expect(registeredShortcuts).toContainEqual(
      expect.objectContaining({
        actionId: 'app.zoom-in',
      }),
    );
    expect(registeredShortcuts).toContainEqual(
      expect.objectContaining({
        actionId: 'app.zoom-in-alt',
      }),
    );
    expect(registeredShortcuts).toContainEqual(
      expect.objectContaining({
        actionId: 'app.zoom-out',
      }),
    );
  });

  it('registers task jump shortcuts by keybinding action', () => {
    registerAppShortcuts();

    expect(registeredShortcuts).toContainEqual(
      expect.objectContaining({
        actionId: 'task.jump-1',
      }),
    );
    expect(registeredShortcuts).toContainEqual(
      expect.objectContaining({
        actionId: 'task.jump-9',
      }),
    );

    const firstTaskShortcut = registeredShortcuts.find(
      (shortcut) => shortcut.actionId === 'task.jump-1',
    );
    const ninthTaskShiftShortcut = registeredShortcuts.find(
      (shortcut) => shortcut.actionId === 'task.jump-9',
    );

    (firstTaskShortcut?.handler as (() => void) | undefined)?.();
    (ninthTaskShiftShortcut?.handler as (() => void) | undefined)?.();

    expect(jumpToTaskMock).toHaveBeenNthCalledWith(1, 0);
    expect(jumpToTaskMock).toHaveBeenNthCalledWith(2, 8);
  });

  it('registers direct task switch shortcuts by keybinding action', () => {
    registerAppShortcuts();

    handlers.get('navigation.task-left')?.();
    handlers.get('navigation.task-right')?.();

    expect(navigateTaskMock).toHaveBeenNthCalledWith(1, 'left');
    expect(navigateTaskMock).toHaveBeenNthCalledWith(2, 'right');
  });

  it.each([
    ['task.merge', 'merge'],
    ['task.push', 'push'],
  ] as const)(
    'routes %s through capability admission and ignores key repeat',
    (actionId, action) => {
      registerAppShortcuts();
      const handler = handlers.get(actionId);

      handler?.({ repeat: true });
      expect(requestTaskGitActionMock).not.toHaveBeenCalled();

      handler?.({ repeat: false });
      expect(requestTaskGitActionMock).toHaveBeenCalledOnce();
      expect(requestTaskGitActionMock).toHaveBeenCalledWith(action, 'task-1', 'shortcut');
    },
  );

  it('closes the shared markdown viewer before other dialogs on Escape', () => {
    storeRef.current.markdownViewer = { content: '# Plan' };

    registerAppShortcuts();
    handlers.get('app.close-dialog')?.();

    expect(closeMarkdownViewerMock).toHaveBeenCalledTimes(1);
  });

  it('closes the add-project dialog on Escape', () => {
    storeRef.current.showAddProjectDialog = true;

    registerAppShortcuts();
    handlers.get('app.close-dialog')?.();

    expect(toggleAddProjectDialogMock).toHaveBeenCalledWith(false);
  });

  it('leaves a mounted New Task dialog to the topmost dialog Escape owner', () => {
    storeRef.current.showNewTaskDialog = true;

    registerAppShortcuts();
    handlers.get('app.close-dialog')?.();

    expect(toggleNewTaskDialogMock).not.toHaveBeenCalled();
  });

  it('handles shell close shortcut failures explicitly', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    closeShellMock.mockRejectedValueOnce(new Error('kill failed'));

    registerAppShortcuts();
    handlers.get('task.close-focused-terminal')?.();
    await Promise.resolve();

    expect(showNotificationMock).toHaveBeenCalledWith('Failed to close terminal', {
      kind: 'error',
    });
    expect(warnSpy).toHaveBeenCalledWith('Failed to close terminal:', expect.any(Error));

    warnSpy.mockRestore();
  });

  it.each(['shell:0junk', 'shell:0.5', 'shell:-1'])(
    'does not close a shell for malformed focused panel %s',
    (panelId) => {
      getTaskFocusedPanelMock.mockReturnValue(panelId);

      registerAppShortcuts();
      handlers.get('task.close-focused-terminal')?.();

      expect(closeShellMock).not.toHaveBeenCalled();
    },
  );
});
