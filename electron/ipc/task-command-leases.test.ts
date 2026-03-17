import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireTaskCommandLease,
  getTaskCommandControllers,
  isTaskCommandLeaseHeld,
  releaseTaskCommandLease,
  renewTaskCommandLease,
  resetTaskCommandLeasesForTest,
} from './task-command-leases.js';

describe('task-command leases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTaskCommandLeasesForTest();
  });

  it('acquires, re-acquires, and snapshots a lease for the same client', () => {
    const first = acquireTaskCommandLease('task-1', 'client-a', 'merge this task', false, 1_000);
    const second = acquireTaskCommandLease('task-1', 'client-a', 'push this task', false, 2_000);

    expect(first).toMatchObject({
      acquired: true,
      action: 'merge this task',
      changed: true,
      controllerId: 'client-a',
      taskId: 'task-1',
    });
    expect(second).toMatchObject({
      acquired: true,
      action: 'push this task',
      changed: true,
      controllerId: 'client-a',
      taskId: 'task-1',
    });
    expect(getTaskCommandControllers(2_000)).toEqual([
      {
        action: 'push this task',
        controllerId: 'client-a',
        taskId: 'task-1',
      },
    ]);
    expect(isTaskCommandLeaseHeld('task-1', 'client-a', 2_000)).toBe(true);
  });

  it('rejects conflicting acquires until a takeover is requested', () => {
    acquireTaskCommandLease('task-1', 'client-a', 'merge this task', false, 1_000);

    const blocked = acquireTaskCommandLease('task-1', 'client-b', 'push this task', false, 2_000);
    const takeover = acquireTaskCommandLease('task-1', 'client-b', 'push this task', true, 2_000);

    expect(blocked).toMatchObject({
      acquired: false,
      action: 'merge this task',
      changed: false,
      controllerId: 'client-a',
      taskId: 'task-1',
    });
    expect(takeover).toMatchObject({
      acquired: true,
      action: 'push this task',
      changed: true,
      controllerId: 'client-b',
      taskId: 'task-1',
    });
  });

  it('renews only for the current holder and expires stale leases', () => {
    acquireTaskCommandLease('task-1', 'client-a', 'merge this task', false, 1_000);

    expect(renewTaskCommandLease('task-1', 'client-a', 5_000)).toMatchObject({
      renewed: true,
      controllerId: 'client-a',
      taskId: 'task-1',
    });
    expect(renewTaskCommandLease('task-1', 'client-b', 5_000)).toMatchObject({
      renewed: false,
      controllerId: 'client-a',
      taskId: 'task-1',
    });
    expect(getTaskCommandControllers(19_999)).toEqual([
      {
        action: 'merge this task',
        controllerId: 'client-a',
        taskId: 'task-1',
      },
    ]);
    expect(getTaskCommandControllers(20_001)).toEqual([]);
    expect(isTaskCommandLeaseHeld('task-1', 'client-a', 20_001)).toBe(false);
  });

  it('releases only for the current holder and prunes expired entries', () => {
    acquireTaskCommandLease('task-1', 'client-a', 'merge this task', false, 1_000);
    acquireTaskCommandLease('task-2', 'client-b', 'push this task', false, 1_000);

    expect(releaseTaskCommandLease('task-1', 'client-b', 2_000)).toEqual({
      changed: false,
      snapshot: {
        action: 'merge this task',
        controllerId: 'client-a',
        taskId: 'task-1',
      },
    });
    expect(releaseTaskCommandLease('task-1', 'client-a', 2_000)).toEqual({
      changed: true,
      snapshot: {
        action: null,
        controllerId: null,
        taskId: 'task-1',
      },
    });
    expect(releaseTaskCommandLease('task-2', undefined, 20_100)).toEqual({
      changed: false,
      snapshot: {
        action: null,
        controllerId: null,
        taskId: 'task-2',
      },
    });
    expect(getTaskCommandControllers(20_100)).toEqual([]);
  });
});
