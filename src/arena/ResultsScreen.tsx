import { For, Show, createSignal, onMount } from 'solid-js';
import { ChangedFilesList } from '../components/ChangedFilesList';
import { DiffViewerDialog } from '../components/DiffViewerDialog';
import {
  arenaStore,
  addMatchToHistory,
  markBranchMerged,
  resetForNewMatch,
  resetForRematch,
  setPhase,
} from './store';
import { saveArenaHistory } from './persistence';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { ArenaMatch, BattleCompetitor } from './types';
import type { ChangedFile } from '../ipc/types';

function formatTime(startTime: number, endTime: number | null): string {
  if (!endTime) return 'DNF';
  const ms = endTime - startTime;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(1)}s`;
}

function rankLabel(index: number): string {
  return ['1st', '2nd', '3rd', '4th'][index] ?? `${index + 1}th`;
}

export function ResultsScreen() {
  const [ratings, setRatings] = createSignal<Record<string, number>>({});
  const [saved, setSaved] = createSignal(false);
  const [diffFile, setDiffFile] = createSignal<ChangedFile | null>(null);
  const [diffWorktree, setDiffWorktree] = createSignal('');
  const [mergedId, setMergedId] = createSignal<string | null>(null);
  const [merging, setMerging] = createSignal(false);
  const [mergeError, setMergeError] = createSignal<string | null>(null);

  type WorktreeStatus = { hasCommitted: boolean; hasUncommitted: boolean };
  const [worktreeStatus, setWorktreeStatus] = createSignal<Record<string, WorktreeStatus>>({});

  // Commit dialog state
  const [commitTarget, setCommitTarget] = createSignal<BattleCompetitor | null>(null);
  const [commitMsg, setCommitMsg] = createSignal('');

  // Terminal output expand/collapse
  const [expandedOutputs, setExpandedOutputs] = createSignal<Record<string, boolean>>({});

  onMount(() => {
    for (const c of arenaStore.battle) {
      if (!c.worktreePath) continue;
      invoke<{ has_committed_changes: boolean; has_uncommitted_changes: boolean }>(
        IPC.GetWorktreeStatus,
        { worktreePath: c.worktreePath },
      )
        .then((status) => {
          if (status.has_committed_changes || status.has_uncommitted_changes) {
            setWorktreeStatus((prev) => ({
              ...prev,
              [c.id]: {
                hasCommitted: status.has_committed_changes,
                hasUncommitted: status.has_uncommitted_changes,
              },
            }));
          }
        })
        .catch(() => {});
    }
  });

  function hasChanges(id: string): boolean {
    const s = worktreeStatus()[id];
    return !!s && (s.hasCommitted || s.hasUncommitted);
  }

  function handleMergeClick(competitor: BattleCompetitor) {
    const status = worktreeStatus()[competitor.id];
    if (status?.hasUncommitted) {
      const promptSnippet =
        arenaStore.prompt.slice(0, 50) + (arenaStore.prompt.length > 50 ? '...' : '');
      setCommitMsg(`arena: ${competitor.name} — ${promptSnippet}`);
      setCommitTarget(competitor);
    } else {
      void doMerge(competitor);
    }
  }

  async function handleCommitAndMerge() {
    const competitor = commitTarget();
    if (!competitor?.worktreePath) return;
    setCommitTarget(null);
    setMerging(true);
    setMergeError(null);
    try {
      await invoke(IPC.CommitAll, {
        worktreePath: competitor.worktreePath,
        message: commitMsg(),
      });
      await doMerge(competitor);
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
      setMerging(false);
    }
  }

  async function handleDiscardAndMerge() {
    const competitor = commitTarget();
    if (!competitor?.worktreePath) return;
    setCommitTarget(null);
    setMerging(true);
    setMergeError(null);
    try {
      await invoke(IPC.DiscardUncommitted, { worktreePath: competitor.worktreePath });
      await doMerge(competitor);
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
      setMerging(false);
    }
  }

  async function doMerge(competitor: BattleCompetitor) {
    if (!competitor.worktreePath || !competitor.branchName) return;
    setMerging(true);
    setMergeError(null);
    try {
      const status = await invoke<{ main_ahead_count: number; conflicting_files: string[] }>(
        IPC.CheckMergeStatus,
        { worktreePath: competitor.worktreePath },
      );
      if (status.conflicting_files.length > 0) {
        setMergeError(`Conflicts in: ${status.conflicting_files.join(', ')}`);
        return;
      }
      const promptSnippet =
        arenaStore.prompt.slice(0, 60) + (arenaStore.prompt.length > 60 ? '...' : '');
      await invoke(IPC.MergeTask, {
        projectRoot: arenaStore.cwd,
        branchName: competitor.branchName,
        squash: true,
        message: `arena: merge ${competitor.name} — ${promptSnippet}`,
        cleanup: true,
      });
      setMergedId(competitor.id);
      markBranchMerged(competitor.id);
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
    } finally {
      setMerging(false);
    }
  }

  const sorted = () =>
    [...arenaStore.battle].sort((a, b) => {
      const aFailed = a.exitCode !== null && a.exitCode !== 0;
      const bFailed = b.exitCode !== null && b.exitCode !== 0;
      if (aFailed !== bFailed) return aFailed ? 1 : -1;
      const aTime = a.endTime && a.startTime ? a.endTime - a.startTime : Infinity;
      const bTime = b.endTime && b.startTime ? b.endTime - b.startTime : Infinity;
      return aTime - bTime;
    });

  function setRating(competitorId: string, stars: number) {
    if (saved()) return;
    setRatings((prev) => ({ ...prev, [competitorId]: stars }));
  }

  function saveResults() {
    const match: ArenaMatch = {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      prompt: arenaStore.prompt,
      competitors: [...arenaStore.battle].map((b) => ({
        name: b.name,
        command: b.command,
        timeMs: b.endTime && b.startTime ? b.endTime - b.startTime : null,
        exitCode: b.exitCode,
        rating: ratings()[b.id] ?? null,
      })),
    };
    addMatchToHistory(match);
    void saveArenaHistory();
    setSaved(true);
  }

  function handleFileClick(worktreePath: string, file: ChangedFile) {
    setDiffWorktree(worktreePath);
    setDiffFile(file);
  }

  return (
    <div class="arena-results">
      <div class="arena-results-grid">
        <For each={sorted()}>
          {(competitor, index) => (
            <div class="arena-result-column">
              <div class="arena-result-column-rank" data-rank={index() === 0 ? '1' : undefined}>
                {rankLabel(index())}
              </div>
              <div class="arena-result-column-name">{competitor.name}</div>
              <div class="arena-result-column-time">
                {formatTime(competitor.startTime, competitor.endTime)}
              </div>
              <Show when={competitor.exitCode !== null && competitor.exitCode !== 0}>
                <div class="arena-result-column-exit">exit {competitor.exitCode}</div>
              </Show>

              {/* Terminal output */}
              <Show when={competitor.terminalOutput}>
                <div class="arena-result-column-output">
                  <button
                    class="arena-output-toggle"
                    onClick={() =>
                      setExpandedOutputs((prev) => ({
                        ...prev,
                        [competitor.id]: !prev[competitor.id],
                      }))
                    }
                  >
                    <span
                      class="arena-output-toggle-icon"
                      data-expanded={expandedOutputs()[competitor.id] ? 'true' : undefined}
                    >
                      &#9654;
                    </span>
                    Terminal output
                  </button>
                  <Show when={expandedOutputs()[competitor.id]}>
                    <pre class="arena-output-pre">{competitor.terminalOutput}</pre>
                  </Show>
                </div>
              </Show>

              {/* Changed files for this competitor's worktree */}
              <Show when={competitor.worktreePath}>
                <div class="arena-result-column-files">
                  <span class="arena-section-label">Changed files</span>
                  <div class="arena-result-column-files-list">
                    <ChangedFilesList
                      worktreePath={competitor.worktreePath!}
                      isActive={true}
                      onFileClick={(file) => handleFileClick(competitor.worktreePath!, file)}
                    />
                  </div>
                </div>
              </Show>

              {/* Star rating */}
              <div class="arena-result-column-rating">
                <span class="arena-result-rating-label">Rate how it performed</span>
                <div class="arena-result-column-stars">
                  <For each={[1, 2, 3, 4, 5]}>
                    {(star) => (
                      <button
                        class="arena-star-btn"
                        data-filled={(ratings()[competitor.id] ?? 0) >= star ? 'true' : undefined}
                        disabled={saved()}
                        onClick={() => setRating(competitor.id, star)}
                        title={`${star} star${star > 1 ? 's' : ''}`}
                      >
                        <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 1.3l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 5.5l4-.6L8 1.3z" />
                        </svg>
                      </button>
                    )}
                  </For>
                </div>
              </div>

              {/* Merge into main */}
              <Show when={competitor.branchName && hasChanges(competitor.id)}>
                <div class="arena-result-column-merge">
                  <Show
                    when={mergedId() !== competitor.id}
                    fallback={<span class="arena-merge-badge">Merged</span>}
                  >
                    <button
                      class="arena-merge-btn"
                      disabled={merging() || mergedId() !== null}
                      onClick={() => handleMergeClick(competitor)}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <circle cx="4" cy="4" r="2" />
                        <circle cx="12" cy="4" r="2" />
                        <circle cx="8" cy="13" r="2" />
                        <path d="M4 6v1c0 2 4 4 4 4M12 6v1c0 2-4 4-4 4" />
                      </svg>
                      {merging() ? 'Merging...' : 'Merge into main'}
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>

      <Show when={mergeError()}>
        <div class="arena-merge-error">{mergeError()}</div>
      </Show>

      <div class="arena-config-actions">
        <Show when={!saved()}>
          <button class="arena-fight-btn" onClick={saveResults}>
            Save Results
          </button>
        </Show>
        <button class="arena-close-btn" onClick={() => void resetForRematch()}>
          Rematch
        </button>
        <button class="arena-close-btn" onClick={() => void resetForNewMatch()}>
          New Match
        </button>
        <button class="arena-close-btn" onClick={() => setPhase('history')}>
          History
        </button>
      </div>

      <DiffViewerDialog
        file={diffFile()}
        worktreePath={diffWorktree()}
        onClose={() => setDiffFile(null)}
      />

      {/* Commit dialog for uncommitted changes */}
      <Show when={commitTarget()}>
        {(target) => (
          <div class="arena-commit-overlay" onClick={() => setCommitTarget(null)}>
            <div class="arena-commit-dialog" onClick={(e) => e.stopPropagation()}>
              <div class="arena-commit-title">{target().name} has uncommitted changes</div>
              <label class="arena-commit-label">
                Commit message
                <input
                  class="arena-commit-input"
                  type="text"
                  value={commitMsg()}
                  onInput={(e) => setCommitMsg(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && commitMsg().trim()) void handleCommitAndMerge();
                  }}
                  autofocus
                />
              </label>
              <div class="arena-commit-actions">
                <button
                  class="arena-merge-btn"
                  disabled={!commitMsg().trim()}
                  onClick={() => void handleCommitAndMerge()}
                >
                  Commit &amp; Merge
                </button>
                <Show when={worktreeStatus()[target().id]?.hasCommitted}>
                  <button class="arena-close-btn" onClick={() => void handleDiscardAndMerge()}>
                    Discard uncommitted &amp; Merge
                  </button>
                </Show>
                <button class="arena-close-btn" onClick={() => setCommitTarget(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
