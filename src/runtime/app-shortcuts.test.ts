import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  closeShellMock,
  getTaskFocusedPanelMock,
  handlers,
  registerShortcutMock,
  showNotificationMock,
  storeRef,
} = vi.hoisted(() => ({
  closeShellMock: vi.fn(),
  getTaskFocusedPanelMock: vi.fn(),
  handlers: new Map<string, () => void>(),
  registerShortcutMock: vi.fn((definition: { handler: () => void; key: string }) => {
    handlers.set(definition.key, definition.handler);
  }),
  showNotificationMock: vi.fn(),
  storeRef: {
    current: {
      activeTaskId: 'task-1',
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
  resetFontScale: vi.fn(),
  resetGlobalScale: vi.fn(),
  toggleSidebar: vi.fn(),
}));

vi.mock('../store/notification', () => ({
  showNotification: showNotificationMock,
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
    registerShortcutMock.mockClear();
    closeShellMock.mockReset();
    getTaskFocusedPanelMock.mockReturnValue('shell:0');
    showNotificationMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
