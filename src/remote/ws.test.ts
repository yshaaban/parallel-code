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
  options: null as CreateWebSocketClientCoreOptions<ServerMessage, unknown> | null,
}));

vi.mock('../lib/client-id', () => ({
  getPersistentClientId: vi.fn(() => 'remote-client-1234'),
}));

vi.mock('./auth', () => ({
  clearToken: vi.fn(),
  getToken: vi.fn(() => null),
  redirectToRemoteAuthGate: vi.fn(async () => false),
}));

vi.mock('../lib/websocket-client', () => ({
  createWebSocketClientCore: vi.fn(
    (
      options: CreateWebSocketClientCoreOptions<ServerMessage, unknown>,
    ): WebSocketClientCore<unknown> => {
      websocketState.options = options;
      return {
        disconnect: vi.fn(),
        ensureConnected: vi.fn(async () => ({}) as WebSocket),
        getLastRttMs: () => null,
        getLastSeq: () => -1,
        getState: () => 'disconnected',
        hasPendingConnection: () => false,
        isOpen: () => false,
        send: vi.fn(async () => {}),
        sendIfOpen: vi.fn(() => true),
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
  websocketState.options = null;
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
});
