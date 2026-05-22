import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { WebSocketTransport } from '../electron/remote/ws-transport.js';
import type {
  BrowserWebSocketServer,
  RegisterBrowserWebSocketServerOptions,
} from './browser-websocket.js';

const {
  canResizeTaskTerminalMock,
  getAgentColsMock,
  getAgentScrollbackMock,
  getAgentTerminalRecoveryMock,
  getAgentTerminalStartupRecoveryMock,
  onPtyEventMock,
  recordTerminalInputTraceClientDisconnectedMock,
  subscribeToAgentMock,
  writeToAgentMock,
} = vi.hoisted(() => ({
  canResizeTaskTerminalMock: vi.fn(() => true),
  getAgentColsMock: vi.fn<() => number>(() => 80),
  getAgentScrollbackMock: vi.fn<() => string | null>(() => null),
  getAgentTerminalRecoveryMock: vi.fn(),
  getAgentTerminalStartupRecoveryMock: vi.fn(),
  onPtyEventMock: vi.fn(() => () => {}),
  recordTerminalInputTraceClientDisconnectedMock: vi.fn(),
  subscribeToAgentMock: vi.fn<(agentId: string, callback: (data: string) => void) => boolean>(
    () => false,
  ),
  writeToAgentMock: vi.fn(),
}));

const AGENT_INPUT_MESSAGE = JSON.stringify({
  agentId: 'agent-1',
  controllerId: 'client-1',
  data: 'pwd\\n',
  requestId: 'request-1',
  taskId: 'task-1',
  type: 'input',
});

vi.mock('../electron/ipc/pty.js', () => ({
  getAgentCols: getAgentColsMock,
  getAgentMeta: vi.fn(() => null),
  getAgentPauseState: vi.fn(() => null),
  getAgentScrollback: getAgentScrollbackMock,
  getAgentTerminalRecovery: getAgentTerminalRecoveryMock,
  getAgentTerminalStartupRecovery: getAgentTerminalStartupRecoveryMock,
  hasAgentSession: vi.fn(() => true),
  killAgent: vi.fn(),
  onPtyEvent: onPtyEventMock,
  pauseAgent: vi.fn(),
  resizeAgent: vi.fn(),
  resumeAgent: vi.fn(),
  subscribeToAgent: subscribeToAgentMock,
  unsubscribeFromAgent: vi.fn(),
  writeToAgent: writeToAgentMock,
}));

vi.mock('../electron/ipc/task-command-leases.js', () => ({
  canResizeTaskTerminal: canResizeTaskTerminalMock,
}));

vi.mock('../electron/ipc/runtime-diagnostics.js', () => ({
  recordTerminalInputTraceClientDisconnected: recordTerminalInputTraceClientDisconnectedMock,
  recordTerminalInputTraceClientUpdate: vi.fn(),
  recordTerminalInputTraceCommandResultSent: vi.fn(),
  recordTerminalInputTraceFailure: vi.fn(),
  recordTerminalInputTraceServerReceived: vi.fn(),
}));

type FakeClient = WebSocket &
  EventEmitter & {
    _socket?: {
      setNoDelay: ReturnType<typeof vi.fn>;
    };
    readyState: WebSocket['readyState'];
  };

function createFakeClient(): FakeClient {
  const emitter = new EventEmitter();
  const client = emitter as FakeClient;
  client._socket = {
    setNoDelay: vi.fn(),
  };
  client.readyState = WebSocket.OPEN;
  client.close = vi.fn();
  return client;
}

function createFakeWebSocketServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true });
}

function createTestTransport(
  overrides: Partial<WebSocketTransport<WebSocket>> = {},
): WebSocketTransport<WebSocket> {
  return {
    authenticateClient: vi.fn(
      (_client, clientId = 'client-1') => ({ ok: true, clientId }) as const,
    ),
    broadcast: vi.fn(),
    broadcastControl: vi.fn(),
    cleanupClient: vi.fn(),
    claimAgentControl: vi.fn(() => ({ ok: true, controllerId: 'client-1' }) as const),
    getAgentControllerId: vi.fn(() => null),
    getAuthenticatedClientCount: vi.fn(() => 1),
    getClientId: vi.fn(() => 'client-1'),
    getLatestControlEventSeq: vi.fn(() => 0),
    hasClientId: vi.fn(() => true),
    isAuthenticated: vi.fn(() => true),
    notePong: vi.fn(),
    releaseAgentControl: vi.fn(),
    replayControlEvents: vi.fn(),
    scheduleAuthTimeout: vi.fn(),
    sendAgentControllers: vi.fn(),
    sendMessage: vi.fn(() => ({ ok: true }) as const),
    sendToClientId: vi.fn(() => true),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    ...overrides,
  };
}

