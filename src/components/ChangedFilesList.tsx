import { createSignal, createMemo, createEffect, onCleanup, For, Show } from 'solid-js';
import { invoke } from '../lib/ipc';
import { listenForGitStatusChanged } from '../runtime/git-status-events';
import { IPC } from '../../electron/ipc/channels';
import { isHydraCoordinationArtifact } from '../lib/hydra';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { getStatusColor } from '../lib/status-colors';
import { getRecentTaskGitStatusPollAge } from '../store/taskStatus';
import type { ChangedFile } from '../ipc/types';

interface ChangedFilesListProps {
  worktreePath: string;
  isActive?: boolean;
  onFileClick?: (file: ChangedFile) => void;
  ref?: (el: HTMLDivElement) => void;
  /** Project root for branch-based fallback when worktree doesn't exist */
  projectRoot?: string;
  /** Branch name for branch-based fallback when worktree doesn't exist */
  branchName?: string | null;
  filterHydraArtifacts?: boolean;
}

interface ChangedFilesCacheEntry {
  value?: ChangedFile[];
  expiresAt: number;
  promise?: Promise<ChangedFile[]>;
}

const CHANGED_FILES_CACHE_TTL_MS = 5_000;
const INITIAL_FETCH_GRACE_AFTER_STATUS_POLL_MS = 1_000;
const changedFilesCache = new Map<string, ChangedFilesCacheEntry>();

function normalizeCachePath(filePath: string): string {
  return filePath.replace(/\/+$/, '');
}

function getWorktreeCacheKey(worktreePath: string): string {
  return `worktree:${normalizeCachePath(worktreePath)}`;
}

function getBranchCacheKey(projectRoot: string, branchName: string): string {
  return `branch:${normalizeCachePath(projectRoot)}:${branchName}`;
}

function getFreshCachedFiles(key: string): ChangedFile[] | null {
  const cached = changedFilesCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt > Date.now() && cached.value) return cached.value;
  if (!cached.promise) changedFilesCache.delete(key);
  return null;
}

async function withChangedFilesCache(
  key: string,
  loader: () => Promise<ChangedFile[]>,
): Promise<ChangedFile[]> {
  const now = Date.now();
  const cached = changedFilesCache.get(key);
  if (cached) {
    if (cached.expiresAt > now && cached.value) return cached.value;
    if (cached.promise) return cached.promise;
    changedFilesCache.delete(key);
  }

  const promise = loader().then(
    (value) => {
      changedFilesCache.set(key, {
        value,
        expiresAt: Date.now() + CHANGED_FILES_CACHE_TTL_MS,
      });
      return value;
    },
    (error) => {
      const current = changedFilesCache.get(key);
      if (current?.promise === promise) changedFilesCache.delete(key);
      throw error;
    },
  );

  changedFilesCache.set(key, {
    promise,
    expiresAt: now + CHANGED_FILES_CACHE_TTL_MS,
  });
  return promise;
}

