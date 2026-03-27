import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ClaimAgentControlResult } from './ws-transport.js';

const writeToAgentMock = vi.fn();
const recordTerminalInputTraceClientUpdateMock = vi.fn();

vi.mock('../ipc/pty.js', () => ({
  getAgentCols: vi.fn(() => 80),
  getAgentScrollback: vi.fn(() => null),
  killAgent: vi.fn(),
  onPtyEvent: vi.fn(() => () => {}),
  pauseAgent: vi.fn(),
  resizeAgent: vi.fn(),
  resumeAgent: vi.fn(),
  subscribeToAgent: vi.fn(() => false),
  unsubscribeFromAgent: vi.fn(),
  writeToAgent: writeToAgentMock,
}));

vi.mock('../ipc/runtime-diagnostics.js', () => ({
  recordTerminalInputTraceClientUpdate: recordTerminalInputTraceClientUpdateMock,
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

function createClaimAgentControlMock() {
  return vi.fn((): ClaimAgentControlResult => ({ ok: true, controllerId: 'client-1' }));
}

describe('registerRemoteWebSocketServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forwards browser terminal input traces to backend diagnostics', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = vi.fn();

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: {
        authenticateClient: vi.fn(),
        broadcast: vi.fn(),
        broadcastControl: vi.fn(),
        cleanupClient: vi.fn(),
        claimAgentControl: createClaimAgentControlMock(),
        getAgentControllerId: vi.fn(() => null),
        getAuthenticatedClientCount: vi.fn(() => 1),
        getClientId: vi.fn(() => 'client-1'),
        hasClientId: vi.fn(() => true),
        isAuthenticated: vi.fn(() => true),
        notePong: vi.fn(),
        releaseAgentControl: vi.fn(),
        replayControlEvents: vi.fn(),
        scheduleAuthTimeout: vi.fn(),
        sendAgentControllers: vi.fn(),
        sendMessage,
        sendToClientId: vi.fn(() => true),
        startHeartbeat: vi.fn(),
        stopHeartbeat: vi.fn(),
      },
      wss: wss as never,
    });

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'terminal-input-trace',
        agentId: 'agent-1',
        outputReceivedAtMs: 100,
        outputRenderedAtMs: 125,
        requestId: 'request-1',
      }),
    );

    expect(recordTerminalInputTraceClientUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        outputReceivedAtMs: 100,
        outputRenderedAtMs: 125,
        requestId: 'request-1',
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'agent-error' }),
    );
  });

  it('responds to browser terminal trace clock sync requests', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = vi.fn();

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: {
        authenticateClient: vi.fn(),
        broadcast: vi.fn(),
        broadcastControl: vi.fn(),
        cleanupClient: vi.fn(),
        claimAgentControl: createClaimAgentControlMock(),
        getAgentControllerId: vi.fn(() => null),
        getAuthenticatedClientCount: vi.fn(() => 1),
        getClientId: vi.fn(() => 'client-1'),
        hasClientId: vi.fn(() => true),
        isAuthenticated: vi.fn(() => true),
        notePong: vi.fn(),
        releaseAgentControl: vi.fn(),
        replayControlEvents: vi.fn(),
        scheduleAuthTimeout: vi.fn(),
        sendAgentControllers: vi.fn(),
        sendMessage,
        sendToClientId: vi.fn(() => true),
        startHeartbeat: vi.fn(),
        stopHeartbeat: vi.fn(),
      },
      wss: wss as never,
    });

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'terminal-input-trace-clock-sync',
        clientSentAtMs: 100,
        requestId: 'request-1',
      }),
    );

    expect(sendMessage).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        type: 'terminal-input-trace-clock-sync',
        clientSentAtMs: 100,
        requestId: 'request-1',
        serverReceivedAtMs: expect.any(Number),
        serverSentAtMs: expect.any(Number),
      }),
    );
  });

  it('preserves browser client and task trace ownership when writing agent input', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: {
        authenticateClient: vi.fn(),
        broadcast: vi.fn(),
        broadcastControl: vi.fn(),
        cleanupClient: vi.fn(),
        claimAgentControl: createClaimAgentControlMock(),
        getAgentControllerId: vi.fn(() => null),
        getAuthenticatedClientCount: vi.fn(() => 1),
        getClientId: vi.fn(() => 'client-1'),
        hasClientId: vi.fn(() => true),
        isAuthenticated: vi.fn(() => true),
        notePong: vi.fn(),
        releaseAgentControl: vi.fn(),
        replayControlEvents: vi.fn(),
        scheduleAuthTimeout: vi.fn(),
        sendAgentControllers: vi.fn(),
        sendMessage: vi.fn(),
        sendToClientId: vi.fn(() => true),
        startHeartbeat: vi.fn(),
        stopHeartbeat: vi.fn(),
      },
      wss: wss as never,
    });

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'input',
        agentId: 'agent-1',
        controllerId: 'client-1',
        data: 'hello',
        requestId: 'request-1',
        taskId: 'task-1',
        trace: {
          bufferedAtMs: 10,
          inputChars: 5,
          inputKind: 'interactive',
          sendStartedAtMs: 20,
          startedAtMs: 5,
        },
      }),
    );

    expect(writeToAgentMock).toHaveBeenCalledWith('agent-1', 'hello', {
      clientId: 'client-1',
      requestId: 'request-1',
      taskId: 'task-1',
      trace: {
        bufferedAtMs: 10,
        inputChars: 5,
        inputKind: 'interactive',
        sendStartedAtMs: 20,
        startedAtMs: 5,
      },
    });
  });
});
