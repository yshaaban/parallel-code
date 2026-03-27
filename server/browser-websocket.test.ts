import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const {
  canResizeTaskTerminalMock,
  recordTerminalInputTraceClientDisconnectedMock,
  writeToAgentMock,
} = vi.hoisted(() => ({
  canResizeTaskTerminalMock: vi.fn(() => true),
  recordTerminalInputTraceClientDisconnectedMock: vi.fn(),
  writeToAgentMock: vi.fn(),
}));

vi.mock('../electron/ipc/pty.js', () => ({
  getAgentCols: vi.fn(() => 80),
  getAgentMeta: vi.fn(() => null),
  getAgentScrollback: vi.fn(() => null),
  killAgent: vi.fn(),
  pauseAgent: vi.fn(),
  resizeAgent: vi.fn(),
  resumeAgent: vi.fn(),
  subscribeToAgent: vi.fn(() => false),
  unsubscribeFromAgent: vi.fn(),
  writeToAgent: writeToAgentMock,
}));

vi.mock('../electron/ipc/task-command-leases.js', () => ({
  canResizeTaskTerminal: canResizeTaskTerminalMock,
}));

vi.mock('../electron/ipc/runtime-diagnostics.js', () => ({
  recordTerminalInputTraceClientDisconnected: recordTerminalInputTraceClientDisconnectedMock,
  recordTerminalInputTraceClientUpdate: vi.fn(),
  recordTerminalInputTraceFailure: vi.fn(),
  recordTerminalInputTraceServerReceived: vi.fn(),
}));

type FakeClient = WebSocket &
  EventEmitter & {
    readyState: WebSocket['readyState'];
  };

interface FakeWebSocketServer extends EventEmitter {
  clients: Set<FakeClient>;
}

function createFakeClient(): FakeClient {
  const emitter = new EventEmitter();
  const client = emitter as FakeClient;
  client.readyState = WebSocket.OPEN;
  client.close = vi.fn();
  return client;
}

function createFakeWebSocketServer(): FakeWebSocketServer {
  const server = new EventEmitter() as FakeWebSocketServer;
  server.clients = new Set();
  return server;
}

