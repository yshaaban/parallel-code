import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    this.onmessage?.({
      data: JSON.stringify(message),
    } as MessageEvent<string>);
  }

  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as TestOutgoingMessage);
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
      getSocketUrl: () => 'ws://localhost/ws',
      getToken: () => 'token-1',
      onMessage: (message) => {
        received.push(message);
      },
      shouldReconnect: () => true,
    });

    const connectPromise = client.ensureConnected();
    const socket = FakeWebSocket.instances[0];

    expect(socket?.url).toBe('ws://localhost/ws');

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
