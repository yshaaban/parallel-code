import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { IPC } from '../electron/ipc/channels.js';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from '../electron/ipc/runtime-diagnostics.js';
import {
  acquireTaskCommandLease,
  getTaskCommandControllerSnapshot,
  releaseTaskCommandLease,
  resetTaskCommandLeasesForTest,
} from '../electron/ipc/task-command-leases.js';
import * as serverStateBootstrapModule from '../electron/ipc/server-state-bootstrap.js';
import { createBrowserControlPlane } from './browser-control-plane.js';

function createFakeClient(): { client: WebSocket; sent: unknown[] } {
  const sent: unknown[] = [];
  const client = {
    bufferedAmount: 0,
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    send: vi.fn((value: unknown) => {
      sent.push(typeof value === 'string' ? JSON.parse(value) : value);
    }),
    terminate: vi.fn(),
  } as unknown as WebSocket;

  return { client, sent };
}

function setClientBufferedAmount(client: WebSocket, bufferedAmount: number): void {
  (client as unknown as { bufferedAmount: number }).bufferedAmount = bufferedAmount;
}

function setClientReadyState(client: WebSocket, readyState: number): void {
  (client as unknown as { readyState: number }).readyState = readyState;
}

function getStateBootstrapSnapshots(sent: unknown[]): unknown[] {
  const bootstrapMessage = sent.find(
    (message): message is { type: 'state-bootstrap'; snapshots: unknown[] } =>
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      (message as { type?: unknown }).type === 'state-bootstrap',
  );

  if (!bootstrapMessage) {
    throw new Error('Missing state-bootstrap message');
  }

  return bootstrapMessage.snapshots;
}

const activeControlPlanes: Array<ReturnType<typeof createBrowserControlPlane>> = [];

function createTrackedControlPlane(
  options: Parameters<typeof createBrowserControlPlane>[0],
): ReturnType<typeof createBrowserControlPlane> {
  const controlPlane = createBrowserControlPlane(options);
  activeControlPlanes.push(controlPlane);
  return controlPlane;
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

    controlPlane.updatePeerPresence(client, {
      type: 'update-presence',
      activeTaskId: 'task-1',
      controllingAgentIds: ['agent-1'],
      controllingTaskIds: ['task-1'],
      displayName: 'Ivan',
      focusedSurface: 'ai-terminal',
      visibility: 'visible',
    });

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

    controlPlane.updatePeerPresence(owner.client, {
      type: 'update-presence',
      displayName: 'Ivan',
      visibility: 'visible',
    });
    controlPlane.updatePeerPresence(requester.client, {
      type: 'update-presence',
      displayName: 'Sara',
      visibility: 'visible',
    });
    acquireTaskCommandLease('task-1', 'client-a', 'type in the terminal');

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

    controlPlane.updatePeerPresence(owner.client, {
      type: 'update-presence',
      displayName: 'Ivan',
      visibility: 'visible',
    });
    controlPlane.updatePeerPresence(requester.client, {
      type: 'update-presence',
      displayName: 'Sara',
      visibility: 'visible',
    });
    controlPlane.updatePeerPresence(replacementOwner.client, {
      type: 'update-presence',
      displayName: 'Mina',
      visibility: 'visible',
    });
    acquireTaskCommandLease('task-1', 'client-a', 'type in the terminal');

    controlPlane.requestTaskCommandTakeover(requester.client, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-2',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });

    acquireTaskCommandLease('task-1', 'client-c', 'type in the terminal', true);
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

    controlPlane.updatePeerPresence(owner.client, {
      type: 'update-presence',
      displayName: 'Ivan',
      visibility: 'visible',
    });
    controlPlane.updatePeerPresence(requester.client, {
      type: 'update-presence',
      displayName: 'Sara',
      visibility: 'visible',
    });
    acquireTaskCommandLease('task-1', 'client-a', 'type in the terminal');

    controlPlane.requestTaskCommandTakeover(requester.client, {
      type: 'request-task-command-takeover',
      action: 'type in the terminal',
      requestId: 'request-cleared',
      targetControllerId: 'client-a',
      taskId: 'task-1',
    });

    const released = releaseTaskCommandLease('task-1', 'client-a');
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
    acquireTaskCommandLease('task-1', 'client-a', 'type in the terminal');

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

    controlPlane.updatePeerPresence(owner.client, {
      type: 'update-presence',
      activeTaskId: 'task-1',
      displayName: 'Ivan',
      focusedSurface: 'ai-terminal',
      visibility: 'visible',
    });
    acquireTaskCommandLease('task-1', 'client-a', 'type in the terminal');

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

    controlPlane.updatePeerPresence(owner.client, {
      type: 'update-presence',
      activeTaskId: 'task-1',
      displayName: 'Ivan',
      focusedSurface: 'hidden',
      visibility: 'hidden',
    });
    acquireTaskCommandLease('task-1', 'client-a', 'type in the terminal');

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
    acquireTaskCommandLease('task-1', 'client-a', 'type in the terminal');

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
    expect(getTaskCommandControllerSnapshot('task-1')).toEqual({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: expect.any(Number),
    });
    expect(controlPlane.getPeerPresenceSnapshots()).toEqual([]);
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
    controlPlane.updatePeerPresence(client, {
      type: 'update-presence',
      activeTaskId: 'task-1',
      controllingAgentIds: [],
      controllingTaskIds: ['task-1'],
      displayName: 'Client A',
      focusedSurface: 'ai-terminal',
      visibility: 'visible',
    });
    acquireTaskCommandLease('task-1', 'client-a', 'type in the terminal');
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
    acquireTaskCommandLease('task-1', 'client-a', 'type in the terminal');

    expect(controlPlane.transport.claimAgentControl(owner.client, 'agent-1')).toEqual({
      ok: true,
      controllerId: 'client-a',
    });
    expect(controlPlane.transport.getAgentControllerId('agent-1')).toBe('client-a');

    const takeover = acquireTaskCommandLease('task-1', 'client-b', 'type in the terminal', true);
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

  it('treats simulated packet loss as extra delay instead of dropping channel data', async () => {
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

    expect(controlPlane.sendChannelData(client, Buffer.from('delayed'))).toBe(true);
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(24);
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([Buffer.from('delayed')]);
    expect(vi.getTimerCount()).toBe(0);
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
});
