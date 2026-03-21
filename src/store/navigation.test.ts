import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setStore, store } from './core';
import { registerFocusFn, resetFocusStateForTests } from './focus';
import { moveActiveTask } from './navigation';
import {
  createTestAgent,
  createTestProject,
  createTestTask,
  resetStoreForTest,
} from '../test/store-test-helpers';

describe('moveActiveTask', () => {
  beforeEach(() => {
    resetStoreForTest();
    resetFocusStateForTests();
  });

  afterEach(() => {
    resetFocusStateForTests();
    vi.restoreAllMocks();
  });

  it('re-focuses the moved task panel after keyboard reordering', () => {
    const project = createTestProject();
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      projectId: project.id,
    });
    const neighbor = createTestTask({
      agentIds: ['agent-2'],
      id: 'task-2',
      projectId: project.id,
    });

    setStore('projects', [project]);
    setStore('tasks', {
      'task-1': task,
      'task-2': neighbor,
    });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-2' }),
    });
    setStore('taskOrder', ['task-1', 'task-2']);
    setStore('activeTaskId', 'task-1');
    setStore('activeAgentId', 'agent-1');
    setStore('focusedPanel', { 'task-1': 'prompt' });

    const focusMock = vi.fn();
    registerFocusFn('task-1:prompt', focusMock);

    moveActiveTask('right');

    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(store.taskOrder).toEqual(['task-2', 'task-1']);
    expect(store.activeTaskId).toBe('task-1');
  });
});
