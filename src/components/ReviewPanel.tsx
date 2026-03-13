import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';

import { fetchTaskReviewFiles } from '../app/review-files';
import { gitStatusEventMatchesTarget } from '../app/git-status-sync';
import { getTaskConvergenceSnapshot } from '../app/task-convergence';
import { getTaskReviewStateLabel } from '../domain/task-convergence';
import { isHydraCoordinationArtifact } from '../lib/hydra';
import { invoke } from '../lib/ipc';
import { theme } from '../lib/theme';
import { IconButton } from './IconButton';
import { IPC } from '../../electron/ipc/channels';
import type { ChangedFile, FileDiffResult } from '../ipc/types';
import { listenForGitStatusChanged } from '../runtime/git-status-events';
import type { ReviewDiffMode } from '../store/types';
import { MonacoDiffEditor } from './MonacoDiffEditor';

interface ReviewPanelProps {
  branchName: string;
  filterHydraArtifacts?: boolean;
  isActive: boolean;
  fullscreen?: boolean;
  onOpenFullscreen?: () => void;
  projectRoot?: string;
  taskId?: string;
  worktreePath: string;
}

interface ReviewFilesRequest {
  branchName?: string | null;
  projectRoot?: string;
  worktreePath: string;
}

function getReviewStateColor(taskId?: string): string {
  if (!taskId) {
    return theme.fgMuted;
  }

  switch (getTaskConvergenceSnapshot(taskId)?.state) {
    case 'review-ready':
      return theme.success;
    case 'needs-refresh':
      return theme.warning;
    case 'merge-blocked':
      return theme.error;
    case 'dirty-uncommitted':
      return theme.accent;
    case 'no-changes':
      return theme.fgSubtle;
    case 'unavailable':
      return theme.fgMuted;
    default:
      return theme.fgMuted;
  }
}

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    css: 'css',
    go: 'go',
    html: 'html',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    sh: 'shell',
    ts: 'typescript',
    tsx: 'typescript',
    yaml: 'yaml',
    yml: 'yaml',
  };
  return map[ext] ?? 'plaintext';
}

function getStatusColor(file: ChangedFile): string {
  if (file.status === 'added' || file.status === 'untracked' || file.status === '?') {
    return '#4ec94e';
  }
  if (file.status === 'deleted') {
    return '#e55';
  }
  return '#e8a838';
}

function getStatusIcon(file: ChangedFile): string {
  if (file.status === 'added' || file.status === 'untracked' || file.status === '?') {
    return '+';
  }
  if (file.status === 'deleted') {
    return '-';
  }
  return 'M';
}

