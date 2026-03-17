import { render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerPresenceSnapshot } from '../domain/server-state';

const { getRuntimeClientIdMock, isElectronRuntimeMock, listPeerSessionsMock } = vi.hoisted(() => ({
  getRuntimeClientIdMock: vi.fn(() => 'browser-client'),
  isElectronRuntimeMock: vi.fn(),
  listPeerSessionsMock: vi.fn<() => PeerPresenceSnapshot[]>(() => []),
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
    getRuntimeClientIdMock.mockReturnValue('browser-client');
    listPeerSessionsMock.mockReturnValue([]);
  });

  it('shows the browser build stamp outside Electron', () => {
    isElectronRuntimeMock.mockReturnValue(false);

    render(() => <SidebarFooter />);

    expect(screen.getByText('Merged to base branch')).toBeDefined();
    expect(screen.getByText('Web build 0.7.0 · 2026-03-13 15:30Z')).toBeDefined();
  });

  it('hides the browser build stamp in Electron', () => {
    isElectronRuntimeMock.mockReturnValue(true);

    render(() => <SidebarFooter />);

    expect(screen.queryByText(/Web build 0\.7\.0/)).toBeNull();
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

  it('shows the sessions roster when another session is joined', () => {
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
    expect(screen.getByText('Ivan')).toBeDefined();
    expect(screen.getByText('You (you)')).toBeDefined();
  });
});
