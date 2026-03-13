import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';

import { gitStatusEventMatchesTarget } from '../app/git-status-sync';
import { getTaskConvergenceSnapshot } from '../app/task-convergence';
import { getTaskReviewStateLabel } from '../domain/task-convergence';
import { invoke } from '../lib/ipc';
import { theme } from '../lib/theme';
import { IPC } from '../../electron/ipc/channels';
import type { ChangedFile, FileDiffResult } from '../ipc/types';
import { listenForGitStatusChanged } from '../runtime/git-status-events';
import type { ReviewDiffMode } from '../store/types';
import { MonacoDiffEditor } from './MonacoDiffEditor';

interface ReviewPanelProps {
  branchName: string;
  isActive: boolean;
  projectRoot?: string;
  taskId?: string;
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
  const [mode, setMode] = createSignal<ReviewDiffMode>('all');
  const [sideBySide, setSideBySide] = createSignal(false);
  const [diff, setDiff] = createSignal<FileDiffResult | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [totalAdded, setTotalAdded] = createSignal(0);
  const [totalRemoved, setTotalRemoved] = createSignal(0);
  const convergence = () => (props.taskId ? getTaskConvergenceSnapshot(props.taskId) : undefined);

  async function fetchFiles(worktreePath: string, currentMode: ReviewDiffMode): Promise<void> {
    try {
      const result = await invoke<{
        files: ChangedFile[];
        totalAdded: number;
        totalRemoved: number;
      }>(IPC.GetProjectDiff, {
        worktreePath,
        mode: currentMode,
      });
      setFiles(result.files);
      setTotalAdded(result.totalAdded);
      setTotalRemoved(result.totalRemoved);
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
    const path = props.worktreePath;
    const projectRoot = props.projectRoot;
    const branchName = props.branchName;
    const currentMode = mode();
    if (!props.isActive) {
      return;
    }

    const offGitStatus = listenForGitStatusChanged((message) => {
      if (
        gitStatusEventMatchesTarget(message, {
          worktreePath: path,
          branchName,
          projectRoot,
        })
      ) {
        void fetchFiles(path, currentMode);
      }
    });

    onCleanup(() => offGitStatus());
  });

  createEffect(() => {
    const currentMode = mode();
    if (!props.isActive) {
      return;
    }

    void fetchFiles(props.worktreePath, currentMode);
  });

  createEffect(() => {
    const currentFiles = files();
    const index = selectedIdx();
    if (currentFiles.length > 0 && index >= 0 && index < currentFiles.length) {
      void fetchDiff(currentFiles[index]);
    }
  });

  function selectedFile(): ChangedFile | undefined {
    return files()[selectedIdx()];
  }

  function navPrev(): void {
    setSelectedIdx((index) => Math.max(0, index - 1));
  }

  function navNext(): void {
    setSelectedIdx((index) => Math.min(files().length - 1, index + 1));
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
          {files().length} file{files().length !== 1 ? 's' : ''}
        </span>
        <span style={{ color: '#4ec94e' }}>+{totalAdded()}</span>
        <span style={{ color: '#e55' }}>-{totalRemoved()}</span>

        <div style={{ 'margin-left': 'auto', display: 'flex', gap: '4px' }}>
          <button
            onClick={navPrev}
            disabled={selectedIdx() <= 0}
            style={{
              background: 'transparent',
              border: `1px solid ${theme.border}`,
              color: theme.fg,
              padding: '1px 6px',
              cursor: 'pointer',
              'border-radius': '3px',
              'font-family': "'JetBrains Mono', monospace",
              'font-size': '10px',
            }}
          >
            ← Prev
          </button>
          <button
            onClick={navNext}
            disabled={selectedIdx() >= files().length - 1}
            style={{
              background: 'transparent',
              border: `1px solid ${theme.border}`,
              color: theme.fg,
              padding: '1px 6px',
              cursor: 'pointer',
              'border-radius': '3px',
              'font-family': "'JetBrains Mono', monospace",
              'font-size': '10px',
            }}
          >
            Next →
          </button>
          <button
            onClick={() => setSideBySide((current) => !current)}
            style={{
              background: 'transparent',
              border: `1px solid ${theme.border}`,
              color: theme.fg,
              padding: '1px 6px',
              cursor: 'pointer',
              'border-radius': '3px',
              'font-family': "'JetBrains Mono', monospace",
              'font-size': '10px',
            }}
          >
            {sideBySide() ? 'Unified' : 'Split'}
          </button>
        </div>
      </div>

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
          <For each={files()}>
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
          <Show when={files().length === 0}>
            <div
              style={{
                padding: '12px',
                color: theme.fgMuted,
                'font-size': '11px',
                'text-align': 'center',
                'font-family': "'JetBrains Mono', monospace",
              }}
            >
              No changes
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