export function ReviewPanel(props: ReviewPanelProps) {
  const [files, setFiles] = createSignal<ChangedFile[]>([]);
  const [selectedIdx, setSelectedIdx] = createSignal(0);
  const [showHydraArtifacts, setShowHydraArtifacts] = createSignal(false);
  const [mode, setMode] = createSignal<ReviewDiffMode>('all');
  const [sideBySide, setSideBySide] = createSignal(false);
  const [diff, setDiff] = createSignal<FileDiffResult | null>(null);
  const [loading, setLoading] = createSignal(false);
  const convergence = () => (props.taskId ? getTaskConvergenceSnapshot(props.taskId) : undefined);
  const hiddenHydraArtifactCount = createMemo(() => {
    if (!props.filterHydraArtifacts) {
      return 0;
    }

    return files().filter((file) => isHydraCoordinationArtifact(file.path)).length;
  });
  const visibleFiles = createMemo(() => {
    if (!props.filterHydraArtifacts || showHydraArtifacts()) {
      return files();
    }

    return files().filter((file) => !isHydraCoordinationArtifact(file.path));
  });
  const visibleTotalAdded = createMemo(() =>
    visibleFiles().reduce((sum, file) => sum + file.lines_added, 0),
  );
  const visibleTotalRemoved = createMemo(() =>
    visibleFiles().reduce((sum, file) => sum + file.lines_removed, 0),
  );
  const canSelectPreviousFile = createMemo(() => selectedIdx() > 0);
  const canSelectNextFile = createMemo(() => selectedIdx() < visibleFiles().length - 1);

  async function fetchFiles(
    request: ReviewFilesRequest,
    currentMode: ReviewDiffMode,
  ): Promise<void> {
    try {
      const result = await fetchTaskReviewFiles(request, currentMode);
      setFiles(result.files);
    } catch {
      /* ignore polling errors */
    }
  }

  async function fetchDiff(file: ChangedFile): Promise<void> {
    setLoading(true);
    try {
      const ipcChannel = file.committed ? IPC.GetFileDiffFromBranch : IPC.GetFileDiff;
      const args = file.committed
        ? { branchName: props.branchName, filePath: file.path, projectRoot: props.projectRoot }
        : { filePath: file.path, worktreePath: props.worktreePath };
      const result = await invoke<FileDiffResult>(ipcChannel, args);
      setDiff(result);
    } catch {
      setDiff(null);
    }
    setLoading(false);
  }

  createEffect(() => {
    const request: ReviewFilesRequest = {
      worktreePath: props.worktreePath,
      projectRoot: props.projectRoot,
      branchName: props.branchName,
    };
    const currentMode = mode();
    if (!props.isActive) {
      return;
    }

    const offGitStatus = listenForGitStatusChanged((message) => {
      if (
        gitStatusEventMatchesTarget(message, {
          worktreePath: request.worktreePath,
          branchName: request.branchName,
          projectRoot: request.projectRoot,
        })
      ) {
        void fetchFiles(request, currentMode);
      }
    });

    onCleanup(() => offGitStatus());
  });

  createEffect(() => {
    const request: ReviewFilesRequest = {
      worktreePath: props.worktreePath,
      projectRoot: props.projectRoot,
      branchName: props.branchName,
    };
    const currentMode = mode();
    if (!props.isActive) {
      return;
    }

    void fetchFiles(request, currentMode);
  });

  createEffect(() => {
    const currentFiles = visibleFiles();
    const index = selectedIdx();
    if (currentFiles.length > 0 && index >= 0 && index < currentFiles.length) {
      void fetchDiff(currentFiles[index]);
    }
  });

  createEffect(() => {
    const currentFiles = visibleFiles();
    if (selectedIdx() >= currentFiles.length) {
      setSelectedIdx(currentFiles.length > 0 ? currentFiles.length - 1 : 0);
    }
  });

  function selectedFile(): ChangedFile | undefined {
    return visibleFiles()[selectedIdx()];
  }

  function navPrev(): void {
    setSelectedIdx((index) => Math.max(0, index - 1));
  }

  function navNext(): void {
    setSelectedIdx((index) => Math.min(visibleFiles().length - 1, index + 1));
  }

  function headerButtonStyle(active = false): Record<string, string> {
    return {
      background: active ? `color-mix(in srgb, ${theme.accent} 14%, transparent)` : 'transparent',
      border: `1px solid ${theme.border}`,
      color: active ? theme.accent : theme.fg,
      padding: '2px',
      cursor: 'pointer',
      'border-radius': '4px',
      display: 'inline-flex',
      'align-items': 'center',
      'justify-content': 'center',
      opacity: active ? '1' : '0.92',
    };
  }

  function handleKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowUp':
      case 'k':
        event.preventDefault();
        navPrev();
        return;
      case 'ArrowDown':
      case 'j':
        event.preventDefault();
        navNext();
        return;
      case 'n':
        navNext();
        return;
      case 'p':
        navPrev();
        return;
      default:
        return;
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: theme.taskPanelBg,
        color: theme.fg,
      }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          padding: '4px 8px',
          'border-bottom': `1px solid ${theme.border}`,
          'flex-shrink': '0',
          'font-size': '11px',
          'font-family': "'JetBrains Mono', monospace",
        }}
      >
        <select
          value={mode()}
          onChange={(event) => {
            setMode(event.currentTarget.value as ReviewDiffMode);
            setSelectedIdx(0);
          }}
          style={{
            background: theme.bg,
            color: theme.fg,
            border: `1px solid ${theme.border}`,
            'border-radius': '3px',
            padding: '2px 4px',
            'font-size': '10px',
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          <option value="all">All changes</option>
          <option value="staged">Staged</option>
          <option value="unstaged">Unstaged</option>
          <option value="branch">Branch</option>
        </select>

        <span style={{ color: theme.fgMuted }}>
          {visibleFiles().length} file{visibleFiles().length !== 1 ? 's' : ''}
        </span>
        <span style={{ color: '#4ec94e' }}>+{visibleTotalAdded()}</span>
        <span style={{ color: '#e55' }}>-{visibleTotalRemoved()}</span>

        <div style={{ 'margin-left': 'auto', display: 'flex', gap: '4px' }}>
          <button
            onClick={navPrev}
            disabled={!canSelectPreviousFile()}
            title="Previous file"
            style={{
              ...headerButtonStyle(),
              cursor: canSelectPreviousFile() ? 'pointer' : 'default',
              opacity: canSelectPreviousFile() ? '0.92' : '0.4',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
            </svg>
          </button>
          <button
            onClick={navNext}
            disabled={!canSelectNextFile()}
            title="Next file"
            style={{
              ...headerButtonStyle(),
              cursor: canSelectNextFile() ? 'pointer' : 'default',
              opacity: canSelectNextFile() ? '0.92' : '0.4',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
          <button
            onClick={() => setSideBySide((current) => !current)}
            title={sideBySide() ? 'Show unified diff' : 'Show split diff'}
            style={headerButtonStyle(sideBySide())}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect
                x="2.25"
                y="2.25"
                width="4.5"
                height="11.5"
                rx="0.75"
                stroke="currentColor"
                stroke-width="1.5"
              />
              <rect
                x="9.25"
                y="2.25"
                width="4.5"
                height="11.5"
                rx="0.75"
                stroke="currentColor"
                stroke-width="1.5"
              />
            </svg>
          </button>
          <Show when={props.onOpenFullscreen && !props.fullscreen}>
            <IconButton
              size="sm"
              title="Open review fullscreen"
              onClick={() => props.onOpenFullscreen?.()}
              icon={
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M2.75 2h3.5a.75.75 0 0 1 0 1.5H4.56l2.97 2.97a.75.75 0 1 1-1.06 1.06L3.5 4.56v1.69a.75.75 0 0 1-1.5 0V2.75A.75.75 0 0 1 2.75 2Zm7 0h3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0V4.56l-2.97 2.97a.75.75 0 0 1-1.06-1.06l2.97-2.97H9.75a.75.75 0 0 1 0-1.5ZM6.47 8.47a.75.75 0 0 1 1.06 1.06L4.56 12.5h1.69a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75v-3.5a.75.75 0 0 1 1.5 0v1.69l2.97-2.97Zm3.06 0 2.97 2.97V9.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1 0-1.5h1.69L8.47 9.53a.75.75 0 1 1 1.06-1.06Z" />
                </svg>
              }
            />
          </Show>
        </div>
      </div>

      <Show when={props.filterHydraArtifacts && hiddenHydraArtifactCount() > 0}>
        <div
          style={{
            padding: '6px 8px 2px',
            'font-size': '10px',
            color: theme.fgMuted,
            'border-bottom': `1px solid ${theme.border}`,
            'font-family': "'JetBrains Mono', monospace",
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

      <Show when={convergence()}>
        {(snapshot) => (
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              gap: '12px',
              padding: '8px',
              'border-bottom': `1px solid ${theme.border}`,
              background: theme.bgInput,
              'font-size': '11px',
              'font-family': "'JetBrains Mono', monospace",
            }}
          >
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                'min-width': '0',
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  color: getReviewStateColor(props.taskId),
                  padding: '2px 6px',
                  'border-radius': '999px',
                  border: `1px solid color-mix(in srgb, ${getReviewStateColor(props.taskId)} 30%, transparent)`,
                  background: `color-mix(in srgb, ${getReviewStateColor(props.taskId)} 10%, transparent)`,
                  'flex-shrink': '0',
                }}
              >
                {getTaskReviewStateLabel(snapshot().state)}
              </span>
              <span
                style={{
                  color: theme.fgMuted,
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                }}
              >
                {snapshot().summary}
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                color: theme.fgSubtle,
                'flex-shrink': '0',
              }}
            >
              <span>{snapshot().commitCount} commits</span>
              <span>{snapshot().changedFileCount} files</span>
              <Show when={snapshot().mainAheadCount > 0}>
                <span>Main +{snapshot().mainAheadCount}</span>
              </Show>
              <Show when={snapshot().overlapWarnings[0]}>
                {(warning) => <span>{warning().sharedCount} shared</span>}
              </Show>
            </div>
          </div>
        )}
      </Show>

      <div style={{ display: 'flex', flex: '1', overflow: 'hidden' }}>
        <div
          style={{
            width: '200px',
            'min-width': '140px',
            'border-right': `1px solid ${theme.border}`,
            overflow: 'auto',
            'flex-shrink': '0',
          }}
        >
          <For each={visibleFiles()}>
            {(file, index) => (
              <div
                onClick={() => setSelectedIdx(index())}
                style={{
                  padding: '3px 8px',
                  cursor: 'pointer',
                  background: index() === selectedIdx() ? theme.accent + '30' : 'transparent',
                  'border-left':
                    index() === selectedIdx()
                      ? `2px solid ${theme.accent}`
                      : '2px solid transparent',
                  'font-size': '11px',
                  'font-family': "'JetBrains Mono', monospace",
                  display: 'flex',
                  'align-items': 'center',
                  gap: '6px',
                  'white-space': 'nowrap',
                  overflow: 'hidden',
                }}
              >
                <span
                  style={{
                    color: getStatusColor(file),
                    'font-weight': 'bold',
                    'flex-shrink': '0',
                    width: '12px',
                    'text-align': 'center',
                  }}
                >
                  {getStatusIcon(file)}
                </span>
                <span
                  style={{
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                  }}
                  title={file.path}
                >
                  {file.path.split('/').pop()}
                </span>
                <span
                  style={{
                    'margin-left': 'auto',
                    color: theme.fgMuted,
                    'font-size': '9px',
                    'flex-shrink': '0',
                  }}
                >
                  <Show when={file.lines_added > 0}>
                    <span style={{ color: '#4ec94e' }}>+{file.lines_added}</span>
                  </Show>
                  <Show when={file.lines_removed > 0}>
                    <span style={{ color: '#e55', 'margin-left': '2px' }}>
                      -{file.lines_removed}
                    </span>
                  </Show>
                </span>
              </div>
            )}
          </For>
          <Show when={visibleFiles().length === 0}>
            <div
              style={{
                padding: '12px',
                color: theme.fgMuted,
                'font-size': '11px',
                'text-align': 'center',
                'font-family': "'JetBrains Mono', monospace",
              }}
            >
              {hiddenHydraArtifactCount() > 0 && !showHydraArtifacts()
                ? 'Only Hydra coordination files are hidden'
                : 'No changes'}
            </div>
          </Show>
        </div>

        <div style={{ flex: '1', overflow: 'hidden' }}>
          <Show
            when={!loading() && diff() && selectedFile()}
            fallback={
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'center',
                  height: '100%',
                  color: theme.fgMuted,
                  'font-size': '12px',
                  'font-family': "'JetBrains Mono', monospace",
                }}
              >
                {loading() ? 'Loading...' : 'Select a file'}
              </div>
            }
          >
            <Show when={diff()}>
              {(currentDiff) => (
                <Show when={selectedFile()}>
                  {(file) => (
                    <>
                      <div
                        style={{
                          padding: '4px 8px',
                          'font-size': '11px',
                          'font-family': "'JetBrains Mono', monospace",
                          color: theme.fgMuted,
                          'border-bottom': `1px solid ${theme.border}`,
                          'flex-shrink': '0',
                        }}
                      >
                        {file().path}
                      </div>
                      <MonacoDiffEditor
                        oldContent={currentDiff().oldContent}
                        newContent={currentDiff().newContent}
                        language={getLanguage(file().path)}
                        sideBySide={sideBySide()}
                      />
                    </>
                  )}
                </Show>
              )}
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
