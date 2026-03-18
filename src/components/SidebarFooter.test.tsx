import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_DISPLAY_NAME_DIALOG_ACTION } from '../app/app-action-keys';
import type { PeerPresenceSnapshot } from '../domain/server-state';

const {
  getRuntimeClientIdMock,
  getStoredDisplayNameMock,
  isElectronRuntimeMock,
  listPeerSessionsMock,
  triggerActionMock,
} = vi.hoisted(() => ({
  getRuntimeClientIdMock: vi.fn(() => 'browser-client'),
  getStoredDisplayNameMock: vi.fn<() => string | null>(() => null),
  isElectronRuntimeMock: vi.fn(),
  listPeerSessionsMock: vi.fn<() => PeerPresenceSnapshot[]>(() => []),
  triggerActionMock: vi.fn(),
}));

vi.mock('../lib/browser-auth', () => ({
  isElectronRuntime: isElectronRuntimeMock,
}));

vi.mock('../lib/runtime-client-id', () => ({
  getRuntimeClientId: getRuntimeClientIdMock,
}));

vi.mock('../lib/build-info', () => ({
  APP_BUILD_STAMP: '2026-03-13 15:30Z',
  APP_VERSION: '0.7.0',
}));

vi.mock('../lib/display-name', () => ({
  getStoredDisplayName: getStoredDisplayNameMock,
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    getCompletedTasksTodayCount: vi.fn(() => 0),
    getMergedLineTotals: vi.fn(() => ({ added: 0, removed: 0 })),
    listPeerSessions: listPeerSessionsMock,
    store: core.store,
    triggerAction: triggerActionMock,
    toggleArena: vi.fn(),
    toggleHelpDialog: vi.fn(),
  };
});

import { SidebarFooter } from './SidebarFooter';

