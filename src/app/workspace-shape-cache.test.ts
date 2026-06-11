import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';
import {
  getCachedWorkspaceShape,
  persistWorkspaceShapeSnapshot,
  resetWorkspaceShapeCacheForTests,
} from './workspace-shape-cache';

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

describe('workspace-shape-cache', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    resetStoreForTest();
    resetWorkspaceShapeCacheForTests();
  });

  afterEach(() => {
    resetWorkspaceShapeCacheForTests();
    resetStoreForTest();
    vi.unstubAllGlobals();
  });

  it('persists and reads back the current workspace shape', () => {
    setStore('projects', [createTestProject()]);
    setStore('tasks', 'task-1', createTestTask({ id: 'task-1', name: 'Fix parser' }));
    setStore('tasks', 'task-2', createTestTask({ id: 'task-2', name: 'Write docs' }));
    setStore('taskOrder', ['task-1', 'task-2']);

    persistWorkspaceShapeSnapshot(2_000);

    expect(getCachedWorkspaceShape()).toEqual({
      projectCount: 1,
      taskNames: ['Fix parser', 'Write docs'],
      updatedAtMs: 2_000,
      version: 1,
    });
  });

  it('clamps task name count and length on read', () => {
    storage.setItem(
      WORKSPACE_SHAPE_CACHE_KEY,
      JSON.stringify({
        projectCount: 3.9,
        taskNames: Array.from({ length: 20 }, (_, index) => `task ${index} ${'x'.repeat(100)}`),
        updatedAtMs: 1_000,
        version: 1,
      }),
    );

    const shape = getCachedWorkspaceShape();
    expect(shape?.projectCount).toBe(3);
    expect(shape?.taskNames).toHaveLength(12);
    expect(shape?.taskNames.every((name) => name.length <= 64)).toBe(true);
  });

  it('returns null for corrupt fragments instead of throwing', () => {
    for (const corrupt of [
      'not json',
      '"a string"',
      'null',
      JSON.stringify({ projectCount: 'two', taskNames: [], updatedAtMs: 1, version: 1 }),
      JSON.stringify({ projectCount: 1, taskNames: [42], updatedAtMs: 1, version: 1 }),
      JSON.stringify({ projectCount: 1, taskNames: 'nope', updatedAtMs: 1, version: 1 }),
    ]) {
      storage.setItem(WORKSPACE_SHAPE_CACHE_KEY, corrupt);
      expect(getCachedWorkspaceShape()).toBeNull();
    }
  });

  it('returns null on version mismatch', () => {
    storage.setItem(
      WORKSPACE_SHAPE_CACHE_KEY,
      JSON.stringify({ projectCount: 1, taskNames: ['Task'], updatedAtMs: 1, version: 2 }),
    );

    expect(getCachedWorkspaceShape()).toBeNull();
  });

  it('returns null when nothing is cached or after the reset seam runs', () => {
    expect(getCachedWorkspaceShape()).toBeNull();

    setStore('tasks', 'task-1', createTestTask({ id: 'task-1', name: 'Real task' }));
    setStore('taskOrder', ['task-1']);
    persistWorkspaceShapeSnapshot(1_000);
    expect(getCachedWorkspaceShape()).not.toBeNull();

    resetWorkspaceShapeCacheForTests();
    expect(getCachedWorkspaceShape()).toBeNull();
  });

  it('never caches an empty workspace shape and clears a stale cache when the workspace empties', () => {
    // Persisting an empty store (cold pre-bootstrap shape, or a genuinely
    // empty workspace) must not mint a returning-user cache entry.
    persistWorkspaceShapeSnapshot(1_000);
    expect(storage.getItem(WORKSPACE_SHAPE_CACHE_KEY)).toBeNull();
    expect(getCachedWorkspaceShape()).toBeNull();

    setStore('projects', [createTestProject()]);
    setStore('tasks', 'task-1', createTestTask({ id: 'task-1', name: 'Real task' }));
    setStore('taskOrder', ['task-1']);
    persistWorkspaceShapeSnapshot(2_000);
    expect(getCachedWorkspaceShape()).not.toBeNull();

    // Emptying the workspace clears the cache so the next reload shows
    // onboarding instead of a one-column ghost skeleton.
    setStore('projects', []);
    setStore('taskOrder', []);
    persistWorkspaceShapeSnapshot(3_000);
    expect(storage.getItem(WORKSPACE_SHAPE_CACHE_KEY)).toBeNull();
    expect(getCachedWorkspaceShape()).toBeNull();
  });

  it('treats a previously cached empty shape as no cache', () => {
    storage.setItem(
      WORKSPACE_SHAPE_CACHE_KEY,
      JSON.stringify({ projectCount: 0, taskNames: [], updatedAtMs: 1_000, version: 1 }),
    );

    expect(getCachedWorkspaceShape()).toBeNull();
  });

  it('skips unnamed tasks when capturing the shape', () => {
    setStore('tasks', 'task-1', createTestTask({ id: 'task-1', name: 'Visible' }));
    setStore('tasks', 'task-2', createTestTask({ id: 'task-2', name: '' }));
    setStore('taskOrder', ['task-1', 'task-2', 'task-missing']);

    persistWorkspaceShapeSnapshot(1_000);

    expect(getCachedWorkspaceShape()?.taskNames).toEqual(['Visible']);
  });
});
