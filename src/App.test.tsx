import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { createEffect } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_DISPLAY_NAME_DIALOG_ACTION } from './app/app-action-keys';

const {
  clearIncomingTaskTakeoverRequestMock,
  clearNotificationMock,
  expireIncomingTaskCommandTakeoverRequestMock,
  getGlobalScaleMock,
  isElectronRuntimeMock,
  registerActionMock,
  registerConfirmNotifierMock,
  setNewTaskDropUrlMock,
  setStoreMock,
  startDesktopAppSessionMock,
  toggleArenaMock,
  toggleHelpDialogMock,
  toggleNewTaskDialogMock,
  toggleSettingsDialogMock,
  toggleSidebarMock,
  storeState,
  unregisterActionMock,
  displayNameDialogPropsRef,
} = vi.hoisted(() => ({
  clearIncomingTaskTakeoverRequestMock: vi.fn(),
  clearNotificationMock: vi.fn(),
  displayNameDialogPropsRef: { current: null as Record<string, unknown> | null },
  expireIncomingTaskCommandTakeoverRequestMock: vi.fn(),
  getGlobalScaleMock: vi.fn(() => 1),
  isElectronRuntimeMock: vi.fn(() => true),
  registerActionMock: vi.fn(),
  registerConfirmNotifierMock: vi.fn(),
  setNewTaskDropUrlMock: vi.fn(),
  setStoreMock: vi.fn((key: string, value: unknown) => {
    (storeState as Record<string, unknown>)[key] = value;
  }),
  startDesktopAppSessionMock: vi.fn(() => vi.fn()),
  toggleArenaMock: vi.fn(),
  toggleHelpDialogMock: vi.fn(),
  toggleNewTaskDialogMock: vi.fn(),
  toggleSettingsDialogMock: vi.fn(),
  toggleSidebarMock: vi.fn(),
  unregisterActionMock: vi.fn(),
  storeState: {
    activeTaskId: null,
    completedTaskCount: 0,
    completedTaskDate: '2026-03-18',
    hasSeenDesktopIntro: false,
    incomingTaskTakeoverRequests: {},
    inactiveColumnOpacity: 0.6,
    mergedLinesAdded: 0,
    mergedLinesRemoved: 0,
    newTaskDropUrl: null,
    notification: null,
    peerSessions: {},
    remoteAccess: { enabled: false },
    showArena: false,
    showHelpDialog: false,
    showNewTaskDialog: false,
    showSettingsDialog: false,
    sidebarVisible: true,
    taskOrder: [],
    themePreset: 'minimal',
  },
}));

vi.mock('./lib/dialog', () => ({
  clearConfirmNotifier: vi.fn(),
  getPendingConfirm: vi.fn(() => null),
  registerConfirmNotifier: registerConfirmNotifierMock,
  resolvePendingConfirm: vi.fn(),
  resolvePendingPathInput: vi.fn(),
}));

vi.mock('./lib/display-name', () => ({
  getStoredDisplayName: vi.fn(() => 'Desktop User'),
  setStoredDisplayName: vi.fn((value: string) => value),
}));

vi.mock('./lib/ipc', () => ({
  isElectronRuntime: isElectronRuntimeMock,
}));

vi.mock('./app/desktop-session', () => ({
  getConnectionBannerText: vi.fn(() => null),
  startDesktopAppSession: startDesktopAppSessionMock,
}));

vi.mock('./runtime/browser-presence', () => ({
  createBrowserPresenceRuntime: vi.fn(),
}));

vi.mock('./runtime/drag-drop', () => ({
  createGitHubDragDropRuntime: vi.fn(() => ({
    handleDragEnter: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDragOver: vi.fn(),
    handleDrop: vi.fn(),
  })),
}));

vi.mock('./app/task-command-lease', () => ({
  expireIncomingTaskCommandTakeoverRequest: expireIncomingTaskCommandTakeoverRequestMock,
  respondToIncomingTaskCommandTakeover: vi.fn(),
}));

