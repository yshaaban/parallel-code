// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentsMessage,
  OutputMessage,
  RemoteAgent,
  ScrollbackMessage,
  ServerMessage,
} from '../../electron/remote/protocol';
import type {
  CreateWebSocketClientCoreOptions,
  WebSocketClientCore,
} from '../lib/websocket-client';

const websocketState = vi.hoisted(() => ({
  ensureConnectedMock: vi.fn(async () => ({}) as WebSocket),
  options: null as CreateWebSocketClientCoreOptions<ServerMessage, unknown> | null,
  sendAsyncMock: vi.fn(async () => {}),
  sendIfOpenMock: vi.fn(() => true),
}));

vi.mock('../lib/client-id', () => ({
  getPersistentClientId: vi.fn(() => 'remote-client-1234'),
}));

vi.mock('./auth', () => ({
  clearToken: vi.fn(),
  getToken: vi.fn(() => null),
  redirectToRemoteAuthGate: vi.fn(async () => false),
}));

vi.mock('./remote-collaboration', () => ({
  applyRemoteIpcEvent: vi.fn(),
  applyRemoteStateBootstrap: vi.fn(),
  handleRemoteTakeoverResult: vi.fn(),
  replaceRemotePeerPresences: vi.fn(),
  upsertIncomingRemoteTakeoverRequest: vi.fn(),
}));

vi.mock('../lib/websocket-client', () => ({
  createWebSocketClientCore: vi.fn(
    (
      options: CreateWebSocketClientCoreOptions<ServerMessage, unknown>,
    ): WebSocketClientCore<unknown> => {
      websocketState.options = options;
      return {
        disconnect: vi.fn(),
        ensureConnected: websocketState.ensureConnectedMock,
        getLastRttMs: () => null,
        getLastSeq: () => -1,
        getState: () => 'disconnected',
        hasPendingConnection: () => false,
        isOpen: () => false,
        send: websocketState.sendAsyncMock,
        sendIfOpen: websocketState.sendIfOpenMock,
      };
    },
  ),
}));

function createAgent(overrides?: Partial<RemoteAgent>): RemoteAgent {
  return {
    agentId: 'agent-1',
    exitCode: null,
    lastLine: '',
    status: 'running',
    taskId: 'task-1',
    taskName: 'Hydra Agent',
    ...overrides,
  };
}

function createAgentsMessage(list: RemoteAgent[]): AgentsMessage {
  return {
    type: 'agents',
    list,
  };
}

function createOutputMessage(data: string): OutputMessage {
  return {
    type: 'output',
    agentId: 'agent-1',
    data,
  };
}

function createScrollbackMessage(data: string): ScrollbackMessage {
  return {
    type: 'scrollback',
    agentId: 'agent-1',
    cols: 80,
    data,
  };
}

async function loadWsModule(): Promise<{
  module: typeof import('./ws');
  options: CreateWebSocketClientCoreOptions<ServerMessage, unknown>;
}> {
  vi.resetModules();
  websocketState.ensureConnectedMock.mockReset();
  websocketState.ensureConnectedMock.mockResolvedValue({} as WebSocket);
  websocketState.options = null;
  websocketState.sendAsyncMock.mockReset();
  websocketState.sendAsyncMock.mockResolvedValue(undefined);
  websocketState.sendIfOpenMock.mockReset();
  websocketState.sendIfOpenMock.mockReturnValue(true);
  const module = await import('./ws');
  const options = websocketState.options;
  if (options === null) {
    throw new Error('websocket options were not captured');
  }

  return { module, options };
}

describe('remote ws projections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes inactive agent previews from authoritative agents snapshots', async () => {
    const { module, options } = await loadWsModule();

    options.onMessage(
      createAgentsMessage([createAgent({ lastLine: 'watching for the next compile' })]),
    );
    expect(module.getAgentPreview('agent-1')).toBe('watching for the next compile');

    options.onMessage(
      createAgentsMessage([createAgent({ lastLine: 'waiting for approval to continue' })]),
    );
    expect(module.getAgentPreview('agent-1')).toBe('waiting for approval to continue');
  });

  it('keeps richer subscribed live preview state when a later agents snapshot is older', async () => {
    const { module, options } = await loadWsModule();

    options.onMessage(createAgentsMessage([createAgent({ lastLine: 'snapshot prompt' })]));
    const cleanup = module.onOutput('agent-1', vi.fn());

    options.onMessage(
      createOutputMessage(Buffer.from('\nlive detail output', 'utf8').toString('base64')),
    );
    expect(module.getAgentPreview('agent-1')).toBe('live detail output');

    options.onMessage(createAgentsMessage([createAgent({ lastLine: 'stale snapshot prompt' })]));
    expect(module.getAgentPreview('agent-1')).toBe('live detail output');

    cleanup();
  });

  it('decodes scrollback snapshots independently from the streaming output decoder', async () => {
    const { module, options } = await loadWsModule();

    options.onMessage(createAgentsMessage([createAgent()]));
    options.onMessage(createOutputMessage(Buffer.from([0xe2, 0x82]).toString('base64')));
    options.onMessage(
      createScrollbackMessage(Buffer.from('snapshot ready', 'utf8').toString('base64')),
    );

    expect(module.getAgentPreview('agent-1')).toBe('snapshot ready');
  });

  it('resets streaming decoders when the websocket connection loses continuity', async () => {
    const { module, options } = await loadWsModule();

    options.onMessage(createAgentsMessage([createAgent()]));
    options.onMessage(createOutputMessage(Buffer.from([0xe2, 0x82]).toString('base64')));

    options.onStateChange?.('reconnecting');
    options.onStateChange?.('connected');
    options.onMessage(createOutputMessage(Buffer.from('A', 'utf8').toString('base64')));

    expect(module.getAgentPreview('agent-1')).toBe('A');
  });

  it('uses the stable remote client identity in the websocket url', async () => {
    const { options } = await loadWsModule();

    const url = new URL(
      options.getSocketUrl({ clientId: 'remote-mobile-client', lastSeq: 12, token: null }),
    );

    expect(url.origin).toBe('ws://localhost:3000');
    expect(url.pathname).toBe('/ws');
    expect(url.searchParams.get('clientId')).toBe('remote-mobile-client');
    expect(url.searchParams.get('lastSeq')).toBe('12');
  });

  it('waits for reconnect before sending critical control messages', async () => {
    const { module } = await loadWsModule();

    await expect(module.sendWhenConnected({ type: 'kill', agentId: 'agent-1' })).resolves.toBe(
      true,
    );
    expect(websocketState.sendAsyncMock).toHaveBeenCalledWith({
      type: 'kill',
      agentId: 'agent-1',
    });
  });

  it('notifies remote listeners when connection status changes', async () => {
    const { module, options } = await loadWsModule();
    const listener = vi.fn();
    const cleanup = module.subscribeRemoteConnectionStatus(listener);

    expect(listener).toHaveBeenCalledWith('disconnected');

    expect(options.onStateChange).toBeDefined();
    options.onStateChange?.('connected');
    expect(listener).toHaveBeenLastCalledWith('connected');

    cleanup();
  });

  it('reconnects on pageshow and when the document becomes visible again', async () => {
    const { module } = await loadWsModule();

    module.connect();
    expect(websocketState.ensureConnectedMock).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('pageshow'));
    expect(websocketState.ensureConnectedMock).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get() {
        return false;
      },
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(websocketState.ensureConnectedMock).toHaveBeenCalledTimes(3);
  });
});
