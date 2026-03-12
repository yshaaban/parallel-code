import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
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

describe('browser control plane', () => {
  it('replays the latest git status snapshot to newly authenticated clients', () => {
    const controlPlane = createBrowserControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    controlPlane.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(sent).toContainEqual({
      type: 'agents',
      list: [],
    });
    expect(sent).toContainEqual({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });
  });

  it('does not replay removed git status snapshots', () => {
    const controlPlane = createBrowserControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    controlPlane.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });
    controlPlane.removeGitStatus('/tmp/task-1');

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    expect(sent).not.toContainEqual({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });
  });

  it('replays only the latest git status snapshot for a worktree', () => {
    const controlPlane = createBrowserControlPlane({
      buildAgentList: () => [],
      cleanupSocketClient: vi.fn(),
      port: 7777,
      token: 'secret',
    });

    controlPlane.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: false,
        has_uncommitted_changes: true,
      },
    });
    controlPlane.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });

    const { client, sent } = createFakeClient();
    expect(controlPlane.authenticateConnection(client)).toBe(true);

    const replayedGitStatuses = sent.filter(
      (message) => (message as { type?: unknown }).type === 'git-status-changed',
    );

    expect(replayedGitStatuses).toEqual([
      {
        type: 'git-status-changed',
        worktreePath: '/tmp/task-1',
        status: {
          has_committed_changes: true,
          has_uncommitted_changes: false,
        },
      },
    ]);
  });
});
