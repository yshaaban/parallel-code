import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStoreForTest } from '../test/store-test-helpers';

vi.mock('../lib/runtime-client-id', () => ({
  getRuntimeClientId: vi.fn(() => 'client-self'),
}));

import {
  applyTaskCommandControllerChanged,
  getTaskCommandController,
  listControlledTaskIdsByController,
  removeTaskCommandControllerStoreState,
  resetTaskCommandControllerStateForTests,
} from './task-command-controllers';
import { store } from './core';

describe('task-command controller state', () => {
  beforeEach(() => {
    resetStoreForTest();
    resetTaskCommandControllerStateForTests();
  });

  afterEach(() => {
    resetStoreForTest();
    resetTaskCommandControllerStateForTests();
  });

  it('ignores a stale controller claim after a newer clear snapshot removed it', () => {
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-1',
      taskId: 'task-1',
      version: 4,
    });
    applyTaskCommandControllerChanged({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 5,
    });
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-stale',
      taskId: 'task-1',
      version: 4,
    });

    expect(getTaskCommandController('task-1')).toBeNull();
  });

  it('lists controlled task ids for a controller in sorted order', () => {
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'client-self',
      taskId: 'task-2',
      version: 1,
    });
    applyTaskCommandControllerChanged({
      action: 'send a prompt',
      controllerId: 'peer-1',
      taskId: 'task-3',
      version: 2,
    });
    applyTaskCommandControllerChanged({
      action: 'send a prompt',
      controllerId: 'client-self',
      taskId: 'task-1',
      version: 3,
    });

    expect(listControlledTaskIdsByController('client-self')).toEqual(['task-1', 'task-2']);
    expect(listControlledTaskIdsByController('peer-1')).toEqual(['task-3']);
  });

  it('clears per-task version truth when a controller entry is removed through store cleanup', () => {
    applyTaskCommandControllerChanged({
      action: 'send a prompt',
      controllerId: 'peer-1',
      taskId: 'task-1',
      version: 5,
    });

    removeTaskCommandControllerStoreState(store, 'task-1');
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-2',
      taskId: 'task-1',
      version: 1,
    });

    expect(getTaskCommandController('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-2',
      version: 1,
    });
  });
});
