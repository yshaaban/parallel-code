import { createSignal, createMemo, createEffect, onCleanup, For, Show } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { isHydraCoordinationArtifact } from '../lib/hydra';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { getStatusColor } from '../lib/status-colors';
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

interface GitChangedFilesEventDetail {
  taskId?: string;
  worktreePath?: string;
  projectRoot?: string;
  branchName?: string | null;
  changedFiles?: ChangedFile[];
}

function isGitChangedFilesEventDetail(value: unknown): value is GitChangedFilesEventDetail {
  if (!value || typeof value !== 'object') return false;
  const detail = value as Record<string, unknown>;

  if (detail.taskId !== undefined && typeof detail.taskId !== 'string') return false;
  if (detail.worktreePath !== undefined && typeof detail.worktreePath !== 'string') return false;
  if (detail.projectRoot !== undefined && typeof detail.projectRoot !== 'string') return false;
  if (
    detail.branchName !== undefined &&
    detail.branchName !== null &&
    typeof detail.branchName !== 'string'
  ) {
    return false;
  }
  if (detail.changedFiles !== undefined && !Array.isArray(detail.changedFiles)) return false;

  return true;
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

  // Server pushes changed files via git file system watchers. Fallback refreshes
  // happen only on explicit invalidation events instead of recurring polling.
  createEffect(() => {
    const worktreePath = props.worktreePath;
    const projectRoot = props.projectRoot;
    const branchName = props.branchName;
    if (!props.isActive) return;
    let cancelled = false;
    let inFlight = false;

    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        if (worktreePath) {
          try {
            const result = await invoke<ChangedFile[]>(IPC.GetChangedFiles, {
              worktreePath,
            });
            if (!cancelled) setFiles(result);
            return;
          } catch {
            // Worktree may not exist — try branch fallback below
          }
        }

        if (projectRoot && branchName) {
          try {
            const result = await invoke<ChangedFile[]>(IPC.GetChangedFilesFromBranch, {
              projectRoot,
              branchName,
            });
            if (!cancelled) setFiles(result);
            return;
          } catch {
            // Branch may no longer exist
          }
        }
        if (!cancelled) setFiles([]);
      } finally {
        inFlight = false;
      }
    }

    // Listen for server-pushed changed files (from git file watcher)
    function onGitChangedFiles(e: Event) {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail;
      if (!isGitChangedFilesEventDetail(detail)) return;
      if (detail.worktreePath === worktreePath && detail.changedFiles && !cancelled) {
        setFiles(detail.changedFiles);
      }
    }

    function matchesInvalidation(detail: GitChangedFilesEventDetail): boolean {
      if (detail.worktreePath && worktreePath && detail.worktreePath === worktreePath) {
        return true;
      }
      if (
        detail.branchName &&
        branchName &&
        detail.branchName === branchName &&
        (!detail.projectRoot || !projectRoot || detail.projectRoot === projectRoot)
      ) {
        return true;
      }
      if (detail.projectRoot && projectRoot && detail.projectRoot === projectRoot) {
        return !detail.branchName || detail.branchName === branchName;
      }
      return false;
    }

    function onGitChangedFilesInvalidated(e: Event) {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail;
      if (!isGitChangedFilesEventDetail(detail)) return;
      if (matchesInvalidation(detail)) {
        void refresh();
      }
    }

    function onRefreshAll() {
      void refresh();
    }

    window.addEventListener('git-changed-files', onGitChangedFiles);
    window.addEventListener('git-changed-files-invalidated', onGitChangedFilesInvalidated);
    window.addEventListener('git-changed-files-refresh-all', onRefreshAll);

    void refresh();
    onCleanup(() => {
      cancelled = true;
      window.removeEventListener('git-changed-files', onGitChangedFiles);
      window.removeEventListener('git-changed-files-invalidated', onGitChangedFilesInvalidated);
      window.removeEventListener('git-changed-files-refresh-all', onRefreshAll);
    });
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
                  color: theme.fg,
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                }}
              >
                {file.path}
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
