import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isFiniteNumber, isRecord, isOptionalString } from './type-guards';
import { createWebSocketClientCore, type WebSocketConnectionState } from './websocket-client';

interface TestIncomingMessage {
  type: string;
  seq?: number;
}

interface TestOutgoingMessage {
  type: string;
  clientId?: string;
  lastSeq?: number;
  token?: string;
}

function parseTestOutgoingMessage(payload: string): TestOutgoingMessage {
  const parsed: unknown = JSON.parse(payload);
  if (
    !isRecord(parsed) ||
    typeof parsed.type !== 'string' ||
    !isOptionalString(parsed.clientId) ||
    !isOptionalString(parsed.token) ||
    !(parsed.lastSeq === undefined || isFiniteNumber(parsed.lastSeq))
  ) {
    throw new Error('invalid test outgoing websocket message');
  }

  const message: TestOutgoingMessage = { type: parsed.type };
  if (parsed.clientId !== undefined) {
    message.clientId = parsed.clientId;
  }
  if (parsed.lastSeq !== undefined) {
    message.lastSeq = parsed.lastSeq;
  }
  if (parsed.token !== undefined) {
    message.token = parsed.token;
  }

  return message;
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  binaryType: BinaryType = 'blob';
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  bufferedAmount = 0;
  readyState = FakeWebSocket.CONNECTING;
  sent: TestOutgoingMessage[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: TestIncomingMessage): void {
    this.receiveRaw(JSON.stringify(message));
  }

  receiveRaw(data: string): void {
    this.onmessage?.({
      data,
    } as MessageEvent<string>);
  }

  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }

  send(payload: string): void {
    this.sent.push(parseTestOutgoingMessage(payload));
  }
}

