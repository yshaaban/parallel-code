import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { IPC } from '../electron/ipc/channels.js';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from '../electron/ipc/runtime-diagnostics.js';
import {
  acquireTaskCommandLease,
  clearTaskCommandLeaseForTask,
  getTaskCommandControllerSnapshot,
  releaseTaskCommandLease,
  resetTaskCommandLeasesForTest,
} from '../electron/ipc/task-command-leases.js';
import {
  isReplayTruncatedMessage,
  type ReplayTruncatedMessage,
  type UpdatePresenceCommand,
} from '../electron/remote/protocol.js';
import * as serverStateBootstrapModule from '../electron/ipc/server-state-bootstrap.js';
import { SERVER_STATE_BOOTSTRAP_CATEGORIES } from '../src/domain/server-state-bootstrap.js';
import { createBrowserControlPlane, getStaleBootstrapCategories } from './browser-control-plane.js';

type FakeWebSocketClient = WebSocket & {
  bufferedAmount: number;
  readyState: WebSocket['readyState'];
};

function createFakeClient(): { client: FakeWebSocketClient; sent: unknown[] } {
  const sent: unknown[] = [];
  const client = {
    bufferedAmount: 0,
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    send: vi.fn((value: unknown) => {
      sent.push(typeof value === 'string' ? JSON.parse(value) : value);
    }),
    terminate: vi.fn(),
  } as unknown as FakeWebSocketClient;

  return { client, sent };
}

function setClientBufferedAmount(client: FakeWebSocketClient, bufferedAmount: number): void {
  client.bufferedAmount = bufferedAmount;
}

