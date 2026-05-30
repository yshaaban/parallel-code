import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { IPC } from '../ipc/channels.js';
import type { ClaimAgentControlResult, WebSocketTransport } from './ws-transport.js';

const writeToAgentMock = vi.fn();
const resizeAgentMock = vi.fn();
const recordTerminalInputTraceClientUpdateMock = vi.fn();
const acquireTaskCommandLeaseMock = vi.fn();
const getAgentMetaMock = vi.fn<
  () => { agentId: string; generation: number; isShell: boolean; taskId: string } | null
>(() => null);
const getAgentTerminalRecoveryMock = vi.fn();
const getAgentTerminalStartupRecoveryMock = vi.fn();
const getTaskCommandControllerSnapshotMock = vi.fn<
  (taskId: string) => {
    action: string | null;
    controllerId: string | null;
    taskId: string;
    version: number;
  }
>((taskId: string) => ({
  action: null,
  controllerId: null,
  taskId,
  version: 0,
}));
const isTaskCommandLeaseHeldMock = vi.fn(() => false);
const releaseTaskCommandLeaseMock = vi.fn();
const renewTaskCommandLeaseMock = vi.fn();
const onPtyEventMock = vi.fn(
  (_event: string, _listener: (agentId: string, data?: unknown) => void) => () => {},
);
const subscribeToAgentMock = vi.fn((_agentId: string, _callback: (data: string) => void) => false);
const unsubscribeFromAgentMock = vi.fn();

vi.mock('../ipc/pty.js', () => ({
  getAgentCols: vi.fn(() => 80),
  getAgentMeta: getAgentMetaMock,
  getAgentPauseState: vi.fn(() => null),
  getAgentScrollback: vi.fn(() => null),
  getAgentTerminalRecovery: getAgentTerminalRecoveryMock,
  getAgentTerminalStartupRecovery: getAgentTerminalStartupRecoveryMock,
  hasAgentSession: vi.fn(() => false),
  killAgent: vi.fn(),
  onPtyEvent: onPtyEventMock,
  pauseAgent: vi.fn(),
  resizeAgent: resizeAgentMock,
  resumeAgent: vi.fn(),
  subscribeToAgent: subscribeToAgentMock,
  unsubscribeFromAgent: unsubscribeFromAgentMock,
  writeToAgent: writeToAgentMock,
}));

vi.mock('../ipc/task-command-leases.js', () => ({
  acquireTaskCommandLease: acquireTaskCommandLeaseMock,
  getTaskCommandControllerSnapshot: getTaskCommandControllerSnapshotMock,
  isTaskCommandLeaseHeld: isTaskCommandLeaseHeldMock,
  releaseTaskCommandLease: releaseTaskCommandLeaseMock,
  renewTaskCommandLease: renewTaskCommandLeaseMock,
}));

vi.mock('../ipc/runtime-diagnostics.js', () => ({
  recordTerminalInputTraceClientUpdate: recordTerminalInputTraceClientUpdateMock,
}));

type FakeClient = WebSocket &
  EventEmitter & {
    _socket?: {
      setNoDelay: ReturnType<typeof vi.fn>;
    };
    readyState: WebSocket['readyState'];
  };

interface FakeWebSocketServer extends EventEmitter {
  clients: Set<FakeClient>;
}

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

function createFakeWebSocketServer(): FakeWebSocketServer {
  const server = new EventEmitter() as FakeWebSocketServer;
  server.clients = new Set();
  return server;
}

function createClaimAgentControlMock() {
  return vi.fn((): ClaimAgentControlResult => ({ ok: true, controllerId: 'client-1' }));
}

function createSendMessageMock() {
  return vi.fn(() => ({ ok: true as const }));
}

function createMockTransport(
  overrides: Partial<WebSocketTransport<WebSocket>> = {},
): WebSocketTransport<WebSocket> {
  return {
    authenticateClient: vi.fn(() => ({ ok: true as const, clientId: 'client-1' })),
    broadcast: vi.fn(),
    broadcastControl: vi.fn(),
    cleanupClient: vi.fn(),
    claimAgentControl: createClaimAgentControlMock(),
    getAgentControllerId: vi.fn(() => null),
    getAuthenticatedClientCount: vi.fn(() => 1),
    getClientId: vi.fn(() => 'client-1'),
    getLatestControlEventSeq: vi.fn(() => -1),
    hasClientId: vi.fn(() => true),
    isAuthenticated: vi.fn(() => true),
    notePong: vi.fn(),
    releaseAgentControl: vi.fn(),
    replayControlEvents: vi.fn(),
    scheduleAuthTimeout: vi.fn(),
    sendAgentControllers: vi.fn(),
    sendMessage: vi.fn(() => ({ ok: true as const })),
    sendToClientId: vi.fn(() => true),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    ...overrides,
  };
}

