import { createSignal, createMemo, createEffect, onCleanup, For, Show } from 'solid-js';
import { createAsyncRequestGuard } from '../app/async-request-guard';
import { isElectronRuntime } from '../lib/ipc';
import {
  createTaskReviewFilesRequest,
  fetchTaskReviewFiles,
  type TaskReviewFilesResult,
} from '../app/review-files';
import { getTaskReviewSnapshot } from '../app/task-review-state';
import { listenForGitStatusChanged } from '../runtime/git-status-events';
import { scrollSelectedRowIntoView } from './file-list-scroll';
import { isHydraCoordinationArtifact } from '../lib/hydra';
import { getChangedFileDisplayEntries } from '../lib/changed-file-display';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import { getStatusColor } from '../lib/status-colors';
import {
  gitStatusEventMatchesTarget,
  getRecentTaskGitStatusPollAge,
} from '../store/task-git-status';
import type { ChangedFile } from '../ipc/types';

interface ChangedFilesListCommonProps {
  isActive?: boolean;
  onFileClick?: (file: ChangedFile) => void;
  ref?: (el: HTMLDivElement) => void;
  filterHydraArtifacts?: boolean;
}

interface TaskChangedFilesListProps extends ChangedFilesListCommonProps {
  kind: 'task';
  taskId: string;
  worktreePath: string;
}

interface WorktreeChangedFilesListProps extends ChangedFilesListCommonProps {
  branchName?: string | null;
  kind: 'worktree';
  /** Project root for branch-based fallback when worktree doesn't exist */
  projectRoot?: string;
  worktreePath: string;
}

type ChangedFilesListProps = TaskChangedFilesListProps | WorktreeChangedFilesListProps;

type ChangedFilesRefreshSource = 'branch-fallback' | 'project-diff' | 'unavailable';

interface ChangedFilesCacheEntry {
  result?: TaskReviewFilesResult;
  expiresAt: number;
  promise?: Promise<TaskReviewFilesResult>;
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

function getFreshCachedFilesResult(key: string): TaskReviewFilesResult | null {
  const cached = changedFilesCache.get(key);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt > Date.now() && cached.result) {
    return cached.result;
  }

  if (!cached.promise) {
    changedFilesCache.delete(key);
  }

  return null;
}

async function withChangedFilesCache(
  key: string,
  loader: () => Promise<TaskReviewFilesResult>,
): Promise<TaskReviewFilesResult> {
  const now = Date.now();
  const cached = changedFilesCache.get(key);
  if (cached) {
    if (cached.expiresAt > now && cached.result) {
      return cached.result;
    }
    if (cached.promise) {
      return cached.promise;
    }
    changedFilesCache.delete(key);
  }

  const promise = loader().then(
    (result) => {
      if (result.source === 'branch-fallback') {
        changedFilesCache.delete(key);
        return result;
      }

      changedFilesCache.set(key, {
        result,
        expiresAt: Date.now() + CHANGED_FILES_CACHE_TTL_MS,
      });
      return result;
    },
    (error) => {
      const current = changedFilesCache.get(key);
      if (current?.promise === promise) {
        changedFilesCache.delete(key);
      }
      throw error;
    },
  );

  changedFilesCache.set(key, {
    promise,
    expiresAt: now + CHANGED_FILES_CACHE_TTL_MS,
  });
  return promise;
}

export function resetChangedFilesListRuntimeStateForTests(): void {
  changedFilesCache.clear();
}

