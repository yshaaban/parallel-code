import { cleanup, render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock('./ws', () => ({
  send: sendMock,
}));

import { createRemotePresenceRuntime, getDefaultRemoteSessionName } from './remote-presence';

describe('remote presence runtime', () => {
  let visibilityState: 'hidden' | 'visible' = 'visible';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    visibilityState = 'visible';

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get() {
        return visibilityState;
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('publishes connected remote presence and heartbeats with focused surface state', async () => {
    const [displayName] = createSignal('Mobile A1B2');
    const [connectionStatus] = createSignal<'connected' | 'disconnected'>('connected');
    const [activeTaskId] = createSignal<string | null>('task-1');
    const [focusedSurface] = createSignal<string | null>('remote-terminal');

    render(() => {
      createRemotePresenceRuntime({
        getActiveTaskId: activeTaskId,
        getConnectionStatus: connectionStatus,
        getDisplayName: displayName,
        getFocusedSurface: focusedSurface,
      });
      return null;
    });

    await Promise.resolve();
    expect(sendMock).toHaveBeenCalledWith({
      type: 'update-presence',
      activeTaskId: 'task-1',
      controllingAgentIds: [],
      controllingTaskIds: [],
      displayName: 'Mobile A1B2',
      focusedSurface: 'remote-terminal',
      visibility: 'visible',
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendMock).toHaveBeenCalledTimes(2);

    visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendMock).toHaveBeenLastCalledWith({
      type: 'update-presence',
      activeTaskId: 'task-1',
      controllingAgentIds: [],
      controllingTaskIds: [],
      displayName: 'Mobile A1B2',
      focusedSurface: 'hidden',
      visibility: 'hidden',
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it('republishes presence when the mobile session name changes', async () => {
    const [displayName, setDisplayName] = createSignal('Mobile A1B2');
    const [connectionStatus] = createSignal<'connected' | 'disconnected'>('connected');
    const [activeTaskId] = createSignal<string | null>('task-1');
    const [focusedSurface] = createSignal<string | null>('remote-list');

    render(() => {
      createRemotePresenceRuntime({
        getActiveTaskId: activeTaskId,
        getConnectionStatus: connectionStatus,
        getDisplayName: displayName,
        getFocusedSurface: focusedSurface,
      });
      return null;
    });

    await Promise.resolve();
    sendMock.mockClear();

    setDisplayName('Ivan phone');
    await Promise.resolve();

    expect(sendMock).toHaveBeenCalledWith({
      type: 'update-presence',
      activeTaskId: 'task-1',
      controllingAgentIds: [],
      controllingTaskIds: [],
      displayName: 'Ivan phone',
      focusedSurface: 'remote-list',
      visibility: 'visible',
    });
  });

  it('derives a mobile-oriented default session name', () => {
    expect(getDefaultRemoteSessionName('remote-client-1234')).toBe('Mobile 1234');
  });
});
