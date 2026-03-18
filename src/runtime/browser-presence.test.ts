import { createRoot, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStoreForTest } from '../test/store-test-helpers';
import { setStore } from '../store/core';

const { authenticatedListenerRef, sendBrowserControlMessageMock, transportListeners } = vi.hoisted(
  () => ({
    authenticatedListenerRef: {
      current: null as (() => void) | null,
    },
    sendBrowserControlMessageMock: vi.fn().mockResolvedValue(undefined),
    transportListeners: new Set<
      (event: {
        kind: 'connection';
        state: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'auth-expired';
      }) => void
    >(),
  }),
);

vi.mock('../lib/ipc', () => ({
  onBrowserAuthenticated: vi.fn((listener: () => void) => {
    authenticatedListenerRef.current = listener;
    return () => {
      if (authenticatedListenerRef.current === listener) {
        authenticatedListenerRef.current = null;
      }
    };
  }),
  onBrowserTransportEvent: vi.fn(
    (
      listener: (event: {
        kind: 'connection';
        state: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'auth-expired';
      }) => void,
    ) => {
      transportListeners.add(listener);
      return () => {
        transportListeners.delete(listener);
      };
    },
  ),
  sendBrowserControlMessage: sendBrowserControlMessageMock,
}));

vi.mock('../lib/runtime-client-id', () => ({
  getRuntimeClientId: vi.fn(() => 'client-self'),
}));

import { createBrowserPresenceRuntime } from './browser-presence';

describe('browser presence runtime', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const documentListeners = new Map<string, EventListener>();
  let visibilityState: 'hidden' | 'visible' = 'visible';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetStoreForTest();
    setStore('activeTaskId', 'task-1');
    setStore('focusedPanel', 'task-1', 'prompt');
    visibilityState = 'visible';

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        addEventListener: vi.fn((event: string, listener: EventListener) => {
          documentListeners.set(event, listener);
        }),
        get visibilityState() {
          return visibilityState;
        },
        removeEventListener: vi.fn((event: string, listener: EventListener) => {
          if (documentListeners.get(event) === listener) {
            documentListeners.delete(event);
          }
        }),
      },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: globalThis,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    authenticatedListenerRef.current = null;
    documentListeners.clear();
    transportListeners.clear();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    resetStoreForTest();
  });

  async function flushMicrotasks(rounds = 4): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      await Promise.resolve();
    }
  }

  function emitTransportConnected(): void {
    for (const listener of transportListeners) {
      listener({
        kind: 'connection',
        state: 'connected',
      });
    }
  }

  it('refreshes visible presence periodically and stops heartbeats while hidden', async () => {
    const dispose = createRoot((rootDispose) => {
      const [displayName] = createSignal('Ivan');
      createBrowserPresenceRuntime({
        getDisplayName: displayName,
      });
      return rootDispose;
    });

    emitTransportConnected();
    await flushMicrotasks();
    expect(sendBrowserControlMessageMock).toHaveBeenCalledTimes(1);
    expect(sendBrowserControlMessageMock).toHaveBeenLastCalledWith({
      type: 'update-presence',
      activeTaskId: 'task-1',
      controllingAgentIds: [],
      controllingTaskIds: [],
      displayName: 'Ivan',
      focusedSurface: 'prompt',
      visibility: 'visible',
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();
    expect(sendBrowserControlMessageMock).toHaveBeenCalledTimes(2);

    visibilityState = 'hidden';
    documentListeners.get('visibilitychange')?.(new Event('visibilitychange'));
    await flushMicrotasks();

    expect(sendBrowserControlMessageMock).toHaveBeenCalledTimes(3);
    expect(sendBrowserControlMessageMock).toHaveBeenLastCalledWith({
      type: 'update-presence',
      activeTaskId: 'task-1',
      controllingAgentIds: [],
      controllingTaskIds: [],
      displayName: 'Ivan',
      focusedSurface: 'hidden',
      visibility: 'hidden',
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect(sendBrowserControlMessageMock).toHaveBeenCalledTimes(3);

    authenticatedListenerRef.current?.();
    await flushMicrotasks();
    expect(sendBrowserControlMessageMock).toHaveBeenCalledTimes(4);

    dispose();
  });

  it('retries the same presence payload on the next heartbeat after an async publish failure', async () => {
    sendBrowserControlMessageMock.mockRejectedValueOnce(new Error('socket unavailable'));

    const dispose = createRoot((rootDispose) => {
      const [displayName] = createSignal('Ivan');
      createBrowserPresenceRuntime({
        getDisplayName: displayName,
      });
      return rootDispose;
    });

    emitTransportConnected();
    await flushMicrotasks();
    expect(sendBrowserControlMessageMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();
    expect(sendBrowserControlMessageMock).toHaveBeenCalledTimes(2);

    dispose();
  });
});
