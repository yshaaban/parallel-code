import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import type { TaskCommandTakeoverRequestMessage } from '../../electron/remote/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  clearIncomingRemoteTakeoverRequestMock,
  connectMock,
  createRemotePresenceRuntimeMock,
  getDefaultRemoteSessionNameMock,
  getIncomingRemoteTakeoverRequestsMock,
  getRemoteControllingTaskIdsMock,
  getStoredDisplayNameMock,
  respondToRemoteTaskCommandTakeoverMock,
  setStoredDisplayNameMock,
} = vi.hoisted(() => ({
  clearIncomingRemoteTakeoverRequestMock: vi.fn(),
  connectMock: vi.fn(),
  createRemotePresenceRuntimeMock: vi.fn(),
  getDefaultRemoteSessionNameMock: vi.fn(() => 'Mobile 1234'),
  getIncomingRemoteTakeoverRequestsMock: vi.fn<() => TaskCommandTakeoverRequestMessage[]>(() => []),
  getRemoteControllingTaskIdsMock: vi.fn(() => []),
  getStoredDisplayNameMock: vi.fn<() => string | null>(() => null),
  respondToRemoteTaskCommandTakeoverMock: vi.fn(async () => true),
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

vi.mock('./remote-collaboration', () => ({
  clearIncomingRemoteTakeoverRequest: clearIncomingRemoteTakeoverRequestMock,
  getIncomingRemoteTakeoverRequests: getIncomingRemoteTakeoverRequestsMock,
  getRemoteControllingTaskIds: getRemoteControllingTaskIdsMock,
}));

vi.mock('./remote-task-command', () => ({
  respondToRemoteTaskCommandTakeover: respondToRemoteTaskCommandTakeoverMock,
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
    getIncomingRemoteTakeoverRequestsMock.mockReturnValue([]);
    setStoredDisplayNameMock.mockImplementation((value: string) => value.trim());
    respondToRemoteTaskCommandTakeoverMock.mockResolvedValue(true);
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

  it('keeps takeover actions disabled until the matching request is cleared', async () => {
    getStoredDisplayNameMock.mockReturnValue('Already Named');
    getIncomingRemoteTakeoverRequestsMock.mockReturnValue([
      {
        action: 'type in the terminal',
        expiresAt: Date.now() + 10_000,
        requestId: 'request-1',
        requesterClientId: 'desktop-observer',
        requesterDisplayName: 'Desktop Observer',
        taskId: 'task-1',
        type: 'task-command-takeover-request',
      },
    ]);

    render(() => <App />);

    const allowButton = screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement;
    fireEvent.click(allowButton);

    await waitFor(() => {
      expect(respondToRemoteTaskCommandTakeoverMock).toHaveBeenCalledWith('request-1', true);
      expect(allowButton.disabled).toBe(true);
    });
  });
});