export function ChangedFilesList(props: ChangedFilesListProps) {
  const [files, setFiles] = createSignal<ChangedFile[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(-1);
  const [showHydraArtifacts, setShowHydraArtifacts] = createSignal(false);

  const hiddenHydraArtifactCount = createMemo(() => {
    if (!props.filterHydraArtifacts) return 0;
    return files().filter((file) => isHydraCoordinationArtifact(file.path)).length;
  });

  const visibleFiles = createMemo(() => {
    if (!props.filterHydraArtifacts || showHydraArtifacts()) return files();
    return files().filter((file) => !isHydraCoordinationArtifact(file.path));
  });

  function handleKeyDown(e: KeyboardEvent) {
    const list = visibleFiles();
    if (list.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(list.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const idx = selectedIndex();
      if (idx >= 0 && idx < list.length) {
        props.onFileClick?.(list[idx]);
      }
    }
  }

  // Poll every 5s, matching the git status polling interval.
  // Falls back to branch-based diff when worktree path doesn't exist.
  createEffect(() => {
    const path = props.worktreePath;
    const projectRoot = props.projectRoot;
    const branchName = props.branchName;
    if (!props.isActive) return;
    let cancelled = false;
    let inFlight = false;
    let usingBranchFallback = false;
    let initialTimer: ReturnType<typeof setTimeout> | undefined;

    const worktreeCacheKey = path ? getWorktreeCacheKey(path) : null;
    const branchCacheKey =
      projectRoot && branchName ? getBranchCacheKey(projectRoot, branchName) : null;

    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        // Try worktree-based fetch first
        if (path && !usingBranchFallback) {
          try {
            const result = await withChangedFilesCache(worktreeCacheKey ?? path, () =>
              invoke<ChangedFile[]>(IPC.GetChangedFiles, {
                worktreePath: path,
              }),
            );
            if (!cancelled) setFiles(result);
            return;
          } catch {
            // Worktree may not exist — try branch fallback below
          }
        }

        // Branch-based fallback: static data, no need to re-poll
        if (!usingBranchFallback && projectRoot && branchName) {
          usingBranchFallback = true;
          try {
            const result = await withChangedFilesCache(
              branchCacheKey ?? `${projectRoot}:${branchName}`,
              () =>
                invoke<ChangedFile[]>(IPC.GetChangedFilesFromBranch, {
                  projectRoot,
                  branchName,
                }),
            );
            if (!cancelled) setFiles(result);
          } catch {
            // Branch may no longer exist
          }
        }
      } finally {
        inFlight = false;
      }
    }

    const recentStatusPollAge = path ? getRecentTaskGitStatusPollAge(path) : null;
    const hasFreshWorktreeCache = worktreeCacheKey ? getFreshCachedFiles(worktreeCacheKey) : null;
    const initialDelayMs =
      hasFreshWorktreeCache ||
      recentStatusPollAge === null ||
      recentStatusPollAge >= INITIAL_FETCH_GRACE_AFTER_STATUS_POLL_MS
        ? 0
        : INITIAL_FETCH_GRACE_AFTER_STATUS_POLL_MS - recentStatusPollAge;

    if (initialDelayMs > 0) {
      initialTimer = setTimeout(() => {
        initialTimer = undefined;
        void refresh();
      }, initialDelayMs);
    } else {
      void refresh();
    }

    const timer = setInterval(() => {
      if (!usingBranchFallback) void refresh();
    }, 5000);
    onCleanup(() => {
      cancelled = true;
      if (initialTimer) clearTimeout(initialTimer);
      clearInterval(timer);
    });
  });

  // Refresh immediately when server pushes a git status change for this worktree
  createEffect(() => {
    const path = props.worktreePath;
    if (!path || !props.isActive) return;
    const offGitStatus = listenForGitStatusChanged((msg) => {
      if (msg.worktreePath && msg.worktreePath === path) {
        // Invalidate cache and re-fetch
        const key = getWorktreeCacheKey(path);
        changedFilesCache.delete(key);
        void invoke<ChangedFile[]>(IPC.GetChangedFiles, { worktreePath: path }).then(
          (result) => setFiles(result),
          () => {},
        );
      }
    });
    onCleanup(() => offGitStatus());
  });

  createEffect(() => {
    const list = visibleFiles();
    if (selectedIndex() >= list.length) {
      setSelectedIndex(list.length > 0 ? list.length - 1 : -1);
    }
  });

  const totalAdded = createMemo(() => visibleFiles().reduce((s, f) => s + f.lines_added, 0));
  const totalRemoved = createMemo(() => visibleFiles().reduce((s, f) => s + f.lines_removed, 0));
  const uncommittedCount = createMemo(() => visibleFiles().filter((f) => !f.committed).length);

  /** For each file, compute the display filename and an optional disambiguating directory. */
  const fileDisplays = createMemo(() => {
    const list = visibleFiles();

    // Count how many times each filename appears
    const nameCounts = new Map<string, number>();
    const parsed = list.map((f) => {
      const sep = f.path.lastIndexOf('/');
      const name = sep >= 0 ? f.path.slice(sep + 1) : f.path;
      const dir = sep >= 0 ? f.path.slice(0, sep) : '';
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      return { name, dir, fullPath: f.path };
    });

    // For duplicates, find the shortest disambiguating parent suffix
    return parsed.map((p) => {
      if ((nameCounts.get(p.name) ?? 0) <= 1 || !p.dir) {
        return { name: p.name, disambig: '', fullPath: p.fullPath };
      }
      // Find all entries with the same filename
      const siblings = parsed.filter((s) => s.name === p.name && s.fullPath !== p.fullPath);
      const parts = p.dir.split('/');
      // Walk from the immediate parent upward until unique
      for (let depth = 1; depth <= parts.length; depth++) {
        const suffix = parts.slice(parts.length - depth).join('/');
        const isUnique = siblings.every((s) => {
          const sParts = s.dir.split('/');
          const sSuffix = sParts.slice(sParts.length - depth).join('/');
          return sSuffix !== suffix;
        });
        if (isUnique) {
          return { name: p.name, disambig: suffix + '/', fullPath: p.fullPath };
        }
      }
      // Fallback: show full directory
      return { name: p.name, disambig: p.dir + '/', fullPath: p.fullPath };
    });
  });

  return (
    <div
      ref={props.ref}
      class="focusable-panel"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        overflow: 'hidden',
        'font-family': "'JetBrains Mono', monospace",
        'font-size': sf(11),
        outline: 'none',
      }}
    >
      <Show when={props.filterHydraArtifacts && hiddenHydraArtifactCount() > 0}>
        <div
          style={{
            padding: '6px 8px 2px',
            'font-size': sf(10),
            color: theme.fgMuted,
            'flex-shrink': '0',
          }}
        >
          <button
            type="button"
            onClick={() => setShowHydraArtifacts((value) => !value)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: '0',
              color: theme.accent,
              cursor: 'pointer',
              'font-size': 'inherit',
              'font-family': "'JetBrains Mono', monospace",
            }}
          >
            {showHydraArtifacts()
              ? 'Hide Hydra coordination files'
              : `Show ${hiddenHydraArtifactCount()} Hydra coordination files`}
          </button>
        </div>
      </Show>
      <div style={{ flex: '1', overflow: 'auto', padding: '4px 0' }}>
        <For each={visibleFiles()}>
          {(file, i) => (
            <div
              class="file-row"
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
                padding: '2px 8px',
                'white-space': 'nowrap',
                cursor: props.onFileClick ? 'pointer' : 'default',
                'border-radius': '3px',
                opacity: file.committed ? '0.45' : '1',
                background: selectedIndex() === i() ? theme.bgHover : 'transparent',
              }}
              onClick={() => {
                setSelectedIndex(i());
                props.onFileClick?.(file);
              }}
            >
              <span
                style={{
                  color: getStatusColor(file.status),
                  'font-weight': '600',
                  width: '12px',
                  'text-align': 'center',
                  'flex-shrink': '0',
                }}
              >
                {file.status}
              </span>
              <span
                style={{
                  flex: '1',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  display: 'flex',
                  gap: '4px',
                  'align-items': 'baseline',
                }}
                title={file.path}
              >
                <span style={{ color: theme.fg }}>{fileDisplays()[i()].name}</span>
                <Show when={fileDisplays()[i()].disambig}>
                  <span style={{ color: theme.fgMuted, 'font-size': sf(10) }}>
                    {fileDisplays()[i()].disambig}
                  </span>
                </Show>
              </span>
              <Show when={file.lines_added > 0 || file.lines_removed > 0}>
                <span style={{ color: theme.success, 'flex-shrink': '0' }}>
                  +{file.lines_added}
                </span>
                <span style={{ color: theme.error, 'flex-shrink': '0' }}>
                  -{file.lines_removed}
                </span>
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={visibleFiles().length > 0}>
        <div
          style={{
            padding: '4px 8px',
            'border-top': `1px solid ${theme.border}`,
            color: theme.fgMuted,
            'flex-shrink': '0',
          }}
        >
          {visibleFiles().length} files,{' '}
          <span style={{ color: theme.success }}>+{totalAdded()}</span>{' '}
          <span style={{ color: theme.error }}>-{totalRemoved()}</span>
          <Show when={uncommittedCount() > 0 && uncommittedCount() < visibleFiles().length}>
            {' '}
            <span style={{ color: theme.warning }}>({uncommittedCount()} uncommitted)</span>
          </Show>
          <Show
            when={
              props.filterHydraArtifacts && hiddenHydraArtifactCount() > 0 && !showHydraArtifacts()
            }
          >
            {' '}
            <span style={{ color: theme.fgSubtle }}>
              ({hiddenHydraArtifactCount()} Hydra coordination files hidden)
            </span>
          </Show>
        </div>
      </Show>
    </div>
  );
}