export function ChangedFilesList(props: ChangedFilesListProps) {
  const [files, setFiles] = createSignal<ChangedFile[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(-1);
  const [showHydraArtifacts, setShowHydraArtifacts] = createSignal(false);
  const rowRefs: Array<HTMLDivElement | undefined> = [];
  const requestRevisionId = createMemo(() => {
    if (props.kind === 'task') {
      return `task:${props.taskId}:${props.worktreePath}`;
    }

    return `worktree:${props.worktreePath}:${props.projectRoot ?? ''}:${props.branchName ?? ''}`;
  });
  const refreshRequestGuard = createAsyncRequestGuard(() => requestRevisionId());
  const isReviewUnavailable = createMemo(() =>
    Boolean(props.kind === 'task' && getTaskReviewSnapshot(props.taskId)?.source === 'unavailable'),
  );

  const rawFiles = createMemo(() => {
    if (props.kind !== 'task') {
      return files();
    }

    return getTaskReviewSnapshot(props.taskId)?.files ?? [];
  });

  const hiddenHydraArtifactCount = createMemo(() => {
    if (!props.filterHydraArtifacts) return 0;
    return rawFiles().filter((file) => isHydraCoordinationArtifact(file.path)).length;
  });
  const emptyStateMessage = createMemo(() => {
    if (isReviewUnavailable()) {
      return 'Review data unavailable';
    }

    if (hiddenHydraArtifactCount() > 0 && !showHydraArtifacts()) {
      return 'Only Hydra coordination files are hidden';
    }

    return 'No changed files';
  });

  const visibleFiles = createMemo(() => {
    if (!props.filterHydraArtifacts || showHydraArtifacts()) return rawFiles();
    return rawFiles().filter((file) => !isHydraCoordinationArtifact(file.path));
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

  createEffect(() => {
    if (props.kind !== 'worktree') {
      return;
    }
    if (!props.isActive) {
      return;
    }

    const path = props.worktreePath;
    const projectRoot = props.projectRoot;
    const branchName = props.branchName;
    const reviewRequest = createTaskReviewFilesRequest({
      branchName,
      projectRoot,
      worktreePath: path,
    });
    const worktreeCacheKey = path ? getWorktreeCacheKey(path) : null;
    let cancelled = false;
    let inFlight = false;
    let refreshSource: ChangedFilesRefreshSource = 'project-diff';
    let initialTimer: ReturnType<typeof setTimeout> | undefined;

    async function refresh(forceFresh: boolean): Promise<void> {
      if (inFlight) {
        return;
      }

      inFlight = true;
      const requestToken = refreshRequestGuard.beginRequest();
      try {
        if (forceFresh && worktreeCacheKey) {
          changedFilesCache.delete(worktreeCacheKey);
        }

        const reviewFiles =
          worktreeCacheKey && !forceFresh
            ? await withChangedFilesCache(worktreeCacheKey, () =>
                fetchTaskReviewFiles(reviewRequest, 'all'),
              )
            : await fetchTaskReviewFiles(reviewRequest, 'all');

        if (cancelled || !refreshRequestGuard.isCurrent(requestToken)) {
          return;
        }

        setFiles(reviewFiles.files);
        refreshSource = reviewFiles.source;
      } catch {
        if (cancelled || !refreshRequestGuard.isCurrent(requestToken)) {
          return;
        }

        setFiles([]);
        refreshSource = 'unavailable';
      } finally {
        inFlight = false;
      }
    }

    const recentStatusPollAge = path ? getRecentTaskGitStatusPollAge(path) : null;
    const hasFreshWorktreeCache = worktreeCacheKey
      ? getFreshCachedFilesResult(worktreeCacheKey)
      : null;
    setFiles(hasFreshWorktreeCache?.files ?? []);
    const initialDelayMs =
      hasFreshWorktreeCache ||
      recentStatusPollAge === null ||
      recentStatusPollAge >= INITIAL_FETCH_GRACE_AFTER_STATUS_POLL_MS
        ? 0
        : INITIAL_FETCH_GRACE_AFTER_STATUS_POLL_MS - recentStatusPollAge;

    if (initialDelayMs > 0) {
      initialTimer = setTimeout(() => {
        initialTimer = undefined;
        void refresh(false);
      }, initialDelayMs);
    } else {
      void refresh(false);
    }

    const timer = isElectronRuntime()
      ? setInterval(() => {
          void refresh(refreshSource !== 'project-diff');
        }, 5000)
      : null;
    const offGitStatus = listenForGitStatusChanged((msg) => {
      if (
        gitStatusEventMatchesTarget(msg, {
          worktreePath: path,
          branchName,
          projectRoot,
        })
      ) {
        void refresh(true);
      }
    });

    onCleanup(() => {
      cancelled = true;
      if (initialTimer) {
        clearTimeout(initialTimer);
      }
      if (timer) {
        clearInterval(timer);
      }
      offGitStatus();
    });
  });

  createEffect(() => {
    const list = visibleFiles();
    if (selectedIndex() >= list.length) {
      setSelectedIndex(list.length > 0 ? list.length - 1 : -1);
    }
  });

  createEffect(() => {
    scrollSelectedRowIntoView(rowRefs, selectedIndex());
  });

  const totalAdded = createMemo(() => visibleFiles().reduce((s, f) => s + f.lines_added, 0));
  const totalRemoved = createMemo(() => visibleFiles().reduce((s, f) => s + f.lines_removed, 0));
  const uncommittedCount = createMemo(() => visibleFiles().filter((f) => !f.committed).length);

  const fileDisplays = createMemo(() => getChangedFileDisplayEntries(visibleFiles()));

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
        outline: 'none',
        ...typography.monoMeta,
      }}
    >
      <Show when={props.filterHydraArtifacts && hiddenHydraArtifactCount() > 0}>
        <div
          style={{
            padding: 'var(--space-xs) var(--space-sm) 0',
            color: theme.fgMuted,
            'flex-shrink': '0',
            ...typography.meta,
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
              ...typography.monoMeta,
            }}
          >
            {showHydraArtifacts()
              ? 'Hide Hydra coordination files'
              : `Show ${hiddenHydraArtifactCount()} Hydra coordination files`}
          </button>
        </div>
      </Show>
      <div style={{ flex: '1', overflow: 'auto', padding: '2px 0' }}>
        <For each={visibleFiles()}>
          {(file, i) => {
            const display = () => fileDisplays()[i()];

            return (
              <div
                ref={(el) => {
                  rowRefs[i()] = el;
                }}
                class="file-row"
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: 'var(--space-2xs)',
                  padding: '2px var(--space-xs)',
                  'white-space': 'nowrap',
                  cursor: props.onFileClick ? 'pointer' : 'default',
                  'border-radius': '6px',
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
                    gap: 'var(--space-2xs)',
                    'align-items': 'baseline',
                  }}
                  title={file.path}
                >
                  <span style={{ color: theme.fg }}>{display().name}</span>
                  <Show when={display().disambig}>
                    <span style={{ color: theme.fgMuted, ...typography.meta }}>
                      {display().disambig}
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
            );
          }}
        </For>
      </div>
      <Show when={visibleFiles().length > 0}>
        <div
          style={{
            padding: 'var(--space-2xs) var(--space-sm)',
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
      <Show when={visibleFiles().length === 0}>
        <div
          style={{
            padding: 'var(--space-2xs) var(--space-sm)',
            'border-top': `1px solid ${theme.border}`,
            color: theme.fgMuted,
            'flex-shrink': '0',
          }}
        >
          {emptyStateMessage()}
        </div>
      </Show>
    </div>
  );
}
