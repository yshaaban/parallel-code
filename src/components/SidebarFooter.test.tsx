import { render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getBrowserClientIdMock, isElectronRuntimeMock } = vi.hoisted(() => ({
  getBrowserClientIdMock: vi.fn(() => 'browser-client'),
  isElectronRuntimeMock: vi.fn(),
}));

vi.mock('../lib/browser-auth', () => ({
  getBrowserClientId: getBrowserClientIdMock,
  isElectronRuntime: isElectronRuntimeMock,
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
    listPeerSessions: vi.fn(() => []),
    store: core.store,
    toggleArena: vi.fn(),
    toggleHelpDialog: vi.fn(),
  };
});

import { SidebarFooter } from './SidebarFooter';

describe('SidebarFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
