import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { IPC } from '../ipc/channels.js';
import type { ClaimAgentControlResult, WebSocketTransport } from './ws-transport.js';
import type { RemoteCommandAuthentication, RemoteGrant } from '../ipc/remote-command-gateway.js';
import type { TaskCatalogDeltaBatch } from '../../src/domain/task-catalog.js';
import type { TaskCreationAgentOperationSnapshot } from '../../src/domain/task-creation.js';
import type {
  TaskCreationOperationCapability,
  TaskCreationOperationId,
} from '../../src/domain/task-creation-ticket.js';
import type { RemoteTaskCreationOperationSource } from '../ipc/task-creation-remote-commands.js';

const writeToAgentMock = vi.fn();
const resizeAgentMock = vi.fn();
const stopTaskAgentWorkflowMock = vi.fn<(agentId: string) => Promise<void>>();
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
const TASK_CREATION_OPERATION_ID = Buffer.alloc(16, 0x31).toString(
  'base64url',
) as TaskCreationOperationId;
const TASK_CREATION_OPERATION_CAPABILITY = Buffer.alloc(32, 0x42).toString(
  'base64url',
) as TaskCreationOperationCapability;

vi.mock('../ipc/pty.js', () => ({
  getAgentCols: vi.fn(() => 80),
  getAgentMeta: getAgentMetaMock,
  getAgentPauseState: vi.fn(() => null),
  getAgentScrollback: vi.fn(() => null),
  getAgentTerminalRecovery: getAgentTerminalRecoveryMock,
  getAgentTerminalStartupRecovery: getAgentTerminalStartupRecoveryMock,
  hasAgentSession: vi.fn(() => false),
  onPtyEvent: onPtyEventMock,
  pauseAgent: vi.fn(),
  resizeAgent: resizeAgentMock,
  resumeAgent: vi.fn(),
  subscribeToAgent: subscribeToAgentMock,
  unsubscribeFromAgent: unsubscribeFromAgentMock,
  writeToAgent: writeToAgentMock,
}));

