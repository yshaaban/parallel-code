import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserControlPlaneContractHarness,
  type FakeWebSocketClient,
  getMessagesOfType,
  type WebSocketContractHarness,
} from '../harness/websocket-contract-harness';
import type { AnyServerStateBootstrapSnapshot } from '../../src/domain/server-state-bootstrap';

function getBootstrapSnapshots(
  harness: WebSocketContractHarness,
  client: FakeWebSocketClient,
): AnyServerStateBootstrapSnapshot[] {
  const messages = getMessagesOfType(harness, client, 'state-bootstrap') as Array<{
    snapshots: AnyServerStateBootstrapSnapshot[];
  }>;

  return messages[0]?.snapshots ?? [];
}

function getGitStatusSnapshotPayload(
  harness: WebSocketContractHarness,
  client: FakeWebSocketClient,
) {
  return getBootstrapSnapshots(harness, client).find(
    (snapshot) => snapshot.category === 'git-status',
  )?.payload;
}

let harness: WebSocketContractHarness = createBrowserControlPlaneContractHarness();

describe('browser git-state contract', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.useFakeTimers();
    harness = createBrowserControlPlaneContractHarness();
  });

  afterEach(() => {
    harness.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('replays only current status snapshots to newly authenticated clients', async () => {
    harness.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: false,
        has_uncommitted_changes: true,
      },
    });
    harness.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-1',
    });

    const client = harness.createClient();
    expect(harness.authenticateConnection(client, 'client-1')).toBe(true);
    await harness.flush();

    expect(getGitStatusSnapshotPayload(harness, client)).toEqual([
      expect.objectContaining({
        worktreePath: '/tmp/task-1',
        status: {
          has_committed_changes: false,
          has_uncommitted_changes: true,
        },
      }),
    ]);
  });

  it('does not replay invalidation-only messages after a snapshot is removed', async () => {
    harness.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });
    harness.removeGitStatus?.('/tmp/task-1');
    harness.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-1',
    });

    const client = harness.createClient();
    expect(harness.authenticateConnection(client, 'client-1')).toBe(true);
    await harness.flush();

    expect(getGitStatusSnapshotPayload(harness, client)).toEqual([]);
  });

  it('replays the latest snapshot for each worktree independently', async () => {
    harness.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: false,
        has_uncommitted_changes: true,
      },
    });
    harness.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });
    harness.broadcastControl({
      type: 'git-status-changed',
      worktreePath: '/tmp/task-2',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: true,
      },
    });

    const client = harness.createClient();
    expect(harness.authenticateConnection(client, 'client-1')).toBe(true);
    await harness.flush();

    expect(getGitStatusSnapshotPayload(harness, client)).toEqual([
      expect.objectContaining({
        worktreePath: '/tmp/task-1',
        status: {
          has_committed_changes: true,
          has_uncommitted_changes: false,
        },
      }),
      expect.objectContaining({
        worktreePath: '/tmp/task-2',
        status: {
          has_committed_changes: true,
          has_uncommitted_changes: true,
        },
      }),
    ]);
  });
});