function setClientReadyState(
  client: FakeWebSocketClient,
  readyState: WebSocket['readyState'],
): void {
  client.readyState = readyState;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStateBootstrapMessage(
  message: unknown,
): message is { snapshots: unknown[]; type: 'state-bootstrap' } {
  return (
    isObjectRecord(message) &&
    message.type === 'state-bootstrap' &&
    Array.isArray(message.snapshots)
  );
}

function getStateBootstrapSnapshots(sent: unknown[]): unknown[] {
  const bootstrapMessage = sent.find(isStateBootstrapMessage);

  if (!bootstrapMessage) {
    throw new Error('Missing state-bootstrap message');
  }

  return bootstrapMessage.snapshots;
}

interface SequencedMessage {
  seq: number;
  type: string;
}

function isSequencedMessage(message: unknown): message is SequencedMessage {
  return (
    isObjectRecord(message) && typeof message.seq === 'number' && typeof message.type === 'string'
  );
}

interface RemoteStatusMessage {
  connectedClients: number;
  peerClients: number;
  type: 'remote-status';
}

function isRemoteStatusMessage(message: unknown): message is RemoteStatusMessage {
  return (
    isObjectRecord(message) &&
    message.type === 'remote-status' &&
    typeof message.connectedClients === 'number' &&
    typeof message.peerClients === 'number'
  );
}

function getSequencedMessages(sent: unknown[]): SequencedMessage[] {
  return sent.filter(isSequencedMessage);
}

function findSentMessageIndex(
  sent: unknown[],
  predicate: (message: unknown) => boolean,
  description: string,
): number {
  const index = sent.findIndex(predicate);
  if (index === -1) {
    throw new Error(`Missing sent message: ${description}`);
  }

  return index;
}

function findRemoteStatusMessageIndex(
  sent: unknown[],
  connectedClients: number,
  description: string,
): number {
  return findSentMessageIndex(
    sent,
    (message) => isRemoteStatusMessage(message) && message.connectedClients === connectedClients,
    description,
  );
}

const activeControlPlanes: Array<ReturnType<typeof createBrowserControlPlane>> = [];

function createTrackedControlPlane(
  options: Parameters<typeof createBrowserControlPlane>[0],
): ReturnType<typeof createBrowserControlPlane> {
  const controlPlane = createBrowserControlPlane(options);
  activeControlPlanes.push(controlPlane);
  return controlPlane;
}

function acquireTaskCommandLeaseForTest(
  taskId: string,
  clientId: string,
  action: string,
  takeover = false,
): ReturnType<typeof acquireTaskCommandLease> {
  return acquireTaskCommandLease(taskId, clientId, `owner:${clientId}`, action, takeover);
}

function createPresenceUpdate(
  overrides: Partial<Omit<UpdatePresenceCommand, 'type'>> &
    Pick<UpdatePresenceCommand, 'displayName' | 'visibility'>,
): UpdatePresenceCommand {
  return {
    type: 'update-presence',
    activeTaskId: null,
    controllingAgentIds: [],
    controllingTaskIds: [],
    focusedSurface: null,
    ...overrides,
  };
}

describe('browser control plane', () => {
  afterEach(() => {
    while (activeControlPlanes.length > 0) {
      activeControlPlanes.pop()?.cleanup();
    }
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetBackendRuntimeDiagnostics();
    resetTaskCommandLeasesForTest();
  });

  it('replays the latest git status snapshot to newly authenticated clients', () => {
    vi.spyOn(serverStateBootstrapModule, 'getServerStateBootstrap').mockReturnValue([
      {
        category: 'git-status',
        mode: 'replace',
        payload: [
          {
            worktreePath: '/tmp/task-1',
            status: {
              has_committed_changes: true,
              has_uncommitted_changes: false,
            },
          },
        ],
        version: 1,
      },
      {
        category: 'remote-status',
        mode: 'replace',
        payload: {
          enabled: true,
          connectedClients: 1,
          peerClients: 0,
          port: 7777,
          tailscaleUrl: null,
          token: 'secret',
          url: 'http://127.0.0.1:7777?token=secret',
          wifiUrl: null,
        },
        version: 1,
      },
      { category: 'agent-supervision', mode: 'replace', payload: [], version: 0 },
      { category: 'task-convergence', mode: 'replace', payload: [], version: 0 },
      { category: 'task-ports', mode: 'replace', payload: [], version: 0 },
    ]);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(sent).toContainEqual({
      type: 'agents',
      list: [],
      version: expect.any(Number),
    });
    expect(getStateBootstrapSnapshots(sent)).toContainEqual({
      category: 'git-status',
      mode: 'replace',
      payload: [
        {
          worktreePath: '/tmp/task-1',
          status: {
            has_committed_changes: true,
            has_uncommitted_changes: false,
          },
        },
      ],
      version: expect.any(Number),
    });
  });

  it('does not replay removed git status snapshots', () => {
    vi.spyOn(serverStateBootstrapModule, 'getServerStateBootstrap').mockReturnValue([
      { category: 'git-status', mode: 'replace', payload: [], version: 2 },
      {
        category: 'remote-status',
        mode: 'replace',
        payload: {
          enabled: true,
          connectedClients: 1,
          peerClients: 0,
          port: 7777,
          tailscaleUrl: null,
          token: 'secret',
          url: 'http://127.0.0.1:7777?token=secret',
          wifiUrl: null,
        },
        version: 1,
      },
      { category: 'agent-supervision', mode: 'replace', payload: [], version: 0 },
      { category: 'task-convergence', mode: 'replace', payload: [], version: 0 },
      { category: 'task-ports', mode: 'replace', payload: [], version: 0 },
    ]);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(getStateBootstrapSnapshots(sent)).toContainEqual({
      category: 'git-status',
      mode: 'replace',
      payload: [],
      version: expect.any(Number),
    });
  });

  it('replays only the latest git status snapshot for a worktree', () => {
    vi.spyOn(serverStateBootstrapModule, 'getServerStateBootstrap').mockReturnValue([
      {
        category: 'git-status',
        mode: 'replace',
        payload: [
          {
            worktreePath: '/tmp/task-1',
            status: {
              has_committed_changes: true,
              has_uncommitted_changes: false,
            },
          },
        ],
        version: 2,
      },
      {
        category: 'remote-status',
        mode: 'replace',
        payload: {
          enabled: true,
          connectedClients: 1,
          peerClients: 0,
          port: 7777,
          tailscaleUrl: null,
          token: 'secret',
          url: 'http://127.0.0.1:7777?token=secret',
          wifiUrl: null,
        },
        version: 1,
      },
      { category: 'agent-supervision', mode: 'replace', payload: [], version: 0 },
      { category: 'task-convergence', mode: 'replace', payload: [], version: 0 },
      { category: 'task-ports', mode: 'replace', payload: [], version: 0 },
    ]);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(getStateBootstrapSnapshots(sent)).toContainEqual({
      category: 'git-status',
      mode: 'replace',
      payload: [
        {
          worktreePath: '/tmp/task-1',
          status: {
            has_committed_changes: true,
            has_uncommitted_changes: false,
          },
        },
      ],
      version: expect.any(Number),
    });
  });

  it('publishes the actual bound server port after startup', () => {
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 0,
      token: 'secret',
    });

    controlPlane.setServerPort(43123);

    expect(controlPlane.getServerInfo()).toMatchObject({
      port: 43123,
      token: 'secret',
      url: 'http://127.0.0.1:43123?token=secret',
    });
  });

  it('replays the latest agent supervision snapshot to newly authenticated clients', () => {
    vi.spyOn(serverStateBootstrapModule, 'getServerStateBootstrap').mockReturnValue([
      { category: 'git-status', mode: 'replace', payload: [], version: 0 },
      {
        category: 'remote-status',
        mode: 'replace',
        payload: {
          enabled: true,
          connectedClients: 1,
          peerClients: 0,
          port: 7777,
          tailscaleUrl: null,
          token: 'secret',
          url: 'http://127.0.0.1:7777?token=secret',
          wifiUrl: null,
        },
        version: 1,
      },
      {
        category: 'agent-supervision',
        mode: 'replace',
        payload: [
          {
            agentId: 'agent-1',
            attentionReason: 'waiting-input',
            isShell: false,
            lastOutputAt: 1_000,
            preview: 'Proceed? [Y/n]',
            state: 'awaiting-input',
            taskId: 'task-1',
            updatedAt: 1_000,
          },
        ],
        version: 1,
      },
      { category: 'task-convergence', mode: 'replace', payload: [], version: 0 },
      { category: 'task-ports', mode: 'replace', payload: [], version: 0 },
    ]);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(getStateBootstrapSnapshots(sent)).toContainEqual({
      category: 'agent-supervision',
      mode: 'replace',
      payload: [
        {
          agentId: 'agent-1',
          attentionReason: 'waiting-input',
          isShell: false,
          lastOutputAt: 1_000,
          preview: 'Proceed? [Y/n]',
          state: 'awaiting-input',
          taskId: 'task-1',
          updatedAt: 1_000,
        },
      ],
      version: expect.any(Number),
    });
  });

  it('tracks peer presence snapshots for authenticated clients', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    const { client, sent } = createFakeClient();

    expect(controlPlane.authenticateConnection(client, 'client-a')).toBe(true);

    controlPlane.updatePeerPresence(
      client,
      createPresenceUpdate({
        activeTaskId: 'task-1',
        controllingAgentIds: ['agent-1'],
        controllingTaskIds: ['task-1'],
        displayName: 'Ivan',
        focusedSurface: 'ai-terminal',
        visibility: 'visible',
      }),
    );

    expect(controlPlane.getPeerPresenceSnapshots()).toEqual([
      {
        activeTaskId: 'task-1',
        clientId: 'client-a',
        controllingAgentIds: ['agent-1'],
        controllingTaskIds: ['task-1'],
        displayName: 'Ivan',
        focusedSurface: 'ai-terminal',
        lastSeenAt: expect.any(Number),
        visibility: 'visible',
      },
    ]);

    await vi.advanceTimersByTimeAsync(8);

    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'peer-presences',
        list: [
          {
            activeTaskId: 'task-1',
            clientId: 'client-a',
            controllingAgentIds: ['agent-1'],
            controllingTaskIds: ['task-1'],
            displayName: 'Ivan',
            focusedSurface: 'ai-terminal',
            lastSeenAt: expect.any(Number),
            visibility: 'visible',
          },
        ],
      }),
    );
  });

  it('brokers takeover request and result messages between sessions', () => {
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    const owner = createFakeClient();
    const requester = createFakeClient();

    expect(controlPlane.authenticateConnection(owner.client, 'client-a')).toBe(true);
    expect(controlPlane.authenticateConnection(requester.client, 'client-b')).toBe(true);

    controlPlane.updatePeerPresence(
      owner.client,
      createPresenceUpdate({
        displayName: 'Ivan',
        visibility: 'visible',
      }),
    );
    controlPlane.updatePeerPresence(
      requester.client,
      createPresenceUpdate({
        displayName: 'Sara',
        visibility: 'visible',
      }),
    );
    acquireTaskCommandLeaseForTest('task-1', 'client-a', 'type in the terminal');

    controlPlane.requestTaskCommandTakeover(requester.client, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-1',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });

    expect(owner.sent).toContainEqual({
      type: 'task-command-takeover-request',
      action: 'type in the terminal',
      expiresAt: expect.any(Number),
      requestId: 'request-1',
      requesterClientId: 'client-b',
      requesterDisplayName: 'Sara',
      taskId: 'task-1',
    });

    controlPlane.respondTaskCommandTakeover(owner.client, {
      type: 'respond-task-command-takeover',
      approved: true,
      requestId: 'request-1',
    });

    expect(requester.sent).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'approved',
      requestId: 'request-1',
      taskId: 'task-1',
    });
    expect(getTaskCommandControllerSnapshot('task-1')).toMatchObject({
      action: 'type in the terminal',
      controllerId: 'client-b',
    });
  });

  it('does not bootstrap a task command controller after final task cleanup clears it', () => {
    acquireTaskCommandLeaseForTest('task-deleted', 'client-a', 'close this task');
    expect(clearTaskCommandLeaseForTask('task-deleted').changed).toBe(true);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(getStateBootstrapSnapshots(sent)).toContainEqual({
      category: 'task-command-controller',
      mode: 'replace',
      payload: [],
      version: expect.any(Number),
    });
  });

  it('delivers a pending takeover result to a replacement requester socket after reconnect', () => {
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    const owner = createFakeClient();
    const firstRequester = createFakeClient();
    const replacementRequester = createFakeClient();

    expect(controlPlane.authenticateConnection(owner.client, 'client-a')).toBe(true);
    expect(controlPlane.authenticateConnection(firstRequester.client, 'client-b')).toBe(true);

    controlPlane.updatePeerPresence(
      owner.client,
      createPresenceUpdate({
        displayName: 'Ivan',
        visibility: 'visible',
      }),
    );
    controlPlane.updatePeerPresence(
      firstRequester.client,
      createPresenceUpdate({
        displayName: 'Sara',
        visibility: 'visible',
      }),
    );
    acquireTaskCommandLeaseForTest('task-1', 'client-a', 'type in the terminal');

    controlPlane.requestTaskCommandTakeover(firstRequester.client, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-reconnect',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });

    expect(controlPlane.authenticateConnection(replacementRequester.client, 'client-b')).toBe(true);
    controlPlane.cleanupClient(firstRequester.client);

    controlPlane.respondTaskCommandTakeover(owner.client, {
      type: 'respond-task-command-takeover',
      approved: true,
      requestId: 'request-reconnect',
    });

    expect(replacementRequester.sent).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'approved',
      requestId: 'request-reconnect',
      taskId: 'task-1',
    });
    expect(firstRequester.sent).not.toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'approved',
      requestId: 'request-reconnect',
      taskId: 'task-1',
    });
    expect(getTaskCommandControllerSnapshot('task-1')).toMatchObject({
      action: 'type in the terminal',
      controllerId: 'client-b',
    });
  });

  it('invalidates takeover approval when ownership moved to another client', () => {
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    const owner = createFakeClient();
    const requester = createFakeClient();
    const replacementOwner = createFakeClient();

    expect(controlPlane.authenticateConnection(owner.client, 'client-a')).toBe(true);
    expect(controlPlane.authenticateConnection(requester.client, 'client-b')).toBe(true);
    expect(controlPlane.authenticateConnection(replacementOwner.client, 'client-c')).toBe(true);

    controlPlane.updatePeerPresence(
      owner.client,
      createPresenceUpdate({
        displayName: 'Ivan',
        visibility: 'visible',
      }),
    );
    controlPlane.updatePeerPresence(
      requester.client,
      createPresenceUpdate({
        displayName: 'Sara',
        visibility: 'visible',
      }),
    );
    controlPlane.updatePeerPresence(
      replacementOwner.client,
      createPresenceUpdate({
        displayName: 'Mina',
        visibility: 'visible',
      }),
    );
    acquireTaskCommandLeaseForTest('task-1', 'client-a', 'type in the terminal');

    controlPlane.requestTaskCommandTakeover(requester.client, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-2',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });

    acquireTaskCommandLeaseForTest('task-1', 'client-c', 'type in the terminal', true);
    controlPlane.respondTaskCommandTakeover(owner.client, {
      type: 'respond-task-command-takeover',
      approved: true,
      requestId: 'request-2',
    });

    expect(requester.sent).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'denied',
      requestId: 'request-2',
      taskId: 'task-1',
    });
  });

  it('resolves pending takeovers when task ownership clears without a direct response', () => {
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    const owner = createFakeClient();
    const requester = createFakeClient();

    expect(controlPlane.authenticateConnection(owner.client, 'client-a')).toBe(true);
    expect(controlPlane.authenticateConnection(requester.client, 'client-b')).toBe(true);

    controlPlane.updatePeerPresence(
      owner.client,
      createPresenceUpdate({
        displayName: 'Ivan',
        visibility: 'visible',
      }),
    );
    controlPlane.updatePeerPresence(
      requester.client,
      createPresenceUpdate({
        displayName: 'Sara',
        visibility: 'visible',
      }),
    );
    acquireTaskCommandLeaseForTest('task-1', 'client-a', 'type in the terminal');

    controlPlane.requestTaskCommandTakeover(requester.client, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-cleared',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });

    const released = releaseTaskCommandLease('task-1', 'client-a', 'owner:client-a');
    controlPlane.emitIpcEvent(IPC.TaskCommandControllerChanged, released.snapshot);

    expect(requester.sent).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'owner-missing',
      requestId: 'request-cleared',
      taskId: 'task-1',
    });
    expect(owner.sent).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'owner-missing',
      requestId: 'request-cleared',
      taskId: 'task-1',
    });
  });

  it('clears owner takeover prompts when the requester disconnects', () => {
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    const owner = createFakeClient();
    const requester = createFakeClient();

    expect(controlPlane.authenticateConnection(owner.client, 'client-a')).toBe(true);
    expect(controlPlane.authenticateConnection(requester.client, 'client-b')).toBe(true);
    acquireTaskCommandLeaseForTest('task-1', 'client-a', 'type in the terminal');

    controlPlane.requestTaskCommandTakeover(requester.client, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-requester-gone',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });

    controlPlane.cleanupClient(requester.client);

    expect(owner.sent).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'denied',
      requestId: 'request-requester-gone',
      taskId: 'task-1',
    });
  });

  it('requires force takeover when the current owner stays active through timeout', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    const owner = createFakeClient();
    const requester = createFakeClient();

    expect(controlPlane.authenticateConnection(owner.client, 'client-a')).toBe(true);
    expect(controlPlane.authenticateConnection(requester.client, 'client-b')).toBe(true);

    controlPlane.updatePeerPresence(
      owner.client,
      createPresenceUpdate({
        activeTaskId: 'task-1',
        displayName: 'Ivan',
        focusedSurface: 'ai-terminal',
        visibility: 'visible',
      }),
    );
    acquireTaskCommandLeaseForTest('task-1', 'client-a', 'type in the terminal');

    controlPlane.requestTaskCommandTakeover(requester.client, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-force',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });

    await vi.advanceTimersByTimeAsync(8_000);

    expect(requester.sent).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'force-required',
      requestId: 'request-force',
      taskId: 'task-1',
    });
  });

  it('auto-approves takeover after timeout when the current owner is hidden', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    const owner = createFakeClient();
    const requester = createFakeClient();

    expect(controlPlane.authenticateConnection(owner.client, 'client-a')).toBe(true);
    expect(controlPlane.authenticateConnection(requester.client, 'client-b')).toBe(true);

    controlPlane.updatePeerPresence(
      owner.client,
      createPresenceUpdate({
        activeTaskId: 'task-1',
        displayName: 'Ivan',
        focusedSurface: 'hidden',
        visibility: 'hidden',
      }),
    );
    acquireTaskCommandLeaseForTest('task-1', 'client-a', 'type in the terminal');

    controlPlane.requestTaskCommandTakeover(requester.client, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-auto',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });

    await vi.advanceTimersByTimeAsync(8_000);

    expect(requester.sent).toContainEqual({
      type: 'task-command-takeover-result',
      decision: 'approved',
      requestId: 'request-auto',
      taskId: 'task-1',
    });
  });

  it('keeps task ownership while a stale socket closes for the same client id', () => {
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    const firstSocket = createFakeClient();
    const replacementSocket = createFakeClient();

    expect(controlPlane.authenticateConnection(firstSocket.client, 'client-a')).toBe(true);
    acquireTaskCommandLeaseForTest('task-1', 'client-a', 'type in the terminal');

    expect(controlPlane.authenticateConnection(replacementSocket.client, 'client-a')).toBe(true);
    controlPlane.cleanupClient(firstSocket.client);

    expect(getTaskCommandControllerSnapshot('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'client-a',
      taskId: 'task-1',
      version: expect.any(Number),
    });
    expect(controlPlane.getPeerPresenceSnapshots()).toEqual([
      expect.objectContaining({
        clientId: 'client-a',
      }),
    ]);

    controlPlane.cleanupClient(replacementSocket.client);
    // Reconnect grace: a full disconnect no longer releases the lease
    // immediately; natural lease expiry still governs a non-renewing holder.
    expect(getTaskCommandControllerSnapshot('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'client-a',
      taskId: 'task-1',
      version: expect.any(Number),
    });
    expect(getTaskCommandControllerSnapshot('task-1', Date.now() + 16_000)).toEqual({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: expect.any(Number),
    });
    expect(controlPlane.getPeerPresenceSnapshots()).toEqual([]);
  });

  it('keeps ownership and presence stable across repeated same-client reconnect churn', () => {
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    let activeSocket = createFakeClient();

    expect(controlPlane.authenticateConnection(activeSocket.client, 'client-a')).toBe(true);
    acquireTaskCommandLeaseForTest('task-1', 'client-a', 'type in the terminal');
    controlPlane.updatePeerPresence(
      activeSocket.client,
      createPresenceUpdate({
        activeTaskId: 'task-1',
        displayName: 'Session 0',
        focusedSurface: 'terminal',
        visibility: 'visible',
      }),
    );

    for (const cycle of [1, 2, 3, 4, 5]) {
      const staleSocket = activeSocket;
      activeSocket = createFakeClient();

      expect(controlPlane.authenticateConnection(activeSocket.client, 'client-a')).toBe(true);
      controlPlane.updatePeerPresence(
        activeSocket.client,
        createPresenceUpdate({
          activeTaskId: 'task-1',
          displayName: `Session ${cycle}`,
          focusedSurface: 'terminal',
          visibility: 'visible',
        }),
      );
      controlPlane.cleanupClient(staleSocket.client);

      expect(getTaskCommandControllerSnapshot('task-1')).toEqual({
        action: 'type in the terminal',
        controllerId: 'client-a',
        taskId: 'task-1',
        version: expect.any(Number),
      });
      expect(controlPlane.getPeerPresenceSnapshots()).toEqual([
        expect.objectContaining({
          activeTaskId: 'task-1',
          clientId: 'client-a',
          displayName: `Session ${cycle}`,
          focusedSurface: 'terminal',
          visibility: 'visible',
        }),
      ]);
      expect(controlPlane.getRemoteStatus()).toEqual(
        expect.objectContaining({
          connectedClients: 1,
          peerClients: 0,
        }),
      );
    }

    controlPlane.cleanupClient(activeSocket.client);
    // Reconnect grace: the lease survives the disconnect window; the
    // non-renewing holder still loses it through natural expiry.
    expect(getTaskCommandControllerSnapshot('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'client-a',
      taskId: 'task-1',
      version: expect.any(Number),
    });
    expect(getTaskCommandControllerSnapshot('task-1', Date.now() + 16_000)).toEqual({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: expect.any(Number),
    });
    expect(controlPlane.getPeerPresenceSnapshots()).toEqual([]);
  });

  it('handles task-command lease acquire, renew, and release on the control websocket', () => {
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    const socket = createFakeClient();

    expect(controlPlane.authenticateConnection(socket.client, 'client-a')).toBe(true);
    socket.sent.length = 0;

    controlPlane.handleTaskCommandLease(socket.client, {
      type: 'task-command-lease',
      action: 'type in the terminal',
      operation: 'acquire',
      ownerId: 'owner-a',
      requestId: 'lease-1',
      taskId: 'task-1',
    });

    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        operation: 'acquire',
        requestId: 'lease-1',
        result: expect.objectContaining({
          acquired: true,
          action: 'type in the terminal',
          controllerId: 'client-a',
          leaseGeneration: 1,
          taskId: 'task-1',
        }),
        type: 'task-command-lease-result',
      }),
    );
    expect(getTaskCommandControllerSnapshot('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'client-a',
      taskId: 'task-1',
      version: expect.any(Number),
    });

    socket.sent.length = 0;
    controlPlane.handleTaskCommandLease(socket.client, {
      type: 'task-command-lease',
      leaseGeneration: 1,
      operation: 'renew',
      ownerId: 'owner-a',
      requestId: 'lease-2',
      taskId: 'task-1',
    });

    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        operation: 'renew',
        requestId: 'lease-2',
        result: expect.objectContaining({
          controllerId: 'client-a',
          leaseGeneration: 1,
          renewed: true,
          taskId: 'task-1',
        }),
        type: 'task-command-lease-result',
      }),
    );

    socket.sent.length = 0;
    controlPlane.handleTaskCommandLease(socket.client, {
      type: 'task-command-lease',
      leaseGeneration: 1,
      operation: 'release',
      ownerId: 'owner-a',
      requestId: 'lease-3',
      taskId: 'task-1',
    });

    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        operation: 'release',
        requestId: 'lease-3',
        result: expect.objectContaining({
          action: null,
          controllerId: null,
          taskId: 'task-1',
        }),
        type: 'task-command-lease-result',
      }),
    );
    expect(getTaskCommandControllerSnapshot('task-1')).toEqual({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: expect.any(Number),
    });
  });

  it('prunes stale task ownership and presence when transport liveness drops without control-plane cleanup', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    const { client } = createFakeClient();

    expect(controlPlane.authenticateConnection(client, 'client-a')).toBe(true);
    controlPlane.updatePeerPresence(
      client,
      createPresenceUpdate({
        activeTaskId: 'task-1',
        controllingAgentIds: [],
        controllingTaskIds: ['task-1'],
        displayName: 'Client A',
        focusedSurface: 'ai-terminal',
        visibility: 'visible',
      }),
    );
    acquireTaskCommandLeaseForTest('task-1', 'client-a', 'type in the terminal');
    controlPlane.startHeartbeat();

    controlPlane.transport.cleanupClient(client);

    expect(getTaskCommandControllerSnapshot('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'client-a',
      taskId: 'task-1',
      version: expect.any(Number),
    });
    expect(controlPlane.getPeerPresenceSnapshots()).toEqual([
      expect.objectContaining({
        clientId: 'client-a',
      }),
    ]);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(getTaskCommandControllerSnapshot('task-1')).toEqual({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: expect.any(Number),
    });
    expect(controlPlane.getPeerPresenceSnapshots()).toEqual([]);
  });

  it('releases stale agent control when task ownership moves to another client', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [
        {
          agentId: 'agent-1',
          exitCode: null,
          lastLine: '',
          status: 'running',
          taskId: 'task-1',
          taskName: 'Task 1',
        },
      ],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });
    const owner = createFakeClient();
    const requester = createFakeClient();

    expect(controlPlane.authenticateConnection(owner.client, 'client-a')).toBe(true);
    expect(controlPlane.authenticateConnection(requester.client, 'client-b')).toBe(true);
    acquireTaskCommandLeaseForTest('task-1', 'client-a', 'type in the terminal');

    expect(controlPlane.transport.claimAgentControl(owner.client, 'agent-1')).toEqual({
      ok: true,
      controllerId: 'client-a',
    });
    expect(controlPlane.transport.getAgentControllerId('agent-1')).toBe('client-a');

    const takeover = acquireTaskCommandLeaseForTest(
      'task-1',
      'client-b',
      'type in the terminal',
      true,
    );
    controlPlane.emitIpcEvent(IPC.TaskCommandControllerChanged, takeover);
    await vi.advanceTimersByTimeAsync(1);

    expect(controlPlane.transport.getAgentControllerId('agent-1')).toBeNull();
    expect(owner.sent).toContainEqual({
      type: 'agent-controller',
      agentId: 'agent-1',
      controllerId: null,
      seq: expect.any(Number),
    });
  });

  it('replays the current remote status to newly authenticated clients', () => {
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(getStateBootstrapSnapshots(sent)).toContainEqual({
      category: 'remote-status',
      mode: 'replace',
      payload: expect.objectContaining({
        enabled: true,
        connectedClients: 1,
        peerClients: 0,
      }),
      version: expect.any(Number),
    });
  });

  it('replays control events before authoritative bootstrap and sends fresh auth status', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const firstSession = createFakeClient();
    expect(controlPlane.authenticateConnection(firstSession.client, 'browser-client')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    firstSession.sent.length = 0;

    controlPlane.broadcastControl({
      type: 'task-event',
      event: 'created',
      name: 'Replay task',
      taskId: 'task-1',
    });
    controlPlane.broadcastRemoteStatus();
    await vi.advanceTimersByTimeAsync(1);

    const replayedMessages = getSequencedMessages(firstSession.sent);
    const taskEvent = replayedMessages.find((message) => message.type === 'task-event');
    if (!taskEvent) {
      throw new Error('Expected a task-event control message before reconnect');
    }
    expect(taskEvent).toEqual(
      expect.objectContaining({
        seq: expect.any(Number),
        type: 'task-event',
      }),
    );

    const reconnectSession = createFakeClient();
    expect(
      controlPlane.authenticateConnection(reconnectSession.client, 'browser-client', taskEvent.seq),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    const reconnectRemoteStatuses = reconnectSession.sent.filter(isRemoteStatusMessage);

    expect(reconnectRemoteStatuses).toEqual([
      expect.objectContaining({
        connectedClients: 1,
        type: 'remote-status',
      }),
      expect.objectContaining({
        connectedClients: 2,
        type: 'remote-status',
      }),
    ]);
    const replayedRemoteStatusIndex = findRemoteStatusMessageIndex(
      reconnectSession.sent,
      1,
      'replayed remote status',
    );
    const bootstrapIndex = findSentMessageIndex(
      reconnectSession.sent,
      isStateBootstrapMessage,
      'authoritative bootstrap',
    );
    const freshRemoteStatusIndex = findRemoteStatusMessageIndex(
      reconnectSession.sent,
      2,
      'fresh auth remote status',
    );

    expect(replayedRemoteStatusIndex).toBeLessThan(bootstrapIndex);
    expect(freshRemoteStatusIndex).toBeGreaterThan(bootstrapIndex);
    expect(reconnectSession.sent).toContainEqual({
      list: [],
      type: 'agents',
      version: expect.any(Number),
    });
    expect(reconnectSession.sent).toContainEqual(
      expect.objectContaining({
        type: 'state-bootstrap',
      }),
    );
    expect(getStateBootstrapSnapshots(reconnectSession.sent)).toContainEqual({
      category: 'remote-status',
      mode: 'replace',
      payload: expect.objectContaining({
        connectedClients: 2,
        enabled: true,
        peerClients: 1,
      }),
      version: expect.any(Number),
    });
  });

  it('signals replay truncation before bootstrap when the auth cursor predates the retained ring', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      controlEventBufferSize: 2,
      port: 7777,
      token: 'secret',
    });

    const firstSession = createFakeClient();
    expect(controlPlane.authenticateConnection(firstSession.client, 'browser-client')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    const firstSessionSequenced = getSequencedMessages(firstSession.sent);
    expect(firstSessionSequenced.length).toBeGreaterThan(0);
    const lastSeq = firstSessionSequenced.reduce(
      (highest, message) => Math.max(highest, message.seq),
      -1,
    );
    firstSession.sent.length = 0;

    controlPlane.broadcastControl({
      type: 'remote-status',
      connectedClients: 1,
      peerClients: 0,
    });
    controlPlane.broadcastControl({
      type: 'agent-controller',
      agentId: 'agent-1',
      controllerId: 'browser-client',
    });
    controlPlane.broadcastControl({
      type: 'task-event',
      event: 'created',
      taskId: 'task-1',
    });
    await vi.advanceTimersByTimeAsync(1);

    const reconnectSession = createFakeClient();
    expect(
      controlPlane.authenticateConnection(reconnectSession.client, 'browser-client', lastSeq),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    const replayTruncatedIndex = findSentMessageIndex(
      reconnectSession.sent,
      isReplayTruncatedMessage,
      'replay truncation metadata',
    );
    const bootstrapIndex = findSentMessageIndex(
      reconnectSession.sent,
      isStateBootstrapMessage,
      'authoritative bootstrap',
    );
    const replayTruncated = reconnectSession.sent[replayTruncatedIndex];

    expect(replayTruncated).toEqual(
      expect.objectContaining({
        lastSeq,
        type: 'replay-truncated',
      }),
    );
    expect((replayTruncated as ReplayTruncatedMessage).oldestAvailableSeq).toBeGreaterThan(
      lastSeq + 1,
    );
    expect(replayTruncatedIndex).toBeLessThan(bootstrapIndex);
  });

  it('does not manufacture replay truncation from the auth client-count broadcast', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      controlEventBufferSize: 3,
      port: 7777,
      token: 'secret',
    });

    const firstSession = createFakeClient();
    expect(controlPlane.authenticateConnection(firstSession.client, 'browser-client')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    const lastSeq = getSequencedMessages(firstSession.sent).reduce(
      (highest, message) => Math.max(highest, message.seq),
      -1,
    );

    controlPlane.broadcastControl({
      type: 'remote-status',
      connectedClients: 1,
      peerClients: 0,
    });
    controlPlane.broadcastControl({
      type: 'agent-controller',
      agentId: 'agent-1',
      controllerId: 'browser-client',
    });
    controlPlane.broadcastControl({
      type: 'task-event',
      event: 'created',
      taskId: 'task-1',
    });
    await vi.advanceTimersByTimeAsync(1);

    const reconnectSession = createFakeClient();
    expect(
      controlPlane.authenticateConnection(reconnectSession.client, 'browser-client', lastSeq),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    expect(reconnectSession.sent.filter(isReplayTruncatedMessage)).toEqual([]);
    expect(getSequencedMessages(reconnectSession.sent).map((message) => message.seq)).toEqual(
      expect.arrayContaining([lastSeq + 1, lastSeq + 2, lastSeq + 3]),
    );
  });

  it('does not replay removed agent supervision snapshots', () => {
    vi.spyOn(serverStateBootstrapModule, 'getServerStateBootstrap').mockReturnValue([
      { category: 'git-status', mode: 'replace', payload: [], version: 0 },
      {
        category: 'remote-status',
        mode: 'replace',
        payload: {
          enabled: true,
          connectedClients: 1,
          peerClients: 0,
          port: 7777,
          tailscaleUrl: null,
          token: 'secret',
          url: 'http://127.0.0.1:7777?token=secret',
          wifiUrl: null,
        },
        version: 1,
      },
      { category: 'agent-supervision', mode: 'replace', payload: [], version: 2 },
      { category: 'task-convergence', mode: 'replace', payload: [], version: 0 },
      { category: 'task-ports', mode: 'replace', payload: [], version: 0 },
    ]);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(getStateBootstrapSnapshots(sent)).toContainEqual({
      category: 'agent-supervision',
      mode: 'replace',
      payload: [],
      version: expect.any(Number),
    });
  });

  it('replays the latest task port snapshot to newly authenticated clients', () => {
    vi.spyOn(serverStateBootstrapModule, 'getServerStateBootstrap').mockReturnValue([
      { category: 'git-status', mode: 'replace', payload: [], version: 0 },
      {
        category: 'remote-status',
        mode: 'replace',
        payload: {
          enabled: true,
          connectedClients: 1,
          peerClients: 0,
          port: 7777,
          tailscaleUrl: null,
          token: 'secret',
          url: 'http://127.0.0.1:7777?token=secret',
          wifiUrl: null,
        },
        version: 1,
      },
      { category: 'agent-supervision', mode: 'replace', payload: [], version: 0 },
      { category: 'task-convergence', mode: 'replace', payload: [], version: 0 },
      {
        category: 'task-ports',
        mode: 'replace',
        payload: [
          {
            taskId: 'task-1',
            observed: [
              {
                host: '127.0.0.1',
                port: 5173,
                protocol: 'http',
                source: 'output',
                suggestion: 'http://127.0.0.1:5173',
                updatedAt: 1_000,
              },
            ],
            exposed: [
              {
                availability: 'available',
                host: '127.0.0.1',
                label: 'Frontend',
                lastVerifiedAt: 1_100,
                port: 5173,
                protocol: 'http',
                statusMessage: null,
                source: 'observed',
                updatedAt: 1_100,
                verifiedHost: '127.0.0.1',
              },
            ],
            updatedAt: 1_100,
          },
        ],
        version: 1,
      },
    ]);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(getStateBootstrapSnapshots(sent)).toContainEqual({
      category: 'task-ports',
      mode: 'replace',
      payload: [
        {
          taskId: 'task-1',
          observed: [
            {
              host: '127.0.0.1',
              port: 5173,
              protocol: 'http',
              source: 'output',
              suggestion: 'http://127.0.0.1:5173',
              updatedAt: 1_000,
            },
          ],
          exposed: [
            {
              availability: 'available',
              host: '127.0.0.1',
              label: 'Frontend',
              lastVerifiedAt: 1_100,
              port: 5173,
              protocol: 'http',
              statusMessage: null,
              source: 'observed',
              updatedAt: 1_100,
              verifiedHost: '127.0.0.1',
            },
          ],
          updatedAt: 1_100,
        },
      ],
      version: expect.any(Number),
    });
  });

  it('does not replay removed task port snapshots', () => {
    vi.spyOn(serverStateBootstrapModule, 'getServerStateBootstrap').mockReturnValue([
      { category: 'git-status', mode: 'replace', payload: [], version: 0 },
      {
        category: 'remote-status',
        mode: 'replace',
        payload: {
          enabled: true,
          connectedClients: 1,
          peerClients: 0,
          port: 7777,
          tailscaleUrl: null,
          token: 'secret',
          url: 'http://127.0.0.1:7777?token=secret',
          wifiUrl: null,
        },
        version: 1,
      },
      { category: 'agent-supervision', mode: 'replace', payload: [], version: 0 },
      { category: 'task-convergence', mode: 'replace', payload: [], version: 0 },
      { category: 'task-ports', mode: 'replace', payload: [], version: 2 },
    ]);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(getStateBootstrapSnapshots(sent)).toContainEqual({
      category: 'task-ports',
      mode: 'replace',
      payload: [],
      version: expect.any(Number),
    });
  });

  it('broadcasts removed task port events without coercing them into snapshots', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);
    sent.length = 0;

    controlPlane.emitTaskPortsChanged({
      kind: 'snapshot',
      taskId: 'task-1',
      observed: [],
      exposed: [],
      updatedAt: 1,
    });
    await vi.runOnlyPendingTimersAsync();
    sent.length = 0;

    controlPlane.emitTaskPortsChanged({
      kind: 'removed',
      removed: true,
      taskId: 'task-1',
    });
    await vi.runOnlyPendingTimersAsync();

    expect(sent).toContainEqual({
      kind: 'removed',
      removed: true,
      seq: expect.any(Number),
      taskId: 'task-1',
      type: 'task-ports-changed',
    });
  });

  it('replays the latest task convergence snapshot to newly authenticated clients', () => {
    vi.spyOn(serverStateBootstrapModule, 'getServerStateBootstrap').mockReturnValue([
      { category: 'git-status', mode: 'replace', payload: [], version: 0 },
      {
        category: 'remote-status',
        mode: 'replace',
        payload: {
          enabled: true,
          connectedClients: 1,
          peerClients: 0,
          port: 7777,
          tailscaleUrl: null,
          token: 'secret',
          url: 'http://127.0.0.1:7777?token=secret',
          wifiUrl: null,
        },
        version: 1,
      },
      { category: 'agent-supervision', mode: 'replace', payload: [], version: 0 },
      {
        category: 'task-convergence',
        mode: 'replace',
        payload: [
          {
            branchFiles: ['src/app.ts'],
            branchName: 'feature/task-1',
            changedFileCount: 1,
            commitCount: 2,
            conflictingFiles: [],
            hasCommittedChanges: true,
            hasUncommittedChanges: false,
            mainAheadCount: 0,
            overlapWarnings: [],
            projectId: 'project-1',
            state: 'review-ready',
            summary: '2 commits, 1 file changed',
            taskId: 'task-1',
            totalAdded: 5,
            totalRemoved: 1,
            updatedAt: 1_000,
            worktreePath: '/tmp/task-1',
          },
        ],
        version: 1,
      },
      { category: 'task-ports', mode: 'replace', payload: [], version: 0 },
    ]);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(getStateBootstrapSnapshots(sent)).toContainEqual({
      category: 'task-convergence',
      mode: 'replace',
      payload: [
        {
          branchFiles: ['src/app.ts'],
          branchName: 'feature/task-1',
          changedFileCount: 1,
          commitCount: 2,
          conflictingFiles: [],
          hasCommittedChanges: true,
          hasUncommittedChanges: false,
          mainAheadCount: 0,
          overlapWarnings: [],
          projectId: 'project-1',
          state: 'review-ready',
          summary: '2 commits, 1 file changed',
          taskId: 'task-1',
          totalAdded: 5,
          totalRemoved: 1,
          updatedAt: 1_000,
          worktreePath: '/tmp/task-1',
        },
      ],
      version: expect.any(Number),
    });
  });

  it('does not replay removed task convergence snapshots', () => {
    vi.spyOn(serverStateBootstrapModule, 'getServerStateBootstrap').mockReturnValue([
      { category: 'git-status', mode: 'replace', payload: [], version: 0 },
      {
        category: 'remote-status',
        mode: 'replace',
        payload: {
          enabled: true,
          connectedClients: 1,
          peerClients: 0,
          port: 7777,
          tailscaleUrl: null,
          token: 'secret',
          url: 'http://127.0.0.1:7777?token=secret',
          wifiUrl: null,
        },
        version: 1,
      },
      { category: 'agent-supervision', mode: 'replace', payload: [], version: 0 },
      { category: 'task-convergence', mode: 'replace', payload: [], version: 2 },
      { category: 'task-ports', mode: 'replace', payload: [], version: 0 },
    ]);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(getStateBootstrapSnapshots(sent)).toContainEqual({
      category: 'task-convergence',
      mode: 'replace',
      payload: [],
      version: expect.any(Number),
    });
  });

  it('records backpressure and not-open send failures', () => {
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    const { client } = createFakeClient();
    setClientBufferedAmount(client, 2_000_000);
    expect(
      controlPlane.sendMessage(client, {
        type: 'remote-status',
        connectedClients: 1,
        peerClients: 0,
      }),
    ).toBe(false);

    setClientBufferedAmount(client, 0);
    setClientReadyState(client, WebSocket.CLOSED);
    expect(
      controlPlane.sendMessage(client, {
        type: 'remote-status',
        connectedClients: 1,
        peerClients: 0,
      }),
    ).toBe(false);

    expect(getBackendRuntimeDiagnosticsSnapshot().browserControl).toMatchObject({
      backpressureRejects: 1,
      maxBufferedAmountBytes: 2_000_000,
      notOpenRejects: 1,
      sendErrors: 0,
    });
  });

  it('records send-error failures and cleans up the client', () => {
    const cleanupSocketClient = vi.fn();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient,
      port: 7777,
      token: 'secret',
    });

    const { client } = createFakeClient();
    client.send = vi.fn(() => {
      throw new Error('boom');
    });

    expect(controlPlane.sendChannelData(client, Buffer.from('test'))).toBe(false);

    expect(cleanupSocketClient).toHaveBeenCalledWith(client);
    expect(getBackendRuntimeDiagnosticsSnapshot().browserControl).toMatchObject({
      backpressureRejects: 0,
      notOpenRejects: 0,
      sendErrors: 1,
    });
  });

  it('drops queued control sends for closed clients without retrying forever', () => {
    vi.useFakeTimers();
    const cleanupSocketClient = vi.fn();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient,
      port: 7777,
      token: 'secret',
    });

    const { client } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);
    setClientReadyState(client, WebSocket.CLOSED);

    controlPlane.emitGitStatusChanged({
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });

    vi.runOnlyPendingTimers();

    expect(cleanupSocketClient).toHaveBeenCalledWith(client);
    expect(getBackendRuntimeDiagnosticsSnapshot().browserControl).toMatchObject({
      backpressureRejects: 0,
      notOpenRejects: 1,
      sendErrors: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let batched control sends from before a diagnostics reset pollute the next sample', () => {
    vi.useFakeTimers();
    const cleanupSocketClient = vi.fn();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient,
      port: 7777,
      token: 'secret',
    });

    const { client } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);
    setClientReadyState(client, WebSocket.CLOSED);

    controlPlane.emitGitStatusChanged({
      worktreePath: '/tmp/task-reset',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });
    resetBackendRuntimeDiagnostics();

    vi.runOnlyPendingTimers();

    expect(cleanupSocketClient).toHaveBeenCalledWith(client);
    expect(getBackendRuntimeDiagnosticsSnapshot().browserControl).toMatchObject({
      backpressureRejects: 0,
      notOpenRejects: 0,
      sendErrors: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one delayed queue per client when channel latency simulation is enabled', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      simulateJitterMs: 0,
      simulateLatencyMs: 50,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();

    expect(controlPlane.sendChannelData(client, Buffer.from('first'))).toBe(true);
    expect(controlPlane.sendChannelData(client, Buffer.from('second'))).toBe(true);
    expect(sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([Buffer.from('first'), Buffer.from('second')]);
    expect(getBackendRuntimeDiagnosticsSnapshot().browserControl).toMatchObject({
      delayedQueueMaxAgeMs: expect.any(Number),
      delayedQueueMaxBytes: expect.any(Number),
      delayedQueueMaxDepth: 2,
    });
    expect(vi.getTimerCount()).toBe(0);
  }, 10_000);

  it('preserves a high-volume delayed queue across storage compaction', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      simulateJitterMs: 0,
      simulateLatencyMs: 50,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    const messageCount = 2_500;
    for (let index = 0; index < messageCount; index += 1) {
      expect(controlPlane.sendChannelData(client, Buffer.from(String(index)))).toBe(true);
    }

    expect(controlPlane.getPendingChannelSendState(client)?.queueDepth).toBe(messageCount);
    await vi.advanceTimersByTimeAsync(50);

    expect(sent).toHaveLength(messageCount);
    expect(sent[0]).toEqual(Buffer.from('0'));
    expect(sent[sent.length - 1]).toEqual(Buffer.from(String(messageCount - 1)));
    expect(controlPlane.getPendingChannelSendState(client)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  }, 10_000);

  it('does not let delayed sends from before a diagnostics reset pollute the next sample', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      simulateJitterMs: 0,
      simulateLatencyMs: 50,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();

    expect(controlPlane.sendChannelData(client, Buffer.from('stale'))).toBe(true);
    resetBackendRuntimeDiagnostics();

    await vi.advanceTimersByTimeAsync(50);

    expect(sent).toEqual([Buffer.from('stale')]);
    expect(getBackendRuntimeDiagnosticsSnapshot().browserControl).toMatchObject({
      delayedQueueMaxAgeMs: 0,
      delayedQueueMaxBytes: 0,
      delayedQueueMaxDepth: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  }, 10_000);

  it('clears pending batched and delayed sends during control-plane cleanup', async () => {
    vi.useFakeTimers();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      simulateJitterMs: 0,
      simulateLatencyMs: 50,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);
    const sentBeforeQueuedWork = sent.length;

    controlPlane.emitGitStatusChanged({
      worktreePath: '/tmp/task-cleanup',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });
    expect(controlPlane.sendChannelData(client, Buffer.from('late-channel-data'))).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    controlPlane.cleanup();

    expect(vi.getTimerCount()).toBe(0);
    await vi.runOnlyPendingTimersAsync();
    expect(sent).toHaveLength(sentBeforeQueuedWork);
    expect(controlPlane.getPendingChannelSendState(client)).toBeNull();
  });

  it('treats simulated packet loss as true send drops for channel data', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      simulatePacketLoss: 1,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();

    expect(controlPlane.sendChannelData(client, Buffer.from('dropped'))).toBe(true);

    expect(sent).toHaveLength(0);
    expect(getBackendRuntimeDiagnosticsSnapshot().browserControl).toMatchObject({
      simulatedDroppedSends: 1,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leave an empty delayed-send queue after a simulated drop', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(1);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      simulatePacketLoss: 0.5,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();

    expect(controlPlane.sendChannelData(client, Buffer.from('dropped'))).toBe(true);
    expect(controlPlane.getPendingChannelSendState(client)).toBeNull();
    expect(controlPlane.sendChannelData(client, Buffer.from('delivered'))).toBe(true);

    expect(sent).toEqual([Buffer.from('delivered')]);
  });

  it('preserves FIFO delayed sends when simulated jitter changes delivery due times', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValueOnce(1).mockReturnValueOnce(0);

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      simulateJitterMs: 50,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();

    expect(controlPlane.sendChannelData(client, Buffer.from('slow-first'))).toBe(true);
    expect(controlPlane.sendChannelData(client, Buffer.from('fast-second'))).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([Buffer.from('slow-first'), Buffer.from('fast-second')]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves FIFO between delayed channel data and later control JSON', async () => {
    vi.useFakeTimers();

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      simulateLatencyMs: 50,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();

    expect(controlPlane.sendChannelData(client, Buffer.from('channel-first'))).toBe(true);
    expect(
      controlPlane.sendMessage(client, {
        agentId: 'agent-1',
        exitCode: null,
        status: 'running',
        type: 'status',
      }),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(49);
    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([
      Buffer.from('channel-first'),
      {
        agentId: 'agent-1',
        exitCode: null,
        status: 'running',
        type: 'status',
      },
    ]);
  });

  it('drops queued control sends for backpressured clients so replay can recover', () => {
    vi.useFakeTimers();
    const cleanupSocketClient = vi.fn();
    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient,
      port: 7777,
      token: 'secret',
    });

    const { client } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);
    setClientBufferedAmount(client, 2_000_000);

    controlPlane.emitGitStatusChanged({
      worktreePath: '/tmp/task-2',
      status: {
        has_committed_changes: false,
        has_uncommitted_changes: true,
      },
    });

    vi.runOnlyPendingTimers();

    expect(cleanupSocketClient).toHaveBeenCalledWith(client);
    expect(getBackendRuntimeDiagnosticsSnapshot().browserControl).toMatchObject({
      backpressureRejects: 1,
      notOpenRejects: 0,
      sendErrors: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves client identity while websocket-side cleanup runs during transport termination', () => {
    vi.useFakeTimers();
    let transportClientIdDuringSocketCleanup: string | null = null;
    const cleanupSocketClient = vi.fn((client: WebSocket) => {
      transportClientIdDuringSocketCleanup = controlPlane.transport.getClientId(client);
    });

    const controlPlane = createTrackedControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient,
      port: 7777,
      token: 'secret',
    });

    const { client } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    const authenticatedClientId = controlPlane.transport.getClientId(client);
    expect(authenticatedClientId).toBeTruthy();

    setClientReadyState(client, WebSocket.CLOSED);
    controlPlane.emitGitStatusChanged({
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });
    vi.runOnlyPendingTimers();

    expect(cleanupSocketClient).toHaveBeenCalledWith(client);
    expect(transportClientIdDuringSocketCleanup).toBe(authenticatedClientId);
    expect(controlPlane.transport.getClientId(client)).toBeNull();
  });
});

