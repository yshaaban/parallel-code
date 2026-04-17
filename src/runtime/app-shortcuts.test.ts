import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  closeMarkdownViewerMock,
  closeShellMock,
  getTaskFocusedPanelMock,
  handlers,
  registeredShortcuts,
  registerShortcutMock,
  showNotificationMock,
  storeRef,
} = vi.hoisted(() => ({
  closeMarkdownViewerMock: vi.fn(),
  closeShellMock: vi.fn(),
  getTaskFocusedPanelMock: vi.fn(),
  handlers: new Map<string, () => void>(),
  registeredShortcuts: [] as Array<Record<string, unknown>>,
  registerShortcutMock: vi.fn((definition: { handler: () => void; key: string }) => {
    registeredShortcuts.push(definition as Record<string, unknown>);
    handlers.set(definition.key, definition.handler);
  }),
  showNotificationMock: vi.fn(),
  storeRef: {
    current: {
      activeTaskId: 'task-1',
      markdownViewer: null as { content: string } | null,
      showArena: false,
      showHelpDialog: false,
      showNewTaskDialog: false,
      showSettingsDialog: false,
      tasks: {
        'task-1': {
          shellAgentIds: ['shell-1'],
        },
      },
    },
  },
}));

vi.mock('../lib/shortcuts', () => ({
  initShortcuts: vi.fn(() => vi.fn()),
  registerShortcut: registerShortcutMock,
}));

vi.mock('../store/focus', () => ({
  getTaskFocusedPanel: getTaskFocusedPanelMock,
  navigateColumn: vi.fn(),
  navigateRow: vi.fn(),
  sendActivePrompt: vi.fn(),
  setPendingAction: vi.fn(),
  toggleHelpDialog: vi.fn(),
  toggleSettingsDialog: vi.fn(),
}));

vi.mock('../store/navigation', () => ({
  moveActiveTask: vi.fn(),
  toggleNewTaskDialog: vi.fn(),
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
    closeMarkdownViewerMock.mockReset();
    closeShellMock.mockReset();
    getTaskFocusedPanelMock.mockReturnValue('shell:0');
    Object.assign(storeRef.current, {
      markdownViewer: null,
      showArena: false,
      showHelpDialog: false,
      showNewTaskDialog: false,
      showSettingsDialog: false,
    });
    showNotificationMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers zoom reset as a global shortcut', () => {
    registerAppShortcuts();

    expect(registeredShortcuts).toContainEqual(
      expect.objectContaining({
        cmdOrCtrl: true,
        dialogSafe: true,
        global: true,
        key: '0',
      }),
    );
  });

  it('registers zoom in and out as global dialog-safe shortcuts', () => {
    registerAppShortcuts();

    expect(registeredShortcuts).toContainEqual(
      expect.objectContaining({
        cmdOrCtrl: true,
        dialogSafe: true,
        global: true,
        key: '=',
      }),
    );
    expect(registeredShortcuts).toContainEqual(
      expect.objectContaining({
        cmdOrCtrl: true,
        dialogSafe: true,
        global: true,
        key: '+',
      }),
    );
    expect(registeredShortcuts).toContainEqual(
      expect.objectContaining({
        cmdOrCtrl: true,
        dialogSafe: true,
        global: true,
        key: '-',
      }),
    );
  });

  it('closes the shared markdown viewer before other dialogs on Escape', () => {
    storeRef.current.markdownViewer = { content: '# Plan' };

    registerAppShortcuts();
    handlers.get('Escape')?.();

    expect(closeMarkdownViewerMock).toHaveBeenCalledTimes(1);
  });

  it('handles shell close shortcut failures explicitly', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    closeShellMock.mockRejectedValueOnce(new Error('kill failed'));

    registerAppShortcuts();
    handlers.get('w')?.();
    await Promise.resolve();

    expect(showNotificationMock).toHaveBeenCalledWith('Failed to close terminal');
    expect(warnSpy).toHaveBeenCalledWith('Failed to close terminal:', expect.any(Error));

    warnSpy.mockRestore();
  });
});
