import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type JSX,
} from 'solid-js';
import { createAsyncRequestGuard } from '../app/async-request-guard';
import { isElectronRuntime } from '../lib/ipc';
import {
  createTaskReviewFilesRequest,
  fetchTaskReviewFiles,
  type TaskReviewFilesResult,
} from '../app/review-files';
import { getTaskReviewSnapshot } from '../app/task-review-state';
import { getChangedFileDisplayEntries } from '../lib/changed-file-display';
import {
  getChangedFilesVisibilityModel,
  getChangedFilesVisibleFileStats,
} from '../lib/changed-file-projection';
import { buildFileTree, flattenVisibleTree } from '../lib/file-tree';
import { listenForGitStatusChanged } from '../runtime/git-status-events';
import {
  getHiddenHydraSummaryLabel,
  getHiddenHydraSummaryTitle,
  getHydraArtifactToggleLabel,
  getHydraArtifactToggleTitle,
} from './hydra-artifact-labels';
import { scrollSelectedRowIntoView } from './file-list-scroll';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import { getStatusColor } from '../lib/status-colors';
import {
  gitStatusEventMatchesTarget,
  getRecentTaskGitStatusPollAge,
} from '../store/task-git-status';
import type { ChangedFile } from '../ipc/types';

interface ChangedFilesListCommonProps {
  activeFilePath?: string | null;
  isActive?: boolean;
  onFileClick?: (file: ChangedFile) => void;
  setRootRef?: (element: HTMLDivElement | undefined) => void;
  filterHydraArtifacts?: boolean;
}

interface TaskChangedFilesListProps extends ChangedFilesListCommonProps {
  kind: 'task';
  taskId: string;
  worktreePath: string;
}

interface WorktreeChangedFilesListProps extends ChangedFilesListCommonProps {
  baseBranch?: string;
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

function getChangedFilesRequestRevisionId(
  kind: ChangedFilesListProps['kind'],
  worktreePath: string,
  options: {
    branchName?: string | null;
    projectRoot?: string;
    taskId?: string;
  },
): string {
  if (kind === 'task') {
    return `task:${options.taskId ?? ''}:${worktreePath}`;
  }

  return `worktree:${worktreePath}:${options.projectRoot ?? ''}:${options.branchName ?? ''}`;
}

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

function getInitialRefreshDelayMs(
  recentStatusPollAge: number | null,
  hasFreshWorktreeCache: boolean,
): number {
  if (
    hasFreshWorktreeCache ||
    recentStatusPollAge === null ||
    recentStatusPollAge >= INITIAL_FETCH_GRACE_AFTER_STATUS_POLL_MS
  ) {
    return 0;
  }

  return INITIAL_FETCH_GRACE_AFTER_STATUS_POLL_MS - recentStatusPollAge;
}

function getChangedFilesRefreshErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  if (message.length > 0) {
    return message;
  }

  return 'Unknown refresh failure';
}

