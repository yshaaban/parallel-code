import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { theme } from '../lib/theme';
import { listenForGitStatusChanged } from '../runtime/git-status-events';
import { MonacoDiffEditor } from './MonacoDiffEditor';
import type { ChangedFile, FileDiffResult } from '../ipc/types';
import type { ReviewDiffMode } from '../store/types';

interface ReviewPanelProps {
  worktreePath: string;
  projectRoot?: string;
  branchName: string;
  isActive: boolean;
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

  async function fetchFiles(currentMode: ReviewDiffMode) {
    try {
      const result = await invoke<{
        files: ChangedFile[];
        totalAdded: number;
        totalRemoved: number;
      }>(IPC.GetProjectDiff, {
        worktreePath: props.worktreePath,
        mode: currentMode,
      });
      setFiles(result.files);
      setTotalAdded(result.totalAdded);
      setTotalRemoved(result.totalRemoved);
    } catch {
      /* ignore polling errors */
    }
  }

  async function fetchDiff(file: ChangedFile) {
    setLoading(true);
    try {
      const ipcChannel = file.committed ? IPC.GetFileDiffFromBranch : IPC.GetFileDiff;
      const args = file.committed
        ? { projectRoot: props.projectRoot, branchName: props.branchName, filePath: file.path }
        : { worktreePath: props.worktreePath, filePath: file.path };
      const result = await invoke<FileDiffResult>(ipcChannel, args);
      setDiff(result);
    } catch {
      setDiff(null);
    }
    setLoading(false);
  }

  // Listen for git push events for this worktree
  createEffect(() => {
    const path = props.worktreePath;
    if (!props.isActive) return;

    // eslint-disable-next-line solid/reactivity
    const offGitStatus = listenForGitStatusChanged((msg) => {
      if (msg.worktreePath === path) {
        void fetchFiles(mode());
      }
    });
    onCleanup(() => offGitStatus());
  });

  // Fetch files on mount and poll
  createEffect(() => {
    const currentMode = mode(); // tracked dependency — re-runs when mode changes
    if (!props.isActive) return;
    void fetchFiles(currentMode);
    const timer = setInterval(() => void fetchFiles(currentMode), 3_000);
    onCleanup(() => clearInterval(timer));
  });

  // Fetch diff when selected file changes
  createEffect(() => {
    const f = files();
    const idx = selectedIdx();
    if (f.length > 0 && idx >= 0 && idx < f.length) {
      void fetchDiff(f[idx]);
    }
  });

  function selectedFile(): ChangedFile | undefined {
    return files()[selectedIdx()];
  }

  function navPrev() {
    setSelectedIdx((i) => Math.max(0, i - 1));
  }

  function navNext() {
    setSelectedIdx((i) => Math.min(files().length - 1, i + 1));
  }

  function getLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      json: 'json',
      md: 'markdown',
      css: 'css',
      html: 'html',
      py: 'python',
      rs: 'rust',
      go: 'go',
      sh: 'shell',
      yml: 'yaml',
      yaml: 'yaml',
    };
    return map[ext] ?? 'plaintext';
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      navPrev();
    } else if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      navNext();
    } else if (e.key === 'n') {
      navNext();
    } else if (e.key === 'p') {
      navPrev();
    }
  }

  function statusIcon(file: ChangedFile): string {
    if (file.status === 'added' || file.status === 'untracked' || file.status === '?') return '+';
    if (file.status === 'deleted') return '-';
    return 'M';
  }

  function statusColor(file: ChangedFile): string {
    if (file.status === 'added' || file.status === 'untracked' || file.status === '?')
      return '#4ec94e';
    if (file.status === 'deleted') return '#e55';
    return '#e8a838';
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
      {/* Toolbar */}
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
          onChange={(e) => {
            setMode(e.currentTarget.value as ReviewDiffMode);
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
            onClick={() => setSideBySide((v) => !v)}
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

      {/* Main content */}
      <div style={{ display: 'flex', flex: '1', overflow: 'hidden' }}>
        {/* File navigator */}
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
            {(file, idx) => (
              <div
                onClick={() => setSelectedIdx(idx())}
                style={{
                  padding: '3px 8px',
                  cursor: 'pointer',
                  background: idx() === selectedIdx() ? theme.accent + '30' : 'transparent',
                  'border-left':
                    idx() === selectedIdx() ? `2px solid ${theme.accent}` : '2px solid transparent',
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
                    color: statusColor(file),
                    'font-weight': 'bold',
                    'flex-shrink': '0',
                    width: '12px',
                    'text-align': 'center',
                  }}
                >
                  {statusIcon(file)}
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

        {/* Diff viewer */}
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
              {(d) => (
                <Show when={selectedFile()}>
                  {(sf) => (
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
                        {sf().path}
                      </div>
                      <MonacoDiffEditor
                        oldContent={d().oldContent}
                        newContent={d().newContent}
                        language={getLanguage(sf().path)}
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
