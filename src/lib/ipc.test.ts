import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { BROWSER_CLIENT_ID_HEADER } from '../domain/browser-ipc';
import type { PauseReason } from '../domain/server-state';
import {
  createBrowserChannelClient,
  getBrowserChannelMessageTiming,
  parseBrowserBinaryChannelFrame,
} from './browser-channel-client';

const CHANNEL_DATA_FRAME_TYPE = 0x01;

function createBinaryFrame(channelId: string, data = 'hello'): ArrayBuffer {
  const channelBytes = new TextEncoder().encode(channelId);
  const payloadBytes = new TextEncoder().encode(data);
  const frame = new Uint8Array(1 + channelBytes.length + payloadBytes.length);
  frame[0] = CHANNEL_DATA_FRAME_TYPE;
  frame.set(channelBytes, 1);
  frame.set(payloadBytes, 1 + channelBytes.length);
  return frame.buffer;
}

describe('parseBrowserBinaryChannelFrame', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('parses valid UUID channel frames', async () => {
    const parsed = parseBrowserBinaryChannelFrame(
      createBinaryFrame('12345678-1234-1234-1234-123456789012', 'hello'),
    );

    expect(parsed?.channelId).toBe('12345678-1234-1234-1234-123456789012');
    expect(new TextDecoder().decode(parsed?.data)).toBe('hello');
  });

  it('ignores short frames', async () => {
    expect(parseBrowserBinaryChannelFrame(new Uint8Array([CHANNEL_DATA_FRAME_TYPE]).buffer)).toBe(
      null,
    );
  });

  it('warns and ignores malformed channel headers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(
      parseBrowserBinaryChannelFrame(createBinaryFrame('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')),
    ).toBe(null);
    expect(warn).toHaveBeenCalledWith('[ipc] Ignoring malformed channel frame header');
  });

  it('records browser channel binary receive timing before listener dispatch', async () => {
    const client = createBrowserChannelClient({
      sendCommand: vi.fn(async () => {}),
    });
    const channel = client.createChannel<{ data: Uint8Array; type: 'Data' }>();
    client.handleChannelBound(channel.id);
    let capturedTiming: ReturnType<typeof getBrowserChannelMessageTiming> = null;

    channel.setOnMessage((message) => {
      capturedTiming = getBrowserChannelMessageTiming(message);
    });

    client.handleBinaryMessage(createBinaryFrame(channel.id, 'hello'));

    expect(capturedTiming).toEqual(
      expect.objectContaining({
        receivedAtMs: expect.any(Number),
      }),
    );

    channel.cleanup();
  });
});

