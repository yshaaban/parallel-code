import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStoreForTest } from '../test/store-test-helpers';

vi.mock('../lib/runtime-client-id', () => ({
  getRuntimeClientId: vi.fn(() => 'client-self'),
}));

import {
  applyTaskCommandControllerChanged,
  getTaskCommandController,
  getPeerTaskCommandControlStatus,
  listControlledTaskIdsByController,
  removeTaskCommandControllerStoreState,
  resetTaskCommandControllerStateForTests,
  subscribeTaskCommandControllerChanges,
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

  it('updates renewal versions without notifying when controller ownership is unchanged', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTaskCommandControllerChanges(listener);
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'client-self',
      taskId: 'task-1',
      version: 1,
    });
    listener.mockClear();

    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'client-self',
      taskId: 'task-1',
      version: 2,
    });

    expect(listener).not.toHaveBeenCalled();
    expect(getTaskCommandController('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'client-self',
      version: 2,
    });

    applyTaskCommandControllerChanged({
      action: 'send a prompt',
      controllerId: 'peer-stale',
      taskId: 'task-1',
      version: 1,
    });

    expect(getTaskCommandController('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'client-self',
      version: 2,
    });
    unsubscribe();
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

  it('does not fall back to stale peer presence when the local client is the authoritative controller', () => {
    store.peerSessions = {
      'peer-1': {
        activeTaskId: 'task-1',
        clientId: 'peer-1',
        controllingAgentIds: [],
        controllingTaskIds: ['task-1'],
        displayName: 'Ivan',
        focusedSurface: 'terminal',
        lastSeenAt: 1,
        visibility: 'visible',
      },
    };
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'client-self',
      taskId: 'task-1',
      version: 1,
    });

    expect(getPeerTaskCommandControlStatus('task-1', 'type in the terminal')).toBeNull();
  });
});
