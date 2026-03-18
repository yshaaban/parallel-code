import { describe, expect, it } from 'vitest';
import {
  applyTaskCommandControllerSnapshotRecord,
  areTaskCommandControllerStatesEqual,
  getTaskCommandControllerSnapshot,
  normalizeTaskCommandControllerSnapshots,
  shouldApplyTaskCommandControllerSnapshot,
} from './task-command-controller-projection';

describe('task-command controller projection', () => {
  it('ignores stale snapshots and keeps the newest controller per task', () => {
    expect(
      normalizeTaskCommandControllerSnapshots([
        {
          action: 'type in the terminal',
          controllerId: 'client-old',
          taskId: 'task-1',
          version: 1,
        },
        {
          action: 'send a prompt',
          controllerId: 'client-new',
          taskId: 'task-1',
          version: 3,
        },
        {
          action: 'type in the terminal',
          controllerId: 'client-stale',
          taskId: 'task-1',
          version: 2,
        },
      ]),
    ).toEqual({
      'task-1': {
        action: 'send a prompt',
        controllerId: 'client-new',
        taskId: 'task-1',
        version: 3,
      },
    });
  });

  it('removes a task controller when a newer clear snapshot arrives', () => {
    const previous = {
      'task-1': {
        action: 'type in the terminal',
        controllerId: 'client-1',
        taskId: 'task-1',
        version: 2,
      },
    };

    expect(
      applyTaskCommandControllerSnapshotRecord(previous, {
        action: null,
        controllerId: null,
        taskId: 'task-1',
        version: 3,
      }),
    ).toEqual({});
  });

  it('rejects stale task-controller snapshots', () => {
    expect(
      shouldApplyTaskCommandControllerSnapshot(
        {
          action: 'type in the terminal',
          controllerId: 'client-1',
          taskId: 'task-1',
          version: 4,
        },
        {
          action: 'send a prompt',
          controllerId: 'client-2',
          taskId: 'task-1',
          version: 3,
        },
      ),
    ).toBe(false);
  });

  it('creates a cleared snapshot when controller state is missing', () => {
    expect(getTaskCommandControllerSnapshot('task-1', null, 7)).toEqual({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 7,
    });
  });

  it('compares controller states by action and controller id only', () => {
    expect(
      areTaskCommandControllerStatesEqual(
        {
          action: 'type in the terminal',
          controllerId: 'client-1',
        },
        {
          action: 'type in the terminal',
          controllerId: 'client-1',
        },
      ),
    ).toBe(true);

    expect(
      areTaskCommandControllerStatesEqual(
        {
          action: 'type in the terminal',
          controllerId: 'client-1',
        },
        {
          action: 'send a prompt',
          controllerId: 'client-1',
        },
      ),
    ).toBe(false);
  });
});
