import { cleanup, render } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  clearIncomingTaskTakeoverRequestMock,
  clearNotificationMock,
  expireIncomingTaskCommandTakeoverRequestMock,
  getGlobalScaleMock,
  isElectronRuntimeMock,
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
} = vi.hoisted(() => ({
  clearIncomingTaskTakeoverRequestMock: vi.fn(),
  clearNotificationMock: vi.fn(),
  expireIncomingTaskCommandTakeoverRequestMock: vi.fn(),
  getGlobalScaleMock: vi.fn(() => 1),
  isElectronRuntimeMock: vi.fn(() => true),
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
  setNewTaskDropUrl: setNewTaskDropUrlMock,
  store: storeState,
  toggleArena: toggleArenaMock,
  toggleHelpDialog: toggleHelpDialogMock,
  toggleNewTaskDialog: toggleNewTaskDialogMock,
  toggleSettingsDialog: toggleSettingsDialogMock,
  toggleSidebar: toggleSidebarMock,
}));

vi.mock('./components/ConfirmDialog', () => ({ ConfirmDialog: () => <div /> }));
vi.mock('./components/DisplayNameDialog', () => ({ DisplayNameDialog: () => <div /> }));
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
});