describe('Channel', () => {
  const storage = new Map<string, string>();
  const sessionStorageData = new Map<string, string>();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;

  class FailingWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    binaryType: BinaryType = 'blob';
    onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
    onmessage:
      | ((this: WebSocket, ev: MessageEvent<string | ArrayBuffer | Blob>) => unknown)
      | null = null;
    onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
    onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
    readyState = FailingWebSocket.CONNECTING;

    constructor(_url: string) {
      queueMicrotask(() => {
        this.readyState = FailingWebSocket.CLOSED;
        this.onerror?.call(this.asWebSocket(), {} as Event);
        this.onclose?.call(this.asWebSocket(), { code: 1006 } as CloseEvent);
      });
    }

    close(): void {
      this.readyState = FailingWebSocket.CLOSED;
    }

    private asWebSocket(): WebSocket {
      return this as unknown as WebSocket;
    }

    send(): void {}
  }

  class ControllableWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: ControllableWebSocket[] = [];

    binaryType: BinaryType = 'blob';
    onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
    onmessage:
      | ((this: WebSocket, ev: MessageEvent<string | ArrayBuffer | Blob>) => unknown)
      | null = null;
    onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
    onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
    readyState = ControllableWebSocket.CONNECTING;
    sent: Array<Record<string, unknown>> = [];

    constructor(_url: string) {
      ControllableWebSocket.instances.push(this);
    }

    static reset(): void {
      ControllableWebSocket.instances = [];
    }

    open(): void {
      this.readyState = ControllableWebSocket.OPEN;
      this.onopen?.call(this.asWebSocket(), {} as Event);
    }

    close(code = 1000): void {
      this.readyState = ControllableWebSocket.CLOSED;
      this.onclose?.call(this.asWebSocket(), { code } as CloseEvent);
    }

    send(payload: string): void {
      this.sent.push(JSON.parse(payload) as Record<string, unknown>);
    }

    receiveText(message: unknown): void {
      this.onmessage?.call(this.asWebSocket(), {
        data: JSON.stringify(message),
      } as MessageEvent<string>);
    }

    receiveBinary(buffer: ArrayBuffer): void {
      this.onmessage?.call(this.asWebSocket(), {
        data: buffer,
      } as MessageEvent<ArrayBuffer>);
    }

    private asWebSocket(): WebSocket {
      return this as unknown as WebSocket;
    }
  }

  async function flushMicrotasks(rounds = 4): Promise<void> {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  }

  function bindFakeWindowTimers(): void {
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
  }

  async function flushQueuedBrowserHttpDrainTick(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
  }

  async function getPromiseState(
    promise: Promise<unknown>,
  ): Promise<'resolved' | 'rejected' | 'pending'> {
    return Promise.race([
      promise.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'pending'>((resolve) => {
        queueMicrotask(() => resolve('pending'));
      }),
    ]);
  }

  function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  } {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    return { promise, resolve, reject };
  }

  function receiveAcceptedAgentCommandResult(
    socket: ControllableWebSocket,
    message: Record<string, unknown> | undefined,
  ): void {
    const requestId = typeof message?.requestId === 'string' ? message.requestId : null;
    const agentId = typeof message?.agentId === 'string' ? message.agentId : 'agent-1';
    const command =
      message?.type === 'pause' || message?.type === 'resize' || message?.type === 'resume'
        ? message.type
        : 'input';
    if (!requestId) {
      throw new Error('Expected agent command requestId');
    }

    socket.receiveText({
      accepted: true,
      agentId,
      command,
      requestId,
      type: 'agent-command-result',
    });
  }

  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
    ControllableWebSocket.reset();
    storage.clear();
    sessionStorageData.clear();
    storage.set('parallel-code-token', 'test-token');

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: new URL('http://localhost/terminal'),
        history: { replaceState: vi.fn() },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        setTimeout,
        clearTimeout,
        electron: undefined,
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        hidden: false,
      },
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          storage.delete(key);
        }),
      },
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => sessionStorageData.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          sessionStorageData.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          sessionStorageData.delete(key);
        }),
      },
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FailingWebSocket,
    });
  });

  afterEach(async () => {
    const {
      assertBrowserAgentCommandRequestStateCleanForTests,
      resetBrowserAgentCommandRequestStateForTests,
      resetBrowserTransportStateForTests,
    } = await import('./ipc');

    try {
      assertBrowserAgentCommandRequestStateCleanForTests();
    } finally {
      resetBrowserTransportStateForTests();
      resetBrowserAgentCommandRequestStateForTests();
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      });
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: originalSessionStorage,
      });
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        value: originalWebSocket,
      });
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNavigator,
      });
    }
  });

  it('keeps ready pending when the initial bind send fails', async () => {
    const { Channel } = await import('./ipc');
    const channel = new Channel<unknown>();
    await flushMicrotasks();

    expect(await getPromiseState(channel.ready)).toBe('pending');

    channel.dispose();
    await expect(channel.ready).rejects.toThrow('Channel cleaned up');
  });

  it('settles pending browser transport work and unbinds lifecycle listeners during reset', async () => {
    vi.useFakeTimers();
    bindFakeWindowTimers();
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { Channel, invoke, onBrowserTransportEvent, resetBrowserTransportStateForTests } =
      await import('./ipc');
    const cleanup = onBrowserTransportEvent(() => {});
    const channel = new Channel<unknown>();
    const request = invoke(IPC.CheckPathExists, { path: '/repo/task-1' });
    await flushMicrotasks();

    expect(await getPromiseState(channel.ready)).toBe('pending');
    expect(await getPromiseState(request)).toBe('pending');

    resetBrowserTransportStateForTests();

    await expect(channel.ready).rejects.toThrow('Browser channel client reset for tests');
    await expect(request).rejects.toThrow('Browser HTTP IPC client reset for tests');
    expect(window.removeEventListener).toHaveBeenCalledWith('online', expect.any(Function));
    expect(window.removeEventListener).toHaveBeenCalledWith('pageshow', expect.any(Function));
    expect(document.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
    cleanup();
  });

  it('ignores browser HTTP IPC work that completes after transport reset', async () => {
    const deferredResponse = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(deferredResponse.promise);
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke, resetBrowserTransportStateForTests } = await import('./ipc');
    const request = invoke(IPC.CheckPathExists, { path: '/repo/task-1' });
    await flushMicrotasks();

    resetBrowserTransportStateForTests();

    deferredResponse.resolve(
      new Response(JSON.stringify({ result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(request).rejects.toThrow('Browser HTTP IPC client reset for tests');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts browser HTTP IPC response drains during transport reset', async () => {
    const deferredBody = createDeferred<unknown>();
    const capturedRequest: { signal: AbortSignal | null } = { signal: null };
    const response = {
      json: vi.fn(() => deferredBody.promise),
      ok: true,
      status: 200,
    } as unknown as Response;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      capturedRequest.signal = init?.signal ?? null;
      return Promise.resolve(response);
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke, resetBrowserTransportStateForTests } = await import('./ipc');
    const request = invoke(IPC.CheckPathExists, { path: '/repo/task-1' });
    await flushMicrotasks();

    expect(response.json).toHaveBeenCalledTimes(1);

    resetBrowserTransportStateForTests();
    expect(capturedRequest.signal?.aborted).toBe(true);

    deferredBody.resolve({ result: true });
    await expect(request).rejects.toThrow('Browser HTTP IPC client reset for tests');
  });

  it('cancels signal-aware browser HTTP IPC without adding reconnect queue work', async () => {
    const capturedRequest: { signal: AbortSignal | null } = { signal: null };
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      capturedRequest.signal = init?.signal ?? null;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });
    const cancellation = new Error('startup acquisition cancelled');
    const controller = new AbortController();
    const { getBrowserQueueDepth, invokeWithAbortSignal } = await import('./ipc');
    const request = invokeWithAbortSignal(IPC.LoadWorkspaceState, controller.signal);
    await flushMicrotasks();

    controller.abort(cancellation);

    await expect(request).rejects.toBe(cancellation);
    expect(capturedRequest.signal?.aborted).toBe(true);
    expect(getBrowserQueueDepth()).toBe(0);
  });

  it('invalidates in-flight browser HTTP IPC work when auth expires', async () => {
    const deferredResponse = createDeferred<Response>();
    const capturedRequest: { signal: AbortSignal | null } = { signal: null };
    let fetchCallCount = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        capturedRequest.signal = init?.signal ?? null;
        return deferredResponse.promise;
      }

      return Promise.resolve(
        new Response(JSON.stringify({ error: 'expired session' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke } = await import('./ipc');
    const firstRequest = invoke(IPC.CheckPathExists, { path: '/repo/task-1' });
    await flushMicrotasks();

    await expect(invoke(IPC.LoadAppState)).rejects.toThrow('expired session');
    expect(capturedRequest.signal?.aborted).toBe(true);

    deferredResponse.resolve(
      new Response(JSON.stringify({ result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(firstRequest).rejects.toThrow('expired session');
  });

  it('keeps module-owned browser transport hooks after transport reset', async () => {
    vi.useFakeTimers();
    bindFakeWindowTimers();
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { Channel, resetBrowserTransportStateForTests } = await import('./ipc');
    resetBrowserTransportStateForTests();
    ControllableWebSocket.reset();

    const channel = new Channel<{ type: string; data: Uint8Array }>();
    void channel.ready.catch(() => {});
    const firstSocket = ControllableWebSocket.instances[0];
    firstSocket?.open();
    await flushMicrotasks();

    expect(
      firstSocket?.sent.some(
        (message) => message.type === 'bind-channel' && message.channelId === channel.id,
      ),
    ).toBe(true);

    firstSocket?.close(1006);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(240);

    const secondSocket = ControllableWebSocket.instances[1];
    secondSocket?.open();
    await flushMicrotasks();

    expect(
      secondSocket?.sent.some(
        (message) => message.type === 'bind-channel' && message.channelId === channel.id,
      ),
    ).toBe(true);

    channel.dispose();
    secondSocket?.close();
  });

  it('disposes channel listeners and cleanup state explicitly', async () => {
    const { Channel } = await import('./ipc');
    const channel = new Channel<unknown>();
    void channel.ready.catch(() => {});
    const cleanup = vi.fn();
    const onmessage = vi.fn();

    channel.cleanup = cleanup;
    channel.onmessage = onmessage;

    channel.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(channel.cleanup).toBeNull();
    expect(channel.onmessage).toBeNull();
    expect(() => channel.dispose()).not.toThrow();
  });

  it('does not require a stored auth token for browser channels', async () => {
    storage.delete('parallel-code-token');
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });
    const { Channel } = await import('./ipc');
    const channel = new Channel<unknown>();
    void channel.ready.catch(() => {});

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    expect(socket.sent.some((message) => message.type === 'auth')).toBe(false);
    expect(
      socket.sent.some(
        (message) => message.type === 'bind-channel' && message.channelId === channel.id,
      ),
    ).toBe(true);
    channel.dispose();
    socket.close();
  });

  it('rejects pending ready when the server closes with auth-expired', async () => {
    class AuthExpiredWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      binaryType: BinaryType = 'blob';
      onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
      onmessage:
        | ((this: WebSocket, ev: MessageEvent<string | ArrayBuffer | Blob>) => unknown)
        | null = null;
      onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
      onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
      readyState = AuthExpiredWebSocket.CONNECTING;

      constructor(_url: string) {
        queueMicrotask(() => {
          this.readyState = AuthExpiredWebSocket.OPEN;
          this.onopen?.call(this.asWebSocket(), {} as Event);
          queueMicrotask(() => {
            this.readyState = AuthExpiredWebSocket.CLOSED;
            this.onclose?.call(this.asWebSocket(), { code: 4001 } as CloseEvent);
          });
        });
      }

      close(): void {
        this.readyState = AuthExpiredWebSocket.CLOSED;
      }

      private asWebSocket(): WebSocket {
        return this as unknown as WebSocket;
      }

      send(): void {}
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: AuthExpiredWebSocket,
    });

    const { Channel } = await import('./ipc');
    const channel = new Channel<unknown>();

    await expect(channel.ready).rejects.toThrow('Browser session expired');
    channel.dispose();
  });

  it('rejects pending ready when an HTTP request expires browser auth', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Session expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });

    const { Channel, invoke } = await import('./ipc');
    const channel = new Channel<unknown>();

    await expect(invoke(IPC.LoadAppState)).rejects.toThrow('Session expired');
    await expect(channel.ready).rejects.toThrow('Session expired');
    channel.dispose();
  });

  it('rebinds channels after reconnect and dispatches binary messages on the new socket', async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    try {
      const { Channel } = await import('./ipc');
      const channel = new Channel<{ type: string; data: Uint8Array }>();
      const received: Array<{ type: string; data: Uint8Array }> = [];
      channel.onmessage = (message) => {
        received.push(message);
      };

      expect(ControllableWebSocket.instances).toHaveLength(1);
      const firstSocket = ControllableWebSocket.instances[0];
      firstSocket.open();
      await flushMicrotasks();
      firstSocket.receiveText({ type: 'agents', list: [] });
      await flushMicrotasks();

      expect(
        firstSocket.sent.some(
          (message) => message.type === 'bind-channel' && message.channelId === channel.id,
        ),
      ).toBe(true);

      firstSocket.receiveText({ type: 'channel-bound', channelId: channel.id });
      await expect(channel.ready).resolves.toBeUndefined();

      firstSocket.close(1006);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(240);

      expect(ControllableWebSocket.instances).toHaveLength(2);
      const secondSocket = ControllableWebSocket.instances[1];
      secondSocket.open();
      await flushMicrotasks();
      secondSocket.receiveText({ type: 'agents', list: [] });
      await flushMicrotasks();

      expect(
        secondSocket.sent.some(
          (message) => message.type === 'bind-channel' && message.channelId === channel.id,
        ),
      ).toBe(true);

      secondSocket.receiveBinary(createBinaryFrame(channel.id, 'reconnected'));
      await flushMicrotasks();

      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe('Data');
      expect(new TextDecoder().decode(received[0]?.data)).toBe('reconnected');

      channel.dispose();
      secondSocket.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid pause reasons instead of silently downgrading them', async () => {
    const { invoke } = await import('./ipc');

    await expect(
      invoke(IPC.PauseAgent, {
        agentId: 'agent-1',
        reason: 'restore ' as unknown as PauseReason,
      }),
    ).rejects.toThrow('Invalid pause reason');
    await expect(
      invoke(IPC.ResumeAgent, {
        agentId: 'agent-1',
        reason: 'restore ' as unknown as PauseReason,
      }),
    ).rejects.toThrow('Invalid pause reason');
  });

  it('does not queue flow-control commands while the browser socket is unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke, getBrowserQueueDepth } = await import('./ipc');

    await expect(
      invoke(IPC.PauseAgent, {
        agentId: 'agent-1',
        reason: 'flow-control',
        channelId: 'channel-1',
      }),
    ).rejects.toThrow('Browser socket unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getBrowserQueueDepth()).toBe(0);
  });

  it('keeps flow-control pause and resume fire-and-forget on the websocket control plane', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { invoke } = await import('./ipc');
    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();

    await invoke(IPC.PauseAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'flow-control',
    });
    await invoke(IPC.ResumeAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'flow-control',
    });

    expect(socket.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: 'agent-1',
          channelId: 'channel-1',
          reason: 'flow-control',
          type: 'pause',
        }),
        expect.objectContaining({
          agentId: 'agent-1',
          channelId: 'channel-1',
          reason: 'flow-control',
          type: 'resume',
        }),
      ]),
    );
    expect(
      socket.sent
        .filter((message) => message.reason === 'flow-control')
        .every((message) => !('requestId' in message)),
    ).toBe(true);
  });

  it('routes restore pause and resume leases over the websocket control plane', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { invoke } = await import('./ipc');
    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();

    const pausePromise = invoke(IPC.PauseAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'restore',
      restoreLeaseId: 'restore-lease-1',
    });
    await flushMicrotasks();
    receiveAcceptedAgentCommandResult(socket, socket.sent.at(-1));
    await pausePromise;

    const resumePromise = invoke(IPC.ResumeAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'restore',
      restoreLeaseId: 'restore-lease-1',
    });
    await flushMicrotasks();
    receiveAcceptedAgentCommandResult(socket, socket.sent.at(-1));
    await resumePromise;

    expect(socket.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: 'agent-1',
          channelId: 'channel-1',
          reason: 'restore',
          requestId: expect.any(String),
          restoreLeaseId: 'restore-lease-1',
          type: 'pause',
        }),
        expect.objectContaining({
          agentId: 'agent-1',
          channelId: 'channel-1',
          reason: 'restore',
          requestId: expect.any(String),
          restoreLeaseId: 'restore-lease-1',
          type: 'resume',
        }),
      ]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes browser task-command lease acquire, renew, and release over the websocket control plane', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { invoke } = await import('./ipc');
    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();

    const acquireRequest = invoke(IPC.AcquireTaskCommandLease, {
      action: 'type in the terminal',
      clientId: 'spoofed-client',
      ownerId: 'owner-1',
      taskId: 'task-1',
    });
    await flushMicrotasks();

    const acquireMessage = socket.sent.find((message) => message.type === 'task-command-lease');
    if (!acquireMessage || typeof acquireMessage.requestId !== 'string') {
      throw new Error('Expected task-command lease acquire request');
    }
    expect(acquireMessage).toEqual(
      expect.objectContaining({
        action: 'type in the terminal',
        operation: 'acquire',
        ownerId: 'owner-1',
        taskId: 'task-1',
      }),
    );
    expect(acquireMessage).not.toHaveProperty('clientId');

    socket.receiveText({
      type: 'task-command-lease-result',
      operation: 'acquire',
      requestId: acquireMessage.requestId,
      result: {
        acquired: true,
        action: 'type in the terminal',
        controllerId: 'server-client',
        leaseGeneration: 1,
        taskId: 'task-1',
        version: 1,
      },
    });

    await expect(acquireRequest).resolves.toEqual({
      acquired: true,
      action: 'type in the terminal',
      controllerId: 'server-client',
      leaseGeneration: 1,
      taskId: 'task-1',
      version: 1,
    });

    const renewRequest = invoke(IPC.RenewTaskCommandLease, {
      clientId: 'spoofed-client',
      leaseGeneration: 1,
      ownerId: 'owner-1',
      taskId: 'task-1',
    });
    await flushMicrotasks();

    const renewMessage = socket.sent.find((message) => message.operation === 'renew');
    if (!renewMessage || typeof renewMessage.requestId !== 'string') {
      throw new Error('Expected task-command lease renew request');
    }
    expect(renewMessage).toEqual(
      expect.objectContaining({
        leaseGeneration: 1,
        operation: 'renew',
        ownerId: 'owner-1',
        taskId: 'task-1',
      }),
    );
    expect(renewMessage).not.toHaveProperty('clientId');

    socket.receiveText({
      type: 'task-command-lease-result',
      operation: 'renew',
      requestId: renewMessage.requestId,
      result: {
        action: 'type in the terminal',
        controllerId: 'server-client',
        leaseGeneration: 1,
        renewed: true,
        taskId: 'task-1',
        version: 1,
      },
    });

    await expect(renewRequest).resolves.toEqual({
      action: 'type in the terminal',
      controllerId: 'server-client',
      leaseGeneration: 1,
      renewed: true,
      taskId: 'task-1',
      version: 1,
    });

    const releaseRequest = invoke(IPC.ReleaseTaskCommandLease, {
      clientId: 'spoofed-client',
      leaseGeneration: 1,
      ownerId: 'owner-1',
      taskId: 'task-1',
    });
    await flushMicrotasks();

    const releaseMessage = socket.sent.find((message) => message.operation === 'release');
    if (!releaseMessage || typeof releaseMessage.requestId !== 'string') {
      throw new Error('Expected task-command lease release request');
    }
    expect(releaseMessage).toEqual(
      expect.objectContaining({
        leaseGeneration: 1,
        operation: 'release',
        ownerId: 'owner-1',
        taskId: 'task-1',
      }),
    );
    expect(releaseMessage).not.toHaveProperty('clientId');

    socket.receiveText({
      type: 'task-command-lease-result',
      operation: 'release',
      requestId: releaseMessage.requestId,
      result: {
        action: null,
        controllerId: null,
        taskId: 'task-1',
        version: 2,
      },
    });

    await expect(releaseRequest).resolves.toEqual({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 2,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps unsent browser task-command lease requests pending across reconnect', async () => {
    vi.useFakeTimers();
    bindFakeWindowTimers();
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { invoke } = await import('./ipc');
    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];

    const acquireRequest = invoke(IPC.AcquireTaskCommandLease, {
      action: 'type in the terminal',
      clientId: 'client-1',
      ownerId: 'owner-1',
      taskId: 'task-1',
    });
    await flushMicrotasks();
    expect(socket.sent.filter((message) => message.type === 'task-command-lease')).toEqual([]);

    socket.close(1006);
    await flushMicrotasks();

    expect(await getPromiseState(acquireRequest)).toBe('pending');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(ControllableWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const reconnectSocket = ControllableWebSocket.instances[1];
    reconnectSocket.open();
    await flushMicrotasks();

    const acquireMessage = reconnectSocket.sent.find(
      (message) => message.type === 'task-command-lease',
    );
    if (!acquireMessage || typeof acquireMessage.requestId !== 'string') {
      throw new Error('Expected retried task-command lease request');
    }
    expect(acquireMessage).toEqual(
      expect.objectContaining({
        action: 'type in the terminal',
        operation: 'acquire',
        ownerId: 'owner-1',
        taskId: 'task-1',
      }),
    );

    reconnectSocket.receiveText({
      type: 'task-command-lease-result',
      operation: 'acquire',
      requestId: acquireMessage.requestId,
      result: {
        acquired: true,
        action: 'type in the terminal',
        controllerId: 'client-1',
        leaseGeneration: 1,
        taskId: 'task-1',
        version: 1,
      },
    });

    await expect(acquireRequest).resolves.toEqual({
      acquired: true,
      action: 'type in the terminal',
      controllerId: 'client-1',
      leaseGeneration: 1,
      taskId: 'task-1',
      version: 1,
    });
  });

  it('sends pagehide task-command lease release through keepalive fetch with browser identity', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const sendBeaconMock = vi.fn(() => true);
    sessionStorageData.set('parallel-code-client-id', 'client-1');
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        sendBeacon: sendBeaconMock,
      },
    });

    const { sendPagehideInvoke } = await import('./ipc');

    sendPagehideInvoke(IPC.ReleaseTaskCommandLease, {
      clientId: 'spoofed-client',
      leaseGeneration: 1,
      ownerId: 'owner-1',
      taskId: 'task-1',
    });
    await flushMicrotasks();

    expect(sendBeaconMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ipc/release_task_command_lease',
      expect.objectContaining({
        keepalive: true,
        headers: expect.objectContaining({
          [BROWSER_CLIENT_ID_HEADER]: 'client-1',
        }),
      }),
    );
  });

  it('chunks large browser write_to_agent payloads instead of sending oversized input frames', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { MAX_CLIENT_INPUT_DATA_LENGTH } = await import('../../electron/remote/protocol');
    const { invoke } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();

    const data = 'x'.repeat(MAX_CLIENT_INPUT_DATA_LENGTH + 512);
    const writePromise = invoke(IPC.WriteToAgent, { agentId: 'agent-1', data });

    await flushMicrotasks();
    const firstInputMessage = socket.sent.find((message) => message.type === 'input');
    receiveAcceptedAgentCommandResult(socket, firstInputMessage);
    await flushMicrotasks();

    const inputMessages = socket.sent.filter((message) => message.type === 'input');
    receiveAcceptedAgentCommandResult(socket, inputMessages[1]);
    await expect(writePromise).resolves.toBeUndefined();

    expect(inputMessages).toHaveLength(2);
    expect(inputMessages[0]?.data).toHaveLength(MAX_CLIENT_INPUT_DATA_LENGTH);
    expect(inputMessages[1]?.data).toHaveLength(512);
    expect(inputMessages.map((message) => message.data).join('')).toBe(data);
  });

  it('chunks large Electron terminal input with matching ordered sequence tokens', async () => {
    const { MAX_CLIENT_INPUT_DATA_LENGTH } = await import('../../electron/remote/protocol');
    const invokeMock = vi.fn<(channel: IPC, args?: unknown) => Promise<unknown>>(
      async () => undefined,
    );
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: new URL('http://localhost/terminal'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        setTimeout,
        clearTimeout,
        electron: {
          ipcRenderer: {
            invoke: invokeMock,
            on: vi.fn(),
            removeAllListeners: vi.fn(),
          },
        },
      },
    });

    const { sendTerminalInput } = await import('./ipc');
    const data = 'x'.repeat(MAX_CLIENT_INPUT_DATA_LENGTH + 512);
    const trace = {
      bufferedAtMs: 100,
      inputChars: data.length,
      inputKind: 'paste' as const,
      sendStartedAtMs: 105,
      startedAtMs: 95,
    };

    await sendTerminalInput({
      agentId: 'agent-1',
      data,
      inputEpoch: 'input-epoch-1',
      inputSeq: 7,
      requestId: 'request-1',
      trace,
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[0]).toEqual([
      IPC.WriteToAgent,
      expect.objectContaining({
        data: 'x'.repeat(MAX_CLIENT_INPUT_DATA_LENGTH),
        inputEpoch: 'input-epoch-1',
        inputSeq: 7,
        requestId: 'request-1:0',
        trace,
      }),
    ]);
    expect(invokeMock.mock.calls[1]).toEqual([
      IPC.WriteToAgent,
      expect.objectContaining({
        data: 'x'.repeat(512),
        inputEpoch: 'input-epoch-1',
        inputSeq: 8,
        requestId: 'request-1:1',
      }),
    ]);
    expect(invokeMock.mock.calls[1]?.[1]).not.toHaveProperty('trace');
  });

  it('settles an aborted Electron IPC consumer before the underlying request completes', async () => {
    const deferredResponse = createDeferred<boolean>();
    const invokeMock = vi
      .fn<(channel: IPC, args?: unknown) => Promise<unknown>>()
      .mockReturnValue(deferredResponse.promise);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: new URL('http://localhost/terminal'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        setTimeout,
        clearTimeout,
        electron: {
          ipcRenderer: {
            invoke: invokeMock,
            on: vi.fn(),
            removeAllListeners: vi.fn(),
          },
        },
      },
    });
    const cancellation = new Error('dialog request superseded');
    const controller = new AbortController();
    const { invokeWithAbortSignal } = await import('./ipc');

    const request = invokeWithAbortSignal(IPC.CheckPathExists, controller.signal, {
      path: '/repo/task-1',
    });
    controller.abort(cancellation);

    await expect(request).rejects.toBe(cancellation);
    expect(await getPromiseState(deferredResponse.promise)).toBe('pending');

    deferredResponse.resolve(true);
    await expect(deferredResponse.promise).resolves.toBe(true);
  });

  it('chunks large browser write_to_agent payloads without splitting surrogate pairs', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { MAX_CLIENT_INPUT_DATA_LENGTH } = await import('../../electron/remote/protocol');
    const { invoke } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();

    const data = `${'a'.repeat(MAX_CLIENT_INPUT_DATA_LENGTH - 1)}🙂`;
    const writePromise = invoke(IPC.WriteToAgent, { agentId: 'agent-1', data });

    await flushMicrotasks();
    const firstInputMessage = socket.sent.find((message) => message.type === 'input');
    receiveAcceptedAgentCommandResult(socket, firstInputMessage);
    await flushMicrotasks();

    const inputMessages = socket.sent.filter((message) => message.type === 'input');
    receiveAcceptedAgentCommandResult(socket, inputMessages[1]);
    await expect(writePromise).resolves.toBeUndefined();

    expect(inputMessages).toHaveLength(2);
    expect(inputMessages[0]?.data).toHaveLength(MAX_CLIENT_INPUT_DATA_LENGTH - 1);
    expect(inputMessages[1]?.data).toBe('🙂');
  });

  it('forwards trace metadata on browser write_to_agent commands', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { invoke } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();

    const trace = {
      bufferedAtMs: 100,
      inputChars: 9,
      inputKind: 'interactive' as const,
      sendStartedAtMs: 105,
      startedAtMs: 95,
    };
    const writePromise = invoke(IPC.WriteToAgent, {
      agentId: 'agent-1',
      data: 'echo trace',
      trace,
    });

    await flushMicrotasks();
    const inputMessage = socket.sent.find((message) => message.type === 'input');
    expect(inputMessage?.trace).toEqual(trace);
    receiveAcceptedAgentCommandResult(socket, inputMessage);
    await expect(writePromise).resolves.toBeUndefined();
  });

  it('rejects browser write_to_agent when the backend rejects the command result', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { invoke } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();

    const writePromise = invoke(IPC.WriteToAgent, {
      agentId: 'agent-1',
      controllerId: 'client-self',
      data: 'echo denied\n',
      taskId: 'task-1',
    });

    await flushMicrotasks();
    const inputMessage = socket.sent.find((message) => message.type === 'input');
    const requestId = typeof inputMessage?.requestId === 'string' ? inputMessage.requestId : null;
    expect(requestId).toBeTruthy();
    socket.receiveText({
      accepted: false,
      agentId: 'agent-1',
      command: 'input',
      message: 'Task is controlled by another client',
      requestId,
      type: 'agent-command-result',
    });

    await expect(writePromise).rejects.toThrow('Task is controlled by another client');
  });

  it('rejects pending browser write_to_agent command requests during transport reset', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const {
      assertBrowserAgentCommandRequestStateCleanForTests,
      invoke,
      resetBrowserTransportStateForTests,
    } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();

    const writePromise = invoke(IPC.WriteToAgent, {
      agentId: 'agent-1',
      data: 'echo reset\n',
    });

    await flushMicrotasks();
    expect(socket.sent.find((message) => message.type === 'input')).toBeTruthy();
    expect(await getPromiseState(writePromise)).toBe('pending');

    resetBrowserTransportStateForTests();

    await expect(writePromise).rejects.toThrow('Browser agent command test state reset');
    expect(() => assertBrowserAgentCommandRequestStateCleanForTests()).not.toThrow();
  });

  it('rejects browser write_to_agent immediately when the browser socket is unavailable', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { invoke } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();
    socket.close();
    await flushMicrotasks();
    const writePromise = invoke(IPC.WriteToAgent, {
      agentId: 'agent-1',
      data: 'echo unavailable\n',
    });

    await flushMicrotasks();
    expect(ControllableWebSocket.instances).toHaveLength(2);
    expect(await getPromiseState(writePromise)).toBe('pending');

    const reconnectSocket = ControllableWebSocket.instances[1];
    reconnectSocket.open();
    await flushMicrotasks();

    const reconnectInputMessage = reconnectSocket.sent.find((message) => message.type === 'input');
    receiveAcceptedAgentCommandResult(reconnectSocket, reconnectInputMessage);
    await expect(writePromise).resolves.toBeUndefined();

    expect(socket.sent.filter((message) => message.type === 'input')).toHaveLength(0);
    expect(reconnectSocket.sent.filter((message) => message.type === 'input')).toHaveLength(1);
  });

  it('ignores mismatched agent command results until the matching agent and command arrive', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { invoke } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();

    const writePromise = invoke(IPC.WriteToAgent, { agentId: 'agent-1', data: 'echo test\n' });

    await flushMicrotasks();
    const inputMessage = socket.sent.find((message) => message.type === 'input');
    const requestId = typeof inputMessage?.requestId === 'string' ? inputMessage.requestId : null;
    expect(requestId).toBeTruthy();

    socket.receiveText({
      accepted: true,
      agentId: 'agent-2',
      command: 'input',
      requestId,
      type: 'agent-command-result',
    });
    await flushMicrotasks();
    expect(await getPromiseState(writePromise)).toBe('pending');

    socket.receiveText({
      accepted: true,
      agentId: 'agent-1',
      command: 'resize',
      requestId,
      type: 'agent-command-result',
    });
    await flushMicrotasks();
    expect(await getPromiseState(writePromise)).toBe('pending');

    socket.receiveText({
      accepted: true,
      agentId: 'agent-1',
      command: 'input',
      requestId,
      type: 'agent-command-result',
    });

    await expect(writePromise).resolves.toBeUndefined();
  });

  it('cancels pending browser agent command requests explicitly', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { cancelBrowserAgentCommandRequest, invoke } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();

    const writePromise = invoke(IPC.WriteToAgent, {
      agentId: 'agent-1',
      data: 'echo cancel\n',
      requestId: 'request-cancel',
    });

    await flushMicrotasks();
    cancelBrowserAgentCommandRequest('request-cancel');

    await expect(writePromise).rejects.toThrow('Browser agent command canceled');
  });

  it('cancels browser write_to_agent requests before a reconnect send occurs', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { cancelBrowserAgentCommandRequest, invoke } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();
    socket.close();
    await flushMicrotasks();

    const writePromise = invoke(IPC.WriteToAgent, {
      agentId: 'agent-1',
      data: 'echo canceled-before-reconnect\n',
      requestId: 'request-reconnect-cancel',
    });

    await flushMicrotasks();
    expect(ControllableWebSocket.instances).toHaveLength(2);

    cancelBrowserAgentCommandRequest('request-reconnect-cancel');
    await expect(writePromise).rejects.toThrow('Browser agent command canceled');

    const reconnectSocket = ControllableWebSocket.instances[1];
    reconnectSocket.open();
    await flushMicrotasks();

    expect(reconnectSocket.sent.filter((message) => message.type === 'input')).toHaveLength(0);
  });

  it('rejects immediate browser control messages instead of queueing them for reconnect', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { onBrowserTransportEvent, sendImmediateBrowserControlMessage } = await import('./ipc');

    const cleanup = onBrowserTransportEvent(() => {});
    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();
    socket.close();
    await flushMicrotasks();

    await expect(
      sendImmediateBrowserControlMessage({
        type: 'request-task-command-takeover',
        action: 'type in the terminal',
        requestId: 'request-now',
        targetControllerId: 'peer-client',
        taskId: 'task-1',
      }),
    ).rejects.toThrow('Browser socket unavailable');

    cleanup();
    expect(
      socket.sent.filter((message) => message.type === 'request-task-command-takeover'),
    ).toHaveLength(0);
  });

  it('exposes a deterministic browser transport test hook when renderer diagnostics are enabled', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });
    Object.assign(window, {
      __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
    });

    const { onBrowserTransportEvent } = await import('./ipc');
    const transportEvents: string[] = [];
    const cleanup = onBrowserTransportEvent((event) => {
      if (event.kind === 'connection') {
        transportEvents.push(event.state);
      }
    });

    const hook = window.__parallelCodeBrowserTransportForTests__;
    expect(hook).toBeTruthy();

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();

    expect(hook?.getConnectionState()).toBe('connected');

    hook?.disconnect();
    await flushMicrotasks();
    expect(hook?.getConnectionState()).toBe('disconnected');

    const reconnectPromise = hook?.ensureConnected();
    expect(ControllableWebSocket.instances).toHaveLength(2);
    const reconnectSocket = ControllableWebSocket.instances[1];
    reconnectSocket.open();
    await reconnectPromise;
    await flushMicrotasks();

    expect(transportEvents).toEqual(
      expect.arrayContaining(['connected', 'disconnected', 'reconnecting']),
    );
    expect(transportEvents[transportEvents.length - 1]).toBe('connected');

    cleanup();
  });

  it('generates a request id and waits for backend acceptance when terminal input omits one', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { sendTerminalInput } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();

    const onBrowserCommandResultReceived = vi.fn();
    const inputPromise = sendTerminalInput(
      {
        agentId: 'agent-1',
        data: 'echo terminal-path\n',
      },
      { onBrowserCommandResultReceived },
    );

    await flushMicrotasks();

    const inputMessage = socket.sent.find((message) => message.type === 'input');
    const requestId = typeof inputMessage?.requestId === 'string' ? inputMessage.requestId : null;
    expect(requestId).toBeTruthy();
    expect(await getPromiseState(inputPromise)).toBe('pending');

    socket.receiveText({
      accepted: true,
      agentId: 'agent-1',
      command: 'input',
      requestId,
      type: 'agent-command-result',
    });
    await expect(inputPromise).resolves.toBeUndefined();
    expect(onBrowserCommandResultReceived).toHaveBeenCalledWith(expect.any(Number));
    expect(socket.sent.filter((message) => message.type === 'input')).toHaveLength(1);
  });

  it('waits for reconnect before sending terminal input on the browser hot path', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { sendTerminalInput } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();
    socket.close();
    await flushMicrotasks();

    const inputPromise = sendTerminalInput({
      agentId: 'agent-1',
      data: 'echo reconnect-hot-path\n',
      requestId: 'terminal-reconnect-send',
    });

    await flushMicrotasks();
    expect(ControllableWebSocket.instances).toHaveLength(2);
    expect(await getPromiseState(inputPromise)).toBe('pending');

    const reconnectSocket = ControllableWebSocket.instances[1];
    reconnectSocket.open();
    await flushMicrotasks();

    const inputMessage = reconnectSocket.sent.find((message) => message.type === 'input');
    const requestId = typeof inputMessage?.requestId === 'string' ? inputMessage.requestId : null;
    expect(requestId).toBeTruthy();
    reconnectSocket.receiveText({
      accepted: true,
      agentId: 'agent-1',
      command: 'input',
      requestId,
      type: 'agent-command-result',
    });
    await flushMicrotasks();

    await expect(inputPromise).resolves.toBeUndefined();
    expect(reconnectSocket.sent.filter((message) => message.type === 'input')).toHaveLength(1);
  });

  it('preserves browser terminal input send order for concurrent reconnect sends', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { sendTerminalInput } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();
    socket.close();
    await flushMicrotasks();

    const firstPromise = sendTerminalInput({
      agentId: 'agent-1',
      data: 'first',
      inputEpoch: 'ordered-epoch',
      inputSeq: 0,
      requestId: 'ordered-first',
    });
    const secondPromise = sendTerminalInput({
      agentId: 'agent-1',
      data: 'second',
      inputEpoch: 'ordered-epoch',
      inputSeq: 1,
      requestId: 'ordered-second',
    });

    await flushMicrotasks();
    expect(ControllableWebSocket.instances).toHaveLength(2);
    const reconnectSocket = ControllableWebSocket.instances[1];
    reconnectSocket.open();
    await flushMicrotasks(8);

    const inputMessages = reconnectSocket.sent.filter((message) => message.type === 'input');
    expect(inputMessages).toMatchObject([
      { data: 'first', inputSeq: 0, requestId: 'ordered-first' },
      { data: 'second', inputSeq: 1, requestId: 'ordered-second' },
    ]);

    receiveAcceptedAgentCommandResult(reconnectSocket, inputMessages[1]);
    receiveAcceptedAgentCommandResult(reconnectSocket, inputMessages[0]);
    await expect(Promise.all([firstPromise, secondPromise])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it('chunks large terminal input sends on the browser hot path', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { MAX_CLIENT_INPUT_DATA_LENGTH } = await import('../../electron/remote/protocol');
    const { sendTerminalInput } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();

    const data = 'x'.repeat(MAX_CLIENT_INPUT_DATA_LENGTH + 512);
    const inputPromise = sendTerminalInput({
      agentId: 'agent-1',
      data,
      requestId: 'terminal-large-send',
    });

    await flushMicrotasks();
    const firstInputMessage = socket.sent.find((message) => message.type === 'input');
    const firstRequestId =
      typeof firstInputMessage?.requestId === 'string' ? firstInputMessage.requestId : null;
    expect(firstRequestId).toBeTruthy();
    socket.receiveText({
      accepted: true,
      agentId: 'agent-1',
      command: 'input',
      requestId: firstRequestId,
      type: 'agent-command-result',
    });
    await flushMicrotasks();

    const inputMessages = socket.sent.filter((message) => message.type === 'input');
    expect(inputMessages).toHaveLength(2);
    const secondRequestId =
      typeof inputMessages[1]?.requestId === 'string' ? inputMessages[1].requestId : null;
    expect(secondRequestId).toBeTruthy();
    socket.receiveText({
      accepted: true,
      agentId: 'agent-1',
      command: 'input',
      requestId: secondRequestId,
      type: 'agent-command-result',
    });
    await expect(inputPromise).resolves.toBeUndefined();

    expect(inputMessages[0]?.data).toHaveLength(MAX_CLIENT_INPUT_DATA_LENGTH);
    expect(inputMessages[1]?.data).toHaveLength(512);
    expect(`${inputMessages[0]?.data ?? ''}${inputMessages[1]?.data ?? ''}`).toBe(data);
  });

  it('cancels pending terminal input sends before reconnect sends the batch', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { cancelBrowserAgentCommandRequest, sendTerminalInput } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();
    socket.close();
    await flushMicrotasks();

    const inputPromise = sendTerminalInput({
      agentId: 'agent-1',
      data: 'echo canceled-terminal-send\n',
      requestId: 'terminal-send-cancel',
    });

    await flushMicrotasks();
    expect(ControllableWebSocket.instances).toHaveLength(2);

    cancelBrowserAgentCommandRequest('terminal-send-cancel');
    await expect(inputPromise).rejects.toThrow('Browser agent command canceled');

    const reconnectSocket = ControllableWebSocket.instances[1];
    reconnectSocket.open();
    await flushMicrotasks();

    expect(reconnectSocket.sent.filter((message) => message.type === 'input')).toHaveLength(0);
  });

  it('forwards trace metadata on the terminal browser hot path', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { sendTerminalInput } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();

    const trace = {
      bufferedAtMs: 210,
      inputChars: 12,
      inputKind: 'burst' as const,
      sendStartedAtMs: 214,
      startedAtMs: 205,
    };
    const inputPromise = sendTerminalInput({
      agentId: 'agent-1',
      data: 'terminal-trace',
      requestId: 'terminal-trace-request',
      trace,
    });

    await flushMicrotasks();
    const inputMessage = socket.sent.find((message) => message.type === 'input');
    expect(inputMessage?.trace).toEqual(trace);
    const requestId = typeof inputMessage?.requestId === 'string' ? inputMessage.requestId : null;
    expect(requestId).toBeTruthy();
    socket.receiveText({
      accepted: true,
      agentId: 'agent-1',
      command: 'input',
      requestId,
      type: 'agent-command-result',
    });
    await expect(inputPromise).resolves.toBeUndefined();
  });

  it('rejects request-tracked terminal input when the backend denies the command', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { sendTerminalInput } = await import('./ipc');

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();
    socket.receiveText({ type: 'agents', list: [] });
    await flushMicrotasks();

    const inputPromise = sendTerminalInput({
      agentId: 'agent-1',
      data: 'echo denied\n',
      requestId: 'terminal-denied-send',
    });

    await flushMicrotasks();
    const inputMessage = socket.sent.find((message) => message.type === 'input');
    const requestId = typeof inputMessage?.requestId === 'string' ? inputMessage.requestId : null;
    expect(requestId).toBeTruthy();
    socket.receiveText({
      accepted: false,
      agentId: 'agent-1',
      command: 'input',
      message: 'Task is controlled by another client',
      requestId,
      type: 'agent-command-result',
    });

    await expect(inputPromise).rejects.toThrow('Task is controlled by another client');
  });

  it('accepts undefined browser HTTP IPC responses for reset_backend_runtime_diagnostics', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });

    const { invoke } = await import('./ipc');

    await expect(invoke(IPC.ResetBackendRuntimeDiagnostics)).resolves.toBeUndefined();
  });

  it('returns typed browser HTTP cleanup warnings for cleanup_task_runtime', async () => {
    const cleanupResult = {
      cleanupWarnings: [
        {
          kind: 'runners' as const,
          message: 'Failed to clean agent runners while removing task runtime: timeout',
        },
      ],
    };
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: cleanupResult }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });

    const { invoke } = await import('./ipc');

    await expect(
      invoke(IPC.CleanupTaskRuntime, {
        agentIds: [],
        controllerId: 'client-1',
        removeTaskState: true,
        taskId: 'task-1',
      }),
    ).resolves.toEqual(cleanupResult);
  });

  it('queues browserFetch requests after a network error and retries them on the next drain tick', async () => {
    vi.useFakeTimers();
    bindFakeWindowTimers();
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke, onBrowserHttpStateChange, onBrowserTransportEvent } = await import('./ipc');
    const states: string[] = [];
    const httpStates: string[] = [];
    const cleanup = onBrowserTransportEvent((event) => {
      if (event.kind === 'connection') states.push(event.state);
    });
    const cleanupHttp = onBrowserHttpStateChange((state) => {
      httpStates.push(state);
    });

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      const firstSocket = ControllableWebSocket.instances[0];
      firstSocket.open();
      await flushMicrotasks();

      const request = invoke(IPC.CheckPathExists, { path: '/repo/task-1' });
      expect(await getPromiseState(request)).toBe('pending');
      expect(states).not.toContain('disconnected');
      expect(httpStates).toContain('unreachable');

      await flushQueuedBrowserHttpDrainTick();

      await expect(request).resolves.toBe(true);
      expect(httpStates).toContain('available');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      firstSocket.close();
    } finally {
      cleanup();
      cleanupHttp();
      vi.useRealTimers();
    }
  });

  it('never queues or replays a single-attempt semantic side effect after transport loss', async () => {
    vi.useFakeTimers();
    bindFakeWindowTimers();
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('response lost'));
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { getBrowserQueueDepth, invokeOnce } = await import('./ipc');
    await expect(
      invokeOnce(IPC.SendTaskPromptInput, {
        agentId: 'agent-1',
        controllerId: 'client-1',
        taskId: 'task-1',
        text: 'continue',
      }),
    ).rejects.toThrow('Unable to reach the Parallel Code server');

    expect(getBrowserQueueDepth()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves task creation operation identity across an ambiguous browser retry', async () => {
    vi.useFakeTimers();
    bindFakeWindowTimers();
    const observedBodies: unknown[] = [];
    const createdTask = {
      base_branch: 'main',
      branch_name: 'main',
      git_isolation: 'current-branch' as const,
      id: 'task-replayed',
      worktree_path: '/repo',
    };
    let attempt = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      observedBodies.push(body);
      attempt += 1;
      if (attempt === 1) {
        throw new Error('response lost after server commit');
      }
      return new Response(JSON.stringify({ result: createdTask }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke } = await import('./ipc');
    const args = {
      gitIsolation: 'current-branch' as const,
      name: 'Root task',
      operationId: 'create-operation-response-loss',
      projectId: 'project-1',
      projectRoot: '/repo',
      symlinkDirs: [],
    };

    try {
      const request = invoke(IPC.CreateTask, args);
      expect(await getPromiseState(request)).toBe('pending');

      await flushQueuedBrowserHttpDrainTick();

      await expect(request).resolves.toEqual(createdTask);
      expect(observedBodies).toEqual([args, args]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays the current HTTP plane state to late subscribers', async () => {
    vi.useFakeTimers();
    bindFakeWindowTimers();

    const deferred = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockReturnValueOnce(deferred.promise);
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke, onBrowserHttpStateChange } = await import('./ipc');
    const request = invoke(IPC.CheckPathExists, { path: '/repo/task-2' });
    expect(await getPromiseState(request)).toBe('pending');

    const httpStates: string[] = [];
    const cleanupHttp = onBrowserHttpStateChange((state) => {
      httpStates.push(state);
    });

    try {
      expect(httpStates).toContain('unreachable');

      deferred.resolve(
        new Response(JSON.stringify({ result: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await flushQueuedBrowserHttpDrainTick();

      await expect(request).resolves.toBe(true);
      expect(httpStates).toContain('available');
    } finally {
      cleanupHttp();
      vi.useRealTimers();
    }
  });

  it('retries queued HTTP requests without waiting for a WebSocket reconnect', async () => {
    vi.useFakeTimers();
    bindFakeWindowTimers();
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FailingWebSocket,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke } = await import('./ipc');

    try {
      const request = invoke(IPC.CheckPathExists, { path: '/repo/task-1' });
      expect(await getPromiseState(request)).toBe('pending');

      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks();

      await expect(request).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains queued requests when they are added to an already-open socket', async () => {
    vi.useFakeTimers();
    bindFakeWindowTimers();
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke, onBrowserTransportEvent } = await import('./ipc');
    const cleanup = onBrowserTransportEvent(() => {});

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      const socket = ControllableWebSocket.instances[0];
      socket.open();
      await flushMicrotasks();

      const request = invoke(IPC.CheckPathExists, { path: '/repo/task-1' });
      expect(await getPromiseState(request)).toBe('pending');

      await flushQueuedBrowserHttpDrainTick();

      await expect(request).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      socket.close();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('replays queued HTTP requests even if the WebSocket never reconnects', async () => {
    vi.useFakeTimers();
    bindFakeWindowTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke } = await import('./ipc');
    const request = invoke(IPC.CheckPathExists, { path: '/repo/task-1' });

    expect(await getPromiseState(request)).toBe('pending');

    await flushQueuedBrowserHttpDrainTick();

    await expect(request).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('rejects queued requests after the max reconnect retries', async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FailingWebSocket,
    });
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke } = await import('./ipc');
    const request = invoke(IPC.LoadAppState);

    expect(await getPromiseState(request)).toBe('pending');

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    await expect(request).rejects.toThrow('network down');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    vi.useRealTimers();
  });

  it('persists durable queued request retry counts across drain attempts', async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn<typeof fetch>().mockRejectedValue(new Error('network down')),
    });

    const { invoke } = await import('./ipc');
    const request = invoke(IPC.KillAgent, { agentId: 'agent-1' });
    void request.catch(() => {});

    await flushMicrotasks();
    await flushQueuedBrowserHttpDrainTick();

    const stored = sessionStorageData.get('ipc-durable-queue');
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored ?? '[]')).toEqual([
      {
        args: {
          agentId: 'agent-1',
        },
        cmd: IPC.KillAgent,
        retries: 1,
      },
    ]);

    vi.useRealTimers();
  });

  it('replays only validated durable HTTP IPC requests from session storage', async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    sessionStorageData.set(
      'ipc-durable-queue',
      JSON.stringify([
        {
          args: { agentId: 'agent-1' },
          cmd: IPC.KillAgent,
          retries: 1,
        },
        {
          args: { agentId: 'agent-2', reason: 'manual' },
          cmd: IPC.ResumeAgent,
          retries: 0,
        },
        {
          args: { agentId: 'agent-3', reason: 'flow-control' },
          cmd: IPC.PauseAgent,
          retries: 0,
        },
        {
          args: { agentId: 'agent-4' },
          cmd: IPC.CheckPathExists,
          retries: 0,
        },
        {
          args: {},
          cmd: IPC.KillAgent,
          retries: 0,
        },
        {
          args: { agentId: 'agent-5', reason: 'manual' },
          cmd: IPC.KillAgent,
          retries: 0,
        },
        {
          args: { agentId: 'agent-6', channelId: 42 },
          cmd: IPC.ResumeAgent,
          retries: 0,
        },
        {
          args: { agentId: 'agent-7' },
          cmd: IPC.KillAgent,
          retries: 4,
        },
      ]),
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { getBrowserQueueDepth } = await import('./ipc');
    expect(getBrowserQueueDepth()).toBe(2);

    await flushQueuedBrowserHttpDrainTick();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/ipc/kill_agent',
      '/api/ipc/resume_agent',
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ agentId: 'agent-1' }),
      JSON.stringify({ agentId: 'agent-2', reason: 'manual' }),
    ]);
    expect(sessionStorageData.has('ipc-durable-queue')).toBe(false);

    vi.useRealTimers();
  });

  it('keeps durable control requests queued when non-durable requests overflow the reconnect queue', async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FailingWebSocket,
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn<typeof fetch>().mockRejectedValue(new Error('network down')),
    });

    const { invoke, getBrowserQueueDepth } = await import('./ipc');
    const createRequests = Array.from({ length: 20 }, (_, index) =>
      invoke(IPC.CheckPathExists, { path: `/repo/task-${index}` }),
    );
    const killRequest = invoke(IPC.KillAgent, { agentId: 'agent-1' });
    for (const request of [...createRequests, killRequest]) {
      void request.catch(() => {});
    }

    await flushMicrotasks();

    await expect(createRequests[0]).rejects.toThrow(
      'IPC request queue overflowed while reconnecting.',
    );
    expect(await getPromiseState(killRequest)).toBe('pending');
    expect(getBrowserQueueDepth()).toBe(20);

    vi.useRealTimers();
  });

  it('deduplicates queued SaveAppState requests with last-write-wins semantics', async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke, onBrowserTransportEvent } = await import('./ipc');
    const cleanup = onBrowserTransportEvent(() => {});

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      const firstSocket = ControllableWebSocket.instances[0];
      firstSocket.open();
      await flushMicrotasks();

      const firstSave = invoke(IPC.SaveAppState, { json: 'first' });
      const secondSave = invoke(IPC.SaveAppState, { json: 'second' });

      expect(await getPromiseState(firstSave)).toBe('pending');
      expect(await getPromiseState(secondSave)).toBe('pending');

      firstSocket.close(1006);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(240);

      const secondSocket = ControllableWebSocket.instances[1];
      secondSocket.open();
      await flushMicrotasks();

      await expect(firstSave).resolves.toBeUndefined();
      await expect(secondSave).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ json: 'second' }));

      secondSocket.close();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('does not let re-enqueued requests block later queued requests', async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });
    const firstRetryResponse = createDeferred<Response>();
    let fetchCallCount = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      fetchCallCount += 1;
      switch (fetchCallCount) {
        case 1:
        case 2:
        case 3:
          throw new Error('network down');
        case 4:
          return new Response(JSON.stringify({ result: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        case 5:
          return firstRetryResponse.promise;
        default:
          throw new Error(`Unexpected fetch call ${fetchCallCount}`);
      }
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke, onBrowserTransportEvent } = await import('./ipc');
    const cleanup = onBrowserTransportEvent(() => {});

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      const socket = ControllableWebSocket.instances[0];
      socket.open();
      await flushMicrotasks();

      const firstRequest = invoke(IPC.CheckPathExists, { path: '/repo/task-1' });
      const secondRequest = invoke(IPC.CheckPathExists, { path: '/repo/task-2' });

      expect(await getPromiseState(firstRequest)).toBe('pending');
      expect(await getPromiseState(secondRequest)).toBe('pending');

      await vi.runAllTimersAsync();
      await flushMicrotasks();

      await expect(secondRequest).resolves.toBe(true);
      expect(await getPromiseState(firstRequest)).toBe('pending');

      firstRetryResponse.resolve(
        new Response(JSON.stringify({ result: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await flushMicrotasks();

      await expect(firstRequest).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(5);

      socket.close();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('uses fast warm reconnect delays for recently connected browser sessions', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });
    const setTimeoutSpy = vi.fn((_handler: TimerHandler, _delay?: number): number => 1);
    window.setTimeout = setTimeoutSpy as unknown as typeof window.setTimeout;
    window.clearTimeout = vi.fn() as unknown as typeof window.clearTimeout;

    const { onBrowserTransportEvent } = await import('./ipc');
    const cleanup = onBrowserTransportEvent(() => {});

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      const firstSocket = ControllableWebSocket.instances[0];
      firstSocket.open();
      await flushMicrotasks();

      firstSocket.close(1006);
      expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(0);

      const firstReconnect = setTimeoutSpy.mock.calls[0]?.[0] as () => void;
      firstReconnect();
      expect(ControllableWebSocket.instances).toHaveLength(2);
      const secondSocket = ControllableWebSocket.instances[1];
      secondSocket.open();
      await flushMicrotasks();

      secondSocket.close(1006);
      expect(setTimeoutSpy.mock.calls[1]?.[1]).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('sends browser heartbeats and clears the pong timeout when a pong arrives', async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { onBrowserTransportEvent } = await import('./ipc');
    const cleanup = onBrowserTransportEvent(() => {});

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      const socket = ControllableWebSocket.instances[0];
      const closeSpy = vi.spyOn(socket, 'close');
      socket.open();
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(socket.sent.some((message) => message.type === 'ping')).toBe(true);

      socket.receiveText({ type: 'pong' });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(12_000);

      expect(closeSpy).not.toHaveBeenCalled();
      socket.close();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('logs 4xx browserFetch responses without emitting a transport error', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Bad input' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { invoke, onBrowserTransportEvent } = await import('./ipc');
    const errors: string[] = [];
    const cleanup = onBrowserTransportEvent((event) => {
      if (event.kind === 'error') errors.push(event.message);
    });

    try {
      await expect(invoke(IPC.LoadAppState)).rejects.toThrow('Bad input');
      expect(warn).toHaveBeenCalledWith('[ipc] Bad request to', IPC.LoadAppState, ':', 'Bad input');
      expect(errors).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('dispatches agent-error server messages to listeners and transport events', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { listenServerMessage, onBrowserTransportEvent } = await import('./ipc');
    const transportErrors: string[] = [];
    const agentErrors: string[] = [];
    const offTransport = onBrowserTransportEvent((event) => {
      if (event.kind === 'error') transportErrors.push(event.message);
    });
    const offAgentErrors = listenServerMessage('agent-error', (message) => {
      agentErrors.push(message.message);
    });

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      const socket = ControllableWebSocket.instances[0];
      socket.open();
      await flushMicrotasks();

      socket.receiveText({ type: 'agent-error', agentId: 'agent-1', message: 'write failed' });
      await flushMicrotasks();

      expect(agentErrors).toEqual(['write failed']);
      expect(transportErrors).toContain('Agent agent-1: write failed');
      socket.close();
    } finally {
      offAgentErrors();
      offTransport();
    }
  });

  it('ignores unknown browser websocket server messages', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { listenServerMessage, onBrowserTransportEvent } = await import('./ipc');
    const transportEvents: string[] = [];
    const agentErrors: string[] = [];
    const offTransport = onBrowserTransportEvent((event) => {
      transportEvents.push(event.kind);
    });
    const offAgentErrors = listenServerMessage('agent-error', (message) => {
      agentErrors.push(message.message);
    });

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      const socket = ControllableWebSocket.instances[0];
      socket.open();
      await flushMicrotasks();
      const transportEventsBeforeUnknownMessage = [...transportEvents];

      socket.receiveText({ type: 'future-server-event', payload: { ready: true } });
      await flushMicrotasks();

      expect(agentErrors).toEqual([]);
      expect(transportEvents).toEqual(transportEventsBeforeUnknownMessage);
      socket.close();
    } finally {
      offAgentErrors();
      offTransport();
    }
  });

  it('ignores malformed known browser websocket server messages', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { listenServerMessage, onBrowserTransportEvent } = await import('./ipc');
    const transportEvents: string[] = [];
    const agentErrors: string[] = [];
    const agentSnapshots: number[] = [];
    const gitStatusPaths: string[] = [];
    const offTransport = onBrowserTransportEvent((event) => {
      transportEvents.push(event.kind);
    });
    const offAgentErrors = listenServerMessage('agent-error', (message) => {
      agentErrors.push(message.message);
    });
    const offAgents = listenServerMessage('agents', (message) => {
      agentSnapshots.push(message.list.length);
    });
    const offGitStatus = listenServerMessage('git-status-changed', (message) => {
      gitStatusPaths.push(message.worktreePath ?? '');
    });

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      const socket = ControllableWebSocket.instances[0];
      socket.open();
      await flushMicrotasks();
      const transportEventsBeforeMalformedMessages = [...transportEvents];

      socket.receiveText({ type: 'agent-error', agentId: 'agent-1' });
      socket.receiveText({ type: 'agents', list: [{ agentId: 'agent-1', status: 'mystery' }] });
      socket.receiveText({ type: 'git-status-changed', worktreePath: 42 });
      await flushMicrotasks();

      expect(agentErrors).toEqual([]);
      expect(agentSnapshots).toEqual([]);
      expect(gitStatusPaths).toEqual([]);
      expect(transportEvents).toEqual(transportEventsBeforeMalformedMessages);
      socket.close();
    } finally {
      offAgentErrors();
      offAgents();
      offGitStatus();
      offTransport();
    }
  });

  it('deduplicates sequenced control messages across reconnects', async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });

    const { listenServerMessage, onBrowserTransportEvent } = await import('./ipc');
    const worktreePaths: string[] = [];
    const offMessages = listenServerMessage('git-status-changed', (message) => {
      worktreePaths.push(message.worktreePath ?? '');
    });
    const offTransport = onBrowserTransportEvent(() => {});

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      const firstSocket = ControllableWebSocket.instances[0];
      firstSocket.open();
      await flushMicrotasks();

      firstSocket.receiveText({ type: 'git-status-changed', worktreePath: '/one', seq: 4 });
      firstSocket.receiveText({ type: 'git-status-changed', worktreePath: '/stale', seq: 4 });
      firstSocket.receiveText({ type: 'git-status-changed', worktreePath: '/older', seq: 3 });
      await flushMicrotasks();

      expect(worktreePaths).toEqual(['/one']);

      firstSocket.close(1006);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(250);

      expect(ControllableWebSocket.instances).toHaveLength(2);
      const secondSocket = ControllableWebSocket.instances[1];
      secondSocket.open();
      await flushMicrotasks();

      secondSocket.receiveText({ type: 'git-status-changed', worktreePath: '/duplicate', seq: 4 });
      secondSocket.receiveText({ type: 'git-status-changed', worktreePath: '/two', seq: 5 });
      await flushMicrotasks();

      expect(worktreePaths).toEqual(['/one', '/two']);
      secondSocket.close();
    } finally {
      offTransport();
      offMessages();
      vi.useRealTimers();
    }
  });

  it('clears the browser token and reports auth-expired on 401 fetch responses', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Session expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });

    const { invoke, onBrowserTransportEvent } = await import('./ipc');
    const states: string[] = [];
    const cleanup = onBrowserTransportEvent((event) => {
      if (event.kind === 'connection') states.push(event.state);
    });

    expect(ControllableWebSocket.instances).toHaveLength(1);
    const socket = ControllableWebSocket.instances[0];
    socket.open();
    await flushMicrotasks();

    await expect(invoke(IPC.LoadAppState)).rejects.toThrow('Session expired');
    expect(storage.has('parallel-code-token')).toBe(false);
    expect(states).toContain('auth-expired');
    expect(states).not.toContain('disconnected');
    expect(socket.readyState).toBe(ControllableWebSocket.CLOSED);

    cleanup();
  });

  it('throws the server-provided error message for 5xx fetch responses', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Server exploded' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });

    const { invoke } = await import('./ipc');

    await expect(invoke(IPC.LoadAppState)).rejects.toThrow('Server exploded');
  });
});