describe('registerRemoteWebSocketServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentTerminalRecoveryMock.mockReturnValue({
      cols: 80,
      kind: 'noop',
      outputCursor: 0,
      rows: 24,
    });
    getAgentTerminalStartupRecoveryMock.mockResolvedValue({
      cols: 80,
      kind: 'noop',
      outputCursor: 0,
      rows: 24,
    });
    getAgentMetaMock.mockReturnValue(null);
    getTaskCommandControllerSnapshotMock.mockImplementation((taskId: string) => ({
      action: null,
      controllerId: null,
      taskId,
      version: 0,
    }));
    isTaskCommandLeaseHeldMock.mockReturnValue(false);
    acquireTaskCommandLeaseMock.mockReturnValue({
      acquired: true,
      action: 'type in the terminal',
      changed: true,
      controllerId: 'client-1',
      leaseGeneration: 1,
      taskId: 'task-1',
      version: 1,
    });
    renewTaskCommandLeaseMock.mockReturnValue({
      action: 'type in the terminal',
      controllerId: 'client-1',
      leaseGeneration: 1,
      renewed: true,
      taskId: 'task-1',
      version: 1,
    });
    releaseTaskCommandLeaseMock.mockReturnValue({
      changed: true,
      snapshot: {
        action: null,
        controllerId: null,
        taskId: 'task-1',
        version: 2,
      },
    });
    subscribeToAgentMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forwards browser terminal input traces to backend diagnostics', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ sendMessage }),
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

  it('enables TCP no-delay on remote websocket connections', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport(),
      wss: wss as never,
    });

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    expect(client._socket?.setNoDelay).toHaveBeenCalledWith(true);
  });

  it('responds to browser terminal trace clock sync requests', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ sendMessage }),
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

  it('streams structured terminal Data for opt-in remote subscribers', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();
    let outputCallback: ((data: string) => void) | undefined;
    subscribeToAgentMock.mockImplementation(
      (_agentId: string, callback: (data: string) => void) => {
        outputCallback = callback;
        return true;
      },
    );

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ sendMessage }),
      wss: wss as never,
    });

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

    const data = Buffer.from('structured data', 'utf8').toString('base64');
    if (outputCallback === undefined) {
      throw new Error('Expected structured subscription callback');
    }
    outputCallback(data);

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
      expect.objectContaining({ type: 'output' }),
    );
  });

  it('signals structured terminal recovery after remote send backpressure', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce({ ok: false as const, reason: 'backpressure' as const })
      .mockReturnValue({ ok: true as const });
    let outputCallback: ((data: string) => void) | undefined;
    subscribeToAgentMock.mockImplementation(
      (_agentId: string, callback: (data: string) => void) => {
        outputCallback = callback;
        return true;
      },
    );

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ sendMessage }),
      wss: wss as never,
    });

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

    if (!outputCallback) {
      throw new Error('Expected structured subscription callback');
    }
    outputCallback('first');
    outputCallback('second');

    expect(sendMessage).toHaveBeenNthCalledWith(1, client, {
      type: 'terminal-stream',
      agentId: 'agent-1',
      event: {
        type: 'Data',
        data: 'first',
      },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, client, {
      type: 'terminal-stream',
      agentId: 'agent-1',
      event: {
        type: 'RecoveryRequired',
        reason: 'backpressure',
      },
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('streams structured terminal Exit diagnostics for opt-in remote subscribers', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();
    subscribeToAgentMock.mockReturnValue(true);

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ sendMessage }),
      wss: wss as never,
    });

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

    const exitListener = onPtyEventMock.mock.calls.find(([event]) => event === 'exit')?.[1] as
      | ((agentId: string, data: unknown) => void)
      | undefined;
    if (!exitListener) {
      throw new Error('Expected exit listener registration');
    }
    exitListener('agent-1', {
      exitCode: 2,
      lastOutput: ['fatal error'],
      signal: null,
    });

    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'terminal-stream',
      agentId: 'agent-1',
      event: {
        type: 'Exit',
        data: {
          exit_code: 2,
          last_output: ['fatal error'],
          signal: null,
        },
      },
    });
  });

  it('keeps legacy output as the default remote subscription protocol', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();
    let outputCallback: ((data: string) => void) | undefined;
    subscribeToAgentMock.mockImplementation(
      (_agentId: string, callback: (data: string) => void) => {
        outputCallback = callback;
        return true;
      },
    );

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ sendMessage }),
      wss: wss as never,
    });

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'subscribe',
        agentId: 'agent-1',
      }),
    );

    const data = Buffer.from('legacy data', 'utf8').toString('base64');
    if (outputCallback === undefined) {
      throw new Error('Expected legacy subscription callback');
    }
    outputCallback(data);

    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'output',
      agentId: 'agent-1',
      data,
    });
    expect(sendMessage).not.toHaveBeenCalledWith(
      client,
      expect.objectContaining({ type: 'terminal-stream' }),
    );
  });

  it('ignores stale output callbacks after remote client cleanup', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();
    let outputCallback: ((data: string) => void) | undefined;
    subscribeToAgentMock.mockImplementation(
      (_agentId: string, callback: (data: string) => void) => {
        outputCallback = callback;
        return true;
      },
    );

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ sendMessage }),
      wss: wss as never,
    });

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });
    client.emit(
      'message',
      JSON.stringify({
        type: 'subscribe',
        agentId: 'agent-1',
      }),
    );

    if (!outputCallback) {
      throw new Error('Expected remote subscription callback');
    }
    client.emit('close');
    outputCallback('stale data');

    expect(unsubscribeFromAgentMock).toHaveBeenCalledWith('agent-1', outputCallback);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('responds to terminal snapshot recovery requests over the remote websocket', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();
    const renderedTail = Buffer.from('tail', 'utf8').toString('base64');
    getAgentTerminalRecoveryMock.mockReturnValue({
      cols: 120,
      data: Buffer.from('snapshot', 'utf8'),
      kind: 'snapshot',
      outputCursor: 42,
      rows: 32,
    });

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ sendMessage }),
      wss: wss as never,
    });

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'terminal-recovery-request',
        agentId: 'agent-1',
        outputCursor: 12,
        renderedTail,
        requestId: 'recovery-1',
        snapshotByteLimit: 4096,
      }),
    );

    expect(getAgentTerminalRecoveryMock).toHaveBeenCalledWith(
      'agent-1',
      Buffer.from('tail', 'utf8'),
      12,
      4096,
    );
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'terminal-recovery-result',
      entry: {
        agentId: 'agent-1',
        cols: 120,
        outputCursor: 42,
        recovery: {
          data: Buffer.from('snapshot', 'utf8').toString('base64'),
          kind: 'snapshot',
        },
        requestId: 'recovery-1',
        rows: 32,
      },
    });
  });

  it('responds to terminal-state startup recovery requests over the remote websocket', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();
    getAgentTerminalStartupRecoveryMock.mockResolvedValue({
      cols: 100,
      data: Buffer.from('terminal-state', 'utf8'),
      kind: 'terminal-state',
      outputCursor: 8,
      rows: 30,
    });

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ sendMessage }),
      wss: wss as never,
    });

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'terminal-startup-recovery-request',
        agentId: 'agent-1',
        requestId: 'startup-1',
        role: 'selected',
        visibleTerminalCount: 2,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(getAgentTerminalStartupRecoveryMock).toHaveBeenCalledWith(
      'agent-1',
      null,
      null,
      'selected',
      2,
    );
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'terminal-recovery-result',
      entry: {
        agentId: 'agent-1',
        cols: 100,
        outputCursor: 8,
        recovery: {
          data: Buffer.from('terminal-state', 'utf8').toString('base64'),
          kind: 'terminal-state',
        },
        requestId: 'startup-1',
        rows: 30,
      },
    });
  });

  it('drops terminal recovery requests with non-canonical base64 tails', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ sendMessage }),
      wss: wss as never,
    });

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'terminal-recovery-request',
        agentId: 'agent-1',
        renderedTail: 'AB==',
        requestId: 'recovery-1',
      }),
    );

    expect(getAgentTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalledWith(
      client,
      expect.objectContaining({ type: 'terminal-recovery-result' }),
    );
  });

  it('preserves browser client and task trace ownership when writing agent input', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    getAgentMetaMock.mockReturnValue({
      agentId: 'agent-1',
      generation: 1,
      isShell: false,
      taskId: 'task-1',
    });
    isTaskCommandLeaseHeldMock.mockReturnValue(true);

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport(),
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

    expect(writeToAgentMock).toHaveBeenCalledWith(
      'agent-1',
      'hello',
      {
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
      },
      undefined,
    );
  });

  it('passes input order tokens to agent writes', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport(),
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
        data: 'ordered input',
        inputEpoch: 'input-epoch-1',
        inputSeq: 7,
      }),
    );

    expect(writeToAgentMock).toHaveBeenCalledWith('agent-1', 'ordered input', undefined, {
      inputEpoch: 'input-epoch-1',
      inputSeq: 7,
    });
  });

  it('rejects task terminal input when the websocket client does not hold the task lease', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();
    getAgentMetaMock.mockReturnValue({
      agentId: 'agent-1',
      generation: 1,
      isShell: false,
      taskId: 'task-1',
    });
    getTaskCommandControllerSnapshotMock.mockReturnValue({
      action: 'type in the terminal',
      controllerId: 'client-2',
      taskId: 'task-1',
      version: 2,
    });

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ sendMessage }),
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
        data: 'blocked input',
        taskId: 'task-1',
      }),
    );

    expect(writeToAgentMock).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'agent-error',
      agentId: 'agent-1',
      message: 'Task is controlled by another client (client-2)',
    });
  });

  it('passes task terminal input when the websocket client holds the task lease', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    getAgentMetaMock.mockReturnValue({
      agentId: 'agent-1',
      generation: 1,
      isShell: false,
      taskId: 'task-1',
    });
    isTaskCommandLeaseHeldMock.mockReturnValue(true);

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport(),
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
        data: 'allowed input',
        taskId: 'task-1',
      }),
    );

    expect(writeToAgentMock).toHaveBeenCalledWith('agent-1', 'allowed input', undefined, undefined);
  });

  it('handles task-command lease acquire, renew, and release over the remote websocket', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    const sendMessage = createSendMessageMock();
    const broadcastControl = vi.fn();
    wss.clients.add(client);

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ broadcastControl, sendMessage }),
      wss: wss as never,
    });

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'task-command-lease',
        action: 'type in the terminal',
        clientId: 'spoofed-client',
        operation: 'acquire',
        ownerId: 'owner-1',
        requestId: 'lease-acquire',
        takeover: true,
        taskId: 'task-1',
      }),
    );

    expect(acquireTaskCommandLeaseMock).toHaveBeenCalledWith(
      'task-1',
      'client-1',
      'owner-1',
      'type in the terminal',
      true,
    );
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'task-command-lease-result',
      operation: 'acquire',
      requestId: 'lease-acquire',
      result: {
        acquired: true,
        action: 'type in the terminal',
        controllerId: 'client-1',
        leaseGeneration: 1,
        taskId: 'task-1',
        version: 1,
      },
    });
    expect(broadcastControl).toHaveBeenCalledWith({
      type: 'ipc-event',
      channel: IPC.TaskCommandControllerChanged,
      payload: {
        action: 'type in the terminal',
        controllerId: 'client-1',
        taskId: 'task-1',
        version: 1,
      },
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'task-command-lease',
        leaseGeneration: 1,
        operation: 'renew',
        ownerId: 'owner-1',
        requestId: 'lease-renew',
        taskId: 'task-1',
      }),
    );
    expect(renewTaskCommandLeaseMock).toHaveBeenCalledWith(
      'task-1',
      'client-1',
      'owner-1',
      expect.any(Number),
      1,
    );
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'task-command-lease-result',
      operation: 'renew',
      requestId: 'lease-renew',
      result: {
        action: 'type in the terminal',
        controllerId: 'client-1',
        leaseGeneration: 1,
        renewed: true,
        taskId: 'task-1',
        version: 1,
      },
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'task-command-lease',
        leaseGeneration: 1,
        operation: 'release',
        ownerId: 'owner-1',
        requestId: 'lease-release',
        taskId: 'task-1',
      }),
    );
    expect(releaseTaskCommandLeaseMock).toHaveBeenCalledWith(
      'task-1',
      'client-1',
      'owner-1',
      expect.any(Number),
      1,
    );
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'task-command-lease-result',
      operation: 'release',
      requestId: 'lease-release',
      result: {
        action: null,
        controllerId: null,
        taskId: 'task-1',
        version: 2,
      },
    });
  });

  it('rejects remote task-command lease messages without an authenticated client id', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    const sendMessage = createSendMessageMock();
    wss.clients.add(client);

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport({ getClientId: vi.fn(() => null), sendMessage }),
      wss: wss as never,
    });

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'task-command-lease',
        action: 'type in the terminal',
        operation: 'acquire',
        ownerId: 'owner-1',
        requestId: 'lease-acquire',
        taskId: 'task-1',
      }),
    );

    expect(acquireTaskCommandLeaseMock).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'task-command-lease-result',
      error: 'Unauthorized',
      operation: 'acquire',
      requestId: 'lease-acquire',
    });
  });

  it('passes resize order tokens to agent resizes', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: (token) => token === 'good',
      transport: createMockTransport(),
      wss: wss as never,
    });

    wss.emit('connection', client, {
      headers: { host: 'localhost' },
      url: '/?token=good',
    });

    client.emit(
      'message',
      JSON.stringify({
        type: 'resize',
        agentId: 'agent-1',
        cols: 120,
        rows: 40,
        resizeEpoch: 'resize-epoch-1',
        resizeSeq: 3,
      }),
    );

    expect(resizeAgentMock).toHaveBeenCalledWith('agent-1', 120, 40, {
      resizeEpoch: 'resize-epoch-1',
      resizeSeq: 3,
    });
  });
});
