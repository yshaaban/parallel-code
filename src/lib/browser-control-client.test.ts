// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientMessage,
  ReplayTruncatedMessage,
  ServerMessage,
} from '../../electron/remote/protocol';
import type { BrowserControlClient } from './browser-control-client';
import type {
  CreateWebSocketClientCoreOptions,
  WebSocketClientCore,
  WebSocketDisconnectEvent,
} from './websocket-client';

const websocketState = vi.hoisted(() => ({
  ensureConnectedMock: vi.fn(async () => ({}) as WebSocket),
  options: null as CreateWebSocketClientCoreOptions<
    ServerMessage | ReplayTruncatedMessage,
    ClientMessage
  > | null,
}));

vi.mock('./websocket-client', () => ({
  createWebSocketClientCore: vi.fn(
    (
      options: CreateWebSocketClientCoreOptions<
        ServerMessage | ReplayTruncatedMessage,
        ClientMessage
      >,
    ): WebSocketClientCore<ClientMessage> => {
      websocketState.options = options;
      return {
        disconnect: vi.fn(),
        ensureConnected: websocketState.ensureConnectedMock,
        getBufferedAmount: () => 0,
        getLastRttMs: () => null,
        getLastSeq: () => -1,
        getState: () => 'disconnected',
        hasPendingConnection: () => false,
        isOpen: () => false,
        resetForTests: vi.fn(),
        send: vi.fn(async () => {}),
        sendIfOpen: vi.fn(() => true),
      };
    },
  ),
}));

async function loadBrowserControlClient(): Promise<{
  client: BrowserControlClient;
  options: CreateWebSocketClientCoreOptions<ServerMessage | ReplayTruncatedMessage, ClientMessage>;
}> {
  vi.resetModules();
  websocketState.ensureConnectedMock.mockReset();
  websocketState.ensureConnectedMock.mockResolvedValue({} as WebSocket);
  websocketState.options = null;

  const { createBrowserControlClient } = await import('./browser-control-client');
  const client = createBrowserControlClient({
    getClientId: () => 'browser-client-1',
    hasChannelBindings: () => false,
    onAuthExpired: vi.fn(),
  });
  const options = websocketState.options;
  if (!options) {
    throw new Error('websocket options were not captured');
  }

  return { client, options };
}

function createDisconnectEvent(
  overrides: Partial<WebSocketDisconnectEvent> = {},
): WebSocketDisconnectEvent {
  return {
    hasConnected: true,
    lastConnectedAt: 0,
    lastConnectionDurationMs: 1_000,
    lastDisconnectedAt: 1_000,
    lastDisconnectReason: 'close',
    lastRttMs: null,
    reason: 'close',
    ...overrides,
  };
}

describe('browser control client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits structured terminal stream and recovery result messages to listeners', async () => {
    const { client, options } = await loadBrowserControlClient();
    const terminalStreamListener = vi.fn();
    const terminalRecoveryListener = vi.fn();

    const cleanupStream = client.listenMessage('terminal-stream', terminalStreamListener);
    const cleanupRecovery = client.listenMessage(
      'terminal-recovery-result',
      terminalRecoveryListener,
    );

    const streamMessage: ServerMessage = {
      type: 'terminal-stream',
      agentId: 'agent-1',
      event: {
        type: 'Data',
        data: Buffer.from('ready', 'utf8').toString('base64'),
      },
    };
    const recoveryMessage: ServerMessage = {
      type: 'terminal-recovery-result',
      entry: {
        agentId: 'agent-1',
        cols: 80,
        outputCursor: 5,
        recovery: {
          data: Buffer.from('state', 'utf8').toString('base64'),
          kind: 'terminal-state',
        },
        requestId: 'recovery-1',
        rows: 24,
      },
    };

    options.onMessage(streamMessage);
    options.onMessage(recoveryMessage);

    expect(terminalStreamListener).toHaveBeenCalledWith(streamMessage);
    expect(terminalRecoveryListener).toHaveBeenCalledWith(recoveryMessage);

    cleanupStream();
    cleanupRecovery();
  });

  it('emits coordinator events to persistent browser message listeners', async () => {
    const { client, options } = await loadBrowserControlClient();
    const listener = vi.fn();
    const cleanup = client.listenMessage('coordinator-event', listener, {
      preserveOnReset: true,
    });
    const message: ServerMessage = {
      type: 'coordinator-event',
      event: {
        categorySeq: 1,
        createdAt: 1_000,
        entityKey: 'run:run-1',
        entityVersion: 1,
        eventType: 'run-removed',
        payload: null,
        runId: 'run-1',
        tombstone: true,
      },
    };

    options.onMessage(message);

    expect(listener).toHaveBeenCalledWith(message);

    cleanup();
  });

  it('freezes the disconnected duration once the reconnect reaches connected state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { client, options } = await loadBrowserControlClient();

    options.onDisconnect?.(createDisconnectEvent());

    vi.setSystemTime(1_250);
    expect(client.getLastDisconnectDurationMs()).toBe(250);

    options.onStateChange?.('connected');
    vi.setSystemTime(5_000);

    expect(client.getLastDisconnectDurationMs()).toBe(250);
  });

  it('does not expose warm reconnect continuity for failed cold connection attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { client, options } = await loadBrowserControlClient();

    options.onDisconnect?.(
      createDisconnectEvent({
        hasConnected: false,
        lastConnectedAt: null,
        lastConnectionDurationMs: null,
        lastDisconnectReason: 'connect-error',
        reason: 'connect-error',
      }),
    );
    vi.setSystemTime(1_250);

    expect(client.getLastDisconnectDurationMs()).toBeNull();
  });

  it('tracks whether sequenced control replay has arrived after a disconnect', async () => {
    const { client, options } = await loadBrowserControlClient();

    options.onDisconnect?.(createDisconnectEvent());

    expect(client.hasSequencedMessageSinceDisconnect()).toBe(false);

    options.onMessage({
      type: 'remote-status',
      connectedClients: 1,
      peerClients: 0,
      seq: 3,
    });

    expect(client.hasSequencedMessageSinceDisconnect()).toBe(true);
  });

  it('tracks replay truncation separately from numeric sequence gaps', async () => {
    const { client, options } = await loadBrowserControlClient();

    options.onDisconnect?.(createDisconnectEvent());

    expect(client.hasReplayTruncatedSinceDisconnect()).toBe(false);
    expect(client.hasSequenceGapSinceDisconnect()).toBe(false);

    options.onMessage({
      type: 'replay-truncated',
      lastSeq: 2,
      latestSeq: 8,
      oldestAvailableSeq: 5,
    });

    expect(client.hasReplayTruncatedSinceDisconnect()).toBe(true);
    expect(client.hasSequenceGapSinceDisconnect()).toBe(false);
    expect(client.hasSequencedMessageSinceDisconnect()).toBe(false);

    options.onDisconnect?.(createDisconnectEvent());

    expect(client.hasReplayTruncatedSinceDisconnect()).toBe(false);
  });
});
