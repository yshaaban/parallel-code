interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface GitQueryCacheEntry<T> {
  value?: T;
  resolved?: boolean;
  expiresAt: number;
  promise?: Promise<T>;
}

const MAIN_BRANCH_TTL = 60_000;
const MERGE_BASE_TTL = 30_000;
const GIT_QUERY_TTL = 5_000;

const mainBranchCache = new Map<string, CacheEntry<string>>();
const mergeBaseCache = new Map<string, CacheEntry<string>>();
const gitQueryCache = new Map<string, GitQueryCacheEntry<unknown>>();
const worktreeLocks = new Map<string, Promise<void>>();

export function cacheKey(p: string): string {
  return p.replace(/\/+$/, '');
}

export function getCachedMainBranch(repoRoot: string): string | null {
  const key = cacheKey(repoRoot);
  const cached = mainBranchCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt > Date.now()) return cached.value;
  mainBranchCache.delete(key);
  return null;
}

export function setCachedMainBranch(repoRoot: string, value: string): void {
  mainBranchCache.set(cacheKey(repoRoot), {
    value,
    expiresAt: Date.now() + MAIN_BRANCH_TTL,
  });
}

export function clearCachedMainBranches(): void {
  mainBranchCache.clear();
}

export function getCachedMergeBase(repoRoot: string): string | null {
  const key = cacheKey(repoRoot);
  const cached = mergeBaseCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt > Date.now()) return cached.value;
  mergeBaseCache.delete(key);
  return null;
}

export function setCachedMergeBase(repoRoot: string, value: string): void {
  mergeBaseCache.set(cacheKey(repoRoot), {
    value,
    expiresAt: Date.now() + MERGE_BASE_TTL,
  });
}

export function invalidateMergeBaseCache(): void {
  mergeBaseCache.clear();
}

export function invalidateGitQueryCacheForPath(repoPath: string): void {
  const normalized = cacheKey(repoPath);
  const suffix = `:${normalized}`;
  const infix = `:${normalized}:`;
  const keysToDelete: string[] = [];
  for (const key of gitQueryCache.keys()) {
    if (key.endsWith(suffix) || key.includes(infix)) keysToDelete.push(key);
  }
  for (const key of keysToDelete) gitQueryCache.delete(key);
}

export function invalidateWorktreeStatusCache(worktreePath: string): void {
  const key = `worktree-status:${cacheKey(worktreePath)}`;
  gitQueryCache.delete(key);
}

export async function withGitQueryCache<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const cached = gitQueryCache.get(key) as GitQueryCacheEntry<T> | undefined;
  if (cached) {
    if (cached.expiresAt > now && cached.resolved) return cached.value as T;
    if (cached.promise) return cached.promise;
    gitQueryCache.delete(key);
  }

  const promise = loader().then(
    (value) => {
      const current = gitQueryCache.get(key) as GitQueryCacheEntry<T> | undefined;
      if (current?.promise === promise) {
        gitQueryCache.set(key, {
          value,
          resolved: true,
          expiresAt: Date.now() + GIT_QUERY_TTL,
        });
      }
      return value;
    },
    (error) => {
      const current = gitQueryCache.get(key) as GitQueryCacheEntry<T> | undefined;
      if (current?.promise === promise) gitQueryCache.delete(key);
      throw error;
    },
  );

  gitQueryCache.set(key, {
    promise,
    expiresAt: now + GIT_QUERY_TTL,
  });
  return promise;
}

export function withWorktreeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = worktreeLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const voidNext = next.then(
    () => {},
    () => {},
  );
  worktreeLocks.set(key, voidNext);
  voidNext.then(() => {
    if (worktreeLocks.get(key) === voidNext) {
      worktreeLocks.delete(key);
    }
  });
  return next;
}

export const MAX_BUFFER = 10 * 1024 * 1024;
