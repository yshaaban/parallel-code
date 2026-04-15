import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStoreForTest } from '../test/store-test-helpers';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../lib/runtime-client-id', () => ({
  getRuntimeClientId: vi.fn(() => 'client-self'),
}));

import {
  applyTaskCommandControllerChanged,
  getTaskCommandController,
  loadTaskCommandControllers,
  resetTaskCommandControllerStateForTests,
} from './task-command-controllers';

describe('loadTaskCommandControllers', () => {
  beforeEach(() => {
    resetStoreForTest();
    resetTaskCommandControllerStateForTests();
    invokeMock.mockReset();
  });

  afterEach(() => {
    resetStoreForTest();
    resetTaskCommandControllerStateForTests();
  });

  it('preserves the current controller when the refresh request fails', async () => {
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'client-self',
      taskId: 'task-1',
      version: 2,
    });
    invokeMock.mockRejectedValueOnce(new Error('network unavailable'));

    await loadTaskCommandControllers();

    expect(getTaskCommandController('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'client-self',
      version: 2,
    });
  });

  it('preserves the current controller when the refresh payload is malformed', async () => {
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-1',
      taskId: 'task-1',
      version: 3,
    });
    invokeMock.mockResolvedValueOnce({
      controllers: null,
      version: 4,
    });

    await loadTaskCommandControllers();

    expect(getTaskCommandController('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-1',
      version: 3,
    });
  });

  it('replaces controller state when the refresh succeeds', async () => {
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-1',
      taskId: 'task-1',
      version: 1,
    });
    invokeMock.mockResolvedValueOnce({
      controllers: [
        {
          action: 'type in the terminal',
          controllerId: 'client-self',
          taskId: 'task-1',
          version: 2,
        },
      ],
      version: 2,
    });

    await loadTaskCommandControllers();

    expect(getTaskCommandController('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'client-self',
      version: 2,
    });
  });
});
