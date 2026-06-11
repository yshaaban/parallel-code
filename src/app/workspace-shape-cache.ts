import {
  getSafeLocalStorage,
  getSafeStorageItem,
  removeSafeStorageItem,
  setSafeStorageItem,
} from '../lib/browser-storage';
import { store } from '../store/state';

// Renderer presentation cache only: the last-known workspace shape lets the
// startup skeleton render correctly-shaped ghost columns and sidebar rows
// before bootstrap lands. It is explicitly NOT restore truth — nothing may
// hydrate canonical state from it. The key is scoped by the serving origin so
// one browser profile pointing at two servers cannot render the wrong shape.
export interface CachedWorkspaceShape {
  projectCount: number;
  taskNames: string[];
  updatedAtMs: number;
  version: 1;
}

const WORKSPACE_SHAPE_CACHE_KEY_PREFIX = 'parallel-code:workspace-shape:v1';
const WORKSPACE_SHAPE_MAX_TASK_NAMES = 12;
const WORKSPACE_SHAPE_MAX_TASK_NAME_LENGTH = 64;

function getWorkspaceShapeCacheKey(): string {
  const origin =
    typeof globalThis.location !== 'undefined' && typeof globalThis.location.origin === 'string'
      ? globalThis.location.origin
      : 'local';
  return `${WORKSPACE_SHAPE_CACHE_KEY_PREFIX}:${origin}`;
}

function clampTaskNames(taskNames: unknown): string[] | null {
  if (!Array.isArray(taskNames)) {
    return null;
  }

  const clamped: string[] = [];
  for (const name of taskNames) {
    if (typeof name !== 'string') {
      return null;
    }

    clamped.push(name.slice(0, WORKSPACE_SHAPE_MAX_TASK_NAME_LENGTH));
    if (clamped.length >= WORKSPACE_SHAPE_MAX_TASK_NAMES) {
      break;
    }
  }

  return clamped;
}

function parseCachedWorkspaceShape(raw: string): CachedWorkspaceShape | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const fragment = parsed as Record<string, unknown>;
  if (fragment.version !== 1) {
    return null;
  }

  const taskNames = clampTaskNames(fragment.taskNames);
  if (
    taskNames === null ||
    typeof fragment.projectCount !== 'number' ||
    !Number.isFinite(fragment.projectCount) ||
    typeof fragment.updatedAtMs !== 'number'
  ) {
    return null;
  }

  return {
    projectCount: Math.max(0, Math.floor(fragment.projectCount)),
    taskNames,
    updatedAtMs: fragment.updatedAtMs,
    version: 1,
  };
}

function isEmptyWorkspaceShape(shape: CachedWorkspaceShape): boolean {
  return shape.projectCount === 0 && shape.taskNames.length === 0;
}

export function getCachedWorkspaceShape(): CachedWorkspaceShape | null {
  const raw = getSafeStorageItem(getSafeLocalStorage(), getWorkspaceShapeCacheKey());
  if (raw === null) {
    return null;
  }

  const shape = parseCachedWorkspaceShape(raw);
  // An empty shape is not a returning-user signal: treat it as no cache so
  // first-run users keep onboarding instead of a bogus one-column skeleton.
  if (shape !== null && isEmptyWorkspaceShape(shape)) {
    return null;
  }

  return shape;
}

export function persistWorkspaceShapeSnapshot(nowMs = Date.now()): void {
  const taskNames = store.taskOrder
    .map((taskId) => store.tasks[taskId]?.name ?? '')
    .filter((name) => name.length > 0)
    .slice(0, WORKSPACE_SHAPE_MAX_TASK_NAMES)
    .map((name) => name.slice(0, WORKSPACE_SHAPE_MAX_TASK_NAME_LENGTH));
  const shape: CachedWorkspaceShape = {
    projectCount: store.projects.length,
    taskNames,
    updatedAtMs: nowMs,
    version: 1,
  };

  // A genuinely empty workspace clears the cache instead of caching an empty
  // shape: the cache exists only to signal "returning user with content".
  if (isEmptyWorkspaceShape(shape)) {
    removeSafeStorageItem(getSafeLocalStorage(), getWorkspaceShapeCacheKey());
    return;
  }

  setSafeStorageItem(getSafeLocalStorage(), getWorkspaceShapeCacheKey(), JSON.stringify(shape));
}

const WORKSPACE_SHAPE_PERSIST_DEBOUNCE_MS = 1_000;

// Session-scoped debounced persistence: callers subscribe this through a
// reactive effect and dispose the returned cleanup with the session.
export function createDebouncedWorkspaceShapePersist(): {
  dispose: () => void;
  schedule: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    schedule(): void {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        persistWorkspaceShapeSnapshot();
      }, WORKSPACE_SHAPE_PERSIST_DEBOUNCE_MS);
    },
  };
}

export function resetWorkspaceShapeCacheForTests(): void {
  removeSafeStorageItem(getSafeLocalStorage(), getWorkspaceShapeCacheKey());
}