describe('getStaleBootstrapCategories', () => {
  function buildCurrentVersions(): Record<string, number> {
    const versions: Record<string, number> = {};
    for (const [index, category] of SERVER_STATE_BOOTSTRAP_CATEGORIES.entries()) {
      versions[category] = index + 1;
    }
    return versions;
  }

  it('resends only the ephemeral connection-scoped categories when everything is current', () => {
    const versions = buildCurrentVersions();

    expect(getStaleBootstrapCategories(versions, versions).sort()).toEqual([
      'peer-presence',
      'remote-status',
    ]);
  });

  it('marks mismatched and unpresented categories stale', () => {
    const serverVersions = buildCurrentVersions();
    const presented = { ...serverVersions };
    presented.coordinator = (serverVersions.coordinator ?? 0) - 1;
    delete presented['task-ports'];

    expect(getStaleBootstrapCategories(serverVersions, presented).sort()).toEqual([
      'coordinator',
      'peer-presence',
      'remote-status',
      'task-ports',
    ]);
  });

  // A throwing version getter omits the category from the server version map
  // (getServerStateBootstrapVersions); the handshake must still visit it and
  // rebuild it instead of silently dropping it from the resend set.
  it('treats a category missing from the server version map as stale', () => {
    const serverVersions = buildCurrentVersions();
    const presented = { ...serverVersions };
    delete serverVersions.coordinator;

    expect(getStaleBootstrapCategories(serverVersions, presented)).toContain('coordinator');
    expect(getStaleBootstrapCategories(serverVersions, presented).sort()).toEqual([
      'coordinator',
      'peer-presence',
      'remote-status',
    ]);
  });
});
