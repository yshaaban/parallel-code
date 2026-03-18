import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStoreForTest } from '../test/store-test-helpers';

vi.mock('../lib/runtime-client-id', () => ({
  getRuntimeClientId: vi.fn(() => 'client-self'),
}));

import {
  applyTaskCommandControllerChanged,
  getTaskCommandController,
  resetTaskCommandControllerStateForTests,
} from './task-command-controllers';

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
});