describe('createWebSocketClientCore', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useRealTimers();
    FakeWebSocket.reset();
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FakeWebSocket,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: originalWebSocket,
    });
  });

  it('authenticates with the stored cursor and ignores duplicate sequenced messages', async () => {
    const received: TestIncomingMessage[] = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: ({ clientId, lastSeq, token }) => ({
        type: 'auth',
        clientId,
        lastSeq,
        token,
      }),
      getClientId: () => 'client-1',
      getSocketUrl: ({ clientId, lastSeq }) =>
        `ws://localhost/ws?clientId=${clientId}&lastSeq=${lastSeq}`,
      getToken: () => 'token-1',
      onMessage: (message) => {
        received.push(message);
      },
      shouldReconnect: () => true,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];

    expect(socket?.url).toBe('ws://localhost/ws?clientId=client-1&lastSeq=-1');

    socket?.open();
    await connectPromise;

    expect(socket?.sent[0]).toEqual({
      type: 'auth',
      clientId: 'client-1',
      lastSeq: -1,
      token: 'token-1',
    });

    socket?.receive({ type: 'agents', seq: 1 });
    socket?.receive({ type: 'agents', seq: 1 });
    socket?.receive({ type: 'status', seq: 2 });

    expect(received).toEqual([
      { type: 'agents', seq: 1 },
      { type: 'status', seq: 2 },
    ]);
    expect(client.getLastSeq()).toBe(2);
  });

  it('accepts a lower first sequence after reconnect when the server cursor resets', async () => {
    const received: TestIncomingMessage[] = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: ({ clientId, lastSeq, token }) => ({
        type: 'auth',
        clientId,
        lastSeq,
        token,
      }),
      getClientId: () => 'client-1',
      getSocketUrl: ({ clientId, lastSeq }) =>
        `ws://localhost/ws?clientId=${clientId}&lastSeq=${lastSeq}`,
      getToken: () => 'token-1',
      onMessage: (message) => {
        received.push(message);
      },
      shouldReconnect: () => false,
    });

    const firstConnect = client.ensureConnected();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket?.open();
    await firstConnect;

    firstSocket?.receive({ type: 'event', seq: 7 });
    expect(client.getLastSeq()).toBe(7);
    firstSocket?.close(1006);

    const secondConnect = client.ensureConnected('reconnecting');
    const secondSocket = FakeWebSocket.instances[1];
    expect(secondSocket?.url).toBe('ws://localhost/ws?clientId=client-1&lastSeq=7');
    secondSocket?.open();
    await secondConnect;

    expect(secondSocket?.sent[0]).toEqual({
      type: 'auth',
      clientId: 'client-1',
      lastSeq: 7,
      token: 'token-1',
    });

    secondSocket?.receive({ type: 'event', seq: 0 });

    expect(received).toEqual([
      { type: 'event', seq: 7 },
      { type: 'event', seq: 0 },
    ]);
    expect(client.getLastSeq()).toBe(0);
  });

  it('reports the active socket buffered amount only while open', async () => {
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      onMessage: () => {},
      shouldReconnect: () => false,
    });

    expect(client.getBufferedAmount()).toBe(0);

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error('expected websocket instance');
    }
    socket.bufferedAmount = 256;
    socket.open();
    await connectPromise;

    expect(client.getBufferedAmount()).toBe(256);

    socket.bufferedAmount = 512;
    expect(client.getBufferedAmount()).toBe(512);

    socket.close();

    expect(client.getBufferedAmount()).toBe(0);
  });

  it('ignores parsed websocket payloads that are not typed message objects', async () => {
    const received: TestIncomingMessage[] = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      onMessage: (message) => {
        received.push(message);
      },
      shouldReconnect: () => false,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await connectPromise;

    socket?.receiveRaw('null');
    socket?.receiveRaw('[]');
    socket?.receiveRaw('{}');
    socket?.receiveRaw('{"type":42}');
    socket?.receiveRaw('not-json');
    expect(received).toEqual([]);

    socket?.receive({ type: 'agents' });
    expect(received).toEqual([{ type: 'agents' }]);
  });

  it('uses the supplied incoming-message guard before dispatching messages', async () => {
    const received: TestIncomingMessage[] = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      isIncomingMessage: (value): value is TestIncomingMessage =>
        isRecord(value) && value.type === 'accepted',
      onMessage: (message) => {
        received.push(message);
      },
      shouldReconnect: () => false,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await connectPromise;

    socket?.receive({ type: 'agents' });
    socket?.receive({ type: 'accepted' });

    expect(received).toEqual([{ type: 'accepted' }]);
  });

  it('passes token context to websocket URLs even when auth messages are not used', async () => {
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      getClientId: () => 'client-1',
      getSocketUrl: ({ clientId, lastSeq, token }) =>
        `ws://localhost/ws?clientId=${clientId}&lastSeq=${lastSeq}&token=${token ?? 'none'}`,
      getToken: () => 'url-token',
      onMessage: () => {},
      shouldReconnect: () => false,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];

    expect(socket?.url).toBe('ws://localhost/ws?clientId=client-1&lastSeq=-1&token=url-token');

    socket?.open();
    await connectPromise;
    expect(socket?.sent).toEqual([]);
  });

  it('allows callers to skip auth messages when token auth is not available', async () => {
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: ({ token }) => `ws://localhost/ws?token=${token ?? 'none'}`,
      getToken: () => null,
      onMessage: () => {},
      onMissingToken: vi.fn(),
      shouldReconnect: () => false,
      shouldSendAuthMessage: ({ token }) => token !== null,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toBe('ws://localhost/ws?token=none');

    socket?.open();
    await connectPromise;

    expect(socket?.sent).toEqual([]);
  });

  it('tracks pong round trips and disconnects after a missed pong timeout', async () => {
    vi.useFakeTimers();

    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      createPingMessage: () => ({ type: 'ping' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      isPongMessage: (message) => message.type === 'pong',
      onMessage: () => {},
      pingIntervalMs: 10,
      pongTimeoutMs: 5,
      shouldReconnect: () => false,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await connectPromise;

    vi.advanceTimersByTime(10);
    expect(socket?.sent[socket.sent.length - 1]).toEqual({ type: 'ping' });

    socket?.receive({ type: 'pong' });
    expect(client.getLastRttMs()).not.toBeNull();

    vi.advanceTimersByTime(10);
    expect(socket?.sent[socket.sent.length - 1]).toEqual({ type: 'ping' });

    vi.advanceTimersByTime(5);
    expect(client.getState()).toBe('disconnected');
  });

  it('allows configured missed pong tolerance before disconnecting', async () => {
    vi.useFakeTimers();

    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      createPingMessage: () => ({ type: 'ping' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      isPongMessage: (message) => message.type === 'pong',
      maxMissedPongs: 2,
      onMessage: () => {},
      pingIntervalMs: 10,
      pongTimeoutMs: 5,
      shouldReconnect: () => false,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await connectPromise;

    vi.advanceTimersByTime(15);
    expect(client.getState()).toBe('connected');

    vi.advanceTimersByTime(10);
    expect(socket?.sent[socket.sent.length - 1]).toEqual({ type: 'ping' });
    vi.advanceTimersByTime(5);
    expect(client.getState()).toBe('disconnected');
  });

  it('passes recent connection context to reconnect delay selection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const reconnectDelayMs = vi.fn(() => 10);

    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      onMessage: () => {},
      reconnectDelayMs,
      shouldReconnect: () => true,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await connectPromise;

    vi.setSystemTime(2_000);
    socket?.close(1006);

    expect(reconnectDelayMs).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        hasConnected: true,
        lastConnectedAt: 1_000,
        lastConnectionDurationMs: 1_000,
        lastDisconnectedAt: 2_000,
        lastDisconnectReason: 'close',
      }),
    );
  });

  it('keeps disconnected age anchored to the first outage across failed retries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const reconnectDelayMs = vi.fn(() => 10);

    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      onMessage: () => {},
      reconnectDelayMs,
      shouldReconnect: () => true,
    });

    const connectPromise = client.ensureConnected();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket?.open();
    await connectPromise;

    vi.setSystemTime(2_000);
    firstSocket?.close(1006);

    await vi.advanceTimersByTimeAsync(10);
    const retrySocket = FakeWebSocket.instances[1];
    expect(retrySocket).toBeDefined();

    vi.setSystemTime(3_000);
    retrySocket?.onerror?.();

    expect(reconnectDelayMs).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({
        hasConnected: true,
        lastDisconnectedAt: 2_000,
        lastDisconnectReason: 'connect-error',
      }),
    );
  });

  it('reports sequenced message gaps after the first processed sequence', async () => {
    const onSequenceGap = vi.fn();
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      onMessage: () => {},
      onSequenceGap,
      shouldReconnect: () => false,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await connectPromise;

    socket?.receive({ type: 'event', seq: 0 });
    socket?.receive({ type: 'event', seq: 2 });

    expect(onSequenceGap).toHaveBeenCalledWith({
      actualSeq: 2,
      expectedSeq: 1,
      previousSeq: 0,
    });
  });

  it('clears stored auth state when the server expires the session', async () => {
    const clearToken = vi.fn();
    const onAuthExpired = vi.fn();

    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      clearToken,
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      onAuthExpired,
      onMessage: () => {},
      shouldReconnect: () => true,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await connectPromise;

    socket?.close(4001);

    expect(clearToken).toHaveBeenCalledTimes(1);
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(client.getState()).toBe('auth-expired');
  });

  it('reports explicit auth-expired disconnects with the auth-expired reason', async () => {
    const onDisconnect = vi.fn();
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      onDisconnect,
      onMessage: () => {},
      shouldReconnect: () => false,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await connectPromise;

    client.disconnect('auth-expired');

    expect(client.getState()).toBe('auth-expired');
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ reason: 'auth-expired' }));
  });

  it('does not reconnect after disconnect if demand disappears before the retry fires', async () => {
    vi.useFakeTimers();

    let keepAlive = true;
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      onMessage: () => {},
      shouldReconnect: () => keepAlive,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await connectPromise;

    socket?.close(1006);
    keepAlive = false;

    await vi.advanceTimersByTimeAsync(250);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.getState()).toBe('disconnected');
  });

  it('schedules a reconnect when the initial socket errors before opening', async () => {
    vi.useFakeTimers();

    const states: WebSocketConnectionState[] = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      onMessage: () => {},
      onStateChange: (state) => {
        states.push(state);
      },
      reconnectDelayMs: () => 10,
      shouldReconnect: () => true,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.onerror?.();

    await expect(connectPromise).rejects.toThrow('WebSocket connection failed');
    expect(client.getState()).toBe('disconnected');

    await vi.advanceTimersByTimeAsync(10);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(client.getState()).toBe('reconnecting');
    expect(states).toEqual(['connecting', 'disconnected', 'reconnecting']);
  });

  it('rejects and schedules a reconnect when the initial socket closes before opening', async () => {
    vi.useFakeTimers();

    const states: WebSocketConnectionState[] = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      onMessage: () => {},
      onStateChange: (state) => {
        states.push(state);
      },
      reconnectDelayMs: () => 10,
      shouldReconnect: () => true,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.close(1006);

    await expect(connectPromise).rejects.toThrow('WebSocket closed before opening');
    expect(client.hasPendingConnection()).toBe(false);
    expect(client.getState()).toBe('disconnected');

    await vi.advanceTimersByTimeAsync(10);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(client.getState()).toBe('reconnecting');
    expect(states).toEqual(['connecting', 'disconnected', 'reconnecting']);
  });

  it('rejects an initial auth-expired close before opening without reconnecting', async () => {
    vi.useFakeTimers();

    const clearToken = vi.fn();
    const onAuthExpired = vi.fn();
    const states: WebSocketConnectionState[] = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      clearToken,
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      onAuthExpired,
      onMessage: () => {},
      onStateChange: (state) => {
        states.push(state);
      },
      reconnectDelayMs: () => 10,
      shouldReconnect: () => true,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.close(4001);

    await expect(connectPromise).rejects.toThrow('Session expired');
    expect(clearToken).toHaveBeenCalledTimes(1);
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(client.hasPendingConnection()).toBe(false);
    expect(client.getState()).toBe('auth-expired');

    await vi.advanceTimersByTimeAsync(10);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(states).toEqual(['connecting', 'auth-expired']);
  });

  it('schedules a reconnect when the initial auth send fails', async () => {
    vi.useFakeTimers();

    const states: WebSocketConnectionState[] = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      onMessage: () => {},
      onStateChange: (state) => {
        states.push(state);
      },
      reconnectDelayMs: () => 10,
      shouldReconnect: () => true,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    if (socket) {
      socket.send = () => {
        throw new Error('send failed');
      };
    }
    socket?.open();

    await expect(connectPromise).rejects.toThrow('WebSocket authentication failed');
    expect(client.getState()).toBe('disconnected');
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);

    await vi.advanceTimersByTimeAsync(10);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(client.getState()).toBe('reconnecting');
    expect(states).toEqual(['connecting', 'disconnected', 'reconnecting']);
  });

  it('ignores stale close events after a disconnect-reconnect overlap', async () => {
    const states: WebSocketConnectionState[] = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      onMessage: () => {},
      onStateChange: (state) => {
        states.push(state);
      },
      shouldReconnect: () => true,
    });

    const firstConnect = client.ensureConnected();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket?.open();
    await firstConnect;

    if (!firstSocket) {
      throw new Error('Expected first socket');
    }

    firstSocket.close = () => {
      firstSocket.readyState = FakeWebSocket.CLOSING;
    };

    client.disconnect();
    expect(client.getState()).toBe('disconnected');

    const secondConnect = client.ensureConnected();
    await Promise.resolve();
    const secondSocket = FakeWebSocket.instances[1];
    if (!secondSocket) {
      throw new Error('Expected second socket');
    }
    secondSocket?.open();
    await secondConnect;

    firstSocket.readyState = FakeWebSocket.CLOSED;
    firstSocket.onclose?.({ code: 1000 } as CloseEvent);

    expect(client.getState()).toBe('connected');
    expect(states[states.length - 1]).toBe('connected');
    expect(secondSocket.sent[0]).toEqual({ type: 'auth' });
  });

  it('rejects an in-flight connect when disconnected before the socket opens', async () => {
    const states: WebSocketConnectionState[] = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      onMessage: () => {},
      onStateChange: (state) => {
        states.push(state);
      },
      shouldReconnect: () => true,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];

    client.disconnect();

    await expect(connectPromise).rejects.toThrow('WebSocket connection cancelled');
    expect(client.getState()).toBe('disconnected');
    expect(client.hasPendingConnection()).toBe(false);

    socket?.open();

    expect(client.getState()).toBe('disconnected');
    expect(states).toEqual(['connecting', 'disconnected']);
  });

  it('resets connection metadata for a clean test reconnect', async () => {
    const requestedLastSeqValues: number[] = [];
    const states: WebSocketConnectionState[] = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: ({ lastSeq }) => ({ type: 'auth', lastSeq }),
      getClientId: () => 'client-1',
      getSocketUrl: ({ lastSeq }) => {
        requestedLastSeqValues.push(lastSeq);
        return 'ws://localhost/ws';
      },
      getToken: () => 'token-1',
      onMessage: () => {},
      onStateChange: (state) => {
        states.push(state);
      },
      shouldReconnect: () => true,
    });

    const firstConnect = client.ensureConnected();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket?.open();
    await firstConnect;
    firstSocket?.receive({ type: 'agents', seq: 7 });

    expect(client.getLastSeq()).toBe(7);

    client.resetForTests();

    expect(client.getLastSeq()).toBe(-1);
    expect(client.getState()).toBe('disconnected');

    const secondConnect = client.ensureConnected();
    const secondSocket = FakeWebSocket.instances[1];
    secondSocket?.open();
    await secondConnect;

    expect(requestedLastSeqValues).toEqual([-1, -1]);
    expect(secondSocket?.sent[0]).toEqual({ type: 'auth', lastSeq: -1 });
    expect(states).toEqual(['connecting', 'connected', 'disconnected', 'connecting', 'connected']);
  });

  it('surfaces missing tokens without opening a socket', async () => {
    const onMissingToken = vi.fn();
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createAuthMessage: () => ({ type: 'auth' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => null,
      onMessage: () => {},
      onMissingToken,
      shouldReconnect: () => true,
    });

    await expect(client.ensureConnected()).rejects.toThrow('Missing auth token');
    expect(onMissingToken).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe('wake liveness probe and control-replay-batch', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useRealTimers();
    FakeWebSocket.reset();
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FakeWebSocket,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: originalWebSocket,
    });
  });

  async function createConnectedProbeClient(
    options: {
      onDisconnect?: (event: { reason: string }) => void;
      onReconnectScheduled?: (event: { attempt: number; delayMs: number }) => void;
      reconnectDelayMs?: () => number;
    } = {},
  ): Promise<{
    client: ReturnType<typeof createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>>;
    socket: FakeWebSocket;
  }> {
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createPingMessage: () => ({ type: 'ping' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      isPongMessage: (message) => message.type === 'pong',
      onMessage: () => {},
      ...(options.onDisconnect ? { onDisconnect: options.onDisconnect } : {}),
      ...(options.onReconnectScheduled
        ? { onReconnectScheduled: options.onReconnectScheduled }
        : {}),
      ...(options.reconnectDelayMs ? { reconnectDelayMs: options.reconnectDelayMs } : {}),
      shouldReconnect: () => true,
    });
    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!socket) {
      throw new Error('Expected a socket instance');
    }
    socket.open();
    await connectPromise;
    return { client, socket };
  }

  it('keeps a live socket open when the probe pong arrives within the deadline', async () => {
    vi.useFakeTimers();
    const { client, socket } = await createConnectedProbeClient();

    client.probeLiveness(2_000);
    expect(socket.sent[socket.sent.length - 1]).toEqual({ type: 'ping' });
    socket.receive({ type: 'pong' });
    vi.advanceTimersByTime(2_500);

    expect(client.getState()).toBe('connected');
    expect(client.isOpen()).toBe(true);
  });

  it('treats any incoming traffic as probe liveness, not only pongs', async () => {
    vi.useFakeTimers();
    const { client, socket } = await createConnectedProbeClient();

    client.probeLiveness(2_000);
    socket.receive({ type: 'agents', seq: 1 });
    vi.advanceTimersByTime(2_500);

    expect(client.getState()).toBe('connected');
  });

  it('force-closes a zombie-OPEN socket on probe miss and schedules a fast reconnect', async () => {
    vi.useFakeTimers();
    const disconnects: string[] = [];
    const scheduled: Array<{ attempt: number; delayMs: number }> = [];
    const { client, socket } = await createConnectedProbeClient({
      onDisconnect: (event) => disconnects.push(event.reason),
      onReconnectScheduled: (event) =>
        scheduled.push({ attempt: event.attempt, delayMs: event.delayMs }),
      reconnectDelayMs: () => 0,
    });

    client.probeLiveness(2_000);
    // The zombie socket never answers; the deadline force-closes it.
    vi.advanceTimersByTime(2_000);

    expect(disconnects).toContain('missed-pong');
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(scheduled[0]).toEqual({ attempt: 0, delayMs: 0 });
  });

  it('no-ops probeLiveness when the socket is not open', () => {
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      createPingMessage: () => ({ type: 'ping' }),
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      onMessage: () => {},
      shouldReconnect: () => false,
    });

    expect(() => client.probeLiveness(2_000)).not.toThrow();
    expect(client.getState()).toBe('disconnected');
  });

  it('adopts control-replay-batch toSeq wholesale and dispatches inner events without gap flags', async () => {
    const received: TestIncomingMessage[] = [];
    const gaps: unknown[] = [];
    const batches: Array<{ eventCount: number; toSeq: number }> = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      onMessage: (message) => received.push(message),
      onReplayBatch: (event) => batches.push(event),
      onSequenceGap: (event) => gaps.push(event),
      shouldReconnect: () => true,
    });
    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await connectPromise;

    // Compaction makes inner seqs non-contiguous (3 then 7): no gap callback
    // may fire, and lastSeq lands on toSeq.
    socket?.receiveRaw(
      JSON.stringify({
        type: 'control-replay-batch',
        toSeq: 9,
        events: [
          { type: 'agents', seq: 3 },
          { type: 'status', seq: 7 },
        ],
      }),
    );

    expect(batches).toEqual([{ eventCount: 2, toSeq: 9 }]);
    expect(received).toEqual([
      { type: 'agents', seq: 3 },
      { type: 'status', seq: 7 },
    ]);
    expect(gaps).toEqual([]);
    expect(client.getLastSeq()).toBe(9);

    // The next live event at toSeq + 1 is contiguous, not a gap.
    socket?.receive({ type: 'agents', seq: 10 });
    expect(gaps).toEqual([]);
    expect(client.getLastSeq()).toBe(10);
  });

  it('adopts the replay-truncated latestSeq so the following live stream is not a gap', async () => {
    const received: TestIncomingMessage[] = [];
    const gaps: unknown[] = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      onMessage: (message) => received.push(message),
      onSequenceGap: (event) => gaps.push(event),
      shouldReconnect: () => true,
    });
    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await connectPromise;
    socket?.receive({ type: 'agents', seq: 2 });
    expect(client.getLastSeq()).toBe(2);

    // A compacted/evicted window cannot be per-event replayed; the server
    // degrades to replay-truncated and the core adopts latestSeq wholesale —
    // otherwise the first live event after the handshake would misfire gap
    // detection (the remote shell answers gaps with a hard reconnect, and its
    // own churn re-compacts the window, looping forever).
    socket?.receiveRaw(
      JSON.stringify({
        type: 'replay-truncated',
        lastSeq: 2,
        latestSeq: 9,
        oldestAvailableSeq: 5,
      }),
    );
    expect(client.getLastSeq()).toBe(9);
    // The message still reaches transport consumers for truncation tracking.
    expect(received.some((message) => message.type === 'replay-truncated')).toBe(true);

    socket?.receive({ type: 'agents', seq: 10 });
    expect(gaps).toEqual([]);
    expect(client.getLastSeq()).toBe(10);
  });

  it('marks the connection sequenced from an empty batch frame', async () => {
    const batches: Array<{ eventCount: number; toSeq: number }> = [];
    const client = createWebSocketClientCore<TestIncomingMessage, TestOutgoingMessage>({
      getClientId: () => 'client-1',
      getSocketUrl: () => 'ws://localhost/ws',
      onMessage: () => {},
      onReplayBatch: (event) => batches.push(event),
      shouldReconnect: () => true,
    });
    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await connectPromise;

    socket?.receiveRaw(JSON.stringify({ type: 'control-replay-batch', toSeq: 4, events: [] }));

    expect(batches).toEqual([{ eventCount: 0, toSeq: 4 }]);
    expect(client.getLastSeq()).toBe(4);
  });
});