describe('registerBrowserWebSocketServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes websocket close through the composed client cleanup path', async () => {
    const { registerBrowserWebSocketServer } = await import('./browser-websocket.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    let browserSocketServer: {
      cleanupClient: (currentClient: FakeClient) => void;
      pruneDisconnectedAgentCommandResults: () => void;
    } | null = null;
    const cleanupClientState = vi.fn((currentClient: FakeClient) => {
      browserSocketServer?.cleanupClient(currentClient);
    });

    browserSocketServer = registerBrowserWebSocketServer({
      authenticateConnection: vi.fn(() => true),
      broadcastRemoteStatus: vi.fn(),
      channels: {
        bindChannel: vi.fn(),
        cleanup: vi.fn(),
        cleanupClient: vi.fn(),
        sendChannelMessage: vi.fn(),
        unbindChannel: vi.fn(),
      },
      cleanupClientState,
      isAllowedBrowserOrigin: vi.fn(() => true),
      isAuthorizedRequest: vi.fn(() => true),
      requestTaskCommandTakeover: vi.fn(),
      respondTaskCommandTakeover: vi.fn(),
      safeCompareToken: vi.fn(() => true),
      sendAgentError: vi.fn(),
      sendMessage: vi.fn(() => true),
      transport: {
        claimAgentControl: vi.fn(() => ({ ok: true, controllerId: 'client-1' })),
        getClientId: vi.fn(() => 'client-1'),
        getClientSocketById: vi.fn(),
        getConnectedClientCount: vi.fn(() => 1),
        getPeerConnectedClientCount: vi.fn(() => 0),
        getPeerPresenceVersion: vi.fn(() => 0),
        getServerInfo: vi.fn(),
        hasClientId: vi.fn(() => true),
        isAuthenticated: vi.fn(() => true),
        notePong: vi.fn(),
        releaseAgentControl: vi.fn(),
        replayControlEvents: vi.fn(),
        scheduleAuthTimeout: vi.fn(),
      } as never,
      updatePeerPresence: vi.fn(),
      wss: wss as never,
    });

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

  it('dedupes cached agent command results across reconnect with the same client id', async () => {
    const { registerBrowserWebSocketServer } = await import('./browser-websocket.js');
    const wss = createFakeWebSocketServer();
    const sendMessage = vi.fn(() => true);
    const clientIds = new Map<FakeClient, string>();
    let browserSocketServer: {
      cleanupClient: (currentClient: FakeClient) => void;
      pruneDisconnectedAgentCommandResults: () => void;
    } | null = null;
    const cleanupClientState = vi.fn((currentClient: FakeClient) => {
      const clientId = clientIds.get(currentClient) ?? null;
      browserSocketServer?.cleanupClient(currentClient);
      clientIds.delete(currentClient);
      if (clientId && !Array.from(clientIds.values()).includes(clientId)) {
        browserSocketServer?.pruneDisconnectedAgentCommandResults();
      }
    });

    browserSocketServer = registerBrowserWebSocketServer({
      authenticateConnection: vi.fn((client: FakeClient, clientId?: string) => {
        if (clientId) {
          clientIds.set(client, clientId);
        }
        return true;
      }),
      broadcastRemoteStatus: vi.fn(),
      channels: {
        bindChannel: vi.fn(),
        cleanup: vi.fn(),
        cleanupClient: vi.fn(),
        sendChannelMessage: vi.fn(),
        unbindChannel: vi.fn(),
      },
      cleanupClientState,
      isAllowedBrowserOrigin: vi.fn(() => true),
      isAuthorizedRequest: vi.fn(() => true),
      requestTaskCommandTakeover: vi.fn(),
      respondTaskCommandTakeover: vi.fn(),
      safeCompareToken: vi.fn(() => true),
      sendAgentError: vi.fn(),
      sendMessage,
      transport: {
        claimAgentControl: vi.fn(() => ({ ok: true, controllerId: 'client-1' })),
        getClientId: vi.fn((client: FakeClient) => clientIds.get(client) ?? null),
        getConnectedClientCount: vi.fn(() => clientIds.size),
        getPeerConnectedClientCount: vi.fn(() => 0),
        getPeerPresenceVersion: vi.fn(() => 0),
        getServerInfo: vi.fn(),
        hasClientId: vi.fn((clientId: string) =>
          Array.from(clientIds.values()).some((currentId) => currentId === clientId),
        ),
        isAuthenticated: vi.fn(() => true),
        notePong: vi.fn(),
        releaseAgentControl: vi.fn(),
        replayControlEvents: vi.fn(),
        scheduleAuthTimeout: vi.fn(),
      } as never,
      updatePeerPresence: vi.fn(),
      wss: wss as never,
    });

    const firstClient = createFakeClient();
    wss.clients.add(firstClient);
    wss.emit('connection', firstClient, {
      headers: { host: 'localhost' },
      url: '/?token=good&clientId=client-1&lastSeq=-1',
    });

    const inputMessage = JSON.stringify({
      agentId: 'agent-1',
      controllerId: 'client-1',
      data: 'pwd\\n',
      requestId: 'request-1',
      taskId: 'task-1',
      type: 'input',
    });

    firstClient.emit('message', inputMessage);
    firstClient.emit('message', inputMessage);

    expect(writeToAgentMock).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    firstClient.emit('close');

    const secondClient = createFakeClient();
    wss.clients.add(secondClient);
    wss.emit('connection', secondClient, {
      headers: { host: 'localhost' },
      url: '/?token=good&clientId=client-1&lastSeq=-1',
    });

    secondClient.emit('message', inputMessage);

    expect(writeToAgentMock).toHaveBeenCalledTimes(1);
    expect(cleanupClientState).toHaveBeenCalledWith(firstClient);

    secondClient.emit('close');

    const thirdClient = createFakeClient();
    wss.clients.add(thirdClient);
    wss.emit('connection', thirdClient, {
      headers: { host: 'localhost' },
      url: '/?token=good&clientId=client-1&lastSeq=-1',
    });

    thirdClient.emit('message', inputMessage);

    expect(writeToAgentMock).toHaveBeenCalledTimes(1);
  });

  it('self-prunes expired cached agent command results after the last disconnect', async () => {
    vi.useFakeTimers();
    try {
      const { registerBrowserWebSocketServer } = await import('./browser-websocket.js');
      const wss = createFakeWebSocketServer();
      const sendMessage = vi.fn(() => true);
      const clientIds = new Map<FakeClient, string>();
      let browserSocketServer: {
        cleanupClient: (currentClient: FakeClient) => void;
        pruneDisconnectedAgentCommandResults: () => void;
      } | null = null;
      const cleanupClientState = vi.fn((currentClient: FakeClient) => {
        const clientId = clientIds.get(currentClient) ?? null;
        browserSocketServer?.cleanupClient(currentClient);
        clientIds.delete(currentClient);
        if (clientId && !Array.from(clientIds.values()).includes(clientId)) {
          browserSocketServer?.pruneDisconnectedAgentCommandResults();
        }
      });

      browserSocketServer = registerBrowserWebSocketServer({
        authenticateConnection: vi.fn((client: FakeClient, clientId?: string) => {
          if (clientId) {
            clientIds.set(client, clientId);
          }
          return true;
        }),
        broadcastRemoteStatus: vi.fn(),
        channels: {
          bindChannel: vi.fn(),
          cleanup: vi.fn(),
          cleanupClient: vi.fn(),
          sendChannelMessage: vi.fn(),
          unbindChannel: vi.fn(),
        },
        cleanupClientState,
        isAllowedBrowserOrigin: vi.fn(() => true),
        isAuthorizedRequest: vi.fn(() => true),
        requestTaskCommandTakeover: vi.fn(),
        respondTaskCommandTakeover: vi.fn(),
        safeCompareToken: vi.fn(() => true),
        sendAgentError: vi.fn(),
        sendMessage,
        transport: {
          claimAgentControl: vi.fn(() => ({ ok: true, controllerId: 'client-1' })),
          getClientId: vi.fn((client: FakeClient) => clientIds.get(client) ?? null),
          getConnectedClientCount: vi.fn(() => clientIds.size),
          getPeerConnectedClientCount: vi.fn(() => 0),
          getPeerPresenceVersion: vi.fn(() => 0),
          getServerInfo: vi.fn(),
          hasClientId: vi.fn((clientId: string) =>
            Array.from(clientIds.values()).some((currentId) => currentId === clientId),
          ),
          isAuthenticated: vi.fn(() => true),
          notePong: vi.fn(),
          releaseAgentControl: vi.fn(),
          replayControlEvents: vi.fn(),
          scheduleAuthTimeout: vi.fn(),
        } as never,
        updatePeerPresence: vi.fn(),
        wss: wss as never,
      });

      const client = createFakeClient();
      wss.clients.add(client);
      wss.emit('connection', client, {
        headers: { host: 'localhost' },
        url: '/?token=good&clientId=client-1&lastSeq=-1',
      });

      const inputMessage = JSON.stringify({
        agentId: 'agent-1',
        controllerId: 'client-1',
        data: 'pwd\\n',
        requestId: 'request-1',
        taskId: 'task-1',
        type: 'input',
      });

      client.emit('message', inputMessage);
      expect(writeToAgentMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      client.emit('close');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