vi.mock('./store/core', () => ({
  setStore: setStoreMock,
}));

vi.mock('./store/store', () => ({
  clearIncomingTaskTakeoverRequest: clearIncomingTaskTakeoverRequestMock,
  clearNotification: clearNotificationMock,
  getGlobalScale: getGlobalScaleMock,
  registerAction: registerActionMock,
  setNewTaskDropUrl: setNewTaskDropUrlMock,
  store: storeState,
  toggleArena: toggleArenaMock,
  toggleHelpDialog: toggleHelpDialogMock,
  toggleNewTaskDialog: toggleNewTaskDialogMock,
  toggleSettingsDialog: toggleSettingsDialogMock,
  toggleSidebar: toggleSidebarMock,
  unregisterAction: unregisterActionMock,
}));

vi.mock('./components/ConfirmDialog', () => ({ ConfirmDialog: () => <div /> }));
vi.mock('./components/DisplayNameDialog', () => ({
  DisplayNameDialog: (props: Record<string, unknown>) => {
    createEffect(() => {
      displayNameDialogPropsRef.current = { ...props };
    });
    return <div data-display-name-open={String(props.open)} />;
  },
}));
vi.mock('./components/TaskTakeoverRequestDialog', () => ({
  TaskTakeoverRequestDialog: () => <div />,
}));
vi.mock('./components/Sidebar', () => ({ Sidebar: () => <div /> }));
vi.mock('./components/TilingLayout', () => ({ TilingLayout: () => <div /> }));
vi.mock('./components/NewTaskDialog', () => ({ NewTaskDialog: () => <div /> }));
vi.mock('./components/HelpDialog', () => ({ HelpDialog: () => <div /> }));
vi.mock('./components/SettingsDialog', () => ({ SettingsDialog: () => <div /> }));
vi.mock('./components/WindowTitleBar', () => ({ WindowTitleBar: () => <div /> }));
vi.mock('./components/WindowResizeHandles', () => ({ WindowResizeHandles: () => <div /> }));
vi.mock('./arena/ArenaOverlay', () => ({ ArenaOverlay: () => <div /> }));
vi.mock('./components/PathInputDialog', () => ({ PathInputDialog: () => <div /> }));

import App from './App';

describe('desktop app intro', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.hasSeenDesktopIntro = false;
    displayNameDialogPropsRef.current = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('opens help once on first Electron launch and marks the intro as seen', () => {
    render(() => <App />);

    expect(setStoreMock).toHaveBeenCalledWith('hasSeenDesktopIntro', true);
    expect(toggleHelpDialogMock).toHaveBeenCalledWith(true);
  });

  it('does not reopen help when the intro has already been seen', () => {
    storeState.hasSeenDesktopIntro = true;

    render(() => <App />);

    expect(setStoreMock).not.toHaveBeenCalledWith('hasSeenDesktopIntro', true);
    expect(toggleHelpDialogMock).not.toHaveBeenCalledWith(true);
  });

  it('registers a browser session-name action that opens the edit dialog', async () => {
    isElectronRuntimeMock.mockReturnValue(false);

    render(() => <App />);

    expect(registerActionMock).toHaveBeenCalledWith(
      OPEN_DISPLAY_NAME_DIALOG_ACTION,
      expect.any(Function),
    );
    expect(displayNameDialogPropsRef.current?.open).toBe(false);

    const openDialog = registerActionMock.mock.calls[0]?.[1] as (() => void) | undefined;
    expect(openDialog).toBeTypeOf('function');
    openDialog?.();

    await waitFor(() => {
      expect(displayNameDialogPropsRef.current?.open).toBe(true);
      expect(displayNameDialogPropsRef.current?.allowClose).toBe(true);
      expect(displayNameDialogPropsRef.current?.confirmLabel).toBe('Save name');
      expect(displayNameDialogPropsRef.current?.title).toBe('Edit session name');
    });
  });
});
