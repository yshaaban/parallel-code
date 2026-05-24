import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const {
  appWindowMock,
  chooseMock,
  invokeMock,
  saveStateMock,
  setWindowStateMock,
  storeState,
  unlistenCloseMock,
} = vi.hoisted(() => ({
  appWindowMock: {
    close: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    onCloseRequested: vi.fn().mockResolvedValue(vi.fn()),
    outerPosition: vi.fn().mockResolvedValue({ x: 12.4, y: 56.6 }),
    outerSize: vi.fn().mockResolvedValue({ height: 720.2, width: 1280.8 }),
  },
  chooseMock: vi.fn(),
  invokeMock: vi.fn(),
  saveStateMock: vi.fn().mockResolvedValue(undefined),
  setWindowStateMock: vi.fn(),
  storeState: {
    windowState: null as {
      height: number;
      maximized: boolean;
      width: number;
      x: number;
      y: number;
    } | null,
  },
  unlistenCloseMock: vi.fn(),
}));

vi.mock('../lib/dialog', () => ({
  choose: chooseMock,
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../lib/window', () => ({
  appWindow: appWindowMock,
}));

vi.mock('../store/persistence-save', () => ({
  saveState: saveStateMock,
}));

vi.mock('../store/state', () => ({
  store: storeState,
}));

vi.mock('../store/ui', () => ({
  setWindowState: setWindowStateMock,
}));

import { createWindowSessionRuntime } from './window-session';

type CloseRequestedHandler = (event: { preventDefault: () => void }) => Promise<void> | void;

function createRuntime(): ReturnType<typeof createWindowSessionRuntime> {
  return createWindowSessionRuntime({
    electronRuntime: true,
    isMac: false,
    setWindowFocused: vi.fn(),
    setWindowMaximized: vi.fn(),
  });
}

function mockRunningAgentCount(count: number): void {
  invokeMock.mockImplementation((channel: IPC) => {
    if (channel === IPC.CountRunningAgents) return Promise.resolve(count);
    if (channel === IPC.KillAllAgents) return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
}

async function triggerRegisteredCloseRequest(): Promise<{
  preventDefault: ReturnType<typeof vi.fn>;
}> {
  const handler = appWindowMock.onCloseRequested.mock.calls[0]?.[0] as
    | CloseRequestedHandler
    | undefined;
  expect(handler).toBeDefined();

  const event = {
    preventDefault: vi.fn(),
  };
  await handler?.(event);
  return event;
}

describe('window session close decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.windowState = null;
    appWindowMock.close.mockResolvedValue(undefined);
    appWindowMock.hide.mockResolvedValue(undefined);
    appWindowMock.isMaximized.mockResolvedValue(false);
    appWindowMock.onCloseRequested.mockResolvedValue(unlistenCloseMock);
    appWindowMock.outerPosition.mockResolvedValue({ x: 12.4, y: 56.6 });
    appWindowMock.outerSize.mockResolvedValue({ height: 720.2, width: 1280.8 });
    saveStateMock.mockResolvedValue(undefined);
  });

  it('kills running sessions and closes when the user chooses Kill & Quit', async () => {
    mockRunningAgentCount(2);
    chooseMock.mockResolvedValue(0);

    const unlisten = await createRuntime().registerCloseRequestedHandler();
    const event = await triggerRegisteredCloseRequest();

    expect(unlisten).toBe(unlistenCloseMock);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(saveStateMock).toHaveBeenCalledTimes(1);
    expect(chooseMock).toHaveBeenCalledWith(
      expect.stringContaining('2 running terminal sessions'),
      {
        cancelIndex: 2,
        choices: ['Kill & Quit', 'Keep in Background', 'Cancel'],
        defaultIndex: 1,
        kind: 'warning',
        title: 'Running Terminals',
      },
    );
    expect(invokeMock).toHaveBeenCalledWith(IPC.KillAllAgents);
    expect(appWindowMock.close).toHaveBeenCalledTimes(1);
    expect(appWindowMock.hide).not.toHaveBeenCalled();
  });

  it('hides the window when the user chooses Keep in Background', async () => {
    mockRunningAgentCount(1);
    chooseMock.mockResolvedValue(1);

    await createRuntime().registerCloseRequestedHandler();
    const event = await triggerRegisteredCloseRequest();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(chooseMock).toHaveBeenCalledWith(
      expect.stringContaining('1 running terminal session'),
      expect.objectContaining({ defaultIndex: 1 }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.KillAllAgents);
    expect(appWindowMock.hide).toHaveBeenCalledTimes(1);
    expect(appWindowMock.close).not.toHaveBeenCalled();
  });

  it('leaves the close request prevented when the user chooses Cancel', async () => {
    mockRunningAgentCount(3);
    chooseMock.mockResolvedValue(2);

    await createRuntime().registerCloseRequestedHandler();
    const event = await triggerRegisteredCloseRequest();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.KillAllAgents);
    expect(appWindowMock.hide).not.toHaveBeenCalled();
    expect(appWindowMock.close).not.toHaveBeenCalled();
  });

  it('defaults to cancel when the running-session choice dialog fails', async () => {
    mockRunningAgentCount(3);
    chooseMock.mockRejectedValue(new Error('dialog failed'));

    await createRuntime().registerCloseRequestedHandler();
    const event = await triggerRegisteredCloseRequest();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.KillAllAgents);
    expect(appWindowMock.hide).not.toHaveBeenCalled();
    expect(appWindowMock.close).not.toHaveBeenCalled();
  });

  it('does not prevent or choose when no sessions are running', async () => {
    mockRunningAgentCount(0);

    await createRuntime().registerCloseRequestedHandler();
    const event = await triggerRegisteredCloseRequest();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(chooseMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith(IPC.CountRunningAgents);
    expect(invokeMock).not.toHaveBeenCalledWith(IPC.KillAllAgents);
    expect(appWindowMock.hide).not.toHaveBeenCalled();
    expect(appWindowMock.close).not.toHaveBeenCalled();
  });
});