vi.mock('../ipc/task-workflows.js', () => ({
  stopTaskAgentWorkflow: stopTaskAgentWorkflowMock,
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

function createScopedAuthentication(
  grants: readonly RemoteGrant[],
  overrides: Partial<RemoteCommandAuthentication> = {},
): RemoteCommandAuthentication {
  return {
    authEpoch: '1',
    authenticationSessionGeneration: 'generation-1',
    csrfValidated: true,
    directPeerValidated: true,
    expiresAt: Number.MAX_SAFE_INTEGER,
    grants: new Set(grants),
    kind: 'browser-session',
    originValidated: true,
    principalId: 'workspace-owner',
    sourceId: 'peer-1',
    transportSecure: true,
    ...overrides,
  };
}

function createTaskCatalogRemovalBatch(): TaskCatalogDeltaBatch {
  return {
    events: [
      {
        catalogVersion: 1,
        entityId: 'task-1',
        entityKind: 'task',
        kind: 'remove',
        serverInstanceId: 'server-1',
      },
    ],
    fromCatalogVersion: 0,
    serverInstanceId: 'server-1',
    toCatalogVersion: 1,
  };
}

function createTaskCreationSnapshot(
  operationId: TaskCreationOperationId = TASK_CREATION_OPERATION_ID,
): TaskCreationAgentOperationSnapshot {
  return {
    commit: 'not-committed',
    committedTaskId: null,
    committedWorkspaceRevision: null,
    current: {
      catalogVersion: 1,
      serverInstanceId: 'server-1',
      task: null,
      taskClosing: false,
      taskState: 'not-visible',
      workspaceRevision: 1,
    },
    managedArtifactRecovery: { kind: 'none' },
    operationId,
    phase: 'validating',
    serverInstanceId: 'server-1',
    symlinkWarnings: [],
    taskMode: 'agent',
    version: 1,
  };
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
    getClientsById: vi.fn(() => []),
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
    stopTaskAgentWorkflowMock.mockResolvedValue(undefined);
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

  it('authenticates scoped cookie sockets without URL credentials and routes input through the gateway', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { kind: 'accepted' } });
    const authenticateConnection = vi.fn(() => true);
    const authentication = {
      authEpoch: '1',
      authenticationSessionGeneration: 'generation-1',
      csrfValidated: true,
      directPeerValidated: true,
      expiresAt: Number.MAX_SAFE_INTEGER,
      grants: new Set(['terminal:control' as const]),
      kind: 'browser-session' as const,
      originValidated: true,
      principalId: 'workspace-owner',
      sourceId: 'peer-1',
      transportSecure: true,
    };

    registerRemoteWebSocketServer({
      authenticateConnection,
      authenticateScopedConnection: () => authentication,
      getAgentList: () => [],
      remoteCommandGateway: { dispatch } as never,
      safeCompareToken: () => false,
      transport: createMockTransport(),
      wss: wss as never,
    });
    wss.emit('connection', client, {
      headers: { cookie: '__Host-parallel_code_session=session', host: 'parallel.test' },
      url: '/?clientId=mobile-1&lastSeq=4',
    });
    client.emit('message', JSON.stringify({ type: 'input', agentId: 'agent-1', data: 'ls\r' }));

    expect(authenticateConnection).toHaveBeenCalledWith(client, 'mobile-1', 4, {
      terminalRead: false,
    });
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        'terminal.input',
        expect.objectContaining({ sourceId: 'mobile-1' }),
        { type: 'input', agentId: 'agent-1', data: 'ls\r' },
      ),
    );
    expect(writeToAgentMock).not.toHaveBeenCalled();
  });

  it('rejects query-token fallback once scoped socket authentication is configured', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const authenticateConnection = vi.fn(() => true);

    registerRemoteWebSocketServer({
      authenticateConnection,
      authenticateScopedConnection: () => ({
        authEpoch: '1',
        authenticationSessionGeneration: 'generation-1',
        csrfValidated: true,
        directPeerValidated: true,
        expiresAt: Number.MAX_SAFE_INTEGER,
        grants: new Set(['terminal:control']),
        kind: 'browser-session',
        originValidated: true,
        principalId: 'workspace-owner',
        transportSecure: true,
      }),
      getAgentList: () => [],
      remoteCommandGateway: { dispatch: vi.fn() } as never,
      safeCompareToken: (token) => token === 'legacy',
      transport: createMockTransport(),
      wss: wss as never,
    });
    wss.emit('connection', client, {
      headers: { host: 'parallel.test' },
      url: '/?token=legacy',
    });

    expect(client.close).toHaveBeenCalledWith(4001, 'Secure session required');
    expect(authenticateConnection).not.toHaveBeenCalled();
  });

  it('rejects every scoped socket missing secure direct exact-origin proof before any effects', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    for (const overrides of [
      { transportSecure: false },
      { directPeerValidated: false },
      { originValidated: false },
      { expiresAt: 0 },
    ] satisfies Array<Partial<RemoteCommandAuthentication>>) {
      const client = createFakeClient();
      const wss = createFakeWebSocketServer();
      wss.clients.add(client);
      const authenticateConnection = vi.fn(() => true);
      const server = registerRemoteWebSocketServer({
        authenticateConnection,
        authenticateScopedConnection: () =>
          createScopedAuthentication(['terminal:read'], overrides),
        getAgentList: () => [],
        safeCompareToken: () => false,
        transport: createMockTransport(),
        wss: wss as never,
      });

      wss.emit('connection', client, { headers: { host: 'parallel.test' }, url: '/' });
      client.emit('message', JSON.stringify({ type: 'subscribe', agentId: 'agent-1' }));

      expect(client.close).toHaveBeenCalledWith(4001, 'Secure session required');
      expect(authenticateConnection).not.toHaveBeenCalled();
      expect(subscribeToAgentMock).not.toHaveBeenCalled();
      server.cleanup();
      vi.clearAllMocks();
    }
  });

  it('closes a scoped socket immediately when its authority invalidates the generation', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const authentication = createScopedAuthentication(['terminal:read']);
    let current: RemoteCommandAuthentication | null = authentication;
    let invalidate: (() => void) | undefined;
    const transport = createMockTransport();

    const server = registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      authenticateScopedConnection: () => authentication,
      getAgentList: () => [],
      getCurrentScopedAuthentication: () => current,
      refreshScopedAuthentication: () => current,
      safeCompareToken: () => false,
      subscribeScopedAuthenticationInvalidation: (listener) => {
        invalidate = listener;
        return () => undefined;
      },
      transport,
      wss: wss as never,
    });
    wss.emit('connection', client, { headers: { host: 'parallel.test' }, url: '/' });

    current = null;
    invalidate?.();

    expect(client.close).toHaveBeenCalledWith(4001, 'Secure session required');
    expect(transport.cleanupClient).toHaveBeenCalledWith(client);
    server.cleanup();
  });

  it('isolates catalog and terminal read streams by scoped grant', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const catalogClient = createFakeClient();
    const catalogWss = createFakeWebSocketServer();
    catalogWss.clients.add(catalogClient);
    const catalogTransport = createMockTransport();
    let publishCatalog: ((batch: TaskCatalogDeltaBatch) => void) | undefined;
    const catalogServer = registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      authenticateScopedConnection: () => createScopedAuthentication(['catalog:read']),
      getAgentList: () => [],
      safeCompareToken: () => false,
      subscribeTaskCatalog: (listener) => {
        publishCatalog = listener;
        return () => undefined;
      },
      transport: catalogTransport,
      wss: catalogWss as never,
    });
    catalogWss.emit('connection', catalogClient, {
      headers: { host: 'parallel.test' },
      url: '/',
    });
    catalogClient.emit('message', JSON.stringify({ type: 'subscribe', agentId: 'agent-1' }));
    publishCatalog?.(createTaskCatalogRemovalBatch());
    expect(subscribeToAgentMock).not.toHaveBeenCalled();
    expect(catalogTransport.sendMessage).toHaveBeenCalledWith(catalogClient, {
      type: 'task-catalog-delta',
      batch: createTaskCatalogRemovalBatch(),
    });

    const terminalClient = createFakeClient();
    const terminalWss = createFakeWebSocketServer();
    terminalWss.clients.add(terminalClient);
    const terminalTransport = createMockTransport();
    let publishWithoutGrant: typeof publishCatalog;
    const terminalServer = registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      authenticateScopedConnection: () => createScopedAuthentication(['terminal:read']),
      getAgentList: () => [],
      safeCompareToken: () => false,
      subscribeTaskCatalog: (listener) => {
        publishWithoutGrant = listener;
        return () => undefined;
      },
      transport: terminalTransport,
      wss: terminalWss as never,
    });
    terminalWss.emit('connection', terminalClient, {
      headers: { host: 'parallel.test' },
      url: '/',
    });
    vi.mocked(terminalTransport.sendMessage).mockClear();
    publishWithoutGrant?.(createTaskCatalogRemovalBatch());
    expect(terminalTransport.sendMessage).not.toHaveBeenCalled();

    catalogServer.cleanup();
    terminalServer.cleanup();
  });

  it('fans out content-free notes invalidations only to notes readers and unsubscribes on cleanup', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const notesClient = createFakeClient();
    const deniedClient = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(notesClient);
    wss.clients.add(deniedClient);
    const transport = createMockTransport();
    const unsubscribe = vi.fn();
    let publish:
      | ((payload: { sourceId: string | null; taskId: string; workspaceRevision: number }) => void)
      | undefined;
    let connection = 0;

    const server = registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      authenticateScopedConnection: () =>
        createScopedAuthentication(connection++ === 0 ? ['notes:read'] : ['terminal:read']),
      getAgentList: () => [],
      safeCompareToken: () => false,
      subscribeTaskNotesChanged: (listener) => {
        publish = listener;
        return unsubscribe;
      },
      transport,
      wss: wss as never,
    });
    wss.emit('connection', notesClient, { headers: { host: 'parallel.test' }, url: '/' });
    wss.emit('connection', deniedClient, { headers: { host: 'parallel.test' }, url: '/' });
    vi.mocked(transport.sendMessage).mockClear();

    publish?.({ sourceId: 'peer-1', taskId: 'task-1', workspaceRevision: 7 });

    expect(transport.sendMessage).toHaveBeenCalledOnce();
    expect(transport.sendMessage).toHaveBeenCalledWith(notesClient, {
      type: 'ipc-event',
      channel: IPC.TaskNotesChanged,
      payload: { sourceId: 'peer-1', taskId: 'task-1', workspaceRevision: 7 },
    });
    expect(transport.sendMessage).not.toHaveBeenCalledWith(deniedClient, expect.anything());

    server.cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('returns visible read-only feedback when scoped terminal control is not granted', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();

    registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      authenticateScopedConnection: () => ({
        authEpoch: '1',
        authenticationSessionGeneration: 'generation-1',
        csrfValidated: true,
        directPeerValidated: true,
        expiresAt: Number.MAX_SAFE_INTEGER,
        grants: new Set(['terminal:read']),
        kind: 'browser-session',
        originValidated: true,
        principalId: 'workspace-owner',
        transportSecure: true,
      }),
      getAgentList: () => [],
      remoteCommandGateway: { dispatch: vi.fn() } as never,
      safeCompareToken: () => false,
      transport: createMockTransport({ sendMessage }),
      wss: wss as never,
    });
    wss.emit('connection', client, { headers: { host: 'parallel.test' }, url: '/' });
    client.emit(
      'message',
      JSON.stringify({
        type: 'task-command-lease',
        action: 'type',
        operation: 'acquire',
        ownerId: 'owner-1',
        requestId: 'request-1',
        taskId: 'task-1',
      }),
    );

    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'task-command-lease-result',
      error: 'Secure terminal control is not available',
      operation: 'acquire',
      requestId: 'request-1',
    });
    expect(acquireTaskCommandLeaseMock).not.toHaveBeenCalled();
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

  it('routes kill through the canonical stop workflow and surfaces asynchronous cleanup failure', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();
    const failure = new Error('runner cleanup failed');
    stopTaskAgentWorkflowMock.mockRejectedValueOnce(failure);

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
        agentId: 'agent-1',
        type: 'kill',
      }),
    );

    await vi.waitFor(() => {
      expect(stopTaskAgentWorkflowMock).toHaveBeenCalledWith('agent-1');
      expect(sendMessage).toHaveBeenCalledWith(client, {
        agentId: 'agent-1',
        message: 'runner cleanup failed',
        type: 'agent-error',
      });
    });
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
      generation: 4,
      lastOutput: ['fatal error'],
      signal: null,
      taskId: 'task-1',
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

  it('resolves tail-needed recovery to a capped snapshot for remote clients', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const sendMessage = createSendMessageMock();
    // The remote protocol has no phase-two tail flow and rejects
    // 'tail-needed' payloads, so the server must resolve a cursor miss to the
    // capped snapshot before responding.
    getAgentTerminalRecoveryMock
      .mockReturnValueOnce({
        cols: 120,
        kind: 'tail-needed',
        outputCursor: 500,
        rows: 32,
      })
      .mockReturnValueOnce({
        cols: 120,
        data: Buffer.from('capped-snapshot', 'utf8'),
        kind: 'snapshot',
        outputCursor: 500,
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
        renderedTail: null,
        requestId: 'recovery-tail-needed',
        snapshotByteLimit: 64,
      }),
    );

    expect(getAgentTerminalRecoveryMock).toHaveBeenCalledTimes(2);
    expect(getAgentTerminalRecoveryMock).toHaveBeenNthCalledWith(1, 'agent-1', null, 12, 64);
    expect(getAgentTerminalRecoveryMock).toHaveBeenNthCalledWith(2, 'agent-1', null, null, 64);
    expect(sendMessage).toHaveBeenCalledWith(client, {
      type: 'terminal-recovery-result',
      entry: {
        agentId: 'agent-1',
        cols: 120,
        outputCursor: 500,
        recovery: {
          data: Buffer.from('capped-snapshot', 'utf8').toString('base64'),
          kind: 'snapshot',
        },
        requestId: 'recovery-tail-needed',
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

  it('publishes catalog-owner events and releases the subscription during cleanup', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const wss = createFakeWebSocketServer();
    const transport = createMockTransport();
    const unsubscribe = vi.fn();
    let publish: ((batch: TaskCatalogDeltaBatch) => void) | undefined;

    const server = registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      getAgentList: () => [],
      safeCompareToken: () => false,
      subscribeTaskCatalog: (listener) => {
        publish = listener;
        return unsubscribe;
      },
      transport,
      wss: wss as never,
    });

    publish?.(createTaskCatalogRemovalBatch());
    expect(transport.broadcast).toHaveBeenCalledWith({
      type: 'task-catalog-delta',
      batch: createTaskCatalogRemovalBatch(),
    });

    server.cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('binds one scoped operation subscription, emits exact secret-free frames, and cleans up', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const transport = createMockTransport();
    const backendUnsubscribe = vi.fn(async () => undefined);
    let publishSnapshot: ((snapshot: TaskCreationAgentOperationSnapshot) => void) | undefined;
    const taskCreationOperations: RemoteTaskCreationOperationSource = {
      refreshOperation: vi.fn(async () => undefined),
      subscribe: vi.fn<RemoteTaskCreationOperationSource['subscribe']>(
        async (_authentication, _request, listener) => {
          publishSnapshot = listener;
          return { kind: 'subscribed', unsubscribe: backendUnsubscribe };
        },
      ),
    };
    const authentication = createScopedAuthentication(['task:create']);
    const server = registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      authenticateScopedConnection: () => authentication,
      getAgentList: () => [],
      safeCompareToken: () => false,
      taskCreationOperations,
      transport,
      wss: wss as never,
    });
    wss.emit('connection', client, {
      headers: { host: 'parallel.test' },
      url: '/?clientId=mobile-1',
    });

    client.emit(
      'message',
      JSON.stringify({
        operationCapability: TASK_CREATION_OPERATION_CAPABILITY,
        operationId: TASK_CREATION_OPERATION_ID,
        type: 'subscribe-task-creation-operation',
      }),
    );
    await vi.waitFor(() => expect(taskCreationOperations.subscribe).toHaveBeenCalledOnce());
    expect(taskCreationOperations.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: 'workspace-owner', sourceId: 'mobile-1' }),
      {
        operationCapability: TASK_CREATION_OPERATION_CAPABILITY,
        operationId: TASK_CREATION_OPERATION_ID,
      },
      expect.any(Function),
    );
    await vi.waitFor(() =>
      expect(transport.sendMessage).toHaveBeenCalledWith(client, {
        operationId: TASK_CREATION_OPERATION_ID,
        state: 'ready',
        type: 'task-creation-operation-subscription-state',
      }),
    );

    publishSnapshot?.(createTaskCreationSnapshot());
    expect(transport.sendMessage).toHaveBeenCalledWith(client, {
      snapshot: createTaskCreationSnapshot(),
      type: 'task-creation-operation-snapshot',
    });
    expect(JSON.stringify(vi.mocked(transport.sendMessage).mock.calls)).not.toContain(
      TASK_CREATION_OPERATION_CAPABILITY,
    );

    client.emit(
      'message',
      JSON.stringify({
        operationId: TASK_CREATION_OPERATION_ID,
        type: 'unsubscribe-task-creation-operation',
      }),
    );
    await vi.waitFor(() => expect(backendUnsubscribe).toHaveBeenCalledOnce());
    server.cleanup();
  });

  it('silently rejects missing grants and bounds each client to eight operation subscriptions', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const deniedClient = createFakeClient();
    const deniedWss = createFakeWebSocketServer();
    deniedWss.clients.add(deniedClient);
    const deniedTransport = createMockTransport();
    const subscribe = vi.fn<RemoteTaskCreationOperationSource['subscribe']>(async () => ({
      kind: 'subscribed',
      unsubscribe: async () => undefined,
    }));
    const taskCreationOperations: RemoteTaskCreationOperationSource = {
      refreshOperation: vi.fn(async () => undefined),
      subscribe,
    };
    const deniedServer = registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      authenticateScopedConnection: () => createScopedAuthentication(['catalog:read']),
      getAgentList: () => [],
      safeCompareToken: () => false,
      taskCreationOperations,
      transport: deniedTransport,
      wss: deniedWss as never,
    });
    deniedWss.emit('connection', deniedClient, { headers: { host: 'parallel.test' }, url: '/' });
    deniedClient.emit(
      'message',
      JSON.stringify({
        operationCapability: TASK_CREATION_OPERATION_CAPABILITY,
        operationId: TASK_CREATION_OPERATION_ID,
        type: 'subscribe-task-creation-operation',
      }),
    );
    expect(subscribe).not.toHaveBeenCalled();
    expect(deniedTransport.sendMessage).not.toHaveBeenCalledWith(
      deniedClient,
      expect.objectContaining({ type: 'task-creation-operation-subscription-state' }),
    );
    deniedServer.cleanup();

    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const transport = createMockTransport();
    const server = registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      authenticateScopedConnection: () => createScopedAuthentication(['task:create']),
      getAgentList: () => [],
      safeCompareToken: () => false,
      taskCreationOperations,
      transport,
      wss: wss as never,
    });
    wss.emit('connection', client, { headers: { host: 'parallel.test' }, url: '/' });
    const operationIds = Array.from({ length: 9 }, (_, index) =>
      Buffer.alloc(16, 0x40 + index).toString('base64url'),
    );
    for (const candidateOperationId of operationIds) {
      client.emit(
        'message',
        JSON.stringify({
          operationCapability: TASK_CREATION_OPERATION_CAPABILITY,
          operationId: candidateOperationId,
          type: 'subscribe-task-creation-operation',
        }),
      );
    }
    expect(subscribe).toHaveBeenCalledTimes(8);
    expect(transport.sendMessage).toHaveBeenCalledWith(client, {
      operationId: operationIds[8],
      state: 'degraded',
      type: 'task-creation-operation-subscription-state',
    });
    server.cleanup();
  });

  it('refreshes subscribed operations after catalog publication and cleans up on grant revocation', async () => {
    const { registerRemoteWebSocketServer } = await import('./ws-server.js');
    const client = createFakeClient();
    const wss = createFakeWebSocketServer();
    wss.clients.add(client);
    const transport = createMockTransport();
    const backendUnsubscribe = vi.fn(async () => undefined);
    let publishCatalog: ((batch: TaskCatalogDeltaBatch) => void) | undefined;
    let publishSnapshot: ((snapshot: TaskCreationAgentOperationSnapshot) => void) | undefined;
    const refreshOperation = vi.fn(async (currentOperationId: TaskCreationOperationId) => {
      publishSnapshot?.(createTaskCreationSnapshot(currentOperationId));
    });
    const taskCreationOperations: RemoteTaskCreationOperationSource = {
      refreshOperation,
      subscribe: vi.fn<RemoteTaskCreationOperationSource['subscribe']>(
        async (_authentication, _request, listener) => {
          publishSnapshot = listener;
          return { kind: 'subscribed', unsubscribe: backendUnsubscribe };
        },
      ),
    };
    const authentication = createScopedAuthentication(['catalog:read', 'task:create']);
    let current: RemoteCommandAuthentication | null = authentication;
    let invalidate: (() => void) | undefined;
    const server = registerRemoteWebSocketServer({
      authenticateConnection: () => true,
      authenticateScopedConnection: () => authentication,
      getAgentList: () => [],
      getCurrentScopedAuthentication: () => current,
      safeCompareToken: () => false,
      subscribeScopedAuthenticationInvalidation: (listener) => {
        invalidate = listener;
        return () => undefined;
      },
      subscribeTaskCatalog: (listener) => {
        publishCatalog = listener;
        return () => undefined;
      },
      taskCreationOperations,
      transport,
      wss: wss as never,
    });
    wss.emit('connection', client, { headers: { host: 'parallel.test' }, url: '/' });
    client.emit(
      'message',
      JSON.stringify({
        operationCapability: TASK_CREATION_OPERATION_CAPABILITY,
        operationId: TASK_CREATION_OPERATION_ID,
        type: 'subscribe-task-creation-operation',
      }),
    );
    await vi.waitFor(() =>
      expect(transport.sendMessage).toHaveBeenCalledWith(
        client,
        expect.objectContaining({ state: 'ready' }),
      ),
    );
    vi.mocked(transport.sendMessage).mockClear();

    publishCatalog?.(createTaskCatalogRemovalBatch());
    await vi.waitFor(() =>
      expect(refreshOperation).toHaveBeenCalledWith(TASK_CREATION_OPERATION_ID),
    );
    expect(transport.sendMessage).toHaveBeenCalledWith(client, {
      snapshot: createTaskCreationSnapshot(),
      type: 'task-creation-operation-snapshot',
    });

    current = createScopedAuthentication(['catalog:read']);
    invalidate?.();
    expect(client.close).toHaveBeenCalledWith(4001, 'Secure session required');
    await vi.waitFor(() => expect(backendUnsubscribe).toHaveBeenCalledOnce());
    server.cleanup();
  });
});
