import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { createTestTask, resetStoreForTest } from '../test/store-test-helpers';
import { store } from '../store/state';
import { jumpToTaskWithPrewarm, navigateTaskWithPrewarm } from './task-navigation-intents';
import {
  resetTerminalPrewarmForTests,
  subscribeTerminalPrewarm,
  type TerminalPrewarmReason,
} from './terminal-prewarm';

describe('task-navigation-intents', () => {
  let prewarms: Array<{ reason: TerminalPrewarmReason; taskId: string }>;
  let unsubscribers: Array<() => void>;

  function subscribeTaskPrewarm(taskId: string): void {
    unsubscribers.push(
      subscribeTerminalPrewarm(taskId, (reason) => {
        prewarms.push({ reason, taskId });
      }),
    );
  }

  beforeEach(() => {
    resetStoreForTest();
    resetTerminalPrewarmForTests();
    prewarms = [];
    unsubscribers = [];
    setStore('tasks', 'task-1', createTestTask({ id: 'task-1' }));
    setStore('tasks', 'task-2', createTestTask({ id: 'task-2' }));
    setStore('tasks', 'task-3', createTestTask({ id: 'task-3' }));
    setStore('taskOrder', ['task-1', 'task-2', 'task-3']);
    setStore('activeTaskId', 'task-2');
    for (const taskId of ['task-1', 'task-2', 'task-3']) {
      subscribeTaskPrewarm(taskId);
    }
  });

  afterEach(() => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    resetTerminalPrewarmForTests();
    resetStoreForTest();
    vi.restoreAllMocks();
  });

  it('prewarms the predicted neighbor before navigating', () => {
    navigateTaskWithPrewarm('right');

    expect(prewarms).toEqual([{ reason: 'selection-intent', taskId: 'task-3' }]);
    expect(store.activeTaskId).toBe('task-3');
  });

  it('prewarms the left neighbor for left navigation', () => {
    navigateTaskWithPrewarm('left');

    expect(prewarms).toEqual([{ reason: 'selection-intent', taskId: 'task-1' }]);
    expect(store.activeTaskId).toBe('task-1');
  });

  it('does not prewarm when the predicted target falls off the edge of the order', () => {
    setStore('activeTaskId', 'task-3');

    navigateTaskWithPrewarm('right');

    expect(prewarms).toEqual([]);
  });

  it('does not prewarm or navigate while a blocking dialog is open', () => {
    setStore('showNewTaskDialog', true);

    navigateTaskWithPrewarm('right');

    expect(prewarms).toEqual([]);
    expect(store.activeTaskId).toBe('task-2');
  });

  it('prewarms the jump target before jumping', () => {
    jumpToTaskWithPrewarm(0);

    expect(prewarms).toEqual([{ reason: 'selection-intent', taskId: 'task-1' }]);
    expect(store.activeTaskId).toBe('task-1');
  });

  it('does not prewarm jumps to missing slots', () => {
    jumpToTaskWithPrewarm(7);

    expect(prewarms).toEqual([]);
  });
});