describe('SidebarFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRuntimeClientIdMock.mockReturnValue('browser-client');
    getStoredDisplayNameMock.mockReturnValue(null);
    listPeerSessionsMock.mockReturnValue([]);
  });

  it('shows the browser build stamp outside Electron', () => {
    isElectronRuntimeMock.mockReturnValue(false);

    render(() => <SidebarFooter />);

    expect(screen.getByText('Merged to base branch')).toBeDefined();
    expect(screen.getByText('Web build 0.7.0 · 2026-03-13 15:30Z')).toBeDefined();
  });

  it('shows a persistent browser session name entry point', () => {
    isElectronRuntimeMock.mockReturnValue(false);
    listPeerSessionsMock.mockReturnValue([]);

    render(() => <SidebarFooter />);

    const button = screen.getByRole('button', { name: /Edit session name/i });
    expect(button).toBeDefined();
    expect(screen.getByText('Choose how other sessions see you')).toBeDefined();

    fireEvent.click(button);

    expect(triggerActionMock).toHaveBeenCalledWith(OPEN_DISPLAY_NAME_DIALOG_ACTION);
  });

  it('prefers the locally saved browser session name over peer-presence echo', () => {
    isElectronRuntimeMock.mockReturnValue(false);
    getStoredDisplayNameMock.mockReturnValue('Fresh Local Name');
    listPeerSessionsMock.mockReturnValue([
      {
        activeTaskId: 'task-1',
        clientId: 'browser-client',
        controllingAgentIds: [],
        controllingTaskIds: [],
        displayName: 'Stale Presence Name',
        focusedSurface: 'sidebar',
        lastSeenAt: Date.now(),
        visibility: 'visible',
      },
    ]);

    render(() => <SidebarFooter />);

    expect(screen.getByText('Fresh Local Name')).toBeDefined();
    expect(screen.queryByText('Stale Presence Name')).toBeNull();
  });

  it('hides the browser build stamp in Electron', () => {
    isElectronRuntimeMock.mockReturnValue(true);

    render(() => <SidebarFooter />);

    expect(screen.queryByText(/Web build 0\.7\.0/)).toBeNull();
    expect(screen.queryByText('Session')).toBeNull();
  });

  it('hides the sessions roster when no other sessions are joined', () => {
    isElectronRuntimeMock.mockReturnValue(false);
    listPeerSessionsMock.mockReturnValue([
      {
        activeTaskId: 'task-1',
        clientId: 'browser-client',
        controllingAgentIds: [],
        controllingTaskIds: [],
        displayName: 'You',
        focusedSurface: 'sidebar',
        lastSeenAt: Date.now(),
        visibility: 'visible',
      },
    ]);

    render(() => <SidebarFooter />);

    expect(screen.queryByText('Sessions')).toBeNull();
    expect(screen.queryByText('You (you)')).toBeNull();
  });

  it('shows compact session chips when another session is joined', () => {
    isElectronRuntimeMock.mockReturnValue(false);
    listPeerSessionsMock.mockReturnValue([
      {
        activeTaskId: 'task-1',
        clientId: 'browser-client',
        controllingAgentIds: [],
        controllingTaskIds: [],
        displayName: 'You',
        focusedSurface: 'sidebar',
        lastSeenAt: Date.now() - 20,
        visibility: 'visible',
      },
      {
        activeTaskId: 'task-1',
        clientId: 'peer-client',
        controllingAgentIds: [],
        controllingTaskIds: [],
        displayName: 'Ivan',
        focusedSurface: 'prompt',
        lastSeenAt: Date.now(),
        visibility: 'visible',
      },
    ]);

    render(() => <SidebarFooter />);

    expect(screen.getByText('Sessions')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('Ivan')).toBeDefined();
    expect(screen.getByText('You (you)')).toBeDefined();
  });

  it('limits the visible session chips and summarizes overflow', () => {
    isElectronRuntimeMock.mockReturnValue(false);
    const now = Date.now();
    listPeerSessionsMock.mockReturnValue([
      {
        activeTaskId: 'task-1',
        clientId: 'browser-client',
        controllingAgentIds: [],
        controllingTaskIds: [],
        displayName: 'You',
        focusedSurface: 'sidebar',
        lastSeenAt: now - 40,
        visibility: 'visible',
      },
      {
        activeTaskId: 'task-1',
        clientId: 'peer-1',
        controllingAgentIds: ['agent-1'],
        controllingTaskIds: ['task-1'],
        displayName: 'Ivan',
        focusedSurface: 'prompt',
        lastSeenAt: now - 10,
        visibility: 'visible',
      },
      {
        activeTaskId: 'task-2',
        clientId: 'peer-2',
        controllingAgentIds: [],
        controllingTaskIds: [],
        displayName: 'Sara',
        focusedSurface: 'terminal',
        lastSeenAt: now - 20,
        visibility: 'visible',
      },
      {
        activeTaskId: 'task-3',
        clientId: 'peer-3',
        controllingAgentIds: [],
        controllingTaskIds: [],
        displayName: 'Zed',
        focusedSurface: 'terminal',
        lastSeenAt: now - 30,
        visibility: 'visible',
      },
      {
        activeTaskId: null,
        clientId: 'peer-4',
        controllingAgentIds: [],
        controllingTaskIds: [],
        displayName: 'Mona',
        focusedSurface: null,
        lastSeenAt: now - 5,
        visibility: 'hidden',
      },
      {
        activeTaskId: 'task-4',
        clientId: 'peer-5',
        controllingAgentIds: [],
        controllingTaskIds: [],
        displayName: 'Neil',
        focusedSurface: 'sidebar',
        lastSeenAt: now - 35,
        visibility: 'visible',
      },
    ]);

    render(() => <SidebarFooter />);

    expect(screen.getByText('6')).toBeDefined();
    expect(screen.getByText('Ivan')).toBeDefined();
    expect(screen.getByText('Sara')).toBeDefined();
    expect(screen.getByText('Zed')).toBeDefined();
    expect(screen.queryByText('Neil')).toBeNull();
    expect(screen.queryByText('You (you)')).toBeNull();
    expect(screen.queryByText('Mona')).toBeNull();

    const sessionsSection = screen.getByText('Sessions').closest('div')?.parentElement;
    expect(sessionsSection).toBeTruthy();
    expect(
      within(sessionsSection as HTMLElement).getByText((_, element) => {
        return (
          element?.tagName === 'DIV' &&
          element.textContent === '5 online · 1 hidden · +3 more recent sessions'
        );
      }),
    ).toBeDefined();
  });
});
