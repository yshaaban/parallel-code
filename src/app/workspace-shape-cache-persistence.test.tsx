import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';
import {
  beginAppStartupPresentation,
  completeAppStartupPresentation,
  resetAppStartupStatusForTests,
} from './app-startup-status';
import {
  getCachedWorkspaceShape,
  persistWorkspaceShapeSnapshot,
  resetWorkspaceShapeCacheForTests,
} from './workspace-shape-cache';
import { startWorkspaceShapeCachePersistence } from './workspace-shape-cache-persistence';

const WORKSPACE_SHAPE_CACHE_KEY = 'parallel-code:workspace-shape:v1:local';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    clear(): void {
      values.clear();
    },
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    key(index: number): string | null {
      return [...values.keys()][index] ?? null;
    },
    get length(): number {
      return values.size;
    },
    removeItem(key: string): void {
      values.delete(key);
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
  };
}

function seedCachedShape(): void {
  setStore('projects', [createTestProject()]);
  setStore('tasks', 'task-1', createTestTask({ id: 'task-1', name: 'Fix parser' }));
  setStore('tasks', 'task-2', createTestTask({ id: 'task-2', name: 'Write docs' }));
  setStore('taskOrder', ['task-1', 'task-2']);
  persistWorkspaceShapeSnapshot(1_000);
  // Back to the cold pre-bootstrap (empty) store without touching the cache.
  resetStoreForTest();
}

describe('workspace-shape-cache-persistence', () => {
  let storage: Storage;
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    resetStoreForTest();
    resetAppStartupStatusForTests();
    resetWorkspaceShapeCacheForTests();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetWorkspaceShapeCacheForTests();
    resetAppStartupStatusForTests();
    resetStoreForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not overwrite the cached shape while startup presentation is pending', () => {
    // Returning-user cache from a previous session.
    seedCachedShape();
    expect(getCachedWorkspaceShape()?.taskNames).toEqual(['Fix parser', 'Write docs']);

    // Subscription registers before the awaited cold bootstrap: the store is
    // still empty and a slow (>1s) bootstrap must not clobber the cache.
    beginAppStartupPresentation();
    cleanup = startWorkspaceShapeCachePersistence();
    vi.advanceTimersByTime(10_000);

    expect(getCachedWorkspaceShape()?.taskNames).toEqual(['Fix parser', 'Write docs']);
  });

  it('persists the hydrated shape once startup presentation completes', () => {
    seedCachedShape();
    beginAppStartupPresentation();
    cleanup = startWorkspaceShapeCachePersistence();

    // Bootstrap hydrates the store, then startup completes.
    setStore('projects', [createTestProject()]);
    setStore('tasks', 'task-3', createTestTask({ id: 'task-3', name: 'New shape' }));
    setStore('taskOrder', ['task-3']);
    vi.advanceTimersByTime(10_000);
    expect(getCachedWorkspaceShape()?.taskNames).toEqual(['Fix parser', 'Write docs']);

    completeAppStartupPresentation();
    vi.advanceTimersByTime(1_000);

    expect(getCachedWorkspaceShape()?.taskNames).toEqual(['New shape']);
  });

  it('stops persisting after the cleanup disposes the subscription', () => {
    cleanup = startWorkspaceShapeCachePersistence();
    cleanup();
    cleanup = null;

    setStore('tasks', 'task-1', createTestTask({ id: 'task-1', name: 'After dispose' }));
    setStore('taskOrder', ['task-1']);
    vi.advanceTimersByTime(10_000);

    expect(storage.getItem(WORKSPACE_SHAPE_CACHE_KEY)).toBeNull();
  });
});