function createTestChannels(): RegisterBrowserWebSocketServerOptions['channels'] {
  return {
    bindChannel: vi.fn(),
    cleanup: vi.fn(),
    cleanupClient: vi.fn(),
    sendChannelMessage: vi.fn(),
    unbindChannel: vi.fn(),
  };
}

function createRegisterOptions(
  overrides: Partial<RegisterBrowserWebSocketServerOptions> &
    Pick<RegisterBrowserWebSocketServerOptions, 'wss'>,
): RegisterBrowserWebSocketServerOptions {
  return {
    authenticateConnection: vi.fn(() => true),
    broadcastRemoteStatus: vi.fn(),
    channels: createTestChannels(),
    cleanupClientState: vi.fn(),
    isAllowedBrowserOrigin: vi.fn(() => true),
    isAuthorizedRequest: vi.fn(() => true),
    requestTaskCommandTakeover: vi.fn(),
    respondTaskCommandTakeover: vi.fn(),
    safeCompareToken: vi.fn(() => true),
    sendAgentError: vi.fn(),
    sendMessage: vi.fn(() => true),
    transport: createTestTransport(),
    updatePeerPresence: vi.fn(),
    ...overrides,
  };
}

interface ClientIdTracking {
  authenticateConnection: RegisterBrowserWebSocketServerOptions['authenticateConnection'];
  clientIds: Map<WebSocket, string>;
  transport: WebSocketTransport<WebSocket>;
}

function createClientIdTracking(): ClientIdTracking {
  const clientIds = new Map<WebSocket, string>();
  return {
    authenticateConnection: vi.fn((client: WebSocket, clientId?: string) => {
      if (clientId) {
        clientIds.set(client, clientId);
      }
      return true;
    }),
    clientIds,
    transport: createTestTransport({
      getAuthenticatedClientCount: vi.fn(() => clientIds.size),
      getClientId: vi.fn((client) => clientIds.get(client) ?? null),
      hasClientId: vi.fn((clientId) =>
        Array.from(clientIds.values()).some((currentId) => currentId === clientId),
      ),
    }),
  };
}

function cleanupTrackedClient(
  tracking: ClientIdTracking,
  browserSocketServer: BrowserWebSocketServer | null,
  currentClient: FakeClient,
): void {
  const clientId = tracking.clientIds.get(currentClient) ?? null;
  browserSocketServer?.cleanupClient(currentClient);
  tracking.clientIds.delete(currentClient);
  if (clientId && !Array.from(tracking.clientIds.values()).includes(clientId)) {
    browserSocketServer?.pruneDisconnectedAgentCommandResults();
  }
}

