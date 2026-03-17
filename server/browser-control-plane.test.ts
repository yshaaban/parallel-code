import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  getBackendRuntimeDiagnosticsSnapshot,
  resetBackendRuntimeDiagnostics,
} from '../electron/ipc/runtime-diagnostics.js';
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

describe('browser control plane', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetBackendRuntimeDiagnostics();
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

    const controlPlane = createBrowserControlPlane({
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

    const controlPlane = createBrowserControlPlane({
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

    const controlPlane = createBrowserControlPlane({
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

    const controlPlane = createBrowserControlPlane({
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

  it('replays the current remote status to newly authenticated clients', () => {
    const controlPlane = createBrowserControlPlane({
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

    const controlPlane = createBrowserControlPlane({
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

    const controlPlane = createBrowserControlPlane({
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

    const controlPlane = createBrowserControlPlane({
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

    const controlPlane = createBrowserControlPlane({
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

    const controlPlane = createBrowserControlPlane({
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
    const controlPlane = createBrowserControlPlane({
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
    const controlPlane = createBrowserControlPlane({
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
    const controlPlane = createBrowserControlPlane({
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

  it('uses one delayed queue per client when channel latency simulation is enabled', () => {
    vi.useFakeTimers();
    const controlPlane = createBrowserControlPlane({
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

    vi.advanceTimersByTime(49);
    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(sent).toEqual([Buffer.from('first'), Buffer.from('second')]);
    expect(getBackendRuntimeDiagnosticsSnapshot().browserControl).toMatchObject({
      delayedQueueMaxAgeMs: expect.any(Number),
      delayedQueueMaxBytes: expect.any(Number),
      delayedQueueMaxDepth: 2,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats simulated packet loss as extra delay instead of dropping channel data', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const controlPlane = createBrowserControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      simulatePacketLoss: 1,
      token: 'secret',
    });

    const { client, sent } = createFakeClient();

    expect(controlPlane.sendChannelData(client, Buffer.from('delayed'))).toBe(true);
    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(24);
    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(sent).toEqual([Buffer.from('delayed')]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops queued control sends for backpressured clients so replay can recover', () => {
    vi.useFakeTimers();
    const cleanupSocketClient = vi.fn();
    const controlPlane = createBrowserControlPlane({
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
