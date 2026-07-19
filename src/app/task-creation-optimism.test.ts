import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../store/state';
import { resetStoreForTest } from '../test/store-test-helpers';
import {
  createTaskOptimistically,
  dismissPendingTaskCreation,
  listPendingTaskCreations,
  resetPendingTaskCreationsForTests,
  retryPendingTaskCreation,
} from './task-creation-optimism';

interface DeferredCreate {
  reject: (error: unknown) => void;
  resolve: (taskId: string) => void;
  run: () => Promise<string>;
  runCount: () => number;
}

function createDeferredCreate(): DeferredCreate {
  let settle: { reject: (error: unknown) => void; resolve: (taskId: string) => void } | null = null;
  let runCount = 0;

  return {
    reject(error: unknown): void {
      settle?.reject(error);
    },
    resolve(taskId: string): void {
      settle?.resolve(taskId);
    },
    run(): Promise<string> {
      runCount += 1;
      return new Promise<string>((resolve, reject) => {
        settle = { reject, resolve };
      });
    },
    runCount: () => runCount,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('task-creation-optimism', () => {
  beforeEach(() => {
    resetStoreForTest();
    resetPendingTaskCreationsForTests();
  });

  afterEach(() => {
    resetPendingTaskCreationsForTests();
    resetStoreForTest();
  });

  it('registers a creating entry synchronously and removes it when the thunk resolves', async () => {
    const deferred = createDeferredCreate();
    const created: string[] = [];

    const pendingId = createTaskOptimistically({
      baseBranch: 'main',
      gitIsolation: 'current-branch',
      launchLabel: 'Claude',
      name: 'New task',
      onCreated: (taskId) => created.push(taskId),
      projectId: 'project-1',
      taskMode: 'agent',
      run: deferred.run,
    });

    expect(pendingId.startsWith('pending-task:')).toBe(true);
    expect(listPendingTaskCreations()).toMatchObject([
      {
        baseBranch: 'main',
        gitIsolation: 'current-branch',
        name: 'New task',
        pendingId,
        state: { kind: 'creating' },
      },
    ]);

    deferred.resolve('task-real');
    await flushMicrotasks();

    expect(listPendingTaskCreations()).toEqual([]);
    expect(created).toEqual(['task-real']);
  });

  it('moves the entry to an error state with the failure message when the thunk rejects', async () => {
    const deferred = createDeferredCreate();
    const pendingId = createTaskOptimistically({
      launchLabel: 'Claude',
      name: 'Failing task',
      projectId: 'project-1',
      taskMode: 'agent',
      run: deferred.run,
    });

    deferred.reject(new Error('Worktree creation failed'));
    await flushMicrotasks();

    expect(listPendingTaskCreations()).toMatchObject([
      { pendingId, state: { kind: 'error', message: 'Worktree creation failed' } },
    ]);
  });

  it('falls back to a generic message for blank failures', async () => {
    const deferred = createDeferredCreate();
    createTaskOptimistically({
      launchLabel: 'Claude',
      name: 'Failing task',
      projectId: 'project-1',
      taskMode: 'agent',
      run: deferred.run,
    });

    deferred.reject(new Error('  '));
    await flushMicrotasks();

    expect(listPendingTaskCreations()[0]?.state).toEqual({
      kind: 'error',
      message: 'Task creation failed.',
    });
  });

  it('retry re-runs the captured thunk from the error state and resolves the entry', async () => {
    const deferred = createDeferredCreate();
    const pendingId = createTaskOptimistically({
      launchLabel: 'Claude',
      name: 'Retry task',
      projectId: 'project-1',
      taskMode: 'agent',
      run: deferred.run,
    });

    deferred.reject(new Error('Transient failure'));
    await flushMicrotasks();
    expect(deferred.runCount()).toBe(1);

    retryPendingTaskCreation(pendingId);
    expect(listPendingTaskCreations()[0]?.state).toEqual({ kind: 'creating' });
    expect(deferred.runCount()).toBe(2);

    deferred.resolve('task-real');
    await flushMicrotasks();
    expect(listPendingTaskCreations()).toEqual([]);
  });

  it('ignores retry for entries that are still creating', async () => {
    const deferred = createDeferredCreate();
    const pendingId = createTaskOptimistically({
      launchLabel: 'Claude',
      name: 'Busy task',
      projectId: 'project-1',
      taskMode: 'agent',
      run: deferred.run,
    });

    retryPendingTaskCreation(pendingId);
    expect(deferred.runCount()).toBe(1);

    deferred.resolve('task-real');
    await flushMicrotasks();
  });

  it('dismiss removes an error entry and a late rejection cannot revive it', async () => {
    const deferred = createDeferredCreate();
    const pendingId = createTaskOptimistically({
      launchLabel: 'Claude',
      name: 'Dismissed task',
      projectId: 'project-1',
      taskMode: 'agent',
      run: deferred.run,
    });

    deferred.reject(new Error('Initial failure'));
    await flushMicrotasks();

    expect(listPendingTaskCreations()).toMatchObject([
      { pendingId, state: { kind: 'error', message: 'Initial failure' } },
    ]);

    dismissPendingTaskCreation(pendingId);
    expect(listPendingTaskCreations()).toEqual([]);

    deferred.reject(new Error('Late failure'));
    await flushMicrotasks();
    expect(listPendingTaskCreations()).toEqual([]);
  });

  it('ignores dismiss while creation is still in flight', async () => {
    const deferred = createDeferredCreate();
    const pendingId = createTaskOptimistically({
      launchLabel: 'Claude',
      name: 'Still creating',
      projectId: 'project-1',
      taskMode: 'agent',
      run: deferred.run,
    });

    dismissPendingTaskCreation(pendingId);
    expect(listPendingTaskCreations()).toMatchObject([{ pendingId, state: { kind: 'creating' } }]);

    deferred.resolve('task-real');
    await flushMicrotasks();
    expect(listPendingTaskCreations()).toEqual([]);
  });

  it('never lets pending ids enter canonical task records', async () => {
    const deferred = createDeferredCreate();
    const pendingId = createTaskOptimistically({
      launchLabel: 'Claude',
      name: 'Ghost task',
      projectId: 'project-1',
      taskMode: 'agent',
      run: deferred.run,
    });

    expect(store.tasks[pendingId]).toBeUndefined();
    expect(store.taskOrder).not.toContain(pendingId);

    deferred.reject(new Error('failed'));
    await flushMicrotasks();
    expect(store.tasks[pendingId]).toBeUndefined();
    expect(store.taskOrder).not.toContain(pendingId);
  });

  it('reset seam clears all pending entries', () => {
    const deferred = createDeferredCreate();
    createTaskOptimistically({
      launchLabel: 'Claude',
      name: 'Reset task',
      projectId: 'project-1',
      taskMode: 'agent',
      run: deferred.run,
    });

    resetPendingTaskCreationsForTests();
    expect(listPendingTaskCreations()).toEqual([]);
  });
});