export function ChangedFilesList(props: ChangedFilesListProps): JSX.Element {
  const [files, setFiles] = createSignal<ChangedFile[]>([]);
  const [taskReviewUnavailable, setTaskReviewUnavailable] = createSignal(false);
  const [worktreeRefreshError, setWorktreeRefreshError] = createSignal<string | null>(null);
  const [selectedIndex, setSelectedIndex] = createSignal(-1);
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [showHydraArtifacts, setShowHydraArtifacts] = createSignal(false);
  const rowRefs: Array<HTMLDivElement | undefined> = [];

  const requestRevisionId = createMemo(() =>
    getChangedFilesRequestRevisionId(props.kind, props.worktreePath, {
      branchName: props.kind === 'worktree' ? props.branchName : undefined,
      projectRoot: props.kind === 'worktree' ? props.projectRoot : undefined,
      taskId: props.kind === 'task' ? props.taskId : undefined,
    }),
  );
  const refreshRequestGuard = createAsyncRequestGuard(() => requestRevisionId());
  const isReviewUnavailable = createMemo(() =>
    Boolean(props.kind === 'task' && taskReviewUnavailable()),
  );

  const visibilityModel = createMemo(() =>
    getChangedFilesVisibilityModel(files(), {
      filterHydraArtifacts: Boolean(props.filterHydraArtifacts),
      showHydraArtifacts: showHydraArtifacts(),
    }),
  );
  const hiddenHydraArtifactCount = createMemo(() => visibilityModel().hiddenHydraArtifactCount);
  const emptyStateMessage = createMemo(() => {
    if (isReviewUnavailable()) {
      return 'Review data unavailable';
    }

    const refreshError = worktreeRefreshError();
    if (refreshError) {
      return `Changed files unavailable: ${refreshError}`;
    }

    if (hiddenHydraArtifactCount() > 0 && !showHydraArtifacts()) {
      return 'Only Hydra coordination files are hidden';
    }

    return 'No changed files';
  });

  const visibleFiles = createMemo(() => visibilityModel().visibleFiles);

  const fileDisplayEntries = createMemo(() => {
    return new Map(
      getChangedFileDisplayEntries(visibleFiles()).map((entry) => [entry.fullPath, entry]),
    );
  });

  const fileTree = createMemo(() => buildFileTree(visibleFiles()));
  const visibleRows = createMemo(() => flattenVisibleTree(fileTree(), collapsed()));

  function toggleDir(path: string): void {
    const rows = visibleRows();
    const currentDirIndex = rows.findIndex((row) => row.node.path === path);
    const isCollapsing = !collapsed().has(path);

    batch(() => {
      if (isCollapsing && currentDirIndex >= 0) {
        const dirDepth = rows[currentDirIndex].depth;
        let subtreeEnd = rows.length;

        for (let i = currentDirIndex + 1; i < rows.length; i += 1) {
          if (rows[i].depth <= dirDepth) {
            subtreeEnd = i;
            break;
          }
        }

        if (selectedIndex() > currentDirIndex && selectedIndex() < subtreeEnd) {
          setSelectedIndex(currentDirIndex);
        }
      }

      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
    });
  }

  function getRowBackground(filePath: string | undefined, rowIndex: number): string {
    if (selectedIndex() === rowIndex) {
      return theme.bgHover;
    }

    if (filePath && props.activeFilePath === filePath) {
      return 'rgba(88, 166, 255, 0.16)';
    }

    return 'transparent';
  }

  function handleKeyDown(e: KeyboardEvent) {
    const rows = visibleRows();
    if (rows.length === 0) {
      return;
    }

    if (e.altKey) {
      return;
    }

    const currentIndex = selectedIndex();

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((index) => Math.min(rows.length - 1, index + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((index) => Math.max(0, index - 1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (currentIndex >= 0 && currentIndex < rows.length) {
        const currentRow = rows[currentIndex];
        if (currentRow.isDir) {
          if (collapsed().has(currentRow.node.path)) {
            toggleDir(currentRow.node.path);
          } else if (currentIndex + 1 < rows.length) {
            setSelectedIndex(currentIndex + 1);
          }
        }
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (currentIndex >= 0 && currentIndex < rows.length) {
        const currentRow = rows[currentIndex];
        if (currentRow.isDir && !collapsed().has(currentRow.node.path)) {
          toggleDir(currentRow.node.path);
        } else if (currentRow.depth > 0) {
          for (let i = currentIndex - 1; i >= 0; i -= 1) {
            if (rows[i].isDir && rows[i].depth === currentRow.depth - 1) {
              setSelectedIndex(i);
              break;
            }
          }
        }
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (currentIndex >= 0 && currentIndex < rows.length) {
        const currentRow = rows[currentIndex];
        if (currentRow.isDir) {
          toggleDir(currentRow.node.path);
        } else if (currentRow.node.file) {
          props.onFileClick?.(currentRow.node.file);
        }
      }
    }
  }

  function activateRow(rowIndex: number): void {
    const rows = visibleRows();
    const row = rows[rowIndex];
    if (!row) {
      return;
    }

    setSelectedIndex(rowIndex);
    if (row.isDir) {
      toggleDir(row.node.path);
      return;
    }

    if (row.node.file) {
      props.onFileClick?.(row.node.file);
    }
  }

  createEffect(() => {
    if (props.kind !== 'task') {
      return;
    }

    const reviewSnapshot = getTaskReviewSnapshot(props.taskId);
    setFiles(reviewSnapshot?.files ?? []);
    setTaskReviewUnavailable(reviewSnapshot?.source === 'unavailable');
    setWorktreeRefreshError(null);
  });

  createEffect(() => {
    if (props.kind !== 'worktree') {
      return;
    }
    if (!props.isActive) {
      return;
    }

    const path = props.worktreePath;
    const baseBranch = props.baseBranch;
    const projectRoot = props.projectRoot;
    const branchName = props.branchName;
    const reviewRequest = createTaskReviewFilesRequest({
      baseBranch,
      branchName,
      projectRoot,
      worktreePath: path,
    });
    const worktreeCacheKey = path ? getWorktreeCacheKey(path) : null;
    let cancelled = false;
    let inFlight = false;
    let refreshSource: ChangedFilesRefreshSource = 'project-diff';
    let initialTimer: ReturnType<typeof setTimeout> | undefined;

    setTaskReviewUnavailable(false);
    setWorktreeRefreshError(null);

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
        setWorktreeRefreshError(null);
        refreshSource = reviewFiles.source;
      } catch (error) {
        if (cancelled || !refreshRequestGuard.isCurrent(requestToken)) {
          return;
        }

        setWorktreeRefreshError(getChangedFilesRefreshErrorMessage(error));
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
    const initialDelayMs = getInitialRefreshDelayMs(
      recentStatusPollAge,
      Boolean(hasFreshWorktreeCache),
    );

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
    scrollSelectedRowIntoView(rowRefs, selectedIndex());
  });

  createEffect(() => {
    const rows = visibleRows();
    rowRefs.length = rows.length;
    if (selectedIndex() >= rows.length) {
      setSelectedIndex(rows.length > 0 ? rows.length - 1 : -1);
    }
  });

  const visibleFileStats = createMemo(() =>
    getChangedFilesVisibleFileStats(visibleFiles(), 'committed'),
  );
  const hydraToggleLabel = createMemo(() =>
    getHydraArtifactToggleLabel({
      count: hiddenHydraArtifactCount(),
      expanded: showHydraArtifacts(),
    }),
  );
  const hydraToggleTitle = createMemo(() =>
    getHydraArtifactToggleTitle({
      count: hiddenHydraArtifactCount(),
      expanded: showHydraArtifacts(),
    }),
  );
  const hiddenHydraSummaryLabel = createMemo(() =>
    getHiddenHydraSummaryLabel(hiddenHydraArtifactCount()),
  );
  const hiddenHydraSummaryTitle = createMemo(() =>
    getHiddenHydraSummaryTitle(hiddenHydraArtifactCount()),
  );

  onCleanup(() => {
    props.setRootRef?.(undefined);
  });

  return (
    <div
      ref={(element) => {
        props.setRootRef?.(element);
      }}
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
            aria-label={hydraToggleTitle()}
            title={hydraToggleTitle()}
            style={{
              background: 'transparent',
              border: 'none',
              padding: '0',
              color: theme.accent,
              cursor: 'pointer',
              ...typography.monoMeta,
            }}
          >
            {hydraToggleLabel()}
          </button>
        </div>
      </Show>
      <div style={{ flex: '1', overflow: 'auto', padding: '2px 0' }}>
        <For each={visibleRows()}>
          {(currentRow, i) => {
            const currentDir = currentRow.node.kind === 'dir' ? currentRow.node : undefined;
            const currentFile = currentRow.node.kind === 'file' ? currentRow.node.file : undefined;
            const fileDisplay = currentFile
              ? fileDisplayEntries().get(currentFile.path)
              : undefined;

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
                  'padding-left': `${8 + currentRow.depth * 10}px`,
                  'white-space': 'nowrap',
                  cursor: currentRow.isDir || props.onFileClick ? 'pointer' : 'default',
                  'border-radius': '6px',
                  opacity: currentRow.isDir || currentFile?.committed ? '0.45' : '1',
                  background: getRowBackground(currentFile?.path, i()),
                }}
                onClick={() => {
                  activateRow(i());
                }}
              >
                <Show
                  when={currentRow.isDir}
                  fallback={
                    <>
                      <span
                        style={{
                          color: currentFile ? getStatusColor(currentFile.status) : theme.fgMuted,
                          'font-weight': '600',
                          width: '12px',
                          'text-align': 'center',
                          'flex-shrink': '0',
                        }}
                      >
                        {currentFile?.status}
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
                        title={currentFile?.path ?? currentRow.node.path}
                      >
                        <span style={{ color: theme.fg }}>
                          {fileDisplay?.name ?? currentRow.node.name}
                        </span>
                        <Show when={fileDisplay?.disambig}>
                          <span style={{ color: theme.fgMuted, ...typography.meta }}>
                            {fileDisplay?.disambig}
                          </span>
                        </Show>
                      </span>
                      <Show
                        when={
                          (currentFile?.lines_added ?? 0) > 0 ||
                          (currentFile?.lines_removed ?? 0) > 0
                        }
                      >
                        <span style={{ color: theme.success, 'flex-shrink': '0' }}>
                          +{currentFile?.lines_added}
                        </span>
                        <span style={{ color: theme.error, 'flex-shrink': '0' }}>
                          -{currentFile?.lines_removed}
                        </span>
                      </Show>
                    </>
                  }
                >
                  <span
                    style={{
                      color: theme.fgMuted,
                      width: '12px',
                      'text-align': 'center',
                      'flex-shrink': '0',
                      ...typography.meta,
                    }}
                  >
                    {collapsed().has(currentRow.node.path) ? '▸' : '▾'}
                  </span>
                  <span
                    style={{
                      flex: '1',
                      overflow: 'hidden',
                      'text-overflow': 'ellipsis',
                      color: theme.fg,
                    }}
                    title={currentDir?.path ?? currentRow.node.path}
                  >
                    {currentDir?.name ?? currentRow.node.name}/
                  </span>
                  <span
                    style={{
                      color: theme.fgMuted,
                      'flex-shrink': '0',
                      ...typography.meta,
                    }}
                  >
                    {currentDir?.fileCount ?? 0}
                  </span>
                  <Show
                    when={(currentDir?.linesAdded ?? 0) > 0 || (currentDir?.linesRemoved ?? 0) > 0}
                  >
                    <span style={{ color: theme.success, 'flex-shrink': '0' }}>
                      +{currentDir?.linesAdded}
                    </span>
                    <span style={{ color: theme.error, 'flex-shrink': '0' }}>
                      -{currentDir?.linesRemoved}
                    </span>
                  </Show>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={visibleFileStats().fileCount > 0}>
        <div
          style={{
            padding: 'var(--space-2xs) var(--space-sm)',
            'border-top': `1px solid ${theme.border}`,
            color: theme.fgMuted,
            'flex-shrink': '0',
          }}
        >
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'flex-wrap': 'wrap',
              gap: '2px var(--space-xs)',
            }}
          >
            <span style={{ 'white-space': 'nowrap' }}>{visibleFileStats().fileCount} files</span>
            <span style={{ color: theme.success, 'white-space': 'nowrap' }}>
              +{visibleFileStats().totalAdded}
            </span>
            <span style={{ color: theme.error, 'white-space': 'nowrap' }}>
              -{visibleFileStats().totalRemoved}
            </span>
            <Show when={visibleFileStats().uncommittedCount > 0}>
              <span
                style={{ color: theme.warning, 'white-space': 'nowrap' }}
                title={`${visibleFileStats().uncommittedCount} uncommitted files`}
              >
                {visibleFileStats().uncommittedCount} uncommitted
              </span>
            </Show>
            <Show
              when={
                props.filterHydraArtifacts &&
                hiddenHydraArtifactCount() > 0 &&
                !showHydraArtifacts()
              }
            >
              <span
                style={{ color: theme.fgSubtle, 'white-space': 'nowrap' }}
                title={hiddenHydraSummaryTitle()}
              >
                {hiddenHydraSummaryLabel()}
              </span>
            </Show>
            <Show when={worktreeRefreshError()}>
              {(message) => (
                <span
                  role="status"
                  aria-live="polite"
                  style={{ color: theme.warning, 'min-width': '0' }}
                  title={`Changed files refresh failed: ${message()}`}
                >
                  Changed files refresh failed: {message()}
                </span>
              )}
            </Show>
          </div>
        </div>
      </Show>
      <Show when={visibleFileStats().fileCount === 0}>
        <div
          role={isReviewUnavailable() || worktreeRefreshError() ? 'status' : undefined}
          aria-live={isReviewUnavailable() || worktreeRefreshError() ? 'polite' : undefined}
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
