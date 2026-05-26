// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentsMessage,
  OutputMessage,
  RemoteAgent,
  ScrollbackMessage,
  ServerMessage,
  TerminalStreamMessage,
} from '../../electron/remote/protocol';
import type {
  CreateWebSocketClientCoreOptions,
  WebSocketClientCore,
} from '../lib/websocket-client';

type CapturedRemoteServerMessage = ServerMessage | { type: string; [key: string]: unknown };

const websocketState = vi.hoisted(() => ({
  disconnectMock: vi.fn(),
  ensureConnectedMock: vi.fn(async () => ({}) as WebSocket),
  options: null as CreateWebSocketClientCoreOptions<CapturedRemoteServerMessage, unknown> | null,
  sendAsyncMock: vi.fn(async () => {}),
  sendIfOpenMock: vi.fn(() => true),
}));

const collaborationState = vi.hoisted(() => ({
  applyRemoteIpcEventMock: vi.fn(),
  applyRemoteStateBootstrapMock: vi.fn(),
  handleRemoteTakeoverResultMock: vi.fn(),
  replaceRemotePeerPresencesMock: vi.fn(),
  upsertIncomingRemoteTakeoverRequestMock: vi.fn(),
}));

const taskState = vi.hoisted(() => ({
  applyRemoteTaskPortsChangedMock: vi.fn(),
}));

const terminalOrderState = vi.hoisted(() => ({
  resetAllMock: vi.fn(),
  resetAgentMock: vi.fn(),
}));

const authState = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  getTokenMock: vi.fn(() => null as string | null),
  redirectToRemoteAuthGateMock: vi.fn(async () => false),
}));

let loadedWsModule: typeof import('./ws') | null = null;

vi.mock('../lib/client-id', () => ({
  getPersistentClientId: vi.fn(() => 'remote-client-1234'),
}));

vi.mock('./auth', () => ({
  clearToken: authState.clearTokenMock,
  getToken: authState.getTokenMock,
  redirectToRemoteAuthGate: authState.redirectToRemoteAuthGateMock,
}));

vi.mock('./remote-collaboration', () => ({
  applyRemoteIpcEvent: collaborationState.applyRemoteIpcEventMock,
  applyRemoteStateBootstrap: collaborationState.applyRemoteStateBootstrapMock,
  handleRemoteTakeoverResult: collaborationState.handleRemoteTakeoverResultMock,
  replaceRemotePeerPresences: collaborationState.replaceRemotePeerPresencesMock,
  upsertIncomingRemoteTakeoverRequest: collaborationState.upsertIncomingRemoteTakeoverRequestMock,
}));

vi.mock('./remote-task-state', () => ({
  applyRemoteTaskPortsChanged: taskState.applyRemoteTaskPortsChangedMock,
}));

vi.mock('./remote-terminal-order', () => ({
  resetRemoteTerminalOrderForAgent: terminalOrderState.resetAgentMock,
  resetRemoteTerminalOrderForAllAgents: terminalOrderState.resetAllMock,
}));

