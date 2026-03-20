import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerPresenceSnapshot } from '../domain/server-state';
import { setStore } from '../store/core';
import { resetStoreForTest } from '../test/store-test-helpers';

const { getRuntimeClientIdMock, isElectronRuntimeMock, listPeerSessionsMock } = vi.hoisted(() => ({
  getRuntimeClientIdMock: vi.fn(() => 'browser-client'),
  isElectronRuntimeMock: vi.fn(),
  listPeerSessionsMock: vi.fn<() => PeerPresenceSnapshot[]>(() => []),
}));

vi.mock('../lib/browser-auth', async () => {
  const actual = await vi.importActual<typeof import('../lib/browser-auth')>('../lib/browser-auth');
  return {
    ...actual,
    isElectronRuntime: isElectronRuntimeMock,
  };
});

vi.mock('../lib/runtime-client-id', () => ({
  getRuntimeClientId: getRuntimeClientIdMock,
}));

vi.mock('../lib/build-info', () => ({
  APP_BUILD_STAMP: '2026-03-13 15:30Z',
  APP_VERSION: '0.7.0',
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    getCompletedTasksTodayCount: vi.fn(() => 0),
    getMergedLineTotals: vi.fn(() => ({ added: 0, removed: 0 })),
    listPeerSessions: listPeerSessionsMock,
    store: core.store,
    toggleArena: vi.fn(),
    toggleHelpDialog: vi.fn(),
  };
});

import { SidebarFooter } from './SidebarFooter';

describe('SidebarFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    getRuntimeClientIdMock.mockReturnValue('browser-client');
    listPeerSessionsMock.mockReturnValue([]);
  });

  it('keeps secondary sections collapsed by default', () => {
    isElectronRuntimeMock.mockReturnValue(false);

    render(() => <SidebarFooter />);

    expect(screen.getByText('Progress')).toBeDefined();
    expect(screen.getByText('Tips')).toBeDefined();
    expect(screen.queryByText('Merged to base branch')).toBeNull();
    expect(screen.queryByText('Web build 0.7.0 · 2026-03-13 15:30Z')).toBeNull();
  });

  it('shows the browser build stamp outside Electron after expanding tips', () => {
    isElectronRuntimeMock.mockReturnValue(false);

    render(() => <SidebarFooter />);

    fireEvent.click(screen.getByRole('button', { name: 'Tips' }));

    expect(screen.getByText('Web build 0.7.0 · 2026-03-13 15:30Z')).toBeDefined();
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

  it('shows a compact session preview when another session is joined', () => {
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

    expect(screen.getByText('Ivan')).toBeDefined();
    expect(screen.getByText('You (you)')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /^Sessions\b/ }));

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

    expect(screen.getByText('Ivan')).toBeDefined();
    expect(screen.getByText('Sara')).toBeDefined();
    expect(screen.getByText('+4')).toBeDefined();
    expect(screen.queryByText('Neil')).toBeNull();
    expect(screen.queryByText('You (you)')).toBeNull();
    expect(screen.queryByText('Mona')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Sessions\b/ }));

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

  it('persists footer collapse toggles through the shared store state', () => {
    isElectronRuntimeMock.mockReturnValue(false);
    setStore('sidebarSectionCollapsed', {
      projects: false,
      progress: false,
      sessions: true,
      tips: true,
    });

    render(() => <SidebarFooter />);

    expect(screen.getByText('Merged to base branch')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Progress' }));

    expect(screen.queryByText('Merged to base branch')).toBeNull();
  });
});