describe('registerBrowserWebSocketServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentColsMock.mockReturnValue(80);
    getAgentScrollbackMock.mockReturnValue(null);
    getAgentTerminalRecoveryMock.mockReturnValue({
      cols: 100,
      data: Buffer.from('browser recovery', 'utf8'),
      kind: 'snapshot',
      outputCursor: 16,
      rows: 30,
    });
    getAgentTerminalStartupRecoveryMock.mockResolvedValue({
      cols: 100,
      data: Buffer.from('browser startup recovery', 'utf8'),
      kind: 'terminal-state',
      outputCursor: 24,
      rows: 30,
    });
    subscribeToAgentMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes websocket close through the composed client cleanup path', async () => {
    const { registerBrowserWebSocketServer } = await import('./browser-websocket.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    let browserSocketServer: BrowserWebSocketServer | null = null;
    const cleanupClientState = vi.fn((currentClient: FakeClient) => {
      browserSocketServer?.cleanupClient(currentClient);
    });

    browserSocketServer = registerBrowserWebSocketServer(
      createRegisterOptions({
        cleanupClientState,
        wss,
      }),
    );

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit('close');

    expect(cleanupClientState).toHaveBeenCalledTimes(1);
    expect(cleanupClientState).toHaveBeenCalledWith(client);
    expect(recordTerminalInputTraceClientDisconnectedMock).toHaveBeenCalledTimes(1);
    expect(recordTerminalInputTraceClientDisconnectedMock).toHaveBeenCalledWith('client-1');
  });

  it('enables TCP no-delay on browser websocket connections', async () => {
    const { registerBrowserWebSocketServer } = await import('./browser-websocket.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);

    registerBrowserWebSocketServer(
      createRegisterOptions({
        wss,
      }),
    );

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    expect(client._socket?.setNoDelay).toHaveBeenCalledWith(true);
  });

  it('ignores invalid websocket URL replay cursors before authenticating', async () => {
    const { registerBrowserWebSocketServer } = await import('./browser-websocket.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    const authenticateConnection = vi.fn(() => true);
    wss.clients.add(client);

    registerBrowserWebSocketServer(
      createRegisterOptions({
        authenticateConnection,
        wss,
      }),
    );

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good&clientId=client-1&lastSeq=-2',
    });

    expect(authenticateConnection).toHaveBeenCalledWith(client, 'client-1', undefined);
  });

  it('serves terminal recovery requests over the browser websocket control plane', async () => {
    const { registerBrowserWebSocketServer } = await import('./browser-websocket.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    const sendMessage = vi.fn(() => true);
    wss.clients.add(client);

    registerBrowserWebSocketServer(
      createRegisterOptions({
        sendMessage,
        wss,
      }),
    );

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit(
      'message',
      JSON.stringify({
        agentId: 'agent-1',
        outputCursor: 10,
        renderedTail: Buffer.from('tail', 'utf8').toString('base64'),
        requestId: 'recovery-1',
        snapshotByteLimit: 4096,
        type: 'terminal-recovery-request',
      }),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(getAgentTerminalRecoveryMock).toHaveBeenCalledWith(
      'agent-1',
      Buffer.from('tail', 'utf8'),
      10,
      4096,
    );
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'terminal-recovery-result',
      entry: {
        agentId: 'agent-1',
        cols: 100,
        outputCursor: 16,
        recovery: {
          data: Buffer.from('browser recovery', 'utf8').toString('base64'),
          kind: 'snapshot',
        },
        requestId: 'recovery-1',
        rows: 30,
      },
    });
  });

  it('honors structured terminal subscriptions on the browser websocket control plane', async () => {
    const { registerBrowserWebSocketServer } = await import('./browser-websocket.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    const sendMessage = vi.fn(() => true);
    let outputCallback: ((data: string) => void) | undefined;
    getAgentColsMock.mockReturnValue(100);
    getAgentScrollbackMock.mockReturnValue(
      Buffer.from('legacy scrollback', 'utf8').toString('base64'),
    );
    subscribeToAgentMock.mockImplementation((_agentId, callback) => {
      outputCallback = callback;
      return true;
    });
    wss.clients.add(client);

    registerBrowserWebSocketServer(
      createRegisterOptions({
        sendMessage,
        wss,
      }),
    );

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'subscribe',
        agentId: 'agent-1',
        terminalProtocol: 'structured',
      }),
    );

    const data = Buffer.from('structured browser output', 'utf8').toString('base64');
    if (outputCallback === undefined) {
      throw new Error('Expected structured subscription callback');
    }
    outputCallback(data);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'terminal-stream',
      agentId: 'agent-1',
      event: {
        type: 'Data',
        data,
      },
    });
    expect(sendMessage).not.toHaveBeenCalledWith(
      client,
      expect.objectContaining({ type: 'scrollback' }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      client,
      expect.objectContaining({ type: 'output' }),
    );
  });

  it('ignores malformed websocket URLs before authenticating', async () => {
    const { registerBrowserWebSocketServer } = await import('./browser-websocket.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    const authenticateConnection = vi.fn(() => true);
    wss.clients.add(client);

    registerBrowserWebSocketServer(
      createRegisterOptions({
        authenticateConnection,
        wss,
      }),
    );

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: 'http://%',
    });

    expect(authenticateConnection).toHaveBeenCalledWith(client, undefined, undefined);
  });

  it('dedupes cached agent command results across reconnect with the same client id', async () => {
    const { registerBrowserWebSocketServer } = await import('./browser-websocket.js');
    const wss = createFakeWebSocketServer();
    const sendMessage = vi.fn(() => true);
    const tracking = createClientIdTracking();
    let browserSocketServer: BrowserWebSocketServer | null = null;
    const cleanupClientState = vi.fn((currentClient: FakeClient) => {
      cleanupTrackedClient(tracking, browserSocketServer, currentClient);
    });

    browserSocketServer = registerBrowserWebSocketServer(
      createRegisterOptions({
        authenticateConnection: tracking.authenticateConnection,
        cleanupClientState,
        sendMessage,
        transport: tracking.transport,
        wss,
      }),
    );

    const firstClient = createFakeClient();
    wss.clients.add(firstClient);
    wss.emit('connection', firstClient, {
      headers: { host: 'localhost' },
      url: '/?token=good&clientId=client-1&lastSeq=-1',
    });

    firstClient.emit('message', AGENT_INPUT_MESSAGE);
    firstClient.emit('message', AGENT_INPUT_MESSAGE);

    expect(writeToAgentMock).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    firstClient.emit('close');

    const secondClient = createFakeClient();
    wss.clients.add(secondClient);
    wss.emit('connection', secondClient, {
      headers: { host: 'localhost' },
      url: '/?token=good&clientId=client-1&lastSeq=-1',
    });

    secondClient.emit('message', AGENT_INPUT_MESSAGE);

    expect(writeToAgentMock).toHaveBeenCalledTimes(1);
    expect(cleanupClientState).toHaveBeenCalledWith(firstClient);

    secondClient.emit('close');

    const thirdClient = createFakeClient();
    wss.clients.add(thirdClient);
    wss.emit('connection', thirdClient, {
      headers: { host: 'localhost' },
      url: '/?token=good&clientId=client-1&lastSeq=-1',
    });

    thirdClient.emit('message', AGENT_INPUT_MESSAGE);

    expect(writeToAgentMock).toHaveBeenCalledTimes(1);
  });

  it('self-prunes expired cached agent command results after the last disconnect', async () => {
    vi.useFakeTimers();
    try {
      const { registerBrowserWebSocketServer } = await import('./browser-websocket.js');
      const wss = createFakeWebSocketServer();
      const sendMessage = vi.fn(() => true);
      const tracking = createClientIdTracking();
      let browserSocketServer: BrowserWebSocketServer | null = null;
      const cleanupClientState = vi.fn((currentClient: FakeClient) => {
        cleanupTrackedClient(tracking, browserSocketServer, currentClient);
      });

      browserSocketServer = registerBrowserWebSocketServer(
        createRegisterOptions({
          authenticateConnection: tracking.authenticateConnection,
          cleanupClientState,
          sendMessage,
          transport: tracking.transport,
          wss,
        }),
      );

      const client = createFakeClient();
      wss.clients.add(client);
      wss.emit('connection', client, {
        headers: { host: 'localhost' },
        url: '/?token=good&clientId=client-1&lastSeq=-1',
      });

      client.emit('message', AGENT_INPUT_MESSAGE);
      expect(writeToAgentMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      client.emit('close');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears cached agent command result timers during websocket cleanup', async () => {
    vi.useFakeTimers();
    try {
      const { registerBrowserWebSocketServer } = await import('./browser-websocket.js');
      const wss = createFakeWebSocketServer();
      const tracking = createClientIdTracking();
      const browserSocketServer = registerBrowserWebSocketServer(
        createRegisterOptions({
          authenticateConnection: tracking.authenticateConnection,
          transport: tracking.transport,
          wss,
        }),
      );
      const client = createFakeClient();

      wss.clients.add(client);
      wss.emit('connection', client, {
        headers: { host: 'localhost' },
        url: '/?token=good&clientId=client-1&lastSeq=-1',
      });
      client.emit('message', AGENT_INPUT_MESSAGE);

      expect(vi.getTimerCount()).toBeGreaterThan(0);

      browserSocketServer.cleanup();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
