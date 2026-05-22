// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '../../electron/remote/protocol';
import type { BrowserControlClient } from './browser-control-client';
import type { CreateWebSocketClientCoreOptions, WebSocketClientCore } from './websocket-client';

const websocketState = vi.hoisted(() => ({
  ensureConnectedMock: vi.fn(async () => ({}) as WebSocket),
  options: null as CreateWebSocketClientCoreOptions<ServerMessage, ClientMessage> | null,
}));

vi.mock('./websocket-client', () => ({
  createWebSocketClientCore: vi.fn(
    (
      options: CreateWebSocketClientCoreOptions<ServerMessage, ClientMessage>,
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
  options: CreateWebSocketClientCoreOptions<ServerMessage, ClientMessage>;
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

describe('browser control client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
