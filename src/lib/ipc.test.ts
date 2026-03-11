import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

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
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses valid UUID channel frames', async () => {
    const { parseBrowserBinaryChannelFrame } = await import('./ipc');
    const parsed = parseBrowserBinaryChannelFrame(
      createBinaryFrame('12345678-1234-1234-1234-123456789012', 'hello'),
    );

    expect(parsed?.channelId).toBe('12345678-1234-1234-1234-123456789012');
    expect(new TextDecoder().decode(parsed?.data)).toBe('hello');
  });

  it('ignores short frames', async () => {
    const { parseBrowserBinaryChannelFrame } = await import('./ipc');
    expect(parseBrowserBinaryChannelFrame(new Uint8Array([CHANNEL_DATA_FRAME_TYPE]).buffer)).toBe(
      null,
    );
  });

  it('warns and ignores malformed channel headers', async () => {
    const { parseBrowserBinaryChannelFrame } = await import('./ipc');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(
      parseBrowserBinaryChannelFrame(createBinaryFrame('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')),
    ).toBe(null);
    expect(warn).toHaveBeenCalledWith('[ipc] Ignoring malformed channel frame header');
  });
});

describe('Channel', () => {
  const storage = new Map<string, string>();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

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
        this.onerror?.call(this as unknown as WebSocket, {} as Event);
        this.onclose?.call(this as unknown as WebSocket, { code: 1006 } as CloseEvent);
      });
    }

    close(): void {
      this.readyState = FailingWebSocket.CLOSED;
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
      this.onopen?.call(this as unknown as WebSocket, {} as Event);
    }

    close(code = 1000): void {
      this.readyState = ControllableWebSocket.CLOSED;
      this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent);
    }

    send(payload: string): void {
      this.sent.push(JSON.parse(payload) as Record<string, unknown>);
    }

    receiveText(message: unknown): void {
      this.onmessage?.call(
        this as unknown as WebSocket,
        {
          data: JSON.stringify(message),
        } as MessageEvent<string>,
      );
    }

    receiveBinary(buffer: ArrayBuffer): void {
      this.onmessage?.call(
        this as unknown as WebSocket,
        {
          data: buffer,
        } as MessageEvent<ArrayBuffer>,
      );
    }
  }

  async function flushMicrotasks(rounds = 4): Promise<void> {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
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

  beforeEach(() => {
    vi.resetModules();
    ControllableWebSocket.reset();
    storage.clear();
    storage.set('parallel-code-token', 'test-token');

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: new URL('http://localhost/terminal'),
        history: { replaceState: vi.fn() },
        addEventListener: vi.fn(),
        setTimeout,
        clearTimeout,
        electron: undefined,
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
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
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FailingWebSocket,
    });
  });

  afterEach(() => {
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
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: originalWebSocket,
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: originalFetch,
    });
  });

  it('keeps ready pending when the initial bind send fails', async () => {
    const { Channel } = await import('./ipc');
    const channel = new Channel<unknown>();

    const readyState = await Promise.race([
      channel.ready.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);

    expect(readyState).toBe('pending');

    channel.cleanup?.();
    await expect(channel.ready).rejects.toThrow('Channel cleaned up');
  });

  it('rejects pending ready when there is no auth token', async () => {
    storage.delete('parallel-code-token');
    const { Channel } = await import('./ipc');
    const channel = new Channel<unknown>();

    await expect(channel.ready).rejects.toThrow('Missing auth token');
    channel.cleanup?.();
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
          this.onopen?.call(this as unknown as WebSocket, {} as Event);
          queueMicrotask(() => {
            this.readyState = AuthExpiredWebSocket.CLOSED;
            this.onclose?.call(this as unknown as WebSocket, { code: 4001 } as CloseEvent);
          });
        });
      }

      close(): void {
        this.readyState = AuthExpiredWebSocket.CLOSED;
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
    channel.cleanup?.();
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

      expect(firstSocket.sent.some((message) => message.type === 'auth')).toBe(true);
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

      expect(secondSocket.sent.some((message) => message.type === 'auth')).toBe(true);
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

      channel.cleanup?.();
      secondSocket.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid pause reasons instead of silently downgrading them', async () => {
    const { invoke } = await import('./ipc');

    await expect(
      invoke(IPC.PauseAgent, { agentId: 'agent-1', reason: 'restore ' }),
    ).rejects.toThrow('Invalid pause reason');
    await expect(
      invoke(IPC.ResumeAgent, { agentId: 'agent-1', reason: 'restore ' }),
    ).rejects.toThrow('Invalid pause reason');
  });

  it('queues browserFetch requests after a network error and replays them after reconnect', async () => {
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
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { ok: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke, onBrowserTransportEvent } = await import('./ipc');
    const states: string[] = [];
    const cleanup = onBrowserTransportEvent((event) => {
      if (event.kind === 'connection') states.push(event.state);
    });

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      const firstSocket = ControllableWebSocket.instances[0];
      firstSocket.open();
      await flushMicrotasks();

      const request = invoke<{ ok: boolean }>(IPC.CreateTask, { taskId: 'task-1' });
      expect(await getPromiseState(request)).toBe('pending');
      expect(states).toContain('disconnected');

      firstSocket.close(1006);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(240);

      expect(ControllableWebSocket.instances).toHaveLength(2);
      const secondSocket = ControllableWebSocket.instances[1];
      secondSocket.open();
      await flushMicrotasks();

      await expect(request).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      secondSocket.close();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('drains queued requests when they are added to an already-open socket', async () => {
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
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { ok: true } }), {
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

      const request = invoke<{ ok: boolean }>(IPC.CreateTask, { taskId: 'task-1' });
      expect(await getPromiseState(request)).toBe('pending');

      await vi.runOnlyPendingTimersAsync();
      await flushMicrotasks();

      await expect(request).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      socket.close();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('rejects queued requests after the max reconnect retries', async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const { invoke, onBrowserTransportEvent } = await import('./ipc');
    const cleanup = onBrowserTransportEvent(() => {});

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      let currentSocket = ControllableWebSocket.instances[0];
      currentSocket.open();
      await flushMicrotasks();

      const request = invoke(IPC.LoadAppState);
      expect(await getPromiseState(request)).toBe('pending');

      for (let attempt = 0; attempt < 3; attempt += 1) {
        currentSocket.close(1006);
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(240);
        currentSocket = ControllableWebSocket.instances[
          ControllableWebSocket.instances.length - 1
        ] as ControllableWebSocket;
        currentSocket.open();
        await flushMicrotasks();
      }

      await expect(request).rejects.toThrow('network down');
      expect(fetchMock).toHaveBeenCalledTimes(4);

      currentSocket.close();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
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
          return new Response(JSON.stringify({ result: { taskId: 'task-2' } }), {
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

      const firstRequest = invoke<{ taskId: string }>(IPC.CreateTask, { taskId: 'task-1' });
      const secondRequest = invoke<{ taskId: string }>(IPC.CreateTask, { taskId: 'task-2' });

      expect(await getPromiseState(firstRequest)).toBe('pending');
      expect(await getPromiseState(secondRequest)).toBe('pending');

      await vi.runAllTimersAsync();
      await flushMicrotasks();

      await expect(secondRequest).resolves.toEqual({ taskId: 'task-2' });
      expect(await getPromiseState(firstRequest)).toBe('pending');

      firstRetryResponse.resolve(
        new Response(JSON.stringify({ result: { taskId: 'task-1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await flushMicrotasks();

      await expect(firstRequest).resolves.toEqual({ taskId: 'task-1' });
      expect(fetchMock).toHaveBeenCalledTimes(5);

      socket.close();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('uses reconnect jitter within the configured range', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ControllableWebSocket,
    });
    const setTimeoutSpy = vi.fn((_handler: TimerHandler, _delay?: number): number => 1);
    window.setTimeout = setTimeoutSpy as unknown as typeof window.setTimeout;
    window.clearTimeout = vi.fn() as unknown as typeof window.clearTimeout;

    const random = vi.spyOn(Math, 'random');
    const { onBrowserTransportEvent } = await import('./ipc');
    const cleanup = onBrowserTransportEvent(() => {});

    try {
      expect(ControllableWebSocket.instances).toHaveLength(1);
      const firstSocket = ControllableWebSocket.instances[0];
      firstSocket.open();
      await flushMicrotasks();

      random.mockReturnValueOnce(0);
      firstSocket.close(1006);
      expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(160);

      const firstReconnect = setTimeoutSpy.mock.calls[0]?.[0] as () => void;
      firstReconnect();
      expect(ControllableWebSocket.instances).toHaveLength(2);
      const secondSocket = ControllableWebSocket.instances[1];
      secondSocket.open();
      await flushMicrotasks();

      random.mockReturnValueOnce(1);
      secondSocket.close(1006);
      expect(setTimeoutSpy.mock.calls[1]?.[1]).toBe(240);
    } finally {
      cleanup();
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

  it('clears the browser token and reports auth-expired on 401 fetch responses', async () => {
    class IdleWebSocket {
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
      readyState = IdleWebSocket.CONNECTING;

      close(): void {
        this.readyState = IdleWebSocket.CLOSED;
      }

      send(): void {}
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: IdleWebSocket,
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

    await expect(invoke(IPC.LoadAppState)).rejects.toThrow('Session expired');
    expect(storage.has('parallel-code-token')).toBe(false);
    expect(states).toContain('auth-expired');

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
