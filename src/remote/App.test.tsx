import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  connectMock,
  createRemotePresenceRuntimeMock,
  getDefaultRemoteSessionNameMock,
  getStoredDisplayNameMock,
  setStoredDisplayNameMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  createRemotePresenceRuntimeMock: vi.fn(),
  getDefaultRemoteSessionNameMock: vi.fn(() => 'Mobile 1234'),
  getStoredDisplayNameMock: vi.fn<() => string | null>(() => null),
  setStoredDisplayNameMock: vi.fn((value: string) => value.trim()),
}));

vi.mock('../lib/display-name', () => ({
  getStoredDisplayName: getStoredDisplayNameMock,
  setStoredDisplayName: setStoredDisplayNameMock,
}));

vi.mock('./remote-presence', () => ({
  createRemotePresenceRuntime: createRemotePresenceRuntimeMock,
  getDefaultRemoteSessionName: getDefaultRemoteSessionNameMock,
}));

vi.mock('./auth', () => ({
  initAuth: vi.fn(),
}));

vi.mock('./ws', () => ({
  agents: () => [],
  authRequired: () => false,
  connect: connectMock,
  getRemoteClientId: () => 'remote-client-1234',
  status: () => 'connected',
}));

vi.mock('./AgentList', () => ({
  AgentList: (props: { onEditSessionName: () => void; sessionName: string }) => (
    <div>
      <span>{props.sessionName}</span>
      <button type="button" onClick={() => props.onEditSessionName()}>
        Rename session
      </button>
    </div>
  ),
}));

vi.mock('./AgentDetail', () => ({
  AgentDetail: () => <div>Agent detail</div>,
}));

import { App } from './App';

describe('remote App session naming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStoredDisplayNameMock.mockReturnValue(null);
    setStoredDisplayNameMock.mockImplementation((value: string) => value.trim());
  });

  afterEach(() => {
    cleanup();
  });

  it('prompts for a mobile session name on first launch and saves it', () => {
    render(() => <App />);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Name this mobile session' })).toBeDefined();

    const input = screen.getByLabelText('Session name') as HTMLInputElement;
    expect(input.value).toBe('Mobile 1234');

    fireEvent.input(input, { target: { value: 'Ivan phone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(setStoredDisplayNameMock).toHaveBeenCalledWith('Ivan phone');
    expect(screen.queryByRole('dialog', { name: 'Name this mobile session' })).toBeNull();
    expect(screen.getByText('Ivan phone')).toBeDefined();
  });

  it('skips the prompt when a stored display name already exists', () => {
    getStoredDisplayNameMock.mockReturnValue('Already Named');

    render(() => <App />);

    expect(screen.queryByRole('dialog', { name: 'Name this mobile session' })).toBeNull();
    expect(screen.getByText('Already Named')).toBeDefined();
  });
});
