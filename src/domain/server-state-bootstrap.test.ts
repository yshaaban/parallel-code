import { describe, expect, it } from 'vitest';

import {
  filterServerStateBootstrapSnapshots,
  isServerStateBootstrapSnapshot,
  isServerStateEventPayload,
} from './server-state-bootstrap';

describe('server-state bootstrap domain helpers', () => {
  it('filters bootstrap snapshots by category-owned payload shape', () => {
    const validTaskReviewSnapshot = {
      category: 'task-review',
      mode: 'replace',
      payload: [
        {
          branchName: 'feature/task-1',
          files: [],
          projectId: 'project-1',
          revisionId: 'rev-1',
          source: 'worktree',
          taskId: 'task-1',
          totalAdded: 0,
          totalRemoved: 0,
          updatedAt: 10,
          worktreePath: '/tmp/task-1',
        },
      ],
      version: 4,
    };
    const mixedTaskReviewSnapshot = {
      ...validTaskReviewSnapshot,
      payload: [
        validTaskReviewSnapshot.payload[0],
        {
          ...validTaskReviewSnapshot.payload[0],
          source: 'cache',
          taskId: 'task-invalid',
        },
      ],
      version: 5,
    };

    expect(isServerStateBootstrapSnapshot(validTaskReviewSnapshot)).toBe(true);
    expect(
      filterServerStateBootstrapSnapshots([
        validTaskReviewSnapshot,
        {
          ...validTaskReviewSnapshot,
          payload: [{ ...validTaskReviewSnapshot.payload[0], source: 'cache' }],
        },
        {
          ...validTaskReviewSnapshot,
          category: 'unknown',
        },
        {
          ...validTaskReviewSnapshot,
          version: Number.NaN,
        },
        {
          ...validTaskReviewSnapshot,
          version: -1,
        },
        {
          ...validTaskReviewSnapshot,
          version: 1.5,
        },
        mixedTaskReviewSnapshot,
      ]),
    ).toEqual([
      validTaskReviewSnapshot,
      {
        ...mixedTaskReviewSnapshot,
        payload: [validTaskReviewSnapshot.payload[0]],
      },
    ]);
  });

  it('validates live event payloads through their owning domain guards', () => {
    expect(
      isServerStateEventPayload('task-ports', {
        exposed: [],
        kind: 'snapshot',
        observed: [],
        taskId: 'task-1',
        updatedAt: 10,
      }),
    ).toBe(true);
    expect(
      isServerStateEventPayload('task-ports', {
        kind: 'removed',
        removed: false,
        taskId: 'task-1',
      }),
    ).toBe(false);
    expect(
      isServerStateEventPayload('remote-status', {
        connectedClients: 2,
        peerClients: 1,
      }),
    ).toBe(true);
    expect(
      isServerStateEventPayload('remote-status', {
        connectedClients: 0,
        enabled: false,
        peerClients: 0,
        port: 3000,
        tailscaleUrl: null,
        token: 'stale-token',
        url: null,
        wifiUrl: null,
      }),
    ).toBe(false);
    expect(
      isServerStateEventPayload('remote-status', {
        connectedClients: 0,
        peerClients: 0,
        port: 3000,
        tailscaleUrl: null,
        token: 'stale-token',
        url: null,
        wifiUrl: null,
      }),
    ).toBe(false);
    expect(
      isServerStateEventPayload('task-steps', {
        errorMessage: null,
        latestStep: null,
        nextAction: null,
        preview: null,
        revisionId: 'task-1::steps',
        state: 'ready',
        stepCount: 0,
        taskId: 'task-1',
        trackingEnabled: true,
        updatedAt: 10,
      }),
    ).toBe(true);
  });
});