vi.mock('../lib/websocket-client', () => ({
  createWebSocketClientCore: vi.fn(
    (
      options: CreateWebSocketClientCoreOptions<CapturedRemoteServerMessage, unknown>,
    ): WebSocketClientCore<unknown> => {
      websocketState.options = options;
      return {
        disconnect: websocketState.disconnectMock,
        ensureConnected: websocketState.ensureConnectedMock,
        getBufferedAmount: () => 0,
        getLastRttMs: () => null,
        getLastSeq: () => -1,
        getState: () => 'disconnected',
        hasPendingConnection: () => false,
        isOpen: () => false,
        resetForTests: vi.fn(),
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

function createTerminalStreamDataMessage(data: string): TerminalStreamMessage {
  return {
    type: 'terminal-stream',
    agentId: 'agent-1',
    event: {
      type: 'Data',
      data,
    },
  };
}

async function loadWsModule(): Promise<{
  module: typeof import('./ws');
  options: CreateWebSocketClientCoreOptions<CapturedRemoteServerMessage, unknown>;
}> {
  vi.resetModules();
  authState.clearTokenMock.mockReset();
  authState.getTokenMock.mockReset();
  authState.getTokenMock.mockReturnValue(null);
  authState.redirectToRemoteAuthGateMock.mockReset();
  authState.redirectToRemoteAuthGateMock.mockResolvedValue(false);
  websocketState.disconnectMock.mockReset();
  websocketState.ensureConnectedMock.mockReset();
  websocketState.ensureConnectedMock.mockResolvedValue({} as WebSocket);
  websocketState.options = null;
  websocketState.sendAsyncMock.mockReset();
  websocketState.sendAsyncMock.mockResolvedValue(undefined);
  websocketState.sendIfOpenMock.mockReset();
  websocketState.sendIfOpenMock.mockReturnValue(true);
  const module = await import('./ws');
  loadedWsModule = module;
  module.resetRemoteWsRuntimeStateForTests();
  const options = websocketState.options;
  if (options === null) {
    throw new Error('websocket options were not captured');
  }

  return { module, options };
}

describe('remote ws projections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskState.applyRemoteTaskPortsChangedMock.mockReset();
    terminalOrderState.resetAgentMock.mockReset();
    terminalOrderState.resetAllMock.mockReset();
  });

  afterEach(() => {
    loadedWsModule?.resetRemoteWsRuntimeStateForTests();
    loadedWsModule = null;
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

  it('buffers output that arrives before the agent snapshot and applies it after agents load', async () => {
    const { module, options } = await loadWsModule();

    options.onMessage(
      createOutputMessage(Buffer.from('\npre-agent live output', 'utf8').toString('base64')),
    );
    expect(module.getAgentPreview('agent-1')).toBe('');

    options.onMessage(createAgentsMessage([createAgent({ lastLine: 'snapshot seed' })]));

    expect(module.getAgentPreview('agent-1')).toBe('pre-agent live output');
    expect(module.getAgentLastActivityAt('agent-1')).not.toBeNull();
  });

  it('buffers scrollback snapshots that arrive before the agent snapshot', async () => {
    const { module, options } = await loadWsModule();

    options.onMessage(
      createScrollbackMessage(
        Buffer.from('older line\npre-agent scrollback ready', 'utf8').toString('base64'),
      ),
    );

    options.onMessage(createAgentsMessage([createAgent({ lastLine: 'stale snapshot prompt' })]));

    expect(module.getAgentPreview('agent-1')).toBe('pre-agent scrollback ready');
  });

  it('bounds pre-agent output buffering per agent before the snapshot arrives', async () => {
    const { module, options } = await loadWsModule();

    options.onMessage(
      createOutputMessage(Buffer.from('very-old-ready '.repeat(5_000)).toString('base64')),
    );
    options.onMessage(
      createOutputMessage(Buffer.from('\nnewest bounded ready', 'utf8').toString('base64')),
    );

    options.onMessage(createAgentsMessage([createAgent({ lastLine: '' })]));

    const preview = module.getAgentPreview('agent-1');
    expect(preview).not.toContain('very-old-ready');
    expect(preview).toBe('newest bounded ready');
  });

  it('routes structured terminal Data through the legacy output listener alias', async () => {
    const cleanups: Array<() => void> = [];
    try {
      const { module, options } = await loadWsModule();
      const outputListener = vi.fn();
      const terminalStreamListener = vi.fn();
      const data = Buffer.from('\nstructured stream detail', 'utf8').toString('base64');

      options.onMessage(createAgentsMessage([createAgent({ lastLine: 'snapshot prompt' })]));
      cleanups.push(module.onOutput('agent-1', outputListener));
      cleanups.push(module.onTerminalStream('agent-1', terminalStreamListener));

      options.onMessage(createTerminalStreamDataMessage(data));

      expect(outputListener).toHaveBeenCalledWith(data);
      expect(terminalStreamListener).toHaveBeenCalledWith({
        type: 'Data',
        data,
      });
      expect(module.getAgentPreview('agent-1')).toBe('structured stream detail');
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
  });

  it('surfaces structured terminal Exit and RecoveryRequired events without legacy output', async () => {
    const cleanups: Array<() => void> = [];
    try {
      const { module, options } = await loadWsModule();
      const outputListener = vi.fn();
      const terminalStreamListener = vi.fn();

      options.onMessage(createAgentsMessage([createAgent({ lastLine: 'running' })]));
      cleanups.push(module.onOutput('agent-1', outputListener));
      cleanups.push(module.onTerminalStream('agent-1', terminalStreamListener));

      options.onMessage({
        type: 'terminal-stream',
        agentId: 'agent-1',
        event: {
          type: 'RecoveryRequired',
          reason: 'backpressure',
        },
      });
      options.onMessage({
        type: 'terminal-stream',
        agentId: 'agent-1',
        event: {
          type: 'Exit',
          data: {
            exit_code: 0,
            last_output: ['finished'],
            signal: null,
          },
        },
      });

      expect(outputListener).not.toHaveBeenCalled();
      expect(terminalStreamListener).toHaveBeenCalledWith({
        type: 'RecoveryRequired',
        reason: 'backpressure',
      });
      expect(terminalStreamListener).toHaveBeenCalledWith({
        type: 'Exit',
        data: {
          exit_code: 0,
          last_output: ['finished'],
          signal: null,
        },
      });
      expect(module.agents()[0]).toMatchObject({ status: 'exited', exitCode: 0 });
      expect(module.getAgentPreview('agent-1')).toBe('finished');
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
  });

  it('seeds a same-id structured respawn from the fresh running snapshot after Exit', async () => {
    const cleanups: Array<() => void> = [];
    try {
      const { module, options } = await loadWsModule();
      const terminalStreamListener = vi.fn();

      options.onMessage(createAgentsMessage([createAgent({ lastLine: 'old run seed ' })]));
      cleanups.push(module.onTerminalStream('agent-1', terminalStreamListener));
      options.onMessage(
        createTerminalStreamDataMessage(Buffer.from('old live output', 'utf8').toString('base64')),
      );
      expect(module.getAgentPreview('agent-1')).toBe('old run seed old live output');

      options.onMessage({
        type: 'terminal-stream',
        agentId: 'agent-1',
        event: {
          type: 'Exit',
          data: {
            exit_code: 0,
            last_output: ['previous session diagnostic '],
            signal: null,
          },
        },
      });
      expect(module.getAgentPreview('agent-1')).toBe('previous session diagnostic');

      websocketState.sendIfOpenMock.mockClear();
      options.onMessage(createAgentsMessage([createAgent({ lastLine: 'new run seed ' })]));
      expect(websocketState.sendIfOpenMock).toHaveBeenCalledWith({
        type: 'subscribe',
        agentId: 'agent-1',
        terminalProtocol: 'structured',
      });
      options.onMessage(
        createTerminalStreamDataMessage(Buffer.from('fresh output', 'utf8').toString('base64')),
      );

      expect(module.getAgentPreview('agent-1')).toBe('new run seed fresh output');
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
  });

  it('resets terminal continuity from exited status when structured Exit was missed', async () => {
    const cleanups: Array<() => void> = [];
    try {
      const { module, options } = await loadWsModule();
      const terminalStreamListener = vi.fn();

      options.onMessage(createAgentsMessage([createAgent({ lastLine: 'old run seed ' })]));
      cleanups.push(module.onTerminalStream('agent-1', terminalStreamListener));
      options.onMessage(
        createTerminalStreamDataMessage(Buffer.from('old live output', 'utf8').toString('base64')),
      );

      websocketState.sendIfOpenMock.mockClear();
      options.onMessage({
        type: 'status',
        agentId: 'agent-1',
        status: 'exited',
        exitCode: 0,
      });
      options.onMessage(createAgentsMessage([createAgent({ lastLine: 'new run seed ' })]));
      options.onMessage(
        createTerminalStreamDataMessage(Buffer.from('fresh output', 'utf8').toString('base64')),
      );

      expect(terminalOrderState.resetAgentMock).toHaveBeenCalledWith('agent-1');
      expect(websocketState.sendIfOpenMock).toHaveBeenCalledWith({
        type: 'subscribe',
        agentId: 'agent-1',
        terminalProtocol: 'structured',
      });
      expect(module.getAgentPreview('agent-1')).toBe('new run seed fresh output');
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
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

  it('drops malformed output and scrollback payloads before notifying terminal listeners', async () => {
    const cleanups: Array<() => void> = [];
    try {
      const { module, options } = await loadWsModule();
      const outputListener = vi.fn();
      const scrollbackListener = vi.fn();

      options.onMessage(createAgentsMessage([createAgent({ lastLine: 'ready' })]));
      const cleanupOutput = module.onOutput('agent-1', outputListener);
      const cleanupScrollback = module.onScrollback('agent-1', scrollbackListener);
      cleanups.push(cleanupOutput, cleanupScrollback);

      options.onMessage(createOutputMessage('not-valid-base64!'));
      options.onMessage(createScrollbackMessage('not-valid-base64!'));

      expect(outputListener).not.toHaveBeenCalled();
      expect(scrollbackListener).not.toHaveBeenCalled();
      expect(module.getAgentPreview('agent-1')).toBe('ready');
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
  });

  it('drops malformed structured terminal Data before notifying terminal listeners', async () => {
    const cleanups: Array<() => void> = [];
    try {
      const { module, options } = await loadWsModule();
      const outputListener = vi.fn();
      const terminalStreamListener = vi.fn();

      options.onMessage(createAgentsMessage([createAgent({ lastLine: 'ready' })]));
      cleanups.push(module.onOutput('agent-1', outputListener));
      cleanups.push(module.onTerminalStream('agent-1', terminalStreamListener));

      options.onMessage(createTerminalStreamDataMessage('AB=='));

      expect(outputListener).not.toHaveBeenCalled();
      expect(terminalStreamListener).not.toHaveBeenCalled();
      expect(module.getAgentPreview('agent-1')).toBe('ready');
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
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

  it('chooses token auth at connect time while allowing cookie-auth websocket sessions', async () => {
    const { options } = await loadWsModule();

    expect(options.shouldSendAuthMessage?.({ token: null })).toBe(false);
    expect(options.shouldSendAuthMessage?.({ token: 'bootstrap-token' })).toBe(true);
    expect(
      options.createAuthMessage?.({
        clientId: 'remote-mobile-client',
        lastSeq: 12,
        token: 'bootstrap-token',
      }),
    ).toEqual({
      type: 'auth',
      clientId: 'remote-mobile-client',
      lastSeq: 12,
      token: 'bootstrap-token',
    });
  });

  it('uses the shared weak-connectivity heartbeat and warm reconnect policy', async () => {
    const { options } = await loadWsModule();

    expect(options.pingIntervalMs).toBe(20_000);
    expect(options.pongTimeoutMs).toBe(12_000);
    expect(options.maxMissedPongs).toBe(2);
    expect(
      options.reconnectDelayMs?.(0, {
        hasConnected: true,
        lastConnectedAt: Date.now(),
        lastConnectionDurationMs: 1_000,
        lastDisconnectedAt: Date.now(),
        lastDisconnectReason: 'close',
        lastRttMs: null,
      }),
    ).toBe(0);
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

  it('sends structured subscribe and terminal recovery request hooks', async () => {
    const { module } = await loadWsModule();
    const renderedTail = Buffer.from('tail', 'utf8').toString('base64');

    module.subscribeAgent('agent-1', { terminalProtocol: 'structured' });
    expect(websocketState.sendIfOpenMock).toHaveBeenCalledWith({
      type: 'subscribe',
      agentId: 'agent-1',
      terminalProtocol: 'structured',
    });

    module.requestRemoteTerminalRecovery({
      agentId: 'agent-1',
      outputCursor: 12,
      renderedTail,
      requestId: 'recovery-1',
      snapshotByteLimit: 4096,
    });
    expect(websocketState.sendIfOpenMock).toHaveBeenCalledWith({
      type: 'terminal-recovery-request',
      agentId: 'agent-1',
      outputCursor: 12,
      renderedTail,
      requestId: 'recovery-1',
      snapshotByteLimit: 4096,
    });

    module.requestRemoteTerminalStartupRecovery({
      agentId: 'agent-1',
      requestId: 'startup-1',
      role: 'selected',
      visibleTerminalCount: 1,
    });
    expect(websocketState.sendIfOpenMock).toHaveBeenCalledWith({
      type: 'terminal-startup-recovery-request',
      agentId: 'agent-1',
      requestId: 'startup-1',
      role: 'selected',
      visibleTerminalCount: 1,
    });
  });

  it('resets remote terminal ordering and resubscribes active agents after authentication', async () => {
    const cleanups: Array<() => void> = [];
    try {
      const { module, options } = await loadWsModule();

      cleanups.push(module.onOutput('agent-1', vi.fn()));
      cleanups.push(module.onTerminalStream('agent-2', vi.fn()));
      terminalOrderState.resetAllMock.mockClear();
      websocketState.sendIfOpenMock.mockClear();

      options.onAuthenticated?.({} as WebSocket);

      expect(terminalOrderState.resetAllMock).toHaveBeenCalledTimes(1);
      expect(websocketState.sendIfOpenMock).toHaveBeenCalledWith({
        type: 'subscribe',
        agentId: 'agent-1',
      });
      expect(websocketState.sendIfOpenMock).toHaveBeenCalledWith({
        type: 'subscribe',
        agentId: 'agent-2',
        terminalProtocol: 'structured',
      });
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
  });

  it('notifies terminal recovery result listeners', async () => {
    const { module, options } = await loadWsModule();
    const listener = vi.fn();
    const cleanup = module.onTerminalRecoveryResult(listener);
    const entry = {
      agentId: 'agent-1',
      cols: 80,
      outputCursor: 4,
      recovery: {
        data: Buffer.from('snapshot', 'utf8').toString('base64'),
        kind: 'snapshot' as const,
      },
      requestId: 'recovery-1',
      rows: 24,
    };

    options.onMessage({
      type: 'terminal-recovery-result',
      entry,
    });

    expect(listener).toHaveBeenCalledWith(entry);
    cleanup();
  });

  it('logs when the initial websocket connection fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { module } = await loadWsModule();
    websocketState.ensureConnectedMock.mockRejectedValueOnce(new Error('connect failed'));

    module.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith(
      '[remote-ws] Failed to establish websocket session (connecting)',
      expect.any(Error),
    );

    module.resetRemoteWsRuntimeStateForTests();
    warnSpy.mockRestore();
  });

  it('logs when sending after waiting for connection fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { module } = await loadWsModule();
    websocketState.sendAsyncMock.mockRejectedValueOnce(new Error('send failed'));

    await expect(module.sendWhenConnected({ type: 'kill', agentId: 'agent-1' })).resolves.toBe(
      false,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[remote-ws] Failed to send websocket message after waiting for connection',
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it('reconnects when the websocket client detects a sequence gap', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { options } = await loadWsModule();

    options.onSequenceGap?.({
      actualSeq: 3,
      expectedSeq: 2,
      previousSeq: 1,
    });

    expect(websocketState.disconnectMock).toHaveBeenCalledTimes(1);
    expect(websocketState.ensureConnectedMock).toHaveBeenCalledWith('reconnecting');
    expect(warnSpy).toHaveBeenCalledWith(
      '[remote-ws] Sequence gap detected; reconnecting remote websocket session',
      {
        actualSeq: 3,
        expectedSeq: 2,
        previousSeq: 1,
      },
    );

    warnSpy.mockRestore();
  });

  it('logs remote agent command errors instead of silently ignoring them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { options } = await loadWsModule();

    options.onMessage({
      type: 'agent-error',
      agentId: 'agent-1',
      message: 'ownership rejected',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[remote-ws] Agent agent-1 command rejected',
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it('explicitly ignores remote server message types that the mobile UI does not consume', async () => {
    const { options } = await loadWsModule();
    const ignoredMessages: ServerMessage[] = [
      { type: 'pong' },
      {
        type: 'channel',
        channelId: 'channel-1',
        payload: { test: true },
      },
      {
        type: 'channel-bound',
        channelId: 'channel-1',
      },
      {
        type: 'agent-lifecycle',
        agentId: 'agent-1',
        event: 'spawn',
        isShell: false,
        taskId: 'task-1',
        status: 'running',
      },
      {
        type: 'agent-controller',
        agentId: 'agent-1',
        controllerId: 'client-1',
      },
      {
        type: 'remote-status',
        connectedClients: 1,
        peerClients: 0,
      },
      {
        type: 'task-event',
        event: 'created',
        taskId: 'task-1',
      },
      {
        type: 'git-status-changed',
        worktreePath: '/tmp/project/task-1',
        branchName: 'feature/task-1',
        status: {
          has_committed_changes: false,
          has_uncommitted_changes: true,
        },
      },
      {
        type: 'permission-request',
        agentId: 'agent-1',
        requestId: 'request-1',
        tool: 'bash',
        description: 'Run command',
        arguments: '{}',
      },
      {
        type: 'agent-command-result',
        accepted: true,
        agentId: 'agent-1',
        command: 'input',
        requestId: 'request-1',
      },
      {
        type: 'terminal-input-trace-clock-sync',
        clientSentAtMs: 1,
        requestId: 'request-1',
        serverReceivedAtMs: 2,
        serverSentAtMs: 3,
      },
    ];

    for (const message of ignoredMessages) {
      options.onMessage(message);
    }

    expect(collaborationState.applyRemoteIpcEventMock).not.toHaveBeenCalled();
    expect(collaborationState.applyRemoteStateBootstrapMock).not.toHaveBeenCalled();
    expect(collaborationState.handleRemoteTakeoverResultMock).not.toHaveBeenCalled();
    expect(collaborationState.replaceRemotePeerPresencesMock).not.toHaveBeenCalled();
    expect(collaborationState.upsertIncomingRemoteTakeoverRequestMock).not.toHaveBeenCalled();
    expect(taskState.applyRemoteTaskPortsChangedMock).not.toHaveBeenCalled();
  });

  it('ignores unknown remote server message types instead of dispatching them', async () => {
    const { options } = await loadWsModule();

    expect(() => {
      options.onMessage({
        type: 'future-server-event',
        payload: { value: true },
      });
    }).not.toThrow();

    expect(collaborationState.applyRemoteIpcEventMock).not.toHaveBeenCalled();
    expect(collaborationState.applyRemoteStateBootstrapMock).not.toHaveBeenCalled();
    expect(collaborationState.handleRemoteTakeoverResultMock).not.toHaveBeenCalled();
    expect(collaborationState.replaceRemotePeerPresencesMock).not.toHaveBeenCalled();
    expect(collaborationState.upsertIncomingRemoteTakeoverRequestMock).not.toHaveBeenCalled();
    expect(taskState.applyRemoteTaskPortsChangedMock).not.toHaveBeenCalled();
  });

  it('drops malformed known remote server message types before dispatch', async () => {
    const { options } = await loadWsModule();
    const malformedMessages: CapturedRemoteServerMessage[] = [
      { type: 'agents', list: [{ agentId: 'agent-1', status: 'mystery-state' }] },
      { type: 'output', agentId: 'agent-1' },
      { type: 'scrollback', agentId: 'agent-1', data: 'c25hcHNob3Q=' },
      { type: 'scrollback', agentId: 'agent-1', data: 'c25hcHNob3Q=', cols: 0 },
      { type: 'status', agentId: 'agent-1', status: 'running', exitCode: Number.NaN },
      { type: 'status', agentId: 'agent-1', status: 'running', exitCode: 1.5 },
      { type: 'terminal-stream', agentId: 'agent-1', event: { type: 'Data', data: 'AB==' } },
      {
        type: 'terminal-recovery-result',
        entry: {
          agentId: 'agent-1',
          cols: 80,
          outputCursor: 1,
          recovery: {
            data: 'AB==',
            kind: 'terminal-state',
          },
          requestId: 'recovery-1',
          rows: 24,
        },
      },
      { type: 'peer-presences' },
      {
        type: 'task-command-takeover-request',
        action: 'type in the terminal',
        expiresAt: 10,
        requestId: 'request-1',
        requesterClientId: 'peer-1',
      },
      {
        type: 'task-command-takeover-result',
        decision: 'maybe',
        requestId: 'request-1',
        taskId: 'task-1',
      },
      { type: 'ipc-event', payload: {} },
    ];

    for (const message of malformedMessages) {
      expect(() => options.onMessage(message)).not.toThrow();
    }

    expect(collaborationState.applyRemoteIpcEventMock).not.toHaveBeenCalled();
    expect(collaborationState.applyRemoteStateBootstrapMock).not.toHaveBeenCalled();
    expect(collaborationState.handleRemoteTakeoverResultMock).not.toHaveBeenCalled();
    expect(collaborationState.replaceRemotePeerPresencesMock).not.toHaveBeenCalled();
    expect(collaborationState.upsertIncomingRemoteTakeoverRequestMock).not.toHaveBeenCalled();
    expect(taskState.applyRemoteTaskPortsChangedMock).not.toHaveBeenCalled();
  });

  it('applies only array state-bootstrap payloads from the websocket transport', async () => {
    const { options } = await loadWsModule();
    const snapshots = [
      {
        category: 'peer-presence',
        mode: 'replace',
        payload: [],
        version: 1,
      },
    ];

    options.onMessage({
      type: 'state-bootstrap',
      snapshots,
    });
    expect(collaborationState.applyRemoteStateBootstrapMock).toHaveBeenCalledWith(snapshots);

    collaborationState.applyRemoteStateBootstrapMock.mockClear();
    options.onMessage({
      type: 'state-bootstrap',
      snapshots: null,
    });

    expect(collaborationState.applyRemoteStateBootstrapMock).not.toHaveBeenCalled();
  });

  it('applies direct task-port control messages because the remote list consumes preview availability', async () => {
    const { options } = await loadWsModule();
    const message: ServerMessage = {
      type: 'task-ports-changed',
      kind: 'snapshot',
      taskId: 'task-1',
      exposed: [],
      observed: [],
      updatedAt: 0,
    };

    options.onMessage(message);

    expect(taskState.applyRemoteTaskPortsChangedMock).toHaveBeenCalledWith(message);
  });

  it('ignores malformed direct task-port control messages', async () => {
    const { options } = await loadWsModule();
    const message = {
      type: 'task-ports-changed',
      kind: 'snapshot',
      taskId: 'task-1',
      exposed: [
        {
          availability: 'available',
          host: '127.0.0.1',
          label: 'Preview',
          lastVerifiedAt: null,
          port: '3000',
          protocol: 'http',
          source: 'manual',
          statusMessage: null,
          updatedAt: 0,
          verifiedHost: '127.0.0.1',
        },
      ],
      observed: [],
      updatedAt: 0,
    };

    options.onMessage(message);

    expect(taskState.applyRemoteTaskPortsChangedMock).not.toHaveBeenCalled();
  });

  it('ignores direct task-port control messages with non-finite numeric fields', async () => {
    const { options } = await loadWsModule();
    const message = {
      type: 'task-ports-changed',
      kind: 'snapshot',
      taskId: 'task-1',
      exposed: [
        {
          availability: 'available',
          host: '127.0.0.1',
          label: 'Preview',
          lastVerifiedAt: Number.NaN,
          port: 3000,
          protocol: 'http',
          source: 'manual',
          statusMessage: null,
          updatedAt: 0,
          verifiedHost: '127.0.0.1',
        },
      ],
      observed: [],
      updatedAt: Number.POSITIVE_INFINITY,
    };

    options.onMessage(message);

    expect(taskState.applyRemoteTaskPortsChangedMock).not.toHaveBeenCalled();
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

  it('returns to disconnected when the initial remote websocket connect fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { module } = await loadWsModule();
    const listener = vi.fn();
    module.subscribeRemoteConnectionStatus(listener);
    websocketState.ensureConnectedMock.mockRejectedValueOnce(new Error('connect failed'));

    module.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(module.status()).toBe('disconnected');
    expect(listener).toHaveBeenLastCalledWith('disconnected');
    warnSpy.mockRestore();
  });

  it('clears remote websocket listeners and projections during test reset', async () => {
    const { module, options } = await loadWsModule();
    const statusListener = vi.fn();
    const outputListener = vi.fn();

    module.subscribeRemoteConnectionStatus(statusListener);
    module.onOutput('agent-1', outputListener);
    options.onMessage(createAgentsMessage([createAgent({ lastLine: 'snapshot ready' })]));
    options.onMessage(createOutputMessage(Buffer.from('\nlive ready', 'utf8').toString('base64')));

    expect(module.agents()).toHaveLength(1);
    expect(module.getAgentPreview('agent-1')).toBe('live ready');
    expect(outputListener).toHaveBeenCalledTimes(1);

    statusListener.mockClear();
    outputListener.mockClear();
    module.resetRemoteWsRuntimeStateForTests();

    expect(module.agents()).toEqual([]);
    expect(module.status()).toBe('disconnected');
    expect(module.authRequired()).toBe(false);
    expect(module.getAgentPreview('agent-1')).toBe('');
    expect(module.getAgentLastActivityAt('agent-1')).toBeNull();

    options.onStateChange?.('connected');
    options.onMessage(createOutputMessage(Buffer.from('\nafter reset', 'utf8').toString('base64')));

    expect(statusListener).not.toHaveBeenCalled();
    expect(outputListener).not.toHaveBeenCalled();
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

    module.resetRemoteWsRuntimeStateForTests();
  });

  it('logs when lifecycle reconnect fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { module } = await loadWsModule();

    module.connect();
    websocketState.ensureConnectedMock.mockRejectedValueOnce(new Error('reconnect failed'));

    window.dispatchEvent(new Event('pageshow'));
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith(
      '[remote-ws] Failed to reconnect websocket session',
      expect.any(Error),
    );

    module.resetRemoteWsRuntimeStateForTests();
    warnSpy.mockRestore();
  });
});
